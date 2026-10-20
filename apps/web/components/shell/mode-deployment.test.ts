/** Which deployment the header's mode badge names: the session's, except in REPLAY, where it is the replayed bundle's. */
import { describe, expect, it } from "vitest";
import { exampleBundleManifest, type BundleManifest } from "@hogee/core";
import { badgeDeployment, deploymentTitle, modeLabel } from "./mode-deployment";

const session = (mode: "live" | "mock" | "replay") => ({ mode, chainId: 11155111, deploymentId: "final-1" });
const bundle = (ids: readonly string[]): BundleManifest => ({
  ...exampleBundleManifest,
  deployments: Object.fromEntries(ids.map((id) => [id, { chainId: 31337, contracts: {} }])),
});

describe("badgeDeployment", () => {
  it("live and mock name the session's deployment", () => {
    expect(badgeDeployment(session("live"), undefined)).toEqual({ deploymentId: "final-1", chainId: 11155111 });
    expect(badgeDeployment(session("mock"), bundle(["final-meie4ba8c"]))).toEqual({ deploymentId: "final-1", chainId: 11155111 });
  });

  it("replay names the replayed bundle's own deployment and chain, never the session's", () => {
    expect(badgeDeployment(session("replay"), bundle(["final-meie4ba8c"]))).toEqual({ deploymentId: "final-meie4ba8c", chainId: 31337 });
  });

  it("replay names none while the bundle is loading, or when it lists no deployment or several (never a guess)", () => {
    expect(badgeDeployment(session("replay"), undefined)).toBeNull();
    expect(badgeDeployment(session("replay"), bundle([]))).toBeNull();
    expect(badgeDeployment(session("replay"), bundle(["final-a", "final-b"]))).toBeNull();
  });
});

describe("modeLabel", () => {
  it("says Sample data for the mock (one word for made-up data) and Recording (offline) for a replay", () => {
    expect(modeLabel("mock", 11155111)).toBe("Sample data");
    expect(modeLabel("replay", 31337)).toBe("Recording (offline)");
  });

  it("names the live network as a test network, never plain 'Live'", () => {
    expect(modeLabel("live", 11155111)).toBe("Sepolia test network");
    expect(modeLabel("live", 31337)).toBe("Local test network");
    expect(modeLabel("live", 1)).toBe("Test network");
    for (const mode of ["live", "mock", "replay"] as const) expect(modeLabel(mode, 11155111)).not.toMatch(/^Live$/);
  });
});

describe("deploymentTitle", () => {
  it("puts the blockchain and app version in the hover text only", () => {
    expect(deploymentTitle({ deploymentId: "final-1", chainId: 11155111 })).toBe("Blockchain 11155111, app version final-1");
    expect(deploymentTitle(null)).toBeUndefined();
  });
});
