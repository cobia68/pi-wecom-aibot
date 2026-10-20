/**
 * /wecom-aibot whoami and setup's interactive steps. They need a live registration and the current
 * configuration, but not the extension's event wiring, so they live outside index.ts with a narrow host.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChatIdentity } from "../shared/gateway-protocol.ts";
import type { BridgeSession } from "./bridge-session.ts";
import { chatIdProblem } from "./commands.ts";
import { CONFIG_FILE, updateConfig, type WeComConfig } from "./config.ts";

/** What whoami needs from the extension that owns this pi. */
export interface SetupHost {
	bridge(): BridgeSession | undefined;
	config(): WeComConfig | undefined;
	applyConfig(config: WeComConfig): void;
	/** The configuration as it is on disk now. */
	readConfig(ctx: ExtensionContext): WeComConfig | undefined;
	waitUntilReady(signal: AbortSignal): Promise<void>;
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
		try {
			if (!this.host.bridge()?.ready)
				await cancellableWait(ctx, "正在连接企业微信…", (signal) => this.host.waitUntilReady(signal));
			const watcher = this.host.bridge();
			const cfg = this.host.config();
			if (!watcher || !cfg) throw new Error("当前 pi 的企微接入已停止");
			const expected = { botId: cfg.botId, secret: cfg.secret };
			const watch = watcher.watchIdentity.bind(watcher);
			ctx.ui.notify(
				"已连接。请在企微给机器人发一条消息：单聊直接发，群聊需 @机器人。这条消息只用于识别，不会交给 pi 处理。",
				"info",
			);
			const identity = await cancellableWait(
				ctx,
				`等待你给机器人发消息（群聊需 @机器人），最多 ${seconds} 秒`,
				(signal) => watch(seconds * 1000, signal),
			);
			await this.saveDefaultTarget(ctx, identity, watcher, expected);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			if (error.name === "AbortError") ctx.ui.notify("已取消 whoami；需要时再运行 /wecom-aibot whoami。", "info");
			else if (error.name === "TimeoutError") {
				const allowlist = this.host.config()?.allowedUserIds?.length
					? "；已配置 allowedUserIds，只识别名单内的 userid"
					: "";
				ctx.ui.notify(
					`${seconds} 秒内没有收到可识别的消息。单聊请直接给机器人发消息，群聊需 @机器人${allowlist}。可再次运行 /wecom-aibot whoami。`,
					"warning",
				);
			} else ctx.ui.notify(`whoami 未完成：${error.message}`, "warning");
		} finally {
			this.identifying = false;
		}
	}

	private async saveDefaultTarget(
		ctx: ExtensionContext,
		identity: ChatIdentity,
		watcher: BridgeSession,
		expected: Pick<WeComConfig, "botId" | "secret">,
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
		// Compare with the file as it is now: another pi window may have changed or removed it.
		const current = this.host.readConfig(ctx);
		if (!current) {
			ctx.ui.notify(
				`配置文件已不存在（可能已在其他 pi 中 /wecom-aibot logout），未保存默认推送目标：${CONFIG_FILE}`,
				"warning",
			);
			return;
		}
		if (current.botId !== expected.botId || current.secret !== expected.secret) {
			throw new Error(
				"机器人配置已改变，默认推送目标未保存；请运行 /wecom-aibot connect 后重新 /wecom-aibot whoami。",
			);
		}
		if (current.defaultChatId === identity.chatId && (current.defaultChatType ?? 1) === identity.chatType) {
			ctx.ui.notify("这已经是默认推送目标，配置未改动。", "info");
			return;
		}
		const replaced = current.defaultChatId
			? `将替换当前默认：${current.defaultChatId}（${current.defaultChatType === 2 ? "群聊" : "单聊"}）。`
			: "当前没有默认推送目标。";
		const ok =
			ctx.hasUI &&
			(await ctx.ui.confirm(
				"设为默认推送目标？",
				`${found}\n${replaced}\nwecom_send 和 /wecom-aibot test 省略目标时发到这里。`,
			));
		if (!ok) {
			ctx.ui.notify(
				`未修改配置。需要时可在配置文件中填写 "defaultChatId": ${JSON.stringify(identity.chatId)}, "defaultChatType": ${identity.chatType}`,
				"info",
			);
			return;
		}
		checkRegistration();
		// Confirmation is asynchronous: the storage operation must compare credentials again before merging.
		const saved = updateConfig({ defaultChatId: identity.chatId, defaultChatType: identity.chatType }, expected);
		const config = this.host.config();
		if (config)
			this.host.applyConfig({ ...config, defaultChatId: identity.chatId, defaultChatType: identity.chatType });
		// Anyone who can message the bot can run tasks in this pi until an allowlist exists; the userid is known now.
		const allowlist = saved.allowedUserIds?.length
			? ""
			: `当前未配置 allowedUserIds：任何能给机器人发消息的人都能让 pi 执行任务。建议在 ${CONFIG_FILE} 中加入 "allowedUserIds": [${JSON.stringify(identity.userid)}]，然后运行 /wecom-aibot connect。`;
		ctx.ui.notify(
			`默认推送目标已保存：${identity.chatId}（${kind}）。可运行 /wecom-aibot test 验证。${allowlist}`,
			"info",
		);
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

/** Ask for missing credentials of an existing bot; undefined means setup was cancelled. */
export async function setupCredentials(
	ctx: ExtensionContext,
	options: Map<string, string>,
): Promise<Pick<WeComConfig, "botId" | "secret"> | undefined> {
	const botId = options.get("bot-id") ?? (await ctx.ui.input("企业微信 BotID", "智能机器人 BotID"))?.trim();
	if (!botId) {
		ctx.ui.notify("已取消，配置未修改。", "info");
		return undefined;
	}
	const secret = options.get("secret") ?? (await ctx.ui.input("长连接 Secret", "智能机器人长连接专用 Secret"))?.trim();
	if (!secret) {
		ctx.ui.notify("已取消，配置未修改。", "info");
		return undefined;
	}
	return { botId, secret };
}

/** The default target given as --chatid / --chat-type, if any. */
export function givenTarget(options: Map<string, string>): { chatId: string; chatType: 1 | 2 } | undefined {
	const chatId = options.get("chatid");
	return chatId === undefined ? undefined : { chatId, chatType: options.get("chat-type") === "2" ? 2 : 1 };
}

/** setup's default target: --chatid as given, otherwise a menu. "whoami" identifies after connecting; undefined keeps; null cancels setup. */
export async function setupTarget(
	ctx: ExtensionContext,
	options: Map<string, string>,
	cfg: WeComConfig | undefined,
): Promise<{ chatId: string; chatType: 1 | 2 } | "whoami" | undefined | null> {
	const given = givenTarget(options);
	if (given) return given;
	if (!ctx.hasUI) return undefined;
	const keep = cfg?.defaultChatId
		? `保持当前：${cfg.defaultChatId}（${cfg.defaultChatType === 2 ? "群聊" : "单聊"}）`
		: "暂不设置";
	const menu = ["自动识别：连上后给机器人发一条消息", "手动填写单聊 userid", "手动填写群聊 chatid", keep];
	const choice = await ctx.ui.select("默认推送目标", menu);
	if (choice === undefined) return null;
	if (choice === menu[0]) return "whoami";
	if (choice === keep) return undefined;
	const chatType = choice === menu[2] ? 2 : 1;
	const answer = (
		await ctx.ui.input(
			chatType === 2 ? "群聊 chatid" : "单聊 userid",
			"原样保存；不清楚就按 Esc，重新 setup 时选自动识别",
		)
	)?.trim();
	if (!answer) return null;
	const problem = chatIdProblem(answer);
	if (problem) {
		ctx.ui.notify(problem, "warning");
		return null;
	}
	return { chatId: answer, chatType };
}
