import assert from "node:assert/strict";
import { test } from "node:test";
import { turnGuidance } from "../../src/extension/turn-guidance.ts";

test("every run WeCom reads is told its answer becomes a card that may offer next steps", () => {
	assert.match(turnGuidance("message")!, /Do not call wecom_send/);
	for (const origin of ["message", "card", "local"] as const) {
		const text = turnGuidance(origin)!;
		assert.match(text, /<!-- wecom_next \[/, origin);
		assert.match(text, /Never write secrets/, origin);
		assert.match(text, /not a document page/, "the default is the plain-text quote");
	}
	assert.equal(turnGuidance(undefined), undefined, "a terminal run nobody reports gets nothing");
});

test("guidance describes the selected display honestly and prepares every answer for the three-line fallback", () => {
	for (const origin of ["message", "card", "local"] as const) {
		const linked = turnGuidance(origin, "linked")!;
		assert.match(linked, /document page in Markdown/);
		assert.match(linked, /falls back to a plain-text quote/);
		const inline = turnGuidance(origin, "inline")!;
		assert.match(inline, /not a document page or a separate Markdown message/);
		assert.match(inline, /code blocks become \[代码\]/);
		for (const text of [linked, inline]) assert.match(text, /first three short non-empty lines/);
	}
});
