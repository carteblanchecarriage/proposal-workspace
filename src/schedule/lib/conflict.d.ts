import type { Conflict, Side } from "./utils/merge.js";
export function askConflicts(title: string | undefined, conflicts: Conflict[]): Promise<Record<string, Side> | null>;
export function askDeleted(title: string | undefined): Promise<boolean>;
export function tellReplaced(title: string | undefined): Promise<void>;
