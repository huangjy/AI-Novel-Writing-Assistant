const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { FileCredentialVault } = require("../../dist/platform/security/credentials");

test("credential envelopes authenticate context and never recreate a missing recovery key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-vault-"));
  const directory = path.join(root, "private"), vault = new FileCredentialVault(directory);
  const first = vault.seal("oauth-sensitive", "github_copilot", true);
  const second = vault.seal("oauth-sensitive", "github_copilot", false);
  assert.notEqual(first, second);
  assert.ok(!first.includes("oauth-sensitive"));
  assert.equal(vault.open(first, "github_copilot"), "oauth-sensitive");
  assert.throws(() => vault.open(first, "another-account"), /授权密钥/);
  const damaged = JSON.parse(first); damaged.tag = Buffer.alloc(16).toString("base64");
  assert.throws(() => vault.open(JSON.stringify(damaged), "github_copilot"), /授权密钥/);
  const missing = path.join(root, "missing");
  assert.throws(() => new FileCredentialVault(missing).open(first, "github_copilot"), /授权密钥/);
  assert.equal(fs.existsSync(missing), false);
  assert.throws(() => new FileCredentialVault(missing).seal("new", "github_copilot", false), /授权密钥/);
  assert.equal(fs.existsSync(missing), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, "master.key")).mode & 0o777, 0o600);
  }
});
