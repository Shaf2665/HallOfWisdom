import assert from "node:assert/strict";

const hermesRouterAdapter = await import("@hall-of-wisdom/hermes-router-adapter");

assert.equal(typeof hermesRouterAdapter.HermesRouterAdapter, "function");
assert.equal(typeof hermesRouterAdapter.startHermesExecutionTransport, "function");
assert.equal(typeof hermesRouterAdapter.HermesJsonlParser, "function");
assert.equal(hermesRouterAdapter.hermesRouterDescriptor.adapterId, "hall.hermes-router");
assert.equal(hermesRouterAdapter.hermesRouterDescriptor.supportedAgent.agentId, "hermes-router");

const adapter = new hermesRouterAdapter.HermesRouterAdapter({ parentEnv: {} });
const detection = await adapter.detect();
assert.equal(detection.availability, "unavailable");
assert.equal(detection.executionTrust, "unavailable");

console.log(
  "OK: @hall-of-wisdom/hermes-router-adapter resolves and fails closed through its public entry point.",
);
