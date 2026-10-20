/**
 * Minimal WebSocket client for the WeCom (企业微信) 智能机器人 长连接 API.
 *
 * Protocol reference (official docs, 智能机器人长连接):
 *   wss://openws.work.weixin.qq.com
 *
 * Client -> server commands:
 *   aibot_subscribe              { bot_id, secret }
 *   ping                         heartbeat
 *   aibot_respond_msg            reply to a msg callback (stream / markdown / template_card / file / ...)
 *   aibot_respond_update_msg     update a template card
 *   aibot_send_msg               proactive push (no callback required)
 *   aibot_upload_media_init/chunk/finish
 *
 * Server -> client:
 *   { headers: { req_id }, errcode, errmsg }         command response
 *   { cmd: "aibot_msg_callback",   headers, body }   user message
 *   { cmd: "aibot_event_callback", headers, body }   event
 */

import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { DeliveryError } from "../shared/delivery.ts";
import { WECOM_ACK_TIMEOUT_MS, WECOM_IMAGE_MAX_BYTES, WECOM_IMAGE_MIN_BYTES, type WeComState } from "../shared/wecom-protocol.ts";

export interface WeComResponse {
	errcode: number;
	errmsg?: string;
	[key: string]: unknown;
}

export interface WeComInbound {
	/** req_id from the callback headers; pass it back when replying. */
	reqId: string;
	/** The callback body, already parsed by the bot document's shape. */
	body: any;
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

/** Small transport boundary, also used by the offline protocol tests. */
export interface WeComSocket {
	readonly readyState: number;
	onopen?: ((event: any) => void) | null;
	onmessage?: ((event: any) => void) | null;
	onerror?: ((event: any) => void) | null;
	onclose?: ((event: any) => void) | null;
	send(data: string): void;
	close(): void;
}

const WS_URL = "wss://openws.work.weixin.qq.com";
const PING_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
/** Like the official SDK: a rejected subscription is retried with backoff, then given up (it is rate-limited). */
const MAX_SUBSCRIBE_FAILURES = 5;
/** Connecting, subscribing and every command are acknowledged within this time. */
const REQUEST_TIMEOUT_MS = WECOM_ACK_TIMEOUT_MS;

function genReqId(): string {
	return `pi-${randomUUID()}`;
}

/** Small typed promise used for command responses. */
interface Pending {
	resolve: (value: WeComResponse) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class WeComClient {
	private ws: WeComSocket | undefined;
	private state: WeComState = "disconnected";
	/** Stopped by stop() or after repeated subscription failures: no reconnect until start(). */
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

	constructor(options: WeComClientOptions) { this.options = options; }

	getState(): WeComState {
		return this.state;
	}

	/** True after stop() or repeated subscription failures, until start(). */
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
				// Closing is best effort, but a failure here means a socket the transport did not expect.
				this.options.log?.(`WebSocket close failed: ${error instanceof Error ? error.message : String(error)}`);
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
			ws = this.options.createWebSocket?.(WS_URL) ?? new WebSocket(WS_URL);
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
			if (this.ws === ws) this.disconnect(`WebSocket error${event?.message ? `: ${event.message}` : ""}`);
		};
		ws.onclose = (ev) => {
			if (this.ws !== ws) return;
			const code = Number.isInteger(ev?.code) ? ev.code : "unknown";
			const uptime = this.openedAt === undefined ? undefined : Math.max(0, Date.now() - this.openedAt);
			const clean = typeof ev?.wasClean === "boolean" ? ev.wasClean : "unknown";
			const reason = String(ev?.reason ?? "").split(this.options.secret || "\0").join("****")
				.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 256);
			this.options.log?.(`WebSocket closed: code=${code} uptime=${uptime === undefined ? "unknown" : `${uptime}ms`} clean=${clean} reason=${reason || "(empty)"}`);
			this.disconnect(`${reason || "connection closed"} (code=${code}, uptime=${uptime === undefined ? "unknown" : `${Math.round(uptime / 1000)}s`})`);
		};
	}

	private setConnectionDeadline(reason: string): void {
		clearTimeout(this.connectionTimer);
		this.connectionTimer = setTimeout(() => this.disconnect(reason), REQUEST_TIMEOUT_MS);
	}

	private subscribe(): void {
		const reqId = genReqId();
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

	private handleData(data: any): void {
		const text = typeof data === "string" ? data : data?.toString?.() ?? "";
		if (!text) return;
		let msg: any;
		try {
			msg = JSON.parse(text);
		} catch {
			this.options.log?.("ignoring non-JSON frame");
			return;
		}
		if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;

		const reqId = typeof msg.headers?.req_id === "string" ? msg.headers.req_id : undefined;

		if (msg?.cmd === "aibot_msg_callback") {
			if (reqId && this.isReady()) this.options.onMessage?.({ reqId, body: msg.body ?? {} });
			return;
		}
		if (msg?.cmd === "aibot_event_callback") {
			if (reqId && this.isReady()) this.options.onEvent?.({ reqId, body: msg.body ?? {} });
			return;
		}

		// command response
		if (reqId && this.pending.has(reqId)) {
			const p = this.pending.get(reqId)!;
			this.pending.delete(reqId);
			clearTimeout(p.timer);
			if (msg.errcode === 0) p.resolve(msg);
			else p.reject(new DeliveryError(`WeCom ${msg.errcode ?? "?"}: ${msg.errmsg ?? "invalid response"}`, typeof msg.errcode === "number" ? "rejected" : "unknown"));
			return;
		}
		if (reqId && reqId === this.subscribeReqId) {
			this.subscribeReqId = undefined;
			clearTimeout(this.connectionTimer);
			this.connectionTimer = undefined;
			if (msg?.errcode === 0) {
				this.attempts = 0;
				this.subscribeFailures = 0;
				this.startPing();
				this.setState("subscribed");
			} else {
				const reason = `subscribe failed: ${msg?.errcode ?? "?"} ${msg?.errmsg ?? ""}`.trim();
				// Credentials stay wrong: stop after a few backed-off attempts instead of hammering the server.
				if (++this.subscribeFailures >= MAX_SUBSCRIBE_FAILURES) this.stop(reason);
				else this.disconnect(reason);
			}
		} else if (typeof msg.errcode === "number" && msg.errcode !== 0) {
			this.options.log?.(`reply rejected: ${msg.errcode} ${msg.errmsg ?? ""}`);
		}
	}

	private setState(state: WeComState, detail?: string): void {
		if (this.state === state && !detail) return;
		this.state = state;
		this.options.onState?.(state, detail);
	}

	// ----------------------------------------------------------------- outbound

	/** Sends one frame; undefined when written, otherwise why it could not be written. */
	private send(payload: any): string | undefined {
		const ws = this.ws;
		if (!ws || ws.readyState !== 1 /* OPEN */) return "WebSocket is not connected";
		try {
			ws.send(JSON.stringify(payload));
			return undefined;
		} catch (error) {
			// A synchronous failure from the transport is not a socket close: report it without reconnecting.
			const reason = error instanceof Error ? error.message : String(error);
			this.options.log?.(`send failed: ${reason}`);
			return `WebSocket send failed: ${reason}`;
		}
	}

	/** Resolve only after a successful acknowledgement; reject on timeout or disconnect. */
	sendCommand(cmd: string, body: any | undefined, reqId = genReqId()): Promise<WeComResponse> {
		if (!this.isReady()) return Promise.reject(new DeliveryError("WebSocket is not subscribed", "not_sent"));
		if (this.pending.has(reqId)) return Promise.reject(new DeliveryError("Request is already pending", "rejected"));
		const payload: any = { cmd, headers: { req_id: reqId } };
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

	/** aibot_respond_msg — reply to a message callback. */
	respondMsg(reqId: string, body: any): boolean {
		return this.isReady() && this.send({ cmd: "aibot_respond_msg", headers: { req_id: reqId }, body }) === undefined;
	}



	/**
	 * Upload a PNG as temporary media and return its media_id. init → chunk × N → finish;
	 * chunks are 512KB of raw bytes and may be retried because the server ignores duplicates.
	 */
	async uploadImage(data: Buffer, filename = "pi-notification.png"): Promise<string> {
		if (data.byteLength < WECOM_IMAGE_MIN_BYTES || data.byteLength > WECOM_IMAGE_MAX_BYTES) {
			throw new DeliveryError(`图片大小必须在 ${WECOM_IMAGE_MIN_BYTES} 字节到 ${WECOM_IMAGE_MAX_BYTES / 1024 / 1024}MB 之间`, "rejected");
		}
		const name = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200) || "pi-notification.png";
		const CHUNK = 512 * 1024;
		const totalChunks = Math.ceil(data.byteLength / CHUNK);
		const md5 = createHash("md5").update(data).digest("hex");
		const init = await this.sendCommand("aibot_upload_media_init", {
			type: "image", filename: name, total_size: data.byteLength, total_chunks: totalChunks, md5,
		});
		const uploadId = bodyField(init, "upload_id");
		if (!uploadId) throw new DeliveryError("上传初始化没有返回 upload_id", "rejected");
		for (let index = 0; index < totalChunks; index++) {
			const chunk = data.subarray(index * CHUNK, (index + 1) * CHUNK);
			for (let attempt = 0; ; attempt++) {
				try {
					await this.sendCommand("aibot_upload_media_chunk", {
						upload_id: uploadId, chunk_index: index, base64_data: chunk.toString("base64"),
					});
					break;
				} catch (error) {
					// Chunks are idempotent server-side, so one retry is safe whatever the outcome; the
					// first reason still reaches the log instead of being hidden by the retry.
					if (attempt >= 1) throw error;
					this.options.log?.(`upload chunk ${index} failed, retrying once: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		const finish = await this.sendCommand("aibot_upload_media_finish", { upload_id: uploadId });
		const mediaId = bodyField(finish, "media_id");
		if (!mediaId) throw new DeliveryError("上传完成没有返回 media_id", "rejected");
		return mediaId;
	}
	/** aibot_send_msg — proactive push to a single user (chat_type=1) or group (chat_type=2). */
	sendMsg(chatId: string, chatType: 1 | 2, body: Record<string, any>): Promise<WeComResponse> {
		return this.sendCommand("aibot_send_msg", { chatid: chatId, chat_type: chatType, ...body });
	}

	private rejectAll(err: Error): void {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}
}

function bodyField(response: WeComResponse, key: string): string | undefined {
	const body = response.body;
	if (body && typeof body === "object") {
		const value = (body as Record<string, unknown>)[key];
		if (typeof value === "string" && value) return value;
	}
	const direct = response[key];
	return typeof direct === "string" && direct ? direct : undefined;
}
