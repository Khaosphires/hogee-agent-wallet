/**
 * Which deployment the header's mode badge names. The mode always comes from GET /api/session (ROLE-P2 A.3 rule 2),
 * and so does the deployment in live and mock. In REPLAY the session is the mock's own (its seeded deployment, such as
 * final-1), but what plays back is the evidence bundle REPLAY=<runId> names: the badge names that bundle's own
 * deployment and chain, from its manifest. A bundle not loaded yet, or one listing no deployment or several, names
 * none: the badge never guesses, and never shows the session's deployment in replay.
 */
import type { ApiMode, BundleManifest } from "@hogee/core";

export interface BadgeDeployment {
  readonly deploymentId: string;
  readonly chainId: number;
}

export function badgeDeployment(
  session: { readonly mode: ApiMode; readonly chainId: number; readonly deploymentId: string },
  replayed: BundleManifest | undefined,
): BadgeDeployment | null {
  if (session.mode !== "replay") return { deploymentId: session.deploymentId, chainId: session.chainId };
  const entries = Object.entries(replayed?.deployments ?? {});
  const only = entries.length === 1 ? entries[0] : undefined;
  return only ? { deploymentId: only[0], chainId: only[1].chainId } : null;
}

const SEPOLIA = 11_155_111;
const ANVIL = 31_337;

/**
 * The data label in the quick settings (UX-PLAN D12, P1): what the numbers on screen are. Mock is "Sample data" (UX
 * round 3: one word, "Sample", for made-up data everywhere, as the "Sample business" switch says); replay is "Recording
 * (offline)"; live names the network honestly: Sepolia is a public test network, never "Live" (it could read as real
 * money). Recording mode never hides this label.
 */
export function modeLabel(mode: ApiMode, chainId: number): string {
  if (mode === "mock") return "Sample data";
  if (mode === "replay") return "Recording (offline)";
  if (chainId === SEPOLIA) return "Sepolia test network";
  if (chainId === ANVIL) return "Local test network";
  return "Test network";
}

/** The badge's hover text: the blockchain and app version, never on screen (K15). */
export function deploymentTitle(deployment: BadgeDeployment | null): string | undefined {
  return deployment ? `Blockchain ${deployment.chainId}, app version ${deployment.deploymentId}` : undefined;
}
