// Types for the merge helpers TypeScript code uses (the helpers stay JavaScript).
type Any = Record<string, any>;
export type Side = "mine" | "theirs";
export type Conflict = { key: string; label: string; mine: any; theirs: any };
export type Ask = (key: string, label: string, mine: any, theirs: any) => Side;
export function same(a: unknown, b: unknown): boolean;
export function mergeFields(base: Any, mine: Any, theirs: Any, groups: string[][], ask: (field: string, mine: any, theirs: any) => Side, skip?: Set<string>): Any;
export function mergeList(o: {
  base?: Any[];
  mine?: Any[];
  theirs?: Any[];
  id: string;
  groups: string[][];
  ask: Ask;
  label: (x: Any) => string;
  kind: string;
  newId?: (old: any) => any;
  combine?: (id: any, base: Any | undefined, mine: Any, theirs: Any) => Any;
}): Any[];
