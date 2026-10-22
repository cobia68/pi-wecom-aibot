/** Render one notification as a PNG: a card header naming its source above the visible terminal content. */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notificationHeader } from "../../shared/notification.ts";
import type { GatewayNotification, NotificationKind } from "../../shared/notification-types.ts";
import type { IconName } from "./icons.ts";
import { type CapturedScreen, renderScreenPng, type ScreenHeader } from "./render.ts";

export interface ScreenImageOptions {
	signal?: AbortSignal;
	/** Credentials masked by the renderer. */
	secrets?: readonly string[];
	warn?: (message: string) => void;
	/** Keep rasterisation replaceable in tests. */
	render?: typeof renderScreenPng;
	/** Temp directory for the PNG; tests use a sandbox. */
	directory?: string;
}

/** The pill's icon for each kind; an aborted run uses circle-stop instead. */
const BADGE_ICONS: Record<NotificationKind, IconName> = {
	notification: "bell",
	completion: "bell",
	reply: "bell",
	connect: "plug",
	test: "flask-conical",
};

/**
 * Three rows of one size and style: the working directory, provider · model, and the session. The
 * status pill says what this is; an aborted run says so in the warning colour (pill and top strip)
 * instead of a line under the screen.
 */
export function screenImageHeader(notification: GatewayNotification): ScreenHeader {
	const { directory, title, provider, model, session } = notificationHeader(notification.source, notification.kind);
	return {
		directory,
		provider,
		model,
		session,
		badge: notification.aborted ? "已中止" : title,
		badgeIcon: notification.aborted ? "circle-stop" : BADGE_ICONS[notification.kind],
		tone: notification.aborted ? "warning" : "accent",
	};
}

/**
 * Capture synchronously, render header + screen, write a private PNG for the gateway. The pi editor,
 * widgets below it and the footer/status bar are never included. Failures (RPC mode, missing fonts,
 * rasteriser) keep the Markdown fallback and never cancel the notification.
 */
export async function prepareScreenImage(
	notification: GatewayNotification,
	capture: () => CapturedScreen,
	options: ScreenImageOptions = {},
): Promise<GatewayNotification> {
	const { signal } = options;
	signal?.throwIfAborted();
	try {
		const screen = capture();
		const png = await (options.render ?? renderScreenPng)(screen, {
			secrets: options.secrets,
			header: screenImageHeader(notification),
			fontSize: 15,
			lineHeight: 1.45,
		});
		signal?.throwIfAborted();
		const directory = options.directory ?? join(tmpdir(), "pi-wecom-aibot-images");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const path = join(directory, `${randomUUID()}.png`);
		writeFileSync(path, png, { mode: 0o600 });
		return { ...notification, image: { mime: "image/png", filename: "pi-notification.png", path } };
	} catch (error) {
		signal?.throwIfAborted();
		let reason = error instanceof Error ? error.message : String(error);
		for (const secret of options.secrets ?? []) if (secret) reason = reason.split(secret).join("****");
		reason = reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 550);
		options.warn?.(`图片生成失败：${reason}；已改发文字`);
		return { ...notification, imageFailure: `生成失败：${reason}`.slice(0, 600) };
	}
}
