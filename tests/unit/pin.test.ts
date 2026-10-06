import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import tls from "node:tls";
import { fetchTlsPin } from "../../src/cli/pin.js";
import { NetworkError } from "../../src/utils/errors.js";
import { EXPECTED_PIN, TEST_CERT, TEST_KEY } from "../fixtures/tlsCert.js";

const startTlsServer = (): Promise<{ port: number; close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const server = tls.createServer({ cert: TEST_CERT, key: TEST_KEY }, (socket) => {
      socket.end();
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });

describe("fetchTlsPin", () => {
  it("returns the correct SHA-256 pin from a local TLS server", async () => {
    const { port, close } = await startTlsServer();
    try {
      const result = await fetchTlsPin("localhost", { port, ca: TEST_CERT });
      expect(result.host).toBe("localhost");
      expect(result.port).toBe(port);
      expect(result.pin).toBe(EXPECTED_PIN);
    } finally {
      await close();
    }
  });

  it("pin matches what the http.ts TLS pinning validator computes", async () => {
    // Verify that fetchTlsPin output would pass the validation in src/utils/http.ts.
    // Both use sha256(cert.pubkey) where cert.pubkey is the raw public key from getPeerCertificate().
    const { port, close } = await startTlsServer();
    try {
      const result = await fetchTlsPin("localhost", { port, ca: TEST_CERT });
      // Simulate the validation logic from http.ts:
      const validated = await new Promise<boolean>((resolve) => {
        const sock = tls.connect(
          { host: "localhost", port, ca: TEST_CERT, servername: "localhost", rejectUnauthorized: true },
          () => {
            const cert = sock.getPeerCertificate();
            sock.destroy();
            const hash = crypto.createHash("sha256").update(cert.pubkey!).digest("base64");
            resolve(hash === result.pin);
          },
        );
        sock.on("error", () => resolve(false));
      });
      expect(validated).toBe(true);
    } finally {
      await close();
    }
  });

  it("rejects with NetworkError on TLS connection failure", async () => {
    await expect(
      fetchTlsPin("127.0.0.1", { port: 1 }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});
