import {
  generateFA1,
  generateFA2,
  generateFA3,
} from "@akmf/ksef-fe-invoice-converter";
import { describe, expect, it, vi } from "vitest";
import { PdfService } from "../../src/services/pdfService";

vi.mock("@akmf/ksef-fe-invoice-converter", () => ({
  generateFA1: vi.fn(() => ({
    getBuffer: (cb: (buffer: Buffer) => void) => cb(Buffer.from("pdf1")),
  })),
  generateFA2: vi.fn(() => ({
    getBuffer: (cb: (buffer: Buffer) => void) => cb(Buffer.from("pdf2")),
  })),
  generateFA3: vi.fn(() => ({
    getBuffer: (cb: (buffer: Buffer) => void) => cb(Buffer.from("pdf3")),
  })),
}));

describe("PdfService", () => {
  it("generates a PDF buffer for FA (1)", async () => {
    const xml =
      "<Faktura><Naglowek><KodFormularza kodSystemowy=\"FA(1)\" /></Naglowek></Faktura>";
    const service = new PdfService();
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
    const service = new PdfService();
    const result = await service.generateInvoicePdf(xml, "KSEF-4");

    expect(result.status).toBe("ok");
    expect(generateFA2).toHaveBeenCalledTimes(1);
  });

  it("returns failure for unsupported schemas", async () => {
    const xml =
      "<Faktura><Naglowek><KodFormularza kodSystemowy=\"FA (9)\" /></Naglowek></Faktura>";
    const service = new PdfService();
    const result = await service.generateInvoicePdf(xml, "KSEF-2");

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toBe("unsupported-schema");
      expect(result.message).toBe("Unsupported invoice schema: FA (9)");
    }
  });

  it("returns failure when Faktura element is missing", async () => {
    const xml = "<Root></Root>";
    const service = new PdfService();
    const result = await service.generateInvoicePdf(xml, "KSEF-3");

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toBe("missing-invoice");
      expect(result.message).toBe("Invoice XML missing Faktura root element");
    }
  });
});
