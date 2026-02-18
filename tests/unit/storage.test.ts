import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile, getInvoiceDir } from "../../src/core/storage";

describe("storage paths", () => {
  it("creates deterministic invoice directory", () => {
    const date = new Date(Date.UTC(2025, 0, 2));
    const dir = getInvoiceDir("/data", date, "1234567890", "KSEF123");
    expect(dir).toBe("/data/invoices/1234567890/2025/01/02/KSEF123");
  });

  it("atomically writes files with secure permissions", async () => {
    // Arrange
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-storage-"));
    const filePath = path.join(tmpDir, "payload.txt");

    // Act
    await atomicWriteFile(filePath, "hello");
    const content = await fs.readFile(filePath, "utf-8");
    const stats = await fs.stat(filePath);

    // Assert
    expect(content).toBe("hello");
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("replaces existing files without leaving temp artifacts", async () => {
    // Arrange
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-storage-"));
    const filePath = path.join(tmpDir, "payload.txt");
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(filePath, "old", "utf-8");

    // Act
    await atomicWriteFile(filePath, "new");
    const content = await fs.readFile(filePath, "utf-8");

    // Assert
    expect(content).toBe("new");
    await expect(fs.stat(tempPath)).rejects.toThrow();
  });
});
