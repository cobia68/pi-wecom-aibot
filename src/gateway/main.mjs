import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Load this package's entire src/ tree, including shared/ and node_modules installations.
// No dev-only runner, pi loader or parent process is needed by the daemon.
const root = new URL("../", import.meta.url).href;
registerHooks({
	load(url, context, nextLoad) {
		if (url.startsWith(root) && url.endsWith(".ts")) {
			return { format: "module", shortCircuit: true,
				source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip", sourceUrl: url }) };
		}
		return nextLoad(url, context);
	},
});

export async function bootstrap(overrides = {}) {
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
		if (Buffer.byteLength(input) > 65_536) throw new Error("invalid gateway bootstrap");
	}
	const { endpoint, credentials } = JSON.parse(input);
	const { startGatewayServer } = await import("./server.ts");
	const { gatewayStateFile } = await import("./selection-store.ts");
	const server = await startGatewayServer({ routingStateFile: gatewayStateFile(credentials.botId), ...overrides, endpoint, credentials });
	if (!server) return; // Another contender owns the shared endpoint.
	const close = () => server.close();
	process.once("SIGINT", close);
	process.once("SIGTERM", close);
	await server.closed;
	process.off("SIGINT", close);
	process.off("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	bootstrap().catch(() => { process.exitCode = 1; });
}
