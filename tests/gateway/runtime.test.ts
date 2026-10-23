import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { inspectPng, stampPng } from "../../src/gateway/png-marker.ts";
import { type GatewayPeer, WeComGateway } from "../../src/gateway/runtime.ts";
import { type GatewayRegistration, type ServerFrame, sessionTarget } from "../../src/shared/gateway-protocol.ts";
import { formatProcessingStatus, notificationPayload } from "../../src/shared/notification.ts";
import { FakeWebSocket } from "../support/fake-websocket.ts";
import { encryptMedia, MEDIA_KEY, TINY_PNG } from "../support/media.ts";

const SESSION_A = "01234567-89ab-4cde-8012-3456789abcde";
const SESSION_B = "01234567-89ab-4cde-8012-3456789abcdf";
let gateway: WeComGateway;
let sandbox: string;
let sequence = 0;

class Peer implements GatewayPeer {
	frames: ServerFrame[] = [];
	closed = false;
	/** The answer to a state question; undefined stays silent. */
	busy: boolean | undefined = false;
	constructor(private readonly instanceId: string) {}
	send(frame: ServerFrame): boolean {
		if (this.closed) return false;
		this.frames.push(frame);
		if (frame.type === "request" && frame.request.action === "state" && this.busy !== undefined)
			gateway.response(this.instanceId, frame.id, { ok: true, busy: this.busy });
		return true;
	}
	close(): void {
		this.closed = true;
	}
	messages() {
		return this.frames.filter((frame) => frame.type === "task");
	}
	/** The one-time code of the watch with this id, as the gateway announced it. */
	code(id: string): string {
		const frame = this.frames.find((item) => item.type === "watching" && item.id === id);
		assert.ok(frame?.type === "watching", `no code for ${id}`);
		return frame.code;
	}
	identities() {
		return this.frames.filter((frame) => frame.type === "identity");
	}
}

function registration(instanceId: string, sessionId = instanceId): GatewayRegistration {
	return {
		instanceId,
		registrationId: `registration-${instanceId}`,
		source: {
			sessionId,
			provider: `provider-${instanceId}`,
			modelName: `model-${instanceId}`,
			directoryName: `project-${instanceId}`,
		},
		config: { botId: "unit-bot" },
	};
}

function add(instanceId: string, sessionId = instanceId, modify?: (value: GatewayRegistration) => void) {
	const value = registration(instanceId, sessionId);
	modify?.(value);
	const peer = new Peer(instanceId);
	gateway.register(value, peer);
	const ws = FakeWebSocket.instances.at(-1)!;
	ws.onSend = (frame) => {
		if (frame.cmd === "aibot_upload_media_init")
			ws.receive({ headers: frame.headers, errcode: 0, errmsg: "ok", body: { upload_id: "upload-1" } });
		else if (frame.cmd === "aibot_upload_media_chunk") ws.acknowledge(frame);
		else if (frame.cmd === "aibot_upload_media_finish")
			ws.receive({ headers: frame.headers, errcode: 0, errmsg: "ok", body: { media_id: "media-1" } });
	};
	if (ws.readyState === 0) {
		ws.open();
		ws.acknowledge();
	}
	return { value, peer, ws };
}

function message(content: string, body: Record<string, unknown> = {}) {
	const id = `message-${++sequence}`;
	const frame = {
		cmd: "aibot_msg_callback",
		headers: { req_id: id },
		body: {
			msgid: id,
			from: { userid: "user" },
			chattype: "single",
			msgtype: "text",
			text: { content },
			...body,
		},
	};
	FakeWebSocket.instances.at(-1)!.receive(frame);
	return frame;
}

function send(sessionId: string, text: string, body: Record<string, unknown> = {}) {
	return message(`/wecom-aibot send --sessionid ${sessionId} --prompt ${text}`, body);
}

/** Screen and cancel requests; the state questions of session lists are left out. */
function requests(peer: Peer) {
	return peer.frames.filter(
		(frame): frame is Extract<ServerFrame, { type: "request" }> =>
			frame.type === "request" && frame.request.action !== "state",
	);
}

function quote(sessionId: string) {
	return {
		msgtype: "text",
		text: { content: `project · 会话通知\nprovider · model\nsession: ${sessionId}\n\nresult` },
	};
}
function prompt(): string {
	return FakeWebSocket.instances.at(-1)!.sent.at(-1).body.stream.content;
}

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "pi-wecom-aibot-runtime-"));
	FakeWebSocket.instances = [];
	sequence = 0;
	gateway = new WeComGateway({
		botId: "unit-bot",
		secret: "unit-secret",
		createWebSocket: (url) => new FakeWebSocket(url),
	});
});
afterEach(() => {
	gateway.stop();
	rmSync(sandbox, { recursive: true, force: true });
});
function dir(): string {
	return sandbox;
}

test("only registered pi instances create and share the single WeCom connection", () => {
	assert.equal(FakeWebSocket.instances.length, 0);
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	assert.equal(gateway.size, 2);
	assert.equal(FakeWebSocket.instances.length, 1);
	assert.equal(a.ws.sent.filter((frame) => frame.cmd === "aibot_subscribe").length, 1);
	gateway.unregister(a.value.instanceId, a.peer);
	assert.equal(gateway.size, 1);
	send(SESSION_B, "still works");
	assert.equal(b.peer.messages().length, 1);
	assert.equal(a.peer.messages().length, 0);
	assert.equal(a.ws.readyState, 1);
});

test("a message without a target never reaches a pi: it teaches the command instead", () => {
	const a = add("A", SESSION_A);
	message("just a task");
	assert.equal(a.peer.messages().length, 0);
	assert.match(prompt(), /先指定目标会话/);
	assert.match(prompt(), /\/wecom-aibot sessions/);
});

test("a message that arrives after the last pi unregistered names the way back", () => {
	const a = add("A", SESSION_A);
	gateway.unregister(a.value.instanceId, a.peer);
	message("hello");
	assert.match(prompt(), /没有在线的 pi 会话/);
	assert.match(prompt(), /\/wecom-aibot connect/);
});

test("send names its target, and the target receives exactly the prompt", () => {
	const a = add("A", SESSION_A);
	send(SESSION_A, "检查构建");
	assert.deepEqual(a.peer.messages()[0].target, sessionTarget(a.value));
	assert.equal(a.peer.messages()[0].task.message.text, "检查构建");
});

test("a task's text result replaces its status message instead of a second push", async () => {
	const a = add("A", SESSION_A);
	const frames: any[] = [];
	a.ws.onSend = (frame: any) => {
		frames.push(frame);
		if (frame.cmd === "aibot_respond_msg") a.ws.acknowledge(frame);
	};
	const task = send(SESSION_A, "task");
	const id = task.headers.req_id;
	assert.equal(gateway.taskStatus("A", id, "running"), true);
	assert.equal(gateway.taskStatus("A", id, "settled"), true);
	await gateway.notify(
		"A",
		{ chatId: "user", chatType: 1 },
		{ kind: "reply", source: a.value.source, text: "RESULT-BODY", taskId: id },
	);
	const finish = frames.filter((frame) => frame.cmd === "aibot_respond_msg" && frame.body.stream.finish).at(-1);
	assert.match(finish.body.stream.content, /RESULT-BODY$/);
	assert.match(finish.body.stream.content, new RegExp(`session: ${SESSION_A}`));
	assert.equal(frames.filter((frame) => frame.cmd === "aibot_send_msg").length, 0, "one bubble per task");
});

test("a result the status message refuses closes the status once, then is pushed", async () => {
	const a = add("A", SESSION_A);
	const frames: any[] = [];
	a.ws.onSend = (frame: any) => {
		frames.push(frame);
		if (frame.cmd === "aibot_respond_msg" && /RESULT-BODY/.test(frame.body.stream.content))
			a.ws.receive({ headers: frame.headers, errcode: 40008, errmsg: "refused" });
		else a.ws.acknowledge(frame);
	};
	const id = send(SESSION_A, "task").headers.req_id;
	gateway.taskStatus("A", id, "running");
	gateway.taskStatus("A", id, "settled");
	await gateway.notify(
		"A",
		{ chatId: "user", chatType: 1 },
		{ kind: "reply", source: a.value.source, text: "RESULT-BODY", taskId: id },
	);
	const finishes = frames.filter((frame) => frame.cmd === "aibot_respond_msg" && frame.body.stream.finish);
	assert.equal(finishes.length, 2, "the refused result, then one closing status");
	assert.doesNotMatch(finishes[1].body.stream.content, /RESULT-BODY/);
	const pushes = frames.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 1);
	assert.match(JSON.stringify(pushes[0].body), /RESULT-BODY/);
	assert.ok(frames.indexOf(finishes[1]) < frames.indexOf(pushes[0]), "the status closes before the push");
});

test("a late result cannot finish another task's status message even in the same chat", async () => {
	const a = add("A", SESSION_A);
	a.ws.onSend = (frame) => {
		if (frame.cmd === "aibot_send_msg" || frame.cmd === "aibot_respond_msg") a.ws.acknowledge(frame);
	};
	const old = send(SESSION_A, "old task").headers.req_id;
	gateway.taskStatus("A", old, "running");
	gateway.taskStatus("A", old, "notifying");
	const current = send(SESSION_A, "current task").headers.req_id;
	gateway.taskStatus("A", current, "running");
	gateway.taskStatus("A", current, "settled");
	await gateway.notify(
		"A",
		{ chatId: "user", chatType: 1 },
		{ kind: "reply", source: a.value.source, text: "CURRENT-RESULT", taskId: current },
	);
	await gateway.notify(
		"A",
		{ chatId: "user", chatType: 1 },
		{ kind: "completion", source: a.value.source, text: "OLDER-NOTIFICATION", taskId: old },
	);
	const currentReplies = a.ws.sent.filter(
		(frame) => frame.cmd === "aibot_respond_msg" && frame.headers.req_id === current,
	);
	assert.match(currentReplies.at(-1).body.stream.content, /CURRENT-RESULT$/);
	assert.doesNotMatch(currentReplies.at(-1).body.stream.content, /OLDER/);
	const oldReplies = a.ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg" && frame.headers.req_id === old);
	assert.match(oldReplies.at(-1).body.stream.content, /结果将另行通知/);
});

test("temporary identity registrations are hidden and cannot be targeted or publish notifications", async () => {
	const a = add("A", SESSION_A);
	const identifying = add("I", "identity-session", (value) => {
		value.identifyOnly = true;
	});
	message("/wecom-aibot sessions");
	assert.match(prompt(), /当前有 1 个在线会话/);
	assert.doesNotMatch(prompt(), /identity-session|project-I/);
	const status = identifying.peer.frames.filter((frame) => frame.type === "status").at(-1)!;
	assert.equal(status.status.sessions, 1);
	send("identity-session", "must not run");
	message("must not run either", { quote: quote("identity-session") });
	message("/wecom-aibot screen --sessionid identity-session");
	assert.equal(identifying.peer.messages().length, 0);
	assert.equal(requests(identifying.peer).length, 0);
	await assert.rejects(
		gateway.notify(
			"I",
			{ chatId: "user", chatType: 1 },
			notificationPayload("connect", identifying.value.source, "entry"),
		),
		/临时识别连接/,
	);

	gateway.watch("I", "identity-watch", 60_000);
	message(identifying.peer.code("identity-watch"));
	assert.equal(identifying.peer.identities().length, 1);
	assert.equal(a.peer.messages().length, 0);
	gateway.unregister("I", identifying.peer);
	send(SESSION_A, "A still works");
	assert.equal(a.peer.messages().length, 1);
});

test("without a result notification the settled status closes after the grace window", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const a = add("A", SESSION_A);
	const task = send(SESSION_A, "task");
	const id = task.headers.req_id;
	gateway.taskStatus("A", id, "running");
	gateway.taskStatus("A", id, "settled");
	t.mock.timers.tick(1_000);
	const finish = a.ws.sent.filter((frame: any) => frame.cmd === "aibot_respond_msg").at(-1);
	assert.equal(finish.body.stream.finish, true);
	assert.equal(finish.body.stream.content, formatProcessingStatus(SESSION_A, "settled"));
});

test("an unknown session ID gets an error plus the current list, never a guess", () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	send("01234567-89ab-4cde-8012-000000000000", "task");
	assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
	assert.match(prompt(), /找不到这个 session ID/);
	assert.match(prompt(), new RegExp(SESSION_A));
	assert.match(prompt(), new RegExp(SESSION_B));
});

test("sessions lists directory, model, state and the full session ID on its own line", () => {
	add("A", SESSION_A);
	add("B", SESSION_B);
	message("/wecom-aibot sessions");
	const text = prompt();
	assert.match(text, /当前有 2 个在线会话/);
	assert.match(text, /project-A · provider-A · model-A · 空闲/);
	assert.match(text, new RegExp(`session: ${SESSION_A}`));
	assert.match(text, new RegExp(`session: ${SESSION_B}`));
});

test("sessions shows what each pi says right now, not what the gateway saw of its tasks", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const a = add("A", SESSION_A);
	// A run typed in pi itself: no WeCom task exists.
	a.peer.busy = true;
	message("/wecom-aibot sessions");
	assert.match(prompt(), /project-A · provider-A · model-A · 执行中/);
	// A WeCom task past its status deadline: the gateway closed the status message, pi still runs.
	send(SESSION_A, "long task");
	gateway.taskStatus("A", a.peer.messages()[0].task.id, "running");
	t.mock.timers.tick(600_000);
	message("/wecom-aibot sessions");
	assert.match(prompt(), /project-A · provider-A · model-A · 执行中/);
	a.peer.busy = false;
	message("/wecom-aibot sessions");
	assert.match(prompt(), /project-A · provider-A · model-A · 空闲/);
});

test("sessions waits a moment for a silent pi, then lists it as unknown", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const a = add("A", SESSION_A);
	add("B", SESSION_B);
	a.peer.busy = undefined;
	const replies = () => a.ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").length;
	const before = replies();
	message("/wecom-aibot sessions");
	assert.equal(replies(), before, "the list waits for A");
	t.mock.timers.tick(2_000);
	assert.equal(replies(), before + 1);
	assert.match(prompt(), /project-A · provider-A · model-A · 状态未知/);
	assert.match(prompt(), /project-B · provider-B · model-B · 空闲/);
	// A pi that leaves while it is asked is answered for at once and not listed.
	message("/wecom-aibot sessions");
	gateway.unregister("A", a.peer);
	assert.equal(replies(), before + 2);
	assert.match(prompt(), /当前有 1 个在线会话/);
});

test("a quoted notification routes that one message, without remembering anything", () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	message("first", { quote: quote(SESSION_B) });
	assert.equal(b.peer.messages().length, 1);
	assert.equal(a.peer.messages().length, 0);
	// The next message has no target of its own, so it must be asked for again.
	message("second");
	assert.equal(b.peer.messages().length, 1);
	assert.match(prompt(), /先指定目标会话/);
});

test("a quote that names no online session is reported, never redirected to another pi", () => {
	const a = add("A", SESSION_A);
	message("orphan", { quote: quote(SESSION_B) });
	assert.equal(a.peer.messages().length, 0);
	assert.match(prompt(), /无法定位到一个在线会话/);
	assert.match(prompt(), new RegExp(SESSION_A));
});

test("a quote with several session IDs is ambiguous and delivers nothing", () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	const both = { msgtype: "text", text: { content: `session: ${SESSION_A}\nsession: ${SESSION_B}` } };
	message("which one", { quote: both });
	assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
	assert.match(prompt(), /无法定位/);
});

test("a command wins over a quote: the named session takes it", () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	send(SESSION_A, "named", { quote: quote(SESSION_B) });
	assert.equal(a.peer.messages().length, 1);
	assert.equal(b.peer.messages().length, 0);
});

test("--prompt keeps spaces, dashes, newlines and command-looking text verbatim", () => {
	const a = add("A", SESSION_A);
	message(`/wecom-aibot send --sessionid ${SESSION_A} --prompt 修复 --screen 和 --sessionid 的解析\n第二行`);
	assert.equal(a.peer.messages()[0].task.message.text, "修复 --screen 和 --sessionid 的解析\n第二行");
});

test("--sessionid written after --prompt is an order error, not part of the prompt", () => {
	const a = add("A", SESSION_A);
	message(`/wecom-aibot send --prompt 正文 --sessionid ${SESSION_A}`);
	assert.equal(a.peer.messages().length, 0);
	assert.match(prompt(), /--sessionid 必须写在 --prompt 之前/);
});

test("an equals form is an unknown option, and the error lists what is supported", () => {
	const a = add("A", SESSION_A);
	message(`/wecom-aibot send --sessionid=${SESSION_A} --prompt x`);
	assert.equal(a.peer.messages().length, 0);
	assert.match(prompt(), /未知选项 --sessionid=/);
	assert.match(prompt(), /--sessionid/);
	assert.match(prompt(), /--prompt/);
});

test("a positional argument is rejected; the prompt belongs after --prompt", () => {
	const a = add("A", SESSION_A);
	message(`/wecom-aibot send ${SESSION_A} 正文`);
	assert.equal(a.peer.messages().length, 0);
	assert.match(prompt(), /不接受位置参数/);
});

test("screen asks the named pi and sends the image it returns", async () => {
	const a = add("A", SESSION_A);
	message(`/wecom-aibot screen --sessionid ${SESSION_A}`);
	const request = requests(a.peer)[0];
	assert.equal(request.type, "request");
	assert.deepEqual(request.request, { action: "screen", target: sessionTarget(a.value) });
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	);
	const file = join(dir(), "screen.png");
	writeFileSync(file, png);
	gateway.response("A", request.id, { ok: true, image: { mime: "image/png", filename: "screen.png", path: file } });
	await new Promise<void>((resolve) => setImmediate(resolve));
	const sent = a.ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
	assert.equal(sent.body.msgtype, "image");
	assert.equal(
		a.ws.sent.some((frame) => frame.cmd === "aibot_upload_media_init"),
		true,
	);
});

test("a failed screen request reports the pi's reason", () => {
	const a = add("A", SESSION_A);
	message(`/wecom-aibot screen --sessionid ${SESSION_A}`);
	gateway.response("A", requests(a.peer)[0].id, { ok: false, error: "该会话没有终端界面" });
	assert.match(prompt(), /截图失败：该会话没有终端界面/);
});

test("screen is only answered by the pi it was sent to", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const a = add("A", SESSION_A);
	add("B", SESSION_B);
	message(`/wecom-aibot screen --sessionid ${SESSION_A}`);
	const count = a.ws.sent.length;
	gateway.response("B", requests(a.peer)[0].id, { ok: true });
	assert.equal(a.ws.sent.length, count, "another pi's answer is ignored");
	t.mock.timers.tick(20_000);
	assert.match(prompt(), /20 秒内响应/);
});

test("cancel asks the named pi and says only that abort was requested", () => {
	const a = add("A", SESSION_A);
	message(`/wecom-aibot cancel --sessionid ${SESSION_A}`);
	const request = requests(a.peer)[0];
	assert.deepEqual(request.request, { action: "cancel", target: sessionTarget(a.value) });
	gateway.response("A", request.id, { ok: true });
	assert.match(prompt(), /已请求中止/);
});

test("a request nobody answers times out with the timeout named", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	add("A", SESSION_A);
	message(`/wecom-aibot screen --sessionid ${SESSION_A}`);
	t.mock.timers.tick(20_000);
	assert.match(prompt(), /20 秒内响应/);
});

test("group participants each name their own target; nothing is shared between senders", () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	send(SESSION_A, "from alice", { from: { userid: "alice" }, chattype: "group", chatid: "group-1" });
	send(SESSION_B, "from bob", { from: { userid: "bob" }, chattype: "group", chatid: "group-1" });
	assert.equal(a.peer.messages().length, 1);
	assert.equal(b.peer.messages().length, 1);
	assert.equal(a.peer.messages()[0].task.message.text, "from alice");
	assert.equal(b.peer.messages()[0].task.message.text, "from bob");
});

test("entering a chat sends nothing at all", () => {
	const a = add("A", SESSION_A);
	add("B", SESSION_B);
	const count = a.ws.sent.length;
	a.ws.receive({
		cmd: "aibot_event_callback",
		headers: { req_id: "enter" },
		body: { from: { userid: "user" }, event: { eventtype: "enter_chat" } },
	});
	assert.equal(a.ws.sent.length, count);
});

test("duplicate callbacks produce one task and one command reply", () => {
	const a = add("A", SESSION_A);
	const frame = send(SESSION_A, "once");
	FakeWebSocket.instances.at(-1)!.receive(frame);
	assert.equal(a.peer.messages().length, 1);
});

test("the same full session cannot be registered by two pi instances", () => {
	const a = add("A", SESSION_A);
	assert.throws(() => add("B", SESSION_A), /另一个 pi 注册/);
	assert.equal(gateway.size, 1);
	assert.equal(a.peer.closed, false);
	send(SESSION_A, "original owner");
	assert.equal(a.peer.messages().length, 1);
});

test("switching sessions invalidates old callbacks and late disconnects cannot remove the new registration", () => {
	const a = add("A", SESSION_A);
	const inbound = send(SESSION_A, "task A");
	const next = registration("A", SESSION_B);
	next.registrationId = "new-registration";
	const peer = new Peer("A");
	gateway.register(next, peer);
	assert.equal(a.peer.closed, true);
	gateway.unregister("A", a.peer);
	assert.equal(gateway.size, 1);
	assert.equal(gateway.taskStatus("A", inbound.headers.req_id, "running"), false);
	message("old target", { quote: quote(SESSION_A) });
	assert.equal(peer.messages().length, 0);
	assert.match(prompt(), /无法定位/);
});

test("task states and notifications are checked against their owning pi and session", async () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	const inbound = message("task A", { quote: quote(SESSION_A) });
	const count = a.ws.sent.length;
	assert.equal(gateway.taskStatus("B", inbound.headers.req_id, "running"), false);
	assert.equal(gateway.taskStatus("A", "unknown-task", "running"), false);
	await assert.rejects(
		gateway.notify(
			"A",
			{ chatId: "user", chatType: 1 },
			notificationPayload("notification", b.value.source, "wrong source"),
		),
		/session/,
	);
	assert.equal(a.ws.sent.length, count);
	assert.equal(gateway.taskStatus("A", inbound.headers.req_id, "running"), true);
	const status = a.ws.sent.at(-1);
	assert.equal(status.headers.req_id, inbound.headers.req_id);
	assert.deepEqual(status.body.stream, {
		id: status.body.stream.id,
		finish: false,
		content: formatProcessingStatus(SESSION_A, "running"),
	});
});

test("concurrent notifications preserve separate source metadata and acknowledgement ownership", async () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	let resolvedA = false;
	const first = gateway
		.notify("A", { chatId: "user-A", chatType: 1 }, notificationPayload("notification", a.value.source, "result A"))
		.then(() => {
			resolvedA = true;
		});
	const frameA = a.ws.sent.at(-1);
	const second = gateway.notify(
		"B",
		{ chatId: "group-B", chatType: 2 },
		notificationPayload("notification", b.value.source, "result B"),
	);
	const frameB = a.ws.sent.at(-1);
	a.ws.acknowledge(frameB);
	await second;
	assert.equal(resolvedA, false);
	assert.ok(frameA.body.markdown.content.includes(`🏷️ provider-A · model-A  \n🆔 session: ${SESSION_A}`));
	assert.ok(frameB.body.markdown.content.includes(`🏷️ provider-B · model-B  \n🆔 session: ${SESSION_B}`));
	assert.equal(frameA.body.chatid, "user-A");
	assert.equal(frameB.body.chat_type, 2);
	a.ws.acknowledge(frameA);
	await first;
});

test("allowlists hide and gate sessions, including quoted targets, and enter_chat stays silent", () => {
	const a = add("A", SESSION_A, (value) => {
		value.config.allowedUserIds = ["alice"];
	});
	const b = add("B", SESSION_B, (value) => {
		value.config.allowedUserIds = ["bob"];
	});
	message("blocked");
	send(SESSION_A, "alice", { from: { userid: "alice" } });
	message("cannot reach B", { from: { userid: "alice" }, quote: quote(SESSION_B) });
	assert.equal(a.peer.messages().length, 1);
	assert.equal(b.peer.messages().length, 0);
	assert.equal(prompt().includes(SESSION_B), false);
	const count = a.ws.sent.length;
	a.ws.receive({
		cmd: "aibot_event_callback",
		headers: { req_id: "enter" },
		body: { from: { userid: "blocked" }, event: { eventtype: "enter_chat" } },
	});
	assert.equal(a.ws.sent.length, count);
});

test("only a registered pi can wait for an identity, and registration needs this gateway's BotID", () => {
	const a = add("A", SESSION_A);
	assert.ok(a.peer.frames.some((frame) => frame.type === "registered"));
	assert.throws(() => gateway.watch("nobody", "watch", 60_000), /尚未注册/);
	assert.throws(
		() =>
			add("other", SESSION_B, (value) => {
				value.config.botId = "other-bot";
			}),
		/BotID/,
	);
	assert.equal(gateway.size, 1);
});

test("only the message that is exactly a pi's one-time code identifies its chat; every other message is routed", () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	const code = gateway.watch("A", "watch-a", 60_000);
	gateway.watch("B", "watch-b", 60_000);
	assert.match(code, /^\d{6}$/);
	assert.equal(a.peer.code("watch-a"), code, "the code is announced to the pi that asked");
	assert.notEqual(b.peer.code("watch-b"), code, "two waiting pi windows never share a code");
	// Anything else, from anyone, is routed as usual while both wait: a colleague's task is not swallowed.
	send(SESSION_A, "a real task");
	assert.equal(a.peer.messages().length, 1);
	message(`${code} and more`);
	assert.deepEqual(a.peer.identities(), []);
	const frame = message(`@bot ${code}`, { from: { userid: "user_one" }, chattype: "group", chatid: "group_chat" });
	assert.deepEqual(a.peer.identities(), [
		{ type: "identity", id: "watch-a", identity: { chatId: "group_chat", chatType: 2, userid: "user_one" } },
	]);
	assert.deepEqual(b.peer.identities(), [], "only the pi whose code it is learns the chat");
	assert.equal(a.peer.messages().length + b.peer.messages().length, 1, "the code is not a task");
	const receipt = a.ws.sent.at(-1);
	assert.equal(receipt.cmd, "aibot_respond_msg");
	assert.equal(receipt.headers.req_id, frame.headers.req_id);
	assert.equal(receipt.body.stream.finish, true);
	assert.match(receipt.body.stream.content, /chatid：`group_chat`　chat_type：2　userid：`user_one`/);
	assert.match(receipt.body.stream.content, /不会交给 pi/);
	// A code is used once; B's code typed with full-width digits from a Chinese IME still counts.
	const wide = b.peer.code("watch-b").replace(/\d/g, (digit) => String.fromCharCode(0xff10 + Number(digit)));
	message(wide);
	assert.equal(b.peer.identities().length, 1);
	message(code);
	assert.equal(a.peer.identities().length, 1);
});

test("a cancelled or expired code identifies nothing, and a stale cancel cannot end a newer one", (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const a = add("A", SESSION_A);
	const first = gateway.watch("A", "watch-1", 60_000);
	gateway.unwatch("A", "watch-1");
	message(first);
	const second = gateway.watch("A", "watch-2", 1000);
	t.mock.timers.tick(1001);
	message(second);
	assert.deepEqual(a.peer.identities(), []);
	const third = gateway.watch("A", "watch-3", 60_000);
	gateway.unwatch("A", "watch-2");
	message(third);
	const identities = a.peer.identities();
	assert.equal(identities.length, 1);
	assert.ok(identities[0].type === "identity" && identities[0].id === "watch-3");
});

test("the code identifies a sender outside the allowlist, who stays silent otherwise; it belongs to the connection that asked", () => {
	const a = add("A", SESSION_A, (value) => {
		value.config.allowedUserIds = ["alice"];
	});
	const code = gateway.watch("A", "watch", 60_000);
	const count = a.ws.sent.length;
	message("hello", { from: { userid: "stranger" } });
	assert.equal(a.ws.sent.length, count, "a sender outside the allowlist gets no reply to anything else");
	message(code, { from: { userid: "stranger" } });
	assert.deepEqual(a.peer.identities(), [
		{ type: "identity", id: "watch", identity: { chatId: "stranger", chatType: 1, userid: "stranger" } },
	]);
	assert.equal(a.peer.messages().length, 0, "being identified grants no task");

	const next = gateway.watch("A", "watch-next", 60_000);
	const replacement = new Peer("A");
	gateway.register(registration("A", SESSION_A), replacement);
	message(next, { from: { userid: "alice" } });
	assert.deepEqual(replacement.identities(), [], "a re-registered connection does not inherit the old code");
});

test("duplicate callbacks cannot produce a second command reply or pi task", () => {
	const a = add("A", SESSION_A);
	const frame = send(SESSION_A, "once");
	a.ws.receive(frame);
	assert.equal(a.peer.messages().length, 1);
});

test("replacement by an external client stops reconnecting but retains registrations until explicit start", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	a.ws.receive({
		cmd: "aibot_event_callback",
		headers: { req_id: "replaced" },
		body: { event: { eventtype: "disconnected_event" } },
	});
	t.mock.timers.tick(60_000);
	assert.equal(gateway.size, 2);
	assert.equal(FakeWebSocket.instances.length, 1);
	assert.equal(a.peer.closed || b.peer.closed, false);
	gateway.resume();
	const next = FakeWebSocket.instances.at(-1)!;
	next.open();
	next.acknowledge();
	assert.equal(FakeWebSocket.instances.length, 2);
	message("back", { quote: quote(SESSION_B) });
	assert.equal(b.peer.messages().length, 1);
});

test("the gateway ends a task's status message before WeCom's 10-minute limit, and a closed message stays closed", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const a = add("A", SESSION_A);
	a.ws.onSend = (frame) => {
		if (frame.cmd === "ping") a.ws.acknowledge(frame);
	};
	const task = send(SESSION_A, "long task");
	const statuses = () =>
		a.ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg" && frame.headers.req_id === task.headers.req_id);
	assert.equal(gateway.taskStatus("A", task.headers.req_id, "running"), true);
	t.mock.timers.tick(589_000);
	assert.equal(statuses().length, 1);
	t.mock.timers.tick(1_000);
	const [opened, closed] = statuses();
	assert.equal(closed.body.stream.id, opened.body.stream.id);
	assert.equal(closed.body.stream.finish, true);
	assert.equal(closed.body.stream.content, formatProcessingStatus(SESSION_A, "waiting"));
	assert.equal(
		gateway.taskStatus("A", task.headers.req_id, "settled"),
		false,
		"the result follows as a notification instead",
	);
	assert.equal(statuses().length, 2);
});

test("a final state WeCom could not take while disconnected is sent after the reconnect", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const a = add("A", SESSION_A);
	const task = send(SESSION_A, "task");
	gateway.taskStatus("A", task.headers.req_id, "running");
	a.ws.close();
	// Settled is deferred until its result arrives; the status itself is closed by the grace timer.
	assert.equal(gateway.taskStatus("A", task.headers.req_id, "settled"), true);
	t.mock.timers.tick(1_000);
	const next = FakeWebSocket.instances.at(-1)!;
	assert.notEqual(next, a.ws);
	next.open();
	next.acknowledge();
	const flushed = next.sent.filter((frame) => frame.cmd === "aibot_respond_msg");
	assert.equal(flushed.length, 1);
	assert.equal(flushed[0].headers.req_id, task.headers.req_id);
	assert.equal(flushed[0].body.stream.finish, true);
	assert.equal(flushed[0].body.stream.content, formatProcessingStatus(SESSION_A, "settled"));
});

test("an unreadable message from a permitted sender is answered instead of routed or guessed", () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	const broken = message("no chat id", { chattype: "group" });
	const reply = a.ws.sent.at(-1);
	assert.equal(reply.headers.req_id, broken.headers.req_id);
	assert.equal(reply.body.stream.finish, true);
	assert.match(reply.body.stream.content, /无法识别/);
	assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
});

function imageFile(data = Buffer.alloc(64, 1)): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "gateway-image-"));
	const path = join(dir, "screen.png");
	writeFileSync(path, data);
	return { dir, path };
}

test("an image notification uploads media and sends a native image message instead of Markdown", async () => {
	const a = add("A", SESSION_A);
	const file = imageFile();
	const sent: any[] = [];
	a.ws.onSend = (frame: any) => {
		sent.push(frame);
		if (frame.cmd === "aibot_upload_media_init")
			a.ws.receive({ headers: frame.headers, errcode: 0, errmsg: "ok", body: { upload_id: "upload-1" } });
		else if (frame.cmd === "aibot_upload_media_chunk") a.ws.acknowledge(frame);
		else if (frame.cmd === "aibot_upload_media_finish")
			a.ws.receive({ headers: frame.headers, errcode: 0, errmsg: "ok", body: { media_id: "media-1" } });
		else if (frame.cmd === "aibot_send_msg") a.ws.acknowledge(frame);
	};
	await gateway.notify(
		"A",
		{ chatId: "user", chatType: 1 },
		{
			kind: "completion",
			source: a.value.source,
			text: "fallback",
			image: { mime: "image/png", filename: "pi-notification.png", path: file.path },
		},
	);
	assert.equal(
		sent.some((frame) => frame.cmd === "aibot_upload_media_init"),
		true,
	);
	const push = sent.find((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(push.body.msgtype, "image");
	assert.equal(push.body.image.media_id, "media-1");
	assert.equal(push.body.markdown, undefined);
	rmSync(file.dir, { recursive: true, force: true });
});

test("an unconfirmed image send never falls back to a duplicate Markdown notification", async () => {
	const a = add("A", SESSION_A);
	const file = imageFile(TINY_PNG);
	const previous = a.ws.onSend;
	a.ws.onSend = (frame) => {
		previous?.(frame);
		if (frame.cmd === "aibot_send_msg") a.ws.close();
	};
	try {
		await assert.rejects(
			gateway.notify(
				"A",
				{ chatId: "user", chatType: 1 },
				{
					kind: "reply",
					source: a.value.source,
					text: "FALLBACK",
					image: { mime: "image/png", filename: "image.png", path: file.path },
				},
			),
			{ outcome: "unknown" },
		);
		assert.equal(a.ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 1);
		assert.equal(a.ws.sent.find((frame) => frame.cmd === "aibot_send_msg").body.msgtype, "image");
	} finally {
		rmSync(file.dir, { recursive: true, force: true });
	}
});

test("a rejected image send falls back to one Markdown body with its rejection reason", async () => {
	const a = add("A", SESSION_A);
	const file = imageFile(TINY_PNG);
	const previous = a.ws.onSend;
	a.ws.onSend = (frame) => {
		previous?.(frame);
		if (frame.cmd === "aibot_send_msg") a.ws.acknowledge(frame, frame.body.msgtype === "image" ? 40006 : 0);
	};
	try {
		await gateway.notify(
			"A",
			{ chatId: "user", chatType: 1 },
			{
				kind: "reply",
				source: a.value.source,
				text: "FALLBACK",
				image: { mime: "image/png", filename: "image.png", path: file.path },
			},
		);
		const pushes = a.ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
		assert.deepEqual(
			pushes.map((frame) => frame.body.msgtype),
			["image", "markdown"],
		);
		assert.match(pushes[1].body.markdown.content, /FALLBACK[\s\S]*发送被拒绝.*40006/);
	} finally {
		rmSync(file.dir, { recursive: true, force: true });
	}
});

test("a missing image file falls back to the Markdown body with a visible reason", async () => {
	const a = add("A", SESSION_A);
	const sent: any[] = [];
	a.ws.onSend = (frame: any) => {
		sent.push(frame);
		if (frame.cmd === "aibot_send_msg") a.ws.acknowledge(frame);
	};
	await gateway.notify(
		"A",
		{ chatId: "user", chatType: 1 },
		{
			kind: "completion",
			source: a.value.source,
			text: "fallback body",
			image: { mime: "image/png", filename: "pi-notification.png", path: "/definitely/missing/pi-notification.png" },
		},
	);
	const push = sent.find((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(push.body.msgtype, "markdown");
	assert.match(push.body.markdown.content, /fallback body/);
	assert.match(push.body.markdown.content, /图片发送失败：.*ENOENT.*已改发文字/);
});

test("a notification fallback always retains its reason inside the UTF-8 byte limit", async () => {
	const a = add("A", SESSION_A);
	a.ws.onSend = (frame) => {
		if (frame.cmd === "aibot_send_msg") a.ws.acknowledge(frame);
	};
	await gateway.notify(
		"A",
		{ chatId: "user", chatType: 1 },
		{
			kind: "reply",
			source: a.value.source,
			text: "汉🙂".repeat(10000),
			image: { mime: "image/png", filename: "missing.png", path: "/definitely/missing.png" },
		},
	);
	const content = a.ws.sent.find((frame) => frame.cmd === "aibot_send_msg").body.markdown.content;
	assert.ok(Buffer.byteLength(content, "utf8") <= 20_480);
	assert.match(content, /图片发送失败：.*ENOENT.*已改发文字/);
	assert.equal(content.includes("\ufffd"), false);
});

test("a rejected media upload falls back to Markdown while a rejected image send also falls back", async () => {
	const a = add("A", SESSION_A);
	const file = imageFile();
	const sent: any[] = [];
	a.ws.onSend = (frame: any) => {
		sent.push(frame);
		if (frame.cmd === "aibot_upload_media_init")
			a.ws.receive({ headers: frame.headers, errcode: 40006, errmsg: "bad size" });
		else if (frame.cmd === "aibot_send_msg") a.ws.acknowledge(frame);
	};
	await gateway.notify(
		"A",
		{ chatId: "user", chatType: 1 },
		{
			kind: "completion",
			source: a.value.source,
			text: "fallback body",
			image: { mime: "image/png", filename: "pi-notification.png", path: file.path },
		},
	);
	const push = sent.find((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(push.body.msgtype, "markdown");
	assert.match(push.body.markdown.content, /图片发送失败：.*已改发文字/);
	rmSync(file.dir, { recursive: true, force: true });
});

async function until<T>(read: () => T | undefined): Promise<T> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("condition not reached");
}

function logs(peer: Peer): string[] {
	return peer.frames.flatMap((frame) => (frame.type === "log" ? [frame.message] : []));
}

/** The file as WeCom received it: the upload chunks in order. */
function uploaded(ws: FakeWebSocket): Buffer {
	const chunks = ws.sent.filter((frame) => frame.cmd === "aibot_upload_media_chunk");
	chunks.sort((left, right) => left.body.chunk_index - right.body.chunk_index);
	return Buffer.concat(chunks.map((frame) => Buffer.from(frame.body.base64_data, "base64")));
}

test("every image the gateway sends carries its session marker; a file it cannot mark is sent as it is", async () => {
	const a = add("A", SESSION_A);
	const file = imageFile(TINY_PNG);
	const image = { mime: "image/png" as const, filename: "pi-notification.png", path: file.path };
	const previous = a.ws.onSend;
	a.ws.onSend = (frame: any) => {
		previous?.(frame);
		if (frame.cmd === "aibot_send_msg") a.ws.acknowledge(frame);
	};
	await gateway.notify(
		"A",
		{ chatId: "user", chatType: 1 },
		{ kind: "reply", source: a.value.source, text: "x", image },
	);
	assert.equal(inspectPng(uploaded(a.ws))?.session, SESSION_A);
	assert.ok(logs(a.peer).some((line) => line.includes(`图片已打标记：PNG 1×1；块 IHDR,tEXt,IDAT`)));
	a.ws.sent.length = 0;
	writeFileSync(file.path, Buffer.alloc(64, 1));
	await gateway.notify(
		"A",
		{ chatId: "user", chatType: 1 },
		{ kind: "reply", source: a.value.source, text: "x", image },
	);
	assert.deepEqual(uploaded(a.ws), Buffer.alloc(64, 1));
	assert.ok(logs(a.peer).some((line) => line.startsWith("图片未打标记")));
	rmSync(file.dir, { recursive: true, force: true });
});

test("a screenshot carries the marker of the session that took it", async () => {
	const a = add("A", SESSION_A);
	message(`/wecom-aibot screen --sessionid ${SESSION_A}`);
	const file = imageFile(TINY_PNG);
	gateway.response("A", requests(a.peer)[0].id, {
		ok: true,
		image: { mime: "image/png", filename: "screen.png", path: file.path },
	});
	await until(() => (a.ws.sent.some((frame) => frame.cmd === "aibot_upload_media_chunk") ? true : undefined));
	assert.equal(inspectPng(uploaded(a.ws))?.session, SESSION_A);
	rmSync(file.dir, { recursive: true, force: true });
});

test("a quoted image routes to the session whose marker it carries", async (t) => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	const encrypted = encryptMedia(stampPng(TINY_PNG, SESSION_B));
	const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(encrypted)));
	const url = "https://wecom.example.invalid/q?sign=SECRET";
	message("这张图里的结果", { quote: { msgtype: "image", image: { url, aeskey: MEDIA_KEY.toString("base64") } } });
	const task = await until(() => b.peer.messages()[0]);
	assert.equal(task.task.message.text, "这张图里的结果");
	assert.equal(a.peer.messages().length, 0);
	const line = await until(() => logs(a.peer).find((entry) => entry.startsWith("引用图片：")));
	assert.match(line, new RegExp(`读到标记 session ${SESSION_B}$`));
	assert.doesNotMatch(line, /SECRET/);
	assert.equal(String(fetchMock.mock.calls[0].arguments[0]), url);
});

test("a quoted image without a marker is reported, never redirected to another pi", async (t) => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(encryptMedia(TINY_PNG))));
	message("这张图", { quote: { msgtype: "image", image: { url: "https://example.invalid/q" } } });
	await until(() => logs(a.peer).find((entry) => entry.startsWith("引用图片：")));
	assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
	assert.match(prompt(), /引用的通知或图片无法定位到一个在线会话/);
	assert.doesNotMatch(logs(a.peer).join("\n"), /读到标记/);
});

test("a quoted image naming a session that is gone is reported, with the sessions that are left", async (t) => {
	const a = add("A", SESSION_A);
	const encrypted = encryptMedia(stampPng(TINY_PNG, SESSION_B));
	t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(encrypted)));
	message("这张图", { quote: { msgtype: "image", image: { url: "https://example.invalid/q" } } });
	await until(() => logs(a.peer).find((entry) => entry.startsWith("引用图片：")));
	assert.equal(a.peer.messages().length, 0);
	assert.match(prompt(), new RegExp(`无法定位到一个在线会话[\\s\\S]*session: ${SESSION_A}`));
});

test("a quote carrying both text and an image is answered by the text, without downloading", async (t) => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	const fetchMock = t.mock.method(globalThis, "fetch");
	message("混合", {
		quote: {
			msgtype: "mixed",
			mixed: { msg_item: [{ msgtype: "text", text: { content: `session: ${SESSION_B}` } }] },
			image: { url: "https://example.invalid/q" },
		},
	});
	assert.equal(b.peer.messages()[0].task.message.text, "混合");
	assert.equal(a.peer.messages().length, 0);
	assert.equal(fetchMock.mock.callCount(), 0);
});

test("an image quoted by someone outside the allowlist is never downloaded", async (t) => {
	add("A", SESSION_A, (value) => {
		value.config.allowedUserIds = ["alice"];
	});
	const fetchMock = t.mock.method(globalThis, "fetch");
	message("x", {
		from: { userid: "mallory" },
		quote: { msgtype: "image", image: { url: "https://example.invalid/q" } },
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(fetchMock.mock.callCount(), 0);
});
