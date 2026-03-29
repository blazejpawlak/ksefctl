import { describe, expect, it } from "vitest";
import {
  formatInvoiceToPay,
  formatInvoicesToPay,
  getInvoicesToPay,
} from "../../src/cli/paymentSummary";

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
        },
        {
          nip: "1234567890",
          ksefNumber: "KSEF-2",
          path: "/tmp/b",
          dueDate: null,
          needsPaymentNotification: false,
        },
      ]),
    ).toEqual([
      {
        nip: "1234567890",
        ksefNumber: "KSEF-1",
        path: "/tmp/a",
        dueDate: "2026-03-24",
        needsPaymentNotification: true,
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
      }),
    ).toBe("1234567890 | KSEF-1 | due 2026-03-24 | -> /tmp/a");
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
        },
      ]),
    ).toEqual(["1234567890 | KSEF-1 | due 2026-03-24 | -> /tmp/a"]);
  });
});
