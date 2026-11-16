import { randomUUID } from "node:crypto";
import type { AuthorizationSession, CopilotAccountSummary } from "@ai-novel/shared/types/authorization";
import {
  accountState, catalogState, COPILOT_ACCOUNT_ID, CopilotError, revisionConflict,
  type AccountStore, type CopilotGateway, type CredentialVault, type DeviceCode,
} from "../domain/contracts";
import { CopilotCredentials, readSavedModels } from "./CopilotCredentials";

interface LoginSession {
  public: AuthorizationSession;
  device: DeviceCode;
  key: string;
  revision: number;
  replaceAccount: boolean;
  controller: AbortController;
  cancelTimer?: () => void;
  polling: boolean;
}
type Scheduler = (operation: () => void, delayMs: number) => () => void;
const schedule: Scheduler = (operation, delayMs) => {
  const timer = setTimeout(operation, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

export class AuthorizationService {
  private readonly sessions = new Map<string, LoginSession>();
  private starting: Promise<AuthorizationSession> | null = null;
  private onAuthorized: () => Promise<void> = async () => {};

  constructor(
    private readonly store: AccountStore,
    private readonly vault: CredentialVault,
    private readonly gateway: CopilotGateway,
    readonly credentials: CopilotCredentials,
    private readonly now: () => number = Date.now,
    private readonly scheduler: Scheduler = schedule,
  ) {}

  setAuthorizedHandler(handler: () => Promise<void>): void { this.onAuthorized = handler; }

  private snapshot(session: LoginSession): AuthorizationSession {
    return { ...session.public, userCode: session.public.state === "pending" ? session.device.userCode : undefined };
  }

  async summary(): Promise<CopilotAccountSummary> {
    const record = await this.store.get();
    const active = [...this.sessions.values()].find(session => session.public.state === "pending");
    return {
      id: COPILOT_ACCOUNT_ID, state: accountState(record), login: record?.login ?? null,
      credentialRevision: record?.credentialRevision ?? 0, catalogState: catalogState(record),
      models: readSavedModels(record), bindings: await this.store.bindings(),
      activeSession: active ? this.snapshot(active) : null,
    };
  }

  async start(key: string, replaceAccount = false): Promise<AuthorizationSession> {
    const existing = [...this.sessions.values()].find(session => session.key === key || session.public.state === "pending");
    if (existing) return this.snapshot(existing);
    if (this.starting) return this.starting;
    const operation = this.create(key, replaceAccount);
    this.starting = operation;
    try { return await operation; } finally { this.starting = null; }
  }

  private async create(key: string, replaceAccount: boolean): Promise<AuthorizationSession> {
    const account = await this.store.initialize();
    if (replaceAccount && account.state !== "signed_out") throw revisionConflict();
    const device = await this.gateway.startDevice();
    const latest = await this.store.get();
    if (latest?.credentialRevision !== account.credentialRevision) throw revisionConflict();
    const session: LoginSession = {
      key, device, revision: account.credentialRevision, replaceAccount,
      controller: new AbortController(), polling: false,
      public: {
        id: randomUUID(), state: "pending", verificationUri: device.verificationUri,
        expiresAt: this.now() + device.expiresIn * 1000, pollIntervalMs: device.interval * 1000,
      },
    };
    for (const [id, value] of this.sessions) {
      if (this.sessions.size < 32) break;
      if (value.public.state !== "pending") this.sessions.delete(id);
    }
    this.sessions.set(session.public.id, session);
    this.reschedule(session);
    return this.snapshot(session);
  }

  session(id: string): AuthorizationSession {
    const session = this.sessions.get(id);
    if (!session) throw new CopilotError("COPILOT_SESSION_NOT_FOUND", "登录会话不存在或服务已重启，请重新登录。", 404);
    return this.snapshot(session);
  }

  private finish(session: LoginSession, state: AuthorizationSession["state"], error?: CopilotError): void {
    session.public.state = state;
    session.public.code = error?.code;
    session.public.error = error?.message;
    session.cancelTimer?.();
    session.controller.abort();
    session.device.deviceCode = "";
    session.device.userCode = "";
    console.info("[authorization.session]", JSON.stringify({ sessionId: session.public.id, outcome: state, code: error?.code }));
  }

  cancel(id: string): AuthorizationSession {
    const session = this.sessions.get(id);
    if (!session) return this.session(id);
    if (session.public.state === "pending") this.finish(session, "cancelled");
    return this.snapshot(session);
  }

  private reschedule(session: LoginSession): void {
    session.cancelTimer?.();
    session.cancelTimer = this.scheduler(() => { void this.poll(session.public.id); },
      Math.max(0, Math.min(session.public.pollIntervalMs, session.public.expiresAt - this.now())));
  }

  async poll(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.public.state !== "pending" || session.polling) return;
    session.polling = true;
    try {
      if (this.now() >= session.public.expiresAt) {
        this.finish(session, "expired", new CopilotError("COPILOT_LOGIN_EXPIRED", "登录码已过期，请重新发起登录。"));
        return;
      }
      const signal = session.controller.signal;
      const result = await this.gateway.pollDevice(session.device.deviceCode, signal);
      signal.throwIfAborted();
      if (result.pending) {
        if (result.slowDown) session.public.pollIntervalMs += 5000;
        this.reschedule(session);
        return;
      }
      if (!result.token) throw new CopilotError("COPILOT_LOGIN_FAILED", "GitHub 登录未完成，请重新发起登录。");
      const user = await this.gateway.user(result.token, signal);
      const access = await this.gateway.exchange(result.token, signal);
      signal.throwIfAborted();
      const account = await this.store.get();
      if (!account || account.credentialRevision !== session.revision) throw revisionConflict();
      if (account.githubUserId && account.githubUserId !== user.id && !session.replaceAccount) {
        throw new CopilotError("COPILOT_ACCOUNT_CONFLICT", "请先退出账户，并确认将所有关联厂商接到另一个 GitHub 账户。", 409);
      }
      const encryptedCredential = this.vault.seal(result.token, account.id, !account.encryptedCredential);
      const saved = await this.store.update(session.revision, {
        githubUserId: user.id, login: user.login, state: "authorized", encryptedCredential,
        catalogState: "refresh_required", catalogJson: "[]",
      }, true);
      this.credentials.invalidate();
      this.credentials.seed({ ...access, revision: saved.credentialRevision });
      // Catalog/provisioning failure must not undo an already saved authorization.
      await this.onAuthorized().catch(() => {
        console.info("[authorization.session]", JSON.stringify({ sessionId: id, outcome: "catalog_pending" }));
      });
      if (session.public.state === "pending") this.finish(session, "succeeded");
    } catch (error) {
      if (session.public.state !== "pending") return;
      const safe = error instanceof CopilotError ? error
        : new CopilotError("COPILOT_LOGIN_FAILED", "授权无法完成，请检查连接后重新登录。");
      this.finish(session, safe.code === "COPILOT_LOGIN_DENIED" ? "denied"
        : safe.code === "COPILOT_LOGIN_EXPIRED" ? "expired" : "failed", safe);
    } finally { session.polling = false; }
  }

  async logout(revision: number): Promise<void> {
    await this.store.initialize();
    await this.store.update(revision, {
      state: "signed_out", encryptedCredential: null, catalogState: "refresh_required",
    }, true);
    for (const session of this.sessions.values()) {
      if (session.public.state === "pending") this.finish(session, "cancelled");
    }
    this.credentials.invalidate();
  }

  close(): void {
    for (const session of this.sessions.values()) {
      if (session.public.state === "pending") this.finish(session, "cancelled");
    }
    this.credentials.invalidate();
  }
}
