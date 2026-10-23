// 打开数据包（--pack）时首页顶部的一块：包头各项、包里的后端日志与设置摘录。没有打开包时不显示。

import { $, esc } from "./util.js";

async function getJson(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  const value = await response.json();
  if (!response.ok) throw new Error(value["出错了"] || `读取接口 ${path} 回了 ${response.status}`);
  return value;
}

function headerRows(head) {
  const rows = [
    ["用途", head.用途], ["粒度", head.粒度], ["任务编号", head.任务编号 || "（清单里没有）"],
    ["会话编号", head.会话编号 || "按任务实例导出，不限一条会话"], ["导出时刻", head.导出时刻],
    ["产品版本", head.产品版本], ["包格式", head.包格式], ["任务库格式", head.任务库格式],
    ["模型", head.模型 || "（没有记）"], ["日志范围", head.日志范围],
    ["包文件", head.包文件], ["解到", head.解到],
  ].filter(([, value]) => value !== "" && value !== undefined && value !== null);
  return rows.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${esc(value)}</dd>`).join("");
}

/** 一份日志的全文，左边带行号；每行有锚点，可以按行号跳。 */
function logHtml(name, text) {
  const lines = text.replace(/\n$/, "").split("\n");
  return `<div class="filters"><b>${esc(name)}</b><span class="muted">${lines.length} 行</span>` +
    `<label>跳到第 <input type="number" min="1" max="${lines.length}" id="logLine" style="width:6em"> 行</label></div>` +
    `<pre class="args packlog">${lines.map((line, i) =>
      `<span id="log-${i + 1}"><span class="ln">${i + 1}</span>${esc(line)}</span>`).join("\n")}</pre>`;
}

/** 首页顶部显示包头；格式过新时返回 false，调用方不再读别的数据。 */
export async function renderPack(overview) {
  const head = overview && overview["诊断包"];
  const box = $("#pack");
  if (!head) { box.hidden = true; return true; }
  box.hidden = false;
  const title = head.是不是诊断包 ? "诊断包" : "数据包";
  if (head.格式过新) {
    box.innerHTML = `<section class="panel"><h2>${title}</h2><p class="warn">${esc(head.格式过新)}包里的数据没有解析。</p>` +
      `<dl class="kv">${headerRows(head)}</dl></section>`;
    return false;
  }
  box.innerHTML = `<section class="panel" data-testid="pack-head"><h2>${title}</h2>` +
    (head.带没带事件归档 ? "" : `<p class="muted">这个包没有带事件归档：会话只看得到会话文件里的消息，处写「没有事件归档」。</p>`) +
    `<dl class="kv">${headerRows(head)}</dl>` +
    `<details id="packLogs"><summary>后端日志</summary><div id="packLogList" class="muted">正在读。</div><div id="packLogText"></div></details>` +
    `<details id="packSettings"><summary>设置摘录</summary><div id="packSettingsBody" class="muted">正在读。</div></details>` +
    `</section>`;
  $("#packLogs").addEventListener("toggle", async () => {
    if (!$("#packLogs").open || $("#packLogList").dataset.done) return;
    const rows = (await getJson("/api/pack/logs"))["日志"];
    $("#packLogList").dataset.done = "1";
    $("#packLogList").innerHTML = rows.length
      ? `<ul>${rows.map((r) => `<li><a href="#" data-log="${esc(r.文件)}">${esc(r.文件)}</a>（${r.行数} 行，${r.字节数} 字节）</li>`).join("")}</ul>`
      : "包里没有后端日志。";
  });
  $("#packLogList").addEventListener("click", async (event) => {
    const link = event.target.closest("a[data-log]");
    if (!link) return;
    event.preventDefault();
    const one = await getJson(`/api/pack/logs/${encodeURIComponent(link.dataset.log)}`);
    $("#packLogText").innerHTML = logHtml(one.文件, one.全文);
    $("#logLine").addEventListener("change", (e) => {
      const target = document.getElementById(`log-${e.target.value}`);
      if (target) { target.scrollIntoView({ block: "center" }); target.classList.add("hit"); }
    });
  });
  $("#packSettings").addEventListener("toggle", async () => {
    if (!$("#packSettings").open || $("#packSettingsBody").dataset.done) return;
    const value = (await getJson("/api/pack/settings"))["设置摘录"];
    $("#packSettingsBody").dataset.done = "1";
    $("#packSettingsBody").innerHTML = !value ? "包里没有设置摘录。"
      : `<pre class="args">${esc(value.内容 !== undefined ? JSON.stringify(value.内容, null, 2) : value.原文)}</pre>`;
  });
  return true;
}
