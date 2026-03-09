import { describe, it, expect, vi } from "vitest";
import { resolveEnvRefs } from "../../build/pre-deploy-lib.mjs";

describe("resolveEnvRefs", () => {
  it("replaces ${VAR} with env value", () => {
    const result = resolveEnvRefs("host: ${HOST}", { HOST: "example.com" });
    expect(result).toBe("host: example.com");
  });

  it("replaces ${VAR:-default} with env value when set", () => {
    const result = resolveEnvRefs("port: ${PORT:-8080}", { PORT: "3000" });
    expect(result).toBe("port: 3000");
  });

  it("uses default when env var is missing", () => {
    const result = resolveEnvRefs("port: ${PORT:-8080}", {});
    expect(result).toBe("port: 8080");
  });

  it("uses default when env var is empty string", () => {
    const result = resolveEnvRefs("port: ${PORT:-8080}", { PORT: "" });
    expect(result).toBe("port: 8080");
  });

  it("skips comment lines", () => {
    const input = "# comment: ${SECRET}\nreal: ${HOST}";
    const result = resolveEnvRefs(input, { SECRET: "s3cr3t", HOST: "ok" });
    expect(result).toBe("# comment: ${SECRET}\nreal: ok");
  });

  it("calls onWarn for unresolved vars", () => {
    const onWarn = vi.fn();
    resolveEnvRefs("val: ${MISSING}", {}, onWarn);
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("MISSING")
    );
  });

  it("handles multiple refs per line", () => {
    const result = resolveEnvRefs("${A}:${B}", { A: "hello", B: "world" });
    expect(result).toBe("hello:world");
  });

  it("returns empty string for unresolved vars without default", () => {
    const result = resolveEnvRefs("val: ${MISSING}", {}, () => {});
    expect(result).toBe("val: ");
  });
});
