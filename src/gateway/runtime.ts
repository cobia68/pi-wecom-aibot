/** One WeCom connection, with routing and membership independent of any pi process. */
import { randomInt, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { deliveryFailure } from "../shared/delivery.ts";
import {
	type BridgeResponse,
	type ChatIdentity,
	type GatewayCredentials,
	type GatewayRegistration,
	type GatewayStatus,
	type ServerFrame,
	type SessionTarget,
	sameTarget,
	sessionTarget,
	type TaskState,
} from "../shared/gateway-protocol.ts";
import {
	formatProcessingStatus,
	type ProcessingState,
	quotedSessions,
	renderNotification,
} from "../shared/notification.ts";
import type { GatewayImage, GatewayNotification, NotificationSource } from "../shared/notification-types.ts";
import { sentences } from "../shared/text.ts";
import {
	type ChatRef,
	type InboundMessage,
	parseInbound,
	quotedImage,
	record,
	senderOf,
	WECOM_IMAGE_MAX_BYTES,
	WECOM_IMAGE_MIN_BYTES,
	WECOM_REPLY_WINDOW_MS,
	WECOM_STREAM_LIFETIME_MS,
} from "../shared/wecom-protocol.ts";
import { inspectPng, stampPng } from "./png-marker.ts";
import { readQuotedImage } from "./quoted-image.ts";
import { WeComClient, type WeComClientOptions, type WeComInbound } from "./wecom-client.ts";

const MAX_SESSIONS = 100;
const MAX_TASKS = 10_000;
const MAX_WATCH_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** End a status message before WeCom ends it on its own; the result follows as a notification. */
const STREAM_DEADLINE_MS = WECOM_STREAM_LIFETIME_MS - 10_000;
const STATE_TIMEOUT_MS = 2_000;
/** Settle and its result notification travel one IPC channel; this is the most the status waits for it. */
const MERGE_GRACE_MS = 1_000;

export interface GatewayPeer {
	send(frame: ServerFrame): boolean;
	close(): void;
}

export interface WeComGatewayOptions extends GatewayCredentials, Pick<WeComClientOptions, "createWebSocket"> {}

interface Member extends GatewayRegistration {
	peer: GatewayPeer;
}

interface PendingRequest {
	reqId: string;
	chat: ChatRef;
	instanceId: string;
	action: "screen" | "cancel";
	timer: ReturnType<typeof setTimeout>;
}

interface SessionsPoll {
	reqId: string;
	prefix?: string;
	members: Member[];
	busy: Map<string, boolean>;
	pending: number;
	done: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

/** A message routed to a pi, by callback req_id. The gateway owns its status message. */
interface Task {
	target: SessionTarget;
	streamId: string;
	chat: ChatRef;
	expiresAt: number;
	deadline?: ReturnType<typeof setTimeout>;
	/** The "running" status was actually written, so its content can still be replaced. */
	opened?: boolean;
	awaitingResult?: boolean;
	completionState?: "settled" | "notifying";
	mergeTimer?: ReturnType<typeof setTimeout>;
	unsent?: ProcessingState;
}

export class WeComGateway {
	private readonly members = new Map<string, Member>();
	private readonly seen = new Set<string>();
	private readonly tasks = new Map<string, Task>();
	private readonly requests = new Map<string, PendingRequest>();
	private readonly stateQueries = new Map<string, { poll: SessionsPoll; instanceId: string }>();
	/** /wecom-aibot config whoami in progress, by pi instance: the one-time code its chat must send. */
	private readonly watches = new Map<string, { id: string; code: string; expiresAt: number }>();
	private client: WeComClient | undefined;
	private status: GatewayStatus = { state: "disconnected", sessions: 0 };
	private readonly options: WeComGatewayOptions;
	private readonly membershipChanged: () => void;

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
		this.members.set(registration.instanceId, { ...registration, source: { ...registration.source }, peer });
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
		this.broadcastStatus();
		this.membershipChanged();
	}

	updateSource(instanceId: string, source: NotificationSource): void {
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
		for (const task of this.tasks.values()) {
			clearTimeout(task.deadline);
			clearTimeout(task.mergeTimer);
		}
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
			task.deadline ??= setTimeout(() => this.expireStream(taskId), STREAM_DEADLINE_MS);
			return this.stream(taskId, task, state);
		}
		if (state === "settled" || state === "notifying") {
			task.completionState = state;
			// The result follows on the same IPC channel and replaces this message, so do not close it yet.
			// A scheduled notification may own the delivery instead; then this deadline closes the status.
			if (!task.awaitingResult) {
				task.awaitingResult = true;
				task.mergeTimer = setTimeout(() => this.finishAwaiting(taskId), MERGE_GRACE_MS);
			}
			return true;
		}
		return this.stream(taskId, task, state);
	}

	async notify(instanceId: string, chat: ChatRef, notification: GatewayNotification): Promise<void> {
		const member = this.members.get(instanceId);
		if (!member || !this.client) throw new Error("pi 尚未注册");
		if (member.identifyOnly) throw new Error("临时识别连接不能发送通知；请完成配置后运行 /wecom-aibot connect");
		if (notification.source.sessionId !== member.source.sessionId)
			throw new Error("通知的 session 与发送 pi 不匹配，已拒绝发送");
		const content = renderNotification(notification.source, notification.text, {
			kind: notification.kind,
			excerpt: notification.excerpt,
			aborted: notification.aborted,
			imageFailure: notification.imageFailure,
		});
		// A task's own text result replaces its status message; an image stays a separate message.
		const awaiting = notification.taskId ? this.awaitingTask(member, chat, notification.taskId) : undefined;
		if (
			awaiting &&
			notification.kind === "reply" &&
			!notification.image &&
			awaiting.task.completionState !== "notifying"
		) {
			const outcome = await this.finishWithResult(this.client, awaiting.taskId, awaiting.task, content);
			if (outcome === "delivered" || outcome === "unknown") return;
		}
		if (awaiting)
			this.stream(
				awaiting.taskId,
				awaiting.task,
				notification.image || awaiting.task.completionState === "notifying" ? "notifying" : "settled",
			);
		if (notification.image) {
			const image = readImage(notification.image.path);
			let failure = image.reason;
			let mediaId: string | undefined;
			if (image.data) {
				try {
					mediaId = await this.client.uploadImage(
						this.marked(image.data, member.source.sessionId),
						notification.image.filename,
					);
				} catch (error) {
					failure = `上传失败：${errorMessage(error)}`;
				}
			}
			if (mediaId) {
				try {
					await this.client.sendMsg(chat.chatId, chat.chatType, {
						msgtype: "image",
						image: { media_id: mediaId },
					});
					return;
				} catch (error) {
					// A rejection definitely did not deliver the image; an unknown ACK must not be duplicated.
					if (deliveryFailure(error) !== "rejected") throw error;
					failure = `发送被拒绝：${errorMessage(error)}`;
				}
			}
			// The README promises the reason in the fallback.
			const reason = failure?.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 200);
			this.log(`图片通知改发文字：${reason ?? "未知原因"}`);
			const fallback = renderNotification(notification.source, notification.text, {
				...notification,
				imageFailure: reason ?? "未知原因",
			});
			await this.client.sendMsg(chat.chatId, chat.chatType, {
				msgtype: "markdown",
				markdown: { content: fallback },
			});
			return;
		}
		await this.client.sendMsg(chat.chatId, chat.chatType, { msgtype: "markdown", markdown: { content } });
	}

	private stream(taskId: string, task: Task, state: ProcessingState): boolean {
		const final = state !== "running";
		const sent =
			this.client?.respondMsg(taskId, {
				msgtype: "stream",
				stream: {
					id: task.streamId,
					finish: final,
					content: formatProcessingStatus(task.target.sessionId, state),
				},
			}) ?? false;
		if (state === "running" && sent) task.opened = true;
		if (final) {
			if (sent) this.closeTask(taskId);
			else task.unsent = state;
		}
		return sent;
	}

	/** Only finish this result's task; an earlier scheduled notification cannot consume a newer status. */
	private awaitingTask(member: Member, chat: ChatRef, taskId: string): { taskId: string; task: Task } | undefined {
		const task = this.tasks.get(taskId);
		if (!task?.awaitingResult || !task.opened) return undefined;
		if (!sameTarget(task.target, sessionTarget(member))) return undefined;
		if (task.chat.chatId !== chat.chatId || task.chat.chatType !== chat.chatType) return undefined;
		return { taskId, task };
	}

	private async finishWithResult(
		client: WeComClient,
		taskId: string,
		task: Task,
		content: string,
	): Promise<"delivered" | "not_sent" | "rejected" | "unknown"> {
		clearTimeout(task.mergeTimer);
		task.mergeTimer = undefined;
		task.awaitingResult = false;
		try {
			await client.respondMsgAck(taskId, {
				msgtype: "stream",
				stream: { id: task.streamId, finish: true, content },
			});
			this.closeTask(taskId);
			return "delivered";
		} catch (error) {
			const outcome = deliveryFailure(error);
			this.log(`结果并入状态消息失败（${outcome}）：${errorMessage(error)}`);
			// An unknown outcome may have delivered the result: send nothing more. Otherwise notify() closes the status.
			if (outcome === "unknown") this.closeTask(taskId);
			return outcome;
		}
	}

	private finishAwaiting(taskId: string): void {
		const task = this.tasks.get(taskId);
		if (!task) return;
		task.mergeTimer = undefined;
		if (!task.awaitingResult) return;
		task.awaitingResult = false;
		if (!task.opened) {
			this.closeTask(taskId);
			return;
		}
		this.stream(taskId, task, task.completionState ?? "settled");
	}

	private expireStream(taskId: string): void {
		const task = this.tasks.get(taskId);
		if (!task) return;
		task.deadline = undefined;
		const state = task.unsent ?? "waiting";
		this.client?.respondMsg(taskId, {
			msgtype: "stream",
			stream: {
				id: task.streamId,
				finish: true,
				content: formatProcessingStatus(task.target.sessionId, state),
			},
		});
		this.closeTask(taskId);
	}

	private flushUnsent(): void {
		for (const [taskId, task] of [...this.tasks]) if (task.unsent) this.stream(taskId, task, task.unsent);
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
		clearTimeout(task.deadline);
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

	private async route(inbound: WeComInbound): Promise<void> {
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
		const quoted = quotedImage(inbound.body);
		const quoting = message.quoteText !== undefined || quoted !== undefined;
		const command = parseWeComCommand(message.text);
		if (command.kind !== "none") {
			this.command(command, inbound.reqId, message, eligible);
			return;
		}
		// A quote targets a session without naming it; only an image quote waits for the download below.
		const named = message.quoteText ? quotedMember(eligible, message.quoteText) : undefined;
		if (named) {
			this.hand(named, inbound.reqId, message, eligible);
			return;
		}
		if (quoted) {
			const reading = await readQuotedImage(quoted);
			this.log(reading.report);
			const marked = reading.sessionId
				? eligible.find((member) => member.source.sessionId === reading.sessionId)
				: undefined;
			if (marked) {
				this.hand(marked, inbound.reqId, message, eligible);
				return;
			}
		}
		if (quoting) this.listSessions(inbound.reqId, eligible, QUOTE_FAILED);
		else this.reply(inbound.reqId, GUIDANCE);
	}

	private hand(target: Member, reqId: string, message: InboundMessage, eligible: Member[]): void {
		if (!this.deliver(target, reqId, message)) this.listSessions(reqId, eligible, TARGET_GONE);
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
				this.listSessions(reqId, eligible);
				return;
			default:
				break;
		}
		const target = eligible.find((member) => member.source.sessionId === command.sessionId);
		if (!target) {
			this.listSessions(reqId, eligible, TARGET_MISSING);
			return;
		}
		if (command.kind === "send") {
			this.hand(target, reqId, { ...message, text: command.prompt }, eligible);
			return;
		}
		this.request(command.kind, target, reqId, message.chat);
	}

	private listSessions(reqId: string, eligible: Member[], prefix?: string): void {
		const poll: SessionsPoll = { reqId, prefix, members: eligible, busy: new Map(), pending: 0, done: false };
		const queries = eligible.map((member) => ({ id: randomUUID(), member }));
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
		const text = sessionsText(online, poll.busy);
		this.reply(poll.reqId, poll.prefix ? `${poll.prefix}\n\n${text}` : text);
	}

	private request(action: "screen" | "cancel", target: Member, reqId: string, chat: ChatRef): void {
		const id = randomUUID();
		const timer = setTimeout(() => {
			if (!this.requests.delete(id)) return;
			this.reply(
				reqId,
				`目标会话未在 ${REQUEST_TIMEOUT_MS / 1000} 秒内响应，可用 /wecom-aibot sessions 确认它仍在线`,
			);
		}, REQUEST_TIMEOUT_MS);
		this.requests.set(id, { reqId, chat, instanceId: target.instanceId, action, timer });
		if (target.peer.send({ type: "request", id, request: { action, target: sessionTarget(target) } })) return;
		clearTimeout(timer);
		this.requests.delete(id);
		this.reply(reqId, TARGET_GONE);
	}

	response(instanceId: string, id: string, response: BridgeResponse): void {
		if (this.stateQueries.get(id)?.instanceId === instanceId) {
			this.answerState(id, response.ok ? response.busy : undefined);
			return;
		}
		const pending = this.requests.get(id);
		if (!pending || pending.instanceId !== instanceId) return;
		clearTimeout(pending.timer);
		this.requests.delete(id);
		if (!response.ok) {
			this.reply(
				pending.reqId,
				`${pending.action === "screen" ? "截图失败" : "中止请求未送达"}：${response.error ?? "未知原因"}`,
			);
			return;
		}
		if (pending.action === "cancel") {
			this.reply(pending.reqId, "已请求中止；这一轮可能还会输出最后一点内容");
			return;
		}
		if (!response.image) {
			this.reply(pending.reqId, "截图失败：目标会话没有返回图片");
			return;
		}
		void this.sendImage(pending.chat, response.image, this.members.get(instanceId)?.source.sessionId)
			.then((sent) => {
				if (!sent) this.reply(pending.reqId, "截图已生成，但图片发送失败；详情见 /wecom-aibot log");
			})
			.catch((error: unknown) => this.log(`截图发送失败：${errorMessage(error)}`));
	}

	private async sendImage(chat: ChatRef, image: GatewayImage, sessionId?: string): Promise<boolean> {
		const client = this.client;
		const read = readImage(image.path);
		if (!client || !read.data) {
			this.log(`截图读取失败：${read.reason ?? "未知原因"}`);
			return false;
		}
		try {
			const data = sessionId ? this.marked(read.data, sessionId) : read.data;
			const mediaId = await client.uploadImage(data, image.filename);
			await client.sendMsg(chat.chatId, chat.chatType, { msgtype: "image", image: { media_id: mediaId } });
			return true;
		} catch (error) {
			this.log(`截图发送失败：${errorMessage(error)}`);
			return false;
		}
	}

	/** Logged so a later quote's reading can be compared with what was sent; an unmarkable file is sent as is. */
	private marked(data: Buffer, sessionId: string): Buffer {
		try {
			const stamped = stampPng(data, sessionId);
			const png = inspectPng(stamped);
			const shape = png ? `PNG ${png.width}×${png.height}；块 ${png.chunks.join(",")}` : "PNG";
			this.log(`图片已打标记：${shape}；${stamped.length} 字节；session ${sessionId}`);
			return stamped;
		} catch (error) {
			this.log(`图片未打标记（${errorMessage(error)}），按原图发送`);
			return data;
		}
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
		const targetId = sessionTarget(target);
		this.track(taskId, {
			target: targetId,
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
		if (record(record(inbound.body)?.event)?.eventtype !== "disconnected_event") return;
		// Retain membership and each pi's queues. Only an explicit /wecom-aibot connect resumes.
		this.client?.stop("机器人连接已被其他机器或旧客户端接管；可在任一 pi 执行 /wecom-aibot connect 恢复");
	}

	private expire(): void {
		const now = Date.now();
		for (const [taskId, task] of [...this.tasks]) if (task.expiresAt < now) this.closeTask(taskId);
		for (const [key, watch] of this.watches) if (watch.expiresAt < now) this.watches.delete(key);
	}
}

const COMMAND_PREFIX = "/wecom-aibot";
const SUBCOMMANDS = ["sessions", "send", "screen", "cancel"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export type WeComCommand =
	| { kind: "none" }
	| { kind: "error"; message: string }
	| { kind: "help"; topic?: Subcommand }
	| { kind: "sessions" }
	| { kind: "send"; sessionId: string; prompt: string }
	| { kind: "screen"; sessionId: string }
	| { kind: "cancel"; sessionId: string };

const OPTIONS: Record<Subcommand, string[]> = {
	sessions: [],
	send: ["--sessionid", "--prompt"],
	screen: ["--sessionid"],
	cancel: ["--sessionid"],
};

/** WeCom-side command grammar. Every task names its target; nothing is remembered between messages. */
export function parseWeComCommand(text: string): WeComCommand {
	const trimmed = text.trim();
	if (!new RegExp(`^${COMMAND_PREFIX}(?:\\s|$)`, "i").test(trimmed)) return { kind: "none" };
	const rest = trimmed.slice(COMMAND_PREFIX.length).trim();
	if (!rest) return { kind: "help" };
	const head = rest.split(/\s+/)[0];
	const name = head.toLowerCase();
	if (name === "--help") return { kind: "help" };
	if (name.startsWith("-"))
		return { kind: "error", message: `未知选项 ${head}。可用子命令：${SUBCOMMANDS.join("、")}` };
	const sub = SUBCOMMANDS.find((item) => item === name);
	if (!sub) return { kind: "error", message: `未知子命令 ${head}。可用子命令：${SUBCOMMANDS.join("、")}` };
	const after = rest.slice(head.length).replace(/^\s+/, "");
	// --prompt is terminal: everything after it is the prompt, exactly as typed.
	const found = /(^|\s)--prompt(?=\s|$)/.exec(after);
	let optionText = after;
	let prompt: string | undefined;
	if (found) {
		const cut = found.index + found[1].length;
		optionText = after.slice(0, cut);
		prompt = after.slice(cut + "--prompt".length).replace(/^\s+/, "");
		// Only a real `--sessionid <id>` misplaced after --prompt is an error; prose may mention the option.
		if (/(^|\s)--sessionid\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\s|$)/i.test(prompt)) {
			return {
				kind: "error",
				message: "--sessionid 必须写在 --prompt 之前。例如：/wecom-aibot send --sessionid <id> --prompt 检查构建",
			};
		}
	}
	const parsed = parseOptions(sub, optionText);
	if (typeof parsed === "string") return { kind: "error", message: parsed };
	if (parsed.help) return { kind: "help", topic: sub };
	const sessionId = parsed.values.get("--sessionid");
	if (sub === "sessions") {
		if (sessionId) return { kind: "error", message: "sessions 不接受 --sessionid" };
		return { kind: "sessions" };
	}
	if (!sessionId) {
		const example = sub === "send" ? " --prompt 你的任务" : "";
		return {
			kind: "error",
			message: `缺少 --sessionid。先发送 /wecom-aibot sessions 获取完整 session ID，例如：/wecom-aibot ${sub} --sessionid <id>${example}`,
		};
	}
	if (sub === "send") {
		if (prompt === undefined)
			return { kind: "error", message: "缺少 --prompt。例如：/wecom-aibot send --sessionid <id> --prompt 检查构建" };
		if (!prompt.trim()) return { kind: "error", message: "--prompt 之后要有正文" };
		return { kind: "send", sessionId, prompt };
	}
	if (prompt !== undefined) return { kind: "error", message: `${sub} 不接受 --prompt` };
	return sub === "screen" ? { kind: "screen", sessionId } : { kind: "cancel", sessionId };
}

function parseOptions(sub: Subcommand, text: string): { values: Map<string, string>; help: boolean } | string {
	const values = new Map<string, string>();
	const tokens = text.trim() ? text.trim().split(/\s+/) : [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--help") return { values, help: true };
		if (!token.startsWith("--")) return `${sub} 不接受位置参数（${token}）；正文请写在 --prompt 之后`;
		const allowed = OPTIONS[sub];
		if (!allowed.includes(token)) {
			const hint = allowed.length ? `可用选项：${allowed.join("、")}` : "该子命令不接受选项";
			return sentences(`未知选项 ${token}`, hint, "参数用空格分隔，不支持 =");
		}
		const value = tokens[i + 1];
		if (value === undefined || value.startsWith("--")) return `${token} 缺少值`;
		if (values.has(token)) return `${token} 重复给出`;
		i++;
		values.set(token, value);
	}
	return { values, help: false };
}

const GUIDANCE = [
	"请先指定目标会话：",
	"1. 发送 /wecom-aibot sessions 查看在线会话与完整 session ID",
	"2. 再发送 /wecom-aibot send --sessionid <id> --prompt <正文>",
	"",
	"也可以直接引用机器人的一条通知或一张图片（如截图），把这条消息定向到该会话",
].join("\n");
const TARGET_MISSING = "找不到这个 session ID；它可能已离线或写错";
const TARGET_GONE = "目标会话已离线";
const QUOTE_FAILED = "引用的通知或图片无法定位到一个在线会话";
const NO_ONLINE_SESSION = "当前没有在线的 pi 会话：最后一个会话已断开。请重新打开 pi 并运行 /wecom-aibot connect";

function quotedMember(eligible: Member[], quoteText: string): Member | undefined {
	const ids = quotedSessions(quoteText);
	if (ids.length !== 1 || !ids[0]) return undefined;
	return eligible.find((member) => member.source.sessionId === ids[0]);
}

function sessionsText(eligible: Member[], busy: ReadonlyMap<string, boolean>): string {
	if (!eligible.length) return "当前没有可用的在线会话。请先在 pi 中运行 /wecom-aibot connect";
	const lines = [`当前有 ${eligible.length} 个在线会话：`];
	for (const member of eligible) {
		const entry = `· ${display(member.source.directoryName)} · ${display(member.source.provider)} · ${display(member.source.modelName)} · ${stateLabel(busy.get(member.instanceId))}\n  session: ${member.source.sessionId}`;
		if (Buffer.byteLength(lines.join("\n\n") + entry, "utf8") > 18_000) {
			lines.push("（其余会话未显示，可先断开一些 pi）");
			break;
		}
		lines.push(entry);
	}
	lines.push("把任务发给其中一个：\n/wecom-aibot send --sessionid <上面的 session ID> --prompt 你的任务");
	return lines.join("\n\n");
}

function stateLabel(busy: boolean | undefined): string {
	if (busy === undefined) return "状态未知";
	return busy ? "执行中" : "空闲";
}

function helpText(topic?: Subcommand): string {
	switch (topic) {
		case "send":
			return [
				"send — 把一段正文作为任务交给指定会话",
				"",
				"用法：/wecom-aibot send --sessionid <完整 session ID> --prompt <正文>",
				"",
				"--prompt 必须放在最后，其后全部内容都是正文（可换行）",
				"参数用空格分隔，不支持 =",
			].join("\n");
		case "screen":
			return [
				"screen — 截取指定会话当前的终端画面",
				"",
				"用法：/wecom-aibot screen --sessionid <完整 session ID>",
				"",
				"只读请求，不会打断正在运行的任务；没有终端界面的会话无法截图",
			].join("\n");
		case "cancel":
			return [
				"cancel — 请求中止指定会话正在运行的一轮",
				"",
				"用法：/wecom-aibot cancel --sessionid <完整 session ID>",
				"",
				"中止是异步生效的，这一轮可能还会输出最后一点内容",
			].join("\n");
		case "sessions":
			return [
				"sessions — 列出在线会话",
				"",
				"用法：/wecom-aibot sessions",
				"",
				"每个会话显示目录、供应商 · 模型、忙闲和完整 session ID；发任务时用它作为 --sessionid",
			].join("\n");
		default:
			return [
				"企业微信侧命令（pi 里的 /wecom-aibot 是另一套设备命令）：",
				"",
				"sessions                      列出在线会话与完整 session ID",
				"send     --sessionid <id> --prompt <正文>",
				"screen   --sessionid <id>     截取该会话当前终端画面",
				"cancel   --sessionid <id>     请求中止该会话正在运行的一轮",
				"",
				"参数用空格分隔，不支持 =。--prompt 必须放在最后，其后全部是正文",
				"查看单个命令：/wecom-aibot <子命令> --help",
			].join("\n");
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readImage(path: string): { data?: Buffer; reason?: string } {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return { reason: "不是普通文件" };
		if (stat.size < WECOM_IMAGE_MIN_BYTES || stat.size > WECOM_IMAGE_MAX_BYTES)
			return { reason: `文件大小 ${stat.size} 字节超出限制` };
		return { data: readFileSync(path) };
	} catch (error) {
		return { reason: errorMessage(error) };
	}
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
