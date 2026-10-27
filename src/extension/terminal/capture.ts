/**
 * pi's rendered terminal lines, not the desktop; pi has no capture API. One pi internal is kept here and
 * fails closed when it changes: pi 1.3's seven root containers (document, pending messages, status,
 * widgets-above, editor, widgets-below, footer), of which only the first three are read. Never fall back to
 * the whole TUI: it would expose editor drafts. A powerline footer renders its bar into widgets-above, so
 * that bar is never read either.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "wecom-aibot-terminal";
const READ_CONTAINERS = 3;
const LAYOUT_ERROR = "无法识别当前 pi 的界面结构；读不到终端画面，请检查插件与 pi 版本是否兼容";

type TerminalRoot = Pick<TUI, "children" | "terminal" | "hasOverlay">;

function childrenOf(component: Component | undefined): Component[] | undefined {
	const value = (component as { children?: unknown } | undefined)?.children;
	return Array.isArray(value) && value.every((child) => child && typeof child.render === "function")
		? value
		: undefined;
}

/** The latest visible lines above the editor, with their ANSI styling, without changing focus or scroll. */
function readTerminal(root: TerminalRoot, marker: Component): string[] {
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
	if (root.hasOverlay()) throw new Error("当前有终端弹窗，请关闭弹窗后再刷新");
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
	// Rows below the read block are measured only: they tell how many rows are visible.
	const excludedRows = children.slice(READ_CONTAINERS).reduce((sum, child) => sum + child.render(columns).length, 0);
	const available = rows - excludedRows;
	if (available <= 0) throw new Error("终端太矮，编辑框以上没有可见内容，请增大窗口后重试");
	return children
		.slice(0, READ_CONTAINERS)
		.flatMap((child) => child.render(columns))
		.slice(-available)
		.map((line) => truncateToWidth(line, columns, ""));
}

/** An invisible widget gives us pi's live TUI reference; no renderer, socket or timer is started. */
export class TerminalCapture {
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

	read(ctx: ExtensionContext): string[] {
		if (ctx.mode !== "tui") throw new Error("只有 pi 终端界面能读画面；RPC、JSON 和 print 模式没有");
		const binding = this.binding;
		if (!binding || binding.sessionId !== ctx.sessionManager.getSessionId()) throw new Error(LAYOUT_ERROR);
		return readTerminal(binding.root, binding.marker);
	}

	dispose(): void {
		const binding = this.binding;
		this.binding = undefined;
		binding?.ctx.ui.setWidget(WIDGET_KEY, undefined);
	}
}
