import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { agentAdapterDescriptorSchema, type AgentAdapterDescriptor } from "./descriptor.js";
import { agentDetectionResultSchema, type AgentDetectionResult } from "./detection.js";
import { agentTaskInputSchema, type AgentTaskInput } from "./task-input.js";

type Equal<A, B> =
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- standard type-equality idiom, T is intentionally used once per branch
  (<T>() => T extends A ? 1 : 0) extends <T>() => T extends B ? 1 : 0 ? true : false;
type Expect<T extends true> = T;

type _DescriptorAligned = Expect<
  Equal<AgentAdapterDescriptor, z.infer<typeof agentAdapterDescriptorSchema>>
>;
type _DetectionAligned = Expect<
  Equal<AgentDetectionResult, z.infer<typeof agentDetectionResultSchema>>
>;
type _TaskInputAligned = Expect<Equal<AgentTaskInput, z.infer<typeof agentTaskInputSchema>>>;

describe("schema/type alignment", () => {
  it("has no runtime assertions beyond the compile-time checks above", () => {
    expect(true).toBe(true);
  });
});
