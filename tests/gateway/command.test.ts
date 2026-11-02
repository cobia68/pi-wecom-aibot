/** Only help and the session picker are textual WeCom commands; retired commands must never become tasks. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { helpText, parseWeComCommand } from "../../src/gateway/command.ts";

function errorOf(text: string): string {
	const parsed = parseWeComCommand(text);
	assert.equal(parsed.kind, "error", text);
	if (parsed.kind !== "error") assert.fail("expected an error");
	return parsed.message;
}

test("ordinary messages and other command prefixes are not interpreted as WeCom commands", () => {
	for (const text of ["帮我检查构建", "/wecom-aibotx send", "/wecom send", "", "/WECOM-AIBOT sessions"])
		assert.deepEqual(parseWeComCommand(text), { kind: "none" }, text);
});

test("the bare prefix and --help show help; sessions opens the picker and has its own help", () => {
	for (const text of ["/wecom-aibot", "/wecom-aibot --help", "  /wecom-aibot\t--help\n"])
		assert.deepEqual(parseWeComCommand(text), { kind: "help" }, text);
	assert.deepEqual(parseWeComCommand("/wecom-aibot sessions"), { kind: "sessions" });
	assert.deepEqual(parseWeComCommand(" /wecom-aibot\nsessions\t"), { kind: "sessions" });
	assert.deepEqual(parseWeComCommand("/wecom-aibot sessions --help"), { kind: "help", topic: "sessions" });
});

test("retired actions and target/prompt parameters are rejected, even when followed by --help", () => {
	for (const command of [
		"send",
		"card",
		"cancel",
		"screen",
		"config",
		"Sessions",
		"send --prompt 任务",
		"send --help",
		"card --help",
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
		"-h",
	]) {
		const error = errorOf(`/wecom-aibot ${command}`);
		assert.match(error, /仅支持 \/wecom-aibot sessions 和 \/wecom-aibot --help/);
		assert.match(error, /任务请直接发送，其他操作请用控制卡/);
	}
});

test("extra arguments never execute sessions or bypass validation through help", () => {
	for (const args of [
		"sessions extra",
		"sessions --unknown",
		"sessions --session-id session-A",
		"sessions --prompt 任务",
		"sessions --help extra",
		"sessions --help --session-id session-A",
		"sessions --help --help",
		"--help sessions",
		"--help send",
		"--help --unknown",
		"--help --help",
	])
		assert.match(errorOf(`/wecom-aibot ${args}`), /不接受参数/);
});

test("help describes the real interaction and never recommends retired commands", () => {
	for (const topic of [undefined, "sessions"] as const) {
		const help = helpText(topic);
		assert.match(help, /\/wecom-aibot sessions/);
		assert.match(help, /控制卡/);
		assert.match(help, /直接发/);
		assert.doesNotMatch(help, /--session-id|--prompt|\/wecom-aibot (?:send|card|cancel)/);
		for (const line of help.split("\n")) assert.equal(line.endsWith("。"), false);
	}
	assert.match(helpText(), /\/wecom-aibot --help/);
	assert.match(helpText(), /回到 pi 终端/);
	assert.match(helpText("sessions"), /列表保留/);
});
