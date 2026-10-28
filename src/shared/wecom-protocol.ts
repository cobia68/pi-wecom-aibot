/**
 * WeCom callback bodies are parsed only here, at the gateway boundary; pi receives the result.
 * Reference: https://developer.work.weixin.qq.com/document/path/101463
 */

export type WeComState = "disconnected" | "connecting" | "connected" | "subscribed";

/** A command such as aibot_send_msg is acknowledged within this time, or its outcome is unknown. */
export const WECOM_ACK_TIMEOUT_MS = 10_000;
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

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** The sender, checked against allowlists before anything else is parsed. */
export function senderOf(value: unknown): string | undefined {
	const userid = asRecord(asRecord(value)?.from)?.userid;
	return typeof userid === "string" && userid ? userid : undefined;
}

export function parseInbound(value: unknown): InboundMessage | undefined {
	const body = asRecord(value);
	const userid = senderOf(body);
	if (!body || !userid || typeof body.msgtype !== "string" || !body.msgtype) return undefined;
	const group = body.chattype === "group";
	const rawChatId = group ? body.chatid : userid;
	const chatId = typeof rawChatId === "string" ? rawChatId.trim() : "";
	if (!chatId) return undefined;
	let text = messageText(body);
	if (text === undefined) return undefined;
	const media = attachments(body);
	if (!media) return undefined;
	if (group) text = text.replace(/^@\S+\s*/, "");
	const quoteText = body.quote ? quotedWords(body.quote) : undefined;
	return {
		msgId: body.msgid === undefined || body.msgid === null ? "" : String(body.msgid),
		msgtype: body.msgtype,
		chat: { chatId, chatType: group ? 2 : 1 },
		userid,
		text,
		...(quoteText ? { quoteText } : {}),
		attachments: media,
	};
}

/** Plain text of a message or quote; images and files become placeholders. undefined when malformed. */
function messageText(value: unknown): string | undefined {
	const node = asRecord(value);
	switch (node?.msgtype) {
		case "text":
			return stringOrUndefined(asRecord(node.text)?.content);
		case "markdown":
			return stringOrUndefined(asRecord(node.markdown)?.content);
		case "voice":
			return stringOrUndefined(asRecord(node.voice)?.content);
		case "mixed": {
			const items = asRecord(node.mixed)?.msg_item;
			if (!Array.isArray(items)) return undefined;
			const parts: string[] = [];
			for (const item of items) {
				const entry = asRecord(item);
				const part = entry?.msgtype === "text" ? stringOrUndefined(asRecord(entry.text)?.content) : "[图片]";
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
			// A kind not listed above is named, not read; no kind at all is malformed.
			return typeof node?.msgtype === "string" && node.msgtype ? `[${node.msgtype}]` : undefined;
	}
}

/** The quote is not words (an image, a file, a mix), so it names no session; WeCom quotes a card as text. */
export function quotesMedia(value: unknown): boolean {
	const quote = asRecord(asRecord(value)?.quote);
	const msgtype = typeof quote?.msgtype === "string" ? quote.msgtype : "";
	return !!quote && !["text", "markdown", "voice"].includes(msgtype);
}

const PLACEHOLDER = /^\[[^[\]\s]{1,20}\]$/;

/**
 * A card's dropdowns at a click, question_key → the first chosen option ID. WeCom sends them only with a
 * button click, as {"selected_item":[{"question_key":"…","option_ids":{"option_id":["…"]}}]} (probed 2026-10).
 */
export function cardSelections(event: unknown): Record<string, string> | undefined {
	const items = asRecord(asRecord(asRecord(event)?.selected_items))?.selected_item;
	if (!Array.isArray(items)) return undefined;
	const chosen: [string, string][] = [];
	for (const value of items.slice(0, 10)) {
		const item = asRecord(value);
		const key = item?.question_key;
		const ids = asRecord(item?.option_ids)?.option_id;
		const id = Array.isArray(ids) ? ids[0] : undefined;
		if (typeof key !== "string" || !key || Buffer.byteLength(key) > 1024) continue;
		if (typeof id !== "string" || !id || Buffer.byteLength(id) > 128) continue;
		chosen.push([key, id]);
	}
	// fromEntries makes own properties only: a "__proto__" key cannot reach the prototype.
	return chosen.length ? Object.fromEntries(chosen) : undefined;
}

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
	return typeof value === "string" ? value : undefined;
}

/** The message's own media; undefined when one of them has no URL to fetch it from. */
function attachments(body: Record<string, unknown>): Attachment[] | undefined {
	const result: Attachment[] = [];
	const add = (kind: Attachment["kind"], value: unknown): boolean => {
		const node = asRecord(value);
		if (typeof node?.url !== "string" || !node.url) return false;
		result.push({
			kind,
			url: node.url,
			...(typeof node.aeskey === "string" && node.aeskey ? { aeskey: node.aeskey } : {}),
		});
		return true;
	};
	if (body.msgtype === "image" && !add("image", body.image)) return undefined;
	if (body.msgtype === "file" && !add("file", body.file)) return undefined;
	if (body.msgtype === "video" && !add("video", body.video)) return undefined;
	const mixed = asRecord(body.mixed)?.msg_item;
	if (body.msgtype === "mixed" && Array.isArray(mixed)) {
		for (const item of mixed) {
			const entry = asRecord(item);
			if (entry?.msgtype === "image" && !add("image", entry.image)) return undefined;
		}
	}
	return result;
}
