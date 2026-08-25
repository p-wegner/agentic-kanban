// Dependency-type semantics (#523).
//
// These live in lib/ rather than schema/ because ROUTES and the CLI ask these
// questions, and the layering rules (dependency-cruiser: routes-not-down-to-persistence,
// cli-not-down-to-persistence) forbid those layers importing persistence. The first cut
// put them in the schema module and tripped both rules — the predicates are domain
// semantics, not table definitions.
//
// The VOCABULARY (union + list) is declared HERE too (#869): it used to live beside the
// table in schema/issue-dependencies.ts, which made this pure module value-import
// persistence — the one shared-lib→shared-schema edge the pattern spec forbids. Per the
// #608 rule the vocabulary a non-persistence layer reads belongs in pure lib; the schema
// module now imports the TYPE only (type-only, erased at compile time).

/** The dependency-edge vocabulary — the one source of truth for `issue_dependencies.type`. */
export type DependencyType = "depends_on" | "blocked_by" | "related_to" | "duplicates" | "parent_of" | "child_of" | "coupled_with";

export const DEPENDENCY_TYPES: DependencyType[] = [
  "depends_on",
  "blocked_by",
  "related_to",
  "duplicates",
  "parent_of",
  "child_of",
  "coupled_with",
];

/**
 * Per-type semantics (#523).
 *
 * The union, list and labels lived here, but the QUESTIONS the code actually asks —
 * does this type block a start, is it directional, is it symmetric — were re-stated as
 * local sets in a dozen files: `BLOCKING_DEPENDENCY_TYPES` in three services,
 * `BLOCKING_DEP_TYPES` in a fourth, `DEP_TYPES_THAT_BLOCK` in a route, an inline
 * `inArray` in a repository, and `DIRECTIONAL_DEPENDENCY_TYPES` twice inside one file
 * plus a third copy in the CLI.
 *
 * They agree today. The hazard is asymmetric: adding a new blocking type means finding
 * every local set, and missing one silently under-blocks — a ticket starts while a real
 * blocker is open, which looks like a scheduling quirk rather than a bug.
 */
export interface DependencyTypeTraits {
  /** An unresolved dependency of this type prevents the dependent from starting. */
  blocksStart: boolean;
  /** The pair has a direction (A -> B differs from B -> A). */
  directional: boolean;
  /** The relationship reads the same both ways. */
  symmetric: boolean;
}

export const DEPENDENCY_TYPE_TRAITS: Record<DependencyType, DependencyTypeTraits> = {
  depends_on:   { blocksStart: true,  directional: true,  symmetric: false },
  blocked_by:   { blocksStart: true,  directional: true,  symmetric: false },
  parent_of:    { blocksStart: false, directional: true,  symmetric: false },
  child_of:     { blocksStart: false, directional: true,  symmetric: false },
  related_to:   { blocksStart: false, directional: false, symmetric: true },
  duplicates:   { blocksStart: false, directional: false, symmetric: true },
  coupled_with: { blocksStart: false, directional: false, symmetric: true },
};

/** Dependency types whose unresolved edges block a start. Derived, never hand-listed. */
export const BLOCKING_DEPENDENCY_TYPES: readonly DependencyType[] =
  DEPENDENCY_TYPES.filter((t) => DEPENDENCY_TYPE_TRAITS[t].blocksStart);

/** Dependency types that carry a direction. */
export const DIRECTIONAL_DEPENDENCY_TYPES: readonly DependencyType[] =
  DEPENDENCY_TYPES.filter((t) => DEPENDENCY_TYPE_TRAITS[t].directional);

/** Whether an unresolved edge of this type blocks the dependent from starting. */
export function isBlockingDependencyType(type: string): boolean {
  return (DEPENDENCY_TYPE_TRAITS as Record<string, DependencyTypeTraits | undefined>)[type]?.blocksStart === true;
}

/** Whether this dependency type has a direction. */
export function isDirectionalDependencyType(type: string): boolean {
  return (DEPENDENCY_TYPE_TRAITS as Record<string, DependencyTypeTraits | undefined>)[type]?.directional === true;
}
