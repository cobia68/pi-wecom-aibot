/** The WeCom-side command surface is only help and the session picker; tasks and controls are interactive. */
import { sentences } from "../shared/text.ts";

const COMMAND_PREFIX = "/wecom-aibot";

export type WeComCommand =
	| { kind: "none" }
	| { kind: "error"; message: string }
	| { kind: "help"; topic?: "sessions" }
	| { kind: "sessions" };

/** Unknown or retired commands are errors, never prompts delivered to a model. Names remain case-sensitive. */
export function parseWeComCommand(text: string): WeComCommand {
	const trimmed = text.trim();
	if (!new RegExp(`^${COMMAND_PREFIX}(?:\\s|$)`).test(trimmed)) return { kind: "none" };
	const tokens = trimmed.slice(COMMAND_PREFIX.length).trim().split(/\s+/).filter(Boolean);
	const [action, extra, trailing] = tokens;
	if (!action) return { kind: "help" };
	if (action === "--help") return extra ? unexpected(`--help 不接受参数（${extra}）`) : { kind: "help" };
	if (action === "sessions") {
		if (!extra) return { kind: "sessions" };
		if (extra === "--help")
			return trailing
				? unexpected(`sessions --help 不接受参数（${trailing}）`)
				: { kind: "help", topic: "sessions" };
		return unexpected(`sessions 不接受参数（${extra}）`);
	}
	return unexpected(`${action.startsWith("-") ? "未知选项" : "未知子命令"} ${action}`);
}

function unexpected(reason: string): WeComCommand {
	return {
		kind: "error",
		message: sentences(
			reason,
			"企微侧仅支持 /wecom-aibot sessions 和 /wecom-aibot --help",
			"任务请直接发送，其他操作请用控制卡",
		),
	};
}

export function helpText(topic?: "sessions"): string {
	if (topic === "sessions")
		return [
			"sessions — 查看在线会话，打开会话的控制卡",
			"",
			"用法：/wecom-aibot sessions",
			"",
			"每页列出 5 个会话的忙闲、目录和模型，用「上一页」「下一页」翻页",
			"下拉框选会话，点「打开会话」发送它的控制卡；列表保留，可以继续打开其他会话",
			"直接发任务后选择会话；刷新、发提示词、切换模型和中止任务都在控制卡上操作",
		].join("\n");
	return [
		"企业微信侧命令（pi 终端里的 /wecom-aibot 是另一套设备命令）：",
		"",
		"/wecom-aibot sessions  查看在线会话，打开会话的控制卡",
		"/wecom-aibot --help    显示帮助",
		"",
		"发任务：直接发消息，机器人会询问这一条发给哪个会话；也可引用带会话标识的文字消息发送，不记住选择",
		"控制会话：在控制卡上刷新、发提示词、切换模型或中止任务",
		"卡片不可用时可稍后重试；仍不可用请回到 pi 终端操作",
		"查看会话列表的帮助：/wecom-aibot sessions --help",
	].join("\n");
}
