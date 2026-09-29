export declare const OFFLINE_MARKER: string;
export declare const OFFLINE_RULE: string;
export declare function effectiveRules(text: string): string[];
export declare function generateOfflineIgnore(text: string): string;
export declare function ruleDiff(standardText: string, offlineText: string): { removed: string[]; added: string[] };
export declare function checkRuleDiff(diff: { removed: string[]; added: string[] }): string[];
