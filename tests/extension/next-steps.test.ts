import assert from "node:assert/strict";
import { test } from "node:test";
import { splitNextSteps, withoutNextStepLines, withoutNextSteps } from "../../src/extension/next-steps.ts";

test("a reply's next-step comment is taken out of its text and becomes its steps; the last comment wins", () => {
	assert.deepEqual(splitNextSteps('结论\n\n<!-- wecom_next ["运行测试", "提交改动"] -->'), {
		text: "结论",
		steps: ["运行测试", "提交改动"],
	});
	assert.deepEqual(splitNextSteps('<!-- wecom_next ["a"] -->正文<!-- wecom_next ["b"] -->'), {
		text: "正文",
		steps: ["b"],
	});
	assert.deepEqual(splitNextSteps("没有注释"), { text: "没有注释", steps: [] });
	assert.equal(withoutNextSteps('正文\n<!--wecom_next ["x"]-->'), "正文");
});

test("steps that are not a list of strings, empty, repeated, too long or too many are dropped", () => {
	assert.deepEqual(
		splitNextSteps("正文<!-- wecom_next {oops} -->"),
		{ text: "正文", steps: [] },
		"the comment still goes",
	);
	assert.deepEqual(splitNextSteps('<!-- wecom_next {"a":1} -->').steps, []);
	assert.deepEqual(splitNextSteps('<!-- wecom_next [" a ", "", 7, "a", "b"] -->').steps, ["a", "b"]);
	assert.deepEqual(splitNextSteps(`<!-- wecom_next ["${"长".repeat(501)}", "ok"] -->`).steps, ["ok"]);
	const many = JSON.stringify(Array.from({ length: 12 }, (_, i) => `step ${i}`));
	assert.equal(splitNextSteps(`<!-- wecom_next ${many} -->`).steps.length, 10);
});

test("the terminal's lines of the comment are left out of the card's quote, even when wrapped", () => {
	assert.deepEqual(withoutNextStepLines(["结论", '<!-- wecom_next ["运行测试",', ' "提交改动"] -->', "末行"]), [
		"结论",
		"末行",
	]);
	assert.deepEqual(
		withoutNextStepLines(["a", "<!-- wecom_next [", "x", "y", "z", "b"]),
		["a", "b"],
		"an unclosed comment is followed a few lines only",
	);
});
