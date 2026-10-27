import type { GatewayNotification, NotificationKind, SessionSource } from "./notification-types.ts";

export const MAX_NOTIFICATION_BYTES = 20_480;
export const NO_REPLY_TEXT = "（本轮没有新的文本输出）";
/** A notification body sent over IPC; the gateway keeps the part a message can hold. */
const MAX_NOTIFICATION_BODY_BYTES = 256 * 1024;

/**
 * The one reply a task's message gets, only when it did not run: busy, failed, cleared from the queue, or
 * forwarding stopped. A task that runs gets none; its result is a card.
 */
const STATUS_TEXT = {
	stopped: "转发已停止",
	busy: "当前等待任务较多，请稍后重试",
	failed: "消息处理失败，请检查消息内容后重试",
	cancelled: "这条消息没有执行：已在控制卡上清空排队",
} as const;
export type ProcessingState = keyof typeof STATUS_TEXT;

/** Line icons of the Markdown the bot writes outside a card. */
const NOTIFICATION_ICONS = { model: "🏷️", session: "🆔", directory: "📁" } as const;

/**
 * Text the bot writes into a chat instead of a refused card: its first line names the session, so quoting the
 * message reaches that pi. Cut from the end to fit WeCom's byte limit.
 */
export function sessionMarkdown(source: SessionSource, body: string, suffix = ""): string {
	validateSessionId(source.sessionId);
	const header = `${NOTIFICATION_ICONS.session} session: ${markdownValue(source.sessionId)}  \n${NOTIFICATION_ICONS.model} ${markdownValue(source.directoryName)} · ${markdownValue(source.provider)} · ${markdownValue(source.modelName)}\n\n`;
	const budget = MAX_NOTIFICATION_BYTES - Buffer.byteLength(header + suffix, "utf8");
	if (budget < 64) throw new Error("通知来源信息过长，无法容纳正文");
	return header + truncateContent(body.trim() || NO_REPLY_TEXT, budget) + suffix;
}

/** A short line naming the session, for notes the gateway or pi send outside a card. */
export function sessionNote(sessionId: string, text: string): string {
	return `${NOTIFICATION_ICONS.session} session: ${markdownValue(sessionId)}\n${text}`;
}

export const ABORTED_SUFFIX = "\n\n（本轮任务已中止）";

const TRUNCATED = "\n\n…（内容过长已截断）";

function truncateContent(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	return sliceUtf8(text, maxBytes - Buffer.byteLength(TRUNCATED, "utf8")) + TRUNCATED;
}

/** A value on one Markdown line: no line breaks or control characters, Markdown escaped; `max` cuts it in characters. */
export function markdownValue(value: string, max?: number): string {
	const line = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
	return (max === undefined ? line : [...line].slice(0, max).join("")).replace(/[\\`*_#[\]<>]/g, "\\$&");
}

function sessionIdProblem(sessionId: string): string | undefined {
	return !sessionId || sessionId.length > 256 || /[\u0000-\u0020\u007f`]/.test(sessionId)
		? "无效的 pi session_id"
		: undefined;
}

function validateSessionId(sessionId: string): void {
	const problem = sessionIdProblem(sessionId);
	if (problem) throw new Error(problem);
}

/**
 * A task's reply when it did not run: its first line names the session like every text the bot writes, the
 * next its directory, so a message that reached the wrong pi shows at once.
 */
export function formatProcessingStatus(sessionId: string, state: ProcessingState, directory?: string): string {
	validateSessionId(sessionId);
	const where = directory?.trim() ? `${NOTIFICATION_ICONS.directory} ${markdownValue(directory)}  \n` : "";
	return `${NOTIFICATION_ICONS.session} session: ${markdownValue(sessionId)}  \n${where}${STATUS_TEXT[state]}`;
}

/** pi's half: bound the body for IPC; the gateway renders it. */
export function notificationPayload(
	kind: NotificationKind,
	source: SessionSource,
	text: string,
	options: Pick<GatewayNotification, "title" | "aborted" | "control"> = {},
): GatewayNotification {
	if (!text.trim()) throw new Error("当前 pi 会话没有可发送的文本回复");
	validateSessionId(source.sessionId);
	const bounded =
		Buffer.byteLength(text, "utf8") <= MAX_NOTIFICATION_BODY_BYTES
			? text
			: sliceUtf8(text, MAX_NOTIFICATION_BODY_BYTES);
	return {
		kind,
		source: { ...source },
		text: bounded,
		...(options.title?.trim() ? { title: options.title.trim() } : {}),
		...(options.aborted ? { aborted: true } : {}),
		...(options.control ? { control: options.control } : {}),
	};
}

/**
 * The session a quoted message names. Everything the bot writes outside a card opens with its own session
 * line (the icon, or a status line under it), which is authoritative over the body. Other text is accepted
 * only when every session marker in it is a clean session line naming one ID, so task output that merely
 * mentions sessions makes routing ask instead of guess.
 */
export function quotedSessions(text: string): string[] {
	const lines = text
		.trimStart()
		.split(/\r?\n/)
		.map((line) => line.replace(/^>\s?/, "").trimEnd());
	const first = sessionInLine(lines[0]);
	if (first !== undefined && (lines[0].startsWith(`${NOTIFICATION_ICONS.session} `) || STATUS_LINES.has(lines[1])))
		return [first];
	const matches = [...text.matchAll(/^\s*(?:>\s*)?(?:🆔 )?session: ([^\s]+)[ \t]*$/gm)];
	const ids = [...new Set(matches.map((match) => unescapeMetadata(match[1])))];
	const markers = [...text.matchAll(/\bsession\s*:/gi)].length;
	return markers !== matches.length ? [...ids, ""] : ids;
}

const STATUS_LINES = new Set<string | undefined>(Object.values(STATUS_TEXT));

function sessionInLine(line: string | undefined): string | undefined {
	const id = /^(?:🆔 )?session: ([^\s]+)[ \t]*$/.exec(line ?? "")?.[1];
	return id === undefined ? undefined : unescapeMetadata(id);
}

function unescapeMetadata(value: string): string {
	return value.replace(/\\([\\`*_#[\]<>])/g, "$1");
}

function sliceUtf8(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}
