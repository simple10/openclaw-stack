import { describe, it, expect } from "vitest";
import { deepMerge, isPlainObject } from "../../build/pre-deploy-lib.mjs";

describe("isPlainObject", () => {
  it("returns true for plain objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("returns false for arrays", () => {
    expect(isPlainObject([])).toBe(false);
  });

  it("returns false for null", () => {
    expect(isPlainObject(null)).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject("str")).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});

describe("deepMerge", () => {
  it("source wins at leaf level", () => {
    const result = deepMerge({ a: 1 }, { a: 2 });
    expect(result.a).toBe(2);
  });

  it("preserves target keys not in source", () => {
    const result = deepMerge({ a: 1, b: 2 }, { a: 3 });
    expect(result).toEqual({ a: 3, b: 2 });
  });

  it("adds new keys from source", () => {
    const result = deepMerge({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("recursively merges nested objects", () => {
    const result = deepMerge(
      { nested: { a: 1, b: 2 } },
      { nested: { b: 3, c: 4 } }
    );
    expect(result.nested).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("replaces arrays (no array merging)", () => {
    const result = deepMerge({ arr: [1, 2] }, { arr: [3] });
    expect(result.arr).toEqual([3]);
  });

  it("null in source overwrites target", () => {
    const result = deepMerge({ a: { b: 1 } }, { a: null });
    expect(result.a).toBeNull();
  });

  it("does not mutate target", () => {
    const target = { a: 1 };
    const result = deepMerge(target, { a: 2 });
    expect(target.a).toBe(1);
    expect(result.a).toBe(2);
  });
});
