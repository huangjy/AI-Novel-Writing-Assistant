import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveAppDataRoot, resolveAppRuntimeMode, resolveServerRoot } from "../../../runtime/appPaths";

const envelopeSchema = z.object({
  version: z.literal(1),
  keyId: z.literal("local-v1"),
  nonce: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
});

export class CredentialUnavailableError extends Error {
  constructor() {
    super("无法读取授权密钥，请恢复原凭据目录，或退出后重新授权。");
    this.name = "CredentialUnavailableError";
  }
}

export function resolveCredentialDirectory(): string {
  const configured = process.env.AI_NOVEL_CREDENTIALS_DIR?.trim();
  return configured ? path.resolve(configured) : resolveAppRuntimeMode() === "desktop"
    ? path.join(resolveAppDataRoot(), "credentials")
    : path.join(resolveServerRoot(), "storage", "credentials");
}

export class FileCredentialVault {
  constructor(private readonly directory = resolveCredentialDirectory()) {}

  private key(allowCreate: boolean): Buffer {
    const file = path.join(this.directory, "master.key");
    try {
      if (!fs.existsSync(file) && allowCreate) {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const directory = fs.lstatSync(this.directory);
        if (!directory.isDirectory() || directory.isSymbolicLink()
          || (process.platform !== "win32" && (directory.mode & 0o077) !== 0)) throw new CredentialUnavailableError();
        const key = randomBytes(32);
        try {
          fs.writeFileSync(file, key, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
        throw new CredentialUnavailableError();
      }
      const key = fs.readFileSync(file);
      if (key.length !== 32) throw new CredentialUnavailableError();
      return key;
    } catch {
      throw new CredentialUnavailableError();
    }
  }

  seal(plaintext: string, context: string, allowCreate: boolean): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(allowCreate), nonce);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return JSON.stringify({
      version: 1, keyId: "local-v1", nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
    });
  }

  open(encrypted: string, context: string): string {
    try {
      const value = envelopeSchema.parse(JSON.parse(encrypted));
      const decipher = createDecipheriv("aes-256-gcm", this.key(false), Buffer.from(value.nonce, "base64"));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(value.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new CredentialUnavailableError();
    }
  }
}
