import { prisma } from "../../../db/prisma";
import { COPILOT_ACCOUNT_ID, revisionConflict, type AccountRecord, type AccountStore } from "../domain/contracts";

export class PrismaAccountStore implements AccountStore {
  get(): Promise<AccountRecord | null> {
    return prisma.authorizationAccount.findUnique({ where: { id: COPILOT_ACCOUNT_ID } });
  }

  initialize(): Promise<AccountRecord> {
    return prisma.authorizationAccount.upsert({
      where: { id: COPILOT_ACCOUNT_ID }, update: {},
      create: { id: COPILOT_ACCOUNT_ID, service: COPILOT_ACCOUNT_ID },
    });
  }

  async update(revision: number, patch: Parameters<AccountStore["update"]>[1], incrementRevision = false): Promise<AccountRecord> {
    return prisma.$transaction(async tx => {
      const result = await tx.authorizationAccount.updateMany({
        where: { id: COPILOT_ACCOUNT_ID, credentialRevision: revision },
        data: { ...patch, ...(incrementRevision ? { credentialRevision: { increment: 1 } } : {}) },
      });
      if (result.count !== 1) throw revisionConflict();
      return tx.authorizationAccount.findUniqueOrThrow({ where: { id: COPILOT_ACCOUNT_ID } });
    });
  }

  bindings() {
    return prisma.aPIKey.findMany({
      where: { authorizationAccountId: COPILOT_ACCOUNT_ID },
      select: { provider: true, displayName: true }, orderBy: { createdAt: "asc" },
    });
  }
}
