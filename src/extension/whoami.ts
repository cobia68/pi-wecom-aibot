/**
 * Identifying a chat for config whoami and config edit: pi shows a one-time code, and the message that is
 * exactly that code reports its chat. Needs a live registration with the configured layer's bot but not
 * the extension's event wiring, hence the narrow host. Saving is left to config.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChatIdentity } from "../shared/gateway-protocol.ts";
import { sentences } from "../shared/text.ts";
import type { BridgeSession } from "./bridge-session.ts";
import type { Connection } from "./config.ts";

export interface WhoamiHost {
	bridge(): BridgeSession | undefined;
	/** Reuse the formal bridge when it uses this bot, or open a temporary identity-only registration with it. */
	beginIdentity(ctx: ExtensionContext, connection: Connection): BridgeSession;
	/** Dispose only the temporary registration owned by this identification. */
	endIdentity(watcher: BridgeSession): void;
	log(line: string): void;
}

/** One identification at a time: a second must not replace the first one's code. */
export class Whoami {
	private identifying = false;

	constructor(private readonly host: WhoamiHost) {}

	/** Cancelling, a timeout or a failure is reported here and returns undefined. */
	async identify(ctx: ExtensionContext, connection: Connection, seconds: number): Promise<ChatIdentity | undefined> {
		if (this.identifying) {
			ctx.ui.notify("whoami 正在等待验证码，请先完成或取消当前这一次", "warning");
			return undefined;
		}
		this.identifying = true;
		let watcher: BridgeSession | undefined;
		try {
			watcher = this.host.beginIdentity(ctx, connection);
			const identifying = watcher;
			if (!identifying.ready)
				await cancellableWait(ctx, "正在临时连接以识别聊天…", (signal) => identifying.waitUntilReady(signal));
			if (identifying !== this.host.bridge() || identifying.sessionId !== ctx.sessionManager.getSessionId())
				throw new Error("当前 pi 的识别连接已停止或切换");
			const identity = await waitForCode(ctx, seconds, (signal, onCode) =>
				identifying.watchIdentity(seconds * 1000, signal, onCode),
			);
			this.host.log(`whoami identified a ${identity.chatType === 2 ? "group" : "single"} chat`);
			return identity;
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			if (error.name === "AbortError") ctx.ui.notify("已取消 whoami", "info");
			else if (error.name === "TimeoutError")
				ctx.ui.notify(
					sentences(`${seconds} 秒内没有收到验证码`, "可再次运行 /wecom-aibot config whoami"),
					"warning",
				);
			else ctx.ui.notify(`whoami 未完成：${error.message}`, "warning");
			return undefined;
		} finally {
			if (watcher) this.host.endIdentity(watcher);
			this.identifying = false;
		}
	}
}

/** A one-option dialog titled with the code once the gateway issued it; without a dialog the code is said once. */
async function waitForCode(
	ctx: ExtensionContext,
	seconds: number,
	watch: (signal: AbortSignal, onCode: (code: string) => void) => Promise<ChatIdentity>,
): Promise<ChatIdentity> {
	const cancel = new AbortController();
	const dialog = new AbortController();
	const show = (code: string) => {
		const title = `在要识别的聊天里把 ${code} 发给机器人（群聊需 @机器人），最多 ${seconds} 秒`;
		if (!ctx.hasUI) {
			ctx.ui.notify(title, "info");
			return;
		}
		// Choosing the option or Esc cancels; after the wait has settled, closing the dialog changes nothing.
		void ctx.ui.select(title, ["取消等待"], { signal: dialog.signal }).then(
			() => cancel.abort(aborted()),
			() => {},
		);
	};
	try {
		return await watch(cancel.signal, show);
	} finally {
		dialog.abort();
	}
}

async function cancellableWait<T>(
	ctx: ExtensionContext,
	title: string,
	task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const cancel = new AbortController();
	if (!ctx.hasUI) return task(cancel.signal);
	const dialog = new AbortController();
	void ctx.ui.select(title, ["取消等待"], { signal: dialog.signal }).then(
		() => cancel.abort(aborted()),
		() => {},
	);
	try {
		return await task(cancel.signal);
	} finally {
		dialog.abort();
	}
}

function aborted(): Error {
	return Object.assign(new Error("whoami 已取消"), { name: "AbortError" });
}
