import { fileURLToPath } from "node:url";

/** Repo root, resolved from this file's location (packages/core/scripts/lib → ../../../..). */
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
