import "../support/home-sandbox.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { GatewayClient } from "../../src/extension/gateway-client.ts";
import { startGatewayServer } from "../../src/gateway/server.ts";
import { gatewayEndpoint } from "../../src/shared/gateway-protocol.ts";
import { FakeWebSocket } from "../support/fake-websocket.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("startup timeout cannot close a gateway registered before socket permissions finish", {
	timeout: 5000,
	skip: process.platform === "win32",
}, async (t) => {
	const config = { botId: `startup-${randomUUID()}`, secret: "offline-test-secret", enabled: true };
	const original = fs.chmod;
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const hitGate = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const chmod = t.mock.method(fs, "chmod", async (...[path, mode]: Parameters<typeof fs.chmod>) => {
		if (String(path).endsWith(".sock")) {
			entered();
			await gate;
		}
		return original(path, mode);
	});
	syncBuiltinESMExports();
	const starting = startGatewayServer({
		endpoint: gatewayEndpoint(config.botId),
		credentials: config,
		startupTimeoutMs: 60,
		createWebSocket(url) {
			const socket = new FakeWebSocket(url);
			socket.onSend = (frame) => socket.acknowledge(frame);
			queueMicrotask(() => socket.open());
			return socket;
		},
	});
	const client = new GatewayClient({
		config,
		source: { sessionId: "startup-session", provider: "p", modelName: "m", directoryName: "d" },
		launch() {
			throw new Error("offline test: no real daemon or upstream may be launched");
		},
	});
	let server: Awaited<typeof starting>;
	t.after(async () => {
		release();
		chmod.mock.restore();
		syncBuiltinESMExports();
		client.stop();
		server ??= await starting;
		server?.close();
		await server?.closed;
	});
	await hitGate;
	client.start();
	const deadline = Date.now() + 2000;
	while (!client.isReady()) {
		assert.ok(Date.now() < deadline, "client registers before delayed chmod completes");
		await pause(5);
	}
	release();
	server = await starting;
	assert.ok(server);
	assert.equal(server.gateway.size, 1);
	let closed = false;
	void server.closed.then(() => {
		closed = true;
	});
	await pause(120);
	assert.equal(closed, false, "an active registration cancels startup recycling, even during initialization");
	assert.equal(server.gateway.size, 1);
});
