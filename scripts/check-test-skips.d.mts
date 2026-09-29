export interface AllowedSkip {
  file: string;
  describe: string;
  why: string;
}

export declare const ALLOWED_SKIPS: AllowedSkip[];
export declare function findDisallowedSkips(
  report: object,
  allowed?: AllowedSkip[],
): { disallowed: string[]; allowedHits: string[]; skippedTotal: number };
