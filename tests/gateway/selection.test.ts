import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { type GatewayPeer, WeComGateway } from "../../src/gateway/runtime.ts";
import { sessionFingerprint } from "../../src/shared/control-card.ts";
import type { GatewayRegistration, ServerFrame } from "../../src/shared/gateway-protocol.ts";
import { FakeWebSocket } from "../support/fake-websocket.ts";

let gateway: WeComGateway;
let sequence = 0;

class Peer implements GatewayPeer {
	frames: ServerFrame[] = [];
	closed = false;
	busy: boolean | undefined = false;
	constructor(readonly registration: GatewayRegistration) {}
	send(frame: ServerFrame): boolean {
		if (this.closed) return false;
		this.frames.push(frame);
		if (frame.type === "request" && frame.request.action === "state" && this.busy !== undefined)
			gateway.response(this.registration.instanceId, frame.id, { ok: true, busy: this.busy });
		return true;
	}
	close(): void {
		this.closed = true;
	}
	tasks() {
		return this.frames.filter((frame) => frame.type === "task");
	}
}

function add(id: string, allowedUserIds?: string[], identifyOnly = false): Peer {
	const registration: GatewayRegistration = {
		instanceId: id,
		registrationId: `reg-${id}-${++sequence}`,
		source: { sessionId: `session-${id}`, directoryName: `project-${id}`, provider: "provider", modelName: "model" },
		config: { botId: "test-bot", allowedUserIds },
		identifyOnly,
	};
	const peer = new Peer(registration);
	gateway.register(registration, peer);
	return peer;
}

function ws(): FakeWebSocket {
	return FakeWebSocket.instances.at(-1)!;
}

function receive(cmd: string, body: Record<string, unknown>) {
	const id = `callback-${++sequence}`;
	const frame = {
		cmd,
		headers: { req_id: id },
		body: { msgid: id, chattype: "single", from: { userid: "alice" }, ...body },
	};
	ws().receive(frame);
	return frame;
}

function message(text: string, body: Record<string, unknown> = {}) {
	return receive("aibot_msg_callback", { msgtype: "text", text: { content: text }, ...body });
}

function click(taskId: string, key: string, body: Record<string, unknown> = {}) {
	return receive("aibot_event_callback", {
		msgtype: "event",
		event: { eventtype: "template_card_event", template_card_event: { task_id: taskId, event_key: key } },
		...body,
	});
}

/** 确认发送 on a question card with `session` chosen in its dropdown. */
function send(taskId: string, session: string, body: Record<string, unknown> = {}) {
	return receive("aibot_event_callback", {
		msgtype: "event",
		event: {
			eventtype: "template_card_event",
			template_card_event: {
				task_id: taskId,
				event_key: "send",
				selected_items: {
					selected_item: [{ question_key: "target", option_ids: { option_id: [sessionFingerprint(session)] } }],
				},
			},
		},
		...body,
	});
}

function options(card: any): string[] {
	return card.button_selection.option_list.map((option: { text: string }) => option.text);
}

function enter(body: Record<string, unknown> = {}) {
	return receive("aibot_event_callback", { msgtype: "event", event: { eventtype: "enter_chat" }, ...body });
}

function cardFrame() {
	const frame = ws()
		.sent.filter((item) => item.body?.template_card)
		.at(-1);
	assert.ok(frame, "expected a card");
	return frame;
}

function reply(): string {
	return (
		ws()
			.sent.filter((frame) => frame.cmd === "aibot_respond_msg")
			.at(-1)?.body.stream.content ?? ""
	);
}

const group = { chattype: "group", chatid: "group-1" };
const bob = { from: { userid: "bob" } };
const quoted = (id: string) => ({ msgtype: "text", text: { content: `session: session-${id}` } });

beforeEach(() => {
	sequence = 0;
	FakeWebSocket.instances = [];
	gateway = new WeComGateway({
		botId: "test-bot",
		secret: "test-secret",
		createWebSocket(url) {
			const socket = new FakeWebSocket(url);
			socket.onSend = (frame) => socket.acknowledge(frame);
			queueMicrotask(() => socket.open());
			return socket;
		},
	});
});
afterEach(() => gateway.stop());

async function ready() {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

/** The question a message without a session gets; nothing answers it by itself. */
function question(): any {
	const card = cardFrame().body.template_card;
	assert.match(card.task_id, /^q@[0-9a-f]{12}$/, "a question card");
	return card;
}

function updated(): any {
	return ws()
		.sent.filter((frame) => frame.cmd === "aibot_respond_update_msg")
		.at(-1);
}

function repliesTo(frame: { headers: { req_id: string } }) {
	return ws().sent.filter((item) => item.cmd === "aibot_respond_msg" && item.headers.req_id === frame.headers.req_id);
}

test("a message without a session waits for one click, and the chosen pi answers the message itself", async () => {
	const a = add("A");
	const b = add("B");
	await ready();
	const sent = message("修一下构建");
	await ready();
	assert.equal(a.tasks().length + b.tasks().length, 0, "nothing reaches a pi by itself");
	const card = question();
	assert.equal(card.main_title.title, "这条消息发给哪个会话？");
	assert.equal(card.quote_area.quote_text, "修一下构建");
	// The sessions are a dropdown, each with its state; below it 确认发送 and 取消发送, in one row.
	assert.equal(card.button_selection.question_key, "target");
	assert.deepEqual(options(card), ["project-A · on-A · 空闲", "project-B · on-B · 空闲"]);
	assert.deepEqual(
		card.button_list.map((button: { key: string; text: string }) => [button.key, button.text]),
		[
			["send", "确认发送"],
			["cancel", "取消发送"],
		],
	);
	// The rows carry the longer text: each session's folder, the end of its ID, its model.
	assert.deepEqual(
		card.horizontal_content_list.map((row: { keyname: string; value: string }) => [row.keyname, row.value]),
		[
			["空闲", "project-A · on-A · model"],
			["空闲", "project-B · on-B · model"],
		],
	);
	send(card.task_id, "session-B");
	await ready();
	assert.equal(b.tasks().length, 1);
	const [task] = b.tasks();
	assert.ok(task.type === "task");
	assert.equal(task.task.id, sent.headers.req_id, "the message's own req_id: its status and result reply to it");
	assert.equal(task.task.message.text, "修一下构建");
	const settled = updated().body.template_card;
	assert.deepEqual(
		settled.button_list.map((button: { key: string }) => button.key),
		["done"],
	);
	assert.equal(settled.button_selection, undefined, "a decided card offers no choice");
	// It names the session the way its control card does: directory, model, ID; the quote is still the message.
	assert.equal(settled.source.desc, "已发送");
	assert.equal(settled.main_title.title, "📁 project-B");
	assert.equal(settled.main_title.desc, "🤖 model · provider");
	assert.equal(settled.sub_title_text, "🆔 session-id: session-B");
	assert.equal(settled.quote_area.quote_text, "修一下构建");
	const row = settled.horizontal_content_list.at(-1);
	assert.equal(row.keyname, "发送记录");
	assert.match(row.value, /已发出，跑完后结果卡发到这个聊天$/);
	// Nothing was remembered: the next message is asked about again, and the old card sends nothing more.
	message("下一条");
	await ready();
	assert.equal(question().quote_area.quote_text, "下一条");
	send(card.task_id, "session-A");
	await ready();
	assert.equal(a.tasks().length, 0);
	assert.deepEqual(updated().body.template_card, settled, "a stale click redraws it exactly as decided");
});

test("in a group only the sender decides; another member's click changes only their own copy", async () => {
	const a = add("A");
	await ready();
	message("@bot 群里的任务", group);
	await ready();
	const card = question();
	assert.match(card.sub_title_text, /只有发送者能选/);
	send(card.task_id, "session-A", { ...group, ...bob });
	await ready();
	assert.equal(a.tasks().length, 0);
	const refused = updated();
	assert.deepEqual(refused.body.userids, ["bob"], "only Bob's copy says so");
	assert.match(refused.body.template_card.horizontal_content_list.at(-1).value, /只有发送者能选择/);
	// The dropdown left as drawn: the first session, shown selected.
	click(card.task_id, "send", group);
	await ready();
	assert.equal(a.tasks().length, 1, "Alice still decides her own message");
	assert.equal(updated().body.userids, undefined, "everyone sees it was sent");
});

test("commands and quotes that name a session go straight there; nothing is asked or remembered", async () => {
	const a = add("A");
	const b = add("B");
	await ready();
	message("/wecom-aibot --session-id session-A send --prompt named");
	message("quoted", { quote: quoted("B") });
	await ready();
	assert.equal(a.tasks().length, 1);
	assert.equal(b.tasks().length, 1);
	assert.equal(
		ws().sent.some((frame) => /^q@/.test(frame.body?.template_card?.task_id ?? "")),
		false,
		"no question for a message that names its session",
	);
	message("plain again");
	await ready();
	assert.equal(a.tasks().length + b.tasks().length, 2);
	assert.equal(question().quote_area.quote_text, "plain again");
});

test("cancel, expiry and a newer message each close the message with why, and its card sends nothing after", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const a = add("A");
	await ready();
	const cancelled = message("取消这条");
	await ready();
	const first = question();
	click(first.task_id, "cancel");
	await ready();
	assert.match(repliesTo(cancelled).at(-1).body.stream.content, /已取消，没有发出/);
	const closed = updated().body.template_card;
	assert.equal(closed.source.desc, "未发送");
	assert.equal(closed.main_title.title, "这条消息没有发出");
	assert.match(closed.horizontal_content_list.at(-1).value, /已取消$/);
	// A newer message from the same sender replaces the waiting one.
	const replaced = message("旧的");
	await ready();
	const old = question();
	message("新的");
	await ready();
	assert.match(repliesTo(replaced).at(-1).body.stream.content, /之后又发了一条，以那条为准/);
	send(old.task_id, "session-A");
	await ready();
	assert.equal(a.tasks().length, 0, "the replaced message is gone");
	// The newest one expires after four minutes, before WeCom's attachment links do.
	const latest = ws().sent.filter((frame) => frame.cmd === "aibot_msg_callback").length;
	assert.equal(latest, 0);
	t.mock.timers.tick(4 * 60_000);
	const expired = ws()
		.sent.filter((frame) => frame.cmd === "aibot_respond_msg")
		.at(-1);
	assert.match(expired.body.stream.content, /4 分钟内没有选择会话，请重新发送/);
	send(question().task_id, "session-A");
	await ready();
	assert.equal(a.tasks().length, 0);
	assert.match(updated().body.template_card.horizontal_content_list.at(-1).value, /已过期或已被新消息替换$/);
});

test("a session that left while its message waited is refused on the card, and the message waits on", async () => {
	const a = add("A");
	const b = add("B");
	await ready();
	message("还在等");
	await ready();
	const card = question();
	gateway.unregister("B", b);
	send(card.task_id, "session-B");
	await ready();
	assert.match(updated().body.template_card.horizontal_content_list.at(-1).value, /选的会话已离线，请选另一个$/);
	send(card.task_id, "session-A");
	await ready();
	assert.equal(a.tasks().length, 1, "still the sender's to send");
});

test("allowlists and identify-only registrations are never offered, and no forged key reaches them", async () => {
	const a = add("A", ["alice"]);
	const b = add("B", ["bob"]);
	add("I", undefined, true);
	await ready();
	message("only mine");
	await ready();
	const card = question();
	assert.deepEqual(options(card), ["project-A · on-A · 空闲"]);
	send(card.task_id, "session-B");
	await ready();
	assert.equal(b.tasks().length, 0);
	assert.equal(a.tasks().length, 0);
});

test("question callbacks are deduplicated: a replayed click sends its message once", async () => {
	const a = add("A");
	await ready();
	message("once");
	await ready();
	const event = send(question().task_id, "session-A");
	ws().receive(event);
	await ready();
	assert.equal(a.tasks().length, 1);
});

/** A list button clicked with `session` chosen in the list's dropdown. */
function pick(taskId: string, key: string, session?: string) {
	return receive("aibot_event_callback", {
		msgtype: "event",
		event: {
			eventtype: "template_card_event",
			template_card_event: {
				task_id: taskId,
				event_key: key,
				...(session
					? {
							selected_items: {
								selected_item: [
									{ question_key: "pick", option_ids: { option_id: [sessionFingerprint(session)] } },
								],
							},
						}
					: {}),
			},
		},
	});
}

test("打开会话 asks the session the dropdown names for a new control card; the list stays, on that session", async () => {
	const a = add("A");
	const b = add("B");
	await ready();
	message("/wecom-aibot sessions");
	await ready();
	const list = cardFrame().body.template_card;
	assert.equal(list.button_selection.question_key, "pick");
	assert.equal(list.main_title.title, "2 个在线会话");
	assert.deepEqual(options(list), ["project-A · on-A · 空闲", "project-B · on-B · 空闲"]);
	assert.equal(
		list.button_selection.selected_id,
		sessionFingerprint("session-A"),
		"the first row: no one singled out",
	);
	const first = sessionFingerprint("session-A");
	assert.deepEqual(
		list.button_list.map((button: { key: string; text: string }) => [button.key, button.text]),
		[
			[`pick@show@${first}`, "打开会话"],
			[`pick@refresh@${first}`, "刷新列表"],
		],
	);
	const forwarded = (peer: Peer) => {
		const frame = peer.frames.filter((item) => item.type === "request").at(-1);
		assert.ok(frame?.type === "request" && frame.request.action === "click");
		return { id: frame.id, click: frame.request.click };
	};
	// The dropdown names B: B is asked to publish its card, as the card command does; no card ID goes with it.
	pick(list.task_id, `pick@show@${first}`, "session-B");
	const asked = forwarded(b);
	assert.deepEqual(asked.click, { key: "control", userid: "alice", chat: { chatId: "alice", chatType: 1 } });
	gateway.response("B", asked.id, { ok: true, note: "已请求补发控制卡；旧卡仍可操作同一会话" });
	await ready();
	const kept = updated().body.template_card;
	assert.equal(kept.task_id, list.task_id, "the list itself is redrawn");
	assert.equal(kept.button_selection.question_key, "pick", "still the list");
	assert.equal(kept.button_selection.selected_id, sessionFingerprint("session-B"), "on the session opened");
	assert.match(kept.horizontal_content_list.at(-1).value, /已打开「project-B · on-B」的控制卡$/);
	// 刷新列表 asks every pi again and keeps the dropdown where it was.
	pick(list.task_id, `pick@refresh@${first}`, "session-B");
	await ready();
	const refreshed = updated().body.template_card;
	assert.equal(refreshed.button_selection.selected_id, sessionFingerprint("session-B"));
	assert.match(refreshed.horizontal_content_list.at(-1).value, /已刷新$/);
	// A session that refuses says why on the list.
	pick(list.task_id, `pick@show@${first}`, "session-B");
	gateway.response("B", forwarded(b).id, { ok: false, error: "pi 尚未正式接入" });
	await ready();
	assert.match(updated().body.template_card.horizontal_content_list.at(-1).value, /处理失败：pi 尚未正式接入$/);
	// A choice gone offline redraws the list as it is now, with a note, and reaches no one.
	const requests = a.frames.length;
	gateway.unregister("A", a);
	pick(list.task_id, `pick@show@${first}`, "session-A");
	await ready();
	assert.equal(a.frames.length, requests);
	const note = updated().body.template_card;
	assert.equal(note.button_selection.question_key, "pick", "still the list");
	assert.equal(note.main_title.title, "1 个在线会话");
	assert.deepEqual(options(note), ["project-B · on-B · 空闲"]);
	assert.match(note.horizontal_content_list.at(-1).value, /选的会话已离线，请选另一个$/);
	// Keys no list draws today do nothing, and nothing is remembered.
	const before = ws().sent.length;
	const seen = b.frames.length;
	for (const [taskId, key] of [
		[list.task_id, `pick@abort@${first}`],
		[list.task_id, "pick@send"],
		["p@0123456789ab", "card@session-B"],
		["p@0123456789ab", "page@1"],
		["p@0123456789ab", "select@session-B"],
		["c@session-B@0123456789ab", "select"],
	])
		click(taskId, key);
	assert.equal(ws().sent.length, before, "no card is updated and no note is sent");
	assert.equal(b.frames.slice(seen).filter((frame) => frame.type === "request").length, 0, "no session is asked");
	message("still asked");
	await ready();
	assert.equal(b.tasks().length, 0);
	assert.equal(question().quote_area.quote_text, "still asked");
});

test("a list of more than five sessions turns its pages in place; in a group only the clicker's copy turns", async () => {
	const peers = ["A", "B", "C", "D", "E", "F", "G"].map((id) => add(id));
	await ready();
	message("@bot /wecom-aibot sessions", group);
	await ready();
	const list = cardFrame().body.template_card;
	assert.equal(list.main_title.desc.startsWith("第 1/2 页"), true);
	assert.deepEqual(options(list), [
		"project-A · on-A · 空闲",
		"project-B · on-B · 空闲",
		"project-C · on-C · 空闲",
		"project-D · on-D · 空闲",
		"project-E · on-E · 空闲",
	]);
	assert.deepEqual(
		list.button_list.map((button: { text: string }) => button.text),
		["打开会话", "刷新列表", "上一页", "下一页"],
	);
	click(list.task_id, "pick@next@1", group);
	await ready();
	const turned = updated();
	assert.deepEqual(turned.body.userids, ["alice"], "only Alice's copy turns");
	assert.equal(turned.body.template_card.button_selection.title, "会话 2/2");
	assert.deepEqual(options(turned.body.template_card), ["project-F · on-F · 空闲", "project-G · on-G · 空闲"]);
	// 打开会话 on page 2 without a choice: its first row, F, publishes its card in the group.
	pick(list.task_id, turned.body.template_card.button_list[0].key);
	const forwarded = peers[5].frames.filter((frame) => frame.type === "request").at(-1);
	assert.ok(forwarded?.type === "request" && forwarded.request.action === "click");
	assert.equal(forwarded.request.click.key, "control");
});

test("whoami codes keep priority and never become a question", async () => {
	const a = add("A");
	const b = add("B");
	await ready();
	const code = gateway.watch("B", "identify-b", 60_000);
	message(code);
	assert.equal(b.frames.filter((frame) => frame.type === "identity").length, 1);
	assert.equal(a.tasks().length + b.tasks().length, 0);
	assert.equal(
		ws().sent.some((frame) => /^q@/.test(frame.body?.template_card?.task_id ?? "")),
		false,
	);
});

test("a question card WeCom refuses leaves the message unsent, with how to name its session instead", async () => {
	const a = add("A");
	await ready();
	ws().onSend = (frame) => ws().acknowledge(frame, frame.body?.msgtype === "template_card" ? 40058 : 0);
	const sent = message("拒收");
	await ready();
	await ready();
	assert.equal(a.tasks().length, 0);
	const answer = repliesTo(sent).at(-1);
	assert.match(answer.body.stream.content, /这条消息没有发出，请用命令指定会话/);
	assert.match(answer.body.stream.content, /--session-id <id> send --prompt/);
	assert.match(answer.body.stream.content, /session ID 写在会话的控制卡上$/, "a result is a card: nothing to quote");
});

test("welcome uses the dedicated event reply within five seconds and never pushes or starts a task", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const a = add("A", ["alice"]);
	add("B", ["bob"]);
	add("I", undefined, true);
	await ready();
	a.busy = undefined;
	const event = enter();
	const before = ws().sent.length;
	t.mock.timers.tick(2_000);
	assert.equal(ws().sent.length, before + 1);
	const welcome = cardFrame();
	assert.equal(welcome.cmd, "aibot_respond_welcome_msg");
	assert.equal(welcome.headers.req_id, event.headers.req_id);
	assert.match(JSON.stringify(welcome.body), /project-A/);
	assert.doesNotMatch(JSON.stringify(welcome.body), /project-B|project-I/);
	assert.deepEqual(options(welcome.body.template_card), ["project-A · on-A · 状态未知"]);
	ws().receive(event);
	assert.equal(ws().sent.length, before + 1, "a duplicate welcome event is ignored");
	assert.equal(a.tasks().length, 0);
});

test("blocked, group and malformed enter events stay silent, and identity-only connections do not welcome", async () => {
	const a = add("A", ["alice"]);
	await ready();
	const before = ws().sent.length;
	enter(bob);
	enter(group);
	enter({ from: {} });
	assert.equal(ws().sent.length, before);
	gateway.unregister("A", a);
	add("I", undefined, true);
	const after = ws().sent.length;
	enter();
	assert.equal(ws().sent.length, after);
});

test("a refused welcome falls back through the welcome interface, never through proactive push", async () => {
	add("A");
	await ready();
	ws().onSend = (frame) => ws().acknowledge(frame, frame.body?.msgtype === "template_card" ? 40058 : 0);
	const event = enter();
	await ready();
	const replies = ws().sent.filter((frame) => frame.headers.req_id === event.headers.req_id);
	assert.deepEqual(
		replies.map((frame) => [frame.cmd, frame.body.msgtype]),
		[
			["aibot_respond_welcome_msg", "template_card"],
			["aibot_respond_welcome_msg", "text"],
		],
	);
	assert.match(replies[1].body.text.content, /session-A/);
	assert.equal(
		ws().sent.some((frame) => frame.cmd === "aibot_send_msg"),
		false,
	);
});

test("a late welcome rejection cannot trigger a fallback outside the event's five-second window", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	add("A");
	await ready();
	ws().onSend = undefined;
	const event = enter();
	const welcome = ws().sent.at(-1);
	assert.equal(welcome.cmd, "aibot_respond_welcome_msg");
	t.mock.timers.tick(4_501);
	ws().acknowledge(welcome, 40058);
	await ready();
	assert.equal(ws().sent.filter((frame) => frame.headers.req_id === event.headers.req_id).length, 1);
});

test("a rejected chooser falls back to the text list, while an uncertain delivery never duplicates it", async () => {
	add("A");
	await ready();
	ws().onSend = (frame) => ws().acknowledge(frame, frame.body?.msgtype === "template_card" ? 40058 : 0);
	message("/wecom-aibot sessions");
	await ready();
	assert.match(reply(), /session-A/);
	assert.match(reply(), /当前有 1 个在线会话/);
	ws().onSend = (frame) => {
		if (frame.cmd === "aibot_send_msg") ws().close();
	};
	const before = ws().sent.length;
	message("/wecom-aibot sessions");
	await ready();
	assert.equal(ws().sent.length, before + 1);
});
