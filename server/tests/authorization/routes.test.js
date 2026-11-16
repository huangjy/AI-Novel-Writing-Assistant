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
  const started = await fetch(`${base}/accounts/github-copilot/login-sessions`, {
    method: "POST", headers, body: JSON.stringify({ idempotencyKey: "allowed-request" }),
  });
  const payload = await started.json();
  assert.equal(payload.data.userCode, "VISIBLE-CODE");
  assert.ok(!JSON.stringify(payload).includes("device-secret"));
  const absent = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: "{}" });
  assert.equal(absent.status, 404);
});
