import { describe, it, expect } from "vitest";
import { formatEnvValue } from "../../build/pre-deploy-lib.mjs";

describe("formatEnvValue", () => {
  it("passes through plain strings", () => {
    expect(formatEnvValue("hello")).toBe("hello");
  });

  it("single-quotes strings with spaces", () => {
    expect(formatEnvValue("hello world")).toBe("'hello world'");
  });

  it("escapes single quotes inside values", () => {
    expect(formatEnvValue("it's")).toBe("'it'\\''s'");
  });

  it("quotes strings with dollar signs", () => {
    expect(formatEnvValue("$HOME")).toBe("'$HOME'");
  });

  it("returns empty string for null/undefined", () => {
    expect(formatEnvValue(null)).toBe("");
    expect(formatEnvValue(undefined)).toBe("");
  });

  it("converts numbers to strings", () => {
    expect(formatEnvValue(8080)).toBe("8080");
  });

  it("converts booleans to strings", () => {
    expect(formatEnvValue(false)).toBe("false");
    expect(formatEnvValue(true)).toBe("true");
  });
});
