import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "../utils/paths";

const assertSafePathSegment = (value: string, label: string): void => {
  if (!value || value === "." || value === "..") {
    throw new Error(`Invalid ${label} path segment`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`Invalid ${label} path segment`);
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new Error(`Invalid ${label} path segment`);
  }
};

export const getInvoiceDir = (
  storageRoot: string,
  date: Date,
  nip: string,
  ksefNumber: string,
): string => {
  assertSafePathSegment(nip, "NIP");
  assertSafePathSegment(ksefNumber, "KSeF number");
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return path.join(
    storageRoot,
    "invoices",
    nip,
    String(year),
    month,
    day,
    ksefNumber,
  );
};

export const atomicWriteFile = async (
  filePath: string,
  data: string | Buffer,
): Promise<void> => {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, data, { mode: 0o600 });
  await fs.chmod(tempPath, 0o600);
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600);
};

export const ensureStorageDirs = async (storageRoot: string): Promise<void> => {
  await ensureDir(storageRoot);
  await ensureDir(path.join(storageRoot, "invoices"));
  await ensureDir(path.join(storageRoot, "db"));
  await ensureDir(path.join(storageRoot, "logs"));
};
