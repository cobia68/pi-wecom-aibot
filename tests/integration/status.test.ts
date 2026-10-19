import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { after, afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GatewayClientOptions } from "../../src/extension/gateway-client.ts";
import type { BridgeClient, GatewayStatus } from "../../src/shared/gateway-protocol.ts";
import type { WeComState } from "../../src/shared/wecom-protocol.ts";
import { fixtureTheme } from "../support/screen-fixture.ts";

const sandbox = await mkdtemp(join(tmpdir(), "pi-wecom-status-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = sandbox;
const { default: extension } = await import("../../src/extension/index.ts");
const { saveConfig, clearConfig } = await import("../../src/extension/config.ts");
const config = { botId: "private-bot-id", secret: "private-secret", enabled: true, welcome: "hello" };
const key = "wecom-bot";
const theme = fixtureTheme("dark");
const label = (color: "success" | "warning" | "error") => theme.fg(color, "wecom-bot");
type Handler = (event: any, ctx: ExtensionContext) => unknown;
let instances: { emit(name: string): Promise<void> }[];

/** A controllable IPC seam: status metadata precedes state callbacks, just as in GatewayClient. */
function connection(options: GatewayClientOptions) {
  let ready = false;
  let state: WeComState = "disconnected";
  let detail: string | undefined;
  const client: BridgeClient = {
    start() { state = "connecting"; options.onState?.(state); },
    stop(reason) { ready = false; state = "disconnected"; detail = reason; options.onState?.(state, detail); },
    isReady: () => ready,
    updateSource() {}, updateWelcome() {}, resume() {},
    taskStatus: () => ready,
    async notify() { if (!ready) throw new Error("not connected"); },
    async watchIdentity() { throw new Error("identity is not used by status tests"); },
  };
  return {
    client,
    publish(status: GatewayStatus, canSend = status.state === "subscribed") {
      ready = canSend;
      options.onStatus?.(status);
      if (state === status.state && detail === status.detail) return;
      state = status.state;
      detail = status.detail;
      options.onState?.(state, detail);
    },
    fail(message: string) { ready = false; options.onError?.(message); },
  };
}

function harness(mode: ExtensionContext["mode"] = "tui") {
  const handlers = new Map<string, Handler[]>();
  const clients: ReturnType<typeof connection>[] = [];
  const statuses = new Map<string, string>([["another-extension", "Other status"]]);
  const changes: (string | undefined)[] = [];
  const notices: string[] = [];
  const state = { sessionId: `session-${instances.length}` };
  let command!: (input: string, ctx: ExtensionContext) => Promise<void>;
  const ctx = {
    mode, hasUI: mode === "tui" || mode === "rpc", cwd: sandbox, isIdle: () => true,
    model: { id: "model", name: "Model", provider: "provider" },
    sessionManager: { getSessionId: () => state.sessionId, getBranch: () => [], getLeafId: () => null },
    ui: {
      notify: (message: string) => notices.push(message),
      confirm: async () => true,
      setWidget() {},
      setStatus(statusKey: string, text: string | undefined) {
        assert.equal(statusKey, key, "the extension owns only its status entry");
        changes.push(text);
        if (text === undefined) statuses.delete(statusKey);
        else statuses.set(statusKey, text);
      },
      setFooter() { assert.fail("must not replace the user's footer"); },
      theme,
    },
  } as unknown as ExtensionContext;
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {}; },
    registerCommand(_name: string, options: { handler: typeof command }) { command = options.handler; },
    registerTool() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI;
  extension(pi, { createClient(options) { const control = connection(options); clients.push(control); return control.client; } });
  const result = {
    ctx, state, clients, statuses, changes, notices,
    command: (input: string) => command(input, ctx),
    async emit(name: string) { for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx); },
  };
  instances.push(result);
  return result;
}

beforeEach(() => { instances = []; saveConfig(config); });
afterEach(async () => { for (const instance of instances) await instance.emit("session_shutdown"); });
after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  assert.equal(dirname(sandbox), tmpdir());
  await rm(sandbox, { recursive: true, force: true });
});

test("loading a configured extension does not show its name until the bridge starts", async () => {
  const h = harness();
  assert.equal(h.clients.length, 0);
  assert.deepEqual(h.changes, []);
  await h.emit("session_start");
  assert.equal(h.clients.length, 1);
  assert.equal(h.statuses.get(key), label("warning"));
});

test("the footer stays empty when unconfigured or disabled; querying status never starts it", async () => {
  clearConfig();
  const unconfigured = harness();
  await unconfigured.emit("session_start");
  await unconfigured.command("--help");
  assert.equal(unconfigured.clients.length, 0);
  assert.deepEqual(unconfigured.changes, []);
  saveConfig({ ...config, enabled: false });
  const disabled = harness();
  await disabled.emit("session_start");
  await disabled.command("status");
  await disabled.emit("model_select");
  assert.equal(disabled.clients.length, 0);
  assert.deepEqual(disabled.changes, []);
  await disabled.command("start");
  assert.equal(disabled.statuses.get(key), label("warning"));
});

test("green means ready, not just an open socket; metadata never changes the name or its color", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.equal(h.statuses.get(key), label("warning"));
  const client = h.clients[0];
  client.publish({ state: "connected", sessions: 1 });
  assert.equal(h.statuses.get(key), label("warning"), "subscription has not completed");
  client.publish({ state: "subscribed", sessions: 1 });
  assert.equal(h.statuses.get(key), label("success"));
  const count = h.changes.length;
  client.publish({ state: "subscribed", sessions: 99, detail: "private-secret\n\x1b[2Jprivate-chat" });
  await h.emit("model_select");
  assert.equal(h.changes.length, count);
  for (const text of h.changes) if (text !== undefined) assert.equal(stripVTControlCharacters(text), "wecom-bot");
  assert.doesNotMatch(h.changes.join("\n"), /private|session-|\x1b\[2J/);
  client.publish({ state: "subscribed", sessions: 99 }, false);
  assert.equal(h.statuses.get(key), label("warning"), "an unusable transport must not appear green");
});

test("connection events automatically change green to yellow or red, then back to green after recovery", async () => {
  const h = harness();
  await h.emit("session_start");
  const client = h.clients[0];
  client.publish({ state: "subscribed", sessions: 1 });
  client.publish({ state: "disconnected", sessions: 1, detail: "outage" });
  assert.equal(h.statuses.get(key), label("warning"));
  client.publish({ state: "disconnected", sessions: 1, detail: "outage", stopped: true });
  assert.equal(h.statuses.get(key), label("error"), "the state callback need not run when only stopped changes");
  await h.command("start");
  assert.equal(h.clients.length, 1, "resuming an upstream must not replace the local bridge");
  client.publish({ state: "connecting", sessions: 1 });
  assert.equal(h.statuses.get(key), label("warning"));
  client.publish({ state: "subscribed", sessions: 1 });
  assert.equal(h.statuses.get(key), label("success"));
});

test("a stopped first subscription colors the name red", async () => {
  const h = harness();
  await h.emit("session_start");
  h.clients[0].publish({ state: "disconnected", sessions: 1, stopped: true, detail: "subscribe refused" });
  assert.equal(h.statuses.get(key), label("error"));
});

test("stop clears only this extension's entry, and late callbacks cannot overwrite a restarted bridge", async () => {
  const h = harness();
  await h.emit("session_start");
  const old = h.clients[0];
  old.publish({ state: "subscribed", sessions: 1 });
  await h.command("stop");
  assert.equal(h.statuses.has(key), false);
  assert.equal(h.statuses.get("another-extension"), "Other status");
  const count = h.changes.length;
  await h.command("status");
  await h.emit("model_select");
  old.publish({ state: "subscribed", sessions: 3, detail: "late" });
  old.fail("late registration failure");
  assert.equal(h.changes.length, count);
  await h.command("start");
  assert.equal(h.statuses.get(key), label("warning"));
  old.publish({ state: "disconnected", sessions: 0, stopped: true });
  assert.equal(h.statuses.get(key), label("warning"));
  h.clients[1].publish({ state: "subscribed", sessions: 1 });
  assert.equal(h.statuses.get(key), label("success"));
});

test("session replacement clears the old entry and cannot inherit its connection status", async () => {
  const h = harness();
  await h.emit("session_start");
  const old = h.clients[0];
  old.publish({ state: "subscribed", sessions: 1 });
  h.state.sessionId = "replacement-session";
  await h.emit("model_select");
  assert.equal(h.statuses.has(key), false, "a bridge for a different session is not this session's connection");
  await h.emit("session_start");
  assert.equal(h.statuses.get(key), label("warning"));
  old.publish({ state: "subscribed", sessions: 1, detail: "late" });
  assert.equal(h.statuses.get(key), label("warning"));
  h.clients[1].publish({ state: "subscribed", sessions: 1 });
  assert.equal(h.statuses.get(key), label("success"));
});

for (const end of ["logout", "session_shutdown", "fatal"] as const) {
  test(`${end} removes the status instead of leaving an apparently online bot`, async () => {
    const h = harness();
    await h.emit("session_start");
    const client = h.clients[0];
    client.publish({ state: "subscribed", sessions: 1 });
    assert.equal(h.statuses.get(key), label("success"));
    if (end === "logout") await h.command("logout");
    else if (end === "fatal") client.fail("registration rejected");
    else await h.emit("session_shutdown");
    assert.equal(h.statuses.has(key), false);
    const count = h.changes.length;
    client.publish({ state: "subscribed", sessions: 1, detail: "late" });
    assert.equal(h.changes.length, count);
    if (end === "fatal") assert.ok(h.notices.some((message) => message.includes("registration rejected")));
  });
}

for (const mode of ["rpc", "json", "print"] as const) {
  test(`${mode} mode still connects without producing terminal status updates`, async () => {
    const h = harness(mode);
    await h.emit("session_start");
    h.clients[0].publish({ state: "subscribed", sessions: 1 });
    assert.equal(h.clients[0].client.isReady(), true);
    await h.command("stop");
    assert.deepEqual(h.changes, []);
  });
}

test("one pi stopping cannot remove another pi's status", async () => {
  const a = harness();
  const b = harness();
  await a.emit("session_start");
  await b.emit("session_start");
  a.clients[0].publish({ state: "subscribed", sessions: 2 });
  b.clients[0].publish({ state: "subscribed", sessions: 2 });
  await a.command("stop");
  assert.equal(a.statuses.has(key), false);
  assert.equal(b.statuses.get(key), label("success"));
});
