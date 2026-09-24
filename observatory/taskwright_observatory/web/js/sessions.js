// 页面一：会话列表。一行是一条 pi 会话，或者一次没能启动起来的 pi 进程。
// 行标题是「任务名 · 会话名 · 开始时刻」；搜索框按任务名、会话名、任务编号、会话编号找会话，可以按任务分组。

import { api } from "./api.js";
import { $, esc, unknown } from "./util.js";
import { freshView, setCrumb, setLangfuse, state } from "./state.js";

// 筛选条件跨页面保留：进一条会话再回来，还是刚才找的那几条。
let filterTask = "全部";
let filterEnd = "全部";
let query = "";
let grouped = false;

function radios(name, values, current) {
  return values.map((value) =>
    `<label><input type="radio" name="${name}" value="${esc(value)}"` +
    `${current === value ? " checked" : ""}> ${esc(value)}</label>`).join("");
}

/** 把搜索词在一段文字里标出来。不区分大小写，只标第一处。 */
function mark(text) {
  const value = String(text || "");
  if (!query) return esc(value);
  const at = value.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return esc(value);
  return esc(value.slice(0, at)) + `<mark>${esc(value.slice(at, at + query.length))}</mark>` +
    esc(value.slice(at + query.length));
}

/** 任务名、会话名、任务编号、会话编号四项里，有一项包含搜索词就算找到。 */
function matches(row) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [row["任务名"], row["会话名"], row["任务编号"], row["会话编号"]]
    .some((value) => String(value || "").toLowerCase().includes(needle));
}

function taskTags(row) {
  if (row["启动失败"]) {
    return `<span class="chip bad">pi 没有启动起来，所以没有任务</span>`;
  }
  if (row["提取出的任务"].length === 0) {
    const note = row["任务对不上的说明"] || "这条会话没有对上任务。";
    const place = row["所在任务目录"] || {};
    return unknown(note) + (place["说明"]
      ? ` <span class="chip domain">任务目录 ${esc(place["任务目录"])}：${esc(place["说明"])}</span>` : "");
  }
  return row["提取出的任务"].map((task) =>
    `<span class="chip domain">领域：${esc(task["任务类型"])} · ${esc(task["状态"])} · ` +
    `任务目录 ${esc(task["任务目录"])} · 已到修订 ${task["修订总数"]}</span>` +
    (task["怎么对上的"] && task["怎么对上的"].includes("归档目录名")
      ? ` <span class="chip warn" title="${esc((row["所在任务目录"] || {})["说明"] || "")}">按归档目录名对上</span>` : ""))
    .join(" ");
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
  const task = row["任务名"]
    ? `<span class="tname">${mark(row["任务名"])}</span>`
    : `<span class="tname none">${row["启动失败"] ? "pi 没有启动起来" : "未对上任务"}</span>`;
  const name = row["会话名"]
    ? `<span class="sname2">${mark(row["会话名"])}</span>`
    : `<span class="sname2 none">${row["启动失败"] ? "没有会话" : "未命名会话"}</span>`;
  const identity = (row["任务编号"] ? `任务编号 ${mark(row["任务编号"])} · ` : "") +
    (row["会话编号"]
      ? `会话编号 <span title="${esc(row["会话编号"])}">${mark(row["会话编号"])}</span>`
      : "这一次没有会话编号，因为 pi 在发出第一条事件之前就退出了") +
    (row["结束时刻"] ? ` · 到 ${esc(row["结束时刻"])} 结束` : "");
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
    row["提取出的任务"].map((t) => `<a href="#/task/${t["任务的键"].split("/").map(encodeURIComponent).join("/")}"` +
      ` onclick="event.stopPropagation()">进入任务页（${esc(t["任务的键"])}）</a>`).join("") +
    (row["提取出的任务"].length ? "" : `<span class="src">${esc((row["任务对不上的说明"] || "这条会话没有对上任务").replace(/。$/, ""))}，所以没有任务页</span>`) + `</div>`;
  return `<div class="sessrow" data-open="${esc(openKey)}">` +
    `<div><div class="stitle">${task}<span class="dot">·</span>${name}<span class="dot">·</span>` +
      `<span class="stime">${esc(row["开始时刻"])}</span></div>` +
      `<div class="src">${identity}</div>` +
      `<div class="src">归档名 ${esc(row["归档名"])} · 归档文件：${esc((row["归档文件"] || []).join("、"))}</div>${failure}</div>` +
    `<div class="src">${row["运行次数"]} 次运行<br>${row["轮数"]} 轮<br>` +
      `${row["模型请求次数"]} 次模型请求<br>${row["工具调用次数"]} 次工具调用<br>` +
      (row["被拒次数"] ? `<span style="color:var(--bad)">${row["被拒次数"]} 次调用被拒</span>`
        : "没有调用被拒") + `</div>` +
    `<div>${ended} ${restart}<div style="margin-top:4px">${taskTags(row)}</div></div>` +
    `<div>${langfuse}${entries}</div></div>`;
}

/** 按任务分组：组头写任务名、任务编号、会话数；没对上任务的归到最后一组。组内与组间都按开始时刻从新到旧。 */
function groupedHtml(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = row["任务编号"] ? `${row["任务名"]}\u0000${row["任务编号"]}` : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  const keys = [...groups.keys()].sort((a, b) => (a === "") - (b === ""));
  return keys.map((key) => {
    const members = groups.get(key);
    const first = members[0];
    const head = key
      ? `<b>${mark(first["任务名"])}</b><span class="src">任务编号 ${mark(first["任务编号"])} · ` +
        `${members.length} 条会话 · 最近一条开始于 ${esc(first["开始时刻"])}</span>`
      : `<b>未对上任务</b><span class="src">这些会话没有对上任何任务，一共 ${members.length} 条</span>`;
    return `<details class="sgroup" open><summary>${head}</summary>${members.map(rowHtml).join("")}</details>`;
  }).join("");
}

function shownRows(all) {
  return all.filter((row) => {
    const hasTask = row["提取出的任务"].length > 0;
    if (filterTask === "有任务" && !hasTask) return false;
    if (filterTask === "没有任务" && hasTask) return false;
    if (filterEnd === "只看正常结束" && (row["启动失败"] || row["终态"] !== "正常结束")) return false;
    if (filterEnd === "只看被中止过的" && !row["终态"].includes("中止")) return false;
    if (filterEnd === "只看 pi 没起来的" && !row["启动失败"]) return false;
    return matches(row);
  }).sort((a, b) => (b["开始秒"] || 0) - (a["开始秒"] || 0));
}

function paintRows(all) {
  const rows = shownRows(all);
  $("#scount").textContent = `一共 ${all.length} 条会话，符合条件的有 ${rows.length} 条，按开始时刻从新到旧排。`;
  $("#srows").innerHTML = (grouped ? groupedHtml(rows) : rows.map(rowHtml).join("")) ||
    `<p class="muted">没有符合当前条件的会话。换个词再找，或者把筛选放宽。</p>`;
}

export async function renderSessions() {
  const view = freshView();
  setCrumb("");
  setLangfuse(state.overview["Langfuse 全部会话"], "到 Langfuse 看全部会话");
  view.innerHTML = `<section class="panel"><p class="muted">正在读会话列表。</p></section>`;

  const all = (await api.sessions())["会话"];

  view.innerHTML =
    `<section class="panel"><h2>会话列表</h2>` +
      `<p class="muted" style="margin:0 0 10px">一行是一条 pi 会话（session）。行标题是「任务名 · 会话名 · 开始时刻」：` +
      `任务名取自会话所在任务目录里的任务数据库，会话名是用户在产品网页里给会话起的名字` +
      `（记在 pi 会话文件的 session_info 里，没有起名字时显示「未命名会话」）。` +
      `产品后端起的会话归档名一律是 service，所以归档名放在小字那一行，区分会话请看任务名与会话名。` +
      `每条会话里有若干次<b>运行</b>（agent run，由用户的一句话触发），每次运行里有若干<b>轮</b>（turn），` +
      `含义见<a href="#/concepts">概念对照</a>那一页。` +
      `会话在哪个任务目录里跑，就属于那个目录里的那个任务；会话文件不在归档里时，按归档目录名去对任务目录名。点一行进入会话详情。</p>` +
      `<div class="filters"><input type="search" id="squery" placeholder="按任务名、会话名、任务编号或会话编号找会话"` +
        ` aria-label="找会话" value="${esc(query)}">` +
        `<label><input type="checkbox" id="sgroup"${grouped ? " checked" : ""}> 按任务分组</label></div>` +
      `<div class="filters"><span class="muted">按有没有对上任务筛选：</span>` +
        radios("ft", ["全部", "有任务", "没有任务"], filterTask) +
        `<span class="sep"></span><span class="muted">按结局筛选：</span>` +
        radios("fe", ["全部", "只看正常结束", "只看被中止过的", "只看 pi 没起来的"], filterEnd) +
      `</div>` +
      `<p class="src">归档目录是 ${esc(state.overview["归档目录"])}；` +
      `任务目录从 ${esc(state.overview["任务目录所在目录"])} 下面扫出来，一共 ` +
      `${state.overview["任务目录数"]} 个。</p>` +
      `<p class="muted" id="scount"></p>` +
      `<div id="srows"></div></section>`;
  paintRows(all);

  // 输入时只重画列表，不重画搜索框，免得光标跳走。
  $("#squery").addEventListener("input", (event) => { query = event.target.value.trim(); paintRows(all); });
  $("#sgroup").addEventListener("change", (event) => { grouped = event.target.checked; paintRows(all); });
  view.addEventListener("change", (event) => {
    if (event.target.name === "ft") { filterTask = event.target.value; paintRows(all); }
    if (event.target.name === "fe") { filterEnd = event.target.value; paintRows(all); }
  });
  $("#srows").addEventListener("click", (event) => {
    if (event.target.closest("summary")) return;
    const row = event.target.closest(".sessrow");
    if (row && row.dataset.open) location.hash = `#/session/${encodeURIComponent(row.dataset.open)}`;
  });
}
