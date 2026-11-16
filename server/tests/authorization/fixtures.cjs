const { FileCredentialVault } = require("../../dist/platform/security/credentials");
const { CopilotCredentials } = require("../../dist/modules/authorization/application/CopilotCredentials");
const { AuthorizationService } = require("../../dist/modules/authorization/application/AuthorizationService");
const { revisionConflict } = require("../../dist/modules/authorization/domain/contracts");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

class MemoryStore {
  record = null;
  writes = [];
  async get() { return this.record ? structuredClone(this.record) : null; }
  async initialize() {
    this.record ??= { id: "github_copilot", service: "github_copilot", state: "signed_out", githubUserId: null,
      login: null, encryptedCredential: null, credentialRevision: 0, bootstrapCompleted: false,
      catalogState: "refresh_required", catalogJson: "[]" };
    return this.get();
  }
  async update(revision, patch, increment = false) {
    if (!this.record || this.record.credentialRevision !== revision) throw revisionConflict();
    this.writes.push(structuredClone(patch));
    Object.assign(this.record, patch);
    if (increment) this.record.credentialRevision++;
    return this.get();
  }
  async bindings() { return []; }
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-auth-test-"));
  const store = new MemoryStore(), vault = new FileCredentialVault(directory);
  let now = 1_000_000;
  const timers = [];
  const counters = { device: 0, poll: 0, exchange: 0, models: 0 };
  const gateway = {
    pollResult: { token: "oauth-secret-sentinel" }, userId: "123",
    async startDevice() { counters.device++; return { deviceCode: "device-secret-sentinel", userCode: "VISIBLE-CODE",
      verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 }; },
    async pollDevice() { counters.poll++; return this.pollResult; },
    async user() { return { id: this.userId, login: "fixture-user" }; },
    async exchange() { counters.exchange++; return { token: "copilot-secret-sentinel", expiresAt: now + 3600000, origin: "https://api.githubcopilot.com" }; },
    async models() { counters.models++; return [{ id: "exact-model", name: "Exact", transport: "chat",
      supportedEndpoints: ["/chat/completions"], supportsTools: true, supportsStructuredOutput: false, reasoningEfforts: [] }]; },
  };
  const credentials = new CopilotCredentials(store, vault, gateway, () => now);
  const service = new AuthorizationService(store, vault, gateway, credentials, () => now, (operation, delay) => {
    const timer = { operation, delay, cancelled: false }; timers.push(timer);
    return () => { timer.cancelled = true; };
  });
  return { directory, store, vault, gateway, credentials, service, counters, timers, advance: ms => { now += ms; } };
}
module.exports = { fixture, MemoryStore };
