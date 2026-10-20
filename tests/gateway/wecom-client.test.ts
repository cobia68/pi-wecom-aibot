import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { WeComClient } from "../../src/gateway/wecom-client.ts";
import { FakeWebSocket } from "../support/fake-websocket.ts";

let client: WeComClient;

beforeEach(() => {
	FakeWebSocket.instances = [];
	client = new WeComClient({
		botId: "test-bot",
		secret: "test-secret",
		createWebSocket: (url) => new FakeWebSocket(url),
	});
});

afterEach(() => {
	client.stop("test cleanup");
});

function connect(): FakeWebSocket {
	client.start();
	const ws = FakeWebSocket.instances[0];
	ws.open();
	ws.acknowledge();
	assert.equal(client.isReady(), true);
	return ws;
}

function deadline<T>(pending: Promise<T>): Promise<T | string> {
	return Promise.race([pending, new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 25))]);
}

test("stopping settles a push that is waiting for acknowledgement", async () => {
	connect();
	const pending = client.sendMsg("test-user", 1, { msgtype: "markdown" });
	const result = assert.rejects(deadline(pending), /stopped by user/);
	client.stop("stopped by user");
	await result;
});

test("socket closure immediately rejects outstanding commands", async () => {
	const ws = connect();
	const result = assert.rejects(
		deadline(client.sendMsg("test-user", 1, { msgtype: "markdown" })),
		/connection closed/,
	);
	ws.close();
	await result;
});

test("close diagnostics include the close code, clean flag and connection lifetime without exposing secrets", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const logs: string[] = [];
	client = new WeComClient({
		botId: "test-bot",
		secret: "test-secret",
		log: (line) => logs.push(line),
		createWebSocket: (url) => new FakeWebSocket(url),
	});
	const ws = connect();
	t.mock.timers.tick(12_345);
	ws.close(1006, "closed test-secret");
	assert.ok(
		logs.some((line) => /code=1006.*uptime=12345ms.*clean=false/.test(line)),
		logs.join("\n"),
	);
	assert.equal(
		logs.some((line) => line.includes("test-secret")),
		false,
	);
});

test("a push attempted before subscription is known unsent and does not start a connection", async () => {
	await assert.rejects(client.sendMsg("test-user", 1, {}), { outcome: "not_sent" });
	assert.equal(FakeWebSocket.instances.length, 0);
});

test("an acknowledgement timeout has an unknown outcome, not a retryable unsent one", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	connect();
	const rejected = assert.rejects(client.sendMsg("test-user", 1, {}), { outcome: "unknown" });
	t.mock.timers.tick(10_000);
	await rejected;
});

test("starting twice retains a single live connection", () => {
	connect();
	client.start();
	assert.equal(FakeWebSocket.instances.length, 1);
	assert.equal(client.isReady(), true);
});

test("a successful command resolves with its matching acknowledgement", async () => {
	const ws = connect();
	const pending = client.sendMsg("test-user", 1, { msgtype: "markdown" });
	ws.acknowledge();
	assert.equal((await pending).errcode, 0);
});

test("server errors reject commands instead of looking like success", async () => {
	const ws = connect();
	const result = assert.rejects(client.sendMsg("test-user", 1, {}), /rejected/);
	ws.acknowledge(undefined, 40014);
	await result;
});

test("registers a command before a synchronous acknowledgement arrives", async () => {
	const ws = connect();
	ws.onSend = (frame) => ws.acknowledge(frame);
	const response = await deadline(client.sendMsg("test-user", 1, {}));
	assert.notEqual(response, "still pending");
});

test("an unacknowledged subscription times out and reconnects", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	client.start();
	const ws = FakeWebSocket.instances[0];
	ws.open();
	t.mock.timers.tick(10_000);
	assert.equal(ws.readyState, 3);
	assert.equal(client.getState(), "disconnected");
	t.mock.timers.tick(1000);
	assert.equal(FakeWebSocket.instances.length, 2);
});

test("an unacknowledged heartbeat closes a half-open connection", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const ws = connect();
	t.mock.timers.tick(30_000);
	assert.equal(ws.sent.at(-1).cmd, "ping");
	t.mock.timers.tick(10_000);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(ws.readyState, 3);
	assert.equal(client.isReady(), false);
});

test("a rejected subscription is retried with backoff and given up after five refusals, until start", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	client.start();
	for (const [index, delay] of [1000, 2000, 4000, 8000, 0].entries()) {
		const ws = FakeWebSocket.instances[index];
		ws.open();
		ws.acknowledge(undefined, 40001);
		if (delay) t.mock.timers.tick(delay);
	}
	assert.equal(FakeWebSocket.instances.length, 5);
	assert.equal(client.stopped, true, "wrong credentials do not hammer the rate-limited subscription");
	t.mock.timers.tick(60_000);
	assert.equal(FakeWebSocket.instances.length, 5);
	client.start();
	assert.equal(FakeWebSocket.instances.length, 6);
	assert.equal(client.stopped, false);
});

test("image upload uses init, 512KB chunks and finish, then returns media_id", async () => {
	const ws = connect();
	ws.onSend = (frame: any) => {
		if (frame.cmd === "aibot_upload_media_init")
			ws.receive({ headers: frame.headers, errcode: 0, errmsg: "ok", body: { upload_id: "upload-1" } });
		else if (frame.cmd === "aibot_upload_media_chunk")
			ws.receive({ headers: frame.headers, errcode: 0, errmsg: "ok" });
		else if (frame.cmd === "aibot_upload_media_finish")
			ws.receive({ headers: frame.headers, errcode: 0, errmsg: "ok", body: { media_id: "media-1" } });
	};
	const data = Buffer.alloc(600 * 1024, 7);
	assert.equal(await client.uploadImage(data, "screen.png"), "media-1");
	const init = ws.sent.find((frame) => frame.cmd === "aibot_upload_media_init");
	assert.equal(init.body.type, "image");
	assert.equal(init.body.filename, "screen.png");
	assert.equal(init.body.total_size, data.length);
	assert.equal(init.body.total_chunks, 2);
	assert.match(init.body.md5, /^[a-f0-9]{32}$/);
	const chunks = ws.sent.filter((frame) => frame.cmd === "aibot_upload_media_chunk");
	assert.deepEqual(
		chunks.map((frame) => frame.body.chunk_index),
		[0, 1],
	);
	assert.equal(Buffer.from(chunks[0].body.base64_data, "base64").length, 512 * 1024);
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_upload_media_finish").length, 1);
});

test("a rejected upload init fails as rejected instead of pretending a media_id exists", async () => {
	const ws = connect();
	ws.onSend = (frame: any) => ws.acknowledge(frame, 40006);
	await assert.rejects(client.uploadImage(Buffer.from("not-a-png")), { outcome: "rejected" });
});

test("chunk uploads retry once when the acknowledgement is lost, while the upload_id and index stay idempotent", async () => {
	const ws = connect();
	let chunks = 0;
	ws.onSend = (frame: any) => {
		if (frame.cmd === "aibot_upload_media_init")
			ws.receive({ headers: frame.headers, errcode: 0, body: { upload_id: "upload-1" } });
		else if (frame.cmd === "aibot_upload_media_chunk") {
			chunks += 1;
			if (chunks === 1) ws.receive({ headers: frame.headers, errcode: 5000, errmsg: "temporary" });
			else ws.acknowledge(frame);
		} else if (frame.cmd === "aibot_upload_media_finish")
			ws.receive({ headers: frame.headers, errcode: 0, body: { media_id: "media-1" } });
	};
	assert.equal(await client.uploadImage(Buffer.alloc(32, 1)), "media-1");
	const sent = ws.sent.filter((frame) => frame.cmd === "aibot_upload_media_chunk");
	assert.equal(sent.length, 2);
	assert.equal(sent[0].body.chunk_index, sent[1].body.chunk_index);
	assert.equal(sent[0].body.upload_id, sent[1].body.upload_id);
});
