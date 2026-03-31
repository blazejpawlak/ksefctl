import { xml2js } from "xml-js";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256Base64 } from "../utils/crypto";
import {
  analyzeInvoicePayment,
  isEligibleForNotification,
} from "./invoicePaymentAnalyzer";
// MetadataFile is defined in ./window.ts
export type SyncItem = {
  nip: string;
  ksefNumber: string;
  path: string;
  dueDate: string | null;
  needsPaymentNotification: boolean;
};

// ─── Constants ────────────────────────────────────────────────────────────────

export const maxInvoiceNumberXmlBytes = 5_000_000;
export const maxInvoiceFileBaseLength = 180;
export const maxZipEntries = 2000;
export const maxZipEntryBytes = 20_000_000;
export const maxZipTotalBytes = 200_000_000;
export const maxInvoicePdfXmlBytes = 5_000_000;
export const maxDecryptedPackageBytes = 200_000_000;

const invoiceNumberKeys = new Set(["p_2", "nrfaktury", "numerfaktury"]);

// ─── XML helpers ──────────────────────────────────────────────────────────────

export const stripDoctype = (xml: string): string =>
  xml.replace(/<!DOCTYPE[\s\S]*?>/gi, "");

const stripPrefixes = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripPrefixes);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const normalizedKey = key.includes(":") ? key.split(":")[1] : key;
        return [normalizedKey, stripPrefixes(entry)];
      }),
    );
  }
  return value;
};

export const extractTextValue = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as { _text?: unknown; _cdata?: unknown };
    if (typeof record._text === "string") return record._text;
    if (typeof record._cdata === "string") return record._cdata;
  }
  return null;
};

const findInvoiceNumber = (node: unknown): string | null => {
  if (Array.isArray(node)) {
    for (const entry of node) {
      const match = findInvoiceNumber(entry);
      if (match) return match;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  for (const [key, value] of Object.entries(node)) {
    if (invoiceNumberKeys.has(key.toLowerCase())) {
      const direct = extractTextValue(value);
      if (direct) return direct;
    }
  }
  for (const value of Object.values(node)) {
    const nested = findInvoiceNumber(value);
    if (nested) return nested;
  }
  return null;
};

export const extractInvoiceNumber = (xml: string): string | null => {
  if (Buffer.byteLength(xml, "utf-8") > maxInvoiceNumberXmlBytes) {
    return null;
  }
  try {
    const parsed = xml2js(stripDoctype(xml), { compact: true }) as unknown;
    return findInvoiceNumber(stripPrefixes(parsed));
  } catch {
    return null;
  }
};

// ─── File helpers ─────────────────────────────────────────────────────────────

export const sanitizeFileName = (value: string): string => {
  const cleaned = value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/[\u0000-\u001f]/g, "");
  const truncated =
    cleaned.length > maxInvoiceFileBaseLength
      ? cleaned.slice(0, maxInvoiceFileBaseLength)
      : cleaned;
  return truncated.trim().replace(/[. ]+$/g, "");
};

export const hasValidInvoiceXml = async (
  invoiceDir: string,
  expectedHash: string | null,
): Promise<boolean> => {
  try {
    const entries = await fs.readdir(invoiceDir);
    const xmlNames = entries.filter((entry) => entry.endsWith(".xml"));
    if (xmlNames.length === 0) return false;
    if (!expectedHash) return false;
    for (const xmlName of xmlNames) {
      try {
        const xmlData = await fs.readFile(path.join(invoiceDir, xmlName));
        if (sha256Base64(xmlData) === expectedHash) {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
};

export const resolveInvoiceFileBase = (
  xml: string,
  ksefNumber: string,
): string => {
  const invoiceNumber = extractInvoiceNumber(xml);
  if (!invoiceNumber) return ksefNumber;
  const safeInvoiceNumber = sanitizeFileName(invoiceNumber);
  if (!safeInvoiceNumber) return ksefNumber;
  const baseName = sanitizeFileName(`Faktura nr ${safeInvoiceNumber}`);
  return baseName || ksefNumber;
};

export const createSyncItem = (
  nip: string,
  ksefNumber: string,
  filePath: string,
  xmlText: string,
): SyncItem => {
  const paymentInfo = analyzeInvoicePayment(xmlText, nip);
  return {
    nip,
    ksefNumber,
    path: filePath,
    dueDate: paymentInfo.dueDate,
    needsPaymentNotification: isEligibleForNotification(paymentInfo),
  };
};
