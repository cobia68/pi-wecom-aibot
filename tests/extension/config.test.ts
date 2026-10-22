import assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";

const sandbox = mkdtempSync(join(tmpdir(), "pi-wecom-aibot-config-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = sandbox;
const {
	CONFIG_FILE,
	SESSIONS_DIR,
	SessionConfig,
	clearConfig,
	connectionKey,
	connectionOf,
	layerFile,
	mergeLayers,
	parseAssignments,
	parseRemovals,
	patchLayer,
	readLayer,
	writeLayer,
} = await import("../../src/extension/config.ts");
const readJson = (file = CONFIG_FILE) => JSON.parse(readFileSync(file, "utf8"));
const bot = { botId: "bot", secret: "secret" };
const PARENT = "11111111-2222-4333-8444-555555555555";
const CHILD = "66666666-7777-4888-9999-aaaaaaaaaaaa";

/** A pi session file whose header names `id`, as the parent of a fork. */
function sessionFile(id: string): string {
	const file = join(sandbox, `${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: sandbox })}\n{"type":"message"}\n`);
	return file;
}

function sessionConfig(id: string, parent?: string) {
	const reports: { message: string; type: string }[] = [];
	const config = new SessionConfig(id, parent, (message, type) => reports.push({ message, type }));
	return { config, reports };
}

beforeEach(() => {
	mkdirSync(dirname(CONFIG_FILE), { recursive: true });
	// Only the link itself when the file is a symlink.
	rmSync(CONFIG_FILE, { force: true });
	rmSync(SESSIONS_DIR, { recursive: true, force: true });
});

after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	assert.equal(dirname(sandbox), tmpdir());
	rmSync(sandbox, { recursive: true, force: true });
});

test("every stored field is validated with its name and file, groups as groups", () => {
	const cases: [Record<string, unknown>, RegExp][] = [
		[{ allowedUserIds: "alice" }, /allowedUserIds/],
		[{ allowedUserIds: ["alice", 7] }, /allowedUserIds/],
		[{ allowedUserIds: [""] }, /allowedUserIds/],
		[{ defaultChatId: "boss", defaultChatType: 3 }, /defaultChatType/],
		[{ defaultChatId: "boss", defaultChatType: "2" }, /defaultChatType/],
		[{ defaultChatId: 42 }, /defaultChatId/],
		[{ defaultChatId: "boss with space" }, /defaultChatId.*含引号或空格/],
		[{ defaultChatType: 2 }, /defaultChatType.*defaultChatId/],
		[{ notificationMode: "image" }, /notificationMode/],
		[{ notificationScope: true }, /notificationScope/],
		[{ screenshotTheme: "" }, /screenshotTheme.*非空字符串/],
		[{ botId: 42, secret: "secret" }, /botId/],
		[{ botId: "bot" }, /secret.*成组/],
	];
	for (const [fields, field] of cases) {
		writeFileSync(CONFIG_FILE, JSON.stringify(fields));
		assert.throws(
			() => readLayer("global"),
			(error: Error) => field.test(error.message) && error.message.includes(CONFIG_FILE),
			JSON.stringify(fields),
		);
	}
	// The allowlist is hand-edited in the global file only; a session file cannot widen it.
	mkdirSync(SESSIONS_DIR, { recursive: true });
	writeFileSync(layerFile({ session: CHILD }), JSON.stringify({ allowedUserIds: ["x"] }));
	assert.throws(() => readLayer({ session: CHILD }), /allowedUserIds.*只能写在全局配置/);
});

test("fields of earlier versions are ignored, never migrated, and dropped by the next save", () => {
	const old = { sendMode: "image", notifyEveryRun: true, enabled: true, welcome: "hi" };
	writeFileSync(CONFIG_FILE, JSON.stringify({ ...bot, ...old, futureField: 1 }));
	assert.deepEqual(readLayer("global"), bot);
	const { values } = mergeLayers(readLayer("global"), undefined);
	assert.equal(values.notificationMode, "text", "sendMode is not converted");
	assert.equal(values.notificationScope, "wecom-tasks", "notifyEveryRun is not converted");
	// Any save of the layer drops them; a field this version does not know is still kept.
	patchLayer("global", { set: { screenshotTheme: "light" } });
	assert.deepEqual(readJson(), { ...bot, futureField: 1, screenshotTheme: "light" });
});

test("a missing file is no layer, while an unreadable one is an error naming it", () => {
	assert.equal(readLayer("global"), undefined);
	assert.equal(readLayer({ session: CHILD }), undefined);
	writeFileSync(CONFIG_FILE, '{ "botId": "bot", ');
	assert.throws(
		() => readLayer("global"),
		(error: Error) => error.message.includes(CONFIG_FILE) && /JSON/.test(error.message),
	);
	assert.throws(
		() => patchLayer("global", { set: { screenshotTheme: "light" } }),
		(error: Error) => error.message.includes(CONFIG_FILE),
	);
	assert.equal(readFileSync(CONFIG_FILE, "utf8"), '{ "botId": "bot", ', "a corrupt file is never overwritten");
});

test("patchLayer merges into the file as it is now, keeping hand edits and unknown fields", () => {
	writeFileSync(CONFIG_FILE, JSON.stringify({ ...bot, allowedUserIds: ["boss"], futureField: { kept: true } }));
	const layer = patchLayer("global", { set: { defaultChatId: "boss", defaultChatType: 1 } });
	assert.deepEqual(layer.allowedUserIds, ["boss"]);
	assert.equal(Object.hasOwn(layer, "futureField"), false, "unknown fields never reach the configuration");
	assert.deepEqual(readJson(), {
		...bot,
		allowedUserIds: ["boss"],
		futureField: { kept: true },
		defaultChatId: "boss",
		defaultChatType: 1,
	});
	patchLayer("global", { remove: ["defaultChatId", "defaultChatType"] });
	assert.deepEqual(readJson(), { ...bot, allowedUserIds: ["boss"], futureField: { kept: true } });
	assert.deepEqual(
		readdirSync(dirname(CONFIG_FILE)).filter((name) => name.endsWith(".tmp")),
		[],
		"no temporary file is left behind",
	);
	if (process.platform !== "win32") assert.equal(statSync(CONFIG_FILE).mode & 0o777, 0o600);
});

test("a global layer may hold only settings, and nothing is written without a valid result", () => {
	patchLayer("global", { set: { notificationMode: "screenshot" } });
	assert.deepEqual(readJson(), { notificationMode: "screenshot" });
	const before = readFileSync(CONFIG_FILE, "utf8");
	assert.throws(() => patchLayer("global", { set: { botId: "half" } }), /secret.*成组/);
	assert.throws(() => patchLayer("global", { set: { defaultChatType: 2 } }), /defaultChatType/);
	assert.equal(readFileSync(CONFIG_FILE, "utf8"), before);
	// A guard sees the layer as it is on disk and may refuse.
	assert.throws(
		() =>
			patchLayer("global", { set: { screenshotTheme: "light" } }, (current) => {
				assert.equal(current?.notificationMode, "screenshot");
				throw new Error("refused");
			}),
		/refused/,
	);
	assert.equal(readFileSync(CONFIG_FILE, "utf8"), before);
});

test("a symlinked configuration stays a private symlink after an atomic update", {
	skip: process.platform === "win32" && "symlinks need extra rights on Windows",
}, () => {
	const real = join(sandbox, "real-wecom-aibot.json");
	writeFileSync(real, JSON.stringify(bot), { mode: 0o644 });
	symlinkSync(real, CONFIG_FILE);
	patchLayer("global", { set: { defaultChatId: "group", defaultChatType: 2 } });
	assert.equal(lstatSync(CONFIG_FILE).isSymbolicLink(), true);
	assert.equal(readJson(real).defaultChatId, "group");
	assert.equal(statSync(real).mode & 0o777, 0o600);
});

test("built-in default < global < session, and a group comes whole from one layer", () => {
	const global = { ...bot, defaultChatId: "group", defaultChatType: 2 as const, screenshotTheme: "dark" as const };
	const merged = mergeLayers(global, { screenshotTheme: "light", defaultChatId: "boss" });
	assert.deepEqual(merged.values, {
		notificationMode: "text",
		notificationScope: "wecom-tasks",
		screenshotTheme: "light",
		...bot,
		defaultChatId: "boss",
		// The session's target is a whole group: its type is not the global group's 2.
		defaultChatType: 1,
	});
	assert.deepEqual(merged.sources, {
		notificationMode: "default",
		notificationScope: "default",
		screenshotTheme: "session",
		botId: "global",
		secret: "global",
		defaultChatId: "session",
		defaultChatType: "session",
	});
	// The type is completed by the merge only: a layer holds exactly what was saved in it.
	writeFileSync(CONFIG_FILE, JSON.stringify({ ...bot, defaultChatId: "boss" }));
	assert.deepEqual(readLayer("global"), { ...bot, defaultChatId: "boss" });
	// Any pi theme name is a value; without one there is none, and the screenshot follows pi.
	assert.equal(mergeLayers({ screenshotTheme: "rainbow-prism" }, undefined).values.screenshotTheme, "rainbow-prism");
	assert.equal(Object.hasOwn(mergeLayers(undefined, undefined).values, "screenshotTheme"), false);
	// A value equal to the default is still the global layer's.
	assert.equal(mergeLayers({ notificationMode: "text" }, undefined).sources.notificationMode, "global");
	assert.equal(mergeLayers(undefined, undefined).values.botId, undefined);
});

test("the connection key covers credentials, target and allowlist, never the settings", () => {
	const target = { defaultChatId: "boss", defaultChatType: 1 as const };
	const base = mergeLayers({ ...bot, ...target, allowedUserIds: ["boss"] }, undefined);
	const key = connectionKey(connectionOf(base));
	assert.equal(
		connectionKey(
			connectionOf(
				mergeLayers(
					{ ...bot, ...target, allowedUserIds: ["boss"] },
					{ notificationMode: "screenshot", screenshotTheme: "light" },
				),
			),
		),
		key,
	);
	assert.notEqual(connectionKey(connectionOf(mergeLayers({ ...bot, ...target }, undefined))), key);
	assert.notEqual(
		connectionKey(
			connectionOf(
				mergeLayers(
					{ ...bot, ...target, allowedUserIds: ["boss"] },
					{ defaultChatId: "other", defaultChatType: 1 },
				),
			),
		),
		key,
	);
	assert.equal(connectionOf(mergeLayers(target, undefined)), undefined, "no credentials, no connection");
	assert.equal(connectionKey(undefined), "");
});

test("pi's own session IDs name their file; any other ID is hashed into a safe name", () => {
	assert.equal(layerFile({ session: CHILD }), join(SESSIONS_DIR, `${CHILD}.json`));
	const odd = basename(layerFile({ session: "../../CON Name" }));
	assert.match(odd, /^id-[0-9a-f]{32}\.json$/);
	assert.notEqual(basename(layerFile({ session: CHILD.toUpperCase() })), `${CHILD.toUpperCase()}.json`);
	writeLayer({ session: CHILD }, { screenshotTheme: "light" });
	if (process.platform !== "win32") {
		assert.equal(statSync(SESSIONS_DIR).mode & 0o777, 0o700);
		assert.equal(statSync(layerFile({ session: CHILD })).mode & 0o777, 0o600);
	}
});

test("a session reads both layers fresh and keeps its own overrides out of the global file", () => {
	writeLayer("global", { ...bot, defaultChatId: "boss", notificationMode: "text" });
	const { config } = sessionConfig(CHILD);
	assert.equal(config.read().values.notificationMode, "text");
	config.patch({ set: { notificationMode: "screenshot" } });
	assert.deepEqual(readJson(layerFile({ session: CHILD })), { notificationMode: "screenshot" });
	assert.equal(readJson().notificationMode, "text");
	// Another window edits the global file: the next read sees it, the session override still wins.
	patchLayer("global", { set: { notificationMode: "text", screenshotTheme: "light" } });
	const resolved = config.read();
	assert.equal(resolved.values.notificationMode, "screenshot");
	assert.equal(resolved.values.screenshotTheme, "light");
	assert.equal(existsSync(layerFile({ session: PARENT })), false, "a plain session never writes for another");
});

test("a broken file keeps the last good result for the places a value is used, warning once", () => {
	writeLayer("global", { ...bot, notificationMode: "screenshot" });
	const { config, reports } = sessionConfig(CHILD);
	assert.equal(config.current().values.notificationMode, "screenshot");
	writeFileSync(CONFIG_FILE, "{ broken");
	for (let i = 0; i < 3; i++) assert.equal(config.current().values.notificationMode, "screenshot");
	assert.equal(reports.length, 1);
	assert.match(reports[0].message, /无法使用.*继续使用上一次有效的配置/);
	assert.throws(() => config.read(), /JSON/, "an explicit read still fails");
	writeLayer("global", { ...bot, notificationMode: "text" });
	assert.equal(config.current().values.notificationMode, "text");
	writeFileSync(CONFIG_FILE, "{ broken");
	config.current();
	assert.equal(reports.length, 2, "a later failure warns again");
	// Without any good read there is nothing to keep: the failure is the caller's to report.
	const fresh = sessionConfig(PARENT);
	assert.throws(() => fresh.config.current(), /JSON/);
	assert.equal(fresh.reports.length, 0);
});

test("a fork takes over its parent's overrides once, then the two sessions evolve independently", () => {
	writeLayer("global", { ...bot, defaultChatId: "team-group", defaultChatType: 2 });
	writeLayer({ session: PARENT }, { defaultChatId: "private-user", defaultChatType: 1, screenshotTheme: "light" });
	const parent = sessionFile(PARENT);
	const { config, reports } = sessionConfig(CHILD, parent);
	const resolved = config.read();
	assert.equal(resolved.values.defaultChatId, "private-user", "a fork keeps sending where its parent did");
	assert.equal(resolved.sources.defaultChatId, "session");
	assert.deepEqual(readJson(layerFile({ session: CHILD })), {
		defaultChatId: "private-user",
		defaultChatType: 1,
		screenshotTheme: "light",
	});
	assert.equal(reports.length, 1);
	assert.match(reports[0].message, /defaultChatId、defaultChatType、screenshotTheme.*一次性快照/);
	// A snapshot: later parent changes never reach the child, and a resume never copies again.
	writeLayer({ session: PARENT }, { screenshotTheme: "dark" });
	assert.equal(sessionConfig(CHILD, parent).config.read().values.screenshotTheme, "light");
	assert.equal(reports.length, 1);
	// Removing every override keeps the (empty) file, so the parent is never copied again.
	config.patch({ remove: ["defaultChatId", "defaultChatType", "screenshotTheme"] });
	assert.deepEqual(readJson(layerFile({ session: CHILD })), {});
	assert.equal(sessionConfig(CHILD, parent).config.read().values.defaultChatId, "team-group");
});

test("a fork of a session without overrides, or of a deleted session, still records its own empty layer", () => {
	const parent = sessionFile(PARENT);
	const quiet = sessionConfig(CHILD, parent);
	quiet.config.read();
	assert.deepEqual(readJson(layerFile({ session: CHILD })), {});
	assert.equal(quiet.reports.length, 0, "nothing inherited, nothing to say");
	rmSync(layerFile({ session: CHILD }));
	const gone = sessionConfig(CHILD, join(sandbox, "deleted.jsonl"));
	gone.config.read();
	assert.deepEqual(readJson(layerFile({ session: CHILD })), {});
	assert.match(gone.reports[0].message, /父会话文件已不存在/);
});

test("a broken parent layer is an error, never a silent fall back to the global target", () => {
	writeLayer("global", { ...bot, defaultChatId: "team-group", defaultChatType: 2 });
	mkdirSync(SESSIONS_DIR, { recursive: true });
	writeFileSync(layerFile({ session: PARENT }), "{ broken");
	const { config } = sessionConfig(CHILD, sessionFile(PARENT));
	assert.throws(
		() => config.read(),
		(error: Error) => error.message.includes(layerFile({ session: PARENT })),
	);
	assert.throws(() => config.patch({ set: { screenshotTheme: "light" } }), /JSON/, "nor can its own layer be written");
	assert.equal(existsSync(layerFile({ session: CHILD })), false, "the copy is retried once the parent is fixed");
	writeLayer({ session: PARENT }, { defaultChatId: "private-user" });
	assert.equal(config.read().values.defaultChatId, "private-user");
	const unreadable = join(sandbox, "not-a-session.jsonl");
	writeFileSync(unreadable, "not json\n");
	rmSync(layerFile({ session: CHILD }));
	assert.throws(() => sessionConfig(CHILD, unreadable).config.read(), /父会话 .* 的会话头 不是有效的 JSON/);
});

test("set tokens are checked together: every problem is reported and nothing is half-applied", () => {
	assert.deepEqual(parseAssignments(["NotificationMode=SCREENSHOT", "screenshottheme=light"]), {
		set: { notificationMode: "screenshot", screenshotTheme: "light" },
	});
	assert.deepEqual(parseAssignments(["defaultChatId=group_chat", "defaultChatType=2"]), {
		set: { defaultChatId: "group_chat", defaultChatType: 2 },
	});
	assert.deepEqual(parseAssignments(["defaultChatId=a=b"]), { set: { defaultChatId: "a=b", defaultChatType: 1 } });
	const result = parseAssignments([
		"notificationMode",
		"secret=s",
		"botId=b",
		"bogus=1",
		"sendMode=image",
		"allowedUserIds=x",
		"screenshotTheme=light",
		"screenshotTheme=dark",
		"defaultChatType=",
		"notificationScope=everything",
		"defaultChatId='quoted'",
	]);
	assert.ok("problems" in result);
	const problems = "problems" in result ? result.problems : [];
	assert.equal(problems.length, 10, problems.join("\n"));
	assert.match(problems.join("\n"), /缺少 =/);
	assert.match(problems.join("\n"), /secret 只能用 .*edit/);
	assert.match(problems.join("\n"), /botId 只能用 .*edit/);
	assert.match(problems.join("\n"), /未知字段 bogus/);
	assert.match(problems.join("\n"), /未知字段 sendMode；可用字段/, "an old name is just unknown");
	assert.match(problems.join("\n"), /allowedUserIds 不由 config 管理/);
	assert.match(problems.join("\n"), /screenshotTheme 重复给出/);
	assert.match(problems.join("\n"), /defaultChatType 缺少值.*unset/);
	assert.match(problems.join("\n"), /只能是 wecom-tasks、all-runs/);
	assert.match(problems.join("\n"), /含引号或空格/);
	assert.match(JSON.stringify(parseAssignments(["defaultChatType=2"])), /需要和 defaultChatId 一起给出/);
});

test("unset takes field names and removes whole groups", () => {
	assert.deepEqual(parseRemovals(["defaultChatType", "SCREENSHOTTHEME"]), {
		remove: ["defaultChatId", "defaultChatType", "screenshotTheme"],
	});
	assert.deepEqual(parseRemovals(["secret"]), { remove: ["botId", "secret"] });
	const result = parseRemovals(["screenshotTheme=light", "bogus"]);
	assert.ok("problems" in result);
	assert.deepEqual(result.problems.length, 2);
	assert.match(result.problems[0], /unset 只写字段名，不带 =/);
	assert.match(result.problems[1], /未知字段 bogus.*secret/);
});

test("clearConfig removes the global file only, and never hides a real deletion error", (t) => {
	clearConfig();
	writeLayer("global", bot);
	writeLayer({ session: CHILD }, { screenshotTheme: "light" });
	clearConfig();
	assert.equal(readLayer("global"), undefined);
	assert.deepEqual(
		readLayer({ session: CHILD }),
		{ screenshotTheme: "light" },
		"session overrides belong to their sessions",
	);
	mkdirSync(CONFIG_FILE);
	writeFileSync(join(CONFIG_FILE, "kept"), "must not be removed recursively");
	t.after(() => rmSync(CONFIG_FILE, { recursive: true, force: true }));
	assert.throws(() => clearConfig());
	assert.equal(readFileSync(join(CONFIG_FILE, "kept"), "utf8"), "must not be removed recursively");
});
