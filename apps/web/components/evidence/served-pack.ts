import { verifyBundle, type BundleFiles, type VerifyResult } from "@hogee/verify-evidence";

/**
 * Runs the offline verifier on a pack's files as `fetchFile` serves them (verify-panel: from the local API). Every file
 * goes in as its exact bytes, as `make verify` reads them from disk, never as decoded text: Blob.text() drops a BOM and
 * replaces invalid UTF-8, so the hashes would be of other bytes (run-10 skills re-check H-2). The verifier decodes text
 * itself, strictly (fileText).
 */
export async function verifyServedPack(files: readonly string[], fetchFile: (path: string) => Promise<Blob>): Promise<VerifyResult> {
  const entries = await Promise.all(files.map(async (path) => [path, new Uint8Array(await (await fetchFile(path)).arrayBuffer())] as const));
  return verifyBundle(Object.fromEntries(entries) as BundleFiles);
}
