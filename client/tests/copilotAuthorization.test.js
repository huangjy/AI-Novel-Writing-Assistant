import test from "node:test";
import assert from "node:assert/strict";
import { canSwitchCopilotAccount, connectionPayload, showProvider, subscriptionModelOptions } from "../src/pages/settings/authorization/authorizationPolicy.ts";

test("account switching is available only after signing out of a remembered account", () => {
  assert.equal(canSwitchCopilotAccount({ state: "signed_out", login: "old-account" }), true);
  assert.equal(canSwitchCopilotAccount({ state: "signed_out", login: null }), false);
  assert.equal(canSwitchCopilotAccount(), false);
  for (const state of ["authorized", "reauthorization_required", "subscription_unavailable", "credential_unavailable"]) {
    assert.equal(canSwitchCopilotAccount({ state, login: "old-account" }), false);
  }
});

test("subscription payloads omit copied keys, URLs and image model settings", () => {
  const form = { key: "private-old-key", baseURL: "https://old.example/v1", imageModel: "old-image", model: "selected" };
  const payload = { ...form, ...connectionPayload("copilot_subscription", "github_copilot") };
  assert.equal(payload.authorizationAccountId, "github_copilot");
  assert.equal(payload.authMode, "none");
  assert.equal(payload.model, "selected");
  assert.equal(payload.key, undefined);
  assert.equal(payload.baseURL, undefined);
  assert.equal(payload.imageModel, undefined);
  assert.ok(!JSON.stringify(payload).includes("private-old-key"));
  const apiKey = { ...form, ...connectionPayload("api_key") };
  assert.equal(apiKey.key, form.key);
  assert.equal(apiKey.authorizationAccountId, undefined);
});

test("model choices only include explicit transports and preserve the current visible selection", () => {
  const account = { models: [
    { id: "chat", transport: "chat" }, { id: "responses", transport: "responses" },
    { id: "unsupported", transport: null }, { id: "hidden", transport: "chat" },
  ] };
  assert.deepEqual(subscriptionModelOptions(account, ["hidden", "chat"], "chat"), ["chat", "responses"]);
  assert.deepEqual(subscriptionModelOptions(undefined), []);
});

test("saved subscription providers remain manageable after logout or catalog failures", () => {
  assert.equal(showProvider({ isActive: true, isConfigured: false, kind: "custom", connectionType: "copilot_subscription" }), true);
  assert.equal(showProvider({ isActive: true, isConfigured: false, kind: "custom", connectionType: "api_key" }), true);
  assert.equal(showProvider({ isActive: false, isConfigured: false, kind: "custom", connectionType: "copilot_subscription" }), false);
  assert.equal(showProvider({ isActive: true, isConfigured: false, kind: "builtin" }), false);
  assert.equal(showProvider({ isActive: true, isConfigured: true, kind: "builtin" }), true);
});
