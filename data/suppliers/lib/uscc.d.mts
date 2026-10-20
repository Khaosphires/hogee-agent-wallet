/** Types for uscc.mjs (GB 32100-2015 USCC and GB 11714-1997 organisation-code check characters). */
export declare const USCC_CHARSET: string;
export declare function usccCheckChar(first17: string): string;
export declare function orgCodeCheckChar(body8: string): string;
export declare function isValidUscc(code: unknown): boolean;
export declare function makeUscc(division: string, orgBody: string): string;
export declare function withWrongCheckChar(code: string): string;
