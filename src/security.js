import crypto from "node:crypto";

function getKey() {
  const secret = process.env.TOKEN_ENCRYPTION_KEY || "dev-only-secret-change-me";
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptText(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptText(payload) {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

export function createSignedState(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", getKey())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function verifySignedState(token) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    throw new Error("Invalid OAuth state");
  }
  const expected = crypto
    .createHmac("sha256", getKey())
    .update(payload)
    .digest("base64url");
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid OAuth state");
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}
