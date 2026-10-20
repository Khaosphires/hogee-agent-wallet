/**
 * The replay CLI's regulator key: a 64-hex value outside the secp256k1 range makes viem throw a message quoting the
 * value (in decimal); regulatorAccountOf replaces it with one naming only the variable, with no `cause`.
 */
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { regulatorAccountOf } from "../../src/fisco/cli";
import { REGULATOR_KEY_NAME, RoleKeysError } from "../../src/fisco/role-keys";

describe("regulatorAccountOf", () => {
  it("returns the account of a valid key", () => {
    const key = generatePrivateKey();
    expect(regulatorAccountOf(key).address).toBe(privateKeyToAccount(key).address);
  });

  it.each([
    ["zero", `0x${"00".repeat(32)}`],
    ["the curve order or above", `0x${"ff".repeat(32)}`],
  ])("names only the variable for a key that is %s", (_what, key) => {
    let caught: unknown;
    try {
      regulatorAccountOf(key as Hex);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RoleKeysError);
    const e = caught as Error;
    expect(e.message).toBe(`${REGULATOR_KEY_NAME} is not a valid secp256k1 private key`);
    expect(e.cause).toBeUndefined();
    expect(e.message).not.toContain(BigInt(key).toString());
    expect(e.message).not.toContain(key.slice(2));
  });
});
