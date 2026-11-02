import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import { MESSAGE_SOURCE_ENTRY, renderMessageSource, sourceLine } from "../../src/extension/message-source.ts";
import { fixtureTheme } from "../support/tui-fixture.ts";

const entry = (data: unknown): CustomEntry => ({
	type: "custom",
	id: "entry-1",
	parentId: null,
	timestamp: new Date(0).toISOString(),
	customType: MESSAGE_SOURCE_ENTRY,
	data,
});

const drawn = (data: unknown): string[] | undefined =>
	renderMessageSource(entry(data), { expanded: false }, fixtureTheme("dark"))
		?.render(60)
		.map((line) => stripVTControlCharacters(line).trimEnd());

test("the source line names the sender and the chat type, never the chat's ID", () => {
	assert.equal(sourceLine({ userid: "alice", chatType: 1 }), "[wecom|from:alice|chat:单聊]");
	assert.equal(sourceLine({ userid: "bob", chatType: 2 }), "[wecom|from:bob|chat:群聊]");
	assert.equal(
		sourceLine({ userid: "ali ce|x]\n\u001b[2J", chatType: 2 }),
		"[wecom|from:ali_ce_x_[2J|chat:群聊]",
		"no break, delimiter or terminal control from WeCom ends or restyles the line",
	);
});

test("pi draws the entry as one line aligned with the message; malformed data draws nothing", () => {
	assert.deepEqual(drawn({ userid: "alice", chatType: 2 }), [" [wecom|from:alice|chat:群聊]"]);
	for (const data of [undefined, null, "alice", { userid: "alice" }, { userid: 1, chatType: 1 }, { chatType: 3 }])
		assert.equal(drawn(data), undefined, JSON.stringify(data));
});
