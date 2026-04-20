import { describe, expect, it } from "vitest";
import {
  formatInvoiceToPay,
  formatInvoicesToPay,
  getInvoicesToPay,
} from "../../src/cli/paymentSummary";

const nullFields = {
  sellerName: null,
  buyerName: null,
  invoiceNumber: null,
  amount: null,
  currency: null,
  pdfPath: null,
};

describe("paymentSummary", () => {
  it("filters only invoices that need payment notification", () => {
    expect(
      getInvoicesToPay([
        {
          nip: "1234567890",
          ksefNumber: "KSEF-1",
          path: "/tmp/a",
          dueDate: "2026-03-24",
          needsPaymentNotification: true,
          ...nullFields,
        },
        {
          nip: "1234567890",
          ksefNumber: "KSEF-2",
          path: "/tmp/b",
          dueDate: null,
          needsPaymentNotification: false,
          ...nullFields,
        },
      ]),
    ).toEqual([
      {
        nip: "1234567890",
        ksefNumber: "KSEF-1",
        path: "/tmp/a",
        dueDate: "2026-03-24",
        needsPaymentNotification: true,
        ...nullFields,
      },
    ]);
  });

  it("formats an invoice to pay with due date and path", () => {
    expect(
      formatInvoiceToPay({
        nip: "1234567890",
        ksefNumber: "KSEF-1",
        path: "/tmp/a",
        dueDate: "2026-03-24",
        needsPaymentNotification: true,
        ...nullFields,
      }),
    ).toBe("NIP 1234567890 | due 2026-03-24 | KSeF KSEF-1 | -> /tmp/a");
  });

  it("sanitizes terminal output and formats multiple invoices", () => {
    expect(
      formatInvoicesToPay([
        {
          nip: "1234567890\n",
          ksefNumber: "KSEF-1\t",
          path: "/tmp/a\r",
          dueDate: "2026-03-24",
          needsPaymentNotification: true,
          ...nullFields,
        },
      ]),
    ).toEqual(["NIP 1234567890 | due 2026-03-24 | KSeF KSEF-1 | -> /tmp/a"]);
  });
});
