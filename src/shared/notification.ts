import type { GatewayNotification, NotificationKind, NotificationSource } from "./notification-types.ts";

export const MAX_NOTIFICATION_BYTES = 20_480;
export const DEFAULT_TAIL_PARAGRAPHS = 3;
export const NO_REPLY_TEXT = "（本轮没有新的文本输出）";
/** A notification body sent over IPC; the gateway cuts it to MAX_NOTIFICATION_BYTES with its header. */
const MAX_NOTIFICATION_BODY_BYTES = 256 * 1024;

/** The second line of a task's status message. The gateway recognises quoted status messages by it. */
const STATUS_TEXT = {
	running: "执行中…",
	settled: "本轮已结束",
	notifying: "本轮已结束，结果将另行通知",
	stopped: "转发已停止",
	waiting: "任务仍在执行，请等待会话通知",
	busy: "当前等待任务较多，请稍后重试",
	failed: "消息处理失败，请检查消息内容后重试",
} as const;
export type ProcessingState = keyof typeof STATUS_TEXT;

export interface NotificationOptions {
	kind?: NotificationKind;
	tailParagraphs?: number;
	aborted?: boolean;
	imageFailure?: string;
}

const TITLES: Record<NotificationKind, string> = {
	notification: "会话通知",
	completion: "会话通知",
	reply: "会话通知",
	test: "部署测试",
	connect: "会话已接入",
};
/** Markdown header line icons. The rendered image draws its own SVG line icons instead. */
export const NOTIFICATION_ICONS = { title: "🔔", model: "🏷️", session: "🆔" } as const;

export function notificationHeader(source: NotificationSource, kind: NotificationKind) {
	validateSessionId(source.sessionId);
	const clean = (value: string) => metadataValue(value, true);
	return {
		directory: clean(source.directoryName),
		title: TITLES[kind],
		provider: clean(source.provider),
		model: clean(source.modelName),
		session: clean(source.sessionId),
	};
}

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
	return line.replace(/[\\`*_#[\]<>]/g, "\\$&");
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

/** Update this small status in place; publish the actual result separately. */
export function formatProcessingStatus(sessionId: string, state: ProcessingState): string {
	validateSessionId(sessionId);
	return `${NOTIFICATION_ICONS.session} session: ${metadataValue(sessionId, false)}  \n${STATUS_TEXT[state]}`;
}

export function formatNotification(
	source: NotificationSource,
	text: string,
	options: NotificationOptions = {},
): string {
	if (!text.trim()) throw new Error("当前 pi 会话没有可发送的文本回复");
	const count = options.tailParagraphs;
	const body = count === undefined ? text : lastParagraphs(text, count);
	return renderNotification(source, body, {
		kind: options.kind,
		excerpt: count !== undefined,
		aborted: options.aborted,
		imageFailure: options.imageFailure,
	});
}

/** The gateway's half of formatNotification: the body arrives already excerpted. */
export function renderNotification(
	source: NotificationSource,
	body: string,
	options: { kind?: NotificationKind; excerpt?: boolean; aborted?: boolean; imageFailure?: string } = {},
): string {
	const layout = layoutNotification(source, body, options);
	if ("reason" in layout) throw new Error(layout.reason);
	return layout.text;
}

/** renderNotification's rules as a returned reason, for callers that only ask whether it is sendable. */
export function notificationProblem(
	source: NotificationSource,
	text: string,
	options: NotificationOptions = {},
): string | undefined {
	const count = options.tailParagraphs;
	if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 20)) {
		return "tail_paragraphs 必须是 1 到 20 的整数";
	}
	const body = count === undefined ? text : lastParagraphs(text, count);
	const layout = layoutNotification(source, body, {
		kind: options.kind,
		excerpt: count !== undefined,
		aborted: options.aborted,
		imageFailure: options.imageFailure,
	});
	return "reason" in layout ? layout.reason : undefined;
}

function layoutNotification(
	source: NotificationSource,
	body: string,
	options: { kind?: NotificationKind; excerpt?: boolean; aborted?: boolean; imageFailure?: string },
): { text: string } | { reason: string } {
	const invalid = sessionIdProblem(source.sessionId);
	if (invalid) return { reason: invalid };
	if (!body.trim()) return { reason: "当前 pi 会话没有可发送的文本回复" };
	const kind = options.kind ?? "notification";
	const title = `${NOTIFICATION_ICONS.title} ${metadataValue(source.directoryName, false)} · ${TITLES[kind]}`;
	const header = `${[
		title,
		`${NOTIFICATION_ICONS.model} ${metadataValue(source.provider, false)} · ${metadataValue(source.modelName, false)}`,
		`${NOTIFICATION_ICONS.session} session: ${metadataValue(source.sessionId, false)}`,
	].join("  \n")}\n\n`;
	const failure = options.imageFailure?.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 200);
	const suffix =
		(options.aborted ? "\n\n（本轮任务已中止）" : "") +
		(failure ? `\n\n（图片发送失败：${failure}，已改发文字）` : "");
	const limit = MAX_NOTIFICATION_BYTES;
	const budget = limit - Buffer.byteLength(header + suffix, "utf8");
	if (budget < 0) return { reason: "通知来源信息过长，无法容纳正文" };
	let content = body.trim();
	if (options.excerpt || kind === "reply" || failure) {
		content = truncateContent(content, budget, !!options.excerpt);
	}
	if (Buffer.byteLength(content, "utf8") > budget) {
		return {
			reason:
				"通知内容（含 session_id、供应商、模型、工作目录）不能超过 20480 个 UTF-8 字节；可设置 tail_paragraphs 截取末尾",
		};
	}
	return { text: header + content + suffix };
}

/** pi's half: excerpt here, where the full reply is, and bound the body for IPC; the gateway renders it. */
export function notificationPayload(
	kind: GatewayNotification["kind"],
	source: NotificationSource,
	text: string,
	options: { tailParagraphs?: number; aborted?: boolean; taskId?: string } = {},
): GatewayNotification {
	const excerpt = options.tailParagraphs !== undefined;
	const count = options.tailParagraphs;
	const body = count === undefined ? text : lastParagraphs(text, count);
	// A longer body could never be sent whole; keep the part the gateway would keep.
	const bounded =
		Buffer.byteLength(body, "utf8") <= MAX_NOTIFICATION_BODY_BYTES
			? body
			: sliceUtf8(body, MAX_NOTIFICATION_BODY_BYTES, excerpt);
	return {
		kind,
		source: { ...source },
		text: bounded,
		...(options.taskId ? { taskId: options.taskId } : {}),
		...(excerpt ? { excerpt } : {}),
		...(options.aborted ? { aborted: true } : {}),
	};
}

/** The source header is authoritative; a damaged one yields "", which never matches, so routing asks, not guesses. */
export function quotedSessions(text: string): string[] {
	const lines = text
		.trimStart()
		.split(/\r?\n/)
		.map((line) => line.replace(/^>\s?/, "").trimEnd());
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
/** Status lines as sent now and as sent before they lost their final full stop: both may be quoted. */
const OLD_FULL_STOP = "。";
const STATUS_LINES = new Set<string>(Object.values(STATUS_TEXT).flatMap((line) => [line, `${line}${OLD_FULL_STOP}`]));

function sessionInLine(line: string | undefined): string | undefined {
	const id = /^(?:🆔 )?session: ([^\s]+)[ \t]*$/.exec(line ?? "")?.[1];
	return id === undefined ? undefined : unescapeMetadata(id);
}

function unescapeMetadata(value: string): string {
	return value.replace(/\\([\\`*_#[\]<>])/g, "$1");
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
