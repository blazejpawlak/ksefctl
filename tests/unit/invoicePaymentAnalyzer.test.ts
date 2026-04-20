import { describe, expect, it } from "vitest";
import {
  analyzeInvoicePayment,
  isEligibleForNotification,
} from "../../src/core/invoicePaymentAnalyzer";

describe("invoicePaymentAnalyzer", () => {
  it("classifies payable unpaid invoice with due date from Platnosc", () => {
    const xml = `
      <Faktura>
        <Podmiot1>
          <DaneIdentyfikacyjne>
            <NIP>5261040337</NIP>
          </DaneIdentyfikacyjne>
        </Podmiot1>
        <Podmiot2>
          <DaneIdentyfikacyjne>
            <NIP>5541346379</NIP>
          </DaneIdentyfikacyjne>
        </Podmiot2>
        <Fa>
          <Platnosc>
            <TerminPlatnosci>
              <Termin>2026-03-24</Termin>
            </TerminPlatnosci>
            <FormaPlatnosci>6</FormaPlatnosci>
          </Platnosc>
        </Fa>
      </Faktura>
    `;

    expect(analyzeInvoicePayment(xml, "5541346379")).toEqual({
      invoiceType: "payable",
      paymentStatus: "unpaid",
      dueDate: "2026-03-24",
      amount: null,
      currency: null,
    });
  });

  it("classifies receivable invoice when subject is the seller", () => {
    const xml = `
      <Faktura>
        <Podmiot1>
          <DaneIdentyfikacyjne>
            <NIP>5541346379</NIP>
          </DaneIdentyfikacyjne>
        </Podmiot1>
        <Podmiot2>
          <DaneIdentyfikacyjne>
            <NIP>5213811400</NIP>
          </DaneIdentyfikacyjne>
        </Podmiot2>
        <Fa>
          <Platnosc>
            <TerminPlatnosci>
              <Termin>2026-03-20</Termin>
            </TerminPlatnosci>
          </Platnosc>
        </Fa>
      </Faktura>
    `;

    expect(analyzeInvoicePayment(xml, "5541346379").invoiceType).toBe(
      "receivable",
    );
  });

  it("marks invoice as paid when Zaplacono is set", () => {
    const xml = `
      <Faktura>
        <Podmiot1>
          <DaneIdentyfikacyjne>
            <NIP>5272898696</NIP>
          </DaneIdentyfikacyjne>
        </Podmiot1>
        <Podmiot2>
          <DaneIdentyfikacyjne>
            <NIP>5541346379</NIP>
          </DaneIdentyfikacyjne>
        </Podmiot2>
        <Fa>
          <Platnosc>
            <Zaplacono>1</Zaplacono>
            <DataZaplaty>2026-03-25</DataZaplaty>
            <TerminPlatnosci>
              <Termin>2026-03-25</Termin>
            </TerminPlatnosci>
          </Platnosc>
        </Fa>
      </Faktura>
    `;

    expect(analyzeInvoicePayment(xml, "5541346379").paymentStatus).toBe("paid");
  });

  it("does not mark invoice as paid when KwotaZaplacona is zero", () => {
    const xml = `
      <Faktura>
        <Podmiot1>
          <DaneIdentyfikacyjne><NIP>5272898696</NIP></DaneIdentyfikacyjne>
        </Podmiot1>
        <Podmiot2>
          <DaneIdentyfikacyjne><NIP>5541346379</NIP></DaneIdentyfikacyjne>
        </Podmiot2>
        <Fa>
          <Platnosc>
            <KwotaZaplacona>0.00</KwotaZaplacona>
            <TerminPlatnosci><Termin>2026-03-25</Termin></TerminPlatnosci>
          </Platnosc>
        </Fa>
      </Faktura>
    `;

    expect(analyzeInvoicePayment(xml, "5541346379").paymentStatus).toBe(
      "unpaid",
    );
  });

  it("supports namespace-prefixed documents", () => {
    const xml = `
      <n0:Faktura xmlns:n0="http://example.test">
        <n0:Podmiot1>
          <n0:DaneIdentyfikacyjne>
            <n0:NIP>7740001454</n0:NIP>
          </n0:DaneIdentyfikacyjne>
        </n0:Podmiot1>
        <n0:Podmiot2>
          <n0:DaneIdentyfikacyjne>
            <n0:NIP>5541346379</n0:NIP>
          </n0:DaneIdentyfikacyjne>
        </n0:Podmiot2>
        <n0:Fa>
          <n0:Platnosc>
            <n0:TerminPlatnosci>
              <n0:Termin>2026-03-29</n0:Termin>
            </n0:TerminPlatnosci>
          </n0:Platnosc>
        </n0:Fa>
      </n0:Faktura>
    `;

    expect(analyzeInvoicePayment(xml, "5541346379").dueDate).toBe("2026-03-29");
  });

  it("falls back to due date embedded in XML description", () => {
    const xml = `
      <Faktura>
        <Podmiot1>
          <DaneIdentyfikacyjne>
            <NIP>8950021311</NIP>
          </DaneIdentyfikacyjne>
        </Podmiot1>
        <Podmiot2>
          <DaneIdentyfikacyjne>
            <NIP>5541346379</NIP>
          </DaneIdentyfikacyjne>
        </Podmiot2>
        <Fa>
          <DodatkowyOpis>
            <Klucz>Kwota do zapłaty w terminie 2026-02-16</Klucz>
            <Wartosc>Przedpłata 224.69 PLN</Wartosc>
          </DodatkowyOpis>
        </Fa>
      </Faktura>
    `;

    expect(analyzeInvoicePayment(xml, "5541346379").dueDate).toBe("2026-02-16");
  });

  it("returns safe defaults for invalid XML", () => {
    expect(analyzeInvoicePayment("<Faktura", "5541346379")).toEqual({
      invoiceType: "receivable",
      paymentStatus: "unpaid",
      dueDate: null,
      amount: null,
      currency: null,
    });
  });

  it("returns safe defaults for oversized XML", () => {
    const xml = `<Faktura>${"x".repeat(6_000_000)}</Faktura>`;

    expect(analyzeInvoicePayment(xml, "5541346379")).toEqual({
      invoiceType: "receivable",
      paymentStatus: "unpaid",
      dueDate: null,
      amount: null,
      currency: null,
    });
  });

  it("recognizes notification eligibility only for payable unpaid invoices with due date", () => {
    const base = { amount: null, currency: null };
    expect(
      isEligibleForNotification({
        invoiceType: "payable",
        paymentStatus: "unpaid",
        dueDate: "2026-03-24",
        ...base,
      }),
    ).toBe(true);

    expect(
      isEligibleForNotification({
        invoiceType: "payable",
        paymentStatus: "paid",
        dueDate: "2026-03-24",
        ...base,
      }),
    ).toBe(false);

    expect(
      isEligibleForNotification({
        invoiceType: "receivable",
        paymentStatus: "unpaid",
        dueDate: "2026-03-24",
        ...base,
      }),
    ).toBe(false);

    expect(
      isEligibleForNotification({
        invoiceType: "payable",
        paymentStatus: "unpaid",
        dueDate: null,
        ...base,
      }),
    ).toBe(false);
  });
});
