import type { SyncItem } from "../core/syncService";

const sanitizeForTerminal = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

export const getInvoicesToPay = (items: SyncItem[]): SyncItem[] =>
  items.filter((item) => item.needsPaymentNotification);

export const formatInvoiceToPay = (item: SyncItem): string => {
  const dueDate = item.dueDate ?? "-";
  return [
    `NIP ${sanitizeForTerminal(item.nip)}`,
    `due ${sanitizeForTerminal(dueDate)}`,
    `KSeF ${sanitizeForTerminal(item.ksefNumber)}`,
    `-> ${sanitizeForTerminal(item.path)}`,
  ].join(" | ");
};

export const formatInvoicesToPay = (items: SyncItem[]): string[] =>
  getInvoicesToPay(items).map(formatInvoiceToPay);
