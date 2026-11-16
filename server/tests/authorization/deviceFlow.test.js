const test = require("node:test"), assert = require("node:assert/strict");
const { fixture } = require("./fixtures.cjs");
const { CopilotError } = require("../../dist/modules/authorization/domain/contracts");

test("login is idempotent and keeps secret tokens out of every public projection", async t => {
  const f = fixture(); t.after(() => f.service.close());
  const [a, b] = await Promise.all([f.service.start("same-request"), f.service.start("same-request")]);
  assert.equal(a.id, b.id); assert.equal(f.counters.device, 1);
  assert.equal(a.userCode, "VISIBLE-CODE");
  assert.ok(!JSON.stringify(a).includes("device-secret"));
  await f.service.poll(a.id);
  assert.equal(f.service.session(a.id).state, "succeeded");
  const summary = await f.service.summary();
  assert.equal(summary.state, "authorized");
  assert.equal(summary.credentialRevision, 1);
  assert.ok(!JSON.stringify(summary).includes("secret-sentinel"));
  assert.ok(!f.store.record.encryptedCredential.includes("oauth-secret"));
  assert.equal((await f.service.start("same-request")).id, a.id);
  const before = { ...f.counters };
  await f.service.summary(); f.service.session(a.id);
  assert.deepEqual(f.counters, before, "GET projections have no remote side effects");
});

test("pending and slow_down honor upstream spacing; cancelled and expired flows do not commit", async t => {
  const f = fixture(); t.after(() => f.service.close());
  const session = await f.service.start("pending-request");
  f.gateway.pollResult = { pending: true, slowDown: true };
  await f.service.poll(session.id);
  assert.equal(f.service.session(session.id).pollIntervalMs, 10000);
  assert.equal(f.timers.at(-1).delay, 10000);
  f.service.cancel(session.id);
  await f.service.poll(session.id);
  assert.equal(f.counters.poll, 1);
  assert.equal(f.store.record.state, "signed_out");
  const expired = await f.service.start("expired-request");
  f.advance(901000);
  await f.service.poll(expired.id);
  assert.equal(f.service.session(expired.id).state, "expired");
  assert.equal(f.counters.poll, 1);
});

test("denial, failed subscription and a different identity preserve existing authorization", async t => {
  const f = fixture(); t.after(() => f.service.close());
  const first = await f.service.start("first-request"); await f.service.poll(first.id);
  const original = structuredClone(f.store.record);
  f.gateway.pollDevice = async () => { throw new CopilotError("COPILOT_LOGIN_DENIED", "拒绝"); };
  const denied = await f.service.start("denied-request"); await f.service.poll(denied.id);
  assert.equal(f.service.session(denied.id).state, "denied");
  assert.deepEqual(f.store.record, original);
  f.gateway.pollDevice = async () => ({ token: "different-secret" });
  f.gateway.userId = "456";
  const conflict = await f.service.start("conflict-request"); await f.service.poll(conflict.id);
  assert.equal(f.service.session(conflict.id).code, "COPILOT_ACCOUNT_CONFLICT");
  assert.deepEqual(f.store.record, original);
  f.gateway.exchange = async () => { throw new CopilotError("COPILOT_ACCESS_DENIED", "订阅拒绝", 403); };
  const invalid = await f.service.start("invalid-request"); await f.service.poll(invalid.id);
  assert.equal(f.service.session(invalid.id).code, "COPILOT_ACCESS_DENIED");
  assert.deepEqual(f.store.record, original);
});

test("logout rejects stale versions and fences late login callbacks", async t => {
  const f = fixture(); t.after(() => f.service.close());
  const first = await f.service.start("first-request"); await f.service.poll(first.id);
  await assert.rejects(() => f.service.logout(0), { code: "COPILOT_REVISION_CONFLICT" });
  let release;
  f.gateway.pollDevice = () => new Promise(resolve => { release = resolve; });
  const pending = await f.service.start("late-request");
  const operation = f.service.poll(pending.id);
  await f.service.logout(1);
  release({ token: "late-secret" }); await operation;
  assert.equal(f.service.session(pending.id).state, "cancelled");
  assert.equal(f.store.record.state, "signed_out");
  assert.equal(f.store.record.encryptedCredential, null);
  assert.equal(f.store.record.credentialRevision, 2);
  await assert.rejects(() => f.credentials.access(), { code: "COPILOT_AUTH_REQUIRED" });
});

test("shared token refresh survives one waiter's cancellation and catalog failure preserves authorization", async t => {
  const f = fixture(); t.after(() => f.service.close());
  const first = await f.service.start("first-request"); await f.service.poll(first.id);
  f.credentials.invalidateToken();
  let release;
  f.gateway.exchange = async () => { f.counters.exchange++; return new Promise(resolve => { release = resolve; }); };
  const cancel = new AbortController();
  const one = f.credentials.access(cancel.signal);
  const two = f.credentials.access();
  const rejected = assert.rejects(one, /cancel-waiter/);
  await new Promise(resolve => setImmediate(resolve));
  cancel.abort(new Error("cancel-waiter"));
  release({ token: "refreshed-secret", origin: "https://api.githubcopilot.com", expiresAt: 999999999 });
  await rejected;
  assert.equal((await two).token, "refreshed-secret");
  assert.equal(f.counters.exchange, 2, "one login validation plus exactly one shared refresh");
  f.gateway.models = async () => { throw new CopilotError("COPILOT_UPSTREAM_UNAVAILABLE", "目录失败", 502); };
  await assert.rejects(() => f.credentials.refreshModels(), { code: "COPILOT_UPSTREAM_UNAVAILABLE" });
  assert.equal(f.store.record.state, "authorized");
  assert.equal(f.store.record.catalogState, "refresh_required");
});
