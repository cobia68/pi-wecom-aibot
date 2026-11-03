import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";

const sandbox = mkdtempSync(join(tmpdir(), "pi-wecom-project-config-"));
const agentDir = join(sandbox, "agent");
const workspace = join(sandbox, "workspace");
const project = join(workspace, "repo");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { CONFIG_FILE, SessionConfig, layerFile, patchLayer, readLayer, writeLayer } = await import(
	"../../src/extension/config.ts"
);

const global = { botId: "global-bot", secret: "global-secret", defaultChatId: "global-user" };
const configFor = (cwd = project, trusted = () => true) =>
	new SessionConfig("session", cwd, undefined, () => {}, trusted);
const localFile = (cwd = project) => join(cwd, ".pi", "wecom-aibot", "config.json");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
/** Fixture for the retired filename format; never use it to supply a new project setting. */
function legacyFile(cwd = project): string {
	return join(agentDir, "wecom-aibot", "projects", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--.json`);
}
function legacyConfig(value: unknown, cwd = project): string {
	const file = legacyFile(cwd);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(value));
	return file;
}

beforeEach(() => {
	rmSync(workspace, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
	mkdirSync(project, { recursive: true });
	writeLayer("global", global);
});
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	assert.equal(dirname(sandbox), tmpdir());
	rmSync(sandbox, { recursive: true, force: true });
});

test("project and global configs share the wecom-aibot/config.json layout under their respective roots", () => {
	assert.equal(CONFIG_FILE, join(agentDir, "wecom-aibot", "config.json"));
	assert.equal(layerFile({ project }), localFile());
	const config = configFor();
	config.patch("project", { set: { contentDisplay: "linked", defaultChatId: "team", defaultChatType: 2 } });
	assert.deepEqual(readJson(localFile()), { contentDisplay: "linked", defaultChatId: "team", defaultChatType: 2 });
	assert.deepEqual(readJson(CONFIG_FILE), global);
	assert.equal(existsSync(join(agentDir, "wecom-aibot", "projects")), false);
	assert.equal(config.read().sources.contentDisplay, "project");
	assert.equal(config.read().values.defaultChatId, "team");
});

test("project settings follow a moved project without any global path registration", () => {
	writeLayer({ project }, { contentDisplay: "linked", controlPrompts: ["运行测试"] });
	const moved = join(workspace, "renamed-repo");
	renameSync(project, moved);
	const config = configFor(moved);
	assert.equal(config.read().values.contentDisplay, "linked");
	assert.deepEqual(config.read().values.controlPrompts, ["运行测试"]);
	assert.equal(config.read().values.botId, global.botId);
	assert.equal(config.read().sources.contentDisplay, "project");
	assert.equal(existsSync(join(agentDir, "wecom-aibot", "projects")), false);
});

test("paths that collided in the flattened filename format now have independent overrides", () => {
	const nested = join(project, "a", "b");
	const flat = join(project, "a-b");
	assert.equal(legacyFile(nested), legacyFile(flat));
	assert.notEqual(layerFile({ project: nested }), layerFile({ project: flat }));
	writeLayer({ project: nested }, { defaultChatId: "nested-user" });
	writeLayer({ project: flat }, { defaultChatId: "flat-user" });
	assert.equal(configFor(nested).read().values.defaultChatId, "nested-user");
	assert.equal(configFor(flat).read().values.defaultChatId, "flat-user");
});

test("only the startup working directory supplies project settings, with no ancestor search or directory creation on read", () => {
	writeLayer({ project }, { contentDisplay: "linked" });
	const nested = join(project, "nested");
	mkdirSync(nested);
	const resolved = configFor(nested).read();
	assert.equal(resolved.values.contentDisplay, "inline");
	assert.equal(resolved.values.botId, global.botId);
	assert.equal(existsSync(join(nested, ".pi")), false);
});

test("writing project overrides preserves other .pi files and existing directory permissions", () => {
	const directory = join(project, ".pi");
	const pluginDirectory = dirname(localFile());
	mkdirSync(directory, { mode: 0o755 });
	mkdirSync(pluginDirectory, { mode: 0o750 });
	const settings = join(directory, "settings.json");
	const original = '{"theme":"dark"}\n';
	writeFileSync(settings, original);
	const mode = statSync(directory).mode;
	const pluginMode = statSync(pluginDirectory).mode;
	writeLayer({ project }, { notificationScope: "all-runs" });
	assert.equal(readFileSync(settings, "utf8"), original);
	assert.equal(statSync(directory).mode, mode);
	assert.equal(statSync(pluginDirectory).mode, pluginMode);
	assert.equal(existsSync(join(project, ".gitignore")), false);
	if (process.platform !== "win32") assert.equal(statSync(localFile()).mode & 0o077, 0);
});

test("unmigrated legacy overrides stop reads and patches instead of being copied into the repo or replaced with global defaults", () => {
	const old = legacyConfig({ botId: "old-bot", secret: "NEVER-COPY-ME", defaultChatId: "old-user" });
	const original = readFileSync(old, "utf8");
	for (const operation of [
		() => readLayer({ project }),
		() => configFor().read(),
		() => patchLayer({ project }, { set: { contentDisplay: "inline" } }),
	])
		assert.throws(operation, (error: Error) => {
			assert.match(error.message, /迁移/);
			assert.ok(error.message.includes(old));
			assert.ok(error.message.includes(localFile()));
			assert.doesNotMatch(error.message, /NEVER-COPY-ME/);
			return true;
		});
	assert.equal(readFileSync(old, "utf8"), original);
	assert.equal(existsSync(join(project, ".pi")), false);
	assert.deepEqual(readJson(CONFIG_FILE), global);
});

test("a local file wins even when empty, never rereads legacy contents, and keeps editor metadata", () => {
	const old = legacyConfig({ contentDisplay: "linked", defaultChatId: "old-user" });
	writeFileSync(old, "{broken legacy");
	writeLayer({ project }, {});
	const config = configFor();
	assert.equal(config.read().values.contentDisplay, "inline");
	assert.equal(config.read().values.defaultChatId, "global-user");
	writeFileSync(localFile(), JSON.stringify({ $schema: "https://example.invalid/schema", contentDisplay: "linked" }));
	config.patch("project", { remove: ["contentDisplay"] });
	assert.deepEqual(readJson(localFile()), { $schema: "https://example.invalid/schema" });
	assert.equal(config.read().values.contentDisplay, "inline");
	assert.equal(readFileSync(old, "utf8"), "{broken legacy");
});

test("a malformed local file is an error, not an invitation to use the legacy or global layer", () => {
	legacyConfig({ contentDisplay: "linked" });
	mkdirSync(dirname(localFile()), { recursive: true });
	writeFileSync(localFile(), "{broken local");
	assert.throws(
		() => configFor().read(),
		(error: Error) => error.message.includes(localFile()) && /JSON/.test(error.message),
	);
});

test("declined project trust skips local settings without parsing them and refuses explicit project access", () => {
	mkdirSync(dirname(localFile()), { recursive: true });
	writeFileSync(localFile(), "{untrusted malformed config");
	legacyConfig({ secret: "untrusted" });
	let trusted = false;
	const config = configFor(project, () => trusted);
	assert.equal(config.read().values.defaultChatId, global.defaultChatId);
	assert.equal(config.layer("project"), undefined);
	assert.throws(() => config.requireProjectTrust(), /信任/);
	assert.throws(() => config.patch("project", { set: { contentDisplay: "linked" } }), /信任/);
	config.patch("global", { set: { notificationScope: "all-runs" } });
	config.patch("session", { set: { controlPrompts: ["会话提示词"] } });
	assert.equal(config.read().values.notificationScope, "all-runs");
	assert.deepEqual(config.read().values.controlPrompts, ["会话提示词"]);
	assert.equal(readFileSync(localFile(), "utf8"), "{untrusted malformed config");
	trusted = true;
	assert.throws(() => config.read(), /JSON/);
	writeLayer({ project }, { contentDisplay: "linked" });
	assert.equal(config.read().values.contentDisplay, "linked");
});

test("a dangling legacy symlink is still reported as an unmigrated file", {
	skip: process.platform === "win32",
}, () => {
	mkdirSync(dirname(legacyFile()), { recursive: true });
	symlinkSync(join(sandbox, "missing-config.json"), legacyFile());
	assert.throws(() => configFor().read(), /迁移/);
	assert.equal(existsSync(localFile()), false);
});
