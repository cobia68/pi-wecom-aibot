import assert from "node:assert/strict";
import { test } from "node:test";
import { type CardModel, clamp, NOTE_KEY, plainText, renderCard, withNote } from "../../src/shared/card.ts";

const model: CardModel = {
	label: "pi-wecom-aibot",
	tone: "success",
	title: "✅ 完成：重构导出模块",
	desc: "provider · model",
	quote: "已拆分 exporter.ts",
	facts: [{ key: "会话", value: "…10888a29" }],
	actions: [{ key: "refresh", text: "刷新卡片", style: 2 }],
};

test("every card is a button_interaction card with the fields WeCom requires for it", () => {
	const card = renderCard(model, "c@s1@0123456789ab");
	assert.equal(card.card_type, "button_interaction");
	assert.equal(card.task_id, "c@s1@0123456789ab");
	assert.deepEqual(card.source, { desc: "pi-wecom-aibot", desc_color: 3 });
	assert.deepEqual(card.main_title, { title: "✅ 完成：重构导出模块", desc: "provider · model" });
	assert.deepEqual(card.quote_area, { quote_text: "已拆分 exporter.ts" });
	assert.deepEqual(card.horizontal_content_list, [{ keyname: "会话", value: "…10888a29" }]);
	assert.deepEqual(card.button_list, [{ text: "刷新卡片", key: "refresh", style: 2 }]);
	assert.equal("card_action" in card, false, "button cards need no jump URL");
	// The source line takes an https icon only, and leaves it out otherwise.
	assert.deepEqual(renderCard({ ...model, icon: "https://pi.dev/logo-auto.svg" }, "t").source, {
		icon_url: "https://pi.dev/logo-auto.svg",
		desc: "pi-wecom-aibot",
		desc_color: 3,
	});
	assert.equal("icon_url" in (renderCard({ ...model, icon: "http://pi.dev/x.svg" }, "t").source as object), false);
	// button_list is mandatory: a card without actions still has one inert button.
	assert.equal((renderCard({ ...model, actions: [] }, "t").button_list as unknown[]).length, 1);
});

test("text is clamped by code point to WeCom's limits, never cut through an emoji", () => {
	const card = renderCard(
		{
			...model,
			title: "🙂".repeat(100),
			facts: Array.from({ length: 9 }, (_, index) => ({ key: `第${index}项标题很长`, value: "x".repeat(99) })),
			actions: Array.from({ length: 9 }, (_, index) => ({ key: `k${index}`, text: "很长很长的按钮文字超出" })),
		},
		"t",
	);
	const title = (card.main_title as { title: string }).title;
	assert.equal([...title].length, 36);
	assert.ok(title.endsWith("…"));
	assert.equal(title.includes("\ufffd"), false);
	assert.equal((card.horizontal_content_list as unknown[]).length, 6);
	assert.equal((card.button_list as unknown[]).length, 6);
	assert.equal(clamp("a\u0000b\u2028c", 10), "a b c");
});

test("a note records the latest click as one fact that replaces itself", () => {
	const at = new Date(2026, 0, 1, 18, 6);
	const once = withNote(model, "已刷新", at);
	const twice = withNote(once, "已发送全文", at);
	assert.deepEqual(
		twice.facts.filter((fact) => fact.key === NOTE_KEY),
		[{ key: NOTE_KEY, value: "18:06 已发送全文" }],
	);
	assert.equal(model.facts.length, 1, "the original model is unchanged");
	// A card may name its own row; the note still replaces itself there.
	const own = withNote(withNote({ ...model, noteKey: "窗口记录" }, "已刷新", at), "已取消中止", at);
	assert.deepEqual(
		own.facts.map((fact) => fact.key),
		["会话", "窗口记录"],
	);
	assert.equal(own.facts.at(-1)!.value, "18:06 已取消中止");
});

test("card text is plain: Markdown markers go, code becomes a placeholder, the words stay", () => {
	const markdown = [
		"## 结论",
		"",
		"**全部通过**，详见 [报告](https://example.com)。",
		"",
		"- 第一项 `a.ts`",
		"* 第二项",
		"",
		"```ts",
		"const secret = 1;",
		"```",
		"",
		"> 引用",
		"![图](x.png)",
		"<think>内部推理</think>",
	].join("\n");
	assert.equal(
		plainText(markdown),
		"结论\n\n全部通过，详见 报告。\n\n· 第一项 a.ts\n· 第二项\n\n[代码]\n\n引用\n[图片]",
	);
});
