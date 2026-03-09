import { describe, it, expect } from "vitest";
import { sanitizeHeaders, truncateBody } from "../src/log";

describe("sanitizeHeaders", () => {
  it("redacts authorization header", () => {
    const headers = new Headers({ Authorization: "Bearer secret-token-123" });
    const result = sanitizeHeaders(headers);
    expect(result["authorization"]).toMatch(/\[REDACTED \(\d+ chars\)\]/);
  });

  it("redacts x-api-key header", () => {
    const headers = new Headers({ "x-api-key": "my-api-key" });
    const result = sanitizeHeaders(headers);
    expect(result["x-api-key"]).toMatch(/\[REDACTED/);
  });

  it("redacts cookie header", () => {
    const headers = new Headers({ Cookie: "session=abc123" });
    const result = sanitizeHeaders(headers);
    expect(result["cookie"]).toMatch(/\[REDACTED/);
  });

  it("masks IP addresses (first 6 chars)", () => {
    const headers = new Headers({ "cf-connecting-ip": "192.168.1.100" });
    const result = sanitizeHeaders(headers);
    expect(result["cf-connecting-ip"]).toBe("192.16…");
  });

  it("preserves normal headers", () => {
    const headers = new Headers({ "Content-Type": "application/json" });
    const result = sanitizeHeaders(headers);
    expect(result["content-type"]).toBe("application/json");
  });

  it("shows length in redacted headers", () => {
    const headers = new Headers({ Authorization: "Bearer x" });
    const result = sanitizeHeaders(headers);
    expect(result["authorization"]).toBe("[REDACTED (8 chars)]");
  });

  it("preserves short IP addresses", () => {
    const headers = new Headers({ "cf-connecting-ip": "1.2.3" });
    const result = sanitizeHeaders(headers);
    expect(result["cf-connecting-ip"]).toBe("1.2.3");
  });

  it("masks x-forwarded-for", () => {
    const headers = new Headers({ "x-forwarded-for": "10.0.0.1, 192.168.1.1" });
    const result = sanitizeHeaders(headers);
    expect(result["x-forwarded-for"]).toBe("10.0.0…");
  });
});

describe("truncateBody", () => {
  it("returns short body unchanged", () => {
    expect(truncateBody("short")).toBe("short");
  });

  it("truncates long body", () => {
    const long = "x".repeat(10000);
    const result = truncateBody(long, 100);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain("truncated");
  });

  it("includes total length in truncation message", () => {
    const long = "x".repeat(200);
    const result = truncateBody(long, 50);
    expect(result).toContain("200 chars total");
  });
});
