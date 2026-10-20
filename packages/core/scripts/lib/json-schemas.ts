/** Renders data/schemas/*.schema.json from the zod schemas (shared by the CLI and the drift test). */
import { z } from "zod";
import { DATA_FILE_SCHEMAS, SCHEMA_VERSION } from "../../src/index";

export const GENERATED_NOTE =
  `Generated from packages/core/src/schemas (schemaVersion ${SCHEMA_VERSION}) by packages/core/scripts/gen-json-schemas.ts. ` +
  "Do not edit; run `pnpm --filter @hogee/core gen:schemas`. Cross-field rules (zod refinements) are only enforced by " +
  "`pnpm --filter @hogee/core validate:data`.";

/** file name → file content (pretty JSON + trailing newline), in registry order. */
export function renderJsonSchemas(): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of DATA_FILE_SCHEMAS) {
    const { $schema, ...body } = z.toJSONSchema(entry.schema, { target: "draft-2020-12", io: "input", unrepresentable: "throw" });
    const doc = {
      $schema,
      title: entry.title,
      description: `Applies to: ${entry.appliesTo}`,
      $comment: GENERATED_NOTE,
      ...body,
    };
    out.set(`${entry.name}.schema.json`, `${JSON.stringify(doc, null, 2)}\n`);
  }
  return out;
}
