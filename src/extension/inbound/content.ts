/** The pi prompt for one WeCom message: text, quote, downloaded images and saved attachments. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { downloadAndDecrypt, saveMedia } from "./media.ts";
import type { Attachment, InboundMessage } from "../../shared/wecom-protocol.ts";

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Files from WeCom are kept in the project, but never committed by accident. */
async function mediaDirectory(cwd: string): Promise<string> {
	const dir = join(cwd, ".pi-wecom-files");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, ".gitignore"), "# Saved by pi-wecom-bot from WeCom messages.\n*\n", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
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
		if (![this.concurrency, this.maxImageBytes].every((value) => Number.isSafeInteger(value) && value > 0)) {
			throw new Error("media preparation limits must be positive safe integers");
		}
	}

	async prepare(cwd: string, message: InboundMessage, signal: AbortSignal): Promise<PreparedInboundContent> {
		signal.throwIfAborted();
		const hasMedia = message.attachments.length > 0;
		if (hasMedia) await this.acquire(signal);
		let imageBytes = 0;
		const release = () => { this.imageBytes -= imageBytes; imageBytes = 0; };
		const reserveImage = (bytes: number) => {
			if (this.imageBytes + bytes > this.maxImageBytes) throw new Error("待处理图片总量已达资源上限，请稍后重发这张图片");
			this.imageBytes += bytes;
			imageBytes += bytes;
		};
		try {
			return { ...await buildUserContent(cwd, message, signal, reserveImage), release };
		} catch (error) {
			release();
			throw error;
		} finally {
			// Cover download, decrypt, conversion AND disk writes: a slow disk cannot accumulate unbounded buffers.
			if (hasMedia) { this.preparing--; this.waiting.shift()?.(); }
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
	let text = message.text;
	if (message.quoteText) text = `> 引用：${message.quoteText}\n\n${text}`;

	const images: ImageContent[] = [];
	const notes: string[] = [];

	const addImage = async (attachment: Attachment): Promise<void> => {
		try {
			const media = await downloadAndDecrypt(attachment.url, attachment.aeskey, { signal });
			if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(media.mimeType)) throw new Error("不支持的图片格式");
			reserveImage(4 * Math.ceil(media.buffer.byteLength / 3));
			images.push({
				type: "image",
				data: media.buffer.toString("base64"),
				mimeType: media.mimeType,
			});
		} catch (err) {
			signal.throwIfAborted();
			notes.push(`[图片处理失败：${errMsg(err)}]`);
		}
	};

	const saveAttachment = async (attachment: Attachment, kind: "file" | "video"): Promise<void> => {
		try {
			const media = await downloadAndDecrypt(attachment.url, attachment.aeskey, { signal });
			signal.throwIfAborted();
			const dir = await mediaDirectory(cwd);
			const file = await saveMedia(dir, `${message.msgId || "media"}-${kind}`, media, signal);
			notes.push(`[${kind === "video" ? "视频" : "文件"}已保存到：${file}]`);
		} catch (err) {
			signal.throwIfAborted();
			notes.push(`[${kind}处理失败：${errMsg(err)}]`);
		}
	};

	// In message order, one at a time: a slow download keeps its place.
	for (const attachment of message.attachments) {
		if (attachment.kind === "image") await addImage(attachment);
		else await saveAttachment(attachment, attachment.kind);
	}

	if (images.length && /^\[图片\]$/.test(text.trim())) text = "";
	signal.throwIfAborted();
	const { chatId, chatType } = message.chat;
	const header = `[企业微信${chatType === 2 ? "群聊" : "单聊"} chatid=${JSON.stringify(chatId)} chat_type=${chatType} userid=${JSON.stringify(message.userid)}]`;
	const full = [header, text, ...notes].filter(Boolean).join("\n");

	const content: (TextContent | ImageContent)[] = [{ type: "text", text: full || header }];
	content.push(...images);
	return { content, label: `${chatType === 2 ? "group" : "single"}/${message.msgtype}` };
}
