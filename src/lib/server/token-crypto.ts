import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "@/lib/server/app-error";
import { getTokenEncryptionKey } from "@/lib/server/env";

const ENVELOPE_VERSION = "v1";

export function encryptToken(plaintext: string): string {
  if (!plaintext) {
    throw new AppError("Token encryption failed.", { status: 500, code: "TOKEN_ENCRYPTION_ERROR" });
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getTokenEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();

  return [ENVELOPE_VERSION, iv.toString("base64"), ciphertext.toString("base64"), authenticationTag.toString("base64")].join(".");
}

export function decryptToken(envelope: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new AppError("Stored token could not be read.", { status: 500, code: "TOKEN_DECRYPTION_ERROR" });
  }

  try {
    const [, encodedIv, encodedCiphertext, encodedTag] = parts;
    const decipher = createDecipheriv("aes-256-gcm", getTokenEncryptionKey(), Buffer.from(encodedIv, "base64"));
    decipher.setAuthTag(Buffer.from(encodedTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError("Stored token could not be read.", { status: 500, code: "TOKEN_DECRYPTION_ERROR" });
  }
}
