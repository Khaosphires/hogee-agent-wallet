/** Mock 32-byte values and addresses (real keccak of a label; never presented as a chain hash outside mock mode). */
import { keccak256Utf8, type Address, type Hex32 } from "@hogee/core";

export const mockHash = (label: string): Hex32 => keccak256Utf8(`hogee-mock:${label}`);
export const mockAddress = (label: string): Address => `0x${mockHash(label).slice(-40)}` as Address;
