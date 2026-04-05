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

const getYearMonthSegments = (date: Date): { year: string; month: string } => ({
  year: String(date.getUTCFullYear()),
  month: String(date.getUTCMonth() + 1).padStart(2, "0"),
});

export const resolveInvoiceOutputRoot = (
  storageRoot: string,
  nip: string,
  outputPath?: string,
): string => {
  assertSafePathSegment(nip, "NIP");
  return outputPath ?? path.join(storageRoot, "invoices", nip);
};

export const getInvoiceDirForRoot = (
  invoiceRoot: string,
  date: Date,
  ksefNumber: string,
): string => {
  assertSafePathSegment(ksefNumber, "KSeF number");
  const { year, month } = getYearMonthSegments(date);
  const day = String(date.getUTCDate()).padStart(2, "0");
  return path.join(invoiceRoot, year, month, day, ksefNumber);
};

export const getFlatInvoiceDirForRoot = (
  invoiceRoot: string,
  date: Date,
): string => {
  const { year, month } = getYearMonthSegments(date);
  return path.join(invoiceRoot, year, month);
};

export const getInvoiceDir = (
  storageRoot: string,
  date: Date,
  nip: string,
  ksefNumber: string,
): string => {
  return getInvoiceDirForRoot(
    resolveInvoiceOutputRoot(storageRoot, nip),
    date,
    ksefNumber,
  );
};

export const getFlatInvoiceDir = (
  storageRoot: string,
  date: Date,
  nip: string,
): string => {
  return getFlatInvoiceDirForRoot(
    resolveInvoiceOutputRoot(storageRoot, nip),
    date,
  );
};

export const atomicWriteFile = async (
  filePath: string,
  data: string | Buffer,
): Promise<void> => {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, data, { mode: 0o600, flag: "wx" });
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
