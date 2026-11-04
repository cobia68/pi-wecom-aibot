/** On-demand Markdown long images. No terminal access, document service, browser, or external image loading. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { Markdown, type MarkdownTheme, stripTerminalSequences, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { GatewayImage } from "../../shared/gateway-protocol.ts";
import type { ReplySnapshot } from "../../shared/notification-types.ts";
import { WECOM_IMAGE_MAX_BYTES } from "../../shared/wecom-protocol.ts";
import { withoutNextSteps } from "../next-steps.ts";
import { loadFonts } from "./fonts.ts";
import { COLORS, MAX_CONTENT_ROWS, type ReplyPage, renderReplyPage } from "./render.ts";

export const REPLY_COLUMNS = 80;
/** Avoid an unbounded render/upload run or flooding a chat; larger replies remain available as Markdown. */
export const MAX_REPLY_IMAGE_PAGES = 20;
const color = (hex: string) => {
	const rgb = hex.match(/[0-9a-f]{2}/gi)!.map((part) => parseInt(part, 16));
	return (text: string) => `\x1b[38;2;${rgb.join(";")}m${text}\x1b[39m`;
};
const style = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
const theme: MarkdownTheme = {
	heading: (text) => style(1, 22)(color(COLORS.accent)(text)),
	link: color(COLORS.link),
	linkUrl: color(COLORS.link),
	code: color(COLORS.variable),
	codeBlock: color(COLORS.foreground),
	codeBlockBorder: color(COLORS.muted),
	quote: color(COLORS.muted),
	quoteBorder: color(COLORS.accent),
	hr: color(COLORS.muted),
	listBullet: color(COLORS.accent),
	bold: style(1, 22),
	italic: style(3, 23),
	strikethrough: style(9, 29),
	underline: style(4, 24),
};

/** Pi's Markdown layout handles lists and tables; wrap code and long URLs too, without clipping their ends. */
export function replyImagePages(text: string): ReplyPage[] {
	const clean = stripTerminalSequences(withoutNextSteps(text)).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
	if (!clean.trim()) throw new Error("本卡没有可渲染的正文");
	const markdown = new Markdown(clean, 0, 0, theme, undefined, {
		preserveOrderedListMarkers: true,
		renderLatex: false,
	});
	const lines = markdown.render(REPLY_COLUMNS).flatMap((line) => wrapTextWithAnsi(line, REPLY_COLUMNS));
	if (lines.length > MAX_CONTENT_ROWS * MAX_REPLY_IMAGE_PAGES)
		throw new Error(`正文超过 ${MAX_REPLY_IMAGE_PAGES} 张长图的上限，请点「查看全文」阅读`);
	const pages: ReplyPage[] = [];
	for (let offset = 0; offset < lines.length; offset += MAX_CONTENT_ROWS)
		pages.push({ lines: lines.slice(offset, offset + MAX_CONTENT_ROWS), columns: REPLY_COLUMNS });
	return pages;
}

export interface ReplyImage {
	png: Uint8Array;
	index: number;
	total: number;
}

/** Stateless between requests: only this card's frozen reply and source are used, even while pi keeps running. */
export class ReplyImageRenderer {
	async *render(reply: ReplySnapshot, signal: AbortSignal): AsyncGenerator<ReplyImage> {
		await yieldToIo(undefined, { signal });
		const pages = replyImagePages(reply.text);
		const fonts = loadFonts();
		for (const [index, page] of pages.entries()) {
			await yieldToIo(undefined, { signal });
			const png = await renderReplyPage(page, {
				fonts,
				header: {
					directory: reply.source.directoryName,
					provider: reply.source.provider,
					model: reply.source.modelName,
					session: reply.source.sessionId,
					badge: pages.length > 1 ? `全文 ${index + 1}/${pages.length}` : "回复全文",
					badgeIcon: "message-square-code",
				},
				fontSize: 15,
				lineHeight: 1.45,
			});
			signal.throwIfAborted();
			if (png.byteLength > WECOM_IMAGE_MAX_BYTES) throw new Error("长图超过企微 10 MiB 限制，请点「查看全文」阅读");
			yield { png, index, total: pages.length };
		}
	}
}

/** The gateway reads a private file instead of a huge base64 IPC frame. Remove it on success, failure or cancellation. */
export async function withReplyImageFile(
	image: ReplyImage,
	send: (file: GatewayImage) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-wecom-reply-"));
	try {
		const filename = `pi-reply-${image.index + 1}-of-${image.total}.png`;
		const path = join(directory, filename);
		await writeFile(path, image.png, { mode: 0o600, flag: "wx" });
		await send({ mime: "image/png", filename, path });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
