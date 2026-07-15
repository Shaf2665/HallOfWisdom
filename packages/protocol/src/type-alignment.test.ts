import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { agentIdentitySchema, type AgentIdentity } from "./agent-identity.js";
import { hallTaskSchema, type HallTask } from "./task.js";
import { agentRunSchema, type AgentRun } from "./agent-run.js";
import {
  normalizedAgentEventSchema,
  runCancelledEventSchema,
  type NormalizedAgentEvent,
  type RunCancelledEvent,
} from "./events.js";

/**
 * Type-level equality check. If an exported type is ever hand-edited to
 * diverge from `z.infer<typeof schema>`, one of the `Expect<...>` lines
 * below fails to compile, catching schema/type drift at typecheck time
 * rather than at runtime.
 */
type Equal<A, B> =
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- standard type-equality idiom, T is intentionally used once per branch
  (<T>() => T extends A ? 1 : 0) extends <T>() => T extends B ? 1 : 0 ? true : false;
type Expect<T extends true> = T;

type _HallTaskAligned = Expect<Equal<HallTask, z.infer<typeof hallTaskSchema>>>;
type _AgentIdentityAligned = Expect<Equal<AgentIdentity, z.infer<typeof agentIdentitySchema>>>;
type _AgentRunAligned = Expect<Equal<AgentRun, z.infer<typeof agentRunSchema>>>;
type _NormalizedAgentEventAligned = Expect<
  Equal<NormalizedAgentEvent, z.infer<typeof normalizedAgentEventSchema>>
>;
type _RunCancelledEventAligned = Expect<
  Equal<RunCancelledEvent, z.infer<typeof runCancelledEventSchema>>
>;

describe("schema/type alignment", () => {
  it("accepts a HallTask-typed literal through the runtime schema", () => {
    const task: HallTask = {
      taskId: "task-1",
      projectId: "project-1",
      title: "Add login page",
      description: "Implement the login page per the design spec.",
      priority: "normal",
      status: "backlog",
      dependencyTaskIds: [],
      createdAt: "2026-07-15T12:00:00.000Z",
      updatedAt: "2026-07-15T12:00:00.000Z",
    };
    expect(hallTaskSchema.safeParse(task).success).toBe(true);
  });
});
