export type AdditionalData = {
  nrKSeF: string;
  qrCode?: string;
  isMobile?: boolean;
};

export type PdfBuffer = Buffer | Uint8Array;

export type PdfDocument = {
  getBuffer: (callback: (buffer: PdfBuffer) => void) => void;
};

export type PdfGeneratorModule = {
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
