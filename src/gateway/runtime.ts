/** One WeCom connection, with routing and membership independent of any pi process. */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { formatProcessingStatus, MAX_NOTIFICATION_BYTES, quotedSessions, renderNotification, type ProcessingState } from "../shared/notification.ts";
import type { GatewayNotification, NotificationSource } from "../shared/notification-types.ts";
import { WeComClient, type WeComClientOptions, type WeComInbound } from "./wecom-client.ts";
import { deliveryFailure } from "../shared/delivery.ts";
import { parseInbound, senderOf, WECOM_IMAGE_MAX_BYTES, WECOM_IMAGE_MIN_BYTES, WECOM_REPLY_WINDOW_MS, WECOM_STREAM_LIFETIME_MS, type ChatRef, type InboundMessage } from "../shared/wecom-protocol.ts";
import {
	sameTarget, sessionTarget, validWelcome,
	type ChatIdentity, type GatewayCredentials, type GatewayRegistration, type GatewayStatus,
	type ServerFrame, type SessionTarget, type TaskState,
} from "../shared/gateway-protocol.ts";
import type { SelectionStore } from "./selection-store.ts";

const MAX_SESSIONS = 100;
const MAX_CONVERSATIONS = 1000;
const MAX_TASKS = 10_000;
const CHOICE_LIFETIME_MS = 5 * 60_000;
const MAX_WATCH_MS = 10 * 60_000;
/** End a status message before WeCom ends it on its own; the result follows as a notification. */
const STREAM_DEADLINE_MS = WECOM_STREAM_LIFETIME_MS - 10_000;

export interface GatewayPeer {
	send(frame: ServerFrame): boolean;
	close(): void;
}

export interface WeComGatewayOptions extends GatewayCredentials, Pick<WeComClientOptions, "createWebSocket"> {}

interface Member extends GatewayRegistration {
	peer: GatewayPeer;
}

interface Choice {
	targets: SessionTarget[];
	pending?: InboundMessage;
	expiresAt: number;
}

/**
 * Where a message goes. deliver hands `message` to target: bind commits the conversation's binding first,
 * answersChoice ends the choice it answered; if the target is gone, the choice is offered with `fallback`.
 */
type Route =
	| { kind: "identify"; watchers: Member[] }
	| { kind: "offer"; reason?: string; pending?: InboundMessage }
	| { kind: "deliver"; target: Member; message: InboundMessage; bind: boolean; answersChoice: boolean; fallback?: string }
	| { kind: "selected"; target: Member };

/** A message routed to a pi, by callback req_id. The gateway owns its status message. */
interface Task {
	target: SessionTarget;
	streamId: string;
	/** WeCom accepts replies to a callback for 24 hours. */
	expiresAt: number;
	/** Set when the status message opened: WeCom ends it 10 minutes later. */
	deadline?: ReturnType<typeof setTimeout>;
	/** A final state that could not be sent while WeCom was disconnected. */
	unsent?: ProcessingState;
}

export class WeComGateway {
	private readonly members = new Map<string, Member>();
	private readonly selections = new Map<string, SessionTarget>();
	private readonly choices = new Map<string, Choice>();
	private readonly seen = new Set<string>();
	private readonly tasks = new Map<string, Task>();
	/** /wecom-aibot whoami in progress, by pi instance. */
	private readonly watches = new Map<string, { id: string; expiresAt: number }>();
	private client: WeComClient | undefined;
	private status: GatewayStatus = { state: "disconnected", sessions: 0 };
	private readonly options: WeComGatewayOptions;
	private readonly membershipChanged: () => void;
	private readonly selectionStore: SelectionStore | undefined;
	private readonly requireChoice: boolean;

	constructor(options: WeComGatewayOptions, membershipChanged: () => void = () => {}, selectionStore?: SelectionStore) {
		this.options = options;
		this.membershipChanged = membershipChanged;
		this.selectionStore = selectionStore;
		const saved = selectionStore?.load();
		for (const [key, target] of saved?.entries ?? []) this.selections.set(key, target);
		this.requireChoice = saved?.requireChoice ?? false;
	}

	get size(): number { return this.members.size; }
	owns(instanceId: string, peer: GatewayPeer): boolean { return this.members.get(instanceId)?.peer === peer; }
	/** Gateway-side diagnostics for pi's log; used when an IPC frame cannot be handled at all. */
	log(message: string): void { this.broadcast({ type: "log", message }); }

	register(registration: GatewayRegistration, peer: GatewayPeer, resume = false): void {
		if (registration.config.botId !== this.options.botId) throw new Error("共享网关的 BotID 与本 pi 不一致，请核对配置。");
		const collision = [...this.members.values()].find((member) => member.source.sessionId === registration.source.sessionId && member.instanceId !== registration.instanceId);
		if (collision) throw new Error("该完整 session ID 已由另一个 pi 注册，请在当前窗口新建或切换会话。");
		if (!this.members.has(registration.instanceId) && this.size >= MAX_SESSIONS) throw new Error("共享网关的在线会话已达上限。");
		const previous = this.members.get(registration.instanceId);
		this.members.set(registration.instanceId, { ...registration, source: { ...registration.source }, peer });
		// A whoami belongs to the connection that asked; the replaced one has already failed it.
		this.watches.delete(registration.instanceId);
		previous?.peer.close();
		peer.send({ type: "registered", status: { ...this.status, sessions: this.size } });
		this.membershipChanged();
		this.broadcastStatus();
		if (!this.client) {
			const { botId, secret, createWebSocket } = this.options;
			this.client = new WeComClient({
				botId, secret, createWebSocket,
				onState: (state, detail) => {
					this.status = { state, detail, sessions: this.size, ...(this.client?.stopped ? { stopped: true } : {}) };
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
		// Keep selections: losing a target must prompt for a new choice, even if only one remains.
		this.broadcastStatus();
		this.membershipChanged();
	}

	updateSource(instanceId: string, source: NotificationSource): void {
		const member = this.members.get(instanceId);
		if (!member) throw new Error("pi 尚未注册");
		if (source.sessionId !== member.source.sessionId) throw new Error("切换 session 必须重新注册");
		member.source = { ...source };
	}

	updateWelcome(instanceId: string, welcome: string): void {
		const member = this.members.get(instanceId);
		if (!member) throw new Error("pi 尚未注册");
		if (!validWelcome(welcome)) throw new Error("无效的欢迎语：必须是至多 16384 个字符的字符串");
		member.config = { ...member.config, welcome };
	}

	resume(): void { this.client?.start(); }

	/** The next message this pi may receive reports its conversation instead of becoming a task. */
	watch(instanceId: string, id: string, timeoutMs: number): void {
		if (!this.members.has(instanceId)) throw new Error("pi 尚未注册");
		this.watches.set(instanceId, { id, expiresAt: Date.now() + Math.min(Math.max(timeoutMs, 1000), MAX_WATCH_MS) });
	}

	unwatch(instanceId: string, id: string): void {
		if (this.watches.get(instanceId)?.id === id) this.watches.delete(instanceId);
	}

	stop(): void {
		this.client?.stop("gateway shutdown");
		for (const member of this.members.values()) member.peer.close();
		this.members.clear();
		this.choices.clear();
		this.selections.clear();
		for (const task of this.tasks.values()) clearTimeout(task.deadline);
		this.tasks.clear();
		this.watches.clear();
	}

	/** Shown in the task's status message; only the pi the task was routed to may report it. */
	taskStatus(instanceId: string, taskId: string, state: TaskState): boolean {
		const task = this.tasks.get(taskId);
		const member = this.members.get(instanceId);
		if (!task || !member || !sameTarget(task.target, sessionTarget(member))) return false;
		if (task.expiresAt < Date.now()) {
			this.closeTask(taskId);
			return false;
		}
		if (state === "running") task.deadline ??= setTimeout(() => this.expireStream(taskId), STREAM_DEADLINE_MS);
		return this.stream(taskId, task, state);
	}

	/** A pi's notification, rendered here with its source header. The source must be that pi's session. */
	async notify(instanceId: string, chat: ChatRef, notification: GatewayNotification): Promise<void> {
		const member = this.members.get(instanceId);
		if (!member || !this.client) throw new Error("pi 尚未注册");
		if (notification.source.sessionId !== member.source.sessionId) throw new Error("通知的 session 与发送 pi 不匹配，已拒绝发送");
		const content = renderNotification(notification.source, notification.text, {
			kind: notification.kind, excerpt: notification.excerpt, aborted: notification.aborted,
		});
		if (notification.image) {
			const image = readImage(notification.image.path);
			let failure = image.reason;
			let mediaId: string | undefined;
			if (image.data) {
				try {
					mediaId = await this.client.uploadImage(image.data, notification.image.filename);
				} catch (error) {
					failure = `上传失败：${errorMessage(error)}`;
				}
			}
			if (mediaId) {
				try {
					await this.client.sendMsg(chat.chatId, chat.chatType, { msgtype: "image", image: { media_id: mediaId } });
					return;
				} catch (error) {
					// A rejection definitely did not deliver the image; an unknown ACK must not be duplicated.
					if (deliveryFailure(error) !== "rejected") throw error;
					failure = `发送被拒绝：${errorMessage(error)}`;
				}
			}
			// The reason belongs in the fallback, as the README promises; a truncated tail is cut, not lost.
			const reason = failure?.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 200);
			this.log(`图片通知改发文字：${reason ?? "未知原因"}`);
			const note = `\n\n（图片发送失败${reason ? `：${reason}` : ""}，已改发文字）`;
			const fallback = Buffer.byteLength(content, "utf8") + Buffer.byteLength(note, "utf8") <= MAX_NOTIFICATION_BYTES ? content + note : content;
			await this.client.sendMsg(chat.chatId, chat.chatType, { msgtype: "markdown", markdown: { content: fallback } });
			return;
		}
		await this.client.sendMsg(chat.chatId, chat.chatType, { msgtype: "markdown", markdown: { content } });
	}

	private stream(taskId: string, task: Task, state: ProcessingState): boolean {
		const final = state !== "running";
		const sent = this.client?.respondMsg(taskId, { msgtype: "stream", stream: {
			id: task.streamId, finish: final, content: formatProcessingStatus(task.target.sessionId, state),
		} }) ?? false;
		if (final) {
			if (sent) this.closeTask(taskId);
			else task.unsent = state;
		}
		return sent;
	}

	/** WeCom would end the status message on its own; end it first and point at the coming notification. */
	private expireStream(taskId: string): void {
		const task = this.tasks.get(taskId);
		if (!task) return;
		task.deadline = undefined;
		const state = task.unsent ?? "waiting";
		this.client?.respondMsg(taskId, { msgtype: "stream", stream: {
			id: task.streamId, finish: true, content: formatProcessingStatus(task.target.sessionId, state),
		} });
		this.closeTask(taskId);
	}

	private flushUnsent(): void {
		for (const [taskId, task] of [...this.tasks]) if (task.unsent) this.stream(taskId, task, task.unsent);
	}

	private track(taskId: string, task: Task): void {
		this.closeTask(taskId);
		this.tasks.set(taskId, task);
		if (this.tasks.size > MAX_TASKS) this.closeTask(this.tasks.keys().next().value!);
	}

	private closeTask(taskId: string): void {
		const task = this.tasks.get(taskId);
		if (!task) return;
		clearTimeout(task.deadline);
		this.tasks.delete(taskId);
	}

	private broadcast(frame: ServerFrame): void {
		for (const member of this.members.values()) member.peer.send(frame);
	}

	private receive(action: () => void): void {
		try { action(); }
		catch (error) { this.log(`gateway inbound failed: ${errorMessage(error)}`); }
	}

	private broadcastStatus(): void {
		this.status = { ...this.status, sessions: this.size };
		this.broadcast({ type: "status", status: this.status });
	}

	private eligible(userid: string): Member[] {
		return [...this.members.values()].filter((member) => !member.config.allowedUserIds?.length || member.config.allowedUserIds.includes(userid));
	}

	private route(inbound: WeComInbound): void {
		const userid = senderOf(inbound.body);
		if (!userid) return;
		const eligible = this.eligible(userid);
		if (!eligible.length) return;
		const message = parseInbound(inbound.body);
		const id = message?.msgId || inbound.reqId;
		if (this.seen.has(id)) return;
		this.seen.add(id);
		if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
		if (!message) {
			this.reply(inbound.reqId, "无法识别这条消息，请重新发送。");
			return;
		}
		this.expire();
		const key = JSON.stringify([message.chat.chatType, message.chat.chatId, message.userid]);
		this.apply(this.decide(key, message, eligible), key, inbound.reqId, message);
	}

	/** Where a message goes, from the current state; changes nothing. */
	private decide(key: string, message: InboundMessage, eligible: Member[]): Route {
		// While a pi waits in /wecom-aibot whoami, the next message it may receive only identifies the chat.
		const watchers = eligible.filter((member) => this.watches.has(member.instanceId));
		if (watchers.length) return { kind: "identify", watchers };
		const quotedIds = message.quoteText ? quotedSessions(message.quoteText) : [];
		if (quotedIds.length) {
			// A quote routes this one message; the conversation's binding stays as it is.
			const target = quotedIds.length === 1 ? eligible.find((member) => member.source.sessionId === quotedIds[0]) : undefined;
			if (target) return { kind: "deliver", target, message, bind: false, answersChoice: false, fallback: "引用的目标会话已离线或不可用，请重新选择。" };
			return { kind: "offer", reason: quotedIds.length > 1 ? "引用中包含多个 session ID，请选择目标。" : "引用的目标会话已离线或不可用，请重新选择。", pending: message };
		}
		const text = message.text.trim();
		if (/^\/wecom-aibot\s+(?:sessions|list)$/i.test(text) || /^\/wecom-aibot\s+use\s*$/i.test(text)) return { kind: "offer" };
		const choice = this.choices.get(key);
		const selection = /^\/wecom-aibot\s+use\s+(\S+)$/i.exec(text)?.[1] ?? (choice && /^\d+$/.test(text) ? text : undefined);
		if (selection !== undefined) {
			// A number refers to the list that was shown, never to the current order of members.
			const numeric = /^\d+$/.test(selection);
			const numbered = numeric ? choice?.targets[Number(selection) - 1] : undefined;
			const target = eligible.find((member) => numeric ? sameTarget(sessionTarget(member), numbered) : member.source.sessionId === selection);
			if (!target) return { kind: "offer", reason: "所选会话已离线或选择无效，请重新选择。" };
			// The original callback already carries the choice prompt; this callback carries the task's status.
			if (choice?.pending) return { kind: "deliver", target, message: choice.pending, bind: true, answersChoice: true, fallback: "目标会话已离线，请重新选择。" };
			return { kind: "selected", target };
		}
		if (choice?.pending) return { kind: "offer", reason: "已保留最初那条消息，请先选择目标；其他任务请在选择后重新发送。" };
		const bound = this.selections.get(key);
		const target = bound ? eligible.find((member) => sameTarget(sessionTarget(member), bound)) : this.singleton(eligible);
		const lost = bound ? "目标会话已离线或不可用，请重新选择。" : undefined;
		if (!target) return { kind: "offer", reason: lost, pending: message };
		return { kind: "deliver", target, message, bind: true, answersChoice: false, fallback: lost };
	}

	/** Without a binding, the only pi takes the message, unless recovered bindings were unreadable. */
	private singleton(eligible: Member[]): Member | undefined {
		return !this.requireChoice && eligible.length === 1 ? eligible[0] : undefined;
	}

	private apply(route: Route, key: string, reqId: string, message: InboundMessage): void {
		switch (route.kind) {
			case "identify":
				this.identify(route.watchers, reqId, { ...message.chat, userid: message.userid });
				return;
			case "offer":
				this.offer(key, this.eligible(message.userid), reqId, route.reason, route.pending);
				return;
			case "selected":
				if (!this.select(key, route.target, reqId)) return;
				this.choices.delete(key);
				this.reply(reqId, `已选择 ${display(route.target.source.directoryName)}。\nsession: ${route.target.source.sessionId}\n\n后续消息将交给此会话。请发送任务。`);
				return;
			case "deliver":
				// Commit the binding before handing the task off; a crash cannot erase its owner.
				if (route.bind && !this.select(key, route.target, reqId)) return;
				if (route.answersChoice) this.choices.delete(key);
				if (this.deliver(route.target, reqId, route.message)) return;
				// The target went away while taking the task: list the pi that remain.
				this.offer(key, this.eligible(message.userid), reqId, route.fallback, route.message);
		}
	}

	private identify(watchers: Member[], reqId: string, identity: ChatIdentity): void {
		for (const member of watchers) {
			const watch = this.watches.get(member.instanceId)!;
			this.watches.delete(member.instanceId);
			member.peer.send({ type: "identity", id: watch.id, identity });
		}
		this.reply(reqId, identityText(identity));
	}

	private deliver(target: Member, taskId: string, message: InboundMessage): boolean {
		const targetId = sessionTarget(target);
		this.track(taskId, { target: targetId, streamId: `pi-${randomUUID()}`, expiresAt: Date.now() + WECOM_REPLY_WINDOW_MS });
		if (target.peer.send({ type: "task", target: targetId, task: { id: taskId, message } })) return true;
		this.closeTask(taskId);
		this.unregister(target.instanceId, target.peer);
		target.peer.close();
		return false;
	}

	private select(key: string, target: Member, reqId: string): boolean {
		if (sameTarget(this.selections.get(key), sessionTarget(target))) return true;
		const next = new Map(this.selections);
		this.remember(next, key, sessionTarget(target));
		try { this.selectionStore?.save([...next]); }
		catch (error) {
			this.reply(reqId, `无法保存目标会话（${errorMessage(error)}），请在 pi 中确认网关目录可写后重试。`);
			return false;
		}
		this.selections.clear();
		for (const [savedKey, savedTarget] of next) this.selections.set(savedKey, savedTarget);
		return true;
	}

	private offer(key: string, members: Member[], reqId: string, reason?: string, pending?: InboundMessage): void {
		const previous = this.choices.get(key);
		const choice: Choice = {
			targets: [], pending: previous?.pending ?? pending,
			expiresAt: previous?.pending ? previous.expiresAt : Date.now() + CHOICE_LIFETIME_MS,
		};
		const lines = [reason, `当前有 ${members.length} 个可用会话：`].filter(Boolean) as string[];
		for (const member of members) {
			const source = member.source;
			const line = `${choice.targets.length + 1}. ${display(source.directoryName)} · ${display(source.provider)} · ${display(source.modelName)}\n   session: ${source.sessionId}`;
			if (Buffer.byteLength(lines.join("\n\n") + line) > 18_000) break;
			lines.push(line);
			choice.targets.push(sessionTarget(member));
		}
		if (choice.targets.length < members.length) lines.push("其他会话可用完整 session ID 选择。");
		lines.push("回复序号，或发送 /wecom-aibot use <完整 session ID>。发送 /wecom-aibot sessions 可重新选择。");
		if (choice.pending) lines.push("已暂存最初那条消息（5 分钟内有效），选择后会交给目标 pi。");
		this.remember(this.choices, key, choice);
		this.reply(reqId, lines.join("\n\n"));
	}

	private reply(reqId: string, content: string): void {
		this.client?.respondMsg(reqId, { msgtype: "stream", stream: { id: `gateway-${randomUUID()}`, finish: true, content } });
	}

	private event(inbound: WeComInbound): void {
		const type = inbound.body?.event?.eventtype;
		if (type === "disconnected_event") {
			// Retain membership and each pi's queues. Only an explicit /wecom-aibot connect resumes.
			this.client?.stop("机器人连接已被其他机器或旧客户端接管；可在任一 pi 执行 /wecom-aibot connect 恢复");
			return;
		}
		const userid = senderOf(inbound.body);
		if (type !== "enter_chat" || !userid) return;
		const members = this.eligible(userid);
		if (!members.length) return;
		const content = members.length === 1
			? renderNotification(members[0].source, members[0].config.welcome || "你好，请把问题或任务发给我。", { kind: "welcome" })
			: `你好，pi 共享网关有 ${members.length} 个在线会话。发送任务后可选择目标，也可以先发送 /wecom-aibot sessions 查看会话。`;
		this.client?.respondWelcome(inbound.reqId, { msgtype: "text", text: { content } });
	}

	private remember<T>(map: Map<string, T>, key: string, value: T): void {
		map.delete(key);
		map.set(key, value);
		if (map.size > MAX_CONVERSATIONS) map.delete(map.keys().next().value!);
	}

	private expire(): void {
		const now = Date.now();
		for (const [key, choice] of this.choices) if (choice.expiresAt < now) this.choices.delete(key);
		for (const [taskId, task] of [...this.tasks]) if (task.expiresAt < now) this.closeTask(taskId);
		for (const [key, watch] of this.watches) if (watch.expiresAt < now) this.watches.delete(key);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read a rendered PNG defensively: a missing, non-file or oversized path falls back to Markdown with a reason. */
function readImage(path: string): { data?: Buffer; reason?: string } {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return { reason: "不是普通文件" };
		if (stat.size < WECOM_IMAGE_MIN_BYTES || stat.size > WECOM_IMAGE_MAX_BYTES) return { reason: `文件大小 ${stat.size} 字节超出限制` };
		return { data: readFileSync(path) };
	} catch (error) {
		return { reason: errorMessage(error) };
	}
}

/** WeCom-side receipt for a message consumed by /wecom-aibot whoami; the pi shows the result. */
function identityText(identity: ChatIdentity): string {
	const code = (value: string) => `\`${value.replace(/[`\s]/g, "")}\``;
	return [
		`whoami 已识别当前${identity.chatType === 2 ? "群聊" : "单聊"}；这条消息只用于识别，不会交给 pi 处理。`,
		`chatid：${code(identity.chatId)}　chat_type：${identity.chatType}　userid：${code(identity.userid)}`,
		"识别结果已交给发起 whoami 的 pi。",
	].join("\n\n");
}

function display(value: string): string {
	return [...value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")].slice(0, 60).join("").replace(/[\\`*_#\[\]<>]/g, "\\$&");
}
