import { xml2js } from "xml-js";

export type InvoiceType = "payable" | "receivable";

export type PaymentStatus = "paid" | "unpaid";

export type InvoicePaymentInfo = {
  invoiceType: InvoiceType;
  paymentStatus: PaymentStatus;
  dueDate: string | null;
  amount: string | null;
  currency: string | null;
};

const maxXmlBytes = 5_000_000;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const emptyPaymentInfo: InvoicePaymentInfo = {
  invoiceType: "receivable",
  paymentStatus: "unpaid",
  dueDate: null,
  amount: null,
  currency: null,
};

const stripDoctype = (xml: string): string =>
  xml.replace(/<!DOCTYPE[\s\S]*?>/gi, "");

const stripPrefixes = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripPrefixes);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key.includes(":") ? key.split(":")[1] : key,
        stripPrefixes(entry),
      ]),
    );
  }
  return value;
};

const extractTextValue = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;

  const record = value as { _text?: unknown; _cdata?: unknown };
  if (typeof record._text === "string") return record._text;
  if (typeof record._cdata === "string") return record._cdata;
  return null;
};

const normalizeText = (value: string | null): string | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeDate = (value: string | null): string | null => {
  const trimmed = normalizeText(value);
  if (!trimmed) return null;
  return isoDatePattern.test(trimmed) ? trimmed : null;
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
  return normalizeText(extractTextValue(current));
};

const collectNestedTexts = (value: unknown, keys: string[]): string[] => {
  if (!value) return [];
  if (keys.length === 0) {
    const text = normalizeText(extractTextValue(value));
    return text ? [text] : [];
  }

  const [head, ...tail] = keys;
  if (!head) return [];

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectNestedTexts(entry, keys));
  }

  const child = getChild(value, head);
  if (Array.isArray(child)) {
    return child.flatMap((entry) => collectNestedTexts(entry, tail));
  }
  return collectNestedTexts(child, tail);
};

const findDueDateInDescriptions = (fa: unknown): string | null => {
  const descriptions = collectNestedTexts(fa, ["DodatkowyOpis", "Klucz"]);
  for (const description of descriptions) {
    const match = /terminie\s+(\d{4}-\d{2}-\d{2})/i.exec(description);
    if (match) {
      return match[1] ?? null;
    }
  }
  return null;
};

const extractBuyerNip = (invoice: unknown): string | null =>
  getNestedText(invoice, ["Podmiot2", "DaneIdentyfikacyjne", "NIP"]);

const extractSellerNip = (invoice: unknown): string | null =>
  getNestedText(invoice, ["Podmiot1", "DaneIdentyfikacyjne", "NIP"]);

const extractDueDate = (invoice: unknown): string | null => {
  const fa = getChild(invoice, "Fa");
  if (!fa) return null;

  const directDueDate = normalizeDate(
    getNestedText(fa, ["Platnosc", "TerminPlatnosci", "Termin"]),
  );
  if (directDueDate) return directDueDate;

  const fallbackDescriptionDate = findDueDateInDescriptions(fa);
  if (fallbackDescriptionDate) return fallbackDescriptionDate;

  return null;
};

const hasTruthyMarker = (value: string | null): boolean => {
  const normalized = normalizeText(value)?.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "tak";
};

const hasPositiveAmount = (value: string | null): boolean => {
  const normalized = normalizeText(value);
  if (!normalized) return false;

  const amount = Number.parseFloat(normalized.replace(",", "."));
  return Number.isFinite(amount) && amount > 0;
};

const extractPaymentStatus = (invoice: unknown): PaymentStatus => {
  const fa = getChild(invoice, "Fa");
  if (!fa) return "unpaid";

  if (hasTruthyMarker(getNestedText(fa, ["Platnosc", "Zaplacono"]))) {
    return "paid";
  }

  if (normalizeDate(getNestedText(fa, ["Platnosc", "DataZaplaty"]))) {
    return "paid";
  }

  if (hasPositiveAmount(getNestedText(fa, ["Platnosc", "KwotaZaplacona"]))) {
    return "paid";
  }

  return "unpaid";
};

const parseInvoiceXml = (xml: string): unknown => {
  try {
    return stripPrefixes(xml2js(stripDoctype(xml), { compact: true }));
  } catch {
    return null;
  }
};

const extractGrossAmount = (invoice: unknown): string | null => {
  const fa = getChild(invoice, "Fa");
  if (!fa) return null;
  return normalizeText(extractTextValue(getChild(fa, "P_15")));
};

const extractCurrency = (invoice: unknown): string | null => {
  const fa = getChild(invoice, "Fa");
  if (!fa) return null;
  return normalizeText(extractTextValue(getChild(fa, "Waluta")));
};

export const analyzeInvoicePayment = (
  xml: string,
  subjectNip: string,
): InvoicePaymentInfo => {
  if (xml.trim().length === 0) return emptyPaymentInfo;
  if (Buffer.byteLength(xml, "utf-8") > maxXmlBytes) return emptyPaymentInfo;

  const parsed = parseInvoiceXml(xml);
  if (!parsed || typeof parsed !== "object") return emptyPaymentInfo;

  const invoice = getChild(parsed, "Faktura") ?? parsed;
  const buyerNip = extractBuyerNip(invoice);
  const sellerNip = extractSellerNip(invoice);

  const invoiceType: InvoiceType =
    buyerNip === subjectNip && buyerNip !== null
      ? "payable"
      : sellerNip === subjectNip && sellerNip !== null
        ? "receivable"
        : "receivable";

  return {
    invoiceType,
    paymentStatus: extractPaymentStatus(invoice),
    dueDate: extractDueDate(invoice),
    amount: extractGrossAmount(invoice),
    currency: extractCurrency(invoice),
  };
};

export const isEligibleForNotification = (info: InvoicePaymentInfo): boolean =>
  info.invoiceType === "payable" &&
  info.paymentStatus === "unpaid" &&
  Boolean(info.dueDate);
