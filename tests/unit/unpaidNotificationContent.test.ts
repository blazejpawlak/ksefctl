import { describe, expect, it } from "vitest";
import {
  formatEmailNotificationContent,
  formatMacNotificationContent,
} from "../../src/notifications/unpaidNotificationContent";

const singleItem = [
  {
    nip: "5541346379",
    ksefNumber: "5261040337-20260325-7CC03A400054-53",
    path: "/tmp/invoice-1",
    dueDate: "2026-03-24",
    needsPaymentNotification: true,
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
  });
});
