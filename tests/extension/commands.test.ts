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
	for (const input of ["setup --help", "setup whoami --help", "test --help", "whoami --help", "test -h"]) {
		const rows = sectionRows(topicHelp(input), "选项");
		assert.ok(rows.length >= 1, input);
		const columns = new Set(rows.map(descriptionColumn));
		assert.equal(columns.size, 1, `${input} option descriptions must share one column: ${[...columns].join(",")}`);
	}
});

test("every topic help has a usage line, the config path and a pointer to the total help", () => {
	const names = (completeWecom("") ?? []).map((item) => item.value).filter((value) => !value.startsWith("-"));
	assert.ok(names.length >= 8);
	for (const name of names) {
		const help = topicHelp(`${name} --help`);
		assert.match(help, new RegExp(`^用法：/wecom-aibot \\[?${name}`, "m"), name);
		assert.match(help, /配置文件/, name);
		assert.match(help, /\/wecom-aibot --help/, name);
	}
});

test("the total help describes the commands it lists, and a topic help never repeats another command's usage", () => {
	const commands = sectionRows(wecomHelpText(), "子命令");
	assert.equal(commands.length, 8);
	// `help` is not an action: only `--help` opens help, so it must not appear among the subcommands.
	assert.doesNotMatch(wecomHelpText(), /^  help  /m);
	for (const row of commands) assert.ok(descriptionColumn(row), row);
	// Usage and options live under the command itself, not in the total help.
	assert.doesNotMatch(wecomHelpText(), /\/wecom-aibot setup \[whoami\]/);
	assert.doesNotMatch(topicHelp("connect --help"), /\/wecom-aibot setup \[--bot-id/);
});

test("setup help documents manual per-session connection and no removed screen settings", () => {
	const help = topicHelp("setup --help");
	assert.match(help, /每个 session.*手动.*\/wecom-aibot connect/);
	assert.match(help, /enabled.*忽略/);
	assert.doesNotMatch(help, /"enabled"\s*:|screenMode|imageHosts|fontFiles|\/wecom-aibot screen/);
});

test("connection help never promises persisted consent or recommends the old start action", () => {
	for (const help of [wecomHelpText(), topicHelp("setup --help"), topicHelp("connect --help"), topicHelp("disconnect --help")]) {
		assert.match(help, /当前 (?:pi|session)/);
		assert.match(help, /每个 session.*手动.*\/wecom-aibot connect/);
		assert.doesNotMatch(help, /enabled 设为|开启自动接入|会打开|\bstart\b/);
	}
});

test("a bare action documents no options and offers no --help, while a parameterized command does", () => {
	for (const name of ["status", "connect", "disconnect", "log", "logout"]) {
		const help = topicHelp(`${name} --help`);
		assert.doesNotMatch(help, /^选项$/m, name);
		assert.doesNotMatch(help, /-h, --help/, name);
		assert.equal(completeWecom(`${name} -`), null, name);
	}
	for (const name of ["setup", "whoami", "test"]) {
		assert.match(topicHelp(`${name} --help`), /^选项$/m, name);
		assert.match(topicHelp(`${name} --help`), /-h, --help/, name);
		assert.ok(completeWecom(`${name} -`)?.some((item) => item.value.endsWith("--help")), name);
	}
});
