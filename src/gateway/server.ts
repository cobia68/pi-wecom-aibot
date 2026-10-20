import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { deliveryFailure } from "../shared/delivery.ts";
import type { WeComClientOptions } from "./wecom-client.ts";
import { WeComGateway, type GatewayPeer } from "./runtime.ts";
import { GatewaySelectionStore } from "./selection-store.ts";
import {
	GATEWAY_IDLE_MS, GATEWAY_PROTOCOL_VERSION, IPC_LEASE_MS, gatewayEndpoint, gatewayProof, parseClientFrame, readFrames,
	validRegistration, verifyProof, writeFrame,
	type ClientFrame, type GatewayCredentials, type GatewayRegistration, type ServerFrame,
} from "../shared/gateway-protocol.ts";

export interface GatewayServerOptions extends Pick<WeComClientOptions, "createWebSocket"> {
	endpoint: string;
	credentials: GatewayCredentials;
	idleTimeoutMs?: number;
	startupTimeoutMs?: number;
	routingStateFile?: string;
}

export interface GatewayServer {
	readonly gateway: WeComGateway;
	readonly closed: Promise<void>;
	close(): void;
}

/** Binding elects one owner before it opens any upstream connection. */
export async function startGatewayServer(options: GatewayServerOptions): Promise<GatewayServer | undefined> {
	const { botId, secret } = options.credentials;
	if (options.endpoint !== gatewayEndpoint(botId)) throw new Error("invalid gateway endpoint");
	const sockets = new Set<Socket>();
	let stopping = false;
	let started = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let finish!: () => void;
	const closed = new Promise<void>((resolve) => { finish = resolve; });
	const server = createServer((socket) => accept(socket));
	const selectionStore = options.routingStateFile ? new GatewaySelectionStore(options.routingStateFile) : undefined;
	const gateway = new WeComGateway({ botId, secret, createWebSocket: options.createWebSocket }, updateIdleTimer, selectionStore);

	/** One timer owner for initialization and membership changes; listening may admit a pi before chmod ends. */
	function updateIdleTimer(): void {
		clearTimeout(idleTimer);
		idleTimer = undefined;
		if (gateway.size) { started = true; return; }
		if (stopping) return;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			if (stopping || gateway.size) return;
			if (started) { try { selectionStore?.clear(); } catch { /* retained bindings fail closed on the next startup */ } }
			close();
		}, started ? options.idleTimeoutMs ?? GATEWAY_IDLE_MS : options.startupTimeoutMs ?? 15_000);
	}

	function close(): void {
		if (stopping) return;
		stopping = true;
		clearTimeout(idleTimer);
		// Stop accepting registrations before tearing down the last connection.
		server.close(() => finish());
		gateway.stop();
		for (const socket of sockets) socket.destroy();
	}

	function accept(socket: Socket): void {
		if (stopping) { socket.destroy(); return; }
		sockets.add(socket);
		let registration: GatewayRegistration | undefined;
		let clientNonce: string | undefined;
		const nonce = randomUUID();
		const pending = new Set<string>();
		const peer: GatewayPeer = { send: (frame) => writeFrame(socket, frame), close: () => socket.destroy() };
		const send = (frame: ServerFrame) => peer.send(frame);
		const fail = (message: string) => {
			send({ type: "fatal", message });
			socket.end();
		};
		// Nothing is sent before the client's hello: a peer that only listens learns nothing.
		socket.setTimeout(5000, () => socket.destroy());
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			sockets.delete(socket);
			if (registration) gateway.unregister(registration.instanceId, peer);
		});
		readFrames(socket, (value) => {
			if (socket.writableEnded) return;
			if (!clientNonce) { acceptHello(value); return; }
			if (!registration) { acceptRegister(value); return; }
			acceptRequest(value, registration);
		}, (error) => {
			// A frame this connection cannot even be parsed or handled is a bug, not a retry: say so in pi's log.
			gateway.log(`共享网关 IPC 帧处理失败：${errorMessage(error)}`);
		});

		/** The shape is the parser's job; the phase order and the Secret are this connection's. */
		function acceptHello(value: unknown): void {
			const parsed = parseClientFrame(value);
			if (!parsed.ok || parsed.frame.type !== "hello") { fail("共享网关协议版本不兼容，请退出使用该机器人的全部 pi 后重新打开"); return; }
			if (parsed.frame.version !== GATEWAY_PROTOCOL_VERSION) { fail("共享网关协议版本不兼容，请退出使用该机器人的全部 pi 后重新打开"); return; }
			clientNonce = parsed.frame.nonce;
			send({ type: "hello", version: GATEWAY_PROTOCOL_VERSION, endpoint: options.endpoint, nonce,
				proof: gatewayProof(secret, "server", nonce, clientNonce, options.endpoint) });
		}

		function acceptRegister(value: unknown): void {
			const parsed = parseClientFrame(value);
			if (!parsed.ok || parsed.frame.type !== "register") { fail("网关认证失败"); return; }
			const frame = parsed.frame;
			if (!verifyProof(frame.proof, gatewayProof(secret, "client", nonce, clientNonce!, options.endpoint))) { fail("网关认证失败"); return; }
			const candidate = copyRegistration(frame.registration);
			if (!candidate) { fail("无效的 pi 注册信息"); return; }
			try {
				gateway.register(candidate, peer, frame.resume === true);
				registration = candidate;
				socket.setTimeout(IPC_LEASE_MS);
			} catch (error) { fail(errorMessage(error)); }
		}

		/** The gateway refuses an operation with a message; a malformed frame never reaches these calls. */
		function acceptRequest(value: unknown, registered: GatewayRegistration): void {
			const parsed = parseClientFrame(value);
			if (!parsed.ok) { fail(parsed.reason); return; }
			const frame = parsed.frame;
			if (frame.type === "hello" || frame.type === "register") { fail("该连接已完成握手"); return; }
			try {
				if (!gateway.owns(registered.instanceId, peer)) { fail("该 pi 注册已失效，已拒绝旧连接的请求"); return; }
				switch (frame.type) {
					case "ping": send({ type: "pong" }); return;
					case "resume": gateway.resume(); return;
					case "unregister":
						gateway.unregister(registered.instanceId, peer);
						socket.end();
						return;
					case "source":
						gateway.updateSource(registered.instanceId, frame.source);
						return;
					case "welcome":
						gateway.updateWelcome(registered.instanceId, frame.text);
						return;
					case "status":
						gateway.taskStatus(registered.instanceId, frame.taskId, frame.state);
						return;
					case "notify": {
						if (pending.has(frame.id) || pending.size >= 100) { fail("请求重复或未确认通知过多"); return; }
						pending.add(frame.id);
						void gateway.notify(registered.instanceId, frame.chat, frame.notification)
							.then(() => send({ type: "result", id: frame.id }))
							.catch((error: unknown) => send({ type: "result", id: frame.id, error: errorMessage(error), outcome: deliveryFailure(error) }))
							.finally(() => pending.delete(frame.id));
						return;
					}
					case "watch":
						gateway.watch(registered.instanceId, frame.id, frame.timeoutMs);
						return;
					case "unwatch":
						gateway.unwatch(registered.instanceId, frame.id);
						return;
				}
			} catch (error) { fail(errorMessage(error)); }
		}
	}

	try {
		if (filesystemSocket(options.endpoint)) await privateDirectory(dirname(options.endpoint));
		if (!await listen(server, options.endpoint)) return undefined;
	} catch (error) {
		close();
		throw error;
	}
	server.on("error", close);
	try { if (filesystemSocket(options.endpoint)) await chmod(options.endpoint, 0o600); }
	catch (error) { close(); throw error; }
	updateIdleTimer();
	return { gateway, closed, close };
}

/** Only the known fields, so nothing a client adds reaches routing state. */
function copyRegistration(value: unknown): GatewayRegistration | undefined {
	if (!validRegistration(value)) return undefined;
	const { instanceId, registrationId, source, config } = value;
	return {
		instanceId, registrationId,
		source: { sessionId: source.sessionId, provider: source.provider, modelName: source.modelName, directoryName: source.directoryName },
		config: { botId: config.botId, welcome: config.welcome, ...(config.allowedUserIds ? { allowedUserIds: [...config.allowedUserIds] } : {}) },
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function filesystemSocket(endpoint: string): boolean {
	return process.platform !== "win32" && !endpoint.startsWith("\0");
}

/** The socket's directory belongs to this user alone: other local users cannot connect or take the name. */
async function privateDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	const uid = process.getuid?.();
	if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) throw new Error(`gateway directory is not private: ${directory}`);
	if (info.mode & 0o077) await chmod(directory, 0o700);
}

async function bind(server: Server, endpoint: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const error = (err: Error) => { server.off("listening", ready); reject(err); };
		const ready = () => { server.off("error", error); resolve(); };
		server.once("error", error);
		server.once("listening", ready);
		server.listen(endpoint);
	});
}

async function listen(server: Server, endpoint: string): Promise<boolean> {
	try { await bind(server, endpoint); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		if (!filesystemSocket(endpoint)) return false;
	}
	// A short-lived kernel mutex serializes stale-file recovery: concurrent
	// cleaners must never unlink a newly bound socket.
	const mutex = createServer((socket) => socket.destroy());
	const port = 49_152 + createHash("sha256").update(endpoint).digest().readUInt16BE(0) % 16_384;
	try {
		await new Promise<void>((resolve, reject) => {
			mutex.once("error", reject);
			mutex.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
		throw error;
	}
	try { return await recoverSocket(server, endpoint); }
	finally { await new Promise<void>((resolve) => mutex.close(() => resolve())); }
}

async function recoverSocket(server: Server, endpoint: string): Promise<boolean> {
	const before = await lstat(endpoint).catch(() => undefined);
	if (!before?.isSocket()) return false;
	const refused = await new Promise<boolean>((resolve) => {
		const probe = createConnection(endpoint);
		probe.setTimeout(1000, () => { probe.destroy(); resolve(false); });
		probe.once("connect", () => { probe.destroy(); resolve(false); });
		probe.once("error", (error: NodeJS.ErrnoException) => { probe.destroy(); resolve(error.code === "ECONNREFUSED"); });
	});
	if (!refused) return false;
	const after = await lstat(endpoint).catch(() => undefined);
	if (!after || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs) return false;
	await unlink(endpoint).catch(() => {});
	try { await bind(server, endpoint); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false; throw error; }
}
