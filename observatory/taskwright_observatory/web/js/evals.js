// 页面：评测。模拟器的评测命令（sim/evals.py）把同一份画像接连演练几遍，每遍算灯与「至少应有」清单；
// 这里只显示它写在演练根目录下的结果，不重算。三个页面：评测列表、一次评测的详情、两次评测的对照。
// 「灯」是工作的每个阶段「算够」的一条判据，由程序从任务数据算出来；「至少应有」是每份材料一张的下限清单。
// 「提示词版本」说明助手那一次用的是哪一版说明文件，由后端启动助手时记下的每份文件的摘要值算出，任何一份文件变了版本都不同。

import { api } from "./api.js";
import { esc } from "./util.js";
import { freshView, setCrumb, setLangfuse } from "./state.js";

const enc = encodeURIComponent;
const evalLink = (label) => `#/evals/${enc(label)}`;
const taskLink = (key) => `#/task/${key.split("/").map(enc).join("/")}`;
const percent = (rate) => (rate == null ? "没有能算的" : `${Math.round(rate * 100)}%`);
const shortCommit = (id) => (id ? id.slice(0, 12) : "没有记");
const promptVersion = (id) => id || "没有记";
const when = (text) => (text || "").replace("T", " ");
const groupLabel = (words) => words.join("／");
/** 清单里一行给人看的「部分」：「模型」一节的「部分」写的是图的种类的键，给人看的名字在「部分名」里。 */
const sectionLabel = (row) => row["部分名"] || row["部分"];

/** 一遍里一盏灯的结果用哪种样式：通过是绿的，未通过是红的，不适用与算不了是灰的。 */
const STATE_CLASS = { "通过": "good", "未通过": "bad" };

function took(seconds) {
  return seconds == null ? "没有记" : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/**
 * 同一个阶段的几盏灯，阶段名只在第一行写，占满这一组的行；阶段名下面写这一组的通过率。
 * notes 是每个阶段要写的那一行（已经是 HTML），没有的阶段只写名字。键在灯表里找不到阶段的灯在「其他」一组，排在最后。
 */
function stageCells(rows, notes = {}) {
  const span = {};
  rows.forEach((row) => { span[row["阶段"]] = (span[row["阶段"]] || 0) + 1; });
  let last = null;
  return rows.map((row) => {
    const first = row["阶段"] !== last;
    last = row["阶段"];
    return first ? `<td rowspan="${span[row["阶段"]]}"><b>${esc(row["阶段"])}</b>${notes[row["阶段"]] || ""}</td>` : "";
  });
}

/** 详情页：每个阶段的本组通过率（这一组各盏灯通过率的平均）。 */
function stageRates(groups) {
  const notes = {};
  (groups || []).forEach((one) => { notes[one["阶段"]] = `<div class="src">本组通过率 ${esc(percent(one["通过率"]))}</div>`; });
  return notes;
}

/** 对照页：每个阶段前后两次的本组通过率与差值，变差的标出来。 */
function stageDeltas(groups) {
  const notes = {};
  const rate = (side) => (side == null ? "没有这一组" : percent(side["比率"]));
  (groups || []).forEach((one) => {
    const points = one["差值"] == null ? null : Math.round(one["差值"] * 100);
    const change = points == null ? "不比" : points === 0 ? "持平" : `${points > 0 ? "+" : "−"}${Math.abs(points)} 个百分点`;
    notes[one["阶段"]] = `<div class="src">本组通过率：前 ${esc(rate(one["前"]))}，后 ${esc(rate(one["后"]))}</div>` +
      `<div class="${one["变差"] ? "evworse" : "src"}">${esc(change)}${one["变差"] ? "，变差" : ""}</div>`;
  });
  return notes;
}

function noRoot(view, data) {
  view.innerHTML = `<section class="panel"><h2>评测</h2><p class="muted">${esc(data["说明"])}</p>` +
    `<p class="muted">启动观测台时加上 <code>--sim-root &lt;演练根目录&gt;</code>，就能在这里看评测，各遍演练的任务与会话也会收进来。</p></section>`;
}

// ───────────── 评测列表 ─────────────

export async function renderEvalList() {
  const view = freshView();
  setCrumb("");
  setLangfuse("");
  view.innerHTML = `<section class="panel"><p class="muted">正在读评测列表。</p></section>`;
  const data = await api.evals();
  if (!data["有没有演练根目录"]) return noRoot(view, data);
  const rows = data["评测"];
  const body = rows.map((row) => `<tr>` +
    `<td><input type="checkbox" class="evpick" value="${esc(row["标签"])}" aria-label="选中评测 ${esc(row["标签"])} 用来对照"></td>` +
    `<td>${esc(when(row["时间"]))}</td>` +
    `<td><a href="${evalLink(row["标签"])}">${esc(row["标签"])}</a></td>` +
    `<td class="mono">${esc(shortCommit(row["提交号"]))}${row["未提交的改动"] ? `<br><span class="src">另有未提交的改动</span>` : ""}</td>` +
    `<td class="mono">${esc(promptVersion(row["提示词版本"]))}</td>` +
    `<td>${esc(row["模型"] || "没有记")}</td>` +
    `<td>${esc((row["材料"] || []).join("、"))}</td>` +
    `<td>${esc(row["遍数"])}</td>` +
    `<td>${esc(percent(row["灯通过率"]))}</td>` +
    `<td>${esc(percent(row["清单命中率"]))}</td></tr>`).join("");
  view.innerHTML = `<section class="panel"><h2>评测列表</h2>` +
    `<p class="muted" style="margin:0 0 10px">一行是一次评测：同一份画像接连演练几遍，每遍按演练结束时的任务数据算灯与「至少应有」清单。` +
    `灯通过率是各盏灯通过率的平均，清单命中率是命中的组数比上组数。提示词版本说明助手用的是哪一版说明文件，两次的版本不同就是说明改过。` +
    `点标签看这一次的详情；勾选两行再点「对照选中的两次」看两次的差别。` +
    `评测结果读自 ${esc(data["演练根目录"])}。</p>` +
    (rows.length
      ? `<div class="filters"><button type="button" id="evcompare" disabled>对照选中的两次</button>` +
        `<span class="muted" id="evhint">请勾选两次评测。</span></div>` +
        `<table class="tbl"><colgroup><col style="width:4em"><col style="width:11em"><col style="width:auto"><col style="width:9em"><col style="width:9em">` +
        `<col style="width:12em"><col style="width:14em"><col style="width:4em"><col style="width:7em"><col style="width:7em"></colgroup>` +
        `<thead><tr><th>对照</th><th>时间</th><th>标签</th><th>代码提交号</th><th>提示词版本</th><th>助手的模型</th><th>材料</th><th>遍数</th>` +
        `<th>灯通过率</th><th>清单命中率</th></tr></thead><tbody>${body}</tbody></table>`
      : `<p class="muted">这个演练根目录下还没有评测。用 <code>python3 -m sim.evals run</code> 跑一次，结果就会出现在这里。</p>`) +
    `</section>`;
  const button = view.querySelector("#evcompare");
  if (!button) return;
  const picked = () => [...view.querySelectorAll(".evpick:checked")].map((box) => box.value);
  view.addEventListener("change", () => {
    const count = picked().length;
    button.disabled = count !== 2;
    view.querySelector("#evhint").textContent = count === 2 ? "" : `请勾选两次评测，现在勾选了 ${count} 次。`;
  });
  button.addEventListener("click", () => {
    // 时间早的那一次放在前面；列表是新的在前，所以把勾选的两个倒过来。
    const [later, earlier] = picked();
    location.hash = `#/evals/compare/${enc(earlier)}/${enc(later)}`;
  });
}

// ───────────── 一次评测的详情 ─────────────

/** 提示词的每份文件：路径、在代码仓里还是在任务目录里、字节数、摘要值。 */
function promptFiles(files) {
  return `<table class="tbl"><colgroup><col style="width:auto"><col style="width:7em"><col style="width:7em"><col style="width:12em"></colgroup>` +
    `<thead><tr><th>文件</th><th>在哪里</th><th>字节数</th><th>摘要值</th></tr></thead><tbody>` +
    files.map((one) => `<tr><td class="mono">${esc(one["路径"])}</td><td>${esc(one["来自"] || "")}</td><td>${esc(one["字节数"] ?? "")}</td>` +
      `<td class="mono">${esc(one["摘要值"] || "")}</td></tr>`).join("") + `</tbody></table>`;
}

/** 详情页页头里的提示词版本：版本、几份文件，点开看每份；取不到时写原因；几遍用的版本不一样时写明。 */
function promptCell(s) {
  const files = s["提示词文件"] || [];
  if (!s["提示词版本"]) return `<span class="muted">${esc(s["提示词说明"] || "没有记")}</span>`;
  const each = (s["各遍提示词版本"] || []).filter(Boolean);
  const mixed = new Set(each).size > 1
    ? `<div class="miss">各遍用的提示词版本不一样（跑到一半有文件改过）：${esc((s["各遍提示词版本"] || []).map((one, n) => `第 ${n + 1} 遍 ${one || "取不到"}`).join("、"))}。` +
      `下面列的是第一份取得到的那一遍的文件。</div>` : "";
  return `<span class="mono">${esc(s["提示词版本"])}</span>，由 ${files.length} 份说明文件的摘要值算出${mixed}` +
    `<details><summary>看这 ${files.length} 份文件</summary>${promptFiles(files)}</details>`;
}

function headKv(s) {
  return `<dl class="kv">` +
    `<dt>时间</dt><dd>${esc(when(s["时间"]))}</dd>` +
    `<dt>代码提交号</dt><dd class="mono">${esc(shortCommit(s["提交号"]))}${s["未提交的改动"] ? `（另有 ${esc(s["未提交的改动"])} 个文件有未提交的改动）` : ""}</dd>` +
    `<dt>提示词版本</dt><dd>${promptCell(s)}</dd>` +
    `<dt>助手的模型</dt><dd>${esc(s["模型"] || "没有记")}</dd>` +
    `<dt>模拟用户的模型</dt><dd>${esc(s["模拟用户的模型"] || "没有记")}</dd>` +
    `<dt>材料</dt><dd>${esc((s["材料"] || []).join("、"))}</dd>` +
    `<dt>画像与清单</dt><dd>${esc(s["画像"])}，${esc(s["清单"])}</dd>` +
    `<dt>遍数</dt><dd>${esc(s["遍数"])} 遍，每遍最多 ${esc(s["轮数上限"])} 轮</dd>` +
    `<dt>灯通过率</dt><dd>${esc(percent(s["灯通过率"]))}</dd>` +
    `<dt>清单命中率</dt><dd>${esc(percent(s["清单命中率"]))}</dd></dl>`;
}

/** 一格：结果是一个链接，点了到观测台里那一遍演练的任务页；没有任务（那一遍没有跑完）时只写字。 */
function passCell(run, text, klass, detail) {
  const chip = `<span class="chip ${klass || ""}">${esc(text)}</span>`;
  return `<td>${run["任务的键"] ? `<a class="evcell" href="${taskLink(run["任务的键"])}" title="到这一遍演练的任务页">${chip}</a>` : chip}` +
    (detail ? `<div class="src">${esc(detail)}</div>` : "") + `</td>`;
}

function runsTable(s) {
  return `<table class="tbl"><colgroup><col style="width:5em"><col style="width:7em"><col style="width:auto"><col style="width:5em">` +
    `<col style="width:9em"><col style="width:auto"></colgroup>` +
    `<thead><tr><th>遍</th><th>演练</th><th>停止原因</th><th>轮数</th><th>用时</th><th>出错</th></tr></thead><tbody>` +
    s["各遍"].map((run, n) => `<tr><td>第 ${n + 1} 遍</td>` +
      `<td>${run["任务的键"] ? `<a href="${taskLink(run["任务的键"])}">${esc(run["演练"])}</a>` : esc(run["演练"])}</td>` +
      `<td>${esc(run["停止原因"] || "")}</td><td>${esc(run["轮数"])}</td><td>${esc(took(run["用时秒"]))}</td>` +
      `<td>${esc(run["出错"] || "没有")}</td></tr>`).join("") + `</tbody></table>`;
}

function passHeads(s) {
  return s["各遍"].map((_run, n) => `<th>第 ${n + 1} 遍</th>`).join("");
}

function passCols(s) {
  return s["各遍"].map(() => `<col style="width:9em">`).join("");
}

function lampTable(s) {
  const stages = stageCells(s["灯"], stageRates(s["灯按阶段"]));
  return `<table class="tbl"><colgroup><col style="width:9em"><col style="width:auto">${passCols(s)}<col style="width:6em"></colgroup>` +
    `<thead><tr><th>阶段</th><th>灯</th>${passHeads(s)}<th>通过几遍</th></tr></thead><tbody>` +
    s["灯"].map((row, i) => `<tr>${stages[i]}<td>${esc(row["说明"])}</td>` +
      row["各遍"].map((state, n) => {
        const missing = row["各遍差的"][n] || [];
        const detail = missing.length ? `差 ${missing.join("、")}` : (state === "通过" ? "" : row["各遍备注"][n]);
        return passCell(s["各遍"][n], state, STATE_CLASS[state], detail);
      }).join("") +
      `<td>${row["通过遍数"]}／${row["能算的遍数"]}</td></tr>`).join("") + `</tbody></table>`;
}

function groupTable(s) {
  if (!s["至少应有"].length) return `<p class="muted">这次评测没有核对清单：没有给清单，或者每一遍都没有跑完。</p>`;
  return `<table class="tbl"><colgroup><col style="width:11em"><col style="width:auto">${passCols(s)}<col style="width:6em"></colgroup>` +
    `<thead><tr><th>部分</th><th>关键词组</th>${passHeads(s)}<th>命中几遍</th></tr></thead><tbody>` +
    s["至少应有"].map((row) => `<tr><td>${esc(sectionLabel(row))}</td><td>${esc(groupLabel(row["组"]))}</td>` +
      row["各遍"].map((hit, n) => {
        if (hit == null) return passCell(s["各遍"][n], "没有核对", "", "");
        const ids = row["各遍命中的条目"][n] || [];
        // 「例外」一节只认以「例外：」开头的例子：没有命中而别的例子里提到了的，写出是哪几页。
        // 早先的评测按全部例子找，那时的结果文件带的是「各遍以例外开头」，照原样显示。
        const elsewhere = (row["各遍只在别的例子里提到的页"] || [])[n] || [];
        const prefixed = (row["各遍以例外开头"] || [])[n];
        const detail = [ids.join("、"), !hit && elsewhere.length ? `${elsewhere.join("、")} 的例子里提到了，但不以「例外：」开头` : "",
          prefixed === false && hit ? "例子不以「例外：」开头" : ""].filter(Boolean).join("；");
        return passCell(s["各遍"][n], hit ? "命中" : "没有", hit ? "good" : "bad", detail);
      }).join("") +
      `<td>${row["命中遍数"]}／${row["核对的遍数"]}</td></tr>`).join("") + `</tbody></table>`;
}

function askedSection(s) {
  return s["各遍的问题"].map((one, n) => `<h3 class="gap">第 ${n + 1} 遍（${esc(one["演练"])}）</h3>` +
    (one["问题"].length
      ? `<ul class="list">${one["问题"].map((q) => `<li><span class="chip">${q["轮"] == null ? "轮次对不上" : `第 ${esc(q["轮"])} 轮`}</span> ` +
        `<span class="chip domain">${esc(q["功能"])}</span> ${esc(q["文字"])}` +
        ((q["选项"] || []).length ? `<div class="src">选项：${esc(q["选项"].join("；"))}</div>` : "") + `</li>`).join("")}</ul>`
      : `<p class="muted">这一遍助手没有向用户要过回应。</p>`)).join("");
}

function stuckItem(x, known) {
  const asked = x["上一轮的问题"].map((q) => q["文字"]).join("；") || "上一轮助手没有提问。";
  const facts = x["画像里可能有的事实"].map((fact) => fact.replace(/。$/, "")).join("；");
  return `<li><span class="chip">第 ${esc(x["轮"])} 轮</span> 模拟用户说：「${esc(x["用户 agent 的话"])}」` +
    `<div>上一轮的问题：${esc(asked)}</div>` +
    (known ? `<div class="miss">画像里可能已有这件事：${esc(facts)}。请看是不是模拟用户演错了。</div>` : "") + `</li>`;
}

function stuckSection(s) {
  return s["各遍答不上的"].map((one, n) => {
    const items = [...one["待人答"].map((x) => stuckItem(x, false)), ...one["画像里可能已有"].map((x) => stuckItem(x, true))];
    return `<h3 class="gap">第 ${n + 1} 遍（${esc(one["演练"])}）</h3>` +
      (items.length ? `<ul class="list">${items.join("")}</ul>` : `<p class="muted">这一遍没有。</p>`);
  }).join("");
}

export async function renderEvalDetail(label) {
  const view = freshView();
  setLangfuse("");
  setCrumb(`<a href="#/evals">评测</a> › ${esc(label)}`);
  view.innerHTML = `<section class="panel"><p class="muted">正在读这次评测。</p></section>`;
  const s = await api.evalDetail(label);
  view.innerHTML =
    `<section class="panel"><h2>评测详情：${esc(s["标签"])}</h2>${headKv(s)}</section>` +
    `<section class="panel"><h2>各遍</h2>${runsTable(s)}</section>` +
    `<section class="panel"><h2>灯</h2><p class="muted" style="margin:0 0 10px">每盏灯是这一段「算够」的一条判据，按演练结束时的任务数据算，` +
    `告诉你这一段还差什么。「不适用」是这盏灯要看的那一类页或条目一个都没有，「算不了」是要用的数据取不到，这两种不计入通过率。` +
    `阶段名下面是这一组的通过率，即这一组各盏灯通过率的平均。` +
    `点一格到那一遍演练的任务页。</p>${lampTable(s)}</section>` +
    `<section class="panel"><h2>至少应有</h2><p class="muted" style="margin:0 0 10px">清单是下限：这份材料读透了至少应当整理出这些。` +
    `一组里是同义的几种写法，出现一种就算命中。</p>${groupTable(s)}</section>` +
    `<section class="panel"><h2>助手问过的问题</h2><p class="muted" style="margin:0">助手每一轮向用户要回应的行为（提问、请确认、给建议值、请选择、提议），按遍按轮列出。</p>` +
    `${askedSection(s)}</section>` +
    `<section class="panel"><h2>模拟用户答不上的问题</h2><p class="muted" style="margin:0">模拟用户的话里出现了「不知道」「要问一下」一类说法时，` +
    `把上一轮助手问的问题列在这里，请人过目：画像里确实没有这件事的，可以补进画像文件再重新评测。这是按说法挑出来的清单，不是结论。</p>` +
    `${stuckSection(s)}</section>`;
}

// ───────────── 两次评测的对照 ─────────────

function side(one) {
  if (one == null) return `<td class="muted">没有这一项</td>`;
  return `<td>${one["分子"]}／${one["分母"]}${one["比率"] == null ? "" : `（${percent(one["比率"])}）`}</td>`;
}

function delta(row) {
  if (row["差值"] == null) return `<td class="muted">不比</td>`;
  const points = Math.round(row["差值"] * 100);
  const text = points === 0 ? "持平" : `${points > 0 ? "+" : "−"}${Math.abs(points)} 个百分点`;
  return row["变差"] ? `<td class="evworse">${esc(text)}，变差</td>` : `<td>${esc(text)}</td>`;
}

function compareHead(one, title) {
  return `<dt>${esc(title)}</dt><dd><a href="${evalLink(one["标签"])}">${esc(one["标签"])}</a>，${esc(when(one["时间"]))}，` +
    `提交 <span class="mono">${esc(shortCommit(one["提交号"]))}</span>，提示词版本 <span class="mono">${esc(promptVersion(one["提示词版本"]))}</span>，${esc(one["遍数"])} 遍；` +
    `灯通过率 ${esc(percent(one["灯通过率"]))}，清单命中率 ${esc(percent(one["清单命中率"]))}</dd>`;
}

/** 对照页的「提示词」一节：两次的版本是不是相同；不同时逐份列出改了的、后一次多出来的、后一次没有的。 */
function promptCompare(data) {
  const prompts = data["提示词"], a = data["前"], b = data["后"];
  const changed = prompts["变了的文件"] || [];
  const digest = (value) => (value ? `<td class="mono">${esc(value)}</td>` : `<td class="muted">没有</td>`);
  return `<section class="panel"><h2>提示词</h2>` +
    `<p class="${prompts["相同"] == null ? "miss" : prompts["相同"] ? "muted" : ""}" style="margin:0 0 10px">${esc(prompts["说明"])}</p>` +
    (changed.length
      ? `<table class="tbl"><colgroup><col style="width:auto"><col style="width:7em"><col style="width:10em"><col style="width:12em"><col style="width:12em"></colgroup>` +
        `<thead><tr><th>文件</th><th>在哪里</th><th>怎样变</th><th>${esc(a["标签"])} 的摘要值</th><th>${esc(b["标签"])} 的摘要值</th></tr></thead><tbody>` +
        changed.map((one) => `<tr><td class="mono">${esc(one["路径"])}</td><td>${esc(one["来自"])}</td><td>${esc(one["怎样变"])}</td>` +
          `${digest(one["前"])}${digest(one["后"])}</tr>`).join("") + `</tbody></table>`
      : "") + `</section>`;
}

export async function renderEvalCompare(first, second) {
  const view = freshView();
  setLangfuse("");
  setCrumb(`<a href="#/evals">评测</a> › 对照`);
  view.innerHTML = `<section class="panel"><p class="muted">正在读这两次评测。</p></section>`;
  const data = await api.evalCompare(first, second);
  const a = data["前"], b = data["后"];
  const stages = stageCells(data["灯"], stageDeltas(data["灯按阶段"]));
  const cols = `<col style="width:9em"><col style="width:9em"><col style="width:12em">`;
  view.innerHTML =
    `<section class="panel"><h2>评测对照</h2><dl class="kv">${compareHead(a, "前一次")}${compareHead(b, "后一次")}` +
    `<dt>变差的</dt><dd>灯有 ${esc(data["变差的灯"])} 盏变差，清单里有 ${esc(data["变差的组"])} 组变差。差值是后一次减前一次；有一边没有能算的遍时不比。</dd></dl>` +
    data["提醒"].map((note) => `<p class="miss">${esc(note)}</p>`).join("") + `</section>` +
    promptCompare(data) +
    `<section class="panel"><h2>灯</h2><p class="muted" style="margin:0 0 10px">每格是「通过的遍数／能算的遍数」。` +
    `阶段名下面是这一组前后两次的通过率（这一组各盏灯通过率的平均）。</p>` +
    `<table class="tbl"><colgroup><col style="width:13em"><col style="width:auto">${cols}</colgroup>` +
    `<thead><tr><th>阶段</th><th>灯</th><th>${esc(a["标签"])}</th><th>${esc(b["标签"])}</th><th>差值</th></tr></thead><tbody>` +
    data["灯"].map((row, i) => `<tr>${stages[i]}<td>${esc(row["说明"])}</td>${side(row["前"])}${side(row["后"])}${delta(row)}</tr>`).join("") +
    `</tbody></table></section>` +
    `<section class="panel"><h2>至少应有</h2><p class="muted" style="margin:0 0 10px">每格是「命中的遍数／核对的遍数」。</p>` +
    (data["至少应有"].length
      ? `<table class="tbl"><colgroup><col style="width:11em"><col style="width:auto">${cols}</colgroup>` +
        `<thead><tr><th>部分</th><th>关键词组</th><th>${esc(a["标签"])}</th><th>${esc(b["标签"])}</th><th>差值</th></tr></thead><tbody>` +
        data["至少应有"].map((row) => `<tr><td>${esc(sectionLabel(row))}</td><td>${esc(groupLabel(row["组"]))}</td>` +
          `${side(row["前"])}${side(row["后"])}${delta(row)}</tr>`).join("") + `</tbody></table>`
      : `<p class="muted">两次评测都没有核对清单。</p>`) + `</section>`;
}
