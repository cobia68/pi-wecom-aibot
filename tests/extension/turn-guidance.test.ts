import assert from "node:assert/strict";
import { test } from "node:test";
import { turnGuidance } from "../../src/extension/turn-guidance.ts";

test("every run WeCom reads is told its answer becomes a card that may offer next steps", () => {
	assert.match(turnGuidance("message")!, /Do not call wecom_send/);
	for (const origin of ["message", "card", "local"] as const) {
		const text = turnGuidance(origin)!;
		assert.match(text, /<!-- wecom_next \[/, origin);
		assert.match(text, /Never write secrets/, origin);
	}
	assert.equal(turnGuidance(undefined), undefined, "a terminal run nobody reports gets nothing");
});
