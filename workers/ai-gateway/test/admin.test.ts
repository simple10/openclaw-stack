import { describe, it, expect } from "vitest";
import { maskString, maskCredentials, mergeCredentials } from "../src/admin";
import type { UserCredentials } from "../src/types";

describe("maskString", () => {
  it("returns *** for short strings", () => {
    expect(maskString("short")).toBe("***");
    expect(maskString("exactly16chars!!")).toBe("***");
  });

  it("shows first 8 + last 4 for long strings", () => {
    const long = "sk-ant-api03-abcdefghijklmnop";
    const result = maskString(long);
    expect(result).toBe("sk-ant-a...mnop");
  });

  it("returns *** for empty string", () => {
    expect(maskString("")).toBe("***");
  });
});

describe("maskCredentials", () => {
  it("masks anthropic apiKey", () => {
    const creds: UserCredentials = {
      anthropic: { apiKey: "sk-ant-api03-very-long-key-here-1234" },
    };
    const result = maskCredentials(creds);
    expect((result.anthropic as Record<string, unknown>).apiKey).toContain("...");
  });

  it("masks openai apiKey", () => {
    const creds: UserCredentials = {
      openai: { apiKey: "sk-proj-very-long-openai-key-5678" },
    };
    const result = maskCredentials(creds);
    expect((result.openai as Record<string, unknown>).apiKey).toContain("...");
  });

  it("shows oauth as configured status", () => {
    const creds: UserCredentials = {
      openai: {
        oauth: {
          accessToken: "secret",
          refreshToken: "also-secret",
          expiresAt: "2026-12-31",
        },
      },
    };
    const result = maskCredentials(creds);
    const openai = result.openai as Record<string, unknown>;
    const oauth = openai.oauth as Record<string, unknown>;
    expect(oauth.status).toBe("configured");
    expect(oauth.expiresAt).toBe("2026-12-31");
    expect(oauth).not.toHaveProperty("accessToken");
  });

  it("returns empty object for empty creds", () => {
    const result = maskCredentials({});
    expect(result).toEqual({});
  });

  it("handles creds with only anthropic", () => {
    const creds: UserCredentials = {
      anthropic: { oauthToken: "very-long-anthropic-oauth-token-here" },
    };
    const result = maskCredentials(creds);
    expect(result).toHaveProperty("anthropic");
    expect(result).not.toHaveProperty("openai");
  });
});

describe("mergeCredentials", () => {
  it("sets a new field", () => {
    const existing: UserCredentials = {};
    const update = { anthropic: { apiKey: "new-key" } };
    const result = mergeCredentials(existing, update);
    expect(result.anthropic?.apiKey).toBe("new-key");
  });

  it("updates an existing field", () => {
    const existing: UserCredentials = {
      anthropic: { apiKey: "old-key" },
    };
    const update = { anthropic: { apiKey: "new-key" } };
    const result = mergeCredentials(existing, update);
    expect(result.anthropic?.apiKey).toBe("new-key");
  });

  it("deletes a field when set to null", () => {
    const existing: UserCredentials = {
      anthropic: { apiKey: "key", oauthToken: "token" },
    };
    const update = { anthropic: { apiKey: null } };
    const result = mergeCredentials(existing, update);
    expect(result.anthropic?.apiKey).toBeUndefined();
    expect(result.anthropic?.oauthToken).toBe("token");
  });

  it("preserves fields not in update", () => {
    const existing: UserCredentials = {
      anthropic: { apiKey: "keep" },
      openai: { apiKey: "also-keep" },
    };
    const update = { anthropic: { apiKey: "changed" } };
    const result = mergeCredentials(existing, update);
    expect(result.anthropic?.apiKey).toBe("changed");
    expect(result.openai?.apiKey).toBe("also-keep");
  });

  it("removes entire provider when set to null", () => {
    const existing: UserCredentials = {
      anthropic: { apiKey: "key" },
    };
    const update = { anthropic: null };
    const result = mergeCredentials(existing, update);
    expect(result.anthropic).toBeUndefined();
  });

  it("removes empty provider section after field deletion", () => {
    const existing: UserCredentials = {
      anthropic: { apiKey: "only-field" },
    };
    const update = { anthropic: { apiKey: null } };
    const result = mergeCredentials(existing, update);
    expect(result.anthropic).toBeUndefined();
  });

  it("does not mutate existing credentials", () => {
    const existing: UserCredentials = {
      anthropic: { apiKey: "original" },
    };
    const update = { anthropic: { apiKey: "changed" } };
    mergeCredentials(existing, update);
    expect(existing.anthropic?.apiKey).toBe("original");
  });

  it("handles openai oauth updates", () => {
    const existing: UserCredentials = {};
    const update = {
      openai: {
        oauth: {
          accessToken: "at",
          refreshToken: "rt",
          expiresAt: "2026-12-31",
        },
      },
    };
    const result = mergeCredentials(existing, update);
    expect(result.openai?.oauth?.accessToken).toBe("at");
  });
});
