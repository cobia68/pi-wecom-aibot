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
	quoteText?: string;
	attachments: Attachment[];
}

/** The sender, checked against allowlists before anything else is parsed. */
export function senderOf(body: any): string | undefined {
	const userid = body?.from?.userid;
	return typeof userid === "string" && userid ? userid : undefined;
}

/** undefined when the callback has no usable sender, conversation or text. */
export function parseInbound(body: any): InboundMessage | undefined {
	const userid = senderOf(body);
	if (!userid) return undefined;
	const group = body.chattype === "group";
	const rawChatId = group ? body.chatid : userid;
	const chatId = typeof rawChatId === "string" ? rawChatId.trim() : "";
	if (!chatId) return undefined;
	let text = messageText(body);
	if (text === undefined) return undefined;
	if (group) text = text.replace(/^@\S+\s*/, "");
	const quoteText = body.quote ? messageText(body.quote) : undefined;
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
export function messageText(node: any): string | undefined {
	switch (node?.msgtype) {
		case "text": return stringOrUndefined(node.text?.content);
		case "markdown": return stringOrUndefined(node.markdown?.content);
		case "voice": return stringOrUndefined(node.voice?.content);
		case "mixed": {
			const items: unknown = node.mixed?.msg_item;
			if (!Array.isArray(items)) return "";
			const parts: string[] = [];
			for (const item of items) {
				const part = item?.msgtype === "text" ? stringOrUndefined(item.text?.content) : "[图片]";
				if (part === undefined) return undefined;
				parts.push(part);
			}
			return parts.join("\n");
		}
		case "image": return "[图片]";
		case "file": return "[文件]";
		case "video": return "[视频]";
		default: return typeof node?.msgtype === "string" && node.msgtype ? `[${node.msgtype}]` : "";
	}
}

function stringOrUndefined(value: unknown): string | undefined {
	return value === undefined ? "" : typeof value === "string" ? value : undefined;
}

function attachments(body: any): Attachment[] {
	const result: Attachment[] = [];
	const add = (kind: Attachment["kind"], node: any) => {
		if (typeof node?.url !== "string" || !node.url) return;
		result.push({ kind, url: node.url, ...(typeof node.aeskey === "string" && node.aeskey ? { aeskey: node.aeskey } : {}) });
	};
	if (body.msgtype === "image") add("image", body.image);
	if (body.msgtype === "file") add("file", body.file);
	if (body.msgtype === "video") add("video", body.video);
	if (body.msgtype === "mixed" && Array.isArray(body.mixed?.msg_item)) {
		for (const item of body.mixed.msg_item) if (item?.msgtype === "image") add("image", item.image);
	}
	return result;
}
