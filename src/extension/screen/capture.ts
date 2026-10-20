/**
 * Capture pi's rendered terminal text, not the desktop. Pi 1.3 mounts seven containers:
 * document, pending messages, status, widgets-above, editor, widgets-below, footer.
 * There is no public screenshot API. Keep that internal layout dependency here and fail closed
 * when it changes; never fall back to rendering the whole TUI (which would expose editor drafts).
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, colorToHex, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { CapturedScreen } from "./render.ts";

const WIDGET_KEY = "wecom-screen-capture";
const LAYOUT_ERROR = "无法识别当前 pi 的界面结构；屏幕图片暂不可用，请检查插件与 pi 版本是否兼容";

type ScreenRoot = Pick<TUI, "children" | "terminal" | "hasOverlay">;

function childrenOf(component: Component | undefined): Component[] | undefined {
	const value = (component as { children?: unknown } | undefined)?.children;
	return Array.isArray(value) && value.every((child) => child && typeof child.render === "function")
		? value
		: undefined;
}

/** Snapshot the latest visible content above the editor, without changing focus or scroll position. */
export function captureScreen(root: ScreenRoot, marker: Component, theme: Theme): CapturedScreen {
	const children = root.children;
	if (
		!Array.isArray(children) ||
		children.length !== 7 ||
		!children.every((child) => childrenOf(child)) ||
		childrenOf(children[0])?.length !== 3 ||
		!childrenOf(children[3])?.includes(marker)
	) {
		throw new Error(LAYOUT_ERROR);
	}
	if (root.hasOverlay()) throw new Error("当前有终端弹窗，请关闭弹窗后再发送屏幕图片");
	const { columns, rows } = root.terminal;
	if (
		!Number.isInteger(columns) ||
		columns < 1 ||
		columns > 500 ||
		!Number.isInteger(rows) ||
		rows < 1 ||
		rows > 300
	) {
		throw new Error("终端尺寸不可用或过大（最多 500 列、300 行），请调整窗口后重试");
	}
	// Only measure the input/footer area; none of its text enters the snapshot.
	const excludedRows = children.slice(4).reduce((sum, child) => sum + child.render(columns).length, 0);
	const available = rows - excludedRows;
	if (available <= 0) throw new Error("终端太矮，编辑框以上没有可见内容，请增大窗口后重试");
	const lines = children
		.slice(0, 4)
		.flatMap((child) => child.render(columns))
		.slice(-available)
		.map((line) => truncateToWidth(line, columns, ""));
	// For terminal-default tokens, theme.colors resolves the terminal's reported colour (or pi's
	// own fallback). If every background token is explicit, use the theme's light/dark fallback.
	const backgroundToken = (
		[
			"selectedBg",
			"searchMatchBg",
			"userMessageBg",
			"customMessageBg",
			"toolPendingBg",
			"toolSuccessBg",
			"toolErrorBg",
		] as const
	).find((token) => theme.getBgAnsi(token) === "\x1b[49m");
	return {
		lines,
		columns,
		foreground: colorToHex(theme.colors.text),
		background: backgroundToken
			? colorToHex(theme.colors[backgroundToken])
			: theme.appearance === "light"
				? "#ffffff"
				: "#000000",
		palette: {
			accent: colorToHex(theme.colors.accent),
			muted: colorToHex(theme.colors.muted),
			dim: colorToHex(theme.colors.dim),
			warning: colorToHex(theme.colors.warning),
		},
	};
}

/** An invisible widget gives us pi's live TUI reference; no renderer, socket or timer is started. */
export class ScreenCapture {
	private binding: { root: TUI; marker: Component; ctx: ExtensionContext; sessionId: string } | undefined;

	bind(ctx: ExtensionContext): void {
		this.dispose();
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET_KEY, (root) => {
			const marker: Component & { dispose(): void } = {
				render: (): string[] => [],
				invalidate() {},
				dispose: () => {
					if (this.binding?.marker === marker) this.binding = undefined;
				},
			};
			this.binding = { root, marker, ctx, sessionId: ctx.sessionManager.getSessionId() };
			return marker;
		});
	}

	capture(ctx: ExtensionContext): CapturedScreen {
		if (ctx.mode !== "tui") throw new Error("屏幕图片只支持 pi 终端界面；RPC、JSON 和 print 模式只发送文字");
		const binding = this.binding;
		if (!binding || binding.sessionId !== ctx.sessionManager.getSessionId()) throw new Error(LAYOUT_ERROR);
		return captureScreen(binding.root, binding.marker, ctx.ui.theme);
	}

	dispose(): void {
		const binding = this.binding;
		this.binding = undefined;
		binding?.ctx.ui.setWidget(WIDGET_KEY, undefined);
	}
}
