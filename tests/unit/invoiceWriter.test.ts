import type { AppConfig } from "../../src/config/schema";
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getMetadataFileName,
  resolveInvoiceStorageTarget,
} from "../../src/core/invoiceWriter";

const baseConfig = (root: string): AppConfig =>
  ({
    environment: "test",
    organizations: [{ nip: "1234567890" }],
    storage: { root },
    sync: { flatSync: false, generatePdf: false },
  }) as unknown as AppConfig;

const deps = (root: string) => ({ config: baseConfig(root) });

describe("getMetadataFileName", () => {
  it("returns shared metadata.json for non-flat layout", () => {
    expect(getMetadataFileName("INV-001", false)).toBe("metadata.json");
  });

  it("returns per-invoice metadata file for flat layout", () => {
    expect(getMetadataFileName("INV-001", true)).toBe("INV-001.metadata.json");
  });
});

describe("resolveInvoiceStorageTarget", () => {
  let tmpDir: string;

  it("resolves non-flat storage target for well-formed XML", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-writer-"));
    const xml = `<FA xmlns="http://crd.gov.pl/wzor/2023/06/29/9843/">
      <Podmiot1><DaneIdentyfikacyjne><NIP>1234567890</NIP></DaneIdentyfikacyjne></Podmiot1>
      <Fa><P_2>2024-01-15</P_2></Fa>
    </FA>`;
    const target = await resolveInvoiceStorageTarget(
      deps(tmpDir),
      "1234567890",
      new Date("2024-01-15"),
      "ABC123",
      xml,
      false,
    );
    expect(target.invoiceDir).toContain("1234567890");
    expect(target.invoiceDir).toContain("ABC123");
    expect(target.metadataFileName).toBe("metadata.json");
    expect(target.fileBaseName).toBeTruthy();
  });

  it("resolves flat storage target into monthly folder", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-writer-"));
    const xml = "<FA/>";
    const target = await resolveInvoiceStorageTarget(
      deps(tmpDir),
      "1234567890",
      new Date("2024-03-20"),
      "FLAT001",
      xml,
      true,
    );
    expect(target.invoiceDir).toContain("2024");
    expect(target.invoiceDir).not.toContain("FLAT001"); // no per-invoice dir in flat mode
    expect(target.metadataFileName).toContain(".metadata.json");
  });

  it("uses outputPathOverride instead of default storage root", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-writer-"));
    const override = path.join(tmpDir, "custom-output");
    const xml = "<FA/>";
    const target = await resolveInvoiceStorageTarget(
      deps(tmpDir),
      "1234567890",
      new Date("2024-01-01"),
      "OVERRIDE01",
      xml,
      false,
      undefined,
      override,
    );
    expect(target.invoiceDir).toContain("custom-output");
  });
});
