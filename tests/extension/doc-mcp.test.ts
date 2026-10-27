import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { DocError, DocMcpClient, docUrlProblem, docUrlSecrets, findField } from "../../src/extension/doc-mcp.ts";

const URL = "https://qyapi.weixin.qq.com/mcp/v2/bot/doc?apikey=secret-key-0123456789";

interface Seen {
	method: string;
	session: string | null;
	version: string | null;
}

/** A Streamable HTTP server: JSON for initialize, SSE for the rest, as the live service answers. */
function server(t: TestContext, tool: (name: string, args: any) => unknown, options: { expire?: boolean } = {}) {
	const seen: Seen[] = [];
	let sessions = 0;
	let expired = !options.expire;
	t.mock.method(globalThis, "fetch", async (input: any, init?: any) => {
		assert.equal(String(input), URL);
		const message = JSON.parse(init.body);
		const headers = init.headers as Record<string, string>;
		seen.push({
			method: message.method,
			session: headers["mcp-session-id"] ?? null,
			version: headers["mcp-protocol-version"] ?? null,
		});
		if (message.method === "initialize") {
			sessions++;
			return new Response(
				JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26" } }),
				{
					headers: { "content-type": "application/json", "mcp-session-id": `session-${sessions}` },
				},
			);
		}
		if (message.id === undefined) return new Response(null, { status: 202 });
		// The first call after a session exists finds it expired.
		if (!expired) {
			expired = true;
			return new Response("session not found", { status: 404 });
		}
		const result = tool(message.params.name, message.params.arguments);
		return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	});
	return seen;
}

test("a call opens one MCP session, then names it and the negotiated version on every request", async (t) => {
	const seen = server(t, () => ({ content: [{ type: "text", text: JSON.stringify({ errcode: 0, docid: "a1_x" }) }] }));
	const client = new DocMcpClient(URL);
	assert.equal(findField(await client.call("smartpage_create", { name: "n" }), "docid"), "a1_x");
	await client.call("smartpage_create", { name: "m" });
	assert.deepEqual(seen, [
		{ method: "initialize", session: null, version: null },
		{ method: "notifications/initialized", session: "session-1", version: "2025-03-26" },
		{ method: "tools/call", session: "session-1", version: "2025-03-26" },
		{ method: "tools/call", session: "session-1", version: "2025-03-26" },
	]);
});

test("an expired session (404) is reopened once and the call repeated", async (t) => {
	const seen = server(t, () => ({ content: [{ type: "text", text: "{}" }] }), { expire: true });
	await new DocMcpClient(URL).call("media_upload", {});
	assert.deepEqual(
		seen.map((item) => `${item.method}@${item.session}`),
		[
			"initialize@null",
			"notifications/initialized@session-1",
			"tools/call@session-1",
			"initialize@null",
			"notifications/initialized@session-2",
			"tools/call@session-2",
		],
	);
});

test("a tool's errcode or isError is an error that keeps WeCom's code but drops its hint and the address", async (t) => {
	server(t, (name) =>
		name === "smartpage_pages_get"
			? {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								errcode: 851008,
								errmsg: "partial no authorization, hint: [1792], from ip: 1.2.3.4, more info at https://x",
							}),
						},
					],
				}
			: { isError: true, content: [{ type: "text", text: `bad call to ${URL}` }] },
	);
	const client = new DocMcpClient(URL);
	await assert.rejects(client.call("smartpage_pages_get", {}), (error: unknown) => {
		assert.ok(error instanceof DocError);
		assert.equal(error.errcode, 851008);
		assert.equal(error.message, "smartpage_pages_get 失败：企业微信 851008：partial no authorization");
		return true;
	});
	await assert.rejects(client.call("other", {}), (error: unknown) => {
		assert.ok(error instanceof DocError);
		assert.doesNotMatch(error.message, /secret-key|qyapi/);
		return true;
	});
});

test("network and HTTP failures never quote the address or its key", async (t) => {
	t.mock.method(globalThis, "fetch", async () => {
		throw new TypeError(`fetch failed for ${URL}`);
	});
	await assert.rejects(new DocMcpClient(URL).call("x", {}), (error: unknown) => {
		assert.ok(error instanceof DocError);
		assert.equal(error.kind, "network");
		assert.doesNotMatch(error.message, /secret-key-0123456789|apikey=/);
		return true;
	});
	t.mock.restoreAll();
	t.mock.method(globalThis, "fetch", async () => new Response(`denied ${URL}`, { status: 403 }));
	await assert.rejects(new DocMcpClient(URL).call("x", {}), (error: unknown) => {
		assert.ok(error instanceof DocError);
		assert.equal(error.errcode, 403);
		assert.doesNotMatch(error.message, /secret-key-0123456789/);
		return true;
	});
});

test("only a bare https address on a qq.com host is accepted, and its key parts are what gets masked", () => {
	assert.equal(docUrlProblem(URL), undefined);
	assert.match(docUrlProblem("http://qyapi.weixin.qq.com/mcp")!, /https/);
	assert.match(docUrlProblem("https://example.com/mcp?apikey=x")!, /qq\.com/);
	assert.match(docUrlProblem("https://evilqq.com/mcp")!, /qq\.com/);
	assert.match(docUrlProblem(`"${URL}"`)!, /引号/);
	assert.match(docUrlProblem(`{"url": "${URL}"}`)!, /引号/);
	assert.deepEqual(docUrlSecrets(URL), [URL, "secret-key-0123456789"]);
});
