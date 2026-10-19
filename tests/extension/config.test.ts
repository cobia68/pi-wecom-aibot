import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";

const sandbox = mkdtempSync(join(tmpdir(), "pi-wecom-config-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = sandbox;
const { CONFIG_FILE, DEFAULT_WELCOME, clearConfig, loadConfig, updateConfig } = await import("../../src/extension/config.ts");
const readJson = () => JSON.parse(readFileSync(CONFIG_FILE, "utf8"));

beforeEach(() => {
  // Only the link itself when the file is a symlink.
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
    enabled: false, welcome: DEFAULT_WELCOME, screenMode: "text", botId: "bot", secret: "rotated",
    allowedUserIds: ["boss"], futureField: { kept: true }, defaultChatId: "boss", defaultChatType: 1,
  });
  assert.deepEqual(readdirSync(sandbox).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left behind");
});

test("updateConfig never creates a configuration without credentials", () => {
  assert.throws(() => updateConfig({ enabled: true }), /\/wecom setup/);
  assert.throws(() => readFileSync(CONFIG_FILE), { code: "ENOENT" });
  updateConfig({ botId: "bot", secret: "secret", enabled: true });
  assert.deepEqual(loadConfig(), { botId: "bot", secret: "secret", enabled: true, welcome: DEFAULT_WELCOME, screenMode: "text", allowedUserIds: undefined, defaultChatId: undefined, defaultChatType: undefined });
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
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...expected, allowedUserIds: ["boss"], futureField: true, welcome: "edited" }));
  const saved = updateConfig({ defaultChatId: "boss", defaultChatType: 1 }, expected);
  assert.equal(saved.defaultChatId, "boss");
  assert.equal(saved.welcome, "edited");
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

test("automatic connection stays off by default, and only an explicit true turns it on", () => {
  updateConfig({ botId: "bot", secret: "secret" });
  assert.equal(loadConfig()?.enabled, false, "a fresh configuration must not auto-connect");
  assert.equal(updateConfig({ enabled: true }).enabled, true);
  assert.equal(loadConfig()?.enabled, true);
});

test("screen mode defaults to text and only an explicit image changes it", () => {
  updateConfig({ botId: "bot", secret: "secret" });
  assert.equal(loadConfig()?.screenMode, "text");
  assert.equal(updateConfig({ screenMode: "image" }).screenMode, "image");
  assert.equal(loadConfig()?.screenMode, "image", "the file keeps the opt-in across reloads");
  writeFileSync(CONFIG_FILE, JSON.stringify({ botId: "bot", secret: "secret", screenMode: "imag" }));
  assert.equal(loadConfig()?.screenMode, "text", "an unknown value falls back to the safe text body");
});

test("image hosts and font files survive reloads and credential/target updates", () => {
  const imageHosts = [{ type: "http", url: "https://images.example/upload", fileField: "image", fields: { key: "image-token" }, urlPath: "data.url" }];
  const fontFiles = ["C:\\Windows\\Fonts\\consola.ttf", "/fonts/cjk.ttc"];
  writeFileSync(CONFIG_FILE, JSON.stringify({ botId: "bot", secret: "secret", imageHosts, fontFiles }));
  assert.deepEqual(loadConfig()?.imageHosts, imageHosts);
  assert.deepEqual(loadConfig()?.fontFiles, fontFiles);
  const updated = updateConfig({ defaultChatId: "group", defaultChatType: 2 });
  assert.deepEqual(updated.imageHosts, imageHosts);
  assert.deepEqual(updated.fontFiles, fontFiles);
  assert.deepEqual(readJson().imageHosts, imageHosts);
});

test("malformed or retired image settings do not turn a working text bot into an unconfigured one", () => {
  for (const imageHosts of ["wrong type", [{ type: "gitea", repo: "https://git.example/owner/images", token: "retired-token" }]]) {
    writeFileSync(CONFIG_FILE, JSON.stringify({ botId: "bot", secret: "secret", imageHosts, fontFiles: [42] }));
    assert.equal(loadConfig()?.botId, "bot", "image-only validation belongs to the opt-in image path");
    assert.equal(updateConfig({ enabled: true }).secret, "secret");
    assert.deepEqual(readJson().imageHosts, imageHosts, "unrelated updates must not silently migrate or erase image settings");
  }
});

test("a corrupt file is reported with its path instead of being overwritten", () => {
  writeFileSync(CONFIG_FILE, "{ \"botId\": \"bot\", ");
  assert.throws(() => updateConfig({ botId: "bot", secret: "secret" }), (error: Error) => error.message.includes(CONFIG_FILE));
  assert.equal(readFileSync(CONFIG_FILE, "utf8"), "{ \"botId\": \"bot\", ");
  assert.equal(loadConfig(), undefined);
});

test("a symlinked configuration stays a private symlink after an atomic update", { skip: process.platform === "win32" && "symlinks need extra rights on Windows" }, () => {
  const real = join(sandbox, "real-wecom-bot.json");
  writeFileSync(real, JSON.stringify({ botId: "bot", secret: "secret" }), { mode: 0o644 });
  symlinkSync(real, CONFIG_FILE);
  updateConfig({ defaultChatId: "group", defaultChatType: 2 });
  assert.equal(lstatSync(CONFIG_FILE).isSymbolicLink(), true);
  assert.equal(JSON.parse(readFileSync(real, "utf8")).defaultChatId, "group");
  assert.equal(statSync(real).mode & 0o777, 0o600);
});
