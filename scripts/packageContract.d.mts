type Variant = 'standard' | 'offline';

export declare const SIZE_BUDGET: Record<Variant, { min: number; max: number }>;
export declare const OFFLINE_ONNX: {
  tier: string;
  repo: string;
  dir: string;
  marker: string;
  files: { path: string; sha256: string }[];
};
export declare function offlineMarkerContent(): string;
export declare function checkEntries(p: { entries: string[]; variant: Variant; manifest: object }): string[];
export declare function checkVersion(p: { repoVersion: string; innerVersion: string; fileName: string; variant: Variant }): string[];
export declare function checkSize(p: { bytes: number; variant: Variant }): string[];
export declare function hashExpectations(manifest: object, variant?: Variant): Map<string, string>;
export declare function smokeScript(extRoot: string): string;
