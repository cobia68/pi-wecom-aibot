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
	type PromptsEdit,
	parseAssignments,
	parseRemovals,
	SESSIONS_DIR,
	SETTABLE,
} from "./config.ts";

export const WHOAMI_WAIT_SECONDS = 300;

const SCOPES = ["global", "session"] as const;
export type ConfigScope = (typeof SCOPES)[number];

interface OptionSpec {
	name: string;
	value: string;
	description: string;
	choices?: readonly (readonly [value: string, description: string])[];
	/** The option written where it belongs, `{}` standing for its value: shown when it is given without a subcommand. */
	example: string;
}

export interface CommandSpec {
	name: string;
	usage: string;
	description: string;
	maxArgs: number;
	argsHint?: string;
	options: OptionSpec[];
	details: string[];
}

/** `config` has a grammar of its own (--scope, action, 字段=值), parsed by parseConfigArgs. */
const CONFIG_COMMAND: CommandSpec = {
	name: "config",
	usage: "config [--scope <global|session>] <动作> [字段=值 …]",
	description: "查看或修改配置：机器人凭据、默认推送目标、通知与控制卡设置",
	maxArgs: 0,
	options: [
		{
			name: "scope",
			value: "<global|session>",
			description: "写在动作前：global 全局配置，session 当前 session 的覆盖；edit、set、unset 必填",
			choices: [
				["global", "全局配置"],
				["session", "当前 session 的覆盖"],
			],
			example: "config --scope {} show",
		},
		{
			name: "wait",
			value: "<秒>",
			description: `只用于 whoami：最多等待的秒数，10～600，默认 ${WHOAMI_WAIT_SECONDS}`,
			example: "config whoami --wait {}",
		},
	],
	details: [
		"两层配置：global 是全局默认，session 是当前 pi 会话的显式覆盖。优先级：内置默认值 < global < session",
		"作用域是命令的目标，写在动作前：config --scope <global|session> <动作>。edit、set、unset 必须写；不写作用域时只读：show 显示合并结果，whoami 只识别不保存",
		"set 写成 字段=值，可一次给多个：先全部校验再一次保存，有错误时一项都不写。controlPrompts 还能写 controlPrompts+=新提示、controlPrompts-=旧提示，只加或只删几条",
		"botId 与 secret、defaultChatId 与 defaultChatType 各为一组，成组保存、成组删除。botId、secret 只能用 edit 输入（命令会留在输入历史中）；输入时屏幕上会显示 Secret",
		"whoami：在要识别的聊天里把 pi 显示的 6 位验证码发给机器人（群聊需 @机器人）。识别不受白名单限制；没有接入时临时连接，不出现在在线会话列表，也不接收任务",
		"保存配置不会断开或重连：通知范围、控制卡提示词等设置下次使用时生效，凭据、默认目标或白名单要运行 /wecom-aibot connect 才切换；每个 session 都需手动 /wecom-aibot connect",
		"allowedUserIds（允许发任务的企微 userid 列表）不由 config 管理，请直接编辑全局配置文件",
	],
};

const COMMANDS: CommandSpec[] = [
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
			"BotID、Secret 和默认推送目标必须齐全；目标可用 /wecom-aibot config --scope <global|session> whoami 识别保存，也可用 /wecom-aibot config --scope <global|session> set defaultChatId=<ID> 填写",
			"注册与企微订阅均成功后，为默认聊天创建或复用本 session 的控制卡；重复接入、恢复同一 session 或网络重连不重发，卡片失败不撤销连接",
			"控制卡只在点击后刷新；找不到旧卡时，在企微发 /wecom-aibot sessions，选择会话后点「打开会话」补发",
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
				example: "test <chatid> --chat-type {}",
			},
		],
		details: [
			"省略 chatid 时发到当前接入的默认推送目标",
			"需要正式 connect；发一张部署测试用的控制卡，点「刷新卡片」验证按钮回调",
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

export type ConfigInvocation =
	/** No action given: list the forms, all of them or one scope's. */
	| { action: "choose"; scope?: ConfigScope }
	| { action: "show"; scope?: ConfigScope }
	| { action: "edit"; scope: ConfigScope }
	| { action: "set"; scope: ConfigScope; set: Partial<ManagedFields>; prompts?: PromptsEdit }
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
		usage: "--scope global show",
		description: "查看全局显式保存的配置",
		scope: "global",
		run: { action: "show", scope: "global" },
	},
	{
		usage: "--scope session show",
		description: "查看当前 session 显式保存的覆盖项",
		scope: "session",
		run: { action: "show", scope: "session" },
	},
	{
		usage: "--scope global edit",
		description: "交互编辑全局配置；还没有凭据时引导填写 BotID、Secret 和默认推送目标",
		scope: "global",
		run: { action: "edit", scope: "global" },
	},
	{
		usage: "--scope session edit",
		description: "交互编辑当前 session 的覆盖项",
		scope: "session",
		run: { action: "edit", scope: "session" },
	},
	{ usage: "--scope global set", args: "字段=值 …", description: "修改全局字段", scope: "global" },
	{ usage: "--scope session set", args: "字段=值 …", description: "修改当前 session 的覆盖项", scope: "session" },
	{
		usage: "--scope global unset",
		args: "字段 …",
		description: "删除全局字段，回到内置默认值",
		scope: "global",
	},
	{
		usage: "--scope session unset",
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
		usage: "--scope global whoami",
		description: "识别聊天，设为全局默认推送目标",
		scope: "global",
		run: { action: "whoami", scope: "global", seconds: WHOAMI_WAIT_SECONDS },
	},
	{
		usage: "--scope session whoami",
		description: "识别聊天，设为当前 session 的默认推送目标",
		scope: "session",
		run: { action: "whoami", scope: "session", seconds: WHOAMI_WAIT_SECONDS },
	},
];

/** The config actions: their usage and help, and the short description completion shows. */
const CONFIG_ACTION_TABLE = [
	{
		action: "show",
		usage: "[--scope <global|session>] show",
		help: "查看配置；不写作用域时显示合并结果并标明来源",
		short: "查看配置",
	},
	{
		action: "edit",
		usage: "--scope <global|session> edit",
		help: "交互编辑一层；还没有凭据时引导填写 BotID、Secret 和默认推送目标",
		short: "交互编辑一层",
	},
	{
		action: "set",
		usage: "--scope <global|session> set 字段=值 …",
		help: "修改字段，未给出的字段保持不变；controlPrompts+= / -= 只加或只删几条",
		short: "修改字段：字段=值",
	},
	{
		action: "unset",
		usage: "--scope <global|session> unset 字段 …",
		help: "删除字段，重新继承下一层；关联组整组删除",
		short: "删除字段，重新继承",
	},
	{
		action: "whoami",
		usage: "[--scope <global|session>] whoami",
		help: "发验证码识别聊天；写了作用域时确认后设为这一层的默认推送目标",
		short: "发验证码识别聊天",
	},
] as const;
const CONFIG_ACTIONS: readonly string[] = CONFIG_ACTION_TABLE.map((item) => item.action);
/** The writes: each needs a target, `config --scope <global|session> <动作>`. */
const SCOPED_ACTIONS = ["edit", "set", "unset"];

export function configSubcommands(scope?: ConfigScope): readonly ConfigSubcommand[] {
	return CONFIG_SUBCOMMANDS.filter((item) => !scope || item.scope === scope);
}

export function subcommandUsage(item: ConfigSubcommand): string {
	return "args" in item ? `${item.usage} ${item.args}` : item.usage;
}

export function configSubcommandLines(scope?: ConfigScope): string[] {
	return table(configSubcommands(scope).map((item) => [subcommandUsage(item), item.description]));
}

export type Invocation =
	| { kind: "help"; topic?: CommandSpec }
	| { kind: "choose" }
	| { kind: "run"; command: CommandSpec; args: string[]; options: Map<string, string> }
	| { kind: "config"; config: ConfigInvocation }
	| { kind: "error"; message: string };

const HELP_OPTION: OptionSpec = { name: "help", value: "", description: "显示帮助", example: "<子命令> --help" };

/** Option names are checked against every command; values are validated later. */
function scanArgs(input: string): {
	positional: string[];
	options: Map<string, string>;
	/** How many positional words came before each option: config's target goes before its action. */
	positionOf: Map<string, number>;
	unknown: string[];
	help: boolean;
	error?: string;
} {
	const known = new Set(COMMANDS.flatMap((command) => command.options.map((option) => option.name)));
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	const positional: string[] = [];
	const options = new Map<string, string>();
	const positionOf = new Map<string, number>();
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
					positionOf,
					unknown,
					help,
					error: `--${name} 缺少值；写成 --${name} <值>，值以 - 开头时写成 --${name}=<值>`,
				};
			}
			if (options.has(name)) return { positional, options, positionOf, unknown, help, error: `--${name} 重复给出` };
			options.set(name, value);
			positionOf.set(name, positional.length);
			continue;
		}
		if (token.startsWith("-") && token.length > 1) {
			unknown.push(token);
			continue;
		}
		positional.push(token);
	}
	return { positional, options, positionOf, unknown, help };
}

type Scan = ReturnType<typeof scanArgs>;

function commandNamed(name: string | undefined): CommandSpec | undefined {
	return name === undefined ? undefined : COMMANDS.find((command) => command.name === name.toLowerCase());
}

export function parseInvocation(input: string): Invocation {
	const scan = scanArgs(input);
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
	if (!command) return { kind: "error", message: "未知子命令，请使用 /wecom-aibot --help 查看用法" };
	if (command === CONFIG_COMMAND) {
		const misplaced = [
			...scan.unknown,
			...[...scan.options.keys()]
				.filter((name) => !command.options.some((option) => option.name === name))
				.map((name) => `--${name}`),
		][0];
		if (misplaced) return { kind: "error", message: configOptionProblem(misplaced) };
		if (scan.help) return { kind: "help", topic: command };
		// Counted from the word after `config`: -1 is before `config` itself, 0 is right after it.
		const after = new Map([...scan.positionOf].map(([name, at]) => [name, at - 1] as const));
		return parseConfigArgs(scan.positional.slice(1), scan.options, after);
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
function bareInvocation(scan: Scan): Invocation {
	if (scan.unknown.length)
		return {
			kind: "error",
			message: sentences(`未知选项 ${scan.unknown[0]}`, "查看用法：/wecom-aibot --help；选项写在子命令后面"),
		};
	if (scan.help) return { kind: "help" };
	const [name, value] = [...scan.options][0] ?? [];
	if (name === undefined) return { kind: "choose" };
	const option = COMMANDS.flatMap((command) => command.options).find((item) => item.name === name);
	return {
		kind: "error",
		message: sentences(
			`--${name} 要写在子命令后面${option ? `，例如 /wecom-aibot ${option.example.replace("{}", value)}` : ""}`,
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

/**
 * `config [--scope <global|session>] <动作> …`: the scope is the command's target and goes before the action, like
 * the WeCom side's `--session-id <id> <动作>`; whoami's --wait goes after it. `positionOf` counts the words after
 * `config` that came before each option.
 */
function parseConfigArgs(args: string[], options: Map<string, string>, positionOf: Map<string, number>): Invocation {
	const error = (message: string): Invocation => ({
		kind: "error",
		message: sentences(message, "查看帮助：/wecom-aibot config --help"),
	});
	const rejected = (problems: string[]) => error(sentences(problems.join("；"), "未做任何修改"));
	const words = args.map((arg) => arg.toLowerCase());
	const given = options.get("scope")?.toLowerCase();
	if (given !== undefined && !isScope(given)) return error("--scope 只能是 global 或 session");
	const scope = given as ConfigScope | undefined;
	const wait = options.get("wait");
	/** The command as it should be written: the target first, then the action and its words, then --wait. */
	const written = (target: string | undefined, rest: string[]) =>
		["/wecom-aibot config", ...(target ? ["--scope", target] : []), ...rest, ...(wait ? ["--wait", wait] : [])].join(
			" ",
		);
	const [action] = words;
	const values = args.slice(1);
	if (scope !== undefined && positionOf.get("scope") !== 0)
		return error(`--scope 要写在动作前：${written(scope, args)}`);
	if (wait !== undefined && action !== "whoami")
		return error("--wait 只用于 whoami，例如 /wecom-aibot config whoami --wait 300");
	if (wait !== undefined && (positionOf.get("wait") ?? 0) < 1)
		return error(`--wait 要写在 whoami 后：${written(scope, args)}`);
	// Only a given scope is part of the result: reading without one is a different request, not an empty scope.
	const scoped = scope ? { scope } : {};
	if (action === undefined) return { kind: "config", config: { action: "choose", ...scoped } };
	if (!CONFIG_ACTIONS.includes(action)) return error(`未知动作 ${args[0]}；可用 ${CONFIG_ACTIONS.join("、")}`);
	const needsScope = (example: string) =>
		error(`${action} 需要 --scope：/wecom-aibot config --scope session ${action}${example}，或 --scope global`);
	switch (action) {
		case "show":
			return values.length ? error("config show 不接受参数") : { kind: "config", config: { action, ...scoped } };
		case "edit":
			if (values.length) return error("config edit 不接受参数");
			return scope ? { kind: "config", config: { action, scope } } : needsScope("");
		case "set": {
			if (!scope) return needsScope(values.length ? ` ${values.join(" ")}` : " notificationScope=all-runs");
			if (!values.length)
				return error(
					`set 需要至少一个 字段=值，例如 /wecom-aibot config --scope ${scope} set notificationScope=all-runs`,
				);
			const parsed = parseAssignments(values);
			return "problems" in parsed
				? rejected(parsed.problems)
				: {
						kind: "config",
						config: { action, scope, set: parsed.set, ...(parsed.prompts ? { prompts: parsed.prompts } : {}) },
					};
		}
		case "unset": {
			if (!scope) return needsScope(values.length ? ` ${values.join(" ")}` : " notificationScope");
			if (!values.length)
				return error(`unset 需要字段名，例如 /wecom-aibot config --scope ${scope} unset notificationScope`);
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

function supportedOptions(command: CommandSpec): string {
	const names = command.options.map((option) => `--${option.name}`);
	const usage = `/wecom-aibot ${command.name}`;
	return names.length
		? `${usage} 支持的选项：${[...names, "--help"].join("、")}`
		: `${usage} 不接受选项，用法：${usage}`;
}

/** Value checks, so a command never starts with a value it would reject halfway. */
function invalidOptionValues(command: CommandSpec, args: string[], options: Map<string, string>): string | undefined {
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

/**
 * Indented name/value rows; groups share one value column, measured in terminal cells so Chinese names align,
 * and are parted by a blank line. A value's later lines stay under its first.
 */
export function table(...groups: [string, string][][]): string[] {
	const shown = groups.filter((rows) => rows.length);
	const width = Math.max(0, ...shown.flat().map(([name]) => visibleWidth(name)));
	const gap = " ".repeat(width + 2);
	return shown.flatMap((rows, index) => [
		...(index ? [""] : []),
		...rows.flatMap(([name, value]) => {
			const [first, ...rest] = value.split("\n");
			const head = first ? `  ${name}${" ".repeat(width - visibleWidth(name))}  ${first}` : `  ${name}`;
			return [head, ...rest.map((line) => `  ${gap}${line}`)];
		}),
	]);
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

function hasOptionsOrArgs(command: CommandSpec): boolean {
	return command.options.length > 0 || command.maxArgs > 0;
}

function configPaths(): string[] {
	return table([
		["配置文件", CONFIG_FILE],
		["会话覆盖", join(SESSIONS_DIR, "<session-id>.json")],
	]);
}

export function helpText(topic?: CommandSpec): string {
	if (topic === CONFIG_COMMAND) return configHelpText();
	return topic ? topicHelpText(topic) : totalHelpText();
}

function totalHelpText(): string {
	return [
		"企业微信智能机器人 — /wecom-aibot 命令帮助",
		"用法：/wecom-aibot [子命令] [参数] [--选项 值]",
		...section("子命令", [
			...table(COMMANDS.map((command) => [command.name, command.description])),
			"",
			"  不带子命令时弹出子命令菜单",
			"  子命令的用法与选项：/wecom-aibot <子命令> --help（只显示帮助，不执行动作）",
			"  企微侧另有 sessions、send、card、screen、cancel",
			"  在企微中发 /wecom-aibot --help 查看",
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

function optionRows(command: CommandSpec): string[] {
	const rows: [string, string][] = command.options.map((option) => [
		`--${option.name} ${option.value}`.trim(),
		option.description,
	]);
	rows.push(["--help", "显示当前命令的帮助，不执行动作"]);
	if (command.maxArgs) rows.push(["--", "结束选项解析，后面的值都作为位置参数"]);
	return table(rows);
}

function topicHelpText(topic: CommandSpec): string {
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
				...table([["chatid", "单聊填企微 userid，群聊填群 chatid；与 pi 的 session ID 是不同的标识"]]),
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
		...section("动作", table(CONFIG_ACTION_TABLE.map((item): [string, string] => [item.usage, item.help]))),
		...section("字段", table(FIELDS.map((spec) => [spec.name, fieldText(spec)]))),
		...section("选项", optionRows(command)),
		...section("示例", [
			"  /wecom-aibot config --scope global edit",
			"  /wecom-aibot config --scope global set notificationScope=all-runs",
			"  /wecom-aibot config --scope session set controlPrompts=继续,运行测试,总结进度",
			"  /wecom-aibot config --scope global set controlPrompts+=部署到测试环境",
			"  /wecom-aibot config --scope global set controlPrompts-=运行测试",
			"  /wecom-aibot config --scope session unset defaultChatId",
			"  /wecom-aibot config --scope global whoami",
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
	/** An option that still needs its value, so a space always follows it. */
	takesValue?: boolean;
}

/**
 * Each returned value replaces all text after "/wecom-aibot ". Every word that may come next is offered, and
 * one that can be followed gets its trailing space, so the next Tab goes a level deeper. A complete token gets
 * no list, so Enter runs the command instead of applying a completion. `prompts` reads the list a scope uses
 * now, for controlPrompts-=.
 */
export function completeArguments(
	prefix: string,
	prompts: (scope: ConfigScope) => readonly string[] = () => [],
): { value: string; label: string }[] | null {
	const tokens = prefix.trimStart().split(/\s+/);
	const current = (tokens.pop() ?? "").toLowerCase();
	const head = tokens.length ? `${tokens.join(" ")} ` : "";
	const all = candidatesAt(tokens, current, prompts);
	const labels = columns(all.map((item) => [item.name ?? item.value, item.description] as const));
	const shown = all.flatMap((item, index) =>
		item.value.toLowerCase().startsWith(current) ? [{ item, label: labels[index] }] : [],
	);
	if (!shown.length || shown.some(({ item }) => item.value.toLowerCase() === current)) return null;
	const spaced = (item: Candidate) =>
		item.takesValue || (!item.value.endsWith("=") && candidatesAt([...tokens, item.value], "", prompts).length > 0);
	return shown.map(({ item, label }) => ({ value: `${head}${item.value}${spaced(item) ? " " : ""}`, label }));
}

/** The words that may follow `tokens`: config's target, positionals, options, then --help. */
function candidatesAt(
	tokens: string[],
	current: string,
	prompts: (scope: ConfigScope) => readonly string[],
): Candidate[] {
	if (!tokens.length) return topLevel();
	const command = commandNamed(tokens[0]);
	const rest = tokens.slice(1).map((token) => token.toLowerCase());
	if (!command || rest.includes("--help")) return [];
	const pending = command.options.find((option) => rest.at(-1) === `--${option.name}`);
	// config's --scope takes a value only right after `config`; written later it is refused when run.
	if (pending && command === CONFIG_COMMAND && pending.name === "scope" && rest.length > 1) return [];
	if (pending) return (pending.choices ?? []).map(([value, description]) => ({ value, description }));
	const used = new Set<string>();
	/** Options written before any positional word: only there is config's --scope in place. */
	const early = new Set<string>();
	const words: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (!rest[i].startsWith("-")) {
			words.push(rest[i]);
			continue;
		}
		const name = rest[i].slice(2).split("=")[0];
		used.add(name);
		if (!words.length) early.add(name);
		if (command.options.some((option) => rest[i] === `--${option.name}`)) i++;
	}
	const option = (item: OptionSpec): Candidate => ({
		value: `--${item.name}`,
		name: `--${item.name}${item.value ? ` ${item.value}` : ""}`,
		description: item.description,
		takesValue: !!item.value,
	});
	const help = option(HELP_OPTION);
	if (command !== CONFIG_COMMAND) {
		if (words.length > command.maxArgs) return [];
		return [...command.options.filter((item) => !used.has(item.name)).map(option), help];
	}
	const [action] = words;
	const scoped = used.has("scope");
	const scopeIndex = rest.indexOf("--scope");
	const scope = scopeIndex >= 0 ? rest[scopeIndex + 1] : undefined;
	const configOption = (name: string) => option(command.options.find((item) => item.name === name)!);
	// The target goes before the action; until it is given, only the actions that may go without it are offered.
	if (action === undefined)
		return [
			...(scoped ? [] : [configOption("scope")]),
			...configCandidates(words, current, scope, prompts).filter(
				(item) => scoped || !SCOPED_ACTIONS.includes(item.value),
			),
			help,
		];
	// A target after the action, a --wait before it, or a write without a target is refused when run: offer nothing.
	if (!CONFIG_ACTIONS.includes(action) || (scoped && !early.has("scope")) || early.has("wait")) return [];
	if (SCOPED_ACTIONS.includes(action) && !scoped) return [];
	if (action !== "set" && action !== "unset" && words.length > 1) return [];
	return [
		...configCandidates(words, current, scope, prompts),
		...(action === "whoami" && !used.has("wait") ? [configOption("wait")] : []),
		help,
	];
}

function topLevel(): Candidate[] {
	return [
		...COMMANDS.map((command) => ({ value: command.name, description: command.description })),
		{ value: "--help", description: HELP_OPTION.description },
	];
}

export function commandMenu(): { label: string; input: string }[] {
	const items = topLevel();
	const labels = columns(items.map((item) => [item.value, item.description] as const));
	return items.map((item, index) => ({ label: labels[index], input: item.value }));
}

function configCandidates(
	words: string[],
	current: string,
	scope: string | undefined,
	prompts: (scope: ConfigScope) => readonly string[],
): Candidate[] {
	const [action, ...rest] = words.map((word) => word.toLowerCase());
	const candidates = (items: [value: string, description: string][]): Candidate[] =>
		items.map(([value, description]) => ({ value, description }));
	if (action === undefined)
		return candidates(CONFIG_ACTION_TABLE.map((item): [string, string] => [item.action, item.short]));
	/** A field once given, whichever of =, += or -= it was given with. */
	const fieldOf = (word: string) => word.split("=")[0].replace(/[+-]$/, "");
	const used = new Set(rest.map(fieldOf));
	if (action === "set") {
		const equals = current.indexOf("=");
		const spec = equals < 0 ? undefined : fieldNamed(fieldOf(current));
		if (spec?.name === "controlPrompts") {
			// Only -= picks from what is there; =, += take new text. A prompt with a space cannot be one word.
			if (current[equals - 1] !== "-" || !isScope(scope)) return [];
			return candidates(
				prompts(scope)
					.filter((prompt) => !/[\s,]/.test(prompt))
					.map((prompt): [string, string] => [`${spec.name}-=${prompt}`, "删掉这一条"]),
			);
		}
		if (spec) {
			const values = (spec.choices ?? []).map((choice): [string, string] => [
				String(choice.value),
				choice.description,
			]);
			return candidates(
				values.map(([value, description]): [string, string] => [`${spec.name}=${value}`, description]),
			);
		}
		return candidates(
			FIELDS.filter((item) => SETTABLE.includes(item.name) && !used.has(item.name.toLowerCase())).flatMap(
				(item): [string, string][] =>
					item.name === "controlPrompts"
						? [
								[`${item.name}=`, `${item.label}：整份替换`],
								[`${item.name}+=`, `${item.label}：加在末尾`],
								[`${item.name}-=`, `${item.label}：删掉几条`],
							]
						: [[`${item.name}=`, item.label]],
			),
		);
	}
	if (action === "unset")
		return candidates(
			FIELDS.filter(
				// The document address lives only in the global layer: a session has none to remove.
				(item) => !used.has(item.name.toLowerCase()) && (scope === "global" || item.effect !== "document"),
			).map((item): [string, string] => [item.name, item.label]),
		);
	return [];
}
