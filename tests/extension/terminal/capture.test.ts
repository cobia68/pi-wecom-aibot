import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FooterStatus } from "../../../src/extension/footer-status.ts";
import { TerminalCapture } from "../../../src/extension/terminal/capture.ts";
import { installTuiFixture } from "../../support/tui-fixture.ts";

function setup() {
	let session = "terminal-session";
	const ctx = { ui: {}, sessionManager: { getSessionId: () => session } } as unknown as ExtensionContext;
	const fixture = installTuiFixture(ctx);
	const capture = new TerminalCapture();
	capture.bind(ctx);
	return {
		ctx,
		capture,
		...fixture,
		switchSession: () => {
			session = "another-session";
		},
	};
}

test("only the latest visible rows above the editor are read, never the editor, footer or widgets below", () => {
	const { ctx, capture, state, root } = setup();
	state.lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
	for (const mode of ["regular", "fullscreen"] as const) {
		Object.assign(root, { mode });
		const lines = capture.read(ctx);
		assert.equal(lines.length, 9, "seven rows are reserved for the status bar, editor, below widgets and footer");
		assert.match(lines.join("\n"), /^line-31\n/);
		assert.ok(lines.includes("line-39"));
		assert.doesNotMatch(lines.join("\n"), /EDITOR|FOOTER/);
	}
	state.lines = ["fresh output"];
	assert.equal(capture.read(ctx)[0], "fresh output", "each read uses the live content");
	capture.dispose();
});

test("the status bar above the editor is never read, whichever widget renders it", () => {
	const { ctx, capture, state } = setup();
	state.lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
	// A powerline footer places its bar as a widget above the editor, exactly like the real one does.
	ctx.ui.setWidget("powerline", () => ({ render: () => ["POWERLINE-BAR"], invalidate() {} }));
	const lines = capture.read(ctx);
	assert.doesNotMatch(lines.join("\n"), /POWERLINE-BAR/);
	assert.equal(lines.length, 8, "the bar's row is excluded like the editor's");
	assert.match(lines.join("\n"), /^line-32\n/);
	capture.dispose();
});

test("the coloured footer name and its invisible theme observer are never read", () => {
	const { ctx, capture, state } = setup();
	const status = new FooterStatus();
	state.lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
	status.update(ctx, "online");
	const lines = capture.read(ctx);
	assert.equal(lines.length, 8);
	assert.match(lines.join("\n"), /^line-32\n/);
	assert.doesNotMatch(lines.join("\n"), /wecom-aibot|EDITOR|FOOTER/);
	status.clear();
	assert.equal(capture.read(ctx).length, 9);
	capture.dispose();
});

test("lines keep their ANSI styling and wide characters, cut to the terminal's width", () => {
	const { ctx, capture, state } = setup();
	state.columns = 6;
	state.lines = ["\x1b[31m中文AB多余文本\x1b[0m"];
	const [line] = capture.read(ctx);
	assert.equal(visibleWidth(line), 6);
	assert.match(line, /\x1b\[31m/);
	assert.doesNotMatch(line, /多余/);
	capture.dispose();
});

test("layout mismatches, overlays, session changes and unusable terminal sizes fail closed", () => {
	const { ctx, capture, state, root, switchSession } = setup();
	state.overlay = true;
	assert.throws(() => capture.read(ctx), /弹窗/);
	state.overlay = false;
	state.rows = 3;
	assert.throws(() => capture.read(ctx), /终端太矮/);
	state.rows = 16;
	state.columns = 1000;
	assert.throws(() => capture.read(ctx), /终端尺寸/);
	state.columns = 80;
	const last = root.children.pop()!;
	assert.throws(() => capture.read(ctx), /界面结构/);
	root.children.push(last);
	switchSession();
	assert.throws(() => capture.read(ctx), /界面结构/);
	capture.dispose();
});

test("non-TUI modes never install a widget, and disposal ends the binding", () => {
	for (const mode of ["rpc", "json", "print"] as const) {
		const capture = new TerminalCapture();
		const ctx = {
			mode,
			ui: {
				setWidget() {
					assert.fail("no terminal UI in this mode");
				},
			},
		} as unknown as ExtensionContext;
		capture.bind(ctx);
		assert.throws(() => capture.read(ctx), /只有 pi 终端界面能读画面/);
	}
	const { capture, ctx } = setup();
	capture.dispose();
	capture.dispose();
	assert.throws(() => capture.read(ctx), /界面结构/);
});
