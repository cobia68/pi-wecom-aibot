import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { readReplyImage } from "../../src/gateway/reply-image.ts";
import { type GatewayPeer, WeComGateway } from "../../src/gateway/runtime.ts";
import { WECOM_IMAGE_MAX_BYTES } from "../../src/shared/wecom-protocol.ts";
import { FakeWebSocket } from "../support/fake-websocket.ts";

const png = await readFile(new URL("../../src/extension/assets/pi-logo.png", import.meta.url));
const chat = { chatId: "clicked-group", chatType: 2 as const };

async function imageFile(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pi-wecom-image-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "reply.png");
	await writeFile(path, png, { mode: 0o600 });
	return { path, filename: "reply.png", mime: "image/png" as const };
}

function gatewayFor(t: TestContext, identifyOnly = false) {
	let ws!: FakeWebSocket;
	const peer: GatewayPeer = { send: () => true, close() {} };
	const gateway = new WeComGateway({
		botId: "test-bot",
		secret: "test-secret",
		createWebSocket(url) {
			ws = new FakeWebSocket(url);
			ws.onSend = (frame) => acknowledge(frame);
			return ws;
		},
	});
	const acknowledge = (frame: any) =>
		ws.acknowledge(
			frame,
			0,
			frame.cmd === "aibot_upload_media_init"
				? { upload_id: "upload" }
				: frame.cmd === "aibot_upload_media_finish"
					? { media_id: "media" }
					: undefined,
		);
	t.after(() => gateway.stop());
	gateway.register(
		{
			instanceId: "pi",
			registrationId: "registration",
			identifyOnly,
			source: { sessionId: "session", directoryName: "project", provider: "provider", modelName: "model" },
			config: { botId: "test-bot" },
		},
		peer,
	);
	ws.open();
	ws.sent.length = 0;
	return { gateway, ws, peer, acknowledge };
}

test("the gateway reads a bounded regular PNG, rejecting missing, disguised, oversized and symlinked files", async (t) => {
	const image = await imageFile(t);
	assert.deepEqual(await readReplyImage(image.path), png);
	await assert.rejects(readReplyImage(`${image.path}-missing`), { code: "ENOENT" });
	await writeFile(image.path, Buffer.alloc(40));
	await assert.rejects(readReplyImage(image.path), /PNG/);
	await truncate(image.path, WECOM_IMAGE_MAX_BYTES + 1);
	await assert.rejects(readReplyImage(image.path), /10 MiB/);
	if (process.platform !== "win32") {
		const link = `${image.path}-link`;
		await symlink(image.path, link);
		await assert.rejects(readReplyImage(link), { code: "ELOOP" });
	}
});

test("a rendered PNG is uploaded and pushed as an image to the clicked chat, not to a default recipient", async (t) => {
	const image = await imageFile(t);
	const { gateway, ws } = gatewayFor(t);
	await gateway.push("pi", chat, { kind: "image", image });
	assert.deepEqual(
		ws.sent.map((frame) => frame.cmd),
		["aibot_upload_media_init", "aibot_upload_media_chunk", "aibot_upload_media_finish", "aibot_send_msg"],
	);
	assert.deepEqual(ws.sent.at(-1).body, {
		chatid: chat.chatId,
		chat_type: 2,
		msgtype: "image",
		image: { media_id: "media" },
	});
	assert.deepEqual(Buffer.from(ws.sent[1].body.base64_data, "base64"), png);
	assert.ok(await stat(image.path), "the sender owns temporary-file cleanup");
});

test("temporary identity-only registrations cannot upload or send images", async (t) => {
	const image = await imageFile(t);
	const { gateway, ws } = gatewayFor(t, true);
	await assert.rejects(gateway.push("pi", chat, { kind: "image", image }), /临时识别连接/);
	assert.deepEqual(ws.sent, []);
});

test("leaving during upload prevents further chunks and the image message", async (t) => {
	const image = await imageFile(t);
	const { gateway, ws, peer, acknowledge } = gatewayFor(t);
	ws.onSend = (frame) => {
		if (frame.cmd === "aibot_upload_media_init") gateway.unregister("pi", peer);
		acknowledge(frame);
	};
	await assert.rejects(gateway.push("pi", chat, { kind: "image", image }), { outcome: "not_sent" });
	assert.deepEqual(
		ws.sent.map((frame) => frame.cmd),
		["aibot_upload_media_init"],
	);
});

test("an unknown upload result is known not to have delivered a chat image", async (t) => {
	const image = await imageFile(t);
	const { gateway, ws } = gatewayFor(t);
	ws.onSend = () => ws.close();
	await assert.rejects(gateway.push("pi", chat, { kind: "image", image }), { outcome: "not_sent" });
	assert.equal(
		ws.sent.some((frame) => frame.cmd === "aibot_send_msg"),
		false,
	);
});

for (const unknown of [false, true])
	test(`a ${unknown ? "lost" : "rejected"} image-send ACK is not retried or replaced with text`, async (t) => {
		const image = await imageFile(t);
		const { gateway, ws, acknowledge } = gatewayFor(t);
		ws.onSend = (frame) => {
			if (frame.cmd === "aibot_send_msg") {
				if (unknown) ws.close();
				else ws.acknowledge(frame, 40014);
			} else acknowledge(frame);
		};
		await assert.rejects(gateway.push("pi", chat, { kind: "image", image }), {
			outcome: unknown ? "unknown" : "rejected",
		});
		const sent = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
		assert.equal(sent.length, 1);
		assert.equal(sent[0].body.msgtype, "image");
	});
