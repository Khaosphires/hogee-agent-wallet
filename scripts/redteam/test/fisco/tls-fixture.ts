/**
 * A throwaway TLS setup for the NativeRpc tests, made at test time with the `openssl` CLI (nothing committed): a chain CA,
 * a node certificate it signs with NO subject alternative name (as FISCO's), an SDK client certificate it signs, and a
 * second, unrelated CA. All RSA-2048 like FISCO 3.17.1's SDK files. Plus a real https server on 127.0.0.1 (ephemeral
 * port) that requires the client certificate and answers with the test's handler.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TlsFixture {
  readonly root: string;
  /** ca.crt, sdk.crt, sdk.key as chain-up.sh snapshots them. */
  readonly sdkDir: string;
  readonly node: { readonly key: Buffer; readonly cert: Buffer };
  /** A node certificate signed by another CA. */
  readonly foreignNode: { readonly key: Buffer; readonly cert: Buffer };
  readonly ca: Buffer;
}

const ssl = (cwd: string, args: readonly string[]): void => void execFileSync("openssl", args, { cwd, stdio: "ignore" });
const CA_EXT = "[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n";

function ca(dir: string, name: string): void {
  ssl(dir, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.crt`, "-days", "2", "-subj", `/CN=${name}`, "-extensions", "v3_ca", "-config", "ca.cnf"]);
}

function leaf(dir: string, name: string, caName: string): void {
  ssl(dir, ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`, "-config", "ca.cnf"]);
  ssl(dir, ["x509", "-req", "-in", `${name}.csr`, "-CA", `${caName}.crt`, "-CAkey", `${caName}.key`, "-CAcreateserial", "-out", `${name}.crt`, "-days", "2"]);
}

export function tlsFixture(): TlsFixture {
  const root = mkdtempSync(join(tmpdir(), "fisco-tls-"));
  writeFileSync(join(root, "ca.cnf"), `[req]\ndistinguished_name=dn\n[dn]\n${CA_EXT}`);
  ca(root, "chain-ca");
  ca(root, "other-ca");
  leaf(root, "node", "chain-ca");
  leaf(root, "sdk", "chain-ca");
  leaf(root, "foreign", "other-ca");
  const sdkDir = join(root, "sdk-dir");
  mkdirSync(sdkDir);
  const read = (f: string): Buffer => readFileSync(join(root, f));
  writeFileSync(join(sdkDir, "ca.crt"), read("chain-ca.crt"));
  writeFileSync(join(sdkDir, "sdk.crt"), read("sdk.crt"));
  writeFileSync(join(sdkDir, "sdk.key"), read("sdk.key"), { mode: 0o400 });
  return {
    root,
    sdkDir,
    node: { key: read("node.key"), cert: read("node.crt") },
    foreignNode: { key: read("foreign.key"), cert: read("foreign.crt") },
    ca: read("chain-ca.crt"),
  };
}

export interface TlsServer {
  readonly port: number;
  readonly bodies: string[];
  close(): Promise<void>;
}

/** An https server on 127.0.0.1 requiring a client certificate signed by `clientCa`; `answer` gets the request body. */
export async function tlsServer(identity: { key: Buffer; cert: Buffer }, clientCa: Buffer, answer: (body: string) => { status: number; body?: string; headers?: Record<string, string> }): Promise<TlsServer> {
  const bodies: string[] = [];
  const server: Server = createServer({ key: identity.key, cert: identity.cert, ca: clientCa, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      bodies.push(body);
      const a = answer(body);
      res.writeHead(a.status, { "content-type": "application/json", ...a.headers });
      res.end(a.body ?? "");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
