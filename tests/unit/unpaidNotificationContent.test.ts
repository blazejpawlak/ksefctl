import { describe, expect, it } from "vitest";
import {
  formatEmailNotificationContent,
  formatMacNotificationContent,
} from "../../src/notifications/unpaidNotificationContent";

const nullFields = {
  sellerName: null,
  buyerName: null,
  invoiceNumber: null,
  amount: null,
  currency: null,
  pdfPath: null,
};

const singleItem = [
  {
    nip: "5541346379",
    ksefNumber: "5261040337-20260325-7CC03A400054-53",
    path: "/tmp/invoice-1",
    dueDate: "2026-03-24",
    needsPaymentNotification: true,
    ...nullFields,
  },
];

describe("unpaidNotificationContent", () => {
  it("formats single-invoice mac notification content", () => {
    expect(formatMacNotificationContent(singleItem)).toEqual({
      title: "Invoice requires payment",
      message: "Due 2026-03-24",
      subtitle: "NIP 5541346379 • KSeF 5261040337-20260325-7CC03A400054-53",
    });
  });

  it("formats multi-invoice mac notification content", () => {
    expect(
      formatMacNotificationContent([
        ...singleItem,
        {
          nip: "7393955632",
          ksefNumber: "KSEF-2",
          path: "/tmp/invoice-2",
          dueDate: "2026-03-25",
          needsPaymentNotification: true,
          ...nullFields,
        },
      ]),
    ).toEqual({
      title: "2 invoices require payment",
      message: "Check due dates in ksefctl output",
      subtitle: "First: NIP 5541346379 • Due 2026-03-24",
    });
  });

  it("formats email notification content with labels", () => {
    const content = formatEmailNotificationContent(
      singleItem,
      "2026-03-31T00:00:00.000Z",
    );

    expect(content.subject).toBe("KSeFctl: 1 invoice requires payment");
    expect(content.body).toContain("The following invoice requires payment.");
    expect(content.body).toContain("1. NIP 5541346379");
    expect(content.body).toContain("Due 2026-03-24");
    expect(content.body).toContain("KSeF 5261040337-20260325-7CC03A400054-53");
    expect(content.body).toContain("Folder: /tmp/invoice-1");
    expect(content.html).toContain("KSeFctl Invoice Alert");
    expect(content.html).toContain("1 invoice requires payment");
    expect(content.html).toContain("Invoice details");
    expect(content.html).toContain("2026-03-24");
  });

  it("shows org label when provided", () => {
    const orgLabels = new Map([["5541346379", "Acme Sp. z o.o."]]);
    const content = formatEmailNotificationContent(
      singleItem,
      "2026-03-31T00:00:00.000Z",
      orgLabels,
    );
    expect(content.body).toContain("1. Acme Sp. z o.o. (NIP 5541346379)");
    expect(content.body).not.toContain("1. NIP 5541346379");
  });

  it("shows seller name, buyer name, invoice number, and amount when present", () => {
    const richItem = [
      {
        ...singleItem[0]!,
        sellerName: "Example Supplier Sp. z o.o.",
        buyerName: "Our Company S.A.",
        invoiceNumber: "FV/2026/04/0042",
        amount: "1230.00",
        currency: "PLN",
      },
    ];
    const content = formatEmailNotificationContent(
      richItem,
      "2026-03-31T00:00:00.000Z",
    );
    expect(content.body).toContain("Seller: Example Supplier Sp. z o.o.");
    expect(content.body).toContain("Buyer: Our Company S.A.");
    expect(content.body).toContain("Invoice: FV/2026/04/0042");
    expect(content.body).toContain("Amount: 1230.00 PLN");
    expect(content.html).toContain("Example Supplier Sp. z o.o.");
    expect(content.html).toContain("1230.00 PLN");
  });

  it("formats multi-invoice email content as a dashboard table", () => {
    const content = formatEmailNotificationContent(
      [
        {
          ...singleItem[0]!,
          sellerName: "Example Supplier Sp. z o.o.",
          invoiceNumber: "FV/2026/04/0042",
          amount: "1230.00",
          currency: "PLN",
        },
        {
          nip: "7393955632",
          ksefNumber: "KSEF-2",
          path: "/tmp/invoice-2",
          dueDate: "2026-03-25",
          needsPaymentNotification: true,
          sellerName: "Second Supplier S.A.",
          buyerName: "Our Company S.A.",
          invoiceNumber: "FV/2026/04/0043",
          amount: "70.50",
          currency: "PLN",
          pdfPath: "/tmp/Faktura-2.pdf",
        },
      ],
      "2026-03-31T00:00:00.000Z",
    );

    expect(content.subject).toBe("KSeFctl: 2 invoices require payment");
    expect(content.html).toContain("2 invoices require payment");
    expect(content.html).toContain("Total amount");
    expect(content.html).toContain("1300.50 PLN");
    expect(content.html).toContain("Invoices requiring payment");
    expect(content.html).toContain("Second Supplier S.A.");
    expect(content.html).toContain("Faktura-2.pdf");
  });

  it("escapes HTML values in email content", () => {
    const content = formatEmailNotificationContent(
      [
        {
          ...singleItem[0]!,
          sellerName: "<script>alert('x')</script>",
        },
      ],
      "2026-03-31T00:00:00.000Z",
    );

    expect(content.html).toContain(
      "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;",
    );
    expect(content.html).not.toContain("<script>alert");
  });
});
