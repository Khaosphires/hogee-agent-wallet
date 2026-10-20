/**
 * rcfix H-4: a RELEASE_ESCROW_BALANCE request opens only for the inspection evidence recorded on its milestone. The
 * founder's MilestoneRelease signs the recorded hash (signing/founder-payments.ts), never the request's, so a request
 * naming another hash would show the loan officer a check code the release does not carry. The decision runs on a fake
 * database here; the same refusals over HTTP on Postgres are in test/live/exceptions.live.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { Db } from "@hogee/db";
import { ApiProblem } from "../src/http/problem";
import { checkCreate, escrowReleaseRefusal } from "../src/services/exception-create";
import type { PolicyWorld } from "../src/services/policy-context";
import { fakeDeps } from "./support/fake-deps";

const SCOPE = { facilityId: "fac-rina", founderId: "founder-rina" };
const RECORDED = `0x${"ab".repeat(32)}`;
const OTHER = `0x${"cd".repeat(32)}`;

interface Milestone {
  readonly amount_minor: string;
  readonly funded_minor: string;
  readonly released_minor: string;
  readonly evidence_hash: string | null;
}

const waiting = (evidence: string | null): Milestone => ({ amount_minor: "20000", funded_minor: "20000", released_minor: "0", evidence_hash: evidence });

/** A database whose escrow_milestones holds `m` (or nothing); every statement is recorded. */
function milestoneDb(m: Milestone | undefined) {
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const query = async (sql: string, params: readonly unknown[] = []) => {
    statements.push({ sql, params });
    return { rows: m && /from escrow_milestones/.test(sql) ? [m] : [], rowCount: m ? 1 : 0 };
  };
  return { db: { $client: { query } } as unknown as Db, statements };
}

function create(m: Milestone | undefined, evidenceHash: string) {
  const { db, statements } = milestoneDb(m);
  const { deps } = fakeDeps({ deps: { db } });
  // RELEASE_ESCROW_BALANCE reads only the milestone row, never the policy world.
  const run = checkCreate(deps, SCOPE, { kind: "RELEASE_ESCROW_BALANCE", payload: { orderId: "order-a-001", idx: 2, evidenceHash } }, {} as PolicyWorld);
  return { run, statements };
}

async function refusal(m: Milestone | undefined, evidenceHash: string) {
  const { run } = create(m, evidenceHash);
  const err = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiProblem);
  return (err as ApiProblem).failure;
}

describe("checkCreate RELEASE_ESCROW_BALANCE (rcfix H-4)", () => {
  it("opens for the inspection evidence recorded on the milestone, read from this facility's order and index", async () => {
    const { run, statements } = create(waiting(RECORDED), RECORDED);
    await expect(run).resolves.toBeUndefined();
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toMatch(/evidence_hash/);
    expect(statements[0]?.params).toEqual(["fac-rina", "order-a-001", 2]);
  });

  it("refuses a check code that is not the recorded inspection evidence (CONFLICT)", async () => {
    expect(await refusal(waiting(RECORDED), OTHER)).toEqual({ code: "CONFLICT", message: "The delivery check code does not match the inspection evidence recorded for that milestone" });
  });

  it("refuses while no inspection evidence is recorded, as the founder's release does (CONFLICT)", async () => {
    expect(await refusal(waiting(null), RECORDED)).toEqual({ code: "CONFLICT", message: "Upload the inspection evidence first" });
  });

  it("still refuses a missing, unfunded or released milestone first", async () => {
    expect(await refusal(undefined, RECORDED)).toMatchObject({ code: "CONFLICT", message: "No such escrow milestone" });
    expect(await refusal({ ...waiting(RECORDED), funded_minor: "19999" }, RECORDED)).toMatchObject({ code: "CONFLICT", message: "That milestone is not funded and waiting for release" });
    expect(await refusal({ ...waiting(RECORDED), released_minor: "1" }, RECORDED)).toMatchObject({ code: "CONFLICT", message: "That milestone is not funded and waiting for release" });
  });

  it("decides from the stored row alone (escrowReleaseRefusal): the hash is compared whole, in any letter case", () => {
    expect(escrowReleaseRefusal(waiting(RECORDED), RECORDED)).toBeNull();
    expect(escrowReleaseRefusal(waiting(RECORDED.toUpperCase().replace("0X", "0x")), RECORDED)).toBeNull();
    expect(escrowReleaseRefusal(waiting(RECORDED), `${RECORDED.slice(0, -1)}c`)).toMatch(/does not match/);
    expect(escrowReleaseRefusal(waiting(RECORDED), RECORDED.slice(0, 10))).toMatch(/does not match/);
  });
});
