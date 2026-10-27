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
import { type CardModel, clamp, firstLine, withNote } from "../shared/card.ts";
import {
	CONTROL_KEYS,
	controlCardFor,
	controlCardId,
	MAX_PROMPTS,
	MODEL_QUESTION,
	PROMPT_QUESTION,
	PUBLISH_KEY,
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
import { errorMessage, sentences } from "../shared/text.ts";
import type { ChatRef, WeComState } from "../shared/wecom-protocol.ts";
import { type Connection, connectionKey, type Settings } from "./config.ts";
import { type BridgeConnectionStatus, ConnectionNotices } from "./connection-notices.ts";
import type { ControlReceipts } from "./control-receipts.ts";
import { type ControlStatus, promptOptions, sessionControlCard } from "./control-view.ts";
import { type GatewayClientOptions, whoamiCancelled } from "./gateway-client.ts";
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
/** Cards whose offered next steps are remembered at once; an older card offers only controlPrompts. */
const CARD_STEPS = 50;
/** A task's first line in its result card's 窗口记录. */
const SUBJECT_LENGTH = 24;
const NO_MODELS = "没有可用的模型：先在 pi 里配置模型和密钥";

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
	/** Sent from a control card's dropdown: no WeCom message, so no gateway task to report to. */
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
	/** Each published card's next steps, offered before controlPrompts in its 提示词 dropdown. */
	private readonly cardSteps = new Map<string, string[]>();
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
			controlCard: (ctx, outcome, note, source, steps) => this.publishedCard(ctx, outcome, note, source, steps),
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
			running: () => this.busy,
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
		return this.occupied || this.queue.length > 0;
	}
	/** Something runs now: this bridge's task, pi's settling, or a run of pi's own. */
	private get occupied(): boolean {
		const ctx = this.host.context();
		return !!this.currentTask || this.host.settling() || (ctx !== undefined && !ctx.isIdle());
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
			if (!this.allows(request.click.userid)) {
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
					const viewer = { viewer: click.userid, chat: click.chat, cardId, choosing, modelPage };
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
					return this.choosePrompt(click);
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
					return { note: this.confirmAbort(ctx, click, "run") };
				case CONTROL_KEYS.abortAll:
					return { note: this.confirmAbort(ctx, click, "all") };
				case CONTROL_KEYS.clearQueue:
					return { note: this.confirmAbort(ctx, click, "queue") };
				case CONTROL_KEYS.cancelAbort:
					this.pendingAbort = undefined;
					return { note: "已取消中止", only: true };
				default:
					return { note: "不支持的按钮" };
			}
		}
		// Without a card ID, the only key is the one that publishes a new copy of this session's card.
		if (key !== PUBLISH_KEY) return { note: "不支持的按钮" };
		void this.sendControl(chat, true, "已补发控制卡").catch((error: unknown) => {
			const outcome = deliveryFailure(error);
			const status = outcome === "unknown" ? "发送结果未知" : outcome === "rejected" ? "被拒绝" : "尚未发出";
			this.pushNote(chat, `控制卡${status}：${errorMessage(error)}`);
		});
		return { note: "已请求补发控制卡；旧卡仍可操作同一会话" };
	}

	// ---------------------------------------------------------------- the control card

	private choosePrompt(click: CardClick): ClickAnswer {
		if (!this.promptsFor(click.cardId).length) return { note: "没有提示词：先在 pi 里设置 controlPrompts" };
		return { note: "选好提示词后点「确认发送」", only: true, choosing: "prompt" };
	}

	private chooseModel(ctx: ExtensionContext, click: CardClick): ClickAnswer {
		if (!this.host.models(ctx).length) return { note: NO_MODELS };
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
		if (!all.options.length) return { note: NO_MODELS };
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
		// The note row is short: what happened goes first, the model's long name last, where a cut costs least.
		if (id === selected) return `模型没有改：仍是 ${option.text}`;
		try {
			if (!(await this.host.setModel(ctx, option.model))) return `没有切换：缺少密钥 · ${option.model.provider}`;
		} catch (error) {
			return `没有切换：${errorMessage(error)}`;
		}
		this.updateSource(ctx);
		return ctx.isIdle() ? `已切换到 ${option.text}` : `下一轮起换成 ${option.text}`;
	}

	/** One model per viewer: only who pressed 中止 sees 确认中止, only who chooses sees the list. */
	private controlCard(
		ctx: ExtensionContext,
		options: {
			viewer?: string;
			chat?: ChatRef;
			/** The copy being drawn: its own next steps join its prompts. */
			cardId?: string;
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
			status: options.status ?? this.controlStatus(options.viewer, options.chat),
			prompts: this.promptsFor(options.cardId),
			queued: this.waiting,
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
	 * Everything pi publishes (a result, a notice, the deployment test): a new copy of this session's control
	 * card, 窗口记录 saying why it is here; `status` is a finished run's, else live. The page is rewritten at once
	 * for its quote.
	 */
	private publishedCard(
		ctx: ExtensionContext,
		status: RunOutcome | undefined,
		note: string,
		source?: SessionSource,
		steps?: readonly string[],
	): GatewayNotification["control"] {
		if (this.identifyOnly) return undefined;
		this.readScreen(ctx);
		const cardId = controlCardId(this.sessionId);
		if (steps?.length) this.rememberSteps(cardId, steps);
		const card = withNote(this.controlCard(ctx, { status, source, cardId }), note);
		void this.page.write();
		return { cardId, card };
	}

	private rememberSteps(cardId: string, steps: readonly string[]): void {
		this.cardSteps.set(cardId, [...steps]);
		for (const old of this.cardSteps.keys()) if (this.cardSteps.size > CARD_STEPS) this.cardSteps.delete(old);
	}

	/** A card's 提示词: the steps its answer offered, then controlPrompts, each once and at most MAX_PROMPTS. */
	private promptsFor(cardId: string | undefined): string[] {
		const steps = (cardId && this.cardSteps.get(cardId)) || [];
		return [...new Set([...steps, ...this.host.settings().controlPrompts])].slice(0, MAX_PROMPTS);
	}

	/**
	 * The terminal now, for the card's three lines and the page; without one (RPC, print) the last stays and
	 * the reason is returned.
	 */
	private readScreen(ctx: ExtensionContext): string | undefined {
		try {
			this.screen = { at: new Date(), lines: this.host.screenLines(ctx) };
			return undefined;
		} catch (error) {
			const reason = errorMessage(error);
			this.host.log(`control card without a fresh screen: ${reason}`);
			return reason;
		}
	}

	private controlStatus(viewer?: string, chat?: ChatRef): ControlStatus {
		const pending = this.pendingAbort;
		if (pending && viewer === pending.userid && chat && chatKey(chat) === pending.chat && Date.now() < pending.until)
			return "confirming";
		if (this.page.problem) return "doc-problem";
		return this.busy ? "running" : "idle";
	}

	/** The card's three lines from the terminal at once, then the page. */
	private async refreshControl(ctx: ExtensionContext, viewer: string): Promise<string> {
		const unread = this.readScreen(ctx);
		return unread ? `画面读取失败：${unread}` : this.page.refresh(viewer);
	}

	autoWritePage(): void {
		this.page.writeAuto();
	}

	/**
	 * 确认发送: the dropdown's prompt runs as this session's task; with no WeCom message, its result is a card.
	 * The list is read now: a prompt removed or edited since the card was drawn is not sent.
	 */
	private sendPrompt(ctx: ExtensionContext, click: CardClick): string {
		const options = promptOptions(this.promptsFor(click.cardId));
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
			subject: firstLine(option.prompt, SUBJECT_LENGTH),
			label: `${click.chat.chatType === 2 ? "group" : "single"}/card`,
			fromCard: true,
			prepared: { content: [{ type: "text", text: option.prompt }], label: "card/prompt", release() {} },
		};
		const ahead = this.queue.length + (this.occupied ? 1 : 0);
		this.queue.push(task);
		this.host.log(`queued card prompt (queue=${this.queue.length})`);
		this.scheduleDrain();
		return ahead ? `已排队「${option.text}」，前面 ${ahead} 条` : `已发送「${option.text}」`;
	}

	/** The gateway applied every pi's allowlist already; this pi checks its own configuration again. */
	private allows(userid: string): boolean {
		const allowed = this.connection.allowedUserIds;
		return !allowed?.length || allowed.includes(userid);
	}

	private requestAbort(ctx: ExtensionContext, click: CardClick): ClickAnswer {
		if (ctx.isIdle() && !this.queue.length) {
			this.pendingAbort = undefined;
			return { note: "当前没有运行中的任务" };
		}
		this.pendingAbort = { userid: click.userid, chat: chatKey(click.chat), until: Date.now() + ABORT_CONFIRM_MS };
		return {
			note: this.waiting ? "60 秒内选；「确认中止」只停这一轮" : "60 秒内点「确认中止」才会中止",
			only: true,
		};
	}

	/** Tasks behind the current run; with nothing running, the queue's head is about to start, so it is not waiting. */
	private get waiting(): number {
		return Math.max(0, this.queue.length - (this.occupied ? 0 : 1));
	}

	/** run: this run only; all: this run and the queue; queue: the queue only. Asked for by 中止任务 first. */
	private confirmAbort(ctx: ExtensionContext, click: CardClick, scope: "run" | "all" | "queue"): string {
		const pending = this.pendingAbort;
		if (!pending || pending.chat !== chatKey(click.chat) || Date.now() >= pending.until) {
			if (pending && Date.now() >= pending.until) this.pendingAbort = undefined;
			return "确认已过期，未中止";
		}
		if (pending.userid !== click.userid) return "只有发起中止的人能确认";
		this.pendingAbort = undefined;
		const cleared = scope === "run" ? 0 : this.clearQueue();
		const running = !ctx.isIdle();
		if (running && scope !== "queue") this.host.abort();
		const queue = cleared ? `已清空排队的 ${cleared} 条` : "排队是空的";
		if (scope === "queue") return queue;
		const run = running ? "已请求中止当前运行" : "任务已结束，无需中止";
		return scope === "all" ? sentences(run, queue) : run;
	}

	/** Every waiting task is dropped; a WeCom message's is answered that it was not run. */
	private clearQueue(): number {
		const dropped = this.queue.splice(0);
		for (const task of dropped) {
			task.prepared?.release();
			task.prepared = undefined;
			this.report(task, "cancelled");
		}
		if (dropped.length) this.host.log(`cleared ${dropped.length} queued task(s) from the control card`);
		return dropped.length;
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
					this.readScreen(before);
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
		if (this.taskMoved(ctx)) return;
		if (this.currentTask && this.currentTask.result === undefined && event.message.role === "assistant") {
			this.currentTask.source = { ...this.currentTask.source, ...captureModelIdentity(ctx, event.message) };
			this.streamText = this.finalText = "";
		}
	}

	/** The active task belongs to a session pi has left: forwarding stops. */
	private taskMoved(ctx: ExtensionContext): boolean {
		if (!this.currentTask || this.currentTask.source.sessionId === ctx.sessionManager.getSessionId()) return false;
		this.host.stop("target session changed");
		return true;
	}

	messageUpdate(event: MessageUpdateEvent): void {
		if (!this.currentTask || this.currentTask.result !== undefined) return;
		const ev = event.assistantMessageEvent;
		if (ev?.type === "text_delta" && ev.delta) this.streamText += ev.delta;
	}

	messageEnd(event: MessageEndEvent, ctx: ExtensionContext): void {
		if (this.taskMoved(ctx)) return;
		if (!this.currentTask || this.currentTask.result !== undefined) return;
		if (event.message?.role !== "assistant") return;
		this.currentTask.source = { ...this.currentTask.source, ...captureModelIdentity(ctx, event.message) };
		const text = assistantReplyText(event.message);
		if (text.trim()) this.finalText = text;
	}

	/**
	 * pi confirms a dispatch only through before_agent_start: a run echoing the prompt handed over belongs
	 * to the WeCom task, a card's or a message's; any other prompt means pi refused it and the user started a
	 * local run.
	 */
	promptStarted(prompt: string, images: number): "card" | "message" | undefined {
		const dispatched = this.dispatched;
		this.dispatched = undefined;
		clearTimeout(this.dispatchTimer);
		this.dispatchTimer = undefined;
		if (!dispatched || this.disposed || this.currentTask !== dispatched.task) return undefined;
		const task = dispatched.task;
		if (dispatched.text !== prompt || dispatched.images !== images) {
			this.failTask(task, DISPATCH_REJECTED);
			return undefined;
		}
		this.startedTask = task;
		this.host.taskStarted?.({ chatId: task.chatId, chatType: task.chatType, userid: task.userid });
		return task.fromCard ? "card" : "message";
	}

	/** A terminal run's answer is published to WeCom only with notificationScope=all-runs and a default target. */
	reportsLocalRuns(): boolean {
		return !this.identifyOnly && this.host.settings().notificationScope === "all-runs" && !!this.connection.target;
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
			/** What the notice offers as next steps on its card. */
			steps?: readonly string[];
		} = {},
	): Promise<void> {
		const signal = options.signal ?? this.lifetime.signal;
		if (this.identifyOnly) throw new Error("临时识别连接不能发送通知，请运行 /wecom-aibot connect 正式接入");
		signal.throwIfAborted();
		const ctx = options.ctx ?? this.host.context();
		if (!ctx || ctx.sessionManager.getSessionId() !== this.sessionId)
			throw new Error("pi session_id 已改变，已取消通知");
		if (this.disposed || this.host.context()?.sessionManager.getSessionId() !== this.sessionId)
			throw new Error("pi 会话已停止或切换，已取消通知");
		// A notice or the deployment test is this session's control card, drawn as the terminal is now.
		const control = this.publishedCard(ctx, undefined, noteOf(notification), notification.source, options.steps);
		await this.client.notify(chat, control ? { ...notification, control } : notification);
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
			const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : whoamiCancelled());
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
				this.deliverOutbox();
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
		if (!this.allows(message.userid)) {
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
			subject: firstLine(message.text, SUBJECT_LENGTH),
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
			// Cleared from the card while it was downloading: it was already answered as not run.
			if (this.disposed || signal.aborted || !this.queue.includes(queued)) {
				prepared.release();
				return;
			}
			queued.prepared = prepared;
			queued.label = prepared.label;
			this.host.log(`queued ${queued.label} (queue=${this.queue.length})`);
		} catch (err) {
			if (this.disposed || signal.aborted) return;
			const index = this.queue.indexOf(queued);
			if (index < 0) return;
			this.queue.splice(index, 1);
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

	/** A message's task is reported to the gateway, which answers the message when it did not run; a card's prompt has no gateway task. */
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
		this.deliverOutbox();
	}

	/** Results ready to go are sent now: with pi's context they are drawn first, else only what is drawn goes. */
	private deliverOutbox(): void {
		const ctx = this.host.context();
		const step = ctx ? this.outbox.prepare(ctx, false, "ready") : this.outbox.flush();
		void step.catch((err: unknown) => this.host.log(`notification delivery failed: ${errorMessage(err)}`));
	}

	private finishTask(): void {
		const active = this.currentTask;
		if (!active || active.result === undefined) return;
		if (!active.notificationQueued) {
			this.outbox.queueResult({
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
