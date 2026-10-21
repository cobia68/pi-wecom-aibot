import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { prepareScreenImage, screenImageHeader } from "../../../src/extension/screen/image.ts";
import type { GatewayNotification } from "../../../src/shared/notification-types.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-wecom-aibot-image-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const source = {
	sessionId: "01a1535b-d65e-749d-bd3a-a549bfe3dc9a",
	provider: "welfare-agentrouter",
	modelName: "deepseek-v4-flash",
	directoryName: "pi-wecom-aibot",
};
const notification: GatewayNotification = { kind: "completion", source, text: "fallback body" };
const palette = { accent: "#ff00ff", muted: "#999999", dim: "#777777", warning: "#ffaa00" };
const screen = {
	lines: ["BODY-LINE", "$ npm test", "256 tests passing"],
	columns: 60,
	foreground: "#eeeeee",
	background: "#111111",
	palette,
};
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

test("the card header names the directory, the kind, the model and the session", () => {
	assert.deepEqual(screenImageHeader(notification), {
		title: "🔔 pi-wecom-aibot",
		badge: "会话通知",
		tone: "accent",
		subtitle: "🏷️ welfare-agentrouter · deepseek-v4-flash",
		caption: "🆔 session: 01a1535b-d65e-749d-bd3a-a549bfe3dc9a",
	});
});

test("an aborted run says so in the warning tone instead of adding a line under the screen", () => {
	const header = screenImageHeader({ ...notification, aborted: true });
	assert.equal(header.badge, "已中止");
	assert.equal(header.tone, "warning");
	assert.equal(header.title, "🔔 pi-wecom-aibot");
	assert.equal(header.subtitle, "🏷️ welfare-agentrouter · deepseek-v4-flash");
	assert.equal(header.caption, "🆔 session: 01a1535b-d65e-749d-bd3a-a549bfe3dc9a");
});

test("a generated image keeps the Markdown fallback and writes a private PNG", async () => {
	let renderOptions: any;
	const prepared = await prepareScreenImage(notification, () => screen, {
		directory,
		render: async (_snapshot, options) => {
			renderOptions = options;
			return png;
		},
	});
	assert.deepEqual(renderOptions.header, screenImageHeader(notification), "the renderer draws the card header itself");
	assert.equal(renderOptions.fontSize, 15);
	assert.equal(renderOptions.lineHeight, 1.45);
	assert.equal(prepared.text, "fallback body");
	assert.equal(prepared.image?.mime, "image/png");
	assert.equal(prepared.image?.filename, "pi-notification.png");
	const path = prepared.image!.path;
	assert.ok(path.startsWith(directory));
	assert.deepEqual(readFileSync(path).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("capture or rasteriser failures keep the text notification and explain the fallback", async () => {
	for (const capture of [
		() => {
			throw new Error("RPC 不支持终端画面");
		},
		() => screen,
	]) {
		const warnings: string[] = [];
		const prepare = capture === (() => screen) ? () => capture() : capture;
		const prepared = await prepareScreenImage(notification, prepare as () => typeof screen, {
			directory,
			warn: (message) => warnings.push(message),
			render: async () => {
				throw new Error("缺少字体");
			},
		});
		assert.equal(prepared.image, undefined);
		assert.equal(prepared.text, "fallback body");
		assert.match(prepared.imageFailure ?? "", /生成失败：.*(?:RPC|缺少字体)/);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /已改发文字/);
	}
});

test("render errors redact configured secrets in both UI warnings and the Markdown fallback", async () => {
	const warnings: string[] = [];
	const prepared = await prepareScreenImage(notification, () => screen, {
		secrets: ["PRIVATE-SECRET"],
		warn: (line) => warnings.push(line),
		render: async () => {
			throw new Error("failed PRIVATE-SECRET");
		},
	});
	assert.doesNotMatch(warnings.join("\n"), /PRIVATE-SECRET/);
	assert.doesNotMatch(prepared.imageFailure ?? "", /PRIVATE-SECRET/);
	assert.match(prepared.imageFailure ?? "", /failed \*\*\*\*/);
});

test("an aborted image preparation rejects instead of sending a late fallback", async () => {
	const abort = new AbortController();
	abort.abort(new Error("stopped"));
	await assert.rejects(
		prepareScreenImage(notification, () => screen, { signal: abort.signal, render: async () => png }),
		/stopped/,
	);
});
