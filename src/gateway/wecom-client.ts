/**
 * Minimal WebSocket client for the WeCom (企业微信) 智能机器人 长连接 API.
 *
 * Server -> client frames:
 *   { headers: { req_id }, errcode, errmsg }         command response
 *   { cmd: "aibot_msg_callback",   headers, body }   user message
 *   { cmd: "aibot_event_callback", headers, body }   event
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { DeliveryError } from "../shared/delivery.ts";
import { errorMessage } from "../shared/text.ts";
import { asRecord, WECOM_ACK_TIMEOUT_MS, type WeComState } from "../shared/wecom-protocol.ts";

export interface WeComResponse {
	errcode: number;
	errmsg?: string;
	[key: string]: unknown;
}

export interface WeComInbound {
	reqId: string;
	/** The callback body as JSON; parseInbound() validates it at this boundary. */
	body: unknown;
}

export interface WeComClientOptions {
	botId: string;
	secret: string;
	onState?: (state: WeComState, detail?: string) => void;
	onMessage?: (msg: WeComInbound) => void;
	onEvent?: (evt: WeComInbound) => void;
	log?: (line: string) => void;
	createWebSocket?: (url: string) => WeComSocket;
}

export interface WeComSocketEvent {
	readonly data?: unknown;
	readonly message?: unknown;
	readonly code?: unknown;
	readonly reason?: unknown;
	readonly wasClean?: unknown;
}

/** Small transport boundary, also used by the offline protocol tests. */
export interface WeComSocket {
	readonly readyState: number;
	onopen?(event: WeComSocketEvent): void;
	onmessage?(event: WeComSocketEvent): void;
	onerror?(event: WeComSocketEvent): void;
	onclose?(event: WeComSocketEvent): void;
	send(data: string): void;
	close(): void;
}

const WS_URL = "wss://openws.work.weixin.qq.com";
const PING_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
/** Like the official SDK: a rejected subscription is retried with backoff, then given up (it is rate-limited). */
const MAX_SUBSCRIBE_FAILURES = 5;
const REQUEST_TIMEOUT_MS = WECOM_ACK_TIMEOUT_MS;

function newReqId(): string {
	return `pi-${randomUUID()}`;
}

interface Pending {
	resolve: (value: WeComResponse) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class WeComClient {
	private ws: WeComSocket | undefined;
	private state: WeComState = "disconnected";
	private halted = false;
	private subscribeFailures = 0;
	private attempts = 0;
	private pingTimer: ReturnType<typeof setInterval> | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private connectionTimer: ReturnType<typeof setTimeout> | undefined;
	private subscribeReqId: string | undefined;
	private openedAt: number | undefined;
	private pending = new Map<string, Pending>();

	private readonly options: WeComClientOptions;

	constructor(options: WeComClientOptions) {
		this.options = options;
	}

	getState(): WeComState {
		return this.state;
	}

	get stopped(): boolean {
		return this.halted;
	}

	isReady(): boolean {
		return this.state === "subscribed" && this.ws?.readyState === 1;
	}

	// ---------------------------------------------------------------- lifecycle

	start(): void {
		if (this.ws || this.reconnectTimer) return;
		this.halted = false;
		this.attempts = 0;
		this.subscribeFailures = 0;
		this.open();
	}

	stop(reason = "stopped"): void {
		this.halted = true;
		this.disconnect(reason);
	}

	private disconnect(reason: string): void {
		this.clearTimers();
		this.subscribeReqId = undefined;
		this.rejectAll(new DeliveryError(reason));
		const ws = this.ws;
		this.ws = undefined;
		this.openedAt = undefined;
		if (ws) {
			try {
				ws.close();
			} catch (error) {
				this.options.log?.(`WebSocket close failed: ${errorMessage(error)}`);
			}
		}
		this.setState("disconnected", reason);
		if (!this.halted) this.scheduleReconnect();
	}

	private open(): void {
		if (this.halted) return;
		this.setState("connecting");
		let ws: WeComSocket;
		try {
			ws = this.options.createWebSocket?.(WS_URL) ?? (new WebSocket(WS_URL) as WeComSocket);
		} catch (err) {
			this.options.log?.(`connect failed: ${String(err)}`);
			this.disconnect("connection failed");
			return;
		}
		this.ws = ws;
		this.setConnectionDeadline("connection timeout");

		ws.onopen = () => {
			if (this.ws !== ws) return;
			this.openedAt = Date.now();
			this.setState("connected");
			this.subscribe();
		};
		ws.onmessage = (ev) => {
			if (this.ws !== ws) return;
			this.handleData(ev?.data);
		};
		ws.onerror = (event) => {
			const message = event?.message === undefined ? "" : String(event.message);
			if (this.ws === ws) this.disconnect(`WebSocket error${message ? `: ${message}` : ""}`);
		};
		ws.onclose = (ev) => {
			if (this.ws !== ws) return;
			const code = typeof ev?.code === "number" && Number.isInteger(ev.code) ? ev.code : "unknown";
			const uptime = this.openedAt === undefined ? undefined : Math.max(0, Date.now() - this.openedAt);
			const clean = typeof ev?.wasClean === "boolean" ? ev.wasClean : "unknown";
			const reason = String(ev?.reason ?? "")
				.split(this.options.secret || "\0")
				.join("****")
				.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
				.slice(0, 256);
			this.options.log?.(
				`WebSocket closed: code=${code} uptime=${uptime === undefined ? "unknown" : `${uptime}ms`} clean=${clean} reason=${reason || "(empty)"}`,
			);
			this.disconnect(
				`${reason || "connection closed"} (code=${code}, uptime=${uptime === undefined ? "unknown" : `${Math.round(uptime / 1000)}s`})`,
			);
		};
	}

	private setConnectionDeadline(reason: string): void {
		clearTimeout(this.connectionTimer);
		this.connectionTimer = setTimeout(() => this.disconnect(reason), REQUEST_TIMEOUT_MS);
	}

	private subscribe(): void {
		const reqId = newReqId();
		this.subscribeReqId = reqId;
		this.setConnectionDeadline("subscription timeout");
		this.send({
			cmd: "aibot_subscribe",
			headers: { req_id: reqId },
			body: { bot_id: this.options.botId, secret: this.options.secret },
		});
	}

	private scheduleReconnect(): void {
		if (this.halted || this.reconnectTimer) return;
		const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempts, 5));
		this.attempts += 1;
		this.options.log?.(`reconnecting in ${Math.round(delay / 1000)}s`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.open();
		}, delay);
	}

	private clearTimers(): void {
		this.clearPing();
		clearTimeout(this.connectionTimer);
		this.connectionTimer = undefined;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
	}

	private clearPing(): void {
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = undefined;
		}
	}

	private startPing(): void {
		this.clearPing();
		const ws = this.ws;
		this.pingTimer = setInterval(() => {
			void this.sendCommand("ping", undefined).catch((err: unknown) => {
				if (this.ws === ws) this.disconnect(`heartbeat failed: ${String(err)}`);
			});
		}, PING_INTERVAL_MS);
	}

	// ------------------------------------------------------------------ inbound

	private handleData(data: unknown): void {
		const text = typeof data === "string" ? data : data === undefined || data === null ? "" : String(data);
		if (!text) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			this.options.log?.("ignoring non-JSON frame");
			return;
		}
		const msg = asRecord(parsed);
		if (!msg) return;

		const headers = asRecord(msg.headers);
		const reqId = typeof headers?.req_id === "string" ? headers.req_id : undefined;

		if (msg.cmd === "aibot_msg_callback") {
			if (reqId && this.isReady()) this.options.onMessage?.({ reqId, body: msg.body ?? {} });
			return;
		}
		if (msg.cmd === "aibot_event_callback") {
			if (reqId && this.isReady()) this.options.onEvent?.({ reqId, body: msg.body ?? {} });
			return;
		}

		// command response
		const errcode = typeof msg.errcode === "number" ? msg.errcode : undefined;
		const errmsg = typeof msg.errmsg === "string" ? msg.errmsg : undefined;
		const pending = reqId === undefined ? undefined : this.pending.get(reqId);
		if (reqId && pending) {
			const p = pending;
			this.pending.delete(reqId);
			clearTimeout(p.timer);
			if (errcode === 0) p.resolve({ errcode, ...(errmsg === undefined ? {} : { errmsg }), ...msg });
			else
				p.reject(
					new DeliveryError(
						`WeCom ${errcode ?? "?"}: ${errmsg ?? "invalid response"}`,
						errcode === undefined ? "unknown" : "rejected",
					),
				);
			return;
		}
		if (reqId && reqId === this.subscribeReqId) {
			this.subscribeReqId = undefined;
			clearTimeout(this.connectionTimer);
			this.connectionTimer = undefined;
			if (errcode === 0) {
				this.attempts = 0;
				this.subscribeFailures = 0;
				this.startPing();
				this.setState("subscribed");
			} else {
				const reason = `subscribe failed: ${errcode ?? "?"} ${errmsg ?? ""}`.trim();
				if (++this.subscribeFailures >= MAX_SUBSCRIBE_FAILURES) this.stop(reason);
				else this.disconnect(reason);
			}
		} else if (errcode !== undefined && errcode !== 0) {
			this.options.log?.(`reply rejected: ${errcode} ${errmsg ?? ""}`);
		}
	}

	private setState(state: WeComState, detail?: string): void {
		if (this.state === state && !detail) return;
		this.state = state;
		this.options.onState?.(state, detail);
	}

	// ----------------------------------------------------------------- outbound

	/** undefined when written, otherwise why it could not be written. */
	private send(payload: object): string | undefined {
		const ws = this.ws;
		if (ws?.readyState !== 1 /* OPEN */) return "WebSocket is not connected";
		try {
			ws.send(JSON.stringify(payload));
			return undefined;
		} catch (error) {
			// A synchronous failure from the transport is not a socket close: report it without reconnecting.
			const reason = errorMessage(error);
			this.options.log?.(`send failed: ${reason}`);
			return `WebSocket send failed: ${reason}`;
		}
	}

	sendCommand(cmd: string, body: unknown, reqId = newReqId()): Promise<WeComResponse> {
		if (!this.isReady()) return Promise.reject(new DeliveryError("WebSocket is not subscribed", "not_sent"));
		if (this.pending.has(reqId)) return Promise.reject(new DeliveryError("Request is already pending", "rejected"));
		const payload: { cmd: string; headers: { req_id: string }; body?: unknown } = { cmd, headers: { req_id: reqId } };
		if (body !== undefined) payload.body = body;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(reqId);
				reject(new DeliveryError(`${cmd} acknowledgement timeout`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(reqId, { resolve, reject, timer });
			const failure = this.send(payload);
			if (failure) {
				clearTimeout(timer);
				this.pending.delete(reqId);
				reject(new DeliveryError(failure));
			}
		});
	}

	respondMsg(reqId: string, body: unknown): boolean {
		return this.isReady() && this.send({ cmd: "aibot_respond_msg", headers: { req_id: reqId }, body }) === undefined;
	}

	/** respondMsg that resolves only once WeCom acknowledged it (scripts/card-probe.ts tries reply formats with it). */
	respondMsgAck(reqId: string, body: unknown): Promise<WeComResponse> {
		return this.sendCommand("aibot_respond_msg", body, reqId);
	}

	/** aibot_send_msg — proactive push to a single user (chat_type=1) or group (chat_type=2). */
	sendMsg(chatId: string, chatType: 1 | 2, body: Record<string, any>): Promise<WeComResponse> {
		return this.sendCommand("aibot_send_msg", { chatid: chatId, chat_type: chatType, ...body });
	}

	/** aibot_respond_welcome_msg — a text or card welcome, within 5 seconds of enter_chat. */
	respondWelcome(eventReqId: string, body: unknown): Promise<WeComResponse> {
		return this.sendCommand("aibot_respond_welcome_msg", body, eventReqId);
	}

	/**
	 * aibot_respond_update_msg — replace a clicked card, within 5 seconds of its template_card_event. userids
	 * (group chats only) replaces just those members' copies; without it every copy is replaced.
	 */
	updateCard(eventReqId: string, templateCard: Record<string, unknown>, userids?: string[]): Promise<WeComResponse> {
		return this.sendCommand(
			"aibot_respond_update_msg",
			{
				response_type: "update_template_card",
				...(userids?.length ? { userids } : {}),
				template_card: templateCard,
			},
			eventReqId,
		);
	}

	private rejectAll(err: Error): void {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}
}
