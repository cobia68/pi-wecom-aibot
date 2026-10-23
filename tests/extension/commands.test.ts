/** Help layout, argument parsing and completion: the invariants every topic shares, and config's own grammar. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { completeWecom, parseWecomInvocation, wecomHelpText, wecomMenu } from "../../src/extension/commands.ts";

function topicHelp(input: string): string {
	const invocation = parseWecomInvocation(input);
	assert.equal(invocation.kind, "help", `${input} must be help`);
	return invocation.kind === "help" ? wecomHelpText(invocation.topic) : "";
}

function errorOf(input: string): string {
	const invocation = parseWecomInvocation(input);
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

/** pi's theme names, as the extension reads them from ctx.ui.getAllThemes(). */
const themes = () => ["system", "dark", "light", "rainbow-prism"];
const values = (prefix: string) => completeWecom(prefix, themes)?.map((item) => item.value) ?? null;

test("the total help lists its sections in a fixed order and never leaves trailing whitespace", () => {
	const help = wecomHelpText();
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
	const names = (completeWecom("", themes) ?? [])
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

test("the total help describes the commands it lists; setup and notify are gone without aliases", () => {
	const commands = sectionRows(wecomHelpText(), "子命令");
	assert.equal(commands.length, 7);
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
	// whoami moved under config: the old name says where it is now, and runs nothing.
	assert.doesNotMatch(wecomHelpText(), /^ {2}whoami {2}/m);
	assert.equal(errorOf("whoami"), "whoami 已移到 config 下：/wecom-aibot config whoami");
	assert.equal(errorOf("whoami --wait 30"), errorOf("whoami"));
});

test("config help documents scopes, every field with its default, and no retired name", () => {
	const help = topicHelp("config --help");
	assert.equal(topicHelp("config set --scope session --help"), help, "help inside config is config's own help");
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
	assert.match(help, /写操作必须写明 --scope global 或 --scope session/);
	assert.match(help, /^ {2}--scope <global\|session> {2,}/m);
	assert.match(help, /^ {2}unset --scope <global\|session> 字段 … {2,}/m);
	assert.match(help, /^ {2}whoami \[--scope <global\|session>\] {2,}/m);
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

test("help says saving configuration never connects, and whoami only listens through a temporary connection", () => {
	const config = topicHelp("config --help");
	assert.match(config, /保存配置不会断开或重连/);
	assert.match(config, /临时连接.*不出现在在线会话列表/);
	assert.match(config, /whoami 只识别不保存/);
	const connect = topicHelp("connect --help");
	assert.match(connect, /默认推送目标必须齐全/);
	assert.match(connect, /可引用的会话入口/);
	assert.match(connect, /没有交互界面且有待处理工作时拒绝切换/);
	assert.doesNotMatch(wecomHelpText(), /wecom-aibot use/);
});

test("config takes an action, --scope and 字段=值; reading may omit the scope, and no action lists the forms", () => {
	const config = (input: string) => {
		const invocation = parseWecomInvocation(input);
		assert.equal(invocation.kind, "config", input);
		return invocation.kind === "config" ? invocation.config : undefined;
	};
	assert.deepEqual(config("config"), { action: "choose" });
	assert.deepEqual(config("config --scope GLOBAL"), { action: "choose", scope: "global" });
	assert.deepEqual(config("config show"), { action: "show" });
	assert.deepEqual(config("config show --scope global"), { action: "show", scope: "global" });
	assert.deepEqual(config("config --scope session show"), { action: "show", scope: "session" });
	assert.deepEqual(config("config edit --scope=global"), { action: "edit", scope: "global" });
	assert.deepEqual(config("config set screenshotTheme=light notificationScope=all-runs --scope session"), {
		action: "set",
		scope: "session",
		set: { screenshotTheme: "light", notificationScope: "all-runs" },
	});
	assert.deepEqual(config("config unset --scope session defaultChatId"), {
		action: "unset",
		scope: "session",
		remove: ["defaultChatId", "defaultChatType"],
	});
	assert.deepEqual(config("config unset --scope global screenshotTheme"), {
		action: "unset",
		scope: "global",
		remove: ["screenshotTheme"],
	});
	assert.deepEqual(config("config whoami"), { action: "whoami", seconds: 300 });
	assert.deepEqual(config("config whoami --scope session --wait 30"), {
		action: "whoami",
		scope: "session",
		seconds: 30,
	});
	const errors: [string, RegExp][] = [
		[
			"config set screenshotTheme=light",
			/^set 需要 --scope：\/wecom-aibot config set --scope session screenshotTheme=light，或 --scope global/,
		],
		["config edit", /^edit 需要 --scope/],
		["config unset defaultChatId", /^unset 需要 --scope：.*unset --scope session defaultChatId/],
		["config set --scope everyone x=1", /--scope 只能是 global 或 session/],
		["config set --scope global --scope session x=1", /--scope 重复给出/],
		[
			"config global set notificationMode=text",
			/作用域改为 --scope：\/wecom-aibot config set --scope global notificationMode=text/,
		],
		["config set session notificationMode=text", /config set --scope session notificationMode=text/],
		["config global", /作用域改为 --scope：\/wecom-aibot config --scope global。/],
		["config session delete x", /config <动作> --scope session/],
		["config set --global x=1", /^未知选项 --global。作用域写成 --scope global$/],
		["config --show", /show 是动作，不带 --/],
		["config set --scope session --notificationMode text", /字段写成 notificationMode=…，不用 --/],
		["config set --scope session --mode text", /未知选项 --mode.*--scope、--wait、--help；字段写成 字段=值/],
		["config show --wait 30", /--wait 只用于 whoami/],
		["config whoami --wait 5", /--wait 须为 10～600/],
		["config whoami x", /不接受参数/],
		["config everything", /未知动作 everything；可用 show、edit、set、unset、whoami/],
		["config show extra", /不接受参数/],
		["config edit --scope global now", /不接受参数/],
		["config set --scope session", /至少一个 字段=值/],
		["config set --scope session screenshotTheme=light bogus=1", /未知字段 bogus.*未做任何修改/],
		["config set --scope global secret=s", /只能用 .*edit/],
		["config unset --scope session", /需要字段名/],
		["test --scope global", /test 不支持 --scope/],
	];
	for (const [input, message] of errors) {
		const invocation = parseWecomInvocation(input);
		assert.equal(invocation.kind, "error", input);
		assert.match(invocation.kind === "error" ? invocation.message : "", message, input);
	}
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
			completeWecom(`${name} -`, themes)?.some((item) => item.value.endsWith("--help")),
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
	assert.deepEqual(values("config "), [
		"config show ",
		"config edit ",
		"config set ",
		"config unset ",
		"config whoami ",
		"config --scope ",
		"config --help",
	]);
	assert.deepEqual(values("config s"), ["config show ", "config set "]);
	assert.deepEqual(values("config -"), ["config --scope ", "config --help"]);
	// The scope may come before the action, which is then offered after it.
	assert.deepEqual(values("config --scope global "), [
		"config --scope global show ",
		"config --scope global edit ",
		"config --scope global set ",
		"config --scope global unset ",
		"config --scope global whoami ",
		"config --scope global --help",
	]);
	// Only options that apply: --wait is whoami's; a used option is not offered again.
	assert.deepEqual(values("config show "), ["config show --scope ", "config show --help"]);
	assert.deepEqual(values("config whoami "), [
		"config whoami --scope ",
		"config whoami --wait ",
		"config whoami --help",
	]);
	assert.deepEqual(values("config whoami --w"), ["config whoami --wait "]);
	assert.deepEqual(values("config show --scope global "), ["config show --scope global --help"]);
	// edit, set and unset need --scope, so it comes first.
	assert.deepEqual(values("config edit "), ["config edit --scope ", "config edit --help"]);
	assert.deepEqual(values("config set -"), ["config set --scope ", "config set --help"]);
	assert.equal(values("config set ")?.[0], "config set --scope ");
	assert.equal(values("config unset ")?.[0], "config unset --scope ");
	assert.deepEqual(values("config set --scope "), ["config set --scope global ", "config set --scope session "]);
	assert.deepEqual(values("config set --scope s"), ["config set --scope session "]);
	// Credentials are never offered to set: they only go through edit. A field= takes its value without a space.
	assert.deepEqual(values("config set --scope global "), [
		"config set --scope global defaultChatId=",
		"config set --scope global defaultChatType=",
		"config set --scope global notificationMode=",
		"config set --scope global notificationScope=",
		"config set --scope global screenshotTheme=",
		"config set --scope global --help",
	]);
	assert.deepEqual(values("config set --scope session notificationMode=text n"), [
		"config set --scope session notificationMode=text notificationScope=",
	]);
	// The scope may come anywhere: fields are completed after it as well as before.
	assert.deepEqual(values("config set n"), ["config set notificationMode=", "config set notificationScope="]);
	// The screenshot theme offers pi's own themes; the plugin brings none.
	assert.deepEqual(values("config set --scope session screenshotTheme=r"), [
		"config set --scope session screenshotTheme=rainbow-prism ",
	]);
	assert.equal(values("config set --scope session screenshotTheme=")?.length, 4);
	assert.deepEqual(values("config set --scope session notificationmode="), [
		"config set --scope session notificationMode=text ",
		"config set --scope session notificationMode=screenshot ",
	]);
	assert.deepEqual(values("config unset --scope session d"), [
		"config unset --scope session defaultChatId ",
		"config unset --scope session defaultChatType ",
	]);
	// A finished token, a free value or a word after --help shows no list: Enter must run the command.
	for (const done of [
		"config",
		"config show",
		"config set --scope session",
		"config set --scope session screenshotTheme=light",
		"config set --scope session defaultChatId=",
		"config whoami --wait ",
		"config show --help ",
		"config show extra ",
		"config bogus ",
		"test x y ",
		"whoami --w",
		"--help",
		"--help ",
		"connect x",
	]) {
		assert.equal(completeWecom(done, themes), null, done);
	}
});

test("every completion level and the menu put the descriptions in one column, which filtering keeps still", () => {
	for (const prefix of [
		"",
		"test x --",
		"config ",
		"config whoami -",
		"config set --scope ",
		"config set --scope global ",
		"config set --scope session notificationScope=",
		"config set --scope session screenshotTheme=",
		"config unset --scope session ",
	]) {
		const labels = (completeWecom(prefix, themes) ?? []).map((item) => item.label);
		assert.ok(labels.length > 1, prefix);
		assert.equal(new Set(labels.map(labelColumn)).size, 1, `${prefix}: ${labels.join(" | ")}`);
		for (const label of labels) assert.doesNotMatch(label, / — /, label);
	}
	const top = labelColumn(completeWecom("", themes)![0].label);
	for (const item of completeWecom("co", themes) ?? []) assert.equal(labelColumn(item.label), top, item.label);
	assert.deepEqual(
		completeWecom("test x --", themes)?.map((item) => item.label),
		["--chat-type <1|2>  1 单聊，2 群聊；需同时给出 chatid，省略时为 1", "--help             显示帮助"],
	);
	const menu = wecomMenu();
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
	assert.match(errorOf("config edit --scope global -h"), /^未知选项 -h。.*--scope、--wait、--help；字段写成 字段=值$/);
	assert.deepEqual(values("-"), ["--help"]);
	assert.equal(topicHelp("--help connect"), topicHelp("connect --help"));
});

test("a bare /wecom-aibot opens the menu; options without a subcommand say where they belong, never as status", () => {
	for (const input of ["", "   ", "--"]) assert.deepEqual(parseWecomInvocation(input), { kind: "choose" }, input);
	assert.deepEqual(parseWecomInvocation("--help"), { kind: "help" });
	const messages = [errorOf("-x"), errorOf("--wait 30"), errorOf("--chat-type 2"), errorOf("--help -x")];
	assert.deepEqual(messages, [
		"未知选项 -x。查看用法：/wecom-aibot --help；选项写在子命令后面",
		"--wait 要写在子命令后面，例如 /wecom-aibot config whoami --wait 30。查看用法：/wecom-aibot --help",
		"--chat-type 要写在子命令后面，例如 /wecom-aibot test <chatid> --chat-type 2。查看用法：/wecom-aibot --help",
		"未知选项 -x。查看用法：/wecom-aibot --help；选项写在子命令后面",
	]);
	for (const message of messages) assert.doesNotMatch(message, /status/, message);
	assert.match(errorOf("--scope global"), /例如 \/wecom-aibot config show --scope global/);
	assert.match(errorOf("--connect"), /^connect 是子命令，不带 --/);
	const status = parseWecomInvocation("status");
	assert.equal(status.kind === "run" && status.command.name, "status");
	const whoami = parseWecomInvocation("--wait 30 config whoami");
	assert.equal(whoami.kind === "config" && whoami.config.action === "whoami" && whoami.config.seconds, 30);
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
		"config set --scope session screenshotTheme=light bogus=1 x",
		"config unset --scope session",
		"config global set x=1",
		"config everything",
		"--wait",
	])
		assert.ok(!errorOf(input).endsWith("。"), errorOf(input));
	assert.equal(
		errorOf("config set --scope session screenshotTheme=light bogus=1 x"),
		"未知字段 bogus；可用字段：defaultChatId、defaultChatType、notificationMode、notificationScope、screenshotTheme；「x」缺少 =，写成 字段=值。未做任何修改。查看帮助：/wecom-aibot config --help",
	);
});
