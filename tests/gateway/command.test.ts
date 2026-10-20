/** The WeCom-side grammar: every task names its target, and nothing is remembered between messages. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWeComCommand } from "../../src/gateway/runtime.ts";

const ID = "01234567-89ab-4cde-8012-3456789abcde";

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

test("send takes the session ID as an option and the prompt as the rest of the message", () => {
  const parsed = parseWeComCommand(`/wecom-aibot send --sessionid ${ID} --prompt 修复 --screen 与 --sessionid 的解析\n第二行`);
  assert.deepEqual(parsed, { kind: "send", sessionId: ID, prompt: "修复 --screen 与 --sessionid 的解析\n第二行" });
});

test("screen and cancel take only a session ID", () => {
  assert.deepEqual(parseWeComCommand(`/wecom-aibot screen --sessionid ${ID}`), { kind: "screen", sessionId: ID });
  assert.deepEqual(parseWeComCommand(`/wecom-aibot cancel --sessionid ${ID}`), { kind: "cancel", sessionId: ID });
});

test("sessions takes no options", () => {
  assert.deepEqual(parseWeComCommand("/wecom-aibot sessions"), { kind: "sessions" });
  const rejected = parseWeComCommand(`/wecom-aibot sessions --sessionid ${ID}`);
  assert.equal(rejected.kind, "error");
});

test("each subcommand has its own help", () => {
  for (const topic of ["sessions", "send", "screen", "cancel"] as const) {
    assert.deepEqual(parseWeComCommand(`/wecom-aibot ${topic} --help`), { kind: "help", topic });
  }
});

test("a missing target explains how to get one", () => {
  const parsed = parseWeComCommand("/wecom-aibot send --prompt 检查构建");
  assert.equal(parsed.kind, "error");
  if (parsed.kind === "error") assert.match(parsed.message, /--sessionid.*sessions/s);
});

test("a missing or empty prompt is refused", () => {
  for (const text of [`/wecom-aibot send --sessionid ${ID}`, `/wecom-aibot send --sessionid ${ID} --prompt`, `/wecom-aibot send --sessionid ${ID} --prompt   `]) {
    const parsed = parseWeComCommand(text);
    assert.equal(parsed.kind, "error", text);
  }
});

test("--sessionid after --prompt is an order error when a real ID follows it", () => {
  const parsed = parseWeComCommand(`/wecom-aibot send --prompt 正文 --sessionid ${ID}`);
  assert.equal(parsed.kind, "error");
  if (parsed.kind === "error") assert.match(parsed.message, /--sessionid 必须写在 --prompt 之前/);
});

test("prose may mention --sessionid without becoming an order error", () => {
  const parsed = parseWeComCommand(`/wecom-aibot send --sessionid ${ID} --prompt 解释 --sessionid 的用法`);
  assert.equal(parsed.kind, "send");
});

test("an equals form is an unknown option, and the error lists what is supported", () => {
  const parsed = parseWeComCommand(`/wecom-aibot send --sessionid=${ID} --prompt x`);
  assert.equal(parsed.kind, "error");
  if (parsed.kind === "error") {
    assert.match(parsed.message, /未知选项 --sessionid=/);
    assert.match(parsed.message, /--sessionid/);
    assert.match(parsed.message, /--prompt/);
  }
});

test("a positional argument is refused everywhere", () => {
  for (const text of [`/wecom-aibot send ${ID} 正文`, `/wecom-aibot screen ${ID}`, "/wecom-aibot sessions extra"]) {
    const parsed = parseWeComCommand(text);
    assert.equal(parsed.kind, "error", text);
    if (parsed.kind === "error") assert.match(parsed.message, /位置参数|不接受/, text);
  }
});

test("an unknown subcommand lists the available ones", () => {
  const parsed = parseWeComCommand("/wecom-aibot strat");
  assert.equal(parsed.kind, "error");
  if (parsed.kind === "error") assert.match(parsed.message, /sessions、send、screen、cancel/);
});

test("subcommands are case-insensitive, and a repeated option is refused", () => {
  assert.deepEqual(parseWeComCommand(`/wecom-aibot SEND --sessionid ${ID} --prompt x`), { kind: "send", sessionId: ID, prompt: "x" });
  const duplicated = parseWeComCommand(`/wecom-aibot screen --sessionid ${ID} --sessionid ${ID}`);
  assert.equal(duplicated.kind, "error");
  if (duplicated.kind === "error") assert.match(duplicated.message, /重复给出/);
});
