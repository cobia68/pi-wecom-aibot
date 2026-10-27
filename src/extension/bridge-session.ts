/**
 * One pi session's registration with the shared gateway. A stop, restart or session change disposes it;
 * a disposed session ignores everything that arrives late, so nothing of it reaches the next one.
 */

import { randomUUID } from "node:crypto";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
	ExtensionContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import { type CardModel, clamp, plainText, withNote } from "../shared/card.ts";
import {
	CONTROL_KEYS,
	controlCardFor,
	controlCardId,
	MODEL_QUESTION,
	PROMPT_QUESTION,
	parseControlKey,
	sessionFingerprint,
} from "../shared/control-card.ts";
import { DeliveryError, deliveryFailure } from "../shared/delivery.ts";
import type {
	BridgeClient,
	BridgeRequest,
	BridgeResponse,
	CardClick,
	ChatIdentity,
	GatewayTask,
	TaskState,
} from "../shared/gateway-protocol.ts";
import { NO_REPLY_TEXT, sessionNote } from "../shared/notification.ts";
import type { GatewayNotification, SessionSource } from "../shared/notification-types.ts";
import { errorMessage } from "../shared/text.ts";
import type { ChatRef, WeComState } from "../shared/wecom-protocol.ts";
import { type Connection, connectionKey, type Settings } from "./config.ts";
import { type BridgeConnectionStatus, ConnectionNotices } from "./connection-notices.ts";
import type { ControlReceipts } from "./control-receipts.ts";
import { type ControlStatus, promptOptions, sessionControlCard } from "./control-view.ts";
import type { GatewayClientOptions } from "./gateway-client.ts";
import { InboundContentPreparer, type PreparedInboundContent } from "./inbound/content.ts";
import { type ModelChoice, modelOptions, modelPage } from "./model-options.ts";
import {
	type CompletionRequest,
	completionTitle,
	NotificationOutbox,
	noteOf,
	type RunOutcome,
} from "./notification-outbox.ts";
import {
	assistantReplyText,
	captureModelIdentity,
	captureSessionSource,
	latestAssistantReply,
} from "./session-data.ts";
import type { SessionDoc } from "./session-doc.ts";
import { SessionPage } from "./session-page.ts";

const MAX_QUEUE_SIZE = 50;
const CONNECT_WAIT_MS = 30_000;
/** pi refuses a prompt without telling extensions. */
const DISPATCH_CHECK_MS = 5_000;
const DISPATCH_REJECTED =
	"pi 没有接受这条企微任务（可能未选择模型、缺少 API key、登录已过期或正在压缩），请在 pi 中处理后重新发送";
const ABORT_CONFIRM_MS = 60_000;
/** Pages of models remembered at once, one per viewer's copy of a card. */
const MODEL_PAGES = 50;

/** What a click did, for the card's 窗口记录; `only`: in a group just the clicker's copy changes. */
interface ClickAnswer {
	note: string;
	only?: boolean;
	choosing?: "prompt" | "model";
	modelPage?: number;
}

interface BridgeTask {
	taskId: string;
	source: SessionSource;
	chatId: string;
	chatType: 1 | 2;
	userid: string;
	/** The first line of the task, for 窗口记录 of the card its result is sent as. */
	subject?: string;
	prepared?: PreparedInboundContent;
	label: string;
	result?: string;
	aborted?: boolean;
	/** pi never ran it. */
	failed?: boolean;
	notificationQueued?: boolean;
	/** Sent from a control card's dropdown: no WeCom message, so no status to update; the result is a card. */
	fromCard?: boolean;
}

export interface BridgeHost {
	context(): ExtensionContext | undefined;
	/** Owned by the pi session, not this disposable registration. */
	receipts(): ControlReceipts;
	/** Read where used, never kept by the session, so another window's change applies. */
	settings(): Settings;
	/** pi is between agent_settled and its notification boundary: no queued task may start. */
	settling(): boolean;
	sendUserMessage(content: (TextContent | ImageContent)[]): void;
	/**
	 * The models 切换模型 offers, in pi's order (its scoped models, else every model with a key), and a switch
	 * to one: false when its provider has no key.
	 */
	models(ctx: ExtensionContext): ModelChoice[];
	setModel(ctx: ExtensionContext, model: ModelChoice): Promise<boolean>;
	taskStarted?(chat: { chatId: string; chatType: 1 | 2; userid: string }): void;
	firstSeen(msgId: string): boolean;
	log(line: string): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** Late calls from a replaced session must not affect its replacement. */
	connectionChanged?(session: BridgeSession): void;
	/** Known secrets in a reply or notice masked, as in the terminal lines. */
	maskText(text: string): string;
	/** The visible terminal as plain text, with secrets masked; throws when there is no terminal to read. */
	screenLines(ctx: ExtensionContext): string[];
	/** The session pages of the configured document, or undefined when no document address is set. */
	doc(): SessionDoc | undefined;
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
	private readonly queue: BridgeTask[] = [];
	private readonly outbox: NotificationOutbox;
	private readonly readyWaiters = new Set<(error?: Error) => void>();
	private currentTask: BridgeTask | undefined;
	private dispatched: { task: BridgeTask; text: string; images: number } | undefined;
	/** The run this bridge started; undefined while the session's current run belongs to the user. */
	private startedTask: BridgeTask | undefined;
	private dispatchTimer: ReturnType<typeof setTimeout> | undefined;
	private streamText = "";
	private finalText = "";
	private drainTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly lifetime = new AbortController();
	private disposed = false;
	/** Detect a recovery that arrived before an earlier not-sent result was returned. */
	private subscription = 0;
	private readonly notices: ConnectionNotices;
	/** The terminal at the latest refresh: the card's three lines. */
	private screen: { at: Date; lines: string[] } | undefined;
	private readonly page: SessionPage;
	/** 中止 waiting for 确认中止: who asked, in which chat, until when. */
	private pendingAbort: { userid: string; chat: string; until: number } | undefined;
	/** The page of models each viewer's copy shows while 切换模型 waits (modelKey). */
	private readonly modelPages = new Map<string, number>();
	/** /wecom-aibot connect before the registration is ready: the first ready state publishes a card. */
	private announceOnReady = false;

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
			context: () => this.host.context(),
			send: (chat, notification) => this.client.notify(chat, notification),
			controlCard: (ctx, outcome, note, source) =>
				this.publishedCard(ctx, outcome === "live" ? undefined : outcome, note, source),
			log: (line) => this.host.log(line),
			notify: (message, type) => this.host.notify(message, type),
		});
		this.sessionId = ctx.sessionManager.getSessionId();
		this.configKey = connectionKey(connection);
		this.page = new SessionPage({
			sessionId: this.sessionId,
			live: () => !this.disposed && !this.identifyOnly,
			context: () => this.host.context(),
			doc: () => this.host.doc(),
			running: (ctx) => this.busy || !ctx.isIdle(),
			maskText: (text) => this.host.maskText(text),
			log: (line) => this.host.log(line),
		});
		this.client = createClient({
			config: connection,
			identifyOnly,
			source: captureSessionSource(ctx),
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
			onRequest: (id, request) => this.answerRequest(id, request),
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
		return !!this.currentTask;
	}
	/** pi is running, or this bridge still holds a WeCom task: a task sent now would wait. */
	get busy(): boolean {
		const ctx = this.host.context();
		return (
			(ctx !== undefined && !ctx.isIdle()) || this.host.settling() || !!this.currentTask || this.queue.length > 0
		);
	}
	get pendingNotifications(): number {
		return this.outbox.size + (this.identifyOnly ? 0 : this.host.receipts().pending);
	}

	dispose(reason: string): void {
		if (this.disposed) return;
		this.disposed = true;
		this.lifetime.abort();
		clearTimeout(this.drainTimer);
		this.drainTimer = undefined;
		clearTimeout(this.dispatchTimer);
		this.dispatchTimer = undefined;
		this.dispatched = undefined;
		this.startedTask = undefined;
		this.notices.dispose();
		if (this.currentTask) this.report(this.currentTask, "stopped");
		if (this.currentTask || this.queue.length)
			this.host.log(`cleared active request and ${this.queue.length} queued requests: ${reason}`);
		this.currentTask?.prepared?.release();
		for (const task of this.queue) task.prepared?.release();
		this.currentTask = undefined;
		this.queue.length = 0;
		this.outbox.dispose();
		this.streamText = this.finalText = "";
		this.client.stop(reason);
		for (const wake of [...this.readyWaiters]) wake(new Error(`当前 pi 的企微接入已停止（${reason}）`));
	}

	updateSource(ctx: ExtensionContext): void {
		if (!this.disposed && ctx.sessionManager.getSessionId() === this.sessionId)
			this.client.updateSource(captureSessionSource(ctx));
	}

	/** A gateway request is read-only with respect to the conversation: no turn is started. */
	private answerRequest(id: string, request: BridgeRequest): void {
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
		if (request.action === "click") {
			// The gateway already applied every pi's allowlist; this pi checks its own configuration again.
			const allowed = this.connection.allowedUserIds;
			if (allowed?.length && !allowed.includes(request.click.userid)) {
				this.host.log("ignored card click from non-allowlisted user");
				answer({ ok: true });
				return;
			}
			const cardId = request.click.cardId;
			// A key names the session its card showed; a card switched to this session was published by another.
			const parsed = parseControlKey(request.click.key);
			if (
				cardId !== undefined &&
				(parsed
					? parsed.fingerprint !== sessionFingerprint(this.sessionId)
					: !controlCardFor(cardId, this.sessionId))
			) {
				answer({ ok: false, error: "控制卡不属于当前 session" });
				return;
			}
			const click = request.click;
			void this.click(ctx, click)
				.then(({ note, only, choosing, modelPage }) => {
					const viewer = { viewer: click.userid, chat: click.chat, choosing, modelPage };
					answer({
						ok: true,
						note: clamp(note, 120),
						...(cardId ? { card: this.controlCard(this.host.context() ?? ctx, viewer) } : {}),
						...(only ? { userids: [click.userid] } : {}),
					});
				})
				.catch((error: unknown) => answer({ ok: false, error: clamp(errorMessage(error), 120) }));
			return;
		}
		if (request.action === "cancel") {
			this.host.abort();
			answer({ ok: true });
		}
	}

	resume(): void {
		this.client.resume();
	}

	/** /wecom-aibot connect: a new control card in the default chat, now or once the registration is ready. */
	announce(): void {
		const target = this.connection.target;
		if (this.disposed || this.identifyOnly || !target) return;
		if (this.ready) this.ensureControl(target, true);
		else this.announceOnReady = true;
	}

	/** A button on one of this session's cards; WeCom takes the card update within 5 seconds. */
	private async click(ctx: ExtensionContext, click: CardClick): Promise<ClickAnswer> {
		const { key, chat } = click;
		if (click.cardId) {
			switch (parseControlKey(key)?.action) {
				case CONTROL_KEYS.refresh:
					return { note: await this.refreshControl(ctx, click.userid) };
				case CONTROL_KEYS.show:
					return { note: `已切换到本会话；${await this.refreshControl(ctx, click.userid)}`, only: true };
				case CONTROL_KEYS.send:
					return this.choosePrompt();
				case CONTROL_KEYS.confirmSend:
					return { note: this.sendPrompt(ctx, click) };
				case CONTROL_KEYS.cancelSend:
					return { note: "已取消，没有发送提示词", only: true };
				case CONTROL_KEYS.model:
					return this.chooseModel(ctx, click);
				case CONTROL_KEYS.modelPrev:
					return this.turnModels(ctx, click, -1);
				case CONTROL_KEYS.modelNext:
					return this.turnModels(ctx, click, 1);
				case CONTROL_KEYS.confirmModel:
					return { note: await this.switchModel(ctx, click) };
				case CONTROL_KEYS.cancelModel:
					this.modelPages.delete(modelKey(click));
					return { note: "已取消，模型没有改", only: true };
				case CONTROL_KEYS.abort:
					return this.requestAbort(ctx, click);
				case CONTROL_KEYS.confirmAbort:
					return { note: this.confirmAbort(ctx, click) };
				case CONTROL_KEYS.cancelAbort:
					this.pendingAbort = undefined;
					return { note: "已取消中止", only: true };
				default:
					return { note: "不支持的按钮" };
			}
		}
		// Without a card ID, the only key is the card command's: publish a new copy of this session's card.
		if (key !== "control") return { note: "不支持的按钮" };
		void this.sendControl(chat, true, "已补发控制卡").catch((error: unknown) => {
			const outcome = deliveryFailure(error);
			const status = outcome === "unknown" ? "发送结果未知" : outcome === "rejected" ? "被拒绝" : "尚未发出";
			this.pushNote(chat, `控制卡${status}：${errorMessage(error)}`);
		});
		return { note: "已请求补发控制卡；旧卡仍可操作同一会话" };
	}

	// ---------------------------------------------------------------- the control card

	private choosePrompt(): ClickAnswer {
		if (!this.host.settings().controlPrompts.length) return { note: "没有提示词：先在 pi 里设置 controlPrompts" };
		return { note: "选好提示词后点「确认发送」", only: true, choosing: "prompt" };
	}

	private chooseModel(ctx: ExtensionContext, click: CardClick): ClickAnswer {
		const models = this.host.models(ctx);
		if (!models.length) return { note: "没有可用的模型：先在 pi 里配置模型和密钥" };
		this.rememberModelPage(click, 0);
		return {
			note: "选好模型后点「确认切换」；正在跑的一轮不变，下一轮起用新模型",
			only: true,
			choosing: "model",
			modelPage: 0,
		};
	}

	/** 上一页 / 下一页, wrapping round at either end. */
	private turnModels(ctx: ExtensionContext, click: CardClick, step: 1 | -1): ClickAnswer {
		const all = modelOptions(this.host.models(ctx), ctx.model);
		if (!all.options.length) return { note: "没有可用的模型：先在 pi 里配置模型和密钥" };
		const { pages } = modelPage(all);
		const page = ((this.modelPages.get(modelKey(click)) ?? 0) + step + pages) % pages;
		this.rememberModelPage(click, page);
		return {
			note: `第 ${page + 1}/${pages} 页；选好模型后点「确认切换」`,
			only: true,
			choosing: "model",
			modelPage: page,
		};
	}

	/** A forgotten page only starts the next 切换模型 from the first. */
	private rememberModelPage(click: CardClick, page: number): void {
		const key = modelKey(click);
		this.modelPages.delete(key);
		this.modelPages.set(key, page);
		for (const old of this.modelPages.keys()) if (this.modelPages.size > MODEL_PAGES) this.modelPages.delete(old);
	}

	/**
	 * 确认切换 reads the list again. A click without the dropdown's choice means what WeCom showed selected:
	 * the model in use on its page, else the page's first.
	 */
	private async switchModel(ctx: ExtensionContext, click: CardClick): Promise<string> {
		const all = modelOptions(this.host.models(ctx), ctx.model);
		const shown = modelPage(all, this.modelPages.get(modelKey(click)) ?? 0);
		this.modelPages.delete(modelKey(click));
		const { options, selected } = all;
		const id = click.selections?.[MODEL_QUESTION] ?? shown.selected ?? shown.options[0]?.id;
		const option = options.find((item) => item.id === id);
		if (!option) return options.length ? "模型列表已变化，请重新点「切换模型」" : "没有可用的模型";
		if (id === selected) return `模型没有改：仍是 ${option.text}`;
		try {
			if (!(await this.host.setModel(ctx, option.model))) return `没有切换：${option.model.provider} 没有配置密钥`;
		} catch (error) {
			return `没有切换：${errorMessage(error)}`;
		}
		this.updateSource(ctx);
		return ctx.isIdle() ? `已切换到 ${option.text}` : `已切换到 ${option.text}，下一轮起生效`;
	}

	/** One model per viewer: only who pressed 中止 sees 确认中止, only who chooses sees the list. */
	private controlCard(
		ctx: ExtensionContext,
		options: {
			viewer?: string;
			chat?: ChatRef;
			status?: ControlStatus;
			choosing?: "prompt" | "model";
			/** The model that wrote what the card is published with; a click shows the live one. */
			source?: SessionSource;
			modelPage?: number;
		} = {},
	): CardModel {
		const pageUrl = this.page.url();
		const icon = this.page.icon();
		return sessionControlCard(options.source ?? captureSessionSource(ctx), {
			status: options.status ?? this.controlStatus(ctx, options.viewer, options.chat),
			prompts: this.host.settings().controlPrompts,
			...(options.choosing ? { choosing: options.choosing } : {}),
			...(options.choosing === "model"
				? {
						models: this.host.models(ctx),
						...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
						...(options.modelPage === undefined ? {} : { modelPage: options.modelPage }),
					}
				: {}),
			...(icon ? { icon } : {}),
			...(this.screen ? { screen: this.screen } : {}),
			...(pageUrl ? { pageUrl } : {}),
		});
	}

	/**
	 * Everything pi publishes but a task's own reply: a new copy of this session's control card, 窗口记录 saying
	 * why it is here; `status` is a finished run's, else live. The page is rewritten at once for its quote.
	 */
	private publishedCard(
		ctx: ExtensionContext,
		status: RunOutcome | undefined,
		note: string,
		source?: SessionSource,
	): GatewayNotification["control"] {
		if (this.identifyOnly) return undefined;
		this.readScreen(ctx, "control card without a fresh screen");
		const card = withNote(this.controlCard(ctx, { status, source }), note);
		void this.page.write();
		return { cardId: controlCardId(this.sessionId), card };
	}

	/** The terminal now, for the card's three lines and the page; without one (RPC, print) the last stays. */
	private readScreen(ctx: ExtensionContext, failure: string): void {
		try {
			this.screen = { at: new Date(), lines: this.host.screenLines(ctx) };
		} catch (error) {
			this.host.log(`${failure}: ${errorMessage(error)}`);
		}
	}

	private controlStatus(ctx: ExtensionContext, viewer?: string, chat?: ChatRef): ControlStatus {
		const pending = this.pendingAbort;
		if (pending && viewer === pending.userid && chat && chatKey(chat) === pending.chat && Date.now() < pending.until)
			return "confirming";
		if (this.page.problem) return "doc-problem";
		return this.busy || !ctx.isIdle() ? "running" : "idle";
	}

	/** The card's three lines from the terminal at once, then the page. */
	private async refreshControl(ctx: ExtensionContext, viewer: string): Promise<string> {
		try {
			this.screen = { at: new Date(), lines: this.host.screenLines(ctx) };
		} catch (error) {
			return `画面读取失败：${errorMessage(error)}`;
		}
		return this.page.refresh(viewer);
	}

	autoWritePage(): void {
		this.page.writeAuto();
	}

	/**
	 * 确认发送: the dropdown's prompt runs as this session's task; with no WeCom message, its result is a card.
	 * The list is read now: a prompt removed or edited since the card was drawn is not sent.
	 */
	private sendPrompt(ctx: ExtensionContext, click: CardClick): string {
		const options = promptOptions(this.host.settings().controlPrompts);
		const id = click.selections?.[PROMPT_QUESTION] ?? options[0]?.id;
		const option = options.find((item) => item.id === id);
		if (!option)
			return options.length ? "提示词已修改，请看刷新后的卡片重选" : "没有提示词：先在 pi 里设置 controlPrompts";
		if (this.queue.length >= MAX_QUEUE_SIZE) return "排队的任务太多，稍后再发";
		const task: BridgeTask = {
			taskId: `card-${randomUUID()}`,
			source: captureSessionSource(ctx),
			chatId: click.chat.chatId,
			chatType: click.chat.chatType,
			userid: click.userid,
			subject: subjectOf(option.prompt),
			label: `${click.chat.chatType === 2 ? "group" : "single"}/card`,
			fromCard: true,
			prepared: { content: [{ type: "text", text: option.prompt }], label: "card/prompt", release() {} },
		};
		const ahead = this.queue.length + (this.currentTask || this.host.settling() || !ctx.isIdle() ? 1 : 0);
		this.queue.push(task);
		this.host.log(`queued card prompt (queue=${this.queue.length})`);
		this.scheduleDrain();
		return ahead ? `已排队「${option.text}」，前面 ${ahead} 条` : `已发送「${option.text}」`;
	}

	private requestAbort(ctx: ExtensionContext, click: CardClick): ClickAnswer {
		if (ctx.isIdle()) {
			this.pendingAbort = undefined;
			return { note: "当前没有运行中的任务" };
		}
		this.pendingAbort = { userid: click.userid, chat: chatKey(click.chat), until: Date.now() + ABORT_CONFIRM_MS };
		return { note: "60 秒内点「确认中止」才会中止", only: true };
	}

	private confirmAbort(ctx: ExtensionContext, click: CardClick): string {
		const pending = this.pendingAbort;
		if (!pending || pending.chat !== chatKey(click.chat) || Date.now() >= pending.until) {
			if (pending && Date.now() >= pending.until) this.pendingAbort = undefined;
			return "确认已过期，未中止";
		}
		if (pending.userid !== click.userid) return "只有发起中止的人能确认";
		this.pendingAbort = undefined;
		if (ctx.isIdle()) return "任务已结束，无需中止";
		this.host.abort();
		return "已请求中止当前运行";
	}

	/** pi chooses the ID, journals the delivery and draws the card; `note` says why the card is here. */
	private async sendControl(chat: ChatRef, force = false, note = "已接入"): Promise<void> {
		const subscription = this.subscription;
		try {
			const sent = await this.host.receipts().ensure(
				this.connection.botId,
				chat,
				async (cardId) => {
					const live = () => {
						const ctx = this.host.context();
						if (
							this.disposed ||
							this.identifyOnly ||
							!this.ready ||
							ctx?.sessionManager.getSessionId() !== this.sessionId
						)
							throw new DeliveryError("会话已停止或连接未就绪，控制卡尚未发送", "not_sent");
						return ctx;
					};
					const before = live();
					this.readScreen(before, "control card without a fresh screen");
					await this.page.ensure(before, chat);
					// Making the page may take seconds: the registration is checked again.
					const ctx = live();
					await this.client.push(chat, { kind: "control", cardId, card: withNote(this.controlCard(ctx), note) });
				},
				force,
			);
			if (sent && !this.disposed) {
				this.host.log(`control card delivered for session ${this.sessionId}`);
				void this.page.write();
			}
		} catch (error) {
			if (
				deliveryFailure(error) === "not_sent" &&
				!this.disposed &&
				this.ready &&
				this.subscription !== subscription
			)
				return this.sendControl(chat, force, note);
			throw error;
		}
	}

	private ensureControl(chat: ChatRef, force = false): void {
		void this.sendControl(chat, force).catch((error: unknown) => {
			if (this.disposed) return;
			const outcome = deliveryFailure(error);
			this.host.log(`control card failed (${outcome}): ${errorMessage(error)}`);
			if (outcome !== "not_sent")
				this.host.notify(
					`控制卡${outcome === "rejected" ? "被拒绝" : "未确认送达"}：${errorMessage(error)}；可在企微用 card 命令显式补发`,
					"warning",
				);
		});
	}

	private pushNote(chat: ChatRef, text: string): void {
		void this.client
			.push(chat, { kind: "markdown", text: sessionNote(this.sessionId, text) })
			.catch((error: unknown) => this.host.log(`click note not sent: ${errorMessage(error)}`));
	}

	// ---------------------------------------------------------------- the pi run of the active task
	messageStart(event: MessageStartEvent, ctx: ExtensionContext): void {
		if (this.currentTask && this.currentTask.source.sessionId !== ctx.sessionManager.getSessionId()) {
			this.host.stop("target session changed");
			return;
		}
		if (this.currentTask && this.currentTask.result === undefined && event.message.role === "assistant") {
			this.currentTask.source = { ...this.currentTask.source, ...captureModelIdentity(ctx, event.message) };
			this.streamText = this.finalText = "";
		}
	}

	messageUpdate(event: MessageUpdateEvent): void {
		if (!this.currentTask || this.currentTask.result !== undefined) return;
		const ev = event.assistantMessageEvent;
		if (ev?.type === "text_delta" && ev.delta) this.streamText += ev.delta;
	}

	messageEnd(event: MessageEndEvent, ctx: ExtensionContext): void {
		if (this.currentTask && this.currentTask.source.sessionId !== ctx.sessionManager.getSessionId()) {
			this.host.stop("target session changed");
			return;
		}
		if (!this.currentTask || this.currentTask.result !== undefined) return;
		if (event.message?.role !== "assistant") return;
		this.currentTask.source = { ...this.currentTask.source, ...captureModelIdentity(ctx, event.message) };
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
		if (!dispatched || this.disposed || this.currentTask !== dispatched.task) return false;
		const task = dispatched.task;
		if (dispatched.text !== prompt || dispatched.images !== images) {
			this.failTask(task, DISPATCH_REJECTED);
			return false;
		}
		this.startedTask = task;
		this.host.taskStarted?.({ chatId: task.chatId, chatType: task.chatType, userid: task.userid });
		return true;
	}

	settle(ctx: ExtensionContext, aborted: boolean): Promise<void> {
		const run = this.startedTask;
		this.startedTask = undefined;
		if (run && this.currentTask === run) {
			run.result = (this.finalText || this.streamText).trim() || NO_REPLY_TEXT;
			run.aborted = aborted;
			this.finishTask();
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
			source: captureSessionSource(ctx, answer),
			afterEntryId: null,
			result: answer?.text ?? NO_REPLY_TEXT,
			title: completionTitle(aborted),
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
		options: {
			ctx?: ExtensionContext;
			signal?: AbortSignal;
		} = {},
	): Promise<void> {
		const signal = options.signal ?? this.lifetime.signal;
		if (this.identifyOnly) throw new Error("临时识别连接不能发送通知，请运行 /wecom-aibot connect 正式接入");
		signal.throwIfAborted();
		const ctx = options.ctx ?? this.host.context();
		if (!ctx || ctx.sessionManager.getSessionId() !== this.sessionId)
			throw new Error("pi session_id 已改变，已取消通知");
		// A notice or the deployment test is this session's control card too, drawn as the terminal is now.
		if (!notification.control && notification.kind !== "result") {
			const control = this.publishedCard(ctx, undefined, noteOf(notification), notification.source);
			if (control) notification = { ...notification, control };
		}
		if (this.disposed || this.host.context()?.sessionManager.getSessionId() !== this.sessionId)
			throw new Error("pi 会话已停止或切换，已取消通知");
		await this.client.notify(chat, notification);
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
				if (!this.identifyOnly) {
					const announce = this.announceOnReady;
					this.announceOnReady = false;
					if (this.connection.target) this.ensureControl(this.connection.target, announce);
					for (const chat of this.host.receipts().retryable(this.connection.botId)) this.ensureControl(chat);
				}
				if (this.currentTask?.result !== undefined) this.finishTask();
				const ctx = this.host.context();
				if (ctx)
					void this.outbox
						.prepare(ctx, false, "ready")
						.catch((err: unknown) => this.host.log(`notification preparation failed: ${errorMessage(err)}`));
				else
					void this.outbox
						.flush()
						.catch((err: unknown) => this.host.log(`notification flush failed: ${errorMessage(err)}`));
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
		void this.accept(ctx, task).catch((err: unknown) => this.host.log(`inbound failed: ${errorMessage(err)}`));
	}

	private async accept(ctx: ExtensionContext, task: GatewayTask): Promise<void> {
		const message = task.message;
		// The gateway already applied every pi's allowlist; this pi checks its own configuration again.
		if (this.connection.allowedUserIds?.length && !this.connection.allowedUserIds.includes(message.userid)) {
			this.host.log("ignored message from non-allowlisted user");
			return;
		}
		if (message.msgId && !this.host.firstSeen(message.msgId)) return;
		const queued: BridgeTask = {
			taskId: task.id,
			source: captureSessionSource(ctx),
			chatId: message.chat.chatId,
			chatType: message.chat.chatType,
			userid: message.userid,
			subject: subjectOf(message.text),
			label: `${message.chat.chatType === 2 ? "group" : "single"}/${message.msgtype}`,
		};
		if (this.queue.length >= MAX_QUEUE_SIZE) {
			this.report(queued, "busy");
			return;
		}
		// Reserve a FIFO position before any asynchronous download begins.
		this.queue.push(queued);
		this.ensureControl(message.chat);
		const signal = this.lifetime.signal;
		try {
			const prepared = await this.contentPreparer.prepare(ctx.cwd, message, signal);
			if (this.disposed || signal.aborted) {
				prepared.release();
				return;
			}
			queued.prepared = prepared;
			queued.label = prepared.label;
			this.host.log(`queued ${queued.label} (queue=${this.queue.length})`);
		} catch (err) {
			if (this.disposed || signal.aborted) return;
			const index = this.queue.indexOf(queued);
			if (index >= 0) this.queue.splice(index, 1);
			this.host.log(`message preparation failed: ${errorMessage(err)}`);
			this.report(queued, "failed");
		}
		this.scheduleDrain();
	}

	// ---------------------------------------------------------------- tasks
	scheduleDrain(delay = 0): void {
		if (this.disposed || this.drainTimer || this.host.settling()) return;
		this.drainTimer = setTimeout(() => {
			this.drainTimer = undefined;
			const ctx = this.host.context();
			if (this.host.settling() || this.currentTask || !this.queue[0]?.prepared || !this.client.isReady() || !ctx)
				return;
			if (!ctx.isIdle()) {
				this.scheduleDrain(250);
				return;
			}
			const next = this.queue.shift();
			if (next) this.run(next);
		}, delay);
	}

	/** The gateway owns the message's reply; a card's prompt has none, its result is a card. */
	private report(task: BridgeTask, taskState: TaskState): boolean {
		if (task.fromCard) return true;
		return this.client.taskStatus(task.taskId, taskState);
	}

	private run(task: BridgeTask): void {
		const prepared = task.prepared;
		if (!prepared) return;
		const ctx = this.host.context();
		if (task.source.sessionId !== this.sessionId || task.source.sessionId !== ctx?.sessionManager.getSessionId()) {
			prepared.release();
			task.prepared = undefined;
			this.host.log("cancelled queued message: target pi session changed before delivery");
			this.host.stop("target session changed");
			return;
		}
		task.source = { ...task.source, ...captureModelIdentity(ctx) };
		this.currentTask = task;
		this.streamText = "";
		this.finalText = "";
		if (!this.report(task, "running")) {
			this.currentTask = undefined;
			this.queue.unshift(task);
			return;
		}
		this.dispatched = { task, ...promptOf(prepared.content) };
		try {
			this.host.sendUserMessage(prepared.content);
			this.armDispatchCheck();
		} catch (err) {
			this.dispatched = undefined;
			clearTimeout(this.dispatchTimer);
			this.dispatchTimer = undefined;
			this.host.log(`sendUserMessage failed: ${errorMessage(err)}`);
			this.failTask(task, `pi 未能启动本次任务：${errorMessage(err)}`);
		} finally {
			prepared.release();
			task.prepared = undefined;
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
			this.failTask(dispatched.task, DISPATCH_REJECTED);
		}, DISPATCH_CHECK_MS);
		this.dispatchTimer.unref();
	}

	/** Report a task pi never ran; its answer must not be taken from whatever the user runs next. */
	private failTask(task: BridgeTask, reason: string): void {
		this.host.log(`task not started: ${reason}`);
		if (this.currentTask !== task) return;
		task.result = reason;
		task.aborted = false;
		task.failed = true;
		this.finishTask();
		const ctx = this.host.context();
		if (ctx)
			void this.outbox
				.prepare(ctx, false, "ready")
				.catch((err: unknown) => this.host.log(`notification preparation failed: ${errorMessage(err)}`));
		else
			void this.outbox
				.flush()
				.catch((err: unknown) => this.host.log(`notification flush failed: ${errorMessage(err)}`));
	}

	private finishTask(): void {
		const active = this.currentTask;
		if (!active || active.result === undefined) return;
		if (!active.notificationQueued) {
			this.outbox.queueResult({
				...(active.fromCard ? {} : { taskId: active.taskId }),
				chatId: active.chatId,
				chatType: active.chatType,
				source: active.source,
				afterEntryId: null,
				result: active.result,
				title: resultTitle(active),
				aborted: active.aborted,
				failed: active.failed,
			});
			active.notificationQueued = true;
			this.host.log(`final notification queued for ${active.label} (${active.result.length} chars)`);
		}
		// Freeze the result even while offline; report its final state before recovery flushes the outbox.
		if (!this.report(active, "settled")) return;
		this.currentTask = undefined;
		this.streamText = this.finalText = "";
		this.scheduleDrain();
	}
}

export function abortError(): Error {
	return Object.assign(new Error("whoami 已取消"), { name: "AbortError" });
}

/** The task's first line, as plain text short enough for a card title. */
function subjectOf(text: string): string | undefined {
	const line = plainText(text)
		.split("\n")
		.find((item) => item.trim());
	return line ? clamp(line, 24) : undefined;
}

function resultTitle(task: BridgeTask): string {
	const what = task.subject ? `：${task.subject}` : "";
	if (task.failed) return `⚠️ 未执行${what}`;
	if (!what) return completionTitle(!!task.aborted);
	return task.aborted ? `⛔ 已中止${what}` : `✅ 完成${what}`;
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

function chatKey(chat: ChatRef): string {
	return `${chat.chatType}:${chat.chatId}`;
}

/** Whose page of models: one viewer's copy of one card, in one chat. */
function modelKey(click: CardClick): string {
	return JSON.stringify([click.cardId ?? "", chatKey(click.chat), click.userid]);
}
