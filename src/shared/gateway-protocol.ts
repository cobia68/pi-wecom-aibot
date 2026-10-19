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

/** The conversation of a message, as /wecom whoami reports it: chatid is the userid in a single chat. */
export interface ChatIdentity {
	chatId: string;
	chatType: 1 | 2;
	userid: string;
}

export interface GatewayStatus {
	state: WeComState;
	detail?: string;
	sessions: number;
	/** The WeCom connection gave up (subscription refused, taken over) and waits for /wecom start. */
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
	/** /wecom whoami: resolve with the next permitted message's conversation instead of routing it. */
	watchIdentity(timeoutMs: number, signal?: AbortSignal): Promise<ChatIdentity>;
}

/**
 * Same OS user + BotID share a gateway, including different pi agent directories.
 * POSIX: a socket in a private 0700 directory, so other local users can neither connect nor take the name.
 */
export function gatewayEndpoint(botId: string): string {
	const key = endpointKey(botId);
	if (process.platform === "win32") return `\\\\.\\pipe\\pi-wecom-${key}`;
	const preferred = join(homedir(), ".pi", "wecom-gateway", `${key}.sock`);
	// sun_path holds 104–108 bytes; a long home directory falls back to a short per-uid directory.
	return Buffer.byteLength(preferred) <= 100 ? preferred : join("/tmp", `pi-wecom-${process.getuid?.() ?? "user"}`, `${key}.sock`);
}

/** Where a protocol-1 gateway listens; it may still serve older pi windows after an upgrade. */
export function legacyGatewayEndpoint(botId: string): string | undefined {
	const key = endpointKey(botId);
	if (process.platform === "win32") return undefined; // Same pipe name: the version check in the handshake applies.
	if (process.platform === "linux") return `\0pi-wecom-${key}`;
	return join(tmpdir(), `pi-wecom-${key}.sock`);
}

function endpointKey(botId: string): string {
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
	return ["notification", "completion", "reply", "test"].includes(notification.kind) && validSource(notification.source)
		&& typeof notification.text === "string" && Buffer.byteLength(notification.text) <= 512 * 1024
		&& [notification.excerpt, notification.aborted].every((flag) => flag === undefined || typeof flag === "boolean");
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

/** Bounded newline-delimited JSON; a slow or malformed peer only loses its own connection. */
export function readFrames(socket: Socket, receive: (frame: any) => void): void {
	socket.setEncoding("utf8");
	let pending = "";
	socket.on("data", (chunk: string) => {
		pending += chunk;
		let end: number;
		while ((end = pending.indexOf("\n")) >= 0) {
			const line = pending.slice(0, end);
			pending = pending.slice(end + 1);
			if (Buffer.byteLength(line) > IPC_MAX_BYTES) { socket.destroy(); return; }
			try {
				const frame: unknown = JSON.parse(line);
				if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("invalid frame");
				receive(frame);
			} catch {
				socket.destroy();
				return;
			}
			if (socket.destroyed) return;
		}
		if (Buffer.byteLength(pending) > IPC_MAX_BYTES) socket.destroy();
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
