const test = require("node:test");
const assert = require("node:assert/strict");
const { openCopilotDeviceLogin } = require("../dist/runtime/authorization/copilotLogin");

test("Copilot browser bridge only accepts the trusted renderer and opens one fixed HTTPS page", async () => {
  const sender = {}, opened = [];
  const open = async url => { opened.push(url); };
  await assert.rejects(() => openCopilotDeviceLogin({ sender: {} }, sender, open));
  await assert.rejects(() => openCopilotDeviceLogin({}, undefined, open));
  assert.equal(opened.length, 0);
  await openCopilotDeviceLogin({ sender, url: "file:///private/secret" }, sender, open);
  assert.deepEqual(opened, ["https://github.com/login/device"]);
});
