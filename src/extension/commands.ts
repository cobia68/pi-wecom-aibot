/** /wecom-aibot command table, argument parsing, help text and completion: pure functions without pi state. */
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { sentences } from "../shared/text.ts";
import {
	CONFIG_FILE,
	chatIdProblem,
	FIELDS,
	type FieldName,
	type FieldSpec,
	fieldNamed,
	type ManagedFields,
	parseAssignments,
	parseRemovals,
	SESSIONS_DIR,
	SETTABLE,
} from "./config.ts";

export const WHOAMI_WAIT_SECONDS = 300;

const SCOPES = ["global", "session"] as const;
export type ConfigScope = (typeof SCOPES)[number];

interface WeComOption {
	name: string;
	value: string;
	description: string;
	choices?: readonly (readonly [value: string, description: string])[];
	/** The option written where it belongs, without its value: shown when it is given without a subcommand. */
	example: string;
}

export interface WeComCommand {
	name: string;
	usage: string;
	description: string;
	maxArgs: number;
	argsHint?: string;
	options: WeComOption[];
	details: string[];
}

/** `config` has a grammar of its own (action, --scope, 字段=值), parsed by parseConfigArgs. */
const CONFIG_COMMAND: WeComCommand = {
	name: "config",
	usage: "config <动作> [--scope <global|session>] [字段=值 …]",
	description: "查看或修改配置：机器人凭据、默认推送目标、通知与截图设置",
	maxArgs: 0,
	options: [
		{
			name: "scope",
			value: "<global|session>",
			description: "global 为全局配置，session 为当前 session 的覆盖；edit、set、unset 必填",
			choices: [
				["global", "全局配置"],
				["session", "当前 session 的覆盖"],
			],
			example: "config show --scope",
		},
		{
			name: "wait",
			value: "<秒>",
			description: `只用于 whoami：最多等待的秒数，10～600，默认 ${WHOAMI_WAIT_SECONDS}`,
			example: "config whoami --wait",
		},
	],
	details: [
		"两层配置：global 是全局默认，session 是当前 pi 会话的显式覆盖。优先级：内置默认值 < global < session",
		"写操作必须写明 --scope global 或 --scope session，位置不限；不写作用域时只读：show 显示合并结果，whoami 只识别不保存",
		"set 写成 字段=值，可一次给多个：先全部校验再一次保存，有错误时一项都不写",
		"botId 与 secret、defaultChatId 与 defaultChatType 各为一组，成组保存、成组删除。botId、secret 只能用 edit 输入（命令会留在输入历史中）；输入时屏幕上会显示 Secret",
		"whoami：在要识别的聊天里把 pi 显示的 6 位验证码发给机器人（群聊需 @机器人）。识别不受白名单限制；没有接入时临时连接，不出现在在线会话列表，也不接收任务",
		"保存配置不会断开或重连：通知设置下次使用时生效，凭据、默认目标或白名单要运行 /wecom-aibot connect 才切换；每个 session 都需手动 /wecom-aibot connect",
		"allowedUserIds（允许发任务的企微 userid 列表）不由 config 管理，请直接编辑全局配置文件",
	],
};

const WECOM_COMMANDS: WeComCommand[] = [
	{
		name: "status",
		usage: "status",
		description: "查看当前 pi 的接入状态、会话来源和配置路径",
		maxArgs: 0,
		options: [],
		details: [],
	},
	CONFIG_COMMAND,
	{
		name: "connect",
		usage: "connect",
		description: "当前 session 接入企微",
		maxArgs: 0,
		options: [],
		details: [
			"重新读取配置，仅连接当前 session，不修改配置；接入配置不变时保留当前任务和待发通知",
			"BotID、Secret 和默认推送目标必须齐全；目标可用 /wecom-aibot config whoami --scope <global|session> 识别保存，也可用 /wecom-aibot config set --scope <global|session> defaultChatId=<ID> 填写",
			"注册与企微订阅均成功后，按通知方式向默认目标发送一次可引用的会话入口通知；已在线重复 connect、网络自动重连不重复发送，通知失败不撤销连接",
			"每个 session 都需手动 /wecom-aibot connect，包括新建、恢复、分叉和重载；退出或切换会话时自动断开",
			"凭据、白名单或默认目标变化后，connect 经确认撤销旧注册及其待处理工作；没有交互界面且有待处理工作时拒绝切换",
		],
	},
	{
		name: "disconnect",
		usage: "disconnect",
		description: "当前 session 断开接入",
		maxArgs: 0,
		options: [],
		details: [
			"取消当前 pi 的转发队列和待发通知，已开始的本地任务继续运行",
			"不修改配置；其他 pi 继续接入",
			"连接状态不会保存或继承；每个 session 都需手动 /wecom-aibot connect",
		],
	},
	{
		name: "test",
		usage: "test [chatid] [--chat-type <1|2>]",
		description: "发送一条部署测试通知",
		maxArgs: 1,
		argsHint: "聊天类型用 --chat-type 给出，例如 /wecom-aibot test your-group-chatid --chat-type 2",
		options: [
			{
				name: "chat-type",
				value: "<1|2>",
				description: "1 单聊，2 群聊；需同时给出 chatid，省略时为 1",
				choices: [
					["1", "单聊"],
					["2", "群聊"],
				],
				example: "test <chatid> --chat-type",
			},
		],
		details: [
			"省略 chatid 时发到当前接入的默认推送目标",
			"需要正式 connect；测试通知与其他通知一样跟随通知方式，screenshot 为当前终端截图",
		],
	},
	{ name: "log", usage: "log", description: "查看最近 20 条日志", maxArgs: 0, options: [], details: [] },
	{
		name: "reset",
		usage: "reset",
		description: "确认后删除全局配置文件，并停止当前 pi 的接入",
		maxArgs: 0,
		options: [],
		details: [
			"删除同一 pi 用户目录共用的全局配置文件：BotID、Secret、默认推送目标、通知设置和白名单一起删除。各 session 的覆盖文件保留",
			"需要交互确认，没有界面时不删除。只停止当前 pi 的接入；其他 pi 若已连接，仍会继续接收，直到它们各自 disconnect 或退出",
		],
	},
];

const MOVED: Record<string, string> = { whoami: "config whoami" };

export type ConfigInvocation =
	/** No action given: list the forms, all of them or one scope's. */
	| { action: "choose"; scope?: ConfigScope }
	| { action: "show"; scope?: ConfigScope }
	| { action: "edit"; scope: ConfigScope }
	| { action: "set"; scope: ConfigScope; set: Partial<ManagedFields> }
	| { action: "unset"; scope: ConfigScope; remove: FieldName[] }
	/** Identify a chat by its one-time code; with a scope, save it as that layer's default target. */
	| { action: "whoami"; scope?: ConfigScope; seconds: number };

/** The forms of config in menu order; one with `args` is put in the editor to be completed, not run. */
export type ConfigSubcommand = { usage: string; description: string; scope?: ConfigScope } & (
	| { run: ConfigInvocation }
	| { args: string }
);

const CONFIG_SUBCOMMANDS: readonly ConfigSubcommand[] = [
	{
		usage: "show",
		description: "查看当前 session 合并后的配置，并标明每项来自 session、global 或内置默认值",
		run: { action: "show" },
	},
	{
		usage: "show --scope global",
		description: "查看全局显式保存的配置",
		scope: "global",
		run: { action: "show", scope: "global" },
	},
	{
		usage: "show --scope session",
		description: "查看当前 session 显式保存的覆盖项",
		scope: "session",
		run: { action: "show", scope: "session" },
	},
	{
		usage: "edit --scope global",
		description: "交互编辑全局配置；还没有凭据时引导填写 BotID、Secret 和默认推送目标",
		scope: "global",
		run: { action: "edit", scope: "global" },
	},
	{
		usage: "edit --scope session",
		description: "交互编辑当前 session 的覆盖项",
		scope: "session",
		run: { action: "edit", scope: "session" },
	},
	{ usage: "set --scope global", args: "字段=值 …", description: "修改全局字段", scope: "global" },
	{ usage: "set --scope session", args: "字段=值 …", description: "修改当前 session 的覆盖项", scope: "session" },
	{
		usage: "unset --scope global",
		args: "字段 …",
		description: "删除全局字段，回到内置默认值",
		scope: "global",
	},
	{
		usage: "unset --scope session",
		args: "字段 …",
		description: "删除 session 覆盖，重新继承全局值或内置默认值",
		scope: "session",
	},
	{
		usage: "whoami",
		description: "发验证码识别聊天，只显示 chatid、chat_type 和 userid",
		run: { action: "whoami", seconds: WHOAMI_WAIT_SECONDS },
	},
	{
		usage: "whoami --scope global",
		description: "识别聊天，设为全局默认推送目标",
		scope: "global",
		run: { action: "whoami", scope: "global", seconds: WHOAMI_WAIT_SECONDS },
	},
	{
		usage: "whoami --scope session",
		description: "识别聊天，设为当前 session 的默认推送目标",
		scope: "session",
		run: { action: "whoami", scope: "session", seconds: WHOAMI_WAIT_SECONDS },
	},
];

const CONFIG_ACTION_ROWS: [usage: string, description: string][] = [
	["show [--scope <global|session>]", "查看配置；不写作用域时显示合并结果并标明来源"],
	["edit --scope <global|session>", "交互编辑一层；还没有凭据时引导填写 BotID、Secret 和默认推送目标"],
	["set --scope <global|session> 字段=值 …", "修改字段，未给出的字段保持不变"],
	["unset --scope <global|session> 字段 …", "删除字段，重新继承下一层；关联组整组删除"],
	["whoami [--scope <global|session>]", "发验证码识别聊天；写了作用域时确认后设为这一层的默认推送目标"],
];
const CONFIG_ACTIONS = ["show", "edit", "set", "unset", "whoami"];

export function configSubcommands(scope?: ConfigScope): readonly ConfigSubcommand[] {
	return CONFIG_SUBCOMMANDS.filter((item) => !scope || item.scope === scope);
}

export function subcommandUsage(item: ConfigSubcommand): string {
	return "args" in item ? `${item.usage} ${item.args}` : item.usage;
}

export function configSubcommandLines(scope?: ConfigScope): string[] {
	return alignedRows(configSubcommands(scope).map((item) => [subcommandUsage(item), item.description]));
}

export type WeComInvocation =
	| { kind: "help"; topic?: WeComCommand }
	| { kind: "choose" }
	| { kind: "run"; command: WeComCommand; args: string[]; options: Map<string, string> }
	| { kind: "config"; config: ConfigInvocation }
	| { kind: "error"; message: string };

const HELP_OPTION: WeComOption = { name: "help", value: "", description: "显示帮助", example: "<子命令> --help" };

/** Option names are checked against every command; values are validated later. */
function scanWecomArgs(input: string): {
	positional: string[];
	options: Map<string, string>;
	unknown: string[];
	help: boolean;
	error?: string;
} {
	const known = new Set(WECOM_COMMANDS.flatMap((command) => command.options.map((option) => option.name)));
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	const positional: string[] = [];
	const options = new Map<string, string>();
	const unknown: string[] = [];
	let help = false;
	let optionsEnded = false;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (optionsEnded) {
			positional.push(token);
			continue;
		}
		if (token === "--") {
			optionsEnded = true;
			continue;
		}
		if (token === "--help") {
			help = true;
			continue;
		}
		const option = /^--([^=]+)(?:=(.*))?$/.exec(token);
		if (option && known.has(option[1].toLowerCase())) {
			const name = option[1].toLowerCase();
			let value = option[2];
			if (value === undefined && tokens[i + 1] !== undefined && !tokens[i + 1].startsWith("-")) value = tokens[++i];
			if (!value) {
				return {
					positional,
					options,
					unknown,
					help,
					error: `--${name} 缺少值；写成 --${name} <值>，值以 - 开头时写成 --${name}=<值>`,
				};
			}
			if (options.has(name)) return { positional, options, unknown, help, error: `--${name} 重复给出` };
			options.set(name, value);
			continue;
		}
		if (token.startsWith("-") && token.length > 1) {
			unknown.push(token);
			continue;
		}
		positional.push(token);
	}
	return { positional, options, unknown, help };
}

type Scan = ReturnType<typeof scanWecomArgs>;

function commandNamed(name: string | undefined): WeComCommand | undefined {
	return name === undefined ? undefined : WECOM_COMMANDS.find((command) => command.name === name.toLowerCase());
}

export function parseWecomInvocation(input: string): WeComInvocation {
	const scan = scanWecomArgs(input);
	if (scan.error) return { kind: "error", message: scan.error };
	for (const token of scan.unknown) {
		const action = commandNamed(token.replace(/^--?/, ""));
		if (action)
			return {
				kind: "error",
				message: sentences(
					`${action.name} 是子命令，不带 --；请使用 /wecom-aibot ${action.name}`,
					`查看用法用 /wecom-aibot ${action.name} --help`,
				),
			};
	}
	if (scan.positional[0] === undefined) return bareInvocation(scan);
	const command = commandNamed(scan.positional[0]);
	if (!command) {
		const moved = MOVED[scan.positional[0].toLowerCase()];
		return {
			kind: "error",
			message: moved
				? `${scan.positional[0]} 已移到 config 下：/wecom-aibot ${moved}`
				: "未知子命令，请使用 /wecom-aibot --help 查看用法",
		};
	}
	if (command === CONFIG_COMMAND) {
		const misplaced = [
			...scan.unknown,
			...[...scan.options.keys()]
				.filter((name) => !command.options.some((option) => option.name === name))
				.map((name) => `--${name}`),
		][0];
		if (misplaced) return { kind: "error", message: configOptionProblem(misplaced) };
		if (scan.help) return { kind: "help", topic: command };
		return parseConfigArgs(scan.positional.slice(1), scan.options);
	}
	if (scan.unknown.length) {
		const positional = command.maxArgs ? "位置参数以 - 开头时，先用单独的 -- 分隔" : "";
		return {
			kind: "error",
			message: sentences(
				`未知选项 ${scan.unknown[0]}`,
				supportedOptions(command),
				"子命令（如 connect）不带 --",
				positional,
			),
		};
	}
	if (scan.help) return { kind: "help", topic: command };
	const args = scan.positional.slice(1);
	for (const option of scan.options.keys()) {
		if (!command.options.some((item) => item.name === option))
			return { kind: "error", message: sentences(`${command.name} 不支持 --${option}`, supportedOptions(command)) };
	}
	if (args.length > command.maxArgs) {
		const action = command.maxArgs ? undefined : commandNamed(args[0]);
		const hint = action
			? `${command.name} 后面不能再接其他动作，${action.name} 请单独运行`
			: (command.argsHint ?? `用法：/wecom-aibot ${command.usage}`);
		return { kind: "error", message: sentences("参数过多", hint, `查看帮助：/wecom-aibot ${command.name} --help`) };
	}
	const invalid = invalidOptionValues(command, args, scan.options);
	if (invalid) return { kind: "error", message: sentences(invalid, `查看帮助：/wecom-aibot ${command.name} --help`) };
	return { kind: "run", command, args, options: scan.options };
}

/** A bare invocation never stands for status. */
function bareInvocation(scan: Scan): WeComInvocation {
	if (scan.unknown.length)
		return {
			kind: "error",
			message: sentences(`未知选项 ${scan.unknown[0]}`, "查看用法：/wecom-aibot --help；选项写在子命令后面"),
		};
	if (scan.help) return { kind: "help" };
	const [name, value] = [...scan.options][0] ?? [];
	if (name === undefined) return { kind: "choose" };
	const option = WECOM_COMMANDS.flatMap((command) => command.options).find((item) => item.name === name);
	return {
		kind: "error",
		message: sentences(
			`--${name} 要写在子命令后面${option ? `，例如 /wecom-aibot ${option.example} ${value}` : ""}`,
			"查看用法：/wecom-aibot --help",
		),
	};
}

function configOptionProblem(token: string): string {
	const name = token.replace(/^--?/, "").split("=")[0];
	const lower = name.toLowerCase();
	if (isScope(lower)) return `未知选项 ${token}。作用域写成 --scope ${lower}`;
	if (CONFIG_ACTIONS.includes(lower)) return `${lower} 是动作，不带 --：/wecom-aibot config ${lower}`;
	const field = fieldNamed(name);
	if (field) return `字段写成 ${field.name}=…，不用 --`;
	return sentences(`未知选项 ${token}`, `${supportedOptions(CONFIG_COMMAND)}；字段写成 字段=值`);
}

function isScope(word: string | undefined): word is ConfigScope {
	return SCOPES.includes(word as ConfigScope);
}

function parseConfigArgs(args: string[], options: Map<string, string>): WeComInvocation {
	const error = (message: string): WeComInvocation => ({
		kind: "error",
		message: sentences(message, "查看帮助：/wecom-aibot config --help"),
	});
	const rejected = (problems: string[]) =>
		error(sentences(problems.map((problem) => problem.replace(/。$/, "")).join("；"), "未做任何修改"));
	const words = args.map((arg) => arg.toLowerCase());
	const given = options.get("scope")?.toLowerCase();
	if (given !== undefined && !isScope(given)) return error("--scope 只能是 global 或 session");
	const scope = given as ConfigScope | undefined;
	// The earlier spelling with the scope as a word, `config global set …` or `config set global …`: say the new one.
	if (scope === undefined) {
		const at = isScope(words[0]) ? 0 : isScope(words[1]) ? 1 : -1;
		if (at >= 0) {
			const rest = args.filter((_, index) => index !== at);
			const head = rest[0]?.toLowerCase() ?? "";
			const spelled = !rest.length
				? ["--scope", words[at]]
				: CONFIG_ACTIONS.includes(head)
					? [head, "--scope", words[at], ...rest.slice(1)]
					: ["<动作>", "--scope", words[at]];
			return error(`作用域改为 --scope：/wecom-aibot config ${spelled.join(" ")}`);
		}
	}
	const [action] = words;
	const values = args.slice(1);
	const wait = options.get("wait");
	if (wait !== undefined && action !== "whoami")
		return error("--wait 只用于 whoami，例如 /wecom-aibot config whoami --wait 300");
	// Only a given scope is part of the result: reading without one is a different request, not an empty scope.
	const scoped = scope ? { scope } : {};
	if (action === undefined) return { kind: "config", config: { action: "choose", ...scoped } };
	if (!CONFIG_ACTIONS.includes(action)) return error(`未知动作 ${args[0]}；可用 show、edit、set、unset、whoami`);
	const needsScope = (example: string) =>
		error(`${action} 需要 --scope：/wecom-aibot config ${action} --scope session${example}，或 --scope global`);
	switch (action) {
		case "show":
			return values.length ? error("config show 不接受参数") : { kind: "config", config: { action, ...scoped } };
		case "edit":
			if (values.length) return error("config edit 不接受参数");
			return scope ? { kind: "config", config: { action, scope } } : needsScope("");
		case "set": {
			if (!scope) return needsScope(values.length ? ` ${values.join(" ")}` : " screenshotTheme=light");
			if (!values.length)
				return error(
					`set 需要至少一个 字段=值，例如 /wecom-aibot config set --scope ${scope} screenshotTheme=light`,
				);
			const parsed = parseAssignments(values);
			return "problems" in parsed
				? rejected(parsed.problems)
				: { kind: "config", config: { action, scope, set: parsed.set } };
		}
		case "unset": {
			if (!scope) return needsScope(values.length ? ` ${values.join(" ")}` : " screenshotTheme");
			if (!values.length)
				return error(`unset 需要字段名，例如 /wecom-aibot config unset --scope ${scope} screenshotTheme`);
			const parsed = parseRemovals(values);
			return "problems" in parsed
				? rejected(parsed.problems)
				: { kind: "config", config: { action, scope, remove: parsed.remove } };
		}
		default: {
			if (values.length) return error("config whoami 不接受参数");
			if (wait !== undefined && (!/^\d+$/.test(wait) || Number(wait) < 10 || Number(wait) > 600))
				return error("--wait 须为 10～600 的整数秒，例如 --wait 300");
			return {
				kind: "config",
				config: { action: "whoami", ...scoped, seconds: wait === undefined ? WHOAMI_WAIT_SECONDS : Number(wait) },
			};
		}
	}
}

function supportedOptions(command: WeComCommand): string {
	const names = command.options.map((option) => `--${option.name}`);
	const usage = `/wecom-aibot ${command.name}`;
	return names.length
		? `${usage} 支持的选项：${[...names, "--help"].join("、")}`
		: `${usage} 不接受选项，用法：${usage}`;
}

/** Value checks, so a command never starts with a value it would reject halfway. */
function invalidOptionValues(command: WeComCommand, args: string[], options: Map<string, string>): string | undefined {
	const chatType = options.get("chat-type");
	if (chatType !== undefined && chatType !== "1" && chatType !== "2")
		return "--chat-type 只能是 1（单聊）或 2（群聊）";
	const chatId = command.name === "test" ? args[0] : undefined;
	const problem = chatId === undefined ? undefined : chatIdProblem(chatId);
	if (problem) return problem;
	if (chatType !== undefined && chatId === undefined)
		return `--chat-type 需要和 chatid 一起使用，例如 /wecom-aibot ${command.name} your-group-chatid --chat-type 2`;
	return undefined;
}

function alignedRows(rows: [string, string][]): string[] {
	const width = Math.max(0, ...rows.map(([key]) => visibleWidth(key)));
	const gap = " ".repeat(width + 2);
	return rows.flatMap(([key, value]) => {
		const [first, ...rest] = value.split("\n");
		const head = first ? `  ${key}${" ".repeat(width - visibleWidth(key))}  ${first}` : `  ${key}`;
		return [head, ...rest.map((line) => `  ${gap}${line}`)];
	});
}

/** Width is taken over the whole list, so filtering it keeps the column still. */
export function columns(rows: readonly (readonly [name: string, description: string])[]): string[] {
	const width = Math.max(0, ...rows.map(([name]) => visibleWidth(name)));
	return rows.map(([name, description]) =>
		description ? `${name}${" ".repeat(width - visibleWidth(name))}  ${description}` : name,
	);
}

function section(title: string, body: string[]): string[] {
	return ["", title, ...body];
}

function hasOptionsOrArgs(command: WeComCommand): boolean {
	return command.options.length > 0 || command.maxArgs > 0 || command === CONFIG_COMMAND;
}

function configPaths(): string[] {
	return alignedRows([
		["配置文件", CONFIG_FILE],
		["会话覆盖", join(SESSIONS_DIR, "<session-id>.json")],
	]);
}

export function wecomHelpText(topic?: WeComCommand): string {
	if (topic === CONFIG_COMMAND) return configHelpText();
	return topic ? topicHelpText(topic) : totalHelpText();
}

function totalHelpText(): string {
	return [
		"企业微信智能机器人 — /wecom-aibot 命令帮助",
		"用法：/wecom-aibot [子命令] [参数] [--选项 值]",
		...section("子命令", [
			...alignedRows(WECOM_COMMANDS.map((command) => [command.name, command.description])),
			"",
			"  不带子命令时弹出子命令菜单",
			"  子命令的用法与选项：/wecom-aibot <子命令> --help（只显示帮助，不执行动作）",
			"  企微侧另有 sessions、send、screen、cancel，在企微中发 /wecom-aibot --help 查看",
		]),
		...section("配置", [...configPaths(), "  字段、作用域与示例：/wecom-aibot config --help"]),
		...section("生命周期", [
			"  connect、disconnect 只控制当前 session，不修改配置",
			"  config 只保存配置，不正式接入也不断开；whoami 识别时会临时连接",
			"  每个 session 都需手动 /wecom-aibot connect",
			"  退出、切换、新建、恢复、分叉或重载会话时自动断开，连接状态不继承",
		]),
	].join("\n");
}

function optionRows(command: WeComCommand): string[] {
	const rows: [string, string][] = command.options.map((option) => [
		`--${option.name} ${option.value}`.trim(),
		option.description,
	]);
	rows.push(["--help", "显示当前命令的帮助，不执行动作"]);
	if (command.maxArgs) rows.push(["--", "结束选项解析，后面的值都作为位置参数"]);
	return alignedRows(rows);
}

function topicHelpText(topic: WeComCommand): string {
	const lines = [`${topic.name} — ${topic.description}`, `用法：/wecom-aibot ${topic.usage}`];
	if (topic.details.length)
		lines.push(
			...section(
				"说明",
				topic.details.map((detail) => `  ${detail}`),
			),
		);
	if (hasOptionsOrArgs(topic)) lines.push(...section("选项", optionRows(topic)));
	if (topic.name === "test")
		lines.push(
			...section("推送目标", [
				...alignedRows([["chatid", "单聊填企微 userid，群聊填群 chatid；与 pi 的 session ID 是不同的标识"]]),
				"  不清楚 chatid：运行 /wecom-aibot config whoami，再把显示的验证码发给机器人（群聊需 @机器人）",
				"  示例",
				"    /wecom-aibot test your-userid",
				"    /wecom-aibot test your-group-chatid --chat-type 2",
			]),
		);
	// Only the help of the command that deletes the file names it; /wecom-aibot status shows the paths too.
	if (topic.name === "reset") lines.push(...section("配置", configPaths()));
	return lines.join("\n");
}

function configHelpText(): string {
	const command = CONFIG_COMMAND;
	return [
		`${command.name} — ${command.description}`,
		`用法：/wecom-aibot ${command.usage}`,
		...section(
			"说明",
			command.details.map((detail) => `  ${detail}`),
		),
		...section("动作", alignedRows(CONFIG_ACTION_ROWS)),
		...section("字段", alignedRows(FIELDS.map((spec) => [spec.name, fieldText(spec)]))),
		...section("选项", optionRows(command)),
		...section("示例", [
			"  /wecom-aibot config edit --scope global",
			"  /wecom-aibot config set --scope session screenshotTheme=light",
			"  /wecom-aibot config set --scope global notificationMode=screenshot notificationScope=all-runs",
			"  /wecom-aibot config unset --scope session defaultChatId",
			"  /wecom-aibot config whoami --scope global",
		]),
		...section("配置", configPaths()),
	].join("\n");
}

function fieldText(spec: FieldSpec): string {
	const choices = (spec.choices ?? []).map(
		(choice) => `${choice.value}：${choice.description}${choice.value === spec.default ? "（默认）" : ""}`,
	);
	const label = spec.label.toLowerCase() === spec.name.toLowerCase() ? "" : `${spec.label}：`;
	return [`${label}${spec.description}`, ...choices].join("\n");
}

interface Candidate {
	value: string;
	name?: string;
	description: string;
}

/**
 * Each returned value replaces all text after "/wecom-aibot ". Options are offered only after `-`, and a
 * complete token gets no list, so Enter runs the command instead of applying a completion.
 */
export function completeWecom(
	prefix: string,
	themes: () => readonly string[],
): { value: string; label: string }[] | null {
	const tokens = prefix.trimStart().split(/\s+/);
	const current = (tokens.pop() ?? "").toLowerCase();
	const head = tokens.length ? `${tokens.join(" ")} ` : "";
	const offer = (all: readonly Candidate[]) => {
		const labels = columns(all.map((item) => [item.name ?? item.value, item.description] as const));
		const shown = all.flatMap((item, index) =>
			item.value.toLowerCase().startsWith(current) ? [{ value: item.value, label: labels[index] }] : [],
		);
		return shown.length && !shown.some((item) => item.value.trim().toLowerCase() === current)
			? shown.map((item) => ({ ...item, value: head + item.value }))
			: null;
	};
	if (!tokens.length) return offer(topLevel());
	const command = commandNamed(tokens[0]);
	if (!command) return null;
	const words = positionals(command, tokens.slice(1));
	const previous = tokens.at(-1)?.toLowerCase();
	const pending = command.options.find((option) => previous === `--${option.name}`);
	if (pending)
		return pending.choices ? offer(pending.choices.map(([value, description]) => ({ value, description }))) : null;
	if (!current.startsWith("-"))
		return command === CONFIG_COMMAND ? offer(configCandidates(words, current, themes)) : null;
	const used = new Set(
		tokens.filter((token) => token.startsWith("--")).map((token) => token.slice(2).split("=")[0].toLowerCase()),
	);
	const options = [...applicableOptions(command, words), ...(hasOptionsOrArgs(command) ? [HELP_OPTION] : [])].filter(
		(option) => !used.has(option.name),
	);
	return offer(
		options.map((option) => ({
			value: option.value ? `--${option.name} ` : `--${option.name}`,
			name: `--${option.name}${option.value ? ` ${option.value}` : ""}`,
			description: option.description,
		})),
	);
}

function applicableOptions(command: WeComCommand, words: string[]): WeComOption[] {
	if (command !== CONFIG_COMMAND) return command.options;
	const action = words[0]?.toLowerCase();
	if (!action || !CONFIG_ACTIONS.includes(action)) return [];
	return command.options.filter((option) => option.name !== "wait" || action === "whoami");
}

function positionals(command: WeComCommand, tokens: string[]): string[] {
	const words: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.startsWith("-")) {
			const takesValue = command.options.some((option) => token.toLowerCase() === `--${option.name}`);
			if (takesValue) i++;
			continue;
		}
		words.push(token);
	}
	return words;
}

function topLevel(): Candidate[] {
	return [
		...WECOM_COMMANDS.map((command) => ({ value: command.name, description: command.description })),
		{ value: "--help", description: HELP_OPTION.description },
	];
}

export function wecomMenu(): { label: string; input: string }[] {
	const items = topLevel();
	const labels = columns(items.map((item) => [item.value, item.description] as const));
	return items.map((item, index) => ({ label: labels[index], input: item.value }));
}

function configCandidates(words: string[], current: string, themes: () => readonly string[]): Candidate[] {
	const [action, ...rest] = words.map((word) => word.toLowerCase());
	const candidates = (items: [value: string, description: string][]): Candidate[] =>
		items.map(([value, description]) => ({ value, description }));
	if (action === undefined)
		return candidates([
			["show", "查看配置"],
			["edit", "交互编辑一层"],
			["set", "修改字段：字段=值"],
			["unset", "删除字段，重新继承"],
			["whoami", "发验证码识别聊天"],
		]);
	const used = new Set(rest.map((word) => word.split("=")[0]));
	if (action === "set") {
		const equals = current.indexOf("=");
		const spec = equals < 0 ? undefined : fieldNamed(current.slice(0, equals));
		if (spec) {
			const values: [string, string][] =
				spec.name === "screenshotTheme"
					? themes().map((name): [string, string] => [name, "pi 主题"])
					: (spec.choices ?? []).map((choice): [string, string] => [String(choice.value), choice.description]);
			return candidates(
				values.map(([value, description]): [string, string] => [`${spec.name}=${value}`, description]),
			);
		}
		return candidates(
			FIELDS.filter((item) => SETTABLE.includes(item.name) && !used.has(item.name.toLowerCase())).map(
				(item): [string, string] => [`${item.name}=`, item.label],
			),
		);
	}
	if (action === "unset")
		return candidates(
			FIELDS.filter((item) => !used.has(item.name.toLowerCase())).map((item): [string, string] => [
				item.name,
				item.label,
			]),
		);
	return [];
}
