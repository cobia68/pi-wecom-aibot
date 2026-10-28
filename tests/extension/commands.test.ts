/** Help layout, argument parsing and completion: the invariants every topic shares, and config's own grammar. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { commandMenu, completeArguments, helpText, parseInvocation } from "../../src/extension/commands.ts";

function topicHelp(input: string): string {
	const invocation = parseInvocation(input);
	assert.equal(invocation.kind, "help", `${input} must be help`);
	return invocation.kind === "help" ? helpText(invocation.topic) : "";
}

function errorOf(input: string): string {
	const invocation = parseInvocation(input);
	assert.equal(invocation.kind, "error", `${input} must be an error`);
	return invocation.kind === "error" ? invocation.message : "";
}

/** Terminal columns: CJK placeholders such as <秒> are two columns wide, like the renderer assumes. */
const width = visibleWidth;

/** The column where a `  label  description` row's description starts, or null for a plain line. */
function descriptionColumn(row: string): number | null {
	const match = /^( {2})(\S.*?)( {2,})(\S.*)$/.exec(row);
	return match ? width(match[1] + match[2] + match[3]) : null;
}

/** The column where a completion or menu label's description starts. */
function labelColumn(label: string): number {
	const match = /^(\S.*?)( {2,})\S/.exec(label);
	assert.ok(match, `no description column: ${label}`);
	return width(match[1] + match[2]);
}

const ALL_HELP = ["--help", "status --help", "config --help", "test --help", "connect --help"];
const ALL_TOPICS = ["disconnect --help", "log --help", "reset --help"];

/** The rows between a section title and the next blank line. */
function sectionRows(help: string, title: string): string[] {
	const lines = help.split("\n");
	const start = lines.indexOf(title);
	assert.notEqual(start, -1, `missing section ${title}`);
	const rows: string[] = [];
	for (let i = start + 1; i < lines.length && lines[i] !== ""; i++) rows.push(lines[i]);
	return rows;
}

const values = (prefix: string) => completeArguments(prefix)?.map((item) => item.value) ?? null;

test("the total help lists its sections in a fixed order and never leaves trailing whitespace", () => {
	const help = helpText();
	const headers = help
		.split("\n")
		.filter((line) => line && !line.startsWith(" "))
		.slice(2);
	assert.deepEqual(headers, ["子命令", "配置", "生命周期"]);
	// The subject is the 智能机器人, not 企业微信 as a whole: this plugin only speaks the bot long connection.
	assert.match(help.split("\n")[0], /^企业微信智能机器人 — /);
	assert.match(help, /^ {2}不带子命令时弹出子命令菜单$/m);
	// The total help fits an 80-column terminal; the paths are this machine's and may be longer.
	for (const line of help.split("\n"))
		if (!/^ {2}(配置文件|会话覆盖) /.test(line)) assert.ok(visibleWidth(line) <= 80, line);
	for (const input of [...ALL_HELP, ...ALL_TOPICS]) {
		const text = input === "--help" ? help : topicHelp(input);
		for (const line of text.split("\n")) {
			assert.equal(line, line.trimEnd(), `trailing whitespace: ${JSON.stringify(line)}`);
			assert.ok(!line.endsWith("。"), `${input}: ${line}`);
		}
		assert.doesNotMatch(text, /(?<![\w-])-h(?![\w-])/, `${input} must not offer -h`);
	}
});

test("option rows line up for every command with options", () => {
	for (const input of ["config --help", "test --help"]) {
		const rows = sectionRows(topicHelp(input), "选项");
		assert.ok(rows.length >= 1, input);
		const columns = new Set(rows.map(descriptionColumn));
		assert.equal(columns.size, 1, `${input} option descriptions must share one column: ${[...columns].join(",")}`);
	}
});

test("every topic help has a usage line; only config and reset name the paths, and none points back to the total help", () => {
	const names = (completeArguments("") ?? [])
		.map((item) => item.value.trim())
		.filter((value) => !value.startsWith("-"));
	assert.equal(names.length, 7);
	for (const name of names) {
		const help = topicHelp(`${name} --help`);
		assert.match(help, new RegExp(`^用法：/wecom-aibot ${name}`, "m"), name);
		if (name === "config" || name === "reset") {
			assert.match(help, /配置文件/, name);
			assert.match(help, /会话覆盖/, name);
		} else assert.doesNotMatch(help, /配置文件/, name);
		assert.doesNotMatch(help, /\/wecom-aibot --help/, name);
	}
	assert.equal(
		topicHelp("status --help"),
		"status — 查看当前 pi 的接入状态、会话来源和配置路径\n用法：/wecom-aibot status",
	);
	assert.equal(topicHelp("log --help"), "log — 查看最近 20 条日志\n用法：/wecom-aibot log");
});

test("the total help describes the commands it lists; names it does not list are unknown", () => {
	const commands = sectionRows(helpText(), "子命令");
	assert.equal(commands.length, 7);
	// `help` is not an action: only `--help` opens help, so it must not appear among the subcommands.
	assert.doesNotMatch(helpText(), /^ {2}help {2}/m);
	for (const row of commands) assert.ok(descriptionColumn(row), row);
	// Usage lives under the command itself, not in the total help or another topic.
	assert.doesNotMatch(helpText(), /用法：\/wecom-aibot config/);
	assert.doesNotMatch(topicHelp("connect --help"), /用法：\/wecom-aibot config/);
	for (const removed of ["setup", "notify", "setup whoami", "notify on", "whoami", "whoami --wait 30"]) {
		assert.doesNotMatch(helpText(), new RegExp(`^ {2}${removed} {2}`, "m"));
		const invocation = parseInvocation(removed);
		assert.equal(invocation.kind, "error", removed);
		assert.match(invocation.kind === "error" ? invocation.message : "", /未知子命令/, removed);
	}
});

test("config help documents scopes, every field with its default, and no retired name", () => {
	const help = topicHelp("config --help");
	assert.equal(topicHelp("config --scope session set --help"), help, "help inside config is config's own help");
	for (const field of ["botId", "secret", "defaultChatId", "defaultChatType", "notificationScope", "controlPrompts"])
		assert.match(help, new RegExp(`^ {2}${field} `, "m"), field);
	assert.match(help, /wecom-tasks：.*（默认）/);
	assert.doesNotMatch(help, /screenshotTheme|截图/);
	assert.match(help, /^用法：\/wecom-aibot config \[--scope <global\|session>\] <动作> \[字段=值 …\]$/m);
	assert.match(help, /作用域是命令的目标，写在动作前：config --scope <global\|session> <动作>/);
	assert.match(help, /^ {2}--scope <global\|session> {2,}写在动作前/m);
	assert.match(help, /^ {2}--scope <global\|session> unset 字段 … {2,}/m);
	assert.match(help, /^ {2}\[--scope <global\|session>\] whoami {2,}/m);
	assert.match(help, /6 位验证码.*不受白名单限制/);
	assert.match(help, /只能用 edit 输入/);
	assert.match(help, /allowedUserIds.*不由 config 管理/);
	// A label that only repeats the field name is not printed twice.
	assert.match(help, /^ {2}botId {14}智能机器人 BotID$/m);
	assert.match(help, /^ {2}defaultChatId {6}默认推送目标：/m);
	assert.doesNotMatch(
		help,
		/sendMode|notifyEveryRun|enabled|screenMode|imageHosts|fontFiles|\/wecom-aibot setup|\/wecom-aibot notify/,
		"no retired field or command is still documented",
	);
});

test("connection help never promises persisted consent or recommends the old start action", () => {
	for (const help of [
		helpText(),
		topicHelp("config --help"),
		topicHelp("connect --help"),
		topicHelp("disconnect --help"),
	]) {
		assert.match(help, /当前 (?:pi|session)/);
		assert.match(help, /每个 session.*手动.*\/wecom-aibot connect/);
		assert.doesNotMatch(help, /enabled 设为|开启自动接入|会打开|\bstart\b/);
	}
});

test("help says saving configuration never connects, and whoami only listens through a temporary connection", () => {
	const config = topicHelp("config --help");
	assert.match(config, /保存配置不会断开或重连/);
	assert.match(config, /临时连接.*不出现在在线会话列表/);
	assert.match(config, /whoami 只识别不保存/);
	const connect = topicHelp("connect --help");
	assert.match(connect, /默认推送目标必须齐全/);
	assert.match(connect, /创建或复用本 session 的控制卡/);
	assert.match(connect, /控制卡只在点击后刷新/);
	assert.match(connect, /没有交互界面且有待处理工作时拒绝切换/);
	assert.doesNotMatch(helpText(), /wecom-aibot use/);
});

test("config takes its target before the action: --scope, action, 字段=值; reading may omit the target", () => {
	const config = (input: string) => {
		const invocation = parseInvocation(input);
		assert.equal(invocation.kind, "config", input);
		return invocation.kind === "config" ? invocation.config : undefined;
	};
	assert.deepEqual(config("config"), { action: "choose" });
	assert.deepEqual(config("config --scope GLOBAL"), { action: "choose", scope: "global" });
	assert.deepEqual(config("config show"), { action: "show" });
	assert.deepEqual(config("config --scope global show"), { action: "show", scope: "global" });
	assert.deepEqual(config("config --scope session show"), { action: "show", scope: "session" });
	assert.deepEqual(config("config --scope=global edit"), { action: "edit", scope: "global" });
	assert.deepEqual(config("config --scope session set defaultChatId=boss notificationScope=all-runs"), {
		action: "set",
		scope: "session",
		set: { defaultChatId: "boss", defaultChatType: 1, notificationScope: "all-runs" },
	});
	assert.deepEqual(config("config --scope global set controlPrompts+=部署,提交 notificationScope=all-runs"), {
		action: "set",
		scope: "global",
		set: { notificationScope: "all-runs" },
		prompts: { op: "add", prompts: ["部署", "提交"] },
	});
	assert.deepEqual(config("config --scope session set controlPrompts-=运行测试"), {
		action: "set",
		scope: "session",
		set: {},
		prompts: { op: "remove", prompts: ["运行测试"] },
	});
	assert.deepEqual(config("config --scope session unset defaultChatId"), {
		action: "unset",
		scope: "session",
		remove: ["defaultChatId", "defaultChatType"],
	});
	assert.deepEqual(config("config --scope global unset notificationScope"), {
		action: "unset",
		scope: "global",
		remove: ["notificationScope"],
	});
	assert.deepEqual(config("config whoami"), { action: "whoami", seconds: 300 });
	assert.deepEqual(config("config --scope session whoami --wait 30"), {
		action: "whoami",
		scope: "session",
		seconds: 30,
	});
	const errors: [string, RegExp][] = [
		[
			"config set notificationScope=all-runs",
			/^set 需要 --scope：\/wecom-aibot config --scope session set notificationScope=all-runs，或 --scope global/,
		],
		["config edit", /^edit 需要 --scope/],
		["config unset defaultChatId", /^unset 需要 --scope：.*config --scope session unset defaultChatId/],
		["config --scope everyone set x=1", /--scope 只能是 global 或 session/],
		["config --scope global set --scope session x=1", /--scope 重复给出/],
		["config global set notificationScope=all-runs", /^未知动作 global；可用 show、edit、set、unset、whoami/],
		["config set session notificationScope=all-runs", /^set 需要 --scope：/],
		["config global", /^未知动作 global/],
		["config session delete x", /^未知动作 session/],
		["config --global set x=1", /^未知选项 --global。作用域写成 --scope global$/],
		["config --show", /show 是动作，不带 --/],
		["config --scope session set --notificationScope all-runs", /字段写成 notificationScope=…，不用 --/],
		["config --scope session set --mode text", /未知选项 --mode.*--scope、--wait、--help；字段写成 字段=值/],
		["config show --wait 30", /--wait 只用于 whoami/],
		["config whoami --wait 5", /--wait 须为 10～600/],
		["config whoami x", /不接受参数/],
		["config everything", /未知动作 everything；可用 show、edit、set、unset、whoami/],
		["config show extra", /不接受参数/],
		["config --scope global edit now", /不接受参数/],
		["config --scope session set", /至少一个 字段=值/],
		["config --scope session set notificationScope=all-runs bogus=1", /未知字段 bogus.*未做任何修改/],
		["config --scope global set secret=s", /只能用 .*edit/],
		["config --scope session unset", /需要字段名/],
		["test --scope global", /test 不支持 --scope/],
	];
	for (const [input, message] of errors) {
		const invocation = parseInvocation(input);
		assert.equal(invocation.kind, "error", input);
		assert.match(invocation.kind === "error" ? invocation.message : "", message, input);
	}
});

test("the target goes right after config and before the action; --wait goes after whoami", () => {
	const misplaced: [string, string][] = [
		[
			"config set --scope global notificationScope=all-runs",
			"/wecom-aibot config --scope global set notificationScope=all-runs",
		],
		["config show --scope session", "/wecom-aibot config --scope session show"],
		["config edit --scope=global", "/wecom-aibot config --scope global edit"],
		["config unset defaultChatId --scope session", "/wecom-aibot config --scope session unset defaultChatId"],
		["config whoami --wait 30 --scope global", "/wecom-aibot config --scope global whoami --wait 30"],
		["--scope global config show", "/wecom-aibot config --scope global show"],
	];
	for (const [input, written] of misplaced)
		assert.equal(errorOf(input), `--scope 要写在动作前：${written}。查看帮助：/wecom-aibot config --help`, input);
	assert.equal(
		errorOf("config --wait 30 whoami"),
		"--wait 要写在 whoami 后：/wecom-aibot config whoami --wait 30。查看帮助：/wecom-aibot config --help",
	);
	assert.match(errorOf("config --scope global --wait 30 whoami"), /config --scope global whoami --wait 30。/);
});

test("a bare action documents no options, yet its completion still offers --help", () => {
	for (const name of ["status", "connect", "disconnect", "log", "reset"]) {
		const help = topicHelp(`${name} --help`);
		assert.doesNotMatch(help, /^选项$/m, name);
		assert.doesNotMatch(help, /--help/, name);
		assert.deepEqual(values(`${name} `), [`${name} --help`], name);
		assert.deepEqual(values(`${name} -`), [`${name} --help`], name);
	}
	for (const name of ["config", "test"]) {
		assert.match(topicHelp(`${name} --help`), /^选项$/m, name);
		assert.match(topicHelp(`${name} --help`), /^ {2}--help {2,}显示当前命令的帮助，不执行动作$/m, name);
		assert.ok(
			completeArguments(`${name} -`)?.some((item) => item.value.endsWith("--help")),
			name,
		);
	}
});

test("argument completion offers every word that may come next: subcommands, options, actions, fields and values", () => {
	assert.deepEqual(values(""), ["status ", "config ", "connect ", "disconnect ", "test ", "log ", "reset ", "--help"]);
	assert.deepEqual(values("co"), ["config ", "connect "]);
	assert.deepEqual(values("--h"), ["--help"]);
	// test's chatid is free text, so only its options are offered.
	assert.deepEqual(values("test "), ["test --chat-type ", "test --help"]);
	assert.deepEqual(values("test x --"), ["test x --chat-type ", "test x --help"]);
	assert.deepEqual(values("test x --chat-type "), ["test x --chat-type 1 ", "test x --chat-type 2 "]);
	assert.deepEqual(values("test x --chat-type 2 "), ["test x --chat-type 2 --help"]);
	// The target comes first: until it is given, only the actions that may go without it are offered.
	assert.deepEqual(values("config "), ["config --scope ", "config show ", "config whoami ", "config --help"]);
	assert.deepEqual(values("config s"), ["config show "]);
	assert.deepEqual(values("config -"), ["config --scope ", "config --help"]);
	assert.deepEqual(values("config --scope "), ["config --scope global ", "config --scope session "]);
	assert.deepEqual(values("config --scope s"), ["config --scope session "]);
	assert.deepEqual(values("config --scope global "), [
		"config --scope global show ",
		"config --scope global edit ",
		"config --scope global set ",
		"config --scope global unset ",
		"config --scope global whoami ",
		"config --scope global --help",
	]);
	assert.deepEqual(values("config --scope=global s"), ["config --scope=global show ", "config --scope=global set "]);
	// After the action there is no --scope: --wait is whoami's and comes after it.
	assert.deepEqual(values("config show "), ["config show --help"]);
	assert.deepEqual(values("config whoami "), ["config whoami --wait ", "config whoami --help"]);
	assert.deepEqual(values("config whoami --w"), ["config whoami --wait "]);
	assert.deepEqual(values("config --scope global whoami "), [
		"config --scope global whoami --wait ",
		"config --scope global whoami --help",
	]);
	assert.deepEqual(values("config --scope global show "), ["config --scope global show --help"]);
	assert.deepEqual(values("config --scope session edit "), ["config --scope session edit --help"]);
	// Credentials are never offered to set: they only go through edit. A field= takes its value without a space.
	assert.deepEqual(values("config --scope global set "), [
		"config --scope global set defaultChatId=",
		"config --scope global set defaultChatType=",
		"config --scope global set notificationScope=",
		"config --scope global set controlPrompts=",
		"config --scope global set controlPrompts+=",
		"config --scope global set controlPrompts-=",
		"config --scope global set --help",
	]);
	// A field already given is not offered again, whichever of =, += or -= it was given with.
	assert.deepEqual(values("config --scope session set notificationScope=all-runs c"), [
		"config --scope session set notificationScope=all-runs controlPrompts=",
		"config --scope session set notificationScope=all-runs controlPrompts+=",
		"config --scope session set notificationScope=all-runs controlPrompts-=",
	]);
	assert.equal(values("config --scope session set controlPrompts+=a c"), null);
	assert.deepEqual(values("config --scope session set notificationscope="), [
		"config --scope session set notificationScope=wecom-tasks ",
		"config --scope session set notificationScope=all-runs ",
	]);
	assert.deepEqual(values("config --scope session unset d"), [
		"config --scope session unset defaultChatId ",
		"config --scope session unset defaultChatType ",
	]);
	// A finished token, a free value or a word after --help shows no list: Enter must run the command.
	for (const done of [
		"config",
		"config show",
		"config --scope session set",
		"config --scope session set notificationScope=all-runs",
		"config --scope session set defaultChatId=",
		"config whoami --wait ",
		"config show --help ",
		"config show extra ",
		"config bogus ",
		// Refused when run: a write without a target, the target after the action, --wait before whoami.
		"config set ",
		"config edit ",
		"config unset d",
		"config set --scope global ",
		"config show --scope ",
		"config --wait 30 whoami ",
		"test x y ",
		"whoami --w",
		"--help",
		"--help ",
		"connect x",
	]) {
		assert.equal(completeArguments(done), null, done);
	}
});

test("controlPrompts-= completes the prompts of the scope it is written for; = and += take new text", () => {
	const lists = { global: ["继续", "运行测试", "has space", "a,b"], session: ["只在 session"] };
	const asked: string[] = [];
	const complete = (prefix: string) =>
		completeArguments(prefix, (scope) => {
			asked.push(scope);
			return lists[scope];
		})?.map((item) => item.value) ?? null;
	assert.deepEqual(complete("config --scope global set controlPrompts-="), [
		"config --scope global set controlPrompts-=继续 ",
		"config --scope global set controlPrompts-=运行测试 ",
	]);
	assert.deepEqual(
		complete("config --scope global set controlPrompts-=运"),
		["config --scope global set controlPrompts-=运行测试 "],
		"one word each: a prompt with a space or a comma cannot be written here",
	);
	assert.equal(complete("config --scope session set controlPrompts-="), null, "no word of the session's list");
	assert.deepEqual(asked, ["global", "global", "session"]);
	for (const free of ["config --scope global set controlPrompts=", "config --scope global set controlPrompts+="])
		assert.equal(complete(free), null, free);
});

test("every completion level and the menu put the descriptions in one column, which filtering keeps still", () => {
	for (const prefix of [
		"",
		"test x --",
		"config ",
		"config whoami -",
		"config --scope ",
		"config --scope global ",
		"config --scope global set ",
		"config --scope session set notificationScope=",
		"config --scope session unset ",
	]) {
		const labels = (completeArguments(prefix) ?? []).map((item) => item.label);
		assert.ok(labels.length > 1, prefix);
		assert.equal(new Set(labels.map(labelColumn)).size, 1, `${prefix}: ${labels.join(" | ")}`);
		for (const label of labels) assert.doesNotMatch(label, / — /, label);
	}
	const top = labelColumn(completeArguments("")![0].label);
	for (const item of completeArguments("co") ?? []) assert.equal(labelColumn(item.label), top, item.label);
	assert.deepEqual(
		completeArguments("test x --")?.map((item) => item.label),
		["--chat-type <1|2>  1 单聊，2 群聊；需同时给出 chatid，省略时为 1", "--help             显示帮助"],
	);
	const menu = commandMenu();
	assert.deepEqual(
		menu.map((item) => item.input),
		["status", "config", "connect", "disconnect", "test", "log", "reset", "--help"],
	);
	assert.equal(new Set(menu.map((item) => labelColumn(item.label))).size, 1);
	for (const item of menu) assert.ok(item.label.startsWith(`${item.input} `), item.label);
});

test("-h is an unknown option like any other: only --help shows help", () => {
	assert.match(errorOf("-h"), /^未知选项 -h。查看用法：\/wecom-aibot --help/);
	assert.match(errorOf("connect -h"), /^未知选项 -h。\/wecom-aibot connect 不接受选项/);
	assert.match(errorOf("test -h"), /支持的选项：--chat-type、--help/);
	assert.match(errorOf("config --scope global edit -h"), /^未知选项 -h。.*--scope、--wait、--help；字段写成 字段=值$/);
	assert.deepEqual(values("-"), ["--help"]);
	assert.equal(topicHelp("--help connect"), topicHelp("connect --help"));
});

test("a bare /wecom-aibot opens the menu; options without a subcommand say where they belong, never as status", () => {
	for (const input of ["", "   ", "--"]) assert.deepEqual(parseInvocation(input), { kind: "choose" }, input);
	assert.deepEqual(parseInvocation("--help"), { kind: "help" });
	const messages = [errorOf("-x"), errorOf("--wait 30"), errorOf("--chat-type 2"), errorOf("--help -x")];
	assert.deepEqual(messages, [
		"未知选项 -x。查看用法：/wecom-aibot --help；选项写在子命令后面",
		"--wait 要写在子命令后面，例如 /wecom-aibot config whoami --wait 30。查看用法：/wecom-aibot --help",
		"--chat-type 要写在子命令后面，例如 /wecom-aibot test <chatid> --chat-type 2。查看用法：/wecom-aibot --help",
		"未知选项 -x。查看用法：/wecom-aibot --help；选项写在子命令后面",
	]);
	for (const message of messages) assert.doesNotMatch(message, /status/, message);
	assert.match(errorOf("--scope global"), /例如 \/wecom-aibot config --scope global show/);
	assert.match(errorOf("--connect"), /^connect 是子命令，不带 --/);
	const status = parseInvocation("status");
	assert.equal(status.kind === "run" && status.command.name, "status");
	// A --wait before the command name is in the wrong place, like one before whoami.
	assert.match(errorOf("--wait 30 config whoami"), /^--wait 要写在 whoami 后：\/wecom-aibot config whoami --wait 30/);
});

test("error messages never end in a full stop, also when composed from several sentences", () => {
	for (const input of [
		"strat",
		"whoami",
		"status x",
		"connect config",
		"test a b",
		"test --chat-type 3 x",
		"config whoami --wait 5",
		"config show --wait 30",
		"config --scope session set notificationScope=all-runs bogus=1 x",
		"config --scope session unset",
		"config global set x=1",
		"config everything",
		"--wait",
	])
		assert.ok(!errorOf(input).endsWith("。"), errorOf(input));
	assert.equal(
		errorOf("config --scope session set notificationScope=all-runs bogus=1 x"),
		"未知字段 bogus；可用字段：defaultChatId、defaultChatType、notificationScope、controlPrompts；「x」缺少 =，写成 字段=值。未做任何修改。查看帮助：/wecom-aibot config --help",
	);
});
