/**
 * 图表校验用的另一条线程的入口。mermaid 解析一段文本是一口气算完的，中途停不下来；放在任务服务自己的线程里算，
 * 这段时间别的请求都得等，算得太久也没有办法打断。所以解析放在这里做：src/diagram_validate.ts 起这条线程、
 * 把文本发过来、等结果，等过了时限就把这条线程结束掉。
 *
 * 起来时先加载校验引擎（workerData.engine 是它的文件地址），加载好了发 { ready: true }，加载不了发 { ready: false, message }；
 * 之后每收到一条 { id, text } 回一条 { id, type, error }（见 diagram_engine.mjs 的 inspect）。
 */
import { parentPort, workerData } from "node:worker_threads";

interface Engine {
  inspect(text: string): Promise<{ type: string | null; error: { message: string; line: number | null } | null }>;
}

const port = parentPort!;
let engine: Engine | null = null;
try {
  engine = (await import(workerData.engine)) as Engine;
  if (typeof engine.inspect !== "function") throw new Error("校验引擎里没有 inspect");
  port.postMessage({ ready: true });
} catch (error) {
  port.postMessage({ ready: false, message: String((error as Error)?.message ?? error) });
}

port.on("message", async (request: { id: number; text: string }) => {
  if (!engine) return;
  try {
    port.postMessage({ id: request.id, ...(await engine.inspect(request.text)) });
  } catch (error) {
    port.postMessage({ id: request.id, type: null, error: { message: String((error as Error)?.message ?? error), line: null }, failed: true });
  }
});
