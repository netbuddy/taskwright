// 页面二：会话详情。与任务页用同一个组件（taskpage.js），按会话取数据：一条会话里发生的事按运行排成一张表，
// 点开一行看各轮与机器细节，右边是交付物看板与知识的使用。会话所在的任务目录里还没有任务记录时照样能看，
// 看板处如实写明。任务与会话按任务目录挂接（一库一任务）。
//
// 本文件只管入口：pi 进程没有启动起来的那一次没有流程可画，照旧给一页说明失败的原因。

import { api } from "./api.js";
import { esc, unknown } from "./util.js";
import { freshView, setCrumb, setLangfuse } from "./state.js";
import { renderTaskPage } from "./taskpage.js";

function failedPage(detail) {
  const launch = detail["启动"][0] || {};
  return `<section class="panel"><h2>这一次 pi 进程没有启动起来</h2>` +
    `<dl class="kv"><dt>归档名</dt><dd>${esc(detail["归档名"])}</dd>` +
    `<dt>启动时刻</dt><dd>${esc(launch["启动时刻"] || "未知")}</dd>` +
    `<dt>归档文件</dt><dd class="mono">${esc(launch["归档文件"] || "")}` +
      `（${launch["事件行数"]} 行，pi 一条事件都没有发出来）</dd>` +
    `<dt>失败原因</dt><dd>${detail["启动失败原因"] && detail["启动失败原因"] !== "未知"
      ? `<pre class="args">${esc(detail["启动失败原因"])}</pre>`
      : unknown("失败原因没有被记在任何文件里。这一次跑在后端补记这件事之前，" +
                "当时 pi 的标准错误只打在终端上。")}</dd>` +
    `<dt>启动命令</dt><dd>${launch["后端补记启动"]
      ? `<pre class="args">${esc((launch["后端补记启动"]["命令行"] || []).join(" "))}</pre>`
      : unknown("启动命令没有被记进归档。")}</dd></dl></section>`;
}

// 地址的第三段是 msg-<会话条目编号> 时（来源里「用户的话」的出处链过来），把那条用户消息展开并滚到眼前。
function focusMessage(anchor) {
  const target = anchor && document.getElementById(anchor);
  if (!target) return;
  for (let node = target; node; node = node.parentElement) {
    if (node.hasAttribute && node.hasAttribute("hidden")) node.removeAttribute("hidden");
    // 流程表里一次运行的展开区被打开时，它上面那一行也标成展开的样子。
    if (node.classList && node.classList.contains("rbody") && node.previousElementSibling) {
      node.previousElementSibling.classList.add("open");
      node.previousElementSibling.setAttribute("aria-expanded", "true");
    }
  }
  target.classList.add("focus-msg");
  setTimeout(() => target.scrollIntoView({block: "center"}), 50);
}

export async function renderSession(sessionId, anchor) {
  const view = freshView();
  view.innerHTML = `<section class="panel"><p class="muted">正在读这条会话。</p></section>`;
  const detail = await api.session(sessionId);
  setCrumb(`<a href="#/sessions">会话列表</a> › 会话「${esc(detail["会话名"] || "未命名会话")}」的会话详情`);
  setLangfuse(detail["Langfuse 链接"], "到 Langfuse 看这条会话");
  if (detail["启动失败"]) {
    view.innerHTML = failedPage(detail);
    return;
  }
  renderTaskPage(view, await api.taskpageSession(sessionId));
  focusMessage(anchor);
}
