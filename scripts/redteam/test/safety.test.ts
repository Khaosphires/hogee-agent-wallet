/** The post-run secret scan finds a secret anywhere in the bundle and nothing in a clean one. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { SoftAuthenticator } from "../src/api-internals";
import { founderSecrets, scanForSecrets, secretsOf } from "../src/safety";
import type { Stack } from "../src/stack";

describe("scanForSecrets", () => {
  it("reports the files that contain a secret, recursively", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-scan-"));
    try {
      mkdirSync(join(dir, "artifacts", "T30"), { recursive: true });
      writeFileSync(join(dir, "evidence.json"), "[]");
      writeFileSync(join(dir, "artifacts", "T30", "http.json"), JSON.stringify({ leaked: "k3y-material-0123456789abcdef" }));
      expect(scanForSecrets(dir, ["k3y-material-0123456789abcdef"])).toEqual([join("artifacts", "T30", "http.json")]);
      expect(scanForSecrets(dir, ["something-else-entirely-0000"])).toEqual([]);
      expect(scanForSecrets(dir, [])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("founder secrets (run-7 re-check L5)", () => {
  const walletKey = generatePrivateKey();
  const auth = new SoftAuthenticator();
  const secrets = founderSecrets(walletKey, auth);
  const [d, dHex, derHex, derB64] = auth.secretForms();

  it("are the real backup-wallet key and the soft passkey's private key (JWK and PKCS8 forms)", () => {
    expect(secrets).toEqual(expect.arrayContaining([walletKey, walletKey.slice(2), d, dHex, derHex, derB64]));
    const jwk = createPublicKey(createPrivateKey({ key: { kty: "EC", crv: "P-256", d: d as string, x: Buffer.from(auth.qx.slice(2), "hex").toString("base64url"), y: Buffer.from(auth.qy.slice(2), "hex").toString("base64url") }, format: "jwk" })).export({ format: "jwk" });
    expect(`0x${Buffer.from(jwk.x as string, "base64url").toString("hex")}`).toBe(auth.qx);
    expect(createPrivateKey({ key: Buffer.from(derHex as string, "hex"), format: "der", type: "pkcs8" }).export({ format: "jwk" }).d).toBe(d);
  });

  it("are in secretsOf, so the scan fails a bundle that leaks either", () => {
    const stack = {
      agent: { memoryKey: null },
      childKeyEnv: {},
      flags: { cookieSecret: undefined, officerToken: undefined, stripeWebhookSecret: undefined },
      loadedSecrets: [],
      generatedSecrets: secrets,
      infra: { cfg: { rpcUrls: [], databaseUrl: "postgres://hogee@127.0.0.1:5432/x" } },
    } as unknown as Stack;
    const all = secretsOf(stack);
    for (const leaked of [walletKey.slice(2), d, derB64]) {
      const dir = mkdtempSync(join(tmpdir(), "rt-scan-l5-"));
      try {
        writeFileSync(join(dir, "evidence.json"), JSON.stringify({ note: `oops ${leaked}` }));
        expect(scanForSecrets(dir, all)).toEqual(["evidence.json"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
