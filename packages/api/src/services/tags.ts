/** bytes32 encodings (§26.3): ShortIds and line keys are right-padded UTF-8 (viem stringToHex(id, {size: 32})). */
import type { Hex } from "viem";
import { toBytes32Tag } from "../chain-lib";

export const toBytes32 = (id: string): Hex => toBytes32Tag(id).toLowerCase() as Hex;
