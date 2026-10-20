/**
 * WeCom callback bodies are parsed once, here, at the gateway boundary. pi receives
 * the result, so the raw platform format has exactly one reader.
 * Reference: https://developer.work.weixin.qq.com/document/path/101463
 */

/** Connection state reported by the gateway and consumed by pi through IPC. */
export type WeComState = "disconnected" | "connecting" | "connected" | "subscribed";

/** A command such as aibot_send_msg is acknowledged within this time, or its outcome is unknown. */
export const WECOM_ACK_TIMEOUT_MS = 10_000;
/** Upload limits from the 上传临时素材 section: an image is 5 bytes to 10MB, one chunk at most 512KB. */
export const WECOM_IMAGE_MIN_BYTES = 5;
export const WECOM_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** A stream message must reach finish=true within 10 minutes of its first send. */
export const WECOM_STREAM_LIFETIME_MS = 600_000;
/** Replies to a message callback are accepted for 24 hours. */
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
	/** Text the message quotes, when it says something in words; a quote that is only a picture leaves this unset. */
	quoteText?: string;
	attachments: Attachment[];
}

/** A JSON object from the platform; undefined for anything else. The one narrowing used at this boundary. */
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

/** undefined when the callback has no usable sender, conversation or text. */
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

/**
 * A quote that is not plainly text, so it may be an image this gateway sent: its type, field names and
 * any image download link. A quote never names the message it quotes; the gateway reads the image's own
 * marker to find out which session sent it.
 */
export interface QuotedImage {
	msgtype: string;
	/** Top-level fields of the quote, names only. */
	quoteFields: string[];
	/** Fields of the quoted image, names only: whether WeCom sent an aeskey, or anything else. */
	imageFields: string[];
	url?: string;
	aeskey?: string;
}

/** undefined without a quote or for text, Markdown and voice quotes; an image may sit inside a mixed one. */
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

/** A placeholder standing in for a picture, file or video: it names no target and is not something a person said. */
const PLACEHOLDER = /^\[[^[\]\s]{1,20}\]$/;

/**
 * The words of a quote. An image quote carries only a placeholder, and handing that to pi as if the user
 * had written "[图片]" makes the prompt look like it contains a statement it does not; a mixed quote keeps
 * its text and loses only the placeholders.
 */
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
