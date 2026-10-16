export const STATIC_MARKER: string;
export function declaresStatic(source: string): boolean;
export function discoverStaticSuites(root?: string): string[];
export function groupByPackage(files: string[]): Record<string, string[]>;
export function main(): Promise<void>;
