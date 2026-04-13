import crypto from "node:crypto";
import tls from "node:tls";
import { NetworkError } from "../utils/errors";

export type TlsPinResult = {
  host: string;
  port: number;
  pin: string;
};

export type FetchTlsPinOptions = {
  port?: number;
  /** Custom CA cert(s) — useful for testing against self-signed certs. */
  ca?: string | Buffer;
};

export const fetchTlsPin = async (
  host: string,
  options: FetchTlsPinOptions = {},
): Promise<TlsPinResult> => {
  const port = options.port ?? 443;
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: true,
        ca: options.ca,
      },
      () => {
        try {
          const cert = socket.getPeerCertificate();
          socket.destroy();
          if (!cert?.pubkey) {
            reject(
              new NetworkError(
                `No public key in certificate from ${host}:${port}`,
              ),
            );
            return;
          }
          const pin = crypto
            .createHash("sha256")
            .update(cert.pubkey)
            .digest("base64");
          resolve({ host, port, pin });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
    );
    socket.on("error", (err) => {
      reject(
        new NetworkError(
          `TLS connection to ${host}:${port} failed: ${(err as Error).message}`,
        ),
      );
    });
  });
};
