# The Sepolia timestamp of a FISCO mirror pack

The FISCO BCOS mirror runs on a local chain nobody else can reach. To show that a given pack existed by a given time,
and has not changed since, the team lead sends **one public Sepolia transaction** whose input is a short ASCII line
naming the pack and the keccak256 of its `hashes.json`. `make verify-fisco` checks it as the line **"Sepolia timestamp"**.

**The recorded anchor:** pack `fm-6abe83e663a2471b`, Sepolia tx
[`0xd38cd129…6d5a`](https://sepolia.etherscan.io/tx/0xd38cd129ee4082117436f1f9fbef93bd72862eb5f26b7f6a15dee0c0d2d36d5a)
in block 11951818 (20 Oct 2026, 00:47:48 UTC). On Etherscan, "View input as UTF-8" shows:

```
hogee-fisco-anchor v1 pack=fm-6abe83e663a2471b hashes=0xfd819cd9af4c8cfebe4a0571fb0f86d87506463a87b01b49183b698a99f367a7 chain=20200 head=39 head-hash=0x1c4aad98c2ae32015ec8856dcfdaffcd247d6bb85d86266d2ad4efbd4fc637c4
```

## The anchor text

```
hogee-fisco-anchor v1 pack=<packId> hashes=<0x keccak256 of the exact hashes.json bytes> chain=20200 head=<headAtEnd> head-hash=<headHashAtEnd>
```

- ASCII only, single spaces, lowercase hex, `head` in decimal; `head` and `head-hash` come from `chain.json`.
- `hashes.json` lists every other pack file with its keccak256, so the line commits to every byte of the pack.
- On Etherscan, **"View input as UTF-8"** shows exactly this line.
- `pnpm --filter @hogee/redteam fisco:anchor text --pack <pack dir>` prints it and its calldata.

## The transaction

- **Signer:** the hogee-deployer, `0x46405e378F5AC837b8E18a96105e3ff3CCB22251` (final-2's deployer on Sepolia). The
  checker accepts no other signer.
- **Shape:** sent to itself, value 0, input = the text's bytes, chain 11155111.
- **Type:** `cast mktx` builds it. A `0x…` positional after the address is taken as raw calldata (checked against
  `cast decode-transaction`). It is an **EIP-1559 (type 2)** transaction; `anchor.sh` refuses any other type before
  sending. The offline checker also accepts legacy and EIP-2930; blob and set-code types are refused.
- **Fee fields:** `anchor.sh` sets all of them itself, so the RPC shapes nothing it signs:
  - **nonce:** `cast nonce` (latest). A pending tx from the signer stops the script;
  - **gas limit:** 21,000, plus the larger of 16 gas per non-zero calldata byte and the EIP-7623 floor (40 gas per
    non-zero byte, in force on Sepolia since Pectra), plus 2,000. For the ASCII text that is 21,000 + 40 per byte +
    2,000, about 32,000. `cast estimate` must not need more;
  - **fee caps:** the base fee from `cast base-fee` must be at most 20 gwei. The max priority fee is 1 gwei and the
    max fee is min(2 × base fee + 1 gwei, 50 gwei).
- **Limits** (enforced by both decoders before sending): gas limit ≤ 60,000, max fee ≤ 50 gwei, max priority fee ≤
  2 gwei, and the nonce equal to the one read. The most it can cost is gas limit × max fee: about 0.0016 ETH at
  worst (about 32,000 gas × 50 gwei), and never more than 0.003 ETH (60,000 gas × 50 gwei).

## The sidecar

The transaction is stored outside the pack: the pack's hashes are what it commits to. The file is
`evidence/fisco/anchors/<packId>.sepolia.json`:

```
{ format: "hogee.fisco-anchor/1", packId, text, txHash, rawSignedTx,
  receipt (eth_getTransactionReceipt as served), block: {number, hash, parentHash, timestamp}, capturedAt }
```

It has a strict schema and is at most 64 KiB. It is read without following links.

## How to anchor (the team lead only)

```
scripts/fisco/anchor.sh --pack evidence/fisco/fm-<16hex> [--rpc <url>]
```

The URL comes from `--rpc`, else `SEPOLIA_RPC_URL_CAPTURE`, else the public node. It must be https (plain http only
on 127.0.0.1) and is never printed. The script runs these steps in order:

1. **Chain check.** It checks that the chain id is 11155111.
2. **Text.** It prints the text, the calldata and what Etherscan will show.
3. **Password.** It asks for the keystore password, hidden.
4. **Fee fields.** It reads the nonce and the base fee, and computes the gas limit and fee caps (above).
5. **Signing.** It signs with `cast mktx`, passing every fee field.
6. **Decode.** It decodes the signed transaction twice, with `cast decode-transaction` and with `fisco:anchor check-raw`.
7. **Confirm.** It throws away anything typed ahead, then asks `[y/N]`. The question names the nonce, the gas limit,
   both fee caps and the most the transaction can cost in ETH.
8. **Publish.** It publishes with `cast publish`.
9. **Capture.** It runs `fisco:anchor capture`, which waits for the receipt and writes the sidecar.

cast runs in a fresh temporary folder next to an empty `foundry.toml`, so no `foundry.toml` or `.env` from the repo
or a parent folder is read. Its error output is never shown as is: URLs (the RPC's included) are replaced and control
bytes are dropped.

The script refuses a pack that is already anchored. It also prints the raw signed transaction before publishing. If
capture fails afterwards (a timeout, say), re-run
`fisco:anchor capture --pack <dir> --raw <file holding that line>`.

## How it is checked

- **Offline, in `make verify-fisco` and in the browser** (`checkSepoliaAnchor`). The check loads the pack strictly and
  recomputes the text. In the sidecar:
  - `keccak256(rawSignedTx)` must be `txHash`.
  - The signed transaction must be the hogee-deployer's, on chain 11155111, to itself, value 0, with exactly that
    text as input.
  - The receipt must have status 1 and name that transaction, signer and block, with no logs.
  - The block number and hash must match the receipt's.
  - The line names the block and time **as stated by the sidecar**; only the online line or Etherscan confirms them.
- **No sidecar.** The check passes with "not anchored". With `--require-anchor`, a missing sidecar fails.
- **Online, opt-in** (`HOGEE_ANCHOR_RPC=<url>`, which keeps a provider key off the command line, or
  `--anchor-rpc <url>`). It adds the line "Sepolia timestamp (online)":
  - the chain id is checked first;
  - the node's receipt (its consensus fields) must equal the sidecar's;
  - the node's block (hash, parent and time) must equal the sidecar's.

## What it proves, and what it does not

- **Proves:** the hogee-deployer key signed a value-0 transaction naming this exact pack (every file, through
  `hashes.json`), and the FISCO head it ended at. A pack edited by even one byte no longer matches.
- **Inclusion and time come from Sepolia, not from the file.** Offline, the receipt and block in the sidecar are
  only as stated by the sidecar: there is no header or trie proof. The raw transaction of a real anchor is public, so
  **anyone who holds it, with no key, can rewrite the receipt or block fields** (block number, hash or time) of a real
  anchor and still pass offline. So the block and time shown offline are as stated by the sidecar. Only the online
  line (`--anchor-rpc`) or Etherscan confirms that the transaction is in Sepolia's canonical chain at that block and
  time: `https://sepolia.etherscan.io/tx/<txHash>`.
- **One canonical transaction.** The raw transaction must use a low `s` (EIP-2) and must re-serialise to exactly its
  own bytes. A malleated twin (the high-`s` signature) or a non-canonical encoding of the same transaction would
  recover the same signer under another hash, which is not the transaction Sepolia holds.
- **Does not prove the FISCO run happened as recorded.** The other `verify-fisco` checks do that. The anchor only fixes
  the pack's content in time.
- **Does not prove the deployer key is uncompromised.** Anyone holding it could anchor another pack.
