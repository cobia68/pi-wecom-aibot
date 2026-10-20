import assert from "node:assert/strict";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { parseClientFrame, parseServerFrame, readFrames } from "../../src/shared/gateway-protocol.ts";

const source = { sessionId: "session", provider: "provider", modelName: "Model", directoryName: "project" };
const task = {
	id: "task",
	message: {
		msgId: "m",
		msgtype: "text",
		chat: { chatId: "user", chatType: 1 },
		userid: "user",
		text: "hi",
		attachments: [],
	},
};

function reader(): { stream: PassThrough; received: unknown[]; errors: unknown[]; write(line: string): void } {
	const stream = new PassThrough();
	const received: unknown[] = [];
	const errors: unknown[] = [];
	readFrames(
		stream as unknown as Socket,
		(value) => {
			received.push(value);
			if ((value as { type?: string }).type === "explode") throw new Error("handler bug");
		},
		(error) => errors.push(error),
	);
	return {
		stream,
		received,
		errors,
		write: (line) => {
			stream.write(line);
		},
	};
}

test("every server frame the extension consumes is validated before use", () => {
	assert.deepEqual(parseServerFrame({ type: "status", status: { state: "subscribed", sessions: 2 } }), {
		ok: true,
		frame: { type: "status", status: { state: "subscribed", sessions: 2 } },
	});
	for (const status of [
		{ state: "hacked", sessions: 1 },
		{ state: "subscribed" },
		{ state: "subscribed", sessions: -1 },
		{ state: "subscribed", sessions: 1, detail: 42 },
		{ state: "subscribed", sessions: 1, stopped: "yes" },
	]) {
		assert.equal(parseServerFrame({ type: "status", status }).ok, false, JSON.stringify(status));
	}
	assert.equal(parseServerFrame({ type: "registered", status: { state: "subscribed", sessions: 1 } }).ok, true);
	assert.equal(parseServerFrame({ type: "log", message: "hello" }).ok, true);
	assert.equal(parseServerFrame({ type: "log", message: 42 }).ok, false);
	assert.equal(parseServerFrame({ type: "result", id: "1" }).ok, true);
	assert.equal(parseServerFrame({ type: "result", id: "1", error: "x", outcome: "maybe" }).ok, false);
	assert.equal(
		parseServerFrame({ type: "identity", id: "1", identity: { chatId: "user", chatType: 1, userid: "user" } }).ok,
		true,
	);
	assert.equal(
		parseServerFrame({ type: "identity", id: "1", identity: { chatId: "user", chatType: 3, userid: "user" } }).ok,
		false,
	);
	assert.equal(
		parseServerFrame({ type: "task", target: { instanceId: "i", registrationId: "r", sessionId: "s" }, task }).ok,
		true,
	);
	assert.equal(
		parseServerFrame({
			type: "task",
			target: { instanceId: "i", registrationId: "r", sessionId: "s" },
			task: { ...task, message: { ...task.message, chat: { chatId: "", chatType: 1 } } },
		}).ok,
		false,
	);
	assert.equal(parseServerFrame({ type: "nonsense" }).ok, false);
	assert.equal(parseServerFrame("pong").ok, false);
});

test("every client frame the gateway consumes is validated before use", () => {
	assert.equal(parseClientFrame({ type: "hello", version: 3, nonce: "0123456789abcdef" }).ok, true);
	assert.equal(parseClientFrame({ type: "hello", version: 3, nonce: "short" }).ok, false);
	assert.equal(parseClientFrame({ type: "status", taskId: "t", state: "running" }).ok, true);
	assert.equal(parseClientFrame({ type: "status", taskId: "t", state: "hacked" }).ok, false);
	assert.equal(parseClientFrame({ type: "status", state: "running" }).ok, false);
	assert.equal(
		parseClientFrame({
			type: "notify",
			id: "1",
			chat: { chatId: "user", chatType: 1 },
			notification: { kind: "test", source, text: "hi" },
		}).ok,
		true,
	);
	assert.equal(
		parseClientFrame({
			type: "notify",
			id: "1",
			chat: { chatId: "", chatType: 1 },
			notification: { kind: "test", source, text: "hi" },
		}).ok,
		false,
	);
	assert.equal(parseClientFrame({ type: "watch", id: "1", timeoutMs: Number.NaN }).ok, false);
	assert.equal(
		parseClientFrame({
			type: "register",
			registration: {
				instanceId: "i",
				registrationId: "r",
				source,
				config: { botId: "bot", allowedUserIds: "alice" },
			},
			proof: "0",
		}).ok,
		false,
		"a string allowlist can never reach the gateway and expand into one userid per character",
	);
	assert.equal(parseClientFrame({ type: "nonsense" }).ok, false);
});

test("a handler failure is reported and ends the connection instead of vanishing", () => {
	const reader1 = reader();
	reader1.write(`${JSON.stringify({ type: "pong" })}\n`);
	assert.equal(reader1.received.length, 1);
	assert.deepEqual(reader1.errors, []);
	reader1.write(`${JSON.stringify({ type: "explode" })}\n`);
	assert.equal(reader1.errors.length, 1);
	assert.match(String((reader1.errors[0] as Error).message), /handler bug/);
	assert.equal(reader1.stream.destroyed, true, "a handler bug must not leave the stream running");
});

test("only a malformed line is rejected at the parse boundary", () => {
	const reader2 = reader();
	reader2.write("not json\n");
	assert.equal(reader2.received.length, 0);
	assert.equal(reader2.errors.length, 1);
	assert.equal(reader2.stream.destroyed, true);
	const reader3 = reader();
	reader3.write("[1,2]\n");
	assert.equal(reader3.errors.length, 1);
	assert.equal(reader3.stream.destroyed, true);
});
