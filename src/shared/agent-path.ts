/**
 * Where this extension keeps its files. Everything it owns lives in one folder inside pi's agent
 * directory, so a user finds the credentials, the gateway socket and the routing state together,
 * and `PI_CODING_AGENT_DIR` moves all of them at once.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** pi's agent directory: `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`. */
export function agentDirectory(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	return configured ? resolve(configured.replace(/^~(?=$|[\\/])/, homedir())) : join(homedir(), ".pi", "agent");
}

/** The one folder this extension owns: `config.json` and the shared gateway's runtime state. */
export function pluginDirectory(): string {
	return join(agentDirectory(), "wecom-aibot");
}

/** The socket and the routing state of the shared gateway, private to this agent directory. */
export function gatewayDirectory(): string {
	return join(pluginDirectory(), "gateway");
}
