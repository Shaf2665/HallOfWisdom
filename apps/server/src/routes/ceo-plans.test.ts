import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CEO_PLAN_EXECUTION_POLICY } from "@hall-of-wisdom/protocol";
import {
  buildTestApp,
  validDeferredTaskBody,
  type CreateTaskResponseJson,
} from "../test-support.js";

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-ceo-plan-routes-test-"));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function buildApp() {
  return buildTestApp({ workspaceRoot: tempRoot });
}

async function createParentTask(app: Awaited<ReturnType<typeof buildApp>>["app"]): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: validDeferredTaskBody({
      description: "Fix the login redirect: it goes to /404 instead of /dashboard.",
      requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
    }),
  });
  return response.json<CreateTaskResponseJson>().task.taskId;
}

interface PlanJson {
  readonly id: string;
  readonly status: string;
  readonly activeVersion: number;
}
interface PlanVersionJson {
  readonly version: number;
  readonly contentHash: string;
  readonly steps: readonly { readonly id: string }[];
}

/** The plan-level `expectedMutationToken` a real browser would echo back — via `GET .../ceo-plans/:planId`, exactly as `CeoPlanDetail` does, never hardcoded — see `apps/web/lib/api-schemas.ts`'s `getCeoPlanResponseSchema`. */
async function fetchMutationToken(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  planId: string,
): Promise<string> {
  const response = await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${planId}` });
  return response.json<{ mutationToken: string }>().mutationToken;
}

describe("CEO plan REST routes", () => {
  it("POST /api/v1/tasks/:taskId/ceo-plans creates a draft plan (201) and never creates a child task", async () => {
    const { app, harness } = await buildApp();
    const taskId = await createParentTask(app);
    const before = harness.taskStore.list().length;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/ceo-plans`,
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ plan: PlanJson; version: PlanVersionJson }>();
    expect(body.plan.status).toBe("draft");
    expect(body.version.version).toBe(1);
    expect(harness.taskStore.list().length).toBe(before);
    await app.close();
  });

  it("returns 404 for an unknown parent task", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/does-not-exist/ceo-plans",
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns 422 (CEO_PLANNING_BLOCKED) when the parent task has no description", async () => {
    const { app } = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validDeferredTaskBody(),
    });
    const taskId = created.json<CreateTaskResponseJson>().task.taskId;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/ceo-plans`,
      payload: {},
    });
    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("CEO_PLANNING_BLOCKED");
    await app.close();
  });

  it("GET /api/v1/ceo-plans/:planId returns the plan with derived progress and links, and an opaque mutation token — never an internal revision", async () => {
    const { app } = await buildApp();
    const taskId = await createParentTask(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/ceo-plans`,
      payload: {},
    });
    const planId = created.json<{ plan: PlanJson }>().plan.id;

    const response = await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${planId}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/"revision"/);
    expect(response.body).not.toMatch(/"internalRevision"/);
    const body = response.json<{
      plan: PlanJson;
      progress: { totalSteps: number };
      links: unknown[];
      mutationToken: string;
    }>();
    expect(body.plan.id).toBe(planId);
    expect(body.links).toEqual([]);
    // A browser landing cold on this page has no other way to learn the
    // value it must echo back as `expectedMutationToken` on its first
    // mutating call — see `CeoPlanOrchestrator.getMutationToken`'s doc
    // comment. The token is opaque (a fixed-length base64url digest), so
    // this only asserts shape, never a specific value.
    expect(body.mutationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await app.close();
  });

  it("no CEO-plan response body, at any stage of the lifecycle, ever contains a `revision` or `internalRevision` field", async () => {
    const { app } = await buildApp();
    const taskId = await createParentTask(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/ceo-plans`,
      payload: {},
    });
    const planId = created.json<{ plan: PlanJson }>().plan.id;

    const bodiesToCheck = [created.body];
    bodiesToCheck.push(
      (await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${planId}` })).body,
    );
    bodiesToCheck.push((await app.inject({ method: "GET", url: "/api/v1/ceo-plans" })).body);
    bodiesToCheck.push(
      (await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${planId}/versions` })).body,
    );
    bodiesToCheck.push(
      (await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${planId}/versions/1` })).body,
    );
    bodiesToCheck.push(
      (await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${planId}/approvals` })).body,
    );
    bodiesToCheck.push(
      (await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${planId}/events` })).body,
    );

    for (const body of bodiesToCheck) {
      expect(body).not.toMatch(/"revision"/);
      expect(body).not.toMatch(/"internalRevision"/);
    }
    await app.close();
  });

  it("full happy path over HTTP: create -> submit -> approve -> delegate, correct status codes throughout, and approval alone starts nothing", async () => {
    const { app, harness } = await buildApp();
    const taskId = await createParentTask(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/ceo-plans`,
      payload: {},
    });
    const { plan } = created.json<{ plan: PlanJson; version: PlanVersionJson }>();
    const tokenAtCreate = await fetchMutationToken(app, plan.id);

    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${plan.id}/submit`,
      payload: { expectedMutationToken: tokenAtCreate },
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json<PlanJson>().status).toBe("awaiting_approval");
    const tokenAfterSubmit = await fetchMutationToken(app, plan.id);
    expect(tokenAfterSubmit).not.toBe(tokenAtCreate);

    const versionResponse = await app.inject({
      method: "GET",
      url: `/api/v1/ceo-plans/${plan.id}/versions/1`,
    });
    const version = versionResponse.json<PlanVersionJson>();

    const beforeApproval = harness.taskStore.list().length;
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${plan.id}/approve`,
      payload: {
        expectedMutationToken: tokenAfterSubmit,
        planVersion: 1,
        contentHash: version.contentHash,
      },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json<{ plan: PlanJson }>().plan.status).toBe("approved");
    // Approval alone starts nothing.
    expect(harness.taskStore.list().length).toBe(beforeApproval);
    const tokenAfterApprove = await fetchMutationToken(app, plan.id);
    expect(tokenAfterApprove).not.toBe(tokenAfterSubmit);

    const delegated = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${plan.id}/delegate`,
      payload: { expectedMutationToken: tokenAfterApprove },
    });
    expect(delegated.statusCode).toBe(202);
    const delegateBody = delegated.json<{
      plan: PlanJson;
      childTasks: readonly { task: { taskId: string; status: string } }[];
    }>();
    expect(delegateBody.plan.status).toBe("delegated");
    expect(delegateBody.childTasks.length).toBeGreaterThan(0);
    for (const childTask of delegateBody.childTasks) {
      expect(childTask.task.status).toBe("assigned");
    }
    await app.close();
  });

  it("returns 409 for a stale-but-well-formed expectedMutationToken (a real token that has since been superseded)", async () => {
    const { app } = await buildApp();
    const taskId = await createParentTask(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/ceo-plans`,
      payload: {},
    });
    const { plan } = created.json<{ plan: PlanJson }>();
    const staleToken = await fetchMutationToken(app, plan.id);

    // Advance the revision once, so `staleToken` is now genuinely stale.
    await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${plan.id}/submit`,
      payload: { expectedMutationToken: staleToken },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${plan.id}/submit`,
      payload: { expectedMutationToken: staleToken },
    });
    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it("returns 400 for a malformed expectedMutationToken", async () => {
    const { app } = await buildApp();
    const taskId = await createParentTask(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/ceo-plans`,
      payload: {},
    });
    const { plan } = created.json<{ plan: PlanJson }>();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${plan.id}/submit`,
      payload: { expectedMutationToken: "not-a-real-token" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("returns 400 for an invalid submit body (missing expectedMutationToken)", async () => {
    const { app } = await buildApp();
    const taskId = await createParentTask(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/ceo-plans`,
      payload: {},
    });
    const { plan } = created.json<{ plan: PlanJson }>();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${plan.id}/submit`,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("never lets the client force delegation before approval — 409, zero child tasks, even with a genuinely valid mutation token", async () => {
    const { app, harness } = await buildApp();
    const taskId = await createParentTask(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/ceo-plans`,
      payload: {},
    });
    const { plan } = created.json<{ plan: PlanJson }>();
    const before = harness.taskStore.list().length;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${plan.id}/delegate`,
      payload: { expectedMutationToken: await fetchMutationToken(app, plan.id) },
    });
    expect(response.statusCode).toBe(409);
    expect(harness.taskStore.list().length).toBe(before);
    await app.close();
  });

  it("DELETE /api/v1/ceo-plans/:planId permanently removes a cancelled plan but preserves its parent task", async () => {
    const { app, harness } = await buildApp();
    const taskId = await createParentTask(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/ceo-plans`,
      payload: {},
    });
    const { plan } = created.json<{ plan: PlanJson }>();
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${plan.id}/cancel`,
      payload: { expectedMutationToken: await fetchMutationToken(app, plan.id) },
    });
    expect(cancelled.statusCode).toBe(200);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/ceo-plans/${plan.id}`,
      payload: { expectedMutationToken: await fetchMutationToken(app, plan.id) },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${plan.id}` })).statusCode,
    ).toBe(404);
    expect(harness.taskStore.get(taskId).task.taskId).toBe(taskId);
    await app.close();
  });

  it("rejects deletion for an active plan", async () => {
    const { app } = await buildApp();
    const taskId = await createParentTask(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/ceo-plans`,
      payload: {},
    });
    const { plan } = created.json<{ plan: PlanJson }>();

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/ceo-plans/${plan.id}`,
      payload: { expectedMutationToken: await fetchMutationToken(app, plan.id) },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CEO_PLAN_STATE_CONFLICT");
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${plan.id}` })).statusCode,
    ).toBe(200);
    await app.close();
  });

  it("rejects deletion of a cancelled plan that has execution history", async () => {
    const { app, harness } = await buildApp();
    const taskId = await createParentTask(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/ceo-plans`,
      payload: {},
    });
    const { plan } = created.json<{ plan: PlanJson }>();
    await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${plan.id}/cancel`,
      payload: { expectedMutationToken: await fetchMutationToken(app, plan.id) },
    });
    harness.ceoExecution.planRunStore.configureRun({
      runId: "history-run-1",
      planId: plan.id,
      planVersion: 1,
      executionMode: "manual",
      policy: DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      now: "2026-08-11T00:00:00.000Z",
      steps: [],
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/ceo-plans/${plan.id}`,
      payload: { expectedMutationToken: await fetchMutationToken(app, plan.id) },
    });
    expect(response.statusCode).toBe(409);
    const error = response.json<{ error: { code: string; message: string } }>().error;
    expect(error.code).toBe("CEO_PLAN_DELETION_BLOCKED");
    expect(error.message).toContain("execution history");
    expect(harness.ceoExecution.planRunStore.getRun("history-run-1").planId).toBe(plan.id);
    await app.close();
  });

  it("GET /api/v1/ceo-plans lists every plan; GET .../events replays the append-only event stream", async () => {
    const { app } = await buildApp();
    const taskId = await createParentTask(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/ceo-plans`,
      payload: {},
    });
    const { plan } = created.json<{ plan: PlanJson }>();

    const list = await app.inject({ method: "GET", url: "/api/v1/ceo-plans" });
    expect(list.json<{ plans: PlanJson[] }>().plans.some((p) => p.id === plan.id)).toBe(true);

    const events = await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${plan.id}/events` });
    const eventBody = events.json<{ events: { type: string }[] }>();
    expect(eventBody.events.some((e) => e.type === "ceo.plan.created")).toBe(true);
    await app.close();
  });
});
