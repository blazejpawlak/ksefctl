import type { PdfGeneratorModule } from "../../src/types/ksef-pdf-generator.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { PdfService } from "../../src/services/pdfService.js";

const generateFA1 = vi.fn(() => ({
  getBuffer: (cb: (buffer: Buffer) => void) => cb(Buffer.from("pdf1")),
}));
const generateFA2 = vi.fn(() => ({
  getBuffer: (cb: (buffer: Buffer) => void) => cb(Buffer.from("pdf2")),
}));
const generateFA3 = vi.fn(() => ({
  getBuffer: (cb: (buffer: Buffer) => void) => cb(Buffer.from("pdf3")),
}));

const loader = (): Promise<PdfGeneratorModule> =>
  Promise.resolve({ generateFA1, generateFA2, generateFA3 });

describe("PdfService", () => {
  beforeEach(() => {
    // The converter mocks live for the whole file; clear their calls so the
    // call-count assertions do not depend on which tests ran first.
    generateFA1.mockClear();
    generateFA2.mockClear();
    generateFA3.mockClear();
  });

  it("generates a PDF buffer for FA (1)", async () => {
    const xml =
      "<Faktura><Naglowek><KodFormularza kodSystemowy=\"FA(1)\" /></Naglowek></Faktura>";
    const service = new PdfService({ loader });
    const result = await service.generateInvoicePdf(xml, "KSEF-1");

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(Buffer.isBuffer(result.buffer)).toBe(true);
      expect(result.buffer.toString("utf-8")).toBe("pdf1");
    }
    expect(generateFA1).toHaveBeenCalledTimes(1);
    expect(generateFA2).toHaveBeenCalledTimes(0);
    expect(generateFA3).toHaveBeenCalledTimes(0);
  });

  it("normalizes FA (2) and generates PDF", async () => {
    const xml =
      "<Faktura><Naglowek><KodFormularza kodSystemowy=\"FA (2)\" /></Naglowek></Faktura>";
    const service = new PdfService({ loader });
    const result = await service.generateInvoicePdf(xml, "KSEF-4");

    expect(result.status).toBe("ok");
    expect(generateFA2).toHaveBeenCalledTimes(1);
  });

  it("returns failure for unsupported schemas", async () => {
    const xml =
      "<Faktura><Naglowek><KodFormularza kodSystemowy=\"FA (9)\" /></Naglowek></Faktura>";
    const service = new PdfService({ loader });
    const result = await service.generateInvoicePdf(xml, "KSEF-2");

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toBe("unsupported-schema");
      expect(result.message).toBe("Unsupported invoice schema: FA (9)");
    }
  });

  it("returns failure when Faktura element is missing", async () => {
    const xml = "<Root></Root>";
    const service = new PdfService({ loader });
    const result = await service.generateInvoicePdf(xml, "KSEF-3");

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toBe("missing-invoice");
      expect(result.message).toBe("Invoice XML missing Faktura root element");
    }
  });

  it("returns timeout when PDF rendering never finishes", async () => {
    const xml =
      "<Faktura><Naglowek><KodFormularza kodSystemowy=\"FA (3)\" /></Naglowek></Faktura>";
    const service = new PdfService({
      timeoutMs: 5,
      loader: () =>
        Promise.resolve({
          generateFA1: vi.fn(),
          generateFA2: vi.fn(),
          generateFA3: vi.fn(() => ({
            getBuffer: () => undefined,
          })),
        }),
    });

    const result = await service.generateInvoicePdf(xml, "KSEF-5");

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toBe("timeout");
      expect(result.message).toBe("PDF generation timed out after 5 ms");
    }
  });

  it("supports promise-based PDF buffer rendering", async () => {
    const xml =
      "<Faktura><Naglowek><KodFormularza kodSystemowy=\"FA (3)\" /></Naglowek></Faktura>";
    const service = new PdfService({
      loader: () =>
        Promise.resolve({
          generateFA1: vi.fn(),
          generateFA2: vi.fn(),
          generateFA3: vi.fn(() => ({
            value: Buffer.from("pdf-promise"),
            getBuffer() {
              return Promise.resolve(this.value);
            },
          })),
        }),
    });

    const result = await service.generateInvoicePdf(xml, "KSEF-6");

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.buffer.toString("utf-8")).toBe("pdf-promise");
    }
  });

  it("loads the vendored converter bundle and renders a real invoice PDF", async () => {
    const xml = await fs.readFile(
      path.join(import.meta.dirname, "..", "fixtures", "invoices", "fa3.xml"),
      "utf-8",
    );
    const result = await new PdfService().generateInvoicePdf(xml, "KSEF-7");

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
  });

  it("reports the generator as unavailable when the loader rejects", async () => {
    const xml =
      "<Faktura><Naglowek><KodFormularza kodSystemowy=\"FA (3)\" /></Naglowek></Faktura>";
    const service = new PdfService({
      loader: () => Promise.reject(new Error("bundle missing")),
    });

    const result = await service.generateInvoicePdf(xml, "KSEF-8");

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toBe("generator-unavailable");
    }
  });
});
