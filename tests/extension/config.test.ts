import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";

const sandbox = mkdtempSync(join(tmpdir(), "pi-wecom-aibot-config-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = sandbox;
const { CONFIG_FILE, clearConfig, loadConfig, updateConfig } = await import("../../src/extension/config.ts");
const readJson = () => JSON.parse(readFileSync(CONFIG_FILE, "utf8"));

beforeEach(() => {
  // Only the link itself when the file is a symlink.
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  rmSync(CONFIG_FILE, { force: true });
});

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  assert.equal(dirname(sandbox), tmpdir());
  rmSync(sandbox, { recursive: true, force: true });
});

test("updateConfig merges into the file as it is now, keeping hand edits and unknown fields", () => {
  writeFileSync(CONFIG_FILE, JSON.stringify({ botId: "bot", secret: "old", allowedUserIds: ["boss"], futureField: { kept: true } }));
  const config = updateConfig({ secret: "rotated", defaultChatId: "boss", defaultChatType: 1 });
  assert.deepEqual(config.allowedUserIds, ["boss"]);
  assert.equal(config.secret, "rotated");
  assert.deepEqual(readJson(), {
    sendMode: "text", botId: "bot", secret: "rotated",
    allowedUserIds: ["boss"], futureField: { kept: true }, defaultChatId: "boss", defaultChatType: 1,
  });
  assert.deepEqual(readdirSync(sandbox).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left behind");
});

test("updateConfig never creates a configuration without credentials", () => {
  assert.throws(() => updateConfig({ sendMode: "image" }), /\/wecom-aibot setup/);
  assert.throws(() => readFileSync(CONFIG_FILE), { code: "ENOENT" });
  updateConfig({ botId: "bot", secret: "secret" });
  assert.deepEqual(loadConfig(), { botId: "bot", secret: "secret", sendMode: "text", allowedUserIds: undefined, defaultChatId: undefined, defaultChatType: undefined });
  if (process.platform !== "win32") assert.equal(statSync(CONFIG_FILE).mode & 0o777, 0o600);
});

test("conditional configuration updates refuse another bot, a rotated Secret, or a deleted file", () => {
  const expected = { botId: "bot-A", secret: "secret-A" };
  for (const replacement of [{ botId: "bot-B", secret: "secret-B" }, { botId: "bot-A", secret: "rotated" }]) {
    writeFileSync(CONFIG_FILE, JSON.stringify(replacement));
    const before = readFileSync(CONFIG_FILE, "utf8");
    assert.throws(() => updateConfig({ defaultChatId: "old-bot-user" }, expected), /配置已改变|配置已删除/);
    assert.equal(readFileSync(CONFIG_FILE, "utf8"), before);
  }
  clearConfig();
  assert.throws(() => updateConfig({ defaultChatId: "old-bot-user" }, expected), /配置已改变|配置已删除/);
  assert.equal(loadConfig(), undefined);
});

test("conditional target updates still preserve unrelated edits for the same bot", () => {
  const expected = { botId: "bot-A", secret: "secret-A" };
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...expected, allowedUserIds: ["boss"], futureField: true }));
  const saved = updateConfig({ defaultChatId: "boss", defaultChatType: 1 }, expected);
  assert.equal(saved.defaultChatId, "boss");
  assert.equal(Object.hasOwn(saved, "futureField"), false, "unknown fields stay out of the runtime configuration");
  assert.deepEqual(saved.allowedUserIds, ["boss"]);
  assert.equal(readJson().futureField, true);
});

test("clearConfig succeeds when absent, but never hides a real filesystem deletion error", (t) => {
  clearConfig();
  updateConfig({ botId: "bot", secret: "secret" });
  clearConfig();
  assert.equal(loadConfig(), undefined);
  mkdirSync(CONFIG_FILE);
  writeFileSync(join(CONFIG_FILE, "kept"), "must not be removed recursively");
  t.after(() => rmSync(CONFIG_FILE, { recursive: true, force: true }));
  assert.throws(() => clearConfig());
  assert.equal(readFileSync(join(CONFIG_FILE, "kept"), "utf8"), "must not be removed recursively");
});

test("new configurations do not persist a connection preference", () => {
  updateConfig({ botId: "bot", secret: "secret" });
  assert.equal(Object.hasOwn(loadConfig()!, "enabled"), false);
  assert.equal(Object.hasOwn(readJson(), "enabled"), false);
});
test("a stored field this version does not know is ignored and preserved", () => {
  const stored = { botId: "bot", secret: "secret", futureField: { kept: true }, anotherField: [1, 2] };
  writeFileSync(CONFIG_FILE, JSON.stringify(stored));
  const before = readFileSync(CONFIG_FILE, "utf8");
  assert.equal(Object.hasOwn(loadConfig()!, "futureField"), false, "unknown fields never reach the running configuration");
  assert.equal(readFileSync(CONFIG_FILE, "utf8"), before, "loading never rewrites the file");
  assert.equal(updateConfig({ sendMode: "image" }).secret, "secret");
  assert.deepEqual(readJson(), { ...stored, sendMode: "image" }, "an edit keeps fields this version does not own");
});

test("send mode defaults to text and only an explicit image changes it", () => {
  updateConfig({ botId: "bot", secret: "secret" });
  assert.equal(loadConfig()?.sendMode, "text");
  assert.equal(updateConfig({ sendMode: "image" }).sendMode, "image");
  assert.equal(loadConfig()?.sendMode, "image", "the file keeps the opt-in across reloads");
  writeFileSync(CONFIG_FILE, JSON.stringify({ botId: "bot", secret: "secret", sendMode: "picture" }));
  assert.throws(() => loadConfig(), /sendMode/, "a typo must name the field instead of silently changing the mode");
});

test("every stored field is validated once, with its field name", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ allowedUserIds: "alice" }, /allowedUserIds/],
    [{ allowedUserIds: ["alice", 7] }, /allowedUserIds/],
    [{ allowedUserIds: [""] }, /allowedUserIds/],
    [{ defaultChatType: 3 }, /defaultChatType/],
    [{ defaultChatType: "2" }, /defaultChatType/],
    [{ defaultChatId: 42 }, /defaultChatId/],
    [{ botId: 42, secret: "secret" }, /botId/],
  ];
  for (const [fields, field] of cases) {
    writeFileSync(CONFIG_FILE, JSON.stringify({ botId: "bot", secret: "secret", ...fields }));
    assert.throws(() => loadConfig(), (error: Error) => field.test(error.message) && error.message.includes(CONFIG_FILE), JSON.stringify(fields));
  }
  // The same validation guards writes, so a broken patch cannot replace a working file.
  writeFileSync(CONFIG_FILE, JSON.stringify({ botId: "bot", secret: "secret" }));
  const before = readFileSync(CONFIG_FILE, "utf8");
  assert.throws(() => updateConfig({ allowedUserIds: "alice" as unknown as string[] }), /allowedUserIds/);
  assert.equal(readFileSync(CONFIG_FILE, "utf8"), before);
});

test("a corrupt file is reported with its path instead of being overwritten", () => {
  writeFileSync(CONFIG_FILE, "{ \"botId\": \"bot\", ");
  assert.throws(() => updateConfig({ botId: "bot", secret: "secret" }), (error: Error) => error.message.includes(CONFIG_FILE));
  assert.equal(readFileSync(CONFIG_FILE, "utf8"), "{ \"botId\": \"bot\", ");
  assert.throws(() => loadConfig(), (error: Error) => error.message.includes(CONFIG_FILE) && /JSON/.test(error.message));
});

test("a symlinked configuration stays a private symlink after an atomic update", { skip: process.platform === "win32" && "symlinks need extra rights on Windows" }, () => {
  const real = join(sandbox, "real-wecom-aibot.json");
  writeFileSync(real, JSON.stringify({ botId: "bot", secret: "secret" }), { mode: 0o644 });
  symlinkSync(real, CONFIG_FILE);
  updateConfig({ defaultChatId: "group", defaultChatType: 2 });
  assert.equal(lstatSync(CONFIG_FILE).isSymbolicLink(), true);
  assert.equal(JSON.parse(readFileSync(real, "utf8")).defaultChatId, "group");
  assert.equal(statSync(real).mode & 0o777, 0o600);
});
