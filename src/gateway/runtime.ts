/** One WeCom connection, with routing and membership independent of any pi process. */

import { randomInt, randomUUID } from "node:crypto";
import { type CardModel, renderCard, withNote } from "../shared/card.ts";
import {
	CONTROL_KEYS,
	CONTROL_OFFLINE_LABEL,
	type ControlAction,
	controlCardFor,
	controlKey,
	isControlCardId,
	PI_ICON_URL,
	parseControlKey,
	publisherFingerprint,
	SESSION_QUESTION,
	sessionFingerprint,
} from "../shared/control-card.ts";
import { DeliveryError, deliveryFailure } from "../shared/delivery.ts";
import {
	type BridgeResponse,
	type ChatIdentity,
	type GatewayCredentials,
	type GatewayRegistration,
	type GatewayStatus,
	type PushItem,
	type ServerFrame,
	type SessionTarget,
	sameTarget,
	sessionTarget,
	type TaskState,
} from "../shared/gateway-protocol.ts";
import {
	ABORTED_SUFFIX,
	formatProcessingStatus,
	type ProcessingState,
	quotedSessions,
	sessionMarkdown,
	sessionNote,
} from "../shared/notification.ts";
import type { GatewayNotification, SessionSource } from "../shared/notification-types.ts";
import { errorMessage } from "../shared/text.ts";
import {
	asRecord,
	type ChatRef,
	cardSelections,
	type InboundMessage,
	parseInbound,
	quotesMedia,
	senderOf,
	WECOM_REPLY_WINDOW_MS,
} from "../shared/wecom-protocol.ts";
import {
	ASK_CHOICES,
	ASK_MS,
	ASK_QUESTION,
	type AskedMessage,
	type AskOutcome,
	askAction,
	askCard,
	askCardId,
	isSettled,
	settledCard,
} from "./ask-card.ts";
import { helpText, parseWeComCommand, sessionCommand, type WeComCommand } from "./command.ts";
import { PICKER_QUESTION, type PickerAction, pageOf, pickerAction, sessionPicker } from "./session-picker.ts";
import { stateLabel, withSessions } from "./session-view.ts";
import { WeComClient, type WeComClientOptions, type WeComInbound } from "./wecom-client.ts";

const MAX_SESSIONS = 100;
const MAX_TASKS = 10_000;
const MAX_WATCH_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** How long a session list waits for each pi to say whether it is busy. */
const STATE_TIMEOUT_MS = 2_000;
/** Settle and its result notification travel one IPC channel; this is the most a task waits for its result. */
const MERGE_GRACE_MS = 1_000;
/**
 * WeCom takes a card update within 5 seconds of the click; pi gets most of that, the update the rest. A
 * control card's refresh writes its WeCom document page inside this window (about 2 seconds measured).
 */
const CLICK_ANSWER_MS = 4_000;
/** Leave transport time inside WeCom's five-second welcome/update window. */
const EVENT_REPLY_MS = 4_500;
/** Cards whose content the gateway can redraw after a click; older ones get a text note instead. */
const MAX_CARDS = 500;

export interface GatewayPeer {
	send(frame: ServerFrame): boolean;
	close(): void;
}

export interface WeComGatewayOptions extends GatewayCredentials, Pick<WeComClientOptions, "createWebSocket"> {}

interface Member extends GatewayRegistration {
	peer: GatewayPeer;
	/** When this session was last used (registered, given a task, published), as a sequence number. */
	active: number;
}

interface PendingRequest {
	reqId: string;
	instanceId: string;
	action: "cancel" | "card";
	timer: ReturnType<typeof setTimeout>;
}

interface SessionsPoll {
	members: Member[];
	busy: Map<string, boolean>;
	finish: (members: Member[], busy: ReadonlyMap<string, boolean>) => void;
	pending: number;
	done: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

/** A message routed to a pi, by callback req_id: its one reply is the result, sent within 24 hours. */
interface Task {
	target: SessionTarget;
	directory: string;
	streamId: string;
	chat: ChatRef;
	expiresAt: number;
	started?: boolean;
	awaitingResult?: boolean;
	mergeTimer?: ReturnType<typeof setTimeout>;
	unsent?: ProcessingState;
}

/** A session list sent as a new message, as the day's welcome, or over the list clicked (only the clicker's copy in a group). */
type PickerReply =
	| { kind: "message" | "welcome"; reqId: string; chat: ChatRef }
	| { kind: "update"; reqId: string; chat: ChatRef; cardId: string; userids?: string[] };

/** A click handed to its pi, answered within CLICK_ANSWER_MS or not at all. */
interface PendingClick {
	instanceId: string;
	target: SessionTarget;
	control: boolean;
	eventReqId: string;
	cardId: string;
	sessionId: string;
	chat: ChatRef;
	userid: string;
	/** Where the copy its clicker saw is recorded; it takes the note when no answer comes. */
	copy?: string;
	timer: ReturnType<typeof setTimeout>;
}

/** How a click reaches its pi as a control card's: the card ID, the dropdowns, the copy to note on a timeout. */
interface ControlForward {
	selections?: Record<string, string>;
	copy?: string;
}

export class WeComGateway {
	private readonly members = new Map<string, Member>();
	private readonly seen = new Set<string>();
	private readonly tasks = new Map<string, Task>();
	private readonly requests = new Map<string, PendingRequest>();
	private readonly stateQueries = new Map<string, { poll: SessionsPoll; instanceId: string }>();
	/** Cards to redraw on a click, by task_id; a control card per session it showed (cardKey). */
	private readonly cards = new Map<string, CardModel>();
	/** Messages that named no session, by their question card; one per sender and chat (askBySender). */
	private readonly asks = new Map<string, AskedMessage>();
	private readonly askBySender = new Map<string, string>();
	private readonly clicks = new Map<string, PendingClick>();
	/** /wecom-aibot config whoami in progress, by pi instance: the one-time code its chat must send. */
	private readonly watches = new Map<string, { id: string; code: string; expiresAt: number }>();
	private client: WeComClient | undefined;
	private status: GatewayStatus = { state: "disconnected", sessions: 0 };
	private readonly options: WeComGatewayOptions;
	private readonly membershipChanged: () => void;
	private activity = 0;
	/** Pi's colour logo from the session document, learned from pi's control cards and drawn on every card. */
	private icon: string | undefined;

	constructor(options: WeComGatewayOptions, membershipChanged: () => void = () => {}) {
		this.options = options;
		this.membershipChanged = membershipChanged;
	}

	get size(): number {
		return this.members.size;
	}
	private onlineSize(): number {
		return [...this.members.values()].filter((member) => !member.identifyOnly).length;
	}
	owns(instanceId: string, peer: GatewayPeer): boolean {
		return this.members.get(instanceId)?.peer === peer;
	}
	log(message: string): void {
		this.broadcast({ type: "log", message });
	}

	register(registration: GatewayRegistration, peer: GatewayPeer, resume = false): void {
		if (registration.config.botId !== this.options.botId)
			throw new Error("共享网关的 BotID 与本 pi 不一致，请核对配置");
		const collision = [...this.members.values()].find(
			(member) =>
				member.source.sessionId === registration.source.sessionId && member.instanceId !== registration.instanceId,
		);
		if (collision) throw new Error("该完整 session ID 已由另一个 pi 注册，请在当前窗口新建或切换会话");
		if (!this.members.has(registration.instanceId) && this.size >= MAX_SESSIONS)
			throw new Error("共享网关的在线会话已达上限");
		const previous = this.members.get(registration.instanceId);
		this.members.set(registration.instanceId, {
			...registration,
			source: { ...registration.source },
			peer,
			active: ++this.activity,
		});
		// A whoami belongs to the connection that asked; the replaced one has already failed it.
		this.watches.delete(registration.instanceId);
		previous?.peer.close();
		peer.send({ type: "registered", status: { ...this.status, sessions: this.onlineSize() } });
		this.membershipChanged();
		this.broadcastStatus();
		if (!this.client) {
			const { botId, secret, createWebSocket } = this.options;
			this.client = new WeComClient({
				botId,
				secret,
				createWebSocket,
				onState: (state, detail) => {
					this.status = {
						state,
						detail,
						sessions: this.onlineSize(),
						...(this.client?.stopped ? { stopped: true } : {}),
					};
					if (state === "subscribed") this.flushUnsent();
					this.broadcastStatus();
				},
				onMessage: (inbound) => this.receive(() => this.route(inbound)),
				onEvent: (inbound) => this.receive(() => this.event(inbound)),
				log: (message) => this.broadcast({ type: "log", message }),
			});
			this.client.start();
		} else if (resume) {
			this.client.start();
		}
	}

	unregister(instanceId: string, peer: GatewayPeer): void {
		if (this.members.get(instanceId)?.peer !== peer) return;
		this.members.delete(instanceId);
		this.watches.delete(instanceId);
		for (const [id, query] of [...this.stateQueries]) if (query.instanceId === instanceId) this.answerState(id);
		for (const [id, click] of [...this.clicks])
			if (click.instanceId === instanceId) this.finishClick(id, "会话已离线");
		this.broadcastStatus();
		this.membershipChanged();
	}

	updateSource(instanceId: string, source: SessionSource): void {
		const member = this.members.get(instanceId);
		if (!member) throw new Error("pi 尚未注册");
		if (source.sessionId !== member.source.sessionId) throw new Error("切换 session 必须重新注册");
		member.source = { ...source };
	}

	resume(): void {
		this.client?.start();
	}

	/** A message that is exactly the returned code identifies its chat, not a task; waiting codes are unique. */
	watch(instanceId: string, id: string, timeoutMs: number): string {
		const member = this.members.get(instanceId);
		if (!member) throw new Error("pi 尚未注册");
		this.watches.delete(instanceId);
		const taken = new Set([...this.watches.values()].map((watch) => watch.code));
		let code: string;
		do {
			code = String(randomInt(0, 1_000_000)).padStart(6, "0");
		} while (taken.has(code));
		const expiresAt = Date.now() + Math.min(Math.max(timeoutMs, 1000), MAX_WATCH_MS);
		this.watches.set(instanceId, { id, code, expiresAt });
		member.peer.send({ type: "watching", id, code });
		return code;
	}

	unwatch(instanceId: string, id: string): void {
		if (this.watches.get(instanceId)?.id === id) this.watches.delete(instanceId);
	}

	stop(): void {
		this.client?.stop("gateway shutdown");
		for (const member of this.members.values()) member.peer.close();
		this.members.clear();
		for (const request of this.requests.values()) clearTimeout(request.timer);
		this.requests.clear();
		for (const { poll } of this.stateQueries.values()) clearTimeout(poll.timer);
		this.stateQueries.clear();
		for (const click of this.clicks.values()) clearTimeout(click.timer);
		this.clicks.clear();
		this.cards.clear();
		for (const asked of this.asks.values()) clearTimeout(asked.timer);
		this.asks.clear();
		this.askBySender.clear();
		for (const task of this.tasks.values()) clearTimeout(task.mergeTimer);
		this.tasks.clear();
		this.watches.clear();
	}

	/** Only the pi the task was routed to may report its status. */
	taskStatus(instanceId: string, taskId: string, state: TaskState): boolean {
		const task = this.tasks.get(taskId);
		const member = this.members.get(instanceId);
		if (!task || !member || member.identifyOnly || !sameTarget(task.target, sessionTarget(member))) return false;
		if (task.expiresAt < Date.now()) {
			this.closeTask(taskId);
			return false;
		}
		if (state === "running") {
			task.started = true;
			return true;
		}
		if (state === "settled") {
			// The result follows on the same IPC channel; a scheduled notification may carry it as a card instead.
			if (!task.awaitingResult) {
				task.awaitingResult = true;
				task.mergeTimer = setTimeout(() => this.closeTask(taskId), MERGE_GRACE_MS);
			}
			return true;
		}
		return this.answer(taskId, task, state);
	}

	/**
	 * A task's own result is its message's reply, as Markdown naming the session; anything else is a card.
	 * WeCom shows no card inside a reply stream (probed 2026-10).
	 */
	async notify(instanceId: string, chat: ChatRef, notification: GatewayNotification): Promise<void> {
		const { member, client } = this.publisher(instanceId);
		if (notification.source.sessionId !== member.source.sessionId)
			throw new Error("通知的 session 与发送 pi 不匹配，已拒绝发送");
		if (!notification.text.trim()) throw new Error("当前 pi 会话没有可发送的文本回复");
		const awaiting = notification.taskId ? this.awaitingTask(member, chat, notification.taskId) : undefined;
		if (awaiting && notification.kind === "result") {
			const content = sessionMarkdown(
				notification.source,
				notification.text,
				notification.aborted ? ABORTED_SUFFIX : "",
			);
			const outcome = await this.replyResult(client, awaiting.taskId, awaiting.task, content);
			if (outcome === "delivered" || outcome === "unknown") return;
		} else if (awaiting) this.closeTask(awaiting.taskId);
		await this.publishCard(client, member, chat, notification);
	}

	/** A session's control card, or a click's follow-up text; each control card is a new message. */
	async push(instanceId: string, chat: ChatRef, item: PushItem): Promise<void> {
		const { member, client } = this.publisher(instanceId);
		member.active = ++this.activity;
		if (item.kind === "control") {
			if (!controlCardFor(item.cardId, member.source.sessionId))
				throw new DeliveryError("控制卡不属于发送 pi 的 session", "rejected");
			await this.sendControl(client, member, chat, item);
			return;
		}
		if (Buffer.byteLength(item.text, "utf8") > 20_480) throw new DeliveryError("推送正文超过 20480 字节", "rejected");
		await client.sendMsg(chat.chatId, chat.chatType, { msgtype: "markdown", markdown: { content: item.text } });
	}

	private publisher(instanceId: string): { member: Member; client: WeComClient } {
		const member = this.members.get(instanceId);
		if (!member || !this.client) throw new Error("pi 尚未注册");
		if (member.identifyOnly) throw new Error("临时识别连接不能发送通知；请完成配置后运行 /wecom-aibot connect");
		return { member, client: this.client };
	}

	/** Recorded before the send, since a click can arrive before the acknowledgement. */
	private async sendControl(
		client: WeComClient,
		member: Member,
		chat: ChatRef,
		control: { cardId: string; card: CardModel },
	): Promise<void> {
		const key = cardKey(control.cardId, member.source.sessionId);
		this.learnIcon(control.card);
		this.rememberCard(key, control.card);
		try {
			await client.sendMsg(chat.chatId, chat.chatType, {
				msgtype: "template_card",
				template_card: renderCard(this.forViewer(control.card, chat), control.cardId),
			});
		} catch (error) {
			// An unknown outcome may have delivered the card: keep its record.
			if (deliveryFailure(error) !== "unknown" && this.cards.get(key) === control.card) this.cards.delete(key);
			throw error;
		}
	}

	/** A notification is its session's control card; without one, or refused, its text goes as Markdown. */
	private async publishCard(
		client: WeComClient,
		member: Member,
		chat: ChatRef,
		notification: GatewayNotification,
	): Promise<void> {
		member.active = ++this.activity;
		const control =
			notification.control && controlCardFor(notification.control.cardId, member.source.sessionId)
				? notification.control
				: undefined;
		let refused = !control;
		if (control) {
			try {
				await this.sendControl(client, member, chat, control);
			} catch (error) {
				if (deliveryFailure(error) !== "rejected") throw error;
				this.log(`卡片被拒绝，改发 Markdown：${errorMessage(error)}`);
				refused = true;
			}
		}
		if (refused)
			await client.sendMsg(chat.chatId, chat.chatType, {
				msgtype: "markdown",
				markdown: {
					content: sessionMarkdown(
						notification.source,
						notification.title ? `**${notification.title}**\n\n${notification.text}` : notification.text,
						notification.aborted ? ABORTED_SUFFIX : "",
					),
				},
			});
	}

	/**
	 * Every card as rendered: the colour logo once known, and a control card's dropdown with the sessions the
	 * viewer may use (all of them on a group card nobody clicked; a click is checked anyway).
	 */
	private forViewer(card: CardModel, viewer: ChatRef | ChatIdentity): CardModel {
		const model = { ...card, icon: this.icon ?? card.icon ?? PI_ICON_URL };
		if (model.selection?.key !== SESSION_QUESTION) return model;
		const userid = "userid" in viewer ? viewer.userid : viewer.chatType === 1 ? viewer.chatId : undefined;
		const online = (userid === undefined ? [...this.members.values()] : this.eligible(userid)).filter(
			(member) => !member.identifyOnly,
		);
		return withSessions(model, online);
	}

	private learnIcon(card: CardModel): void {
		if (card.icon && card.icon !== PI_ICON_URL) this.icon = card.icon;
	}

	private rememberCard(cardId: string, card: CardModel): void {
		this.cards.set(cardId, card);
		const oldest = this.cards.keys().next().value;
		if (this.cards.size > MAX_CARDS && oldest !== undefined) this.cards.delete(oldest);
	}

	/** The message's one reply when it is not a result: it was not run, or forwarding stopped. */
	private answer(taskId: string, task: Task, state: ProcessingState): boolean {
		const sent =
			this.client?.respondMsg(taskId, {
				msgtype: "stream",
				stream: {
					id: task.streamId,
					finish: true,
					content: formatProcessingStatus(task.target.sessionId, state, task.directory),
				},
			}) ?? false;
		if (sent) this.closeTask(taskId);
		else task.unsent = state;
		return sent;
	}

	/** Only this result's own task: an earlier scheduled notification cannot take a newer reply. */
	private awaitingTask(member: Member, chat: ChatRef, taskId: string): { taskId: string; task: Task } | undefined {
		const task = this.tasks.get(taskId);
		if (!task?.awaitingResult || !task.started) return undefined;
		if (!sameTarget(task.target, sessionTarget(member))) return undefined;
		if (task.chat.chatId !== chat.chatId || task.chat.chatType !== chat.chatType) return undefined;
		return { taskId, task };
	}

	/** One attempt: a result the reply refuses goes out as a card, an unknown outcome not at all. */
	private async replyResult(
		client: WeComClient,
		taskId: string,
		task: Task,
		content: string,
	): Promise<"delivered" | "not_sent" | "rejected" | "unknown"> {
		try {
			await client.respondMsgAck(taskId, {
				msgtype: "stream",
				stream: { id: task.streamId, finish: true, content },
			});
			return "delivered";
		} catch (error) {
			const outcome = deliveryFailure(error);
			this.log(`结果未能回复到原消息（${outcome}）：${errorMessage(error)}`);
			return outcome;
		} finally {
			this.closeTask(taskId);
		}
	}

	private flushUnsent(): void {
		for (const [taskId, task] of [...this.tasks]) if (task.unsent) this.answer(taskId, task, task.unsent);
	}

	private track(taskId: string, task: Task): void {
		this.closeTask(taskId);
		this.tasks.set(taskId, task);
		const oldest = this.tasks.keys().next().value;
		if (this.tasks.size > MAX_TASKS && oldest !== undefined) this.closeTask(oldest);
	}

	private closeTask(taskId: string): void {
		const task = this.tasks.get(taskId);
		if (!task) return;
		clearTimeout(task.mergeTimer);
		this.tasks.delete(taskId);
	}

	private broadcast(frame: ServerFrame): void {
		for (const member of this.members.values()) member.peer.send(frame);
	}

	private receive(action: () => void | Promise<void>): void {
		const failed = (error: unknown) => this.log(`gateway inbound failed: ${errorMessage(error)}`);
		try {
			const running = action();
			running?.catch(failed);
		} catch (error) {
			failed(error);
		}
	}

	private broadcastStatus(): void {
		this.status = { ...this.status, sessions: this.onlineSize() };
		this.broadcast({ type: "status", status: this.status });
	}

	private eligible(userid: string): Member[] {
		return [...this.members.values()].filter(
			(member) => !member.config.allowedUserIds?.length || member.config.allowedUserIds.includes(userid),
		);
	}

	/** The sessions a user may send to; an allowlist that excludes them everywhere gets silence. */
	private permitted(userid: string): Member[] {
		return this.eligible(userid).filter((member) => !member.identifyOnly);
	}

	/** A session online now, by fingerprint, whoever may use it. */
	private online(fingerprint: string | undefined): Member | undefined {
		if (!fingerprint) return undefined;
		for (const member of this.members.values())
			if (!member.identifyOnly && sessionFingerprint(member.source.sessionId) === fingerprint) return member;
		return undefined;
	}

	private route(inbound: WeComInbound): void {
		const userid = senderOf(inbound.body);
		if (!userid) return;
		const message = parseInbound(inbound.body);
		this.expire();
		// Before the allowlist: only the person at that pi has seen the code, and being identified grants nothing.
		const watcher = message && this.watcherOf(message.text);
		if (message && watcher) {
			if (this.firstSeen(message.msgId || inbound.reqId))
				this.identify(watcher, inbound.reqId, { ...message.chat, userid: message.userid });
			return;
		}
		const permitted = this.eligible(userid);
		if (!permitted.length) {
			// WeCom outlives the last pi by a moment; a sender only an allowlist excludes gets silence.
			if (!this.members.size) this.reply(inbound.reqId, NO_ONLINE_SESSION);
			return;
		}
		const eligible = permitted.filter((member) => !member.identifyOnly);
		if (!this.firstSeen(message?.msgId || inbound.reqId)) return;
		if (!message) {
			this.reply(inbound.reqId, "无法识别这条消息，请重新发送");
			return;
		}
		const quoting = message.quoteText !== undefined || quotesMedia(inbound.body);
		const command = parseWeComCommand(message.text);
		if (command.kind !== "none") {
			this.command(command, inbound.reqId, message, eligible);
			return;
		}
		// A quoted bot message names its session; a quoted image, file or card names none.
		const named = message.quoteText ? quotedMember(eligible, message.quoteText) : undefined;
		if (named) {
			this.hand(named, inbound.reqId, message, QUOTED_GONE);
			return;
		}
		// Nothing on the message names a session: ask about this one message, never guess or remember.
		const reason = quoting ? QUOTE_FAILED : asRecord(inbound.body)?.quote !== undefined ? QUOTE_OPAQUE : undefined;
		this.ask(inbound.reqId, message, eligible, reason);
	}

	/** The card a message without a session gets: which pi takes it. Only this message waits for the answer. */
	private ask(reqId: string, message: InboundMessage, eligible: Member[], reason?: string): void {
		if (!eligible.length) {
			this.listSessions(reqId, eligible, reason);
			return;
		}
		const sender = senderKey(message);
		const previous = this.askBySender.get(sender);
		if (previous) this.dropAsk(previous, "这条消息没有发出：之后又发了一条，以那条为准");
		this.pollSessions(eligible, (online, busy) => {
			const client = this.client;
			if (!client) return;
			if (!online.length) {
				this.reply(reqId, sessionsText(online, busy));
				return;
			}
			const cardId = askCardId();
			const card = askCard(message, states(online, busy), reason);
			const timer = setTimeout(
				() => this.dropAsk(cardId, "这条消息没有发出：4 分钟内没有选择会话，请重新发送"),
				ASK_MS,
			);
			timer.unref?.();
			const choices = online.slice(0, ASK_CHOICES).map((member) => sessionFingerprint(member.source.sessionId));
			this.asks.set(cardId, { reqId, message, choices, expiresAt: Date.now() + ASK_MS, timer });
			this.askBySender.set(sender, cardId);
			this.rememberCard(cardId, card);
			void client
				.sendMsg(message.chat.chatId, message.chat.chatType, {
					msgtype: "template_card",
					template_card: renderCard(this.forViewer(card, message.chat), cardId),
				})
				.catch((error: unknown) => {
					const outcome = deliveryFailure(error);
					this.log(`待发消息确认卡发送失败（${outcome}）：${errorMessage(error)}`);
					// An unknown outcome may have shown the card: keep the message waiting for its click.
					if (outcome !== "unknown") this.dropAsk(cardId, [reason, ASK_FALLBACK].filter(Boolean).join("\n\n"));
				});
		});
	}

	/** A waiting message is closed with a reply that says why it was not sent; its card answers no more. */
	private dropAsk(cardId: string, reason: string): void {
		const asked = this.forgetAsk(cardId);
		if (asked) this.reply(asked.reqId, reason);
	}

	private forgetAsk(cardId: string): AskedMessage | undefined {
		const asked = this.asks.get(cardId);
		if (!asked) return undefined;
		clearTimeout(asked.timer);
		this.asks.delete(cardId);
		const sender = senderKey(asked.message);
		if (this.askBySender.get(sender) === cardId) this.askBySender.delete(sender);
		return asked;
	}

	/** One click decides one waiting message: only its sender may, and only while it waits. */
	private askClick(
		eventReqId: string,
		cardId: string,
		key: string,
		identity: ChatIdentity,
		selections?: Record<string, string>,
	): void {
		const action = askAction(cardId, key);
		if (!action) return;
		const asked = this.asks.get(cardId);
		if (!asked) {
			const card = this.cards.get(cardId);
			// A stale copy's late click redraws the decision; it never rewrites it.
			if (card && isSettled(card)) this.showCard(eventReqId, cardId, card, identity);
			else if (action.kind !== "done")
				this.settleAsk(eventReqId, cardId, identity, { kind: "closed" }, "已过期或已被新消息替换");
			return;
		}
		if (identity.userid !== asked.message.userid) {
			// Only the clicker's own copy says so; the sender's still waits for their choice.
			this.redraw(eventReqId, cardId, undefined, identity, "只有发送者能选择", { userids: [identity.userid] });
			return;
		}
		if (action.kind !== "send") {
			this.dropAsk(cardId, "这条消息已取消，没有发出");
			this.settleAsk(eventReqId, cardId, identity, { kind: "closed" }, "已取消");
			return;
		}
		// A dropdown left as drawn may come back without its choice: that is the first session, shown selected.
		const chosen = selections?.[ASK_QUESTION] ?? asked.choices[0];
		const eligible = this.permitted(identity.userid);
		const target = asked.choices.includes(chosen)
			? eligible.find((member) => sessionFingerprint(member.source.sessionId) === chosen)
			: undefined;
		if (!target) {
			this.redraw(eventReqId, cardId, undefined, identity, "选的会话已离线，请选另一个");
			return;
		}
		this.forgetAsk(cardId);
		// The message's own req_id: its result replies to the message itself.
		if (this.members.get(target.instanceId) !== target || !this.deliver(target, asked.reqId, asked.message)) {
			this.listSessions(asked.reqId, eligible, TARGET_GONE);
			this.settleAsk(eventReqId, cardId, identity, { kind: "closed" }, "会话刚刚离线");
			return;
		}
		this.settleAsk(
			eventReqId,
			cardId,
			identity,
			{ kind: "sent", source: target.source },
			"已发出，跑完后回复你这条消息",
		);
	}

	/** Every copy of a decided card says what happened; nothing on it sends again. */
	private settleAsk(
		eventReqId: string,
		cardId: string,
		identity: ChatIdentity,
		outcome: AskOutcome,
		note: string,
	): void {
		const card = this.cards.get(cardId);
		if (card) this.redraw(eventReqId, cardId, undefined, identity, note, { model: settledCard(card, outcome) });
		else this.redraw(eventReqId, cardId, undefined, identity, outcome.kind === "sent" ? note : `没有发出：${note}`);
	}

	private showCard(eventReqId: string, cardId: string, card: CardModel, viewer: ChatIdentity): void {
		void this.client
			?.updateCard(eventReqId, renderCard(this.forViewer(card, viewer), cardId))
			.catch((error: unknown) => this.log(`卡片更新失败：${errorMessage(error)}`));
	}

	/** A pi that cannot take it now (it left or its connection broke) is not replaced by another: the sender is asked. */
	private hand(target: Member, reqId: string, message: InboundMessage, gone: string): void {
		if (!this.deliver(target, reqId, message)) this.ask(reqId, message, this.permitted(message.userid), gone);
	}

	private command(
		command: Exclude<WeComCommand, { kind: "none" }>,
		reqId: string,
		message: InboundMessage,
		eligible: Member[],
	): void {
		switch (command.kind) {
			case "help":
				this.reply(reqId, helpText(command.topic));
				return;
			case "error":
				this.reply(reqId, command.message);
				return;
			case "sessions":
				this.showPicker({ kind: "message", reqId, chat: message.chat }, eligible);
				return;
			default:
				break;
		}
		const target = eligible.find((member) => member.source.sessionId === command.sessionId);
		if (!target) {
			this.listSessions(reqId, eligible, TARGET_MISSING);
			return;
		}
		if (command.kind === "session") {
			this.showSession(reqId, target, message.userid);
			return;
		}
		if (command.kind === "send") {
			this.hand(target, reqId, { ...message, text: command.prompt }, TARGET_GONE);
			return;
		}
		this.request(command.kind, target, reqId, message.chat, message.userid);
	}

	private showSession(reqId: string, target: Member, userid: string): void {
		this.pollSessions([target], (online, busy) => {
			const member = online[0];
			if (!member) {
				this.listSessions(reqId, this.permitted(userid), TARGET_MISSING);
				return;
			}
			this.reply(reqId, sessionText(member, busy.get(member.instanceId)));
		});
	}

	private listSessions(reqId: string, eligible: Member[], prefix?: string): void {
		this.pollSessions(eligible, (online, busy) => {
			const text = sessionsText(online, busy);
			this.reply(reqId, prefix ? `${prefix}\n\n${text}` : text);
		});
	}

	/** The session list, asking each pi whether it is busy; `page` may be the page a session is listed on. */
	private showPicker(
		reply: PickerReply,
		eligible: Member[],
		page: number | { fingerprint?: string } = 0,
		note?: string,
	): void {
		const deadline = reply.kind === "message" ? undefined : Date.now() + EVENT_REPLY_MS;
		this.pollSessions(eligible, (online, busy) => {
			const fallback = sessionsText(online, busy);
			const sessions = states(online, busy);
			const list = sessionPicker(sessions, typeof page === "number" ? page : pageOf(sessions, page.fingerprint));
			if (!list) {
				if (reply.kind === "message") this.reply(reply.reqId, fallback);
				else if (reply.kind === "update") this.redraw(reply.reqId, reply.cardId, undefined, reply.chat, NO_LISTED);
				return;
			}
			const card = note ? withNote(list.card, note) : list.card;
			const cardId = reply.kind === "update" ? reply.cardId : list.cardId;
			void this.sendPicker(reply, cardId, card, fallback, deadline).catch((error: unknown) =>
				this.log(`会话列表发送失败：${errorMessage(error)}`),
			);
		});
	}

	private async sendPicker(
		reply: PickerReply,
		cardId: string,
		model: CardModel,
		fallback: string,
		deadline?: number,
	): Promise<void> {
		const client = this.client;
		if (!client || (deadline !== undefined && Date.now() >= deadline)) return;
		// A page one group member turned is not what the others see, so it is not recorded.
		const shared = reply.kind !== "update" || !reply.userids?.length;
		if (shared) this.rememberCard(cardId, model);
		const body = { msgtype: "template_card", template_card: renderCard(this.forViewer(model, reply.chat), cardId) };
		try {
			if (reply.kind === "welcome") await client.respondWelcome(reply.reqId, body);
			else if (reply.kind === "update") await client.updateCard(reply.reqId, body.template_card, reply.userids);
			else await client.sendMsg(reply.chat.chatId, reply.chat.chatType, body);
		} catch (error) {
			const outcome = deliveryFailure(error);
			if (shared && outcome !== "unknown" && this.cards.get(cardId) === model) this.cards.delete(cardId);
			this.log(`会话列表发送失败（${outcome}）：${errorMessage(error)}`);
			if (outcome !== "rejected") return;
			if (reply.kind === "message") this.reply(reply.reqId, fallback);
			else if (reply.kind === "welcome") {
				if (deadline !== undefined && Date.now() < deadline)
					await client.respondWelcome(reply.reqId, { msgtype: "text", text: { content: fallback } });
			} else {
				await client.sendMsg(reply.chat.chatId, reply.chat.chatType, {
					msgtype: "markdown",
					markdown: { content: fallback },
				});
			}
		}
	}

	private pollSessions(members: Member[], finish: SessionsPoll["finish"]): void {
		const poll: SessionsPoll = { members, busy: new Map(), finish, pending: 0, done: false };
		const queries = members.map((member) => ({ id: randomUUID(), member }));
		// Registered before the first send: a pi may answer before the loop ends.
		for (const { id, member } of queries) this.stateQueries.set(id, { poll, instanceId: member.instanceId });
		poll.pending = queries.length;
		if (queries.length) poll.timer = setTimeout(() => this.finishPoll(poll), STATE_TIMEOUT_MS);
		for (const { id, member } of queries) {
			const request = { action: "state" as const, target: sessionTarget(member) };
			if (!member.peer.send({ type: "request", id, request })) this.answerState(id);
		}
		if (!poll.pending) this.finishPoll(poll);
	}

	private answerState(id: string, busy?: boolean): void {
		const query = this.stateQueries.get(id);
		if (!query) return;
		this.stateQueries.delete(id);
		const { poll } = query;
		if (busy !== undefined) poll.busy.set(query.instanceId, busy);
		poll.pending -= 1;
		if (!poll.pending) this.finishPoll(poll);
	}

	private finishPoll(poll: SessionsPoll): void {
		if (poll.done) return;
		poll.done = true;
		clearTimeout(poll.timer);
		for (const [id, query] of [...this.stateQueries]) if (query.poll === poll) this.stateQueries.delete(id);
		// A pi that left or registered again while it was asked is not listed.
		const online = poll.members.filter((member) => this.members.get(member.instanceId) === member);
		poll.finish(online, poll.busy);
	}

	private request(action: "cancel" | "card", target: Member, reqId: string, chat: ChatRef, userid: string): void {
		const id = randomUUID();
		const timer = setTimeout(() => {
			if (!this.requests.delete(id)) return;
			this.reply(
				reqId,
				`目标会话未在 ${REQUEST_TIMEOUT_MS / 1000} 秒内响应，可用 /wecom-aibot sessions 确认它仍在线`,
			);
		}, REQUEST_TIMEOUT_MS);
		this.requests.set(id, { reqId, instanceId: target.instanceId, action, timer });
		const request =
			action === "card"
				? { action: "click" as const, target: sessionTarget(target), click: { key: "control", userid, chat } }
				: { action, target: sessionTarget(target) };
		if (target.peer.send({ type: "request", id, request })) return;
		clearTimeout(timer);
		this.requests.delete(id);
		this.reply(reqId, TARGET_GONE);
	}

	response(instanceId: string, id: string, response: BridgeResponse): void {
		if (this.stateQueries.get(id)?.instanceId === instanceId) {
			this.answerState(id, response.ok ? response.busy : undefined);
			return;
		}
		const click = this.clicks.get(id);
		if (click?.instanceId === instanceId) {
			const member = this.members.get(instanceId);
			if (!member || !sameTarget(click.target, sessionTarget(member))) this.finishClick(id, "会话已离线或重新接入");
			else if (!response.ok) this.finishClick(id, `处理失败：${response.error ?? "未知原因"}`);
			else if (click.control && !response.card) this.finishClick(id, "会话没有返回控制卡状态");
			else this.finishClick(id, response.note, click.control ? response.card : undefined, response.userids);
			return;
		}
		const pending = this.requests.get(id);
		if (!pending || pending.instanceId !== instanceId) return;
		clearTimeout(pending.timer);
		this.requests.delete(id);
		if (!response.ok) {
			this.reply(
				pending.reqId,
				`${pending.action === "card" ? "控制卡请求失败" : "中止请求未送达"}：${response.error ?? "未知原因"}`,
			);
			return;
		}
		if (pending.action === "cancel") {
			this.reply(pending.reqId, "已请求中止；这一轮可能还会输出最后一点内容");
			return;
		}
		this.reply(pending.reqId, response.note ?? "控制卡请求未获确认");
	}

	/** A button on one of the bot's cards: a question card's, a session list's, a control card's, or a retired one. */
	private click(inbound: WeComInbound): void {
		const body = asRecord(inbound.body);
		const event = asRecord(asRecord(body?.event)?.template_card_event);
		const userid = senderOf(body);
		const cardId = typeof event?.task_id === "string" ? event.task_id : "";
		const key = typeof event?.event_key === "string" ? event.event_key : "";
		if (!userid || !cardId || !key) return;
		const msgId = typeof body?.msgid === "string" && body.msgid ? body.msgid : inbound.reqId;
		if (!this.firstSeen(msgId)) return;
		const chat = eventChat(body, userid);
		if (!chat) return;
		if (askAction(cardId, key)) {
			this.askClick(inbound.reqId, cardId, key, { ...chat, userid }, cardSelections(event));
			return;
		}
		const picked = pickerAction(key);
		if (picked && isControlCardId(cardId)) {
			this.pickClick(inbound.reqId, cardId, picked, { ...chat, userid }, cardSelections(event));
			return;
		}
		const fingerprint = publisherFingerprint(cardId);
		if (fingerprint) {
			// A key naming no session is from before version 10: it refreshes the copy in today's layout.
			const parsed = parseControlKey(key) ?? { action: CONTROL_KEYS.refresh, fingerprint };
			this.controlClick(inbound.reqId, cardId, parsed, { ...chat, userid }, cardSelections(event));
			return;
		}
		this.retire(inbound.reqId, userid);
	}

	/** A card this gateway no longer draws says so in place, with nothing left to press. */
	private retire(eventReqId: string, userid: string): void {
		if (!this.permitted(userid).length) return;
		void this.client
			?.updateCard(
				eventReqId,
				renderCard(
					this.forViewer(RETIRED_CARD, { chatId: userid, chatType: 1 }),
					`retired@${randomUUID().replace(/-/g, "").slice(0, 12)}`,
				),
			)
			.catch((error: unknown) => this.log(`旧卡片未能更新：${errorMessage(error)}`));
	}

	/**
	 * A control card's button acts on the session its copy shows. When the dropdown names another, that one
	 * redraws the copy for itself and nothing acts: a click acts only on what its clicker saw.
	 */
	private controlClick(
		eventReqId: string,
		cardId: string,
		parsed: { action: ControlAction; fingerprint: string },
		identity: ChatIdentity,
		selections: Record<string, string> | undefined,
	): void {
		const permitted = this.permitted(identity.userid);
		if (!permitted.length) return;
		const chosen = selections?.[SESSION_QUESTION];
		const switching = chosen !== undefined && chosen !== parsed.fingerprint;
		const target = this.online(switching ? chosen : parsed.fingerprint);
		const copy = fingerprintKey(cardId, parsed.fingerprint);
		if (!target) {
			// A card the gateway still has turns red and offers the others; else a short message.
			const note = switching
				? "选的会话已离线，请选另一个"
				: this.cards.has(copy)
					? "会话已离线，可在下拉框选其他会话"
					: "此控制卡所属会话已离线，可用 /wecom-aibot sessions 查找在线会话";
			this.redraw(eventReqId, cardId, undefined, identity, note, {
				key: copy,
				offline: !this.online(parsed.fingerprint),
			});
			return;
		}
		if (!permitted.includes(target)) return;
		const key = switching
			? controlKey(CONTROL_KEYS.show, target.source.sessionId)
			: `${parsed.action}@${parsed.fingerprint}`;
		this.forwardClick(eventReqId, cardId, target, identity, key, { selections, copy });
	}

	/**
	 * A session list's button: a page, or an action on the session the dropdown names (else the page's first
	 * row). The answer is that session's control card, so the clicker's copy becomes it; every action but
	 * 查看会话 is a first step that still asks to confirm there.
	 */
	private pickClick(
		eventReqId: string,
		cardId: string,
		picked: PickerAction,
		identity: ChatIdentity,
		selections: Record<string, string> | undefined,
	): void {
		const permitted = this.permitted(identity.userid);
		if (!permitted.length) return;
		const chat: ChatRef = { chatId: identity.chatId, chatType: identity.chatType };
		const reply: PickerReply = {
			kind: "update",
			reqId: eventReqId,
			chat,
			cardId,
			...(chat.chatType === 2 ? { userids: [identity.userid] } : {}),
		};
		if (picked.kind === "page") {
			this.showPicker(reply, permitted, picked.page);
			return;
		}
		const target = this.online(selections?.[PICKER_QUESTION] ?? picked.fingerprint ?? publisherFingerprint(cardId));
		if (!target) {
			this.showPicker(reply, permitted, { fingerprint: picked.fingerprint }, "选的会话已离线，请选另一个");
			return;
		}
		if (!permitted.includes(target)) return;
		const key = controlKey(picked.action, target.source.sessionId);
		this.forwardClick(eventReqId, cardId, target, identity, key, { copy: cardId });
	}

	/** `control`: the click is a control card's, answered with the card. A session the clicker may not use gets silence. */
	private forwardClick(
		eventReqId: string,
		cardId: string,
		target: Member,
		identity: ChatIdentity,
		key: string,
		control?: ControlForward,
	): void {
		const id = randomUUID();
		const timer = setTimeout(() => this.finishClick(id, "会话没有及时响应"), CLICK_ANSWER_MS);
		const chat: ChatRef = { chatId: identity.chatId, chatType: identity.chatType };
		const targetId = sessionTarget(target);
		this.clicks.set(id, {
			instanceId: target.instanceId,
			target: targetId,
			control: control !== undefined,
			eventReqId,
			cardId,
			sessionId: target.source.sessionId,
			chat,
			userid: identity.userid,
			...(control?.copy ? { copy: control.copy } : {}),
			timer,
		});
		const request = {
			action: "click" as const,
			target: targetId,
			click: {
				key,
				userid: identity.userid,
				chat,
				...(control ? { cardId } : {}),
				...(control?.selections ? { selections: control.selections } : {}),
			},
		};
		if (!target.peer.send({ type: "request", id, request })) this.finishClick(id, "会话已离线");
	}

	private finishClick(id: string, note: string | undefined, model?: CardModel, userids?: string[]): void {
		const click = this.clicks.get(id);
		if (!click) return;
		clearTimeout(click.timer);
		this.clicks.delete(id);
		if (model) this.learnIcon(model);
		if (note || model)
			this.redraw(
				click.eventReqId,
				click.cardId,
				click.sessionId,
				{ ...click.chat, userid: click.userid },
				note ?? "状态已刷新",
				{
					model,
					// A single chat has one copy; only a group's are per member.
					userids: click.chat.chatType === 2 ? userids : undefined,
					...(click.copy && !model ? { key: click.copy } : {}),
				},
			);
	}

	/**
	 * The card again with this note: `model`, else the one recorded at `key` (by default the control card of
	 * `sessionId`, or the task's). A card the gateway no longer knows gets the note as a short message; a copy
	 * shown to some members only is not recorded.
	 */
	private redraw(
		eventReqId: string,
		cardId: string,
		sessionId: string | undefined,
		chat: ChatRef | ChatIdentity,
		note: string,
		options: { model?: CardModel; userids?: string[]; offline?: boolean; key?: string } = {},
	): void {
		const client = this.client;
		if (!client) return;
		const sendNote = () =>
			client
				.sendMsg(chat.chatId, chat.chatType, {
					msgtype: "markdown",
					markdown: { content: sessionId ? sessionNote(sessionId, note) : note },
				})
				.catch((error: unknown) => this.log(`点击结果未发出：${errorMessage(error)}`));
		const key = options.key ?? (sessionId && isControlCardId(cardId) ? cardKey(cardId, sessionId) : cardId);
		let model = options.model ?? this.cards.get(key);
		if (!model) {
			void sendNote();
			return;
		}
		if (options.offline) model = { ...model, label: CONTROL_OFFLINE_LABEL, tone: "danger" };
		model = withNote(model, note);
		if (!options.userids?.length) this.rememberCard(key, model);
		const card = renderCard(this.forViewer(model, chat), cardId);
		void client.updateCard(eventReqId, card, options.userids).catch((error: unknown) => {
			this.log(`卡片更新失败：${errorMessage(error)}`);
			// A refused update cannot have shown the confirmation; an unknown outcome must not duplicate it.
			if (deliveryFailure(error) === "rejected") void sendNote();
		});
	}

	/** WeCom may deliver one message twice. */
	private firstSeen(id: string): boolean {
		if (this.seen.has(id)) return false;
		this.seen.add(id);
		const oldest = this.seen.values().next().value;
		if (this.seen.size > 1000 && oldest !== undefined) this.seen.delete(oldest);
		return true;
	}

	/** Full-width digits from a Chinese IME count too. */
	private watcherOf(text: string): Member | undefined {
		const typed = text.trim().replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10));
		if (!/^\d{6}$/.test(typed)) return undefined;
		for (const [instanceId, watch] of this.watches) if (watch.code === typed) return this.members.get(instanceId);
		return undefined;
	}

	private identify(member: Member, reqId: string, identity: ChatIdentity): void {
		const watch = this.watches.get(member.instanceId);
		this.watches.delete(member.instanceId);
		if (watch) member.peer.send({ type: "identity", id: watch.id, identity });
		this.reply(reqId, identityText(identity));
	}

	private deliver(target: Member, taskId: string, message: InboundMessage): boolean {
		target.active = ++this.activity;
		const targetId = sessionTarget(target);
		this.track(taskId, {
			target: targetId,
			directory: target.source.directoryName,
			streamId: `pi-${randomUUID()}`,
			chat: { ...message.chat },
			expiresAt: Date.now() + WECOM_REPLY_WINDOW_MS,
		});
		if (target.peer.send({ type: "task", target: targetId, task: { id: taskId, message } })) return true;
		this.closeTask(taskId);
		this.unregister(target.instanceId, target.peer);
		target.peer.close();
		return false;
	}

	private reply(reqId: string, content: string): void {
		this.client?.respondMsg(reqId, {
			msgtype: "stream",
			stream: { id: `gateway-${randomUUID()}`, finish: true, content },
		});
	}

	private event(inbound: WeComInbound): void {
		const eventType = asRecord(asRecord(inbound.body)?.event)?.eventtype;
		if (eventType === "template_card_event") {
			this.click(inbound);
			return;
		}
		if (eventType === "enter_chat") {
			const body = asRecord(inbound.body);
			const userid = senderOf(body);
			if (!userid || body?.chattype === "group") return;
			const eligible = this.permitted(userid);
			if (!eligible.length) return;
			const msgId = typeof body?.msgid === "string" && body.msgid ? body.msgid : inbound.reqId;
			if (this.firstSeen(msgId))
				this.showPicker({ kind: "welcome", reqId: inbound.reqId, chat: { chatId: userid, chatType: 1 } }, eligible);
			return;
		}
		if (eventType !== "disconnected_event") return;
		// Retain membership and each pi's queues. Only an explicit /wecom-aibot connect resumes.
		this.client?.stop("机器人连接已被其他机器或旧客户端接管；可在任一 pi 执行 /wecom-aibot connect 恢复");
	}

	private expire(): void {
		const now = Date.now();
		for (const [taskId, task] of [...this.tasks]) if (task.expiresAt < now) this.closeTask(taskId);
		for (const [key, watch] of this.watches) if (watch.expiresAt < now) this.watches.delete(key);
	}
}

/** When the question card cannot be shown: how a message names its session without one. */
const ASK_FALLBACK = [
	"这条消息没有发出，请指定会话：",
	"1. 引用机器人发来的结果，再输入消息；卡片引用不了",
	`2. 用命令：${sessionCommand("<id>", "send")}`,
].join("\n");
/** What a card from an earlier version turns into when pressed: task_id only matters on a send. */
const RETIRED_CARD: CardModel = {
	label: "旧版卡片",
	tone: "neutral",
	title: "这张卡已停用",
	subtitle: "请用最新的控制卡；发 /wecom-aibot sessions 可打开任一会话的控制卡",
	facts: [],
	actions: [{ key: "retired", text: "已停用", style: 4 }],
};
const TARGET_MISSING = "找不到这个 session ID；它可能已离线或写错";
const TARGET_GONE = "目标会话已离线";
const QUOTED_GONE = "引用的会话已离线";
const QUOTE_FAILED = "引用的消息或图片看不出是哪个在线会话";
/** WeCom hands the bot nothing of a quoted card, so a card can never name its session this way. */
const QUOTE_OPAQUE = "引用的是卡片：企业微信不给卡片内容，看不出是哪个会话";
/** A session list redrawn after its last session left. */
const NO_LISTED = "没有在线会话了；在 pi 中运行 /wecom-aibot connect 后再发 /wecom-aibot sessions";
const NO_ONLINE_SESSION = "当前没有在线的 pi 会话：最后一个会话已断开。请重新打开 pi 并运行 /wecom-aibot connect";

/** Where a control card is recorded: its ID and the session it shows. */
function cardKey(cardId: string, sessionId: string): string {
	return fingerprintKey(cardId, sessionFingerprint(sessionId));
}

function fingerprintKey(cardId: string, fingerprint: string): string {
	return `${cardId}#${fingerprint}`;
}

function states(members: readonly Member[], busy: ReadonlyMap<string, boolean>) {
	return members.map((member) => ({ source: member.source, busy: busy.get(member.instanceId) }));
}

function quotedMember(eligible: Member[], quoteText: string): Member | undefined {
	const ids = quotedSessions(quoteText);
	if (ids.length !== 1 || !ids[0]) return undefined;
	return eligible.find((member) => member.source.sessionId === ids[0]);
}

function sessionSummary(member: Member, busy: boolean | undefined): string {
	return `· ${display(member.source.directoryName)} · ${display(member.source.provider)} · ${display(member.source.modelName)} · ${stateLabel(busy)}`;
}

function sessionText(member: Member, busy: boolean | undefined): string {
	return [
		sessionSummary(member, busy),
		"",
		sessionCommand(member.source.sessionId, "send"),
		sessionCommand(member.source.sessionId, "card"),
		sessionCommand(member.source.sessionId, "cancel"),
	].join("\n");
}

function sessionsText(eligible: Member[], busy: ReadonlyMap<string, boolean>): string {
	if (!eligible.length) return "当前没有可用的在线会话。请先在 pi 中运行 /wecom-aibot connect";
	const lines = [`当前有 ${eligible.length} 个在线会话：`];
	for (const member of eligible) {
		const entry = `${sessionSummary(member, busy.get(member.instanceId))}\n  session: ${member.source.sessionId}`;
		if (Buffer.byteLength(lines.join("\n\n") + entry, "utf8") > 18_000) {
			lines.push("（其余会话未显示，可先断开一些 pi）");
			break;
		}
		lines.push(entry);
	}
	lines.push(`把任务发给其中一个：\n${sessionCommand("<上面的 session ID>", "send", "你的任务")}`);
	return lines.join("\n\n");
}

/** Where a card event happened: the group it is in, or the single chat with its clicker. */
function eventChat(body: Record<string, unknown> | undefined, userid: string): ChatRef | undefined {
	if (body?.chattype !== "group") return { chatId: userid, chatType: 1 };
	const chatId = typeof body.chatid === "string" ? body.chatid.trim() : "";
	return chatId ? { chatId, chatType: 2 } : undefined;
}

function identityText(identity: ChatIdentity): string {
	const code = (value: string) => `\`${value.replace(/[`\s]/g, "")}\``;
	return [
		`whoami 已识别当前${identity.chatType === 2 ? "群聊" : "单聊"}；这条消息只用于识别，不会交给 pi 处理`,
		`chatid：${code(identity.chatId)}　chat_type：${identity.chatType}　userid：${code(identity.userid)}`,
		"识别结果已交给发起 whoami 的 pi",
	].join("\n\n");
}

function display(value: string): string {
	return [...value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")]
		.slice(0, 60)
		.join("")
		.replace(/[\\`*_#[\]<>]/g, "\\$&");
}

/** One waiting message per sender in each chat. */
function senderKey(message: InboundMessage): string {
	return JSON.stringify([message.chat.chatType, message.chat.chatId, message.userid]);
}
