// 页面五：概念对照。观测台上每个词到底指什么、出处在哪里。
// 属于 pi 的概念用 pi 的名字与定义并附官方原句；不属于 pi 的标明它是领域概念还是后端概念。

import { api } from "./api.js";
import { esc } from "./util.js";
import { freshView, setCrumb, setLangfuse } from "./state.js";

function piTable(rows) {
  return rows.map((row) => `<section class="panel conceptcard">` +
    `<h3>${esc(row["观测台的叫法"])} <span class="chip pi">pi 的概念：` +
    `${esc(row["pi 的名字"])}</span></h3>` +
    `<dl class="kv">` +
    `<dt>一句话解释</dt><dd>${esc(row["一句话解释"])}</dd>` +
    `<dt>官方定义原句</dt><dd class="mono">${esc(row["官方原句"])}</dd>` +
    `<dt>中文翻译</dt><dd>${esc(row["中文翻译"])}</dd>` +
    `<dt>出处</dt><dd class="mono">${esc(row["出处"])}</dd>` +
    `<dt>观测台在哪里用到</dt><dd>${esc(row["观测台在哪里用到"])}</dd>` +
    `</dl></section>`).join("");
}

function smallTable(rows, columns) {
  return `<table class="tbl"><thead><tr>` +
    columns.map((name) => `<th>${esc(name)}</th>`).join("") +
    `</tr></thead><tbody>` +
    rows.map((row) => `<tr>` +
      columns.map((name) => `<td>${esc(row[name])}</td>`).join("") + `</tr>`).join("") +
    `</tbody></table>`;
}

export async function renderConcepts() {
  const view = freshView();
  setCrumb("");
  setLangfuse("", "");
  view.innerHTML = `<section class="panel"><p class="muted">正在读概念对照。</p></section>`;
  const data = await api.concepts();

  view.innerHTML =
    `<section class="panel"><h2>概念对照</h2>` +
      `<p class="muted" style="margin:0">${esc(data["说明"])}</p>` +
      `<p class="src">核对行号时用的 pi 版本是 ${esc(data["pi 版本"])}，` +
      `文档路径是 pi 源码里的 packages/coding-agent/docs/。</p></section>` +
    `<section class="panel"><h2>一、pi 自己的概念</h2>` +
      `<p class="muted" style="margin:0 0 8px">这些词一律用 pi 的名字与定义。` +
      `下面每一条都附官方文档里的英文原句、中文翻译与出处。</p></section>` +
    piTable(data["pi 的概念"]) +
    `<section class="panel"><h2>二、领域概念（不是 pi 的，来自任务数据库）</h2>` +
      smallTable(data["领域概念"], ["名字", "它是什么", "来源", "与 pi 的关系"]) + `</section>` +
    `<section class="panel"><h2>三、后端概念（不是 pi 的，来自后端归档）</h2>` +
      smallTable(data["后端概念"], ["名字", "它是什么", "来源", "与 pi 的关系"]) + `</section>` +
    `<section class="panel"><h2>四、呈现用语（只是画法，不是谁的概念）</h2>` +
      `<p class="muted" style="margin:0 0 8px">这些词说的是任务页与会话详情页怎么画，` +
      `不对应 pi、领域或后端的任何一样东西。列在这里，是为了让人知道它们不是新事实。</p>` +
      smallTable(data["呈现用语"], ["名字", "它是什么", "它不是什么", "画的依据"]) + `</section>` +
    `<section class="panel"><h2>四之一、阶段的判定规则</h2>` +
      `<p class="muted" style="margin:0 0 8px">${esc(data["归类声明说明"])}</p>` +
      smallTable(data["阶段的判定规则"], ["情形", "判成什么阶段", "依据"]) +
      `<h3 style="margin-top:12px">观测台自己带的默认值（stage_rules.json）</h3>` +
      smallTable(data["归类声明的默认值"], ["项", "默认值"]) + `</section>` +
    `<section class="panel"><h2>五、Langfuse 的用词怎么对应</h2>` +
      `<p class="muted" style="margin:0 0 8px">观测台不采用 Langfuse 的叫法，` +
      `只在这里说明它的词对应 pi 的哪个概念，好让人过去数得对。</p>` +
      smallTable(data["Langfuse 用词对应"],
                 ["Langfuse 里叫什么", "对应 pi 的什么", "数目怎么核对"]) + `</section>`;
}
