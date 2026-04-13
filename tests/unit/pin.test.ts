import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import tls from "node:tls";
import { fetchTlsPin } from "../../src/cli/pin";
import { NetworkError } from "../../src/utils/errors";

// Pre-generated self-signed P-256 cert for localhost (valid 10 years from 2026-04-13).
// Generated with: openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=localhost"
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBfjCCASOgAwIBAgIUK+Mc+c5StjWKklFni5+zSl9Eag0wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDQxMzEyNTMzMloXDTM2MDQxMDEy
NTMzMlowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEwOzNJZCc8d1c8895dvehBRi4BYoDNcEPjfC/RrwX8dxpNbjqCMmsdTOh
cvAzlyrRgSKuHUxaZvGWw2ptYE9+36NTMFEwHQYDVR0OBBYEFIRUedDsU2jcFssv
d8ZZjTGoJTXaMB8GA1UdIwQYMBaAFIRUedDsU2jcFssvd8ZZjTGoJTXaMA8GA1Ud
EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhAJKVtB3mQoCTovV+rBJ0AIJ+
+6l8XygWUAheG8vonaHGAiEAkD0nqIxAZt/f/TclbvsMagAwBwpzNfdCwlXtCx/v
ddU=
-----END CERTIFICATE-----`;

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0S8+rvfwsjxZUSn3
ZzSiUZUFssOYEqFZVNAfPHlAftKhRANCAATA7M0lkJzx3Vzzz3l296EFGLgFigM1
wQ+N8L9GvBfx3Gk1uOoIyax1M6Fy8DOXKtGBIq4dTFpm8ZbDam1gT37f
-----END PRIVATE KEY-----`;

// The expected pin for TEST_CERT as produced by fetchTlsPin:
// sha256(cert.pubkey) where cert.pubkey is the raw EC point from getPeerCertificate().
// Note: this is sha256 of the raw uncompressed public key bytes, NOT of the SPKI DER.
// Verified empirically by running fetchTlsPin against a local TLS server using this cert.
const EXPECTED_PIN = "BZfPzHr9AENIUtJgbLB16/UW6KG4rtXHnuAS9c8/rvk=";

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
