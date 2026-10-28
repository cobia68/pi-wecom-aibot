import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { sessionControlCard } from "../../src/extension/control-view.ts";
import { GatewayClient, type GatewayClientOptions } from "../../src/extension/gateway-client.ts";
import { type GatewayServer, startGatewayServer } from "../../src/gateway/server.ts";
import { controlCardFor, controlCardId } from "../../src/shared/control-card.ts";
import {
	type ClientFrame,
	GATEWAY_PROTOCOL_VERSION,
	type GatewayRegistration,
	type GatewayTask,
	gatewayEndpoint,
	gatewayProof,
	parseClientFrame,
	parseServerFrame,
	readFrames,
	type ServerFrame,
	sessionTarget,
	writeFrame,
} from "../../src/shared/gateway-protocol.ts";
import { notificationPayload } from "../../src/shared/notification.ts";
import type { SessionSource } from "../../src/shared/notification-types.ts";
import { FakeWebSocket } from "../support/fake-websocket.ts";
import { sandboxHome, socketDirectory } from "../support/home-sandbox.ts";

let config: GatewayClientOptions["config"];
let server: GatewayServer | undefined;
let clients: GatewayClient[];
let autoAcknowledge: boolean;
const user = { chatId: "user", chatType: 1 as const };

/** The same parsers the client and gateway use, so a test fixture cannot accept a frame production rejects. */
function readServerFrames(socket: Socket, receive: (frame: ServerFrame) => void): void {
	readFrames(socket, (value) => {
		const parsed = parseServerFrame(value);
		if (!parsed.ok) throw new Error(parsed.reason);
		receive(parsed.frame);
	});
}

function readClientFrames(socket: Socket, receive: (frame: ClientFrame) => void): void {
	readFrames(socket, (value) => {
		const parsed = parseClientFrame(value);
		if (!parsed.ok) throw new Error(parsed.reason);
		receive(parsed.frame);
	});
}

export async function until(predicate: () => boolean, description: string, timeout = 4000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() >= deadline) assert.fail(`timed out: ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function source(id: string): SessionSource {
	return {
		sessionId: `session-${id}`,
		provider: `provider-${id}`,
		modelName: `model-${id}`,
		directoryName: `directory-${id}`,
	};
}

async function startServer(idleTimeoutMs = 1000) {
	server = await startGatewayServer({
		endpoint: gatewayEndpoint(config.botId),
		credentials: config,
		idleTimeoutMs,
		createWebSocket(url) {
			const socket = new FakeWebSocket(url);
			socket.onSend = (frame) => {
				if (
					["aibot_subscribe", "ping", "aibot_respond_msg"].includes(frame.cmd) ||
					(autoAcknowledge && frame.cmd === "aibot_send_msg")
				)
					socket.acknowledge(frame);
			};
			queueMicrotask(() => socket.open());
			return socket;
		},
	});
	assert.ok(server);
	return server;
}

function client(
	id: string,
	overrides: Partial<GatewayClientOptions["config"]> = {},
	options: Partial<GatewayClientOptions> = {},
) {
	const tasks: GatewayTask[] = [];
	const states: string[] = [];
	const logs: string[] = [];
	const errors: string[] = [];
	const connection: GatewayClient = new GatewayClient({
		config: { ...config, ...overrides },
		source: source(id),
		onTask: (task) => tasks.push(task),
		onState: (state, detail) => states.push(`${state} ${detail ?? ""}`),
		// Session lists ask every pi whether it is busy; these clients are idle.
		onRequest: (requestId, request) => {
			if (request.action === "state") connection.respond(requestId, { ok: true, busy: false });
		},
		log: (message) => logs.push(message),
		onError: (message) => errors.push(message),
		launch: () => {
			throw new Error("tests must not launch a real upstream");
		},
		...options,
	});
	clients.push(connection);
	return { connection, tasks, states, logs, errors };
}

/** A task that names its target; every WeCom task does since routing is explicit. */
function inbound(content: string, extra: Record<string, unknown> = {}, sessionId = "session-A") {
	const id = randomUUID();
	FakeWebSocket.instances.at(-1)!.receive({
		cmd: "aibot_msg_callback",
		headers: { req_id: id },
		body: {
			msgid: id,
			from: { userid: "user" },
			chattype: "single",
			msgtype: "text",
			text: { content: `/wecom-aibot --session-id ${sessionId} send --prompt ${content}` },
			...extra,
		},
	});
}

/** A text message from `user`, as the gateway routes it. */
function messageFor(_id: string, content: string) {
	const reqId = randomUUID();
	const ws = FakeWebSocket.instances.at(-1)!;
	ws.receive({
		cmd: "aibot_msg_callback",
		headers: { req_id: reqId },
		body: {
			msgid: reqId,
			from: { userid: "user" },
			chattype: "single",
			msgtype: "text",
			text: { content },
		},
	});
}

/** pi publishes every notification as its session's control card. */
function notification(id: string, content = id) {
	return {
		...notificationPayload("notice", source(id), content),
		control: { cardId: controlCardId(`session-${id}`), card: sessionControlCard(source(id), { status: "idle" }) },
	};
}

/** A fake gateway on the real endpoint; closed after the test. */
async function fakeGateway(
	t: { after(fn: () => Promise<void>): void },
	endpoint: string,
	accept: (socket: Socket) => void,
) {
	socketDirectory(endpoint);
	const sockets = new Set<Socket>();
	const fake = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		accept(socket);
	});
	await new Promise<void>((resolve) => fake.listen(endpoint, resolve));
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => fake.close(() => resolve()));
	});
}

beforeEach(() => {
	config = { botId: `ipc-test-${randomUUID()}`, secret: "offline-test-secret" };
	FakeWebSocket.instances = [];
	clients = [];
	autoAcknowledge = true;
});
afterEach(async () => {
	for (const connection of clients) connection.stop("test cleanup");
	server?.close();
	await server?.closed;
	server = undefined;
});

test("IPC registers only started clients and last unregister closes the gateway", async () => {
	const running = await startServer(50);
	const a = client("A");
	const b = client("B");
	assert.equal(running.gateway.size, 0);
	assert.equal(FakeWebSocket.instances.length, 0);
	a.connection.start();
	await until(() => a.connection.isReady(), "A registered");
	assert.equal(running.gateway.size, 1);
	inbound("only A started");
	await until(() => a.tasks.length === 1, "single registered target");
	assert.equal(b.tasks.length, 0);
	b.connection.start();
	await until(() => b.connection.isReady(), "B registered");
	assert.equal(FakeWebSocket.instances.length, 1);
	a.connection.stop();
	await until(() => running.gateway.size === 1, "A unregistered");
	await b.connection.notify(user, notification("B"));
	assert.equal(b.connection.isReady(), true);
	b.connection.stop();
	await running.closed;
	assert.equal(FakeWebSocket.instances[0].readyState, 3);
});

test("a temporary IPC registration is hidden and only watches identities while other sessions stay connected", async () => {
	const running = await startServer();
	const a = client("A");
	const identifying = client("I", {}, { identifyOnly: true });
	a.connection.start();
	identifying.connection.start();
	await until(() => a.connection.isReady() && identifying.connection.isReady(), "formal and temporary registrations");
	assert.equal(running.gateway.size, 2, "the temporary client keeps the shared transport alive");
	messageFor("A", "/wecom-aibot sessions");
	await until(
		() =>
			FakeWebSocket.instances[0].sent.some(
				(frame) => frame.body?.template_card?.button_selection?.question_key === "pick",
			),
		"session chooser",
	);
	const list = FakeWebSocket.instances[0].sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1)
		.body.template_card;
	assert.equal(list.main_title.title, "1 个在线会话");
	assert.doesNotMatch(JSON.stringify(list), /session-I/);
	inbound("cannot run", {}, "session-I");
	await assert.rejects(identifying.connection.notify(user, notification("I")), /临时识别连接/);
	assert.equal(identifying.tasks.length, 0);
	let code: string | undefined;
	const identity = identifying.connection.watchIdentity(60_000, undefined, (issued) => {
		code = issued;
	});
	await until(() => code !== undefined, "one-time code");
	messageFor("I", code!);
	assert.deepEqual(await identity, { chatId: "user", chatType: 1, userid: "user" });
	assert.equal(identifying.tasks.length, 0);
	identifying.connection.stop();
	await until(() => running.gateway.size === 1, "temporary registration closed");
	inbound("A continues");
	await until(() => a.tasks.length === 1, "A receives its own task");
	assert.equal(FakeWebSocket.instances.length, 1);
});

test("a registration arriving during the idle grace period retains the same gateway", async () => {
	const running = await startServer(250);
	const a = client("A");
	a.connection.start();
	await until(() => a.connection.isReady(), "A ready");
	a.connection.stop();
	await until(() => running.gateway.size === 0, "A gone");
	const b = client("B");
	b.connection.start();
	await until(() => b.connection.isReady(), "B ready");
	assert.equal(FakeWebSocket.instances.length, 1);
	await b.connection.notify(user, notification("B"));
});

test("a pi cannot send a notification labelled with another pi's session", async () => {
	await startServer();
	const a = client("A");
	const b = client("B");
	a.connection.start();
	b.connection.start();
	await until(() => a.connection.isReady() && b.connection.isReady(), "both ready");
	const ws = FakeWebSocket.instances[0];
	const count = ws.sent.length;
	await assert.rejects(a.connection.notify(user, notification("B")), /session/);
	assert.equal(ws.sent.length, count);
	await a.connection.notify(user, notification("A"));
	await b.connection.notify({ chatId: "group", chatType: 2 }, notification("B"));
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 2);
	for (const [index, id] of ["A", "B"].entries()) {
		const card = pushes[index].body.template_card;
		assert.equal(card.main_title.title, `📁 directory-${id}`);
		assert.equal(card.main_title.desc, `🤖 model-${id} · provider-${id}`);
		assert.ok(controlCardFor(card.task_id, `session-${id}`));
	}
	assert.equal(pushes[1].body.chat_type, 2);
});

test("IPC carries a cancel request to the pi and returns its answer", async () => {
	await startServer();
	const requests: { id: string; request: any }[] = [];
	const a = client("A", {}, { onRequest: (id, request) => requests.push({ id, request }) });
	a.connection.start();
	await until(() => a.connection.isReady(), "A ready");
	messageFor("A", "/wecom-aibot --session-id session-A cancel");
	await until(() => requests.length === 1, "request delivered");
	assert.equal(requests[0].request.action, "cancel");
	a.connection.respond(requests[0].id, { ok: false, error: "这一轮已结束" });
	await until(
		() =>
			FakeWebSocket.instances[0].sent.some((frame) =>
				String(frame.body?.stream?.content ?? "").includes("中止请求未送达：这一轮已结束"),
			),
		"failure reported",
	);
});

test("IPC carries a target-only live-state query to just that pi and keeps no selected target", async () => {
	await startServer();
	let busy = true;
	let askedA = 0;
	let askedB = 0;
	const a = client(
		"A",
		{},
		{
			onRequest: (id, request) => {
				assert.equal(request.action, "state");
				askedA++;
				a.connection.respond(id, { ok: true, busy });
			},
		},
	);
	const b = client(
		"B",
		{},
		{
			onRequest: () => {
				askedB++;
			},
		},
	);
	a.connection.start();
	b.connection.start();
	await until(() => a.connection.isReady() && b.connection.isReady(), "both ready");
	const ws = FakeWebSocket.instances[0];
	const replies = () => ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg");
	messageFor("A", "/wecom-aibot --session-id session-A");
	await until(() => replies().length === 1, "single-session busy reply");
	assert.equal(
		replies()[0].body.stream.content,
		[
			"· directory-A · provider-A · model-A · 执行中",
			"",
			"/wecom-aibot --session-id session-A send --prompt <正文>",
			"/wecom-aibot --session-id session-A card",
			"/wecom-aibot --session-id session-A cancel",
		].join("\n"),
	);
	busy = false;
	messageFor("A", "/wecom-aibot --session-id session-A");
	await until(() => replies().length === 2, "single-session idle reply");
	assert.match(replies()[1].body.stream.content, /^· directory-A · provider-A · model-A · 空闲\n/);
	messageFor("A", "/wecom-aibot cancel");
	await until(() => replies().length === 3, "missing target reply");
	assert.match(replies()[2].body.stream.content, /^cancel 需要目标：/);
	assert.equal(askedA, 2);
	assert.equal(askedB, 0, "B is neither polled nor operated on");
	assert.equal(a.tasks.length + b.tasks.length, 0);
});

test("IPC preserves a known-unsent outcome when upstream readiness is stale", async () => {
	await startServer();
	const a = client("A");
	a.connection.start();
	await until(() => a.connection.isReady(), "A ready");
	const ws = FakeWebSocket.instances[0];
	ws.readyState = 2;
	await assert.rejects(a.connection.notify(user, notification("A")), { outcome: "not_sent" });
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
});

test("IPC reports an explicit WeCom rejection without treating it as retryable", async () => {
	await startServer();
	const a = client("A");
	a.connection.start();
	await until(() => a.connection.isReady(), "A ready");
	autoAcknowledge = false;
	const rejected = assert.rejects(a.connection.notify(user, notification("A")), { outcome: "rejected" });
	const ws = FakeWebSocket.instances[0];
	const pushes = () => ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	await until(() => pushes().length === 1, "card attempted");
	ws.acknowledge(pushes()[0], 40014);
	// A refused card is sent once more as Markdown; only when that is refused too is the notification rejected.
	await until(() => pushes().length === 2, "Markdown fallback attempted");
	assert.equal(pushes()[0].body.msgtype, "template_card");
	assert.equal(pushes()[1].body.msgtype, "markdown");
	assert.match(pushes()[1].body.markdown.content, /^🆔 session: session-A/);
	ws.acknowledge(pushes()[1], 40014);
	await rejected;
});

test("an unconfirmed send in an exiting pi cannot resolve another pi's notification", async () => {
	await startServer();
	const a = client("A");
	const b = client("B");
	a.connection.start();
	b.connection.start();
	await until(() => a.connection.isReady() && b.connection.isReady(), "both ready");
	autoAcknowledge = false;
	const first = a.connection.notify(user, notification("A"));
	const rejected = assert.rejects(first, /stopped|未知/);
	const second = b.connection.notify({ chatId: "group", chatType: 2 }, notification("B"));
	const ws = FakeWebSocket.instances[0];
	await until(
		() => ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length === 2,
		"both sends reached upstream",
	);
	a.connection.stop();
	const [frameA, frameB] = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	ws.acknowledge(frameA);
	ws.acknowledge(frameB);
	await rejected;
	await second;
	assert.equal(b.connection.isReady(), true);
});

test("a duplicate session is refused without replacing its current pi", async () => {
	const running = await startServer();
	const a = client("A");
	a.connection.start();
	await until(() => a.connection.isReady(), "original ready");
	const duplicate = client("A");
	duplicate.connection.start();
	await until(() => duplicate.states.some((line) => line.includes("另一个 pi 注册")), "duplicate refused");
	assert.equal(running.gateway.size, 1);
	assert.equal(a.connection.isReady(), true);
	inbound("owner");
	await until(() => a.tasks.length === 1, "original receives task");
	assert.equal(duplicate.tasks.length, 0);
});

test("wrong credentials cannot register or replace the shared upstream connection", async () => {
	const running = await startServer();
	const a = client("A");
	a.connection.start();
	await until(() => a.connection.isReady(), "original ready");
	const wrong = client("B", { secret: "different-secret" });
	wrong.connection.start();
	await until(() => wrong.states.some((line) => line.includes("认证失败")), "credentials refused");
	assert.equal(running.gateway.size, 1);
	assert.equal(FakeWebSocket.instances.length, 1);
	assert.equal(a.connection.isReady(), true);
});

test("after a Secret rotation the client waits for the old gateway to exit, then launches its own", async () => {
	const old = await startServer(200);
	const a = client("A");
	a.connection.start();
	await until(() => a.connection.isReady(), "old configuration ready");
	// /wecom-aibot setup: the old registration leaves, and the old gateway is still in its idle grace.
	a.connection.stop();
	const rotated = { ...config, secret: "rotated-secret" };
	const launches: string[] = [];
	const failures: unknown[] = [];
	const b = client(
		"A",
		{ secret: rotated.secret },
		{
			launch: (_endpoint, credentials) => {
				launches.push(credentials.secret);
				config = rotated;
				startServer().catch((error: unknown) => failures.push(error));
			},
		},
	);
	b.connection.start();
	await until(() => b.connection.isReady(), "registered with the rotated Secret", 8000);
	await old.closed;
	assert.deepEqual(failures, []);
	assert.deepEqual(b.errors, [], "a gateway that is about to exit is not reported as a failure");
	assert.deepEqual(launches, ["rotated-secret"]);
	assert.ok(
		b.states.some((line) => line.includes("等待旧网关退出")),
		"the old gateway was met and retried",
	);
	assert.equal(FakeWebSocket.instances.at(-1)!.sent[0].body.secret, "rotated-secret");
});

test("a gateway that keeps other credentials is reported once after the retry window", async () => {
	const running = await startServer();
	const a = client("A");
	a.connection.start();
	await until(() => a.connection.isReady(), "original ready");
	const wrong = client("B", { secret: "different-secret" }, { retryMs: 300 });
	wrong.connection.start();
	await until(() => wrong.errors.length === 1, "mismatch reported");
	assert.match(wrong.errors[0], /认证失败.*\/wecom-aibot connect/);
	assert.ok(wrong.states.filter((line) => line.includes("等待旧网关退出")).length >= 2, "retried before reporting");
	const settled = wrong.states.length;
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal(wrong.states.length, settled, "no further attempts after the report");
	assert.equal(wrong.errors.length, 1);
	assert.equal(wrong.connection.isReady(), false);
	assert.equal(running.gateway.size, 1);
	assert.equal(a.connection.isReady(), true);
});

test("model metadata updates reach the session list", async () => {
	await startServer();
	const a = client("A");
	a.connection.start();
	await until(() => a.connection.isReady(), "ready");
	a.connection.updateSource({
		...source("A"),
		provider: "new-provider",
		modelName: "new-model",
		directoryName: "new-directory",
	});
	// The acknowledged send follows the metadata update in the same ordered IPC channel.
	await a.connection.notify(user, notification("A"));
	messageFor("A", "/wecom-aibot sessions");
	const replies = () =>
		FakeWebSocket.instances[0].sent.filter(
			(frame) => frame.body?.template_card?.button_selection?.question_key === "pick",
		);
	await until(() => replies().length > 0, "session chooser");
	const list = replies().at(-1).body.template_card;
	assert.equal(list.button_selection.option_list[0].text, "new-direc… · on-A · 空闲");
	assert.deepEqual(list.horizontal_content_list[0], { keyname: "空闲", value: "new-directory · on-A · new-model" });
	// The list leaves the provider out; querying this ID still exposes its full metadata.
	messageFor("A", "/wecom-aibot --session-id session-A");
	const details = () => FakeWebSocket.instances[0].sent.filter((frame) => frame.cmd === "aibot_respond_msg");
	await until(() => details().length > 0, "session details");
	assert.match(details().at(-1).body.stream.content, /new-directory · new-provider · new-model · 空闲/);
});

test("clients re-register the same identity after a gateway crash", async () => {
	const first = await startServer();
	const a = client("A");
	const b = client("B");
	a.connection.start();
	b.connection.start();
	await until(() => a.connection.isReady() && b.connection.isReady(), "initial registration");
	first.close();
	await first.closed;
	await until(() => !a.connection.isReady() && !b.connection.isReady(), "disconnect observed");
	await startServer();
	await until(() => a.connection.isReady() && b.connection.isReady(), "both re-registered");
	inbound("B only", {}, "session-B");
	await until(() => b.tasks.length === 1, "B receives after recovery");
	assert.equal(a.tasks.length, 0);
});

test("client drops inbound tasks tagged for another instance, registration or session, and malformed ones", async (t) => {
	const endpoint = gatewayEndpoint(config.botId);
	let registration: GatewayRegistration | undefined;
	let wire: Socket | undefined;
	await fakeGateway(t, endpoint, (socket) => {
		wire = socket;
		const nonce = randomUUID();
		readClientFrames(socket, (frame) => {
			if (frame.type === "hello") {
				writeFrame(socket, {
					type: "hello",
					version: GATEWAY_PROTOCOL_VERSION,
					nonce,
					endpoint,
					proof: gatewayProof(config.secret, "server", nonce, frame.nonce, endpoint),
				});
			} else if (frame.type === "register") {
				registration = frame.registration;
				writeFrame(socket, { type: "registered", status: { state: "subscribed", sessions: 1 } });
			}
		});
	});
	const a = client("A");
	a.connection.start();
	await until(() => a.connection.isReady() && !!registration, "fake handshake complete");
	assert.doesNotMatch(JSON.stringify(registration), /offline-test-secret/, "a registration never carries the Secret");
	const target = sessionTarget(registration!);
	const task: GatewayTask = {
		id: "test",
		message: {
			msgId: "m",
			msgtype: "text",
			chat: { chatId: "user", chatType: 1 },
			userid: "user",
			text: "task",
			attachments: [],
		},
	};
	for (const key of ["instanceId", "registrationId", "sessionId"] as const) {
		writeFrame(wire!, { type: "task", target: { ...target, [key]: "wrong" }, task });
	}
	writeFrame(wire!, {
		type: "task",
		target,
		task: { ...task, message: { ...task.message, chat: { chatId: "", chatType: 1 } } },
	});
	writeFrame(wire!, { type: "task", target, task });
	await until(() => a.tasks.length === 1, "valid task delivered");
	assert.equal(a.logs.filter((line) => line.includes("rejected inbound")).length, 3);
	assert.equal(
		a.logs.filter((line) => line.includes("共享网关发送了无效数据")).length,
		1,
		"a malformed task is named and dropped, not routed",
	);
});

test("the server refuses a notification labelled with another session, even on an authenticated connection", async (t) => {
	await startServer();
	const endpoint = gatewayEndpoint(config.botId);
	const socket = createConnection(endpoint);
	const frames: ServerFrame[] = [];
	const clientNonce = randomUUID();
	const registration: GatewayRegistration = {
		instanceId: "raw",
		registrationId: "raw-registration",
		source: source("A"),
		config: { botId: config.botId },
	};
	t.after(() => socket.destroy());
	socket.on("error", () => {});
	readServerFrames(socket, (frame) => {
		frames.push(frame);
		if (frame.type !== "hello") return;
		writeFrame(socket, {
			type: "register",
			registration,
			proof: gatewayProof(config.secret, "client", frame.nonce, clientNonce, endpoint),
		});
	});
	socket.once("connect", () =>
		writeFrame(socket, { type: "hello", version: GATEWAY_PROTOCOL_VERSION, nonce: clientNonce }),
	);
	await until(
		() => frames.some((frame) => frame.type === "status" && frame.status.state === "subscribed"),
		"raw client registered",
	);
	const count = FakeWebSocket.instances[0].sent.length;
	writeFrame(socket, { type: "notify", id: "forged", chat: user, notification: notification("B") });
	await until(() => frames.some((frame) => frame.type === "result" && frame.id === "forged"), "forged send rejected");
	const result = frames.find((frame) => frame.type === "result" && frame.id === "forged");
	assert.ok(result?.type === "result" && result.error?.includes("session"));
	assert.equal(FakeWebSocket.instances[0].sent.length, count);
});

test("the gateway sends nothing before the client's hello and refuses another protocol version", async (t) => {
	await startServer();
	const socket = createConnection(gatewayEndpoint(config.botId));
	t.after(() => socket.destroy());
	socket.on("error", () => {});
	const frames: ServerFrame[] = [];
	readServerFrames(socket, (frame) => frames.push(frame));
	await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(frames.length, 0, "a connection that only listens learns nothing");
	writeFrame(socket, { type: "hello", version: 1, nonce: randomUUID() });
	await until(() => frames.length > 0, "version refused");
	assert.equal(frames[0].type, "fatal");
});

test("a captured gateway hello cannot be replayed: a fake gateway without the Secret learns and injects nothing", async (t) => {
	const real = await startServer();
	const endpoint = gatewayEndpoint(config.botId);
	// Anyone who can connect obtains a hello, for a client nonce of their choosing.
	const captured = await new Promise<ServerFrame>((resolve) => {
		const socket = createConnection(endpoint);
		socket.on("error", () => {});
		readServerFrames(socket, (frame) => {
			resolve(frame);
			socket.destroy();
		});
		socket.once("connect", () =>
			writeFrame(socket, { type: "hello", version: GATEWAY_PROTOCOL_VERSION, nonce: randomUUID() }),
		);
	});
	assert.equal(captured.type, "hello");
	real.close();
	await real.closed;
	const received: { type: string }[] = [];
	await fakeGateway(t, endpoint, (socket) => {
		readClientFrames(socket, (frame) => {
			received.push(frame);
			if (frame.type !== "hello") return;
			writeFrame(socket, captured);
			writeFrame(socket, { type: "registered", status: { state: "subscribed", sessions: 1 } });
		});
	});
	const victim = client("A", { allowedUserIds: ["private-user"] }, { retryMs: 300 });
	victim.connection.start();
	await until(() => victim.errors.length === 1, "replayed hello rejected");
	assert.match(victim.errors[0], /认证失败/);
	assert.ok(
		received.length > 0 && received.every((frame) => frame.type === "hello"),
		"the fake gateway never received a registration",
	);
	assert.doesNotMatch(JSON.stringify(received), /private-user/);
	assert.equal(victim.tasks.length, 0);
	assert.equal(victim.connection.isReady(), false);
});

test("whoami over IPC hands out a one-time code; only that code identifies the chat, a task is still a task", async () => {
	await startServer();
	const a = client("A");
	a.connection.start();
	await until(() => a.connection.isReady(), "A ready");
	let code: string | undefined;
	const identity = a.connection.watchIdentity(60_000, undefined, (issued) => {
		code = issued;
	});
	await until(() => code !== undefined, "one-time code");
	assert.match(code!, /^\d{6}$/);
	// While the code waits, other messages are routed as usual.
	inbound("a real task");
	await until(() => a.tasks.length === 1, "a task during the wait");
	const id = randomUUID();
	FakeWebSocket.instances.at(-1)!.receive({
		cmd: "aibot_msg_callback",
		headers: { req_id: id },
		body: { msgid: id, from: { userid: "user_one" }, chattype: "single", msgtype: "text", text: { content: code } },
	});
	assert.deepEqual(await identity, { chatId: "user_one", chatType: 1, userid: "user_one" });
	assert.equal(a.tasks.length, 1);
	const receipt = FakeWebSocket.instances[0].sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1);
	assert.match(receipt.body.stream.content, /whoami 已识别当前单聊/);
});

test("cancelling or timing out whoami retires its code", async () => {
	await startServer();
	const a = client("A");
	a.connection.start();
	await until(() => a.connection.isReady(), "A ready");
	const cancel = new AbortController();
	let code: string | undefined;
	const cancelled = a.connection.watchIdentity(60_000, cancel.signal, (issued) => {
		code = issued;
	});
	await until(() => code !== undefined, "one-time code");
	cancel.abort();
	await assert.rejects(cancelled, { name: "AbortError" });
	await assert.rejects(a.connection.watchIdentity(50), { name: "TimeoutError" });
	// The unwatch travels the same ordered IPC channel as this acknowledged send.
	await a.connection.notify(user, notification("A"));
	const later = a.connection.watchIdentity(200);
	messageFor("A", code!);
	await assert.rejects(later, { name: "TimeoutError" }, "a retired code identifies nothing");
});

test("whoami ends when the gateway connection is lost", async () => {
	const running = await startServer();
	const a = client("A");
	a.connection.start();
	await until(() => a.connection.isReady(), "A ready");
	const waiting = a.connection.watchIdentity(60_000);
	running.close();
	await assert.rejects(waiting, /连接已断开/);
});

test("a protocol-1 gateway on the endpoint is reported after the retry window and never receives a registration", async (t) => {
	const endpoint = gatewayEndpoint(config.botId);
	const received: string[] = [];
	await fakeGateway(t, endpoint, (socket) => {
		// Protocol 1 spoke first, with a proof over its own nonce only.
		writeFrame(socket, { type: "hello", version: 1, endpoint, nonce: randomUUID(), proof: "0".repeat(64) });
		readClientFrames(socket, (frame) => {
			received.push(frame.type);
		});
	});
	const a = client("A", {}, { retryMs: 300 });
	a.connection.start();
	await until(() => a.errors.length === 1, "older gateway reported");
	assert.match(a.errors[0], /插件版本/);
	assert.equal(received.includes("register"), false);
	assert.equal(a.connection.isReady(), false);
});

test("a protocol-2 gateway is not joined or replaced by a competing connection", async (t) => {
	const endpoint = gatewayEndpoint(config.botId);
	const received: string[] = [];
	await fakeGateway(t, endpoint, (socket) => {
		readClientFrames(socket, (frame) => {
			received.push(frame.type);
			if (frame.type !== "hello") return;
			const nonce = randomUUID();
			const proof = createHmac("sha256", config.secret)
				.update(JSON.stringify([2, "server", nonce, frame.nonce, endpoint]))
				.digest("hex");
			writeFrame(socket, { type: "hello", version: 2, endpoint, nonce, proof });
		});
	});
	const launches: string[] = [];
	const a = client(
		"A",
		{},
		{
			retryMs: 300,
			launch: (endpoint) => {
				launches.push(endpoint);
			},
		},
	);
	a.connection.start();
	await until(() => a.errors.length === 1, "protocol-2 gateway reported");
	assert.match(a.errors[0], /插件版本/);
	assert.equal(received.includes("register"), false);
	assert.deepEqual(launches, []);
});

const posixOnly = { skip: process.platform === "win32" && "Windows uses a named pipe" };

test(
	"on POSIX the gateway socket lives in a directory only this user can enter, tightened if it was loose",
	posixOnly,
	async () => {
		const endpoint = gatewayEndpoint(config.botId);
		assert.equal(
			endpoint.startsWith("\0"),
			false,
			"no abstract socket: other local users can neither connect nor take the name",
		);
		assert.equal(dirname(endpoint), join(homedir(), ".pi", "agent", "wecom-aibot", "gateway"));
		mkdirSync(dirname(endpoint), { recursive: true });
		chmodSync(dirname(endpoint), 0o755);
		await startServer();
		assert.equal(statSync(dirname(endpoint)).mode & 0o777, 0o700);
		assert.ok(statSync(endpoint).isSocket());
		assert.equal(statSync(endpoint).mode & 0o777, 0o600);
	},
);

test("a home directory too long for a socket path falls back to a short per-user directory", posixOnly, () => {
	const home = process.env.HOME;
	process.env.HOME = join(sandboxHome, "x".repeat(120));
	try {
		const endpoint = gatewayEndpoint(config.botId);
		assert.match(endpoint, /^\/tmp\/pi-wecom-aibot-\d+\/[0-9a-f]{32}\.sock$/);
		assert.ok(Buffer.byteLength(endpoint) <= 100);
	} finally {
		process.env.HOME = home;
	}
});

test("a socket file left by a killed gateway is recovered by the next one", posixOnly, async () => {
	const endpoint = gatewayEndpoint(config.botId);
	socketDirectory(endpoint);
	const child = spawn(
		process.execPath,
		[
			"-e",
			`require("node:net").createServer().listen(${JSON.stringify(endpoint)}, () => process.stdout.write("listening"))`,
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGKILL");
	await exited;
	assert.ok(statSync(endpoint).isSocket(), "SIGKILL leaves the socket file behind");
	await startServer();
	const a = client("A");
	a.connection.start();
	await until(() => a.connection.isReady(), "registered after recovery");
});
