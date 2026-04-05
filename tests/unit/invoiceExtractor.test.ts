import { describe, expect, it } from "vitest";
import {
  extractInvoiceNumber,
  extractSellerName,
  extractTextValue,
  maxExtractedTextValueLength,
  resolveFlatInvoiceFileBase,
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

  it("extracts seller name from invoice XML", () => {
    const xml = `
      <Faktura>
        <Podmiot1>
          <DaneIdentyfikacyjne>
            <Nazwa>ACME Sp. z o.o.</Nazwa>
          </DaneIdentyfikacyjne>
        </Podmiot1>
      </Faktura>
    `;

    expect(extractSellerName(xml)).toBe("ACME Sp. z o.o.");
  });

  it("prefers metadata when resolving flat invoice file base", () => {
    const xml = `
      <Faktura>
        <Podmiot1>
          <DaneIdentyfikacyjne>
            <Nazwa>XML Seller</Nazwa>
          </DaneIdentyfikacyjne>
        </Podmiot1>
        <Fa>
          <P_2>XML/123</P_2>
        </Fa>
      </Faktura>
    `;

    expect(
      resolveFlatInvoiceFileBase(xml, "KSEF-1", {
        seller: { name: "ACME / Seller" },
        invoiceNumber: "FV/1:2026?",
      }),
    ).toBe("ACME - Seller - FV-1-2026-");
  });

  it("falls back to XML when metadata is unavailable", () => {
    const xml = `
      <Faktura>
        <Podmiot1>
          <DaneIdentyfikacyjne>
            <Nazwa>XML Seller</Nazwa>
          </DaneIdentyfikacyjne>
        </Podmiot1>
        <Fa>
          <P_2>FV/77</P_2>
        </Fa>
      </Faktura>
    `;

    expect(resolveFlatInvoiceFileBase(xml, "KSEF-77")).toBe(
      "XML Seller - FV-77",
    );
  });

  it("falls back to KSeF number when seller and invoice number are missing", () => {
    expect(resolveFlatInvoiceFileBase("<Faktura />", "KSEF-EMPTY")).toBe(
      "KSEF-EMPTY",
    );
  });
});
