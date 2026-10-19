import WebSocket from "ws";
import { bootstrap } from "../../src/gateway/main.mjs";

await bootstrap({ createWebSocket: () => new WebSocket(process.argv[2]), idleTimeoutMs: 150, startupTimeoutMs: 5000, routingStateFile: undefined });
