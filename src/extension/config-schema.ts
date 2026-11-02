/**
 * The JSON Schema of the global `config.json`, for editors to complete and check. It is built from the field
 * table in config.ts, so it accepts what reading the file accepts. The generated file is config.schema.json at
 * the repository root: `npm run gen:schema` writes it again, and a test fails when it is out of date.
 *
 * The schema checks how a value is written, never more than reading the file does: whether a document address
 * really is the smart robot's is still for `/wecom-aibot config show` to say.
 */
import { MAX_PROMPT_LENGTH, MAX_PROMPTS } from "../shared/control-card.ts";
import { FIELDS, type FieldName, type FieldSpec } from "./config.ts";

/** Where it is published: the root of the repository mirrored on GitHub. A configuration's `$schema` names it. */
export const SCHEMA_URL = "https://raw.githubusercontent.com/cobia68/pi-wecom-aibot/main/config.schema.json";

/** Text with something besides whitespace in it. */
const NOT_BLANK = "\\S";

/** How each field's value is written, as reading the file checks it. */
const VALUES: Record<FieldName, Record<string, unknown>> = {
	botId: { type: "string", pattern: NOT_BLANK },
	secret: { type: "string", pattern: NOT_BLANK },
	// A userid or chatid never holds quotes or whitespace (chatIdProblem).
	defaultChatId: { type: "string", pattern: "^[^\"'“”‘’`\\s]+$" },
	defaultChatType: { type: "integer" },
	notificationScope: { type: "string" },
	contentDisplay: { type: "string" },
	controlPrompts: {
		type: "array",
		maxItems: MAX_PROMPTS,
		uniqueItems: true,
		items: {
			type: "string",
			minLength: 1,
			maxLength: MAX_PROMPT_LENGTH,
			// No surrounding whitespace, no line break or control character (promptsProblem).
			pattern: "^(?!\\s)[^\\u0000-\\u001f\\u007f\\u2028\\u2029]*(?<!\\s)$",
		},
	},
	docMcpUrl: { type: "string", pattern: "^https://", maxLength: 2048 },
};

function field(spec: FieldSpec): Record<string, unknown> {
	const choices = spec.choices?.map((choice) => `${choice.value}：${choice.description}`).join("；");
	const label = spec.label.toLowerCase() === spec.name.toLowerCase() ? "" : `${spec.label}：`;
	return {
		description: `${label}${spec.description}${choices ? `。${choices}` : ""}`,
		...VALUES[spec.name],
		...(spec.choices && { enum: spec.choices.map((choice) => choice.value) }),
		...(spec.default !== undefined && { default: spec.default }),
	};
}

export function configSchema(): Record<string, unknown> {
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: SCHEMA_URL,
		title: "pi-wecom-aibot 全局配置",
		description:
			"~/.pi/agent/wecom-aibot/config.json。用 /wecom-aibot config 查看和修改；allowedUserIds 只能在这里手写",
		type: "object",
		additionalProperties: false,
		properties: {
			$schema: { description: "这份 JSON Schema 的地址，给编辑器用", type: "string" },
			...Object.fromEntries(FIELDS.map((spec) => [spec.name, field(spec)])),
			allowedUserIds: {
				description: "允许给 pi 发任务的企微 userid；不写或留空时所有人都能用。只能写在全局配置里",
				type: "array",
				items: { type: "string", pattern: NOT_BLANK },
			},
		},
		// botId 与 secret 成组；defaultChatType 要和 defaultChatId 一起写。
		dependentRequired: { botId: ["secret"], secret: ["botId"], defaultChatType: ["defaultChatId"] },
	};
}
