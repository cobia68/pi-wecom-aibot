/** config.schema.json: built from the field table, never out of date, and as strict as reading the file. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-wecom-aibot-schema-test-"));
const { CONFIG_FILE, FIELDS, chatIdProblem, patchLayer, promptsProblem, readLayer } = await import(
	"../../src/extension/config.ts"
);
const { configSchema, SCHEMA_URL } = await import("../../src/extension/config-schema.ts");

type Schema = Record<string, any>;
const schema: Schema = configSchema();
const property = (name: string): Schema => schema.properties[name];
const matches = (name: string, value: string) => new RegExp(property(name).pattern, "u").test(value);

test("the committed config.schema.json is the one the field table builds; run npm run gen:schema when not", () => {
	const committed = JSON.parse(readFileSync(new URL("../../config.schema.json", import.meta.url), "utf8"));
	assert.deepEqual(committed, schema);
	assert.equal(schema.$id, SCHEMA_URL);
});

test("the keys are the file's: every field, allowedUserIds and $schema, and nothing else", () => {
	assert.deepEqual(Object.keys(schema.properties).sort(), [
		...[...FIELDS.map((spec) => spec.name), "allowedUserIds", "$schema"].sort(),
	]);
	assert.equal(schema.additionalProperties, false);
	for (const spec of FIELDS) {
		assert.deepEqual(
			property(spec.name).enum,
			spec.choices?.map((choice) => choice.value),
			spec.name,
		);
		assert.deepEqual(property(spec.name).default, spec.default, spec.name);
	}
	assert.deepEqual(schema.dependentRequired, {
		botId: ["secret"],
		secret: ["botId"],
		defaultChatType: ["defaultChatId"],
	});
});

test("a value the schema refuses is one reading the file refuses too", () => {
	for (const chatId of ["me", "wrk_abc-1", '"me"', "a b", "a\tb"])
		assert.equal(matches("defaultChatId", chatId), chatIdProblem(chatId) === undefined, chatId);
	const prompt = (text: string) => new RegExp(property("controlPrompts").items.pattern, "u").test(text);
	for (const text of ["继续", "运行测试，再提交", "a b", " a", "a ", "a\nb", "a\u2028b"])
		assert.equal(prompt(text), promptsProblem([text]) === undefined, JSON.stringify(text));
	assert.equal(property("controlPrompts").maxItems, 10);
	assert.equal(property("controlPrompts").items.maxLength, 500);
	assert.equal(matches("secret", "  "), false);
	assert.equal(matches("docMcpUrl", "http://qyapi.weixin.qq.com/mcp"), false);
});

test("a $schema line in the global file survives config's own writes", () => {
	mkdirSync(dirname(CONFIG_FILE), { recursive: true });
	writeFileSync(CONFIG_FILE, JSON.stringify({ $schema: SCHEMA_URL, botId: "b", secret: "s" }));
	patchLayer("global", { set: { notificationScope: "all-runs" } });
	assert.equal(JSON.parse(readFileSync(CONFIG_FILE, "utf8")).$schema, SCHEMA_URL);
	assert.equal(readLayer("global")?.notificationScope, "all-runs");
});
