import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
// Installs the same local TS loader as the real detached gateway.
import "../../src/gateway/main.mjs";
import { GatewayClient } from "../../src/extension/gateway-client.ts";
import { notificationPayload } from "../../src/shared/notification.ts";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { config, source } = JSON.parse(input);
const report = (message) => { if (process.connected) process.send(message); };
const client = new GatewayClient({ config, source,
  onState: (state, detail) => report({ type: "state", state, detail }),
  onTask: (task) => report({ type: "inbound", task }),
  log: (message) => report({ type: "log", message }),
  launch(endpoint, credentials) {
    const entry = fileURLToPath(new URL("./gateway-worker.mjs", import.meta.url));
    const child = spawn(process.execPath, [entry, process.argv[2]], { detached: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", (error) => report({ type: "error", error: error.message }));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ endpoint, credentials }));
    child.once("spawn", () => report({ type: "daemon", pid: child.pid }));
    child.unref();
  },
});
process.on("message", async (message) => {
  if (message.type === "send") {
    try {
      await client.notify({ chatId: message.chatId, chatType: message.chatType ?? 1 }, notificationPayload("notification", source, message.content));
      report({ type: "sent", id: message.id });
    } catch (error) { report({ type: "send-error", id: message.id, error: String(error) }); }
  }
  if (message.type === "quit") { client.stop(); process.disconnect(); }
});
client.start();
