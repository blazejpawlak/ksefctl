import { describe, expect, it } from "vitest";
import {
  extractInvoiceNumber,
  extractTextValue,
  maxExtractedTextValueLength,
} from "../../src/core/invoiceExtractor";

describe("invoiceExtractor", () => {
  it("limits oversized extracted text values", () => {
    const value = "A".repeat(maxExtractedTextValueLength + 128);

    expect(extractTextValue(value)).toHaveLength(maxExtractedTextValueLength);
  });

  it("limits oversized invoice numbers extracted from XML", () => {
    const invoiceNumber = "F".repeat(maxExtractedTextValueLength + 64);
    const xml = `<Invoice><P_2>${invoiceNumber}</P_2></Invoice>`;

    expect(extractInvoiceNumber(xml)).toBe(
      "F".repeat(maxExtractedTextValueLength),
    );
  });
});
