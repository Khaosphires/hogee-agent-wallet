/** A software P-256 passkey for the mock's signing tests: enrolment through the officer's code, then assertions. */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { PasskeyAssertion, SignatureRequestResponse } from "@hogee/core";
import { json, type As } from "./harness";

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const hex32 = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

type Call = <T>(path: string, init?: RequestInit, as?: As) => Promise<{ status: number; body: T }>;

export interface SoftPasskey {
  readonly credentialId: string;
  readonly privateKey: KeyObject;
}

/** A WebAuthn get() assertion over `challenge` (low-s, as the browser's would be after normalising). */
export function assertion(key: SoftPasskey, challenge: string): PasskeyAssertion {
  const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge, origin: "http://localhost:3000", crossOrigin: false });
  const authenticatorData = Buffer.concat([createHash("sha256").update("localhost").digest(), Buffer.from([0x05, 0, 0, 0, 1])]);
  const sig = sign("sha256", Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  const s = BigInt(`0x${sig.subarray(32).toString("hex")}`);
  return {
    credentialId: key.credentialId,
    r: `0x${sig.subarray(0, 32).toString("hex")}`,
    s: hex32(s > P256_N >> 1n ? P256_N - s : s),
    challengeIndex: clientDataJSON.indexOf('"challenge"'),
    typeIndex: clientDataJSON.indexOf('"type"'),
    authenticatorData: `0x${authenticatorData.toString("hex")}`,
    clientDataJSON,
  };
}

/** Registers a new founder passkey with an enrolment code the officer issues. */
export async function enrolFounder(call: Call): Promise<SoftPasskey> {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = randomBytes(16).toString("base64url");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const { body: issued } = await call<{ code: string }>("/api/officer/founder-key/enrolment-code", json({}), "officer");
  const { body: opts } = await call<{ challenge: string }>("/api/passkey/register/options", json({ enrolmentCode: issued.code }));
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: opts.challenge })).toString("base64url");
  await call("/api/passkey/register/verify", json({ id: credentialId, rawId: credentialId, type: "public-key", response: { clientDataJSON, attestationObject: "o2Nm", publicKey: spki }, clientExtensionResults: {} }));
  return { credentialId, privateKey };
}

/** Submits a signature request with the passkey's assertion over its challenge. */
export const submitWith = (call: Call, key: SoftPasskey, req: SignatureRequestResponse) =>
  call<{ state?: string; txHash?: string; error?: { code: string; message: string; details?: { reason?: string } } }>(`/api/signatures/${req.requestId}/submit`, json({ passkey: assertion(key, req.challengeB64url) }));
