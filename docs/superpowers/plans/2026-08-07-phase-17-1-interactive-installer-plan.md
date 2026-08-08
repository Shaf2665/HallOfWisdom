# Phase 17.1 — Interactive Installer + Persistent Hall Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce `.\install.ps1` as Hall of Wisdom's primary Windows onboarding experience, backed by a new versioned, persistent `@hall-of-wisdom/hall-config` package, so a normal user never has to retype Hall Core's long startup flags again.

**Architecture:** A new `packages/hall-config` package owns the persisted-config schema, cross-platform storage location, atomic load/save, and a thin JSON-in/JSON-out CLI. `apps/server` splits CLI parsing into optional "overrides" vs. a required-workspaceRoot "resolved config" merged per-field (CLI > persisted > default), gains a side-effect-minimized `--verify-only` preflight, and derives `webOrigin` from `hallWebPort`. `install.ps1` (plus small PowerShell support modules under `scripts/install/`) drives prerequisite checks, prompts, build, and verification, using verify-before-promote for reconfiguration.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), Zod, Vitest, Windows PowerShell 5.1+/pwsh 7, Node's built-in `parseArgs`.

**Design doc:** `docs/superpowers/specs/2026-08-07-phase-17-1-interactive-installer-design.md` — read it first; this plan implements it exactly, including all five corrections (CLI-overrides/resolved-config split, persisted `comparisonRoot` with derived default, side-effect-minimized `--verify-only`, verify-before-promote reconfiguration, `hallWebPort`→`webOrigin` derivation).

## Global Constraints

- Node.js `>=24.11.0 <25`, pnpm `10.33.0` (root `package.json`, do not change).
- TypeScript strict mode, ESM/NodeNext, `verbatimModuleSyntax` — use `import type` for type-only imports.
- `exactOptionalPropertyTypes: true` — an optional field either has a real value or the key is omitted entirely; never assign `undefined` to it explicitly except via conditional spread (`...(x === undefined ? {} : { x })`), matching the codebase's existing pattern.
- No new runtime dependencies beyond what's already in the workspace (Zod, Node builtins) — no new PowerShell test framework (no Pester dependency), no shell-command string concatenation, no `Invoke-Expression`.
- `--verify-only` must never call `runRestartRecovery`, CEO plan recovery, worktree cleanup/reconciliation, task mutation, or `app.listen()`, and must never fence/supersede a live Hall Core instance.
- Reconfiguration must validate a candidate before the active `config.json` is atomically replaced — never write-active-then-rollback.
- Phase 16 configuration-fingerprint (`checkOrRecordConfigurationFingerprint`) and worktree path-safety code (`path-safety.ts`, `database-config.ts`, `instance-ownership.ts`, `database-ownership-fence.ts`) are reused as-is, never reimplemented or weakened.
- `mockScenario` / `mockStepDelayMs` stay CLI-only — never added to the persisted `HallConfig` schema.
- Installer `pnpm typecheck` + `pnpm build` are blocking; `pnpm lint` + `pnpm test` are installer diagnostics (reported, non-blocking) — but all four must pass before Phase 17.1 itself is considered complete (see Task 18).
- No Phase 17.2 provider-login/auth work in this phase.
- Every task's tests run via `vitest run` (existing convention) except the PowerShell tasks, which use plain assertion scripts (no Pester).
- Branch: `phase-17-1-interactive-installer` (already created, starting commit `d03ed4f04f77d411a17614ca0f625face70e62a2`). Do not merge to `main`.

---

## File Structure

New:
- `packages/hall-config/` — new workspace package (`package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `verify-package-entry.mjs`, `src/schema.ts`, `src/config-path.ts`, `src/config-store.ts`, `src/path-precheck.ts`, `src/run-cli.ts`, `src/cli.ts`, `src/index.ts`, plus `*.test.ts` siblings).
- `apps/server/src/config/resolve-server-config.ts` (+ test) — CLI-overrides/persisted-config merge and final validation.
- `apps/server/src/verify-only/run-verify-only.ts` (+ test) — the `--verify-only` preflight.
- `apps/server/src/process-tests/phase-17-1-verify-only.test.ts` — real-binary process test.
- `docs/architecture/0017-persistent-hall-configuration.md` — ADR.
- `install.ps1` (repo root) — entrypoint.
- `scripts/install/Prerequisites.ps1`, `scripts/install/HallConfigDefaults.ps1`, `scripts/install/HallConfigCli.ps1`, `scripts/install/Verification.ps1`, `scripts/install/Reconfigure.ps1` — support modules.
- `scripts/install/tests/*.Tests.ps1` + `scripts/install/tests/run-tests.ps1` — PowerShell test runner.

Modified:
- `apps/server/src/config/server-cli-args.ts` (+ test) — split into overrides-only schema, add `--verify-only`.
- `apps/server/src/config/server-config.ts` — hoist exit-code constants so `run-verify-only.ts` can share them.
- `apps/server/src/server.ts` (+ test) — load persisted config, resolve, branch to `runVerifyOnly` early.
- `apps/server/package.json` — add `@hall-of-wisdom/hall-config` dependency.
- `README.md` — point to `install.ps1` as the primary path (minimal correction only).

---

### Task 1: Scaffold `packages/hall-config` and its schema

**Files:**
- Create: `packages/hall-config/package.json`
- Create: `packages/hall-config/tsconfig.json`
- Create: `packages/hall-config/tsconfig.build.json`
- Create: `packages/hall-config/vitest.config.ts`
- Create: `packages/hall-config/verify-package-entry.mjs`
- Create: `packages/hall-config/src/schema.ts`
- Test: `packages/hall-config/src/schema.test.ts`

**Interfaces:**
- Produces: `HALL_CONFIG_SCHEMA_VERSION: 1`, `DEFAULT_HALL_CORE_PORT: 4310`, `DEFAULT_HALL_WEB_PORT: 3000`, `HallConfigSchema` (Zod), `type HallConfig`, `parseHallConfig(raw: unknown): HallConfig`, `class HallConfigValidationError extends Error`, `class UnsupportedHallConfigSchemaVersionError extends Error`.

- [ ] **Step 1: Create the package scaffold**

`packages/hall-config/package.json`:
```json
{
  "name": "@hall-of-wisdom/hall-config",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Versioned, persisted Hall configuration: schema, cross-platform storage location, atomic load/save, and a thin CLI for non-Node callers (install.ps1).",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "bin": {
    "hall-config": "./dist/cli.js"
  },
  "files": ["dist"],
  "engines": {
    "node": ">=24.11.0 <25"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "build": "tsc -p tsconfig.build.json",
    "lint": "eslint .",
    "test": "vitest run",
    "verify:package-entry": "node verify-package-entry.mjs"
  },
  "dependencies": {
    "@hall-of-wisdom/protocol": "workspace:*",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^24.0.0"
  }
}
```

`packages/hall-config/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src", "vitest.config.ts"],
  "exclude": ["dist", "node_modules"]
}
```

`packages/hall-config/tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "noEmit": false,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["dist", "node_modules", "src/**/*.test.ts"]
}
```

`packages/hall-config/vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: false,
  },
});
```

`packages/hall-config/verify-package-entry.mjs`:
```javascript
// Proves the *built* package can be consumed the same way an external
// package would consume it — resolving through its `exports` map, never
// by reaching into `src` or `dist` directly. Run after `pnpm build`.
import assert from "node:assert/strict";
import fs from "node:fs";

const hallConfig = await import("@hall-of-wisdom/hall-config");

assert.equal(hallConfig.HALL_CONFIG_SCHEMA_VERSION, 1, "HALL_CONFIG_SCHEMA_VERSION should be 1");
assert.equal(typeof hallConfig.parseHallConfig, "function", "parseHallConfig should be exported");
assert.equal(typeof hallConfig.loadConfig, "function", "loadConfig should be exported");
assert.equal(typeof hallConfig.saveConfig, "function", "saveConfig should be exported");
assert.equal(
  typeof hallConfig.resolveHallConfigFilePath,
  "function",
  "resolveHallConfigFilePath should be exported",
);

const validConfig = hallConfig.parseHallConfig({
  schemaVersion: 1,
  workspaceRoot: "D:\\HallOfWisdom",
  comparisonRoot: null,
  hallCorePort: 4310,
  hallWebPort: 3000,
  codexTrustedLocal: false,
});
assert.equal(validConfig.workspaceRoot, "D:\\HallOfWisdom", "parseHallConfig should round-trip a valid config");

assert.throws(
  () => hallConfig.parseHallConfig({ schemaVersion: 1 }),
  hallConfig.HallConfigValidationError,
  "invalid input should raise HallConfigValidationError through the public entry point",
);

assert.ok(fs.existsSync(new URL("./dist/cli.js", import.meta.url)), "dist/cli.js should exist after build");

console.log("OK: @hall-of-wisdom/hall-config resolves and behaves correctly through its public entry point.");
```

- [ ] **Step 2: Write the failing schema test**

`packages/hall-config/src/schema.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HALL_CORE_PORT,
  DEFAULT_HALL_WEB_PORT,
  HALL_CONFIG_SCHEMA_VERSION,
  HallConfigValidationError,
  UnsupportedHallConfigSchemaVersionError,
  parseHallConfig,
} from "./schema.js";

const BASE = {
  schemaVersion: 1,
  workspaceRoot: "D:\\HallOfWisdom",
  comparisonRoot: null,
};

describe("parseHallConfig", () => {
  it("parses a minimal valid config, applying port/codex defaults", () => {
    const config = parseHallConfig(BASE);
    expect(config.workspaceRoot).toBe("D:\\HallOfWisdom");
    expect(config.hallCorePort).toBe(DEFAULT_HALL_CORE_PORT);
    expect(config.hallWebPort).toBe(DEFAULT_HALL_WEB_PORT);
    expect(config.codexTrustedLocal).toBe(false);
    expect(config.comparisonRoot).toBeNull();
    expect(config.dataDir).toBeUndefined();
    expect(config.agentWorktreeRoot).toBeUndefined();
  });

  it("parses a fully populated config", () => {
    const config = parseHallConfig({
      ...BASE,
      dataDir: "D:\\HallOfWisdomData",
      agentWorktreeRoot: "D:\\HallOfWisdomAgentWorktrees",
      comparisonRoot: "D:\\HallOfWisdomComparisons",
      hallCorePort: 5000,
      hallWebPort: 5001,
      codexTrustedLocal: true,
    });
    expect(config.dataDir).toBe("D:\\HallOfWisdomData");
    expect(config.comparisonRoot).toBe("D:\\HallOfWisdomComparisons");
    expect(config.codexTrustedLocal).toBe(true);
  });

  it("rejects a missing workspaceRoot", () => {
    expect(() => parseHallConfig({ ...BASE, workspaceRoot: undefined })).toThrow(
      HallConfigValidationError,
    );
  });

  it("rejects a missing comparisonRoot key entirely (must be string or null, never absent)", () => {
    const { comparisonRoot: _omit, ...withoutComparisonRoot } = BASE;
    expect(() => parseHallConfig(withoutComparisonRoot)).toThrow(HallConfigValidationError);
  });

  it("rejects an unknown extra field (.strict())", () => {
    expect(() => parseHallConfig({ ...BASE, unknownField: "x" })).toThrow(HallConfigValidationError);
  });

  it("rejects an out-of-range hallCorePort", () => {
    expect(() => parseHallConfig({ ...BASE, hallCorePort: 99999 })).toThrow(HallConfigValidationError);
  });

  it("throws UnsupportedHallConfigSchemaVersionError for a newer schemaVersion", () => {
    expect(() => parseHallConfig({ ...BASE, schemaVersion: 2 })).toThrow(
      UnsupportedHallConfigSchemaVersionError,
    );
  });

  it("rejects schemaVersion 0 as a generic validation error, not unsupported-version", () => {
    expect(() => parseHallConfig({ ...BASE, schemaVersion: 0 })).toThrow(HallConfigValidationError);
  });

  it("never accidentally exposes credential-shaped fields (documentation-as-test)", () => {
    const config = parseHallConfig(BASE);
    expect(Object.keys(config)).not.toContain("token");
    expect(Object.keys(config)).not.toContain("apiKey");
    expect(Object.keys(config)).not.toContain("password");
  });

  it("HALL_CONFIG_SCHEMA_VERSION is 1", () => {
    expect(HALL_CONFIG_SCHEMA_VERSION).toBe(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @hall-of-wisdom/hall-config run test`
Expected: FAIL — `./schema.js` does not exist yet (and the package isn't registered with pnpm yet either; run `pnpm install` at the repo root first so the new workspace member is linked).

- [ ] **Step 4: Write `src/schema.ts`**

```typescript
import { z } from "zod";
import { boundedNonBlankString } from "@hall-of-wisdom/protocol";

export const HALL_CONFIG_SCHEMA_VERSION = 1;

export const DEFAULT_HALL_CORE_PORT = 4310;
export const DEFAULT_HALL_WEB_PORT = 3000;

const portSchema = z.number().int().min(1).max(65535);

export const HallConfigSchema = z
  .object({
    schemaVersion: z.literal(HALL_CONFIG_SCHEMA_VERSION),
    workspaceRoot: boundedNonBlankString(4096),
    dataDir: boundedNonBlankString(4096).optional(),
    agentWorktreeRoot: boundedNonBlankString(4096).optional(),
    // `null` means comparisons are explicitly disabled; a string is the
    // persisted comparison root. Always present as a key — never simply
    // absent — so intent is never ambiguous the way an omitted-vs-disabled
    // CLI flag would be.
    comparisonRoot: boundedNonBlankString(4096).nullable(),
    hallCorePort: portSchema.default(DEFAULT_HALL_CORE_PORT),
    hallWebPort: portSchema.default(DEFAULT_HALL_WEB_PORT),
    codexTrustedLocal: z.boolean().default(false),
  })
  .strict();

export type HallConfig = z.infer<typeof HallConfigSchema>;

export class HallConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HallConfigValidationError";
  }
}

export class UnsupportedHallConfigSchemaVersionError extends Error {
  constructor(foundVersion: number) {
    super(
      `Hall configuration schema version ${String(foundVersion)} is newer than the highest version this build supports (${String(HALL_CONFIG_SCHEMA_VERSION)}). Refusing to load it.`,
    );
    this.name = "UnsupportedHallConfigSchemaVersionError";
  }
}

function hasNewerSchemaVersion(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null || !("schemaVersion" in raw)) return undefined;
  const value = (raw as { schemaVersion: unknown }).schemaVersion;
  return typeof value === "number" && value > HALL_CONFIG_SCHEMA_VERSION ? value : undefined;
}

export function parseHallConfig(raw: unknown): HallConfig {
  const newerVersion = hasNewerSchemaVersion(raw);
  if (newerVersion !== undefined) {
    throw new UnsupportedHallConfigSchemaVersionError(newerVersion);
  }
  const result = HallConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new HallConfigValidationError(`Invalid Hall configuration: ${issues}`);
  }
  return result.data;
}
```

- [ ] **Step 5: Register the workspace member and run the test**

Run: `pnpm install` (links the new package into the workspace), then `pnpm --filter @hall-of-wisdom/hall-config run test`
Expected: PASS (all `schema.test.ts` cases green).

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @hall-of-wisdom/hall-config run typecheck`
Expected: no errors.

```bash
git add packages/hall-config/package.json packages/hall-config/tsconfig.json packages/hall-config/tsconfig.build.json packages/hall-config/vitest.config.ts packages/hall-config/verify-package-entry.mjs packages/hall-config/src/schema.ts packages/hall-config/src/schema.test.ts pnpm-lock.yaml
git commit -m "feat(hall-config): scaffold package and versioned HallConfigSchema"
```

---

### Task 2: `config-path.ts` — cross-platform config file location

**Files:**
- Create: `packages/hall-config/src/config-path.ts`
- Test: `packages/hall-config/src/config-path.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `HALL_CONFIG_DIR_ENV_OVERRIDE: "HALL_CONFIG_DIR"`, `HALL_CONFIG_FILE_NAME: "config.json"`, `resolveHallConfigDir(env?, platform?): string`, `resolveHallConfigFilePath(env?, platform?): string`.

- [ ] **Step 1: Write the failing test**

`packages/hall-config/src/config-path.test.ts`:
```typescript
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HALL_CONFIG_DIR_ENV_OVERRIDE,
  HALL_CONFIG_FILE_NAME,
  resolveHallConfigDir,
  resolveHallConfigFilePath,
} from "./config-path.js";

describe("resolveHallConfigDir", () => {
  it("uses %LOCALAPPDATA%\\HallOfWisdom on win32", () => {
    const dir = resolveHallConfigDir({ LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" }, "win32");
    expect(dir).toBe(path.join("C:\\Users\\Test\\AppData\\Local", "HallOfWisdom"));
  });

  it("falls back to homedir-derived Local path on win32 when LOCALAPPDATA is unset", () => {
    const dir = resolveHallConfigDir({}, "win32");
    expect(dir.endsWith(path.join("AppData", "Local", "HallOfWisdom"))).toBe(true);
  });

  it("uses ~/Library/Application Support/HallOfWisdom on darwin", () => {
    const dir = resolveHallConfigDir({}, "darwin");
    expect(dir.endsWith(path.join("Library", "Application Support", "HallOfWisdom"))).toBe(true);
  });

  it("uses $XDG_CONFIG_HOME/hall-of-wisdom on linux when set", () => {
    const dir = resolveHallConfigDir({ XDG_CONFIG_HOME: "/home/test/.config" }, "linux");
    expect(dir).toBe(path.join("/home/test/.config", "hall-of-wisdom"));
  });

  it("falls back to ~/.config/hall-of-wisdom on linux when XDG_CONFIG_HOME is unset", () => {
    const dir = resolveHallConfigDir({}, "linux");
    expect(dir.endsWith(path.join(".config", "hall-of-wisdom"))).toBe(true);
  });

  it("HALL_CONFIG_DIR env override wins on every platform", () => {
    const override = { [HALL_CONFIG_DIR_ENV_OVERRIDE]: "D:\\FakeHallConfigForTests" };
    expect(resolveHallConfigDir(override, "win32")).toBe("D:\\FakeHallConfigForTests");
    expect(resolveHallConfigDir(override, "linux")).toBe("D:\\FakeHallConfigForTests");
  });

  it("ignores a blank HALL_CONFIG_DIR override", () => {
    const dir = resolveHallConfigDir({ [HALL_CONFIG_DIR_ENV_OVERRIDE]: "   ", LOCALAPPDATA: "C:\\LA" }, "win32");
    expect(dir).toBe(path.join("C:\\LA", "HallOfWisdom"));
  });
});

describe("resolveHallConfigFilePath", () => {
  it("appends config.json to the resolved directory", () => {
    const filePath = resolveHallConfigFilePath({ LOCALAPPDATA: "C:\\LA" }, "win32");
    expect(filePath).toBe(path.join("C:\\LA", "HallOfWisdom", HALL_CONFIG_FILE_NAME));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @hall-of-wisdom/hall-config run test`
Expected: FAIL with "Cannot find module './config-path.js'".

- [ ] **Step 3: Write `src/config-path.ts`**

```typescript
import os from "node:os";
import path from "node:path";

export const HALL_CONFIG_DIR_ENV_OVERRIDE = "HALL_CONFIG_DIR";
export const HALL_CONFIG_FILE_NAME = "config.json";

/**
 * Resolves Hall's persisted-configuration directory. Deliberately
 * machine-local (Windows `%LOCALAPPDATA%`, not Roaming): this file stores
 * machine-specific absolute paths that must never sync across machines via
 * a roaming profile. Overridable via `HALL_CONFIG_DIR` so tests never touch
 * a real user profile.
 */
export function resolveHallConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env[HALL_CONFIG_DIR_ENV_OVERRIDE];
  if (override !== undefined && override.trim().length > 0) {
    return override;
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    const base =
      localAppData !== undefined && localAppData.trim().length > 0
        ? localAppData
        : path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "HallOfWisdom");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "HallOfWisdom");
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME;
  const base =
    xdgConfigHome !== undefined && xdgConfigHome.trim().length > 0
      ? xdgConfigHome
      : path.join(os.homedir(), ".config");
  return path.join(base, "hall-of-wisdom");
}

export function resolveHallConfigFilePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(resolveHallConfigDir(env, platform), HALL_CONFIG_FILE_NAME);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @hall-of-wisdom/hall-config run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hall-config/src/config-path.ts packages/hall-config/src/config-path.test.ts
git commit -m "feat(hall-config): resolve cross-platform config file location"
```

---

### Task 3: `config-store.ts` — atomic load/save

**Files:**
- Create: `packages/hall-config/src/config-store.ts`
- Test: `packages/hall-config/src/config-store.test.ts`

**Interfaces:**
- Consumes: `resolveHallConfigFilePath` (Task 2), `parseHallConfig`/`HallConfig`/`HallConfigValidationError`/`UnsupportedHallConfigSchemaVersionError` (Task 1).
- Produces: `interface LoadedHallConfig { config: HallConfig; path: string }`, `loadConfig(configPath?): LoadedHallConfig`, `tryLoadConfig(configPath?): LoadedHallConfig | undefined`, `saveConfig(config, configPath?): void`, `class HallConfigNotFoundError extends Error`.

- [ ] **Step 1: Write the failing test**

`packages/hall-config/src/config-store.test.ts`:
```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HallConfigNotFoundError, loadConfig, saveConfig, tryLoadConfig } from "./config-store.js";
import { HallConfigValidationError, UnsupportedHallConfigSchemaVersionError } from "./schema.js";

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hall-config-store-test-"));
  configPath = path.join(tmpDir, "nested", "config.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const VALID_CONFIG = {
  schemaVersion: 1 as const,
  workspaceRoot: "D:\\HallOfWisdom",
  comparisonRoot: null,
  dataDir: undefined,
  agentWorktreeRoot: undefined,
  hallCorePort: 4310,
  hallWebPort: 3000,
  codexTrustedLocal: false,
};

describe("saveConfig / loadConfig round-trip", () => {
  it("creates the directory and writes a readable config", () => {
    saveConfig(VALID_CONFIG, configPath);
    const loaded = loadConfig(configPath);
    expect(loaded.config.workspaceRoot).toBe("D:\\HallOfWisdom");
    expect(loaded.path).toBe(configPath);
  });

  it("overwrites an existing config atomically (no leftover temp files)", () => {
    saveConfig(VALID_CONFIG, configPath);
    saveConfig({ ...VALID_CONFIG, workspaceRoot: "D:\\Other" }, configPath);
    const loaded = loadConfig(configPath);
    expect(loaded.config.workspaceRoot).toBe("D:\\Other");
    const dirEntries = fs.readdirSync(path.dirname(configPath));
    expect(dirEntries).toEqual(["config.json"]);
  });

  it("rejects saving an invalid config before ever touching the file", () => {
    expect(() => saveConfig({ ...VALID_CONFIG, workspaceRoot: "" } as never, configPath)).toThrow();
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

describe("loadConfig", () => {
  it("throws HallConfigNotFoundError when no file exists", () => {
    expect(() => loadConfig(configPath)).toThrow(HallConfigNotFoundError);
  });

  it("throws HallConfigValidationError on malformed JSON content", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{ not valid json", "utf8");
    expect(() => loadConfig(configPath)).toThrow();
  });

  it("throws HallConfigValidationError on schema-invalid JSON content", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1 }), "utf8");
    expect(() => loadConfig(configPath)).toThrow(HallConfigValidationError);
  });

  it("throws UnsupportedHallConfigSchemaVersionError on a future schema version", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ ...VALID_CONFIG, schemaVersion: 2 }), "utf8");
    expect(() => loadConfig(configPath)).toThrow(UnsupportedHallConfigSchemaVersionError);
  });
});

describe("tryLoadConfig", () => {
  it("returns undefined (never throws) when no file exists", () => {
    expect(tryLoadConfig(configPath)).toBeUndefined();
  });

  it("returns the loaded config when the file exists", () => {
    saveConfig(VALID_CONFIG, configPath);
    expect(tryLoadConfig(configPath)?.config.workspaceRoot).toBe("D:\\HallOfWisdom");
  });

  it("still throws on a malformed existing file (never masks corruption as absence)", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{ not valid json", "utf8");
    expect(() => tryLoadConfig(configPath)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @hall-of-wisdom/hall-config run test`
Expected: FAIL with "Cannot find module './config-store.js'".

- [ ] **Step 3: Write `src/config-store.ts`**

```typescript
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveHallConfigFilePath } from "./config-path.js";
import { parseHallConfig, type HallConfig } from "./schema.js";

export class HallConfigNotFoundError extends Error {
  constructor(configPath: string) {
    super(`No Hall configuration found at "${configPath}".`);
    this.name = "HallConfigNotFoundError";
  }
}

export interface LoadedHallConfig {
  readonly config: HallConfig;
  readonly path: string;
}

export function loadConfig(configPath: string = resolveHallConfigFilePath()): LoadedHallConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new HallConfigNotFoundError(configPath);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Hall configuration at "${configPath}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { config: parseHallConfig(parsed), path: configPath };
}

/** Returns `undefined` (never throws) only when no config file exists yet — the normal "first run" case. A malformed or unsupported-version file still throws, so corruption is never silently treated as absence. */
export function tryLoadConfig(
  configPath: string = resolveHallConfigFilePath(),
): LoadedHallConfig | undefined {
  if (!fs.existsSync(configPath)) return undefined;
  return loadConfig(configPath);
}

/**
 * Atomic write: validates `config`, writes it to a fresh temp file in the
 * *same directory* as `configPath`, then `fs.renameSync`s it over the
 * target — an atomic replace on both POSIX and Windows (same-volume
 * rename), so an interrupted write can never leave a half-written config
 * file behind. Validates before touching the filesystem at all.
 */
export function saveConfig(
  config: HallConfig,
  configPath: string = resolveHallConfigFilePath(),
): void {
  const validated = parseHallConfig(config);
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(configPath)}.tmp-${randomUUID()}`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, configPath);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @hall-of-wisdom/hall-config run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hall-config/src/config-store.ts packages/hall-config/src/config-store.test.ts
git commit -m "feat(hall-config): atomic loadConfig/saveConfig"
```

---

### Task 4: `path-precheck.ts` — best-effort UX pre-check

**Files:**
- Create: `packages/hall-config/src/path-precheck.ts`
- Test: `packages/hall-config/src/path-precheck.test.ts`

**Interfaces:**
- Produces: `precheckHallOwnedPath(rawPath: string, label: string): void`, `class HallConfigPathPrecheckError extends Error`.

This is deliberately **not** the authoritative safety validation — that stays entirely inside `apps/server` (canonicalization, mutual non-containment, the fingerprint). This exists only so `install.ps1` can reject an obviously-wrong path before spending time on a build.

- [ ] **Step 1: Write the failing test**

`packages/hall-config/src/path-precheck.test.ts`:
```typescript
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { HallConfigPathPrecheckError, precheckHallOwnedPath } from "./path-precheck.js";

describe("precheckHallOwnedPath", () => {
  it("accepts a plausible absolute path", () => {
    expect(() => precheckHallOwnedPath("D:\\HallOfWisdomData", "dataDir")).not.toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => precheckHallOwnedPath("", "dataDir")).toThrow(HallConfigPathPrecheckError);
  });

  it("rejects a blank string", () => {
    expect(() => precheckHallOwnedPath("   ", "dataDir")).toThrow(HallConfigPathPrecheckError);
  });

  it("rejects a relative path", () => {
    expect(() => precheckHallOwnedPath("relative\\path", "dataDir")).toThrow(
      HallConfigPathPrecheckError,
    );
  });

  it("rejects a bare filesystem root", () => {
    const root = os.platform() === "win32" ? "D:\\" : "/";
    expect(() => precheckHallOwnedPath(root, "dataDir")).toThrow(HallConfigPathPrecheckError);
  });

  it("includes the label in the error message", () => {
    expect(() => precheckHallOwnedPath("", "agentWorktreeRoot")).toThrow(/agentWorktreeRoot/);
  });

  it("accepts a path built with path.join to prove platform-appropriate separators work", () => {
    const candidate = path.join(os.platform() === "win32" ? "D:\\" : "/", "HallOfWisdomData");
    expect(() => precheckHallOwnedPath(candidate, "dataDir")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @hall-of-wisdom/hall-config run test`
Expected: FAIL with "Cannot find module './path-precheck.js'".

- [ ] **Step 3: Write `src/path-precheck.ts`**

```typescript
import path from "node:path";

export class HallConfigPathPrecheckError extends Error {
  constructor(label: string, reason: string) {
    super(`${label} ${reason}`);
    this.name = "HallConfigPathPrecheckError";
  }
}

/**
 * Best-effort UX pre-check only — NOT the authoritative safety validation.
 * `apps/server`'s own startup path (canonicalization, mutual
 * non-containment, the configuration fingerprint) remains the sole source
 * of truth; this exists purely so `install.ps1` can reject an obviously
 * wrong path before spending time on a build.
 */
export function precheckHallOwnedPath(rawPath: string, label: string): void {
  if (rawPath.trim().length === 0) {
    throw new HallConfigPathPrecheckError(label, "must not be empty.");
  }
  if (!path.isAbsolute(rawPath)) {
    throw new HallConfigPathPrecheckError(label, "must be an absolute path.");
  }
  const normalized = path.resolve(rawPath);
  if (path.parse(normalized).root === normalized) {
    throw new HallConfigPathPrecheckError(label, "must not be a filesystem root.");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @hall-of-wisdom/hall-config run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hall-config/src/path-precheck.ts packages/hall-config/src/path-precheck.test.ts
git commit -m "feat(hall-config): best-effort path pre-check"
```

---

### Task 5: `run-cli.ts` / `cli.ts` / `index.ts` — the thin CLI + public entry point

**Files:**
- Create: `packages/hall-config/src/run-cli.ts`
- Create: `packages/hall-config/src/cli.ts`
- Create: `packages/hall-config/src/index.ts`
- Test: `packages/hall-config/src/run-cli.test.ts`

**Interfaces:**
- Consumes: `tryLoadConfig`/`saveConfig` (Task 3), `parseHallConfig`/`HallConfigValidationError`/`UnsupportedHallConfigSchemaVersionError`/`type HallConfig` (Task 1), `resolveHallConfigFilePath` (Task 2), `precheckHallOwnedPath`/`HallConfigPathPrecheckError` (Task 4).
- Produces: `interface CliIo { stdin: string; writeStdout(text: string): void }`, `runCli(argv: readonly string[], io: CliIo): number` — the process-free, directly-testable core. `cli.ts` is the thin `process.argv`/stdin/stdout wrapper `install.ps1` actually invokes (`node dist/cli.js status|validate|save [--path <path>]`).

JSON contracts (all responses are single-line JSON on stdout):
- `status`: `{"exists": boolean, "path": string, "config": HallConfig | null, "error": string | null}`, always exit 0.
- `validate` (reads candidate `HallConfig` JSON from stdin): `{"valid": true, "errors": []}` exit 0, or `{"valid": false, "errors": string[]}` exit 1.
- `save` (reads candidate `HallConfig` JSON from stdin): `{"saved": true, "path": string}` exit 0, or `{"saved": false, "errors": string[]}` exit 1. Never partially writes (delegates to `saveConfig`'s atomic write).

- [ ] **Step 1: Write the failing test**

`packages/hall-config/src/run-cli.test.ts`:
```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./run-cli.js";
import { saveConfig } from "./config-store.js";

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hall-config-cli-test-"));
  configPath = path.join(tmpDir, "config.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function captureStdout() {
  const lines: string[] = [];
  return { lines, writeStdout: (text: string) => lines.push(text) };
}

const VALID_CANDIDATE = {
  schemaVersion: 1,
  workspaceRoot: "D:\\HallOfWisdom",
  comparisonRoot: null,
  hallCorePort: 4310,
  hallWebPort: 3000,
  codexTrustedLocal: false,
};

describe("runCli status", () => {
  it("reports exists:false when no config file is present", () => {
    const out = captureStdout();
    const code = runCli(["status", "--path", configPath], { stdin: "", writeStdout: out.writeStdout });
    expect(code).toBe(0);
    expect(JSON.parse(out.lines[0] as string)).toEqual({
      exists: false,
      path: configPath,
      config: null,
      error: null,
    });
  });

  it("reports the loaded config when present", () => {
    saveConfig(VALID_CANDIDATE as never, configPath);
    const out = captureStdout();
    const code = runCli(["status", "--path", configPath], { stdin: "", writeStdout: out.writeStdout });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.lines[0] as string);
    expect(parsed.exists).toBe(true);
    expect(parsed.config.workspaceRoot).toBe("D:\\HallOfWisdom");
  });

  it("reports a non-null error (still exit 0) for a malformed existing file, never crashing install.ps1's status check", () => {
    fs.writeFileSync(configPath, "{ not json", "utf8");
    const out = captureStdout();
    const code = runCli(["status", "--path", configPath], { stdin: "", writeStdout: out.writeStdout });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.lines[0] as string);
    expect(parsed.error).not.toBeNull();
  });
});

describe("runCli validate", () => {
  it("reports valid:true for a well-formed candidate", () => {
    const out = captureStdout();
    const code = runCli(["validate", "--path", configPath], {
      stdin: JSON.stringify(VALID_CANDIDATE),
      writeStdout: out.writeStdout,
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.lines[0] as string)).toEqual({ valid: true, errors: [] });
  });

  it("reports valid:false and exit 1 for malformed stdin JSON", () => {
    const out = captureStdout();
    const code = runCli(["validate", "--path", configPath], { stdin: "{ not json", writeStdout: out.writeStdout });
    expect(code).toBe(1);
    const parsed = JSON.parse(out.lines[0] as string);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it("reports valid:false for a schema-invalid candidate", () => {
    const out = captureStdout();
    const code = runCli(["validate", "--path", configPath], {
      stdin: JSON.stringify({ ...VALID_CANDIDATE, workspaceRoot: undefined }),
      writeStdout: out.writeStdout,
    });
    expect(code).toBe(1);
  });

  it("reports valid:false for a relative workspaceRoot (path pre-check)", () => {
    const out = captureStdout();
    const code = runCli(["validate", "--path", configPath], {
      stdin: JSON.stringify({ ...VALID_CANDIDATE, workspaceRoot: "relative\\path" }),
      writeStdout: out.writeStdout,
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(out.lines[0] as string);
    expect(parsed.errors[0]).toMatch(/workspaceRoot/);
  });

  it("never writes a file", () => {
    runCli(["validate", "--path", configPath], { stdin: JSON.stringify(VALID_CANDIDATE), writeStdout: () => {} });
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

describe("runCli save", () => {
  it("saves a valid candidate and reports saved:true", () => {
    const out = captureStdout();
    const code = runCli(["save", "--path", configPath], {
      stdin: JSON.stringify(VALID_CANDIDATE),
      writeStdout: out.writeStdout,
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.lines[0] as string)).toEqual({ saved: true, path: configPath });
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it("does not save an invalid candidate", () => {
    const out = captureStdout();
    const code = runCli(["save", "--path", configPath], {
      stdin: JSON.stringify({ ...VALID_CANDIDATE, workspaceRoot: "relative" }),
      writeStdout: out.writeStdout,
    });
    expect(code).toBe(1);
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

describe("runCli unknown command", () => {
  it("reports an error and exit 1", () => {
    const out = captureStdout();
    const code = runCli(["not-a-command"], { stdin: "", writeStdout: out.writeStdout });
    expect(code).toBe(1);
    expect(JSON.parse(out.lines[0] as string).error).toMatch(/Unknown command/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @hall-of-wisdom/hall-config run test`
Expected: FAIL with "Cannot find module './run-cli.js'".

- [ ] **Step 3: Write `src/run-cli.ts`**

```typescript
import { saveConfig, tryLoadConfig } from "./config-store.js";
import { resolveHallConfigFilePath } from "./config-path.js";
import {
  HallConfigValidationError,
  UnsupportedHallConfigSchemaVersionError,
  parseHallConfig,
  type HallConfig,
} from "./schema.js";
import { HallConfigPathPrecheckError, precheckHallOwnedPath } from "./path-precheck.js";

export interface CliIo {
  readonly stdin: string;
  writeStdout(text: string): void;
}

function precheckAllPaths(config: HallConfig): string[] {
  const errors: string[] = [];
  const checks: ReadonlyArray<readonly [string, string | undefined | null]> = [
    ["workspaceRoot", config.workspaceRoot],
    ["dataDir", config.dataDir],
    ["agentWorktreeRoot", config.agentWorktreeRoot],
    ["comparisonRoot", config.comparisonRoot],
  ];
  for (const [label, value] of checks) {
    if (value === undefined || value === null) continue;
    try {
      precheckHallOwnedPath(value, label);
    } catch (error) {
      errors.push(error instanceof HallConfigPathPrecheckError ? error.message : String(error));
    }
  }
  return errors;
}

function extractPathFlag(rest: readonly string[]): string | undefined {
  const index = rest.indexOf("--path");
  return index === -1 ? undefined : rest[index + 1];
}

/** Process-free CLI core, directly unit-testable. `cli.ts` is the thin process wrapper around this. */
export function runCli(argv: readonly string[], io: CliIo): number {
  const [command, ...rest] = argv;
  const configPath = extractPathFlag(rest) ?? resolveHallConfigFilePath();

  if (command === "status") {
    try {
      const loaded = tryLoadConfig(configPath);
      io.writeStdout(
        JSON.stringify({
          exists: loaded !== undefined,
          path: configPath,
          config: loaded?.config ?? null,
          error: null,
        }),
      );
    } catch (error) {
      io.writeStdout(
        JSON.stringify({
          exists: true,
          path: configPath,
          config: null,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return 0;
  }

  if (command === "validate" || command === "save") {
    let candidate: HallConfig;
    try {
      candidate = parseHallConfig(JSON.parse(io.stdin));
    } catch (error) {
      const message =
        error instanceof HallConfigValidationError || error instanceof UnsupportedHallConfigSchemaVersionError
          ? error.message
          : `stdin was not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
      io.writeStdout(JSON.stringify({ valid: false, saved: false, errors: [message] }));
      return 1;
    }

    const pathErrors = precheckAllPaths(candidate);
    if (pathErrors.length > 0) {
      io.writeStdout(JSON.stringify({ valid: false, saved: false, errors: pathErrors }));
      return 1;
    }

    if (command === "validate") {
      io.writeStdout(JSON.stringify({ valid: true, errors: [] }));
      return 0;
    }

    try {
      saveConfig(candidate, configPath);
    } catch (error) {
      io.writeStdout(
        JSON.stringify({ saved: false, errors: [error instanceof Error ? error.message : String(error)] }),
      );
      return 1;
    }
    io.writeStdout(JSON.stringify({ saved: true, path: configPath }));
    return 0;
  }

  io.writeStdout(
    JSON.stringify({ error: `Unknown command "${String(command)}". Expected status, validate, or save.` }),
  );
  return 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @hall-of-wisdom/hall-config run test`
Expected: PASS.

- [ ] **Step 5: Write `src/cli.ts` (thin process wrapper — not directly unit-tested, exercised end-to-end in Task 16)**

```typescript
#!/usr/bin/env node
import fs from "node:fs";
import { runCli } from "./run-cli.js";

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const command = process.argv[2];
const needsStdin = command === "validate" || command === "save";

const exitCode = runCli(process.argv.slice(2), {
  stdin: needsStdin ? readStdinSync() : "",
  writeStdout: (text) => {
    process.stdout.write(`${text}\n`);
  },
});
process.exitCode = exitCode;
```

- [ ] **Step 6: Write `src/index.ts` (public entry point)**

```typescript
export {
  HALL_CONFIG_SCHEMA_VERSION,
  DEFAULT_HALL_CORE_PORT,
  DEFAULT_HALL_WEB_PORT,
  HallConfigSchema,
  HallConfigValidationError,
  UnsupportedHallConfigSchemaVersionError,
  parseHallConfig,
  type HallConfig,
} from "./schema.js";
export {
  HALL_CONFIG_DIR_ENV_OVERRIDE,
  HALL_CONFIG_FILE_NAME,
  resolveHallConfigDir,
  resolveHallConfigFilePath,
} from "./config-path.js";
export {
  HallConfigNotFoundError,
  loadConfig,
  saveConfig,
  tryLoadConfig,
  type LoadedHallConfig,
} from "./config-store.js";
export { HallConfigPathPrecheckError, precheckHallOwnedPath } from "./path-precheck.js";
```

- [ ] **Step 7: Typecheck, build, verify package entry**

Run: `pnpm --filter @hall-of-wisdom/hall-config run typecheck && pnpm --filter @hall-of-wisdom/hall-config run build && pnpm --filter @hall-of-wisdom/hall-config run verify:package-entry`
Expected: all three succeed; `verify-package-entry.mjs` (Task 1) prints the OK line.

- [ ] **Step 8: Commit**

```bash
git add packages/hall-config/src/run-cli.ts packages/hall-config/src/run-cli.test.ts packages/hall-config/src/cli.ts packages/hall-config/src/index.ts
git commit -m "feat(hall-config): thin status/validate/save CLI and public entry point"
```

---

### Task 6: Split `server-cli-args.ts` into CLI overrides (optional `workspaceRoot`) + `--verify-only`

**Files:**
- Modify: `apps/server/src/config/server-cli-args.ts` (full rewrite of the schema/type/parse function; `ServerCliError` and `stripLeadingScriptSeparator` are unchanged)
- Modify: `apps/server/src/config/server-cli-args.test.ts`
- Modify: `apps/server/package.json` (add `@hall-of-wisdom/hall-config` as a dependency — needed by Task 7, add it now so this task's branch typechecks against the next one cleanly)

**Interfaces:**
- Produces: `type ServerCliOverrides` (renamed from `ServerCliOptions` — **every field now optional**, including `workspaceRoot` and `webOrigin`; `verifyOnly: boolean` new, defaulted `false`), `serverCliOverridesSchema` (renamed from `serverCliOptionsSchema`), `parseServerCliArguments(argv): ServerCliOverrides`, `ServerCliError` (unchanged), `stripLeadingScriptSeparator` (unchanged).
- Breaking rename: any other file importing `ServerCliOptions`/`serverCliOptionsSchema` must be updated in the same commit — grep for both names across `apps/server/src` before finishing this task.

Why `webOrigin` and `enableCodexTrustedLocal` lose their `.default(...)` here: Task 7's per-field CLI-over-persisted-over-builtin-default precedence needs to distinguish "flag not supplied" (`undefined`) from "flag supplied with this value" — a schema-level default would collapse that distinction before precedence ever runs. The *actual* default values move to Task 7's `resolveServerConfig`.

- [ ] **Step 1: Update the test file first (TDD — these tests define the new contract)**

Replace `apps/server/src/config/server-cli-args.test.ts` in full with:
```typescript
import { describe, expect, it } from "vitest";
import {
  parseServerCliArguments,
  ServerCliError,
  stripLeadingScriptSeparator,
} from "./server-cli-args.js";

describe("parseServerCliArguments", () => {
  it("parses a minimal command with no flags at all — workspaceRoot is optional here", () => {
    const options = parseServerCliArguments([]);
    expect(options.workspaceRoot).toBeUndefined();
    expect(options.port).toBeUndefined();
    expect(options.verifyOnly).toBe(false);
  });

  it("parses --workspace-root when supplied", () => {
    const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
    expect(options.workspaceRoot).toBe("D:\\HallOfWisdom");
  });

  it("parses port, mock-scenario, and mock-step-delay-ms", () => {
    const options = parseServerCliArguments([
      "--workspace-root",
      "D:\\HallOfWisdom",
      "--port",
      "5000",
      "--mock-scenario",
      "failure",
      "--mock-step-delay-ms",
      "10",
    ]);
    expect(options.port).toBe(5000);
    expect(options.mockScenario).toBe("failure");
    expect(options.mockStepDelayMs).toBe(10);
  });

  it("rejects an out-of-range port", () => {
    expect(() =>
      parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom", "--port", "99999"]),
    ).toThrow(ServerCliError);
  });

  it("rejects a non-numeric port", () => {
    expect(() =>
      parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom", "--port", "not-a-number"]),
    ).toThrow(ServerCliError);
  });

  it("rejects an unknown argument", () => {
    expect(() =>
      parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom", "--not-a-real-flag"]),
    ).toThrow(ServerCliError);
  });

  it("leaves webOrigin undefined when --web-origin is omitted (defaulting/derivation now happens in resolve-server-config.ts)", () => {
    const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
    expect(options.webOrigin).toBeUndefined();
  });

  it("parses and normalizes a valid --web-origin", () => {
    const options = parseServerCliArguments([
      "--workspace-root",
      "D:\\HallOfWisdom",
      "--web-origin",
      "http://127.0.0.1:5173/",
    ]);
    expect(options.webOrigin).toBe("http://127.0.0.1:5173");
  });

  it("rejects an invalid --web-origin", () => {
    expect(() =>
      parseServerCliArguments([
        "--workspace-root",
        "D:\\HallOfWisdom",
        "--web-origin",
        "not a url",
      ]),
    ).toThrow(ServerCliError);
  });

  describe("--enable-codex-trusted-local (Phase 10.2)", () => {
    it("is undefined when omitted (defaulting to false now happens in resolve-server-config.ts)", () => {
      const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
      expect(options.enableCodexTrustedLocal).toBeUndefined();
    });

    it("parses --enable-codex-trusted-local as true", () => {
      const options = parseServerCliArguments([
        "--workspace-root",
        "D:\\HallOfWisdom",
        "--enable-codex-trusted-local",
      ]);
      expect(options.enableCodexTrustedLocal).toBe(true);
    });
  });

  describe("--comparison-root (Phase 12)", () => {
    it("is undefined when omitted", () => {
      const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
      expect(options.comparisonRoot).toBeUndefined();
    });

    it("parses --comparison-root when supplied", () => {
      const options = parseServerCliArguments([
        "--workspace-root",
        "D:\\HallOfWisdom",
        "--comparison-root",
        "D:\\HallOfWisdomComparisons",
      ]);
      expect(options.comparisonRoot).toBe("D:\\HallOfWisdomComparisons");
    });
  });

  describe("--data-dir (Phase 13)", () => {
    it("is undefined when omitted", () => {
      const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
      expect(options.dataDir).toBeUndefined();
    });

    it("parses --data-dir when supplied", () => {
      const options = parseServerCliArguments([
        "--workspace-root",
        "D:\\HallOfWisdom",
        "--data-dir",
        "D:\\HallOfWisdomData",
      ]);
      expect(options.dataDir).toBe("D:\\HallOfWisdomData");
    });
  });

  describe("--agent-worktree-root (Phase 16.4)", () => {
    it("is undefined when omitted", () => {
      const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
      expect(options.agentWorktreeRoot).toBeUndefined();
    });

    it("parses --agent-worktree-root when supplied", () => {
      const options = parseServerCliArguments([
        "--workspace-root",
        "D:\\HallOfWisdom",
        "--data-dir",
        "D:\\HallOfWisdomData",
        "--agent-worktree-root",
        "D:\\HallOfWisdomAgentWorktrees",
      ]);
      expect(options.agentWorktreeRoot).toBe("D:\\HallOfWisdomAgentWorktrees");
    });
  });

  describe("--verify-only (Phase 17.1)", () => {
    it("defaults to false when omitted", () => {
      const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
      expect(options.verifyOnly).toBe(false);
    });

    it("parses --verify-only as true", () => {
      const options = parseServerCliArguments(["--verify-only"]);
      expect(options.verifyOnly).toBe(true);
    });

    it("--verify-only does not require --workspace-root at the parse stage", () => {
      expect(() => parseServerCliArguments(["--verify-only"])).not.toThrow();
    });
  });

  describe("stripLeadingScriptSeparator (Phase 11.1)", () => {
    it("leaves argv without a leading separator untouched (direct node invocation)", () => {
      expect(stripLeadingScriptSeparator(["--workspace-root", "D:\\HallOfWisdom"])).toEqual([
        "--workspace-root",
        "D:\\HallOfWisdom",
      ]);
    });

    it("strips a single leading standalone separator", () => {
      expect(stripLeadingScriptSeparator(["--", "--workspace-root", "D:\\HallOfWisdom"])).toEqual([
        "--workspace-root",
        "D:\\HallOfWisdom",
      ]);
    });

    it("strips only one leading separator, leaving a second one for parseArgs to reject", () => {
      expect(
        stripLeadingScriptSeparator(["--", "--", "--workspace-root", "D:\\HallOfWisdom"]),
      ).toEqual(["--", "--workspace-root", "D:\\HallOfWisdom"]);
    });

    it("does not strip a separator that is not the first token", () => {
      expect(stripLeadingScriptSeparator(["--workspace-root", "--", "D:\\HallOfWisdom"])).toEqual([
        "--workspace-root",
        "--",
        "D:\\HallOfWisdom",
      ]);
    });

    it("does not alter a value containing two hyphens", () => {
      expect(stripLeadingScriptSeparator(["--workspace-root", "D:\\Foo--Bar"])).toEqual([
        "--workspace-root",
        "D:\\Foo--Bar",
      ]);
    });

    it("returns an empty array unchanged", () => {
      expect(stripLeadingScriptSeparator([])).toEqual([]);
    });
  });

  describe("pnpm '--' script-separator forwarding (Phase 11.1)", () => {
    it("parses direct argv with no separator (baseline)", () => {
      const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
      expect(options.workspaceRoot).toBe("D:\\HallOfWisdom");
    });

    it("parses correctly with a leading standalone separator", () => {
      const options = parseServerCliArguments(["--", "--workspace-root", "D:\\HallOfWisdom"]);
      expect(options.workspaceRoot).toBe("D:\\HallOfWisdom");
    });

    it("parses --port after the separator", () => {
      const options = parseServerCliArguments([
        "--",
        "--workspace-root",
        "D:\\HallOfWisdom",
        "--port",
        "4310",
      ]);
      expect(options.port).toBe(4310);
    });

    it("still rejects a genuinely unexpected positional argument", () => {
      expect(() =>
        parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom", "unexpected-positional"]),
      ).toThrow(ServerCliError);
    });

    it("still rejects when more than one leading separator is present", () => {
      expect(() =>
        parseServerCliArguments(["--", "--", "--workspace-root", "D:\\HallOfWisdom"]),
      ).toThrow(ServerCliError);
    });

    it("still rejects an unknown flag after the separator, exactly like without one", () => {
      expect(() =>
        parseServerCliArguments([
          "--",
          "--workspace-root",
          "D:\\HallOfWisdom",
          "--not-a-real-flag",
        ]),
      ).toThrow(ServerCliError);
    });

    it("parses the exact argv pnpm forwards for the README's documented Hall Core startup command", () => {
      const options = parseServerCliArguments([
        "--",
        "--workspace-root",
        "D:\\HallOfWisdom",
        "--port",
        "4310",
        "--mock-scenario",
        "success",
        "--web-origin",
        "http://127.0.0.1:3000",
      ]);
      expect(options).toEqual({
        workspaceRoot: "D:\\HallOfWisdom",
        port: 4310,
        mockScenario: "success",
        webOrigin: "http://127.0.0.1:3000",
        verifyOnly: false,
      });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @hall-of-wisdom/hall-core run test -- server-cli-args`
Expected: FAIL (current implementation still requires `workspaceRoot`, defaults `webOrigin`/`enableCodexTrustedLocal`, has no `--verify-only`).

- [ ] **Step 3: Rewrite `apps/server/src/config/server-cli-args.ts`**

```typescript
import { parseArgs } from "node:util";
import { z } from "zod";
import { boundedNonBlankString } from "@hall-of-wisdom/protocol";
import { InvalidWebOriginError, parseWebOrigin } from "./web-origin.js";

export class ServerCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerCliError";
  }
}

/**
 * Raw command-line overrides only — every field optional, including
 * `workspaceRoot`. Hall must be able to start from a persisted
 * `@hall-of-wisdom/hall-config` configuration alone, with zero flags; the
 * "workspaceRoot is actually required" rule is enforced one step later, on
 * the *merged* result, by `resolve-server-config.ts`'s
 * `resolvedServerConfigSchema`. This split is what lets an explicit CLI
 * flag win per-field over persisted config without a schema-level default
 * masking "not supplied" as "supplied with the default value."
 */
const serverCliOverridesSchema = z
  .object({
    workspaceRoot: boundedNonBlankString(4096).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    mockScenario: boundedNonBlankString(50).optional(),
    mockStepDelayMs: z.number().int().min(0).max(5000).optional(),
    webOrigin: boundedNonBlankString(2048).optional(),
    enableCodexTrustedLocal: z.boolean().optional(),
    comparisonRoot: boundedNonBlankString(4096).optional(),
    dataDir: boundedNonBlankString(4096).optional(),
    agentWorktreeRoot: boundedNonBlankString(4096).optional(),
    // Phase 17.1 — a side-effect-minimized configuration preflight. No
    // corresponding persisted-config field: it is a pure CLI-only mode
    // switch, so a schema default (rather than `.optional()`) is correct
    // here — there is no other source to defer to.
    verifyOnly: z.boolean().default(false),
  })
  .strict();

export type ServerCliOverrides = z.infer<typeof serverCliOverridesSchema>;

function parseOptionalInteger(raw: unknown, flagName: string): number | undefined {
  if (raw === undefined) return undefined;
  const rawText = typeof raw === "string" ? raw : JSON.stringify(raw);
  const parsed = Number(rawText);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ServerCliError(`--${flagName} must be an integer, got "${rawText}"`);
  }
  return parsed;
}

function parseOptionalWebOrigin(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const rawText = typeof raw === "string" ? raw : JSON.stringify(raw);
  try {
    return parseWebOrigin(rawText);
  } catch (error) {
    if (error instanceof InvalidWebOriginError) {
      throw new ServerCliError(error.message);
    }
    throw error;
  }
}

/**
 * Strips exactly one leading standalone `--` from `argv`, if present — see
 * the historical note in git blame / Phase 11.1: pnpm 10.33.0's `run
 * <script> -- <args>` forwards the literal `--` separator token itself as
 * the first argument, which Node's `parseArgs` would otherwise treat as
 * "end of options."
 */
export function stripLeadingScriptSeparator(argv: readonly string[]): string[] {
  const args = Array.from(argv);
  return args[0] === "--" ? args.slice(1) : args;
}

/**
 * Parses and bounds-validates raw `argv` using `node:util`'s built-in
 * `parseArgs`. Produces `ServerCliOverrides` — raw, optional-everywhere
 * overrides; see that type's doc comment for why `workspaceRoot` is
 * optional here.
 */
export function parseServerCliArguments(argv: readonly string[]): ServerCliOverrides {
  let raw: ReturnType<typeof parseArgs>;
  try {
    raw = parseArgs({
      args: stripLeadingScriptSeparator(argv),
      options: {
        "workspace-root": { type: "string" },
        port: { type: "string" },
        "mock-scenario": { type: "string" },
        "mock-step-delay-ms": { type: "string" },
        "web-origin": { type: "string" },
        "enable-codex-trusted-local": { type: "boolean" },
        "comparison-root": { type: "string" },
        "data-dir": { type: "string" },
        "agent-worktree-root": { type: "string" },
        "verify-only": { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    throw new ServerCliError(
      error instanceof Error ? error.message : "failed to parse command-line arguments",
    );
  }

  const { values } = raw;

  const webOrigin = parseOptionalWebOrigin(values["web-origin"]);
  const candidate = {
    ...(values["workspace-root"] === undefined ? {} : { workspaceRoot: values["workspace-root"] }),
    port: parseOptionalInteger(values.port, "port"),
    mockScenario: values["mock-scenario"],
    mockStepDelayMs: parseOptionalInteger(values["mock-step-delay-ms"], "mock-step-delay-ms"),
    ...(webOrigin === undefined ? {} : { webOrigin }),
    ...(values["enable-codex-trusted-local"] === undefined
      ? {}
      : { enableCodexTrustedLocal: values["enable-codex-trusted-local"] }),
    ...(values["comparison-root"] === undefined ? {} : { comparisonRoot: values["comparison-root"] }),
    ...(values["data-dir"] === undefined ? {} : { dataDir: values["data-dir"] }),
    ...(values["agent-worktree-root"] === undefined
      ? {}
      : { agentWorktreeRoot: values["agent-worktree-root"] }),
    ...(values["verify-only"] === undefined ? {} : { verifyOnly: values["verify-only"] }),
  };

  const result = serverCliOverridesSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ServerCliError(`Invalid command-line arguments: ${issues}`);
  }
  return result.data;
}
```

- [ ] **Step 4: Grep for other usages of the renamed exports**

Run: `grep -rn "ServerCliOptions\|serverCliOptionsSchema" apps/server/src apps/e2e/src 2>/dev/null` (or the `Grep` tool). Every match outside `server-cli-args.ts`/`server-cli-args.test.ts` must be updated to `ServerCliOverrides` in this same commit — expected hit: `apps/server/src/server.ts` (updated in Task 8, not here — leave a one-line note in this task's commit message if `server.ts` still references the old name, since Task 8 fixes it next).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @hall-of-wisdom/hall-core run test -- server-cli-args`
Expected: PASS. (`server.ts` itself will fail to typecheck until Task 8 — that's expected and fixed there; do not run the full `typecheck` gate until Task 8 lands.)

- [ ] **Step 6: Add the `@hall-of-wisdom/hall-config` dependency**

In `apps/server/package.json`, add to `"dependencies"`:
```json
"@hall-of-wisdom/hall-config": "workspace:*",
```
(insert alphabetically among the existing `@hall-of-wisdom/*` deps). Run `pnpm install` to link it.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/config/server-cli-args.ts apps/server/src/config/server-cli-args.test.ts apps/server/package.json pnpm-lock.yaml
git commit -m "refactor(hall-core): split CLI parsing into optional overrides, add --verify-only"
```

---

### Task 7: `resolve-server-config.ts` — CLI/persisted-config precedence + `webOrigin` derivation

**Files:**
- Create: `apps/server/src/config/resolve-server-config.ts`
- Test: `apps/server/src/config/resolve-server-config.test.ts`

**Interfaces:**
- Consumes: `type ServerCliOverrides` (Task 6), `type HallConfig`/`DEFAULT_HALL_WEB_PORT` from `@hall-of-wisdom/hall-config` (Tasks 1, 6), `DEFAULT_PORT` from `./server-config.js` (existing), `parseWebOrigin`/`InvalidWebOriginError` from `./web-origin.js` (existing), `ServerCliError` (Task 6).
- Produces: `type ResolvedServerConfig`, `resolveServerConfig(overrides: ServerCliOverrides, persisted: HallConfig | undefined): ResolvedServerConfig`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/config/resolve-server-config.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import type { HallConfig } from "@hall-of-wisdom/hall-config";
import { resolveServerConfig } from "./resolve-server-config.js";
import { ServerCliError } from "./server-cli-args.js";
import type { ServerCliOverrides } from "./server-cli-args.js";

const NO_OVERRIDES: ServerCliOverrides = { verifyOnly: false } as ServerCliOverrides;

const PERSISTED: HallConfig = {
  schemaVersion: 1,
  workspaceRoot: "D:\\PersistedWorkspace",
  comparisonRoot: null,
  hallCorePort: 4400,
  hallWebPort: 3300,
  codexTrustedLocal: false,
};

describe("resolveServerConfig — workspaceRoot precedence", () => {
  it("throws ServerCliError when neither CLI nor persisted config supplies workspaceRoot", () => {
    expect(() => resolveServerConfig(NO_OVERRIDES, undefined)).toThrow(ServerCliError);
  });

  it("uses persisted workspaceRoot when CLI omits it", () => {
    const resolved = resolveServerConfig(NO_OVERRIDES, PERSISTED);
    expect(resolved.workspaceRoot).toBe("D:\\PersistedWorkspace");
  });

  it("CLI workspaceRoot wins over persisted", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\CliWorkspace" },
      PERSISTED,
    );
    expect(resolved.workspaceRoot).toBe("D:\\CliWorkspace");
  });
});

describe("resolveServerConfig — port precedence", () => {
  it("falls back to the built-in DEFAULT_PORT when neither source supplies it", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W" },
      undefined,
    );
    expect(resolved.port).toBe(4310);
  });

  it("uses persisted hallCorePort when CLI omits --port", () => {
    const resolved = resolveServerConfig({ ...NO_OVERRIDES, workspaceRoot: "D:\\W" }, PERSISTED);
    expect(resolved.port).toBe(4400);
  });

  it("CLI --port wins over persisted hallCorePort", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W", port: 9999 },
      PERSISTED,
    );
    expect(resolved.port).toBe(9999);
  });
});

describe("resolveServerConfig — webOrigin derivation from hallWebPort", () => {
  it("defaults to http://127.0.0.1:3000 when nothing supplies webOrigin or hallWebPort", () => {
    const resolved = resolveServerConfig({ ...NO_OVERRIDES, workspaceRoot: "D:\\W" }, undefined);
    expect(resolved.webOrigin).toBe("http://127.0.0.1:3000");
  });

  it("derives webOrigin from persisted hallWebPort when --web-origin is omitted", () => {
    const resolved = resolveServerConfig({ ...NO_OVERRIDES, workspaceRoot: "D:\\W" }, PERSISTED);
    expect(resolved.webOrigin).toBe("http://127.0.0.1:3300");
  });

  it("explicit --web-origin always wins, even over a persisted hallWebPort", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W", webOrigin: "http://127.0.0.1:6000" },
      PERSISTED,
    );
    expect(resolved.webOrigin).toBe("http://127.0.0.1:6000");
  });

  it("a persisted hallWebPort change can never silently create a CORS mismatch (documentation-as-test)", () => {
    const changedPortConfig: HallConfig = { ...PERSISTED, hallWebPort: 4444 };
    const resolved = resolveServerConfig({ ...NO_OVERRIDES, workspaceRoot: "D:\\W" }, changedPortConfig);
    expect(resolved.webOrigin).toBe("http://127.0.0.1:4444");
  });
});

describe("resolveServerConfig — enableCodexTrustedLocal precedence", () => {
  it("defaults to false when neither source supplies it", () => {
    const resolved = resolveServerConfig({ ...NO_OVERRIDES, workspaceRoot: "D:\\W" }, undefined);
    expect(resolved.enableCodexTrustedLocal).toBe(false);
  });

  it("uses persisted codexTrustedLocal when CLI omits the flag", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W" },
      { ...PERSISTED, codexTrustedLocal: true },
    );
    expect(resolved.enableCodexTrustedLocal).toBe(true);
  });

  it("CLI --enable-codex-trusted-local wins over a persisted false", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W", enableCodexTrustedLocal: true },
      { ...PERSISTED, codexTrustedLocal: false },
    );
    expect(resolved.enableCodexTrustedLocal).toBe(true);
  });
});

describe("resolveServerConfig — comparisonRoot", () => {
  it("is undefined when persisted comparisonRoot is null and CLI omits it", () => {
    const resolved = resolveServerConfig({ ...NO_OVERRIDES, workspaceRoot: "D:\\W" }, PERSISTED);
    expect(resolved.comparisonRoot).toBeUndefined();
  });

  it("uses a persisted non-null comparisonRoot when CLI omits it", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W" },
      { ...PERSISTED, comparisonRoot: "D:\\PersistedComparisons" },
    );
    expect(resolved.comparisonRoot).toBe("D:\\PersistedComparisons");
  });

  it("CLI --comparison-root wins over a persisted value", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W", comparisonRoot: "D:\\CliComparisons" },
      { ...PERSISTED, comparisonRoot: "D:\\PersistedComparisons" },
    );
    expect(resolved.comparisonRoot).toBe("D:\\CliComparisons");
  });
});

describe("resolveServerConfig — dataDir / agentWorktreeRoot / mock fields", () => {
  it("dataDir and agentWorktreeRoot stay undefined in ephemeral mode with no persisted config (existing dev startup unaffected)", () => {
    const resolved = resolveServerConfig({ ...NO_OVERRIDES, workspaceRoot: "D:\\W" }, undefined);
    expect(resolved.dataDir).toBeUndefined();
    expect(resolved.agentWorktreeRoot).toBeUndefined();
  });

  it("mockScenario/mockStepDelayMs come from CLI only, never from persisted config", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W", mockScenario: "success", mockStepDelayMs: 5 },
      PERSISTED,
    );
    expect(resolved.mockScenario).toBe("success");
    expect(resolved.mockStepDelayMs).toBe(5);
  });
});

describe("resolveServerConfig — verifyOnly passthrough", () => {
  it("carries verifyOnly through unchanged", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W", verifyOnly: true },
      undefined,
    );
    expect(resolved.verifyOnly).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @hall-of-wisdom/hall-core run test -- resolve-server-config`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Write `apps/server/src/config/resolve-server-config.ts`**

```typescript
import { z } from "zod";
import { boundedNonBlankString } from "@hall-of-wisdom/protocol";
import { DEFAULT_HALL_WEB_PORT, type HallConfig } from "@hall-of-wisdom/hall-config";
import { DEFAULT_PORT } from "./server-config.js";
import { InvalidWebOriginError, parseWebOrigin } from "./web-origin.js";
import { ServerCliError, type ServerCliOverrides } from "./server-cli-args.js";

const resolvedServerConfigSchema = z
  .object({
    workspaceRoot: boundedNonBlankString(4096),
    port: z.number().int().min(1).max(65535),
    webOrigin: boundedNonBlankString(2048),
    mockScenario: boundedNonBlankString(50).optional(),
    mockStepDelayMs: z.number().int().min(0).max(5000).optional(),
    enableCodexTrustedLocal: z.boolean(),
    comparisonRoot: boundedNonBlankString(4096).optional(),
    dataDir: boundedNonBlankString(4096).optional(),
    agentWorktreeRoot: boundedNonBlankString(4096).optional(),
    verifyOnly: z.boolean(),
  })
  .strict();

export type ResolvedServerConfig = z.infer<typeof resolvedServerConfigSchema>;

/**
 * Per-field precedence: an explicitly supplied CLI override always wins;
 * otherwise the persisted Hall configuration's value; otherwise the
 * existing built-in default. `workspaceRoot` has no built-in default — if
 * neither source supplies it, this throws `ServerCliError`, exactly like
 * the previous "missing --workspace-root" behavior did, just one step
 * later (`--workspace-root` is optional at the raw-CLI-parsing stage now,
 * so Hall can start from persisted config alone).
 *
 * `webOrigin`: an explicit `--web-origin` always wins. Otherwise it is
 * *derived* from the resolved `hallWebPort`
 * (`http://127.0.0.1:<hallWebPort>`) — never a flat stored default — so a
 * persisted `hallWebPort` change can never silently create a
 * CORS/WebSocket-origin mismatch against Hall Core's own allowlist.
 */
export function resolveServerConfig(
  overrides: ServerCliOverrides,
  persisted: HallConfig | undefined,
): ResolvedServerConfig {
  const workspaceRoot = overrides.workspaceRoot ?? persisted?.workspaceRoot;
  if (workspaceRoot === undefined) {
    throw new ServerCliError(
      "--workspace-root was not supplied and no persisted Hall configuration was found. Run install.ps1, or pass --workspace-root explicitly.",
    );
  }

  const port = overrides.port ?? persisted?.hallCorePort ?? DEFAULT_PORT;

  let webOrigin: string;
  if (overrides.webOrigin !== undefined) {
    webOrigin = overrides.webOrigin;
  } else {
    const hallWebPort = persisted?.hallWebPort ?? DEFAULT_HALL_WEB_PORT;
    try {
      webOrigin = parseWebOrigin(`http://127.0.0.1:${String(hallWebPort)}`);
    } catch (error) {
      throw error instanceof InvalidWebOriginError ? new ServerCliError(error.message) : error;
    }
  }

  const enableCodexTrustedLocal = overrides.enableCodexTrustedLocal ?? persisted?.codexTrustedLocal ?? false;
  const dataDir = overrides.dataDir ?? persisted?.dataDir;
  const agentWorktreeRoot = overrides.agentWorktreeRoot ?? persisted?.agentWorktreeRoot;
  const persistedComparisonRoot = persisted?.comparisonRoot === null ? undefined : persisted?.comparisonRoot;
  const comparisonRoot = overrides.comparisonRoot ?? persistedComparisonRoot;

  const candidate = {
    workspaceRoot,
    port,
    webOrigin,
    enableCodexTrustedLocal,
    verifyOnly: overrides.verifyOnly,
    ...(overrides.mockScenario === undefined ? {} : { mockScenario: overrides.mockScenario }),
    ...(overrides.mockStepDelayMs === undefined ? {} : { mockStepDelayMs: overrides.mockStepDelayMs }),
    ...(comparisonRoot === undefined ? {} : { comparisonRoot }),
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(agentWorktreeRoot === undefined ? {} : { agentWorktreeRoot }),
  };

  const result = resolvedServerConfigSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ServerCliError(`Invalid resolved server configuration: ${issues}`);
  }
  return result.data;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @hall-of-wisdom/hall-core run test -- resolve-server-config`
Expected: PASS.

- [ ] **Step 5: Remove the now-dead `DEFAULT_WEB_ORIGIN` constant**

Grep: `grep -rn "DEFAULT_WEB_ORIGIN" apps/server/src`. After this task, the only remaining reference should be its own definition in `server-config.ts` (both `server-cli-args.ts`'s old `.default(DEFAULT_WEB_ORIGIN)` and `resolve-server-config.ts`'s new derivation no longer use it). Remove the `export const DEFAULT_WEB_ORIGIN = "http://127.0.0.1:3000";` line and its doc comment from `apps/server/src/config/server-config.ts`. If any other file still references it, leave it in place and note why in the commit message instead of removing it.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @hall-of-wisdom/hall-core run typecheck`
Expected: `server.ts` will still fail here (it references the old `cliOptions.workspaceRoot`/etc. shape and the removed `ServerCliOptions` name) — that's expected and fixed in Task 8. Confirm the *only* errors are in `server.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/config/resolve-server-config.ts apps/server/src/config/resolve-server-config.test.ts apps/server/src/config/server-config.ts
git commit -m "feat(hall-core): resolveServerConfig — CLI/persisted-config precedence, webOrigin derivation"
```

---

### Task 8: Wire `resolveServerConfig` into `server.ts`'s startup flow

**Files:**
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/server.test.ts` (add persisted-config precedence coverage; keep all existing tests passing)

**Interfaces:**
- Consumes: `parseServerCliArguments` (Task 6, now returns `ServerCliOverrides`), `resolveServerConfig`/`type ResolvedServerConfig` (Task 7), `tryLoadConfig` from `@hall-of-wisdom/hall-config` (Task 3).

This task does **not** touch `--verify-only` behavior yet (Task 9) — it only changes where `runServer()`'s values come from. Every existing Phase 13–16 code path (canonicalization order, `openDurableStorage`, `runRestartRecovery`, shutdown, ownership-fence monitor) is untouched.

- [ ] **Step 1: Update imports and the top of `runServer()`**

In `apps/server/src/server.ts`, change the import block (original lines 1–30):
```typescript
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { isContainedPath, validateWorkspace } from "@hall-of-wisdom/hall-runner";
import { tryLoadConfig } from "@hall-of-wisdom/hall-config";
import { createHallCoreApp } from "./app.js";
import { createServerComposition } from "./composition/server-composition.js";
import { parseServerCliArguments, ServerCliError } from "./config/server-cli-args.js";
import { resolveServerConfig } from "./config/resolve-server-config.js";
import {
  DATABASE_BUSY_TIMEOUT_MS,
  DEFAULT_LIMITS,
  LOCAL_ONLY_HOST,
  SHUTDOWN_TIMEOUT_MS,
} from "./config/server-config.js";
import { installShutdownSignals } from "./process/signal-shutdown.js";
import { HallDatabase, type OwnershipFence } from "./persistence/database.js";
import { resolveDataDir } from "./persistence/database-config.js";
import { PersistenceError } from "./persistence/persistence-errors.js";
import { recordCleanShutdown } from "./persistence/boot-repository.js";
import type { InstanceOwnershipHandle } from "./persistence/instance-ownership.js";
import { openDurableStorage } from "./persistence/durable-startup.js";
import {
  startOwnershipFenceMonitor,
  type OwnershipFenceMonitorHandle,
} from "./persistence/ownership-fence-monitor.js";
import { runRestartRecovery, type RecoverySummary } from "./recovery/restart-recovery.js";
import { reconcileAllPlanProgress } from "./ceo-plans/ceo-plan-progress-reconciliation.js";
import { runCeoPlanExecutionRecovery } from "./ceo-execution/ceo-plan-execution-recovery.js";
import { canonicalizeHallOwnedRoot } from "./agent-worktrees/path-safety.js";
import { AgentWorktreePathError } from "./agent-worktrees/agent-worktree-errors.js";
```
(Removed `DEFAULT_PORT` from the `server-config.js` import — it is no longer read directly here, only inside `resolveServerConfig`.)

Replace the start of `runServer()` (original lines 60–78: parsing through `workspaceRoot` validation) with:
```typescript
export async function runServer(argv: readonly string[]): Promise<number> {
  let overrides;
  try {
    overrides = parseServerCliArguments(argv);
  } catch (error) {
    console.error(formatError(error));
    return EXIT_INVALID_INPUT;
  }

  const persisted = tryLoadConfig()?.config;

  let cliOptions;
  try {
    cliOptions = resolveServerConfig(overrides, persisted);
  } catch (error) {
    console.error(formatError(error));
    return EXIT_INVALID_INPUT;
  }

  let workspaceRoot: string;
  try {
    workspaceRoot = validateWorkspace({
      workspaceRoot: cliOptions.workspaceRoot,
      workingDirectory: cliOptions.workspaceRoot,
    }).workspaceRoot;
  } catch (error) {
    console.error(formatError(error));
    return EXIT_INVALID_INPUT;
  }
```
Naming note: the local variable is deliberately still called `cliOptions` (now holding a `ResolvedServerConfig`, not a `ServerCliOverrides`) — every field name (`port`, `webOrigin`, `mockScenario`, `mockStepDelayMs`, `enableCodexTrustedLocal`, `comparisonRoot`, `dataDir`, `agentWorktreeRoot`) is identical between the old `ServerCliOptions` and the new `ResolvedServerConfig`, so every other `cliOptions.*` reference in the rest of this ~450-line function needs **no change at all**. This keeps the diff minimal and avoids touching the sensitive Phase 13–16 canonicalization/recovery/shutdown code in the rest of the function.

`tryLoadConfig()`'s own errors (malformed JSON, unsupported schema version) are **not** caught here — they propagate up to the top-level `.catch` in `isMainModule()`'s invocation (original lines 455–463), which already logs and sets `EXIT_INTERNAL_ERROR`. This is intentional: a corrupt persisted config is a real installation problem, not something normal startup should silently paper over by falling back to CLI-only.

- [ ] **Step 2: Confirm the rest of the function is unchanged**

Read through the rest of `runServer()` (original lines 79–447) and confirm every `cliOptions.workspaceRoot` besides the two already replaced above, `cliOptions.comparisonRoot`, `cliOptions.dataDir`, `cliOptions.agentWorktreeRoot`, `cliOptions.mockScenario`, `cliOptions.mockStepDelayMs`, `cliOptions.enableCodexTrustedLocal`, `cliOptions.webOrigin`, and `cliOptions.port` reads are untouched — they now read from the resolved config transparently. Do not rewrite any other line in this function for this task.

- [ ] **Step 3: Add persisted-config precedence tests to `server.test.ts`**

Read the existing `apps/server/src/server.test.ts` first to match its exact test-fixture conventions (temp workspace/data-dir creation helpers, `runServer` invocation style). Add a new `describe("persisted Hall configuration (Phase 17.1)", ...)` block with at least these cases, using the file's existing temp-directory fixture helpers and `HALL_CONFIG_DIR` env override (Task 2) to point `tryLoadConfig()` at an isolated, disposable directory per test:
  1. `runServer([])` with no CLI args but a valid persisted config present (write one via `saveConfig` from `@hall-of-wisdom/hall-config` into the isolated `HALL_CONFIG_DIR`-scoped path before calling `runServer`) starts successfully — assert the process reaches "listening" (mirror however the existing test file already asserts a successful ephemeral start, e.g. hitting the health endpoint, then shut it down the same way the existing tests do).
  2. `runServer(["--workspace-root", "<cli-path>"])` with a *different* persisted `workspaceRoot` present starts using the **CLI** value, not the persisted one (assert via whatever the existing tests use to observe the effective workspace root — e.g. a subsequent API call whose response embeds it, or a targeted unit-level call to `resolveServerConfig` directly if `server.test.ts` doesn't already have a way to introspect this at the process level; if so, keep this specific precedence assertion in `resolve-server-config.test.ts` from Task 7 instead of duplicating it awkwardly here).
  3. `runServer([])` with no CLI args and no persisted config returns `EXIT_INVALID_INPUT` (2) — this is the "no workspaceRoot from any source" case; assert on the returned exit code exactly like the file's other invalid-input tests already do.

- [ ] **Step 4: Run the full existing server test suite**

Run: `pnpm --filter @hall-of-wisdom/hall-core run test -- server.test`
Expected: PASS — every pre-existing test in this file (ephemeral, durable, comparison, agent-worktree, mutual-non-containment) still passes unchanged, plus the new precedence tests from Step 3.

- [ ] **Step 5: Typecheck the whole package**

Run: `pnpm --filter @hall-of-wisdom/hall-core run typecheck`
Expected: no errors now (Task 6/7's dangling `server.ts` errors are resolved).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/server.ts apps/server/src/server.test.ts
git commit -m "feat(hall-core): start Hall Core from persisted config when CLI flags are omitted"
```

---

### Task 9: `--verify-only` — side-effect-minimized preflight

**Files:**
- Modify: `apps/server/src/config/server-config.ts` (hoist exit-code constants)
- Modify: `apps/server/src/server.ts` (import shared exit codes, add the early-return `--verify-only` branch)
- Create: `apps/server/src/verify-only/run-verify-only.ts`
- Test: `apps/server/src/verify-only/run-verify-only.test.ts`

**Interfaces:**
- Consumes: `type ResolvedServerConfig` (Task 7), `validateWorkspace`/`isContainedPath` from `@hall-of-wisdom/hall-runner` (existing), `resolveDataDir` (existing, `persistence/database-config.ts`), `canonicalizeHallOwnedRoot` (existing, `agent-worktrees/path-safety.ts`), `openDurableStorage` (existing, `persistence/durable-startup.ts`), `checkOrRecordConfigurationFingerprint` (existing, `persistence/server-metadata-repository.ts`), `createServerComposition` (existing, `composition/server-composition.ts`), `InstanceOwnershipConflictError`/`PersistenceError` (existing, `persistence/persistence-errors.ts`), `AgentWorktreePathError` (existing, `agent-worktrees/agent-worktree-errors.ts`).
- Produces: `runVerifyOnly(resolved: ResolvedServerConfig): Promise<number>`, `VERIFY_STORAGE_SKIPPED_LIVE_INSTANCE: string` (the exact message printed when a live instance is detected — asserted on in tests).

**Why a separate module, not an `if (verifyOnly)` branch woven through `runServer()`:** `runServer()`'s ~450 lines implement extremely sensitive Phase 13–16 invariants (ownership fencing, restart recovery ordering, shutdown sequencing). Scattering conditionals through it to skip pieces for `--verify-only` would risk accidentally changing normal-startup behavior. Instead, `runVerifyOnly` is a small, independently-testable module that reuses the exact same lower-level primitives (`openDurableStorage`, `checkOrRecordConfigurationFingerprint`, `createServerComposition`) but with its own short, linear control flow — and `runServer()` gains exactly one early-return branch, before any of its own state is touched.

- [ ] **Step 1: Hoist exit-code constants into `server-config.ts`**

Append to `apps/server/src/config/server-config.ts`:
```typescript
export const EXIT_INVALID_INPUT = 2;
export const EXIT_INTERNAL_ERROR = 3;
export const EXIT_FORCED_SHUTDOWN = 130;
/** This instance's durable ownership epoch was superseded by another instance (Phase 13.2) — distinguished from `EXIT_INTERNAL_ERROR` purely for operator diagnosability; nothing branches on the specific value. */
export const EXIT_OWNERSHIP_LOST = 4;
```
In `apps/server/src/server.ts`: delete the local `const EXIT_INVALID_INPUT = 2;` ... `const EXIT_OWNERSHIP_LOST = 4;` block (original lines 32–41) and its comment, and add these four names to the existing `from "./config/server-config.js"` import.

Run: `pnpm --filter @hall-of-wisdom/hall-core run typecheck` — expected PASS, no behavior change.

Commit this step on its own:
```bash
git add apps/server/src/config/server-config.ts apps/server/src/server.ts
git commit -m "refactor(hall-core): hoist exit-code constants so run-verify-only.ts can share them"
```

- [ ] **Step 2: Write the failing test for `runVerifyOnly`**

`apps/server/src/verify-only/run-verify-only.test.ts` — read `apps/server/src/server.test.ts` first for the exact temp-directory fixture helpers this codebase already uses (creating a disposable workspace root, data dir, etc.) and reuse them rather than inventing new ones. Then:
```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runVerifyOnly, VERIFY_STORAGE_SKIPPED_LIVE_INSTANCE } from "./run-verify-only.js";
import type { ResolvedServerConfig } from "../config/resolve-server-config.js";
import { openDurableStorage } from "../persistence/durable-startup.js";
import { EXIT_INVALID_INPUT } from "../config/server-config.js";

let workspaceRoot: string;
let dataDir: string;

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-only-workspace-"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-only-data-"));
});

afterEach(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function baseConfig(overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig {
  return {
    workspaceRoot,
    port: 4310,
    webOrigin: "http://127.0.0.1:3000",
    enableCodexTrustedLocal: false,
    verifyOnly: true,
    ...overrides,
  };
}

describe("runVerifyOnly — ephemeral mode", () => {
  it("succeeds with exit 0 and never touches any storage when dataDir is omitted", async () => {
    const exitCode = await runVerifyOnly(baseConfig());
    expect(exitCode).toBe(0);
  });

  it("fails closed with EXIT_INVALID_INPUT for a workspaceRoot that does not exist", async () => {
    const exitCode = await runVerifyOnly(baseConfig({ workspaceRoot: path.join(workspaceRoot, "does-not-exist") }));
    expect(exitCode).toBe(EXIT_INVALID_INPUT);
  });
});

describe("runVerifyOnly — durable mode, fresh data dir", () => {
  it("succeeds, records the initial fingerprint, and releases the ownership lock afterward", async () => {
    const exitCode = await runVerifyOnly(baseConfig({ dataDir }));
    expect(exitCode).toBe(0);
    // A real startup afterward must be able to acquire ownership cleanly —
    // proves runVerifyOnly released its lock rather than leaving it held.
    const opened = openDurableStorage({ dataDir, bootId: "next-real-boot", busyTimeoutMs: 5000 });
    opened.db.close();
    opened.ownershipHandle.release();
  });
});

describe("runVerifyOnly — a live instance already holds the data dir", () => {
  it("reports skip (not failure) and exits 0, never touching the epoch", async () => {
    const live = openDurableStorage({ dataDir, bootId: "live-instance", busyTimeoutMs: 5000 });
    try {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      let exitCode: number;
      try {
        exitCode = await runVerifyOnly(baseConfig({ dataDir }));
      } finally {
        console.log = originalLog;
      }
      expect(exitCode).toBe(0);
      expect(logs.some((line) => line.includes(VERIFY_STORAGE_SKIPPED_LIVE_INSTANCE))).toBe(true);
    } finally {
      live.db.close();
      live.ownershipHandle.release();
    }
  });
});

describe("runVerifyOnly — fingerprint incompatibility fails closed", () => {
  it("rejects a workspaceRoot that conflicts with the database's recorded fingerprint", async () => {
    const firstRun = await runVerifyOnly(baseConfig({ dataDir }));
    expect(firstRun).toBe(0);

    const otherWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-only-other-workspace-"));
    try {
      const secondRun = await runVerifyOnly(baseConfig({ dataDir, workspaceRoot: otherWorkspaceRoot }));
      expect(secondRun).toBe(EXIT_INVALID_INPUT);
    } finally {
      fs.rmSync(otherWorkspaceRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @hall-of-wisdom/hall-core run test -- verify-only`
Expected: FAIL — module does not exist yet.

- [ ] **Step 4: Write `apps/server/src/verify-only/run-verify-only.ts`**

```typescript
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isContainedPath, validateWorkspace } from "@hall-of-wisdom/hall-runner";
import type { ResolvedServerConfig } from "../config/resolve-server-config.js";
import { DATABASE_BUSY_TIMEOUT_MS, DEFAULT_LIMITS, EXIT_INTERNAL_ERROR, EXIT_INVALID_INPUT } from "../config/server-config.js";
import { resolveDataDir } from "../persistence/database-config.js";
import { openDurableStorage } from "../persistence/durable-startup.js";
import { checkOrRecordConfigurationFingerprint } from "../persistence/server-metadata-repository.js";
import { InstanceOwnershipConflictError, PersistenceError } from "../persistence/persistence-errors.js";
import { canonicalizeHallOwnedRoot } from "../agent-worktrees/path-safety.js";
import { AgentWorktreePathError } from "../agent-worktrees/agent-worktree-errors.js";
import { createServerComposition } from "../composition/server-composition.js";

export const VERIFY_STORAGE_SKIPPED_LIVE_INSTANCE =
  "Hall Core is currently running against this data directory — storage and fingerprint checks were skipped (this is expected and safe).";

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * A side-effect-minimized configuration preflight — deliberately NOT
 * "normal startup minus `app.listen()`". Never calls `runRestartRecovery`
 * (no task/comparison/agent-worktree reconciliation, no CEO plan
 * recovery, no worktree cleanup) and never calls `app.listen()`. Reuses
 * `openDurableStorage()` exactly as real startup does — that function's
 * existing ownership-acquisition ordering (filesystem lock via
 * `acquireInstanceOwnership` before the database epoch bump via
 * `acquireDatabaseEpoch`) already fails closed with
 * `InstanceOwnershipConflictError` against a live-heartbeat owner *before*
 * ever bumping the epoch — so a live Hall Core instance is never fenced
 * out by a concurrent `--verify-only` run. That specific error is caught
 * here and treated as "skip storage checks," never as a preflight
 * failure. See docs/architecture/0017-persistent-hall-configuration.md.
 */
export async function runVerifyOnly(resolved: ResolvedServerConfig): Promise<number> {
  let workspaceRoot: string;
  try {
    workspaceRoot = validateWorkspace({
      workspaceRoot: resolved.workspaceRoot,
      workingDirectory: resolved.workspaceRoot,
    }).workspaceRoot;
  } catch (error) {
    console.error(formatError(error));
    return EXIT_INVALID_INPUT;
  }
  console.log(`OK: workspaceRoot is valid (${workspaceRoot}).`);

  let comparisonRoot: string | undefined;
  if (resolved.comparisonRoot !== undefined) {
    let canonicalComparisonRoot: string;
    try {
      canonicalComparisonRoot = validateWorkspace({
        workspaceRoot: resolved.comparisonRoot,
        workingDirectory: resolved.comparisonRoot,
      }).workspaceRoot;
    } catch (error) {
      console.error(formatError(error));
      return EXIT_INVALID_INPUT;
    }
    const caseSensitive = process.platform !== "win32" && process.platform !== "darwin";
    const nested =
      isContainedPath(workspaceRoot, canonicalComparisonRoot, { caseSensitive, path }) ||
      isContainedPath(canonicalComparisonRoot, workspaceRoot, { caseSensitive, path });
    if (nested) {
      console.error("comparisonRoot must not be nested inside, or an ancestor of, workspaceRoot.");
      return EXIT_INVALID_INPUT;
    }
    comparisonRoot = canonicalComparisonRoot;
    console.log(`OK: comparisonRoot is valid (${comparisonRoot}).`);
  }

  if (resolved.dataDir === undefined) {
    console.log("OK: ephemeral mode — no durable storage to verify.");
    return 0;
  }

  let canonicalDataDir: string;
  let agentWorktreeRoot: string | undefined;
  try {
    canonicalDataDir = resolveDataDir({ dataDir: resolved.dataDir, workspaceRoot, comparisonRoot });
    agentWorktreeRoot =
      resolved.agentWorktreeRoot === undefined
        ? undefined
        : canonicalizeHallOwnedRoot({
            rawOwnedRoot: resolved.agentWorktreeRoot,
            forbiddenRoots: [
              { canonicalPath: workspaceRoot, label: "workspace root" },
              { canonicalPath: canonicalDataDir, label: "data directory" },
              ...(comparisonRoot === undefined ? [] : [{ canonicalPath: comparisonRoot, label: "comparison root" }]),
            ],
          });
  } catch (error) {
    console.error(formatError(error));
    return error instanceof PersistenceError || error instanceof AgentWorktreePathError
      ? EXIT_INVALID_INPUT
      : EXIT_INTERNAL_ERROR;
  }
  console.log(`OK: dataDir is valid (${canonicalDataDir}).`);
  if (agentWorktreeRoot !== undefined) {
    console.log(`OK: agentWorktreeRoot is valid (${agentWorktreeRoot}).`);
  }

  const bootId = randomUUID();
  let opened;
  try {
    opened = openDurableStorage({ dataDir: canonicalDataDir, bootId, busyTimeoutMs: DATABASE_BUSY_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof InstanceOwnershipConflictError) {
      console.log(VERIFY_STORAGE_SKIPPED_LIVE_INSTANCE);
      return 0;
    }
    console.error(formatError(error));
    return error instanceof PersistenceError ? EXIT_INVALID_INPUT : EXIT_INTERNAL_ERROR;
  }

  const { db, ownershipHandle } = opened;
  try {
    // Deliberately NOT `runRestartRecovery()` — calling this repository
    // function directly is the whole point: no task/comparison/
    // agent-worktree reconciliation, no CEO plan recovery, no worktree
    // cleanup runs during a preflight.
    checkOrRecordConfigurationFingerprint(db, { workspaceRoot, comparisonRoot, agentWorktreeRoot });
    console.log("OK: configuration fingerprint check passed.");

    createServerComposition({
      workspaceRoot,
      mockScenario: resolved.mockScenario,
      mockStepDelayMs: resolved.mockStepDelayMs,
      limits: DEFAULT_LIMITS,
      enableCodexTrustedLocal: resolved.enableCodexTrustedLocal,
      comparisonRoot,
      agentWorktreeRoot,
      db,
    });
    console.log("OK: Hall Core composition succeeded.");
  } catch (error) {
    console.error(formatError(error));
    return error instanceof PersistenceError ? EXIT_INVALID_INPUT : EXIT_INTERNAL_ERROR;
  } finally {
    db.close();
    ownershipHandle.release();
  }

  console.log("OK: installation verified.");
  return 0;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @hall-of-wisdom/hall-core run test -- verify-only`
Expected: PASS.

- [ ] **Step 6: Wire the early-return branch into `server.ts`**

Immediately after the `cliOptions = resolveServerConfig(overrides, persisted)` block from Task 8 (and before the `workspaceRoot = validateWorkspace(...)` block), insert:
```typescript
  if (cliOptions.verifyOnly) {
    return runVerifyOnly(cliOptions);
  }
```
Add the import: `import { runVerifyOnly } from "./verify-only/run-verify-only.js";`

- [ ] **Step 7: Add a `server.test.ts` assertion that `--verify-only` never reaches normal startup**

Add one test to `apps/server/src/server.test.ts` (matching its existing fixture conventions): `runServer(["--workspace-root", "<tmp-workspace>", "--verify-only"])` in ephemeral mode returns `0` and — using whatever mechanism the file already has for asserting a server did **not** end up listening (e.g. attempting to connect to the resolved port and expecting a connection failure, or checking no health-endpoint response is obtainable) — confirms no HTTP server was ever started.

- [ ] **Step 8: Run the full `apps/server` test suite and typecheck**

Run: `pnpm --filter @hall-of-wisdom/hall-core run test && pnpm --filter @hall-of-wisdom/hall-core run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/verify-only/run-verify-only.ts apps/server/src/verify-only/run-verify-only.test.ts apps/server/src/server.ts apps/server/src/server.test.ts
git commit -m "feat(hall-core): --verify-only side-effect-minimized configuration preflight"
```

---

### Task 10: Real-binary process test for `--verify-only`

**Files:**
- Create: `apps/server/src/process-tests/phase-17-1-verify-only.test.ts`

**Interfaces:**
- Consumes: `requireBuiltDist`, `spawnRealServerCapturingOutput`, `waitForExit`, `waitForHealth`, `attemptStart`, `killAndWait` from `./process-test-support.js` (existing — signatures confirmed in `concurrent-instance-rejected.test.ts`), `HallDatabase` from `../persistence/database.js` (existing).

This proves `--verify-only` end to end through the **real built binary** (`node dist/server.js --verify-only ...`), not just in-process unit calls — matching the existing process-test convention (`pnpm verify:process-recovery` runs this file).

- [ ] **Step 1: Write the test**

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { HallDatabase } from "../persistence/database.js";
import {
  attemptStart,
  killAndWait,
  requireBuiltDist,
  spawnRealServerCapturingOutput,
  waitForExit,
} from "./process-test-support.js";

describe("--verify-only against the real built binary", () => {
  beforeAll(() => {
    requireBuiltDist();
  });

  let tempRoot: string;
  const spawned: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of spawned.splice(0)) {
      await killAndWait(child);
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("verifies a fresh durable configuration, records the fingerprint, and exits 0 without ever binding a port", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-verify-only-"));
    const workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceRoot);
    const dataDir = path.join(tempRoot, "data");
    const port = 47090;

    const { child, output } = spawnRealServerCapturingOutput([
      "--workspace-root",
      workspaceRoot,
      "--data-dir",
      dataDir,
      "--port",
      String(port),
      "--verify-only",
    ]);
    spawned.push(child);
    await waitForExit(child);

    expect(child.exitCode).toBe(0);
    expect(output.text).toContain("OK: installation verified.");
    await expect(fetch(`http://127.0.0.1:${String(port)}/api/v1/health`)).rejects.toBeTruthy();

    const db = HallDatabase.open({ dataDir, busyTimeoutMs: 2000 });
    try {
      const fingerprintRow = db
        .prepare("SELECT value FROM server_metadata WHERE key = 'configFingerprint.workspaceRoot'")
        .get() as { value: string } | undefined;
      expect(fingerprintRow?.value).toBeDefined();
      const bootCount = db.prepare("SELECT COUNT(*) AS count FROM boots").get() as { count: number };
      expect(bootCount.count).toBe(0);
    } finally {
      db.close();
    }
  }, 20000);

  it("skips storage checks (exit 0) when a real instance is already running against the same dataDir", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-verify-only-live-"));
    const workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceRoot);
    const dataDir = path.join(tempRoot, "data");
    const livePort = 47091;
    const verifyPort = 47092;

    const live = (
      await attemptStart(
        [
          "--workspace-root",
          workspaceRoot,
          "--data-dir",
          dataDir,
          "--port",
          String(livePort),
          "--mock-scenario",
          "success",
        ],
        livePort,
        5000,
      )
    ).child;
    spawned.push(live);

    const { child: verify, output } = spawnRealServerCapturingOutput([
      "--workspace-root",
      workspaceRoot,
      "--data-dir",
      dataDir,
      "--port",
      String(verifyPort),
      "--verify-only",
    ]);
    spawned.push(verify);
    await waitForExit(verify);

    expect(verify.exitCode).toBe(0);
    expect(output.text).toContain("storage and fingerprint checks were skipped");

    const stillHealthy = await fetch(`http://127.0.0.1:${String(livePort)}/api/v1/health`);
    expect(stillHealthy.status).toBe(200);
  }, 20000);

  it("verifies ephemeral (no --data-dir) configuration and exits 0", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-verify-only-ephemeral-"));
    const workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceRoot);

    const { child, output } = spawnRealServerCapturingOutput([
      "--workspace-root",
      workspaceRoot,
      "--verify-only",
    ]);
    spawned.push(child);
    await waitForExit(child);

    expect(child.exitCode).toBe(0);
    expect(output.text).toContain("ephemeral mode");
  }, 15000);
});
```

- [ ] **Step 2: Build and run the process test**

Run: `pnpm --filter @hall-of-wisdom/hall-core run build && pnpm --filter @hall-of-wisdom/hall-core run test:process -- phase-17-1-verify-only`
Expected: PASS (all three scenarios).

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/process-tests/phase-17-1-verify-only.test.ts
git commit -m "test(hall-core): real-binary process test for --verify-only"
```

---

### Task 11: ADR 0017 — persistent Hall configuration model

**Files:**
- Create: `docs/architecture/0017-persistent-hall-configuration.md`
- Modify: `README.md` (add the new ADR to the "Key architecture documents" list only — the fuller README rewrite is Task 17/Phase 17.4)

**Interfaces:** None (documentation only).

- [ ] **Step 1: Write the ADR**

`docs/architecture/0017-persistent-hall-configuration.md`:
```markdown
# ADR 0017: Persistent Hall Configuration

## Status

Accepted (Phase 17.1).

## Context

Hall Core's startup configuration (`--workspace-root`, `--data-dir`, `--agent-worktree-root`,
`--port`, `--web-origin`, `--comparison-root`, `--enable-codex-trusted-local`) was, through Phase
16, supplied exclusively via CLI flags on every invocation. A normal Windows user had to remember
and retype a long command every session. Phase 17.1 introduces `.\install.ps1` as the primary
onboarding path, which requires a durable place to store the answers a user gives once.

## Decision

A new workspace package, `@hall-of-wisdom/hall-config`, owns a versioned, schema-validated
configuration file (`HallConfigSchema`, `schemaVersion: 1`) stored at a machine-local,
user-specific location (`%LOCALAPPDATA%\HallOfWisdom\config.json` on Windows — deliberately
*Local*, not *Roaming*, since the file stores machine-specific absolute paths that must never
sync across machines via a roaming profile; macOS/Linux equivalents are defined now for a future
non-Windows frontend). Writes are atomic (temp file + rename). The schema explicitly excludes any
provider credential, token, or secret — it stores only filesystem roots, ports, and a boolean
Codex trusted-local opt-in.

`apps/server`'s CLI parsing splits into two layers: `ServerCliOverrides` (every field optional,
including `workspaceRoot`) and a `ResolvedServerConfig` (workspaceRoot required) produced by
`resolveServerConfig()`, which merges CLI overrides over the persisted config over built-in
defaults, per field. An explicit CLI flag always wins. `webOrigin` is derived from the resolved
`hallWebPort` unless `--web-origin` is explicitly supplied, so a persisted web-port change can
never silently create a CORS/WebSocket-origin mismatch. `comparisonRoot` is a normal, persisted
setting (not dev-only) — the installer derives a real default rather than leaving comparisons
disabled by omission, since comparison composition depends entirely on this value being present.
`mockScenario`/`mockStepDelayMs` remain CLI-only development flags, never persisted.

A new `--verify-only` flag on `apps/server`'s existing entrypoint provides a side-effect-minimized
configuration preflight, used by `install.ps1` both for first-install verification and for
validating a reconfiguration candidate before promoting it. It reuses `openDurableStorage()`
exactly as real startup does; that function's existing ownership-acquisition ordering
(filesystem lock via `acquireInstanceOwnership()` before the database epoch bump via
`acquireDatabaseEpoch()`) already fails closed with `InstanceOwnershipConflictError` against a
live-heartbeat owner before the epoch is ever touched, so `--verify-only` can never fence out a
live Hall Core instance — it catches that specific error and reports a skip, not a failure. It
calls `checkOrRecordConfigurationFingerprint()` directly rather than `runRestartRecovery()`, so it
never runs task/comparison/agent-worktree reconciliation, CEO plan recovery, or worktree cleanup,
and it never calls `app.listen()`.

Reconfiguration (`install.ps1`'s "reconfigure" flow) validates the candidate by invoking
`--verify-only` with the candidate's values passed as explicit CLI flags — which, by the
precedence rule above, always wins over the still-untouched active `config.json` — and only
atomically promotes the candidate over the active file on a `0` exit. The active configuration is
never overwritten before verification and never partially written.

## Consequences

- A user who has run `install.ps1` once can start Hall Core with zero flags.
- The Phase 16 configuration fingerprint and worktree path-safety code are reused unmodified —
  this ADR introduces no new authority over what counts as a safe path.
- A future macOS/Linux installer can reuse `@hall-of-wisdom/hall-config` unchanged; only the
  PowerShell driver (`install.ps1`) is Windows-specific.
- `apps/web`'s hardcoded port-3000 startup scripts are unchanged by this phase — Hall Core's own
  `webOrigin` derivation is correct for whatever port Hall Web eventually uses, but actually
  starting Hall Web on a non-default `hallWebPort` remains Phase 17.3's launcher's responsibility.
```

- [ ] **Step 2: Add the ADR to README's architecture list**

In `README.md`, add one line to the "Key architecture documents" bullet list (after the `0016` entry):
```markdown
- [`docs/architecture/0017-persistent-hall-configuration.md`](docs/architecture/0017-persistent-hall-configuration.md)
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/0017-persistent-hall-configuration.md README.md
git commit -m "docs: add ADR 0017 for the persistent Hall configuration model"
```

---

### Task 12: PowerShell test harness + `Prerequisites.ps1`

No Pester dependency (per Global Constraints) — a small, dependency-free convention: each `scripts/install/tests/*.Tests.ps1` file is a plain script that runs `Assert-*` calls top-to-bottom; a thrown assertion fails the whole file, caught and reported by `run-tests.ps1`. Coarser than per-case reporting, but simple and needs nothing beyond PowerShell itself.

**Files:**
- Create: `scripts/install/tests/TestHelpers.ps1`
- Create: `scripts/install/tests/run-tests.ps1`
- Create: `scripts/install/Prerequisites.ps1`
- Create: `scripts/install/tests/Prerequisites.Tests.ps1`

**Interfaces:**
- Produces: `Assert-True`, `Assert-Equal`, `Assert-Throws` (test helpers). `Get-HallRequiredVersions -RepoRoot`, `Test-HallNodeVersionInRange -VersionText -RangeText`, `Test-HallGitPrerequisite`, `Test-HallNodePrerequisite -RequiredRange`, `Test-HallPnpmPrerequisite -RequiredVersion`, `Test-HallRepositoryIntegrity -RepoRoot` — each `Test-Hall*Prerequisite`/`Test-HallRepositoryIntegrity` returns `[PSCustomObject]@{ Ok = [bool]; Message = [string] }`, never throws.

- [ ] **Step 1: Write the test harness**

`scripts/install/tests/TestHelpers.ps1`:
```powershell
function Assert-True {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function Assert-False {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if ($Condition) { throw "ASSERTION FAILED: $Message" }
}

function Assert-Equal {
    param([Parameter(Mandatory)]$Expected, [Parameter(Mandatory)]$Actual, [Parameter(Mandatory)][string]$Message)
    if ($Expected -ne $Actual) {
        throw "ASSERTION FAILED: $Message (expected '$Expected', got '$Actual')"
    }
}

function Assert-Throws {
    param([Parameter(Mandatory)][scriptblock]$ScriptBlock, [Parameter(Mandatory)][string]$Message)
    $threw = $false
    try { & $ScriptBlock | Out-Null } catch { $threw = $true }
    if (-not $threw) { throw "ASSERTION FAILED: $Message (expected an exception, none was thrown)" }
}
```

`scripts/install/tests/run-tests.ps1`:
```powershell
param()
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$testFiles = Get-ChildItem -Path $here -Filter "*.Tests.ps1" | Sort-Object Name
$failed = @()

foreach ($file in $testFiles) {
    Write-Host "Running $($file.Name)..." -NoNewline
    try {
        & $file.FullName
        Write-Host " PASS" -ForegroundColor Green
    } catch {
        Write-Host " FAIL" -ForegroundColor Red
        Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
        $failed += $file.Name
    }
}

if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Host "$($failed.Count) test file(s) failed: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host ""
Write-Host "All $($testFiles.Count) test file(s) passed." -ForegroundColor Green
exit 0
```

- [ ] **Step 2: Write the failing test for `Prerequisites.ps1`**

`scripts/install/tests/Prerequisites.Tests.ps1`:
```powershell
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path $PSScriptRoot ".." "Prerequisites.ps1")

# Test-HallNodeVersionInRange — narrow ">=A.B.C <D" range parser
Assert-True (Test-HallNodeVersionInRange -VersionText "v24.11.0" -RangeText ">=24.11.0 <25") "24.11.0 is exactly the minimum, must be in range"
Assert-True (Test-HallNodeVersionInRange -VersionText "v24.12.5" -RangeText ">=24.11.0 <25") "24.12.5 is above the minimum, must be in range"
Assert-True (Test-HallNodeVersionInRange -VersionText "v24.99.99" -RangeText ">=24.11.0 <25") "24.99.99 is still major 24, must be in range"
Assert-False (Test-HallNodeVersionInRange -VersionText "v24.10.9" -RangeText ">=24.11.0 <25") "24.10.9 is below the minor minimum, must NOT be in range"
Assert-False (Test-HallNodeVersionInRange -VersionText "v23.0.0" -RangeText ">=24.11.0 <25") "major 23 is below range, must NOT be in range"
Assert-False (Test-HallNodeVersionInRange -VersionText "v25.0.0" -RangeText ">=24.11.0 <25") "major 25 is excluded by the upper bound, must NOT be in range"
Assert-Throws { Test-HallNodeVersionInRange -VersionText "v24.11.0" -RangeText "not a range" } "an unrecognized range format must throw, never silently pass"

# Get-HallRequiredVersions — reads engines/packageManager from a fixture package.json
$fixtureDir = Join-Path ([System.IO.Path]::GetTempPath()) "hall-install-prereq-test-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $fixtureDir -Force | Out-Null
try {
    $fixturePackageJson = @{
        engines = @{ node = ">=24.11.0 <25" }
        packageManager = "pnpm@10.33.0"
    } | ConvertTo-Json
    Set-Content -LiteralPath (Join-Path $fixtureDir "package.json") -Value $fixturePackageJson -Encoding utf8

    $versions = Get-HallRequiredVersions -RepoRoot $fixtureDir
    Assert-Equal ">=24.11.0 <25" $versions.NodeRange "NodeRange should come from package.json engines.node"
    Assert-Equal "10.33.0" $versions.PnpmVersion "PnpmVersion should be parsed out of the packageManager field"
} finally {
    Remove-Item -LiteralPath $fixtureDir -Recurse -Force
}

Assert-Throws { Get-HallRequiredVersions -RepoRoot "C:\definitely-does-not-exist-hall-test" } "missing package.json must throw"

# Test-HallRepositoryIntegrity — a fixture missing required paths must fail
$emptyDir = Join-Path ([System.IO.Path]::GetTempPath()) "hall-install-empty-test-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $emptyDir -Force | Out-Null
try {
    $result = Test-HallRepositoryIntegrity -RepoRoot $emptyDir
    Assert-False $result.Ok "an empty directory must fail repository-integrity check"
} finally {
    Remove-Item -LiteralPath $emptyDir -Recurse -Force
}

# Test-HallGitPrerequisite / Test-HallNodePrerequisite / Test-HallPnpmPrerequisite —
# smoke-tested against whatever this test-runner's own environment actually has,
# since the plan's own Global Constraints already require Git/Node/pnpm present.
$gitResult = Test-HallGitPrerequisite
Assert-True $gitResult.Ok "Git must be present in the environment running this test suite"

$nodeResult = Test-HallNodePrerequisite -RequiredRange ">=24.11.0 <25"
Assert-True $nodeResult.Ok "the pinned Node.js version must be present in this environment"

$pnpmResult = Test-HallPnpmPrerequisite -RequiredVersion "10.33.0"
Assert-True $pnpmResult.Ok "the pinned pnpm version must be present in this environment"

Write-Host "  (Prerequisites.Tests.ps1: all assertions passed)"
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pwsh -NoProfile -File scripts/install/tests/run-tests.ps1` (or `powershell -NoProfile -File ...` on Windows PowerShell 5.1)
Expected: FAIL — `Prerequisites.ps1` does not exist yet.

- [ ] **Step 4: Write `scripts/install/Prerequisites.ps1`**

```powershell
function Get-HallRequiredVersions {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $packageJsonPath = Join-Path $RepoRoot "package.json"
    if (-not (Test-Path -LiteralPath $packageJsonPath)) {
        throw "package.json not found at '$packageJsonPath'."
    }
    $packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
    [PSCustomObject]@{
        NodeRange   = $packageJson.engines.node
        PnpmVersion = ($packageJson.packageManager -replace '^pnpm@', '')
    }
}

# Narrow parser for THIS repo's exact node engines range shape
# (">=A.B.C <D" — minimum inclusive, major-exclusive upper bound). Not a
# general semver-range parser; throws on anything else rather than
# guessing.
function Test-HallNodeVersionInRange {
    param(
        [Parameter(Mandatory)][string]$VersionText,
        [Parameter(Mandatory)][string]$RangeText
    )
    if ($RangeText -notmatch '^>=(\d+)\.(\d+)\.(\d+)\s+<(\d+)$') {
        throw "Unsupported node engines range format: '$RangeText'."
    }
    $minMajor = [int]$Matches[1]; $minMinor = [int]$Matches[2]; $minPatch = [int]$Matches[3]
    $maxMajorExclusive = [int]$Matches[4]

    $cleanVersion = $VersionText.TrimStart('v')
    if ($cleanVersion -notmatch '^(\d+)\.(\d+)\.(\d+)') {
        return $false
    }
    $major = [int]$Matches[1]; $minor = [int]$Matches[2]; $patch = [int]$Matches[3]

    if ($major -ge $maxMajorExclusive) { return $false }
    if ($major -lt $minMajor) { return $false }
    if ($major -eq $minMajor) {
        if ($minor -lt $minMinor) { return $false }
        if ($minor -eq $minMinor -and $patch -lt $minPatch) { return $false }
    }
    return $true
}

function Test-HallGitPrerequisite {
    try {
        $version = (git --version) 2>$null
        if (-not $version) { return [PSCustomObject]@{ Ok = $false; Message = "Git was not found on PATH." } }
        return [PSCustomObject]@{ Ok = $true; Message = $version.Trim() }
    } catch {
        return [PSCustomObject]@{ Ok = $false; Message = "Git was not found on PATH." }
    }
}

function Test-HallNodePrerequisite {
    param([Parameter(Mandatory)][string]$RequiredRange)
    try {
        $version = (node --version) 2>$null
        if (-not $version) { return [PSCustomObject]@{ Ok = $false; Message = "Node.js was not found on PATH." } }
    } catch {
        return [PSCustomObject]@{ Ok = $false; Message = "Node.js was not found on PATH." }
    }
    if (-not (Test-HallNodeVersionInRange -VersionText $version -RangeText $RequiredRange)) {
        return [PSCustomObject]@{ Ok = $false; Message = "Node.js $version was found, but Hall requires $RequiredRange." }
    }
    return [PSCustomObject]@{ Ok = $true; Message = $version.Trim() }
}

function Test-HallPnpmPrerequisite {
    param([Parameter(Mandatory)][string]$RequiredVersion)
    try {
        $version = ((pnpm --version) 2>$null).Trim()
        if (-not $version) { return [PSCustomObject]@{ Ok = $false; Message = "pnpm was not found on PATH." } }
    } catch {
        return [PSCustomObject]@{ Ok = $false; Message = "pnpm was not found on PATH." }
    }
    if ($version -ne $RequiredVersion) {
        return [PSCustomObject]@{ Ok = $false; Message = "pnpm $version was found, but Hall is pinned to pnpm $RequiredVersion." }
    }
    return [PSCustomObject]@{ Ok = $true; Message = $version }
}

function Test-HallRepositoryIntegrity {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $requiredRelativePaths = @("package.json", "pnpm-workspace.yaml", "AGENTS.md", "apps/server", "packages/hall-config")
    $missing = @()
    foreach ($relativePath in $requiredRelativePaths) {
        $fullPath = Join-Path $RepoRoot $relativePath
        if (-not (Test-Path -LiteralPath $fullPath)) { $missing += $relativePath }
    }
    if ($missing.Count -gt 0) {
        return [PSCustomObject]@{ Ok = $false; Message = "Missing expected repository paths: $($missing -join ', ')" }
    }
    return [PSCustomObject]@{ Ok = $true; Message = "Repository structure looks intact." }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pwsh -NoProfile -File scripts/install/tests/run-tests.ps1`
Expected: PASS. (`Test-HallRepositoryIntegrity` against `$emptyDir` correctly fails; the live Git/Node/pnpm checks pass because this repo's own dev environment already satisfies the Global Constraints.)

- [ ] **Step 6: Commit**

```bash
git add scripts/install/tests/TestHelpers.ps1 scripts/install/tests/run-tests.ps1 scripts/install/Prerequisites.ps1 scripts/install/tests/Prerequisites.Tests.ps1
git commit -m "feat(install): dependency-free PowerShell test harness + prerequisite checks"
```

---

### Task 13: `HallConfigDefaults.ps1` + `HallConfigCli.ps1` — default paths and the `hall-config` CLI wrapper

**Files:**
- Create: `scripts/install/HallConfigDefaults.ps1`
- Create: `scripts/install/HallConfigCli.ps1`
- Create: `scripts/install/tests/HallConfigDefaults.Tests.ps1`
- Create: `scripts/install/tests/HallConfigCli.Tests.ps1`

**Interfaces:**
- Produces: `Get-HallDefaultPaths -LocalAppData` → `[PSCustomObject]@{ DataDir; AgentWorktreeRoot; ComparisonRoot }`. `Get-HallConfigCliPath -RepoRoot`, `Invoke-HallConfigCli -RepoRoot -Command -ConfigPath [-CandidateJson]` → `[PSCustomObject]@{ ExitCode; Result }`, `Invoke-HallConfigStatus -RepoRoot -ConfigPath`, `Invoke-HallConfigValidate -RepoRoot -ConfigPath -Candidate`, `Invoke-HallConfigSave -RepoRoot -ConfigPath -Candidate`.

All arguments to `node` are passed as an array (`& node @arguments`), never string-concatenated — satisfies the "structured process args, never unsafe shell strings" constraint even for paths containing spaces.

- [ ] **Step 1: Write the failing tests**

`scripts/install/tests/HallConfigDefaults.Tests.ps1`:
```powershell
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path $PSScriptRoot ".." "HallConfigDefaults.ps1")

$defaults = Get-HallDefaultPaths -LocalAppData "C:\Users\Test\AppData\Local"
Assert-Equal (Join-Path "C:\Users\Test\AppData\Local" "HallOfWisdom" "data") $defaults.DataDir "DataDir should be a sibling under HallOfWisdom"
Assert-Equal (Join-Path "C:\Users\Test\AppData\Local" "HallOfWisdom" "agent-worktrees") $defaults.AgentWorktreeRoot "AgentWorktreeRoot should be a sibling under HallOfWisdom"
Assert-Equal (Join-Path "C:\Users\Test\AppData\Local" "HallOfWisdom" "comparisons") $defaults.ComparisonRoot "ComparisonRoot should default to a sibling under HallOfWisdom (Correction 2)"

Assert-Throws { Get-HallDefaultPaths -LocalAppData "" } "an empty LocalAppData must throw, never silently default to a relative path"

Write-Host "  (HallConfigDefaults.Tests.ps1: all assertions passed)"
```

`scripts/install/tests/HallConfigCli.Tests.ps1` (uses a fake `dist/cli.js` under a disposable fixture repo root, so it never depends on a real `pnpm build`):
```powershell
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path $PSScriptRoot ".." "HallConfigCli.ps1")

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-install-cli-test-$([guid]::NewGuid())"
$cliDir = Join-Path $fixtureRoot "packages/hall-config/dist"
New-Item -ItemType Directory -Path $cliDir -Force | Out-Null

# A fake CLI mirroring the real dist/cli.js JSON contract from
# packages/hall-config's run-cli.ts, so this file tests only the
# PowerShell wrapper's argument-passing / JSON round-trip, not
# hall-config's own business logic (already covered by run-cli.test.ts).
$fakeCli = @'
const path = process.argv[3] === "--path" ? process.argv[4] : undefined;
const command = process.argv[2];
if (command === "status") {
  console.log(JSON.stringify({ exists: false, path, config: null, error: null }));
  process.exit(0);
}
let stdin = "";
try { stdin = require("fs").readFileSync(0, "utf8"); } catch {}
const failing = stdin.includes("invalid-marker");
if (command === "validate") {
  console.log(JSON.stringify(failing ? { valid: false, errors: ["fake error"] } : { valid: true, errors: [] }));
  process.exit(failing ? 1 : 0);
}
if (command === "save") {
  console.log(JSON.stringify(failing ? { saved: false, errors: ["fake error"] } : { saved: true, path }));
  process.exit(failing ? 1 : 0);
}
process.exit(1);
'@
Set-Content -LiteralPath (Join-Path $cliDir "cli.js") -Value $fakeCli -Encoding utf8

try {
    $configPath = Join-Path $fixtureRoot "config.json"

    $cliPath = Get-HallConfigCliPath -RepoRoot $fixtureRoot
    Assert-Equal (Join-Path $cliDir "cli.js") $cliPath "Get-HallConfigCliPath should resolve to packages/hall-config/dist/cli.js"

    $status = Invoke-HallConfigStatus -RepoRoot $fixtureRoot -ConfigPath $configPath
    Assert-Equal $false $status.exists "fake CLI status should report exists:false"
    Assert-Equal $configPath $status.path "status should echo back the --path argument exactly"

    $validCandidate = @{ schemaVersion = 1; workspaceRoot = "D:\HallOfWisdom" }
    $validateResult = Invoke-HallConfigValidate -RepoRoot $fixtureRoot -ConfigPath $configPath -Candidate $validCandidate
    Assert-Equal 0 $validateResult.ExitCode "a valid candidate should exit 0"
    Assert-Equal $true $validateResult.Result.valid "a valid candidate should report valid:true"

    $invalidCandidate = @{ schemaVersion = 1; workspaceRoot = "invalid-marker" }
    $invalidResult = Invoke-HallConfigValidate -RepoRoot $fixtureRoot -ConfigPath $configPath -Candidate $invalidCandidate
    Assert-Equal 1 $invalidResult.ExitCode "an invalid candidate should exit 1"
    Assert-Equal $false $invalidResult.Result.valid "an invalid candidate should report valid:false"

    $saveResult = Invoke-HallConfigSave -RepoRoot $fixtureRoot -ConfigPath $configPath -Candidate $validCandidate
    Assert-Equal 0 $saveResult.ExitCode "saving a valid candidate should exit 0"
    Assert-Equal $true $saveResult.Result.saved "saving a valid candidate should report saved:true"

    Assert-Throws { Get-HallConfigCliPath -RepoRoot "C:\definitely-does-not-exist-hall-test" } "a missing dist/cli.js must throw a clear 'run pnpm build first' error"
} finally {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

Write-Host "  (HallConfigCli.Tests.ps1: all assertions passed)"
```

- [ ] **Step 2: Run to verify both fail**

Run: `pwsh -NoProfile -File scripts/install/tests/run-tests.ps1`
Expected: FAIL — `HallConfigDefaults.ps1`/`HallConfigCli.ps1` do not exist yet.

- [ ] **Step 3: Write `scripts/install/HallConfigDefaults.ps1`**

```powershell
# Derives Hall's default machine-local paths, sibling to
# packages/hall-config's own config-file location logic
# (%LOCALAPPDATA%\HallOfWisdom on Windows) — see
# docs/architecture/0017-persistent-hall-configuration.md. comparisonRoot
# gets a real default here (Correction 2: comparisons are a normal
# setting, not dev-only) rather than being silently left disabled.
function Get-HallDefaultPaths {
    param([string]$LocalAppData = $env:LOCALAPPDATA)
    if ([string]::IsNullOrWhiteSpace($LocalAppData)) {
        throw "LOCALAPPDATA is not set; cannot derive default Hall paths. Pass -LocalAppData explicitly."
    }
    $base = Join-Path $LocalAppData "HallOfWisdom"
    [PSCustomObject]@{
        DataDir           = Join-Path $base "data"
        AgentWorktreeRoot = Join-Path $base "agent-worktrees"
        ComparisonRoot    = Join-Path $base "comparisons"
    }
}
```

- [ ] **Step 4: Write `scripts/install/HallConfigCli.ps1`**

```powershell
function Get-HallConfigCliPath {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $cliPath = Join-Path $RepoRoot "packages/hall-config/dist/cli.js"
    if (-not (Test-Path -LiteralPath $cliPath)) {
        throw "hall-config CLI not found at '$cliPath' — run 'pnpm --filter @hall-of-wisdom/hall-config run build' first."
    }
    return $cliPath
}

# Every argument to `node` is passed as an array element — never
# string-concatenated — so a path containing spaces or special characters
# is handled correctly and no `Invoke-Expression`/shell-string
# construction is ever used.
function Invoke-HallConfigCli {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][ValidateSet("status", "validate", "save")][string]$Command,
        [Parameter(Mandatory)][string]$ConfigPath,
        [string]$CandidateJson
    )
    $cliPath = Get-HallConfigCliPath -RepoRoot $RepoRoot
    $arguments = @($cliPath, $Command, "--path", $ConfigPath)

    if ($CandidateJson) {
        $stdout = $CandidateJson | & node @arguments
    } else {
        $stdout = & node @arguments
    }
    $exitCode = $LASTEXITCODE

    if (-not $stdout) {
        throw "hall-config CLI '$Command' produced no output (exit code $exitCode)."
    }
    $lastLine = @($stdout) | Select-Object -Last 1
    [PSCustomObject]@{
        ExitCode = $exitCode
        Result   = $lastLine | ConvertFrom-Json
    }
}

function Invoke-HallConfigStatus {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$ConfigPath)
    (Invoke-HallConfigCli -RepoRoot $RepoRoot -Command "status" -ConfigPath $ConfigPath).Result
}

function Invoke-HallConfigValidate {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$ConfigPath, [Parameter(Mandatory)]$Candidate)
    Invoke-HallConfigCli -RepoRoot $RepoRoot -Command "validate" -ConfigPath $ConfigPath -CandidateJson ($Candidate | ConvertTo-Json -Depth 10)
}

function Invoke-HallConfigSave {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$ConfigPath, [Parameter(Mandatory)]$Candidate)
    Invoke-HallConfigCli -RepoRoot $RepoRoot -Command "save" -ConfigPath $ConfigPath -CandidateJson ($Candidate | ConvertTo-Json -Depth 10)
}
```

- [ ] **Step 5: Run to verify both pass**

Run: `pwsh -NoProfile -File scripts/install/tests/run-tests.ps1`
Expected: PASS (requires `node` on PATH, already a Global Constraint).

- [ ] **Step 6: Commit**

```bash
git add scripts/install/HallConfigDefaults.ps1 scripts/install/HallConfigCli.ps1 scripts/install/tests/HallConfigDefaults.Tests.ps1 scripts/install/tests/HallConfigCli.Tests.ps1
git commit -m "feat(install): default Hall paths and a structured hall-config CLI wrapper"
```

---

### Task 14: `Verification.ps1` (`--verify-only` wrapper) + `Reconfigure.ps1` (verify-before-promote)

**Files:**
- Create: `scripts/install/Verification.ps1`
- Create: `scripts/install/Reconfigure.ps1`
- Create: `scripts/install/tests/Verification.Tests.ps1`
- Create: `scripts/install/tests/Reconfigure.Tests.ps1`

**Interfaces:**
- Consumes: `Invoke-HallConfigValidate` / `Invoke-HallConfigSave` (Task 13).
- Produces: `Get-HallServerDistPath -RepoRoot`, `Invoke-HallVerifyOnly -RepoRoot -WorkspaceRoot [-DataDir] [-AgentWorktreeRoot] [-ComparisonRoot] [-Port] [-EnableCodexTrustedLocal]` → `[PSCustomObject]@{ ExitCode; Success; Output }`. `Invoke-HallReconfigure -RepoRoot -ConfigPath -Candidate` → `[PSCustomObject]@{ Success; Stage; Errors }` where `Stage` is one of `structural-validation` / `verify-only` / `save` / `complete`.

**Correction 4 enforcement, precisely:** `Invoke-HallReconfigure` never calls `Invoke-HallConfigSave` (the only thing that touches the active `config.json`) until *after* `Invoke-HallVerifyOnly` has returned `Success = $true`, and `Invoke-HallVerifyOnly` is passed the *candidate's* values as explicit `node dist/server.js --verify-only` flags — it never reads or writes the active config file at all. If verification fails, the function returns before `Invoke-HallConfigSave` is ever reached, so the active file is provably untouched.

- [ ] **Step 1: Write the failing tests**

`scripts/install/tests/Verification.Tests.ps1` (fake `apps/server/dist/server.js` stub so this never depends on a real `pnpm build`):
```powershell
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path $PSScriptRoot ".." "Verification.ps1")

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-install-verify-test-$([guid]::NewGuid())"
$serverDistDir = Join-Path $fixtureRoot "apps/server/dist"
New-Item -ItemType Directory -Path $serverDistDir -Force | Out-Null

# Mirrors run-verify-only.ts's observable contract just enough to test
# this wrapper: exit 0 unless --workspace-root contains the literal
# substring "trigger-verify-failure".
$fakeServer = @'
const args = process.argv.slice(2);
const rootIndex = args.indexOf("--workspace-root");
const workspaceRoot = rootIndex === -1 ? "" : args[rootIndex + 1];
if (workspaceRoot.includes("trigger-verify-failure")) {
  console.error("simulated verify-only failure");
  process.exit(2);
}
console.log("OK: installation verified.");
process.exit(0);
'@
Set-Content -LiteralPath (Join-Path $serverDistDir "server.js") -Value $fakeServer -Encoding utf8

try {
    $distPath = Get-HallServerDistPath -RepoRoot $fixtureRoot
    Assert-Equal (Join-Path $serverDistDir "server.js") $distPath "Get-HallServerDistPath should resolve to apps/server/dist/server.js"

    $ok = Invoke-HallVerifyOnly -RepoRoot $fixtureRoot -WorkspaceRoot "D:\HallOfWisdom"
    Assert-Equal 0 $ok.ExitCode "a normal workspace root should verify successfully"
    Assert-True $ok.Success "Success should be true on exit code 0"

    $bad = Invoke-HallVerifyOnly -RepoRoot $fixtureRoot -WorkspaceRoot "D:\trigger-verify-failure"
    Assert-Equal 2 $bad.ExitCode "a workspace root that triggers the fake failure should propagate exit code 2"
    Assert-False $bad.Success "Success should be false on a non-zero exit code"

    Assert-Throws { Get-HallServerDistPath -RepoRoot "C:\definitely-does-not-exist-hall-test" } "a missing server.js must throw a clear 'run pnpm build first' error"
} finally {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

Write-Host "  (Verification.Tests.ps1: all assertions passed)"
```

`scripts/install/tests/Reconfigure.Tests.ps1` (reuses the same two fakes: `packages/hall-config/dist/cli.js` from Task 13's convention, `apps/server/dist/server.js` from this task's convention, assembled fresh in its own fixture so this file has no cross-file fixture dependency):
```powershell
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path $PSScriptRoot ".." "HallConfigCli.ps1")
. (Join-Path $PSScriptRoot ".." "Verification.ps1")
. (Join-Path $PSScriptRoot ".." "Reconfigure.ps1")

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-install-reconfigure-test-$([guid]::NewGuid())"
$cliDir = Join-Path $fixtureRoot "packages/hall-config/dist"
$serverDistDir = Join-Path $fixtureRoot "apps/server/dist"
New-Item -ItemType Directory -Path $cliDir -Force | Out-Null
New-Item -ItemType Directory -Path $serverDistDir -Force | Out-Null

$fakeCli = @'
const path = process.argv[3] === "--path" ? process.argv[4] : undefined;
const command = process.argv[2];
if (command === "status") { console.log(JSON.stringify({ exists: false, path, config: null, error: null })); process.exit(0); }
let stdin = "";
try { stdin = require("fs").readFileSync(0, "utf8"); } catch {}
const structurallyInvalid = stdin.includes("trigger-structural-failure");
if (command === "validate") {
  console.log(JSON.stringify(structurallyInvalid ? { valid: false, errors: ["fake structural error"] } : { valid: true, errors: [] }));
  process.exit(structurallyInvalid ? 1 : 0);
}
if (command === "save") {
  const fs = require("fs");
  if (!structurallyInvalid) { fs.writeFileSync(path, stdin); }
  console.log(JSON.stringify(structurallyInvalid ? { saved: false, errors: ["fake structural error"] } : { saved: true, path }));
  process.exit(structurallyInvalid ? 1 : 0);
}
process.exit(1);
'@
Set-Content -LiteralPath (Join-Path $cliDir "cli.js") -Value $fakeCli -Encoding utf8

$fakeServer = @'
const args = process.argv.slice(2);
const rootIndex = args.indexOf("--workspace-root");
const workspaceRoot = rootIndex === -1 ? "" : args[rootIndex + 1];
if (workspaceRoot.includes("trigger-verify-failure")) { console.error("simulated verify-only failure"); process.exit(2); }
console.log("OK: installation verified.");
process.exit(0);
'@
Set-Content -LiteralPath (Join-Path $serverDistDir "server.js") -Value $fakeServer -Encoding utf8

try {
    $configPath = Join-Path $fixtureRoot "config.json"
    Set-Content -LiteralPath $configPath -Value '{"schemaVersion":1,"workspaceRoot":"D:\\OriginalActive","comparisonRoot":null,"hallCorePort":4310,"hallWebPort":3000,"codexTrustedLocal":false}' -Encoding utf8
    $originalContent = Get-Content -LiteralPath $configPath -Raw

    # Case 1: verify-only fails -> active config must be untouched, Stage reported precisely.
    $failingCandidate = @{ schemaVersion = 1; workspaceRoot = "D:\trigger-verify-failure"; comparisonRoot = $null; hallCorePort = 4310; hallWebPort = 3000; codexTrustedLocal = $false }
    $failResult = Invoke-HallReconfigure -RepoRoot $fixtureRoot -ConfigPath $configPath -Candidate $failingCandidate
    Assert-False $failResult.Success "a candidate that fails --verify-only must not be promoted"
    Assert-Equal "verify-only" $failResult.Stage "the failure stage must be reported as verify-only, not save"
    Assert-Equal $originalContent (Get-Content -LiteralPath $configPath -Raw) "the active config file must be byte-for-byte untouched after a failed verify-only"

    # Case 2: structural validation fails -> verify-only (and save) must never even run.
    $structurallyBadCandidate = @{ schemaVersion = 1; workspaceRoot = "trigger-structural-failure"; comparisonRoot = $null; hallCorePort = 4310; hallWebPort = 3000; codexTrustedLocal = $false }
    $structResult = Invoke-HallReconfigure -RepoRoot $fixtureRoot -ConfigPath $configPath -Candidate $structurallyBadCandidate
    Assert-False $structResult.Success "a structurally invalid candidate must not be promoted"
    Assert-Equal "structural-validation" $structResult.Stage "the failure stage must be reported as structural-validation"
    Assert-Equal $originalContent (Get-Content -LiteralPath $configPath -Raw) "the active config file must be untouched after a structural-validation failure"

    # Case 3: everything passes -> active config is promoted (overwritten) exactly once, atomically.
    $goodCandidate = @{ schemaVersion = 1; workspaceRoot = "D:\NewActiveWorkspace"; comparisonRoot = $null; hallCorePort = 4310; hallWebPort = 3000; codexTrustedLocal = $false }
    $successResult = Invoke-HallReconfigure -RepoRoot $fixtureRoot -ConfigPath $configPath -Candidate $goodCandidate
    Assert-True $successResult.Success "a fully valid candidate must be promoted"
    Assert-Equal "complete" $successResult.Stage "a successful reconfigure must report stage complete"
    $promotedContent = Get-Content -LiteralPath $configPath -Raw
    Assert-True ($promotedContent -like "*NewActiveWorkspace*") "the active config file must now contain the promoted candidate's workspaceRoot"
} finally {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

Write-Host "  (Reconfigure.Tests.ps1: all assertions passed)"
```

- [ ] **Step 2: Run to verify both fail**

Run: `pwsh -NoProfile -File scripts/install/tests/run-tests.ps1`
Expected: FAIL — `Verification.ps1`/`Reconfigure.ps1` do not exist yet.

- [ ] **Step 3: Write `scripts/install/Verification.ps1`**

```powershell
function Get-HallServerDistPath {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $distPath = Join-Path $RepoRoot "apps/server/dist/server.js"
    if (-not (Test-Path -LiteralPath $distPath)) {
        throw "Hall Core build not found at '$distPath' — run 'pnpm --filter @hall-of-wisdom/hall-core run build' first."
    }
    return $distPath
}

# Wraps `node dist/server.js --verify-only ...` — see
# apps/server/src/verify-only/run-verify-only.ts and
# docs/architecture/0017-persistent-hall-configuration.md for exactly what
# this preflight does and, just as importantly, does not do (never
# runRestartRecovery, never app.listen(), never fences a live instance).
# Every argument is passed as an array element, never a concatenated
# shell string.
function Invoke-HallVerifyOnly {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$WorkspaceRoot,
        [string]$DataDir,
        [string]$AgentWorktreeRoot,
        [string]$ComparisonRoot,
        [int]$Port = 4310,
        [switch]$EnableCodexTrustedLocal
    )
    $distPath = Get-HallServerDistPath -RepoRoot $RepoRoot
    $arguments = @($distPath, "--workspace-root", $WorkspaceRoot, "--port", $Port, "--verify-only")
    if ($DataDir) { $arguments += @("--data-dir", $DataDir) }
    if ($AgentWorktreeRoot) { $arguments += @("--agent-worktree-root", $AgentWorktreeRoot) }
    if ($ComparisonRoot) { $arguments += @("--comparison-root", $ComparisonRoot) }
    if ($EnableCodexTrustedLocal) { $arguments += "--enable-codex-trusted-local" }

    $output = & node @arguments 2>&1
    $exitCode = $LASTEXITCODE
    [PSCustomObject]@{
        ExitCode = $exitCode
        Success  = ($exitCode -eq 0)
        Output   = ($output -join [Environment]::NewLine)
    }
}
```

- [ ] **Step 4: Write `scripts/install/Reconfigure.ps1`**

```powershell
# Verify-before-promote reconfiguration (Correction 4 — never
# write-active-then-rollback). The active config file at $ConfigPath is
# read exactly nowhere in this function's write path until the very last
# step, and only once every earlier stage has succeeded.
function Invoke-HallReconfigure {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$ConfigPath,
        [Parameter(Mandatory)]$Candidate
    )
    $structural = Invoke-HallConfigValidate -RepoRoot $RepoRoot -ConfigPath $ConfigPath -Candidate $Candidate
    if ($structural.ExitCode -ne 0) {
        return [PSCustomObject]@{ Success = $false; Stage = "structural-validation"; Errors = $structural.Result.errors }
    }

    $verify = Invoke-HallVerifyOnly `
        -RepoRoot $RepoRoot `
        -WorkspaceRoot $Candidate.workspaceRoot `
        -DataDir $Candidate.dataDir `
        -AgentWorktreeRoot $Candidate.agentWorktreeRoot `
        -ComparisonRoot $Candidate.comparisonRoot `
        -Port $Candidate.hallCorePort `
        -EnableCodexTrustedLocal:([bool]$Candidate.codexTrustedLocal)

    if (-not $verify.Success) {
        return [PSCustomObject]@{ Success = $false; Stage = "verify-only"; Errors = @($verify.Output) }
    }

    $saved = Invoke-HallConfigSave -RepoRoot $RepoRoot -ConfigPath $ConfigPath -Candidate $Candidate
    if ($saved.ExitCode -ne 0) {
        return [PSCustomObject]@{ Success = $false; Stage = "save"; Errors = $saved.Result.errors }
    }

    [PSCustomObject]@{ Success = $true; Stage = "complete"; Errors = @() }
}
```

- [ ] **Step 5: Run to verify both pass**

Run: `pwsh -NoProfile -File scripts/install/tests/run-tests.ps1`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/install/Verification.ps1 scripts/install/Reconfigure.ps1 scripts/install/tests/Verification.Tests.ps1 scripts/install/tests/Reconfigure.Tests.ps1
git commit -m "feat(install): --verify-only wrapper and verify-before-promote reconfiguration"
```

---

### Task 15: `install.ps1` — the main entrypoint

**Files:**
- Create: `install.ps1` (repo root)
- Create: `scripts/install/tests/InstallHelpers.Tests.ps1`

**Interfaces:**
- Consumes: every function from Tasks 12–14.
- Produces: the `install.ps1` script itself, plus its pure helper functions (`Get-HallInstallerConfigPath`, `Read-HallAnswer`, `Get-HallAnswers`) — defined as functions inside `install.ps1` but dot-source-testable like every other module in this plan, since `install.ps1`'s own top-level `# ----- Main -----` section only runs when invoked directly (guarded — see Step 3).

Located via `$PSScriptRoot`, never the caller's working directory (satisfies "locate the repository relative to the script itself").

- [ ] **Step 1: Write the failing test for the pure helpers**

`scripts/install/tests/InstallHelpers.Tests.ps1`:
```powershell
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")

$env:HALL_INSTALL_PS1_UNDER_TEST = "1"
. (Join-Path $PSScriptRoot ".." ".." "install.ps1")
Remove-Item Env:\HALL_INSTALL_PS1_UNDER_TEST

Assert-Throws { Get-HallInstallerConfigPath -LocalAppData "" } "an empty LOCALAPPDATA must throw, never silently resolve a relative config path"
$resolved = Get-HallInstallerConfigPath -LocalAppData "C:\Users\Test\AppData\Local"
Assert-Equal (Join-Path "C:\Users\Test\AppData\Local" "HallOfWisdom" "config.json") $resolved "Get-HallInstallerConfigPath must mirror packages/hall-config's win32 config-path convention exactly"

Assert-Equal "bound-value" (Read-HallAnswer -Prompt "x" -Default "default-value" -BoundValue "bound-value") "a bound (parameter) value must win over any prompt"
Assert-Equal "default-value" (Read-HallAnswer -Prompt "x" -Default "default-value" -NonInteractive) "-NonInteractive with no bound value must fall back to the default, never prompt"

Write-Host "  (InstallHelpers.Tests.ps1: all assertions passed)"
```

- [ ] **Step 2: Run to verify it fails**

Run: `pwsh -NoProfile -File scripts/install/tests/run-tests.ps1`
Expected: FAIL — `install.ps1` does not exist yet.

- [ ] **Step 3: Write `install.ps1`**

```powershell
<#
.SYNOPSIS
    Hall of Wisdom interactive setup — installs dependencies, builds Hall,
    collects and persists configuration, and verifies the installation.
.DESCRIPTION
    See docs/architecture/0017-persistent-hall-configuration.md. Locates
    the repository via $PSScriptRoot, never the caller's working directory.
#>
[CmdletBinding()]
param(
    [string]$WorkspaceRoot,
    [string]$DataDir,
    [string]$AgentWorktreeRoot,
    [string]$ComparisonRoot,
    [switch]$EnableCodexTrustedLocal,
    [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"
$RepoRoot = $PSScriptRoot

. (Join-Path $RepoRoot "scripts/install/Prerequisites.ps1")
. (Join-Path $RepoRoot "scripts/install/HallConfigDefaults.ps1")
. (Join-Path $RepoRoot "scripts/install/HallConfigCli.ps1")
. (Join-Path $RepoRoot "scripts/install/Verification.ps1")
. (Join-Path $RepoRoot "scripts/install/Reconfigure.ps1")

function Get-HallInstallerConfigPath {
    # Deliberately mirrors packages/hall-config/src/config-path.ts's
    # win32 branch exactly (%LOCALAPPDATA%\HallOfWisdom\config.json) — a
    # narrow, unavoidable duplication: existing-config detection must run
    # BEFORE the first build (so the reinstall/reconfigure prompt appears
    # before "Installing Hall..."), but the hall-config CLI only exists
    # after `pnpm --filter @hall-of-wisdom/hall-config run build`. If
    # config-path.ts's win32 logic ever changes, this literal must change
    # with it.
    param([string]$LocalAppData = $env:LOCALAPPDATA)
    if ([string]::IsNullOrWhiteSpace($LocalAppData)) {
        throw "LOCALAPPDATA is not set; cannot locate the Hall configuration file."
    }
    Join-Path $LocalAppData "HallOfWisdom/config.json"
}

function Write-HallBanner {
    Write-Host ""
    Write-Host "Hall of Wisdom Setup" -ForegroundColor Cyan
    Write-Host "----------------------------------------"
    Write-Host ""
}

function Test-HallPrerequisitesOrExit {
    param([Parameter(Mandatory)][string]$RepoRoot)
    Write-Host "Checking your system..."
    $versions = Get-HallRequiredVersions -RepoRoot $RepoRoot
    $checks = @(
        @{ Name = "Git"; Result = Test-HallGitPrerequisite }
        @{ Name = "Node.js"; Result = (Test-HallNodePrerequisite -RequiredRange $versions.NodeRange) }
        @{ Name = "pnpm"; Result = (Test-HallPnpmPrerequisite -RequiredVersion $versions.PnpmVersion) }
        @{ Name = "Hall repository"; Result = (Test-HallRepositoryIntegrity -RepoRoot $RepoRoot) }
    )
    $failed = $false
    foreach ($check in $checks) {
        if ($check.Result.Ok) {
            Write-Host "  [OK] $($check.Name) ($($check.Result.Message))" -ForegroundColor Green
        } else {
            Write-Host "  [FAIL] $($check.Name): $($check.Result.Message)" -ForegroundColor Red
            $failed = $true
        }
    }
    Write-Host ""
    if ($failed) {
        Write-Host "One or more prerequisites are missing. Install/upgrade the tools reported above, then run .\install.ps1 again." -ForegroundColor Red
        exit 1
    }
}

function Read-HallAnswer {
    param(
        [Parameter(Mandatory)][string]$Prompt,
        [Parameter(Mandatory)][string]$Default,
        [string]$BoundValue,
        [switch]$NonInteractive
    )
    if ($BoundValue) { return $BoundValue }
    if ($NonInteractive) { return $Default }
    $response = Read-Host "$Prompt [$Default]"
    if ([string]::IsNullOrWhiteSpace($response)) { return $Default }
    return $response
}

function Get-HallAnswers {
    param(
        [string]$BoundWorkspaceRoot,
        [string]$BoundDataDir,
        [string]$BoundAgentWorktreeRoot,
        [string]$BoundComparisonRoot,
        [bool]$BoundEnableCodexTrustedLocal,
        [switch]$NonInteractive,
        [PSCustomObject]$ExistingConfig
    )
    $defaults = Get-HallDefaultPaths

    $defaultWorkspaceRoot = if ($ExistingConfig) { $ExistingConfig.workspaceRoot } else { (Get-Location).Path }
    $workspaceRoot = Read-HallAnswer -Prompt "Projects/workspace folder" -Default $defaultWorkspaceRoot -BoundValue $BoundWorkspaceRoot -NonInteractive:$NonInteractive

    $defaultDataDir = if ($ExistingConfig -and $ExistingConfig.dataDir) { $ExistingConfig.dataDir } else { $defaults.DataDir }
    $dataDir = Read-HallAnswer -Prompt "Hall data location" -Default $defaultDataDir -BoundValue $BoundDataDir -NonInteractive:$NonInteractive

    $defaultAgentWorktreeRoot = if ($ExistingConfig -and $ExistingConfig.agentWorktreeRoot) { $ExistingConfig.agentWorktreeRoot } else { $defaults.AgentWorktreeRoot }
    $agentWorktreeRoot = Read-HallAnswer -Prompt "Agent worktree location" -Default $defaultAgentWorktreeRoot -BoundValue $BoundAgentWorktreeRoot -NonInteractive:$NonInteractive

    $defaultComparisonRoot = if ($ExistingConfig -and $ExistingConfig.comparisonRoot) { $ExistingConfig.comparisonRoot } else { $defaults.ComparisonRoot }
    $comparisonRoot = if ($BoundComparisonRoot) { $BoundComparisonRoot } else { $defaultComparisonRoot }

    $enableCodexTrustedLocal = $BoundEnableCodexTrustedLocal
    if (-not $NonInteractive -and -not $BoundEnableCodexTrustedLocal) {
        $codexResponse = Read-Host "Enable Codex trusted-local execution? [No, recommended] (y/N)"
        $enableCodexTrustedLocal = ($codexResponse -match '^(y|yes)$')
    }

    [PSCustomObject]@{
        schemaVersion     = 1
        workspaceRoot     = $workspaceRoot
        dataDir           = $dataDir
        agentWorktreeRoot = $agentWorktreeRoot
        comparisonRoot    = $comparisonRoot
        hallCorePort      = 4310
        hallWebPort       = 3000
        codexTrustedLocal = [bool]$enableCodexTrustedLocal
    }
}

function Install-HallDependenciesAndConfig {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$ConfigPath, [Parameter(Mandatory)]$Answers)
    Write-Host "Installing Hall..."
    Push-Location $RepoRoot
    try {
        & pnpm install
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (exit code $LASTEXITCODE)." }
        Write-Host "  [OK] Dependencies installed" -ForegroundColor Green

        & pnpm --filter "@hall-of-wisdom/hall-config" run build
        if ($LASTEXITCODE -ne 0) { throw "Building @hall-of-wisdom/hall-config failed (exit code $LASTEXITCODE)." }

        $saved = Invoke-HallConfigSave -RepoRoot $RepoRoot -ConfigPath $ConfigPath -Candidate $Answers
        if ($saved.ExitCode -ne 0) { throw "Saving Hall configuration failed: $($saved.Result.errors -join '; ')" }
        Write-Host "  [OK] Configuration saved ($ConfigPath)" -ForegroundColor Green

        & pnpm typecheck
        if ($LASTEXITCODE -ne 0) { throw "pnpm typecheck failed (exit code $LASTEXITCODE) — this is a blocking installation failure." }

        & pnpm build
        if ($LASTEXITCODE -ne 0) { throw "pnpm build failed (exit code $LASTEXITCODE) — this is a blocking installation failure." }
        Write-Host "  [OK] Hall Core built" -ForegroundColor Green
        Write-Host "  [OK] Hall Web built" -ForegroundColor Green
    } finally {
        Pop-Location
    }
}

function Invoke-HallInstallVerification {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)]$Answers)
    $verify = Invoke-HallVerifyOnly -RepoRoot $RepoRoot -WorkspaceRoot $Answers.workspaceRoot -DataDir $Answers.dataDir `
        -AgentWorktreeRoot $Answers.agentWorktreeRoot -ComparisonRoot $Answers.comparisonRoot -Port $Answers.hallCorePort `
        -EnableCodexTrustedLocal:([bool]$Answers.codexTrustedLocal)
    if (-not $verify.Success) {
        Write-Host "  [FAIL] Installation verification failed:" -ForegroundColor Red
        Write-Host $verify.Output -ForegroundColor Red
        exit 1
    }
    Write-Host "  [OK] Installation verified" -ForegroundColor Green
}

function Invoke-HallDiagnostics {
    param([Parameter(Mandatory)][string]$RepoRoot)
    Write-Host ""
    Write-Host "Running diagnostics (lint/test — not blocking)..."
    Push-Location $RepoRoot
    try {
        & pnpm lint
        if ($LASTEXITCODE -ne 0) { Write-Host "  [WARN] pnpm lint reported issues (non-blocking)." -ForegroundColor Yellow } else { Write-Host "  [OK] pnpm lint" -ForegroundColor Green }
        & pnpm test
        if ($LASTEXITCODE -ne 0) { Write-Host "  [WARN] pnpm test reported failures (non-blocking)." -ForegroundColor Yellow } else { Write-Host "  [OK] pnpm test" -ForegroundColor Green }
    } finally {
        Pop-Location
    }
}

function Invoke-HallInstaller {
    param([Parameter(Mandatory)][string]$RepoRoot)

    Write-HallBanner
    Test-HallPrerequisitesOrExit -RepoRoot $RepoRoot

    $configPath = Get-HallInstallerConfigPath
    $existing = $null
    if (Test-Path -LiteralPath $configPath) {
        try {
            $existing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        } catch {
            Write-Host "An existing Hall configuration was found at '$configPath' but could not be read: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "Refusing to guess — fix or remove that file manually, then run .\install.ps1 again." -ForegroundColor Red
            exit 1
        }
    }

    $mode = "install"
    if ($existing -and -not $NonInteractive) {
        Write-Host "Existing Hall configuration found."
        Write-Host "  1. Keep current configuration and verify/repair installation"
        Write-Host "  2. Reconfigure Hall"
        Write-Host "  3. Cancel"
        $choice = Read-Host "Choose an option [1]"
        switch ($choice) {
            "2" { $mode = "reconfigure" }
            "3" { Write-Host "Cancelled."; exit 0 }
            default { $mode = "keep" }
        }
    } elseif ($existing -and $NonInteractive) {
        $mode = "reconfigure"
    }

    if ($mode -eq "keep") {
        Install-HallDependenciesAndConfig -RepoRoot $RepoRoot -ConfigPath $configPath -Answers $existing
        Invoke-HallInstallVerification -RepoRoot $RepoRoot -Answers $existing
        Invoke-HallDiagnostics -RepoRoot $RepoRoot
        Write-Host ""; Write-Host "Hall of Wisdom is ready." -ForegroundColor Cyan
        return
    }

    $answers = Get-HallAnswers -BoundWorkspaceRoot $WorkspaceRoot -BoundDataDir $DataDir -BoundAgentWorktreeRoot $AgentWorktreeRoot `
        -BoundComparisonRoot $ComparisonRoot -BoundEnableCodexTrustedLocal ([bool]$EnableCodexTrustedLocal) -NonInteractive:$NonInteractive -ExistingConfig $existing

    if ($mode -eq "reconfigure") {
        Push-Location $RepoRoot
        try {
            & pnpm install
            if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (exit code $LASTEXITCODE)." }
            & pnpm build
            if ($LASTEXITCODE -ne 0) { throw "pnpm build failed (exit code $LASTEXITCODE) — cannot verify a reconfiguration candidate without a build." }
        } finally {
            Pop-Location
        }
        $result = Invoke-HallReconfigure -RepoRoot $RepoRoot -ConfigPath $configPath -Candidate $answers
        if (-not $result.Success) {
            Write-Host "Reconfiguration failed at stage '$($result.Stage)':" -ForegroundColor Red
            $result.Errors | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
            Write-Host "The previous configuration at '$configPath' was left untouched." -ForegroundColor Yellow
            exit 1
        }
        Write-Host "  [OK] Configuration reconfigured and verified" -ForegroundColor Green
        Invoke-HallDiagnostics -RepoRoot $RepoRoot
        Write-Host ""; Write-Host "Hall of Wisdom is ready." -ForegroundColor Cyan
        return
    }

    Install-HallDependenciesAndConfig -RepoRoot $RepoRoot -ConfigPath $configPath -Answers $answers
    Invoke-HallInstallVerification -RepoRoot $RepoRoot -Answers $answers
    Invoke-HallDiagnostics -RepoRoot $RepoRoot
    Write-Host ""; Write-Host "Hall of Wisdom is ready." -ForegroundColor Cyan
}

# Guard so this file can be dot-sourced (for testing the pure helper
# functions above, or by run-tests.ps1's fixtures) without immediately
# running the full interactive installer.
if (-not $env:HALL_INSTALL_PS1_UNDER_TEST) {
    Invoke-HallInstaller -RepoRoot $RepoRoot
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pwsh -NoProfile -File scripts/install/tests/run-tests.ps1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add install.ps1 scripts/install/tests/InstallHelpers.Tests.ps1
git commit -m "feat(install): install.ps1 main entrypoint — prompts, install, verify, reconfigure"
```

---

### Task 16: End-to-end `install.ps1 -NonInteractive` smoke test

**Files:**
- Create: `scripts/install/tests/end-to-end-smoke-test.ps1`

Deliberately **not** named `*.Tests.ps1` — `run-tests.ps1` (Task 12) only picks up that pattern, and this script runs the real `pnpm install`/`build`/`lint`/`test` pipeline (genuinely slow, and it's the concrete "manual installer verification" this phase's completion criteria requires — invoked explicitly, not part of the fast unit-test loop).

- [ ] **Step 1: Write the smoke test**

```powershell
<#
.SYNOPSIS
    End-to-end smoke test for install.ps1 -NonInteractive, run against
    fully disposable directories (including a fake LOCALAPPDATA, so the
    real user profile's Hall configuration is never touched).
.DESCRIPTION
    Run explicitly: pwsh -NoProfile -File scripts/install/tests/end-to-end-smoke-test.ps1
#>
$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$installPs1 = Join-Path $repoRoot "install.ps1"

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-e2e-smoke-$([guid]::NewGuid())"
$fakeLocalAppData = Join-Path $tempRoot "LocalAppData"
$workspaceRoot = Join-Path $tempRoot "workspace"
$dataDir = Join-Path $tempRoot "data"
$agentWorktreeRoot = Join-Path $tempRoot "agent-worktrees"
$comparisonRoot = Join-Path $tempRoot "comparisons"
New-Item -ItemType Directory -Path $fakeLocalAppData, $workspaceRoot -Force | Out-Null

$originalLocalAppData = $env:LOCALAPPDATA
try {
    $env:LOCALAPPDATA = $fakeLocalAppData

    & pwsh -NoProfile -File $installPs1 `
        -WorkspaceRoot $workspaceRoot `
        -DataDir $dataDir `
        -AgentWorktreeRoot $agentWorktreeRoot `
        -ComparisonRoot $comparisonRoot `
        -NonInteractive
    if ($LASTEXITCODE -ne 0) {
        throw "install.ps1 -NonInteractive exited $LASTEXITCODE"
    }

    $configPath = Join-Path $fakeLocalAppData "HallOfWisdom/config.json"
    if (-not (Test-Path -LiteralPath $configPath)) {
        throw "Expected config file was not written at '$configPath'."
    }
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.workspaceRoot -ne $workspaceRoot) {
        throw "Persisted workspaceRoot '$($config.workspaceRoot)' does not match the requested '$workspaceRoot'."
    }
    if ($config.comparisonRoot -ne $comparisonRoot) {
        throw "Persisted comparisonRoot was not saved as the requested value (Correction 2)."
    }

    # The actual completion criterion: Hall Core now starts with ZERO
    # flags, reading everything from the just-saved persisted config.
    $serverDist = Join-Path $repoRoot "apps/server/dist/server.js"
    $proc = Start-Process -FilePath "node" -ArgumentList @($serverDist, "--verify-only") -NoNewWindow -PassThru -Wait
    if ($proc.ExitCode -ne 0) {
        throw "node dist/server.js --verify-only (zero flags) exited $($proc.ExitCode) — Hall Core did not start cleanly from persisted config alone."
    }

    # Re-running install.ps1 -NonInteractive against the SAME LOCALAPPDATA
    # must take the reconfigure path and succeed idempotently — never
    # destroy the SQLite database it just verified above.
    & pwsh -NoProfile -File $installPs1 `
        -WorkspaceRoot $workspaceRoot `
        -DataDir $dataDir `
        -AgentWorktreeRoot $agentWorktreeRoot `
        -ComparisonRoot $comparisonRoot `
        -NonInteractive
    if ($LASTEXITCODE -ne 0) {
        throw "second install.ps1 -NonInteractive run (idempotent reconfigure) exited $LASTEXITCODE"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $dataDir "hall-core.db"))) {
        throw "SQLite database (hall-core.db, see apps/server/src/persistence/database.ts's DATABASE_FILE_NAME) appears to have been removed by a reconfigure run — this must never happen."
    }

    Write-Host "End-to-end install.ps1 smoke test PASSED." -ForegroundColor Green
} finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
```

- [ ] **Step 2: Run it**

Run: `pwsh -NoProfile -File scripts/install/tests/end-to-end-smoke-test.ps1`
Expected: `End-to-end install.ps1 smoke test PASSED.` (this is the "manually exercise install.ps1 using safe disposable directories" verification the phase requires — record its output in the final phase report).

- [ ] **Step 3: Commit**

```bash
git add scripts/install/tests/end-to-end-smoke-test.ps1
git commit -m "test(install): end-to-end install.ps1 -NonInteractive smoke test"
```

---

### Task 17: README — point to `install.ps1` as the primary path

**Files:**
- Modify: `README.md`

Minimal correction only, per Global Constraints — the full rewrite is Phase 17.4. Only fix what would otherwise mislead a new user now that `install.ps1` exists.

- [ ] **Step 1: Add a short "Recommended: interactive setup" note**

In `README.md`, immediately after the "Installation / Quick Start" heading and its prerequisites list, before the existing `git clone` / manual `pnpm install` code block, insert:
```markdown
**Recommended for most Windows users:** clone the repository, then run `.\install.ps1` from the
repository root. It checks prerequisites, prompts for your workspace/data/agent-worktree
locations, installs dependencies, builds Hall, saves your configuration, and verifies the
installation — see
[`docs/architecture/0017-persistent-hall-configuration.md`](docs/architecture/0017-persistent-hall-configuration.md).
Once you've run it, Hall Core no longer needs any of the manual `--workspace-root` /
`--data-dir` / `--agent-worktree-root` flags shown below.

The manual steps below remain fully supported for development and are still how you'd start Hall
Core with CLI flags that override your saved configuration for a single run.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: point README at install.ps1 as the primary Windows setup path"
```

---

### Task 18: Full workspace verification, phase completion report, and final commit

**Files:** none created; this task runs the repository's quality gates end to end and writes the completion report the project's phase-report convention (`AGENTS.md`) requires.

- [ ] **Step 1: Run the full verification suite from the repo root**

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm verify:process-recovery
pnpm verify:package-entry
```
Every command must succeed. If any fails, use `superpowers:systematic-debugging` to determine whether it's a Phase 17.1 regression (fix it, re-run from Step 1), a pre-existing baseline problem unrelated to this phase's changes (confirm via `git stash` + re-run on the pre-Phase-17.1 commit `d03ed4f04f77d411a17614ca0f625face70e62a2` before concluding this), or an environment/tooling issue (report it explicitly, do not paper over it with a timeout increase or a skipped test).

- [ ] **Step 2: Run the PowerShell suites**

```powershell
pwsh -NoProfile -File scripts/install/tests/run-tests.ps1
pwsh -NoProfile -File scripts/install/tests/end-to-end-smoke-test.ps1
```
Both must succeed. Also run PowerShell's own syntax check over every new script (`Get-Command -Syntax` alone doesn't parse a whole file — use `[System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors)` for each of `install.ps1` and every `scripts/install/*.ps1` file, asserting `$errors.Count -eq 0`; if `PSScriptAnalyzer` happens to already be installed in this environment, also run `Invoke-ScriptAnalyzer` over the same files and report — but do not install it as a new dependency per Global Constraints).

- [ ] **Step 3: Security/quality self-review pass**

Confirm, by rereading the actual final code (not from memory):
- No `Invoke-Expression` anywhere in `install.ps1`/`scripts/install/*.ps1`.
- No shell-string concatenation for any spawned process's arguments — every `node`/`pnpm`/`git` invocation in this phase's new/changed files uses an argument array or discrete positional arguments.
- No provider credential/token/cookie/auth-file handling anywhere in this phase's new code.
- `packages/hall-config`'s `HallConfigSchema` has no field that could ever hold a secret.
- `--verify-only` truly never calls `runRestartRecovery`, CEO plan recovery, agent-worktree reconciliation, or `app.listen()` — grep `apps/server/src/verify-only/run-verify-only.ts` to confirm none of those identifiers appear there.
- `Invoke-HallReconfigure` never calls `Invoke-HallConfigSave` before `Invoke-HallVerifyOnly` has returned success — reread `scripts/install/Reconfigure.ps1`'s control flow directly.
- Reinstall/reconfigure never deletes `hall.db`/worktrees — grep for `Remove-Item`/`rm`/`del` across `scripts/install/` and `install.ps1`; there should be none touching `dataDir`/`agentWorktreeRoot`.

Fix anything this pass finds before proceeding.

- [ ] **Step 4: Inspect the complete diff before committing**

```bash
git status
git diff --stat phase-17-1-interactive-installer d03ed4f04f77d411a17614ca0f625face70e62a2
```
Confirm no secrets, generated data (`dist/`, `node_modules/`), databases, local config, logs, worktrees, or personal paths are staged. `pnpm-lock.yaml` changes from the new `hall-config` workspace member are expected and correct to include.

- [ ] **Step 5: Final commit (if Step 3 produced fixes not yet committed)**

```bash
git add -A
git status
```
Review the staged list one more time before committing; commit any final fixes with a clear message. Do not merge to `main` (per Global Constraints).

- [ ] **Step 6: Write the phase completion report**

Per `AGENTS.md`'s required end-of-phase report format, produce a report containing exactly these sections: Phase Completed, What Was Implemented, Files Created or Changed, Commands Executed, Test Results, Security and Bug Review, How to Verify, Expected Output, Git Status, Next Proposed Phase, and end with a `STOPPED` line (no auto-continuation into Phase 17.2). Include, per the original Phase 17.1 kickoff's "Final report" requirements specifically:
- Starting branch/SHA (`main` / `d03ed4f04f77d411a17614ca0f625face70e62a2`) and resulting branch/SHA (`phase-17-1-interactive-installer` / the final commit from Step 5).
- The persistent config architecture and file locations (from ADR 0017).
- Installer UX and supported operations (install / keep-and-verify / reconfigure / cancel).
- Prerequisite behavior, reinstall/reconfigure behavior, CLI/config precedence rule.
- Phase 16 fingerprint compatibility (explicitly confirm it was reused unmodified).
- Security guarantees (from Step 3's review).
- Tests added (list every new test file from Tasks 1–16).
- Exact verification commands and results (from Steps 1–2).
- Manual installer verification performed (the Task 16 smoke test's actual output).
- Files/ADRs added or changed.
- Known limitations (at minimum: `apps/web`'s hardcoded port-3000 scripts, deferred to Phase 17.3).
- Explicit confirmation that Phase 17.2 (provider-login UI) was not started.
