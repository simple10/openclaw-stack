# Test Suite for OpenClaw Deployment Pipeline

## Context

The deployment pipeline (`bun run pre-deploy`) generates all VPS deployment artifacts from `.env` + `stack.yml` + `docker-compose.yml.hbs`. There are currently **zero tests**. The main pain point is regressions during refactors — config builds break, scripts source wrong variables, templates render incorrectly, and these issues are only caught during live VPS deployment. A test suite that validates the build pipeline, generated artifacts, and shell config resolution will catch most of these regressions locally.

## Refactoring for Testability

### 1. Extract pure functions into `build/lib/config.ts`

Move these functions out of `pre-deploy.ts` into an importable module:

- `resolveEnvRefs(text, env)` (lines 64-86)
- `isPlainObject(val)` + `deepMerge(target, source)` (lines 90-107)
- `parseMemoryValue(val)` + `formatMemory(mb)` (lines 151-164)
- `parseJsoncFile(text, filePath)` (lines 207-215)
- `validateClaw(name, claw)` (lines 219-231)
- `computeDerivedValues(claws, stack, host)` (lines 237-266)
- `formatEnvValue(val)` + `generateStackEnv(env, config, claws)` (lines 288-360)
- `ENVSUBST_VARS` constant (lines 271-282)
- Interfaces: `VpsCapacity`, `ResolvedResources`

`pre-deploy.ts` imports from `./lib/config.ts`. No behavior change.

### 2. Make `fatal()` throw instead of `process.exit(1)`

```ts
export class BuildError extends Error { name = "BuildError"; }
export function fatal(msg: string): never { throw new BuildError(msg); }
```

The `main().catch()` handler (line 527) adds `process.exit(1)`. This lets tests catch errors instead of killing the test runner.

### 3. Make `main()` accept config overrides

```ts
interface BuildConfig { rootDir: string; deployDir: string; dryRun: boolean; }
async function main(config?: Partial<BuildConfig>) { ... }
```

Integration tests pass a temp directory for `deployDir` and fixture directory for `rootDir`.

## Test Structure

```
tests/
  fixtures/
    env.fixture                    # Fake .env (10.0.0.1, test tokens)
    stack-single.yml               # Single claw, absolute resources
    stack-multi.yml                # Two claws
    stack-minimal.yml              # Bare minimum valid config
    stack-no-vector.yml            # vector: false
    stack-bad-missing-claws.yml    # No claws section (error case)
    stack-bad-missing-domain.yml   # Claw missing domain (error case)
    stack-bad-memory.yml           # Invalid memory "12TB" (error case)
  unit/
    resolve-env-refs.test.ts
    deep-merge.test.ts
    parse-memory-value.test.ts
    validate-claw.test.ts
    compute-derived-values.test.ts
    generate-stack-env.test.ts
    parse-jsonc-file.test.ts
  integration/
    build-pipeline.test.ts         # Full build → temp dir → validate output
    template-rendering.test.ts     # Handlebars template with crafted data
  bash/
    source-config.test.sh          # Bash tests with temp directory structures
    run-bash-tests.sh              # Runner
```

## Unit Tests (`tests/unit/`)

All import directly from `build/lib/config.ts`. No mocking needed — these are pure functions.

### `resolve-env-refs.test.ts`

- `${VAR}` substitution with known/missing/empty keys
- `${VAR:-default}` fallback behavior
- Comment lines (`# ...`) skipped (not processed)
- Multiple `${VAR}` on one line
- Special characters in values (URLs with colons, slashes)

### `deep-merge.test.ts`

- Source keys overwrite target scalars
- Nested objects merge recursively (not replaced)
- Arrays replaced (not merged)
- Missing source keys preserve target
- Does not mutate original objects
- Real-world: defaults + claw overrides (telegram.bot_token override)

### `parse-memory-value.test.ts`

- `"12G"` → 12288 MB, `"512M"` → 512 MB, `"512MB"` → 512 MB
- Case insensitive (`"12g"`, `"12GB"`)
- No unit defaults to M
- Invalid values throw BuildError (`"abc"`, `"12TB"`, `""`)
- `formatMemory`: 1024 → `"1G"`, 512 → `"512M"`

### `validate-claw.test.ts`

- Valid claw passes silently
- Missing `domain`/`gateway_port`/`dashboard_port` → throws BuildError
- Missing `telegram.bot_token` → warns (does not throw)

### `compute-derived-values.test.ts`

- Auto-generates `gateway_token` (64 hex chars) when not set
- Preserves existing `gateway_token`
- Sets `anthropic_base_url` = gateway URL + `/anthropic`
- Sets `allowed_origin` = `https://` + domain
- Sets `events_url`/`llmetry_url` from logging config
- Per-claw ai_gateway overrides stack-level

### `generate-stack-env.test.ts`

- Header comment present
- `ENV__VPS_IP` from env, `STACK__STACK__INSTALL_DIR` from stack
- Per-claw vars use uppercased name with hyphens → underscores
- Values with spaces/special chars are single-quoted
- `formatEnvValue`: quoting rules for spaces, single quotes, empty strings

### `parse-jsonc-file.test.ts`

- Valid JSON, JSON with `//` comments, trailing commas
- Preserves `$VAR` strings in values
- Invalid syntax throws BuildError with offset info

## Integration Tests (`tests/integration/`)

### `build-pipeline.test.ts`

Runs the full `main()` with fixture configs → temp output directory. Validates:

- `.deploy/` contains: `docker-compose.yml`, `stack.json`, `stack.env`, `source-config.sh`, `entrypoint-gateway.sh`, `openclaw/<name>/openclaw.json`
- `docker-compose.yml` is valid YAML with `services` and `networks` keys
- `stack.json` is valid JSON with `stack`, `claws`, `host` sections
- `stack.env` lines match `/^(#|[A-Z_]+=)/` pattern
- `stack.env` is bash-sourceable (`bash -c 'source <file> && echo OK'`)
- `openclaw.json` is valid JSON, contains `$OPENCLAW_DOMAIN_PATH` (not resolved), no `//` comments
- Multi-claw produces separate `openclaw/<name>/` dirs
- Error cases: missing `.env`, missing claws, invalid memory value

### `template-rendering.test.ts`

Renders `docker-compose.yml.hbs` directly with crafted context objects:

- Single-claw → one `openclaw-<name>` service
- Multi-claw → one service per claw
- Port bindings are `127.0.0.1`-scoped
- `$$OPENCLAW_GATEWAY_PORT` escaping preserved (Docker Compose `$$` syntax)
- Vector service present/absent based on `stack.vector`
- Rendered output is valid YAML
- Resource limits render from claw config

## Bash Tests (`tests/bash/`)

### `source-config.test.sh`

Creates temporary directory trees and verifies `source-config.sh` behavior:

- Local context: `.env` + `.deploy/` present → `OPENCLAW_CONTEXT="local"`, `REPO_ROOT` set
- VPS context: `stack.env` + `stack.json` present → `OPENCLAW_CONTEXT="vps"`, `REPO_ROOT` empty
- Variables from `stack.env` are exported after sourcing
- Upward search: finds config 3 levels up
- Max depth: stops at 10 levels
- Missing config: exits with error to stderr, message includes "bun run pre-deploy"

### `run-bash-tests.sh`

Simple runner with pass/fail assertions, temp dir cleanup via trap.

## Fixture Strategy

All fixtures use clearly fake data (committed to git):

- `env.fixture`: `VPS_IP=10.0.0.1`, `ROOT_DOMAIN=test.example.com`, `*_TOKEN=test-*` placeholder values
- Stack fixtures use **absolute** resource values (e.g., `max_cpu: 8`, `max_mem: 16G`) — avoids SSH queries entirely
- Error fixtures have specific structural problems for negative testing
- JSONC fixture: reference existing `openclaw/default/openclaw.jsonc` directly

## Mocking Strategy

- **SSH/VPS queries**: Not needed. Fixtures use absolute values (no `%` suffix), so `queryVpsCapacity` is never called. One dedicated test can mock `queryVpsCapacity` return value to test percentage resolution.
- **Filesystem**: Integration tests pass temp dir to `main({ deployDir: tmpDir, rootDir: fixtureDir })`
- **process.exit**: Replaced by `throw BuildError` in extracted module; `main().catch()` calls `process.exit(1)` only in CLI entry point
- **Console output**: `spyOn(console, "log")` to suppress noise

## Package.json Changes

```json
"scripts": {
  "test": "bun test",
  "test:unit": "bun test tests/unit/",
  "test:integration": "bun test tests/integration/",
  "test:bash": "bash tests/bash/run-bash-tests.sh",
  "test:all": "bun test && bash tests/bash/run-bash-tests.sh"
}
```

## Implementation Order

| Phase | What | Why first |
|-------|------|-----------|
| 1 | Extract `build/lib/config.ts` + `BuildError` + make `main()` configurable | Enables all tests |
| 2 | Fixtures (`env.fixture`, `stack-*.yml`) | Required by all tests |
| 3 | Unit tests (resolve-env-refs, deep-merge, parse-memory, validate-claw) | Highest value — catch most common regressions |
| 4 | Remaining unit tests (compute-derived, generate-stack-env, parse-jsonc) | Complete unit coverage |
| 5 | Integration tests (build-pipeline, template-rendering) | Full pipeline validation |
| 6 | Bash tests (source-config) | Shell-specific regressions |
| 7 | Package.json scripts | Developer workflow |

## Verification

After implementation, verify the test suite itself:

1. `bun test` — all TypeScript tests pass
2. `bash tests/bash/run-bash-tests.sh` — all bash tests pass
3. Introduce a known regression (e.g., break `resolveEnvRefs` regex) → confirm tests catch it
4. `bun run pre-deploy:dry` still works (refactoring didn't break the pipeline)
5. `bun run pre-deploy` still produces correct `.deploy/` output
