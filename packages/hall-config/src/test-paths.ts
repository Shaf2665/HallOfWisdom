import os from "node:os";
import path from "node:path";

const TEST_ROOT = path.join(os.tmpdir(), "hall-config-test-paths");

export const TEST_WORKSPACE_ROOT = path.join(TEST_ROOT, "HallOfWisdom");
export const TEST_DATA_DIR = path.join(TEST_ROOT, "HallOfWisdomData");
export const TEST_AGENT_WORKTREE_ROOT = path.join(TEST_ROOT, "HallOfWisdomAgentWorktrees");
export const TEST_COMPARISON_ROOT = path.join(TEST_ROOT, "HallOfWisdomComparisons");
export const TEST_CONFIG_DIR = path.join(TEST_ROOT, "HallConfig");
