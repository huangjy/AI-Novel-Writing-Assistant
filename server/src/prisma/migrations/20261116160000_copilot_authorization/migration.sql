CREATE TABLE "AuthorizationAccount" (
  "id" TEXT NOT NULL,
  "service" TEXT NOT NULL,
  "githubUserId" TEXT,
  "login" TEXT,
  "state" TEXT NOT NULL DEFAULT 'signed_out',
  "encryptedCredential" TEXT,
  "credentialRevision" INTEGER NOT NULL DEFAULT 0,
  "bootstrapCompleted" BOOLEAN NOT NULL DEFAULT false,
  "catalogState" TEXT NOT NULL DEFAULT 'refresh_required',
  "catalogJson" TEXT NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuthorizationAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AuthorizationAccount_service_key" ON "AuthorizationAccount"("service");
ALTER TABLE "APIKey" ADD COLUMN "connectionType" TEXT NOT NULL DEFAULT 'api_key';
ALTER TABLE "APIKey" ADD COLUMN "authorizationAccountId" TEXT;
CREATE INDEX "APIKey_authorizationAccountId_idx" ON "APIKey"("authorizationAccountId");
ALTER TABLE "APIKey" ADD CONSTRAINT "APIKey_authorizationAccountId_fkey"
  FOREIGN KEY ("authorizationAccountId") REFERENCES "AuthorizationAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
