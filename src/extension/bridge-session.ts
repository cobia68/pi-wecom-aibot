/**
 * One pi session's connection through the shared gateway: its client, the WeCom messages it accepted and
 * the notifications it owes. A stop, a restart or a session change disposes it, and a disposed session
 * ignores everything that arrives late; nothing of it can reach the next one.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext, MessageEndEvent, MessageStartEvent, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";
import { deliveryFailure } from "../shared/delivery.ts";
import type { WeComConfig } from "./config.ts";
import type { GatewayClientOptions } from "./gateway-client.ts";
import type { BridgeClient, ChatIdentity, GatewayTask, TaskState } from "../shared/gateway-protocol.ts";
import { InboundContentPreparer, type PreparedInboundContent } from "./inbound/content.ts";
import { rmSync } from "node:fs";
import { assistantReplyText, captureModelIdentity, captureNotificationSource, latestAssistantReply } from "./notification-source.ts";
import { NO_REPLY_TEXT, notificationPayload, renderNotification } from "../shared/notification.ts";
import type { GatewayNotification, NotificationSource } from "../shared/notification-types.ts";
import type { ChatRef, WeComState } from "../shared/wecom-protocol.ts";

const MAX_QUEUE_SIZE = 50;
const CONNECT_WAIT_MS = 30_000;
const DISCONNECT_NOTICE_MS = 30_000;

/** A WeCom message accepted by this pi; its status message belongs to the gateway. */
interface BridgeRequest {
	taskId: string;
	source: NotificationSource;
	chatId: string;
	chatType: 1 | 2;
	prepared?: PreparedInboundContent;
	label: string;
	result?: string;
	aborted?: boolean;
}

/** A wecom_send with after_settle: its content is read when the run ends. */
export interface CompletionRequest {
	chatId: string;
	chatType: 1 | 2;
	source: NotificationSource;
	content?: string;
	/** The frozen result of an automatic reply; content is reserved for explicit wecom_send bodies. */
	result?: string;
	aborted?: boolean;
	tailParagraphs?: number;
	afterEntryId: string | null;
	/** Image preparation in progress; settle and reconnect must not capture twice. */
	preparing?: Promise<void>;
	/** Frozen when the run ends; a reconnect sends exactly this. */
	ready?: GatewayNotification;
	/** Retained until ACK; concurrent settle/reconnect events share this attempt. */
	sending?: Promise<void>;
}

/** Visible connection status after this registration has been usable at least once. */
export type BridgeConnectionStatus = "online" | "reconnecting" | "blocked";

/** What a session needs from the pi extension that owns it. */
export interface BridgeHost {
	/** The context of the latest pi event or command. */
	context(): ExtensionContext | undefined;
	/** pi is between agent_settled and its notification boundary: no queued task may start. */
	settling(): boolean;
	sendUserMessage(content: (TextContent | ImageContent)[], chat?: { chatId: string; chatType: 1 | 2; userid: string }): void;
	/** false for a WeCom message this pi has already seen. */
	firstSeen(msgId: string): boolean;
	log(line: string): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** The owner may update its display; late updates must not affect a replacement session. */
	connectionChanged?(session: BridgeSession): void;
	/** Render this notification as a screen image; failures return the Markdown fallback. */
	prepareImage(notification: GatewayNotification, ctx: ExtensionContext, signal: AbortSignal): Promise<GatewayNotification>;
	/** Dispose this session, e.g. after the client gave up or the pi session changed. */
	stop(reason: string): void;
}

export class BridgeSession {
	/** The pi session the gateway registration belongs to. */
	readonly sessionId: string;
	/** Credentials and permissions this connection was made with; a change revokes the old registration. */
	readonly configKey: string;
	state: WeComState = "disconnected";
	detail: string | undefined;
	gatewaySessions = 0;
	/** The shared WeCom connection gave up and waits for /wecom-aibot connect (from the latest gateway status). */
	private upstreamStopped = false;
	private readonly host: BridgeHost;
	private readonly config: WeComConfig;
	private readonly client: BridgeClient;
	private readonly contentPreparer = new InboundContentPreparer();
	private readonly queue: BridgeRequest[] = [];
	private readonly notifications = new Map<string, CompletionRequest>();
	/** Frozen deliveries have their own ownership, independent of the next run's scheduling key. */
	private readonly outbox = new Set<CompletionRequest>();
	/** /wecom-aibot whoami waiting for this registration and subscription; an error ends the wait. */
	private readonly readyWaiters = new Set<(error?: Error) => void>();
	private active: BridgeRequest | undefined;
	private streamText = "";
	private finalText = "";
	private drainTimer: ReturnType<typeof setTimeout> | undefined;
	/** Aborts inbound media preparation, e.g. when this session is replaced. */
	private readonly mediaAbort = new AbortController();
	private disposed = false;
	/** A stopped upstream has been reported; the next report needs a restart in between. */
	private stoppedNotice = false;
	private everSubscribed = false;
	/** Readiness at the last callback; metadata and socket state can arrive separately. */
	private connectionReady = false;
	/** Detect a recovery that arrived before an earlier not-sent result was returned. */
	private subscription = 0;
	private connectionNoticeTimer: ReturnType<typeof setTimeout> | undefined;
	private disconnectReported = false;
	private disconnectDetail: string | undefined;

	constructor(host: BridgeHost, config: WeComConfig, ctx: ExtensionContext, createClient: (options: GatewayClientOptions) => BridgeClient, instanceId: string) {
		this.host = host;
		this.config = config;
		this.sessionId = ctx.sessionManager.getSessionId();
		this.configKey = connectionConfig(config);
		this.client = createClient({
			config,
			source: captureNotificationSource(ctx),
			instanceId,
			onStatus: (status) => {
				if (this.disposed) return;
				this.gatewaySessions = status.sessions;
				this.upstreamStopped = status.stopped === true;
				// stopped/readiness can change without a subsequent onState callback.
				this.changeState(status.state, status.detail);
			},
			onError: (message) => {
				if (this.disposed) return;
				// The client has given up: status, whoami and /wecom-aibot connect must see a stopped bridge, not a live one.
				host.stop(message);
				host.notify(message, "error");
			},
			onState: (next, detail) => this.changeState(next, detail),
			onTask: (task) => this.receive(task),
			log: (line) => host.log(line),
		});
	}

	start(): void { this.client.start(); }

	get ready(): boolean { return !this.disposed && this.state === "subscribed" && this.client.isReady(); }
	get connectionStatus(): BridgeConnectionStatus | undefined {
		if (this.ready) return "online";
		if (!this.everSubscribed) return undefined;
		return this.upstreamStopped && this.state === "disconnected" ? "blocked" : "reconnecting";
	}
	get queued(): number { return this.queue.length; }
	get running(): boolean { return !!this.active; }
	get pendingNotifications(): number { return this.notifications.size + this.outbox.size; }

	dispose(reason: string): void {
		if (this.disposed) return;
		this.disposed = true;
		this.mediaAbort.abort();
		clearTimeout(this.drainTimer);
		this.drainTimer = undefined;
		clearTimeout(this.connectionNoticeTimer);
		this.connectionNoticeTimer = undefined;
		if (this.active) this.report(this.active, "stopped");
		if (this.active || this.queue.length) this.host.log(`cleared active request and ${this.queue.length} queued requests: ${reason}`);
		this.active?.prepared?.release();
		for (const request of this.queue) request.prepared?.release();
		this.active = undefined;
		this.queue.length = 0;
		for (const request of this.notifications.values()) removeImage(request.ready);
		for (const request of this.outbox) removeImage(request.ready);
		this.notifications.clear();
		this.outbox.clear();
		this.streamText = this.finalText = "";
		this.client.stop(reason);
		for (const wake of [...this.readyWaiters]) wake(new Error(`当前 pi 的企微接入已停止（${reason}）`));
	}

	updateSource(ctx: ExtensionContext): void {
		if (!this.disposed && ctx.sessionManager.getSessionId() === this.sessionId) this.client.updateSource(captureNotificationSource(ctx));
	}

	updateWelcome(welcome: string): void { this.client.updateWelcome(welcome); }

	resume(): void { this.client.resume(); }

	// ---------------------------------------------------------------- the pi run of the active task
	messageStart(event: MessageStartEvent, ctx: ExtensionContext): void {
		if (this.active && this.active.source.sessionId !== ctx.sessionManager.getSessionId()) { this.host.stop("target session changed"); return; }
		if (this.active && this.active.result === undefined && event.message.role === "assistant") {
			this.active.source = { ...this.active.source, ...captureModelIdentity(ctx, event.message) };
			this.streamText = this.finalText = "";
		}
	}

	messageUpdate(event: MessageUpdateEvent): void {
		if (!this.active || this.active.result !== undefined) return;
		const ev = event.assistantMessageEvent;
		if (ev?.type === "text_delta" && ev.delta) this.streamText += ev.delta;
	}

	messageEnd(event: MessageEndEvent, ctx: ExtensionContext): void {
		if (this.active && this.active.source.sessionId !== ctx.sessionManager.getSessionId()) { this.host.stop("target session changed"); return; }
		if (!this.active || this.active.result !== undefined) return;
		if (event.message?.role !== "assistant") return;
		this.active.source = { ...this.active.source, ...captureModelIdentity(ctx, event.message) };
		const text = assistantReplyText(event.message);
		if (text.trim()) this.finalText = text;
	}

	/** The run ended: the active task's result and every completion notification are frozen and sent. */
	settle(ctx: ExtensionContext, aborted: boolean): Promise<void> {
		if (this.active && this.active.result === undefined) {
			const text = (this.finalText || this.streamText).trim();
			this.active.result = text || NO_REPLY_TEXT;
			this.active.aborted = aborted;
		}
		this.finishActive();
		return this.prepareNotifications(ctx, aborted);
	}

	// ---------------------------------------------------------------- wecom_send
	/** Send when the run ends; the latest call for the same conversation wins. */
	schedule(request: CompletionRequest): void {
		const key = notificationKey(request.source.sessionId, request);
		if (!this.notifications.has(key) && this.pendingNotifications >= MAX_QUEUE_SIZE) throw new Error("待发送通知过多，请稍后重试");
		this.notifications.set(key, request);
	}

	async notify(chat: ChatRef, notification: GatewayNotification, options: { ctx?: ExtensionContext; signal?: AbortSignal; image?: boolean } = {}): Promise<void> {
		const signal = options.signal ?? this.mediaAbort.signal;
		signal.throwIfAborted();
		const ctx = options.ctx ?? this.host.context();
		if (!ctx || ctx.sessionManager.getSessionId() !== this.sessionId) throw new Error("pi session_id 已改变，已取消通知");
		if (options.image) notification = await this.host.prepareImage(notification, ctx, signal);
		signal.throwIfAborted();
		if (this.disposed || this.host.context()?.sessionManager.getSessionId() !== this.sessionId) throw new Error("pi 会话已停止或切换，已取消通知");
		try {
			await this.client.notify(chat, notification);
		} finally {
			// A direct notification is not retained for reconnect: the gateway has consumed the file.
			removeImage(notification);
		}
	}

	// ---------------------------------------------------------------- whoami
	/** Resolve once this pi is registered and the bot is subscribed; stop, cancel or timeout reject. */
	waitUntilReady(signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const finish = (error?: Error) => {
				if (!error && !this.client.isReady()) return;
				this.readyWaiters.delete(finish);
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve();
			};
			const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : abortError());
			const timer = setTimeout(() => finish(new Error(
				`${CONNECT_WAIT_MS / 1000} 秒内未连上企业微信（${this.state}${this.detail ? `：${this.detail}` : ""}）；可用 /wecom-aibot status 和 /wecom-aibot log 查看原因`,
			)), CONNECT_WAIT_MS);
			this.readyWaiters.add(finish);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			else finish();
		});
	}

	watchIdentity(timeoutMs: number, signal: AbortSignal): Promise<ChatIdentity> {
		return this.client.watchIdentity(timeoutMs, signal);
	}

	// ---------------------------------------------------------------- client events
	private changeState(next: WeComState, detail: string | undefined): void {
		if (this.disposed) return;
		const wasReady = this.connectionReady;
		const wasStopped = this.stoppedNotice;
		this.state = next;
		this.detail = detail;
		this.connectionReady = this.ready;
		this.stoppedNotice = this.upstreamStopped && next === "disconnected";
		if (this.connectionReady) {
			clearTimeout(this.connectionNoticeTimer);
			this.connectionNoticeTimer = undefined;
			// The first success is shown only in the footer, even after a slow or refused attempt.
			if (this.everSubscribed && (this.disconnectReported || wasStopped)) this.host.notify("企业微信机器人连接已恢复", "info");
			this.everSubscribed = true;
			this.disconnectReported = false;
			this.disconnectDetail = undefined;
			for (const wake of [...this.readyWaiters]) wake();
			if (!wasReady) {
				this.subscription++;
				if (this.active?.result !== undefined) this.finishActive();
				const ctx = this.host.context();
				if (ctx) void this.prepareNotifications(ctx, false);
				else void this.flushNotifications();
				this.scheduleDrain();
			}
		}
		if (this.stoppedNotice) {
			clearTimeout(this.connectionNoticeTimer);
			this.connectionNoticeTimer = undefined;
		}
		if (this.stoppedNotice && !wasStopped) {
			// Also on the first connection: a refused subscription must not leave the bridge silently waiting.
			const reason = detail ?? "企业微信连接已停止";
			for (const wake of [...this.readyWaiters]) wake(new Error(reason));
			const hint = reason.includes("/wecom-aibot connect") ? "" : "。请核对 BotID/Secret（/wecom-aibot setup），然后运行 /wecom-aibot connect 恢复";
			this.disconnectReported = true;
			this.host.notify(`企业微信机器人连接已停止：${reason}${hint}`, "warning");
		} else if (!this.connectionReady && !this.stoppedNotice) {
			if (detail) this.disconnectDetail = detail;
			if (!this.connectionNoticeTimer && !this.disconnectReported) {
				// One deadline for the initial connection or each outage, not one per retry.
				this.connectionNoticeTimer = setTimeout(() => {
					this.connectionNoticeTimer = undefined;
					if (this.disposed || this.ready || this.stoppedNotice) return;
					this.disconnectReported = true;
					this.host.notify(this.everSubscribed
						? `企业微信机器人连接中断已超过 30 秒${this.disconnectDetail ? `：${this.disconnectDetail}` : ""}。仍在自动重连，可运行 /wecom-aibot log 查看诊断`
						: "企业微信首次连接等待已超过 30 秒。仍在重试，可运行 /wecom-aibot status 和 /wecom-aibot log 查看原因；/wecom-aibot disconnect 可取消。", "warning");
				}, this.everSubscribed ? DISCONNECT_NOTICE_MS : CONNECT_WAIT_MS);
				this.connectionNoticeTimer.unref();
			}
		}
		this.host.connectionChanged?.(this);
	}

	private receive(task: GatewayTask): void {
		const ctx = this.host.context();
		if (this.disposed || !ctx) return;
		if (ctx.sessionManager.getSessionId() !== this.sessionId) {
			this.host.log("rejected message: current pi session differs from gateway registration");
			return;
		}
		void this.accept(ctx, task).catch((err: unknown) => this.host.log(`inbound failed: ${errMsg(err)}`));
	}

	private async accept(ctx: ExtensionContext, task: GatewayTask): Promise<void> {
		const message = task.message;
		// The gateway already applied every pi's allowlist; this pi checks its own configuration again.
		if (this.config.allowedUserIds?.length && !this.config.allowedUserIds.includes(message.userid)) {
			this.host.log("ignored message from non-allowlisted user");
			return;
		}
		if (message.msgId && !this.host.firstSeen(message.msgId)) return;
		const request: BridgeRequest = {
			taskId: task.id,
			source: captureNotificationSource(ctx),
			chatId: message.chat.chatId,
			chatType: message.chat.chatType,
			label: `${message.chat.chatType === 2 ? "group" : "single"}/${message.msgtype}`,
		};
		if (this.queue.length >= MAX_QUEUE_SIZE) {
			this.report(request, "busy");
			return;
		}
		// Reserve a FIFO position before any asynchronous download begins.
		this.queue.push(request);
		const signal = this.mediaAbort.signal;
		try {
			const prepared = await this.contentPreparer.prepare(ctx.cwd, message, signal);
			if (this.disposed || signal.aborted) { prepared.release(); return; }
			request.prepared = prepared;
			request.label = prepared.label;
			this.host.log(`queued ${request.label} (queue=${this.queue.length})`);
		} catch (err) {
			if (this.disposed || signal.aborted) return;
			const index = this.queue.indexOf(request);
			if (index >= 0) this.queue.splice(index, 1);
			this.host.log(`message preparation failed: ${errMsg(err)}`);
			this.report(request, "failed");
		}
		this.scheduleDrain();
	}

	// ---------------------------------------------------------------- tasks
	scheduleDrain(delay = 0): void {
		if (this.disposed || this.drainTimer || this.host.settling()) return;
		this.drainTimer = setTimeout(() => {
			this.drainTimer = undefined;
			const ctx = this.host.context();
			if (this.host.settling() || this.active || !this.queue[0]?.prepared || !this.client.isReady() || !ctx) return;
			if (!ctx.isIdle()) {
				this.scheduleDrain(250);
				return;
			}
			this.run(this.queue.shift()!);
		}, delay);
	}

	/** pi only reports where the task is; the gateway shows it, ends the message in time and words it. */
	private report(request: BridgeRequest, taskState: TaskState): boolean {
		return this.client.taskStatus(request.taskId, taskState);
	}

	private run(request: BridgeRequest): void {
		const prepared = request.prepared;
		if (!prepared) return;
		const ctx = this.host.context();
		if (request.source.sessionId !== this.sessionId || request.source.sessionId !== ctx?.sessionManager.getSessionId()) {
			prepared.release();
			request.prepared = undefined;
			this.host.log("cancelled queued message: target pi session changed before delivery");
			this.host.stop("target session changed");
			return;
		}
		request.source = { ...request.source, ...captureModelIdentity(ctx) };
		this.active = request;
		this.streamText = "";
		this.finalText = "";
		// The gateway ends the status message before WeCom's 10-minute limit; the result follows as a notification.
		if (!this.report(request, "running")) {
			this.active = undefined;
			this.queue.unshift(request);
			return;
		}
		try {
			this.host.sendUserMessage(prepared.content, prepared.chat);
		} catch (err) {
			this.host.log(`sendUserMessage failed: ${errMsg(err)}`);
			request.result = "pi 未能启动本次任务，请在 pi 中查看错误后重试。";
			this.finishActive();
			void this.flushNotifications();
		} finally {
			// pi now owns its input (or rejected it); this bridge retains no image payload for the active run.
			prepared.release();
			request.prepared = undefined;
		}
	}

	private finishActive(): void {
		const active = this.active;
		if (!active || active.result === undefined) return;
		// Not handed to the gateway (disconnected): the next subscription finishes it.
		if (!this.report(active, "settled")) return;
		const key = notificationKey(active.source.sessionId, active);
		// A scheduled notification to this conversation owns the final delivery. Previous runs'
		// attempted deliveries live in the outbox and cannot swallow this newer result.
		if (!this.notifications.has(key)) {
			this.notifications.set(key, {
				chatId: active.chatId, chatType: active.chatType, source: active.source, afterEntryId: null,
				result: active.result, aborted: active.aborted,
			});
		}
		this.host.log(`final notification queued for ${active.label} (${active.result.length} chars)`);
		this.active = undefined;
		this.streamText = this.finalText = "";
		this.scheduleDrain();
	}

	// ---------------------------------------------------------------- notifications
	private prepareNotifications(ctx: ExtensionContext, aborted: boolean): Promise<void> {
		const images: Promise<void>[] = [];
		for (const [key, request] of this.notifications) {
			if (request.ready !== undefined) continue;
			if (request.preparing) { images.push(request.preparing); continue; }
			try {
				if (request.source.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("pi session_id 已改变，已取消通知");
				const answer = request.content === undefined && request.result === undefined
					? latestAssistantReply(ctx.sessionManager.getBranch(), request.afterEntryId) : undefined;
				if (answer) request.source = { ...request.source, ...captureModelIdentity(ctx, answer) };
				// Autonomous replies keep the tail like a normal reply; scheduled excerpts use completion rules.
				const ready = notificationPayload(request.result !== undefined ? "reply" : "completion", request.source,
					request.content ?? request.result ?? answer?.text ?? NO_REPLY_TEXT, {
						tailParagraphs: request.tailParagraphs, aborted: request.aborted ?? aborted,
					});
				// Validate the Markdown fallback before any image side effects.
				renderNotification(ready.source, ready.text, ready);
				// Explicit content stays Markdown; automatic replies and scheduled answers follow the mode.
				if (request.content !== undefined || this.config.sendMode !== "image") {
					request.ready = ready;
					continue;
				}
				const prepare = this.host.prepareImage(ready, ctx, this.mediaAbort.signal).then((prepared) => {
					if (this.disposed || this.notifications.get(key) !== request) { removeImage(prepared); return; }
					request.ready = prepared;
				}).catch((err: unknown) => this.cancelNotification(key, request, err))
					.finally(() => { request.preparing = undefined; });
				request.preparing = prepare;
				images.push(prepare);
			} catch (err) {
				this.cancelNotification(key, request, err);
			}
		}
		// Text notifications start their writes synchronously; images flush once their files are ready.
		const flush = this.flushNotifications();
		return images.length ? Promise.all(images).then(() => this.flushNotifications()) : flush;
	}

	private cancelNotification(key: string, request: CompletionRequest, error: unknown): void {
		if (this.disposed || this.notifications.get(key) !== request) return;
		this.notifications.delete(key);
		this.host.log(`notification cancelled: ${errMsg(error)}`);
		this.host.notify(`企微通知已取消：${errMsg(error)}`, "warning");
	}

	private async flushNotifications(): Promise<void> {
		if (this.disposed) return;
		// Transfer only at a ready connection: finishActive first needs to see any completion
		// prepared while offline, so it does not create an extra automatic reply for that same run.
		if (this.client.isReady()) for (const [key, request] of this.notifications) {
			if (request.ready === undefined) continue;
			this.notifications.delete(key);
			this.outbox.add(request);
		}
		const deliveries: Promise<void>[] = [];
		for (const request of this.outbox) {
			if (request.sending) { deliveries.push(request.sending); continue; }
			if (!this.client.isReady() || request.ready === undefined) continue;
			const subscription = this.subscription;
			let retained = false;
			// Content stays frozen through the ACK; a newer run has an independent outbox entry.
			request.sending = this.client.notify({ chatId: request.chatId, chatType: request.chatType }, request.ready).then(() => {
				this.outbox.delete(request);
				removeImage(request.ready);
				if (!this.disposed) this.host.log(`notification delivered for session ${request.source.sessionId}`);
			}).catch((err: unknown) => {
				if (this.disposed) return;
				const outcome = deliveryFailure(err);
				if (outcome === "not_sent") {
					retained = this.outbox.has(request);
					if (retained) this.host.log(`notification not sent; retained for reconnect: ${errMsg(err)}`);
					return;
				}
				this.outbox.delete(request);
				removeImage(request.ready);
				// A rejection needs user action; an unknown ACK outcome must never trigger an automatic duplicate.
				this.host.log(`notification failed (${outcome}): ${errMsg(err)}`);
				this.host.notify(`企微通知${outcome === "rejected" ? "被拒绝" : "未确认送达"}：${errMsg(err)}`, "warning");
			}).finally(() => {
				request.sending = undefined;
				// The subscribed event may have already visited this in-flight attempt. Do not miss that recovery.
				if (retained && !this.disposed && this.subscription !== subscription && this.client.isReady()) void this.flushNotifications();
			});
			deliveries.push(request.sending);
		}
		await Promise.all(deliveries);
	}
}

/** Credentials or permissions require a new registration; presentation updates retain pending session work. */
export function connectionConfig(config: WeComConfig): string {
	return JSON.stringify([config.botId, config.secret, config.allowedUserIds ?? []]);
}

export function abortError(): Error {
	return Object.assign(new Error("whoami 已取消"), { name: "AbortError" });
}

function removeImage(notification: GatewayNotification | undefined): void {
	const path = notification?.image?.path;
	if (!path) return;
	try { rmSync(path, { force: true }); } catch { /* best effort */ }
}

function notificationKey(sessionId: string, target: { chatId: string; chatType: 1 | 2 }): string {
	return JSON.stringify([sessionId, target.chatType, target.chatId]);
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
