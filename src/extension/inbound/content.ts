/** The pi prompt for one WeCom message: text, quote, downloaded images and saved attachments. */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { errorMessage } from "../../shared/text.ts";
import type { Attachment, InboundMessage } from "../../shared/wecom-protocol.ts";
import { downloadAndDecrypt, saveMedia } from "./media.ts";

/** Files from WeCom are kept in the project, but never committed by accident. */
async function mediaDirectory(cwd: string): Promise<string> {
	const dir = join(cwd, ".pi-wecom-aibot-files");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, ".gitignore"), "# Saved by pi-wecom-aibot from WeCom messages.\n*\n", {
		flag: "wx",
	}).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	return dir;
}

export interface PreparedInboundContent {
	content: (TextContent | ImageContent)[];
	label: string;
	/** Release the queued-image budget when handed to pi or discarded. Idempotent. */
	release(): void;
}

/** Per-session prefetch: short-lived URLs are still fetched early, but preparations and queued images are bounded. */
export class InboundContentPreparer {
	private readonly concurrency: number;
	private readonly maxImageBytes: number;
	private preparing = 0;
	private imageBytes = 0;
	private readonly waiting: (() => void)[] = [];

	constructor(limits: { concurrency?: number; maxImageBytes?: number } = {}) {
		this.concurrency = limits.concurrency ?? 2;
		// Base64 payload bytes retained by this plugin, not pi's own active run or conversation history.
		this.maxImageBytes = limits.maxImageBytes ?? 128 * 1024 * 1024;
	}

	async prepare(cwd: string, message: InboundMessage, signal: AbortSignal): Promise<PreparedInboundContent> {
		signal.throwIfAborted();
		const hasMedia = message.attachments.length > 0;
		if (hasMedia) await this.acquire(signal);
		let imageBytes = 0;
		const release = () => {
			this.imageBytes -= imageBytes;
			imageBytes = 0;
		};
		const reserveImage = (bytes: number) => {
			if (this.imageBytes + bytes > this.maxImageBytes)
				throw new Error("待处理图片总量已达资源上限，请稍后重发这张图片");
			this.imageBytes += bytes;
			imageBytes += bytes;
		};
		try {
			return { ...(await buildUserContent(cwd, message, signal, reserveImage)), release };
		} catch (error) {
			release();
			throw error;
		} finally {
			// Cover download, decrypt, conversion AND disk writes: a slow disk cannot accumulate unbounded buffers.
			if (hasMedia) {
				this.preparing--;
				this.waiting.shift()?.();
			}
		}
	}

	private acquire(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			const enter = () => {
				signal.removeEventListener("abort", cancel);
				this.preparing++;
				resolve();
			};
			const cancel = () => {
				const index = this.waiting.indexOf(enter);
				if (index >= 0) this.waiting.splice(index, 1);
				reject(signal.reason);
			};
			if (this.preparing < this.concurrency) enter();
			else {
				this.waiting.push(enter);
				signal.addEventListener("abort", cancel, { once: true });
			}
		});
	}
}

async function buildUserContent(
	cwd: string,
	message: InboundMessage,
	signal: AbortSignal,
	reserveImage: (bytes: number) => void,
): Promise<{ content: (TextContent | ImageContent)[]; label: string }> {
	signal.throwIfAborted();
	// The source line names who sent it and where, never the chat's ID; a quote and saved files are blocks of their own.
	const header = `[wecom|from:${field(message.userid)}|chat:${message.chat.chatType === 2 ? "群聊" : "单聊"}]`;
	const quote = message.quoteText ? `[quote]\n${message.quoteText}\n[/quote]` : "";
	let text = message.text;

	const images: ImageContent[] = [];
	const saved: string[] = [];
	const notes: string[] = [];

	const addImage = async (attachment: Attachment): Promise<void> => {
		try {
			const media = await downloadAndDecrypt(attachment.url, attachment.aeskey, { signal });
			if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(media.mimeType))
				throw new Error("不支持的图片格式");
			reserveImage(4 * Math.ceil(media.buffer.byteLength / 3));
			images.push({
				type: "image",
				data: media.buffer.toString("base64"),
				mimeType: media.mimeType,
			});
		} catch (err) {
			signal.throwIfAborted();
			notes.push(`[图片处理失败：${errorMessage(err)}]`);
		}
	};

	const saveAttachment = async (attachment: Attachment, kind: "file" | "video"): Promise<void> => {
		try {
			const media = await downloadAndDecrypt(attachment.url, attachment.aeskey, { signal });
			signal.throwIfAborted();
			const dir = await mediaDirectory(cwd);
			const file = await saveMedia(dir, `${message.msgId || "media"}-${kind}`, media, signal);
			saved.push(`${kind === "video" ? "视频" : "文件"}：${file}`);
		} catch (err) {
			signal.throwIfAborted();
			notes.push(`[${kind}处理失败：${errorMessage(err)}]`);
		}
	};

	// In message order, one at a time: a slow download keeps its place.
	for (const attachment of message.attachments) {
		if (attachment.kind === "image") await addImage(attachment);
		else await saveAttachment(attachment, attachment.kind);
	}

	if (images.length && /^\[图片\]$/.test(text.trim())) text = "";
	signal.throwIfAborted();
	const attachments = saved.length ? `[attachments]\n${saved.join("\n")}\n[/attachments]` : "";
	const full = [header, quote, text, attachments, ...notes].filter(Boolean).join("\n");
	return {
		content: [{ type: "text", text: full }, ...images],
		label: `${message.chat.chatType === 2 ? "group" : "single"}/${message.msgtype}`,
	};
}

/** A userid as a header value: no line break or delimiter can end the line early. */
function field(value: string): string {
	return value.replace(/[\s|\]]+/g, "_");
}
