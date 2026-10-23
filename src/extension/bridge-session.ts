/**
 * One pi session's registration with the shared gateway. A stop, restart or session change disposes it;
 * a disposed session ignores everything that arrives late, so nothing of it reaches the next one.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
	ExtensionContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import type {
	BridgeClient,
	BridgeResponse,
	ChatIdentity,
	BridgeRequest as GatewayRequest,
	GatewayTask,
	TaskState,
} from "../shared/gateway-protocol.ts";
import { NO_REPLY_TEXT } from "../shared/notification.ts";
import type { GatewayImage, GatewayNotification, NotificationSource } from "../shared/notification-types.ts";
import type { ChatRef, WeComState } from "../shared/wecom-protocol.ts";
import { type Connection, connectionKey, type Settings } from "./config.ts";
import { type BridgeConnectionStatus, ConnectionNotices } from "./connection-notices.ts";
import type { GatewayClientOptions } from "./gateway-client.ts";
import { InboundContentPreparer, type PreparedInboundContent } from "./inbound/content.ts";
import { type CompletionRequest, NotificationOutbox, removeNotificationImage } from "./notification-outbox.ts";
import {
	assistantReplyText,
	captureModelIdentity,
	captureNotificationSource,
	latestAssistantReply,
} from "./notification-source.ts";

const MAX_QUEUE_SIZE = 50;
const CONNECT_WAIT_MS = 30_000;
/** pi refuses a prompt without telling extensions. */
const DISPATCH_CHECK_MS = 5_000;
const DISPATCH_REJECTED =
	"pi 没有接受这条企微任务（可能未选择模型、缺少 API key、登录已过期或正在压缩），请在 pi 中处理后重新发送";

interface BridgeRequest {
	taskId: string;
	source: NotificationSource;
	chatId: string;
	chatType: 1 | 2;
	userid: string;
	prepared?: PreparedInboundContent;
	label: string;
	result?: string;
	aborted?: boolean;
	/** Frozen at result creation, so a later mode reload cannot change its status or screenshot. */
	completionState?: "settled" | "notifying";
	notificationQueued?: boolean;
}

export interface BridgeHost {
	context(): ExtensionContext | undefined;
	/** Read where used, never kept by the session, so another window's change applies. */
	settings(): Settings;
	/** pi is between agent_settled and its notification boundary: no queued task may start. */
	settling(): boolean;
	sendUserMessage(content: (TextContent | ImageContent)[]): void;
	taskStarted?(chat: { chatId: string; chatType: 1 | 2; userid: string }): void;
	firstSeen(msgId: string): boolean;
	log(line: string): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** Late calls from a replaced session must not affect its replacement. */
	connectionChanged?(session: BridgeSession): void;
	/** Render this notification as a screen image; failures return the Markdown fallback. */
	prepareImage(
		notification: GatewayNotification,
		ctx: ExtensionContext,
		signal: AbortSignal,
	): Promise<GatewayNotification>;
	captureScreen(ctx: ExtensionContext, signal: AbortSignal): Promise<GatewayImage | undefined>;
	abort(): void;
	stop(reason: string): void;
}

export class BridgeSession {
	readonly sessionId: string;
	/** Credentials, permissions and the default target used by this registration; changes revoke it. */
	readonly configKey: string;
	state: WeComState = "disconnected";
	detail: string | undefined;
	gatewaySessions = 0;
	private upstreamStopped = false;
	private readonly host: BridgeHost;
	private readonly client: BridgeClient;
	private readonly contentPreparer = new InboundContentPreparer();
	private readonly queue: BridgeRequest[] = [];
	private readonly outbox: NotificationOutbox;
	private readonly readyWaiters = new Set<(error?: Error) => void>();
	private active: BridgeRequest | undefined;
	private dispatched: { request: BridgeRequest; text: string; images: number } | undefined;
	/** The run this bridge started; undefined while the session's current run belongs to the user. */
	private activeRun: BridgeRequest | undefined;
	private dispatchTimer: ReturnType<typeof setTimeout> | undefined;
	private streamText = "";
	private finalText = "";
	private drainTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly mediaAbort = new AbortController();
	private disposed = false;
	/** Detect a recovery that arrived before an earlier not-sent result was returned. */
	private subscription = 0;
	private readonly notices: ConnectionNotices;

	constructor(
		host: BridgeHost,
		readonly connection: Connection,
		ctx: ExtensionContext,
		createClient: (options: GatewayClientOptions) => BridgeClient,
		instanceId: string,
		readonly identifyOnly = false,
	) {
		this.host = host;
		this.notices = new ConnectionNotices((message, type) => host.notify(message, type));
		this.outbox = new NotificationOutbox({
			isReady: () => this.client.isReady(),
			subscription: () => this.subscription,
			notificationMode: () => this.host.settings().notificationMode,
			context: () => this.host.context(),
			prepareImage: (notification, ctx, signal) => this.host.prepareImage(notification, ctx, signal),
			send: (chat, notification) => this.client.notify(chat, notification),
			log: (line) => this.host.log(line),
			notify: (message, type) => this.host.notify(message, type),
			signal: this.mediaAbort.signal,
		});
		this.sessionId = ctx.sessionManager.getSessionId();
		this.configKey = connectionKey(connection);
		if (!identifyOnly && connection.target) {
			this.outbox.schedule({
				kind: "connect",
				...connection.target,
				source: captureNotificationSource(ctx),
				content: "引用本条消息回复，即可向这个会话发送任务",
				afterEntryId: null,
			});
		}
		this.client = createClient({
			config: connection,
			identifyOnly,
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
			onRequest: (id, request) => this.request(id, request),
			log: (line) => host.log(line),
		});
	}

	start(): void {
		this.client.start();
	}

	get ready(): boolean {
		return !this.disposed && this.state === "subscribed" && this.client.isReady();
	}
	/** The shared WeCom connection gave up, also before a first subscription; /wecom-aibot connect resumes it. */
	get stopped(): boolean {
		return !this.disposed && this.upstreamStopped && this.state === "disconnected";
	}
	get connectionStatus(): BridgeConnectionStatus | undefined {
		return this.identifyOnly ? undefined : this.notices.connectionStatus;
	}
	get queued(): number {
		return this.queue.length;
	}
	get running(): boolean {
		return !!this.active;
	}
	/** pi is running, or this bridge still holds a WeCom task: a task sent now would wait. */
	get busy(): boolean {
		const ctx = this.host.context();
		return (ctx !== undefined && !ctx.isIdle()) || this.host.settling() || !!this.active || this.queue.length > 0;
	}
	get pendingNotifications(): number {
		return this.outbox.size;
	}

	dispose(reason: string): void {
		if (this.disposed) return;
		this.disposed = true;
		this.mediaAbort.abort();
		clearTimeout(this.drainTimer);
		this.drainTimer = undefined;
		clearTimeout(this.dispatchTimer);
		this.dispatchTimer = undefined;
		this.dispatched = undefined;
		this.activeRun = undefined;
		this.notices.dispose();
		if (this.active) this.report(this.active, "stopped");
		if (this.active || this.queue.length)
			this.host.log(`cleared active request and ${this.queue.length} queued requests: ${reason}`);
		this.active?.prepared?.release();
		for (const request of this.queue) request.prepared?.release();
		this.active = undefined;
		this.queue.length = 0;
		this.outbox.dispose();
		this.streamText = this.finalText = "";
		this.client.stop(reason);
		for (const wake of [...this.readyWaiters]) wake(new Error(`当前 pi 的企微接入已停止（${reason}）`));
	}

	updateSource(ctx: ExtensionContext): void {
		if (!this.disposed && ctx.sessionManager.getSessionId() === this.sessionId)
			this.client.updateSource(captureNotificationSource(ctx));
	}

	/** A gateway request is read-only with respect to the conversation: no turn is started. */
	private request(id: string, request: GatewayRequest): void {
		const ctx = this.host.context();
		const answer = (response: BridgeResponse) => {
			if (!this.disposed) this.client.respond(id, response);
		};
		if (this.disposed || this.identifyOnly || !ctx) {
			answer({ ok: false, error: "pi 尚未正式接入" });
			return;
		}
		if (ctx.sessionManager.getSessionId() !== this.sessionId || request.target.sessionId !== this.sessionId) {
			answer({ ok: false, error: "请求的 session 与当前 pi 不匹配" });
			return;
		}
		if (request.action === "state") {
			answer({ ok: true, busy: this.busy });
			return;
		}
		if (request.action === "cancel") {
			this.host.abort();
			answer({ ok: true });
			return;
		}
		void this.host
			.captureScreen(ctx, this.mediaAbort.signal)
			.then((image) => answer(image ? { ok: true, image } : { ok: false, error: "没有返回图片" }))
			.catch((error: unknown) => answer({ ok: false, error: errMsg(error) }));
	}

	resume(): void {
		this.client.resume();
	}

	// ---------------------------------------------------------------- the pi run of the active task
	messageStart(event: MessageStartEvent, ctx: ExtensionContext): void {
		if (this.active && this.active.source.sessionId !== ctx.sessionManager.getSessionId()) {
			this.host.stop("target session changed");
			return;
		}
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
		if (this.active && this.active.source.sessionId !== ctx.sessionManager.getSessionId()) {
			this.host.stop("target session changed");
			return;
		}
		if (!this.active || this.active.result !== undefined) return;
		if (event.message?.role !== "assistant") return;
		this.active.source = { ...this.active.source, ...captureModelIdentity(ctx, event.message) };
		const text = assistantReplyText(event.message);
		if (text.trim()) this.finalText = text;
	}

	/**
	 * pi confirms a dispatch only through before_agent_start: a run echoing the prompt handed over belongs
	 * to the WeCom task; any other prompt means pi refused it and the user started a local run.
	 */
	promptStarted(prompt: string, images: number): boolean {
		const dispatched = this.dispatched;
		this.dispatched = undefined;
		clearTimeout(this.dispatchTimer);
		this.dispatchTimer = undefined;
		if (!dispatched || this.disposed || this.active !== dispatched.request) return false;
		const request = dispatched.request;
		if (dispatched.text !== prompt || dispatched.images !== images) {
			this.failTask(request, DISPATCH_REJECTED);
			return false;
		}
		this.activeRun = request;
		this.host.taskStarted?.({ chatId: request.chatId, chatType: request.chatType, userid: request.userid });
		return true;
	}

	settle(ctx: ExtensionContext, aborted: boolean): Promise<void> {
		const run = this.activeRun;
		this.activeRun = undefined;
		if (run && this.active === run) {
			const text = (this.finalText || this.streamText).trim();
			run.result = text || NO_REPLY_TEXT;
			run.aborted = aborted;
			this.finishActive();
		} else if (!run) {
			// A local run: its answer is read from the session branch because its stream is not tracked.
			this.queueLocalReply(ctx, aborted);
		}
		return this.outbox.prepare(ctx, aborted);
	}

	/** notificationScope=all-runs: a terminal run reports to the adopted default target, never a guessed one. */
	private queueLocalReply(ctx: ExtensionContext, aborted: boolean): void {
		if (this.host.settings().notificationScope !== "all-runs" || this.identifyOnly) return;
		const { target } = this.connection;
		if (!target) return;
		const answer = latestAssistantReply(ctx.sessionManager.getBranch(), null);
		this.outbox.queueResult({
			...target,
			source: captureNotificationSource(ctx, answer),
			afterEntryId: null,
			result: answer?.text ?? NO_REPLY_TEXT,
			aborted,
		});
		this.host.log(`local run finished; result notification queued for ${target.chatId}`);
	}

	// ---------------------------------------------------------------- wecom_send
	schedule(request: CompletionRequest): void {
		if (this.identifyOnly) throw new Error("临时识别连接不能安排通知，请运行 /wecom-aibot connect 正式接入");
		this.outbox.schedule(request);
	}

	async notify(
		chat: ChatRef,
		notification: GatewayNotification,
		options: { ctx?: ExtensionContext; signal?: AbortSignal } = {},
	): Promise<void> {
		const signal = options.signal ?? this.mediaAbort.signal;
		if (this.identifyOnly) throw new Error("临时识别连接不能发送通知，请运行 /wecom-aibot connect 正式接入");
		signal.throwIfAborted();
		const ctx = options.ctx ?? this.host.context();
		if (!ctx || ctx.sessionManager.getSessionId() !== this.sessionId)
			throw new Error("pi session_id 已改变，已取消通知");
		try {
			if (this.host.settings().notificationMode === "screenshot")
				notification = await this.host.prepareImage(notification, ctx, signal);
			signal.throwIfAborted();
			if (this.disposed || this.host.context()?.sessionManager.getSessionId() !== this.sessionId)
				throw new Error("pi 会话已停止或切换，已取消通知");
			await this.client.notify(chat, notification);
		} finally {
			// A direct notification is not retained for reconnect: the gateway has consumed the file.
			removeNotificationImage(notification, (line) => this.host.log(line));
		}
	}

	// ---------------------------------------------------------------- whoami
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
			const timer = setTimeout(
				() =>
					finish(
						new Error(
							`${CONNECT_WAIT_MS / 1000} 秒内未连上企业微信（${this.state}${this.detail ? `：${this.detail}` : ""}）；可用 /wecom-aibot status 和 /wecom-aibot log 查看原因`,
						),
					),
				CONNECT_WAIT_MS,
			);
			this.readyWaiters.add(finish);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			else finish();
		});
	}

	watchIdentity(timeoutMs: number, signal: AbortSignal, onCode: (code: string) => void): Promise<ChatIdentity> {
		return this.client.watchIdentity(timeoutMs, signal, onCode);
	}

	// ---------------------------------------------------------------- client events
	private changeState(next: WeComState, detail: string | undefined): void {
		if (this.disposed) return;
		this.state = next;
		this.detail = detail;
		const ready = this.ready;
		const { becameReady, becameStopped } = this.notices.update({
			ready,
			stopped: this.stopped,
			detail,
		});
		if (ready) {
			for (const wake of [...this.readyWaiters]) wake();
			if (becameReady) {
				this.subscription++;
				if (this.active?.result !== undefined) this.finishActive();
				const ctx = this.host.context();
				if (ctx)
					void this.outbox
						.prepare(ctx, false, "ready")
						.catch((err: unknown) => this.host.log(`notification preparation failed: ${errMsg(err)}`));
				else
					void this.outbox
						.flush()
						.catch((err: unknown) => this.host.log(`notification flush failed: ${errMsg(err)}`));
				this.scheduleDrain();
			}
		}
		if (becameStopped) for (const wake of [...this.readyWaiters]) wake(new Error(detail ?? "企业微信连接已停止"));
		this.host.connectionChanged?.(this);
	}

	private receive(task: GatewayTask): void {
		const ctx = this.host.context();
		if (this.disposed || this.identifyOnly || !ctx) return;
		if (ctx.sessionManager.getSessionId() !== this.sessionId) {
			this.host.log("rejected message: current pi session differs from gateway registration");
			return;
		}
		void this.accept(ctx, task).catch((err: unknown) => this.host.log(`inbound failed: ${errMsg(err)}`));
	}

	private async accept(ctx: ExtensionContext, task: GatewayTask): Promise<void> {
		const message = task.message;
		// The gateway already applied every pi's allowlist; this pi checks its own configuration again.
		if (this.connection.allowedUserIds?.length && !this.connection.allowedUserIds.includes(message.userid)) {
			this.host.log("ignored message from non-allowlisted user");
			return;
		}
		if (message.msgId && !this.host.firstSeen(message.msgId)) return;
		const request: BridgeRequest = {
			taskId: task.id,
			source: captureNotificationSource(ctx),
			chatId: message.chat.chatId,
			chatType: message.chat.chatType,
			userid: message.userid,
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
			if (this.disposed || signal.aborted) {
				prepared.release();
				return;
			}
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
			const next = this.queue.shift();
			if (next) this.run(next);
		}, delay);
	}

	/** The gateway owns the status message: its wording, and ending it before WeCom's 10-minute limit. */
	private report(request: BridgeRequest, taskState: TaskState): boolean {
		return this.client.taskStatus(request.taskId, taskState);
	}

	private run(request: BridgeRequest): void {
		const prepared = request.prepared;
		if (!prepared) return;
		const ctx = this.host.context();
		if (
			request.source.sessionId !== this.sessionId ||
			request.source.sessionId !== ctx?.sessionManager.getSessionId()
		) {
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
		if (!this.report(request, "running")) {
			this.active = undefined;
			this.queue.unshift(request);
			return;
		}
		this.dispatched = { request, ...promptOf(prepared.content) };
		try {
			this.host.sendUserMessage(prepared.content);
			this.armDispatchCheck();
		} catch (err) {
			this.dispatched = undefined;
			clearTimeout(this.dispatchTimer);
			this.dispatchTimer = undefined;
			this.host.log(`sendUserMessage failed: ${errMsg(err)}`);
			this.failTask(request, `pi 未能启动本次任务：${errMsg(err)}`);
		} finally {
			prepared.release();
			request.prepared = undefined;
		}
	}

	/** Idle after a dispatch means pi refused the prompt; busy means its run may still be preparing. */
	private armDispatchCheck(): void {
		if (this.dispatchTimer || !this.dispatched) return;
		this.dispatchTimer = setTimeout(() => {
			this.dispatchTimer = undefined;
			const dispatched = this.dispatched;
			const ctx = this.host.context();
			if (!dispatched || this.disposed || !ctx) return;
			if (!ctx.isIdle()) {
				this.armDispatchCheck();
				return;
			}
			this.dispatched = undefined;
			this.failTask(dispatched.request, DISPATCH_REJECTED);
		}, DISPATCH_CHECK_MS);
		this.dispatchTimer.unref();
	}

	/** Report a task pi never ran; its answer must not be taken from whatever the user runs next. */
	private failTask(request: BridgeRequest, reason: string): void {
		this.host.log(`task not started: ${reason}`);
		if (this.active !== request) return;
		request.result = reason;
		request.aborted = false;
		this.finishActive(true);
		const ctx = this.host.context();
		if (ctx)
			void this.outbox
				.prepare(ctx, false, "ready")
				.catch((err: unknown) => this.host.log(`notification preparation failed: ${errMsg(err)}`));
		else void this.outbox.flush().catch((err: unknown) => this.host.log(`notification flush failed: ${errMsg(err)}`));
	}

	private finishActive(textOnly = false): void {
		const active = this.active;
		if (!active || active.result === undefined) return;
		if (!active.notificationQueued) {
			active.completionState =
				!textOnly && this.host.settings().notificationMode === "screenshot" ? "notifying" : "settled";
			this.outbox.queueResult({
				taskId: active.taskId,
				chatId: active.chatId,
				chatType: active.chatType,
				source: active.source,
				afterEntryId: null,
				result: active.result,
				aborted: active.aborted,
				textOnly,
			});
			active.notificationQueued = true;
			this.host.log(`final notification queued for ${active.label} (${active.result.length} chars)`);
		}
		// Freeze the result even while offline; report its final state before recovery flushes the outbox.
		if (!this.report(active, active.completionState ?? "settled")) return;
		this.active = undefined;
		this.streamText = this.finalText = "";
		this.scheduleDrain();
	}
}

export function abortError(): Error {
	return Object.assign(new Error("whoami 已取消"), { name: "AbortError" });
}

/** Mirrors how before_agent_start reports the prompt (text parts joined by "\n", image count). */
function promptOf(content: (TextContent | ImageContent)[]): { text: string; images: number } {
	return {
		text: content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n"),
		images: content.filter((part) => part.type === "image").length,
	};
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
