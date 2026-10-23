/**
 * 连模型服务时信任操作系统信任库里的根证书：用户的模型服务用自签证书或企业内部证书时，把签发它的根证书装进操作系统就行，产品里不另配。
 *
 * 后端自己：Node 只在进程启动时读 NODE_USE_SYSTEM_CA（或 --use-system-ca），运行中再设不起作用，而后端有好几种启动方式（代码仓里直接起、
 * service restart、桌面包的启动程序），靠启动者设变量容易漏一处。所以后端在第一次向模型服务发请求之前，把系统根证书加进本进程的默认根证书
 * （tls.setDefaultCACertificates），之后进程里的 https 请求（内置 fetch 也是）都认它们。只做一次；取到的证书由 Node 自己缓存。
 *
 * 助手进程 pi：后端拉起它时在环境里加 NODE_USE_SYSTEM_CA=1（launch.ts 的 buildEnvironment），pi 启动时就读到。
 *
 * 不放松校验：证书校验照常做，只是多认几张根证书；校验没有通过时照实报（isCertificateError）。
 */

import tls from "node:tls";

/** 交给 pi 的那个环境变量：Node 启动时读它，把操作系统信任库里的根证书加进默认根证书。 */
export const USE_SYSTEM_CA_ENV = "NODE_USE_SYSTEM_CA";

let trusted = false;

/**
 * 把操作系统信任库里的根证书加进本进程的默认根证书（原有的默认根证书不动，含 NODE_EXTRA_CA_CERTS 给的）。只做一次。
 * system 取系统根证书，测试用它代替操作系统信任库。取不到（例如平台不支持）时照原样，只写一行日志。
 */
export function trustSystemCertificates(system: () => string[] = () => tls.getCACertificates("system")): void {
  if (trusted) return;
  trusted = true;
  try {
    const extra = system();
    if (extra.length === 0) return;
    tls.setDefaultCACertificates([...new Set([...tls.getCACertificates("default"), ...extra])]);
  } catch (error) {
    console.log(`取不到操作系统信任库里的根证书，连模型服务时只认 Node 自带的根证书：${(error as Error).message}`);
  }
}

/** 测试用：下一次 trustSystemCertificates 重新做一遍。 */
export function resetTrustForTests(): void {
  trusted = false;
}

/** 证书校验没有通过的那几种错误代号的开头（Node 的 TLS 错误，经内置 fetch 时在 error.cause.code 上）。 */
const CERTIFICATE_CODES = /^(UNABLE_TO_|CERT_|SELF_SIGNED|DEPTH_ZERO|ERR_TLS_CERT_ALTNAME_INVALID$|HOSTNAME_MISMATCH$)/;

/** 一次请求失败是不是因为对方的证书没有通过校验。看错误本身与它的 cause（内置 fetch 把底层错误放在 cause 上）。 */
export function isCertificateError(error: unknown): boolean {
  for (let one: any = error, depth = 0; one && depth < 4; one = one.cause, depth += 1) {
    if (typeof one.code === "string" && CERTIFICATE_CODES.test(one.code)) return true;
  }
  return false;
}
