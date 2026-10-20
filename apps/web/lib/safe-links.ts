/**
 * Links built from values the page did not write (audit run-8), kept here so they can be tested without rendering:
 *   - an evidence bundle row's artifact path (evidence-table.tsx): `encodeURIComponent` leaves dots alone, so a `..`
 *     segment would survive into the link and the browser would resolve it to another same-origin path. A path is
 *     linked only if the files route would accept it (api-contract EvidenceFileParams) and no segment is empty, `.` or
 *     `..`; anything else gets no link.
 *   - a plan rule's source URL (rule-list.tsx): only `https:` is linked. `javascript:`, `data:`, `http:` and anything
 *     that does not parse are shown as text; a placeholder (`*.invalid`) is not shown at all.
 */
import { EvidenceFileParams } from "@hogee/api-contract";

/** At most this much of a refused source URL is shown as text. */
const MAX_SOURCE_TEXT = 200;

/** `path` when it names a file inside the bundle, else null (no link). */
export function artifactPath(path: string): string | null {
  if (!EvidenceFileParams.shape.path.safeParse(path).success) return null;
  const segments = path.split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..") ? path : null;
}

export type SourceLink =
  | { readonly kind: "link"; readonly href: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "placeholder" };

/** How to show a rule's source URL: an https link, plain text for anything else, nothing for a placeholder. */
export function sourceLink(url: string): SourceLink {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "text", text: url.slice(0, MAX_SOURCE_TEXT) };
  }
  if (/\.invalid$/i.test(parsed.hostname)) return { kind: "placeholder" };
  if (parsed.protocol !== "https:") return { kind: "text", text: url.slice(0, MAX_SOURCE_TEXT) };
  return { kind: "link", href: parsed.href };
}
