// 启动与路由。地址栏井号后面的那一段说明要看哪一页。

import { api } from "./api.js";
import { $, esc } from "./util.js";
import { state } from "./state.js";
import { renderSessions } from "./sessions.js";
import { renderSession } from "./session.js";
import { renderTask, renderTaskList } from "./task.js";
import { renderHealth } from "./health.js";
import { renderConcepts } from "./concepts.js";

const TABS = [
  { id: "sessions", name: "会话列表" },
  { id: "tasks", name: "任务" },
  { id: "health", name: "系统健康" },
  { id: "concepts", name: "概念对照" },
];

function buildTabs() {
  $("#tabs").innerHTML = TABS.map((tab) =>
    `<button type="button" data-tab="${tab.id}" aria-selected="false">${esc(tab.name)}</button>`)
    .join("");
  $("#tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tab]");
    if (button) location.hash = `#/${button.dataset.tab}`;
  });
}

function markTab(id) {
  [...$("#tabs").children].forEach((button) =>
    button.setAttribute("aria-selected", String(button.dataset.tab === id)));
}

function showError(error) {
  $("#view").innerHTML = `<section class="panel"><h2>出错了</h2>` +
    `<pre class="args">${esc(error && error.message ? error.message : error)}</pre>` +
    `<p class="muted">这是观测台自己出的错，不是被观测的那次运行出的错。</p></section>`;
}

async function route() {
  const hash = (location.hash || "#/sessions").replace(/^#\//, "");
  const parts = hash.split("/").map(decodeURIComponent);
  try {
    if (parts[0] === "health") { markTab("health"); await renderHealth(); }
    else if (parts[0] === "concepts") { markTab("concepts"); await renderConcepts(); }
    else if (parts[0] === "session" && parts[1]) {
      markTab("sessions");
      await renderSession(parts[1], parts[2]);
    } else if (parts[0] === "task" && parts[1] && parts[2]) {
      markTab("tasks");
      await renderTask(`${parts[1]}/${parts[2]}`);
    } else if (parts[0] === "tasks" || parts[0] === "task") {
      markTab("tasks"); await renderTaskList();
    } else { markTab("sessions"); await renderSessions(); }
  } catch (error) {
    showError(error);
  }
  if (!(parts[0] === "session" && parts[2])) window.scrollTo(0, 0);
}

async function start() {
  buildTabs();
  try {
    state.overview = await api.overview();
  } catch (error) {
    showError(error);
    return;
  }
  const overview = state.overview;
  $("#notice").innerHTML =
    `这一页上的每一个数字都来自真实记录：任务目录里的任务数据库、后端归档的 pi 原始事件流、` +
    `pi 自己的会话文件。取不到依据的地方写「未知」或「这类记录还没有」，不拿示意数据填。` +
    `属于 pi 的概念一律用 pi 的名字，含义与出处见<a href="#/concepts">概念对照</a>那一页。` +
    (overview["有没有配 Langfuse"] ? "" :
      "（没有给 Langfuse 的地址与项目标识，所以这一次不显示到 Langfuse 的链接。）");
  window.addEventListener("hashchange", route);
  await route();
}

start();
