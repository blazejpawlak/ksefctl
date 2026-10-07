import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getContinuationPoint,
  setContinuationPoint,
} from "../../src/db/repository.js";
import { SqliteStore } from "../../src/db/sqlite.js";

const tmpDirs: string[] = [];
const isRoot = process.getuid?.() === 0;

const createStore = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sqlite-"));
  tmpDirs.push(dir);
  const dbDir = path.join(dir, "db");
  const dbPath = path.join(dbDir, "state.sqlite");
  return { dbDir, dbPath, store: new SqliteStore(dbPath) };
};

const readCursor = (store: SqliteStore) =>
  store.readDb((db) => getContinuationPoint(db, "123", "Subject1"));

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tmpDirs.splice(0).map(async (dir) => {
      await fs.chmod(path.join(dir, "db"), 0o700).catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("SqliteStore.readDb", () => {
  it("treats a missing DB as empty without creating the file or directory", async () => {
    const { dbDir, store } = await createStore();

    await expect(readCursor(store)).resolves.toBeNull();

    await expect(fs.stat(dbDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns persisted data and never writes the DB back", async () => {
    const { dbPath, store } = await createStore();
    await store.withDb((db) =>
      setContinuationPoint(db, "123", "Subject1", "2026-04-01T00:00:00.000Z"),
    );
    const bytesBefore = await fs.readFile(dbPath);
    const mtimeBefore = (await fs.stat(dbPath)).mtimeMs;

    await expect(readCursor(store)).resolves.toBe("2026-04-01T00:00:00.000Z");
    // Mutations inside the callback live in memory only.
    await store.readDb((db) =>
      setContinuationPoint(db, "123", "Subject1", "1999-01-01T00:00:00.000Z"),
    );

    expect((await fs.stat(dbPath)).mtimeMs).toBe(mtimeBefore);
    expect(Buffer.compare(await fs.readFile(dbPath), bytesBefore)).toBe(0);
    await expect(readCursor(store)).resolves.toBe("2026-04-01T00:00:00.000Z");
  });

  it("migrates a legacy schema in memory only", async () => {
    const { dbDir, dbPath, store } = await createStore();
    const initSqlJs = (await import("sql.js")).default;
    const SQL = await initSqlJs({
      locateFile: (file: string) =>
        path.join(
          path.dirname(
            new URL(import.meta.resolve("sql.js/dist/sql-wasm.wasm")).pathname,
          ),
          file,
        ),
    });
    const legacy = new SQL.Database();
    legacy.exec(
      `CREATE TABLE continuation_points (subject_type TEXT PRIMARY KEY, cursor TEXT);
       INSERT INTO continuation_points VALUES ('Subject1', '2026-03-01T00:00:00.000Z');`,
    );
    await fs.mkdir(dbDir, { recursive: true });
    await fs.writeFile(dbPath, legacy.export());
    legacy.close();
    const bytesBefore = await fs.readFile(dbPath);

    await expect(
      store.readDb((db) => getContinuationPoint(db, "legacy", "Subject1")),
    ).resolves.toBe("2026-03-01T00:00:00.000Z");

    expect(Buffer.compare(await fs.readFile(dbPath), bytesBefore)).toBe(0);
  });

  it.skipIf(isRoot)("reads a read-only DB in a read-only directory", async () => {
    const { dbDir, dbPath, store } = await createStore();
    await store.withDb((db) =>
      setContinuationPoint(db, "123", "Subject1", "2026-04-01T00:00:00.000Z"),
    );
    await fs.chmod(dbPath, 0o400);
    await fs.chmod(dbDir, 0o500);

    await expect(readCursor(store)).resolves.toBe("2026-04-01T00:00:00.000Z");
  });

  it("propagates read errors other than a missing file", async () => {
    const { dbPath, store } = await createStore();
    // A directory at the DB path makes readFile fail with EISDIR.
    await fs.mkdir(dbPath, { recursive: true });

    await expect(readCursor(store)).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe("SqliteStore.withDb atomic writes", () => {
  it("persists writes with owner-only permissions and leaves no temp files", async () => {
    const { dbDir, dbPath, store } = await createStore();

    await store.withDb((db) =>
      setContinuationPoint(db, "123", "Subject1", "2026-04-01T00:00:00.000Z"),
    );

    await expect(readCursor(store)).resolves.toBe("2026-04-01T00:00:00.000Z");
    expect((await fs.stat(dbPath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(dbDir)).filter((n) => n.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("keeps the previous DB intact and removes the temp file when the rename fails", async () => {
    const { dbDir, dbPath, store } = await createStore();
    await store.withDb((db) =>
      setContinuationPoint(db, "123", "Subject1", "2026-04-01T00:00:00.000Z"),
    );
    const bytesBefore = await fs.readFile(dbPath);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));

    await expect(
      store.withDb((db) =>
        setContinuationPoint(db, "123", "Subject1", "2030-01-01T00:00:00.000Z"),
      ),
    ).rejects.toThrow("rename failed");

    expect(Buffer.compare(await fs.readFile(dbPath), bytesBefore)).toBe(0);
    expect((await fs.readdir(dbDir)).filter((n) => n.endsWith(".tmp"))).toEqual(
      [],
    );
    // The lock was released, so the store is still usable.
    await store.withDb((db) =>
      setContinuationPoint(db, "123", "Subject1", "2031-01-01T00:00:00.000Z"),
    );
    await expect(readCursor(store)).resolves.toBe("2031-01-01T00:00:00.000Z");
  });

  it("keeps the previous DB intact when writing the temp file fails mid-way", async () => {
    const { dbDir, dbPath, store } = await createStore();
    await store.withDb((db) =>
      setContinuationPoint(db, "123", "Subject1", "2026-04-01T00:00:00.000Z"),
    );
    const bytesBefore = await fs.readFile(dbPath);
    const realOpen = fs.open.bind(fs);
    let prefixBytes = 0;
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await realOpen(file, flags, mode);
      if (String(file).endsWith(".tmp")) {
        // Write a real prefix of the data, then run out of space.
        vi.spyOn(handle, "writeFile").mockImplementation(async (data) => {
          const bytes = data as Uint8Array;
          const prefix = bytes.subarray(0, Math.floor(bytes.length / 2));
          prefixBytes = prefix.length;
          await handle.write(prefix);
          throw Object.assign(new Error("no space left on device"), {
            code: "ENOSPC",
          });
        });
      }
      return handle;
    });

    await expect(
      store.withDb((db) =>
        setContinuationPoint(db, "123", "Subject1", "2030-01-01T00:00:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "ENOSPC" });

    expect(prefixBytes).toBeGreaterThan(0);
    expect(Buffer.compare(await fs.readFile(dbPath), bytesBefore)).toBe(0);
    expect((await fs.readdir(dbDir)).filter((n) => n.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("does not replace the DB with an empty one when reading it fails", async () => {
    const { dbDir, dbPath, store } = await createStore();
    await store.withDb((db) =>
      setContinuationPoint(db, "123", "Subject1", "2026-04-01T00:00:00.000Z"),
    );
    const bytesBefore = await fs.readFile(dbPath);
    const realReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(((file: unknown, ...rest: unknown[]) =>
      String(file) === dbPath
        ? Promise.reject(Object.assign(new Error("I/O error"), { code: "EIO" }))
        : (realReadFile as (...args: unknown[]) => unknown)(
            file,
            ...rest,
          )) as typeof fs.readFile);

    await expect(
      store.withDb((db) =>
        setContinuationPoint(db, "123", "Subject1", "2030-01-01T00:00:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "EIO" });
    vi.restoreAllMocks();

    expect(Buffer.compare(await fs.readFile(dbPath), bytesBefore)).toBe(0);
    expect((await fs.readdir(dbDir)).filter((n) => n.endsWith(".tmp"))).toEqual(
      [],
    );
    // The lock was released and the stored cursor is still there.
    await expect(readCursor(store)).resolves.toBe("2026-04-01T00:00:00.000Z");
  });

  it("does not write when the callback throws", async () => {
    const { dbPath, store } = await createStore();
    await store.withDb((db) =>
      setContinuationPoint(db, "123", "Subject1", "2026-04-01T00:00:00.000Z"),
    );
    const bytesBefore = await fs.readFile(dbPath);

    await expect(
      store.withDb((db) => {
        setContinuationPoint(db, "123", "Subject1", "2030-01-01T00:00:00.000Z");
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");

    expect(Buffer.compare(await fs.readFile(dbPath), bytesBefore)).toBe(0);
  });
});
