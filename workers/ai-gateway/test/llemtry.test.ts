import { describe, it, expect } from "vitest";
import { isLlemtryEnabled, isLlmRoute } from "../src/llemtry";

// Minimal Log interface for testing
const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("isLlemtryEnabled", () => {
  it("returns false when LLEMTRY_ENABLED is not 'true'", () => {
    const env = {
      LLEMTRY_ENABLED: "false",
      LLEMTRY_ENDPOINT: "https://example.com",
      LLEMTRY_AUTH_TOKEN: "token",
    } as unknown as Env;
    expect(isLlemtryEnabled(env, noopLog)).toBe(false);
  });

  it("returns false when LLEMTRY_ENABLED is undefined", () => {
    const env = {} as unknown as Env;
    expect(isLlemtryEnabled(env, noopLog)).toBe(false);
  });

  it("returns true when enabled with endpoint and token", () => {
    const env = {
      LLEMTRY_ENABLED: "true",
      LLEMTRY_ENDPOINT: "https://example.com/llemtry",
      LLEMTRY_AUTH_TOKEN: "test-token",
    } as unknown as Env;
    expect(isLlemtryEnabled(env, noopLog)).toBe(true);
  });

  it("returns false when endpoint is missing", () => {
    const errorLog = { ...noopLog, error: () => {} };
    const env = {
      LLEMTRY_ENABLED: "true",
      LLEMTRY_AUTH_TOKEN: "token",
    } as unknown as Env;
    expect(isLlemtryEnabled(env, errorLog)).toBe(false);
  });

  it("returns false when auth token is missing", () => {
    const errorLog = { ...noopLog, error: () => {} };
    const env = {
      LLEMTRY_ENABLED: "true",
      LLEMTRY_ENDPOINT: "https://example.com",
    } as unknown as Env;
    expect(isLlemtryEnabled(env, errorLog)).toBe(false);
  });
});

describe("isLlmRoute", () => {
  it("returns true for anthropic messages route", () => {
    expect(isLlmRoute("v1/messages")).toBe(true);
  });

  it("returns true for openai chat completions route", () => {
    expect(isLlmRoute("v1/chat/completions")).toBe(true);
  });

  it("returns false for embeddings route", () => {
    expect(isLlmRoute("v1/embeddings")).toBe(false);
  });

  it("returns false for models route", () => {
    expect(isLlmRoute("v1/models")).toBe(false);
  });
});
