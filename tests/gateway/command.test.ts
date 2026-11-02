/** Only help and the session picker are textual WeCom commands; aliases share the canonical parser. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { helpText, parseWeComCommand } from "../../src/gateway/command.ts";

const prefixes = ["/wecom-aibot", "/wa"];

function errorOf(text: string): string {
	const parsed = parseWeComCommand(text);
	assert.equal(parsed.kind, "error", text);
	if (parsed.kind !== "error") assert.fail("expected an error");
	return parsed.message;
}

test("ordinary messages and other command prefixes are not interpreted as WeCom commands", () => {
	for (const text of [
		"帮我检查构建",
		"/wecom-aibotx send",
		"/wecom send",
		"/wax s",
		"/wa-test s",
		"/wa/s",
		"boom",
		"/booms",
		"/boom/s",
		"/BOOM",
		"/pi",
		"/s",
		"/h",
		"/tmp/file",
		"",
		"/WECOM-AIBOT sessions",
		"/WA s",
	])
		assert.deepEqual(parseWeComCommand(text), { kind: "none" }, text);
});

test("bare WeCom prefixes are errors, not implicit help or model prompts", () => {
	for (const prefix of prefixes) {
		const error = errorOf(prefix);
		assert.match(error, /缺少子命令或帮助选项/);
		assert.match(error, /\/wa -h/);
		assert.equal(errorOf(`  ${prefix}\t\n`), error);
	}
});

test("explicit help and sessions accept full and short names, mixed or not", () => {
	for (const prefix of prefixes) {
		for (const args of ["--help", "-h"])
			assert.deepEqual(parseWeComCommand(`  ${prefix}\t${args}\n`), { kind: "help" });
		for (const action of ["sessions", "s"])
			assert.deepEqual(parseWeComCommand(` ${prefix}\n${action}\t`), { kind: "sessions" });
	}
});

test("the hidden /boom command maps to sessions and keeps its argument restrictions", () => {
	assert.deepEqual(parseWeComCommand("/boom"), { kind: "sessions" });
	assert.deepEqual(parseWeComCommand("  /boom\t\n"), { kind: "sessions" });
	for (const args of ["extra", "sessions", "s", "--help", "-h", "\n继续执行"]) {
		const canonical = args === "-h" ? "--help" : args;
		assert.equal(errorOf(`/boom ${args}`), errorOf(`/wecom-aibot sessions ${canonical}`));
	}
});

test("aliases expand to canonical commands before validation, without rewriting argument values", () => {
	for (const [short, full] of [
		["/wa", "/wecom-aibot"],
		["/wa s", "/wecom-aibot sessions"],
		["/wa -h", "/wecom-aibot --help"],
		["/wecom-aibot s", "/wecom-aibot sessions"],
		["/wecom-aibot -h", "/wecom-aibot --help"],
		["/wa s -h", "/wecom-aibot sessions --help"],
		["/wa s s", "/wecom-aibot sessions s"],
		["/wa -h s", "/wecom-aibot --help s"],
		["/wa -h -h", "/wecom-aibot --help --help"],
		["/wa cancel -h", "/wecom-aibot cancel --help"],
	])
		assert.deepEqual(parseWeComCommand(short), parseWeComCommand(full), short);
	assert.match(errorOf("/wa s s"), /sessions 不接受参数（s）/);
	assert.match(errorOf("/wa -h s"), /--help 不接受参数（s）/);
});

test("retired actions, implicit abbreviations and target parameters are rejected through either prefix", () => {
	for (const prefix of prefixes)
		for (const command of [
			"send",
			"card",
			"cancel",
			"screen",
			"config",
			"connect",
			"help",
			"help sessions",
			"h",
			"se",
			"Sessions",
			"S",
			"send --prompt 任务",
			"send --help",
			"card -h",
			"cancel --help",
			"--session-id session-A",
			"--session-id session-A send --prompt 任务",
			"--session-id session-A card",
			"--session-id session-A cancel",
			"--session-id session-A --help",
			"--session-id=session-A",
			"--prompt 任务",
			"--prompt=任务",
			"--SESSION-ID session-A",
			"--HELP",
			"-H",
			"__proto__",
		]) {
			const error = errorOf(`${prefix} ${command}`);
			assert.match(error, /\/wa s.*\/wa -h/);
			assert.match(error, /任务请直接发送，其他操作请用控制卡/);
		}
});

test("sessions has no arguments or scoped help, including when either word is abbreviated", () => {
	for (const prefix of prefixes)
		for (const action of ["sessions", "s"])
			for (const args of [
				"extra",
				"--unknown",
				"--session-id session-A",
				"--prompt 任务",
				"--help",
				"-h",
				"--help extra",
				"-h -h",
				"\n继续执行",
			])
				assert.match(errorOf(`${prefix} ${action} ${args}`), /sessions 不接受参数/);
});

test("top-level help does not accept a topic, another option or trailing task text", () => {
	for (const prefix of prefixes)
		for (const option of ["--help", "-h"])
			for (const args of ["sessions", "s", "send", "--unknown", "--help", "-h", "\n继续执行"])
				assert.match(errorOf(`${prefix} ${option} ${args}`), /--help 不接受参数/);
});

test("one help describes the full commands and aliases, not retired or scoped help forms", () => {
	const help = helpText();
	for (const command of ["/wecom-aibot sessions", "/wecom-aibot --help", "/wa s", "/wa -h"])
		assert.ok(help.includes(command), command);
	assert.match(help, /控制卡/);
	assert.match(help, /直接发/);
	assert.match(help, /回到 pi 终端/);
	assert.match(help, /不接受参数/);
	assert.match(help, /必须指定子命令或帮助选项/);
	assert.doesNotMatch(help, /--session-id|--prompt|\/wecom-aibot (?:send|card|cancel)|sessions --help|help sessions/);
	assert.doesNotMatch(help, /boom/, "the easter egg is not advertised");
	for (const line of help.split("\n")) assert.equal(line.endsWith("。"), false);
});
