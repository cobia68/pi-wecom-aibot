import assert from "node:assert/strict";
import { test } from "node:test";
import { cardSelections, parseInbound, quotesMedia, senderOf } from "../../src/shared/wecom-protocol.ts";

const base = {
	msgid: "m1",
	from: { userid: "alice" },
	chattype: "single",
	msgtype: "text",
	text: { content: "hello" },
};

test("a single-chat text message replies to its sender", () => {
	assert.deepEqual(parseInbound(base), {
		msgId: "m1",
		msgtype: "text",
		chat: { chatId: "alice", chatType: 1 },
		userid: "alice",
		text: "hello",
		attachments: [],
	});
});

test("a group message replies to the group and drops only the leading @mention", () => {
	const message = parseInbound({
		...base,
		chattype: "group",
		chatid: " group-1 ",
		text: { content: "@Robot 检查 @someone 的代码" },
	});
	assert.deepEqual(message?.chat, { chatId: "group-1", chatType: 2 });
	assert.equal(message?.text, "检查 @someone 的代码");
	// In a single chat a leading @ is the user's own text.
	assert.equal(parseInbound({ ...base, text: { content: "@here 开会" } })?.text, "@here 开会");
});

test("mixed messages keep their text in order with image placeholders, and images become attachments", () => {
	const message = parseInbound({
		...base,
		msgtype: "mixed",
		mixed: {
			msg_item: [
				{ msgtype: "text", text: { content: "看这张" } },
				{ msgtype: "image", image: { url: "https://example.invalid/a", aeskey: "key-a" } },
				{ msgtype: "text", text: { content: "和这张" } },
				{ msgtype: "image", image: { url: "https://example.invalid/b" } },
			],
		},
	});
	assert.equal(message?.text, "看这张\n[图片]\n和这张\n[图片]");
	assert.deepEqual(message?.attachments, [
		{ kind: "image", url: "https://example.invalid/a", aeskey: "key-a" },
		{ kind: "image", url: "https://example.invalid/b" },
	]);
});

test("media messages carry their short-lived URL and key; voice carries its transcript", () => {
	for (const kind of ["image", "file", "video"] as const) {
		const message = parseInbound({
			...base,
			msgtype: kind,
			[kind]: { url: `https://example.invalid/${kind}`, aeskey: "key" },
		});
		assert.deepEqual(message?.attachments, [{ kind, url: `https://example.invalid/${kind}`, aeskey: "key" }]);
		assert.match(message!.text, /^\[(?:图片|文件|视频)\]$/);
	}
	assert.equal(parseInbound({ ...base, msgtype: "voice", voice: { content: "语音转文字" } })?.text, "语音转文字");
});

test("a quote keeps its plain text, including a quoted Markdown notification", () => {
	const message = parseInbound({
		...base,
		quote: { msgtype: "markdown", markdown: { content: "project · 会话通知  \nsession: s1" } },
	});
	assert.equal(message?.quoteText, "project · 会话通知  \nsession: s1");
	assert.equal(
		parseInbound({ ...base, quote: { msgtype: "text", text: { content: 42 } } })?.quoteText,
		undefined,
		"a malformed quote is dropped",
	);
});

test("a quote that is only a picture, file or video leaves no text behind for pi to read", () => {
	for (const kind of ["image", "file", "video", "miniprogram"]) {
		const message = parseInbound({ ...base, quote: { msgtype: kind, [kind]: { url: "https://example.invalid/q" } } });
		assert.equal(message?.quoteText, undefined, `a ${kind} quote is not words`);
	}
});

test("a mixed quote keeps the words it has and drops only its placeholders", () => {
	const mix = (items: unknown[]) => ({ ...base, quote: { msgtype: "mixed", mixed: { msg_item: items } } });
	const both = parseInbound(
		mix([
			{ msgtype: "text", text: { content: "看图" } },
			{ msgtype: "image", image: { url: "https://example.invalid/q" } },
		]),
	);
	assert.equal(both?.quoteText, "看图");
	assert.equal(
		parseInbound(mix([{ msgtype: "image", image: { url: "https://example.invalid/q" } }]))?.quoteText,
		undefined,
		"placeholders alone say nothing",
	);
	assert.equal(
		parseInbound(mix([{ msgtype: "text", text: { content: "  " } }]))?.quoteText,
		undefined,
		"blank text is not words either",
	);
});

test("malformed callbacks are rejected instead of guessed", () => {
	assert.equal(senderOf({ from: {} }), undefined);
	assert.equal(parseInbound({ ...base, from: undefined }), undefined, "no sender");
	assert.equal(parseInbound({ ...base, chattype: "group" }), undefined, "a group message without chatid");
	assert.equal(parseInbound({ ...base, text: { content: 123 } }), undefined, "non-string text");
	assert.equal(
		parseInbound({ ...base, msgtype: "mixed", mixed: { msg_item: [{ msgtype: "text", text: { content: {} } }] } }),
		undefined,
	);
	assert.equal(
		parseInbound({ ...base, msgtype: "location" })?.text,
		"[location]",
		"an unknown type is named, not dropped",
	);
});

test("a quote of an image, a file or a mix is media; text, Markdown and voice are words", () => {
	for (const quote of [
		{ msgtype: "image", image: { url: "https://example.invalid/q", aeskey: "KEY" } },
		{ msgtype: "image" },
		{ msgtype: "file", file: { url: "f" } },
		{ msgtype: "mixed", mixed: { msg_item: [{ msgtype: "text", text: { content: "hi" } }] } },
	])
		assert.equal(quotesMedia({ ...base, quote }), true, quote.msgtype);
	for (const msgtype of ["text", "markdown", "voice"])
		assert.equal(quotesMedia({ ...base, quote: { msgtype, [msgtype]: { content: "x" } } }), false, msgtype);
	assert.equal(quotesMedia(base), false);
});

test("a click's dropdowns become question → first option, bounded and without prototype keys", () => {
	const event = (items: unknown) => ({ selected_items: { selected_item: items } });
	assert.deepEqual(
		cardSelections(
			event([
				{ question_key: "prompt", option_ids: { option_id: ["continue", "ignored"] } },
				{ question_key: "other", option_ids: { option_id: ["b"] } },
			]),
		),
		{ prompt: "continue", other: "b" },
	);
	assert.equal(cardSelections({}), undefined);
	assert.equal(cardSelections(event([])), undefined);
	assert.equal(cardSelections(event([{ question_key: "", option_ids: { option_id: ["x"] } }])), undefined);
	assert.equal(
		cardSelections(event([{ question_key: "p", option_ids: { option_id: ["x".repeat(129)] } }])),
		undefined,
	);
	const polluted = cardSelections(event([{ question_key: "__proto__", option_ids: { option_id: ["x"] } }]));
	assert.equal(Object.getPrototypeOf(polluted), Object.prototype);
	assert.equal(({} as Record<string, unknown>).x, undefined);
});
