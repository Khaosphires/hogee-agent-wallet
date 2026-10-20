"use client";

import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RP_ID, assertDigest } from "@/lib/passkey";
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, publicKeyFromSpki, type Hex } from "@/lib/passkey-encode";

/** e2e/vectors/passkey-N.json (ROLE-P2 2.6): 0x-hex except clientDataJSON, a UTF-8 string. */
export interface PasskeyVector {
  readonly digest: Hex;
  readonly qx: Hex;
  readonly qy: Hex;
  readonly r: Hex;
  readonly s: Hex;
  readonly challengeIndex: number;
  readonly typeIndex: number;
  readonly authenticatorData: Hex;
  readonly clientDataJSON: string;
}

declare global {
  interface Window {
    __hogeeVectors?: PasskeyVector[];
  }
}

const random = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

/** A throwaway credential for vectors (local options; never registered with the API). */
async function createTestCredential(): Promise<{ credentialId: string; qx: Hex; qy: Hex }> {
  const response = await startRegistration({
    optionsJSON: {
      challenge: bytesToBase64Url(random(32)),
      rp: { name: "Hogee test vectors", id: RP_ID },
      user: { id: bytesToBase64Url(random(16)), name: "vectors", displayName: "Test vectors" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { userVerification: "required", residentKey: "discouraged" },
      attestation: "none",
      timeout: 60_000,
    },
  });
  const spki = response.response.publicKey;
  if (!spki) throw new Error("This browser did not return the public key (getPublicKey()); use Chrome or Safari.");
  return { credentialId: response.id, ...publicKeyFromSpki(base64UrlToBytes(spki)) };
}

export function VectorGenerator() {
  const [count, setCount] = useState(20);
  const [vectors, setVectors] = useState<PasskeyVector[]>([]);
  const [status, setStatus] = useState<string>("Idle");
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    setVectors([]);
    try {
      setStatus("Creating a passkey (Touch ID or your device's lock)");
      const cred = await createTestCredential();
      const out: PasskeyVector[] = [];
      for (let i = 0; i < count; i += 1) {
        setStatus(`Signing digest ${i + 1} of ${count}`);
        const digest = bytesToHex(random(32));
        const { auth } = await assertDigest(digest, cred.credentialId);
        out.push({ digest, qx: cred.qx, qy: cred.qy, ...auth });
      }
      setVectors(out);
      window.__hogeeVectors = out;
      setStatus(`Done: ${out.length} vectors`);
    } catch (e) {
      setStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const blob = new Blob([JSON.stringify(vectors, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "passkey-vectors.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generate</CardTitle>
        <CardDescription>
          Each vector has the fields of e2e/vectors/passkey-N.json. The Playwright run (project &quot;vectors&quot;) writes them
          with a virtual authenticator; use this page with a real passkey to check Touch ID too.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="vector-count">Signatures</Label>
            <Input id="vector-count" type="number" min={1} max={100} value={count} onChange={(e) => setCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} className="w-28" />
          </div>
          <Button onClick={generate} disabled={busy}>
            Generate vectors
          </Button>
          <Button variant="outline" onClick={download} disabled={busy || vectors.length === 0}>
            Download JSON
          </Button>
        </div>
        <p role="status" className="text-sm text-muted-foreground" data-testid="vector-status">
          {status}
        </p>
        {vectors.length > 0 ? (
          <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs" data-testid="vectors">
            {JSON.stringify(vectors.slice(0, 2), null, 2)}
            {vectors.length > 2 ? `\n… ${vectors.length - 2} more` : ""}
          </pre>
        ) : null}
      </CardContent>
    </Card>
  );
}
