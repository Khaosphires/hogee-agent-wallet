/**
 * Outbound canary (project.md §12.2): national and tax ID shapes from data/pii/canary-patterns.json, context free.
 * The input is usually a serialised prompt, so JSON escapes are decoded first (a "\n" before an ID must not hide it),
 * then folded like redact() folds. Returns the entity types found, sorted; never the matched text.
 */
import type { CompiledCanary } from "./config";
import { Ranges } from "./detect";
import { decodeJsonEscapes, foldText } from "./fold";

export function canaryHits(input: string, cfg: CompiledCanary): string[] {
  const text = foldText(decodeJsonEscapes(input)).text;
  const prot = Ranges.scan(text, cfg.protected);
  const found = new Set<string>();
  for (const p of cfg.patterns) {
    if (found.has(p.entity)) continue;
    for (const m of text.matchAll(p.re)) {
      const end = m.index + m[0].length;
      if (prot.contains(m.index, end)) continue;
      if (p.validator && !p.validator(m[0])) continue;
      found.add(p.entity);
      break;
    }
  }
  return [...found].sort();
}
