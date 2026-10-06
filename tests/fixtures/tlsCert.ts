// Pre-generated self-signed P-256 cert for localhost (valid 10 years from 2026-04-13).
// Generated with: openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=localhost"
export const TEST_CERT = `-----BEGIN CERTIFICATE-----
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

export const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0S8+rvfwsjxZUSn3
ZzSiUZUFssOYEqFZVNAfPHlAftKhRANCAATA7M0lkJzx3Vzzz3l296EFGLgFigM1
wQ+N8L9GvBfx3Gk1uOoIyax1M6Fy8DOXKtGBIq4dTFpm8ZbDam1gT37f
-----END PRIVATE KEY-----`;

// The expected pin for TEST_CERT as produced by fetchTlsPin:
// sha256(cert.pubkey) where cert.pubkey is the raw EC point from getPeerCertificate().
// Note: this is sha256 of the raw uncompressed public key bytes, NOT of the SPKI DER.
// Verified empirically by running fetchTlsPin against a local TLS server using this cert.
export const EXPECTED_PIN = "BZfPzHr9AENIUtJgbLB16/UW6KG4rtXHnuAS9c8/rvk=";
