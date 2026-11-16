import { randomUUID } from "node:crypto";
import { prisma } from "../../../db/prisma";
import { COPILOT_ACCOUNT_ID, revisionConflict } from "../domain/contracts";
import type { BindingRepository, SubscriptionProviderInput } from "../application/SubscriptionProviders";

function writeInput(input: SubscriptionProviderInput) {
  return {
    connectionType: "copilot_subscription", authorizationAccountId: COPILOT_ACCOUNT_ID,
    key: null, baseURL: null, authMode: "none",
    ...(input.name || input.displayName ? { displayName: input.name ?? input.displayName } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    ...(input.reasoningEnabled !== undefined ? { reasoningEnabled: input.reasoningEnabled } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.hiddenModels !== undefined ? { hiddenModels: JSON.stringify(input.hiddenModels) } : {}),
    ...(input.concurrencyLimit !== undefined ? { concurrencyLimit: input.concurrencyLimit } : {}),
    ...(input.requestIntervalMs !== undefined ? { requestIntervalMs: input.requestIntervalMs } : {}),
  };
}

export class PrismaSubscriptionBindings implements BindingRepository {
  get(provider: string) { return prisma.aPIKey.findUnique({ where: { provider } }); }
  create(provider: string, input: SubscriptionProviderInput) {
    return prisma.aPIKey.create({ data: { provider, ...writeInput(input) } });
  }
  save(provider: string, input: SubscriptionProviderInput) {
    return prisma.aPIKey.update({ where: { provider }, data: writeInput(input) });
  }
  async bootstrap(revision: number): Promise<void> {
    await prisma.$transaction(async tx => {
      const marked = await tx.authorizationAccount.updateMany({
        where: { id: COPILOT_ACCOUNT_ID, credentialRevision: revision, state: "authorized", bootstrapCompleted: false },
        data: { bootstrapCompleted: true },
      });
      if (!marked.count) return;
      const id = "custom_github_copilot";
      const existing = await tx.aPIKey.findUnique({ where: { provider: id } });
      await tx.aPIKey.create({ data: {
        provider: existing ? `${id}_${randomUUID().slice(0, 8)}` : id,
        ...writeInput({ displayName: "GitHub Copilot", model: "" }), reasoningEnabled: false,
      } });
    });
  }
  async publish(revision: number, models: string[]): Promise<void> {
    await prisma.$transaction(async tx => {
      const account = await tx.authorizationAccount.findUnique({ where: { id: COPILOT_ACCOUNT_ID } });
      if (account?.credentialRevision !== revision || account.state !== "authorized") throw revisionConflict();
      const where = { connectionType: "copilot_subscription", authorizationAccountId: COPILOT_ACCOUNT_ID };
      await tx.aPIKey.updateMany({ where, data: { availableModels: JSON.stringify(models) } });
      if (models[0]) await tx.aPIKey.updateMany({
        where: { ...where, OR: [{ model: null }, { model: "" }] }, data: { model: models[0] },
      });
    });
  }
}
