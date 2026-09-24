// 假服务：按接口约定（docs/api.md）的字段返回数据、能推 SSE 的 Node 小服务，只用 Node 自带的模块。
//
// 数据来自真实归档导出的 runtime/fixture.json（先运行 export_fixture.py），不手写条目。
// 响应形状按与后端对齐之后的样子：成功都带 ok: true，列表放在一个键下。
// 它只为前端开发与测试顶着后端：接受直接操作、推库事件、按固定脚本回话，所有回话都标明「假服务」。
// 完成条件在这里用 JavaScript 重算，只为让界面在操作之后有变化可看；真后端是调 agent 的核对函数算的。
//
// 用法：node mock/server.mjs          端口由环境变量 MOCK_PORT 给，缺省 5681，绑 0.0.0.0。
// 演示开关（只有假服务有）：
//   POST /__mock/busy        { "on": true }   模拟执行者正在另一条会话里工作（之后说话与直接操作返回 session_busy）
//   POST /__mock/disconnect                    断开全部事件流（看前端怎样带 Last-Event-ID 重连）
//   POST /__mock/resync                        给全部事件流发一条 resync

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "runtime", "fixture.json");
const PORT = Number(process.env.MOCK_PORT || 5681);
const REPLAY_WINDOW = 500;

if (!existsSync(FIXTURE)) {
  console.error(`找不到 ${FIXTURE}。先在代码仓根目录运行：python3 web/mock/export_fixture.py`);
  process.exit(1);
}
const fixture = JSON.parse(readFileSync(FIXTURE, "utf-8"));

const now = () => new Date().toISOString().replace("Z", "+00:00");
const clone = (x) => JSON.parse(JSON.stringify(x));

// ───────────── 内存里的状态 ─────────────

const tasks = new Map();
for (const t of fixture.tasks) addTask(t);

function addTask(t) {
  const revisions = new Map();
  for (const e of t.library_events) {
    if (e.event === "deliverable_changed") revisions.set(e.data.revision_no, clone(e.data));
  }
  tasks.set(t.task.task_id, {
    task: clone(t.task),
    versions: clone(t.versions),
    events: clone(t.library_events),
    revisions,
    sessions: t.sessions.map((s) => ({ ...clone(s) })),
    materials: clone(t.materials),
    template: t.template,
    activeSession: t.sessions[0]?.session_id ?? null,
    busyElsewhere: false,
    clients: new Set(),
    counter: 0,
  });
}

const lastSeq = (st) => (st.events.length ? st.events[st.events.length - 1].data.seq : 0);

// ───────────── 完成条件（只为假服务重算） ─────────────

function recompute(st) {
  const task = st.task;
  if (!task.completion) return;
  task.completion.conditions = task.completion.conditions.map((c) => {
    const items = task.items.filter((i) => i.collection === c.collection);
    let missing = [];
    let note;
    if (c.name === "至少一个条目") {
      note = items.length ? `现在有 ${items.length} 个条目。` : "现在一个条目也没有。";
      return { ...c, met: items.length > 0, done: items.length, total: items.length, missing: [], note };
    }
    if (c.name === "每个条目评审通过") {
      missing = items.filter((i) => !i.reviews.some((r) => r.version_no === i.version_no && r.verdict === "合规")).map((i) => i.item_id);
      note = missing.length ? `有 ${missing.length} 个条目的当前版本还没有评审通过的记录。` : "每个条目的当前版本都有评审通过的记录。";
    } else if (c.name === "每个条目用户确认") {
      missing = items.filter((i) => !i.confirmations.some((r) => r.version_no === i.version_no && r.accepted)).map((i) => i.item_id);
      note = missing.length ? `有 ${missing.length} 个条目的当前版本还没有用户接受的记录。` : "每个条目的当前版本都有用户接受的记录。";
    } else if (c.name === "没有状态为未解决的条目") {
      missing = items.filter((i) => i.fields["状态"] === "未解决").map((i) => i.item_id);
      note = missing.length ? `还有 ${missing.length} 个状态为未解决的条目。` : "没有状态为未解决的条目。";
    } else {
      return c;
    }
    return { ...c, met: missing.length === 0, done: items.length - missing.length, total: items.length, missing, note };
  });
  task.completion.all_met = task.completion.conditions.every((c) => c.met);
}

// ───────────── 事件流 ─────────────

function send(res, event, data, id) {
  res.write(`event: ${event}\n${id != null ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
}

function broadcastLibrary(st, event, data) {
  st.events.push({ event, data });
  for (const c of st.clients) send(c.res, event, data, data.seq);
}

function broadcastProcess(st, event, data) {
  for (const c of st.clients) {
    if (data.session_id && c.session && c.session !== data.session_id) continue;
    send(c.res, event, data);
  }
}

function openStream(st, req, res, session) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": 已连上假服务的事件流\n\n");
  const last = Number(req.headers["last-event-id"]);
  if (Number.isFinite(last) && req.headers["last-event-id"] !== undefined) {
    const missing = st.events.filter((e) => e.data.seq > last);
    if (lastSeq(st) - last > REPLAY_WINDOW) send(res, "resync", { reason: "gap_too_large" });
    else for (const e of missing) send(res, e.event, e.data, e.data.seq);
  }
  const client = { res, session };
  st.clients.add(client);
  const keepAlive = setInterval(() => res.write(": 保活\n\n"), 15000);
  req.on("close", () => {
    clearInterval(keepAlive);
    st.clients.delete(client);
  });
}

// ───────────── 工具函数 ─────────────

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function fail(res, status, code, message, data = {}) {
  json(res, status, { ok: false, error: { code, message, data } });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function listEntry(st) {
  const c = st.task.completion;
  return {
    task_id: st.task.task_id, task_name: st.task.task_name, task_type: st.task.task_type, domain_tag: st.task.domain_tag,
    status: st.task.status, item_count: st.task.items.length,
    completion_met: c ? c.conditions.filter((x) => x.met).length : null, completion_total: c ? c.conditions.length : null,
    last_active_at: st.sessions.map((s) => s.last_active_at).filter(Boolean).sort().pop() ?? st.task.started_at,
    session_count: st.sessions.length,
  };
}

function sessionEntry(st, s) {
  return { session_id: s.session_id, name: s.name, started_at: s.started_at, last_active_at: s.last_active_at,
           message_count: s.messages.length, active: st.activeSession === s.session_id };
}

function materialsOut(st) {
  return st.materials.map(({ path, bytes, modified_at }) => ({ path, bytes, modified_at }));
}

function executorOf(st, session) {
  if (st.busyElsewhere) return { state: "working", text: "助手正在另一条会话里工作。", active_session: "s-elsewhere" };
  return { state: "idle", text: "助手空闲，可以开始。", active_session: st.activeSession ?? session };
}

function statusNote(st) {
  const t = st.task;
  const counts = t.definition.collections.map((c) => `${c.name} ${t.items.filter((i) => i.collection === c.name).length} 个`).join("、");
  const c = t.completion;
  const met = c ? c.conditions.filter((x) => x.met).length : "?";
  const total = c ? c.conditions.length : "?";
  const pending = t.items.filter((i) => i.fields["状态"] === "未解决").length;
  return `这是新会话。任务「${t.task_name}」${t.status}，交付物现有 ${t.items.length} 个条目（${counts}），完成条件满足 ${met} 项、共 ${total} 项，还有 ${pending} 条问题条目未解决。`;
}

// ───────────── 按固定脚本回话 ─────────────

function scriptedReply(st, text, count) {
  const item = st.task.items[count % Math.max(st.task.items.length, 1)];
  // 问题条目：所在集合有一个枚举字段，取值里有「用户决定保留」。假服务的提问挂在它上面。
  const pendingCollections = st.task.definition.collections
    .filter((c) => c.fields.some((f) => f.type === "枚举" && (f.values || []).includes("用户决定保留"))).map((c) => c.name);
  const pendingItem = st.task.items.find((i) => pendingCollections.includes(i.collection) && i.fields["状态"] !== "用户决定保留");
  const kinds = ["ask", "confirm", "suggest", "choose", "propose"];
  // 第一轮先演示挂在问题条目上的提问。
  const kind = kinds[(count - 1 + kinds.length) % kinds.length];
  const head = `（假服务按固定脚本回话，不是真的助手。）收到你说的「${text.slice(0, 40)}」。`;
  // 与「回复」工具的核对一致：提问、建议、提议、请确认都挂当前版本的条目；与条目无关的提问写 scope。
  const acts = {
    ask: pendingItem
      ? { kind: "ask", text: `假服务的提问：关于 ${pendingItem.item_id}，你们打算怎样处理？`, items: [{ item_id: pendingItem.item_id, version_no: pendingItem.version_no }] }
      : { kind: "ask", text: "假服务的提问：你希望先看哪一类条目？", scope: "general" },
    confirm: item && { kind: "confirm", text: `假服务请你确认 ${item.item_id} 的第 ${item.version_no} 版。`,
                       items: [{ item_id: item.item_id, version_no: item.version_no }] },
    suggest: item && { kind: "suggest", text: `假服务给 ${item.item_id} 一个建议值。`, value: String(item.title),
                       basis: item.sources.slice(0, 1), items: [{ item_id: item.item_id, version_no: item.version_no }] },
    choose: { kind: "choose", text: "假服务请你选下一步做什么。",
              options: st.task.definition.collections.slice(0, 3).map((c, i) => ({ key: "abc"[i], text: `先看${c.name}` })) },
    propose: item && { kind: "propose", text: `假服务提议把 ${item.item_id} 拆成两条。`,
                       items: [{ item_id: item.item_id, version_no: item.version_no }],
                       preview: [{ effect: "remove", text: `撤下 ${item.item_id}` }, { effect: "add", text: "新增两条条目" }] },
  };
  return { informs: [head], act: acts[kind] || null, text: `${head}这一轮假服务演示的是「${kind}」卡片。` };
}

/**
 * 假服务演示「执行者改了条目」（改动块、刚改过标记要用）：用户在卡片上选了一项或同意了提议之后，
 * 把第一条未解决的问题条目改成已解决并写上处理结果，再给第一个集合的第一个条目的第一个列表字段加一步。
 * 集合名、字段名都按任务定义找，不写死。
 */
function executorRevision(st, sessionId, userText) {
  const defs = st.task.definition.collections;
  const ops = [];
  const pendingDef = defs.find((c) => c.fields.some((f) => f.type === "枚举" && (f.values ?? []).includes("用户决定保留")));
  if (pendingDef) {
    const status = pendingDef.fields.find((f) => (f.values ?? []).includes("用户决定保留"));
    const result = [...pendingDef.fields].reverse().find((f) => f.type === "文本");
    const tbd = st.task.items.find((i) => i.collection === pendingDef.name && i.fields[status.name] === status.values[0]);
    if (tbd) {
      const fields = { ...tbd.fields, [status.name]: status.values[1], ...(result ? { [result.name]: `假服务按你的回答写的：${userText}` } : {}) };
      ops.push({ op: "update", collection: tbd.collection, item_id: tbd.item_id, title: tbd.title, version_before: tbd.version_no, version_after: tbd.version_no + 1, fields, sources: tbd.sources });
    }
  }
  const first = defs[0];
  const listField = first?.fields.find((f) => f.type === "文本列表" && f.required);
  const uc = first && st.task.items.find((i) => i.collection === first.name);
  if (uc && listField) {
    const fields = { ...uc.fields, [listField.name]: [...(uc.fields[listField.name] || []), "（假服务加的一步）系统把处理结果通知用户"] };
    ops.push({ op: "update", collection: uc.collection, item_id: uc.item_id, title: uc.title, version_before: uc.version_no, version_after: uc.version_no + 1, fields, sources: uc.sources });
  }
  if (ops.length) commitRevision(st, ops, null, sessionId, "", null, "executor");
  return ops.length > 0;
}

function runWork(st, sessionId, userText) {
  const session = st.sessions.find((s) => s.session_id === sessionId);
  const workId = `mock-work-${Date.now()}-${++st.counter}`; // 不与导出数据里的 work-1 之类重号
  const t0 = Date.now();
  const at = () => now();
  broadcastProcess(st, "executor_state", { state: "working", text: "助手正在工作。", active_session: sessionId });
  broadcastProcess(st, "work_started", { session_id: sessionId, work_id: workId, at: at(), triggered_by: null });
  const revise = userText.startsWith("我选：") || userText === "就这样做。";
  const steps = ["读材料《" + (st.materials[0]?.path ?? "材料") + "》", ...(revise ? ["保存修订"] : []), "组织回复"];
  if (revise) setTimeout(() => executorRevision(st, sessionId, userText), 1200);
  steps.forEach((s, i) => {
    setTimeout(() => broadcastProcess(st, "step", { session_id: sessionId, work_id: workId, step_key: i, text: `正在${s}`, in_progress: true, failed: false }), 300 + i * 500);
    setTimeout(() => broadcastProcess(st, "step", { session_id: sessionId, work_id: workId, step_key: i, text: s.replace(/^读/, "读了"), in_progress: false, failed: false }), 600 + i * 500);
  });
  setTimeout(() => {
    const reply = { session_id: sessionId, message_id: `m-${Date.now()}`, at: at(), work_id: workId, via_reply_tool: true,
                    ...scriptedReply(st, userText, st.counter) };
    session?.messages.push({ type: "assistant_reply", ...reply });
    broadcastProcess(st, "assistant_reply", reply);
    const ended = { session_id: sessionId, work_id: workId, at: at(), seconds: Math.round((Date.now() - t0) / 1000), step_count: steps.length, outcome: "replied" };
    const summary = { session_id: sessionId, work_id: workId, at: ended.at, seconds: ended.seconds, step_count: ended.step_count, stages: steps.map((s) => ({ text: s })) };
    // 与真后端一致：过程摘要在这次工作的回复之前（回复刚刚推进去，就插在它前面）。
    session?.messages.splice(session.messages.length - 1, 0, { type: "work_summary", ...summary });
    broadcastProcess(st, "work_ended", ended);
    broadcastProcess(st, "work_summary", summary);
    broadcastProcess(st, "executor_state", { state: "idle", text: "助手空闲，可以开始。", active_session: sessionId });
    if (session) session.last_active_at = at();
  }, 1800);
}

// ───────────── 直接操作 ─────────────

function newRevisionNo(st) {
  return Math.max(0, ...st.revisions.keys()) + 1;
}

function applyAction(st, body, sessionId, res) {
  const opId = `ui-op-${++st.counter}`;
  const findItem = (id) => st.task.items.find((i) => i.item_id === id);
  if (body.kind === "undo") {
    const rev = st.revisions.get(body.targets?.[0]?.revision_no);
    if (!rev) return fail(res, 422, "rejected", "要撤销的那次修订不存在。", { reasons: ["修订序号不存在"] });
    const conflicts = rev.operations.filter((op) => {
      const item = findItem(op.item_id);
      return op.op !== "delete" && item && item.version_no !== op.version_after;
    });
    if (conflicts.length) {
      return fail(res, 409, "undo_conflict", `那次修订之后 ${conflicts.map((c) => c.item_id).join("、")} 又被改过，不能撤销。`,
                  { items: conflicts.map((c) => c.item_id) });
    }
    json(res, 200, { ok: true, client_id: body.client_id, op_id: opId });
    const ops = rev.operations.map((op) => {
      const item = findItem(op.item_id);
      const before = (st.versions[op.item_id] || []).find((v) => v.version_no === op.version_before);
      if (op.op === "add") return { op: "delete", collection: op.collection, item_id: op.item_id, title: op.title, version_before: item?.version_no ?? null, version_after: null, fields: null, sources: [] };
      return { op: "update", collection: op.collection, item_id: op.item_id, title: item?.title ?? op.title,
               version_before: item?.version_no ?? null, version_after: (item?.version_no ?? 0) + 1,
               fields: before?.fields ?? item?.fields, sources: before?.sources ?? item?.sources ?? [] };
    });
    return setTimeout(() => commitRevision(st, ops, opId, sessionId, `你撤销了第 ${rev.revision_no} 次修订`, rev.revision_no), 200);
  }

  const stale = [];
  for (const target of body.targets || []) {
    const item = findItem(target.item_id);
    if (!item) return fail(res, 422, "rejected", `条目 ${target.item_id} 不存在。`, { reasons: [`条目 ${target.item_id} 不存在`] });
    if (target.base_version !== item.version_no) stale.push({ item_id: item.item_id, version_no: item.version_no, by: item.version_by });
  }
  if (stale.length) {
    return fail(res, 409, "stale_version", "这个条目刚被改过（可能是助手，也可能是另一个页面），请看最新内容后再改。", { items: stale });
  }

  if (body.kind === "edit_fields" || body.kind === "keep_pending") {
    const item = findItem(body.targets[0].item_id);
    const def = st.task.definition.collections.find((c) => c.name === item.collection);
    const fields = body.kind === "keep_pending" ? { 状态: "用户决定保留" } : body.fields || {};
    const reasons = [];
    for (const [name, value] of Object.entries(fields)) {
      const f = def.fields.find((x) => x.name === name);
      if (!f) reasons.push(`集合「${item.collection}」没有字段「${name}」`);
      else if (f.required && (value == null || (Array.isArray(value) ? value.filter((s) => String(s).trim()).length === 0 : String(value).trim() === "")))
        reasons.push(`必填字段「${name}」不能为空`);
      else if (f.values && !f.values.includes(value)) reasons.push(`字段「${name}」只能取 ${f.values.join("、")} 之一`);
    }
    if (reasons.length) return fail(res, 422, "rejected", "这次修改没有保存：" + reasons.join("；") + "。", { reasons });
    json(res, 200, { ok: true, client_id: body.client_id, op_id: opId });
    const merged = { ...item.fields, ...fields };
    const op = { op: "update", collection: item.collection, item_id: item.item_id, title: String(Array.isArray(merged[def.fields[0].name]) ? merged[def.fields[0].name].join("；") : merged[def.fields[0].name] ?? item.title),
                 version_before: item.version_no, version_after: item.version_no + 1, fields: merged, sources: item.sources };
    const names = Object.keys(fields).join("、");
    return setTimeout(() => commitRevision(st, [op], opId, sessionId, `你修改了 ${item.item_id} 的${names}（第 ${item.version_no} 版 → 第 ${item.version_no + 1} 版）`), 200);
  }

  if (body.kind === "delete_item") {
    const item = findItem(body.targets[0].item_id);
    json(res, 200, { ok: true, client_id: body.client_id, op_id: opId });
    const op = { op: "delete", collection: item.collection, item_id: item.item_id, title: item.title, version_before: item.version_no, version_after: null, fields: null, sources: [] };
    return setTimeout(() => commitRevision(st, [op], opId, sessionId, `你删除了 ${item.item_id}`), 200);
  }

  if (body.kind === "confirm" || body.kind === "unconfirm") {
    json(res, 200, { ok: true, client_id: body.client_id, op_id: opId });
    return setTimeout(() => {
      const accepted = body.kind === "confirm";
      const items = body.targets.map((t) => ({ item_id: t.item_id, version_no: t.base_version, accepted }));
      for (const it of items) {
        const item = findItem(it.item_id);
        item.confirmations.push({ version_no: it.version_no, accepted, basis: "ui_click", at: now() });
        item.confirmation_stale = false;
      }
      recompute(st);
      const seq = lastSeq(st) + 1;
      broadcastLibrary(st, "confirmation_recorded", { seq, at: now(), task_id: st.task.task_id, op_id: opId, items, basis: "ui_click", completion: clone(st.task.completion) });
      const list = items.map((i) => `${i.item_id} 第 ${i.version_no} 版`).join("、");
      noteAction(st, sessionId, accepted ? `你确认了 ${list}` : `你撤回了对 ${list} 的确认`, seq, false);
      if (accepted && body.notify_executor) {
        const text = `我已经在界面上确认了：${list}。请接着往下做。`;
        broadcastProcess(st, "user_message", { session_id: sessionId, message_id: `m-${Date.now()}`, at: now(), text, origin: "ui_request", annotation: null, queued: false });
        runWork(st, sessionId, text);
      }
    }, 200);
  }
  return fail(res, 400, "bad_request", `不认识的操作种类 ${body.kind}。`);
}

function commitRevision(st, ops, opId, sessionId, noteText, undoOf = null, actor = "user") {
  for (const op of ops) {
    const index = st.task.items.findIndex((i) => i.item_id === op.item_id);
    if (op.op === "delete") {
      if (index >= 0) st.task.items.splice(index, 1);
      continue;
    }
    const item = st.task.items[index];
    const updated = { ...item, title: op.title, version_no: op.version_after, version_by: actor, version_at: now(),
                      version_count: item.version_count + 1, fields: op.fields, sources: op.sources };
    const accepted = [...updated.confirmations].reverse().find((c) => c.accepted);
    updated.confirmation_stale = !!accepted && accepted.version_no !== updated.version_no;
    st.task.items[index] = updated;
    (st.versions[op.item_id] ||= []).push({ version_no: op.version_after, revision_no: newRevisionNo(st), by: actor, at: now(),
                                           fields: op.fields, sources: op.sources, reviews: [], confirmations: [] });
  }
  recompute(st);
  const revisionNo = newRevisionNo(st);
  const data = { seq: lastSeq(st) + 1, at: now(), task_id: st.task.task_id, revision_no: revisionNo, actor, op_id: actor === "user" ? opId : null,
                 undo_of_revision: undoOf, operations: ops, completion: clone(st.task.completion) };
  st.revisions.set(revisionNo, clone(data));
  broadcastLibrary(st, "deliverable_changed", data);
  if (actor === "user") noteAction(st, sessionId, `${noteText}`, data.seq, true, revisionNo);
}

function noteAction(st, sessionId, text, seq, undoable, revisionNo) {
  const note = { session_id: sessionId, message_id: `ui-${seq}`, at: now(), text, event_seq: seq, undoable, revision_no: revisionNo ?? null };
  st.sessions.find((s) => s.session_id === sessionId)?.messages.push({ type: "ui_action_noted", ...note });
  broadcastProcess(st, "ui_action_noted", note);
}

// ───────────── 生成文档 ─────────────

function renderDocument(st, selection) {
  const lines = [`# ${st.task.task_name}`, ""];
  for (const coll of st.task.definition.collections) {
    const picked = selection.filter((s) => st.task.items.find((i) => i.item_id === s.item_id)?.collection === coll.name);
    if (!picked.length) continue;
    lines.push(`## ${coll.name}`, "");
    for (const sel of picked) {
      const version = (st.versions[sel.item_id] || []).find((v) => v.version_no === sel.version_no);
      const item = st.task.items.find((i) => i.item_id === sel.item_id);
      if (!version) continue;
      const reviewed = item.reviews.some((r) => r.version_no === sel.version_no && r.verdict === "合规");
      const confirmed = item.confirmations.some((c) => c.version_no === sel.version_no && c.accepted);
      lines.push(`### ${sel.item_id} ${item.title}（第 ${sel.version_no} 版）`);
      if (!reviewed) lines.push("> 这一版还没有评审通过的记录。");
      if (!confirmed) lines.push("> 这一版还没有用户确认的记录。");
      lines.push("");
      for (const f of coll.fields) {
        const v = version.fields?.[f.name];
        if (v == null || (Array.isArray(v) && !v.length) || v === "") continue;
        lines.push(`**${f.name}**：` + (Array.isArray(v) ? "\n" + v.map((x, i) => `${i + 1}. ${x}`).join("\n") : String(v)), "");
      }
    }
  }
  lines.push("", "（假服务生成的预览，不是后端的渲染程序。）");
  return lines.join("\n");
}

// ───────────── 路由 ─────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const session = url.searchParams.get("session");
  try {
    if (parts[0] === "__mock") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      for (const st of tasks.values()) {
        if (parts[1] === "busy") {
          st.busyElsewhere = !!body.on;
          broadcastProcess(st, "executor_state", executorOf(st, null));
        }
        if (parts[1] === "disconnect") for (const c of st.clients) c.res.destroy();
        if (parts[1] === "resync") for (const c of st.clients) send(c.res, "resync", { reason: "gap_too_large" });
      }
      return json(res, 200, { ok: true });
    }
    if (parts[0] === "api" && parts[1] === "v1" && parts[2] === "task-types") {
      return json(res, 200, { ok: true, task_types: [{ task_type: "srs-authoring", name: fixture.tasks[0].task.task_type }] });
    }
    if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "tasks") return fail(res, 404, "not_found", "没有这个接口。");
    if (parts.length === 3) {
      if (req.method === "GET") return json(res, 200, { ok: true, tasks: [...tasks.values()].map(listEntry) });
      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        if (!body.task_name?.trim()) return fail(res, 422, "rejected", "任务名不能为空。", { reasons: ["任务名不能为空"] });
        const base = fixture.tasks[0];
        const id = `TASK-${String(tasks.size + 1).padStart(3, "0")}`;
        const t = clone(base);
        t.task = { ...t.task, task_id: id, task_name: body.task_name, domain_tag: body.domain_tag ?? null, status: "进行中",
                   started_at: now(), ended_at: null, items: [] };
        t.versions = {};
        t.library_events = [{ event: "task_changed", data: { seq: 1, at: now(), task_id: id, task_name: body.task_name, status_before: null, status_after: "进行中", actor: "user", completion: null } }];
        t.sessions = [];
        t.materials = [];
        addTask(t);
        recompute(tasks.get(id));
        return json(res, 200, { ok: true, task_id: id });
      }
    }
    const st = tasks.get(parts[3]);
    if (!st) return fail(res, 404, "not_found", "没有这个任务。");
    const rest = parts.slice(4);
    const closed = st.task.status !== "进行中";

    if (rest.length === 0 && req.method === "GET") {
      return json(res, 200, { ok: true, ...st.task, materials: materialsOut(st), sessions: st.sessions.map((s) => sessionEntry(st, s)) });
    }
    if (rest[0] === "sessions") {
      if (req.method === "GET") return json(res, 200, { ok: true, sessions: st.sessions.map((s) => sessionEntry(st, s)) });
      if (st.busyElsewhere) return fail(res, 409, "session_busy", "执行者正在另一条会话里工作，做完才能在这里继续。", { active_session: "s-elsewhere" });
      const id = `s-${Date.now().toString(36)}`;
      const at = now();
      st.sessions.push({ session_id: id, name: "新会话", started_at: at, last_active_at: at, message_count: 0,
                         messages: [{ type: "system_note", message_id: `note-${id}`, at, text: statusNote(st) }] });
      st.activeSession = id;
      return json(res, 200, { ok: true, session_id: id });
    }
    if (rest[0] === "snapshot") {
      const s = st.sessions.find((x) => x.session_id === session);
      if (!s) return fail(res, 400, "bad_request", "没有这条会话。");
      if (!st.busyElsewhere) st.activeSession = session;
      return json(res, 200, {
        seq: lastSeq(st), generated_at: now(), executor: executorOf(st, session),
        session: { session_id: s.session_id, name: s.name, started_at: s.started_at, last_active_at: s.last_active_at },
        task: st.task, materials: materialsOut(st),
        conversation: { messages: s.messages.slice(-100), has_earlier: s.messages.length > 100, earliest_id: s.messages[0]?.message_id ?? null },
        current_work: null,
      });
    }
    if (rest[0] === "events") return openStream(st, req, res, session);
    if (rest[0] === "items" && rest[2] === "versions") return json(res, 200, { ok: true, item_id: rest[1], versions: st.versions[rest[1]] || [] });
    if (rest[0] === "materials" && rest[1] === "content") {
      const path = url.searchParams.get("path") || "";
      const m = st.materials.find((x) => x.path === path);
      if (!path.startsWith("inputs/") || !m) return fail(res, 400, "bad_request", "路径不在材料目录里。");
      return json(res, 200, { path, text: m.text });
    }
    if (rest[0] === "materials" && req.method === "POST") {
      const raw = await readBody(req);
      const text = raw.toString("utf-8");
      const name = (text.match(/filename="([^"]+)"/) || [])[1] || "";
      if (!/\.(md|txt)$/i.test(name)) return fail(res, 415, "unsupported_type", "只接受 .md 与 .txt 文件。");
      if (raw.length > 5 * 1024 * 1024) return fail(res, 413, "too_large", "单个文件不能超过 5 MB。");
      if (/[\\/]/.test(name)) return fail(res, 400, "bad_request", "文件名不能带路径分隔符。");
      const content = text.split(/\r\n\r\n/).slice(1).join("\r\n\r\n").replace(/\r\n--[^\r\n]*--\r\n?$/, "");
      let path = `inputs/${name}`;
      for (let n = 2; st.materials.some((m) => m.path === path); n++) path = `inputs/${name.replace(/(\.\w+)$/, `-${n}$1`)}`;
      const material = { path, bytes: Buffer.byteLength(content), modified_at: now() };
      st.materials.push({ ...material, text: content });
      broadcastProcess(st, "material_added", { session_id: session, at: now(), ...material });
      return json(res, 200, { ok: true, path });
    }
    if (rest[0] === "conversation") return json(res, 200, { messages: [], has_earlier: false, earliest_id: null });
    if (rest[0] === "documents") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const text = renderDocument(st, body.selection || []);
      if (rest[1] === "preview") return json(res, 200, { text });
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": "attachment; filename=\"document.md\"" });
      return res.end(text);
    }
    if (rest[0] === "messages" || rest[0] === "actions" || rest[0] === "control") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      if (closed) return fail(res, 409, "task_closed", "这个任务已经结束，只能查看。");
      if (st.busyElsewhere) return fail(res, 409, "session_busy", "执行者正在另一条会话里工作，做完才能在这里继续。", { active_session: "s-elsewhere" });
      if (rest[0] === "control") return json(res, 200, { ok: true, cleared: [] });
      if (rest[0] === "actions") return applyAction(st, body, session, res);
      json(res, 200, { ok: true, client_id: body.client_id, queued: false });
      const s = st.sessions.find((x) => x.session_id === session);
      const message = { session_id: session, message_id: `m-${Date.now()}`, at: now(), text: body.text, origin: body.origin || "typed",
                        annotation: body.card ?? null, queued: false, client_id: body.client_id };
      s?.messages.push({ type: "user_message", ...message });
      setTimeout(() => broadcastProcess(st, "user_message", message), 100);
      return setTimeout(() => runWork(st, session, body.text), 200);
    }
    return fail(res, 404, "bad_request", "没有这个接口。");
  } catch (error) {
    console.error(error);
    return fail(res, 400, "bad_request", String(error));
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`假服务已启动：http://0.0.0.0:${PORT}（数据来自 ${fixture.说明}）`));
