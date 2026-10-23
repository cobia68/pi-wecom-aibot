/**
 * WeCom callback bodies are parsed only here, at the gateway boundary; pi receives the result.
 * Reference: https://developer.work.weixin.qq.com/document/path/101463
 */

export type WeComState = "disconnected" | "connecting" | "connected" | "subscribed";

/** A command such as aibot_send_msg is acknowledged within this time, or its outcome is unknown. */
export const WECOM_ACK_TIMEOUT_MS = 10_000;
/** Upload limits from the 上传临时素材 section: an image is 5 bytes to 10MB, one chunk at most 512KB. */
export const WECOM_IMAGE_MIN_BYTES = 5;
export const WECOM_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** A stream message must reach finish=true within 10 minutes of its first send. */
export const WECOM_STREAM_LIFETIME_MS = 600_000;
export const WECOM_REPLY_WINDOW_MS = 24 * 60 * 60_000;

/** A conversation: chatId is the userid in a single chat (chatType 1), the group chatid otherwise. */
export interface ChatRef {
	chatId: string;
	chatType: 1 | 2;
}

/** Media sent by the user; the URL is valid for 5 minutes and the content is AES-encrypted with aeskey. */
export interface Attachment {
	kind: "image" | "file" | "video";
	url: string;
	aeskey?: string;
}

export interface InboundMessage {
	/** The callback's unique ID, for de-duplication and saved file names; may be empty. */
	msgId: string;
	msgtype: string;
	chat: ChatRef;
	userid: string;
	/** Visible text; the leading @mention of a group message is removed. */
	text: string;
	/** Words of the quoted message; unset for a picture-only quote. */
	quoteText?: string;
	attachments: Attachment[];
}

export function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** The sender, checked against allowlists before anything else is parsed. */
export function senderOf(value: unknown): string | undefined {
	const userid = record(record(value)?.from)?.userid;
	return typeof userid === "string" && userid ? userid : undefined;
}

export function parseInbound(value: unknown): InboundMessage | undefined {
	const body = record(value);
	const userid = senderOf(body);
	if (!body || !userid) return undefined;
	const group = body.chattype === "group";
	const rawChatId = group ? body.chatid : userid;
	const chatId = typeof rawChatId === "string" ? rawChatId.trim() : "";
	if (!chatId) return undefined;
	let text = messageText(body);
	if (text === undefined) return undefined;
	if (group) text = text.replace(/^@\S+\s*/, "");
	const quoteText = body.quote ? quotedWords(body.quote) : undefined;
	return {
		msgId: body.msgid === undefined || body.msgid === null ? "" : String(body.msgid),
		msgtype: typeof body.msgtype === "string" ? body.msgtype : "?",
		chat: { chatId, chatType: group ? 2 : 1 },
		userid,
		text,
		...(quoteText ? { quoteText } : {}),
		attachments: attachments(body),
	};
}

/** Plain text of a message or quote; images and files become placeholders. undefined when malformed. */
export function messageText(value: unknown): string | undefined {
	const node = record(value);
	switch (node?.msgtype) {
		case "text":
			return stringOrUndefined(record(node.text)?.content);
		case "markdown":
			return stringOrUndefined(record(node.markdown)?.content);
		case "voice":
			return stringOrUndefined(record(node.voice)?.content);
		case "mixed": {
			const items = record(node.mixed)?.msg_item;
			if (!Array.isArray(items)) return "";
			const parts: string[] = [];
			for (const item of items) {
				const entry = record(item);
				const part = entry?.msgtype === "text" ? stringOrUndefined(record(entry.text)?.content) : "[图片]";
				if (part === undefined) return undefined;
				parts.push(part);
			}
			return parts.join("\n");
		}
		case "image":
			return "[图片]";
		case "file":
			return "[文件]";
		case "video":
			return "[视频]";
		default:
			return typeof node?.msgtype === "string" && node.msgtype ? `[${node.msgtype}]` : "";
	}
}

/** A quote never names the message it quotes: the gateway reads an image's own marker to find its session. */
export interface QuotedImage {
	msgtype: string;
	quoteFields: string[];
	/** Fields of the quoted image, names only: whether WeCom sent an aeskey, or anything else. */
	imageFields: string[];
	url?: string;
	aeskey?: string;
}

export function quotedImage(value: unknown): QuotedImage | undefined {
	const quote = record(record(value)?.quote);
	const msgtype = typeof quote?.msgtype === "string" ? quote.msgtype : "";
	if (!quote || ["text", "markdown", "voice"].includes(msgtype)) return undefined;
	let image = msgtype === "image" ? record(quote.image) : undefined;
	if (msgtype === "mixed") {
		const items = record(quote.mixed)?.msg_item;
		const entry = Array.isArray(items) ? items.map(record).find((item) => item?.msgtype === "image") : undefined;
		image = record(entry?.image);
	}
	return {
		msgtype,
		quoteFields: Object.keys(quote),
		imageFields: image ? Object.keys(image) : [],
		...(typeof image?.url === "string" && image.url ? { url: image.url } : {}),
		...(typeof image?.aeskey === "string" && image.aeskey ? { aeskey: image.aeskey } : {}),
	};
}

const PLACEHOLDER = /^\[[^[\]\s]{1,20}\]$/;

/** A quote's words without placeholders: "[图片]" handed to pi would read as something the user wrote. */
function quotedWords(value: unknown): string | undefined {
	const text = messageText(value);
	if (text === undefined) return undefined;
	const words = text
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			return trimmed && !PLACEHOLDER.test(trimmed);
		})
		.join("\n");
	return words || undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
	return value === undefined ? "" : typeof value === "string" ? value : undefined;
}

function attachments(body: Record<string, unknown>): Attachment[] {
	const result: Attachment[] = [];
	const add = (kind: Attachment["kind"], value: unknown) => {
		const node = record(value);
		if (typeof node?.url !== "string" || !node.url) return;
		result.push({
			kind,
			url: node.url,
			...(typeof node.aeskey === "string" && node.aeskey ? { aeskey: node.aeskey } : {}),
		});
	};
	if (body.msgtype === "image") add("image", body.image);
	if (body.msgtype === "file") add("file", body.file);
	if (body.msgtype === "video") add("video", body.video);
	const mixed = record(body.mixed)?.msg_item;
	if (body.msgtype === "mixed" && Array.isArray(mixed)) {
		for (const item of mixed) {
			const entry = record(item);
			if (entry?.msgtype === "image") add("image", entry.image);
		}
	}
	return result;
}
