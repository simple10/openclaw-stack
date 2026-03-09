import { describe, it, expect } from "vitest";
import { handlePreflight, addCorsHeaders } from "../src/cors";

describe("handlePreflight", () => {
  it("returns 204 status", () => {
    const response = handlePreflight();
    expect(response.status).toBe(204);
  });

  it("includes CORS headers", () => {
    const response = handlePreflight();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("sets max-age header", () => {
    const response = handlePreflight();
    expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
  });
});

describe("addCorsHeaders", () => {
  it("adds CORS headers to response", () => {
    const original = new Response("body", { status: 200 });
    const patched = addCorsHeaders(original);
    expect(patched.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("preserves original status", () => {
    const original = new Response("error", { status: 500 });
    const patched = addCorsHeaders(original);
    expect(patched.status).toBe(500);
  });

  it("preserves body", async () => {
    const original = new Response("test body", { status: 200 });
    const patched = addCorsHeaders(original);
    expect(await patched.text()).toBe("test body");
  });
});
