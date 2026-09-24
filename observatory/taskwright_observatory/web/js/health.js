// 页面四：系统健康。核对托着执行者跑起来的那一层是不是正常工作，与任务内容无关。
// 取不到依据的项一律显示「未知」，并写清楚缺的是哪一条事实、建议由谁去补记。

import { api } from "./api.js";
import { $, esc, shortId } from "./util.js";
import { freshView, setCrumb, setLangfuse, state } from "./state.js";

let scope = "all";

const TONE = {
  "正常": ["ok", "✓ 正常"],
  "要注意": ["warn", "! 要注意"],
  "不正常": ["err", "✗ 不正常"],
  "未知": ["unk", "? 未知"],
};

function itemHtml(item) {
  const [klass, label] = TONE[item["结论"]] || TONE["未知"];
  return `<div class="hitem"><span class="stat ${klass}">${esc(label)}</span>` +
    `<span><b>${esc(item["检查项"])}</b><br>${esc(item["说明"])}<br>` +
    ((item["明细"] || []).length
      ? `<ul class="list" style="margin:4px 0">` +
        item["明细"].map((line) => `<li class="src">${esc(line)}</li>`).join("") + `</ul>`
      : "") +
    `<span class="src">依据：${esc(item["来源"] || "没有写来源")}</span>` +
    (item["缺什么"] ? `<span class="miss">缺什么：${esc(item["缺什么"])}</span>` : "") +
    `</span></div>`;
}

function gateTable(gate) {
  const rows = gate["行"];
  if (!rows.length) {
    return `<p class="muted">当前范围里一次调用也没有被拒过，所以这张表是空的。</p>`;
  }
  return `<table class="tbl"><colgroup><col style="width:auto"><col style="width:7em">` +
    `<col style="width:9em"><col style="width:12em"></colgroup>` +
    `<thead><tr><th>拒绝原因（工具返回的原文）</th><th>发生次数</th><th>其后改正成功</th>` +
    `<th>发生在哪几条会话</th></tr></thead><tbody>` +
    rows.map((row) => `<tr><td>${esc(row["拒绝原因原文"])}</td>` +
      `<td>这条原因一共出现了 ${row["发生次数"]} 次。</td>` +
      `<td>其中 ${row["其后改正成功次数"]} 次后来改过来了。</td>` +
      `<td>${row["涉及会话"].map((id) =>
        `<a href="#/session/${encodeURIComponent(id)}">${esc(shortId(id))}</a>`).join("、")}</td>` +
      `</tr>`).join("") + `</tbody></table>`;
}

export async function renderHealth() {
  const view = freshView();
  setCrumb("");
  setLangfuse(state.overview["Langfuse 全部会话"], "到 Langfuse 看全部会话");
  view.innerHTML = `<section class="panel"><p class="muted">正在核对。</p></section>`;

  const options = (await api.sessionOptions())["会话"];
  const data = await api.health(scope);
  const counts = data["统计"];

  const chooser = `<select id="hscope"><option value="all"` +
    `${scope === "all" ? " selected" : ""}>全部会话</option>` +
    options.filter((one) => one["会话编号"]).map((one) =>
      `<option value="${esc(one["会话编号"])}"${scope === one["会话编号"] ? " selected" : ""}>` +
      `只看会话「${esc(one["名字"])}」${esc(one["开始时刻"])} 这一次` +
      `${one["启动失败"] ? "（pi 没有启动起来）" : ""}` +
      `</option>`).join("") + `</select>`;

  const groups = data["分组"].map((group) =>
    `<section class="panel"><h2>${esc(group["标题"])}</h2>` +
    group["项"].map(itemHtml).join("") + `</section>`);

  view.innerHTML =
    `<section class="panel"><h2>范围</h2><div class="filters">` +
      `<span class="muted">看哪些会话：</span>${chooser}` +
      `<span class="muted">现在看的是：${esc(data["范围"])}</span></div>` +
      `<p class="muted" style="margin:6px 0 0">这一页核对的是托着助手跑起来的这一套系统本身是不是正常工作，` +
      `与任务内容无关。这一层包括启动 pi、装扩展、转话、归档、` +
      `看护的那些代码。</p>` +
      `<p class="src">当前范围里：会话 ${counts["会话数"]} 条，` +
      `pi 进程启动 ${counts["pi 进程启动次数"]} 次，运行 ${counts["运行次数"]} 次，` +
      `轮 ${counts["轮数"]} 轮，模型请求 ${counts["模型请求次数"]} 次，` +
      `工具调用 ${counts["工具调用次数"]} 次，其中被拒 ${counts["被拒次数"]} 次；` +
      `最早的一次是 ${esc(counts["最早一次"] || "未知")}。` +
      `不变式核对只核对这些会话真的写过的 ${data["核对了几个任务目录"]} 个任务目录` +
      (data["没有核对的任务目录"].length
        ? `；另外 ${data["没有核对的任务目录"].length} 个任务目录没有被这些会话碰过，不在范围内。`
        : `。`) + `</p></section>` +
    `<div class="hgrid">${groups[0]}${groups[1]}</div>` +
    `<section class="panel"><h2>三、门禁统计</h2>` +
      `<p class="muted" style="margin:0 0 8px">${esc(data["门禁"]["说明"])}</p>` +
      gateTable(data["门禁"]) + `</section>` +
    `<div class="hgrid">${groups[2]}${groups[3]}</div>`;

  $("#hscope").addEventListener("change", (event) => {
    scope = event.target.value;
    renderHealth();
  });
}
