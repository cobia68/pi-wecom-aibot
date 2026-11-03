import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { WeComClient } from "../../src/gateway/wecom-client.ts";
import { WECOM_IMAGE_MAX_BYTES, WECOM_MEDIA_CHUNK_BYTES } from "../../src/shared/wecom-protocol.ts";
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

test("image upload initializes, chunks at 512 KiB, and finishes with an acknowledged media_id", async () => {
	const ws = connect();
	const data = Buffer.alloc(WECOM_MEDIA_CHUNK_BYTES + 3, 7);
	ws.onSend = (frame) =>
		ws.acknowledge(
			frame,
			0,
			frame.cmd === "aibot_upload_media_init"
				? { upload_id: "upload" }
				: frame.cmd === "aibot_upload_media_finish"
					? { media_id: "media" }
					: undefined,
		);
	assert.equal(await client.uploadImage(data, "reply.png"), "media");
	const frames = ws.sent.filter((frame) => frame.cmd.startsWith("aibot_upload"));
	assert.deepEqual(
		frames.map((frame) => frame.cmd),
		["aibot_upload_media_init", "aibot_upload_media_chunk", "aibot_upload_media_chunk", "aibot_upload_media_finish"],
	);
	assert.deepEqual(frames[0].body, {
		type: "image",
		filename: "reply.png",
		total_size: data.length,
		total_chunks: 2,
		md5: createHash("md5").update(data).digest("hex"),
	});
	assert.deepEqual(
		frames.slice(1, 3).map((frame) => frame.body.chunk_index),
		[0, 1],
	);
	assert.deepEqual(
		Buffer.concat(frames.slice(1, 3).map((frame) => Buffer.from(frame.body.base64_data, "base64"))),
		data,
	);
	assert.deepEqual(frames[3].body, { upload_id: "upload" });
});

test("only idempotent upload chunks are retried once, never init or finish", async () => {
	const ws = connect();
	let chunks = 0;
	ws.onSend = (frame) => {
		if (frame.cmd === "aibot_upload_media_chunk" && ++chunks === 1) ws.acknowledge(frame, 40014);
		else ws.acknowledge(frame, 0, frame.cmd === "aibot_upload_media_init" ? { upload_id: "u" } : { media_id: "m" });
	};
	assert.equal(await client.uploadImage(Buffer.alloc(32)), "m");
	assert.equal(chunks, 2);
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_upload_media_init").length, 1);
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_upload_media_finish").length, 1);
	ws.onSend = (frame) =>
		ws.acknowledge(frame, frame.cmd === "aibot_upload_media_chunk" ? 40014 : 0, { upload_id: "u" });
	await assert.rejects(client.uploadImage(Buffer.alloc(32)), { outcome: "rejected" });
});

test("invalid image sizes or names and missing upload IDs fail without a fake success", async () => {
	const ws = connect();
	const before = ws.sent.length;
	for (const data of [Buffer.alloc(0), Buffer.alloc(WECOM_IMAGE_MAX_BYTES + 1)])
		await assert.rejects(client.uploadImage(data), { outcome: "rejected" });
	for (const name of ["../a.png", "..\\a.png", "图".repeat(100)])
		await assert.rejects(client.uploadImage(Buffer.alloc(32), name), { outcome: "rejected" });
	assert.equal(ws.sent.length, before);
	ws.onSend = (frame) => ws.acknowledge(frame);
	await assert.rejects(client.uploadImage(Buffer.alloc(32)), /upload_id/);
	ws.onSend = (frame) => ws.acknowledge(frame, 0, { upload_id: "u" });
	await assert.rejects(client.uploadImage(Buffer.alloc(32)), /media_id/);
});

test("an upload validates its registration between acknowledgements, before sending the next chunk", async () => {
	const ws = connect();
	let active = true;
	ws.onSend = (frame) => {
		active = false;
		ws.acknowledge(frame, 0, { upload_id: "u" });
	};
	await assert.rejects(
		client.uploadImage(Buffer.alloc(32), "reply.png", () => {
			if (!active) throw new Error("registration stopped");
		}),
		/registration stopped/,
	);
	assert.equal(ws.sent.filter((frame) => frame.cmd.startsWith("aibot_upload")).length, 1);
});

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

test("a welcome uses its event req_id and the dedicated command, acknowledged like other sends", async () => {
	const ws = connect();
	const body = { msgtype: "template_card", template_card: { task_id: "p@0123456789ab" } };
	const pending = client.respondWelcome("enter-event", body);
	assert.deepEqual(ws.sent.at(-1), { cmd: "aibot_respond_welcome_msg", headers: { req_id: "enter-event" }, body });
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

test("acknowledged 30-second heartbeats keep an idle connection subscribed well beyond 120 seconds", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const ws = connect();
	ws.onSend = (frame) => ws.acknowledge(frame);
	for (let tick = 0; tick < 10; tick++) {
		t.mock.timers.tick(30_000);
		assert.equal(client.isReady(), true);
		assert.equal(ws.readyState, 1);
	}
	assert.equal(FakeWebSocket.instances.length, 1);
	const heartbeats = ws.sent.filter((frame) => frame.cmd === "ping");
	assert.equal(heartbeats.length, 10);
	assert.equal(new Set(heartbeats.map((frame) => frame.headers.req_id)).size, 10);
	assert.ok(heartbeats.every((frame) => frame.body === undefined));
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
