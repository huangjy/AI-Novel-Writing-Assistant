const test = require("node:test"), assert = require("node:assert/strict");
const express = require("express");
const { once } = require("node:events");
const { fixture } = require("./fixtures.cjs");
const { createAuthorizationRouter } = require("../../dist/modules/authorization/http/authorizationRoutes");
const { authMiddleware } = require("../../dist/middleware/auth");
const { errorHandler } = require("../../dist/middleware/errorHandler");

test("authorization management inherits app protection and never provides a public inference route", async t => {
  const previous = process.env.AI_NOVEL_ACCESS_TOKEN;
  process.env.AI_NOVEL_ACCESS_TOKEN = "app-test-token";
  t.after(() => { if (previous === undefined) delete process.env.AI_NOVEL_ACCESS_TOKEN; else process.env.AI_NOVEL_ACCESS_TOKEN = previous; });
  const f = fixture(); t.after(() => f.service.close());
  const app = express(); app.use(express.json()); app.use("/api", authMiddleware);
  app.use("/api/authorization", createAuthorizationRouter(f.service)); app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/authorization`;
  const denied = await fetch(`${base}/accounts/github-copilot/login-sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: "denied-request" }),
  });
  assert.equal(denied.status, 401); assert.equal(f.counters.device, 0); assert.equal(f.store.record, null);
  const headers = { authorization: "Bearer app-test-token", "content-type": "application/json" };
  const status = await fetch(`${base}/accounts/github-copilot`, { headers });
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.equal((await status.json()).data.state, "signed_out");
  const refreshDenied = await fetch(`${base}/accounts/github-copilot/refresh-models`, { method: "POST", headers, body: "{}" });
  assert.equal(refreshDenied.status, 409);
  assert.equal((await refreshDenied.json()).code, "COPILOT_AUTH_REQUIRED");
  const started = await fetch(`${base}/accounts/github-copilot/login-sessions`, {
    method: "POST", headers, body: JSON.stringify({ idempotencyKey: "allowed-request" }),
  });
  const payload = await started.json();
  assert.equal(payload.data.userCode, "VISIBLE-CODE");
  assert.ok(!JSON.stringify(payload).includes("device-secret"));
  await f.service.poll(payload.data.id);
  let explicitRefreshes = 0;
  f.service.setAuthorizedHandler(async () => { explicitRefreshes++; });
  const refresh = await fetch(`${base}/accounts/github-copilot/refresh-models`, { method: "POST", headers, body: "{}" });
  assert.equal(refresh.status, 200);
  assert.equal(explicitRefreshes, 1);
  await f.service.logout(1);
  f.gateway.userId = "456";
  const switched = await fetch(`${base}/accounts/github-copilot/login-sessions`, {
    method: "POST", headers, body: JSON.stringify({ idempotencyKey: "confirmed-account-switch", replaceAccount: true }),
  });
  assert.equal(switched.status, 200);
  const switchSession = (await switched.json()).data;
  await f.service.poll(switchSession.id);
  assert.equal(f.service.session(switchSession.id).state, "succeeded");
  assert.equal(f.store.record.githubUserId, "456", "HTTP must forward the explicit switch confirmation");
  const absent = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: "{}" });
  assert.equal(absent.status, 404);
});
