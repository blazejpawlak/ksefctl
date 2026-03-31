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

const formatEmailItem = (item: SyncItem, index: number): string[] => [
  `${index}. ${formatNip(item.nip)}`,
  `   ${formatDueDate(item.dueDate)}`,
  `   ${formatKsefNumber(item.ksefNumber)}`,
  `   ${formatFolder(item.path)}`,
];

export const formatEmailNotificationContent = (
  items: SyncItem[],
  generatedAt: string,
): EmailNotificationContent => {
  const invoiceLabel =
    items.length === 1 ? "invoice requires" : "invoices require";
  return {
    subject: `KSeFctl: ${items.length} ${invoiceLabel} payment`,
    body: [
      `The following ${invoiceLabel} payment.`,
      "",
      ...items.flatMap((item, index) => [
        ...formatEmailItem(item, index + 1),
        "",
      ]),
      `Generated at: ${generatedAt}`,
    ].join("\n"),
  };
};
