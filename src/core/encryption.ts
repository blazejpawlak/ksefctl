import { KsefClient } from "../api/ksefClient";
import {
  createPublicKeyFromCertificate,
  generateAes256Key,
  generateIv,
  rsaOaepSha256Encrypt,
} from "../utils/crypto";

export type EncryptionData = {
  key: Buffer;
  iv: Buffer;
  encryptionInfo: {
    encryptedSymmetricKey: string;
    initializationVector: string;
  };
};

export const selectCertificateByUsage = (
  certs: Array<{ certificate: string; usage: string[] }>,
  usage: string,
) => {
  const match = certs.find((cert) => cert.usage.includes(usage));
  if (!match)
    throw new Error(`No public key certificate found for usage: ${usage}`);
  return match.certificate;
};

export const createEncryptionData = async (
  client: KsefClient,
  certificate?: string,
): Promise<EncryptionData> => {
  const cert = certificate
    ? certificate
    : selectCertificateByUsage(
        await client.getPublicKeyCertificates(),
        "SymmetricKeyEncryption",
      );
  const publicKey = createPublicKeyFromCertificate(cert);

  const key = generateAes256Key();
  const iv = generateIv();
  const encryptedKey = rsaOaepSha256Encrypt(publicKey, key).toString("base64");
  const initializationVector = iv.toString("base64");

  return {
    key,
    iv,
    encryptionInfo: {
      encryptedSymmetricKey: encryptedKey,
      initializationVector,
    },
  };
};
