import assert from "node:assert/strict";
import { test } from "node:test";
import { type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { colorToHex, visibleWidth } from "@earendil-works/pi-tui";
import { ScreenCapture } from "../../../src/extension/screen/capture.ts";
import { WeComStatus } from "../../../src/extension/status.ts";
import { fixtureTheme, installTuiFixture, setLiveTheme } from "../../support/tui-fixture.ts";

function setup() {
	let session = "screen-session";
	const ctx = { ui: {}, sessionManager: { getSessionId: () => session } } as unknown as ExtensionContext;
	const fixture = installTuiFixture(ctx);
	const capture = new ScreenCapture();
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

test("capture contains only the latest visible rows above the editor, never editor/footer/below widgets", () => {
	const { ctx, capture, state, root } = setup();
	state.lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
	for (const mode of ["regular", "fullscreen"] as const) {
		Object.assign(root, { mode });
		const screen = capture.capture(ctx, "dark");
		assert.equal(screen.columns, 80);
		assert.equal(
			screen.lines.length,
			9,
			"seven rows are reserved for the status bar, editor, below widgets and footer",
		);
		assert.match(screen.lines.join("\n"), /^line-31\n/);
		assert.ok(screen.lines.includes("line-39"));
		assert.doesNotMatch(screen.lines.join("\n"), /EDITOR|FOOTER/);
	}
	state.lines = ["fresh output"];
	assert.equal(capture.capture(ctx, "dark").lines[0], "fresh output", "each capture uses the live content");
	capture.dispose();
});

test("the status bar above the editor is never captured, whichever widget renders it", () => {
	const { ctx, capture, state } = setup();
	state.lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
	// A powerline footer places its bar as a widget above the editor, exactly like the real one does.
	ctx.ui.setWidget("powerline", () => ({ render: () => ["POWERLINE-BAR"], invalidate() {} }));
	const screen = capture.capture(ctx, "dark");
	assert.doesNotMatch(screen.lines.join("\n"), /POWERLINE-BAR/);
	assert.equal(screen.lines.length, 8, "the bar's row is excluded from the capture like the editor's");
	assert.match(screen.lines.join("\n"), /^line-32\n/);
	capture.dispose();
});

test("the colored footer name and its invisible theme observer never enter the screenshot", () => {
	const { ctx, capture, state } = setup();
	const status = new WeComStatus();
	state.lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
	status.update(ctx, "online");
	const screen = capture.capture(ctx, "dark");
	assert.equal(screen.lines.length, 8);
	assert.match(screen.lines.join("\n"), /^line-32\n/);
	assert.doesNotMatch(screen.lines.join("\n"), /wecom-aibot|EDITOR|FOOTER/);
	status.clear();
	assert.equal(capture.capture(ctx, "dark").lines.length, 9);
	capture.dispose();
});

test("capture respects terminal width, ANSI styling and wide characters; the screenshot theme sets the colours", () => {
	const { ctx, capture, state } = setup();
	state.columns = 6;
	state.lines = ["\x1b[31m中文AB多余文本\x1b[0m"];
	const dark = capture.capture(ctx, "dark");
	assert.equal(visibleWidth(dark.lines[0]), 6);
	assert.match(dark.lines[0], /\x1b\[31m/);
	assert.doesNotMatch(dark.lines[0], /多余/);
	assert.equal(dark.background, "#000000");
	// pi's own theme does not matter: the screenshot theme decides.
	Object.assign(ctx.ui, { theme: fixtureTheme("dark") });
	const light = capture.capture(ctx, "light");
	assert.notEqual(light.foreground, dark.foreground);
	assert.equal(light.background, "#ffffff");
	assert.equal(light.palette.accent, colorToHex(fixtureTheme("light").colors.accent));
	capture.dispose();
});

test("the captured rows render in the screenshot theme, and pi's own theme is restored afterwards", (t) => {
	const { ctx, capture, containers } = setup();
	setLiveTheme("light");
	t.after(() => setLiveTheme("dark"));
	// A component that reads pi's live theme while rendering, as pi's message components do.
	const heading = { render: () => [getMarkdownTheme().heading("HEADING")], invalidate() {} };
	(containers[0] as unknown as { children: { addChild(c: unknown): void }[] }).children[2].addChild(heading);
	const darkHeading = fixtureTheme("dark").fg("mdHeading", "HEADING");
	const lightHeading = fixtureTheme("light").fg("mdHeading", "HEADING");
	assert.notEqual(darkHeading, lightHeading, "the two themes colour headings differently");
	const screen = capture.capture(ctx, "dark");
	assert.ok(screen.lines.includes(darkHeading), JSON.stringify(screen.lines));
	assert.equal(heading.render()[0], lightHeading, "pi keeps rendering in its own theme");
	// Already in the screenshot theme: nothing is swapped.
	assert.ok(capture.capture(ctx, "light").lines.includes(lightHeading));
	capture.dispose();
});

test("without a screenshot theme the rows are exactly what pi shows, and pi's theme is never touched", (t) => {
	const { ctx, capture, containers } = setup();
	setLiveTheme("light");
	// ctx.ui.theme is pi's live theme, a custom one included.
	Object.assign(ctx.ui, { theme: fixtureTheme("light"), getTheme: () => assert.fail("no theme is loaded") });
	const heading = { render: () => [getMarkdownTheme().heading("HEADING")], invalidate() {} };
	(containers[0] as unknown as { children: { addChild(c: unknown): void }[] }).children[2].addChild(heading);
	const slot = Symbol.for("@earendil-works/pi-coding-agent:theme");
	const live = (globalThis as unknown as Record<symbol, unknown>)[slot];
	let writes = 0;
	Object.defineProperty(globalThis, slot, {
		configurable: true,
		get: () => live,
		set: () => {
			writes++;
		},
	});
	t.after(() => {
		Object.defineProperty(globalThis, slot, { configurable: true, writable: true, value: live });
		setLiveTheme("dark");
	});
	const screen = capture.capture(ctx, undefined);
	assert.ok(screen.lines.includes(fixtureTheme("light").fg("mdHeading", "HEADING")), JSON.stringify(screen.lines));
	assert.equal(screen.background, "#ffffff");
	assert.equal(screen.palette.accent, colorToHex(fixtureTheme("light").colors.accent));
	assert.equal(writes, 0);
	// A named theme does swap (and restores), so the check above would have seen one.
	Object.assign(ctx.ui, { getTheme: (name: string) => fixtureTheme(name) });
	capture.capture(ctx, "dark");
	assert.ok(writes > 0);
	capture.dispose();
});

test("an unrecognisable live theme or a theme pi does not have fails closed instead of a wrong image", (t) => {
	const { ctx, capture } = setup();
	const slot = Symbol.for("@earendil-works/pi-coding-agent:theme");
	const slots = globalThis as unknown as Record<symbol, unknown>;
	const live = slots[slot];
	t.after(() => {
		slots[slot] = live;
	});
	slots[slot] = undefined;
	assert.throws(() => capture.capture(ctx, "light"), /截图主题/);
	slots[slot] = live;
	Object.assign(ctx.ui, { getTheme: () => undefined });
	assert.throws(() => capture.capture(ctx, "dark"), /pi 中没有截图主题 dark.*config <session\|global> edit/);
	capture.dispose();
});

test("layout mismatches, overlays, session changes and unusable terminal dimensions fail closed", () => {
	const { ctx, capture, state, root, switchSession } = setup();
	state.overlay = true;
	assert.throws(() => capture.capture(ctx, "dark"), /弹窗/);
	state.overlay = false;
	state.rows = 3;
	assert.throws(() => capture.capture(ctx, "dark"), /终端太矮/);
	state.rows = 16;
	state.columns = 1000;
	assert.throws(() => capture.capture(ctx, "dark"), /终端尺寸/);
	state.columns = 80;
	const last = root.children.pop()!;
	assert.throws(() => capture.capture(ctx, "dark"), /界面结构/);
	root.children.push(last);
	switchSession();
	assert.throws(() => capture.capture(ctx, "dark"), /界面结构/);
	capture.dispose();
});

test("non-TUI modes never install a widget, and disposal invalidates the old capture", () => {
	for (const mode of ["rpc", "json", "print"] as const) {
		const capture = new ScreenCapture();
		const ctx = {
			mode,
			ui: {
				setWidget() {
					assert.fail("no terminal UI in this mode");
				},
			},
		} as unknown as ExtensionContext;
		capture.bind(ctx);
		assert.throws(() => capture.capture(ctx, "dark"), /只支持 pi 终端界面/);
	}
	const { capture, ctx } = setup();
	capture.dispose();
	capture.dispose();
	assert.throws(() => capture.capture(ctx, "dark"), /界面结构/);
});
