export interface PathRef {
  path: string;
  localOnly: boolean;
  line: number;
}
export declare function isPathLike(code: string): boolean;
export declare function extractPathRefs(markdown: string): PathRef[];
export declare function isTracked(path: string, tracked: Set<string>): boolean;
export declare function checkPathRefs(refs: PathRef[], repo: { tracked: Set<string>; isIgnored: (path: string) => boolean }): string[];
export declare function extractSrcLayout(markdown: string): { entries: string[]; errors: string[] };
export declare function srcTopLevel(trackedFiles: Iterable<string>): Set<string>;
export declare function checkSrcLayout(entries: string[], trackedFiles: Iterable<string>): string[];
