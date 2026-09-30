export interface CerResult {
  normRef: string;
  normHyp: string;
  distance: number;
  refLen: number;
  cer: number | null;
}

export interface NormalizeOptions {
  lowercaseLatin?: boolean;
}

export declare function normalizeForEvaluation(text: string, opts?: NormalizeOptions): string;
export declare function levenshtein(a: string, b: string): number;
export declare function cer(reference: string, hypothesis: string, opts?: NormalizeOptions): CerResult;
export declare function weightedCer(cases: { cer: number | null; weight: number }[]): number | null;
