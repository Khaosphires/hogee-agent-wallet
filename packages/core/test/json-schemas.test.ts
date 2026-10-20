import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_FILE_SCHEMAS, SCENARIO_RINA_FILE_SCHEMAS } from "../src/index";
import { renderJsonSchemas } from "../scripts/lib/json-schemas";
import { REPO_ROOT } from "../scripts/lib/paths";

describe("generated JSON Schemas", () => {
  const rendered = renderJsonSchemas();

  it("covers every registered data file schema, including each scenario-rina fixture", () => {
    expect(rendered.size).toBe(DATA_FILE_SCHEMAS.length);
    for (const file of Object.keys(SCENARIO_RINA_FILE_SCHEMAS)) {
      expect(rendered.has(`scenario-rina-${file.replace(/\.json$/, "")}.schema.json`)).toBe(true);
    }
  });

  it("data/schemas is up to date (run `pnpm --filter @hogee/core gen:schemas`)", () => {
    for (const [file, content] of rendered) {
      const path = join(REPO_ROOT, "data", "schemas", file);
      expect(existsSync(path), `missing data/schemas/${file}`).toBe(true);
      expect(readFileSync(path, "utf8"), `stale data/schemas/${file}`).toBe(content);
    }
  });

  it("strict objects become additionalProperties: false", () => {
    const supplier = JSON.parse(rendered.get("supplier.schema.json") ?? "{}") as { additionalProperties?: boolean };
    expect(supplier.additionalProperties).toBe(false);
  });
});
