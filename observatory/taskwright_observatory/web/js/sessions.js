// 页面一：会话列表。一行是一条 pi 会话，或者一次没能启动起来的 pi 进程。

import { api } from "./api.js";
import { $, esc, shortId, unknown } from "./util.js";
import { freshView, setCrumb, setLangfuse, state } from "./state.js";

let filterTask = "全部";
let filterEnd = "全部";

function radios(name, values, current) {
  return values.map((value) =>
    `<label><input type="radio" name="${name}" value="${esc(value)}"` +
    `${current === value ? " checked" : ""}> ${esc(value)}</label>`).join("");
}

function taskTags(row) {
  if (row["启动失败"]) {
    return `<span class="chip bad">pi 没有启动起来，所以没有任务</span>`;
  }
  if (row["提取出的任务"].length === 0) {
    const note = row["任务对不上的说明"] ||
      "这条会话没有对上任务。";
    const place = row["所在任务目录"] || {};
    return unknown(note) + (place["说明"]
      ? ` <span class="chip domain">任务目录 ${esc(place["任务目录"])}：${esc(place["说明"])}</span>` : "");
  }
  return row["提取出的任务"].map((task) =>
    `<span class="chip domain">领域：${esc(task["任务类型"])} · ${esc(task["状态"])} · ` +
    `任务目录 ${esc(task["任务目录"])} · 已修订到第 ${task["修订总数"]} 次</span>`).join(" ");
}

function rowHtml(row) {
  const ended = row["启动失败"]
    ? `<span class="chip bad">pi 没有启动起来</span>`
    : (row["终态"] === "正常结束"
      ? `<span class="chip good">正常结束</span>`
      : `<span class="chip warn">${esc(row["终态"])}</span>`);
  const restart = row["启动失败"] ? ""
    : (row["是否重启过"]
      ? `<span class="chip backend">后端：中途重启过 pi，一共启动了 ` +
        `${row["pi 进程启动次数"]} 次进程</span>`
      : `<span class="chip backend">后端：没有重启过 pi</span>`);
  const identity = row["会话编号"]
    ? `会话编号 <span title="${esc(row["会话编号"])}">${esc(shortId(row["会话编号"]))}</span>`
    : "这一次没有会话编号，因为 pi 在发出第一条事件之前就退出了";
  const failure = row["启动失败"] && row["启动失败原因"]
    ? `<div class="src" style="color:var(--bad)">失败原因原文：${esc(row["启动失败原因"])}</div>`
    : "";
  const langfuse = row["Langfuse 链接"]
    ? `<a href="${esc(row["Langfuse 链接"])}" target="_blank" rel="noopener"` +
      ` onclick="event.stopPropagation()">到 Langfuse</a>`
    : `<span class="src">这一次没有 Langfuse 链接</span>`;
  const openKey = row["会话编号"] || (row["归档文件"] || [])[0] || "";
  const entries = row["启动失败"] ? "" :
    `<div class="entries"><a href="#/session/${encodeURIComponent(openKey)}"` +
    ` onclick="event.stopPropagation()">进入会话详情</a>` +
    row["提取出的任务"].map((task) => `<a href="#/task/${task["任务的键"].split("/").map(encodeURIComponent).join("/")}"` +
      ` onclick="event.stopPropagation()">进入任务页（${esc(task["任务的键"])}）</a>`).join("") +
    (row["提取出的任务"].length ? "" : `<span class="src">${esc((row["任务对不上的说明"] || "这条会话没有对上任务").replace(/。$/, ""))}，所以没有任务页</span>`) + `</div>`;
  return `<div class="sessrow" data-open="${esc(openKey)}">` +
    `<div><div class="stitle">归档名「${esc(row["归档名"])}」</div>` +
      `<div class="src">${esc(row["开始时刻"])}` +
      (row["结束时刻"] ? ` 到 ${esc(row["结束时刻"])}` : "") + ` · ${identity}</div>` +
      `<div class="src">归档文件：${esc((row["归档文件"] || []).join("、"))}</div>${failure}</div>` +
    `<div class="src">${row["运行次数"]} 次运行<br>${row["轮数"]} 轮<br>` +
      `${row["模型请求次数"]} 次模型请求<br>${row["工具调用次数"]} 次工具调用<br>` +
      (row["被拒次数"] ? `<span style="color:var(--bad)">${row["被拒次数"]} 次调用被拒</span>`
        : "没有调用被拒") + `</div>` +
    `<div>${ended} ${restart}<div style="margin-top:4px">${taskTags(row)}</div></div>` +
    `<div>${langfuse}${entries}</div></div>`;
}

export async function renderSessions() {
  const view = freshView();
  setCrumb("");
  setLangfuse(state.overview["Langfuse 全部会话"], "到 Langfuse 看全部会话");
  view.innerHTML = `<section class="panel"><p class="muted">正在读会话列表。</p></section>`;

  const data = await api.sessions();
  const rows = data["会话"].filter((row) => {
    const hasTask = row["提取出的任务"].length > 0;
    if (filterTask === "有任务" && !hasTask) return false;
    if (filterTask === "没有任务" && hasTask) return false;
    if (filterEnd === "只看正常结束" && (row["启动失败"] || row["终态"] !== "正常结束")) return false;
    if (filterEnd === "只看被中止过的" && !row["终态"].includes("中止")) return false;
    if (filterEnd === "只看 pi 没起来的" && !row["启动失败"]) return false;
    return true;
  });

  view.innerHTML =
    `<section class="panel"><h2>会话列表</h2>` +
      `<p class="muted" style="margin:0 0 10px">一行是一条 pi 会话（session）。` +
      `每条会话里有若干次<b>运行</b>（agent run，一次运行由一次提示 prompt 触发），` +
      `每次运行里有若干<b>轮</b>（turn，一轮是一条助手响应加它引出的工具调用与结果）。` +
      `这几个词都是 pi 自己的，含义见<a href="#/concepts">概念对照</a>那一页。` +
      `任务不是这里登记的：会话在哪个任务目录里跑，就属于那个目录里的那个任务（一库一任务），不看它有没有写过库；` +
      `旧格式的库一库可以有好几个任务，仍按会话里工具调用的调用编号到那个任务目录的库里去对。` +
      `任务目录里还没有任务记录时，这条会话就没有任务。点一行进入会话详情。</p>` +
      `<div class="filters"><span class="muted">按有没有对上任务筛选：</span>` +
        radios("ft", ["全部", "有任务", "没有任务"], filterTask) +
        `<span class="muted">按结局筛选：</span>` +
        radios("fe", ["全部", "只看正常结束", "只看被中止过的", "只看 pi 没起来的"], filterEnd) +
      `</div>` +
      `<p class="src">归档目录是 ${esc(state.overview["归档目录"])}；` +
      `任务目录从 ${esc(state.overview["任务目录所在目录"])} 下面扫出来，一共 ` +
      `${state.overview["任务目录数"]} 个。</p>` +
      `<div id="srows">${rows.map(rowHtml).join("") ||
        `<p class="muted">没有符合当前筛选条件的会话。</p>`}</div></section>`;

  view.addEventListener("change", (event) => {
    if (event.target.name === "ft") { filterTask = event.target.value; renderSessions(); }
    if (event.target.name === "fe") { filterEnd = event.target.value; renderSessions(); }
  });
  $("#srows").addEventListener("click", (event) => {
    const row = event.target.closest(".sessrow");
    if (row && row.dataset.open) location.hash = `#/session/${encodeURIComponent(row.dataset.open)}`;
  });
}
