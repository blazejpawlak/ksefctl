import type {
  AdditionalData,
  PdfBuffer,
  PdfDocument,
} from "@akmf/ksef-fe-invoice-converter";
import { xml2js } from "xml-js";

type PdfGeneratorModule = {
  generateFA1: (
    invoice: unknown,
    additionalData: AdditionalData,
  ) => PdfDocument;
  generateFA2: (
    invoice: unknown,
    additionalData: AdditionalData,
  ) => PdfDocument;
  generateFA3: (
    invoice: unknown,
    additionalData: AdditionalData,
  ) => PdfDocument;
};

type PdfGeneratorLoader = () => Promise<PdfGeneratorModule>;

type ParsedInvoice = {
  Faktura?: unknown;
};

type InvoiceHeader = {
  Naglowek?: {
    KodFormularza?: { _attributes?: { kodSystemowy?: string } };
  };
};

export type PdfGenerationFailureReason =
  | "runtime-unsupported"
  | "invalid-xml"
  | "missing-invoice"
  | "missing-version"
  | "unsupported-schema"
  | "generator-unavailable"
  | "generation-error";

export type PdfGenerationFailure = {
  status: "failed";
  reason: PdfGenerationFailureReason;
  message: string;
  error?: Error;
};

export type PdfGenerationResult =
  | {
      status: "ok";
      buffer: Buffer;
    }
  | PdfGenerationFailure;

const isNodeRuntime = (): boolean =>
  typeof process !== "undefined" &&
  typeof process.versions?.node === "string" &&
  typeof Buffer !== "undefined";

const maxPdfXmlBytes = 5_000_000;

const stripDoctype = (xml: string): string =>
  xml.replace(/<!DOCTYPE[\s\S]*?>/gi, "");

const stripPrefixes = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripPrefixes);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const normalizedKey = key.includes(":") ? key.split(":")[1] : key;
        return [normalizedKey, stripPrefixes(entry)];
      }),
    );
  }
  return value;
};

const parseInvoiceXml = (xml: string): ParsedInvoice => {
  const parsed = xml2js(stripDoctype(xml), { compact: true }) as unknown;
  return stripPrefixes(parsed) as ParsedInvoice;
};

const getInvoiceVersion = (invoice: unknown): string | null => {
  if (!invoice || typeof invoice !== "object") return null;
  const header = (invoice as InvoiceHeader).Naglowek;
  const version = header?.KodFormularza?._attributes?.kodSystemowy;
  return typeof version === "string" ? version : null;
};

const normalizeVersion = (version: string): string =>
  version
    .trim()
    .replace(/\s+/g, " ")
    .replace(/FA\s*\(\s*(\d+)\s*\)/i, "FA ($1)");

const pdfToBuffer = (pdf: PdfDocument): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    try {
      if (!pdf?.getBuffer) {
        reject(new Error("PDF document missing getBuffer"));
        return;
      }
      pdf.getBuffer((buffer: PdfBuffer) => {
        resolve(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
      });
    } catch (error) {
      reject(error);
    }
  });

const defaultGeneratorLoader: PdfGeneratorLoader = async () =>
  (await import("@akmf/ksef-fe-invoice-converter")) as PdfGeneratorModule;

const ensureGeneratorExports = (
  generator: PdfGeneratorModule,
): PdfGenerationFailure | null => {
  if (
    !generator.generateFA1 ||
    !generator.generateFA2 ||
    !generator.generateFA3
  ) {
    return {
      status: "failed",
      reason: "generator-unavailable",
      message: "PDF generator module missing required exports",
    };
  }
  return null;
};

const toError = (error: unknown): Error | undefined =>
  error instanceof Error ? error : undefined;

export class PdfService {
  private loader: PdfGeneratorLoader;

  constructor(options?: { loader?: PdfGeneratorLoader }) {
    this.loader = options?.loader ?? defaultGeneratorLoader;
  }

  async generateInvoicePdf(
    xml: string,
    ksefNumber: string,
  ): Promise<PdfGenerationResult> {
    if (!isNodeRuntime()) {
      return {
        status: "failed",
        reason: "runtime-unsupported",
        message: "PDF generation requires Node.js runtime",
      };
    }

    if (Buffer.byteLength(xml, "utf-8") > maxPdfXmlBytes) {
      return {
        status: "failed",
        reason: "invalid-xml",
        message: "Invoice XML too large for PDF generation",
      };
    }

    let parsed: ParsedInvoice;
    try {
      parsed = parseInvoiceXml(xml);
    } catch (error) {
      return {
        status: "failed",
        reason: "invalid-xml",
        message: "Invoice XML is invalid",
        error: toError(error),
      };
    }

    const invoice = parsed.Faktura;
    if (!invoice) {
      return {
        status: "failed",
        reason: "missing-invoice",
        message: "Invoice XML missing Faktura root element",
      };
    }

    const version = getInvoiceVersion(invoice);
    if (!version) {
      return {
        status: "failed",
        reason: "missing-version",
        message: "Invoice XML missing kodSystemowy",
      };
    }
    const normalizedVersion = normalizeVersion(version);

    let generator: PdfGeneratorModule;
    try {
      generator = await this.loader();
    } catch (error) {
      return {
        status: "failed",
        reason: "generator-unavailable",
        message: "PDF generator module unavailable",
        error: toError(error),
      };
    }

    const exportError = ensureGeneratorExports(generator);
    if (exportError) return exportError;

    const additionalData: AdditionalData = {
      nrKSeF: ksefNumber,
      isMobile: false,
    };

    let pdf: PdfDocument;
    try {
      switch (normalizedVersion) {
        case "FA (1)":
          pdf = generator.generateFA1(invoice, additionalData);
          break;
        case "FA (2)":
          pdf = generator.generateFA2(invoice, additionalData);
          break;
        case "FA (3)":
          pdf = generator.generateFA3(invoice, additionalData);
          break;
        default:
          return {
            status: "failed",
            reason: "unsupported-schema",
            message: `Unsupported invoice schema: ${normalizedVersion}`,
          };
      }
    } catch (error) {
      return {
        status: "failed",
        reason: "generation-error",
        message: "Failed to generate invoice PDF",
        error: toError(error),
      };
    }

    try {
      const buffer = await pdfToBuffer(pdf);
      return { status: "ok", buffer };
    } catch (error) {
      return {
        status: "failed",
        reason: "generation-error",
        message: "Failed to render invoice PDF",
        error: toError(error),
      };
    }
  }
}
