/**
 * 监听端口：命令行给的端口被占（EADDRINUSE）时依次试后面的端口，最多试 PORT_TRIES 个；都被占就报错。
 * 实际端口由调用方打印到日志、写进占用标记，并由 GET /api/v1/service 回出。
 */

import type { Server } from "node:http";

export const PORT_TRIES = 10;

/** 按运行形态给缺省的绑定地址：desktop 只绑本机回环地址，server 绑全部网卡；命令行给了 --host 以它为准。 */
export function defaultHost(mode: string, host: string | undefined): string {
  if (host) return host;
  return mode === "desktop" ? "127.0.0.1" : "0.0.0.0";
}

export class NoFreePort extends Error {}

/** 在 host 上从 port 起依次试着监听，返回实际监听的端口。端口被占以外的错误（例如没有权限）照原样抛出。 */
export async function listenFrom(server: Server, port: number, host: string, tries = PORT_TRIES): Promise<number> {
  for (let n = 0; n < tries; n++) {
    const candidate = port + n;
    const error = await new Promise<NodeJS.ErrnoException | null>((ok) => {
      const onError = (e: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        ok(e);
      };
      const onListening = () => {
        server.off("error", onError);
        ok(null);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(candidate, host);
    });
    if (error === null) return candidate;
    if (error.code !== "EADDRINUSE") throw error;
  }
  throw new NoFreePort(`端口 ${port} 到 ${port + tries - 1} 都被占用了，服务没有起来。`);
}
