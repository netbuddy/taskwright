/**
 * 两个工具访问后端 HTTP 接口的几个小函数，只用 Node 自带的 fetch。后端地址、任务编号、会话编号从环境变量取：
 * TASKWRIGHT_SIM_BACKEND（例如 http://127.0.0.1:8790/api/v1）、TASKWRIGHT_SIM_TASK、TASKWRIGHT_SIM_SESSION，由驾驭程序 run.py 设好。
 *
 * 另有一份进程内的状态：上一次看界面时已经看过哪些消息、执行者最近一条带卡片的回复。
 * 「看界面」写它，「回应」读它（按钮只认最近一条回复上的）。
 */

import type { Message, TaskView } from "./screen.ts";

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`没有设环境变量 ${name}，工具不知道该连哪个后端、哪个任务或哪条会话。`);
  return value;
}

export const state = {
  seen: new Set<string>(),
  lastReply: null as Message | null,
  /** 最近一次看界面时的条目区数据：判断提问卡片上有没有「先不管」按钮要用任务定义。 */
  lastTask: null as TaskView | null,
  counter: 0,
};

export async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const response = await fetch(env("TASKWRIGHT_SIM_BACKEND") + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  return { status: response.status, data };
}

export function taskPath(suffix: string): string {
  const session = encodeURIComponent(env("TASKWRIGHT_SIM_SESSION"));
  const join = suffix.includes("?") ? "&" : "?";
  return `/tasks/${encodeURIComponent(env("TASKWRIGHT_SIM_TASK"))}${suffix}${join}session=${session}`;
}

/** 等执行者停下来：执行者状态不是「正在做事」、也没有进行中的工作时返回整份数据；等太久就返回最后一次读到的。 */
export async function snapshotWhenIdle(timeoutMs = 900_000, pollMs = 1500): Promise<{ snapshot: any; waited: number; idle: boolean }> {
  const started = Date.now();
  let last: any = null;
  while (true) {
    const { status, data } = await call("GET", taskPath("/snapshot"));
    if (status !== 200) throw new Error(`读界面失败：${data?.error?.message ?? status}`);
    last = data;
    const busy = data.executor?.state === "working" || data.executor?.state === "starting" || data.current_work;
    if (!busy) return { snapshot: data, waited: Date.now() - started, idle: true };
    if (Date.now() - started > timeoutMs) return { snapshot: last, waited: Date.now() - started, idle: false };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
