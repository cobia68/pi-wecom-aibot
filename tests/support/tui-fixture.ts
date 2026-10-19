import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type Component, type TUI } from "@earendil-works/pi-tui";

// Test-only lookup of pi's real built-in themes; production receives its theme from ctx.ui.
const sdk = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const themes = await import(pathToFileURL(join(sdk, "modes/interactive/theme/theme.js")).href);
export const fixtureTheme = (name: string): Theme => themes.getThemeByName(name);

/** The real Container layout pi 1.3 mounts; only terminal I/O and the editor/footer text are fake. */
export function installTuiFixture(ctx: ExtensionContext) {
  const state = { lines: ["initial screen"], columns: 80, rows: 16, overlay: false };
  const statuses = new Map<string, string>();
  const widgets = new Map<string, Component & { dispose?: () => void }>();
  const containers = Array.from({ length: 7 }, () => new Container());
  const [document, , , widgetsAbove, editor, widgetsBelow, footer] = containers;
  const documentParts = Array.from({ length: 3 }, () => new Container());
  documentParts.forEach((part) => document.addChild(part));
  const fixed = (lines: string[]): Component => ({ render: () => lines, invalidate() {} });
  documentParts[2].addChild({ render: () => state.lines, invalidate() {} });
  widgetsAbove.addChild(new Spacer(1));
  editor.addChild(fixed(["EDITOR-DRAFT", "EDITOR-SECRET", "EDITOR-BORDER"]));
  widgetsBelow.addChild(fixed(["BELOW-EDITOR-WIDGET"]));
  footer.addChild({
    render: () => ["FOOTER-PATH", "FOOTER-TOKENS", ...(statuses.size ? [[...statuses.values()].join(" ")] : [])],
    invalidate() {},
  });
  const root = {
    children: containers,
    mode: "regular",
    terminal: { get columns() { return state.columns; }, get rows() { return state.rows; } },
    hasOverlay: () => state.overlay,
    invalidate: () => containers.forEach((container) => container.invalidate()),
  } as unknown as TUI;
  Object.assign(ctx, { mode: "tui", hasUI: true });
  Object.assign(ctx.ui, {
    theme: fixtureTheme("dark"),
    setStatus(key: string, text: string | undefined) {
      if (text === undefined) statuses.delete(key);
      else statuses.set(key, text);
    },
    setWidget(key: string, factory?: (tui: TUI, theme: Theme) => Component) {
      widgets.get(key)?.dispose?.();
      widgets.delete(key);
      if (factory) widgets.set(key, factory(root, ctx.ui.theme));
      widgetsAbove.clear();
      widgetsAbove.addChild(new Spacer(1));
      for (const widget of widgets.values()) widgetsAbove.addChild(widget);
    },
  });
  return { state, root, containers, statuses, widgets };
}
