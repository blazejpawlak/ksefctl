import type { AppConfig } from "../config/schema";
import type {
  PdfGenerationFailureReason,
  PdfService,
} from "../services/pdfService";
import type { Logger } from "pino";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, resolveInvoiceOutputRoot } from "./storage";

export type PdfRepairItem = {
  nip: string;
  ksefNumber: string;
  xmlPath: string;
  pdfPath: string;
  status: "repaired" | "failed" | "skipped";
  reason?: PdfGenerationFailureReason | "metadata-missing" | "pdf-exists";
  message?: string;
};

export type PdfRepairResult = {
  scanned: number;
  missing: number;
  repaired: number;
  failed: number;
  skipped: number;
  items: PdfRepairItem[];
};

export type PdfRepairOptions = {
  nip?: string;
};

type RepairDeps = {
  config: AppConfig;
  logger: Logger;
  pdfService: PdfService;
};

type MetadataFile = {
  ksefNumber?: unknown;
  nip?: unknown;
};

const emptyResult = (): PdfRepairResult => ({
  scanned: 0,
  missing: 0,
  repaired: 0,
  failed: 0,
  skipped: 0,
  items: [],
});

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const collectXmlPaths = async (root: string): Promise<string[]> => {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) return collectXmlPaths(entryPath);
      if (entry.isFile() && entry.name.endsWith(".xml")) return [entryPath];
      return [];
    }),
  );
  return nested.flat();
};

const readMetadata = async (xmlPath: string): Promise<MetadataFile | null> => {
  const dir = path.dirname(xmlPath);
  const base = path.basename(xmlPath, ".xml");
  const candidates = [
    path.join(dir, "metadata.json"),
    path.join(dir, `${base}.metadata.json`),
  ];
  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate, "utf-8");
      return JSON.parse(content) as MetadataFile;
    } catch {
      continue;
    }
  }
  return null;
};

const repairXml = async (
  deps: RepairDeps,
  nip: string,
  xmlPath: string,
): Promise<PdfRepairItem> => {
  const pdfPath = xmlPath.replace(/\.xml$/u, ".pdf");
  if (await pathExists(pdfPath)) {
    return {
      nip,
      ksefNumber: "",
      xmlPath,
      pdfPath,
      status: "skipped",
      reason: "pdf-exists",
    };
  }

  const metadata = await readMetadata(xmlPath);
  const ksefNumber =
    typeof metadata?.ksefNumber === "string" ? metadata.ksefNumber : "";
  if (!ksefNumber) {
    return {
      nip,
      ksefNumber,
      xmlPath,
      pdfPath,
      status: "failed",
      reason: "metadata-missing",
      message: "Invoice metadata missing ksefNumber",
    };
  }

  const xml = await fs.readFile(xmlPath, "utf-8");
  const result = await deps.pdfService.generateInvoicePdf(xml, ksefNumber);
  if (result.status === "ok") {
    await atomicWriteFile(pdfPath, result.buffer);
    return { nip, ksefNumber, xmlPath, pdfPath, status: "repaired" };
  }

  deps.logger.warn(
    { nip, ksefNumber, reason: result.reason, err: result.message },
    "Failed to repair missing invoice PDF",
  );
  return {
    nip,
    ksefNumber,
    xmlPath,
    pdfPath,
    status: "failed",
    reason: result.reason,
    message: result.message,
  };
};

export const repairMissingInvoicePdfs = async (
  deps: RepairDeps,
  options: PdfRepairOptions = {},
): Promise<PdfRepairResult> => {
  const result = emptyResult();
  const nips = options.nip
    ? [options.nip]
    : deps.config.organizations.map((org) => org.nip);

  for (const nip of nips) {
    const orgOutputPath = deps.config.organizations.find(
      (org) => org.nip === nip,
    )?.outputPath;
    const root = resolveInvoiceOutputRoot(
      deps.config.storage.root,
      nip,
      orgOutputPath,
    );
    if (!(await pathExists(root))) continue;

    const xmlPaths = await collectXmlPaths(root);
    result.scanned += xmlPaths.length;
    for (const xmlPath of xmlPaths) {
      const pdfPath = xmlPath.replace(/\.xml$/u, ".pdf");
      if (await pathExists(pdfPath)) continue;
      result.missing += 1;
      const item = await repairXml(deps, nip, xmlPath);
      result.items.push(item);
      if (item.status === "repaired") result.repaired += 1;
      if (item.status === "failed") result.failed += 1;
      if (item.status === "skipped") result.skipped += 1;
    }
  }

  return result;
};
