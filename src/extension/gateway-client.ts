import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DeliveryError } from "../shared/delivery.ts";
import type { GatewayNotification, NotificationSource } from "../shared/notification-types.ts";
import type { WeComConfig } from "./config.ts";
import type { ChatRef, WeComState } from "../shared/wecom-protocol.ts";
import {
	GATEWAY_PROTOCOL_VERSION, GATEWAY_RETRY_MS, IPC_HEARTBEAT_MS, IPC_LEASE_MS, IPC_SEND_TIMEOUT_MS,
	gatewayEndpoint, gatewayProof, legacyGatewayEndpoint, readFrames, sameTarget, sessionTarget, validNonce, validTask, validWelcome, verifyProof, writeFrame,
	type BridgeClient, type ChatIdentity, type GatewayCredentials, type GatewayRegistration,
	type GatewayStatus, type GatewayTask, type ServerFrame, type TaskState,
} from "../shared/gateway-protocol.ts";

const AUTH_FAILED = "共享网关认证失败：本机运行中的网关使用不同的 BotID/Secret 或插件版本。"
	+ "请在仍用旧配置的 pi 中运行 /wecom start 或 /wecom stop（旧版插件需退出该 pi），再在这里运行 /wecom start。";
const LEGACY_GATEWAY = "旧版插件的共享网关仍在运行：同一机器人只能有一个长连接。"
	+ "请在仍使用旧版插件的 pi 窗口执行 /reload 或退出，再在这里运行 /wecom start。";

export interface GatewayClientOptions {
	config: WeComConfig;
	source: NotificationSource;
	instanceId?: string;
	onState?: (state: WeComState, detail?: string) => void;
	onStatus?: (status: GatewayStatus) => void;
	onTask?: (task: GatewayTask) => void;
	onError?: (message: string) => void;
	log?: (message: string) => void;
	/** Process boundary override for offline tests. */
	launch?: (endpoint: string, credentials: GatewayCredentials) => void;
	/** How long an incompatible gateway may hold the endpoint before onError; default GATEWAY_RETRY_MS. */
	retryMs?: number;
}

export class GatewayClient implements BridgeClient {
	private readonly options: GatewayClientOptions;
	private readonly registration: GatewayRegistration;
	private readonly credentials: GatewayCredentials;
	private readonly endpoint: string;
	private socket: Socket | undefined;
	private registered = false;
	private stopped = true;
	private resumeRequested = false;
	private state: WeComState = "disconnected";
	private detail: string | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private nextLaunchAt = 0;
	private attempts = 0;
	private lastReceived = 0;
	/** Since when an incompatible gateway has held the endpoint, and which kind. */
	private blocked: { since: number; message: string } | undefined;
	private readonly pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private readonly watches = new Map<string, (error?: Error, identity?: ChatIdentity) => void>();

	constructor(options: GatewayClientOptions) {
		this.options = options;
		const { botId, secret, welcome, allowedUserIds } = options.config;
		this.credentials = { botId, secret };
		this.registration = {
			config: { botId, welcome, ...(allowedUserIds ? { allowedUserIds: [...allowedUserIds] } : {}) },
			source: { ...options.source }, instanceId: options.instanceId ?? randomUUID(), registrationId: randomUUID(),
		};
		this.endpoint = gatewayEndpoint(botId);
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.attempts = 0;
		this.blocked = undefined;
		this.connect();
	}

	resume(): void {
		if (this.isReady()) return;
		this.resumeRequested = true;
		if (this.stopped) this.start();
		else if (this.registered && this.socket) {
			writeFrame(this.socket, { type: "resume" });
		}
	}

	stop(reason = "stopped"): void {
		this.stopped = true;
		clearTimeout(this.retryTimer);
		clearInterval(this.heartbeat);
		this.retryTimer = this.heartbeat = undefined;
		const socket = this.socket;
		this.socket = undefined;
		if (socket) {
			if (this.registered) writeFrame(socket, { type: "unregister" });
			socket.end();
			// Unregister follows any final status in the same ordered channel.
			socket.setTimeout(1000, () => socket.destroy());
			socket.unref();
		}
		this.registered = false;
		this.rejectAll(reason);
		this.setState("disconnected", reason);
	}

	isReady(): boolean { return this.registered && this.state === "subscribed" && !!this.socket && !this.socket.destroyed && this.socket.writable && !this.socket.writableEnded; }

	updateSource(source: NotificationSource): void {
		if (source.sessionId !== this.registration.source.sessionId) throw new Error("session 已改变，必须重新注册网关");
		if (JSON.stringify(source) === JSON.stringify(this.registration.source)) return;
		this.registration.source = { ...source };
		if (this.registered && this.socket) writeFrame(this.socket, { type: "source", source });
	}

	updateWelcome(welcome: string): void {
		if (!validWelcome(welcome)) throw new Error("无效的欢迎语：必须是至多 16384 个字符的字符串");
		if (welcome === this.registration.config.welcome) return;
		this.registration.config = { ...this.registration.config, welcome };
		if (this.registered && this.socket) writeFrame(this.socket, { type: "welcome", text: welcome });
	}

	taskStatus(taskId: string, state: TaskState): boolean {
		return this.isReady() && writeFrame(this.socket!, { type: "status", taskId, state });
	}

	notify(chat: ChatRef, notification: GatewayNotification): Promise<void> {
		if (notification.source.sessionId !== this.registration.source.sessionId) return Promise.reject(new DeliveryError("通知 session 与注册会话不匹配，已拒绝发送", "rejected"));
		if (!this.isReady()) return Promise.reject(new DeliveryError("共享网关或企微连接未就绪", "not_sent"));
		return new Promise((resolve, reject) => {
			const id = randomUUID();
			const timer = setTimeout(() => { this.pending.delete(id); reject(new DeliveryError("网关通知确认超时，发送结果未知")); }, IPC_SEND_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			if (!writeFrame(this.socket!, { type: "notify", id, chat, notification })) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new DeliveryError("网关连接已断开，发送结果未知"));
			}
		});
	}

	/** Rejects with name "TimeoutError" when no permitted message arrives, "AbortError" when cancelled. */
	watchIdentity(timeoutMs: number, signal?: AbortSignal): Promise<ChatIdentity> {
		if (!this.isReady()) return Promise.reject(new Error("共享网关或企微连接未就绪"));
		if (signal?.aborted) return Promise.reject(named("AbortError", "whoami 已取消"));
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const finish = (error?: Error, identity?: ChatIdentity) => {
				if (!this.watches.delete(id)) return;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (error) {
					// Release the gateway's hold so a later message is routed normally again.
					if (this.registered && this.socket) writeFrame(this.socket, { type: "unwatch", id });
					reject(error);
				} else resolve(identity!);
			};
			const onAbort = () => finish(named("AbortError", "whoami 已取消"));
			const timer = setTimeout(() => finish(named("TimeoutError", `${Math.round(timeoutMs / 1000)} 秒内没有收到可识别的消息`)), timeoutMs);
			this.watches.set(id, finish);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (!writeFrame(this.socket!, { type: "watch", id, timeoutMs })) finish(new Error("网关连接已断开，whoami 未开始"));
		});
	}

	private connect(): void {
		if (this.stopped || this.socket) return;
		this.setState("connecting", "正在注册本机共享网关");
		const socket = createConnection(this.endpoint);
		this.socket = socket;
		const nonce = randomUUID();
		let handshake = false;
		let missing = false;
		let rejected = false;
		socket.setTimeout(5000, () => socket.destroy(new Error("网关注册超时")));
		socket.on("error", (error: NodeJS.ErrnoException) => {
			missing = error.code === "ENOENT" || error.code === "ECONNREFUSED";
			if (!missing) this.options.log?.(`gateway connection: ${error.message}`);
		});
		socket.on("close", () => {
			if (this.socket !== socket) return;
			this.socket = undefined;
			this.registered = false;
			clearInterval(this.heartbeat);
			this.heartbeat = undefined;
			this.rejectAll("网关连接已断开，发送结果未知");
			if (rejected && this.block(AUTH_FAILED)) return;
			this.setState("disconnected", rejected ? "共享网关认证失败，等待旧网关退出后重试" : "本机共享网关连接已断开");
			if (missing && Date.now() >= this.nextLaunchAt) {
				this.nextLaunchAt = Date.now() + 5000;
				void this.launch();
			}
			this.retry();
		});
		// The client speaks first; the gateway proves the Secret over this nonce before it learns anything.
		socket.once("connect", () => writeFrame(socket, { type: "hello", version: GATEWAY_PROTOCOL_VERSION, nonce }));
		readFrames(socket, (frame: ServerFrame) => {
			if (this.socket !== socket || this.stopped) return;
			this.lastReceived = Date.now();
			if (!handshake) {
				if (frame.type !== "hello" || frame.version !== GATEWAY_PROTOCOL_VERSION || frame.endpoint !== this.endpoint || !validNonce(frame.nonce)
					|| !verifyProof(frame.proof, gatewayProof(this.credentials.secret, "server", frame.nonce, nonce, this.endpoint))) {
					// Not final: the close handler retries until the retry window has passed.
					rejected = true;
					socket.destroy();
					return;
				}
				handshake = true;
				this.blocked = undefined;
				// Credentials reach a new daemon only through the private bootstrap pipe.
				writeFrame(socket, { type: "register", registration: this.registration, resume: this.resumeRequested,
					proof: gatewayProof(this.credentials.secret, "client", frame.nonce, nonce, this.endpoint) });
				return;
			}
			if (frame.type === "fatal") { this.fail(frame.message); return; }
			if (frame.type === "registered") {
				if (this.registered) { this.fail("重复的网关注册响应"); return; }
				this.registered = true;
				this.attempts = 0;
				writeFrame(socket, { type: "source", source: this.registration.source });
				// Include changes made after register was written but before its ACK arrived.
				writeFrame(socket, { type: "welcome", text: this.registration.config.welcome });
				socket.setTimeout(0);
				this.heartbeat = setInterval(() => {
					if (Date.now() - this.lastReceived > IPC_LEASE_MS) socket.destroy();
					else writeFrame(socket, { type: "ping" });
				}, IPC_HEARTBEAT_MS);
				this.heartbeat.unref();
				this.status(frame.status);
				return;
			}
			if (!this.registered) { this.fail("网关在注册确认前发送了消息"); return; }
			switch (frame.type) {
				case "status": this.status(frame.status); return;
				case "pong": return;
				case "log": this.options.log?.(frame.message); return;
				case "task":
					if (!sameTarget(frame.target, sessionTarget(this.registration))) {
						this.options.log?.("rejected inbound task for a different pi/session registration");
						return;
					}
					if (!validTask(frame.task)) { this.options.log?.("rejected malformed inbound task"); return; }
					this.options.onTask?.(frame.task);
					return;
				case "result": {
					const pending = this.pending.get(frame.id);
					if (!pending) return;
					this.pending.delete(frame.id);
					clearTimeout(pending.timer);
					if (frame.error) pending.reject(new DeliveryError(frame.error, frame.outcome));
					else pending.resolve();
					return;
				}
				case "identity": {
					const identity = frame.identity;
					if (typeof identity?.chatId !== "string" || !identity.chatId || ![1, 2].includes(identity.chatType) || typeof identity.userid !== "string") return;
					this.watches.get(frame.id)?.(undefined, { chatId: identity.chatId, chatType: identity.chatType, userid: identity.userid });
					return;
				}
			}
		});
	}

	/**
	 * An incompatible gateway holds the endpoint, typically until its idle exit after the last pi left.
	 * true once it has done so for the whole retry window: then the error is reported and retrying ends.
	 */
	private block(message: string): boolean {
		if (this.blocked?.message !== message) this.blocked = { since: Date.now(), message };
		if (Date.now() - this.blocked.since < (this.options.retryMs ?? GATEWAY_RETRY_MS)) return false;
		this.fail(message);
		return true;
	}

	private retry(): void {
		if (this.stopped || this.retryTimer) return;
		const delay = Math.min(2000, 100 * 2 ** Math.min(this.attempts++, 5));
		this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.connect(); }, delay);
		this.retryTimer.unref();
	}

	/** Never start a gateway beside a protocol-1 one: both would claim the bot's single WeCom connection. */
	private async launch(): Promise<void> {
		const legacy = legacyGatewayEndpoint(this.credentials.botId);
		if (legacy && await reachable(legacy)) {
			if (this.stopped || this.block(LEGACY_GATEWAY)) return;
			this.nextLaunchAt = 0;
			this.setState("disconnected", "旧版插件的共享网关仍在运行，等待其退出");
			return;
		}
		if (this.stopped) return;
		this.blocked = undefined;
		try {
			if (this.options.launch) this.options.launch(this.endpoint, this.credentials);
			else launchGateway(this.endpoint, this.credentials, this.options.log);
		} catch (error) { this.options.log?.(`gateway launch failed: ${String(error)}`); }
	}

	private status(status: GatewayStatus): void {
		if (status.state === "subscribed") this.resumeRequested = false;
		this.options.onStatus?.(status);
		this.setState(status.state, status.detail);
	}

	private fail(message: string): void {
		this.options.log?.(message);
		this.stop(message);
		this.options.onError?.(message);
	}

	private setState(state: WeComState, detail?: string): void {
		if (this.state === state && this.detail === detail) return;
		this.state = state;
		this.detail = detail;
		this.options.onState?.(state, detail);
	}

	private rejectAll(reason: string): void {
		for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new DeliveryError(reason)); }
		this.pending.clear();
		// The gateway forgets a closed connection's whoami, so the local wait ends too.
		for (const finish of [...this.watches.values()]) finish(new Error(`连接已断开：${reason}`));
	}
}

function named(name: "AbortError" | "TimeoutError", message: string): Error {
	return Object.assign(new Error(message), { name });
}

function reachable(endpoint: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createConnection(endpoint);
		probe.setTimeout(1000, () => { probe.destroy(); resolve(false); });
		probe.once("connect", () => { probe.destroy(); resolve(true); });
		probe.once("error", () => { probe.destroy(); resolve(false); });
	});
}

export function launchGateway(endpoint: string, credentials: GatewayCredentials, log?: (message: string) => void): void {
	const entry = fileURLToPath(new URL("../gateway/main.mjs", import.meta.url));
	const executable = /^node(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : "node";
	const child = spawn(executable, [entry], { cwd: dirname(entry), detached: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
	// A short private pipe bootstraps credentials without files, environment variables or argv.
	child.on("error", (error) => log?.(`gateway launch failed: ${error.message}`));
	child.on("exit", (code) => { if (code) log?.(`gateway process exited (${code}); check Node.js and runtime dependencies`); });
	child.stdin.on("error", () => {});
	child.stdin.end(JSON.stringify({ endpoint, credentials: { botId: credentials.botId, secret: credentials.secret } }));
	child.unref();
}
