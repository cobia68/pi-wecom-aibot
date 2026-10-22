/**
 * /wecom-aibot whoami. It needs a live registration and the current configuration, but not the
 * extension's event wiring, so it lives outside index.ts with a narrow host.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChatIdentity } from "../shared/gateway-protocol.ts";
import type { BridgeSession } from "./bridge-session.ts";
import { CONFIG_FILE, mergeLayers, patchLayer, type Resolved, readLayer } from "./config.ts";

/** What whoami needs from the extension that owns this pi. */
export interface SetupHost {
	bridge(): BridgeSession | undefined;
	/** The current session's configuration as it is on disk now; throws when it cannot be used. */
	resolve(): Resolved;
	/** Reuse the formal bridge, or open a temporary identity-only registration. */
	beginIdentity(ctx: ExtensionContext): BridgeSession;
	/** Dispose only the temporary registration owned by this identification. */
	endIdentity(watcher: BridgeSession): void;
	/** A target was saved: the owner refreshes what it shows about pending reconnection. */
	configChanged(): void;
	log(line: string): void;
}

/** /wecom-aibot whoami: the next message this pi may receive reports its chat, saved once confirmed. */
export class SessionSetup {
	/** One wait at a time: a second whoami must not steal the gateway's identity watch. */
	private identifying = false;

	constructor(private readonly host: SetupHost) {}

	async identify(ctx: ExtensionContext, seconds: number): Promise<void> {
		if (this.identifying) {
			ctx.ui.notify("whoami 正在等待消息，请先完成或取消当前这一次。", "warning");
			return;
		}
		this.identifying = true;
		let watcher: BridgeSession | undefined;
		try {
			watcher = this.host.beginIdentity(ctx);
			const identifying = watcher;
			if (!identifying.ready)
				await cancellableWait(ctx, "正在临时连接以识别聊天…", (signal) => identifying.waitUntilReady(signal));
			if (identifying !== this.host.bridge() || identifying.sessionId !== ctx.sessionManager.getSessionId())
				throw new Error("当前 pi 的识别连接已停止或切换");
			const watch = identifying.watchIdentity.bind(identifying);
			ctx.ui.notify(
				`${identifying.identifyOnly ? "临时识别连接已就绪，尚未正式接入。" : ""}请在企微给机器人发一条消息：单聊直接发，群聊需 @机器人。这条消息只用于识别，不会交给 pi 处理。`,
				"info",
			);
			const identity = await cancellableWait(
				ctx,
				`等待你给机器人发消息（群聊需 @机器人），最多 ${seconds} 秒`,
				(signal) => watch(seconds * 1000, signal),
			);
			await this.saveDefaultTarget(ctx, identity, watcher);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			if (error.name === "AbortError") ctx.ui.notify("已取消 whoami；需要时再运行 /wecom-aibot whoami。", "info");
			else if (error.name === "TimeoutError") {
				const allowlist = watcher?.connection.allowedUserIds?.length
					? "；已配置 allowedUserIds，只识别名单内的 userid"
					: "";
				ctx.ui.notify(
					`${seconds} 秒内没有收到可识别的消息。单聊请直接给机器人发消息，群聊需 @机器人${allowlist}。可再次运行 /wecom-aibot whoami。`,
					"warning",
				);
			} else ctx.ui.notify(`whoami 未完成：${error.message}`, "warning");
		} finally {
			if (watcher) this.host.endIdentity(watcher);
			this.identifying = false;
		}
	}

	/**
	 * The identified chat becomes the global default target. It belongs to the bot that saw the message,
	 * so it is saved only while that bot is still the global one; saving never disconnects anything.
	 */
	private async saveDefaultTarget(
		ctx: ExtensionContext,
		identity: ChatIdentity,
		watcher: BridgeSession,
	): Promise<void> {
		const checkRegistration = () => {
			if (watcher !== this.host.bridge() || watcher.sessionId !== ctx.sessionManager.getSessionId()) {
				throw new Error("当前 pi 的企微接入已停止或切换，默认推送目标未保存；请重新运行 /wecom-aibot whoami。");
			}
		};
		checkRegistration();
		const kind = identity.chatType === 2 ? "群聊" : "单聊";
		const found = `已识别${kind}：chatid=${identity.chatId}　chat_type=${identity.chatType}　userid=${identity.userid}`;
		ctx.ui.notify(found, "info");
		const { botId, secret } = watcher.connection;
		const sameBot = (current: { botId?: string; secret?: string } | undefined) =>
			current?.botId === botId && current.secret === secret;
		// Compare with the files as they are now: another pi window may have changed them.
		const resolved = this.host.resolve();
		if (!sameBot(resolved.values))
			throw new Error(
				"机器人配置已改变，默认推送目标未保存；请运行 /wecom-aibot connect 后重新 /wecom-aibot whoami。",
			);
		if (resolved.sources.botId === "session")
			throw new Error(
				`当前 session 覆盖了机器人凭据，全局默认目标属于另一个机器人；请改用 /wecom-aibot config session set defaultChatId=${identity.chatId} defaultChatType=${identity.chatType}。`,
			);
		// The global target as the global layer alone resolves it, with the default type applied.
		const global = mergeLayers(readLayer("global"), undefined).values;
		const sessionTarget = resolved.sources.defaultChatId === "session";
		const shadowed = sessionTarget
			? "当前 session 覆盖了默认推送目标，保存到全局后本 session 仍使用自己的目标。"
			: "";
		if (global.defaultChatId === identity.chatId && global.defaultChatType === identity.chatType) {
			ctx.ui.notify(`这已经是全局默认推送目标，配置未改动。${shadowed}`, "info");
			return;
		}
		const replaced = global.defaultChatId
			? `将替换当前全局默认：${global.defaultChatId}（${global.defaultChatType === 2 ? "群聊" : "单聊"}）。`
			: "当前没有全局默认推送目标。";
		const consequence = watcher.identifyOnly
			? "识别完成后关闭临时连接；请手动运行 /wecom-aibot connect 正式接入。"
			: "保存不会断开当前接入；运行 /wecom-aibot connect 后改用新目标（会确认并清除当前 session 的排队任务和待发通知）。";
		const ok =
			ctx.hasUI &&
			(await ctx.ui.confirm(
				"设为全局默认推送目标？",
				`${found}\n${replaced}${shadowed}\nwecom_send 和 /wecom-aibot test 省略目标时发到这里。\n${consequence}`,
			));
		if (!ok) {
			ctx.ui.notify(
				`未修改配置。需要时运行 /wecom-aibot config global set defaultChatId=${identity.chatId} defaultChatType=${identity.chatType}`,
				"info",
			);
			return;
		}
		checkRegistration();
		// Confirmation is asynchronous: the write compares the bot once more against the file it changes.
		patchLayer(
			"global",
			{ set: { defaultChatId: identity.chatId, defaultChatType: identity.chatType } },
			(current) => {
				if (!sameBot(current))
					throw new Error(
						"机器人配置已改变，默认推送目标未保存；请运行 /wecom-aibot connect 后重新 /wecom-aibot whoami。",
					);
			},
		);
		this.host.configChanged();
		// Anyone who can message the bot can run tasks in this pi until an allowlist exists; the userid is known now.
		const allowlist = resolved.allowedUserIds?.length
			? ""
			: `当前未配置 allowedUserIds：任何能给机器人发消息的人都能让 pi 执行任务。建议在 ${CONFIG_FILE} 中加入 "allowedUserIds": [${JSON.stringify(identity.userid)}]，然后运行 /wecom-aibot connect。`;
		const next = sessionTarget
			? "本 session 仍使用自己覆盖的目标。"
			: watcher.identifyOnly
				? "尚未正式接入，请运行 /wecom-aibot connect；连上后可运行 /wecom-aibot test 验证。"
				: "当前接入仍使用旧目标，运行 /wecom-aibot connect 后生效。";
		ctx.ui.notify(`全局默认推送目标已保存：${identity.chatId}（${kind}）。${next}${allowlist}`, "info");
	}
}

/** A wait the user can cancel: a one-option dialog that closes by itself when the wait ends. */
async function cancellableWait<T>(
	ctx: ExtensionContext,
	title: string,
	task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const cancel = new AbortController();
	if (!ctx.hasUI) return task(cancel.signal);
	const dialog = new AbortController();
	// Choosing the option or Esc cancels; after the task has settled, closing the dialog changes nothing.
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
