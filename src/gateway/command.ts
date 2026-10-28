/**
 * The WeCom side's /wecom-aibot commands: parsing, and the help they print. Pure; the gateway routes what this
 * returns. The target is an option before the action (--session-id <id> send), spelled as pi's own command
 * line and the cards spell it. --prompt ends parsing.
 */
import { sentences } from "../shared/text.ts";

const COMMAND_PREFIX = "/wecom-aibot";
const SESSION_OPTION = "--session-id";
const SUBCOMMANDS = ["sessions", "send", "card", "cancel"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export type WeComCommand =
	| { kind: "none" }
	| { kind: "error"; message: string }
	| { kind: "help"; topic?: Subcommand }
	| { kind: "sessions" }
	| { kind: "session"; sessionId: string }
	| { kind: "send"; sessionId: string; prompt: string }
	| { kind: "card"; sessionId: string }
	| { kind: "cancel"; sessionId: string };

export type SessionAction = Exclude<Subcommand, "sessions">;

/** The target is a command option before the action; --prompt ends parsing unconditionally. */
export function parseWeComCommand(text: string): WeComCommand {
	const trimmed = text.trimStart();
	if (!new RegExp(`^${COMMAND_PREFIX}(?:\\s|$)`, "i").test(trimmed)) return { kind: "none" };
	const rest = trimmed.slice(COMMAND_PREFIX.length);
	const tokens = /\S+/g;
	let sessionId: string | undefined;
	let sub: Subcommand | undefined;
	for (let found = tokens.exec(rest); found; found = tokens.exec(rest)) {
		const token = found[0];
		if (token === "--help") return sub ? { kind: "help", topic: sub } : { kind: "help" };
		if (token === SESSION_OPTION) {
			const value = tokens.exec(rest)?.[0];
			if (!value || value.startsWith("--")) return { kind: "error", message: "--session-id 缺少值" };
			if (sessionId) return { kind: "error", message: "--session-id 重复给出" };
			if (sub === "sessions") return { kind: "error", message: "sessions 不需要 --session-id" };
			if (sub) return { kind: "error", message: `--session-id 要写在动作前：${sessionCommand(value, sub)}` };
			sessionId = value;
			continue;
		}
		if (!sub) {
			if (token.startsWith("-")) return unknownOption(token);
			sub = SUBCOMMANDS.find((item) => item === token.toLowerCase());
			if (!sub) return { kind: "error", message: `未知子命令 ${token}。可用子命令：${SUBCOMMANDS.join("、")}` };
			continue;
		}
		if (token === "--prompt") {
			if (sub !== "send") return { kind: "error", message: `${sub} 不接受 --prompt` };
			if (!sessionId) return targetRequired(sub);
			// Only the separator is syntax; keep all remaining whitespace and command-looking text as content.
			const prompt = rest.slice(tokens.lastIndex).replace(/^(?:\r\n|\s)/, "");
			if (!prompt.trim()) return { kind: "error", message: "--prompt 之后要有正文" };
			return { kind: "send", sessionId, prompt };
		}
		if (token.startsWith("-")) return unknownOption(token, sub);
		return { kind: "error", message: `${sub} 不接受位置参数（${token}）；正文请写在 --prompt 之后` };
	}
	if (!sub) return sessionId ? { kind: "session", sessionId } : { kind: "help" };
	if (sub === "sessions")
		return sessionId ? { kind: "error", message: "sessions 不需要 --session-id" } : { kind: "sessions" };
	if (!sessionId) return targetRequired(sub);
	if (sub === "send")
		return { kind: "error", message: `缺少 --prompt。例如：${sessionCommand(sessionId, sub, "检查构建")}` };
	return { kind: sub, sessionId };
}

function unknownOption(token: string, sub?: Subcommand): WeComCommand {
	const allowed = sub ? (sub === "send" ? ["--prompt", "--help"] : ["--help"]) : ["--session-id", "--help"];
	return {
		kind: "error",
		message: sentences(`未知选项 ${token}`, `可用选项：${allowed.join("、")}`, "参数用空格分隔，不支持 ="),
	};
}

function targetRequired(action: SessionAction): WeComCommand {
	return {
		kind: "error",
		message: sentences(
			`${action} 需要目标：${sessionCommand("<id>", action)}`,
			`先发 ${COMMAND_PREFIX} sessions 获取 ID`,
		),
	};
}

/** A command line for one session, as the cards and help write it. */
export function sessionCommand(sessionId: string, action: SessionAction, prompt = "<正文>"): string {
	return `${COMMAND_PREFIX} --session-id ${sessionId} ${action}${action === "send" ? ` --prompt ${prompt}` : ""}`;
}

/** The WeCom side's help: one subcommand, or all of them. */
export function helpText(topic?: Subcommand): string {
	switch (topic) {
		case "send":
			return [
				"send — 把一段正文作为任务交给指定会话",
				"",
				`用法：${sessionCommand("<完整 session ID>", "send")}`,
				"",
				"--session-id 必须写在动作前；--prompt 必须放在最后，其后全部内容都是正文（可换行）",
				"参数用空格分隔，不支持 =",
			].join("\n");
		case "card":
			return [
				"card — 在当前聊天显式补发这个会话的控制卡",
				"",
				`用法：${sessionCommand("<完整 session ID>", "card")}`,
				"",
				"补发会产生一张新卡，下拉框列出此刻在线的所有会话；旧卡仍可操作同一个在线会话，不会启动任务",
			].join("\n");
		case "cancel":
			return [
				"cancel — 请求中止指定会话正在运行的一轮",
				"",
				`用法：${sessionCommand("<完整 session ID>", "cancel")}`,
				"",
				"中止是异步生效的，这一轮可能还会输出最后一点内容",
			].join("\n");
		case "sessions":
			return [
				"sessions — 打开在线会话卡",
				"",
				"用法：/wecom-aibot sessions",
				"",
				"正文每个会话一行（忙闲 | 文件夹 · ID 末 4 位 · 模型），一页 5 个，超过时用「上一页」「下一页」翻",
				"「会话」下拉框和这一页的行一样；按钮作用于选的会话，和控制卡同名按钮一样，点了卡片换成它的控制卡",
				"不记目标：普通消息没有引用时，机器人会问发给哪个会话",
			].join("\n");
		default:
			return [
				"企业微信侧命令（pi 里的 /wecom-aibot 是另一套设备命令）：",
				"",
				"/wecom-aibot sessions                   查看在线会话，打开某个会话的控制卡",
				"/wecom-aibot --session-id <id>          查看该会话并列出可复制命令",
				sessionCommand("<id>", "send"),
				`${sessionCommand("<id>", "card")}     补发该会话的控制卡`,
				`${sessionCommand("<id>", "cancel")}   请求中止该会话正在运行的一轮`,
				"",
				"普通消息：引用某个会话的消息就发给它；没有引用时机器人发一张卡问这一条发给谁，不记住选择",
				"--session-id 必须写在动作前，只作用于本条命令；命令不从引用补目标",
				"参数用空格分隔，不支持 =。--prompt 必须放在最后，其后全部是正文",
				"查看单个命令：/wecom-aibot <子命令> --help；带目标的 --help 同样只显示帮助",
			].join("\n");
	}
}
