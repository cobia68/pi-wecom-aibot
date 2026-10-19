/**
 * pi-wecom-bot — 企业微信智能机器人（长连接）扩展
 *
 * 把一个企业微信「智能机器人」通过官方 WebSocket 长连接接到正在运行的 pi 会话：
 * 在企微里发任务、收回复，也可以让 pi 主动推送消息。
 *
 * 官方协议：https://developer.work.weixin.qq.com/document/path/101463
 * 使用 BotID + 长连接专用 Secret，无需公网回调地址；媒体资源自动解密。
 *
 * 命令（主对象用位置参数，可选设置用 --选项）：
 *   /wecom setup [whoami] [--bot-id ID] [--secret S] [--chatid ID] [--chat-type 1|2]   配置并连接已有机器人；接 whoami 时连上后识别 chatid
 *   /wecom whoami [--wait 秒]      等你给机器人发消息，识别 chatid，确认后设为默认推送目标
 *   /wecom test [chatid] [--chat-type 1|2]
 *   /wecom screen [chatid] [--chat-type 1|2]   把当前终端画面作为通知正文（屏幕文字或整屏图片，二选一）
 *   /wecom start | stop | status | log | logout
 *   /wecom --help                 命令与配置帮助
 *
 * 工具：
 *   wecom_send(...)   带会话、供应商、模型、目录来源的通知，可摘录最终回复或改发当前屏幕
 */

import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { abortError, BridgeSession, connectionConfig, type BridgeHost, type CompletionRequest } from "./bridge-session.ts";
import { clearConfig, CONFIG_FILE, loadConfig, updateConfig, type WeComConfig } from "./config.ts";
import { chatIdProblem, completeWecom, parseWecomInvocation, WHOAMI_WAIT_SECONDS, wecomHelpText } from "./commands.ts";
import { GatewayClient, type GatewayClientOptions } from "./gateway-client.ts";
import type { BridgeClient, ChatIdentity } from "../shared/gateway-protocol.ts";
import { captureModelIdentity, captureNotificationSource, latestAssistantReply } from "./notification-source.ts";
import { DEFAULT_TAIL_PARAGRAPHS, formatNotification, notificationPayload } from "../shared/notification.ts";
import { ScreenCapture } from "./screen/capture.ts";
import { prepareScreenNotification, type ScreenNotificationOptions } from "./screen/notification.ts";
import { WeComStatus } from "./status.ts";

export interface BridgeOptions {
	createClient?: (options: GatewayClientOptions) => BridgeClient;
	renderScreen?: ScreenNotificationOptions["render"];
}

export default function wecomBotExtension(pi: ExtensionAPI, options: BridgeOptions = {}) {
	// ---------------------------------------------------------------- state
	let cfg: WeComConfig | undefined;
	/** This pi's connection through the shared gateway, while it is started. */
	let bridge: BridgeSession | undefined;
	const instanceId = randomUUID();
	const screenCapture = new ScreenCapture();
	const footerStatus = new WeComStatus();
	let stoppedByUser = false;
	/** Why the last bridge stopped, for /wecom status. */
	let stopReason: string | undefined;
	let sessionCtx: ExtensionContext | undefined;
	let identifying = false;
	let settling = false;
	/** The session leaf when the current pi run started: replies after it belong to this run. */
	let runStartEntryId: string | null = null;
	/** WeCom messages already accepted in this pi session, across bridge restarts. */
	const seenMsgIds = new Set<string>();
	const logLines: string[] = [];

	const log = (line: string): void => {
		const stamped = `${new Date().toISOString()} ${line}`;
		logLines.push(stamped);
		if (logLines.length > 200) logLines.shift();
	};

	const notify = (ctx: ExtensionContext | undefined, message: string, type: "info" | "warning" | "error" = "info"): void => {
		if (ctx?.hasUI) ctx.ui.notify(message, type);
	};

	const host: BridgeHost = {
		context: () => sessionCtx,
		settling: () => settling,
		sendUserMessage: (content) => pi.sendUserMessage(content, { expandPromptTemplates: false }),
		firstSeen(msgId) {
			if (seenMsgIds.has(msgId)) return false;
			seenMsgIds.add(msgId);
			if (seenMsgIds.size > 1000) {
				const oldest = seenMsgIds.values().next().value;
				if (oldest !== undefined) seenMsgIds.delete(oldest);
			}
			return true;
		},
		log,
		notify: (message, type) => notify(sessionCtx, message, type),
		connectionChanged: (session) => { if (session === bridge) refreshStatus(); },
		prepareScreen: (notification, ctx, signal) => {
			if (!cfg) return Promise.reject(new Error("企微配置已清除，已取消通知"));
			return prepareScreenNotification(notification, cfg, () => screenCapture.capture(ctx), {
				signal, render: options.renderScreen,
				warn: (message) => { log(message); notify(ctx, `${message}；文字照常发送`, "warning"); },
			});
		},
		stop: (reason) => stopBridge(reason),
	};

	// ---------------------------------------------------------------- bridge
	function refreshStatus(): void {
		const connection = bridge && sessionCtx && bridge.sessionId === sessionCtx.sessionManager.getSessionId()
			? bridge.connectionStatus : undefined;
		footerStatus.update(sessionCtx, connection);
	}

	function statusText(): string {
		const source = sessionCtx ? captureNotificationSource(sessionCtx) : undefined;
		const state = bridge?.state ?? "disconnected";
		const detail = bridge ? bridge.detail : stopReason;
		return [
			`企业微信智能机器人：${state}${detail ? `（${detail}）` : ""}`,
			cfg ? `BotID：${mask(cfg.botId)}　Secret：${mask(cfg.secret)}` : "未配置（运行 /wecom setup）",
			`自动连接：${cfg?.enabled ? "开" : "关"}　待处理：${bridge?.queued ?? 0}　处理中：${bridge?.running ? "是" : "否"}`,
			`本机共享网关：${bridge?.gatewaySessions ?? 0} 个已注册 pi　当前 pi：${bridge ? "已启动" : "已停止"}`,
			`session: ${source?.sessionId ?? "未启动"}　待通知：${bridge?.pendingNotifications ?? 0}`,
			`${source?.provider ?? "未选择供应商"} · ${source?.modelName ?? "未选择模型"}　工作目录：${source?.directoryName ?? "未启动"}`,
			`默认推送：${cfg?.defaultChatId ? `${cfg.defaultChatId}（${cfg.defaultChatType === 2 ? "群聊" : "单聊"}）` : cfg ? "未配置（运行 /wecom whoami 识别）" : "未配置"}`,
			`屏幕正文：${cfg?.screenMode === "image"
				? `图片（${Array.isArray(cfg.imageHosts) && cfg.imageHosts.length ? `${cfg.imageHosts.length} 个图床` : "未配置 imageHosts，将改发文字"}）`
				: "文字（屏幕最后 20 行）"}`,
			`配置文件：${CONFIG_FILE}`,
		].join("\n");
	}

	function ensureClient(ctx: ExtensionContext): void {
		if (!cfg || bridge) return;
		sessionCtx = ctx;
		const session = new BridgeSession(host, cfg, ctx, options.createClient ?? ((clientOptions) => new GatewayClient(clientOptions)), instanceId);
		// Assigned before start: a client that fails at once stops this session, not an older one.
		bridge = session;
		refreshStatus();
		session.start();
	}

	function restart(ctx: ExtensionContext): void {
		stopBridge("restart");
		ensureClient(ctx);
	}

	function stopBridge(reason: string): void {
		const session = bridge;
		bridge = undefined;
		stopReason = reason;
		try { session?.dispose(reason); }
		finally { footerStatus.clear(); }
	}

	function destination(chatId?: string, chatType?: 1 | 2): { chatId: string; chatType: 1 | 2 } {
		const target = (chatId ?? cfg?.defaultChatId)?.trim();
		if (!target) throw new Error("缺少 chatid，请传入目标或配置 defaultChatId（可运行 /wecom whoami 识别）");
		return { chatId: target, chatType: chatType ?? (chatId === undefined ? cfg?.defaultChatType : undefined) ?? 1 };
	}

	// ---------------------------------------------------------------- pi events
	pi.on("session_start", async (_event, ctx) => {
		stopBridge("session changed");
		seenMsgIds.clear();
		runStartEntryId = null;
		sessionCtx = ctx;
		screenCapture.bind(ctx);
		cfg = loadConfig();
		if (cfg?.enabled && !stoppedByUser) ensureClient(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopBridge("session shutdown");
		screenCapture.dispose();
		sessionCtx = undefined;
	});

	function refreshSource(ctx: ExtensionContext): void {
		sessionCtx = ctx;
		bridge?.updateSource(ctx);
		refreshStatus();
	}

	pi.on("model_select", (_event, ctx) => refreshSource(ctx));
	pi.on("agent_start", (_event, ctx) => {
		// Emitted before the run's prompt is persisted, so the leaf still belongs to the previous run.
		runStartEntryId = ctx.sessionManager.getLeafId();
		refreshSource(ctx);
	});

	pi.on("message_start", (event, ctx) => bridge?.messageStart(event, ctx));
	pi.on("message_update", (event) => bridge?.messageUpdate(event));
	pi.on("message_end", (event, ctx) => bridge?.messageEnd(event, ctx));

	pi.on("agent_settled", async (event, ctx) => {
		if (bridge && bridge.sessionId !== ctx.sessionManager.getSessionId()) { stopBridge("target session changed"); return; }
		settling = true;
		try {
			await bridge?.settle(ctx, event.aborted);
		} finally {
			settling = false;
			// Submit queued work only after the notification boundary returns.
			bridge?.scheduleDrain();
		}
	});

	// ---------------------------------------------------------------- whoami
	/** Resolve once this pi is registered and the bot is subscribed; stop, cancel or timeout reject. */
	function waitUntilReady(signal: AbortSignal): Promise<void> {
		return bridge?.waitUntilReady(signal) ?? Promise.reject(new Error("当前 pi 的企微接入已停止，请运行 /wecom start"));
	}

	/** A wait the user can cancel: a one-option dialog that closes by itself when the wait ends. */
	async function cancellableWait<T>(ctx: ExtensionContext, title: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const cancel = new AbortController();
		if (!ctx.hasUI) return task(cancel.signal);
		const dialog = new AbortController();
		// Choosing the option or Esc cancels; after the task has settled, closing the dialog changes nothing.
		void ctx.ui.select(title, ["取消等待"], { signal: dialog.signal }).then(() => cancel.abort(abortError()), () => {});
		try {
			return await task(cancel.signal);
		} finally {
			dialog.abort();
		}
	}

	/** /wecom whoami: the next message this pi may receive reports its chat, saved as the default target once confirmed. */
	async function identify(ctx: ExtensionContext, seconds: number): Promise<void> {
		if (identifying) {
			ctx.ui.notify("whoami 正在等待消息，请先完成或取消当前这一次。", "warning");
			return;
		}
		identifying = true;
		try {
			if (!bridge?.ready) await cancellableWait(ctx, "正在连接企业微信…", (signal) => waitUntilReady(signal));
			const watcher = bridge;
			if (!watcher || !cfg) throw new Error("当前 pi 的企微接入已停止");
			const expected = { botId: cfg.botId, secret: cfg.secret };
			const watch = watcher.watchIdentity.bind(watcher);
			ctx.ui.notify(`已连接。请在企微给机器人发一条消息：单聊直接发，群聊需 @机器人。这条消息只用于识别，不会交给 pi 处理。`, "info");
			const identity = await cancellableWait(ctx, `等待你给机器人发消息（群聊需 @机器人），最多 ${seconds} 秒`, (signal) => watch(seconds * 1000, signal));
			await saveDefaultTarget(ctx, identity, watcher, expected);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			if (error.name === "AbortError") ctx.ui.notify("已取消 whoami；需要时再运行 /wecom whoami。", "info");
			else if (error.name === "TimeoutError") {
				const allowlist = cfg?.allowedUserIds?.length ? "；已配置 allowedUserIds，只识别名单内的 userid" : "";
				ctx.ui.notify(`${seconds} 秒内没有收到可识别的消息。单聊请直接给机器人发消息，群聊需 @机器人${allowlist}。可再次运行 /wecom whoami。`, "warning");
			} else ctx.ui.notify(`whoami 未完成：${error.message}`, "warning");
		} finally {
			identifying = false;
		}
	}

	async function saveDefaultTarget(ctx: ExtensionContext, identity: ChatIdentity, watcher: BridgeSession, expected: Pick<WeComConfig, "botId" | "secret">): Promise<void> {
		const checkRegistration = () => {
			if (watcher !== bridge || watcher.sessionId !== ctx.sessionManager.getSessionId()) {
				throw new Error("当前 pi 的企微接入已停止或切换，默认推送目标未保存；请重新运行 /wecom whoami。");
			}
		};
		checkRegistration();
		const kind = identity.chatType === 2 ? "群聊" : "单聊";
		const found = `已识别${kind}：chatid=${identity.chatId}　chat_type=${identity.chatType}　userid=${identity.userid}`;
		ctx.ui.notify(found, "info");
		// Compare with the file as it is now: another pi window may have changed or removed it.
		const current = loadConfig();
		if (!current) {
			ctx.ui.notify(`配置文件已不存在（可能已在其他 pi 中 /wecom logout），未保存默认推送目标：${CONFIG_FILE}`, "warning");
			return;
		}
		if (current.botId !== expected.botId || current.secret !== expected.secret) {
			throw new Error("机器人配置已改变，默认推送目标未保存；请运行 /wecom start 后重新 /wecom whoami。");
		}
		if (current.defaultChatId === identity.chatId && (current.defaultChatType ?? 1) === identity.chatType) {
			ctx.ui.notify("这已经是默认推送目标，配置未改动。", "info");
			return;
		}
		const replaced = current.defaultChatId
			? `将替换当前默认：${current.defaultChatId}（${current.defaultChatType === 2 ? "群聊" : "单聊"}）。`
			: "当前没有默认推送目标。";
		const ok = ctx.hasUI && await ctx.ui.confirm("设为默认推送目标？", `${found}\n${replaced}\nwecom_send 和 /wecom test 省略目标时发到这里。`);
		if (!ok) {
			ctx.ui.notify(`未修改配置。需要时可在配置文件中填写 "defaultChatId": ${JSON.stringify(identity.chatId)}, "defaultChatType": ${identity.chatType}`, "info");
			return;
		}
		checkRegistration();
		// Confirmation is asynchronous: the storage operation must compare credentials again before merging.
		const saved = updateConfig({ defaultChatId: identity.chatId, defaultChatType: identity.chatType }, expected);
		if (cfg) cfg = { ...cfg, defaultChatId: identity.chatId, defaultChatType: identity.chatType };
		// Anyone who can message the bot can run tasks in this pi until an allowlist exists; the userid is known now.
		const allowlist = saved.allowedUserIds?.length ? "" : `当前未配置 allowedUserIds：任何能给机器人发消息的人都能让 pi 执行任务。建议在 ${CONFIG_FILE} 中加入 "allowedUserIds": [${JSON.stringify(identity.userid)}]，然后运行 /wecom start。`;
		ctx.ui.notify(`默认推送目标已保存：${identity.chatId}（${kind}）。可运行 /wecom test 验证。${allowlist}`, "info");
	}

	/** Ask for missing credentials of an existing bot; undefined means setup was cancelled. */
	async function setupCredentials(ctx: ExtensionContext, options: Map<string, string>): Promise<Pick<WeComConfig, "botId" | "secret"> | undefined> {
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
	function givenTarget(options: Map<string, string>): { chatId: string; chatType: 1 | 2 } | undefined {
		const chatId = options.get("chatid");
		return chatId === undefined ? undefined : { chatId, chatType: options.get("chat-type") === "2" ? 2 : 1 };
	}

	/** setup's default target: --chatid as given, otherwise a menu. "whoami" identifies after connecting; undefined keeps; null cancels setup. */
	async function setupTarget(ctx: ExtensionContext, options: Map<string, string>): Promise<{ chatId: string; chatType: 1 | 2 } | "whoami" | undefined | null> {
		const given = givenTarget(options);
		if (given) return given;
		if (!ctx.hasUI) return undefined;
		const keep = cfg?.defaultChatId ? `保持当前：${cfg.defaultChatId}（${cfg.defaultChatType === 2 ? "群聊" : "单聊"}）` : "暂不设置";
		const menu = ["自动识别：连上后给机器人发一条消息", "手动填写单聊 userid", "手动填写群聊 chatid", keep];
		const choice = await ctx.ui.select("默认推送目标", menu);
		if (choice === undefined) return null;
		if (choice === menu[0]) return "whoami";
		if (choice === keep) return undefined;
		const chatType = choice === menu[2] ? 2 : 1;
		const answer = (await ctx.ui.input(chatType === 2 ? "群聊 chatid" : "单聊 userid", "原样保存；不清楚就按 Esc，重新 setup 时选自动识别"))?.trim();
		if (!answer) return null;
		const problem = chatIdProblem(answer);
		if (problem) {
			ctx.ui.notify(problem, "warning");
			return null;
		}
		return { chatId: answer, chatType };
	}

	// ---------------------------------------------------------------- commands

	pi.registerCommand("wecom", {
		description: "管理当前 pi 的企业微信智能机器人（/wecom --help 查看用法）",
		getArgumentCompletions: (prefix) => completeWecom(prefix),
		handler: async (input, ctx) => {
			sessionCtx = ctx;
			refreshStatus();
			const invocation = parseWecomInvocation(input);
			if (invocation.kind === "error") {
				ctx.ui.notify(invocation.message, "warning");
				return;
			}
			// Parsing and help finish before any command can mutate configuration or connections.
			if (invocation.kind === "help") {
				ctx.ui.notify(wecomHelpText(invocation.topic), "info");
				return;
			}
			const { args, options, command, next } = invocation;
			const sub = command.name;

			switch (sub) {
				case "setup": {
					const credentials = await setupCredentials(ctx, options);
					if (!credentials) return;
					const { botId, secret } = credentials;
					// `setup whoami` runs whoami after connecting; otherwise the target comes from --chatid or the menu.
					const target = next ? "whoami" : await setupTarget(ctx, options);
					if (target === null) {
						ctx.ui.notify("已取消，配置未修改。", "info");
						return;
					}
					// Only the fields setup asks for; everything else stays as the file has it now.
					// Auto-connect is deliberately not switched on: /wecom start is the opt-in for that.
					cfg = updateConfig({
						botId, secret,
						...(target && target !== "whoami" ? { defaultChatId: target.chatId, defaultChatType: target.chatType } : {}),
					});
					stoppedByUser = false;
					ctx.ui.notify("配置已保存，正在连接…", "info");
					restart(ctx);
					if (!cfg.enabled) ctx.ui.notify("新开的 pi 默认不会自动接入；需要时运行 /wecom start（会打开自动接入）。", "info");
					// whoami needs the connection: the next message to the bot reports chatid and chat_type.
					if (target === "whoami") await identify(ctx, Number(options.get("wait") ?? WHOAMI_WAIT_SECONDS));
					else if (cfg.defaultChatId) {
						ctx.ui.notify(`默认推送目标${target ? "已保存" : "保持"}：${cfg.defaultChatId}（${cfg.defaultChatType === 2 ? "群聊" : "单聊"}）。`, "info");
					} else ctx.ui.notify("未配置默认推送目标；需要时运行 /wecom whoami 识别。", "info");
					return;
				}
				case "whoami": {
					if (!cfg) {
						ctx.ui.notify("尚未配置，请先运行 /wecom setup", "warning");
						return;
					}
					if (!bridge) {
						ctx.ui.notify("当前 pi 未接入企业微信，请先运行 /wecom start", "warning");
						return;
					}
					await identify(ctx, Number(options.get("wait") ?? WHOAMI_WAIT_SECONDS));
					return;
				}
				case "start": {
					// Only the file counts: after a logout in another pi, this window's snapshot must not recreate it.
					const current = loadConfig();
					if (!current) {
						ctx.ui.notify("尚未配置，请先运行 /wecom setup", "warning");
						return;
					}
					cfg = current.enabled ? current : updateConfig({ enabled: true });
					stoppedByUser = false;
					if (bridge && (bridge.sessionId !== ctx.sessionManager.getSessionId() || bridge.configKey !== connectionConfig(cfg))) stopBridge("session or configuration changed");
					ensureClient(ctx);
					bridge?.updateWelcome(cfg.welcome);
					bridge?.resume();
					ctx.ui.notify("正在向共享网关注册当前 pi…", "info");
					return;
				}
				case "stop": {
					stoppedByUser = true;
					stopBridge("stopped by user");
					ctx.ui.notify("当前 pi 已从共享网关注销", "info");
					return;
				}
				case "logout": {
					const ok = await ctx.ui.confirm("清除企业微信配置？", "将删除 BotID/Secret 并停止桥接。");
					if (!ok) return;
					stoppedByUser = true;
					stopBridge("logout");
					try {
						clearConfig();
						cfg = undefined;
						ctx.ui.notify("已清除企业微信配置", "info");
					} catch (error) {
						const detail = error instanceof Error ? error.message : String(error);
						log(`configuration deletion failed: ${detail}`);
						ctx.ui.notify(`当前 pi 已停止，但配置文件删除失败：${detail}。BotID/Secret 可能仍在 ${CONFIG_FILE}，请检查权限后重试 /wecom logout。`, "error");
					}
					return;
				}
				case "log": {
					ctx.ui.notify(logLines.slice(-20).join("\n") || "（暂无日志）", "info");
					return;
				}
				case "test":
				case "screen": {
					const sender = bridge;
					if (!sender?.ready) throw new Error("企业微信机器人未连接，请先运行 /wecom start");
					const chatType = options.get("chat-type");
					const target = destination(args[0], chatType === undefined ? undefined : chatType === "2" ? 2 : 1);
					const screen = sub === "screen";
					await sender.notify(target, notificationPayload(screen ? "notification" : "test", captureNotificationSource(ctx), screen
						? "当前 pi 终端画面（不含编辑框和底部状态栏）。"
						: [
							"机器人长连接认证成功；这是一条用于验证通知发送的测试消息。",
							`测试时间：${new Date().toISOString()}`,
						].join("\n\n")), { screen, ctx });
					log(`${screen ? "screen" : "deployment test"} notification acknowledged`);
					ctx.ui.notify(`${screen ? "屏幕通知" : "部署测试通知"}已获得企业微信服务端确认`, "info");
					return;
				}
				case "status": {
					ctx.ui.notify(statusText(), "info");
					return;
				}
				default: {
					ctx.ui.notify("未知子命令，请使用 /wecom --help 查看用法。", "warning");
					return;
				}
			}
		},
	});

	// ---------------------------------------------------------------- tool
	pi.registerTool({
		name: "wecom_send",
		label: "WeCom Send",
		description:
			"Send a Markdown notification through the WeCom (企业微信) smart robot. " +
			"The plugin automatically adds the pi session ID, provider, model name and working directory's final folder name; do not repeat them in content. " +
			"Use userid for single chat, chatid for group chat, or omit chatid to use the configured default target. " +
			"The user must have messaged the robot before. " +
			"Omit content to copy pi's latest visible reply from the current run (last 3 paragraphs by default); to resend an earlier answer, pass it as content. " +
			"For a completion notification, set after_settle=true, omit content, then continue the task and produce its final answer. " +
			"Only when the user asks to see the current screen, set screen=true: the screen becomes the notification body, either the last visible lines (text mode, the default) or the whole screen rendered and uploaded to imageHosts (image mode), never both. " +
			"content and screen are mutually exclusive. Screen content may include sensitive tool output; in image mode it becomes accessible at the image URL. With after_settle, capture at the end of this run. " +
			"session_id validates the current session; it does not switch or resume another session.",
		parameters: Type.Object({
			chatid: Type.Optional(Type.String({ minLength: 1, description: "Target userid or group chatid. Omit to use configured defaultChatId." })),
			chat_type: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)], { description: "1 = single chat, 2 = group chat. Default 1." })),
			session_id: Type.Optional(Type.String({ minLength: 1, description: "Current pi session ID. Omit to read it automatically." })),
			content: Type.Optional(Type.String({ minLength: 1, description: "Explicit Markdown text; omit to extract pi's actual reply." })),
			tail_paragraphs: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Keep the last N paragraphs. Defaults to 3 when content is omitted." })),
			after_settle: Type.Optional(Type.Boolean({ description: "Wait for this run's final answer before sending. Default false." })),
			screen: Type.Optional(Type.Boolean({ description: "Explicit opt-in: use the current pi terminal screen as the notification body (screenMode text = last visible lines, image = whole screen upload; never both). Excludes editor/footer. Cannot be combined with content. Default false; errors fall back to text." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, toolCtx) {
			signal?.throwIfAborted();
			if (params.content !== undefined && !params.content.trim()) throw new Error("content 不能为空");
			if (params.content !== undefined && params.screen) {
				throw new Error("content 与 screen 只能二选一：screen 会用当前终端画面作为正文");
			}
			const target = destination(params.chatid, params.chat_type);
			const ctx = toolCtx ?? sessionCtx;
			if (!ctx) throw new Error("pi 会话尚未启动");
			const sessionId = ctx.sessionManager.getSessionId();
			if (params.session_id !== undefined && params.session_id !== sessionId) {
				throw new Error(`session_id 与当前 pi 会话不匹配（当前：${sessionId}）`);
			}
			const request: CompletionRequest = {
				...target, source: captureNotificationSource(ctx),
				content: params.content, screen: params.screen,
				tailParagraphs: params.screen ? undefined : params.tail_paragraphs ?? (params.content === undefined ? DEFAULT_TAIL_PARAGRAPHS : undefined),
				afterEntryId: ctx.sessionManager.getLeafId(),
			};
			if (request.content !== undefined) formatNotification(request.source, request.content, {
				kind: params.after_settle ? "completion" : "notification", tailParagraphs: request.tailParagraphs,
			});
			const current = bridge;
			if (!current?.ready) throw new Error("企业微信机器人未连接，请先运行 /wecom start");
			const details = {
				chatid: request.chatId, chat_type: request.chatType, session_id: sessionId,
				directory_name: request.source.directoryName,
				tail_paragraphs: request.tailParagraphs ?? null, screen: params.screen === true,
			};
			if (params.after_settle && !ctx.isIdle()) {
				current.schedule(request);
				return {
					content: [{ type: "text", text: "已安排在本轮 pi 结束后发送通知，尚未投递。请正常完成任务并输出最终回复。" }],
					details: { ...details, status: "queued" },
				};
			}
			// Only this run's replies: a tool call without text must not resend the previous run's answer.
			const answer = request.content === undefined ? latestAssistantReply(ctx.sessionManager.getBranch(), runStartEntryId) : undefined;
			if (request.content === undefined && !answer && !request.screen) {
				throw new Error("本轮还没有可摘录的文本回复；请用 content 指定正文，或设置 after_settle=true 在本轮结束后发送最终回复");
			}
			if (answer) request.source = { ...request.source, ...captureModelIdentity(ctx, answer) };
			await current.notify({ chatId: request.chatId, chatType: request.chatType }, notificationPayload(
				params.after_settle ? "completion" : "notification", request.source, request.content ?? answer?.text ?? "当前 pi 终端画面（不含编辑框和底部状态栏）。",
				{ tailParagraphs: request.tailParagraphs },
			), { screen: request.screen, ctx, signal });
			return {
				content: [{ type: "text", text: `已发送到 ${request.chatId}` }],
				details: { ...details, provider: request.source.provider, model_name: request.source.modelName, status: "sent" },
			};
		},
	});
}

// -------------------------------------------------------------------- helpers

function mask(value: string): string {
	if (value.length <= 8) return `${value.slice(0, 2)}****`;
	return `${value.slice(0, 4)}****${value.slice(-2)}`;
}
