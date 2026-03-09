import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "deploy", "openclaw-stack", "resolve-config-vars.mjs");
const TMP = join(__dirname, ".tmp-resolve-test");

function setup(configContent, composeContent) {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, ".deploy"), { recursive: true });
  const configPath = join(TMP, "openclaw.jsonc");
  writeFileSync(configPath, configContent);
  writeFileSync(join(TMP, ".deploy", "docker-compose.yml"), composeContent);
  return configPath;
}

function run(configPath, clawName) {
  return execSync(`node "${SCRIPT}" "${configPath}" "${clawName}"`, {
    encoding: "utf-8",
  });
}

function cleanup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
}

const composeYml = `
services:
  test-openclaw-main:
    environment:
      - TOKEN=abc123
      - PORT=8080
      - EMPTY_VAR=
      - DOMAIN=example.com
`;

describe("resolve-config-vars.mjs", () => {
  afterEach(cleanup);

  it("resolves ${VAR} with env value", () => {
    const configPath = setup('{"token": "${TOKEN}"}', composeYml);
    const result = run(configPath, "main");
    expect(result).toContain('"token": "abc123"');
  });

  it("resolves ${VAR:-default} with env value when set", () => {
    const configPath = setup('{"port": "${PORT:-9090}"}', composeYml);
    const result = run(configPath, "main");
    expect(result).toContain('"port": "8080"');
  });

  it("uses default when var is empty", () => {
    const configPath = setup('{"val": "${EMPTY_VAR:-fallback}"}', composeYml);
    const result = run(configPath, "main");
    expect(result).toContain('"val": "fallback"');
  });

  it("uses default when var is missing", () => {
    const configPath = setup('{"val": "${MISSING:-default_val}"}', composeYml);
    const result = run(configPath, "main");
    expect(result).toContain('"val": "default_val"');
  });

  it("resolves multiple vars in same file", () => {
    const configPath = setup(
      '{"a": "${TOKEN}", "b": "${DOMAIN}"}',
      composeYml
    );
    const result = run(configPath, "main");
    expect(result).toContain('"a": "abc123"');
    expect(result).toContain('"b": "example.com"');
  });

  it("preserves JSONC comments in output", () => {
    const configPath = setup(
      '// comment\n{"token": "${TOKEN}"}',
      composeYml
    );
    const result = run(configPath, "main");
    expect(result).toContain("// comment");
    expect(result).toContain('"token": "abc123"');
  });

  it("passes through unchanged when compose file is missing", () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    const configPath = join(TMP, "openclaw.jsonc");
    writeFileSync(configPath, '{"token": "${TOKEN}"}');
    const result = run(configPath, "main");
    expect(result).toContain("${TOKEN}");
  });
});
