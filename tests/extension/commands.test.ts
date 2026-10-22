/** Help layout, argument parsing and completion: the invariants every topic shares, and config's own grammar. */
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

/** pi's theme names, as the extension reads them from ctx.ui.getAllThemes(). */
const themes = () => ["system", "dark", "light", "rainbow-prism"];
const values = (prefix: string) => completeWecom(prefix, themes)?.map((item) => item.value) ?? null;

test("the total help lists its sections in a fixed order and never leaves trailing whitespace", () => {
	const help = wecomHelpText();
	const headers = help
		.split("\n")
		.filter((line) => line && !line.startsWith(" "))
		.slice(2);
	assert.deepEqual(headers, ["说明", "子命令", "通用选项", "推送目标", "配置", "生命周期"]);
	// The subject is the 智能机器人, not 企业微信 as a whole: this plugin only speaks the bot long connection.
	assert.match(help.split("\n")[0], /^企业微信智能机器人 — /);
	for (const text of [help, topicHelp("config --help")])
		for (const line of text.split("\n"))
			assert.equal(line, line.trimEnd(), `trailing whitespace: ${JSON.stringify(line)}`);
	assert.doesNotMatch(help, /--help, -h/, "the help option reads -h, --help");
});

test("option rows line up for every command with options", () => {
	for (const input of ["config --help", "test --help", "whoami --help", "test -h"]) {
		const rows = sectionRows(topicHelp(input), "选项");
		assert.ok(rows.length >= 1, input);
		const columns = new Set(rows.map(descriptionColumn));
		assert.equal(columns.size, 1, `${input} option descriptions must share one column: ${[...columns].join(",")}`);
	}
});

test("every topic help has a usage line, the config path and a pointer to the total help", () => {
	const names = (completeWecom("", themes) ?? []).map((item) => item.value).filter((value) => !value.startsWith("-"));
	assert.equal(names.length, 8);
	for (const name of names) {
		const help = topicHelp(`${name} --help`);
		assert.match(help, new RegExp(`^用法：/wecom-aibot \\[?${name}`, "m"), name);
		assert.match(help, /配置文件/, name);
		assert.match(help, /会话覆盖/, name);
		assert.match(help, /\/wecom-aibot --help/, name);
	}
});

test("the total help describes the commands it lists; setup and notify are gone without aliases", () => {
	const commands = sectionRows(wecomHelpText(), "子命令");
	assert.equal(commands.length, 8);
	// `help` is not an action: only `--help` opens help, so it must not appear among the subcommands.
	assert.doesNotMatch(wecomHelpText(), /^ {2}help {2}/m);
	for (const row of commands) assert.ok(descriptionColumn(row), row);
	// Usage lives under the command itself, not in the total help or another topic.
	assert.doesNotMatch(wecomHelpText(), /用法：\/wecom-aibot config/);
	assert.doesNotMatch(topicHelp("connect --help"), /用法：\/wecom-aibot config/);
	for (const removed of ["setup", "notify", "setup whoami", "notify on"]) {
		assert.doesNotMatch(wecomHelpText(), new RegExp(`^ {2}${removed} {2}`, "m"));
		const invocation = parseWecomInvocation(removed);
		assert.equal(invocation.kind, "error", removed);
		assert.match(invocation.kind === "error" ? invocation.message : "", /未知子命令/, removed);
	}
});

test("config help documents scopes, every field with its default, and no retired name", () => {
	const help = topicHelp("config --help");
	assert.equal(topicHelp("config session set --help"), help, "help inside config is config's own help");
	for (const field of [
		"botId",
		"secret",
		"defaultChatId",
		"defaultChatType",
		"notificationMode",
		"notificationScope",
		"screenshotTheme",
	])
		assert.match(help, new RegExp(`^ {2}${field} `, "m"), field);
	assert.match(help, /text：.*（默认）/);
	assert.match(help, /wecom-tasks：.*（默认）/);
	assert.match(help, /screenshotTheme .*pi 主题名.*不设置时跟随 pi 当前的界面主题/);
	assert.match(help, /写操作必须写明 session 或 global/);
	assert.match(help, /只能用 edit 输入/);
	assert.match(help, /fork／clone/);
	assert.match(help, /allowedUserIds.*不由 config 管理/);
	assert.doesNotMatch(
		help,
		/sendMode|notifyEveryRun|enabled|screenMode|imageHosts|fontFiles|\/wecom-aibot setup|\/wecom-aibot notify/,
		"no retired field or command is still documented",
	);
});

test("connection help never promises persisted consent or recommends the old start action", () => {
	for (const help of [
		wecomHelpText(),
		topicHelp("config --help"),
		topicHelp("connect --help"),
		topicHelp("disconnect --help"),
	]) {
		assert.match(help, /当前 (?:pi|session)/);
		assert.match(help, /每个 session.*手动.*\/wecom-aibot connect/);
		assert.doesNotMatch(help, /enabled 设为|开启自动接入|会打开|\bstart\b/);
	}
});

test("help says saving configuration never connects, and whoami's save never disconnects", () => {
	assert.match(topicHelp("config --help"), /保存配置不会断开或重连/);
	const identity = topicHelp("whoami --help");
	assert.match(identity, /临时连接.*不出现在在线会话列表/);
	assert.match(identity, /保存不会断开当前接入/);
	assert.match(identity, /全局默认推送目标/);
	const connect = topicHelp("connect --help");
	assert.match(connect, /默认推送目标必须齐全/);
	assert.match(connect, /可引用的会话入口/);
	assert.match(connect, /没有交互界面且有待处理工作时拒绝切换/);
	assert.doesNotMatch(wecomHelpText(), /wecom-aibot use/);
});

test("config takes a scope, an action and 字段=值; only showing may omit the scope, and no action lists the choices", () => {
	const config = (input: string) => {
		const invocation = parseWecomInvocation(input);
		assert.equal(invocation.kind, "config", input);
		return invocation.kind === "config" ? invocation.config : undefined;
	};
	assert.deepEqual(config("config"), { action: "choose" });
	assert.deepEqual(config("config show"), { action: "show" });
	assert.deepEqual(config("config GLOBAL"), { action: "choose", scope: "global" });
	assert.deepEqual(config("config global show"), { action: "show", scope: "global" });
	assert.deepEqual(config("config session show"), { action: "show", scope: "session" });
	assert.deepEqual(config("config global edit"), { action: "edit", scope: "global" });
	assert.deepEqual(config("config session set screenshotTheme=light notificationScope=all-runs"), {
		action: "set",
		scope: "session",
		set: { screenshotTheme: "light", notificationScope: "all-runs" },
	});
	assert.deepEqual(config("config session unset defaultChatId"), {
		action: "unset",
		scope: "session",
		remove: ["defaultChatId", "defaultChatType"],
	});
	const errors: [string, RegExp][] = [
		["config set screenshotTheme=light", /需要写明作用域.*config session set/],
		["config edit", /需要写明作用域/],
		["config everyone", /未知作用域/],
		["config show extra", /不接受参数/],
		["config global edit now", /不接受参数/],
		["config session set", /至少一个 字段=值/],
		["config session set screenshotTheme=light bogus=1", /未知字段 bogus.*未做任何修改/],
		["config global set secret=s", /只能用 .*edit/],
		["config session unset", /需要字段名/],
		["config global unset screenshotTheme", /暂不支持/],
		["config session delete x", /未知动作 delete.*unset/],
		["config session set --mode text", /字段=值，不用 --选项/],
		["config --wait 5", /字段=值，不用 --选项/],
	];
	for (const [input, message] of errors) {
		const invocation = parseWecomInvocation(input);
		assert.equal(invocation.kind, "error", input);
		assert.match(invocation.kind === "error" ? invocation.message : "", message, input);
	}
});

test("a bare action documents no options and offers no --help, while a parameterized command does", () => {
	for (const name of ["status", "connect", "disconnect", "log", "reset"]) {
		const help = topicHelp(`${name} --help`);
		assert.doesNotMatch(help, /^选项$/m, name);
		assert.doesNotMatch(help, /-h, --help/, name);
		assert.equal(completeWecom(`${name} -`, themes), null, name);
	}
	for (const name of ["config", "whoami", "test"]) {
		assert.match(topicHelp(`${name} --help`), /^选项$/m, name);
		assert.match(topicHelp(`${name} --help`), /-h, --help/, name);
		assert.ok(
			completeWecom(`${name} -`, themes)?.some((item) => item.value.endsWith("--help")),
			name,
		);
	}
});

test("argument completion offers subcommands, options, and config's scopes, actions, fields and values", () => {
	assert.deepEqual(values("co"), ["config", "connect"]);
	assert.deepEqual(values("--h"), ["--help"]);
	assert.deepEqual(values("test x --"), ["test x --chat-type ", "test x --help"]);
	assert.deepEqual(values("whoami --w"), ["whoami --wait "]);
	assert.deepEqual(values("config "), ["config show", "config global", "config session"]);
	assert.deepEqual(values("config s"), ["config show", "config session"]);
	assert.deepEqual(values("config global "), ["config global show", "config global edit", "config global set"]);
	assert.deepEqual(values("config session u"), ["config session unset"]);
	// Credentials are never offered to set: they only go through edit.
	assert.deepEqual(values("config global set "), [
		"config global set defaultChatId=",
		"config global set defaultChatType=",
		"config global set notificationMode=",
		"config global set notificationScope=",
		"config global set screenshotTheme=",
	]);
	assert.deepEqual(values("config session set notificationMode=text n"), [
		"config session set notificationMode=text notificationScope=",
	]);
	// The screenshot theme offers pi's own themes; the plugin brings none.
	assert.deepEqual(values("config session set screenshotTheme=r"), [
		"config session set screenshotTheme=rainbow-prism",
	]);
	assert.equal(values("config session set screenshotTheme=")?.length, 4);
	assert.deepEqual(values("config session set notificationmode="), [
		"config session set notificationMode=text",
		"config session set notificationMode=screenshot",
	]);
	assert.deepEqual(values("config session unset d"), [
		"config session unset defaultChatId",
		"config session unset defaultChatType",
	]);
	// A finished token or a value position shows no list: Enter must run the command, not apply a completion.
	for (const done of [
		"config",
		"config session",
		"config session set screenshotTheme=light",
		"config session set defaultChatId=",
		"config global unset ",
		"whoami --wait",
		"--help",
		"connect x",
		"connect ",
	]) {
		assert.equal(completeWecom(done, themes), null, done);
	}
});
