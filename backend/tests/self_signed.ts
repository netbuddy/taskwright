/**
 * 测试用的自签证书：测试现生成一张根证书与它签发的服务证书（给 127.0.0.1），用本机的 openssl。根证书不在操作系统信任库里。
 * 本机没有 openssl 时 NO_OPENSSL 是跳过的原因。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const NO_OPENSSL: string | false = spawnSync("openssl", ["version"], { encoding: "utf-8" }).error ? "本机 PATH 上没有 openssl" : false;

/** 在 dir 下生成根证书与服务证书，返回根证书、服务证书的私钥与证书（PEM 文字）。 */
export function selfSignedPair(dir: string): { ca: string; key: string; cert: string } {
  mkdirSync(dir, { recursive: true });
  const run = (args: string[]) => {
    const done = spawnSync("openssl", args, { cwd: dir, encoding: "utf-8" });
    assert.equal(done.status, 0, done.stderr);
  };
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=Taskwright Test Root",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=127.0.0.1"]);
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=IP:127.0.0.1\n");
  run(["x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.pem", "-days", "1", "-extfile", "ext.cnf"]);
  return { ca: readFileSync(join(dir, "ca.pem"), "utf-8"), key: readFileSync(join(dir, "srv.key"), "utf-8"), cert: readFileSync(join(dir, "srv.pem"), "utf-8") };
}
