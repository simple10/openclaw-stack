import { describe, it, expect } from "vitest";
import { jsonError } from "../src/errors";

describe("jsonError", () => {
  it("returns correct status code", () => {
    const response = jsonError("Not found", 404);
    expect(response.status).toBe(404);
  });

  it("returns JSON content type", () => {
    const response = jsonError("Bad request", 400);
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  it("returns error object in body", async () => {
    const response = jsonError("Something broke", 500);
    const body = await response.json();
    expect(body).toEqual({ error: { message: "Something broke" } });
  });
});
