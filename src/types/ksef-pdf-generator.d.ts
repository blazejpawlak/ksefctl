declare module "@akmf/ksef-fe-invoice-converter" {
  export type AdditionalData = {
    nrKSeF: string;
    qrCode?: string;
    isMobile?: boolean;
  };

  export type PdfBuffer = Buffer | Uint8Array;

  export type PdfDocument = {
    getBuffer: (callback: (buffer: PdfBuffer) => void) => void;
  };

  export const generateFA1: (
    invoice: unknown,
    additionalData: AdditionalData,
  ) => PdfDocument;
  export const generateFA2: (
    invoice: unknown,
    additionalData: AdditionalData,
  ) => PdfDocument;
  export const generateFA3: (
    invoice: unknown,
    additionalData: AdditionalData,
  ) => PdfDocument;
}
