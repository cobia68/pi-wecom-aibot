/** Persist only destination bindings, so gateway recovery cannot silently change a user's pi. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionTarget } from "../shared/gateway-protocol.ts";

export class GatewaySelectionStore {
	private readonly file: string;
	constructor(file: string) { this.file = file; }

	load(): { entries: [string, SessionTarget][]; requireChoice: boolean } {
		try {
			const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			if (!Array.isArray(value) || value.length > 1000 || !value.every(validEntry)) throw new Error("invalid bindings");
			return { entries: value, requireChoice: false };
		} catch (error) {
			// An unreadable/corrupt existing file must not become a new singleton default.
			return { entries: [], requireChoice: (error as NodeJS.ErrnoException).code !== "ENOENT" };
		}
	}

	save(entries: [string, SessionTarget][]): void {
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600, flag: "wx" });
			renameSync(temporary, this.file);
		} finally {
			rmSync(temporary, { force: true });
		}
	}

	clear(): void { rmSync(this.file, { force: true }); }
}

export function gatewayStateFile(botId: string): string {
	const key = createHash("sha256").update(botId).digest("hex").slice(0, 32);
	return join(homedir(), ".pi", "wecom-gateway", `${key}.json`);
}

function validEntry(value: unknown): value is [string, SessionTarget] {
	if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || value[0].length > 4096) return false;
	const target = value[1] as SessionTarget | undefined;
	return !!target && [target.instanceId, target.registrationId, target.sessionId].every((part) => typeof part === "string" && part.length > 0 && part.length <= 256);
}
