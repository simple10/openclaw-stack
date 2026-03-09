import { describe, it, expect } from "vitest";
import { parseMemoryValue, formatMemory } from "../../build/pre-deploy-lib.mjs";

describe("parseMemoryValue", () => {
  it("parses GB values", () => {
    expect(parseMemoryValue("12G").mb).toBe(12288);
  });

  it("parses MB values", () => {
    expect(parseMemoryValue("1024M").mb).toBe(1024);
  });

  it("defaults to MB when no unit", () => {
    expect(parseMemoryValue("512").mb).toBe(512);
  });

  it("handles fractional GB", () => {
    expect(parseMemoryValue("1.5G").mb).toBe(1536);
  });

  it("is case insensitive", () => {
    expect(parseMemoryValue("4g").mb).toBe(4096);
    expect(parseMemoryValue("256m").mb).toBe(256);
  });

  it("handles GB/MB suffix variants", () => {
    expect(parseMemoryValue("2GB").mb).toBe(2048);
    expect(parseMemoryValue("512MB").mb).toBe(512);
  });

  it("throws on invalid input", () => {
    expect(() => parseMemoryValue("abc")).toThrow("Invalid memory value");
  });

  it("preserves original string", () => {
    expect(parseMemoryValue("12G").original).toBe("12G");
  });
});

describe("formatMemory", () => {
  it("formats exact GB values", () => {
    expect(formatMemory(12288)).toBe("12G");
  });

  it("formats non-exact values as MB", () => {
    expect(formatMemory(1025)).toBe("1025M");
  });

  it("formats 1G", () => {
    expect(formatMemory(1024)).toBe("1G");
  });
});
