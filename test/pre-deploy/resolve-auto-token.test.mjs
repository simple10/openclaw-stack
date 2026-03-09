import { describe, it, expect, vi } from "vitest";
import { resolveAutoToken } from "../../build/pre-deploy-lib.mjs";

describe("resolveAutoToken", () => {
  const mockGenerate = vi.fn(() => "generated-token");

  it("returns explicit value when provided", () => {
    const result = resolveAutoToken("explicit", "a.b", null, mockGenerate);
    expect(result).toBe("explicit");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("returns cached value from previous deploy", () => {
    const prev = { a: { b: "cached-token" } };
    const result = resolveAutoToken("", "a.b", prev, mockGenerate);
    expect(result).toBe("cached-token");
  });

  it("generates new token when no explicit or cached value", () => {
    mockGenerate.mockReturnValue("new-token");
    const result = resolveAutoToken("", "a.b", null, mockGenerate);
    expect(result).toBe("new-token");
  });

  it("handles undefined intermediate keys in cache path", () => {
    const prev = { a: {} };
    mockGenerate.mockReturnValue("fallback");
    const result = resolveAutoToken("", "a.b.c", prev, mockGenerate);
    expect(result).toBe("fallback");
  });

  it("handles null previous deploy", () => {
    mockGenerate.mockReturnValue("fresh");
    const result = resolveAutoToken(null, "x.y", null, mockGenerate);
    expect(result).toBe("fresh");
  });
});
