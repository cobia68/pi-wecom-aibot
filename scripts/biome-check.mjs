// Runs Biome for this project. The native binary is resolved directly: this repository may live on
// a share where npm cannot create node_modules/.bin links, so the package's own entry is used.
// Usage: node scripts/biome-check.mjs [--write] [--lint]
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const write = args.includes("--write");
const command = args.includes("--lint") ? "lint" : "check";
const binary = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
const result = spawnSync(
	process.execPath,
	[binary, command, "--error-on-warnings", ...(write ? ["--write"] : []), "."],
	{
		stdio: "inherit",
	},
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
