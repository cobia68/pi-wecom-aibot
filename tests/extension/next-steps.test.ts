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

test("steps that are not a list of strings, too long or too many are dropped and named; empty and repeated ones quietly", () => {
	const broken = splitNextSteps("正文<!-- wecom_next {oops} -->");
	assert.equal(broken.text, "正文", "the comment still goes");
	assert.deepEqual(broken.steps, []);
	assert.match(broken.problem ?? "", /^wecom_next 不是有效的 JSON：/);
	assert.deepEqual(splitNextSteps('<!-- wecom_next {"a":1} -->'), {
		text: "",
		steps: [],
		problem: "wecom_next 应是字符串数组",
	});
	const mixed = splitNextSteps('<!-- wecom_next [" a ", "", 7, "a", "b"] -->');
	assert.deepEqual(mixed.steps, ["a", "b"]);
	assert.match(mixed.problem ?? "", /^wecom_next 有 1 项未采用/, "the number, not the empty or repeated one");
	const long = splitNextSteps(`<!-- wecom_next ["${"长".repeat(501)}", "ok"] -->`);
	assert.deepEqual(long.steps, ["ok"]);
	assert.match(long.problem ?? "", /有 1 项未采用/);
	const many = JSON.stringify(Array.from({ length: 12 }, (_, i) => `step ${i}`));
	const capped = splitNextSteps(`<!-- wecom_next ${many} -->`);
	assert.equal(capped.steps.length, 10);
	assert.match(capped.problem ?? "", /有 2 项未采用/);
	assert.equal(splitNextSteps('<!-- wecom_next ["a", "a", " "] -->').problem, undefined);
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
