/**
 * Gateway sockets and routing state live in the plugin folder inside pi's agent directory (or inside HOME for
 * tests). Import this first in tests that start gateways: HOME points at a temporary directory for this test
 * file and the processes it spawns.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";

const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
export const sandboxHome = mkdtempSync(join(tmpdir(), "pi-wecom-aibot-home-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  assert.equal(dirname(sandboxHome), tmpdir());
  rmSync(sandboxHome, { recursive: true, force: true });
});

/** A fake gateway listening on a real endpoint needs the private directory the real one creates. */
export function socketDirectory(endpoint: string): void {
  if (process.platform !== "win32") mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
}
