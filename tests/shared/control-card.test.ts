import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionControlCard } from "../../src/extension/control-view.ts";
import { renderCard, validCardModel, withNote } from "../../src/shared/card.ts";
import { controlCardFor, controlCardId, isControlCardId } from "../../src/shared/control-card.ts";
import { parseClientFrame, parseServerFrame } from "../../src/shared/gateway-protocol.ts";

const sessionId = "session-A";
const cardId = controlCardId(sessionId);
const chat = { chatId: "user", chatType: 1 };
const card = sessionControlCard(
	{ sessionId, directoryName: "project", provider: "provider", modelName: "model" },
	{ status: "idle", pageUrl: "https://doc.weixin.qq.com/smartpage/a1_doc?p=page" },
);

test("a button shows four characters at most, and a note row keeps the short notes whole", () => {
	const drawn: any = renderCard(
		{
			...card,
			actions: [
				{ key: "a", text: "打开控制卡" },
				{ key: "b", text: "打开会话" },
			],
		},
		cardId,
	);
	assert.deepEqual(
		drawn.button_list.map((button: { text: string }) => button.text),
		["打开控…", "打开会话"],
	);
	for (const note of ["60 秒内选；「确认中止」只停这一轮", "没有在线会话了；在 pi 里 connect 后再列"]) {
		const row: any = renderCard(withNote(card, note), cardId);
		assert.equal(row.horizontal_content_list.at(-1).value.endsWith(note), true, note);
	}
});

test("control IDs have a bounded safe wire representation and name their session even for custom IDs", () => {
	for (const id of ["session-A", "会话/特殊@标识", "x".repeat(256)]) {
		const first = controlCardId(id);
		assert.match(first, /^[A-Za-z0-9_@-]+$/);
		assert.ok(Buffer.byteLength(first) <= 128);
		assert.ok(isControlCardId(first));
		assert.ok(controlCardFor(first, id));
		assert.equal(controlCardFor(first, "other"), false);
		assert.notEqual(first, controlCardId(id));
	}
	for (const value of [null, [], "s@bad", "c@session-A@0123456789ab", `junk${cardId}`])
		assert.equal(isControlCardId(value), false);
});

test("bounded semantic cards cross IPC for both initial delivery and click updates", () => {
	assert.ok(validCardModel(card));
	const push = { type: "push", id: "send", chat, item: { kind: "control", cardId, card } };
	assert.deepEqual(parseClientFrame(push), { ok: true, frame: push });
	const answer = { type: "response", id: "click", response: { ok: true, note: "状态已刷新", card } };
	assert.deepEqual(parseClientFrame(answer), { ok: true, frame: answer });
	const request = {
		type: "request",
		id: "click",
		request: {
			action: "click",
			target: { instanceId: "A", registrationId: "reg-A", sessionId },
			click: { cardId, key: "refresh", userid: "user", chat },
		},
	};
	assert.deepEqual(parseServerFrame(request), { ok: true, frame: request });
	const sending = {
		...request,
		request: {
			...request.request,
			click: { ...request.request.click, key: "send", selections: { prompt: "continue" } },
		},
	};
	assert.deepEqual(parseServerFrame(sending), { ok: true, frame: sending });
	for (const selections of [[], { prompt: 1 }, { prompt: "x".repeat(129) }, { "": "a" }])
		assert.equal(
			parseServerFrame({
				...request,
				request: { ...request.request, click: { ...request.request.click, selections } },
			}).ok,
			false,
		);
	const scoped = { type: "response", id: "click", response: { ok: true, card, userids: ["alice"] } };
	assert.deepEqual(parseClientFrame(scoped), { ok: true, frame: scoped });
	for (const userids of [[], [""], ["a", 1], "alice"])
		assert.equal(parseClientFrame({ ...scoped, response: { ...scoped.response, userids } }).ok, false);
	assert.equal(
		parseServerFrame({
			...request,
			request: { ...request.request, click: { ...request.request.click, cardId: "not-a-card" } },
		}).ok,
		false,
	);
});

test("malformed or oversized card models are rejected before the gateway renders them", () => {
	for (const invalid of [
		null,
		[],
		{ ...card, tone: [] },
		{ ...card, label: 1 },
		{ ...card, quote: "x".repeat(16_385) },
		{ ...card, facts: Array(7).fill({ key: "x", value: "y" }) },
		{ ...card, facts: [{ key: "x", value: false }] },
		{ ...card, actions: [{ key: "x", text: "x", style: 5 }] },
		{
			...card,
			actions: [
				{ key: "x", text: "x" },
				{ key: "x", text: "y" },
			],
		},
		{ ...card, actions: [{ key: "x".repeat(1025), text: "x" }] },
		{ ...card, quoteUrl: "http://doc.weixin.qq.com/insecure" },
		{ ...card, icon: "http://pi.dev/logo-auto.svg" },
		{ ...card, quoteLimit: 0 },
		// The renderer cuts the subtitle as text: anything else would throw there, on a click's redraw.
		{ ...card, subtitle: 5 },
		{ ...card, subtitle: {} },
		{ ...card, noteKey: "" },
		{ ...card, noteKey: "x".repeat(17) },
		{ ...card, quoteLimit: 1.5 },
		{ ...card, quoteLimit: 100_000 },
		{ ...card, quoteUrl: "https://doc.weixin.qq.com/a b" },
		{ ...card, selection: { key: "prompt", title: "提示词", options: [] } },
		{ ...card, selection: { key: "prompt", title: "提示词", options: Array(11).fill({ id: "a", text: "a" }) } },
		{
			...card,
			selection: {
				key: "prompt",
				title: "提示词",
				options: [
					{ id: "a", text: "A" },
					{ id: "a", text: "B" },
				],
			},
		},
		{ ...card, selection: { key: "prompt", title: "提示词", options: [{ id: "a", text: "A" }], selected: "b" } },
		{ ...card, selection: { key: "prompt", title: "提示词", options: [{ id: "x".repeat(129), text: "A" }] } },
	]) {
		assert.equal(validCardModel(invalid), false);
		assert.equal(
			parseClientFrame({ type: "push", id: "send", chat, item: { kind: "control", cardId, card: invalid } }).ok,
			false,
		);
		assert.equal(
			parseClientFrame({ type: "response", id: "click", response: { ok: true, card: invalid } }).ok,
			false,
		);
	}
});
