import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Discover in Node, not a shell glob: Windows and POSIX run the same nested tests.
const root = fileURLToPath(new URL("../", import.meta.url));
const entries = await readdir(join(root, "tests"), { recursive: true, withFileTypes: true });
const files = entries
	.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
	.map((entry) => join(entry.parentPath, entry.name))
	.sort();
if (!files.length) throw new Error("No *.test.ts files found under tests/");

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...process.argv.slice(2), ...files], {
	cwd: root,
	stdio: "inherit",
	windowsHide: true,
});
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
