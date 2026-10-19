/** Screen capture/render/upload stays in pi. Only ordinary Markdown crosses the gateway. */
import type { ScreenMode, WeComConfig } from "../config.ts";
import type { GatewayNotification } from "../../shared/notification-types.ts";
import { replaceNotificationBody } from "../../shared/notification.ts";
import { hostSecrets, imageMarkdown, parseImageHosts, redactSecrets, uploadImage } from "./image-hosts.ts";
import { parseAnsiLine, renderScreenPng, type CapturedScreen } from "./render.ts";

export interface ScreenNotificationOptions {
	signal?: AbortSignal;
	warn?: (message: string) => void;
	/** Keep the capture and upload paths real in integration tests, replacing only rasterisation. */
	render?: typeof renderScreenPng;
}

export function parseFontFiles(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > 8 || value.some((file) => typeof file !== "string" || !file.trim()
		|| file.length > 4096 || /[\u0000-\u001f\u007f]/.test(file))) {
		throw new Error("fontFiles 应为最多 8 个字体文件路径组成的数组");
	}
	return value.map((file: string) => file.trim());
}

/** Text mode keeps the tail of the visible screen: the last lines are the answer, and the byte budget trims the rest. */
export const SCREEN_TEXT_LINES = 20;

/** The visible screen as plain text: ANSI styling dropped, trailing padding and blank edges removed. */
export function screenText(screen: CapturedScreen): string {
	const lines = screen.lines.slice(-SCREEN_TEXT_LINES)
		.map((line) => parseAnsiLine(line).map((cell) => cell.text).join("").trimEnd());
	while (lines.length && !lines[0].trim()) lines.shift();
	while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
	return lines.join("\n");
}

/**
 * The notification body is either the screen text or one image link, never both:
 * - text mode sends the last visible lines, cut from the top only when the notification limit demands it;
 * - image mode captures before the first await, renders the whole screen, uploads it and uses the link.
 * A failure degrades to the screen text (or the original body) with a bounded explanation; it never cancels.
 */
export async function prepareScreenNotification(
	notification: GatewayNotification,
	config: WeComConfig,
	capture: () => CapturedScreen,
	options: ScreenNotificationOptions = {},
): Promise<GatewayNotification> {
	const { signal } = options;
	signal?.throwIfAborted();
	const mode: ScreenMode = config.screenMode === "image" ? "image" : "text";
	let stage = "画面获取失败";
	let secrets = [config.secret];
	let screen: CapturedScreen | undefined;
	let text = "";
	try {
		// Capture before the first await: a later local answer or a reconnect cannot replace this screen.
		screen = capture();
		text = screenText(screen);
		if (!text.trim()) throw new Error("终端没有可发送的可见内容");
		if (mode === "text") {
			signal?.throwIfAborted();
			return replaceNotificationBody(notification, text);
		}
		stage = "图片配置有误";
		const hosts = parseImageHosts(config.imageHosts);
		secrets = [...secrets, ...hostSecrets(hosts)];
		const fontFiles = parseFontFiles(config.fontFiles);
		if (!hosts.length) throw new Error("没有配置图床（imageHosts）");
		stage = "图片生成失败";
		const png = await (options.render ?? renderScreenPng)(screen, { fontFiles, secrets });
		signal?.throwIfAborted();
		stage = "图片上传失败";
		const { url } = await uploadImage(png, hosts, { signal });
		signal?.throwIfAborted();
		return replaceNotificationBody(notification, imageMarkdown(url));
	} catch (error) {
		// /wecom stop, a session replacement or a cancelled tool must never send a late fallback.
		signal?.throwIfAborted();
		const reason = redactSecrets(error instanceof Error ? error.message : String(error), secrets)
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 600);
		const warning = reason.startsWith(`${stage}：`) ? reason : `${stage}：${reason}`;
		options.warn?.(warning);
		// This is untrusted server/error text, not Markdown instructions or another image link.
		const plain = warning.replace(/[\\`*_#\[\]<>!]/g, "\\$&");
		const fallback = text.trim() || notification.text.trim();
		return replaceNotificationBody(notification, `${fallback}\n\n（${plain}；文字照常发送）`);
	}
}
