/**
 * Capture pi's rendered terminal text, not the desktop; pi has no screenshot API. Two pi internals are
 * kept here and fail closed when they change: pi 1.3's seven root containers (document, pending messages,
 * status, widgets-above, editor, widgets-below, footer), of which only the first three are captured, and
 * pi's global theme, swapped for one synchronous render when a named screenshot theme is set. Never fall
 * back to rendering the whole TUI: it would expose editor drafts. A powerline footer renders its status
 * bar into widgets-above, so that bar is never part of an image either.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, colorToHex, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { CapturedScreen } from "./render.ts";

const WIDGET_KEY = "wecom-screen-capture";
const CAPTURED_CONTAINERS = 3;
const LAYOUT_ERROR = "无法识别当前 pi 的界面结构；屏幕图片暂不可用，请检查插件与 pi 版本是否兼容";
const THEME_ERROR = "无法切换 pi 的截图主题；屏幕图片暂不可用，请检查插件与 pi 版本是否兼容";
/** Where pi keeps its live theme (both names, for extensions loaded under the old package name). */
const THEME_KEYS = [
	Symbol.for("@earendil-works/pi-coding-agent:theme"),
	Symbol.for("@mariozechner/pi-coding-agent:theme"),
] as const;

type ScreenRoot = Pick<TUI, "children" | "terminal" | "hasOverlay">;
export type ThemedRender = <T>(theme: Theme, containers: readonly Component[], render: () => T) => T;

function childrenOf(component: Component | undefined): Component[] | undefined {
	const value = (component as { children?: unknown } | undefined)?.children;
	return Array.isArray(value) && value.every((child) => child && typeof child.render === "function")
		? value
		: undefined;
}

/** Snapshot the latest visible content above the editor in `theme`, without changing focus or scroll position. */
export function captureScreen(
	root: ScreenRoot,
	marker: Component,
	theme: Theme,
	themed: ThemedRender = withPiTheme,
): CapturedScreen {
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
	// Rows below the captured block are measured only, never captured: they tell how many rows are visible.
	const excludedRows = children
		.slice(CAPTURED_CONTAINERS)
		.reduce((sum, child) => sum + child.render(columns).length, 0);
	const available = rows - excludedRows;
	if (available <= 0) throw new Error("终端太矮，编辑框以上没有可见内容，请增大窗口后重试");
	const captured = children.slice(0, CAPTURED_CONTAINERS);
	const lines = themed(theme, captured, () => captured.flatMap((child) => child.render(columns)))
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
			warning: colorToHex(theme.colors.warning),
			// The model and session rows reuse the theme's link and syntax colours, already tuned for its background.
			link: colorToHex(theme.colors.mdLink),
			variable: colorToHex(theme.colors.syntaxVariable),
		},
	};
}

/**
 * The captured containers re-render from scratch in `theme` and again in pi's own afterwards, so no
 * cached line of either theme reaches the other.
 */
function withPiTheme<T>(theme: Theme, containers: readonly Component[], render: () => T): T {
	const slots = globalThis as unknown as Record<symbol, unknown>;
	const live = slots[THEME_KEYS[0]];
	if (!isTheme(live)) throw new Error(THEME_ERROR);
	if (live.name !== undefined && live.name === theme.name) return render();
	const previous = THEME_KEYS.map((key) => slots[key]);
	const invalidate = () => {
		for (const container of containers) container.invalidate();
	};
	try {
		for (const key of THEME_KEYS) slots[key] = theme;
		invalidate();
		return render();
	} finally {
		THEME_KEYS.forEach((key, index) => {
			slots[key] = previous[index];
		});
		invalidate();
	}
}

function isTheme(value: unknown): value is Theme {
	return !!value && typeof (value as Theme).fg === "function" && typeof (value as Theme).getBgAnsi === "function";
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

	capture(ctx: ExtensionContext, themeName: string | undefined): CapturedScreen {
		if (ctx.mode !== "tui") throw new Error("屏幕图片只支持 pi 终端界面；RPC、JSON 和 print 模式只发送文字");
		const binding = this.binding;
		if (!binding || binding.sessionId !== ctx.sessionManager.getSessionId()) throw new Error(LAYOUT_ERROR);
		if (themeName === undefined)
			return captureScreen(binding.root, binding.marker, ctx.ui.theme, (_theme, _containers, render) => render());
		const theme = ctx.ui.getTheme(themeName);
		if (!theme)
			throw new Error(
				`pi 中没有截图主题 ${themeName}，屏幕图片暂不可用；用 /wecom-aibot config <session|global> edit 换一个`,
			);
		return captureScreen(binding.root, binding.marker, theme);
	}

	dispose(): void {
		const binding = this.binding;
		this.binding = undefined;
		binding?.ctx.ui.setWidget(WIDGET_KEY, undefined);
	}
}
