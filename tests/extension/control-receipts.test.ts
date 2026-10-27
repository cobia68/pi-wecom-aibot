import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTROL_CARD_ENTRY, type ControlReceipt, ControlReceipts } from "../../src/extension/control-receipts.ts";
import { controlCardFor } from "../../src/shared/control-card.ts";
import { DeliveryError } from "../../src/shared/delivery.ts";

const chat = { chatId: "user", chatType: 1 as const };
const source = { sessionId: "session-A", directoryName: "project", provider: "provider", modelName: "model" };
const entry = (data: ControlReceipt) => ({ type: "custom", customType: CONTROL_CARD_ENTRY, data });

function setup(sessionId = source.sessionId, entries: unknown[] = []) {
	const logs: string[] = [];
	const cards = new ControlReceipts(
		sessionId,
		entries,
		(receipt) => {
			entries.push(entry(receipt));
		},
		(text) => logs.push(text),
	);
	return { cards, entries, logs };
}

test("one physical card is shared by concurrent callers and retained across registration and runtime replacement", async () => {
	const { cards, entries } = setup();
	const ids: string[] = [];
	let finish!: () => void;
	const first = cards.ensure("bot", chat, (id) => {
		ids.push(id);
		return new Promise<void>((resolve) => {
			finish = resolve;
		});
	});
	const second = cards.ensure("bot", chat, async () => {
		assert.fail("duplicate send");
	});
	await Promise.resolve();
	assert.equal(ids.length, 1);
	assert.equal(cards.pending, 1);
	assert.deepEqual(entries, [
		entry({ version: 1, sessionId: source.sessionId, botId: "bot", chat, cardId: ids[0], state: "unknown" }),
	]);
	finish();
	assert.equal(await first, true);
	assert.equal(await second, false);
	assert.equal(cards.pending, 0);
	assert.equal(
		await cards.ensure("bot", chat, async () => {
			assert.fail("repeat connect");
		}),
		false,
	);
	const restored = setup(source.sessionId, entries).cards;
	assert.equal(
		await restored.ensure("bot", chat, async () => {
			assert.fail("reload duplicate");
		}),
		false,
	);
});

test("receipts are scoped by bot, chat type, chat ID and session; forks inherit no physical card", async () => {
	const { cards, entries } = setup();
	const ids: string[] = [];
	const send = async (id: string) => {
		ids.push(id);
	};
	await cards.ensure("bot", chat, send);
	await cards.ensure("other-bot", chat, send);
	await cards.ensure("bot", { ...chat, chatType: 2 }, send);
	await cards.ensure("bot", { ...chat, chatId: "other" }, send);
	const fork = setup("session-B", entries).cards;
	await fork.ensure("bot", chat, send);
	assert.equal(new Set(ids).size, 5);
	assert.ok(controlCardFor(ids[4], "session-B"));
});

for (const outcome of ["unknown", "rejected"] as const) {
	test(`${outcome} delivery is never automatically repeated, but explicit resend creates a new copy`, async () => {
		const { cards, entries } = setup();
		const ids: string[] = [];
		await assert.rejects(
			cards.ensure("bot", chat, async (id) => {
				ids.push(id);
				throw new DeliveryError("failure", outcome);
			}),
			{ outcome },
		);
		const restored = setup(source.sessionId, entries).cards;
		assert.equal(
			await restored.ensure("bot", chat, async () => {
				assert.fail("automatic duplicate");
			}),
			false,
		);
		assert.equal(
			await restored.ensure(
				"bot",
				chat,
				async (id) => {
					ids.push(id);
				},
				true,
			),
			true,
		);
		assert.equal(ids.length, 2);
		assert.notEqual(ids[0], ids[1]);
	});
}

test("a crash after write-ahead reservation leaves an unknown receipt, never an automatic resend", async () => {
	const { cards, entries } = setup();
	let finish!: () => void;
	const pending = cards.ensure(
		"bot",
		chat,
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	await Promise.resolve();
	const restored = setup(source.sessionId, [...entries]).cards;
	assert.equal(
		await restored.ensure("bot", chat, async () => {
			assert.fail("uncertain delivery");
		}),
		false,
	);
	cards.dispose();
	finish();
	await pending;
	assert.equal(entries.length, 1, "late completion cannot append state through a disposed pi context");
});

test("only a definitely unwritten attempt is retried, using its original card ID", async () => {
	const { cards, entries } = setup();
	const ids: string[] = [];
	await assert.rejects(
		cards.ensure("bot", chat, async (id) => {
			ids.push(id);
			throw new DeliveryError("not connected", "not_sent");
		}),
		{ outcome: "not_sent" },
	);
	const restored = setup(source.sessionId, entries).cards;
	await restored.ensure("bot", chat, async (id) => {
		ids.push(id);
	});
	assert.deepEqual(ids, [ids[0], ids[0]]);
});

test("a new ready registration retries after the previous in-flight attempt returns not_sent", async () => {
	const { cards } = setup();
	let reject!: (error: Error) => void;
	const old = assert.rejects(
		cards.ensure(
			"bot",
			chat,
			() =>
				new Promise<void>((_resolve, fail) => {
					reject = fail;
				}),
		),
		{ outcome: "not_sent" },
	);
	let delivered = 0;
	const fresh = cards.ensure("bot", chat, async () => {
		delivered++;
	});
	await Promise.resolve();
	reject(new DeliveryError("old transport not ready", "not_sent"));
	await old;
	assert.equal(await fresh, true);
	assert.equal(delivered, 1);
});

test("write-ahead persistence failure prevents the send; ACK persistence failure retains the safe unknown receipt", async () => {
	const entries: unknown[] = [];
	const logs: string[] = [];
	let writes = 0;
	const failing = new ControlReceipts(
		source.sessionId,
		[],
		() => {
			throw new Error("disk full");
		},
		() => {},
	);
	await assert.rejects(
		failing.ensure("bot", chat, async () => {
			assert.fail("not journalled");
		}),
		{ outcome: "not_sent" },
	);
	const cards = new ControlReceipts(
		source.sessionId,
		[],
		(receipt) => {
			if (++writes > 1) throw new Error("disk full");
			entries.push(entry(receipt));
		},
		(text) => logs.push(text),
	);
	assert.equal(await cards.ensure("bot", chat, async () => {}), true);
	assert.match(logs[0], /回执未能保存/);
	assert.equal(
		await setup(source.sessionId, entries).cards.ensure("bot", chat, async () => {
			assert.fail("duplicate");
		}),
		false,
	);
});

test("a journal that appends before throwing cannot leave a definitely unsent card permanently reserved", async () => {
	const entries: unknown[] = [];
	const cards = new ControlReceipts(
		source.sessionId,
		[],
		(receipt) => {
			entries.push(entry(receipt));
			throw new Error("disk full after in-memory append");
		},
		() => {},
	);
	await assert.rejects(
		cards.ensure("bot", chat, async () => {
			assert.fail("must not send");
		}),
		{ outcome: "not_sent" },
	);
	const restored = setup(source.sessionId, entries).cards;
	let delivered = 0;
	assert.equal(
		await restored.ensure("bot", chat, async () => {
			delivered++;
		}),
		true,
	);
	assert.equal(delivered, 1);
});
