/**
 * Check 4 "deploy inputs" and check 5 "code identity":
 *   deploy inputs — each FISCO creation input is the artifact's creation bytecode ‖ ABI constructor arguments, and
 *     those arguments equal the source deploy's (sepolia-broadcast.json, a verbatim copy of the broadcast the source
 *     identity pins by path and keccak256, never one the pack chooses) except the chain tag and the links to the
 *     deployment's own contracts; they also equal deployment.json's roles and params, and DeployFinal's manifest
 *     names the same addresses;
 *   code identity — FISCO runtime code, source runtime code and the artifact's deployedBytecode have the same length,
 *     are equal once every immutableReferences range is zeroed (the artifact is zero there), carry the same CBOR
 *     metadata tail, and every immutable word is explained by the same known value on both chains (chain tag,
 *     deployment id, each contract's domain separator recomputed from its address via domainSalt, the links, the
 *     roles, the params). Each artifact's creation bytecode carries its deployedBytecode (at a byte boundary; the
 *     immutables are zero there too), and Treasury's carries TreasuryGovernance's creation bytecode (its constructor
 *     creates it), so the runtime code compared is the one the creation code deploys, with or without a local build.
 *     With a local forge build (--artifacts), artifacts.json must equal it.
 */
import { decodeAbiParameters, encodeAbiParameters, encodePacked, getContractAddress, keccak256, type Hex } from "viem";
import { domainSalt, HOGEE_TYPEHASHES } from "../eip712";
import { fileBytes, hexToBytesOrNull, Problems, sameHex, tagToBytes32, type VerifyCheck } from "../util";
import { fiscoAddress, sameJson, type Ctx } from "./context";
import { CODE_NAMES, DEPLOYED, FISCO_CHAIN_ID, FISCO_CHAIN_TAG, PACK_FILES, type ArtifactEntry, type CodeName, type DeployedName } from "./pack";

export const DEPLOY_CHECK = "deploy inputs";
export const CODE_CHECK = "code identity";

const ADDRESS = { type: "address" } as const;
/** DeployFinal's constructor arguments (contracts/src: PlanRegistry, Treasury, MilestoneEscrow, SalesOracle). */
export const CONSTRUCTOR_PARAMS = {
  PlanRegistry: [ADDRESS, ADDRESS, { type: "bytes32" }, { type: "bytes32" }, { type: "bool" }, { type: "uint64" }],
  Treasury: [ADDRESS, ADDRESS, { type: "uint64" }, { type: "tuple", components: [ADDRESS, ADDRESS, ADDRESS, { type: "uint64" }] }, { type: "bytes32[]" }, { type: "bytes32[]" }],
  MilestoneEscrow: [ADDRESS],
  SalesOracle: [ADDRESS],
} as const;

/** The values a deployment's immutables may hold, labelled; the same labels on both chains. */
export interface Facts {
  readonly chainTag: string;
  readonly addresses: Readonly<Record<CodeName, string>>;
  readonly lender: string;
  readonly oracle: string;
  readonly observer: string;
  readonly cooling: bigint;
  readonly loosen: bigint;
  readonly judging: bigint;
}

type Args = readonly unknown[];

function argsOf(name: DeployedName, input: string, art: ArtifactEntry, where: string, p: Problems): Args | null {
  const code = art.bytecode.toLowerCase();
  if (!input.toLowerCase().startsWith(code)) {
    p.add(`${where} ${name}: the creation input does not start with the artifact's bytecode`);
    return null;
  }
  const encoded = `0x${input.slice(code.length)}` as Hex;
  try {
    const args = decodeAbiParameters(CONSTRUCTOR_PARAMS[name], encoded);
    if (encodeAbiParameters(CONSTRUCTOR_PARAMS[name], args as never).toLowerCase() !== encoded.toLowerCase()) p.add(`${where} ${name}: trailing bytes after the constructor arguments`);
    return args;
  } catch {
    p.add(`${where} ${name}: the constructor arguments do not decode`);
    return null;
  }
}

/** Facts from decoded constructor args (null when a contract's args are missing). */
function factsOf(args: Partial<Record<DeployedName, Args>>, addresses: Record<CodeName, string>, chainTag: string): Facts | null {
  const reg = args.PlanRegistry;
  const tre = args.Treasury;
  if (!reg || !tre) return null;
  const links = tre[3] as readonly [string, string, string, bigint];
  return { chainTag, addresses, lender: String(reg[0]), oracle: String(tre[1]), observer: links[2], cooling: tre[2] as bigint, loosen: links[3], judging: reg[5] as bigint };
}

/** The constructor args each chain must pass (its own links, chain tag and the shared values). */
function expectedArgs(name: DeployedName, f: Facts, deploymentId: string, payees: readonly string[], payouts: readonly string[]): Args {
  const a = f.addresses;
  switch (name) {
    case "PlanRegistry":
      return [f.lender, a.Treasury, tagToBytes32(deploymentId), tagToBytes32(f.chainTag), false, f.judging];
    case "Treasury":
      return [a.PlanRegistry, f.oracle, f.cooling, [a.MilestoneEscrow, a.SalesOracle, f.observer, f.loosen], payees, payouts];
    default:
      return [a.Treasury];
  }
}

function sourceInputs(ctx: Ctx, p: Problems): Map<string, { input: string; address: string | null }> {
  const d = ctx.pack.deployment;
  const out = new Map<string, { input: string; address: string | null }>();
  const raw = ctx.pack.sepoliaBroadcast;
  const bytes = ctx.files[PACK_FILES.sepoliaBroadcast];
  // The pin: deployment.json must name the source identity's broadcast (path and keccak256), and the copy must be it.
  if (d.sepolia.broadcastFile !== ctx.source.broadcastFile) p.add(`deployment.json names the source broadcast ${d.sepolia.broadcastFile}, not the pinned ${ctx.source.broadcastFile}`);
  if (!sameHex(d.sepolia.broadcastKeccak, ctx.source.broadcastKeccak)) p.add("deployment.json's broadcastKeccak is not the pinned source broadcast's");
  if (bytes === undefined || keccak256(fileBytes(bytes)) !== d.sepolia.broadcastKeccak) p.add(`${PACK_FILES.sepoliaBroadcast} is not the broadcast file whose keccak256 deployment.json records`);
  if (raw.chain !== ctx.source.chainId) p.add(`the source broadcast is for chain ${raw.chain}, not ${ctx.source.chainId}`);
  for (const t of raw.transactions) if (t.transactionType === "CREATE" && t.contractName) out.set(t.contractName, { input: t.transaction.input, address: t.contractAddress });
  const gov = raw.transactions.flatMap((t) => t.additionalContracts ?? []).find((c) => c.contractName === "TreasuryGovernance");
  if (!gov || !sameHex(gov.address, d.sepolia.contracts.TreasuryGovernance)) p.add("the source broadcast does not create the TreasuryGovernance deployment.json names");
  if (!sameHex(getContractAddress({ from: d.sepolia.contracts.Treasury as Hex, nonce: 1n }), d.sepolia.contracts.TreasuryGovernance)) p.add("the source TreasuryGovernance is not the source Treasury's first CREATE");
  return out;
}

function checkManifest(ctx: Ctx, p: Problems): void {
  const d = ctx.pack.deployment;
  const m = d.manifestJson;
  if (m.chainId !== FISCO_CHAIN_ID || m.deploymentId !== d.deploymentId || m.chainTag !== FISCO_CHAIN_TAG) p.add("the deploy manifest is not chain 20200 / this deployment id / tag fisco");
  for (const n of DEPLOYED) if (!sameHex(m.contracts[n].address, d.contracts[n].address)) p.add(`the deploy manifest's ${n} is not deployment.json's`);
  if (d.deploymentId !== ctx.source.deploymentId) p.add(`deployment id ${d.deploymentId} is not the source's ${ctx.source.deploymentId}`);
  const bundled = ctx.bundle?.parsed?.contracts.contracts;
  if (bundled) for (const n of DEPLOYED) if (!sameHex(bundled[n]?.address, d.sepolia.contracts[n])) p.add(`deployment.json's source ${n} is not the source bundle's`);
}

export interface DeployResult {
  readonly checks: readonly VerifyCheck[];
}

export function checkDeploy(ctx: Ctx, artifacts?: Partial<Record<CodeName, ArtifactEntry>>): DeployResult {
  const p = new Problems(DEPLOY_CHECK);
  const d = ctx.pack.deployment;
  const art = ctx.pack.artifacts.contracts;
  const src = sourceInputs(ctx, p);
  const fiscoArgs: Partial<Record<DeployedName, Args>> = {};
  const srcArgs: Partial<Record<DeployedName, Args>> = {};
  for (const name of DEPLOYED) {
    const tx = ctx.view.deploys.get(name)?.parsed;
    if (tx) fiscoArgs[name] = argsOf(name, tx.data, art[name], "FISCO", p) ?? undefined;
    const s = src.get(name);
    if (!s) p.add(`the source broadcast has no ${name} creation`);
    else {
      if (!sameHex(s.address, d.sepolia.contracts[name])) p.add(`the source broadcast's ${name} is not at deployment.json's source address`);
      srcArgs[name] = argsOf(name, s.input, art[name], "source", p) ?? undefined;
    }
  }
  const fiscoAddrs = Object.fromEntries(CODE_NAMES.map((n) => [n, fiscoAddress(ctx, n)])) as Record<CodeName, string>;
  const fisco: Facts = { chainTag: FISCO_CHAIN_TAG, addresses: fiscoAddrs, lender: d.roles.lender, oracle: d.roles.oracle, observer: d.roles.observer, cooling: BigInt(d.params.coolingSeconds), loosen: BigInt(d.params.loosenTimelockSeconds), judging: BigInt(d.params.judgingWindowEnd) };
  const source = factsOf(srcArgs, d.sepolia.contracts as Record<CodeName, string>, ctx.source.chainTag);
  if (!source) p.add("the source constructor arguments are missing, so the shared values are unknown");
  for (const name of DEPLOYED) {
    const got = fiscoArgs[name];
    if (got && !sameJson(got, expectedArgs(name, fisco, d.deploymentId, d.params.platformPayeeIds, d.params.platformPayoutHashes))) p.add(`FISCO ${name}: constructor arguments differ from deployment.json's roles, params and links`);
    const sGot = srcArgs[name];
    // Same shared values as the source deploy: its args with only the chain tag and the links swapped for FISCO's.
    if (got && sGot && source && !sameJson(got, expectedArgs(name, { ...source, chainTag: FISCO_CHAIN_TAG, addresses: fiscoAddrs }, d.deploymentId, (srcArgs.Treasury?.[4] as string[]) ?? [], (srcArgs.Treasury?.[5] as string[]) ?? []))) p.add(`${name}: constructor arguments differ from the source deploy's beyond the chain tag and the links`);
    if (sGot && source && !sameJson(sGot, expectedArgs(name, source, ctx.source.deploymentId, (srcArgs.Treasury?.[4] as string[]) ?? [], (srcArgs.Treasury?.[5] as string[]) ?? []))) p.add(`source ${name}: constructor arguments are not linked to the source deployment`);
  }
  checkManifest(ctx, p);
  const code = checkCode(ctx, fisco, source, artifacts);
  return { checks: [p.result(`${DEPLOYED.length} creation inputs = artifact bytecode ‖ the pinned source deploy's arguments (chain tag and links aside)`), code] };
}

// ---- code identity ----------------------------------------------------------------------------------------------

/** keccak256(abi.encode(EIP712Domain typehash, "Hogee", "1", contract, salt)) — HogeeTypes.domainSeparator. */
export function domainSeparatorOf(address: string, chainTag: string, deploymentId: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }],
      [HOGEE_TYPEHASHES.EIP712Domain, keccak256(encodePacked(["string"], ["Hogee"])), keccak256(encodePacked(["string"], ["1"])), address as Hex, domainSalt(chainTag, deploymentId)],
    ),
  );
}

const word = (v: bigint | string): string => (typeof v === "bigint" ? v.toString(16) : v.slice(2).toLowerCase()).padStart(64, "0");

/** Every value an immutable may hold on one chain, as a 32-byte word → its labels. */
function knownWords(f: Facts, deploymentId: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (label: string, v: bigint | string) => out.set(word(v), (out.get(word(v)) ?? new Set()).add(label));
  add("chainTag", tagToBytes32(f.chainTag));
  add("deploymentId", tagToBytes32(deploymentId));
  add("fiscoMs", 0n);
  for (const n of CODE_NAMES) {
    add(`address:${n}`, f.addresses[n]);
    if (n !== "SalesOracle") add(`domain:${n}`, domainSeparatorOf(f.addresses[n], f.chainTag, deploymentId));
  }
  add("lender", f.lender);
  add("oracle", f.oracle);
  add("observer", f.observer);
  add("coolingSeconds", f.cooling);
  add("loosenTimelockSeconds", f.loosen);
  add("judgingWindowEnd", f.judging);
  return out;
}

function ranges(a: ArtifactEntry, size: number, name: string, p: Problems): { start: number; ref: string }[] {
  const out = Object.entries(a.immutableReferences).flatMap(([ref, list]) => list.map((r) => ({ start: r.start, ref })));
  out.sort((x, y) => x.start - y.start);
  out.forEach((r, i) => {
    if (r.start + 32 > size) p.add(`${name}: immutable ${r.ref} at ${r.start} runs past the code`);
    const next = out[i + 1];
    if (next && next.start < r.start + 32) p.add(`${name}: immutable ranges overlap at ${next.start}`);
  });
  return out;
}

const metadataTail = (code: Uint8Array): Uint8Array | null => {
  if (code.length < 2) return null;
  const len = ((code[code.length - 2] as number) << 8) | (code[code.length - 1] as number);
  return len + 2 <= code.length ? code.subarray(code.length - len - 2) : null;
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const wordAt = (b: Uint8Array, at: number): string => Array.from(b.subarray(at, at + 32), (x) => x.toString(16).padStart(2, "0")).join("");

function checkOne(name: CodeName, fisco: Uint8Array, src: Uint8Array, art: Uint8Array, a: ArtifactEntry, known: { fisco: Map<string, Set<string>>; source: Map<string, Set<string>> } | null, p: Problems): number {
  if (fisco.length !== art.length || src.length !== art.length) {
    p.add(`${name}: code lengths differ (FISCO ${fisco.length}, source ${src.length}, artifact ${art.length})`);
    return 0;
  }
  const rs = ranges(a, art.length, name, p);
  const zf = Uint8Array.from(fisco);
  const zs = Uint8Array.from(src);
  for (const r of rs) {
    if (art.subarray(r.start, r.start + 32).some((x) => x !== 0)) p.add(`${name}: the artifact is not zero in immutable ${r.ref}`);
    zf.fill(0, r.start, r.start + 32);
    zs.fill(0, r.start, r.start + 32);
  }
  if (!sameBytes(zf, art)) p.add(`${name}: FISCO code differs from the artifact outside the immutables`);
  if (!sameBytes(zs, art)) p.add(`${name}: source code differs from the artifact outside the immutables`);
  const [tf, ts, ta] = [metadataTail(fisco), metadataTail(src), metadataTail(art)];
  if (!tf || !ts || !ta || !sameBytes(tf, ta) || !sameBytes(ts, ta)) p.add(`${name}: the CBOR metadata tails differ`);
  else if (rs.some((r) => r.start + 32 > art.length - ta.length)) p.add(`${name}: an immutable range overlaps the metadata tail`);
  let explained = 0;
  for (const r of rs) {
    if (!known) continue;
    const fl = known.fisco.get(wordAt(fisco, r.start));
    const sl = known.source.get(wordAt(src, r.start));
    if (!fl || !sl || ![...fl].some((l) => sl.has(l))) p.add(`${name}: immutable ${r.ref} at ${r.start} is not explained by the same known value on both chains`);
    else explained += 1;
  }
  return explained;
}

/** `inner` (0x-hex) occurs inside `outer` at a byte boundary (an even hex offset). */
function carries(outer: string, inner: string): boolean {
  const [o, i] = [outer.slice(2).toLowerCase(), inner.slice(2).toLowerCase()];
  if (i.length === 0) return false;
  for (let at = o.indexOf(i); at >= 0; at = o.indexOf(i, at + 1)) if (at % 2 === 0) return true;
  return false;
}

/** artifacts.json is self-consistent: each creation code carries its runtime code; Treasury's carries TreasuryGovernance's. */
function checkEmbedded(art: Readonly<Record<CodeName, ArtifactEntry>>, p: Problems): void {
  for (const n of CODE_NAMES) if (!carries(art[n].bytecode, art[n].deployedBytecode)) p.add(`${n}: the creation bytecode does not carry its deployedBytecode`);
  if (!carries(art.Treasury.bytecode, art.TreasuryGovernance.bytecode)) p.add("Treasury's creation bytecode does not carry TreasuryGovernance's (its constructor creates it)");
}

function checkCode(ctx: Ctx, fisco: Facts, source: Facts | null, local?: Partial<Record<CodeName, ArtifactEntry>>): VerifyCheck {
  const p = new Problems(CODE_CHECK);
  const d = ctx.pack.deployment;
  const { code, sepoliaCode } = ctx.pack;
  if (code.chainId !== FISCO_CHAIN_ID) p.add(`code/meta.json is for chain ${code.chainId}`);
  if (sepoliaCode.chainId !== ctx.source.chainId) p.add(`code-sepolia/meta.json is for chain ${sepoliaCode.chainId}, not ${ctx.source.chainId}`);
  for (const n of CODE_NAMES) {
    if (!sameHex(code.addresses[n], d.contracts[n].address)) p.add(`code/meta.json: ${n} is not deployment.json's`);
    if (!sameHex(sepoliaCode.addresses[n], d.sepolia.contracts[n])) p.add(`code-sepolia/meta.json: ${n} is not deployment.json's source address`);
  }
  if (local) for (const n of CODE_NAMES) if (!local[n] || !sameJson(local[n], ctx.pack.artifacts.contracts[n])) p.add(`artifacts.json: ${n} is not the local forge build's`);
  checkEmbedded(ctx.pack.artifacts.contracts, p);
  const known = source ? { fisco: knownWords(fisco, d.deploymentId), source: knownWords(source, ctx.source.deploymentId) } : null;
  if (!known) p.add("immutables not explained: the source constructor arguments are unknown");
  let explained = 0;
  for (const n of CODE_NAMES) {
    const a = ctx.pack.artifacts.contracts[n];
    const [f, s, art] = [hexToBytesOrNull(ctx.pack.codeHex.get(n) ?? ""), hexToBytesOrNull(ctx.pack.sepoliaCodeHex.get(n) ?? ""), hexToBytesOrNull(a.deployedBytecode)];
    if (!f || !s || !art) {
      p.add(`${n}: code missing`);
      continue;
    }
    explained += checkOne(n, f, s, art, a, known, p);
  }
  const build = local ? "artifacts equal the local forge build" : "artifacts from the pack, not rebuilt (no local forge build given)";
  return p.result(`${CODE_NAMES.length} contracts: FISCO = source = artifact outside the immutables, ${explained} immutable words explained; each creation code carries its runtime code; ${build}`);
}
