import type { AppConfig } from "../../src/config/schema";
import type { PdfService } from "../../src/services/pdfService";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { repairMissingInvoicePdfs } from "../../src/core/pdfRepairService";

const createLogger = (): Logger => ({ warn: vi.fn() }) as unknown as Logger;

const createConfig = (root: string): AppConfig =>
  ({
    storage: { root },
    organizations: [{ nip: "1234567890" }],
  }) as unknown as AppConfig;

const createInvoiceXml = (): string =>
  "<Faktura><Naglowek><KodFormularza kodSystemowy=\"FA (3)\" /></Naglowek></Faktura>";

describe("repairMissingInvoicePdfs", () => {
  it("generates a PDF for local XML invoices missing a PDF", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-pdf-repair-"));
    const invoiceDir = path.join(
      root,
      "invoices",
      "1234567890",
      "2026",
      "06",
      "10",
      "KSEF-1",
    );
    await fs.mkdir(invoiceDir, { recursive: true });
    await fs.writeFile(
      path.join(invoiceDir, "invoice.xml"),
      createInvoiceXml(),
    );
    await fs.writeFile(
      path.join(invoiceDir, "metadata.json"),
      JSON.stringify({ nip: "1234567890", ksefNumber: "KSEF-1" }),
    );
    const generateInvoicePdf = vi.fn().mockResolvedValue({
      status: "ok",
      buffer: Buffer.from("pdf"),
    });
    const pdfService = {
      generateInvoicePdf,
    } as unknown as PdfService;

    const result = await repairMissingInvoicePdfs({
      config: createConfig(root),
      logger: createLogger(),
      pdfService,
    });

    expect(result).toMatchObject({
      scanned: 1,
      missing: 1,
      repaired: 1,
      failed: 0,
    });
    await expect(
      fs.readFile(path.join(invoiceDir, "invoice.pdf")),
    ).resolves.toEqual(Buffer.from("pdf"));
    expect(generateInvoicePdf).toHaveBeenCalledWith(
      createInvoiceXml(),
      "KSEF-1",
    );
  });

  it("reports failures without writing a PDF", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-pdf-repair-"));
    const invoiceDir = path.join(root, "invoices", "1234567890", "KSEF-2");
    await fs.mkdir(invoiceDir, { recursive: true });
    await fs.writeFile(
      path.join(invoiceDir, "invoice.xml"),
      createInvoiceXml(),
    );
    await fs.writeFile(
      path.join(invoiceDir, "metadata.json"),
      JSON.stringify({ nip: "1234567890", ksefNumber: "KSEF-2" }),
    );
    const pdfService = {
      generateInvoicePdf: vi.fn().mockResolvedValue({
        status: "failed",
        reason: "timeout",
        message: "PDF generation timed out after 5 ms",
      }),
    } as unknown as PdfService;

    const result = await repairMissingInvoicePdfs({
      config: createConfig(root),
      logger: createLogger(),
      pdfService,
    });

    expect(result.failed).toBe(1);
    expect(result.items[0]).toMatchObject({
      ksefNumber: "KSEF-2",
      status: "failed",
      reason: "timeout",
    });
    await expect(
      fs.stat(path.join(invoiceDir, "invoice.pdf")),
    ).rejects.toThrow();
  });
});
