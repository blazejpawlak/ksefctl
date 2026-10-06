import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http2 from "node:http2";
import os from "node:os";
import path from "node:path";
import { NetworkError } from "../../src/utils/errors.js";
import { HttpClient, type SecurityOptions } from "../../src/utils/http.js";
import { EXPECTED_PIN, TEST_CERT, TEST_KEY } from "../fixtures/tlsCert.js";

// Exercises HttpClient against a real local TLS server so the undici dispatcher
// (TLS options, certificate pinning, protocol selection) and the abort-based
// timeout run end to end instead of through a stubbed fetch.

const WRONG_PIN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

type TestServer = {
  port: number;
  requests: { path: string; httpVersion: string }[];
  close: () => Promise<void>;
};

// HTTP/2-capable server that also accepts HTTP/1.1, so the negotiated protocol
// is decided by what the client offers over ALPN.
const startServer = (): Promise<TestServer> =>
  new Promise((resolve, reject) => {
    const requests: TestServer["requests"] = [];
    const sockets = new Set<Socket>();
    const server = http2.createSecureServer(
      { cert: TEST_CERT, key: TEST_KEY, allowHTTP1: true },
      (req, res) => {
        requests.push({ path: req.url, httpVersion: req.httpVersion });
        if (req.url.startsWith("/v2/hang")) {
          // Never respond: the client timeout has to abort the request.
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    );
    server.on("secureConnection", (socket: Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        requests,
        close: () =>
          new Promise((res) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => res());
          }),
      });
    });
  });

let server: TestServer;
let tmpDir: string;
let caPath: string;

beforeAll(async () => {
  server = await startServer();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksefctl-http-tls-"));
  caPath = path.join(tmpDir, "ca.pem");
  await fs.writeFile(caPath, TEST_CERT);
});

afterAll(async () => {
  await server.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const createClient = (
  security: Partial<SecurityOptions>,
  timeoutMs = 5000,
): HttpClient =>
  new HttpClient({
    baseUrl: `https://localhost:${server.port}/v2`,
    timeoutMs,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
    security: {
      enablePinning: false,
      pins: [],
      pinningHosts: [],
      caPath,
      ...security,
    },
  });

const requestCountFor = (prefix: string): number =>
  server.requests.filter((request) => request.path.startsWith(prefix)).length;

describe("HttpClient transport (real TLS server)", () => {
  it("succeeds when the server key matches a configured pin", async () => {
    const client = createClient({ enablePinning: true, pins: [EXPECTED_PIN] });

    await expect(
      client.request({ method: "GET", path: "/pin-match" }),
    ).resolves.toEqual({ ok: true });
    expect(requestCountFor("/v2/pin-match")).toBe(1);
  });

  it("fails closed on a pin mismatch before any request reaches the server", async () => {
    const client = createClient({ enablePinning: true, pins: [WRONG_PIN] });

    const error = await client
      .request({ method: "GET", path: "/pin-mismatch" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NetworkError);
    expect(requestCountFor("/v2/pin-mismatch")).toBe(0);
  });

  it("fails closed on a pin mismatch for a host listed in pinningHosts", async () => {
    const client = createClient({
      enablePinning: true,
      pins: [WRONG_PIN],
      pinningHosts: ["LOCALHOST."],
    });

    await expect(
      client.request({ method: "GET", path: "/pin-host-listed" }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(requestCountFor("/v2/pin-host-listed")).toBe(0);
  });

  it("skips pinning for hosts outside pinningHosts", async () => {
    const client = createClient({
      enablePinning: true,
      pins: [WRONG_PIN],
      pinningHosts: ["api.ksef.mf.gov.pl"],
    });

    await expect(
      client.request({ method: "GET", path: "/pin-host-unlisted" }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects an untrusted certificate when no caPath is configured", async () => {
    const client = createClient({ caPath: undefined });

    await expect(
      client.request({ method: "GET", path: "/untrusted" }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(requestCountFor("/v2/untrusted")).toBe(0);
  });

  it("keeps using HTTP/1.1 against an HTTP/2-capable server", async () => {
    const client = createClient({});

    await client.request({ method: "GET", path: "/protocol" });

    const protocolRequests = server.requests.filter(
      (request) => request.path === "/v2/protocol",
    );
    expect(protocolRequests).toHaveLength(1);
    expect(protocolRequests[0]?.httpVersion).toBe("1.1");
  });

  it("aborts a request that exceeds timeoutMs", async () => {
    const client = createClient({}, 200);
    const startedAt = Date.now();

    const error = await client
      .request({ method: "GET", path: "/hang" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toMatch(/^Network failure: .*abort/i);
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });
});
