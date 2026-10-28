import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { type ControlView, sessionControlCard } from "../../src/extension/control-view.ts";
import { type GatewayPeer, WeComGateway } from "../../src/gateway/runtime.ts";
import {
	CONTROL_OFFLINE_LABEL,
	type ControlAction,
	controlCardId,
	controlKey,
	PI_ICON_URL,
	parseControlKey,
	sessionFingerprint,
} from "../../src/shared/control-card.ts";
import { deliveryFailure } from "../../src/shared/delivery.ts";
import type { GatewayRegistration, ServerFrame } from "../../src/shared/gateway-protocol.ts";
import { notificationPayload } from "../../src/shared/notification.ts";
import { FakeWebSocket } from "../support/fake-websocket.ts";

let gateway: WeComGateway;
let sequence = 0;
class Peer implements GatewayPeer {
	frames: ServerFrame[] = [];
	closed = false;
	constructor(readonly registration: GatewayRegistration) {}
	send(frame: ServerFrame): boolean {
		if (this.closed) return false;
		this.frames.push(frame);
		return true;
	}
	close() {
		this.closed = true;
	}
	requests() {
		return this.frames.filter((frame) => frame.type === "request");
	}
	tasks() {
		return this.frames.filter((frame) => frame.type === "task");
	}
}
function add(id: string, allowedUserIds?: string[], identifyOnly = false): Peer {
	const registration: GatewayRegistration = {
		instanceId: id,
		registrationId: `registration-${++sequence}`,
		source: { sessionId: `session-${id}`, directoryName: `project-${id}`, provider: "provider", modelName: "model" },
		config: { botId: "bot", allowedUserIds },
		identifyOnly,
	};
	const peer = new Peer(registration);
	gateway.register(registration, peer);
	const socket = ws();
	if (socket.readyState === 0) {
		socket.open();
		socket.acknowledge();
	}
	return peer;
}
function ws() {
	return FakeWebSocket.instances.at(-1)!;
}
function updates() {
	return ws().sent.filter((frame) => frame.cmd === "aibot_respond_update_msg");
}
const idle: ControlView = { status: "idle" };
/** A button of the card as drawn for this peer's session. */
function key(peer: Peer, action: ControlAction): string {
	return controlKey(action, peer.registration.source.sessionId);
}
/** The card's buttons as actions; each key names the session it was drawn for. */
function actions(card: any, peer?: Peer): string[] {
	return card.button_list.map((button: { key: string }) => {
		const parsed = parseControlKey(button.key);
		assert.ok(parsed, button.key);
		if (peer) assert.equal(parsed.fingerprint, sessionFingerprint(peer.registration.source.sessionId), button.key);
		return parsed.action;
	});
}
function fingerprintOf(peer: Peer): string {
	return sessionFingerprint(peer.registration.source.sessionId);
}
async function publish(peer: Peer, chat: { chatId: string; chatType: 1 | 2 } = { chatId: "alice", chatType: 1 }) {
	const cardId = controlCardId(peer.registration.source.sessionId);
	const card = sessionControlCard(peer.registration.source, idle);
	await gateway.push(peer.registration.instanceId, chat, { kind: "control", cardId, card });
	return { cardId, card };
}
function click(
	cardId: string,
	key: string,
	userid = "alice",
	options: { group?: string; selected?: Record<string, string> } = {},
) {
	const reqId = `click-${++sequence}`;
	const selected = options.selected
		? {
				selected_items: {
					selected_item: Object.entries(options.selected).map(([question, option]) => ({
						question_key: question,
						option_ids: { option_id: [option] },
					})),
				},
			}
		: {};
	ws().receive({
		cmd: "aibot_event_callback",
		headers: { req_id: reqId },
		body: {
			msgid: reqId,
			from: { userid },
			chattype: options.group ? "group" : "single",
			...(options.group ? { chatid: options.group } : {}),
			msgtype: "event",
			event: {
				eventtype: "template_card_event",
				template_card_event: { task_id: cardId, event_key: key, ...selected },
			},
		},
	});
	return reqId;
}
function message(text: string) {
	const id = `message-${++sequence}`;
	ws().receive({
		cmd: "aibot_msg_callback",
		headers: { req_id: id },
		body: {
			msgid: id,
			from: { userid: "alice" },
			chattype: "single",
			msgtype: "text",
			text: { content: text },
		},
	});
	return id;
}

beforeEach(() => {
	sequence = 0;
	FakeWebSocket.instances = [];
	gateway = new WeComGateway({
		botId: "bot",
		secret: "secret",
		createWebSocket(url) {
			const socket = new FakeWebSocket(url);
			socket.onSend = (frame) => {
				if (frame.cmd !== "aibot_subscribe") socket.acknowledge(frame);
			};
			return socket;
		},
	});
});
afterEach(() => gateway.stop());

test("only the owning session can publish a control ID, and temporary registrations cannot publish", async () => {
	const a = add("A");
	add("B");
	add("I", undefined, true);
	const { cardId, card } = await publish(a);
	assert.equal(ws().sent.at(-1).body.template_card.task_id, cardId);
	const before = ws().sent.length;
	await assert.rejects(gateway.push("B", { chatId: "alice", chatType: 1 }, { kind: "control", cardId, card }), {
		outcome: "rejected",
	});
	await assert.rejects(
		gateway.push("I", { chatId: "alice", chatType: 1 }, { kind: "control", cardId, card }),
		/临时识别连接/,
	);
	assert.equal(ws().sent.length, before);
});

test("a refresh asks only its owner, then replaces the same card with the owner's fresh model", async () => {
	const a = add("A");
	const b = add("B");
	const { cardId } = await publish(a);
	const published = ws().sent.at(-1).body.template_card;
	assert.deepEqual(
		published.button_selection,
		{
			question_key: "session",
			title: "会话",
			selected_id: fingerprintOf(a),
			option_list: [
				{ id: fingerprintOf(a), text: "project-A · on-A" },
				{ id: fingerprintOf(b), text: "project-B · on-B" },
			],
		},
		"the gateway lists every session online; the one shown is selected",
	);
	const event = click(cardId, key(a, "refresh"));
	const request = a.requests()[0];
	assert.ok(request.request.action === "click");
	assert.equal(request.request.click.cardId, cardId);
	assert.equal(request.request.click.key, key(a, "refresh"));
	assert.equal(b.requests().length, 0);
	const fresh = sessionControlCard(
		{ ...a.registration.source, modelName: "new-model" },
		{
			status: "running",
			screen: { at: new Date(2026, 0, 1, 9, 0, 0), lines: ["✔ 483 passed", "检查全部通过"] },
			pageUrl: "https://doc.weixin.qq.com/smartpage/a1_doc?p=page",
			prompts: ["继续"],
		},
	);
	gateway.response("B", request.id, { ok: true, card: fresh });
	assert.equal(updates().length, 0);
	gateway.response("A", request.id, { ok: true, note: "已刷新（2.1 秒）", card: fresh });
	const update = updates()[0];
	assert.equal(update.headers.req_id, event);
	assert.equal(update.body.userids, undefined, "a single chat has one copy");
	const card = update.body.template_card;
	assert.equal(card.task_id, cardId);
	assert.deepEqual(card.source, { icon_url: PI_ICON_URL, desc: "执行中", desc_color: 3 });
	assert.equal(card.main_title.title, "📁 project-A");
	assert.equal(card.main_title.desc, "🤖 new-model · provider");
	assert.deepEqual(card.quote_area, {
		type: 1,
		url: "https://doc.weixin.qq.com/smartpage/a1_doc?p=page",
		quote_text: "✔ 483 passed\n检查全部通过",
	});
	// One row: the latest operation, not a link (the quote is).
	assert.equal(card.horizontal_content_list.length, 1);
	assert.equal(card.horizontal_content_list[0].keyname, "窗口记录", "a control card names its own row");
	assert.equal(card.horizontal_content_list[0].type, undefined);
	assert.match(card.horizontal_content_list[0].value, /^\d\d:\d\d 已刷新（2.1 秒）$/);
	assert.equal(card.button_selection.question_key, "session");
	assert.deepEqual(
		card.button_selection.option_list.map((option: { id: string }) => option.id),
		[fingerprintOf(a), fingerprintOf(b)],
	);
	assert.deepEqual(actions(card, a), ["refresh", "send", "model", "abort"]);
	assert.equal(
		ws().sent.filter((frame) => frame.cmd === "aibot_send_msg").length,
		1,
		"refresh creates no new message",
	);
});

test("a control from before a gateway restart is rebuilt by its live owner, without a routing cache", () => {
	const a = add("A");
	const cardId = controlCardId(a.registration.source.sessionId);
	click(cardId, key(a, "refresh"));
	assert.equal((a.requests()[0] as any).request.click.key, key(a, "refresh"));
	gateway.response("A", a.requests()[0].id, {
		ok: true,
		card: sessionControlCard(a.registration.source, idle),
		note: "已刷新",
	});
	assert.equal(updates()[0].body.template_card.task_id, cardId);
	assert.equal(
		ws().sent.some((frame) => frame.cmd === "aibot_send_msg"),
		false,
	);
});

test("control clicks obey the owner's allowlist before forwarding", async () => {
	const a = add("A", ["alice"]);
	const b = add("B", ["bob"]);
	const { cardId } = await publish(a);
	const before = ws().sent.length;
	click(cardId, key(a, "refresh"), "bob");
	click(cardId, key(a, "abort"), "bob");
	// Choosing a session the clicker may use acts on that one alone, never on the one the card shows.
	click(cardId, key(a, "abort"), "bob", { selected: { session: fingerprintOf(b) } });
	assert.equal(a.requests().length, 0);
	assert.equal((b.requests()[0] as any).request.click.key, key(b, "show"));
	click(cardId, key(b, "refresh"), "alice", { selected: { session: fingerprintOf(b) } });
	assert.equal(b.requests().length, 1, "alice may not use B: silence");
	assert.equal(ws().sent.length, before);
});

test("a refresh may take most of WeCom's five seconds; replies after that or after re-registering are ignored", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const a = add("A");
	const { cardId, card } = await publish(a);
	click(cardId, key(a, "refresh"));
	const first = a.requests()[0];
	t.mock.timers.tick(3_900);
	assert.equal(updates().length, 0, "a document write of a few seconds still fits");
	t.mock.timers.tick(100);
	assert.match(updates()[0].body.template_card.horizontal_content_list.at(-1).value, /没有及时响应/);
	gateway.response("A", first.id, { ok: true, card });
	assert.equal(updates().length, 1);
	click(cardId, key(a, "refresh"));
	const second = a.requests()[1];
	add("A");
	gateway.response("A", second.id, { ok: true, card: { ...card, title: "STALE-REPLY" } });
	assert.equal(updates().at(-1).body.template_card.main_title.title, "📁 project-A");
	assert.match(updates().at(-1).body.template_card.horizontal_content_list.at(-1).value, /重新接入/);
});

test("an offline owner turns its cached card red; uncached offline controls receive a short explanation", async () => {
	const a = add("A");
	add("B");
	const b = add("B");
	const { cardId } = await publish(a);
	gateway.unregister("A", a);
	click(cardId, key(a, "refresh"));
	const card = updates()[0].body.template_card;
	assert.deepEqual(card.source, { icon_url: PI_ICON_URL, desc: CONTROL_OFFLINE_LABEL, desc_color: 2 });
	assert.equal(CONTROL_OFFLINE_LABEL, "会话已离线", "the status alone; the icon says it is pi");
	assert.match(card.horizontal_content_list.at(-1).value, /已离线，可在下拉框选其他会话$/);
	assert.deepEqual(
		card.button_selection.option_list.map((option: { id: string }) => option.id),
		[fingerprintOf(a), fingerprintOf(b)],
		"the offline session stays shown and selected; the dropdown offers the one online",
	);
	assert.equal(gateway.size, 1);
	click(controlCardId("offline-session"), controlKey("refresh", "offline-session"));
	assert.match(ws().sent.at(-1).body.markdown.content, /所属会话已离线/);
	// A card from before version 10 names no session in its keys: its ID's owner, here gone, is all there is.
	click(controlCardId("offline-session"), "refresh");
	assert.match(ws().sent.at(-1).body.markdown.content, /所属会话已离线/);
});

test("a key from before version 10 refreshes its card: an old 中止 or 设为目标 never acts, and nothing is remembered", async () => {
	const a = add("A");
	const { cardId } = await publish(a);
	for (const old of ["select", "abort", "send"]) click(cardId, old);
	assert.deepEqual(
		a.requests().map((request) => request.request.action === "click" && request.request.click.key),
		[key(a, "refresh"), key(a, "refresh"), key(a, "refresh")],
		"the session that published the card redraws it in today's layout",
	);
	// No click remembers a target: a message without a session is asked about, not delivered.
	message("without a chosen target");
	assert.equal(a.tasks().length, 0);
});

test("the dropdown's choice travels with the click to the owning pi", async () => {
	const a = add("A");
	const { cardId } = await publish(a);
	click(cardId, key(a, "send-confirm"), "alice", { selected: { prompt: "continue" } });
	const request = a.requests()[0];
	assert.ok(request.request.action === "click");
	assert.deepEqual(request.request.click.selections, { prompt: "continue" });
	click(cardId, key(a, "refresh"));
	const plain = a.requests()[1];
	assert.ok(plain.request.action === "click");
	assert.equal(plain.request.click.selections, undefined);
});

test("in a group only the members pi names see an update, and that copy is never remembered as everyone's", async () => {
	const a = add("A");
	add("B");
	const { cardId } = await publish(a, { chatId: "team", chatType: 2 });
	click(cardId, key(a, "abort"), "alice", { group: "team" });
	const confirm = sessionControlCard(a.registration.source, { status: "confirming" });
	gateway.response("A", a.requests()[0].id, { ok: true, note: "60 秒内确认", card: confirm, userids: ["alice"] });
	const scoped = updates()[0];
	assert.deepEqual(scoped.body.userids, ["alice"]);
	assert.deepEqual(actions(scoped.body.template_card, a), ["abort-confirm", "abort-cancel"]);
	// Others still have the published card: an offline redraw shows that one, not alice's confirmation.
	gateway.unregister("A", a);
	click(cardId, key(a, "refresh"), "bob", { group: "team" });
	const redraw = updates()[1];
	assert.equal(redraw.body.userids, undefined);
	assert.deepEqual(actions(redraw.body.template_card, a), ["refresh", "send", "model", "abort"]);
});

test("userids is a group-only field: a single chat's update replaces its one copy", async () => {
	const a = add("A");
	const { cardId } = await publish(a);
	click(cardId, key(a, "abort"));
	const confirm = sessionControlCard(a.registration.source, { status: "confirming" });
	gateway.response("A", a.requests()[0].id, { ok: true, card: confirm, userids: ["alice"] });
	assert.equal(updates()[0].body.userids, undefined);
});

test("a result arrives as its session's control card; another session's card is never sent in its name", async () => {
	const a = add("A");
	const done = sessionControlCard(a.registration.source, { status: "done", prompts: ["继续"] });
	const cardId = controlCardId("session-A");
	await gateway.notify(
		"A",
		{ chatId: "alice", chatType: 1 },
		{
			...notificationPayload("result", a.registration.source, "THE REPLY", { title: "✅ 本轮完成" }),
			control: { cardId, card: done },
		},
	);
	const sent = ws().sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(sent.length, 1);
	const card = sent[0].body.template_card;
	assert.equal(card.task_id, cardId, "the control card, not a result card");
	assert.equal(card.source.desc, "已完成");
	assert.deepEqual(actions(card, a), ["refresh", "send", "model", "abort"]);
	assert.equal(card.button_selection.selected_id, fingerprintOf(a), "the dropdown starts at the session that sent it");
	// Its buttons are the control card's: a click asks the owning pi.
	click(cardId, key(a, "refresh"));
	assert.equal(a.requests().length, 1);
	assert.equal((a.requests()[0] as any).request.click.cardId, cardId);
	// A card ID of another session is refused, not sent in another form: the error names why.
	const before = ws().sent.length;
	await assert.rejects(
		gateway.notify(
			"A",
			{ chatId: "alice", chatType: 1 },
			{
				...notificationPayload("result", a.registration.source, "SECOND", { title: "✅ 本轮完成" }),
				control: { cardId: controlCardId("session-B"), card: done },
			},
		),
		(error: unknown) => deliveryFailure(error) === "rejected" && /控制卡不属于发送 pi 的 session/.test(String(error)),
	);
	assert.equal(ws().sent.length, before, "nothing is sent");
});

test("a refused result control card is sent as Markdown with the reply, so the result is never lost", async () => {
	const a = add("A");
	const socket = ws();
	socket.onSend = (frame) => {
		if (frame.cmd === "aibot_send_msg" && frame.body.msgtype === "template_card")
			socket.receive({ headers: frame.headers, errcode: 40008, errmsg: "refused" });
		else if (frame.cmd !== "aibot_subscribe") socket.acknowledge(frame);
	};
	await gateway.notify(
		"A",
		{ chatId: "alice", chatType: 1 },
		{
			...notificationPayload("result", a.registration.source, "THE WHOLE REPLY", { title: "✅ 本轮完成" }),
			control: {
				cardId: controlCardId("session-A"),
				card: sessionControlCard(a.registration.source, { status: "done" }),
			},
		},
	);
	const markdown = socket.sent.find((frame) => frame.body?.msgtype === "markdown");
	assert.match(markdown.body.markdown.content, /✅ 本轮完成[\s\S]*THE WHOLE REPLY/);
});

test("choosing another session redraws the clicker's copy for it, and no button acts on either session", async () => {
	const a = add("A");
	const b = add("B");
	const { cardId } = await publish(a);
	const event = click(cardId, key(a, "abort"), "alice", { selected: { session: fingerprintOf(b) } });
	assert.equal(a.requests().length, 0, "nothing reaches the session the card showed");
	const request = b.requests()[0];
	assert.ok(request.request.action === "click");
	assert.equal(request.request.click.key, key(b, "show"), "B is asked to show itself, not to abort");
	assert.equal(request.request.click.cardId, cardId, "on A's card");
	const shown = sessionControlCard(b.registration.source, { status: "running" });
	gateway.response("B", request.id, { ok: true, note: "已切换到本会话；已刷新", card: shown });
	const update = updates()[0];
	assert.equal(update.headers.req_id, event);
	const card = update.body.template_card;
	assert.equal(card.task_id, cardId);
	assert.equal(card.main_title.title, "📁 project-B");
	assert.deepEqual(actions(card, b), ["refresh", "send", "model", "abort"]);
	assert.equal(card.button_selection.selected_id, fingerprintOf(b));
	assert.deepEqual(
		card.button_selection.option_list.map((option: { id: string }) => option.id),
		[fingerprintOf(a), fingerprintOf(b)],
	);
	// The same dropdown, unchanged: the button acts on the session shown.
	click(cardId, key(b, "refresh"), "alice", { selected: { session: fingerprintOf(b) } });
	assert.equal((b.requests()[1] as any).request.click.key, key(b, "refresh"));
	// A copy still showing A, its dropdown also at A: A acts.
	click(cardId, key(a, "refresh"), "alice", { selected: { session: fingerprintOf(a) } });
	assert.equal((a.requests()[0] as any).request.click.key, key(a, "refresh"));
	// No answer in time: the copy its clicker saw, A's, says so; B's model is never put in its place.
	click(cardId, key(a, "refresh"), "alice", { selected: { session: fingerprintOf(b) } });
	gateway.unregister("B", b);
	const last = updates().at(-1).body.template_card;
	assert.equal(last.main_title.title, "📁 project-A");
});

test("choosing a session that has gone offline leaves the card on its session and says to choose another", async () => {
	const a = add("A");
	const b = add("B");
	const { cardId } = await publish(a);
	gateway.unregister("B", b);
	click(cardId, key(a, "refresh"), "alice", { selected: { session: fingerprintOf(b) } });
	assert.equal(a.requests().length, 0);
	const card = updates()[0].body.template_card;
	assert.equal(card.main_title.title, "📁 project-A");
	assert.equal(card.source.desc, "空闲", "A is still online");
	assert.match(card.horizontal_content_list.at(-1).value, /选的会话已离线，请选另一个$/);
	assert.deepEqual(
		card.button_selection.option_list.map((option: { id: string }) => option.id),
		[fingerprintOf(a)],
	);
});

test("the dropdown lists only the sessions its viewer may use", async () => {
	const a = add("A");
	add("B", ["bob"]);
	add("I", undefined, true);
	await publish(a);
	const card = ws().sent.at(-1).body.template_card;
	assert.deepEqual(
		card.button_selection.option_list.map((option: { text: string }) => option.text),
		["project-A · on-A"],
		"alice may not use B; an identification-only pi is no session",
	);
});

test("once a pi's card shows its document's colour logo, every card the gateway draws shows it too", async () => {
	const a = add("A");
	const cards = () =>
		ws()
			.sent.filter((frame) => frame.body?.template_card)
			.map((frame) => frame.body.template_card);
	let answered = 0;
	const message = async (text: string) => {
		const reqId = `message-${++sequence}`;
		ws().receive({
			cmd: "aibot_msg_callback",
			headers: { req_id: reqId },
			body: {
				msgid: reqId,
				chattype: "single",
				from: { userid: "alice" },
				msgtype: "text",
				text: { content: text },
			},
		});
		// The question card and the list wait for each pi to say whether it is busy.
		for (const frame of a.requests().slice(answered))
			if (frame.type === "request" && frame.request.action === "state")
				gateway.response("A", frame.id, { ok: true, busy: false });
		answered = a.requests().length;
		await new Promise((resolve) => setImmediate(resolve));
	};
	// Before any pi sent one: the public copy, also on the gateway's own cards.
	await message("修一下构建");
	assert.equal(cards().at(-1).source.icon_url, PI_ICON_URL, "the question card");
	const colour = "https://wdcdn.qpic.cn/colour-logo";
	const cardId = controlCardId(a.registration.source.sessionId);
	await gateway.push(
		"A",
		{ chatId: "alice", chatType: 1 },
		{
			kind: "control",
			cardId,
			card: sessionControlCard(a.registration.source, { ...idle, icon: colour }),
		},
	);
	assert.equal(cards().at(-1).source.icon_url, colour, "the control card itself");
	await message("再来一条");
	assert.equal(cards().at(-1).source.icon_url, colour, "the question card");
	await message("/wecom-aibot sessions");
	assert.equal(cards().at(-1).button_selection.question_key, "pick");
	assert.equal(cards().at(-1).source.icon_url, colour, "the session list");
	// A card from an older version: the retired card.
	click("p@0123456789ab", "card@session-A");
	assert.equal(updates().at(-1).body.template_card.source.icon_url, colour, "the retired card");
});
