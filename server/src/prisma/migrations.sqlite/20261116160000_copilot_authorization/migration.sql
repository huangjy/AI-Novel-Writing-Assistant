CREATE TABLE "AuthorizationAccount" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "service" TEXT NOT NULL,
  "githubUserId" TEXT,
  "login" TEXT,
  "state" TEXT NOT NULL DEFAULT 'signed_out',
  "encryptedCredential" TEXT,
  "credentialRevision" INTEGER NOT NULL DEFAULT 0,
  "bootstrapCompleted" BOOLEAN NOT NULL DEFAULT false,
  "catalogState" TEXT NOT NULL DEFAULT 'refresh_required',
  "catalogJson" TEXT NOT NULL DEFAULT '[]',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "AuthorizationAccount_service_key" ON "AuthorizationAccount"("service");
ALTER TABLE "APIKey" ADD COLUMN "connectionType" TEXT NOT NULL DEFAULT 'api_key';
ALTER TABLE "APIKey" ADD COLUMN "authorizationAccountId" TEXT REFERENCES "AuthorizationAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "APIKey_authorizationAccountId_idx" ON "APIKey"("authorizationAccountId");
