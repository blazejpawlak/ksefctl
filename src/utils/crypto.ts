import crypto from "node:crypto";

export const pemFromDerBase64Cert = (base64Der: string): string => {
  const lines = base64Der.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
};

export const createPublicKeyFromCertificate = (
  base64Der: string,
): crypto.KeyObject => {
  const certPem = pemFromDerBase64Cert(base64Der);
  try {
    return crypto.createPublicKey(certPem);
  } catch {
    const lines = base64Der.match(/.{1,64}/g) ?? [];
    const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
    return crypto.createPublicKey(publicKeyPem);
  }
};

export const rsaOaepSha256Encrypt = (
  publicKey: crypto.KeyObject,
  data: Buffer,
): Buffer => {
  return crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    data,
  );
};

export const generateAes256Key = (): Buffer => crypto.randomBytes(32);
export const generateIv = (): Buffer => crypto.randomBytes(16);

export const decryptAes256Cbc = (
  key: Buffer,
  iv: Buffer,
  encrypted: Buffer,
): Buffer => {
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
};

export const encryptAes256Cbc = (
  key: Buffer,
  iv: Buffer,
  plain: Buffer,
): Buffer => {
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
};

export const sha256Base64 = (data: Buffer): string =>
  crypto.createHash("sha256").update(data).digest("base64");
