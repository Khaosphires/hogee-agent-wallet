/**
 * Gate G3 passkey test vectors (ROLE-P2 2.6): drive /dev/passkey with a virtual authenticator, check every vector in
 * Node exactly as OZ WebAuthn.verify will (P-256 over authenticatorData ‖ sha256(clientDataJSON), low-s, the challenge
 * is the digest, the indices point at the keys), then write e2e/vectors/passkey-N.json for P1's Foundry test.
 * Run: pnpm --filter @hogee/e2e vectors
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { addVirtualAuthenticator } from "./virtual-authenticator";

const COUNT = 20;
const P256_HALF_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n >> 1n;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");

interface Vector {
  digest: string;
  qx: string;
  qy: string;
  r: string;
  s: string;
  challengeIndex: number;
  typeIndex: number;
  authenticatorData: string;
  clientDataJSON: string;
}

const hex = (h: string) => Buffer.from(h.slice(2), "hex");

function checkVector(v: Vector): void {
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: hex(v.qx).toString("base64url"), y: hex(v.qy).toString("base64url") }, format: "jwk" });
  const message = Buffer.concat([hex(v.authenticatorData), createHash("sha256").update(v.clientDataJSON, "utf8").digest()]);
  expect(verify("sha256", message, { key, dsaEncoding: "ieee-p1363" }, Buffer.concat([hex(v.r), hex(v.s)])), "P-256 signature").toBe(true);
  expect(BigInt(v.s) <= P256_HALF_N, "low-s").toBe(true);
  const client = JSON.parse(v.clientDataJSON) as { type: string; challenge: string; origin: string };
  expect(client.type).toBe("webauthn.get");
  expect(client.challenge).toBe(hex(v.digest).toString("base64url"));
  expect(client.origin).toBe("http://localhost:3000");
  const bytes = Buffer.from(v.clientDataJSON, "utf8");
  expect(bytes.subarray(v.typeIndex, v.typeIndex + 6).toString()).toBe('"type"');
  expect(bytes.subarray(v.challengeIndex, v.challengeIndex + 11).toString()).toBe('"challenge"');
  expect(hex(v.authenticatorData).subarray(0, 32).equals(createHash("sha256").update("localhost").digest()), "rpIdHash = sha256(localhost)").toBe(true);
  expect(hex(v.authenticatorData)[32]! & 0x05, "user present + verified flags").toBe(0x05);
}

test("generates and verifies 20 passkey vectors", async ({ page }) => {
  test.setTimeout(180_000);
  await addVirtualAuthenticator(page);
  await page.goto("/dev/passkey");
  await page.getByLabel("Signatures").fill(String(COUNT));
  await page.getByRole("button", { name: "Generate vectors" }).click();
  await expect(page.getByTestId("vector-status")).toHaveText(`Done: ${COUNT} vectors`, { timeout: 120_000 });
  const vectors = (await page.evaluate(() => (window as unknown as { __hogeeVectors?: unknown[] }).__hogeeVectors ?? [])) as Vector[];
  expect(vectors).toHaveLength(COUNT);
  vectors.forEach(checkVector);
  mkdirSync(OUT_DIR, { recursive: true });
  vectors.forEach((v, i) => writeFileSync(join(OUT_DIR, `passkey-${i + 1}.json`), `${JSON.stringify(v, null, 2)}\n`));
});
