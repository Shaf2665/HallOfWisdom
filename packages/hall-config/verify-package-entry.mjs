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
