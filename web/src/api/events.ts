// 事件流：服务器推送事件（SSE）。
//
// 不用浏览器自带的 EventSource：它只在自己断线重连时带 Last-Event-ID，我们在 45 秒收不到任何东西时
// 要主动重连，新建的 EventSource 带不上这个头。所以这里用 fetch 读流、自己按行解析，重连时自己带上
// 最后收到的库事件序号。只有库事件写 id 行（第 3 节），过程与对话类事件没有 id，不改变这个序号。

export interface SseMessage {
  event: string;
  id: string | null;
  data: unknown;
}

/** 把一段 SSE 文本按空行切成若干条消息；最后一段不完整的留给下一次。以冒号开头的是注释（保活），忽略。 */
export function parseSseChunk(buffer: string): { messages: SseMessage[]; rest: string } {
  const messages: SseMessage[] = [];
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let event = "message";
    let id: string | null = null;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "id") id = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0) continue;
    const raw = data.join("\n");
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* 不是 JSON 就原样交出去，由上层决定忽略 */
    }
    messages.push({ event, id, data: parsed });
  }
  return { messages, rest };
}

/** 45 秒收不到任何东西就主动重连（第 3 节）。 */
export const IDLE_RECONNECT_MS = 45_000;

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface StreamHandlers {
  onMessage: (message: SseMessage) => void;
  onStatus?: (status: StreamStatus) => void;
}

/**
 * 连上一个任务的事件流。返回关闭函数。
 * lastEventId 由调用方维护（它知道哪些是已应用的库事件），每次重连时读它。
 */
export function openEventStream(
  url: string,
  getLastEventId: () => number | null,
  handlers: StreamHandlers,
): () => void {
  let closed = false;
  let controller: AbortController | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = 1000;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller?.abort(), IDLE_RECONNECT_MS);
  };

  const connect = async () => {
    if (closed) return;
    controller = new AbortController();
    handlers.onStatus?.("connecting");
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    const last = getLastEventId();
    if (last !== null) headers["Last-Event-ID"] = String(last);
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      handlers.onStatus?.("open");
      retryDelay = 1000;
      resetIdle();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        resetIdle();
        buffer += decoder.decode(value, { stream: true });
        const { messages, rest } = parseSseChunk(buffer);
        buffer = rest;
        for (const message of messages) handlers.onMessage(message);
      }
    } catch {
      /* 断线、超时或被主动中止，下面统一重连 */
    }
    if (idleTimer) clearTimeout(idleTimer);
    if (closed) return;
    handlers.onStatus?.("reconnecting");
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15_000);
  };

  connect();
  return () => {
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    controller?.abort();
    handlers.onStatus?.("closed");
  };
}
