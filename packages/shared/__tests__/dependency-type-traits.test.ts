import { describe, it, expect } from "vitest";
import { DEPENDENCY_TYPES } from "../src/schema/issue-dependencies.js";
import {
  DEPENDENCY_TYPE_TRAITS,
  BLOCKING_DEPENDENCY_TYPES,
  DIRECTIONAL_DEPENDENCY_TYPES,
  isBlockingDependencyType,
  isDirectionalDependencyType,
} from "../src/lib/dependency-type-traits.js";

describe("DEPENDENCY_TYPE_TRAITS (#523)", () => {
  it("covers EVERY dependency type — a new type cannot be added without deciding its traits", () => {
    // This is the point of the table: the compiler already requires a full Record, and
    // this asserts the runtime list and the table cannot drift apart.
    for (const type of DEPENDENCY_TYPES) {
      expect(DEPENDENCY_TYPE_TRAITS[type], `no traits for "${type}"`).toBeDefined();
    }
    expect(Object.keys(DEPENDENCY_TYPE_TRAITS).sort()).toEqual([...DEPENDENCY_TYPES].sort());
  });

  it("preserves the blocking set the scattered copies all hard-coded", () => {
    expect([...BLOCKING_DEPENDENCY_TYPES].sort()).toEqual(["blocked_by", "depends_on"]);
  });

  it("preserves the directional set", () => {
    expect([...DIRECTIONAL_DEPENDENCY_TYPES].sort()).toEqual(
      ["blocked_by", "child_of", "depends_on", "parent_of"].sort(),
    );
  });

  it("symmetric types are never directional, and vice versa", () => {
    for (const type of DEPENDENCY_TYPES) {
      const t = DEPENDENCY_TYPE_TRAITS[type];
      expect(t.symmetric, `"${type}" is both symmetric and directional`).toBe(!t.directional);
    }
  });

  it("every blocking type is directional (a symmetric edge cannot block one side)", () => {
    for (const type of BLOCKING_DEPENDENCY_TYPES) {
      expect(DEPENDENCY_TYPE_TRAITS[type].directional, `"${type}" blocks but is not directional`).toBe(true);
    }
  });

  it("the predicates are safe on an unknown type string", () => {
    expect(isBlockingDependencyType("not_a_type")).toBe(false);
    expect(isDirectionalDependencyType("not_a_type")).toBe(false);
    expect(isBlockingDependencyType("depends_on")).toBe(true);
    expect(isDirectionalDependencyType("parent_of")).toBe(true);
  });
});
