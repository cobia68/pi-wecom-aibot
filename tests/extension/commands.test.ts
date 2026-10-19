/** Help layout: sections, alignment and the invariants every topic help shares. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { completeWecom, parseWecomInvocation, wecomHelpText } from "../../src/extension/commands.ts";

function topicHelp(input: string): string {
	const invocation = parseWecomInvocation(input);
	assert.equal(invocation.kind, "help", `${input} must be help`);
	return invocation.kind === "help" ? wecomHelpText(invocation.topic) : "";
}

/** Terminal columns: CJK placeholders such as <秒> are two columns wide, like the renderer assumes. */
function width(text: string): number {
	return [...text].reduce((sum, char) => sum + (/[\u2e80-\uffef]/.test(char) ? 2 : 1), 0);
}

/** The column where a `  label  description` row's description starts, or null for a plain line. */
function descriptionColumn(row: string): number | null {
	const match = /^( {2})(\S.*?)( {2,})(\S.*)$/.exec(row);
	return match ? width(match[1] + match[2] + match[3]) : null;
}

/** The rows between a section title and the next blank line. */
function sectionRows(help: string, title: string): string[] {
	const lines = help.split("\n");
	const start = lines.indexOf(title);
	assert.notEqual(start, -1, `missing section ${title}`);
	const rows: string[] = [];
	for (let i = start + 1; i < lines.length && lines[i] !== ""; i++) rows.push(lines[i]);
	return rows;
}

test("the total help lists its sections in a fixed order and never leaves trailing whitespace", () => {
	const help = wecomHelpText();
	const headers = help.split("\n").filter((line) => line && !line.startsWith(" ")).slice(2);
	assert.deepEqual(headers, ["说明", "子命令", "通用选项", "推送目标", "配置", "生命周期"]);
	// The subject is the 智能机器人, not 企业微信 as a whole: this plugin only speaks the bot long connection.
	assert.match(help.split("\n")[0], /^企业微信智能机器人 — /);
	for (const line of help.split("\n")) assert.equal(line, line.trimEnd(), `trailing whitespace: ${JSON.stringify(line)}`);
	assert.doesNotMatch(help, /--help, -h/, "the help option reads -h, --help");
});

test("option rows line up, with or without a chained action", () => {
	for (const input of ["setup --help", "setup whoami --help", "test --help", "screen --help", "whoami --help", "help help"]) {
		const rows = sectionRows(topicHelp(input), "选项");
		assert.ok(rows.length >= 1, input);
		const columns = new Set(rows.map(descriptionColumn));
		assert.equal(columns.size, 1, `${input} option descriptions must share one column: ${[...columns].join(",")}`);
	}
});

test("every topic help has a usage line, the config path and a pointer to the total help", () => {
	const names = (completeWecom("") ?? []).map((item) => item.value).filter((value) => !value.startsWith("-"));
	assert.ok(names.length >= 10);
	for (const name of names) {
		// `help --help` is the total help; `help help` is the topic help for the help command itself.
		const help = topicHelp(name === "help" ? "help help" : `${name} --help`);
		assert.match(help, new RegExp(`^用法：/wecom \\[?${name}`, "m"), name);
		assert.match(help, /配置文件/, name);
		assert.match(help, /\/wecom --help/, name);
	}
});

test("the total help describes the commands it lists, and a topic help never repeats another command's usage", () => {
	const commands = sectionRows(wecomHelpText(), "子命令");
	assert.equal(commands.length, 10);
	for (const row of commands) assert.ok(descriptionColumn(row), row);
	// Usage and options live under the command itself, not in the total help.
	assert.doesNotMatch(wecomHelpText(), /\/wecom setup \[whoami\]/);
	assert.doesNotMatch(topicHelp("start --help"), /\/wecom setup \[--bot-id/);
});

test("screen and setup help explain platform fonts without bundling or automatic downloads", () => {
	for (const input of ["screen --help", "setup --help"]) {
		const help = topicHelp(input);
		assert.match(help, /Windows.*微软雅黑/);
		assert.match(help, /macOS.*苹方/);
		assert.match(help, /Linux.*CJK.*安装/);
		assert.match(help, /不内置字体.*不自动下载/);
	}
});

test("setup help documents only HTTP image uploads and their configurable fields", () => {
	for (const input of ["setup --help", "setup whoami --help"]) {
		const help = topicHelp(input);
		assert.match(help, /imageHosts.*HTTP/);
		assert.match(help, /type 只能是 http/);
		for (const field of ["url", "fileField", "fields", "headers", "urlPath"]) assert.ok(help.includes(field), field);
		assert.doesNotMatch(help, /gitea/i);
	}
});

test("screen help documents the exclusive text and image bodies", () => {
	const help = topicHelp("screen --help");
	assert.match(help, /screenMode=text/);
	assert.match(help, /screenMode=image/);
	assert.match(help, /二选一/);
	assert.match(help, /最后 20 行/);
	assert.match(help, /imageHosts/, "image mode names the required host setting");
});

test("setup help documents screenMode and the opt-in automatic connection", () => {
	const help = topicHelp("setup --help");
	assert.match(help, /screenMode.*text.*image/);
	assert.match(help, /imageHosts.*image/);
	assert.match(help, /enabled.*默认关闭/);
});

test("a bare action documents no options and offers no --help, while a parameterized command does", () => {
	for (const name of ["status", "start", "stop", "log", "logout"]) {
		const help = topicHelp(`${name} --help`);
		assert.doesNotMatch(help, /^选项$/m, name);
		assert.doesNotMatch(help, /-h, --help/, name);
		assert.equal(completeWecom(`${name} -`), null, name);
	}
	for (const name of ["setup", "whoami", "test", "screen"]) {
		assert.match(topicHelp(`${name} --help`), /^选项$/m, name);
		assert.match(topicHelp(`${name} --help`), /-h, --help/, name);
		assert.ok(completeWecom(`${name} -`)?.some((item) => item.value.endsWith("--help")), name);
	}
});
