import { xml2js } from "xml-js";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256Base64 } from "../utils/crypto";
import {
  analyzeInvoicePayment,
  isEligibleForNotification,
} from "./invoicePaymentAnalyzer";
export type SyncItem = {
  nip: string;
  ksefNumber: string;
  path: string;
  dueDate: string | null;
  needsPaymentNotification: boolean;
  sellerName: string | null;
  buyerName: string | null;
  invoiceNumber: string | null;
  amount: string | null;
  currency: string | null;
  bankAccount: string | null;
  pdfPath: string | null;
};

export type InvoiceFileMetadata = {
  invoiceNumber?: string | null;
  seller?: {
    name?: string | null;
  } | null;
};

// ─── Constants ────────────────────────────────────────────────────────────────

// 5 MB — generous upper bound for a single XML invoice file (real KSeF invoices are typically < 100 KB).
export const maxInvoiceNumberXmlBytes = 5_000_000;
// 180 chars — keeps generated filesystem paths within the 255-byte filename limit on Linux/macOS.
export const maxInvoiceFileBaseLength = 180;
// ZIP-bomb mitigations: keep limits well above any realistic KSeF export package to avoid DoS.
export const maxZipEntries = 2000; // KSeF docs show batches of up to 1000 invoices per package.
export const maxZipEntryBytes = 20_000_000; // 20 MB per entry; real invoices are < 1 MB.
export const maxZipTotalBytes = 200_000_000; // 200 MB total uncompressed; matches decrypted limit.
export const maxInvoicePdfXmlBytes = 5_000_000; // 5 MB — same cap as the raw XML file.
export const maxDecryptedPackageBytes = 200_000_000; // 200 MB decrypted limit guards against zip-bombs.
export const maxExtractedTextValueLength = 4096; // Caps individual XML text values to prevent oversized log lines.

const invoiceNumberKeys = new Set(["p_2", "nrfaktury", "numerfaktury"]);
const sellerNamePaths = [
  ["Podmiot1", "DaneIdentyfikacyjne", "Nazwa"],
  ["Podmiot1", "DaneIdentyfikacyjne", "PelnaNazwa"],
  ["Podmiot1", "DaneIdentyfikacyjne", "NazwaPelna"],
  ["Podmiot1", "DaneIdentyfikacyjne", "SkroconaNazwa"],
];
const buyerNamePaths = [
  ["Podmiot2", "DaneIdentyfikacyjne", "Nazwa"],
  ["Podmiot2", "DaneIdentyfikacyjne", "PelnaNazwa"],
  ["Podmiot2", "DaneIdentyfikacyjne", "NazwaPelna"],
  ["Podmiot2", "DaneIdentyfikacyjne", "SkroconaNazwa"],
];

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

const limitExtractedText = (value: string): string =>
  value.slice(0, maxExtractedTextValueLength);

export const extractTextValue = (value: unknown): string | null => {
  if (typeof value === "string") return limitExtractedText(value);
  if (value && typeof value === "object") {
    const record = value as { _text?: unknown; _cdata?: unknown };
    if (typeof record._text === "string")
      return limitExtractedText(record._text);
    if (typeof record._cdata === "string") {
      return limitExtractedText(record._cdata);
    }
  }
  return null;
};

const getChild = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== "object") return null;
  return (value as Record<string, unknown>)[key] ?? null;
};

const getNestedText = (value: unknown, keys: string[]): string | null => {
  let current: unknown = value;
  for (const key of keys) {
    current = getChild(current, key);
    if (!current) return null;
  }
  return extractTextValue(current)?.trim() ?? null;
};

const parseInvoiceXml = (xml: string): unknown => {
  try {
    return stripPrefixes(xml2js(stripDoctype(xml), { compact: true }));
  } catch {
    return null;
  }
};

const getInvoiceNode = (parsed: unknown): unknown =>
  getChild(parsed, "Faktura") ?? parsed;

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
  const parsed = parseInvoiceXml(xml);
  return findInvoiceNumber(getInvoiceNode(parsed));
};

export const extractSellerName = (xml: string): string | null => {
  if (Buffer.byteLength(xml, "utf-8") > maxInvoiceNumberXmlBytes) {
    return null;
  }
  const invoice = getInvoiceNode(parseInvoiceXml(xml));
  for (const sellerNamePath of sellerNamePaths) {
    const sellerName = getNestedText(invoice, sellerNamePath);
    if (sellerName) return sellerName;
  }
  return null;
};

export const extractBuyerName = (xml: string): string | null => {
  if (Buffer.byteLength(xml, "utf-8") > maxInvoiceNumberXmlBytes) {
    return null;
  }
  const invoice = getInvoiceNode(parseInvoiceXml(xml));
  for (const buyerNamePath of buyerNamePaths) {
    const buyerName = getNestedText(invoice, buyerNamePath);
    if (buyerName) return buyerName;
  }
  return null;
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

const sanitizeBaseSegment = (value: string | null | undefined): string => {
  if (!value) return "";
  return sanitizeFileName(value);
};

export const resolveFlatInvoiceFileBase = (
  xml: string,
  ksefNumber: string,
  metadata?: InvoiceFileMetadata,
): string => {
  const sellerName = sanitizeBaseSegment(
    metadata?.seller?.name ?? extractSellerName(xml),
  );
  const invoiceNumber = sanitizeBaseSegment(
    metadata?.invoiceNumber ?? extractInvoiceNumber(xml),
  );
  const baseName = sanitizeFileName(
    [sellerName, invoiceNumber].filter((value) => value.length > 0).join(" - "),
  );
  return baseName || ksefNumber;
};

export const createSyncItem = (
  nip: string,
  ksefNumber: string,
  filePath: string,
  xmlText: string,
  pdfPath: string | null = null,
): SyncItem => {
  const paymentInfo = analyzeInvoicePayment(xmlText, nip);
  return {
    nip,
    ksefNumber,
    path: filePath,
    dueDate: paymentInfo.dueDate,
    needsPaymentNotification: isEligibleForNotification(paymentInfo),
    sellerName: extractSellerName(xmlText),
    buyerName: extractBuyerName(xmlText),
    invoiceNumber: extractInvoiceNumber(xmlText),
    amount: paymentInfo.amount,
    currency: paymentInfo.currency,
    bankAccount: paymentInfo.bankAccount,
    pdfPath,
  };
};
