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
	addAllowedUser,
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
		[{ notificationScope: true }, /notificationScope/],
		[{ defaultChatId: "" }, /defaultChatId.*非空字符串/],
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
	const old = {
		sendMode: "image",
		notifyEveryRun: true,
		enabled: true,
		welcome: "hi",
		notificationMode: "screenshot",
		screenshotTheme: "light",
	};
	writeFileSync(CONFIG_FILE, JSON.stringify({ ...bot, ...old, futureField: 1 }));
	assert.deepEqual(readLayer("global"), bot);
	const { values } = mergeLayers(readLayer("global"), undefined);
	assert.equal(
		Object.hasOwn(values, "notificationMode"),
		false,
		"notificationMode is gone: every notification is a card",
	);
	assert.equal(values.notificationScope, "wecom-tasks", "notifyEveryRun is not converted");
	// Any save of the layer drops them; a field this version does not know is still kept.
	patchLayer("global", { set: { notificationScope: "all-runs" } });
	assert.deepEqual(readJson(), { ...bot, futureField: 1, notificationScope: "all-runs" });
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
		() => patchLayer("global", { set: { notificationScope: "all-runs" } }),
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
	patchLayer("global", { set: { notificationScope: "all-runs" } });
	assert.deepEqual(readJson(), { notificationScope: "all-runs" });
	const before = readFileSync(CONFIG_FILE, "utf8");
	assert.throws(() => patchLayer("global", { set: { botId: "half" } }), /secret.*成组/);
	assert.throws(() => patchLayer("global", { set: { defaultChatType: 2 } }), /defaultChatType/);
	assert.equal(readFileSync(CONFIG_FILE, "utf8"), before);
	// A guard sees the layer as it is on disk and may refuse.
	assert.throws(
		() =>
			patchLayer("global", { set: { notificationScope: "all-runs" } }, (current) => {
				assert.equal(current?.notificationScope, "all-runs");
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
	const global = {
		...bot,
		defaultChatId: "group",
		defaultChatType: 2 as const,
		notificationScope: "all-runs" as const,
	};
	const merged = mergeLayers(global, { notificationScope: "wecom-tasks", defaultChatId: "boss" });
	assert.deepEqual(merged.values, {
		notificationScope: "wecom-tasks",
		controlPrompts: [],
		...bot,
		defaultChatId: "boss",
		// The session's target is a whole group: its type is not the global group's 2.
		defaultChatType: 1,
	});
	assert.deepEqual(merged.sources, {
		notificationScope: "session",
		controlPrompts: "default",
		botId: "global",
		secret: "global",
		defaultChatId: "session",
		defaultChatType: "session",
	});
	// The type is completed by the merge only: a layer holds exactly what was saved in it.
	writeFileSync(CONFIG_FILE, JSON.stringify({ ...bot, defaultChatId: "boss" }));
	assert.deepEqual(readLayer("global"), { ...bot, defaultChatId: "boss" });
	// A value equal to the default is still the global layer's.
	assert.equal(mergeLayers({ notificationScope: "wecom-tasks" }, undefined).sources.notificationScope, "global");
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
					{ notificationScope: "all-runs", controlPrompts: ["继续"] },
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
	writeLayer({ session: CHILD }, { notificationScope: "all-runs" });
	if (process.platform !== "win32") {
		assert.equal(statSync(SESSIONS_DIR).mode & 0o777, 0o700);
		assert.equal(statSync(layerFile({ session: CHILD })).mode & 0o777, 0o600);
	}
});

test("a session reads both layers fresh and keeps its own overrides out of the global file", () => {
	writeLayer("global", { ...bot, defaultChatId: "boss", notificationScope: "wecom-tasks" });
	const { config } = sessionConfig(CHILD);
	assert.equal(config.read().values.notificationScope, "wecom-tasks");
	config.patch({ set: { notificationScope: "all-runs" } });
	assert.deepEqual(readJson(layerFile({ session: CHILD })), { notificationScope: "all-runs" });
	assert.equal(readJson().notificationScope, "wecom-tasks");
	// Another window edits the global file: the next read sees it, the session override still wins.
	patchLayer("global", { set: { notificationScope: "wecom-tasks", controlPrompts: ["继续"] } });
	const resolved = config.read();
	assert.equal(resolved.values.notificationScope, "all-runs");
	assert.deepEqual(resolved.values.controlPrompts, ["继续"]);
	assert.equal(existsSync(layerFile({ session: PARENT })), false, "a plain session never writes for another");
});

test("a broken file keeps the last good result for the places a value is used, warning once", () => {
	writeLayer("global", { ...bot, notificationScope: "all-runs" });
	const { config, reports } = sessionConfig(CHILD);
	assert.equal(config.current().values.notificationScope, "all-runs");
	writeFileSync(CONFIG_FILE, "{ broken");
	for (let i = 0; i < 3; i++) assert.equal(config.current().values.notificationScope, "all-runs");
	assert.equal(reports.length, 1);
	assert.match(reports[0].message, /无法使用.*继续使用上一次有效的配置/);
	assert.throws(() => config.read(), /JSON/, "an explicit read still fails");
	writeLayer("global", { ...bot, notificationScope: "wecom-tasks" });
	assert.equal(config.current().values.notificationScope, "wecom-tasks");
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
	writeLayer(
		{ session: PARENT },
		{ defaultChatId: "private-user", defaultChatType: 1, notificationScope: "all-runs" },
	);
	const parent = sessionFile(PARENT);
	const { config, reports } = sessionConfig(CHILD, parent);
	const resolved = config.read();
	assert.equal(resolved.values.defaultChatId, "private-user", "a fork keeps sending where its parent did");
	assert.equal(resolved.sources.defaultChatId, "session");
	assert.deepEqual(readJson(layerFile({ session: CHILD })), {
		defaultChatId: "private-user",
		defaultChatType: 1,
		notificationScope: "all-runs",
	});
	assert.equal(reports.length, 1);
	assert.match(reports[0].message, /defaultChatId、defaultChatType、notificationScope.*一次性快照/);
	// A snapshot: later parent changes never reach the child, and a resume never copies again.
	writeLayer({ session: PARENT }, { notificationScope: "wecom-tasks" });
	assert.equal(sessionConfig(CHILD, parent).config.read().values.notificationScope, "all-runs");
	assert.equal(reports.length, 1);
	// Removing every override keeps the (empty) file, so the parent is never copied again.
	config.patch({ remove: ["defaultChatId", "defaultChatType", "notificationScope"] });
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
	assert.throws(
		() => config.patch({ set: { notificationScope: "all-runs" } }),
		/JSON/,
		"nor can its own layer be written",
	);
	assert.equal(existsSync(layerFile({ session: CHILD })), false, "the copy is retried once the parent is fixed");
	writeLayer({ session: PARENT }, { defaultChatId: "private-user" });
	assert.equal(config.read().values.defaultChatId, "private-user");
	const unreadable = join(sandbox, "not-a-session.jsonl");
	writeFileSync(unreadable, "not json\n");
	rmSync(layerFile({ session: CHILD }));
	assert.throws(() => sessionConfig(CHILD, unreadable).config.read(), /父会话 .* 的会话头 不是有效的 JSON/);
});

test("set tokens are checked together: every problem is reported and nothing is half-applied", () => {
	assert.deepEqual(parseAssignments(["NotificationScope=ALL-RUNS", "controlprompts=继续"]), {
		set: { notificationScope: "all-runs", controlPrompts: ["继续"] },
	});
	assert.deepEqual(parseAssignments(["defaultChatId=group_chat", "defaultChatType=2"]), {
		set: { defaultChatId: "group_chat", defaultChatType: 2 },
	});
	assert.deepEqual(parseAssignments(["defaultChatId=a=b"]), { set: { defaultChatId: "a=b", defaultChatType: 1 } });
	const result = parseAssignments([
		"notificationScope",
		"secret=s",
		"botId=b",
		"bogus=1",
		"sendMode=image",
		"allowedUserIds=x",
		"controlPrompts=继续",
		"controlPrompts=运行测试",
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
	assert.match(problems.join("\n"), /controlPrompts 重复给出/);
	assert.match(problems.join("\n"), /defaultChatType 缺少值.*unset/);
	assert.match(problems.join("\n"), /只能是 wecom-tasks、all-runs/);
	assert.match(problems.join("\n"), /含引号或空格/);
	assert.match(JSON.stringify(parseAssignments(["defaultChatType=2"])), /需要和 defaultChatId 一起给出/);
});

test("unset takes field names and removes whole groups", () => {
	assert.deepEqual(parseRemovals(["defaultChatType", "NOTIFICATIONSCOPE"]), {
		remove: ["defaultChatId", "defaultChatType", "notificationScope"],
	});
	assert.deepEqual(parseRemovals(["secret"]), { remove: ["botId", "secret"] });
	const result = parseRemovals(["notificationScope=all-runs", "bogus"]);
	assert.ok("problems" in result);
	assert.deepEqual(result.problems.length, 2);
	assert.match(result.problems[0], /unset 只写字段名，不带 =/);
	assert.match(result.problems[1], /未知字段 bogus.*secret/);
});

test("whoami's 加入白名单 adds one userid to the global file and keeps everything else in it", () => {
	writeFileSync(
		CONFIG_FILE,
		JSON.stringify({ ...bot, allowedUserIds: ["boss"], futureField: 1, notificationMode: "screenshot" }),
	);
	addAllowedUser("alice");
	addAllowedUser("alice");
	assert.deepEqual(readJson(), { ...bot, allowedUserIds: ["boss", "alice"], futureField: 1 });
});

test("clearConfig removes the global file only, and never hides a real deletion error", (t) => {
	clearConfig();
	writeLayer("global", bot);
	writeLayer({ session: CHILD }, { notificationScope: "all-runs" });
	clearConfig();
	assert.equal(readLayer("global"), undefined);
	assert.deepEqual(
		readLayer({ session: CHILD }),
		{ notificationScope: "all-runs" },
		"session overrides belong to their sessions",
	);
	mkdirSync(CONFIG_FILE);
	writeFileSync(join(CONFIG_FILE, "kept"), "must not be removed recursively");
	t.after(() => rmSync(CONFIG_FILE, { recursive: true, force: true }));
	assert.throws(() => clearConfig());
	assert.equal(readFileSync(join(CONFIG_FILE, "kept"), "utf8"), "must not be removed recursively");
});

test("the document address is global only, never settable by command, and must be a bare qq.com https URL", () => {
	const url = "https://qyapi.weixin.qq.com/mcp/v2/bot/doc?apikey=key-0123456789";
	patchLayer("global", { set: { docMcpUrl: url } });
	assert.equal(readLayer("global")?.docMcpUrl, url);
	assert.equal(mergeLayers(readLayer("global"), undefined).values.docMcpUrl, url);
	assert.throws(() => patchLayer({ session: CHILD }, { set: { docMcpUrl: url } }), /docMcpUrl.*只能写在全局配置/);
	assert.throws(() => patchLayer("global", { set: { docMcpUrl: "http://qyapi.weixin.qq.com/mcp" } }), /https/);
	assert.throws(() => patchLayer("global", { set: { docMcpUrl: "https://example.com/mcp" } }), /qq\.com/);
	const result = parseAssignments([`docMcpUrl=${url}`]);
	assert.ok("problems" in result);
	assert.match(result.problems.join("\n"), /docMcpUrl 只能用 \/wecom-aibot config --scope global edit/);
	assert.deepEqual(parseRemovals(["docmcpurl"]), { remove: ["docMcpUrl"] });
	assert.equal(
		connectionKey(connectionOf(mergeLayers({ ...bot, docMcpUrl: url }, undefined))),
		connectionKey(connectionOf(mergeLayers(bot, undefined))),
		"the address is not part of a registration",
	);
});

test("controlPrompts is a list: comma-separated in set, checked the same way in a file, and inherited like any setting", () => {
	assert.deepEqual(parseAssignments(["controlPrompts=继续,运行测试，再提交, 总结进度"]), {
		set: { controlPrompts: ["继续", "运行测试，再提交", "总结进度"] },
	});
	for (const [token, problem] of [
		["controlPrompts=继续,,总结", /第 2 条是空的/],
		["controlPrompts=a,a", /第 2 条与前面重复：a/],
		[`controlPrompts=${Array.from({ length: 11 }, (_, i) => `p${i}`).join(",")}`, /最多 10 条提示词，现在 11 条/],
		[`controlPrompts=${"长".repeat(501)}`, /第 1 条超过 500 字/],
	] as const) {
		const result = parseAssignments([token]);
		assert.ok("problems" in result, token);
		assert.match(result.problems.join("\n"), problem);
	}
	patchLayer("global", { set: { controlPrompts: ["继续", "运行测试"] } });
	assert.deepEqual(readJson().controlPrompts, ["继续", "运行测试"], "a JSON array in the file");
	const merged = mergeLayers(readLayer("global"), { controlPrompts: ["只在这个 session"] });
	assert.deepEqual(merged.values.controlPrompts, ["只在这个 session"]);
	assert.equal(merged.sources.controlPrompts, "session");
	// A hand edit is checked like a typed one, naming the field and the file.
	writeFileSync(CONFIG_FILE, JSON.stringify({ controlPrompts: "继续" }));
	assert.throws(() => readLayer("global"), /controlPrompts 无效：必须是提示词字符串组成的数组/);
	writeFileSync(CONFIG_FILE, JSON.stringify({ controlPrompts: ["继续\n运行测试"] }));
	assert.throws(() => readLayer("global"), /第 1 条含换行或控制字符/);
	assert.deepEqual(parseRemovals(["controlprompts"]), { remove: ["controlPrompts"] });
	// No built-in prompts; an empty list is a valid override, and the default is a fresh copy each time.
	assert.deepEqual(mergeLayers({ controlPrompts: ["继续"] }, { controlPrompts: [] }).values.controlPrompts, []);
	const first = mergeLayers(undefined, undefined).values.controlPrompts;
	first.push("x");
	assert.deepEqual(mergeLayers(undefined, undefined).values.controlPrompts, []);
});
