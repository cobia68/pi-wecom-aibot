import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { FooterComponent, SessionManager, initTheme, type AgentSession, type ExtensionContext, type ReadonlyFooterDataProvider, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { BridgeConnectionStatus } from "../../src/extension/bridge-session.ts";
import { WeComStatus, WECOM_STATUS_KEY } from "../../src/extension/status.ts";
import { fixtureTheme, installTuiFixture } from "../support/tui-fixture.ts";

function context(mode: ExtensionContext["mode"] = "tui", hasUI = true) {
  const ctx = { ui: {} } as ExtensionContext;
  const fixture = installTuiFixture(ctx);
  const writes: [string, string | undefined][] = [];
  const setStatus = ctx.ui.setStatus;
  ctx.ui.setStatus = (key, text) => { writes.push([key, text]); setStatus(key, text); };
  Object.assign(ctx, { mode, hasUI });
  return { ...ctx, ...fixture, writes };
}

test("the name stays exactly wecom-aibot; only its foreground color indicates the connection state", () => {
  const ctx = context();
  const status = new WeComStatus();
  const cases: [BridgeConnectionStatus, ThemeColor][] = [
    ["online", "success"], ["reconnecting", "warning"], ["blocked", "error"],
  ];
  for (const [connection, color] of cases) {
    status.update(ctx, connection);
    const text = ctx.statuses.get(WECOM_STATUS_KEY)!;
    assert.equal(text, ctx.ui.theme.fg(color, "wecom-aibot"));
    assert.equal(stripVTControlCharacters(text), "wecom-aibot");
    assert.equal(visibleWidth(text), 11);
  }
  status.clear();
});

test("fresh SDK contexts and changes with the same color do not cause redundant footer writes", () => {
  const ctx = context();
  const status = new WeComStatus();
  status.update(ctx, "reconnecting");
  status.update({ ...ctx }, "reconnecting");
  status.update({ ...ctx }, "reconnecting");
  assert.deepEqual(ctx.writes, [[WECOM_STATUS_KEY, ctx.ui.theme.fg("warning", "wecom-aibot")]]);
  assert.equal(ctx.widgets.size, 1);
  status.clear();
  status.clear();
  assert.equal(ctx.writes.length, 2);
  assert.deepEqual(ctx.writes[1], [WECOM_STATUS_KEY, undefined]);
  assert.equal(ctx.widgets.size, 0);
});

test("pi theme invalidation repaints an idle status without a connection event or polling", () => {
  const ctx = context();
  const status = new WeComStatus();
  status.update(ctx, "online");
  const dark = ctx.statuses.get(WECOM_STATUS_KEY);
  Object.assign(ctx.ui, { theme: fixtureTheme("light") });
  ctx.root.invalidate();
  const light = ctx.statuses.get(WECOM_STATUS_KEY);
  assert.notEqual(light, dark);
  assert.equal(light, ctx.ui.theme.fg("success", "wecom-aibot"));
  const count = ctx.writes.length;
  ctx.root.invalidate();
  assert.equal(ctx.writes.length, count);
  status.clear();
});

test("the theme observer occupies no rows, leaves other widgets alone, and cannot revive or clear a newer status", () => {
  const ctx = context();
  const other = { render: () => ["Other widget"], invalidate() {} };
  ctx.ui.setWidget("other-widget", () => other);
  const before = ctx.containers[3].render(80);
  const status = new WeComStatus();
  status.update(ctx, "online");
  assert.deepEqual(ctx.containers[3].render(80), before);
  const observer = [...ctx.widgets.values()].find((widget) => widget !== other);
  assert.ok(observer);
  assert.deepEqual(observer.render(80), []);
  status.clear();
  const count = ctx.writes.length;
  observer.invalidate();
  observer.dispose?.();
  assert.equal(ctx.writes.length, count);
  assert.deepEqual([...ctx.widgets.values()], [other]);
  status.update(ctx, "reconnecting");
  observer.invalidate();
  observer.dispose?.();
  assert.equal(ctx.statuses.get(WECOM_STATUS_KEY), ctx.ui.theme.fg("warning", "wecom-aibot"));
  status.clear();
});

test("a host-disposed theme observer drops its old binding and allows a fresh binding", () => {
  const ctx = context();
  const status = new WeComStatus();
  status.update(ctx, "online");
  assert.equal(ctx.widgets.size, 1);
  const [widgetKey] = ctx.widgets.keys();
  ctx.ui.setWidget(widgetKey, undefined);
  assert.equal(ctx.statuses.size, 0);
  status.update(ctx, "online");
  assert.equal(ctx.widgets.size, 1);
  assert.equal(ctx.statuses.get(WECOM_STATUS_KEY), ctx.ui.theme.fg("success", "wecom-aibot"));
  status.clear();
});

test("rebinding a different UI removes the old entry and observer but preserves other extensions", () => {
  const a = context();
  const b = context();
  a.statuses.set("other", "Other A");
  b.statuses.set("other", "Other B");
  const status = new WeComStatus();
  status.update(a, "online");
  status.update(b, "online");
  assert.deepEqual([...a.statuses], [["other", "Other A"]]);
  assert.equal(a.widgets.size, 0);
  assert.equal(b.statuses.get(WECOM_STATUS_KEY), b.ui.theme.fg("success", "wecom-aibot"));
  status.update(b, undefined);
  assert.deepEqual([...b.statuses], [["other", "Other B"]]);
  assert.equal(b.widgets.size, 0);
});

test("without a visible connection, neither the name nor a theme observer is installed", () => {
  const ctx = context();
  const status = new WeComStatus();
  status.update(ctx, undefined);
  ctx.root.invalidate();
  assert.deepEqual(ctx.writes, []);
  assert.equal(ctx.widgets.size, 0);
});

test("no status or theme observer is installed in RPC, JSON, print or UI-less contexts", () => {
  const status = new WeComStatus();
  for (const ctx of [context("rpc"), context("json"), context("print"), context("tui", false)]) {
    status.update(ctx, "online");
    assert.deepEqual(ctx.writes, []);
    assert.equal(ctx.widgets.size, 0);
  }
  const tui = context();
  status.update(tui, "online");
  status.update(context("rpc"), "online");
  assert.equal(tui.statuses.size, 0, "an old TUI entry must not survive switching away from the terminal");
  assert.equal(tui.widgets.size, 0);
  status.update(undefined, undefined);
});

test("pi's real footer retains its model and usage rows, applies the name's color and fits narrow terminals", () => {
  const ctx = context();
  const status = new WeComStatus();
  const session = {
    sessionManager: SessionManager.inMemory(process.cwd()),
    state: { model: { id: "test-model", provider: "test-provider", contextWindow: 2048 } },
    modelRuntime: { isUsingSubscription: () => false },
    getContextUsage: () => ({ tokens: 42, contextWindow: 2048, percent: 2 }),
  } as unknown as AgentSession;
  const data: ReadonlyFooterDataProvider = {
    getGitBranch: () => null, onBranchChange: () => () => {},
    getAvailableProviderCount: () => 1, getExtensionStatuses: () => ctx.statuses,
  };
  const footer = new FooterComponent(session, data);
  for (const theme of ["dark", "light"]) {
    initTheme(theme, false);
    Object.assign(ctx.ui, { theme: fixtureTheme(theme) });
    const before = footer.render(80);
    assert.equal(before.length, 2);
    ctx.statuses.set("another-extension", "Other");
    for (const [connection, color] of [["online", "success"], ["reconnecting", "warning"], ["blocked", "error"]] as const) {
      status.update(ctx, connection);
      const after = footer.render(80);
      assert.deepEqual(after.slice(0, 2), before);
      assert.match(after[1], /test-model/);
      assert.equal(stripVTControlCharacters(after[2]), "Other wecom-aibot");
      assert.ok(after[2].includes(ctx.ui.theme.fg(color, "wecom-aibot")));
      for (const width of [8, 9, 12, 24, 80]) {
        for (const line of footer.render(width)) assert.ok(visibleWidth(line) <= width);
      }
    }
    status.clear();
    assert.match(footer.render(80)[2], /Other/);
    assert.doesNotMatch(footer.render(80).slice(2).join("\n"), /wecom-aibot/, "the extension row is cleared; the cwd may still contain the package name");
    ctx.statuses.delete("another-extension");
    assert.equal(footer.render(80).length, 2, "no empty extra row remains after all statuses are removed");
  }
  footer.dispose();
});
