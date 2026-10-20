/** /wecom-aibot command table, argument parsing, help text and completion: pure functions without pi state. */
import { CONFIG_FILE } from "./config.ts";

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
	/** An action that may follow on the same line, e.g. `setup whoami`, and the options it rules out. */
	then?: { name: string; excludes: string[] };
	options: WeComOption[];
	details: string[];
}

const WECOM_COMMANDS: WeComCommand[] = [
	{ name: "status", usage: "[status]", description: "查看当前 pi 的接入状态、会话来源和配置路径", maxArgs: 0, options: [], details: ["省略子命令时默认显示 status。"] },
	{
		name: "setup", usage: "setup [whoami] [--bot-id <BotID>] [--secret <Secret>] [--chatid <ID>] [--chat-type <1|2>]",
		description: "配置已有机器人并接入；接 whoami 时连上后识别 chatid", maxArgs: 0,
		argsHint: "setup 的值都用选项给出，例如 /wecom-aibot setup --bot-id <BotID> --secret <Secret>；也可以只输入 /wecom-aibot setup 按提示填写。",
		then: { name: "whoami", excludes: ["chatid", "chat-type"] },
		options: [
			{ name: "bot-id", value: "<BotID>", description: "智能机器人 BotID" },
			{ name: "secret", value: "<Secret>", description: "长连接专用 Secret；建议省略后按提示输入，命令行里的值会留在输入历史中" },
			{ name: "chatid", value: "<ID>", description: "默认推送目标，原样保存：单聊填 userid，群聊填群 chatid" },
			{ name: "chat-type", value: "<1|2>", description: "默认推送目标的类型：1 单聊，2 群聊；需与 --chatid 一起使用，省略时为 1" },
		],
		details: [
			"先在企业微信中创建或打开 API 模式、长连接的智能机器人，取得 BotID 和 Secret；插件只连接已有机器人。",
			"未给出的 BotID 和 Secret 按提示输入，留空或按 Esc 取消整个 setup，配置不变。未给出 --chatid 时，在菜单中选择自动识别、手动填写或保持当前目标。",
			"setup whoami：配置并连接后接着运行 whoami，给机器人发一条消息即可识别 chatid，确认后保存；可加 whoami 的 --wait。",
			"whoami 与 --chatid、--chat-type 不能同时使用：默认推送目标由识别结果决定。",
			"setup 会重新连接当前 pi 的企微接入：正在转发的企微任务不再回传结果，排队任务和待发通知会清空。",
			"setup 只配置并连接当前 session；之后每个 session 都需手动 /wecom-aibot connect，退出或切换会话时自动断开。",
			"示例：/wecom-aibot setup",
			"示例：/wecom-aibot setup whoami --bot-id <BotID>",
			"示例：/wecom-aibot setup --bot-id <BotID> --secret <Secret> --chatid <群 chatid> --chat-type 2",
		],
	},
	{
		name: "whoami", usage: "whoami [--wait <秒>]", description: "等你给机器人发一条消息，识别 chatid / chat_type / userid", maxArgs: 0,
		argsHint: "等待时间用 --wait 给出，例如 /wecom-aibot whoami --wait 180。",
		options: [{ name: "wait", value: "<秒>", description: `最多等待的秒数，10～600，默认 ${WHOAMI_WAIT_SECONDS}` }],
		details: [
			"运行后在企微给机器人发一条消息：单聊直接发，群聊需 @机器人。这条消息只用于识别，不会交给 pi 处理。",
			"单聊的 chatid 就是你的 userid，chat_type 为 1；群聊为群 chatid，chat_type 为 2。",
			"识别后经你确认，保存为默认推送目标 defaultChatId / defaultChatType；等待期间按 Esc 取消。",
			"需要当前 pi 已接入企微（/wecom-aibot connect）；配置时可写成 /wecom-aibot setup whoami，连上后接着识别。",
			"配置了 allowedUserIds 时只识别名单内的 userid。",
		],
	},
	{
		name: "connect", usage: "connect", description: "当前 session 手动接入企微；共享网关不存在时自动启动", maxArgs: 0, options: [],
		details: [
			"重新读取配置，仅连接当前 session，不修改共享配置；重复 connect 会保留当前任务和待发通知。",
			"每个 session 都需手动 /wecom-aibot connect，包括新建、恢复、分叉和重载；退出或切换会话时自动断开。",
			"首次连接中不显示标签或静态注册提示，注册和订阅均可用后才显示绿色 wecom-aibot；超过 30 秒未就绪会提醒一次。",
			"凭据或白名单变化会撤销旧注册及其待处理工作；其他 pi 共用一个网关，不会各自再连一条企业微信长连接。",
		],
	},
	{
		name: "disconnect", usage: "disconnect", description: "仅注销当前 pi；最后一个 pi 注销后共享网关自动退出", maxArgs: 0, options: [],
		details: [
			"取消当前 pi 的转发队列和待发通知，已开始的本地任务继续运行。",
			"不停止 pi 进程，不修改共享配置；其他 pi 继续接入，最后一个 pi 注销后共享网关约 1.5 秒后自动退出。",
			"连接状态不会保存或继承；每个 session 都需手动 /wecom-aibot connect。",
		],
	},
	{
		name: "test", usage: "test [chatid] [--chat-type <1|2>]", description: "发送部署测试；省略目标时使用默认推送配置", maxArgs: 1,
		argsHint: "聊天类型用 --chat-type 给出，例如 /wecom-aibot test your-group-chatid --chat-type 2。",
		options: [{ name: "chat-type", value: "<1|2>", description: "1 单聊，2 群聊；需同时给出 chatid，省略时为 1" }],
		details: ["chatid 是位置参数，直接写值；省略时发到 defaultChatId / defaultChatType。"],
	},
	{ name: "log", usage: "log", description: "查看最近 20 条日志", maxArgs: 0, options: [], details: [] },
	{ name: "logout", usage: "logout", description: "确认后删除共享配置，并停止当前 pi 的接入", maxArgs: 0, options: [], details: ["删除的是同一 pi 用户目录共用的配置文件，之后需要重新 setup。"] },
];
export type WeComInvocation =
	| { kind: "help"; topic?: WeComCommand }
	| { kind: "run"; command: WeComCommand; next?: WeComCommand; args: string[]; options: Map<string, string> }
	| { kind: "error"; message: string };

const HELP_OPTION: WeComOption = { name: "help", value: "", description: "显示帮助" };

/** Tokens split into positionals and --options; option names are checked against every command, values validated later. */
function scanWecomArgs(input: string): { positional: string[]; options: Map<string, string>; unknown: string[]; help: boolean; error?: string } {
	const known = new Set(WECOM_COMMANDS.flatMap((command) => command.options.map((option) => option.name)));
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	const positional: string[] = [];
	const options = new Map<string, string>();
	const unknown: string[] = [];
	let help = false;
	let optionsEnded = false;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (optionsEnded) { positional.push(token); continue; }
		if (token === "--") { optionsEnded = true; continue; }
		if (token === "--help" || token === "-h") { help = true; continue; }
		const option = /^--([^=]+)(?:=(.*))?$/.exec(token);
		if (option && known.has(option[1].toLowerCase())) {
			const name = option[1].toLowerCase();
			let value = option[2];
			if (value === undefined && tokens[i + 1] !== undefined && !tokens[i + 1].startsWith("-")) value = tokens[++i];
			if (!value) {
				return { positional, options, unknown, help, error: `--${name} 缺少值；写成 --${name} <值>，值以 - 开头时写成 --${name}=<值>。` };
			}
			if (options.has(name)) return { positional, options, unknown, help, error: `--${name} 重复给出。` };
			options.set(name, value);
			continue;
		}
		if (token.startsWith("-") && token.length > 1) { unknown.push(token); continue; }
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
	// An action written as an option: `--connect`, or `setup --whoami` for the action that may follow setup.
	for (const token of scan.unknown) {
		const action = commandNamed(token.replace(/^--?/, ""));
		if (!action) continue;
		const usage = command?.then?.name === action.name ? `/wecom-aibot ${command.name} ${action.name}` : `/wecom-aibot ${action.name}`;
		return { kind: "error", message: `${action.name} 是子命令，不带 --；请使用 ${usage}。查看用法用 /wecom-aibot ${action.name} --help。` };
	}
	if (!command) return { kind: "error", message: "未知子命令，请使用 /wecom-aibot --help 查看用法。" };
	if (scan.unknown.length) {
		const positional = command.maxArgs ? "位置参数以 - 开头时，先用单独的 -- 分隔。" : "";
		return { kind: "error", message: `未知选项 ${scan.unknown[0]}。${supportedOptions(command)}子命令（如 connect）不带 --。${positional}` };
	}
	let args = scan.positional.slice(1);
	if (scan.help) return { kind: "help", topic: scan.positional.length ? command : undefined };
	// `setup whoami`: the word after setup is a second action, never a value.
	const then = command.then;
	const next = then && args[0]?.toLowerCase() === then.name ? commandNamed(then.name) : undefined;
	if (next) args = args.slice(1);
	for (const option of scan.options.keys()) {
		if (next && then?.excludes.includes(option)) {
			return { kind: "error", message: `${command.name} ${next.name} 由识别结果决定默认推送目标，不能同时给 --${option}。查看帮助：/wecom-aibot ${command.name} --help。` };
		}
		if ([...command.options, ...(next?.options ?? [])].some((item) => item.name === option)) continue;
		const later = then ? commandNamed(then.name) : undefined;
		const belongs = next ? undefined : later?.options.find((item) => item.name === option);
		const hint = belongs && later
			? `--${option} 属于 ${later.name}，写成 /wecom-aibot ${command.name} ${later.name} --${option} ${belongs.value}。`
			: supportedOptions(command, next);
		return { kind: "error", message: `${next ? `${command.name} ${next.name}` : command.name} 不支持 --${option}。${hint}` };
	}
	if (args.length > command.maxArgs) {
		const action = command.maxArgs ? undefined : commandNamed(args[0]);
		const hint = action
			? then && action.name === then.name ? `${then.name} 只能写一次。` : `${command.name} 后面${then ? `只能接 ${then.name}` : "不能再接其他动作"}，${action.name} 请单独运行。`
			: command.argsHint ?? `用法：/wecom-aibot ${command.usage}。`;
		return { kind: "error", message: `参数过多。${hint}查看帮助：/wecom-aibot ${command.name} --help。` };
	}
	const invalid = invalidOptionValues(command, args, scan.options);
	if (invalid) return { kind: "error", message: `${invalid}查看帮助：/wecom-aibot ${command.name} --help。` };
	return { kind: "run", command, next, args, options: scan.options };
}

function supportedOptions(command: WeComCommand, next?: WeComCommand): string {
	const excluded = next ? command.then?.excludes ?? [] : [];
	const names = [...command.options.filter((option) => !excluded.includes(option.name)), ...(next?.options ?? [])].map((option) => `--${option.name}`);
	const usage = `/wecom-aibot ${command.name}${next ? ` ${next.name}` : ""}`;
	// A bare action has no options to list, so point at its usage instead of offering `--help`.
	return names.length ? `${usage} 支持的选项：${[...names, "--help"].join("、")}。` : `${usage} 不接受选项，用法：${usage}。`;
}

/** Value checks, so a command never starts with a value it would reject halfway. */
function invalidOptionValues(command: WeComCommand, args: string[], options: Map<string, string>): string | undefined {
	const chatType = options.get("chat-type");
	if (chatType !== undefined && chatType !== "1" && chatType !== "2") return "--chat-type 只能是 1（单聊）或 2（群聊）。";
	const wait = options.get("wait");
	if (wait !== undefined && (!/^\d+$/.test(wait) || Number(wait) < 10 || Number(wait) > 600)) return "--wait 须为 10～600 的整数秒，例如 --wait 180。";
	const positionalTarget = command.name === "test";
	const chatId = positionalTarget ? args[0] : options.get("chatid");
	const problem = chatId === undefined ? undefined : chatIdProblem(chatId);
	if (problem) return problem;
	if (chatType !== undefined && chatId === undefined) {
		return positionalTarget ? `--chat-type 需要和 chatid 一起使用，例如 /wecom-aibot ${command.name} your-group-chatid --chat-type 2。` : "--chat-type 需要和 --chatid 一起使用。";
	}
	return undefined;
}

/** Values are used as given; a userid or chatid never contains quotes or spaces, so such a value was pasted with something else. */
export function chatIdProblem(chatId: string): string | undefined {
	return /["'“”‘’`\s]/.test(chatId) ? `chatid「${chatId}」含引号或空格；企微的 userid 和 chatid 不含这些字符，请只写 ID 本身。` : undefined;
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

/** A command worth asking for help about: it has options of its own, or it takes positional arguments. */
function hasOptionsOrArgs(command: WeComCommand, follow?: WeComCommand): boolean {
	return command.options.length > 0 || (follow?.options.length ?? 0) > 0 || command.maxArgs > 0;
}

/** The shared help layout: a title line, `用法：…`, then titled sections with aligned rows. */
export function wecomHelpText(topic?: WeComCommand): string {
	const follow = topic?.then ? commandNamed(topic.then.name) : undefined;
	const chained = topic && follow ? `${topic.name} ${follow.name}` : "";
	const optionRows: [string, string][] = [
		...(topic?.options ?? []),
		...(follow?.options ?? []).map((option) => ({ ...option, description: `${option.description}；用于 ${chained}` })),
	].map((option) => [`--${option.name} ${option.value}`.trim(), option.description]);
	// A bare action such as `connect` has nothing to list, so it gets no option table and no `--help`.
	const showOptions = !topic || hasOptionsOrArgs(topic, follow);
	if (showOptions) {
		optionRows.push(["-h, --help", "显示当前命令的帮助，不执行动作"]);
		// `--` only matters for commands that take positional arguments.
		if (!topic || topic.maxArgs) optionRows.push(["--", "结束选项解析，后面的值都作为位置参数"]);
	}

	const lines = topic
		? [`${topic.name} — ${topic.description}`, `用法：/wecom-aibot ${topic.usage}`]
		: ["企业微信智能机器人 — /wecom-aibot 命令帮助", "用法：/wecom-aibot [子命令] [位置参数] [--选项 值]"];

	if (topic) {
		if (topic.details.length) lines.push(...section("说明", topic.details.map((detail) => `  ${detail}`)));
		if (showOptions) lines.push(...section("选项", alignedRows(optionRows)));
	} else {
		lines.push(...section("说明", [
			"  子命令是动作，不带 --（如 connect）；位置参数是命令作用的对象，直接写值。",
			"  可选设置写成 --选项 值 或 --选项=值；setup 后面可以接 whoami，按顺序执行两个动作：/wecom-aibot setup whoami。",
			"  企业微信聊天里另有 sessions / send / screen / cancel 四个子命令（用完整 session ID 指定目标），它们只在企微中解析，pi 里没有。",
		]));
		lines.push(...section("子命令", [
			...alignedRows(WECOM_COMMANDS.map((command) => [command.name, command.description])),
			"",
			"  子命令的用法与选项：/wecom-aibot <子命令> --help，例如 /wecom-aibot setup --help。",
		]));
		lines.push(...section("通用选项", alignedRows(optionRows)));
	}

	// The target rules belong to the commands that take a target; the total help keeps only the essentials.
	if (!topic || topic.name === "test") {
		const target: string[] = [
			...alignedRows([
				["chatid", "单聊填企微 userid，群聊填群 chatid；与 pi 的 session ID 是不同的标识。"],
				["chat_type", "1 = 单聊，2 = 群聊；用 --chat-type 指定，显式给出 chatid 时默认单聊。"],
				["默认目标", "/wecom-aibot test 省略目标时使用 defaultChatId / defaultChatType；wecom_send 在企微任务中优先发回来源聊天，本地任务才用默认目标。"],
			]),
			topic
				? "  不清楚 chatid：运行 /wecom-aibot whoami（配置时可写 /wecom-aibot setup whoami），再在企微给机器人发一条消息"
				: "  识别目标：运行 /wecom-aibot whoami（配置时可写 /wecom-aibot setup whoami），再给机器人发一条消息；详见 /wecom-aibot whoami --help。",
		];
		if (topic) target.push(
			"  （群聊需 @机器人），即可识别 chatid、chat_type 和 userid，确认后保存为默认推送目标。",
			"  示例",
			"    /wecom-aibot test your-userid",
			"    /wecom-aibot test your-group-chatid --chat-type 2",
		);
		lines.push(...section("推送目标", target));
	}

	// Every help ends with the config path; the field reference lives in `setup --help` and the README.
	const configPath = alignedRows([["配置文件", CONFIG_FILE]]);
	if (topic?.name === "setup") {
		lines.push(...section("配置", [
			...alignedRows([
				["配置文件", `${CONFIG_FILE}\n独立 JSON 文件；同一 pi 用户目录下的多个窗口共用。`],
				["默认位置", "~/.pi/agent/wecom-aibot/config.json，与其他 pi 配置同在 agent 目录下，但放在插件自己的文件夹里。\n同一文件夹还放着共享网关的 socket 和会话选择记录（gateway/）；PI_CODING_AGENT_DIR 改变时整块随之移动。"],
				["写入方式", "/wecom-aibot setup 保存 botId、secret 和默认推送目标；其他配置可编辑此 JSON 文件。"],
				["字段", "botId / secret：机器人凭据。\ndefaultChatId：默认推送的 userid 或群 chatid；defaultChatType：1 单聊 / 2 群聊。\nallowedUserIds：允许发任务的企微 userid 列表；空列表表示不限制。"],
				["sendMode", "通知模式：text（默认）用 Markdown；image 把自动结果渲染成当前 pi 终端图片（含 session 等三行头部，不含 footer/状态栏），通过原生图片消息发送。wecom_send 的显式 content 和 /wecom-aibot test 始终为 Markdown。"],
			]),
			"  配置示例（请替换示例中的 BotID、Secret 和目标 ID）：",
			...JSON.stringify({
				botId: "your-bot-id", secret: "your-long-connection-secret", sendMode: "text",
				defaultChatId: "your-userid", defaultChatType: 1,
				allowedUserIds: [],
			}, null, 2).split("\n").map((line) => `  ${line}`),
			"  修改后，在需要更新的 pi 中执行 /wecom-aibot connect 重新读取配置；只影响当前 session。",
		]));
		lines.push("  全部命令与配置说明：/wecom-aibot --help。");
	} else if (topic) {
		lines.push(...section("配置", [...configPath, "  全部命令与配置说明：/wecom-aibot --help。"]));
	} else {
		lines.push(...section("配置", [...configPath, "  字段说明与示例：/wecom-aibot setup --help。"]));
	}

	if (!topic) lines.push(...section("生命周期", [
		"  connect / disconnect 只控制当前 session，不修改共享配置；每个 session 都需手动 /wecom-aibot connect。",
		"  退出、切换、新建、恢复、分叉或重载会话时自动断开，连接状态不会继承。",
		"  共享网关由第一个接入的 pi 自动启动，最后一个 pi 注销后约 1.5 秒自动退出。",
		"  在企微聊天中发送 /wecom-aibot sessions 查看会话，/wecom-aibot use <完整 session ID> 选择目标。",
	]));
	return lines.join("\n");
}

/**
 * Completions for the text after "/wecom-aibot "; the returned value replaces all of it.
 * A token that is already complete gets no list, so Enter runs the command instead of applying a completion.
 */
export function completeWecom(prefix: string): { value: string; label: string }[] | null {
	const tokens = prefix.trimStart().split(/\s+/);
	const current = tokens.pop()!.toLowerCase();
	const head = tokens.length ? `${tokens.join(" ")} ` : "";
	const offer = (items: { value: string; label: string }[]) => (items.length && !items.some((item) => item.value.trim() === current) ? items.map((item) => ({ ...item, value: head + item.value })) : null);
	const describe = (command: WeComCommand) => ({ value: command.name, label: `${command.name} — ${command.description}` });
	if (!tokens.length) {
		const candidates = [...WECOM_COMMANDS.map(describe), { value: "--help", label: "--help — 显示帮助" }, { value: "-h", label: "-h — 显示帮助" }];
		return offer(candidates.filter((item) => item.value.startsWith(current)));
	}
	const command = commandNamed(tokens[0]);
	if (!command) return null;
	const then = command.then;
	const follow = then && tokens.slice(1).some((token) => token.toLowerCase() === then.name) ? commandNamed(then.name) : undefined;
	if (!current.startsWith("-")) {
		// Only the action that may follow, while it is being typed, and never in an option's value position.
		const previous = tokens.at(-1)!.toLowerCase();
		if (WECOM_COMMANDS.some((item) => item.options.some((option) => previous === `--${option.name}`))) return null;
		const later = then && !follow && current ? commandNamed(then.name) : undefined;
		const conflict = then?.excludes.some((name) => tokens.some((token) => token.toLowerCase().startsWith(`--${name}`)));
		return later && !conflict && later.name.startsWith(current) ? offer([describe(later)]) : null;
	}
	const used = new Set(tokens.filter((token) => token.startsWith("--")).map((token) => token.slice(2).split("=")[0].toLowerCase()));
	const excluded = follow ? then?.excludes ?? [] : [];
	const candidates = [...command.options.filter((option) => !excluded.includes(option.name)), ...(follow?.options ?? []), ...(hasOptionsOrArgs(command, follow) ? [HELP_OPTION] : [])]
		.filter((option) => !used.has(option.name));
	return offer(candidates.filter((option) => `--${option.name}`.startsWith(current)).map((option) => ({
		value: option.value ? `--${option.name} ` : `--${option.name}`,
		label: `--${option.name}${option.value ? ` ${option.value}` : ""} — ${option.description}`,
	})));
}
