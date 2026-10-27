import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { sessionControlCard } from "../../src/extension/control-view.ts";
import { type GatewayPeer, WeComGateway } from "../../src/gateway/runtime.ts";
import { controlCardFor, controlCardId, controlKey, sessionFingerprint } from "../../src/shared/control-card.ts";
import { type GatewayRegistration, type ServerFrame, sessionTarget } from "../../src/shared/gateway-protocol.ts";
import { formatProcessingStatus, notificationPayload } from "../../src/shared/notification.ts";
import { FakeWebSocket } from "../support/fake-websocket.ts";

/** pi publishes every notification as its session's control card. */
function controlled(source: GatewayRegistration["source"]) {
	return {
		control: { cardId: controlCardId(source.sessionId), card: sessionControlCard(source, { status: "idle" }) },
	};
}

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
		if (frame.body?.template_card?.button_selection?.question_key === "pick") ws.acknowledge(frame);
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
	return message(`/wecom-aibot --sessionid ${sessionId} send --prompt ${text}`, body);
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
/** The card a message without a session gets: the question, which nothing answers by itself. */
function asked() {
	const frame = FakeWebSocket.instances
		.at(-1)!
		.sent.filter((item) => item.body?.template_card)
		.at(-1);
	assert.match(frame.body.template_card.task_id, /^q@[0-9a-f]{12}$/, "a question card");
	return frame.body.template_card;
}
function picker() {
	return FakeWebSocket.instances
		.at(-1)!
		.sent.filter((frame) => frame.body?.template_card)
		.at(-1).body.template_card;
}
/** The session list's dropdown, as its options read: 「目录 · 忙闲」. */
function listed(): string[] {
	return picker().button_selection.option_list.map((option: { text: string }) => option.text);
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

test("a message without a target never reaches a pi by itself: it is asked about, with one session online too", () => {
	const a = add("A", SESSION_A);
	message("just a task");
	assert.equal(a.peer.messages().length, 0);
	const card = asked();
	assert.equal(card.main_title.title, "这条消息发给哪个会话？");
	assert.equal(card.quote_area.quote_text, "just a task");
	assert.deepEqual(
		card.button_selection.option_list.map((option: { id: string }) => option.id),
		[sessionFingerprint(SESSION_A)],
	);
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

test("a task's result is its session's control card in that chat; the message itself gets no reply", async () => {
	const a = add("A", SESSION_A);
	const frames: any[] = [];
	a.ws.onSend = (frame: any) => {
		frames.push(frame);
		a.ws.acknowledge(frame);
	};
	const task = send(SESSION_A, "task");
	const id = task.headers.req_id;
	assert.equal(gateway.taskStatus("A", id, "running"), true);
	assert.equal(
		frames.filter((frame) => frame.cmd === "aibot_respond_msg").length,
		0,
		"no 执行中: the question card already said where it went",
	);
	assert.equal(gateway.taskStatus("A", id, "settled"), true);
	await gateway.notify(
		"A",
		{ chatId: "user", chatType: 1 },
		{
			kind: "result",
			source: a.value.source,
			text: "RESULT-BODY",
			title: "✅ 完成",
			...controlled(a.value.source),
		},
	);
	assert.equal(frames.filter((frame) => frame.cmd === "aibot_respond_msg").length, 0, "no reply to the message");
	const pushes = frames.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 1, "one card per task");
	assert.equal(pushes[0].body.chatid, "user");
	assert.equal(pushes[0].body.msgtype, "template_card");
	assert.ok(controlCardFor(pushes[0].body.template_card.task_id, SESSION_A), "its session's control card");
	assert.equal(gateway.taskStatus("A", id, "failed"), false, "the task is closed, nothing more goes to the message");
});
test("a result whose card WeCom refuses goes to the chat as Markdown naming the session, never as a reply", async () => {
	const a = add("A", SESSION_A);
	const frames: any[] = [];
	a.ws.onSend = (frame: any) => {
		frames.push(frame);
		if (frame.cmd === "aibot_send_msg" && frame.body.msgtype === "template_card")
			a.ws.receive({ headers: frame.headers, errcode: 40008, errmsg: "refused" });
		else a.ws.acknowledge(frame);
	};
	const id = send(SESSION_A, "task").headers.req_id;
	gateway.taskStatus("A", id, "running");
	gateway.taskStatus("A", id, "settled");
	await gateway.notify(
		"A",
		{ chatId: "user", chatType: 1 },
		{ kind: "result", source: a.value.source, text: "RESULT-BODY", ...controlled(a.value.source) },
	);
	assert.equal(frames.filter((frame) => frame.cmd === "aibot_respond_msg").length, 0);
	const pushes = frames.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.deepEqual(
		pushes.map((frame) => frame.body.msgtype),
		["template_card", "markdown"],
	);
	assert.match(pushes[1].body.markdown.content, new RegExp(`^🆔 session: ${SESSION_A}`));
	assert.match(pushes[1].body.markdown.content, /RESULT-BODY$/);
});
test("a settled task is closed: a later stop never answers its message, whatever the result does", async () => {
	const a = add("A", SESSION_A);
	a.ws.onSend = (frame) => a.ws.acknowledge(frame);
	const id = send(SESSION_A, "task").headers.req_id;
	assert.equal(gateway.taskStatus("A", id, "running"), true);
	assert.equal(gateway.taskStatus("A", id, "settled"), true);
	assert.equal(gateway.taskStatus("A", id, "stopped"), false, "nothing is left to answer");
	assert.equal(a.ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").length, 0);
});
test("temporary identity registrations are hidden and cannot be targeted or publish notifications", async () => {
	const a = add("A", SESSION_A);
	const identifying = add("I", "identity-session", (value) => {
		value.identifyOnly = true;
	});
	message("/wecom-aibot sessions");
	assert.equal(picker().main_title.title, "1 个在线会话");
	assert.doesNotMatch(JSON.stringify(picker()), /identity-session|project-I/);
	const status = identifying.peer.frames.filter((frame) => frame.type === "status").at(-1)!;
	assert.equal(status.status.sessions, 1);
	send("identity-session", "must not run");
	message("must not run either", { quote: quote("identity-session") });
	message("/wecom-aibot --sessionid identity-session cancel");
	message("/wecom-aibot --sessionid identity-session");
	assert.match(prompt(), /找不到这个 session ID/);
	assert.doesNotMatch(prompt(), /project-I/);
	assert.equal(identifying.peer.messages().length, 0);
	assert.equal(requests(identifying.peer).length, 0);
	await assert.rejects(
		gateway.notify(
			"I",
			{ chatId: "user", chatType: 1 },
			notificationPayload("notice", identifying.value.source, "notice"),
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

test("without a result after the grace window the task is closed, and a result after it never replies", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const a = add("A", SESSION_A);
	const task = send(SESSION_A, "task");
	const id = task.headers.req_id;
	gateway.taskStatus("A", id, "running");
	gateway.taskStatus("A", id, "settled");
	t.mock.timers.tick(1_000);
	assert.equal(a.ws.sent.filter((frame: any) => frame.cmd === "aibot_respond_msg").length, 0, "nothing to say");
	assert.equal(gateway.taskStatus("A", id, "settled"), false, "the task is gone");
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

test("sessions lists each session's directory, state and model; its buttons are a control card's", () => {
	add("A", SESSION_A);
	add("B", SESSION_B);
	message("/wecom-aibot sessions");
	const card = picker();
	assert.equal(card.main_title.title, "2 个在线会话");
	// The body is the list: a row per session, and no session's head.
	assert.deepEqual(
		card.horizontal_content_list.map((row: { keyname: string; value: string }) => [row.keyname, row.value]),
		[
			["空闲", `project-A · ${SESSION_A.slice(-4)} · model-A`],
			["空闲", `project-B · ${SESSION_B.slice(-4)} · model-B`],
		],
	);
	assert.doesNotMatch(JSON.stringify(card), new RegExp(`${SESSION_A}|${SESSION_B}`));
	assert.deepEqual(listed(), [
		`project-A · ${SESSION_A.slice(-4)} · 空闲`,
		`project-B · ${SESSION_B.slice(-4)} · 空闲`,
	]);
	assert.deepEqual(
		card.button_list.map((button: { key: string }) => button.key.replace(/@[0-9a-f]{64}$/, "")),
		["pick@show", "pick@refresh"],
	);
});

test("sessions shows what each pi says right now, not what the gateway saw of its tasks", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const a = add("A", SESSION_A);
	// A run typed in pi itself: no WeCom task exists.
	a.peer.busy = true;
	message("/wecom-aibot sessions");
	assert.deepEqual(listed(), [`project-A · ${SESSION_A.slice(-4)} · 执行中`]);
	// A long WeCom task: the gateway sent nothing for it yet, pi still runs.
	send(SESSION_A, "long task");
	gateway.taskStatus("A", a.peer.messages()[0].task.id, "running");
	t.mock.timers.tick(600_000);
	message("/wecom-aibot sessions");
	assert.deepEqual(listed(), [`project-A · ${SESSION_A.slice(-4)} · 执行中`]);
	a.peer.busy = false;
	message("/wecom-aibot sessions");
	assert.deepEqual(listed(), [`project-A · ${SESSION_A.slice(-4)} · 空闲`]);
});

test("sessions waits a moment for a silent pi, then lists it as unknown", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const a = add("A", SESSION_A);
	add("B", SESSION_B);
	a.peer.busy = undefined;
	const replies = () => a.ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length;
	const before = replies();
	message("/wecom-aibot sessions");
	assert.equal(replies(), before, "the list waits for A");
	t.mock.timers.tick(2_000);
	assert.equal(replies(), before + 1);
	assert.deepEqual(listed(), [
		`project-A · ${SESSION_A.slice(-4)} · 状态未知`,
		`project-B · ${SESSION_B.slice(-4)} · 空闲`,
	]);
	// A pi that leaves while it is asked is answered for at once and not listed.
	message("/wecom-aibot sessions");
	gateway.unregister("A", a.peer);
	assert.equal(replies(), before + 2);
	assert.equal(picker().main_title.title, "1 个在线会话");
});

test("a target-only command queries just that pi and returns filled-in commands without selecting it", () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	a.peer.busy = true;
	b.peer.busy = undefined;
	message(`/wecom-aibot --sessionid ${SESSION_A}`);
	assert.equal(
		prompt(),
		[
			"· project-A · provider-A · model-A · 执行中",
			"",
			`/wecom-aibot --session-id ${SESSION_A} send --prompt <正文>`,
			`/wecom-aibot --session-id ${SESSION_A} card`,
			`/wecom-aibot --session-id ${SESSION_A} cancel`,
		].join("\n"),
	);
	assert.equal(
		a.peer.frames.filter((frame) => frame.type === "request" && frame.request.action === "state").length,
		1,
	);
	assert.equal(b.peer.frames.filter((frame) => frame.type === "request").length, 0);
	assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
	assert.equal(requests(a.peer).length, 0);
	a.peer.busy = false;
	message(`/wecom-aibot --sessionid ${SESSION_A}`);
	assert.match(prompt(), /^· project-A · provider-A · model-A · 空闲\n/);
	b.peer.busy = false;
	message("the next message has no target");
	assert.equal(asked().quote_area.quote_text, "the next message has no target", "a query selects nothing");
	for (const action of ["card", "cancel"]) {
		message(`/wecom-aibot ${action}`);
		assert.match(prompt(), new RegExp(`^${action} 需要目标：`));
	}
	assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
	assert.equal(requests(a.peer).length + requests(b.peer).length, 0);
});

test("a target-only command with an unknown ID returns the error and the current session list", () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	message("/wecom-aibot --sessionid missing-session");
	assert.match(prompt(), /^找不到这个 session ID/);
	assert.match(prompt(), /当前有 2 个在线会话/);
	assert.match(prompt(), new RegExp(SESSION_A));
	assert.match(prompt(), new RegExp(SESSION_B));
	assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
	assert.equal(requests(a.peer).length + requests(b.peer).length, 0);
});

test("a single-session query waits up to two seconds and ignores answers from the wrong pi or after completion", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const a = add("A", SESSION_A);
	add("B", SESSION_B);
	a.peer.busy = undefined;
	const replies = () => a.ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").length;
	const before = replies();
	message(`/wecom-aibot --sessionid ${SESSION_A}`);
	const query = a.peer.frames.find((frame) => frame.type === "request" && frame.request.action === "state");
	assert.ok(query?.type === "request");
	gateway.response("B", query.id, { ok: true, busy: true });
	assert.equal(replies(), before);
	t.mock.timers.tick(1_999);
	assert.equal(replies(), before);
	t.mock.timers.tick(1);
	assert.equal(replies(), before + 1);
	assert.match(prompt(), /^· project-A · provider-A · model-A · 状态未知\n/);
	gateway.response("A", query.id, { ok: true, busy: true });
	t.mock.timers.tick(2_000);
	assert.equal(replies(), before + 1);
});

test("a pi leaving during a single-session query falls back to the remaining live session list", () => {
	const a = add("A", SESSION_A);
	add("B", SESSION_B);
	a.peer.busy = undefined;
	message(`/wecom-aibot --sessionid ${SESSION_A}`);
	gateway.unregister("A", a.peer);
	assert.match(prompt(), /^找不到这个 session ID/);
	assert.match(prompt(), /当前有 1 个在线会话/);
	assert.match(prompt(), new RegExp(SESSION_B));
	assert.doesNotMatch(prompt(), /project-A/);
});

test("a re-registered pi cannot inherit an in-flight single-session query", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const a = add("A", SESSION_A);
	a.peer.busy = undefined;
	message(`/wecom-aibot --sessionid ${SESSION_A}`);
	const next = registration("A", SESSION_B);
	next.registrationId = "new-registration";
	const peer = new Peer("A");
	gateway.register(next, peer);
	t.mock.timers.tick(2_000);
	assert.match(prompt(), /^找不到这个 session ID/);
	assert.match(prompt(), new RegExp(`session: ${SESSION_B}`));
	assert.doesNotMatch(prompt(), new RegExp(SESSION_A));
});

test("single-session queries only reveal sessions the sender can access", () => {
	const a = add("A", SESSION_A, (value) => {
		value.config.allowedUserIds = ["alice"];
	});
	const b = add("B", SESSION_B, (value) => {
		value.config.allowedUserIds = ["bob"];
	});
	message(`/wecom-aibot --sessionid ${SESSION_B}`, { from: { userid: "alice" } });
	assert.match(prompt(), /^找不到这个 session ID/);
	assert.match(prompt(), new RegExp(SESSION_A));
	assert.doesNotMatch(prompt(), /project-B/);
	assert.doesNotMatch(prompt(), new RegExp(SESSION_B));
	assert.equal(b.peer.frames.filter((frame) => frame.type === "request").length, 0);
	message(`/wecom-aibot --sessionid ${SESSION_A}`, { from: { userid: "alice" } });
	assert.match(prompt(), /^· project-A · provider-A · model-A · 空闲\n/);
	assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
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
	assert.equal(asked().quote_area.quote_text, "second");
});

test("a quote that names no online session is reported, never redirected to another pi", () => {
	const a = add("A", SESSION_A);
	message("orphan", { quote: quote(SESSION_B) });
	assert.equal(a.peer.messages().length, 0);
	const card = asked();
	assert.match(card.sub_title_text, /^引用的消息或图片看不出是哪个在线会话；/);
	assert.deepEqual(
		card.button_selection.option_list[0].id,
		sessionFingerprint(SESSION_A),
		"asked, never redirected by itself",
	);
});

test("a quoted card names nothing, so the sender is asked, and told why", () => {
	const a = add("A", SESSION_A);
	// Exactly what WeCom delivered when a card was quoted (probe, 2026-10).
	message("引用卡片后的一句话", { quote: { msgtype: "text", text: { content: "[该消息类型暂不能展示]" } } });
	assert.equal(a.peer.messages().length, 0);
	const card = asked();
	assert.equal(card.quote_area.quote_text, "引用卡片后的一句话");
	assert.match(card.sub_title_text, /^引用的是卡片：企业微信不给卡片内容，看不出是哪个会话；/);
});

test("a quote with several session IDs is ambiguous and delivers nothing", () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	const both = { msgtype: "text", text: { content: `session: ${SESSION_A}\nsession: ${SESSION_B}` } };
	message("which one", { quote: both });
	assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
	assert.match(asked().sub_title_text, /看不出是哪个在线会话/);
});

test("a command wins over a quote: the named session takes it", () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	send(SESSION_A, "named", { quote: quote(SESSION_B) });
	assert.equal(a.peer.messages().length, 1);
	assert.equal(b.peer.messages().length, 0);
});

test("an explicit target wins over a conflicting quote for cancel too", () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	message(`/wecom-aibot --sessionid ${SESSION_A} cancel`, { quote: quote(SESSION_B) });
	assert.equal(requests(a.peer).at(-1)!.request.action, "cancel");
	assert.equal(requests(b.peer).length, 0);
});

test("commands never infer a missing target from a quoted notification or image", () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	for (const quoteBody of [quote(SESSION_B), { msgtype: "image", image: { url: "https://example.invalid/q" } }]) {
		for (const action of ["send", "card", "cancel"]) {
			message(`/wecom-aibot ${action}${action === "send" ? " --prompt task" : ""}`, { quote: quoteBody });
			assert.match(prompt(), new RegExp(`^${action} 需要目标：`));
		}
	}
	assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
	assert.equal(requests(a.peer).length + requests(b.peer).length, 0);
});

test("--prompt keeps spaces, dashes, newlines and command-looking text verbatim, with no UUID exception", () => {
	const a = add("A", SESSION_A);
	const text = `修复  --screen 和 --sessionid ${SESSION_B} 的解析\n第二行 --help --prompt\n\n`;
	send(SESSION_A, text);
	assert.equal(a.peer.messages()[0].task.message.text, text);
});

test("a target written only after --prompt remains prose and cannot supply the missing command target", () => {
	const a = add("A", SESSION_A);
	message(`/wecom-aibot send --prompt 正文 --sessionid ${SESSION_A}`);
	assert.equal(a.peer.messages().length, 0);
	assert.match(prompt(), /^send 需要目标：/);
	assert.doesNotMatch(prompt(), /必须写在 --prompt 之前/);
});

test("the action-first target syntax reports its replacement without executing any action", () => {
	const a = add("A", SESSION_A);
	for (const action of ["send", "card", "cancel"]) {
		message(`/wecom-aibot ${action} --sessionid ${SESSION_A}${action === "send" ? " --prompt task" : ""}`);
		assert.match(prompt(), /^--session-id 要写在动作前：/);
		assert.ok(prompt().includes(`/wecom-aibot --session-id ${SESSION_A} ${action}`));
	}
	assert.equal(a.peer.messages().length, 0);
	assert.equal(requests(a.peer).length, 0);
});

test("help never queries or operates on a supplied target, even when it is offline", () => {
	const a = add("A", SESSION_A);
	for (const content of [
		`/wecom-aibot --sessionid ${SESSION_A} --help`,
		"/wecom-aibot --sessionid offline-session --help",
		"/wecom-aibot --sessionid offline-session send --help",
		`/wecom-aibot --sessionid ${SESSION_A} card --help`,
		`/wecom-aibot --sessionid ${SESSION_A} cancel --help`,
	]) {
		message(content);
		assert.match(prompt(), /sessions|send|card|cancel/);
		assert.doesNotMatch(prompt(), /找不到这个 session ID/);
	}
	assert.equal(a.peer.messages().length, 0);
	assert.equal(a.peer.frames.filter((frame) => frame.type === "request").length, 0);
});

test("all text guidance and action help use the target-first grammar", () => {
	add("A", SESSION_A);
	for (const content of ["/wecom-aibot --help"]) {
		message(content);
		assert.match(prompt(), /\/wecom-aibot --session-id <[^>]+> send --prompt/);
		assert.doesNotMatch(prompt(), /\/wecom-aibot (?:send|card|cancel)\s+--sessionid/);
	}
	for (const action of ["send", "card", "cancel"]) {
		message(`/wecom-aibot ${action} --help`);
		assert.ok(prompt().includes(`/wecom-aibot --session-id <完整 session ID> ${action}`));
		assert.doesNotMatch(prompt(), /\/wecom-aibot (?:send|card|cancel)\s+--sessionid/);
		for (const line of prompt().split("\n")) assert.equal(line.endsWith("。"), false);
	}
});

test("an equals form is an unknown option, and the error lists what is supported", () => {
	const a = add("A", SESSION_A);
	message(`/wecom-aibot --sessionid=${SESSION_A} send --prompt x`);
	assert.equal(a.peer.messages().length, 0);
	assert.match(prompt(), /未知选项 --sessionid=/);
	assert.match(prompt(), /可用选项：--session-id、--help/);
	assert.match(prompt(), /不支持 =/);
});

test("a positional argument is rejected; the prompt belongs after --prompt", () => {
	const a = add("A", SESSION_A);
	message(`/wecom-aibot send ${SESSION_A} 正文`);
	assert.equal(a.peer.messages().length, 0);
	assert.match(prompt(), /不接受位置参数/);
});

test("a failed cancel request reports the pi's reason", () => {
	const a = add("A", SESSION_A);
	message(`/wecom-aibot --sessionid ${SESSION_A} cancel`);
	gateway.response("A", requests(a.peer)[0].id, { ok: false, error: "这一轮已结束" });
	assert.match(prompt(), /中止请求未送达：这一轮已结束/);
});

test("a request is only answered by the pi it was sent to", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const a = add("A", SESSION_A);
	add("B", SESSION_B);
	message(`/wecom-aibot --sessionid ${SESSION_A} cancel`);
	const count = a.ws.sent.length;
	gateway.response("B", requests(a.peer)[0].id, { ok: true });
	assert.equal(a.ws.sent.length, count, "another pi's answer is ignored");
	t.mock.timers.tick(20_000);
	assert.match(prompt(), /20 秒内响应/);
});

test("cancel asks the named pi and says only that abort was requested", () => {
	const a = add("A", SESSION_A);
	message(`/wecom-aibot --sessionid ${SESSION_A} cancel`);
	const request = requests(a.peer)[0];
	assert.deepEqual(request.request, { action: "cancel", target: sessionTarget(a.value) });
	gateway.response("A", request.id, { ok: true });
	assert.match(prompt(), /已请求中止/);
});

test("a request nobody answers times out with the timeout named", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	add("A", SESSION_A);
	message(`/wecom-aibot --sessionid ${SESSION_A} cancel`);
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

test("entering a chat sends a chooser through the dedicated welcome reply without starting a task", () => {
	const a = add("A", SESSION_A);
	add("B", SESSION_B);
	const count = a.ws.sent.length;
	a.ws.receive({
		cmd: "aibot_event_callback",
		headers: { req_id: "enter" },
		body: { from: { userid: "user" }, event: { eventtype: "enter_chat" } },
	});
	assert.equal(a.ws.sent.length, count + 1);
	assert.equal(a.ws.sent.at(-1).cmd, "aibot_respond_welcome_msg");
	assert.equal(a.ws.sent.at(-1).headers.req_id, "enter");
	assert.equal(picker().main_title.title, "2 个在线会话");
	assert.equal(a.peer.messages().length, 0);
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
	assert.match(asked().sub_title_text, /看不出是哪个在线会话/);
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
			notificationPayload("notice", b.value.source, "wrong source"),
		),
		/session/,
	);
	assert.equal(a.ws.sent.length, count);
	assert.equal(gateway.taskStatus("A", inbound.headers.req_id, "running"), true);
	assert.equal(a.ws.sent.length, count, "running sends nothing");
	assert.equal(gateway.taskStatus("A", inbound.headers.req_id, "failed"), true);
	const status = a.ws.sent.at(-1);
	assert.equal(status.headers.req_id, inbound.headers.req_id);
	assert.deepEqual(status.body.stream, {
		id: status.body.stream.id,
		finish: true,
		content: formatProcessingStatus(SESSION_A, "failed", "project-A"),
	});
});

test("concurrent notifications preserve separate source metadata and acknowledgement ownership", async () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	let resolvedA = false;
	const first = gateway
		.notify(
			"A",
			{ chatId: "user-A", chatType: 1 },
			{
				...notificationPayload("notice", a.value.source, "result A"),
				...controlled(a.value.source),
			},
		)
		.then(() => {
			resolvedA = true;
		});
	const frameA = a.ws.sent.at(-1);
	const second = gateway.notify(
		"B",
		{ chatId: "group-B", chatType: 2 },
		{ ...notificationPayload("notice", b.value.source, "result B"), ...controlled(b.value.source) },
	);
	const frameB = a.ws.sent.at(-1);
	a.ws.acknowledge(frameB);
	await second;
	assert.equal(resolvedA, false);
	assert.equal(frameA.body.template_card.main_title.desc, "🤖 model-A · provider-A");
	assert.equal(frameB.body.template_card.main_title.desc, "🤖 model-B · provider-B");
	assert.equal(frameA.body.chatid, "user-A");
	assert.equal(frameB.body.chat_type, 2);
	a.ws.acknowledge(frameA);
	await first;
});

test("allowlists hide and gate sessions, including quoted targets, and blocked enter_chat stays silent", () => {
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
	assert.equal(JSON.stringify(asked()).includes(SESSION_B), false, "a hidden session is never offered");
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

test("a task that runs past ten minutes still ends in its card, and its message is never answered", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const a = add("A", SESSION_A);
	a.ws.onSend = (frame) => {
		if (frame.cmd === "ping" || frame.cmd === "aibot_respond_msg" || frame.cmd === "aibot_send_msg")
			a.ws.acknowledge(frame);
	};
	const task = send(SESSION_A, "long task");
	const replies = () =>
		a.ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg" && frame.headers.req_id === task.headers.req_id);
	assert.equal(gateway.taskStatus("A", task.headers.req_id, "running"), true);
	t.mock.timers.tick(30 * 60_000);
	assert.equal(replies().length, 0, "nothing while it runs");
	assert.equal(gateway.taskStatus("A", task.headers.req_id, "settled"), true);
	await gateway.notify(
		"A",
		{ chatId: "user", chatType: 1 },
		{
			kind: "result",
			source: a.value.source,
			text: "LATE-RESULT",
			...controlled(a.value.source),
		},
	);
	assert.equal(replies().length, 0);
	assert.equal(a.ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 1);
});
test("a reply WeCom could not take while disconnected is sent after the reconnect", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const a = add("A", SESSION_A);
	const task = send(SESSION_A, "task");
	a.ws.close();
	assert.equal(gateway.taskStatus("A", task.headers.req_id, "failed"), false, "not written");
	t.mock.timers.tick(1_000);
	const next = FakeWebSocket.instances.at(-1)!;
	assert.notEqual(next, a.ws);
	next.open();
	next.acknowledge();
	const flushed = next.sent.filter((frame) => frame.cmd === "aibot_respond_msg");
	assert.equal(flushed.length, 1);
	assert.equal(flushed[0].headers.req_id, task.headers.req_id);
	assert.equal(flushed[0].body.stream.finish, true);
	assert.equal(flushed[0].body.stream.content, formatProcessingStatus(SESSION_A, "failed", "project-A"));
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

test("an unconfirmed card is never followed by a duplicate", async () => {
	const a = add("A", SESSION_A);
	const previous = a.ws.onSend;
	a.ws.onSend = (frame) => {
		previous?.(frame);
		if (frame.cmd === "aibot_send_msg") a.ws.close();
	};
	await assert.rejects(
		gateway.notify(
			"A",
			{ chatId: "user", chatType: 1 },
			{ kind: "notice", source: a.value.source, text: "BODY", ...controlled(a.value.source) },
		),
		{ outcome: "unknown" },
	);
	assert.deepEqual(
		a.ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").map((frame) => frame.body.msgtype),
		["template_card"],
	);
});

test("a notification without a control card is sent as Markdown with its session; a foreign card ID is never sent", async () => {
	const a = add("A", SESSION_A);
	a.ws.onSend = (frame) => {
		if (frame.cmd === "aibot_send_msg") a.ws.acknowledge(frame);
	};
	const chat = { chatId: "user", chatType: 1 as const };
	await gateway.notify("A", chat, notificationPayload("notice", a.value.source, "PLAIN", { title: "标题" }));
	const foreign = { ...controlled(a.value.source).control, cardId: controlCardId(SESSION_B) };
	await gateway.notify("A", chat, { ...notificationPayload("notice", a.value.source, "FOREIGN"), control: foreign });
	const pushes = a.ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.deepEqual(
		pushes.map((frame) => frame.body.msgtype),
		["markdown", "markdown"],
	);
	assert.equal(
		pushes[0].body.markdown.content,
		`🆔 session: ${SESSION_A}  \n🏷️ project-A · provider-A · model-A\n\n**标题**\n\nPLAIN`,
	);
	assert.match(pushes[1].body.markdown.content, /FOREIGN$/);
});

test("a card WeCom refuses is sent as Markdown within the UTF-8 byte limit, with its title", async () => {
	const a = add("A", SESSION_A);
	a.ws.onSend = (frame) => {
		if (frame.cmd === "aibot_send_msg") a.ws.acknowledge(frame, frame.body.msgtype === "template_card" ? 40058 : 0);
	};
	await gateway.notify(
		"A",
		{ chatId: "user", chatType: 1 },
		{
			kind: "result",
			source: a.value.source,
			title: "⛔ 已中止",
			text: "汉🙂".repeat(10000),
			aborted: true,
			...controlled(a.value.source),
		},
	);
	const pushes = a.ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.deepEqual(
		pushes.map((frame) => frame.body.msgtype),
		["template_card", "markdown"],
	);
	const content = pushes[1].body.markdown.content;
	assert.ok(Buffer.byteLength(content, "utf8") <= 20_480);
	assert.match(content, /\*\*⛔ 已中止\*\*/);
	assert.ok(content.endsWith("（本轮任务已中止）"));
	assert.equal(content.includes("\ufffd"), false);
});

test("a quoted image names no session, so the sender is asked", () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	message("这张图", { quote: { msgtype: "image", image: { url: "https://example.invalid/q" } } });
	assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
	assert.match(asked().sub_title_text, /^引用的消息或图片看不出是哪个在线会话/);
});

test("a quote carrying both text and an image is answered by the text", () => {
	const a = add("A", SESSION_A);
	const b = add("B", SESSION_B);
	message("混合", {
		quote: {
			msgtype: "mixed",
			mixed: { msg_item: [{ msgtype: "text", text: { content: `session: ${SESSION_B}` } }] },
			image: { url: "https://example.invalid/q" },
		},
	});
	assert.equal(b.peer.messages()[0].task.message.text, "混合");
	assert.equal(a.peer.messages().length, 0);
});

// ---------------------------------------------------------------- cards and clicks

/** A button press on one of the bot's cards, as WeCom delivers it. */
function click(taskId: string, key: string, body: Record<string, unknown> = {}) {
	const id = `click-${++sequence}`;
	FakeWebSocket.instances.at(-1)!.receive({
		cmd: "aibot_event_callback",
		headers: { req_id: id },
		body: {
			msgid: id,
			from: { userid: "user" },
			chattype: "single",
			msgtype: "event",
			event: {
				eventtype: "template_card_event",
				template_card_event: { card_type: "button_interaction", event_key: key, task_id: taskId },
			},
			...body,
		},
	});
	return id;
}

/** Publish this pi's control card and return what WeCom received. */
async function publish(instanceId: string, ws: FakeWebSocket, source: GatewayRegistration["source"]) {
	ws.onSend = (frame) => {
		if (frame.cmd === "aibot_send_msg" || frame.cmd === "aibot_respond_update_msg") ws.acknowledge(frame);
	};
	await gateway.notify(
		instanceId,
		{ chatId: "user", chatType: 1 },
		{
			...notificationPayload("result", source, "RESULT", { title: "✅ 完成" }),
			...controlled(source),
		},
	);
	return ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1).body.template_card;
}

function clicks(peer: Peer) {
	return peer.frames.filter(
		(frame): frame is Extract<ServerFrame, { type: "request" }> =>
			frame.type === "request" && frame.request.action === "click",
	);
}

function updates(ws: FakeWebSocket) {
	return ws.sent.filter((frame) => frame.cmd === "aibot_respond_update_msg");
}

test("a click WeCom delivers twice is handled once; a group event without its chat goes nowhere", async () => {
	const a = add("A", SESSION_A);
	const card = await publish("A", a.ws, a.value.source);
	const refresh = controlKey("refresh", SESSION_A);
	click(card.task_id, refresh, { msgid: "same-click" });
	click(card.task_id, refresh, { msgid: "same-click" });
	assert.equal(clicks(a.peer).length, 1);
	click(card.task_id, refresh, { chattype: "group" });
	assert.equal(clicks(a.peer).length, 1);
});

test("a card this gateway no longer draws says so in place: an old notification card, an old list, an unknown key", async () => {
	const a = add("A", SESSION_A);
	a.ws.onSend = (frame) => {
		if (frame.cmd === "aibot_respond_update_msg") a.ws.acknowledge(frame);
	};
	const pressed = [
		click(`c@${SESSION_A}@0123456789ab`, "screen"),
		click(`c@${SESSION_A}@0123456789ab`, "full-e-abc"),
		click("p@0123456789ab", "select@session-A"),
		click("p@0123456789ab", "clear"),
		click("probe-button-1", "anything"),
	];
	assert.equal(clicks(a.peer).length, 0, "nothing reaches a pi");
	assert.deepEqual(
		updates(a.ws).map((frame) => frame.headers.req_id),
		pressed,
	);
	for (const update of updates(a.ws)) {
		const card = update.body.template_card;
		assert.equal(card.main_title.title, "这张卡已停用");
		assert.deepEqual(
			card.button_list.map((button: { text: string }) => button.text),
			["已停用"],
		);
	}
	assert.equal(a.ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0, "no message is pushed");
	// Someone the bot does not serve gets silence.
	gateway.unregister("A", a.peer);
	add("B", SESSION_B, (value) => {
		value.config.allowedUserIds = ["alice"];
	});
	click("probe-button-2", "anything");
	assert.equal(updates(a.ws).length, pressed.length);
});

test("a click's follow-up is pushed to the card's chat as Markdown, within WeCom's byte limit", async () => {
	const a = add("A", SESSION_A);
	const previous = a.ws.onSend;
	a.ws.onSend = (frame: any) => {
		previous?.(frame);
		if (frame.cmd === "aibot_send_msg") a.ws.acknowledge(frame);
	};
	const group = { chatId: "group-1", chatType: 2 as const };
	await gateway.push("A", group, { kind: "markdown", text: "全文正文" });
	const markdown = a.ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
	assert.deepEqual(markdown.body, {
		chatid: "group-1",
		chat_type: 2,
		msgtype: "markdown",
		markdown: { content: "全文正文" },
	});
	await assert.rejects(gateway.push("A", group, { kind: "markdown", text: "x".repeat(20_481) }), {
		outcome: "rejected",
	});
});
