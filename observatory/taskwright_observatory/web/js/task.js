// 页面三：任务。顶部导航「任务」进来先是任务列表，点一个任务进它的任务页。
// 任务页与会话详情页用同一个组件（taskpage.js），按任务取数据：一个任务可以跨好几条会话，按时间接起来。
// 「任务」是业务领域的概念，来自任务目录的任务数据库，不是 pi 的概念。

import { api } from "./api.js";
import { esc } from "./util.js";
import { freshView, setCrumb, setLangfuse, state } from "./state.js";
import { renderTaskPage } from "./taskpage.js";

const link = (key) => `#/task/${key.split("/").map(encodeURIComponent).join("/")}`;

export async function renderTaskList() {
  const view = freshView();
  setCrumb("");
  setLangfuse(state.overview["Langfuse 全部会话"], "到 Langfuse 看全部会话");
  view.innerHTML = `<section class="panel"><p class="muted">正在读任务列表。</p></section>`;
  const rows = (await api.tasklist())["任务"];
  const touched = rows.filter((r) => r["涉及会话"].length);
  const quiet = rows.filter((r) => !r["涉及会话"].length);
  const row = (r) => `<li><a href="${r["涉及会话"].length ? link(r["任务的键"]) : "#/tasks"}">` +
    `${esc(r["任务名"] || r["任务编号"])}</a> ` +
    `<span class="chip domain">任务目录 ${esc(r["任务目录"])} · 任务编号 ${esc(r["任务编号"])} · ${esc(r["库的格式"])} · 状态是${esc(r["状态"])}</span> ` +
    `<span class="src">${r["涉及会话"].length ? `涉及 ${r["涉及会话"].length} 条会话` :
      "当前扫到的归档里没有哪条会话在这个任务的库里写过东西，所以没有任务页可看"}</span></li>`;
  view.innerHTML = `<section class="panel"><h2>任务</h2>` +
    `<p class="muted" style="margin:0 0 10px">一行是一个任务，取自各个任务目录的任务数据库（任务是业务领域的概念，不是 pi 的概念）。` +
    `点一个任务进它的任务页：一个任务可以跨好几条会话，任务页把它们按时间接起来，一行是一次运行（用户的一句话加上助手为它做的全部轮），点开一行看各轮与机器细节。</p>` +
    `<ul class="list">${touched.map(row).join("") || "<li class=\"muted\">当前扫到的归档里没有对得上会话的任务。</li>"}</ul>` +
    (quiet.length ? `<details class="gap"><summary class="muted">另有 ${quiet.length} 个任务在当前扫到的归档里对不上任何一条会话（点开看）</summary>` +
      `<ul class="list">${quiet.map(row).join("")}</ul></details>` : "") +
    `</section>`;
}

export async function renderTask(key) {
  const view = freshView();
  view.innerHTML = `<section class="panel"><p class="muted">正在读这个任务。</p></section>`;
  const page = await api.taskpageTask(key);
  setCrumb(`<a href="#/tasks">任务</a> › 任务目录 ${esc(page["页头"]["任务目录"])} 的任务 ${esc(page["页头"]["任务编号"])}`);
  setLangfuse((page["会话"][0] || {})["Langfuse 链接"], "到 Langfuse 看这个任务的第一条会话");
  renderTaskPage(view, page);
}
