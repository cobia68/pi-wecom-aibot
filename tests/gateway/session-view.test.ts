import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionControlCard } from "../../src/extension/control-view.ts";
import { withSessions } from "../../src/gateway/session-view.ts";
import { sessionFingerprint } from "../../src/shared/control-card.ts";

const source = {
	sessionId: "01a1682b-c652-762d-b8d2-b5be10888a29",
	provider: "test-provider",
	modelName: "Model A",
	directoryName: "pi-wecom-aibot",
};

test("the session dropdown keeps the shown session selected and, beyond ten, lists the others used most recently", () => {
	const listed = (index: number, directoryName = `dir-${index}`) => ({
		source: { ...source, sessionId: `session-${String(index).padStart(2, "0")}`, directoryName },
		active: index,
	});
	// The oldest, least active session shows the card; twelve are online.
	const online = Array.from({ length: 12 }, (_, index) => listed(index + 1));
	const own = sessionControlCard(online[0].source, { status: "idle" });
	const card = withSessions(own, online);
	const ids = card.selection!.options.map((option) => option.id);
	assert.equal(ids.length, 10, "WeCom takes ten options");
	assert.equal(card.selection!.selected, sessionFingerprint("session-01"));
	assert.deepEqual(
		card.selection!.options.map((option) => option.text),
		[
			"dir-1 · n-01",
			"dir-4 · n-04",
			"dir-5 · n-05",
			"dir-6 · n-06",
			"dir-7 · n-07",
			"dir-8 · n-08",
			"dir-9 · n-09",
			"dir-10 · n-10",
			"dir-11 · n-11",
			"dir-12 · n-12",
		],
		"the shown one, then the nine most recently used, in the order they connected",
	);
	assert.match(card.subtitle!, /；另有 2 个会话，发 \/wecom-aibot sessions 查看$/);
	// Every session shows the end of its ID, so two in one folder differ; one gone offline stays shown, first.
	const twins = [listed(2, "pi-wecom-aibot"), listed(3, "pi-wecom-aibot")];
	const offline = withSessions(sessionControlCard(online[0].source, { status: "idle" }), twins);
	assert.deepEqual(
		offline.selection!.options.map((option) => option.text),
		["dir-1 · n-01", "pi-wecom-… · n-02", "pi-wecom-… · n-03"],
		"the folder cut to ten, then the last four of the ID",
	);
	assert.equal(offline.subtitle, own.subtitle, "nothing left out");
	// Any other dropdown is the card's own business.
	const prompts = sessionControlCard(online[0].source, { status: "idle", prompts: ["继续"], choosing: "prompt" });
	assert.equal(withSessions(prompts, online), prompts);
});
