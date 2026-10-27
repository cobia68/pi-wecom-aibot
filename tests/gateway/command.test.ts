/** The WeCom-side grammar: each command declares its own target before its action. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWeComCommand } from "../../src/gateway/command.ts";

const ID = "01234567-89ab-4cde-8012-3456789abcde";

function errorOf(text: string): string {
	const parsed = parseWeComCommand(text);
	assert.equal(parsed.kind, "error", text);
	if (parsed.kind !== "error") assert.fail("expected an error");
	return parsed.message;
}

test("a message that is not the command prefix is not a command", () => {
	for (const text of ["帮我检查构建", "/wecom-aibotx send", "/wecom send --sessionid x", ""]) {
		assert.deepEqual(parseWeComCommand(text), { kind: "none" }, text);
	}
});

test("the bare prefix and --help show the command index", () => {
	for (const text of ["/wecom-aibot", "/wecom-aibot --help", "/wecom-aibot  --help"]) {
		assert.deepEqual(parseWeComCommand(text), { kind: "help" }, text);
	}
});

test("send takes its target before the action and the prompt as the rest of the message", () => {
	const prompt = "修复 --screen 与 --sessionid 的解析\n第二行";
	assert.deepEqual(parseWeComCommand(`/wecom-aibot --sessionid ${ID} send --prompt ${prompt}`), {
		kind: "send",
		sessionId: ID,
		prompt,
	});
});

test("cancel takes its target before the action; screen is no longer an action", () => {
	assert.deepEqual(parseWeComCommand(`/wecom-aibot --sessionid ${ID} cancel`), { kind: "cancel", sessionId: ID });
	assert.equal(
		errorOf(`/wecom-aibot --sessionid ${ID} screen`),
		"未知子命令 screen。可用子命令：sessions、send、card、cancel",
	);
});

test("card explicitly republishes a named control and follows the same target-first grammar", () => {
	assert.deepEqual(parseWeComCommand(`/wecom-aibot --sessionid ${ID} card`), { kind: "card", sessionId: ID });
	assert.deepEqual(parseWeComCommand("/wecom-aibot card --help"), { kind: "help", topic: "card" });
	assert.match(errorOf("/wecom-aibot card"), /^card 需要目标/);
	assert.match(errorOf(`/wecom-aibot card --sessionid ${ID}`), /--session-id 要写在动作前/);
	assert.match(errorOf(`/wecom-aibot --sessionid ${ID} card --prompt x`), /card 不接受 --prompt/);
});

test("a target without an action is a read-only single-session query", () => {
	assert.deepEqual(parseWeComCommand(`/wecom-aibot --sessionid ${ID}`), { kind: "session", sessionId: ID });
	assert.deepEqual(parseWeComCommand(`  /wecom-aibot\t--sessionid\n${ID}\n `), {
		kind: "session",
		sessionId: ID,
	});
});

test("sessions takes no target in either position", () => {
	assert.deepEqual(parseWeComCommand("/wecom-aibot sessions"), { kind: "sessions" });
	for (const text of [`/wecom-aibot --sessionid ${ID} sessions`, `/wecom-aibot sessions --sessionid ${ID}`]) {
		assert.equal(errorOf(text), "sessions 不需要 --session-id");
	}
	assert.match(errorOf("/wecom-aibot sessions --prompt x"), /sessions 不接受 --prompt/);
});

test("each action has help without requiring a target", () => {
	for (const topic of ["sessions", "send", "card", "cancel"] as const) {
		assert.deepEqual(parseWeComCommand(`/wecom-aibot ${topic} --help`), { kind: "help", topic });
		assert.deepEqual(parseWeComCommand(`/wecom-aibot --sessionid ${ID} ${topic} --help`), {
			kind: "help",
			topic,
		});
	}
	assert.deepEqual(parseWeComCommand(`/wecom-aibot --sessionid ${ID} --help`), { kind: "help" });
});

test("a missing target explains the new order and how to get an ID", () => {
	for (const kind of ["send", "card", "cancel"] as const) {
		const suffix = kind === "send" ? " --prompt <正文>" : "";
		const text = `/wecom-aibot ${kind}${kind === "send" ? " --prompt 检查构建" : ""}`;
		assert.equal(
			errorOf(text),
			`${kind} 需要目标：/wecom-aibot --session-id <id> ${kind}${suffix}。先发 /wecom-aibot sessions 获取 ID`,
		);
	}
});

test("the former action-first target option is refused and suggests a copyable replacement", () => {
	for (const kind of ["send", "card", "cancel"] as const) {
		const suffix = kind === "send" ? " --prompt <正文>" : "";
		const text = `/wecom-aibot ${kind} --sessionid ${ID}${kind === "send" ? " --prompt task" : ""}`;
		assert.equal(errorOf(text), `--session-id 要写在动作前：/wecom-aibot --session-id ${ID} ${kind}${suffix}`);
	}
});

test("a missing or empty prompt is refused", () => {
	for (const text of [
		`/wecom-aibot --sessionid ${ID} send`,
		`/wecom-aibot --sessionid ${ID} send --prompt`,
		`/wecom-aibot --sessionid ${ID} send --prompt   \n\t`,
	]) {
		assert.match(errorOf(text), /缺少 --prompt|--prompt 之后要有正文/, text);
	}
});

test("everything after --prompt is prose, including real IDs, help and repeated option names", () => {
	for (const prompt of [
		`解释 --sessionid ${ID} 的用法`,
		`--sessionid ${ID} --help --prompt --unknown`,
		"正文  有两个空格\n第二行\n\n",
		"/wecom-aibot cancel --sessionid=xxx  ",
	]) {
		assert.deepEqual(parseWeComCommand(`/wecom-aibot --sessionid ${ID} send --prompt ${prompt}`), {
			kind: "send",
			sessionId: ID,
			prompt,
		});
	}
});

test("a target mentioned only in the prompt cannot supply the command's missing target", () => {
	const message = errorOf(`/wecom-aibot send --prompt 正文 --sessionid ${ID}`);
	assert.match(message, /^send 需要目标：/);
	assert.doesNotMatch(message, /必须写在 --prompt 之前|要写在动作前/);
});

test("--prompt belongs to send and must follow the action", () => {
	for (const kind of ["card", "cancel"] as const) {
		assert.equal(errorOf(`/wecom-aibot --sessionid ${ID} ${kind} --prompt x`), `${kind} 不接受 --prompt`);
	}
	assert.match(errorOf(`/wecom-aibot --sessionid ${ID} --prompt x send`), /^未知选项 --prompt/);
});

test("equals forms remain unknown options, with options listed for the relevant position", () => {
	const global = errorOf(`/wecom-aibot --sessionid=${ID} send --prompt x`);
	assert.match(global, /^未知选项 --sessionid=/);
	assert.match(global, /可用选项：--session-id、--help/);
	assert.match(global, /不支持 =/);
	const action = errorOf(`/wecom-aibot --sessionid ${ID} send --prompt=x`);
	assert.match(action, /^未知选项 --prompt=x/);
	assert.match(action, /可用选项：--prompt、--help/);
});

test("positional parameters after an action are refused", () => {
	for (const text of [
		`/wecom-aibot send ${ID} 正文`,
		`/wecom-aibot --sessionid ${ID} send 正文`,
		`/wecom-aibot --sessionid ${ID} card extra`,
		`/wecom-aibot --sessionid ${ID} cancel card`,
		"/wecom-aibot sessions extra",
	]) {
		assert.match(errorOf(text), /不接受位置参数/, text);
	}
});

test("unknown actions still list the available ones, with or without a target", () => {
	for (const text of ["/wecom-aibot strat", `/wecom-aibot --sessionid ${ID} strat`]) {
		assert.equal(errorOf(text), "未知子命令 strat。可用子命令：sessions、send、card、cancel");
	}
});

test("the command prefix and actions remain case-insensitive", () => {
	assert.deepEqual(parseWeComCommand(` /WECOM-AIBOT --sessionid ${ID} SEND --prompt x`), {
		kind: "send",
		sessionId: ID,
		prompt: "x",
	});
});

test("a repeated target option before --prompt is refused", () => {
	for (const text of [
		`/wecom-aibot --sessionid ${ID} --sessionid ${ID} cancel`,
		`/wecom-aibot --sessionid ${ID} --sessionid ${ID}`,
		`/wecom-aibot --sessionid ${ID} cancel --sessionid ${ID}`,
	]) {
		assert.equal(errorOf(text), "--session-id 重复给出", text);
	}
});

test("--session-id without a value keeps its diagnostic", () => {
	for (const text of [
		"/wecom-aibot --sessionid",
		"/wecom-aibot --sessionid --help",
		"/wecom-aibot cancel --sessionid",
		`/wecom-aibot --sessionid ${ID} --sessionid`,
	]) {
		assert.equal(errorOf(text), "--session-id 缺少值", text);
	}
});

test("unknown options are refused before or after the action", () => {
	for (const text of [
		"/wecom-aibot -h",
		"/wecom-aibot --unknown x",
		`/wecom-aibot --sessionid ${ID} cancel --unknown x`,
		"/wecom-aibot sessions --unknown x",
	]) {
		assert.match(errorOf(text), /^未知选项/, text);
	}
});

test("the target option is --session-id, as pi and the cards spell it; --sessionid, copied before, still works", () => {
	assert.deepEqual(parseWeComCommand(`/wecom-aibot --session-id ${ID} card`), { kind: "card", sessionId: ID });
	assert.deepEqual(parseWeComCommand(`/wecom-aibot --sessionid ${ID} card`), { kind: "card", sessionId: ID });
});
