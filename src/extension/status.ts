/** A colored name in pi's existing footer. The bridge stays hidden until its first usable connection. */
import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { BridgeConnectionStatus } from "./connection-notices.ts";

export const WECOM_STATUS_KEY = "wecom-aibot";
const THEME_WIDGET_KEY = "wecom-aibot-theme";
export const FLASH_MS = 1_500;

const COLOR: Record<BridgeConnectionStatus, ThemeColor> = {
	online: "success",
	reconnecting: "warning",
	blocked: "error",
};

type StatusContext = Pick<ExtensionContext, "mode" | "hasUI"> & {
	ui: Pick<ExtensionContext["ui"], "setStatus" | "setWidget" | "theme">;
};

interface StatusBinding {
	ui: StatusContext["ui"];
	connection: BridgeConnectionStatus;
	/** Online, but the files now describe another connection: /wecom-aibot connect would switch. */
	pending: boolean;
	text?: string;
}

export class WeComStatus {
	private binding: StatusBinding | undefined;
	private flashTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly flashMs = FLASH_MS) {}

	update(ctx: StatusContext | undefined, connection: BridgeConnectionStatus | undefined, pending = false): void {
		this.cancelFlash();
		const target = ctx?.mode === "tui" && ctx.hasUI ? ctx.ui : undefined;
		if (!target || connection === undefined) {
			this.clear();
			return;
		}
		let binding = this.binding;
		if (!binding || binding.ui !== target) {
			this.clear();
			binding = { ui: target, connection, pending };
			this.binding = binding;
			const owner = binding;
			// setStatus stores ANSI text. A zero-row component receives pi's theme invalidation,
			// so idle colors stay current without polling, replacing the footer or private hooks.
			target.setWidget(THEME_WIDGET_KEY, () => ({
				render: () => [],
				invalidate: () => this.paint(owner),
				dispose: () => {
					if (this.binding !== owner) return;
					this.binding = undefined;
					target.setStatus(WECOM_STATUS_KEY, undefined);
				},
			}));
		} else {
			binding.connection = connection;
			binding.pending = pending;
		}
		this.paint(binding);
	}

	private paint(binding: StatusBinding): void {
		if (this.binding !== binding) return;
		const { theme } = binding.ui;
		const name = theme.fg(COLOR[binding.connection], WECOM_STATUS_KEY);
		const text =
			binding.pending && binding.connection === "online" ? `${name}${theme.fg("warning", "（待重新接入）")}` : name;
		if (binding.text === text) return;
		binding.text = text;
		binding.ui.setStatus(WECOM_STATUS_KEY, text);
	}

	/** A user disconnect: show the error colour for a moment, then remove the name instead of blinking away. */
	flash(ctx: StatusContext | undefined): void {
		this.update(ctx, "blocked");
		if (!this.binding) return;
		this.flashTimer = setTimeout(() => {
			this.flashTimer = undefined;
			this.clear();
		}, this.flashMs);
		this.flashTimer.unref();
	}

	clear(): void {
		this.cancelFlash();
		const binding = this.binding;
		this.binding = undefined;
		if (!binding) return;
		try {
			binding.ui.setStatus(WECOM_STATUS_KEY, undefined);
		} finally {
			binding.ui.setWidget(THEME_WIDGET_KEY, undefined);
		}
	}

	private cancelFlash(): void {
		if (!this.flashTimer) return;
		clearTimeout(this.flashTimer);
		this.flashTimer = undefined;
	}
}
