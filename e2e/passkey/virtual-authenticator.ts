import type { Page } from "@playwright/test";

/**
 * A CDP virtual authenticator (Chromium only): a platform passkey with user verification, which signs without
 * prompting. Used for the G3 vectors, the SignDialog tests and the scripted demo video.
 */
export async function addVirtualAuthenticator(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return authenticatorId;
}
