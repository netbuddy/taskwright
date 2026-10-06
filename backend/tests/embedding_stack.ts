/**
 * 知识库按意思查找的测试共用的夹具：一个假的嵌入服务（ollama 的接口）、把 pi 的配置目录与产品设置文件指到临时目录、
 * 在产品设置里登记并选定嵌入模型、经上传接口放文档进知识库。不连任何真的模型服务。
 *
 * 假服务回的数字串由文字里有没有几个指定的词决定（KEYWORDS，每个词一位，末尾再加一位固定的数），
 * 所以哪个片段与哪句话更相近是算得出来的：两段文字共有的词越多、各自独有的词越少，越相近。
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { dispatch } from "../src/http.ts";
import { GENERAL } from "../src/knowledge.ts";
import { type StoredProvider, updatePiDirSettings } from "../src/product_settings.ts";
import type { Service } from "../src/service.ts";

export type Dict = Record<string, any>;
export type Reply = { status?: number; body: unknown; delay?: number };

export const PROVIDER = "taskwright-ollama";
export const MODEL = `${PROVIDER}/bge-m3`;

/** 数字串的各位对着这几个词：文字里有这个词，这一位是 1，没有是 0；最后另有一位固定是 0.2。 */
export const KEYWORDS = ["罚款", "预约", "续借", "丢失"];
export const vectorOf = (text: string) => [...KEYWORDS.map((word) => (text.includes(word) ? 1 : 0)), 0.2];
export const fine = (body: Dict): Reply => ({ body: { model: body.model, embeddings: body.input.map(vectorOf) } });

/** 假的嵌入服务：记下收到的每个请求体，回答由各例设置（缺省是 fine）。 */
export class FakeEmbedder {
  reply: (body: Dict) => Reply = fine;
  hits: Dict[] = [];
  server!: Server;
  port = 0;
  async start(): Promise<this> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
        this.hits.push(body);
        const answer = this.reply(body);
        setTimeout(() => {
          res.writeHead(answer.status ?? 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(answer.body));
        }, answer.delay ?? 0);
      });
    });
    await new Promise<void>((ok) => this.server.listen(0, "127.0.0.1", ok));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  reset(): void {
    this.reply = fine;
    this.hits = [];
  }
  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((ok) => this.server.close(() => ok()));
  }
}

const ENV_NAMES = ["PI_CODING_AGENT_DIR", "TASKWRIGHT_SETTINGS_FILE"];

/**
 * 把 pi 的配置目录与产品设置文件指到 dir 下面（本进程的环境变量）；返回配置目录的路径与把环境变量恢复原样的函数。
 */
export function isolateSettings(dir: string): { agent: string; restore: () => void } {
  const saved = ENV_NAMES.map((name) => [name, process.env[name]] as const);
  const agent = join(dir, "pi-agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "auth.json"), "{}");
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.TASKWRIGHT_SETTINGS_FILE = join(dir, "settings", "settings.json");
  const restore = () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  return { agent, restore };
}

/**
 * 造模型设置只在这一个函数里：登记一个 ollama 种类、提供嵌入模型的模型服务，地址是 base，选定它的 bge-m3；
 * model 给 null 时不选嵌入模型。prefix 是查询前缀。
 */
export async function chooseEmbedding(agent: string, base: string, model: string | null = "bge-m3", prefix = ""): Promise<void> {
  const provider: StoredProvider = {
    kind: "ollama", purpose: "embedding", name: "测试用的 ollama", base_url: base, models_fetched_at: null, status: null,
    models: ["bge-m3", "另一个模型"].map((id) => ({ id, enabled: true, context_window: null, context_source: null })),
  };
  await updatePiDirSettings(agent, (dir) => {
    dir.providers = { [PROVIDER]: provider };
    dir.selection.embedding = model === null ? null : { provider: PROVIDER, model, query_prefix: prefix };
  });
}

/** 在本进程里调一个接口（不经网络），返回状态码与回答。 */
export async function call(service: Service, method: string, path: string, body: Dict | Buffer | null = null, headers: Dict = {}) {
  const raw = body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const reply = (await dispatch(service, { method, path, query: {}, headers, body: raw, remote: "127.0.0.1" })) as Dict;
  return { status: reply.status as number, json: JSON.parse(reply.body.toString("utf-8")) as Dict };
}

/** 经上传接口放一份文档进知识库（缺省是通用知识库）。 */
export async function upload(service: Service, name: string, data: Buffer | string, library = GENERAL): Promise<void> {
  const head = Buffer.from(`--B\r\nContent-Disposition: form-data; name="kind"\r\n\r\nstandard\r\n--B\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const body = Buffer.concat([head, Buffer.isBuffer(data) ? data : Buffer.from(data), Buffer.from("\r\n--B--\r\n")]);
  const done = await call(service, "POST", `/api/v1/knowledge/libraries/${library}/documents`, body, { "content-type": "multipart/form-data; boundary=B" });
  assert.equal(done.status, 200, JSON.stringify(done.json));
}

/** 一份借阅规范：切出来是四个片段，标题依次是「借阅规范」「借阅规范 / 逾期」「借阅规范 / 预约」「借阅规范 / 丢失」。 */
export const RULES = "# 借阅规范\n\n## 逾期\n\n逾期每册每天罚款 0.5 元。\n\n## 预约\n\n全部借出的图书可以预约。\n\n## 丢失\n\n图书丢失按定价赔偿，另收罚款。\n";
