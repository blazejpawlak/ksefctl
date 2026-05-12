import type { SyncItem } from "../core/syncService";
import path from "node:path";

const sanitizeText = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();

const escapeHtml = (value: string): string =>
  sanitizeText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const escapeOptionalHtml = (value: string | null): string =>
  value ? escapeHtml(value) : "&mdash;";

const formatDueDate = (dueDate: string | null): string =>
  dueDate ? `Due ${sanitizeText(dueDate)}` : "Due date unavailable";

const formatDueDateValue = (dueDate: string | null): string =>
  dueDate ? sanitizeText(dueDate) : "Unavailable";

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
  html: string;
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
  if (item.sellerName)
    lines.push(`   Seller: ${sanitizeText(item.sellerName)}`);
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

const formatAmount = (item: Pick<SyncItem, "amount" | "currency">): string => {
  if (!item.amount) return "—";
  return item.currency
    ? `${sanitizeText(item.amount)} ${sanitizeText(item.currency)}`
    : sanitizeText(item.amount);
};

const formatHtmlAmount = (
  item: Pick<SyncItem, "amount" | "currency">,
): string => {
  if (!item.amount) return "&mdash;";
  return item.currency
    ? `${escapeHtml(item.amount)} ${escapeHtml(item.currency)}`
    : escapeHtml(item.amount);
};

const getOrgLabel = (item: SyncItem, orgLabels?: OrgLabels): string =>
  orgLabels?.get(item.nip) ?? item.buyerName ?? `NIP ${item.nip}`;

const formatAttachmentName = (item: SyncItem): string | null =>
  item.pdfPath ? path.basename(item.pdfPath) : null;

const sumInvoiceAmounts = (items: SyncItem[]): string => {
  const amounts = items.map((item) => Number.parseFloat(item.amount ?? ""));
  if (amounts.some((amount) => !Number.isFinite(amount))) return "See table";

  const currencies = new Set(
    items
      .map((item) => item.currency)
      .filter((currency): currency is string => Boolean(currency)),
  );
  if (currencies.size > 1) return "See table";

  const total = amounts.reduce((sum, amount) => sum + amount, 0).toFixed(2);
  const currency = [...currencies][0];
  return currency ? `${total} ${sanitizeText(currency)}` : total;
};

const findEarliestDueDate = (items: SyncItem[]): string => {
  const dueDates = items
    .map((item) => item.dueDate)
    .filter((dueDate): dueDate is string => Boolean(dueDate))
    .sort();
  return dueDates[0] ? sanitizeText(dueDates[0]) : "Unavailable";
};

const styles = {
  page: "margin:0;padding:0;background-color:#f4f7fb;",
  container:
    "width:100%;max-width:720px;background-color:#ffffff;border:1px solid #d9e2ec;border-radius:16px;overflow:hidden;",
  header:
    "padding:24px 28px;background-color:#0f172a;color:#ffffff;font-family:Arial,Helvetica,sans-serif;",
  title: "margin:0;font-size:22px;line-height:28px;font-weight:700;",
  subtitle: "margin:6px 0 0;color:#cbd5e1;font-size:14px;line-height:20px;",
  body: "padding:28px;font-family:Arial,Helvetica,sans-serif;color:#1f2937;",
  card: "padding:16px;border:1px solid #d9e2ec;border-radius:12px;background-color:#f8fafc;",
  label:
    "font-size:12px;line-height:16px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;",
  value:
    "padding-top:6px;font-size:18px;line-height:24px;color:#0f172a;font-weight:700;",
  sectionTitle:
    "padding-top:26px;padding-bottom:10px;font-size:16px;line-height:22px;color:#0f172a;font-weight:700;",
  th: "padding:10px 12px;background-color:#e2e8f0;color:#334155;font-size:12px;line-height:16px;text-align:left;border-bottom:1px solid #cbd5e1;",
  td: "padding:11px 12px;color:#1f2937;font-size:13px;line-height:18px;border-bottom:1px solid #e2e8f0;vertical-align:top;",
  muted: "color:#64748b;",
  footer:
    "padding:18px 28px;background-color:#f8fafc;color:#64748b;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;",
};

const renderSummaryCard = (label: string, value: string): string => `
  <td width="33.33%" style="padding-right:10px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td style="${styles.card}">
        <div style="${styles.label}">${escapeHtml(label)}</div>
        <div style="${styles.value}">${escapeHtml(value)}</div>
      </td></tr>
    </table>
  </td>`;

const renderSummaryCards = (items: SyncItem[]): string => {
  const paymentLabel =
    items.length === 1 ? "1 invoice" : `${items.length} invoices`;
  const amount =
    items.length === 1 ? formatAmount(items[0]!) : sumInvoiceAmounts(items);
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        ${renderSummaryCard("Payment required", paymentLabel)}
        ${renderSummaryCard("Total amount", amount)}
        ${renderSummaryCard("Earliest due date", findEarliestDueDate(items))}
      </tr>
    </table>`;
};

const renderDetailsTable = (item: SyncItem, orgLabels?: OrgLabels): string => {
  const rows: [string, string][] = [
    ["Seller", escapeOptionalHtml(item.sellerName)],
    ["Buyer", escapeHtml(getOrgLabel(item, orgLabels))],
    ["NIP", escapeHtml(item.nip)],
    ["Invoice", escapeOptionalHtml(item.invoiceNumber)],
    ["Amount", formatHtmlAmount(item)],
    ["Due date", escapeHtml(formatDueDateValue(item.dueDate))],
    ["KSeF", escapeHtml(item.ksefNumber)],
    ["Folder", escapeHtml(item.path)],
  ];

  return `
    <div style="${styles.sectionTitle}">Invoice details</div>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #d9e2ec;border-radius:12px;overflow:hidden;">
      ${rows
        .map(
          ([label, value]) => `
            <tr>
              <td width="30%" style="${styles.td}${styles.muted}">${escapeHtml(label)}</td>
              <td style="${styles.td}">${value}</td>
            </tr>`,
        )
        .join("")}
    </table>`;
};

const renderInvoiceRows = (items: SyncItem[]): string =>
  items
    .map(
      (item, index) => `
        <tr>
          <td style="${styles.td}">${index + 1}</td>
          <td style="${styles.td}">${escapeOptionalHtml(item.sellerName)}</td>
          <td style="${styles.td}">${escapeOptionalHtml(item.invoiceNumber)}</td>
          <td style="${styles.td}">${escapeHtml(formatDueDateValue(item.dueDate))}</td>
          <td style="${styles.td}">${formatHtmlAmount(item)}</td>
        </tr>`,
    )
    .join("");

const renderInvoiceTable = (items: SyncItem[]): string => `
  <div style="${styles.sectionTitle}">Invoices requiring payment</div>
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #d9e2ec;border-radius:12px;overflow:hidden;">
    <tr>
      <th style="${styles.th}">#</th>
      <th style="${styles.th}">Seller</th>
      <th style="${styles.th}">Invoice</th>
      <th style="${styles.th}">Due date</th>
      <th style="${styles.th}">Amount</th>
    </tr>
    ${renderInvoiceRows(items)}
  </table>`;

const renderAttachments = (items: SyncItem[]): string => {
  const attachmentNames = items
    .map(formatAttachmentName)
    .filter((name): name is string => name !== null);
  if (attachmentNames.length === 0) return "";

  return `
    <div style="${styles.sectionTitle}">Attachments</div>
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      ${attachmentNames
        .map(
          (name) => `
            <tr>
              <td style="padding:8px 0;color:#1f2937;font-size:13px;line-height:18px;">📎 ${escapeHtml(name)}</td>
            </tr>`,
        )
        .join("")}
    </table>`;
};

const formatEmailHtml = (
  items: SyncItem[],
  generatedAt: string,
  orgLabels?: OrgLabels,
): string => {
  const invoiceLabel =
    items.length === 1
      ? "1 invoice requires"
      : `${items.length} invoices require`;
  const details =
    items.length === 1
      ? renderDetailsTable(items[0]!, orgLabels)
      : renderInvoiceTable(items);

  return `<!doctype html>
<html lang="en">
  <body style="${styles.page}">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f4f7fb">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="720" style="${styles.container}">
            <tr>
              <td style="${styles.header}">
                <h1 style="${styles.title}">KSeFctl Invoice Alert</h1>
                <p style="${styles.subtitle}">${invoiceLabel} payment</p>
              </td>
            </tr>
            <tr>
              <td style="${styles.body}">
                ${renderSummaryCards(items)}
                ${details}
                ${renderAttachments(items)}
              </td>
            </tr>
            <tr>
              <td style="${styles.footer}">Generated at: ${escapeHtml(generatedAt)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
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
    html: formatEmailHtml(items, generatedAt, orgLabels),
  };
};
