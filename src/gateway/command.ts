/** The WeCom-side command surface is only help and the session picker; tasks and controls are interactive. */
import { sentences } from "../shared/text.ts";

const COMMAND_PREFIX = "/wecom-aibot";

export type WeComCommand =
	| { kind: "none" }
	| { kind: "error"; message: string }
	| { kind: "help" }
	| { kind: "sessions" };

/** Expand explicit aliases before canonical validation; ordinary argument values stay intact. */
function expandAliases(text: string): string[] | undefined {
	const [prefix, ...args] = text.trim().split(/\s+/);
	// Hidden whole-command alias, not another command namespace.
	if (prefix === "/boom") args.unshift("sessions");
	else if ((prefix === "/wa" ? COMMAND_PREFIX : prefix) !== COMMAND_PREFIX) return undefined;
	return args.map((arg, index) => {
		if (arg === "-h") return "--help";
		return index === 0 && arg === "s" ? "sessions" : arg;
	});
}

/** Full and short forms share validation. Unknown commands are errors, never prompts; names are case-sensitive. */
export function parseWeComCommand(text: string): WeComCommand {
	const tokens = expandAliases(text);
	if (!tokens) return { kind: "none" };
	const [action, extra] = tokens;
	if (!action) return unexpected("缺少子命令或帮助选项");
	if (action === "--help") return extra ? unexpected(`--help 不接受参数（${extra}）`) : { kind: "help" };
	if (action === "sessions") return extra ? unexpected(`sessions 不接受参数（${extra}）`) : { kind: "sessions" };
	return unexpected(`${action.startsWith("-") ? "未知选项" : "未知子命令"} ${action}`);
}

function unexpected(reason: string): WeComCommand {
	return {
		kind: "error",
		message: sentences(reason, "可用 /wa s 查看会话，/wa -h 查看帮助", "任务请直接发送，其他操作请用控制卡"),
	};
}

export function helpText(): string {
	return [
		"企业微信侧命令（缩写不适用于 pi 终端）：",
		"",
		"/wecom-aibot sessions（/wa s）   查看在线会话，打开会话的控制卡",
		"/wecom-aibot --help（/wa -h）    显示这份帮助",
		"",
		"完整写法和缩写可混用，区分大小写；必须指定子命令或帮助选项",
		"sessions 不接受参数；帮助选项只用于顶层，不接受参数",
		"发任务：直接发消息，机器人会询问这一条发给哪个会话；也可引用带会话标识的文字消息发送，不记住选择",
		"控制会话：在控制卡上刷新、发提示词、切换模型或中止任务",
		"卡片不可用时可稍后重试；仍不可用请回到 pi 终端操作",
	].join("\n");
}
