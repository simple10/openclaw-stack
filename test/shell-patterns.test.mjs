import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

function grepExits(pattern, file) {
  try {
    execSync(`grep -q ${pattern} "${file}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("build-openclaw.sh grep patterns", () => {
  // Main uses: grep -q "docker.io" Dockerfile
  // This is the CURRENT pattern on main — it has a known false-positive
  // where FROM docker.io/library/node matches even without the install line.
  describe('grep -q "docker.io" (main branch pattern)', () => {
    it("matches patched Dockerfile (has install line)", () => {
      expect(grepExits('"docker.io"', join(FIXTURES, "Dockerfile.patched"))).toBe(true);
    });

    it("does NOT match unpatched Dockerfile", () => {
      expect(grepExits('"docker.io"', join(FIXTURES, "Dockerfile.unpatched"))).toBe(false);
    });

    it("FALSE POSITIVE: matches OCI label Dockerfile (known bug)", () => {
      // This documents the known bug on main: FROM docker.io/library/node
      // triggers the grep, so the patch is skipped even though docker.io
      // package isn't installed. Fixed on the deploy fix branch.
      expect(grepExits('"docker.io"', join(FIXTURES, "Dockerfile.oci-label"))).toBe(true);
    });
  });

  describe("grep -q '^data/' .dockerignore", () => {
    it("matches when data/ exclusion exists", () => {
      expect(grepExits("'^data/'", join(FIXTURES, "dockerignore.with-data"))).toBe(true);
    });

    it("does not match when data/ is absent", () => {
      expect(grepExits("'^data/'", join(FIXTURES, "dockerignore.with-git"))).toBe(false);
    });
  });

  describe("grep -q '^\\.git$' .dockerignore", () => {
    it("matches exact .git line", () => {
      expect(grepExits("'^\\.git$'", join(FIXTURES, "dockerignore.with-git"))).toBe(true);
    });

    it("does not match when .git is absent", () => {
      expect(grepExits("'^\\.git$'", join(FIXTURES, "dockerignore.no-git"))).toBe(false);
    });
  });

  describe("grep -q 'rm.*tmp/jiti' Dockerfile (jiti cache patch)", () => {
    it("does not match unpatched Dockerfile", () => {
      expect(grepExits("'rm.*tmp/jiti'", join(FIXTURES, "Dockerfile.unpatched"))).toBe(false);
    });
  });

  describe("broken import pattern", () => {
    it("matches broken import path", () => {
      expect(
        grepExits('"openclaw/plugin-sdk/keyed-async-queue"', join(FIXTURES, "send-queue.broken.ts"))
      ).toBe(true);
    });

    it("does not match fixed import path", () => {
      expect(
        grepExits('"openclaw/plugin-sdk/keyed-async-queue"', join(FIXTURES, "send-queue.fixed.ts"))
      ).toBe(false);
    });
  });
});
