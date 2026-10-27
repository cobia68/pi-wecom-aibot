import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CONTROL_CARD_ENTRY, ControlReceipts } from "../../src/extension/control-receipts.ts";

test("real session storage retains control deliveries across reopen and tree moves, excludes them from model context, and isolates forks", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-control-journal-"));
	try {
		const manager = SessionManager.create(directory, directory);
		const firstUser = manager.appendMessage({ role: "user", content: "A local task", timestamp: Date.now() });
		const owner = (session: SessionManager) =>
			new ControlReceipts(
				session.getSessionId(),
				session.getEntries(),
				(receipt) => {
					session.appendCustomEntry(CONTROL_CARD_ENTRY, receipt);
				},
				(message) => {
					assert.fail(message);
				},
			);
		let deliveries = 0;
		const deliver = async () => {
			deliveries++;
		};
		const chat = { chatId: "private-control-target", chatType: 1 as const };
		await owner(manager).ensure("test-bot", chat, deliver);
		assert.equal(manager.getEntries().filter((entry) => entry.type === "custom").length, 2);
		assert.doesNotMatch(
			JSON.stringify(manager.buildSessionContext()),
			/private-control-target|wecom-aibot-control-card/,
		);
		manager.branch(firstUser);
		assert.equal(manager.getBranch().filter((entry) => entry.type === "custom").length, 0);
		assert.equal(
			await owner(manager).ensure("test-bot", chat, deliver),
			false,
			"a branch move cannot undo a real delivery",
		);
		const file = manager.getSessionFile();
		assert.ok(file);
		const restored = SessionManager.open(file);
		assert.equal(await owner(restored).ensure("test-bot", chat, deliver), false);
		assert.equal(deliveries, 1);
		const fork = SessionManager.forkFrom(file, directory, directory);
		assert.notEqual(fork.getSessionId(), manager.getSessionId());
		assert.equal(await owner(fork).ensure("test-bot", chat, deliver), true);
		assert.equal(deliveries, 2);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
