/** /wecom-aibot command table, argument parsing, help text and completion: pure functions without pi state. */
import { join } from "node:path";
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

export const WHOAMI_WAIT_SECONDS = 120;

/** An option takes one value: `--name value` or `--name=value`. */
interface WeComOption {
	name: string;
	value: string;
	description: string;
}

export interface WeComCommand {
	name: string;
	usage: string;
	description: string;
	/** Positional arguments: the object the command acts on. */
	maxArgs: number;
	/** Shown when there are too many positional arguments, e.g. to point at an option. */
	argsHint?: string;
	options: WeComOption[];
	details: string[];
}

/** `config` has a grammar of its own (scope, action, 字段=值), parsed by parseConfigArgs. */
const CONFIG_COMMAND: WeComCommand = {
	name: "config",
	usage: "config [global|session] <show|edit|set|unset> [字段=值 …]",
	description: "查看或修改配置：机器人凭据、默认推送目标、通知与截图设置",
	maxArgs: 0,
	options: [],
	details: [
		"两层配置：global 是全局默认，session 是当前 pi 会话的显式覆盖；session 始终指当前会话，不需要填写 ID。优先级：内置默认值 < global < session。",
		"写操作必须写明 session 或 global；不带动作的 config、config global、config session 列出子命令供选择，不执行任何动作。",
		"set 写成 字段=值，可一次给多个：先全部校验再一次保存，有错误时一项都不写。unset 删除 session 覆盖，使其重新继承全局值或内置默认值。",
		"botId 与 secret、defaultChatId 与 defaultChatType 各为一组，成组保存、成组删除。botId、secret 只能用 edit 输入（命令会留在输入历史中）；输入时屏幕上会显示 Secret，查看时只显示是否已配置。",
		"保存配置不会断开或重连：通知方式、通知范围、截图主题在下次使用时生效；凭据、默认目标或白名单变化后显示「待重新接入」，运行 /wecom-aibot connect 才切换。配置不等于接入：每个 session 都需手动 /wecom-aibot connect。",
		"fork／clone 出的会话首次启动时复制一次父会话的覆盖项，之后各自独立。",
		"allowedUserIds（允许发任务的企微 userid 列表）不由 config 管理，请直接编辑全局配置文件。",
	],
};

const WECOM_COMMANDS: WeComCommand[] = [
	{
		name: "status",
		usage: "[status]",
		description: "查看当前 pi 的接入状态、会话来源和配置路径",
		maxArgs: 0,
		options: [],
		details: ["省略子命令时默认显示 status。"],
	},
	CONFIG_COMMAND,
	{
		name: "whoami",
		usage: "whoami [--wait <秒>]",
		description: "等你给机器人发一条消息，识别 chatid / chat_type / userid",
		maxArgs: 0,
		argsHint: "等待时间用 --wait 给出，例如 /wecom-aibot whoami --wait 180。",
		options: [{ name: "wait", value: "<秒>", description: `最多等待的秒数，10～600，默认 ${WHOAMI_WAIT_SECONDS}` }],
		details: [
			"运行后在企微给机器人发一条消息：单聊直接发，群聊需 @机器人。这条消息只用于识别，不会交给 pi 处理。",
			"单聊的 chatid 就是你的 userid，chat_type 为 1；群聊为群 chatid，chat_type 为 2。",
			"识别后经你确认，保存为全局默认推送目标 defaultChatId / defaultChatType；等待期间按 Esc 取消。",
			"离线时只需先用 /wecom-aibot config global edit 保存 BotID/Secret；whoami 自动临时连接以识别，不出现在在线会话列表，也不接收任务，完成、取消或超时后关闭临时接入。",
			"已接入时复用当前连接识别；保存不会断开当前接入，运行 /wecom-aibot connect 后改用新目标。",
			"配置了 allowedUserIds 时只识别名单内的 userid。",
		],
	},
	{
		name: "connect",
		usage: "connect",
		description: "当前 session 手动接入企微；共享网关不存在时自动启动",
		maxArgs: 0,
		options: [],
		details: [
			"重新读取配置，仅连接当前 session，不修改配置；接入配置不变时保留当前任务和待发通知。通知方式等设置在使用时读取，不需要 connect。",
			"BotID、Secret 和默认推送目标必须齐全；目标可通过 whoami 识别确认，也可用 /wecom-aibot config <session|global> set defaultChatId=<ID> 填写。",
			"注册与企微订阅均成功后，按通知方式向默认目标发送一次可引用的会话入口通知；已在线重复 connect、网络自动重连不重复发送，通知失败不撤销连接。",
			"每个 session 都需手动 /wecom-aibot connect，包括新建、恢复、分叉和重载；退出或切换会话时自动断开。",
			"首次连接中不显示标签或静态注册提示，注册和订阅均可用后才显示绿色 wecom-aibot；超过 30 秒未就绪会提醒一次。",
			"凭据、白名单或默认目标变化后，connect 经确认撤销旧注册及其待处理工作；没有交互界面且有待处理工作时拒绝切换。其他 pi 共用一个网关，不会各自再连一条企业微信长连接。",
		],
	},
	{
		name: "disconnect",
		usage: "disconnect",
		description: "仅注销当前 pi；最后一个 pi 注销后共享网关自动退出",
		maxArgs: 0,
		options: [],
		details: [
			"取消当前 pi 的转发队列和待发通知，已开始的本地任务继续运行。",
			"不停止 pi 进程，不修改配置；其他 pi 继续接入，最后一个 pi 注销后共享网关约 1.5 秒后自动退出。",
			"连接状态不会保存或继承；每个 session 都需手动 /wecom-aibot connect。",
		],
	},
	{
		name: "test",
		usage: "test [chatid] [--chat-type <1|2>]",
		description: "发送部署测试；省略目标时使用默认推送配置",
		maxArgs: 1,
		argsHint: "聊天类型用 --chat-type 给出，例如 /wecom-aibot test your-group-chatid --chat-type 2。",
		options: [{ name: "chat-type", value: "<1|2>", description: "1 单聊，2 群聊；需同时给出 chatid，省略时为 1" }],
		details: [
			"chatid 是位置参数，直接写值；省略时发到当前接入的默认推送目标。",
			"需要正式 connect；测试通知与其他通知一样跟随通知方式，screenshot 为当前终端截图。",
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
			"删除同一 pi 用户目录共用的全局配置文件：BotID、Secret、默认推送目标、通知设置和白名单一起删除，之后需要重新 /wecom-aibot config global edit。各 session 的覆盖文件保留。",
			"需要交互确认，没有界面时不删除。只停止当前 pi 的接入；其他 pi 若已连接，仍会继续接收，直到它们各自 disconnect 或退出。",
		],
	},
];

export type ConfigScope = "global" | "session";

export type ConfigInvocation =
	/** No action given: list the subcommands, all of them or one scope's. */
	| { action: "choose"; scope?: ConfigScope }
	| { action: "show"; scope?: ConfigScope }
	| { action: "edit"; scope: ConfigScope }
	| { action: "set"; scope: ConfigScope; set: Partial<ManagedFields> }
	| { action: "unset"; scope: "session"; remove: FieldName[] };

/**
 * The subcommands, in menu order: help, the chooser and its no-UI listing all read this table. One
 * that needs values (`args`) is not run from the menu but put in the editor to be completed.
 */
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
		usage: "global show",
		description: "查看全局显式保存的配置",
		scope: "global",
		run: { action: "show", scope: "global" },
	},
	{
		usage: "global edit",
		description: "交互编辑全局配置；还没有凭据时引导填写 BotID、Secret 和默认推送目标",
		scope: "global",
		run: { action: "edit", scope: "global" },
	},
	{
		usage: "global set",
		args: "字段=值 …",
		description: "修改全局字段，未给出的字段保持不变",
		scope: "global",
	},
	{
		usage: "session show",
		description: "查看当前 session 显式保存的覆盖项",
		scope: "session",
		run: { action: "show", scope: "session" },
	},
	{
		usage: "session edit",
		description: "交互编辑当前 session 的覆盖项",
		scope: "session",
		run: { action: "edit", scope: "session" },
	},
	{
		usage: "session set",
		args: "字段=值 …",
		description: "修改当前 session 的覆盖项，未给出的字段保持不变",
		scope: "session",
	},
	{
		usage: "session unset",
		args: "字段 …",
		description: "删除 session 覆盖，重新继承全局值或内置默认值；关联组整组删除",
		scope: "session",
	},
];

/** All subcommands, or one scope's. */
export function configSubcommands(scope?: ConfigScope): readonly ConfigSubcommand[] {
	return CONFIG_SUBCOMMANDS.filter((item) => !scope || item.scope === scope);
}

/** How a subcommand is written after `config`, its values included. */
export function subcommandUsage(item: ConfigSubcommand): string {
	return "args" in item ? `${item.usage} ${item.args}` : item.usage;
}

/** The subcommands as aligned `usage  description` lines. */
export function configSubcommandLines(scope?: ConfigScope): string[] {
	return alignedRows(configSubcommands(scope).map((item) => [subcommandUsage(item), item.description]));
}

export type WeComInvocation =
	| { kind: "help"; topic?: WeComCommand }
	| { kind: "run"; command: WeComCommand; args: string[]; options: Map<string, string> }
	| { kind: "config"; config: ConfigInvocation }
	| { kind: "error"; message: string };

const HELP_OPTION: WeComOption = { name: "help", value: "", description: "显示帮助" };

/** Tokens split into positionals and --options; option names are checked against every command, values validated later. */
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
		if (token === "--help" || token === "-h") {
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
					error: `--${name} 缺少值；写成 --${name} <值>，值以 - 开头时写成 --${name}=<值>。`,
				};
			}
			if (options.has(name)) return { positional, options, unknown, help, error: `--${name} 重复给出。` };
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

function commandNamed(name: string | undefined): WeComCommand | undefined {
	return name === undefined ? undefined : WECOM_COMMANDS.find((command) => command.name === name.toLowerCase());
}

export function parseWecomInvocation(input: string): WeComInvocation {
	const scan = scanWecomArgs(input);
	if (scan.error) return { kind: "error", message: scan.error };
	const command = commandNamed(scan.positional[0] ?? "status");
	// An action written as an option: `--connect`.
	for (const token of scan.unknown) {
		const action = commandNamed(token.replace(/^--?/, ""));
		if (action)
			return {
				kind: "error",
				message: `${action.name} 是子命令，不带 --；请使用 /wecom-aibot ${action.name}。查看用法用 /wecom-aibot ${action.name} --help。`,
			};
	}
	if (!command) return { kind: "error", message: "未知子命令，请使用 /wecom-aibot --help 查看用法。" };
	if (command === CONFIG_COMMAND && (scan.unknown.length || scan.options.size)) {
		const given = scan.unknown[0] ?? `--${[...scan.options.keys()][0]}`;
		return {
			kind: "error",
			message: `config 的参数写成 字段=值，不用 --选项（${given}）。查看帮助：/wecom-aibot config --help。`,
		};
	}
	if (scan.unknown.length) {
		const positional = command.maxArgs ? "位置参数以 - 开头时，先用单独的 -- 分隔。" : "";
		return {
			kind: "error",
			message: `未知选项 ${scan.unknown[0]}。${supportedOptions(command)}子命令（如 connect）不带 --。${positional}`,
		};
	}
	if (scan.help) return { kind: "help", topic: scan.positional.length ? command : undefined };
	const args = scan.positional.slice(1);
	if (command === CONFIG_COMMAND) return parseConfigArgs(args);
	for (const option of scan.options.keys()) {
		if (!command.options.some((item) => item.name === option))
			return { kind: "error", message: `${command.name} 不支持 --${option}。${supportedOptions(command)}` };
	}
	if (args.length > command.maxArgs) {
		const action = command.maxArgs ? undefined : commandNamed(args[0]);
		const hint = action
			? `${command.name} 后面不能再接其他动作，${action.name} 请单独运行。`
			: (command.argsHint ?? `用法：/wecom-aibot ${command.usage}。`);
		return { kind: "error", message: `参数过多。${hint}查看帮助：/wecom-aibot ${command.name} --help。` };
	}
	const invalid = invalidOptionValues(command, args, scan.options);
	if (invalid) return { kind: "error", message: `${invalid}查看帮助：/wecom-aibot ${command.name} --help。` };
	return { kind: "run", command, args, options: scan.options };
}

const CONFIG_ACTIONS = ["show", "edit", "set", "unset"];

/** `[global|session] [show|edit|set|unset] [字段=值 …]`: only showing may omit the scope; no action lists the choices. */
function parseConfigArgs(args: string[]): WeComInvocation {
	const error = (message: string): WeComInvocation => ({
		kind: "error",
		message: `${message}查看帮助：/wecom-aibot config --help。`,
	});
	const rejected = (problems: string[]) =>
		error(`${problems.map((problem) => problem.replace(/。$/, "")).join("；")}。未做任何修改。`);
	const [scope, action] = args.map((arg) => arg.toLowerCase());
	if (scope === undefined) return { kind: "config", config: { action: "choose" } };
	if (scope === "show")
		return args.length > 1 ? error("config show 不接受参数。") : { kind: "config", config: { action: "show" } };
	if (scope !== "global" && scope !== "session")
		return error(
			CONFIG_ACTIONS.includes(scope)
				? `${scope} 需要写明作用域，例如 /wecom-aibot config session ${scope}。`
				: `未知作用域 ${args[0]}；可用 global、session，或只读的 show。`,
		);
	const values = args.slice(2);
	switch (action) {
		case undefined:
			return { kind: "config", config: { action: "choose", scope } };
		case "show":
		case "edit":
			return values.length
				? error(`config ${scope} ${action} 不接受参数。`)
				: { kind: "config", config: { action, scope } };
		case "set": {
			if (!values.length)
				return error(`set 需要至少一个 字段=值，例如 /wecom-aibot config ${scope} set screenshotTheme=light。`);
			const parsed = parseAssignments(values);
			return "problems" in parsed
				? rejected(parsed.problems)
				: { kind: "config", config: { action, scope, set: parsed.set } };
		}
		case "unset": {
			if (scope === "global") return error(`config global unset 暂不支持；全局字段请直接编辑 ${CONFIG_FILE}。`);
			if (!values.length) return error("unset 需要字段名，例如 /wecom-aibot config session unset screenshotTheme。");
			const parsed = parseRemovals(values);
			return "problems" in parsed
				? rejected(parsed.problems)
				: { kind: "config", config: { action, scope, remove: parsed.remove } };
		}
		default:
			return error(`未知动作 ${args[1]}；可用 show、edit、set${scope === "session" ? "、unset" : ""}。`);
	}
}

function supportedOptions(command: WeComCommand): string {
	const names = command.options.map((option) => `--${option.name}`);
	const usage = `/wecom-aibot ${command.name}`;
	// A bare action has no options to list, so point at its usage instead of offering `--help`.
	return names.length
		? `${usage} 支持的选项：${[...names, "--help"].join("、")}。`
		: `${usage} 不接受选项，用法：${usage}。`;
}

/** Value checks, so a command never starts with a value it would reject halfway. */
function invalidOptionValues(command: WeComCommand, args: string[], options: Map<string, string>): string | undefined {
	const chatType = options.get("chat-type");
	if (chatType !== undefined && chatType !== "1" && chatType !== "2")
		return "--chat-type 只能是 1（单聊）或 2（群聊）。";
	const wait = options.get("wait");
	if (wait !== undefined && (!/^\d+$/.test(wait) || Number(wait) < 10 || Number(wait) > 600))
		return "--wait 须为 10～600 的整数秒，例如 --wait 180。";
	const chatId = command.name === "test" ? args[0] : undefined;
	const problem = chatId === undefined ? undefined : chatIdProblem(chatId);
	if (problem) return problem;
	if (chatType !== undefined && chatId === undefined)
		return `--chat-type 需要和 chatid 一起使用，例如 /wecom-aibot ${command.name} your-group-chatid --chat-type 2。`;
	return undefined;
}

/** Terminal display width: CJK, fullwidth forms and CJK punctuation take two columns. */
function displayWidth(text: string): number {
	return [...text].reduce((sum, char) => sum + (/[\u2e80-\uffef]/.test(char) ? 2 : 1), 0);
}

/**
 * `key  value` rows aligned by display width and indented two spaces. A value may contain newlines;
 * continuation lines are indented to the value column, so a wrapped explanation keeps its shape.
 */
function alignedRows(rows: [string, string][]): string[] {
	const width = Math.max(0, ...rows.map(([key]) => displayWidth(key)));
	const gap = " ".repeat(width + 2);
	return rows.flatMap(([key, value]) => {
		const [first, ...rest] = value.split("\n");
		const head = first ? `  ${key}${" ".repeat(width - displayWidth(key))}  ${first}` : `  ${key}`;
		return [head, ...rest.map((line) => `  ${gap}${line}`)];
	});
}

/** A blank line, the section title, then the body: sections are separated by exactly one blank line. */
function section(title: string, body: string[]): string[] {
	return ["", title, ...body];
}

/** A command worth asking for help about: it has options of its own, or it takes arguments. */
function hasOptionsOrArgs(command: WeComCommand): boolean {
	return command.options.length > 0 || command.maxArgs > 0 || command === CONFIG_COMMAND;
}

function configPaths(): string[] {
	return alignedRows([
		["配置文件", CONFIG_FILE],
		["会话覆盖", join(SESSIONS_DIR, "<session-id>.json")],
	]);
}

/** The shared help layout: a title line, `用法：…`, then titled sections with aligned rows. */
export function wecomHelpText(topic?: WeComCommand): string {
	if (topic === CONFIG_COMMAND) return configHelpText();
	const optionRows: [string, string][] = (topic?.options ?? []).map((option) => [
		`--${option.name} ${option.value}`.trim(),
		option.description,
	]);
	// A bare action such as `connect` has nothing to list, so it gets no option table and no `--help`.
	const showOptions = !topic || hasOptionsOrArgs(topic);
	if (showOptions) {
		optionRows.push(["-h, --help", "显示当前命令的帮助，不执行动作"]);
		// `--` only matters for commands that take positional arguments.
		if (!topic || topic.maxArgs) optionRows.push(["--", "结束选项解析，后面的值都作为位置参数"]);
	}

	const lines = topic
		? [`${topic.name} — ${topic.description}`, `用法：/wecom-aibot ${topic.usage}`]
		: ["企业微信智能机器人 — /wecom-aibot 命令帮助", "用法：/wecom-aibot [子命令] [位置参数] [--选项 值]"];

	if (topic) {
		if (topic.details.length)
			lines.push(
				...section(
					"说明",
					topic.details.map((detail) => `  ${detail}`),
				),
			);
		if (showOptions) lines.push(...section("选项", alignedRows(optionRows)));
	} else {
		lines.push(
			...section("说明", [
				"  子命令是动作，不带 --（如 connect）；位置参数是命令作用的对象，直接写值。",
				"  可选设置写成 --选项 值 或 --选项=值；config 的参数写成 字段=值，例如 /wecom-aibot config session set screenshotTheme=light。",
				"  企业微信聊天里另有 sessions / send / screen / cancel 四个子命令（用完整 session ID 指定目标），它们只在企微中解析，pi 里没有。",
			]),
			...section("子命令", [
				...alignedRows(WECOM_COMMANDS.map((command) => [command.name, command.description])),
				"",
				"  子命令的用法与选项：/wecom-aibot <子命令> --help，例如 /wecom-aibot config --help。",
			]),
			...section("通用选项", alignedRows(optionRows)),
		);
	}

	// The target rules belong to the commands that take a target; the total help keeps only the essentials.
	if (!topic || topic.name === "test") {
		const target: string[] = [
			...alignedRows([
				["chatid", "单聊填企微 userid，群聊填群 chatid；与 pi 的 session ID 是不同的标识。"],
				["chat_type", "1 = 单聊，2 = 群聊；用 --chat-type 指定，显式给出 chatid 时默认单聊。"],
				[
					"默认目标",
					"/wecom-aibot test 省略目标时使用 defaultChatId / defaultChatType；wecom_send 在企微任务中优先发回来源聊天，本地任务才用默认目标。",
				],
			]),
			topic
				? "  不清楚 chatid：运行 /wecom-aibot whoami，再在企微给机器人发一条消息"
				: "  识别目标：运行 /wecom-aibot whoami，再给机器人发一条消息；也可以用 /wecom-aibot config <session|global> set defaultChatId=<ID> 直接填写。",
		];
		if (topic)
			target.push(
				"  （群聊需 @机器人），即可识别 chatid、chat_type 和 userid，确认后保存为默认推送目标。",
				"  示例",
				"    /wecom-aibot test your-userid",
				"    /wecom-aibot test your-group-chatid --chat-type 2",
			);
		lines.push(...section("推送目标", target));
	}

	// Every help ends with the config paths; the field reference lives in `config --help` and the README.
	const pointer = topic
		? "全部命令与配置说明：/wecom-aibot --help。"
		: "字段、作用域与示例：/wecom-aibot config --help。";
	lines.push(...section("配置", [...configPaths(), `  ${pointer}`]));

	if (!topic)
		lines.push(
			...section("生命周期", [
				"  connect / disconnect 只控制当前 session，不修改配置；每个 session 都需手动 /wecom-aibot connect。",
				"  退出、切换、新建、恢复、分叉或重载会话时自动断开，连接状态不会继承。",
				"  config 只保存配置，不连接也不断开；whoami 必要时临时识别。默认目标齐全后，每个 session 都需手动 /wecom-aibot connect 正式接入。",
				"  共享网关由第一个正式或临时接入的 pi 自动启动，最后一个 pi 注销后约 1.5 秒自动退出。",
				"  在企微聊天中发送 /wecom-aibot sessions 查看会话；引用通知回复，或用 send --sessionid <完整 session ID> --prompt <正文> 指定目标。",
			]),
		);
	return lines.join("\n");
}

/** config takes actions and fields rather than options, so its help lists those instead. */
function configHelpText(): string {
	const command = CONFIG_COMMAND;
	return [
		`${command.name} — ${command.description}`,
		`用法：/wecom-aibot ${command.usage}`,
		...section(
			"说明",
			command.details.map((detail) => `  ${detail}`),
		),
		...section("动作", configSubcommandLines()),
		...section("字段", alignedRows(FIELDS.map((spec) => [spec.name, fieldText(spec)]))),
		...section("选项", alignedRows([["-h, --help", "显示当前命令的帮助，不执行动作"]])),
		...section("示例", [
			"  /wecom-aibot config global edit",
			"  /wecom-aibot config session set screenshotTheme=light",
			"  /wecom-aibot config global set notificationMode=screenshot notificationScope=all-runs",
			"  /wecom-aibot config session set defaultChatId=<群 chatid> defaultChatType=2",
			"  /wecom-aibot config session unset defaultChatId",
		]),
		...section("配置", [...configPaths(), "  全部命令与配置说明：/wecom-aibot --help。"]),
	].join("\n");
}

function fieldText(spec: FieldSpec): string {
	const choices = (spec.choices ?? []).map(
		(choice) => `${choice.value}：${choice.description}${choice.value === spec.default ? "（默认）" : ""}`,
	);
	return [`${spec.label}：${spec.description}`, ...choices].join("\n");
}

/**
 * Completions for the text after "/wecom-aibot "; the returned value replaces all of it.
 * A token that is already complete gets no list, so Enter runs the command instead of applying a completion.
 */
/** `themes`: pi's theme names, read only when screenshotTheme is being completed. */
export function completeWecom(
	prefix: string,
	themes: () => readonly string[],
): { value: string; label: string }[] | null {
	const tokens = prefix.trimStart().split(/\s+/);
	const current = (tokens.pop() ?? "").toLowerCase();
	const head = tokens.length ? `${tokens.join(" ")} ` : "";
	const offer = (items: { value: string; label: string }[]) =>
		items.length && !items.some((item) => item.value.trim().toLowerCase() === current)
			? items.map((item) => ({ ...item, value: head + item.value }))
			: null;
	const describe = (command: WeComCommand) => ({
		value: command.name,
		label: `${command.name} — ${command.description}`,
	});
	if (!tokens.length) {
		const candidates = [
			...WECOM_COMMANDS.map(describe),
			{ value: "--help", label: "--help — 显示帮助" },
			{ value: "-h", label: "-h — 显示帮助" },
		];
		return offer(candidates.filter((item) => item.value.startsWith(current)));
	}
	const command = commandNamed(tokens[0]);
	if (!command) return null;
	if (!current.startsWith("-"))
		return command === CONFIG_COMMAND ? offer(configCompletions(tokens.slice(1), current, themes)) : null;
	const used = new Set(
		tokens.filter((token) => token.startsWith("--")).map((token) => token.slice(2).split("=")[0].toLowerCase()),
	);
	const candidates = [...command.options, ...(hasOptionsOrArgs(command) ? [HELP_OPTION] : [])].filter(
		(option) => !used.has(option.name),
	);
	return offer(
		candidates
			.filter((option) => `--${option.name}`.startsWith(current))
			.map((option) => ({
				value: option.value ? `--${option.name} ` : `--${option.name}`,
				label: `--${option.name}${option.value ? ` ${option.value}` : ""} — ${option.description}`,
			})),
	);
}

/** The words after `config`: scope, action, then fields and values; matching ignores case. */
function configCompletions(
	words: string[],
	current: string,
	themes: () => readonly string[],
): { value: string; label: string }[] {
	const [scope, action, ...rest] = words.map((word) => word.toLowerCase());
	const starting = (items: [string, string][]) =>
		items
			.filter(([value]) => value.toLowerCase().startsWith(current))
			.map(([value, label]) => ({ value, label: `${value} — ${label}` }));
	if (scope === undefined)
		return starting([
			["show", "查看当前 session 合并后的配置"],
			["global", "全局默认"],
			["session", "当前 session 的覆盖"],
		]);
	if (scope !== "global" && scope !== "session") return [];
	if (action === undefined) {
		const actions: [string, string][] = [
			["show", "查看这一层"],
			["edit", "交互编辑"],
			["set", "修改字段：字段=值"],
		];
		if (scope === "session") actions.push(["unset", "删除覆盖，重新继承"]);
		return starting(actions);
	}
	const used = new Set(rest.map((word) => word.split("=")[0]));
	if (action === "set") {
		const equals = current.indexOf("=");
		const spec = equals < 0 ? undefined : fieldNamed(current.slice(0, equals));
		if (spec) {
			const values: [string, string][] =
				spec.name === "screenshotTheme"
					? themes().map((name) => [name, "pi 主题"])
					: (spec.choices ?? []).map((choice) => [String(choice.value), choice.description]);
			return starting(values.map(([value, label]) => [`${spec.name}=${value}`, label]));
		}
		return starting(
			FIELDS.filter((item) => SETTABLE.includes(item.name) && !used.has(item.name.toLowerCase())).map((item) => [
				`${item.name}=`,
				item.label,
			]),
		);
	}
	if (action === "unset" && scope === "session")
		return starting(
			FIELDS.filter((item) => !used.has(item.name.toLowerCase())).map((item) => [item.name, item.label]),
		);
	return [];
}
