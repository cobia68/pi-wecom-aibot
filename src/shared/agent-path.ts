/**
 * Everything this extension owns (credentials, gateway socket, routing state) lives in one folder inside
 * pi's agent directory, so `PI_CODING_AGENT_DIR` moves all of them at once.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function agentDirectory(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	return configured ? resolve(configured.replace(/^~(?=$|[\\/])/, homedir())) : join(homedir(), ".pi", "agent");
}

export function pluginDirectory(): string {
	return join(agentDirectory(), "wecom-aibot");
}

export function gatewayDirectory(): string {
	return join(pluginDirectory(), "gateway");
}
