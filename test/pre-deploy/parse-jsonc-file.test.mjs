import { describe, it, expect } from "vitest";
import { parseJsoncFile } from "../../build/pre-deploy-lib.mjs";

describe("parseJsoncFile", () => {
  it("parses valid JSON", () => {
    const result = parseJsoncFile('{"key": "value"}', "test.json");
    expect(result).toEqual({ key: "value" });
  });

  it("parses JSON with comments", () => {
    const input = `{
      // This is a comment
      "key": "value"
    }`;
    const result = parseJsoncFile(input, "test.jsonc");
    expect(result).toEqual({ key: "value" });
  });

  it("parses JSON with trailing commas", () => {
    const input = '{"a": 1, "b": 2,}';
    const result = parseJsoncFile(input, "test.jsonc");
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseJsoncFile("{invalid", "bad.json")).toThrow("JSONC parse errors");
  });

  it("includes file path in error message", () => {
    expect(() => parseJsoncFile("{bad", "my-file.jsonc")).toThrow("my-file.jsonc");
  });
});
