/**
 * Passkey ceremonies (project.md §6.1, §8.7; ROLE-P2 2.6/2.7) with @simplewebauthn/browser.
 * RP ID "localhost" (serve on http://localhost:3000, not 127.0.0.1). The challenge is the RAW 32-byte EIP-712 digest;
 * the browser puts it base64url-encoded into clientDataJSON, which OZ WebAuthn.verify checks.
 */
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PasskeyAssertion, PasskeyRegistrationResponse, PasskeyRegistrationResult } from "@hogee/core";
import { apiCall } from "./api/client";
import { RegistrationFailure, normalizeEnrolmentCode, type RegistrationStep } from "./enrolment";
import { base64UrlToBytes, bytesToBase64Url, encodeWebAuthnAuth, hexToBytes, type Hex, type WebAuthnAuth } from "./passkey-encode";

export const RP_ID = "localhost";
const CREDENTIAL_KEY = "hogee.passkey.credentialId";

/** Fired on window whenever this browser stores the founder's passkey id, or the welcome card is put off ("Later"). */
export const PASSKEY_EVENT = "hogee:passkey";

type CreationOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];

export const passkeysSupported = (): boolean => typeof window !== "undefined" && browserSupportsWebAuthn();

/** The founder's credential id on this device (set after registration), if any. */
export function storedCredentialId(): string | undefined {
  try {
    return window.localStorage.getItem(CREDENTIAL_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberCredential(id: string): void {
  try {
    const changed = window.localStorage.getItem(CREDENTIAL_KEY) !== id;
    window.localStorage.setItem(CREDENTIAL_KEY, id);
    if (changed) window.dispatchEvent(new Event(PASSKEY_EVENT));
  } catch {
    // Storage unavailable: the browser's passkey picker still offers the credential.
  }
}

/**
 * Registers the founder's passkey with the one-time enrolment code their loan officer issued (G2): options needs the
 * code, verify consumes it. The officer then reviews the key from GET /api/officer/founder-key/pending and registers
 * (qx, qy) on-chain. Throws RegistrationFailure naming the step, since a code means something different at each.
 */
export async function registerFounderPasskey(enrolmentCode: string): Promise<PasskeyRegistrationResult> {
  const options = await step("options", () => apiCall("passkeyRegisterOptions", { body: { enrolmentCode: normalizeEnrolmentCode(enrolmentCode) } }));
  const response = await step("device", () => startRegistration({ optionsJSON: options as unknown as CreationOptions }));
  const result = await step("verify", () => apiCall("passkeyRegisterVerify", { body: response as unknown as PasskeyRegistrationResponse }));
  rememberCredential(result.credentialId);
  return result;
}

async function step<T>(name: RegistrationStep, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new RegistrationFailure(name, e);
  }
}

/** One WebAuthn assertion over `digest`, encoded as WebAuthnAuth (low-s, byte indices). */
export async function assertDigest(digest: Hex, credentialId = storedCredentialId()): Promise<{ credentialId: string; auth: WebAuthnAuth }> {
  const response = await startAuthentication({
    optionsJSON: {
      challenge: bytesToBase64Url(hexToBytes(digest)),
      rpId: RP_ID,
      allowCredentials: credentialId ? [{ id: credentialId, type: "public-key" }] : [],
      userVerification: "required",
      timeout: 60_000,
    },
  });
  const auth = encodeWebAuthnAuth(
    {
      signature: base64UrlToBytes(response.response.signature),
      authenticatorData: base64UrlToBytes(response.response.authenticatorData),
      clientDataJSON: base64UrlToBytes(response.response.clientDataJSON),
    },
    digest,
  );
  rememberCredential(response.id);
  return { credentialId: response.id, auth };
}

/** The body of POST /api/signatures/:id/submit for a passkey signature. */
export async function passkeySubmission(digest: Hex): Promise<{ passkey: PasskeyAssertion }> {
  const { credentialId, auth } = await assertDigest(digest);
  return { passkey: { credentialId, ...auth } };
}
