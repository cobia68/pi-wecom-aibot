/** A colored name in pi's existing footer. Only a started bridge owns an entry. */
import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { BridgeConnectionStatus } from "./bridge-session.ts";

export const WECOM_STATUS_KEY = "wecom-bot";
const THEME_WIDGET_KEY = "wecom-bot-theme";

const COLOR: Record<BridgeConnectionStatus, ThemeColor> = {
	connecting: "warning",
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
	text?: string;
}

export class WeComStatus {
	private binding: StatusBinding | undefined;

	update(ctx: StatusContext | undefined, connection: BridgeConnectionStatus | undefined): void {
		const target = ctx?.mode === "tui" && ctx.hasUI ? ctx.ui : undefined;
		if (!target || connection === undefined) { this.clear(); return; }
		let binding = this.binding;
		if (!binding || binding.ui !== target) {
			this.clear();
			binding = { ui: target, connection };
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
		}
		this.paint(binding);
	}

	private paint(binding: StatusBinding): void {
		if (this.binding !== binding) return;
		const text = binding.ui.theme.fg(COLOR[binding.connection], WECOM_STATUS_KEY);
		if (binding.text === text) return;
		binding.text = text;
		binding.ui.setStatus(WECOM_STATUS_KEY, text);
	}

	clear(): void {
		const binding = this.binding;
		this.binding = undefined;
		if (!binding) return;
		try { binding.ui.setStatus(WECOM_STATUS_KEY, undefined); }
		finally { binding.ui.setWidget(THEME_WIDGET_KEY, undefined); }
	}
}
