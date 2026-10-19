import type { GatewayNotification, NotificationKind, NotificationSource } from "./notification-types.ts";

export const MAX_NOTIFICATION_BYTES = 20_480;
export const DEFAULT_TAIL_PARAGRAPHS = 3;
export const NO_REPLY_TEXT = "（本轮没有新的文本输出）";
/** A notification body sent over IPC; the gateway cuts it to MAX_NOTIFICATION_BYTES with its header. */
const MAX_NOTIFICATION_BODY_BYTES = 256 * 1024;

/** The second line of a task's status message. The gateway recognises quoted status messages by it. */
const STATUS_TEXT = {
	running: "执行中…",
	settled: "本轮已结束。",
	stopped: "转发已停止。",
	waiting: "任务仍在执行，请等待会话通知。",
	busy: "当前等待任务较多，请稍后重试。",
	failed: "消息处理失败，请检查消息内容后重试。",
} as const;
export type ProcessingState = keyof typeof STATUS_TEXT;

export interface NotificationOptions {
	kind?: NotificationKind;
	tailParagraphs?: number;
	aborted?: boolean;
}

const TITLES: Record<NotificationKind, string> = {
	notification: "会话通知", completion: "会话通知", reply: "会话通知", test: "部署测试", welcome: "欢迎",
};
/** Header line icons. They lead each line; quotedSessions accepts the session line with or without its icon. */
const ICONS = { title: "🔔", model: "🏷️", session: "🆔" } as const;

/** Blank lines delimit paragraphs; fenced code blocks remain a single block. */
export function lastParagraphs(text: string, count: number): string {
	if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("tail_paragraphs 必须是 1 到 20 的整数");
	const paragraphs: string[] = [];
	let lines: string[] = [];
	let fence: string | undefined;
	const flush = () => {
		const paragraph = lines.join("\n").trim();
		if (paragraph) paragraphs.push(paragraph);
		lines = [];
	};
	for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
		const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (fence) {
			lines.push(line);
			if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
				fence = undefined;
				flush();
			}
		} else if (marker) {
			flush();
			fence = marker[1];
			lines.push(line);
		} else if (!line.trim()) {
			flush();
		} else {
			lines.push(line);
		}
	}
	flush();
	return paragraphs.slice(-count).join("\n\n");
}

function truncateContent(text: string, maxBytes: number, keepTail: boolean): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	const marker = keepTail ? "…（前文已截断）\n\n" : "\n\n…（内容过长已截断）";
	const budget = maxBytes - Buffer.byteLength(marker, "utf8");
	if (budget < 0) throw new Error("通知来源信息过长，无法容纳正文");
	if (keepTail) {
		let start = bytes.length - budget;
		while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
		return marker + bytes.subarray(start).toString("utf8");
	}
	let end = budget;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8") + marker;
}

function metadataValue(value: string, plain: boolean): string {
	const line = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
	if (plain) return line;
	return line.replace(/[\\`*_#\[\]<>]/g, "\\$&");
}

function validateSessionId(sessionId: string): void {
	if (!sessionId || sessionId.length > 256 || /[\u0000-\u0020\u007f`]/.test(sessionId)) {
		throw new Error("无效的 pi session_id");
	}
}

/** Update this small status in place; publish the actual result separately. */
export function formatProcessingStatus(sessionId: string, state: ProcessingState): string {
	validateSessionId(sessionId);
	return `${ICONS.session} session: ${metadataValue(sessionId, false)}  \n${STATUS_TEXT[state]}`;
}

/** One envelope for final notifications, deployment checks and welcome messages. */
export function formatNotification(
	source: NotificationSource,
	text: string,
	options: NotificationOptions = {},
): string {
	if (!text.trim()) throw new Error("当前 pi 会话没有可发送的文本回复");
	const excerpt = options.tailParagraphs !== undefined;
	const body = excerpt ? lastParagraphs(text, options.tailParagraphs!) : text;
	return renderNotification(source, body, { kind: options.kind, excerpt, aborted: options.aborted });
}

/**
 * The gateway's half of formatNotification: the source header plus a body that is already excerpted.
 * An excerpt, a reply and a welcome are cut to the byte limit; other text that does not fit is an error.
 */
export function renderNotification(
	source: NotificationSource,
	body: string,
	options: { kind?: NotificationKind; excerpt?: boolean; aborted?: boolean } = {},
): string {
	validateSessionId(source.sessionId);
	if (!body.trim()) throw new Error("当前 pi 会话没有可发送的文本回复");
	const kind = options.kind ?? "notification";
	const plain = kind === "welcome";
	const title = `${ICONS.title} ${metadataValue(source.directoryName, plain)} · ${TITLES[kind]}`;
	const header = [
		title,
		`${ICONS.model} ${metadataValue(source.provider, plain)} · ${metadataValue(source.modelName, plain)}`,
		`${ICONS.session} session: ${metadataValue(source.sessionId, plain)}`,
	].join(plain ? "\n" : "  \n") + "\n\n";
	const suffix = options.aborted ? "\n\n（本轮任务已中止）" : "";
	const limit = plain ? 2048 : MAX_NOTIFICATION_BYTES;
	const budget = limit - Buffer.byteLength(header + suffix, "utf8");
	if (budget < 0) throw new Error("通知来源信息过长，无法容纳正文");
	let content = body.trim();
	if (options.excerpt || kind === "reply" || plain) {
		content = truncateContent(content, budget, !!options.excerpt);
	}
	if (Buffer.byteLength(content, "utf8") > budget) {
		throw new Error("通知内容（含 session_id、供应商、模型、工作目录）不能超过 20480 个 UTF-8 字节；可设置 tail_paragraphs 截取末尾");
	}
	return header + content + suffix;
}

/**
 * pi's half: excerpt here, where the full reply is, and bound the body for IPC. The gateway renders it.
 * formatNotification(source, text, options) is what the gateway will send.
 */
export function notificationPayload(
	kind: GatewayNotification["kind"],
	source: NotificationSource,
	text: string,
	options: { tailParagraphs?: number; aborted?: boolean } = {},
): GatewayNotification {
	const excerpt = options.tailParagraphs !== undefined;
	const body = excerpt ? lastParagraphs(text, options.tailParagraphs!) : text;
	// A longer body could never be sent whole; keep the part the gateway would keep.
	const bounded = Buffer.byteLength(body, "utf8") <= MAX_NOTIFICATION_BODY_BYTES ? body
		: sliceUtf8(body, MAX_NOTIFICATION_BODY_BYTES, excerpt);
	return { kind, source: { ...source }, text: bounded, ...(excerpt ? { excerpt } : {}), ...(options.aborted ? { aborted: true } : {}) };
}

/**
 * Replace the body with one screen representation: a notification is either text or an image, never both.
 * The body keeps its tail when it exceeds the gateway's byte budget, so the end of the screen (where the
 * answer usually is) survives; `excerpt` also lets the gateway trim a body this build overestimated.
 */
export function replaceNotificationBody(notification: GatewayNotification, body: string): GatewayNotification {
	const text = body.trim();
	if (!text) throw new Error("当前 pi 会话没有可发送的内容");
	const overhead = Buffer.byteLength(renderNotification(notification.source, "x", notification), "utf8") - 1;
	const budget = MAX_NOTIFICATION_BYTES - overhead;
	if (budget < 0) throw new Error("通知来源信息过长，无法容纳正文");
	return { ...notification, text: truncateContent(text, budget, true), excerpt: true };
}

/**
 * The session IDs a quoted message routes to. A notification's or status message's source header is
 * authoritative; a damaged header yields "", which never matches, so routing asks instead of guessing.
 */
export function quotedSessions(text: string): string[] {
	const lines = text.trimStart().split(/\r?\n/).map((line) => line.replace(/^>\s?/, "").trimEnd());
	if (TITLE_LINE.test(lines[0])) return [sessionInLine(lines[2]) ?? ""];
	if (STATUS_LINES.has(lines[1] ?? "")) return [sessionInLine(lines[0]) ?? ""];
	const matches = [...text.matchAll(/^\s*(?:>\s*)?(?:🆔 )?session: ([^\s]+)[ \t]*$/gm)];
	const ids = [...new Set(matches.map((match) => unescapeMetadata(match[1])))];
	// Task output can itself mention sessions: a marker that is not a clean session line is damage.
	const markers = [...text.matchAll(/\bsession\s*:/gi)].length;
	const missingNotificationSource = ids.length === 0 && TITLE_ANYWHERE.test(text);
	return markers !== matches.length || missingNotificationSource ? [...ids, ""] : ids;
}

const titleAlternatives = [...new Set(Object.values(TITLES))].join("|");
const TITLE_LINE = new RegExp(` · (?:${titleAlternatives})$`);
const TITLE_ANYWHERE = new RegExp(` · (?:${titleAlternatives})(?:\\s|$)`);
const STATUS_LINES = new Set<string>(Object.values(STATUS_TEXT));

function sessionInLine(line: string | undefined): string | undefined {
	const id = /^(?:🆔 )?session: ([^\s]+)[ \t]*$/.exec(line ?? "")?.[1];
	return id === undefined ? undefined : unescapeMetadata(id);
}

function unescapeMetadata(value: string): string {
	return value.replace(/\\([\\`*_#\[\]<>])/g, "$1");
}

function sliceUtf8(text: string, maxBytes: number, keepTail: boolean): string {
	const bytes = Buffer.from(text, "utf8");
	if (keepTail) {
		let start = bytes.length - maxBytes;
		while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
		return bytes.subarray(start).toString("utf8");
	}
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}
