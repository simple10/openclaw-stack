import { describe, it, expect } from "vitest";
import { extractToken, authenticateRequest } from "../src/auth";
import { env } from "cloudflare:test";

describe("extractToken", () => {
  it("extracts Bearer token from Authorization header", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer my-token" },
    });
    expect(extractToken(req)).toBe("my-token");
  });

  it("returns null for non-Bearer Authorization", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Basic abc" },
    });
    expect(extractToken(req)).toBeNull();
  });

  it("falls back to x-api-key header", () => {
    const req = new Request("https://example.com", {
      headers: { "x-api-key": "api-key-123" },
    });
    expect(extractToken(req)).toBe("api-key-123");
  });

  it("returns null when no auth headers", () => {
    const req = new Request("https://example.com");
    expect(extractToken(req)).toBeNull();
  });

  it("prefers Authorization over x-api-key", () => {
    const req = new Request("https://example.com", {
      headers: {
        Authorization: "Bearer bearer-tok",
        "x-api-key": "api-key-tok",
      },
    });
    expect(extractToken(req)).toBe("bearer-tok");
  });
});

describe("authenticateRequest", () => {
  const kv = env.AUTH_KV;

  it("returns userId for exact token match", async () => {
    await kv.put("token:exact-token-123", "usr_abc");
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer exact-token-123" },
    });
    const result = await authenticateRequest(req, kv);
    expect(result).toBe("usr_abc");
  });

  it("returns null for missing token", async () => {
    const req = new Request("https://example.com");
    const result = await authenticateRequest(req, kv);
    expect(result).toBeNull();
  });

  it("returns null for unknown token", async () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer unknown-token" },
    });
    const result = await authenticateRequest(req, kv);
    expect(result).toBeNull();
  });

  it("looks up JWT tokens by SHA-256 hash", async () => {
    // Create a fake JWT (3 dot-separated segments)
    const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fakesig";
    const hash = await sha256Hex(fakeJwt);
    await kv.put(`token:${hash}`, "usr_jwt");

    const req = new Request("https://example.com", {
      headers: { Authorization: `Bearer ${fakeJwt}` },
    });
    const result = await authenticateRequest(req, kv);
    expect(result).toBe("usr_jwt");
  });

  it("falls back to provider-prefix stripping", async () => {
    await kv.put("token:realtoken123", "usr_prefix");
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer sk-ant-api03-realtoken123" },
    });
    const result = await authenticateRequest(req, kv);
    expect(result).toBe("usr_prefix");
  });
});

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
