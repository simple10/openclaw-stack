import { describe, it, expect } from "vitest";
import { matchProviderRoute } from "../src/routing";

describe("matchProviderRoute", () => {
  it("matches anthropic/v1/messages POST", () => {
    const result = matchProviderRoute("POST", "/anthropic/v1/messages");
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("anthropic");
    expect(result!.directPath).toBe("v1/messages");
  });

  it("matches openai/v1/chat/completions POST", () => {
    const result = matchProviderRoute("POST", "/openai/v1/chat/completions");
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("openai");
    expect(result!.directPath).toBe("v1/chat/completions");
  });

  it("matches openai/v1/responses POST", () => {
    const result = matchProviderRoute("POST", "/openai/v1/responses");
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("openai");
  });

  it("matches openai/v1/embeddings POST", () => {
    const result = matchProviderRoute("POST", "/openai/v1/embeddings");
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("openai");
  });

  it("matches openai/v1/models GET", () => {
    const result = matchProviderRoute("GET", "/openai/v1/models");
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("openai");
  });

  it("routes openai/v1/codex/responses to openai-codex provider", () => {
    const result = matchProviderRoute("POST", "/openai/v1/codex/responses");
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("openai-codex");
    expect(result!.directPath).toBe("codex/responses");
  });

  it("routes openai-codex/codex/responses to openai-codex provider", () => {
    const result = matchProviderRoute("POST", "/openai-codex/codex/responses");
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("openai-codex");
    expect(result!.directPath).toBe("codex/responses");
  });

  it("returns null for wrong method", () => {
    expect(matchProviderRoute("GET", "/anthropic/v1/messages")).toBeNull();
  });

  it("returns null for unknown path", () => {
    expect(matchProviderRoute("POST", "/unknown/path")).toBeNull();
  });

  it("generates gateway path without /v1/ segment", () => {
    const result = matchProviderRoute("POST", "/anthropic/v1/messages");
    expect(result!.gatewayPath).toBe("anthropic/messages");
  });
});
