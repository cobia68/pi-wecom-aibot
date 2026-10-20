/**
 * Local IPC between pi and the shared gateway: no credentials in command lines and no public listening port.
 *
 * Handshake (protocol 3): the client sends hello{nonce}; the gateway answers hello{nonce, proof}; the client
 * checks the proof and only then sends register{proof}. Both proofs are HMAC(Secret) over both nonces and the
 * endpoint, so a captured hello cannot be replayed, and a peer without the Secret learns nothing about the pi.
 *
 * The gateway owns the WeCom format: message parsing, stream ids and deadlines, wording, byte limits. pi sends
 * task states and notification snapshots, and receives parsed messages.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import type { DeliveryFailure } from "./delivery.ts";
import type { GatewayNotification, NotificationSource } from "./notification-types.ts";
import { WECOM_ACK_TIMEOUT_MS, type ChatRef, type InboundMessage, type WeComState } from "./wecom-protocol.ts";
import { agentDirectory, gatewayDirectory } from "./agent-path.ts";

export const GATEWAY_PROTOCOL_VERSION = 3;
export const IPC_HEARTBEAT_MS = 10_000;
export const IPC_LEASE_MS = 45_000;
export const IPC_MAX_BYTES = 1_048_576;
/** A notification's IPC result follows WeCom's acknowledgement (or its timeout). */
export const IPC_SEND_TIMEOUT_MS = WECOM_ACK_TIMEOUT_MS + 2_000;
/** After the last pi leaves, the gateway waits this long for another before it exits. */
export const GATEWAY_IDLE_MS = 1_500;
/** An incompatible gateway (other Secret, other protocol) may hold the endpoint this long, e.g. its idle exit, before a pi reports it. */
export const GATEWAY_RETRY_MS = 10_000;

/** What a pi registers: never the Secret, and only the fields the gateway uses. */
export interface RegistrationConfig {
	botId: string;
	welcome: string;
	allowedUserIds?: string[];
}

/** The gateway's own credentials; given to a new daemon only through its private stdin. */
export interface GatewayCredentials {
	botId: string;
	secret: string;
}

export interface GatewayRegistration {
	instanceId: string;
	registrationId: string;
	source: NotificationSource;
	config: RegistrationConfig;
}

export interface SessionTarget {
	instanceId: string;
	registrationId: string;
	sessionId: string;
}

/** The conversation of a message, as /wecom-aibot whoami reports it: chatid is the userid in a single chat. */
export interface ChatIdentity {
	chatId: string;
	chatType: 1 | 2;
	userid: string;
}

export interface GatewayStatus {
	state: WeComState;
	detail?: string;
	sessions: number;
	/** The WeCom connection gave up (subscription refused, taken over) and waits for /wecom-aibot connect. */
	stopped?: boolean;
}

/** A message routed to one pi; its id is the WeCom callback's req_id. */
export interface GatewayTask {
	id: string;
	message: InboundMessage;
}

/**
 * The state of a task, as pi reports it. The gateway shows it in the task's status message:
 * running opens it, any other state closes it (busy/failed: the task was not accepted).
 */
export type TaskState = "running" | "settled" | "stopped" | "busy" | "failed";

export type ClientFrame =
	| { type: "hello"; version: number; nonce: string }
	| { type: "register"; registration: GatewayRegistration; proof: string; resume?: boolean }
	| { type: "source"; source: NotificationSource }
	| { type: "welcome"; text: string }
	| { type: "ping" | "resume" | "unregister" }
	| { type: "status"; taskId: string; state: TaskState }
	| { type: "notify"; id: string; chat: ChatRef; notification: GatewayNotification }
	| { type: "watch"; id: string; timeoutMs: number }
	| { type: "unwatch"; id: string };

export type ServerFrame =
	| { type: "hello"; version: number; endpoint: string; nonce: string; proof: string }
	| { type: "registered"; status: GatewayStatus }
	| { type: "status"; status: GatewayStatus }
	| { type: "pong" }
	| { type: "task"; target: SessionTarget; task: GatewayTask }
	| { type: "result"; id: string; error?: string; outcome?: DeliveryFailure }
	| { type: "identity"; id: string; identity: ChatIdentity }
	| { type: "log"; message: string }
	| { type: "fatal"; message: string };

/** The bridge can be tested separately from process management. */
export interface BridgeClient {
	start(): void;
	stop(reason?: string): void;
	isReady(): boolean;
	updateSource(source: NotificationSource): void;
	/** Update presentation only, retaining the registration, tasks and identity watches. */
	updateWelcome(welcome: string): void;
	/** Restart a stopped upstream connection, e.g. after another client took it over. */
	resume(): void;
	/** false when the state could not be handed to the gateway; the gateway ignores tasks it no longer knows. */
	taskStatus(taskId: string, state: TaskState): boolean;
	/** Resolves once WeCom acknowledged the push; only a DeliveryError with not_sent is safe to retry. */
	notify(chat: ChatRef, notification: GatewayNotification): Promise<void>;
	/** /wecom-aibot whoami: resolve with the next permitted message's conversation instead of routing it. */
	watchIdentity(timeoutMs: number, signal?: AbortSignal): Promise<ChatIdentity>;
}

/**
 * The shared gateway's endpoint for one agent directory and BotID. Multiple pi windows in the same
 * agent directory meet here; POSIX keeps the socket in a private 0700 directory, so other local users
 * can neither connect nor take the name.
 */
export function gatewayEndpoint(botId: string): string {
	const key = endpointKey(botId);
	if (process.platform === "win32") return `\\\\.\\pipe\\pi-wecom-aibot-${key}`;
	const preferred = join(gatewayDirectory(), `${key}.sock`);
	// sun_path holds 104–108 bytes; a long agent directory falls back to a short per-user directory.
	return Buffer.byteLength(preferred) <= 100 ? preferred : join(tmpdir(), `pi-wecom-aibot-${process.getuid?.() ?? "user"}`, `${key}.sock`);
}

/**
 * Where a protocol-1 gateway listens; it may still serve older pi windows after an upgrade.
 * The path keeps the pre-rename `pi-wecom-` spelling on purpose: it names a historical endpoint
 * that old gateways are already listening on, so renaming it would hide them instead of waiting.
 */
export function legacyGatewayEndpoint(botId: string): string | undefined {
	const key = legacyEndpointKey(botId);
	if (process.platform === "win32") return undefined; // Same pipe name: the version check in the handshake applies.
	if (process.platform === "linux") return `\0pi-wecom-${key}`;
	return join(tmpdir(), `pi-wecom-${key}.sock`);
}

function endpointKey(botId: string): string {
	return createHash("sha256").update(`${userInfo().username}\0${homedir()}\0${agentDirectory()}\0${botId}`).digest("hex").slice(0, 32);
}

/** The pre-rename key, which did not include the agent directory: names the historical protocol-1 endpoint. */
function legacyEndpointKey(botId: string): string {
	return createHash("sha256").update(`${userInfo().username}\0${homedir()}\0${botId}`).digest("hex").slice(0, 32);
}

export function validSource(value: unknown): value is NotificationSource {
	if (!value || typeof value !== "object") return false;
	const source = value as Record<string, unknown>;
	return typeof source.sessionId === "string" && source.sessionId.length > 0 && source.sessionId.length <= 256
		&& !/[\u0000-\u0020\u007f`]/.test(source.sessionId)
		&& [source.provider, source.modelName, source.directoryName].every((item) => typeof item === "string" && item.length <= 4096);
}

export function validWelcome(value: unknown): value is string {
	return typeof value === "string" && value.length <= 16_384;
}

export function validRegistration(value: unknown): value is GatewayRegistration {
	if (!value || typeof value !== "object") return false;
	const registration = value as GatewayRegistration;
	const cfg = registration.config;
	return typeof registration.instanceId === "string" && registration.instanceId.length > 0 && registration.instanceId.length <= 256
		&& typeof registration.registrationId === "string" && registration.registrationId.length > 0 && registration.registrationId.length <= 256
		&& validSource(registration.source) && !!cfg && typeof cfg === "object"
		&& typeof cfg.botId === "string" && !!cfg.botId && cfg.botId.length <= 1024
		&& validWelcome(cfg.welcome)
		&& (cfg.allowedUserIds === undefined || (Array.isArray(cfg.allowedUserIds) && cfg.allowedUserIds.length <= 1000
			&& cfg.allowedUserIds.every((id) => typeof id === "string" && id.length <= 1024)));
}

export function validNotification(value: unknown): value is GatewayNotification {
	if (!value || typeof value !== "object") return false;
	const notification = value as GatewayNotification;
	const image = notification.image;
	return ["notification", "completion", "reply", "test"].includes(notification.kind) && validSource(notification.source)
		&& typeof notification.text === "string" && Buffer.byteLength(notification.text) <= 512 * 1024
		&& [notification.excerpt, notification.aborted].every((flag) => flag === undefined || typeof flag === "boolean")
		&& (image === undefined || (!!image && typeof image === "object"
			&& image.mime === "image/png"
			&& typeof image.filename === "string" && !!image.filename && image.filename.length <= 256 && !/[\u0000-\u001f\u007f]/.test(image.filename)
			&& typeof image.path === "string" && !!image.path && image.path.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(image.path)));
}

export function validChat(value: unknown): value is ChatRef {
	const chat = value as ChatRef | undefined;
	return !!chat && typeof chat.chatId === "string" && !!chat.chatId.trim() && chat.chatId.length <= 1024 && (chat.chatType === 1 || chat.chatType === 2);
}

/** pi checks what an authenticated gateway sends, too: a malformed task is dropped, not half-processed. */
export function validTask(value: unknown): value is GatewayTask {
	const task = value as GatewayTask | undefined;
	const message = task?.message;
	return !!task && typeof task.id === "string" && !!task.id && task.id.length <= 256 && !!message
		&& typeof message.msgId === "string" && typeof message.msgtype === "string" && validChat(message.chat)
		&& typeof message.userid === "string" && !!message.userid && typeof message.text === "string"
		&& (message.quoteText === undefined || typeof message.quoteText === "string")
		&& Array.isArray(message.attachments) && message.attachments.every((item) => ["image", "file", "video"].includes(item?.kind)
			&& typeof item.url === "string" && (item.aeskey === undefined || typeof item.aeskey === "string"));
}

export function validNonce(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9-]{16,128}$/.test(value);
}

export function sessionTarget(registration: GatewayRegistration): SessionTarget {
	return { instanceId: registration.instanceId, registrationId: registration.registrationId, sessionId: registration.source.sessionId };
}

export function sameTarget(left: SessionTarget | undefined, right: SessionTarget | undefined): boolean {
	return !!left && !!right && left.instanceId === right.instanceId && left.registrationId === right.registrationId && left.sessionId === right.sessionId;
}

/** Each side proves the Secret over both fresh nonces, bound to the endpoint and the side, so no proof is reusable. */
export function gatewayProof(secret: string, side: "server" | "client", serverNonce: string, clientNonce: string, endpoint: string): string {
	return createHmac("sha256", secret).update(JSON.stringify([GATEWAY_PROTOCOL_VERSION, side, serverNonce, clientNonce, endpoint])).digest("hex");
}

export function verifyProof(proof: unknown, expected: string): boolean {
	if (typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)) return false;
	return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(expected, "hex"));
}

/** A frame is either accepted as its typed form or rejected with the reason; callers never guess. */
export type FrameParse<Frame> = { ok: true; frame: Frame } | { ok: false; reason: string };

export function isTaskState(value: unknown): value is TaskState {
	return value === "running" || value === "settled" || value === "stopped" || value === "busy" || value === "failed";
}

const WE_COM_STATES = new Set<WeComState>(["disconnected", "connecting", "connected", "subscribed"]);
const DELIVERY_FAILURES = new Set<DeliveryFailure>(["not_sent", "rejected", "unknown"]);

/** The only reader of what pi sends: every shape check for a client frame lives here. */
export function parseClientFrame(value: unknown): FrameParse<ClientFrame> {
	const frame = value as (ClientFrame & Record<string, unknown>) | undefined;
	if (!frame || typeof frame !== "object") return reject("帧必须是 JSON 对象");
	switch (frame.type) {
		case "hello":
			if (typeof frame.version !== "number") return reject("无效的协议版本");
			if (!validNonce(frame.nonce)) return reject("无效的握手 nonce");
			return accept({ type: "hello", version: frame.version, nonce: frame.nonce });
		case "register":
			if (!validRegistration(frame.registration)) return reject("无效的 pi 注册信息");
			if (typeof frame.proof !== "string") return reject("无效的认证证明");
			if (frame.resume !== undefined && typeof frame.resume !== "boolean") return reject("无效的恢复标记");
			return accept({ type: "register", registration: frame.registration, proof: frame.proof, ...(frame.resume === true ? { resume: true } : {}) });
		case "source":
			if (!validSource(frame.source)) return reject("无效的会话来源");
			return accept({ type: "source", source: frame.source });
		case "welcome":
			if (!validWelcome(frame.text)) return reject("无效的欢迎语");
			return accept({ type: "welcome", text: frame.text });
		case "status":
			if (!validRequestId(frame.taskId)) return reject("无效的任务 ID");
			if (!isTaskState(frame.state)) return reject("无效的任务状态");
			return accept({ type: "status", taskId: frame.taskId, state: frame.state });
		case "notify":
			if (!validRequestId(frame.id)) return reject("无效的请求 ID");
			if (!validChat(frame.chat)) return reject("无效的通知目标");
			if (!validNotification(frame.notification)) return reject("无效的通知");
			return accept({ type: "notify", id: frame.id, chat: frame.chat, notification: frame.notification });
		case "watch":
			if (!validRequestId(frame.id)) return reject("无效的 whoami 请求");
			if (typeof frame.timeoutMs !== "number" || !Number.isFinite(frame.timeoutMs) || frame.timeoutMs <= 0) return reject("无效的 whoami 超时");
			return accept({ type: "watch", id: frame.id, timeoutMs: frame.timeoutMs });
		case "unwatch":
			if (!validRequestId(frame.id)) return reject("无效的 whoami 请求");
			return accept({ type: "unwatch", id: frame.id });
		case "ping":
		case "resume":
		case "unregister":
			return accept({ type: frame.type });
		default:
			return reject("未知的网关请求");
	}
}

/** The only reader of what the gateway sends; the gateway is authenticated, but its bugs stay contained too. */
export function parseServerFrame(value: unknown): FrameParse<ServerFrame> {
	const frame = value as (ServerFrame & Record<string, unknown>) | undefined;
	if (!frame || typeof frame !== "object") return reject("帧必须是 JSON 对象");
	switch (frame.type) {
		case "hello":
			if (typeof frame.version !== "number") return reject("无效的协议版本");
			if (typeof frame.endpoint !== "string" || !frame.endpoint) return reject("无效的网关地址");
			if (!validNonce(frame.nonce)) return reject("无效的握手 nonce");
			if (typeof frame.proof !== "string") return reject("无效的认证证明");
			return accept({ type: "hello", version: frame.version, endpoint: frame.endpoint, nonce: frame.nonce, proof: frame.proof });
		case "registered":
			if (!validStatus(frame.status)) return reject("无效的注册状态");
			return accept({ type: "registered", status: frame.status });
		case "status":
			if (!validStatus(frame.status)) return reject("无效的连接状态");
			return accept({ type: "status", status: frame.status });
		case "task":
			if (!validTask(frame.task)) return reject("无效的任务");
			if (!validTarget(frame.target)) return reject("无效的任务目标");
			return accept({ type: "task", target: frame.target, task: frame.task });
		case "result":
			if (!validRequestId(frame.id)) return reject("无效的请求 ID");
			if (frame.error !== undefined && typeof frame.error !== "string") return reject("无效的送达错误");
			if (frame.outcome !== undefined && !DELIVERY_FAILURES.has(frame.outcome as DeliveryFailure)) return reject("无效的送达结果");
			return accept({ type: "result", id: frame.id, ...(frame.error !== undefined ? { error: frame.error } : {}),
				...(frame.outcome !== undefined ? { outcome: frame.outcome as DeliveryFailure } : {}) });
		case "identity":
			if (!validRequestId(frame.id)) return reject("无效的 whoami 请求");
			if (!validIdentity(frame.identity)) return reject("无效的会话标识");
			return accept({ type: "identity", id: frame.id, identity: frame.identity });
		case "log":
			if (typeof frame.message !== "string") return reject("无效的网关日志");
			return accept({ type: "log", message: frame.message });
		case "pong":
			return accept({ type: "pong" });
		case "fatal":
			if (typeof frame.message !== "string") return reject("无效的网关错误");
			return accept({ type: "fatal", message: frame.message });
		default:
			return reject("未知的网关响应");
	}
}

function accept<Frame>(frame: Frame): FrameParse<Frame> { return { ok: true, frame }; }
function reject<Frame>(reason: string): FrameParse<Frame> { return { ok: false, reason }; }

function validRequestId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function validStatus(value: unknown): value is GatewayStatus {
	const status = value as GatewayStatus | undefined;
	return !!status && typeof status === "object" && WE_COM_STATES.has(status.state)
		&& (status.detail === undefined || typeof status.detail === "string")
		&& Number.isSafeInteger(status.sessions) && status.sessions >= 0
		&& (status.stopped === undefined || typeof status.stopped === "boolean");
}

function validTarget(value: unknown): value is SessionTarget {
	const target = value as SessionTarget | undefined;
	return !!target && [target.instanceId, target.registrationId, target.sessionId].every((item) => typeof item === "string" && !!item && item.length <= 256);
}

function validIdentity(value: unknown): value is ChatIdentity {
	const identity = value as ChatIdentity | undefined;
	return !!identity && typeof identity.chatId === "string" && !!identity.chatId && identity.chatId.length <= 1024
		&& (identity.chatType === 1 || identity.chatType === 2) && typeof identity.userid === "string" && !!identity.userid;
}

/** Bounded newline-delimited JSON; a slow or malformed peer only loses its own connection. */
export function readFrames(socket: Socket, receive: (value: unknown) => void, onError?: (error: unknown) => void): void {
	socket.setEncoding("utf8");
	let pending = "";
	socket.on("data", (chunk: string) => {
		pending += chunk;
		let end: number;
		while ((end = pending.indexOf("\n")) >= 0) {
			const line = pending.slice(0, end);
			pending = pending.slice(end + 1);
			if (Buffer.byteLength(line) > IPC_MAX_BYTES) { onError?.(new Error("frame exceeds the IPC size limit")); socket.destroy(); return; }
			let frame: unknown;
			// Only a malformed line is expected to throw here: it ends the connection.
			try {
				frame = JSON.parse(line);
				if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("frame is not a JSON object");
			} catch (error) {
				onError?.(error);
				socket.destroy();
				return;
			}
			// A handler bug must be visible: report it and drop the connection instead of reconnecting silently.
			try {
				receive(frame);
			} catch (error) {
				onError?.(error);
				socket.destroy();
				return;
			}
			if (socket.destroyed) return;
		}
		if (Buffer.byteLength(pending) > IPC_MAX_BYTES) { onError?.(new Error("frame exceeds the IPC size limit")); socket.destroy(); }
	});
}

export function writeFrame(socket: Socket, frame: ClientFrame | ServerFrame): boolean {
	if (socket.destroyed || !socket.writable || socket.writableEnded) return false;
	const data = `${JSON.stringify(frame)}\n`;
	if (Buffer.byteLength(data) > IPC_MAX_BYTES || socket.writableLength + Buffer.byteLength(data) > IPC_MAX_BYTES * 2) {
		socket.destroy();
		return false;
	}
	try {
		// false from socket.write is backpressure, not a delivery failure.
		socket.write(data);
		return true;
	} catch {
		socket.destroy();
		return false;
	}
}
