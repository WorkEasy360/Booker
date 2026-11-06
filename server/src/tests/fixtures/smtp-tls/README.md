# Test-only TLS certificate for local SMTP servers

`localhost-cert.pem` and `localhost-key.pem` are a self-signed certificate and its private key, made only for the
automated tests (`src/tests/smtp-tls.test.ts`, `scripts/smoke-production.mjs`). They protect nothing: the key is
public on purpose, and the certificate is valid only for `localhost`, `127.0.0.1` and `::1`.

`wrong-host-cert.pem` and `wrong-host-key.pem` are a second test-only pair, valid only for
`wrong-host.example.test` (a name that can never exist). `smtp-tls.test.ts` serves it on 127.0.0.1 to a client that
trusts it, to prove that host-name checking stays on: the connection must fail even though the certificate is trusted.

Nothing outside the tests reads this folder: no setting of the server selects a certificate or key, the production
build (`npm run build`, `tsconfig.build.json`) leaves `src/tests` out, and `.pem` files are never compiled.

The tests run small SMTP servers on 127.0.0.1 with this certificate. A client trusts it only when the test says so,
by starting a separate Node process with `NODE_EXTRA_CA_CERTS` pointing at `localhost-cert.pem`. Without that, the
same connection must fail certificate verification, which proves verification is on.

Never use these files outside the tests, and never add them to a server's trusted certificates.

Valid until 21 October 2036. To make a new pair (Git Bash or any shell with OpenSSL 3):

```bash
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -subj "/CN=WorkEasy360 test SMTP server (localhost only)" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,digitalSignature,keyCertSign" \
  -addext "extendedKeyUsage=serverAuth" -keyout localhost-key.pem -out localhost-cert.pem
```
