import path from "node:path";
import { pathToFileURL } from "node:url";

// The PDF converter ships prebuilt inside this package (see
// scripts/prepare-ksef-pdf-generator.mjs). Both src/utils and dist/utils sit
// two levels below the package root, so one relative path serves tests and the
// built CLI.
const vendorDir = path.join(
  import.meta.dirname,
  "..",
  "..",
  "vendor",
  "ksef-pdf-generator",
);

export const pdfConverterBundleUrl = (): string =>
  pathToFileURL(path.join(vendorDir, "ksef-fe-invoice-converter.js")).href;

export const pdfConverterMetadataPath = (): string =>
  path.join(vendorDir, "metadata.json");
