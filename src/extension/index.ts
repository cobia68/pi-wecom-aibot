/**
 * pi-wecom-aibot — 企业微信智能机器人（长连接）扩展
 *
 * 把一个企业微信「智能机器人」通过官方 WebSocket 长连接接到正在运行的 pi 会话：
 * 在企微里发任务、收回复，也可以让 pi 主动推送消息。
 *
 * 官方协议：https://developer.work.weixin.qq.com/document/path/101463
 * 使用 BotID + 长连接专用 Secret，无需公网回调地址；媒体资源自动解密。
 *
 * 命令（主对象用位置参数，可选设置用 --选项，config 的参数写成 字段=值）：
 *   /wecom-aibot config [global|session] <show|edit|set|unset> [字段=值 …]   全局配置与当前 session 的覆盖；不带动作时列出子命令
 *   /wecom-aibot whoami [--wait 秒]      等你给机器人发消息，识别 chatid，确认后设为全局默认推送目标
 *   /wecom-aibot test [chatid] [--chat-type 1|2]
 *   /wecom-aibot connect | disconnect | status | log | reset
 *   /wecom-aibot --help                 命令与配置帮助
 *
 * 工具：
 *   wecom_send(...)   带会话、供应商、模型、目录来源的通知，可摘录最终回复
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BridgeClient } from "../shared/gateway-protocol.ts";
import { DEFAULT_TAIL_PARAGRAPHS, notificationPayload, notificationProblem } from "../shared/notification.ts";
import type { GatewayNotification } from "../shared/notification-types.ts";
import type { ChatRef, WeComState } from "../shared/wecom-protocol.ts";
import { type BridgeHost, BridgeSession } from "./bridge-session.ts";
import { completeWecom, parseWecomInvocation, WHOAMI_WAIT_SECONDS, wecomHelpText } from "./commands.ts";
import {
	CONFIG_FILE,
	type Connection,
	clearConfig,
	connectionKey,
	connectionOf,
	layerFile,
	type Resolved,
	SessionConfig,
	type Settings,
} from "./config.ts";
import { type ConfigHost, display, pendingReconnect, runConfig } from "./config-command.ts";
import { GatewayClient, type GatewayClientOptions } from "./gateway-client.ts";
import type { CompletionRequest } from "./notification-outbox.ts";
import { captureModelIdentity, captureNotificationSource, latestAssistantReply } from "./notification-source.ts";
import { ScreenCapture } from "./screen/capture.ts";
import { prepareScreenImage } from "./screen/image.ts";
import type { renderScreenPng } from "./screen/render.ts";
import { SessionSetup } from "./session-setup.ts";
import { WeComStatus } from "./status.ts";

export interface BridgeOptions {
	createClient?: (options: GatewayClientOptions) => BridgeClient;
	/** Keep the screen capture and image path real in integration tests, replacing only rasterisation. */
	renderScreen?: typeof renderScreenPng;
}

export default function wecomBotExtension(pi: ExtensionAPI, options: BridgeOptions = {}) {
	// ---------------------------------------------------------------- state
	/** Both configuration layers as the current session sees them; replaced at every session start. */
	let config: SessionConfig | undefined;
	/** The connection key whose pending reconnection was announced, so it is announced once. */
	let announcedPending: string | undefined;
	/** This session's explicitly requested connection through the shared gateway. */
	let bridge: BridgeSession | undefined;
	const instanceId = randomUUID();
	const screenCapture = new ScreenCapture();
	const footerStatus = new WeComStatus();
	/** Why the last bridge stopped, for /wecom-aibot status. */
	let stopReason: string | undefined;
	let sessionCtx: ExtensionContext | undefined;
	let settling = false;
	/** The session leaf when the current pi run started: replies after it belong to this run. */
	let runStartEntryId: string | null = null;
	/** Source chat of the current WeCom task; wecom_send omitting a target replies here. */
	let wecomSourceChat: { chatId: string; chatType: 1 | 2; userid: string } | undefined;
	/** WeCom messages already accepted in this pi session, across bridge restarts. */
	const seenMsgIds = new Set<string>();
	const logLines: string[] = [];

	const log = (line: string): void => {
		const stamped = `${new Date().toISOString()} ${line}`;
		logLines.push(stamped);
		if (logLines.length > 200) logLines.shift();
	};

	const notify = (
		ctx: ExtensionContext | undefined,
		message: string,
		type: "info" | "warning" | "error" = "info",
	): void => {
		if (ctx?.hasUI) ctx.ui.notify(message, type);
	};

	const host: BridgeHost = {
		context: () => sessionCtx,
		settings,
		settling: () => settling,
		sendUserMessage: (content) => {
			pi.sendUserMessage(content, { expandPromptTemplates: false });
		},
		// pi confirmed the run this task started; only then do its replies belong to that conversation.
		taskStarted: (chat) => {
			wecomSourceChat = { ...chat };
		},
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
		connectionChanged: (session) => {
			if (session === bridge) refreshStatus();
		},
		prepareImage: (notification, ctx, signal) => screenImage(notification, ctx, signal),
		captureScreen: async (ctx, signal) => {
			const prepared = await screenImage(
				{ kind: "reply", source: captureNotificationSource(ctx), text: "screen" },
				ctx,
				signal,
			);
			return prepared.image ?? Promise.reject(new Error(prepared.imageFailure ?? "没有返回图片"));
		},
		abort: () => sessionCtx?.abort(),
		stop: (reason) => stopBridge(reason),
	};

	/** The current screen in the screenshot theme, read now; failures keep the Markdown fallback. */
	function screenImage(
		notification: GatewayNotification,
		ctx: ExtensionContext,
		signal: AbortSignal,
	): Promise<GatewayNotification> {
		const { screenshotTheme } = settings();
		return prepareScreenImage(notification, () => screenCapture.capture(ctx, screenshotTheme), {
			signal,
			render: options.renderScreen,
			secrets: knownSecrets(),
			warn: (message) => {
				log(message);
				notify(ctx, message, "warning");
			},
		});
	}

	/** pi's theme names, for completing screenshotTheme; none before a session has started. */
	function piThemes(): string[] {
		return sessionCtx?.ui.getAllThemes().map((theme) => theme.name) ?? [];
	}

	/** Masked in every image: the Secret in use and the one the files hold now. */
	function knownSecrets(): string[] {
		const secrets = [bridge?.connection.secret, config?.latest?.values.secret];
		return [...new Set(secrets.filter((secret): secret is string => !!secret))];
	}

	/** The current session's configuration; commands, tools and connections exist only after session_start. */
	function sessionConfig(): SessionConfig {
		if (!config) throw new Error("pi 会话尚未启动");
		return config;
	}

	/** The notification settings, read where they are used so another window's change applies. */
	function settings(): Settings {
		const resolved = sessionConfig().current();
		observe(resolved);
		return resolved.values;
	}

	/** The connection key of the formal registration; undefined when this session is not connected. */
	function adoptedKey(): string | undefined {
		return bridge && !bridge.identifyOnly ? bridge.configKey : undefined;
	}

	/**
	 * Compare what the files say with what the registration uses: a difference is announced once and
	 * shown in the footer until /wecom-aibot connect adopts it. `announced`: the caller already said so.
	 */
	function observe(resolved: Resolved, announced = false): void {
		if (pendingReconnect(resolved, adoptedKey())) {
			const key = connectionKey(connectionOf(resolved));
			if (announcedPending !== key && !announced)
				notify(
					sessionCtx,
					"企业微信接入配置已改变（凭据、默认目标或白名单），当前接入仍使用旧配置；运行 /wecom-aibot connect 后生效。",
					"warning",
				);
			announcedPending = key;
		} else announcedPending = undefined;
		paintFooter();
	}

	// ---------------------------------------------------------------- bridge
	function refreshStatus(): void {
		if (bridge && sessionCtx && bridge.sessionId !== sessionCtx.sessionManager.getSessionId())
			stopBridge("target session changed");
		paintFooter();
	}

	function paintFooter(): void {
		footerStatus.update(sessionCtx, bridge?.connectionStatus, pendingReconnect(config?.latest, adoptedKey()));
	}

	/** `resolved`: what the files say now, undefined when they cannot be used (already reported). */
	function statusText(resolved: Resolved | undefined): string {
		const source = sessionCtx ? captureNotificationSource(sessionCtx) : undefined;
		const state = bridge?.state ?? "disconnected";
		const detail = bridge ? bridge.detail : stopReason;
		// What the registration uses while connected, otherwise what connect would use.
		const connection = bridge && !bridge.identifyOnly ? bridge.connection : resolved && connectionOf(resolved);
		const target = connection?.target
			? `${connection.target.chatId}（${connection.target.chatType === 2 ? "群聊" : "单聊"}）`
			: connection
				? "未配置（运行 /wecom-aibot whoami 识别）"
				: "未配置";
		const settings = resolved?.values;
		return [
			`企业微信智能机器人：${stateLabel(state)}${detail ? `（${stopReasonLabel(detail)}）` : ""}`,
			connection
				? `BotID：${display("botId", connection.botId)}　Secret：${display("secret", connection.secret)}`
				: resolved
					? "未配置（运行 /wecom-aibot config global edit）"
					: "配置无法使用（见上一条提示）",
			`接入方式：手动（每个 session 需 /wecom-aibot connect）　待处理：${bridge?.queued ?? 0}　处理中：${bridge?.running ? "是" : "否"}`,
			`本机共享网关：${bridge ? `${bridge.gatewaySessions} 个已注册 pi` : "未接入"}　当前 pi：${bridge?.identifyOnly ? "临时识别（未正式接入）" : bridge?.ready ? "已连接" : bridge ? "未就绪" : "未连接"}`,
			`session: ${source?.sessionId ?? "未启动"}　待通知：${bridge?.pendingNotifications ?? 0}`,
			`${source?.provider ?? "未选择供应商"} · ${source?.modelName ?? "未选择模型"}　工作目录：${source?.directoryName ?? "未启动"}`,
			`默认推送：${target}`,
			...(pendingReconnect(resolved, adoptedKey())
				? ["待重新接入：配置文件中的凭据、默认目标或白名单已改变，运行 /wecom-aibot connect 后生效"]
				: []),
			...(settings
				? [
						`通知方式：${settings.notificationMode === "screenshot" ? "screenshot（当前终端截图，与 screen 相同）" : "text（文字，Markdown）"}`,
						`自动结束通知范围：${settings.notificationScope === "all-runs" ? "all-runs（每轮结束都通知，含本地任务）" : "wecom-tasks（仅企微下发的任务）"}`,
						`截图主题：${display("screenshotTheme", settings.screenshotTheme)}`,
					]
				: []),
			`配置文件：${CONFIG_FILE}`,
			...(config ? [`会话覆盖：${layerFile({ session: config.sessionId })}`] : []),
			"查看各项来源：/wecom-aibot config show",
		].join("\n");
	}

	function ensureClient(ctx: ExtensionContext, connection: Connection, identifyOnly = false): void {
		if (bridge) return;
		sessionCtx = ctx;
		const session = new BridgeSession(
			host,
			connection,
			ctx,
			options.createClient ?? ((clientOptions) => new GatewayClient(clientOptions)),
			instanceId,
			identifyOnly,
		);
		// Assigned before start: a client that fails at once stops this session, not an older one.
		bridge = session;
		stopReason = undefined;
		refreshStatus();
		session.start();
	}

	function stopBridge(reason: string): void {
		const session = bridge;
		bridge = undefined;
		stopReason = reason;
		wecomSourceChat = undefined;
		announcedPending = undefined;
		try {
			session?.dispose(reason);
		} finally {
			footerStatus.clear();
		}
	}

	/** No explicit target: a WeCom task replies to its source chat, local runs to the adopted default. */
	function destination(chatId?: string, chatType?: 1 | 2, source?: ChatRef): ChatRef {
		const implicit = chatId === undefined ? (source ?? bridge?.connection.target) : undefined;
		const target = (chatId ?? implicit?.chatId)?.trim();
		if (!target) throw new Error("缺少 chatid，请传入目标或配置 defaultChatId（可运行 /wecom-aibot whoami 识别）");
		return { chatId: target, chatType: chatType ?? implicit?.chatType ?? 1 };
	}

	/**
	 * Both layers as they are on disk now, or undefined after telling the user why they cannot be used.
	 * Every caller reports the connection state itself, so a pending reconnection is not announced again.
	 */
	function readResolved(ctx: ExtensionContext): Resolved | undefined {
		let resolved: Resolved;
		try {
			resolved = sessionConfig().read();
		} catch (error) {
			ctx.ui.notify(`企业微信配置无法使用：${error instanceof Error ? error.message : String(error)}`, "error");
			return undefined;
		}
		observe(resolved, true);
		return resolved;
	}

	/**
	 * Replacing a registration drops its queued tasks and pending notifications: ask first. Without an
	 * interactive UI only a registration with nothing pending is replaced.
	 */
	async function confirmSwitch(ctx: ExtensionContext, owner: BridgeSession): Promise<boolean> {
		const pending = [
			owner.queued ? `${owner.queued} 条排队任务` : "",
			owner.pendingNotifications ? `${owner.pendingNotifications} 条待发通知` : "",
			owner.running ? "1 个运行中的任务" : "",
		].filter(Boolean);
		if (!ctx.hasUI) {
			if (pending.length)
				ctx.ui.notify(
					`接入配置已改变，但当前注册还有 ${pending.join("、")}；没有交互界面无法确认，未重新接入。请在终端中运行 /wecom-aibot connect 确认，或先 /wecom-aibot disconnect。`,
					"warning",
				);
			return !pending.length;
		}
		return ctx.ui.confirm(
			"连接配置已改变，重新接入？",
			"将撤销当前 session 的旧注册，清除排队任务和待发通知；已开始的任务继续运行，但旧结果不再回传。",
		);
	}

	// ---------------------------------------------------------------- pi events
	pi.on("session_start", async (_event, ctx) => {
		stopBridge("session changed");
		seenMsgIds.clear();
		runStartEntryId = null;
		wecomSourceChat = undefined;
		sessionCtx = ctx;
		screenCapture.bind(ctx);
		// The header names the parent of a fork or clone, which hands over its overrides once.
		config = new SessionConfig(
			ctx.sessionManager.getSessionId(),
			ctx.sessionManager.getHeader()?.parentSession,
			(message, type) => sessionCtx?.ui.notify(message, type),
		);
		// An unreadable file is reported now, never taken for “not configured” later.
		readResolved(ctx);
		stopReason = undefined;
		// Connection consent is never persisted or inherited by a new/resumed/reloaded session.
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
	pi.on("before_agent_start", (event, ctx) => {
		if (event.messageType !== "user") return;
		sessionCtx = ctx;
		const current = bridge;
		if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return;
		// A prompt this bridge did not hand over is a local run: its answer and replies stay local.
		if (!current.promptStarted(event.prompt, event.images?.length ?? 0)) wecomSourceChat = undefined;
	});
	pi.on("agent_start", (_event, ctx) => {
		// Emitted before the run's prompt is persisted, so the leaf still belongs to the previous run.
		runStartEntryId = ctx.sessionManager.getLeafId();
		refreshSource(ctx);
	});

	pi.on("message_start", (event, ctx) => bridge?.messageStart(event, ctx));
	pi.on("message_update", (event) => bridge?.messageUpdate(event));
	pi.on("message_end", (event, ctx) => bridge?.messageEnd(event, ctx));

	pi.on("agent_settled", async (event, ctx) => {
		if (bridge && bridge.sessionId !== ctx.sessionManager.getSessionId()) {
			stopBridge("target session changed");
			return;
		}
		settling = true;
		try {
			await bridge?.settle(ctx, event.aborted);
		} finally {
			settling = false;
			wecomSourceChat = undefined;
			// Submit queued work only after the notification boundary returns.
			bridge?.scheduleDrain();
		}
	});

	const setup = new SessionSetup({
		bridge: () => bridge,
		resolve: () => sessionConfig().read(),
		beginIdentity: (ctx) => {
			const connection = connectionOf(sessionConfig().read());
			if (!connection) throw new Error("尚未配置机器人凭据，请先运行 /wecom-aibot config global edit");
			if (bridge && bridge.configKey !== connectionKey(connection))
				throw new Error("连接配置已改变，请先 /wecom-aibot disconnect，再运行 /wecom-aibot whoami");
			ensureClient(ctx, connection, true);
			const identifying = bridge;
			if (!identifying) throw new Error("临时识别连接未能启动");
			identifying.resume();
			return identifying;
		},
		endIdentity: (watcher) => {
			if (watcher.identifyOnly && bridge === watcher) stopBridge("identity completed");
		},
		// whoami's own message already says the target waits for /wecom-aibot connect.
		configChanged: () => observe(sessionConfig().current(), true),
		log,
	});

	const configHost: ConfigHost = {
		config: sessionConfig,
		adopted: adoptedKey,
		// The command's own report already says whether the save waits for /wecom-aibot connect.
		changed: (resolved) => observe(resolved, true),
	};

	// ---------------------------------------------------------------- commands

	pi.registerCommand("wecom-aibot", {
		description: "管理当前 pi 的企业微信智能机器人（/wecom-aibot --help 查看用法）",
		getArgumentCompletions: (prefix) => completeWecom(prefix, piThemes),
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
			if (invocation.kind === "config") {
				await runConfig(ctx, invocation.config, configHost);
				return;
			}
			const { args, options, command } = invocation;
			const commandSessionId = ctx.sessionManager.getSessionId();
			const sub = command.name;

			switch (sub) {
				case "whoami": {
					await setup.identify(ctx, Number(options.get("wait") ?? WHOAMI_WAIT_SECONDS));
					return;
				}
				case "connect": {
					// Only the files count: after a reset in another pi, this window's snapshot must not recreate it.
					const resolved = readResolved(ctx);
					if (!resolved) return;
					const connection = connectionOf(resolved);
					if (!connection) {
						ctx.ui.notify("尚未配置机器人凭据，请先运行 /wecom-aibot config global edit", "warning");
						return;
					}
					if (bridge?.identifyOnly) {
						ctx.ui.notify("whoami 正在临时识别聊天，请完成或取消后再运行 /wecom-aibot connect。", "warning");
						return;
					}
					if (!connection.target) {
						ctx.ui.notify(
							`默认推送目标未配置，请先运行 /wecom-aibot whoami 识别并确认保存，或用 /wecom-aibot config <session|global> set defaultChatId=<ID> 填写。${bridge ? "本次未更新当前接入。" : "尚未接入。"}`,
							"warning",
						);
						return;
					}
					const key = connectionKey(connection);
					if (bridge && (bridge.sessionId !== commandSessionId || bridge.configKey !== key)) {
						const owner = bridge;
						if (!(await confirmSwitch(ctx, owner))) return;
						if (bridge !== owner || sessionCtx?.sessionManager.getSessionId() !== commandSessionId) {
							ctx.ui.notify(
								"当前 session 或接入已改变，未重新连接，请再次运行 /wecom-aibot connect。",
								"warning",
							);
							return;
						}
						const confirmed = readResolved(ctx);
						if (!confirmed) return;
						if (connectionKey(connectionOf(confirmed)) !== key) {
							ctx.ui.notify("配置在确认期间再次改变，未重新连接，请再次运行 /wecom-aibot connect。", "warning");
							return;
						}
						stopBridge("session or configuration changed");
					}
					ensureClient(ctx, connection);
					bridge?.resume();
					observe(resolved);
					return;
				}
				case "disconnect": {
					stopBridge("disconnected by user");
					// The label turns red for a moment, so an empty footer is explained rather than mysterious.
					footerStatus.flash(sessionCtx);
					ctx.ui.notify("已断开当前 pi 的企业微信接入；需要恢复请运行 /wecom-aibot connect。", "info");
					return;
				}
				case "reset": {
					if (!ctx.hasUI) {
						ctx.ui.notify(`reset 需要交互确认，没有界面时不删除配置；需要时直接删除 ${CONFIG_FILE}。`, "warning");
						return;
					}
					const ok = await ctx.ui.confirm(
						"删除全局企业微信配置？",
						"将删除全局的 BotID/Secret、默认推送目标、通知设置和白名单，并停止当前 pi 的接入；各 session 的覆盖文件保留。",
					);
					if (!ok) return;
					stopBridge("reset");
					try {
						clearConfig();
						ctx.ui.notify("已删除企业微信全局配置", "info");
					} catch (error) {
						const detail = error instanceof Error ? error.message : String(error);
						log(`configuration deletion failed: ${detail}`);
						ctx.ui.notify(
							`当前 pi 已停止，但配置文件删除失败：${detail}。BotID/Secret 可能仍在 ${CONFIG_FILE}，请检查权限后重试 /wecom-aibot reset。`,
							"error",
						);
					}
					return;
				}
				case "log": {
					ctx.ui.notify(logLines.slice(-20).join("\n") || "（暂无日志）", "info");
					return;
				}
				case "test": {
					const sender = bridge;
					if (!sender?.ready || sender.identifyOnly)
						throw new Error("企业微信智能机器人未正式接入，请先运行 /wecom-aibot connect");
					const chatType = options.get("chat-type");
					const target = destination(args[0], chatType === undefined ? undefined : chatType === "2" ? 2 : 1);
					await sender.notify(
						target,
						notificationPayload(
							"test",
							captureNotificationSource(ctx),
							[
								"机器人长连接认证成功；这是一条用于验证通知发送的测试消息。",
								`测试时间：${new Date().toISOString()}`,
							].join("\n\n"),
						),
						{ ctx },
					);
					log("deployment test notification acknowledged");
					ctx.ui.notify("部署测试通知已获得企业微信服务端确认", "info");
					return;
				}
				case "status": {
					ctx.ui.notify(statusText(readResolved(ctx)), "info");
					return;
				}
				default: {
					ctx.ui.notify("未知子命令，请使用 /wecom-aibot --help 查看用法。", "warning");
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
			"Send a notification through the WeCom (企业微信) smart robot. " +
			"The plugin automatically adds the pi session ID, provider, model name and working directory's final folder name; do not repeat them in content. " +
			"Use userid for single chat, chatid for group chat, or omit chatid to reply to the chat that sent the current WeCom task (local runs use the configured default target). " +
			"The user must have messaged the robot before. " +
			"Omit content to copy pi's latest visible reply from the current run (last 3 paragraphs by default); to resend an earlier answer, pass it as content. " +
			"For a completion notification, set after_settle=true, omit content, then continue the task and produce its final answer. " +
			"All notifications follow notificationMode: text sends Markdown; screenshot captures the current terminal, exactly like screen. " +
			"In screenshot mode explicit content is the Markdown fallback, not text drawn into the screenshot. " +
			"session_id validates the current session; it does not switch or resume another session.",
		parameters: Type.Object({
			chatid: Type.Optional(
				Type.String({
					minLength: 1,
					description:
						"Target userid or group chatid. Omit to use the source chat of the current WeCom task, or configured defaultChatId for local runs.",
				}),
			),
			chat_type: Type.Optional(
				Type.Union([Type.Literal(1), Type.Literal(2)], {
					description: "1 = single chat, 2 = group chat. Default 1.",
				}),
			),
			session_id: Type.Optional(
				Type.String({ minLength: 1, description: "Current pi session ID. Omit to read it automatically." }),
			),
			content: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Markdown body in text mode, fallback body in screenshot mode; omit to extract pi's reply.",
				}),
			),
			tail_paragraphs: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 20,
					description: "Keep the last N paragraphs. Defaults to 3 when content is omitted.",
				}),
			),
			after_settle: Type.Optional(
				Type.Boolean({ description: "Wait for this run's final answer before sending. Default false." }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, toolCtx) {
			signal?.throwIfAborted();
			if (params.content !== undefined && !params.content.trim()) throw new Error("content 不能为空");
			const target = destination(params.chatid, params.chat_type, wecomSourceChat);
			const ctx = toolCtx ?? sessionCtx;
			if (!ctx) throw new Error("pi 会话尚未启动");
			const sessionId = ctx.sessionManager.getSessionId();
			if (params.session_id !== undefined && params.session_id !== sessionId) {
				throw new Error(`session_id 与当前 pi 会话不匹配（当前：${sessionId}）`);
			}
			const request: CompletionRequest = {
				...target,
				source: captureNotificationSource(ctx),
				content: params.content,
				tailParagraphs:
					params.tail_paragraphs ?? (params.content === undefined ? DEFAULT_TAIL_PARAGRAPHS : undefined),
				afterEntryId: ctx.sessionManager.getLeafId(),
			};
			// Validate without rendering: the gateway renders the notification exactly once.
			if (request.content !== undefined) {
				const problem = notificationProblem(request.source, request.content, {
					kind: params.after_settle ? "completion" : "notification",
					tailParagraphs: request.tailParagraphs,
				});
				if (problem) throw new Error(problem);
			}
			const current = bridge;
			if (!current?.ready || current.identifyOnly)
				throw new Error("企业微信智能机器人未正式接入，请先运行 /wecom-aibot connect");
			const details = {
				chatid: request.chatId,
				chat_type: request.chatType,
				session_id: sessionId,
				directory_name: request.source.directoryName,
				tail_paragraphs: request.tailParagraphs ?? null,
			};
			if (params.after_settle && !ctx.isIdle()) {
				current.schedule(request);
				return {
					content: [
						{ type: "text", text: "已安排在本轮 pi 结束后发送通知，尚未投递。请正常完成任务并输出最终回复。" },
					],
					details: { ...details, status: "queued" },
				};
			}
			// Only this run's replies: a tool call without text must not resend the previous run's answer.
			const answer =
				request.content === undefined
					? latestAssistantReply(ctx.sessionManager.getBranch(), runStartEntryId)
					: undefined;
			if (request.content === undefined && !answer) {
				throw new Error(
					"本轮还没有可摘录的文本回复；请用 content 指定正文，或设置 after_settle=true 在本轮结束后发送最终回复",
				);
			}
			if (answer) request.source = { ...request.source, ...captureModelIdentity(ctx, answer) };
			const body = request.content ?? answer?.text;
			if (body === undefined) throw new Error("本轮还没有可摘录的文本回复");
			await current.notify(
				{ chatId: request.chatId, chatType: request.chatType },
				notificationPayload(params.after_settle ? "completion" : "notification", request.source, body, {
					tailParagraphs: request.tailParagraphs,
				}),
				{ ctx, signal },
			);
			return {
				content: [{ type: "text", text: `已发送到 ${request.chatId}` }],
				details: {
					...details,
					provider: request.source.provider,
					model_name: request.source.modelName,
					status: "sent",
				},
			};
		},
	});
}

// -------------------------------------------------------------------- helpers

/** pi-facing words for the connection state; the wire protocol keeps its own names. */
const STATE_LABELS: Record<WeComState, string> = {
	disconnected: "已断开",
	connecting: "正在连接",
	connected: "连接已建立，尚未订阅",
	subscribed: "已接入",
};

/** The reasons this extension sets itself; anything else is an upstream diagnostic and shown as given. */
const STOP_REASON_LABELS: Record<string, string> = {
	"disconnected by user": "已由用户断开",
	"identity completed": "whoami 识别完成",
	reset: "配置已删除",
	"session changed": "会话已切换",
	"session or configuration changed": "会话或配置已更改",
	"session shutdown": "pi 已退出",
	"target session changed": "目标会话已切换",
};

function stateLabel(state: WeComState): string {
	return STATE_LABELS[state];
}

function stopReasonLabel(reason: string): string {
	return STOP_REASON_LABELS[reason] ?? reason;
}
