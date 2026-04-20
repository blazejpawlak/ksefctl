import type { SyncItem } from "../core/syncService";

const sanitizeText = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();

const formatDueDate = (dueDate: string | null): string =>
  dueDate ? `Due ${sanitizeText(dueDate)}` : "Due date unavailable";

const formatNip = (nip: string): string => `NIP ${sanitizeText(nip)}`;

const formatKsefNumber = (ksefNumber: string): string =>
  `KSeF ${sanitizeText(ksefNumber)}`;

const formatFolder = (path: string): string => `Folder: ${sanitizeText(path)}`;

export type MacNotificationContent = {
  title: string;
  message: string;
  subtitle: string;
};

export type EmailNotificationContent = {
  subject: string;
  body: string;
};

export type OrgLabels = Map<string, string | undefined>;

export const formatMacNotificationContent = (
  items: SyncItem[],
): MacNotificationContent => {
  const firstItem = items[0];
  if (!firstItem) {
    return {
      title: "Invoice requires payment",
      message: "Review ksefctl output for details",
      subtitle: "",
    };
  }

  if (items.length === 1) {
    return {
      title: "Invoice requires payment",
      message: formatDueDate(firstItem.dueDate),
      subtitle: `${formatNip(firstItem.nip)} • ${formatKsefNumber(firstItem.ksefNumber)}`,
    };
  }

  return {
    title: `${items.length} invoices require payment`,
    message: "Check due dates in ksefctl output",
    subtitle: `First: ${formatNip(firstItem.nip)} • ${formatDueDate(firstItem.dueDate)}`,
  };
};

const formatEmailItem = (
  item: SyncItem,
  index: number,
  orgLabels?: OrgLabels,
): string[] => {
  const label = orgLabels?.get(item.nip);
  const orgLine = label
    ? `${index}. ${sanitizeText(label)} (${formatNip(item.nip)})`
    : `${index}. ${formatNip(item.nip)}`;

  const lines = [orgLine];
  if (item.sellerName) lines.push(`   Seller: ${sanitizeText(item.sellerName)}`);
  if (item.buyerName) lines.push(`   Buyer: ${sanitizeText(item.buyerName)}`);
  if (item.invoiceNumber)
    lines.push(`   Invoice: ${sanitizeText(item.invoiceNumber)}`);
  if (item.amount) {
    const amountLine = item.currency
      ? `   Amount: ${sanitizeText(item.amount)} ${sanitizeText(item.currency)}`
      : `   Amount: ${sanitizeText(item.amount)}`;
    lines.push(amountLine);
  }
  lines.push(`   ${formatDueDate(item.dueDate)}`);
  lines.push(`   ${formatKsefNumber(item.ksefNumber)}`);
  lines.push(`   ${formatFolder(item.path)}`);
  return lines;
};

export const formatEmailNotificationContent = (
  items: SyncItem[],
  generatedAt: string,
  orgLabels?: OrgLabels,
): EmailNotificationContent => {
  const invoiceLabel =
    items.length === 1 ? "invoice requires" : "invoices require";
  return {
    subject: `KSeFctl: ${items.length} ${invoiceLabel} payment`,
    body: [
      `The following ${invoiceLabel} payment.`,
      "",
      ...items.flatMap((item, index) => [
        ...formatEmailItem(item, index + 1, orgLabels),
        "",
      ]),
      `Generated at: ${generatedAt}`,
    ].join("\n"),
  };
};
