/**
 * pi-wecom-aibot — 企业微信智能机器人（长连接）扩展
 *
 * 把一个企业微信「智能机器人」通过官方 WebSocket 长连接接到正在运行的 pi 会话：
 * 在企微里发任务、收回复，也可以让 pi 主动推送消息。
 *
 * 官方协议：https://developer.work.weixin.qq.com/document/path/101463
 * 使用 BotID + 长连接专用 Secret，无需公网回调地址；媒体资源自动解密。
 *
 * 命令（主对象用位置参数，可选设置用 --选项）：
 *   /wecom-aibot setup [whoami] [--bot-id ID] [--secret S] [--chatid ID] [--chat-type 1|2]   配置并连接已有机器人；接 whoami 时连上后识别 chatid
 *   /wecom-aibot whoami [--wait 秒]      等你给机器人发消息，识别 chatid，确认后设为默认推送目标
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
import { type BridgeHost, BridgeSession, connectionConfig } from "./bridge-session.ts";
import { completeWecom, parseWecomInvocation, WHOAMI_WAIT_SECONDS, wecomHelpText } from "./commands.ts";
import { CONFIG_FILE, clearConfig, loadConfig, updateConfig, type WeComConfig } from "./config.ts";
import { GatewayClient, type GatewayClientOptions } from "./gateway-client.ts";
import type { CompletionRequest } from "./notification-outbox.ts";
import { captureModelIdentity, captureNotificationSource, latestAssistantReply } from "./notification-source.ts";
import { ScreenCapture } from "./screen/capture.ts";
import { prepareScreenImage } from "./screen/image.ts";
import type { renderScreenPng } from "./screen/render.ts";
import { SessionSetup, setupCredentials, setupTarget } from "./session-setup.ts";
import { WeComStatus } from "./status.ts";

export interface BridgeOptions {
	createClient?: (options: GatewayClientOptions) => BridgeClient;
	/** Keep the screen capture and image path real in integration tests, replacing only rasterisation. */
	renderScreen?: typeof renderScreenPng;
}

export default function wecomBotExtension(pi: ExtensionAPI, options: BridgeOptions = {}) {
	// ---------------------------------------------------------------- state
	let cfg: WeComConfig | undefined;
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

	/** Read the file as it is on disk now. */
	const readConfig = (_ctx: ExtensionContext | undefined): WeComConfig | undefined => loadConfig();

	const notify = (
		ctx: ExtensionContext | undefined,
		message: string,
		type: "info" | "warning" | "error" = "info",
	): void => {
		if (ctx?.hasUI) ctx.ui.notify(message, type);
	};

	const host: BridgeHost = {
		context: () => sessionCtx,
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
		prepareImage: (notification, ctx, signal) => {
			if (!cfg) return Promise.resolve(notification);
			return prepareScreenImage(notification, () => screenCapture.capture(ctx), {
				signal,
				render: options.renderScreen,
				secrets: [cfg.secret],
				warn: (message) => {
					log(message);
					notify(ctx, message, "warning");
				},
			});
		},
		captureScreen: async (ctx, signal) => {
			if (!cfg) return undefined;
			const prepared = await prepareScreenImage(
				{ kind: "reply", source: captureNotificationSource(ctx), text: "screen" },
				() => screenCapture.capture(ctx),
				{
					signal,
					render: options.renderScreen,
					secrets: [cfg.secret],
					warn: (message) => {
						log(message);
						notify(ctx, message, "warning");
					},
				},
			);
			return prepared.image;
		},
		abort: () => sessionCtx?.abort(),
		stop: (reason) => stopBridge(reason),
	};

	// ---------------------------------------------------------------- bridge
	function refreshStatus(): void {
		if (bridge && sessionCtx && bridge.sessionId !== sessionCtx.sessionManager.getSessionId())
			stopBridge("target session changed");
		footerStatus.update(sessionCtx, bridge?.connectionStatus);
	}

	function statusText(): string {
		const source = sessionCtx ? captureNotificationSource(sessionCtx) : undefined;
		const state = bridge?.state ?? "disconnected";
		const detail = bridge ? bridge.detail : stopReason;
		return [
			`企业微信智能机器人：${state}${detail ? `（${detail}）` : ""}`,
			cfg ? `BotID：${mask(cfg.botId)}　Secret：${mask(cfg.secret)}` : "未配置（运行 /wecom-aibot setup）",
			`接入方式：手动（每个 session 需 /wecom-aibot connect）　待处理：${bridge?.queued ?? 0}　处理中：${bridge?.running ? "是" : "否"}`,
			`本机共享网关：${bridge ? `${bridge.gatewaySessions} 个已注册 pi` : "未接入"}　当前 pi：${bridge?.ready ? "已连接" : bridge ? "未就绪" : "未连接"}`,
			`session: ${source?.sessionId ?? "未启动"}　待通知：${bridge?.pendingNotifications ?? 0}`,
			`${source?.provider ?? "未选择供应商"} · ${source?.modelName ?? "未选择模型"}　工作目录：${source?.directoryName ?? "未启动"}`,
			`默认推送：${cfg?.defaultChatId ? `${cfg.defaultChatId}（${cfg.defaultChatType === 2 ? "群聊" : "单聊"}）` : cfg ? "未配置（运行 /wecom-aibot whoami 识别）" : "未配置"}`,
			`通知模式：${cfg?.sendMode === "image" ? "图片（自动结果截取当前屏幕）" : "文字（Markdown）"}`,
			`配置文件：${CONFIG_FILE}`,
		].join("\n");
	}

	function ensureClient(ctx: ExtensionContext): void {
		if (!cfg || bridge) return;
		sessionCtx = ctx;
		const session = new BridgeSession(
			host,
			cfg,
			ctx,
			options.createClient ?? ((clientOptions) => new GatewayClient(clientOptions)),
			instanceId,
		);
		// Assigned before start: a client that fails at once stops this session, not an older one.
		bridge = session;
		stopReason = undefined;
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
		wecomSourceChat = undefined;
		try {
			session?.dispose(reason);
		} finally {
			footerStatus.clear();
		}
	}

	/** No explicit target: a WeCom task replies to its source chat, local runs to the configured default. */
	function destination(
		chatId?: string,
		chatType?: 1 | 2,
		source?: { chatId: string; chatType: 1 | 2 },
	): { chatId: string; chatType: 1 | 2 } {
		const target = (chatId ?? source?.chatId ?? cfg?.defaultChatId)?.trim();
		if (!target) throw new Error("缺少 chatid，请传入目标或配置 defaultChatId（可运行 /wecom-aibot whoami 识别）");
		return {
			chatId: target,
			chatType: chatType ?? (chatId === undefined ? (source?.chatType ?? cfg?.defaultChatType) : undefined) ?? 1,
		};
	}

	// ---------------------------------------------------------------- pi events
	pi.on("session_start", async (_event, ctx) => {
		stopBridge("session changed");
		seenMsgIds.clear();
		runStartEntryId = null;
		wecomSourceChat = undefined;
		sessionCtx = ctx;
		screenCapture.bind(ctx);
		try {
			cfg = readConfig(ctx);
		} catch (error) {
			// Never treat an unreadable file as “not configured”: the user would edit a different setting.
			cfg = undefined;
			const detail = error instanceof Error ? error.message : String(error);
			log(`configuration unreadable: ${detail}`);
			ctx.ui.notify(`企业微信配置无法使用：${detail}。修正或删除后运行 /wecom-aibot connect。`, "error");
		}
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

	/** Resolve once this pi is registered and the bot is subscribed; stop, cancel or timeout reject. */
	function waitUntilReady(signal: AbortSignal): Promise<void> {
		return (
			bridge?.waitUntilReady(signal) ??
			Promise.reject(new Error("当前 pi 的企微接入已停止，请运行 /wecom-aibot connect"))
		);
	}

	const setup = new SessionSetup({
		bridge: () => bridge,
		config: () => cfg,
		applyConfig: (next) => {
			cfg = next;
		},
		readConfig,
		waitUntilReady,
		log,
	});

	// ---------------------------------------------------------------- commands

	pi.registerCommand("wecom-aibot", {
		description: "管理当前 pi 的企业微信智能机器人（/wecom-aibot --help 查看用法）",
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
					const target = next ? "whoami" : await setupTarget(ctx, options, cfg);
					if (target === null) {
						ctx.ui.notify("已取消，配置未修改。", "info");
						return;
					}
					// Only the fields setup asks for; connecting this session never opts another session in.
					cfg = updateConfig({
						botId,
						secret,
						...(target && target !== "whoami"
							? { defaultChatId: target.chatId, defaultChatType: target.chatType }
							: {}),
					});
					ctx.ui.notify("配置已保存；仅连接当前 session，新 session 需手动 /wecom-aibot connect。", "info");
					restart(ctx);
					// whoami needs the connection: the next message to the bot reports chatid and chat_type.
					if (target === "whoami") await setup.identify(ctx, Number(options.get("wait") ?? WHOAMI_WAIT_SECONDS));
					else if (cfg.defaultChatId) {
						ctx.ui.notify(
							`默认推送目标${target ? "已保存" : "保持"}：${cfg.defaultChatId}（${cfg.defaultChatType === 2 ? "群聊" : "单聊"}）。`,
							"info",
						);
					} else ctx.ui.notify("未配置默认推送目标；需要时运行 /wecom-aibot whoami 识别。", "info");
					return;
				}
				case "whoami": {
					if (!cfg) {
						ctx.ui.notify("尚未配置，请先运行 /wecom-aibot setup", "warning");
						return;
					}
					if (!bridge) {
						ctx.ui.notify("当前 pi 未接入企业微信，请先运行 /wecom-aibot connect", "warning");
						return;
					}
					await setup.identify(ctx, Number(options.get("wait") ?? WHOAMI_WAIT_SECONDS));
					return;
				}
				case "connect": {
					// Only the file counts: after a reset in another pi, this window's snapshot must not recreate it.
					let current: WeComConfig | undefined;
					try {
						current = readConfig(ctx);
					} catch (error) {
						const detail = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`企业微信配置无法使用：${detail}`, "error");
						return;
					}
					if (!current) {
						ctx.ui.notify("尚未配置，请先运行 /wecom-aibot setup", "warning");
						return;
					}
					cfg = current;
					if (
						bridge &&
						(bridge.sessionId !== ctx.sessionManager.getSessionId() || bridge.configKey !== connectionConfig(cfg))
					)
						stopBridge("session or configuration changed");
					ensureClient(ctx);
					bridge?.resume();
					return;
				}
				case "disconnect": {
					stopBridge("disconnected by user");
					ctx.ui.notify("当前 pi 已断开；其他 pi 不受影响，最后一个 pi 断开后网关自动结束。", "info");
					return;
				}
				case "reset": {
					const ok = await ctx.ui.confirm(
						"删除整份企业微信配置？",
						"将删除 BotID/Secret、默认推送目标和通知模式，并停止桥接。",
					);
					if (!ok) return;
					stopBridge("reset");
					try {
						clearConfig();
						cfg = undefined;
						ctx.ui.notify("已删除企业微信配置", "info");
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
					if (!sender?.ready) throw new Error("企业微信机器人未连接，请先运行 /wecom-aibot connect");
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
					ctx.ui.notify(statusText(), "info");
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
			"Send a Markdown notification through the WeCom (企业微信) smart robot. " +
			"The plugin automatically adds the pi session ID, provider, model name and working directory's final folder name; do not repeat them in content. " +
			"Use userid for single chat, chatid for group chat, or omit chatid to reply to the chat that sent the current WeCom task (local runs use the configured default target). " +
			"The user must have messaged the robot before. " +
			"Omit content to copy pi's latest visible reply from the current run (last 3 paragraphs by default); to resend an earlier answer, pass it as content. " +
			"For a completion notification, set after_settle=true, omit content, then continue the task and produce its final answer. " +
			"Explicit content is always sent as Markdown; the configured sendMode only decides how automatic results are sent. " +
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
				Type.String({ minLength: 1, description: "Explicit Markdown text; omit to extract pi's actual reply." }),
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
			if (!current?.ready) throw new Error("企业微信机器人未连接，请先运行 /wecom-aibot connect");
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
				{ ctx, signal, image: params.content === undefined && cfg?.sendMode === "image" },
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

function mask(value: string): string {
	if (value.length <= 8) return `${value.slice(0, 2)}****`;
	return `${value.slice(0, 4)}****${value.slice(-2)}`;
}
