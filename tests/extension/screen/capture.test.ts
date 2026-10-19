import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ScreenCapture } from "../../../src/extension/screen/capture.ts";
import { WeComStatus } from "../../../src/extension/status.ts";
import { fixtureTheme, installTuiFixture } from "../../support/tui-fixture.ts";

function setup() {
  let session = "screen-session";
  const ctx = { ui: {}, sessionManager: { getSessionId: () => session } } as unknown as ExtensionContext;
  const fixture = installTuiFixture(ctx);
  const capture = new ScreenCapture();
  capture.bind(ctx);
  return { ctx, capture, ...fixture, switchSession: () => { session = "another-session"; } };
}

test("capture contains only the latest visible rows above the editor, never editor/footer/below widgets", () => {
  const { ctx, capture, state, root } = setup();
  state.lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
  for (const mode of ["regular", "fullscreen"] as const) {
    Object.assign(root, { mode });
    const screen = capture.capture(ctx);
    assert.equal(screen.columns, 80);
    assert.equal(screen.lines.length, 10, "six rows are reserved for editor, below widgets and footer");
    assert.match(screen.lines.join("\n"), /^line-31\n/);
    assert.ok(screen.lines.includes("line-39"));
    assert.doesNotMatch(screen.lines.join("\n"), /EDITOR|FOOTER/);
  }
  state.lines = ["fresh output"];
  assert.equal(capture.capture(ctx).lines[0], "fresh output", "each capture uses the live content");
  capture.dispose();
});

test("the colored footer name and its invisible theme observer never enter the screenshot", () => {
  const { ctx, capture, state } = setup();
  const status = new WeComStatus();
  state.lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
  status.update(ctx, "online");
  const screen = capture.capture(ctx);
  assert.equal(screen.lines.length, 9);
  assert.match(screen.lines.join("\n"), /^line-32\n/);
  assert.doesNotMatch(screen.lines.join("\n"), /wecom-aibot|EDITOR|FOOTER/);
  status.clear();
  assert.equal(capture.capture(ctx).lines.length, 10);
  capture.dispose();
});

test("capture respects terminal width, ANSI styling, wide characters and theme changes", () => {
  const { ctx, capture, state } = setup();
  state.columns = 6;
  state.lines = ["\x1b[31m中文AB多余文本\x1b[0m"];
  const dark = capture.capture(ctx);
  assert.equal(visibleWidth(dark.lines[0]), 6);
  assert.match(dark.lines[0], /\x1b\[31m/);
  assert.doesNotMatch(dark.lines[0], /多余/);
  assert.match(dark.background, /^#[a-f0-9]{6}$/);
  Object.assign(ctx.ui, { theme: fixtureTheme("light") });
  const light = capture.capture(ctx);
  assert.notEqual(light.foreground, dark.foreground);
  assert.equal(light.background, "#ffffff");
  capture.dispose();
});

test("layout mismatches, overlays, session changes and unusable terminal dimensions fail closed", () => {
  const { ctx, capture, state, root, switchSession } = setup();
  state.overlay = true;
  assert.throws(() => capture.capture(ctx), /弹窗/);
  state.overlay = false;
  state.rows = 3;
  assert.throws(() => capture.capture(ctx), /终端太矮/);
  state.rows = 16;
  state.columns = 1000;
  assert.throws(() => capture.capture(ctx), /终端尺寸/);
  state.columns = 80;
  const last = root.children.pop()!;
  assert.throws(() => capture.capture(ctx), /界面结构/);
  root.children.push(last);
  switchSession();
  assert.throws(() => capture.capture(ctx), /界面结构/);
  capture.dispose();
});

test("non-TUI modes never install a widget, and disposal invalidates the old capture", () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    const capture = new ScreenCapture();
    const ctx = { mode, ui: { setWidget() { assert.fail("no terminal UI in this mode"); } } } as unknown as ExtensionContext;
    capture.bind(ctx);
    assert.throws(() => capture.capture(ctx), /只支持 pi 终端界面/);
  }
  const { capture, ctx } = setup();
  capture.dispose();
  capture.dispose();
  assert.throws(() => capture.capture(ctx), /界面结构/);
});
