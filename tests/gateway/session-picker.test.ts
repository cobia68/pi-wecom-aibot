import assert from "node:assert/strict";
import { test } from "node:test";
import { PICKER_PAGE, PICKER_QUESTION, pageOf, pickerAction, sessionPicker } from "../../src/gateway/session-picker.ts";
import { renderCard } from "../../src/shared/card.ts";
import { CONTROL_KEYS, controlCardFor, isControlCardId, sessionFingerprint } from "../../src/shared/control-card.ts";

function sessions(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		source: {
			sessionId: `01234567-89ab-4cde-8012-${String(index).padStart(12, "0")}`,
			directoryName: `project-${index}`,
			provider: "provider",
			modelName: `model-${index}`,
		},
		busy: index === 0 ? true : index === 1 ? false : undefined,
	}));
}
const fingerprintOf = (index: number) => sessionFingerprint(sessions(index + 1)[index].source.sessionId);

test("the list is its sessions, one row each, with no session singled out", () => {
	const drawn = sessionPicker(sessions(3), 0, new Date(2026, 0, 1, 12, 34, 56));
	assert.ok(drawn);
	const card: any = renderCard(drawn.card, drawn.cardId);
	assert.equal(card.source.desc, "在线会话");
	assert.equal(card.main_title.title, "3 个在线会话");
	assert.equal(card.main_title.desc, "12:34 的状态");
	assert.equal(card.quote_area, undefined, "no session's head, no quote");
	assert.deepEqual(
		card.horizontal_content_list.map((row: { keyname: string; value: string }) => [row.keyname, row.value]),
		[
			["执行中", "project-0 · 0000 · model-0"],
			["空闲", "project-1 · 0001 · model-1"],
			["状态未知", "project-2 · 0002 · model-2"],
		],
	);
	assert.match(card.sub_title_text, /^下拉框选会话，再点按钮，卡片换成它的控制卡；/);
	assert.doesNotMatch(JSON.stringify(card), /session-id|01234567/, "no session ID on the list");
	// The dropdown names the same sessions in the same order, from the first row, as WeCom draws it anyway.
	assert.equal(card.button_selection.question_key, PICKER_QUESTION);
	assert.equal(card.button_selection.title, "会话");
	assert.deepEqual(
		card.button_selection.option_list.map((option: { text: string }) => option.text),
		["project-0 · 0000 · 执行中", "project-1 · 0001 · 空闲", "project-2 · 0002 · 状态未知"],
	);
	assert.equal(card.button_selection.selected_id, fingerprintOf(0));
	assert.deepEqual(
		card.button_list.map((button: { key: string; text: string; style: number }) => [
			button.key,
			button.text,
			button.style,
		]),
		[
			[`pick@show@${fingerprintOf(0)}`, "查看会话", 1],
			[`pick@send@${fingerprintOf(0)}`, "发提示词", 2],
			[`pick@model@${fingerprintOf(0)}`, "切换模型", 2],
			[`pick@abort@${fingerprintOf(0)}`, "中止任务", 3],
		],
	);
	assert.ok(isControlCardId(drawn.cardId), "it becomes a control card once a button is pressed");
	assert.ok(controlCardFor(drawn.cardId, sessions(1)[0].source.sessionId));
});

test("more than five sessions are paged five at a time; the pages are turned by the second row of buttons", () => {
	const all = sessions(12);
	const first = sessionPicker(all, 0)!;
	assert.equal(first.card.title, "12 个在线会话");
	assert.match(first.card.desc!, /^第 1\/3 页 · /);
	assert.equal(first.card.selection!.title, "会话 1/3");
	assert.equal(first.card.facts.length, PICKER_PAGE, "the sixth row is kept for a click's note");
	assert.equal(first.card.selection!.options.length, PICKER_PAGE);
	assert.deepEqual(
		first.card.actions.map((action) => [action.key, action.text]),
		[
			[`pick@show@${fingerprintOf(0)}`, "查看会话"],
			[`pick@send@${fingerprintOf(0)}`, "发提示词"],
			["pick@prev@2", "上一页"],
			["pick@next@1", "下一页"],
		],
	);
	const last = sessionPicker(all, 2)!;
	assert.deepEqual(
		last.card.facts.map((fact) => fact.value),
		["project-10 · 0010 · model-10", "project-11 · 0011 · model-11"],
	);
	assert.equal(last.card.selection!.selected, fingerprintOf(10), "the page's first row");
	assert.deepEqual(
		last.card.actions.slice(2).map((action) => action.key),
		["pick@prev@1", "pick@next@0"],
		"wrapping round at either end",
	);
	assert.equal(sessionPicker(all, 9)!.card.selection!.title, "会话 3/3", "clamped");
	// Two pages: both buttons lead to the other page, under keys of their own.
	const two = sessionPicker(sessions(6), 0)!;
	assert.deepEqual(
		two.card.actions.slice(2).map((action) => action.key),
		["pick@prev@1", "pick@next@1"],
	);
	assert.equal(pageOf(all, fingerprintOf(11)), 2);
	assert.equal(pageOf(all, "gone"), 0);
});

test("sessions sharing a folder differ by the end of their ID; a long folder is cut before the ID", () => {
	const all = sessions(3).map((item, index) =>
		index < 2 ? { ...item, source: { ...item.source, directoryName: "pi-wecom-aibot-workspace" } } : item,
	);
	const card = sessionPicker(all, 0)!.card;
	assert.deepEqual(
		card.facts.map((fact) => fact.value),
		["pi-wecom-aibot-… · 0000 · model-0", "pi-wecom-aibot-… · 0001 · model-1", "project-2 · 0002 · model-2"],
		"a row keeps sixteen of the folder",
	);
	assert.deepEqual(
		card.selection!.options.map((option) => option.text),
		["pi-wecom-… · 0000 · 执行中", "pi-wecom-… · 0001 · 空闲", "project-2 · 0002 · 状态未知"],
		"an option keeps ten",
	);
});

test("no session online draws no list", () => {
	assert.equal(sessionPicker([]), undefined);
});

test("only the list's keys are actions; the old lists' keys are none", () => {
	assert.deepEqual(pickerAction(`pick@show@${fingerprintOf(0)}`), {
		kind: "act",
		action: CONTROL_KEYS.show,
		fingerprint: fingerprintOf(0),
	});
	assert.deepEqual(pickerAction("pick@abort"), { kind: "act", action: CONTROL_KEYS.abort }, "the list before");
	assert.deepEqual(pickerAction("pick@next@12"), { kind: "page", page: 12 });
	assert.deepEqual(pickerAction("pick@prev@0"), { kind: "page", page: 0 });
	for (const key of [
		"pick@abort-confirm",
		"pick@refresh",
		"pick@page@1",
		"page@1",
		"card@session",
		"select@session",
		"send",
	])
		assert.equal(pickerAction(key), undefined, key);
});
