// Writes config.schema.json at the repository root from the field table: run npm run gen:schema after changing a field.
import { writeFileSync } from "node:fs";
import { configSchema } from "../src/extension/config-schema.ts";

const target = new URL("../config.schema.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(configSchema(), null, 2)}\n`);
console.log(`wrote ${target.pathname}`);
