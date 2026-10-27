import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ASK_CHOICES,
	askAction,
	askCard,
	askCardId,
	isSettled,
	SETTLED_ROW,
	settledCard,
} from "../../src/gateway/ask-card.ts";
import { renderCard } from "../../src/shared/card.ts";
import { sessionFingerprint } from "../../src/shared/control-card.ts";
import type { InboundMessage } from "../../src/shared/wecom-protocol.ts";

const message = (text: string, chatType: 1 | 2 = 1, attachments = 0): InboundMessage => ({
	msgId: "m",
	msgtype: "text",
	chat: { chatId: chatType === 2 ? "team" : "alice", chatType },
	userid: "alice",
	text,
	attachments: Array.from({ length: attachments }, () => ({
		kind: "image" as const,
		url: "https://example.invalid/a",
	})),
});
const sessions = (count: number) =>
	Array.from({ length: count }, (_, index) => ({
		source: {
			sessionId: `session-${index}`,
			directoryName: `project-${index}`,
			provider: "p",
			modelName: `model-${index}`,
		},
		busy: index === 0,
	}));

test("a message without a session asks which pi takes it: a dropdown of sessions, 确认发送 and 取消发送", () => {
	const card = askCard(message("修一下构建\n再跑测试\n最后提交"), sessions(2));
	assert.equal(card.title, "这条消息发给哪个会话？");
	assert.equal(card.quote, "修一下构建\n再跑测试\n…", "two lines of the message");
	assert.match(card.subtitle!, /选好会话后点「确认发送」；只对这一条消息有效，下一条再问/);
	assert.doesNotMatch(card.subtitle!, /只有发送者/, "a single chat has one sender");
	assert.deepEqual(card.selection, {
		key: "target",
		title: "会话",
		options: [
			{ id: sessionFingerprint("session-0"), text: "project-0 · on-0 · 执行中" },
			{ id: sessionFingerprint("session-1"), text: "project-1 · on-1 · 空闲" },
		],
	});
	assert.deepEqual(
		card.actions.map((action) => [action.key, action.text, action.style]),
		[
			["send", "确认发送", 1],
			["cancel", "取消发送", 2],
		],
		"one row of two, as every second step on a control card",
	);
	// The longer text goes in the rows: each session's folder, the end of its ID, its model.
	assert.deepEqual(card.facts, [
		{ key: "执行中", value: "project-0 · on-0 · model-0" },
		{ key: "空闲", value: "project-1 · on-1 · model-1" },
	]);
	assert.ok(renderCard(card, askCardId()), "a card WeCom takes");
	// A group card says who decides; beyond ten, how to reach the rest; a picture shows as one.
	const group = askCard(message("x", 2, 1), sessions(ASK_CHOICES + 2), "引用的是卡片");
	assert.match(
		group.subtitle!,
		/^引用的是卡片；.*只有发送者能选；正文列前 5 个，下拉框列前 10 个；另有 2 个会话未列出，可用 --session-id 指定$/,
	);
	assert.equal(group.selection!.options.length, 10, "WeCom's dropdown takes ten");
	assert.equal(group.facts.length, 5, "six rows at most, the sixth a click's note");
	assert.match(group.quote!, /［1 个附件］/);
});

test("only an ask card's ID takes its keys, and a decided card offers nothing that sends", () => {
	const taskId = askCardId();
	assert.match(taskId, /^q@[0-9a-f]{12}$/);
	assert.deepEqual(askAction(taskId, "send"), { kind: "send" });
	assert.deepEqual(askAction(taskId, "cancel"), { kind: "cancel" });
	for (const key of ["send@session-1", "select@session-1", "refresh"]) assert.equal(askAction(taskId, key), undefined);
	assert.equal(askAction("p@0123456789ab", "send"), undefined);
	const question = askCard(message("修一下构建"), sessions(2));
	assert.equal(isSettled(question), false);
	const [, chosen] = sessions(2);
	// Sent: the head names the session as its control card does; the quote stays the message.
	const sent = settledCard(question, { kind: "sent", source: chosen.source });
	assert.deepEqual(
		[sent.label, sent.tone, sent.title, sent.desc, sent.subtitle, sent.quote],
		["已发送", "success", "📁 project-1", "🤖 model-1 · p", "🆔 session-id: session-1", "修一下构建"],
	);
	// Unsent: no session to name, and nothing that looks like a session's card.
	const closed = settledCard(question, { kind: "closed" });
	assert.deepEqual(
		[closed.label, closed.tone, closed.title, closed.desc, closed.subtitle, closed.quote],
		["未发送", "neutral", "这条消息没有发出", undefined, "需要的话重新发送", "修一下构建"],
	);
	for (const settled of [sent, closed]) {
		assert.ok(isSettled(settled));
		assert.deepEqual(settled.actions, [{ key: "done", text: "已处理", style: 4 }]);
		assert.deepEqual(settled.facts, []);
		assert.equal(settled.selection, undefined);
		assert.equal(settled.noteKey, SETTLED_ROW);
	}
});
