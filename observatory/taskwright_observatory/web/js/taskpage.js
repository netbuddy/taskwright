// 任务页与会话详情页共用的组件：把一条流程画成「阶段 → 对话 → 机器」三层，右边是交付物看板与知识的使用。
//
// 画法照用户确认过的任务页设计原型搬过来；阶段怎么判、概括句怎么拼、需要注意怎么得出都在后端 taskpage.py 里，
// 这里只按数据画，不再做任何判断。三层是同一条流程的三个放大级别，在同一页里原地展开：
// 只看阶段 → 阶段加对话（每个阶段里的改动、执行者发出的消息、用户说的话）→ 全部细节（每一轮的模型交互、
// 工具执行、出口、时间条）。「阶段」「需要注意」「交付物看板」「知识的使用」「参与者」「生命线」「激活」
// 「模型交互」「工具执行」「出口」「变化」都是观测台自己的呈现用语，不是 pi 的概念，见概念对照页。

import { esc } from "./util.js";

const 道宽 = 40;
let zoom = 1;             // 放大级别跨页面保留：看完一条会话再看另一条，还停在同一档
let cur = null;           // 这一页的数据
let host = null;          // 这一页的根元素
let observer = null;

const 人物 = {
  用户:      {形: "h", 字: "用", 名: "用户",       色: "#3148C8", 底: "#EEF1FD"},
  执行者:    {形: "a", 字: "执", 名: "执行者",     色: "#0F766E", 底: "#E7F4F2"},
  评审者:    {形: "a", 字: "评", 名: "评审者",     色: "#7C4DBC", 底: "#F3EEFB"},
  确认判读者: {形: "a", 字: "判", 名: "确认判读者", 色: "#A8651B", 底: "#FBF2E6"},
  模拟用户:  {形: "h", 字: "模", 名: "模拟用户",   色: "#B83A6B", 底: "#FBEBF1"},
};
const 头像 = (名) => `<span class="av ${人物[名].形}">${人物[名].字}</span>`;
const $ = (s, r) => (r || host).querySelector(s);
const 秒 = (n) => (n == null ? "未知" : Number(n) < 1 ? Math.round(Number(n) * 1000) + " 毫秒" : Number(n).toFixed(2) + " 秒");
const secs = (s) => s == null ? "未知" : (s >= 60 ? Math.floor(s / 60) + " 分 " + Math.round(s % 60) + " 秒"
  : (s < 1 ? s + " 秒" : Math.round(s) + " 秒"));

/* 检视抽屉里的一条条目录 */
const 库 = [];
const 登记 = (o) => (库.push(o), 库.length - 1);

/* ───── 比对结果的画法：分段由后端算好，这里只上色 ───── */
// 扩展写进会话的自定义消息（例如打开会话时的任务现状消息）。pi 交给模型时是用户角色的消息，
// 所以这里显示成用户消息，并标明来源是扩展、不是人打的字。
function 扩展消息HTML(list) {
  if (!list.length) return "";
  // 「.say」自带保留换行的样式，所以模板里不留换行与缩进，免得显示成空行。
  return `<div class="extmsgs">${list.map((m) => `<div class="say human" id="msg-${esc(m.条目编号)}" data-arrow="扩展>执行者">` +
    `<div class="saylab">用户消息（pi 的自定义消息 ${esc(m.类型)}）　来源：扩展，不是人打的字　${esc(m.时刻 || "")}</div>` +
    `${esc(m.文字)}<span class="src">会话 <code>${esc(m.会话编号)}</code> 的条目 <code>${esc(m.条目编号)}</code></span></div>`).join("")}</div>`;
}

// 一条来源：种类、出处、支持哪几处、摘录。「用户的话」的出处是「会话编号#会话条目编号」，
// 链到那条会话并定位到那条用户消息（会话页地址的第三段是 msg-<会话条目编号>）。
function 来源HTML(s, 间距, 字号) {
  const 对话 = s.对话出处;
  const 出处 = 对话
    ? `<a href="#/session/${encodeURIComponent(对话.会话编号)}/msg-${encodeURIComponent(对话.条目编号)}"
         title="到这条会话里看用户说的这句话">会话 ${esc(对话.会话编号)} 的条目 ${esc(对话.条目编号)}</a>`
    : esc(s.出处);
  return `<div style="margin-bottom:${间距}px"><span class="stag">${esc(s.种类)}</span>
    <span style="color:var(--ink2);font-size:${字号}px">${出处}</span>
    ${s.支持 ? `<span style="color:var(--ink3);font-size:12px">　支持${esc(s.支持)}</span>` : ""}
    <div class="squote">${esc(s.摘录)}</div></div>`;
}

function 画分段(段, 取) {
  return (段 || []).map((p) => {
    if (p.标记 === "增") return 取 === "后" ? `<span class="ins">${esc(p.文)}</span>` : "";
    if (p.标记 === "删") return 取 === "前" ? `<span class="del">${esc(p.文)}</span>` : "";
    return esc(p.文);
  }).join("");
}

/* ───── 页头 ───── */
function renderHead() {
  const h = cur.页头, hasTask = cur.任务在不在;
  const 范围 = cur.范围 === "任务"
    ? `这一页的范围是整个任务，按时间接起了 ${h.会话数} 条会话`
    : (hasTask ? `这一页的范围是一条会话，只画这条会话里发生的事` : "");
  const 另一页 = cur.范围 === "任务"
    ? cur.会话.map((s, i) => `<a href="#/session/${encodeURIComponent(s.会话编号)}">第 ${i + 1} 条会话「${esc(s.归档名)}」的会话详情</a>`).join("、")
    : (cur.任务的键 ? `<a href="#/task/${cur.任务的键.split("/").map(encodeURIComponent).join("/")}">看这个任务的任务页</a>` : "");
  // 页头压成标题一行加事实一段：事实之间用分号接成一段连续的文字，按宽度自然折行，不再一项占一格。
  const facts = [
    另一页 ? `去${另一页}` : "",
    `任务目录是 <b>${esc(h.任务目录 || "未知")}</b>，库的格式是 <b>${esc(h.库的格式 || "未知")}</b>`,
    h.材料文件.length ? `材料文件是 <b>${h.材料文件.map(esc).join("、")}</b>`
      : (h.材料目录是任务定义登记的 ? `执行者没有读到材料目录 <b>${esc(h.材料目录)}</b> 里的任何一份文件` : ""),
    `从 <b>${esc(h.开始时刻)}</b> 到 <b>${esc(h.结束时刻 || "未知")}</b>`,
    `跨了 <b>${h.会话数} 条会话（session）、${h.运行次数} 次运行（agent run）、${h.轮数} 轮（turn）、${h.工具调用次数} 次工具调用</b>，其中 <b>${h.被拒次数} 次被工具拒绝</b>`,
    `后端把 pi 进程启动了 <b>${h["pi 进程启动次数"]} 次</b>`,
    `前后一共 <b>${secs(h.总耗时秒)}</b>：模型在想 <b>${secs(h.模型在想的秒数)}</b>，工具在跑 <b>${secs(h.工具在跑的秒数)}</b>，其余是等待`,
    `用的模型是 <b>${esc(h.模型)}</b>`,
  ];
  const 同区 = (cur.同任务目录里没有写过这个任务的会话 || []).length
    ? `<p class="declnote">同一个任务目录里还有 ${cur.同任务目录里没有写过这个任务的会话.length} 条会话没有在这个任务的库里写下任何东西，所以不在这一页上：${
      cur.同任务目录里没有写过这个任务的会话.map((s) => `<a href="#/session/${encodeURIComponent(s.会话编号)}">「${esc(s.归档名)}」</a>`).join("、")}。</p>` : "";
  $("#tp-head").innerHTML = `
  <div class="head">
    <div class="line1">
      <h1>${esc(hasTask ? h.任务名 : "这条会话没有对上任务")}</h1>
      ${hasTask ? `<span class="badge">任务编号 ${esc(h.任务编号)}</span>
                  <span class="badge run">状态是${esc(h.状态)}</span>
                  ${h.交付物名称 ? `<span class="badge">交付物是「${esc(h.交付物名称)}」</span>`
                                : `<span class="badge old">这个任务的库是旧格式，没有登记交付物名称</span>`}`
               : `<span class="badge none">它所在的任务目录里还没有任务记录</span>`}
      <span class="badge">归档名是 ${esc(h.归档名)}</span>
      ${范围 ? `<span class="badge">${esc(范围)}</span>` : ""}
    </div>
    <p class="facts">${facts.filter(Boolean).join("；")}。</p>
    <p class="lede">${esc(cur.概括)}</p>
    ${h.声明说明 ? `<p class="declnote">${esc(h.声明说明)}</p>` : ""}
    ${同区}
  </div>`;
}

/* ───── 这一页上的名词、阶段怎么判、观测不到什么 ───── */
function renderWords() {
  const lf = cur.Langfuse || {};
  $("#tp-words").innerHTML = `<details class="words">
  <summary>这一页上的名词、阶段是怎么判出来的、有哪些东西观测不到（点开看）</summary>
  <div class="in">
    <h4>三层是同一条流程的三个放大级别</h4>
    <p>这一页把同一条流程画了三遍，粗细不同，关联的依据是下面这条链子：<b>一个阶段是连着的、判定相同的几轮；每一轮属于某一次运行（agent run）；每一次运行由用户的一句话触发。</b>
    点开一个阶段看到的是它那几轮里的对话内容，再点开一轮看到的是那一轮的模型交互与工具执行。它们不是三个页面，是同一份数据的三个放大级别。</p>

    <h4>观测台自己的呈现用语，pi 里没有这几个说法</h4>
    <dl>
      <dt>阶段</dt><dd>连着的、判定相同的几轮合并成的一行。一轮只属于一个阶段，按这一轮的第一个工具调用判；没有工具调用的轮，按「对用户说话」或「没有说话也没有调用工具」判。同一轮里还有别的种类的调用时，阶段名写成「了解方法，同时找材料」这样。判定只看事实，不看内容。</dd>
      <dt>需要注意</dt><dd>只列由事实直接得出的异常，没有异常时整块不显示。</dd>
      <dt>交付物看板</dt><dd>指右边那一栏，摆的是这个任务到现在产出了什么。</dd>
      <dt>知识的使用</dt><dd>指右边那一栏的第二个页签，摆的是知识仓库里的每份文件这一次各自用到没有、怎么用到的。</dd>
      <dt>知识仓库</dt><dd>任务目录里给执行者读的那些文件：执行方法（skill）所在的 .pi/skills/，与各类文档所在的 docs/。</dd>
      <dt>参与者</dt><dd>在这条会话里说话或者做事的一方，例如用户、执行者。</dd>
      <dt>窄带</dt><dd>流程区左边那条窄带：每条竖线是一个参与者的生命线；加粗的一段是他正在做事，横线是一条消息。</dd>
      <dt>生命线</dt><dd>窄带里的一条竖线，代表一个参与者从头到尾的存在。</dd>
      <dt>激活</dt><dd>生命线上加粗的那一段，表示这个参与者在这段时间里正在做事。</dd>
      <dt>模型交互</dt><dd>一轮里 pi 与模型一问一答的那一段。</dd>
      <dt>工具执行</dt><dd>一轮里 pi 执行模型提出的调用的那一段。</dd>
      <dt>出口</dt><dd>一轮结束时 pi 是接着开下一轮，还是把这次运行收尾。</dd>
      <dt>变化</dt><dd>一次工具调用在任务数据库里留下的后果：交付物的一次修订，或者任务的建立。</dd>
    </dl>

    <h4>pi 自己的概念</h4>
    <dl>
      <dt>会话（session）</dt><dd>pi 保存在一个会话文件里的一整段交流。</dd>
      <dt>提示（prompt）</dt><dd>外部投给 pi 的一句话，pi 收到它就开始一次运行。</dd>
      <dt>一次运行（agent run）</dt><dd>pi 从收到提示到安顿下来的一整段处理，从 agent_start 开始，到 agent_settled 结束。</dd>
      <dt>轮（turn）</dt><dd>一次运行里的一个来回：pi 请求一次模型，再执行模型提出的工具调用。</dd>
      <dt>模型请求（provider request）</dt><dd>pi 把当前的消息列表发给模型、等它应答的那一次请求。</dd>
      <dt>助手消息（assistant message）</dt><dd>模型应答里的那段正文，被 pi 追加进消息列表。</dd>
      <dt>工具结果消息（toolResult message）</dt><dd>一次工具调用的结果，被 pi 存成消息列表末尾的一条消息。</dd>
      <dt>用户消息（user message）</dt><dd>提示被 pi 存成的那条消息。</dd>
      <dt>工具调用（tool call）</dt><dd>模型在应答里提出、由 pi 去执行的一次调用。</dd>
      <dt>插话（steer）</dt><dd>一次运行还没有结束时又投进来的一句话，pi 把它排在下一轮给模型看，这次运行不会因此中断。</dd>
      <dt>自动重试（auto retry）</dt><dd>模型请求出错时 pi 自己再请求一次，这会让 pi 重新开始一段低层运行，它给的轮号 turnIndex 从 0 重新编。</dd>
      <dt>skill</dt><dd>pi 启动时加载的一份执行方法说明。启动时只把它的名字与描述放进系统提示，正文要执行者自己用 read 去读。</dd>
      <dt>上下文文件（context file）</dt><dd>AGENTS.md 一类的文件，pi 启动时把它们整份放进系统提示。</dd>
    </dl>
    <p>「模型应答」在 pi 里没有单独的名字。观测台用这四个字指同一次应答里的四样东西：助手消息的内容、停止原因、词元用量、响应编号。</p>

    <h4>业务领域的概念，不属于 pi</h4>
    <dl>
      <dt>任务</dt><dd>用户要办的一件事，系统为它记账。</dd>
      <dt>修订</dt><dd>交付物被改动一次就存下一次修订。</dd>
      <dt>交付物</dt><dd>这条任务要产出的东西。</dd>
      <dt>条目</dt><dd>交付物里的一条内容，例如一个功能用例、一条约束。每个条目附带一到多条来源。</dd>
      <dt>来源</dt><dd>一个条目的出处：种类、出处、摘录，以及它支持哪几个字段（不指明就是支持整个条目）。「用户的话」的出处点开就是那条会话里用户说的那句话。</dd>
      <dt>记录</dt><dd>工具写下的、不属于交付物的东西，例如一次评审记录、一次确认记录。</dd>
    </dl>

    <h4>后端的概念</h4>
    <dl>
      <dt>一次 pi 进程启动</dt><dd>后端把 pi 拉起来一次。同一条会话可以跨好几次启动。</dd>
      <dt>收到时刻</dt><dd>后端收到某一条事件的时刻，页面上的时间与长度都按它算。</dd>
      <dt>后端补记</dt><dd>后端在归档旁边另记的几样 pi 事件流里没有的事实，例如启动命令、这次加载了哪些 skill、知识仓库每份文件的摘要值。</dd>
    </dl>

    <h4>阶段是按这一份归类声明判出来的</h4>
    <p>判定规则不写在观测台的代码里，而是读下面这一份声明：路径归类（执行方法、领域规矩、材料目录、文档模板各在哪里）读任务定义，工具对应的阶段名与异常判据的阈值是观测台自己带的默认值。换一类任务只要换一份任务定义，观测台的代码不用动。</p>
    <pre class="code">${esc(JSON.stringify(cur.声明, null, 2))}</pre>

    <h4>页头那句概括是怎么拼出来的</h4>
    <p>它是一句按固定模板拼出来的话，不是人写的结论。模板是：交付物现有多少条目 → 完成条件满足了几条 → 执行者走过几个阶段 → 最后一个阶段是什么 → 这条会话的终态。换一份数据它自己会变。</p>

    <h4>耗时为什么拆成两项</h4>
    <p>一轮只属于一个阶段，所以这一轮里模型在想的时间与工具在跑的时间，都记在这个阶段上。「模型在想」是这几轮里模型交互的耗时，「工具在跑」是工具调用本身的耗时。两项加起来一般小于页头的总耗时，差额是等待用户与进程空转的时间。</p>

    <h4>到 Langfuse 的链接</h4>
    <p>${esc((lf.状态 || {}).说明 || "没有读到 Langfuse 的配置状态。")}</p>

    <h4>有哪些东西这一页观测不到</h4>
    <p>模型在两次工具调用之间想了什么——例如它是怎样把材料分拣成功能用例、非功能需求、约束、待定事项这几类的——不产生任何工具调用，所以不会成为一个阶段，只存在于那一轮应答的正文里（在「全部细节」这一档里看）。这一页只显示有事实依据的阶段，不编造中间步骤，也不替执行者解释它为什么这样做。</p>
  </div></details>`;
}

/* ───── 需要注意 ───── */
function renderAlerts() {
  // 按轻重分两块：重的是红底，轻的（合乎规矩、后来改对了之类的说明）是浅色底；只有轻的时整块就是浅色。
  const list = cur.需要注意 || [];
  const 一块 = (items, soft) => !items.length ? "" :
    `<div class="alerts${soft ? " soft" : ""}"><h2>${soft ? "需要注意（轻）" : "需要注意"}</h2><ul>${
      items.map((n) => `<li>${esc(n.文字)}${
        n.去哪 ? ` <button class="jump alertgo" data-jump="${esc(n.去哪)}">跳到那个阶段</button>` : ""}</li>`).join("")}</ul></div>`;
  $("#tp-alerts").innerHTML = 一块(list.filter((n) => n.轻重 === "重"), false) + 一块(list.filter((n) => n.轻重 !== "重"), true);
}

/* ───── 参与者 ───── */
function renderPeople() {
  const box = $("#tp-people");
  box.innerHTML = `<span class="tip">参与者（点一下只看与他有关的阶段）：</span>` +
    (cur.参与者 || []).map((p) => `<button type="button" class="person p-${esc(p.名)}" aria-pressed="false" data-who="${esc(p.名)}">
      ${头像(p.名)}<span class="who">${esc(p.名)}</span><span class="role">${esc(p.角色)}</span></button>`).join("");
  box.querySelectorAll(".person").forEach((b) => {
    b.onclick = () => {
      b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
      const 选中 = [...box.querySelectorAll('.person[aria-pressed="true"]')].map((x) => x.dataset.who);
      $("#tp-flow").querySelectorAll(".stage").forEach((s) =>
        s.classList.toggle("dim", 选中.length > 0 && !选中.includes(s.dataset.who)));
      布局();
    };
  });
}

/* ───── 改动块：条目、字段、来源、改前改后 ───── */
function 画值(f) {
  if (f.类型 === "文本列表" && Array.isArray(f.值))
    return `<ol class="flist">${f.值.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`;
  if (f.类型 === "枚举") return `<span class="enum">${esc(f.值)}</span>`;
  if (f.类型 === "条目引用" && Array.isArray(f.值))
    return f.值.length ? f.值.map((x) => `<button class="ref" data-code="${esc(x)}">${esc(x)}</button>`).join(" ")
      : `<div class="ftext">（没有引用任何条目）</div>`;
  return `<div class="ftext">${esc(f.值 == null || f.值 === "" ? "（这一项没有填）" : f.值)}</div>`;
}
function 画字段表(字段, key, 折) {
  const rows = 字段.map((f) => `<div class="frow"><div class="fn">${esc(f.名)}</div><div>${画值(f)}</div></div>`);
  if (!折 || rows.length <= 3) return `<div class="ftable">${rows.join("")}</div>`;
  return `<div class="ftable">${rows.slice(0, 3).join("")}<span hidden data-allf="${key}">${rows.slice(3).join("")}</span></div>
    <button class="opmore" data-openf="${key}">展开全部 ${rows.length} 项字段</button>`;
}
function 画列表比对(v) {
  const 步 = v.步骤 || [];
  const 前 = [], 后 = [];
  步.forEach((x) => {
    if (x.标记 === "未变") { 前.push(`<li>${esc(x.文)}</li>`); 后.push(`<li>${esc(x.文)}</li>`); }
    else if (x.标记 === "删除") 前.push(`<li><span class="del">${esc(x.文)}</span></li>`);
    else if (x.标记 === "新增") 后.push(`<li><span class="ins">${esc(x.文)}</span></li>`);
    else { 前.push(`<li>${画分段(x.段, "前")}</li>`); 后.push(`<li>${画分段(x.段, "后")}</li>`); }
  });
  return `<div class="sidebyside">
    <div class="cbox"><div class="colh">改前</div><ol class="flist">${前.join("") || '<li class="none">此前没有内容</li>'}</ol></div>
    <div class="cbox"><div class="colh">改后</div><ol class="flist">${后.join("") || '<li class="none">（空）</li>'}</ol></div></div>`;
}
function 画变更(v) {
  if (v.类型 === "文本列表" && v.步骤) return 画列表比对(v);
  if (v.段) {
    return `<div class="sidebyside">
      <div class="cbox"><div class="colh">改前</div><div class="ftext">${画分段(v.段, "前") || '<span class="none">此前没有内容</span>'}</div></div>
      <div class="cbox"><div class="colh">改后</div><div class="ftext">${画分段(v.段, "后") || '<span class="none">（空）</span>'}</div></div></div>`;
  }
  const 值 = (x) => v.类型 === "枚举" ? `<span class="enum">${esc(x)}</span>` : 画值({类型: v.类型, 值: x});
  return `<div class="sidebyside"><div class="cbox"><div class="colh">改前</div>${值(v.改前)}</div>
      <div class="cbox"><div class="colh">改后</div>${值(v.改后)}</div></div>`;
}
function 画操作(op, key, 收起) {
  const kind = op.动作 === "新增" ? "add" : op.动作 === "删除" ? "drop" : "edit";
  const v = op.版本 || [null, null];
  const ver = op.动作 === "修改" && v[0] != null ? `第 ${v[0]} 版改成第 ${v[1]} 版`
    : op.动作 === "新增" && v[1] != null ? `这是它的第 ${v[1]} 版` : "";
  let 体;
  if (op.动作 === "新增") 体 = 画字段表(op.字段 || [], key, true);
  else if (op.动作 === "删除") 体 = `<div class="ftext"><span class="del">${esc(op.条目标题 || op.条目编号)}</span></div>
    <div class="none">这个条目在这一次修订里被删掉了。</div>`;
  else 体 = (op.变更 || []).length
    ? (op.变更 || []).map((x) => `<div class="chgf"><div class="cfn">${esc(x.字段)}</div>${画变更(x)}</div>`).join("")
    : `<div class="none">这次修改只改了来源，字段一项都没有变。</div>`;
  return `<div class="op" data-code="${esc(op.条目编号)}" data-opkey="${esc(key)}" ${收起 ? "hidden" : ""}>
    <div class="oph"><span class="opk ${kind}">${esc(op.动作)}</span>
      <button class="ref" data-code="${esc(op.条目编号)}">${esc(op.条目编号)}</button>
      <span style="color:var(--ink3);font-size:12.5px">集合「${esc(op.集合)}」</span>
      ${op.条目标题 && op.条目标题 !== op.条目编号 ? `<b style="font-weight:600">${esc(op.条目标题)}</b>` : ""}
      ${ver ? `<span class="ver">${ver}</span>` : ""}</div>
    ${体}
    ${(op.来源 || []).length ? `<div class="srcs"><div class="srch">这一版的来源一共 ${op.来源.length} 条${op.动作 === "修改" ? (op.来源变了吗 ? "，这次修改换过来源" : "，这次修改沿用了上一版的来源") : ""}</div>${
      op.来源.map((s) => 来源HTML(s, 5, 12.5)).join("")}</div>` : ""}
  </div>`;
}
/* 新库表的一次保存先只显示一行：各集合新增、修改、删除了哪几个条目，点某个条目才在原地展开 */
function 收起的一行(b, key) {
  const 组 = [];
  b.操作.forEach((op, i) => {
    const k = `${op.动作}|${op.集合}`;
    let g = 组.find((x) => x.k === k);
    if (!g) { g = {k, 动作: op.动作, 集合: op.集合, 项: []}; 组.push(g); }
    g.项.push({op, i});
  });
  return `<div class="oneline">${组.map((g) => `<div class="olrow"><span class="opk ${g.动作 === "新增" ? "add" : g.动作 === "删除" ? "drop" : "edit"}">${esc(g.动作)}</span>
    <span class="olset">${esc(g.集合)}</span>${g.项.map(({op, i}) =>
      `<button class="olitem" data-opentoggle="${esc(key)}-${i}" aria-expanded="false"><span class="code">${esc(op.条目编号)}</span>${
        op.条目标题 ? `「${esc(op.条目标题)}」` : ""}</button>`).join("")}</div>`).join("")}
    <div class="olhint">点一个条目，在这里展开它这一版的字段与来源${b.操作.some((o) => o.动作 === "修改") ? "（修改的条目展开的是改前改后）" : ""}。</div></div>`;
}
function 改动块(b, key, 调用编号) {
  if (b.类别 === "任务的变化") {
    const 键 = 登记({标题: "任务的一次变化", 概念: [["业务领域的概念", "任务"]],
      这是什么: "这是业务领域里的一件事：工具在库里立起了一个任务。它不是 pi 的概念。",
      字段: [["任务编号", `<code>${esc(b.任务.任务编号)}</code>`], ["任务名", esc(b.任务.任务名)],
        ["条目集合", esc((b.任务.集合 || []).join("、"))],
        ["由哪次调用写下", `<code>${esc(调用编号)}</code>`],
        ["写下的事实", (b.事件 || []).map((e) => `${esc(e.事件名)}（第 ${e.事件序号} 条，发起方 ${esc(e.发起方 || "—")}）`).join("；") || "接口没有单独给出事件序号。"]],
      链接: ""});
    return `<div class="chgblock" id="chg-${esc(key)}" data-mark="mile">
      <div class="chgtitle"><i class="flag"></i><span class="txt" data-k="${键}">${esc(b.标题句)}</span>
        <button class="ref" data-code="${esc(b.任务.任务编号)}">${esc(b.任务.任务编号)}</button></div>
      <div class="op"><div class="oph"><span class="opk add">新建</span>
        <span style="color:var(--ink3);font-size:12.5px">任务「${esc(b.任务.任务名)}」</span></div>
        <div class="ftext">${esc(b.任务.说明)}交付物分成 ${(b.任务.集合 || []).length} 个条目集合：${(b.任务.集合 || []).map(esc).join("、")}。</div></div>
    </div>`;
  }
  if (b.类别 === "评审记录" || b.类别 === "确认记录" || b.类别 === "任务的完成") {
    return `<div class="chgblock" id="chg-${esc(key)}" data-mark="mile">
      <div class="chgtitle"><i class="flag"></i><span class="txt">${esc(b.标题句)}</span></div>
      <div class="op"><div class="ftable">${(b.记录 || []).map(([名, 值]) =>
        `<div class="frow"><div class="fn">${esc(名)}</div><div class="ftext">${esc(值)}</div></div>`).join("")}</div></div>
    </div>`;
  }
  const 键 = 登记({标题: "交付物的一次修订", 概念: [["业务领域的概念", "修订"]],
    这是什么: "这是业务领域里的一件事：工具把数据写进去以后，交付物存下了新的一次修订。它不是 pi 的概念。",
    字段: [["修订序号", b.修订序号 != null ? `第 ${b.修订序号} 次修订` : "这次改动没有形成修订"],
      ["改动", esc(b.标题句)],
      ["由哪次调用写下", `<code>${esc(调用编号)}</code>`],
      ["写下的事实", (b.事件 || []).map((e) => `${esc(e.事件名)}（第 ${e.事件序号} 条，发起方 ${esc(e.发起方 || "—")}）`).join("；") || "接口没有单独给出事件序号。"]],
    链接: ""});
  const 收起 = !b.旧库表;
  return `<div class="chgblock" id="chg-${esc(key)}" data-mark="mile">
    <div class="chgtitle"><i class="flag"></i><span class="txt" data-k="${键}">${esc(b.标题句)}</span>
      ${收起 ? "" : (b.标签 || []).map((c) => `<button class="ref" data-code="${esc(c)}">${esc(c)}</button>`).join(" ")}</div>
    ${b.对不上 ? `<p class="none" style="color:var(--bad)">${esc(b.对不上)}</p>` : ""}
    ${收起 ? 收起的一行(b, key) : ""}
    ${(b.操作 || []).map((op, i) => 画操作(op, key + "-" + i, 收起)).join("")}
  </div>`;
}

/* ───── 机器层：一轮的完整画法 ───── */
function 模型交互(q, t, qi, key) {
  const two = q.带的消息 || {};
  const 消息数 = two["观测台数出来的"] != null ? two["观测台数出来的"] : "若干";
  const 承接 = t.序数 > 1
    ? `<span class="sub">这次请求带的消息里，最后一条是上一轮的工具结果，模型从这里第一次看到它。</span>` : "";
  const 请求键 = 登记({
    标题: "一次模型请求", 概念: [["pi 的概念", "模型请求（provider request）"]],
    这是什么: "这是 pi 把当前的消息列表发给模型、等它应答的那一次请求。这一块只讲请求本身，模型回了什么在「应答」那一块。",
    字段: [
      ["模型", esc(q.模型)],
      ["供应方与接口", `${esc(q.供应方)}　<code>${esc(q.接口)}</code>`],
      ["带的消息", `观测台从事件流里数出 ${two["观测台数出来的"]} 条；Langfuse 那条生成记录里记的是 ${two["取自 Langfuse 的"] == null ? "没取到" : two["取自 Langfuse 的"]} 条。${
        two["两个数一样吗"] === true ? "两个数一样。" : two["两个数一样吗"] === false ? "两个数对不上。" : ""}`],
      ["最近几条消息", `<ol class="ctx">${(q.最近几条消息 || []).map((m) => `<li>${esc(m.角色)}：${esc(m.开头)}</li>`).join("") || "<li>接口没有给出这一项。</li>"}</ol>`],
      ["归档行号", q.行 && q.行[0] != null ? `第 ${q.行[0]} 到 ${q.行[1]} 行（${esc(t.归档文件)}）` : "没有行号"],
      ["是不是自动重试", q.是不是自动重试 ? "是，这是 pi 的一次自动重试。" : "不是。"],
    ], 链接: q.链接 || "", 第一级: t.运行记录链接 || ""});
  const 正文 = (t.正文 || "").trim() ? esc(t.正文) : "模型这一次没有说话。";
  const 应答键 = 登记({
    标题: "模型这一次的应答",
    概念: [["pi 的概念", "助手消息（assistant message）"], ["pi 的概念", "工具调用（tool call）"]],
    这是什么: "这是模型对上面那次请求给出的应答。「模型应答」在 pi 里没有单独的名字，它是助手消息的内容加停止原因、词元用量、响应编号。",
    字段: [
      ["正文", `<div style="white-space:pre-wrap">${正文}</div>`],
      ["提出的调用", t.调用.length ? t.调用.map((c) => `${esc(c.中文名 || c.工具)}（${esc(c.工具)}）`).join("、") : "这一次没有提出工具调用"],
      ["停止原因", `<code>${esc(q.停止原因)}</code>（pi 给的原词是 <code>${esc(q.原始停止原因)}</code>）${q.出错说明 ? `。出错的说明是：${esc(q.出错说明)}` : ""}`],
      ["词元", `输入 ${q.词元.input}，输出 ${q.词元.output}，读缓存 ${q.词元.cacheRead}，合计 ${q.词元.totalTokens}`],
      ["响应编号", `<code>${esc(q.响应编号)}</code>`],
      ["用时", `${秒(q.耗时秒)}。${esc(q.耗时是怎么算的 || "")}`],
    ], 链接: q.链接 || "", 第一级: t.运行记录链接 || ""});
  return `<div class="blk" id="blk-${esc(key)}-req${qi}" data-k="${请求键}"><div class="k">请求</div>
      <div>pi 把当前的消息列表发给 ${esc(q.模型)}，这次带了 ${消息数} 条消息。${q.是不是自动重试 ? "这是一次自动重试。" : ""}${承接}</div></div>
    <div class="join">模型回来了下面这条应答</div>
    <div class="blk${q.停止原因 === "error" ? " bad" : ""}" data-k="${应答键}"><div class="k">应答</div><div><div style="white-space:pre-wrap">${正文}</div>
      <div style="margin-top:4px">${t.调用.length ? `模型提出了 ${t.调用.length} 个工具调用。` : "模型这一次没有提出工具调用。"}</div>
      <span class="sub">停止原因 ${esc(q.停止原因)}；词元合计 ${q.词元.totalTokens}；用了 ${秒(q.耗时秒)}。${q.出错说明 ? "出错的说明是：" + esc(q.出错说明) : ""}</span></div></div>`;
}
function 变化标题(c) {
  if (c.对不上) return "库里找不到对应的记录";
  if (!c.改动.length) return "这次调用没有带来变化";
  return c.改动[0].类别;
}
function 工具执行(c, t, key, ci) {
  const 坏 = c.被拒 ? " bad" : "";
  const 调用键 = 登记({
    标题: `一次工具调用：${c.中文名 || c.工具}`, 概念: [["pi 的概念", "工具调用（tool call）"]],
    这是什么: "这是模型在应答里提出、由 pi 去执行的一次调用。这一块只讲模型提出了什么，结果在「结果」那一块。",
    字段: [["工具", `${esc(c.中文名 || c.工具)}（<code>${esc(c.工具)}</code>）`],
      ["调用编号", `<code>${esc(c.编号)}</code>`],
      ["参数", `<pre>${esc(JSON.stringify(c.参数, null, 2))}</pre>`]],
    链接: c.链接 || "", 第一级: t.运行记录链接 || ""});
  const 结果键 = 登记({
    标题: `一次工具调用的结果：${c.中文名 || c.工具}`, 概念: [["pi 的概念", "工具结果消息（toolResult message）"]],
    这是什么: "这是工具执行完以后返回的东西。工具可以接受这次调用，也可以拒绝它。",
    字段: [["接受还是拒绝", c.被拒 ? '<span class="pill no">被拒绝</span>' : c.有没有执行结果 ? '<span class="pill ok">已接受</span>' : "归档里没有这次调用的执行结果"],
      ["结果原文", `<div style="white-space:pre-wrap">${esc(c.结果全文)}</div>`],
      ...(c.回复 && c.回复.排版 ? [["排好的样子", `<pre style="white-space:pre-wrap">${esc(c.回复.排版.join("\n"))}</pre><span class="sub">${esc(c.回复.排版是怎么来的)}</span>`]] : []),
      ...(c.回复 && c.回复.降级放行 ? [["降级放行", esc(c.回复.降级放行说明)]] : []),
      ["耗时", 秒(c.耗时秒)],
      ["存到哪里", "结果存成一条工具结果消息（toolResult message），追加到消息列表末尾，本轮里模型还没有看到它。"]],
    链接: c.链接 || "", 第一级: t.运行记录链接 || ""});
  const 事件文 = (c.事件 || []).map((e) => `${esc(e.事件名)}（第 ${e.事件序号} 条，来源 ${esc(e.来源 || "—")}）`).join("；");
  const 库键 = 登记({
    标题: `这次调用带来的变化：${变化标题(c)}`,
    概念: [["业务领域的概念", "修订"], ["业务领域的概念", "记录"]],
    这是什么: "这一块讲的是业务领域里的后果，不属于 pi：工具把数据写进去，交付物或者别的记录因此发生变化。下面这些事件序号与发起方是给开发者对照用的事实。",
    字段: [["写下的事实", 事件文 || (c.对不上 ? esc(c.对不上) : "这次调用没有在库里写下任何记录。")],
      ["发起方", (c.事件 || []).map((e) => esc(e.发起方 || "—")).join("、") || "没有写下记录，也就没有发起方。"],
      ["改动的内容", c.改动.map((b) => esc(b.标题句)).join("<br>") || "这次调用没有改动交付物，也没有留下其他记录。"],
      ["形成的修订", c.修订序号 != null ? `第 ${c.修订序号} 次修订` : "这次调用没有形成修订。"]],
    链接: ""});
  const 上面画过 = c.改动.length && !c.被拒;
  const 跳 = `<button class="jump" style="color:var(--human);text-decoration:underline" data-jump="chg-${esc(key)}-${ci}">跳到对话层里那一块看改动</button>`;
  const 变化块 = c.对不上 ? `<div class="none" style="color:var(--bad)">${esc(c.对不上)}</div>`
    : 上面画过 ? (t.调用.length === 1 ? `<div>${跳}</div>` : `<div class="none">这次调用带来的改动显示在这一轮的对话层里。${跳}</div>`)
      : `<div class="none">这次调用没有改动交付物，也没有留下其他记录。</div>`;
  const 判读块 = (c.模型调用 || []).map((m, mi) => {
    let 提示 = m.提示;
    try { const p = JSON.parse(m.提示); 提示 = `【系统提示】\n${p.systemPrompt}\n\n【用户消息】\n${(p.messages || []).map((x) => x.content).join("\n")}`; } catch (e) { /* 原样显示 */ }
    const 键 = 登记({
      标题: `工具里的一次模型调用：${m.角色}`, 概念: [["业务领域的概念", m.角色]],
      这是什么: "这是工具在执行时自己发起的一次模型调用，不经过 pi 的运行循环，所以 Langfuse 里看不到它；提示全文与原始输出记在库里的 model_call 表。",
      字段: [["角色", esc(m.角色)], ["结果", esc(m.结果) + (m.判读序号 != null ? `（写成了第 ${m.判读序号} 次判读）` : "")],
        ["模型", esc(m.模型)], ["耗时", `${m.耗时毫秒} 毫秒`], ["用量", `输入 ${m.输入用量 ?? "没记"}，输出 ${m.输出用量 ?? "没记"}`],
        ["时刻", esc(m.时刻)],
        ["提示", `<pre style="white-space:pre-wrap">${esc(提示)}</pre>`],
        ["输出", `<pre style="white-space:pre-wrap">${esc(m.输出 || "（没有输出）")}</pre>`]],
      链接: ""});
    const 坏判 = m.结果 === "采用" ? "" : " bad";
    return `<div class="blk${坏判}" id="blk-${esc(key)}-tool${ci}-mc${mi}" data-k="${键}"><div class="k">${esc(m.角色)}</div>
      <div>工具里第 ${mi + 1} 次模型调用：${esc(m.结果)}　<span class="sub">${esc(m.模型)}，${m.耗时毫秒} 毫秒；点开看提示与输出全文。</span></div></div>`;
  }).join("");
  const 拒因 = c.被拒 ? `<div class="sub" style="color:var(--bad)">上面这段就是工具拒绝这次调用时给出的原话。</div>` : "";
  return `<div class="blk${坏}" id="blk-${esc(key)}-tool${ci}" data-k="${调用键}"><div class="k">调用</div>
      <div>${esc(c.中文名 || c.工具)}（${esc(c.工具)}）　<code>${esc(String(c.编号).slice(0, 8))}</code>
      <span class="sub">${esc(c.参数摘要)}</span></div></div>
    <div class="blk${坏}" data-k="${结果键}"><div class="k">结果</div><div>${c.被拒 ? '<span class="pill no">被拒绝</span>' : c.有没有执行结果 ? '<span class="pill ok">已接受</span>' : "归档里没有这次调用的执行结果"}
      <div style="margin-top:5px;white-space:pre-wrap">${esc(c.结果全文)}</div>${拒因}</div></div>
    ${判读块}
    <div class="blk${坏}" data-k="${库键}"><div class="k">变化</div><div><div class="chg-h">${变化标题(c)}</div>${变化块}</div></div>`;
}
function 一轮机器层(t, key) {
  const 行号 = (t.行 && t.行[0] != null) ? `，归档第 ${t.行[0]} 到 ${t.行[1]} 行` : "";
  const 有工具 = t.调用.length > 0;
  const 到此为止 = 有工具 && t.调用.every((c) => c.要求到此为止);
  let 出口;
  if (有工具 && !到此为止 && t.下一轮序数 != null)
    出口 = `<b>出口</b>　本轮到此结束（turn_end）。本轮有工具结果，所以开始第 ${t.下一轮序数} 轮。`;
  else if (有工具 && 到此为止)
    出口 = `<b>出口</b>　本轮到此结束（turn_end）。本轮的工具都要求到此为止，这次运行到此结束，随后 pi 发出 agent_settled。`;
  else if (有工具)
    出口 = `<b>出口</b>　本轮到此结束（turn_end）。本轮有工具结果，可是归档里这次运行后面没有第 ${t.序数 + 1} 轮，这次运行到此结束。`;
  else if (t.下一轮序数 != null)
    出口 = `<b>出口</b>　本轮到此结束（turn_end）。本轮没有工具调用，可是这次运行后面还有第 ${t.下一轮序数} 轮（自动重试或插话让 pi 接着请求了模型）。`;
  else
    出口 = `<b>出口</b>　本轮到此结束（turn_end）。本轮没有工具调用，这次运行到此结束，随后 pi 发出 agent_settled。`;
  const 改正 = t.调用.filter((c) => c.被拒 && c.改正 && c.改正.有没有再试).map((c) =>
    `<p class="fixline"><button class="jump" data-jump="turn-${c.改正.运行序号}-${c.改正.轮号 + 1}">跳到${c.改正.改正成功 ? "改对的" : "再试的"}那一轮</button>　这次被拒的调用，后来在第 ${c.改正.运行序号} 次运行的第 ${c.改正.轮号 + 1} 轮${c.改正.改正成功 ? "改对了" : "又试了一次，仍然被拒绝"}。</p>`).join("");
  return `<div class="lv3" data-lv3box="${esc(key)}" hidden>
    <header><h3>第 ${t.运行序号} 次运行的第 ${t.序数} 轮</h3>
      ${t.轮号 != null ? `<span class="mono small">pi 的轮号 turnIndex＝${t.轮号}</span>` : ""}
      <span class="tag pi">轮（turn）</span>
      <span class="r">这一轮用了 ${Number(t.耗时秒 || 0).toFixed(2)} 秒，${esc(t.时刻)} 起${行号}</span></header>
    <div class="msec"><div class="name"><b>模型交互</b>pi 与模型一问一答</div>
      <div>${t.请求.map((q, qi) => 模型交互(q, t, qi, key)).join("")}</div></div>
    <div class="msec"><div class="name"><b>工具执行</b>pi 执行模型提出的调用</div>
      <div><div class="join">${有工具 ? `模型提出了 ${t.调用.length} 个工具调用，pi 去执行。` : "模型没有提出工具调用。"}</div>
      ${有工具 ? t.调用.map((c, ci) => 工具执行(c, t, key, ci)).join("")
        : '<div class="blk" style="cursor:default"><div class="k"></div><div>本轮没有工具调用。</div></div>'}</div></div>
    <div class="exit">${出口}</div>
    ${改正}
  </div>`;
}

/* ───── 时间条 ───── */
function 时间条(s, key) {
  const 带 = s.时间条 || {};
  if (!带.能不能画)
    return `<p class="tlnote" style="padding-left:10px">${esc(带.原因 || "这个阶段画不出时间条。")}</p>`;
  const 起 = 带.起, 跨 = Math.max(带.止 - 带.起, 0.001);
  const 位 = (m) => ((m - 起) / 跨 * 100) + "%";
  const 粗 = 跨 / 9;
  const 阶 = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const 步 = 阶.find((x) => x >= 粗) || Math.ceil(粗 / 60) * 60;
  let 刻度 = "";
  for (let x = 0; x <= 跨 + 1e-9; x += 步)
    刻度 += `<div class="tick" style="left:${x / 跨 * 100}%"><i>${x === 0 ? "0 秒" : (Math.round(x * 100) / 100) + " 秒"}</i></div>`;
  const 道 = [];
  const 放 = (i, seg) => { (道[i] = 道[i] || []).push(seg); };
  s.轮.forEach((t) => {
    const tk = `${key}-${t.序数}`;
    (t.请求 || []).forEach((q, qi) => {
      if (!q.起止 || q.起止[0] == null) return;
      放(0, {起: q.起止[0], 止: q.起止[1], 名: "模型交互" + (q.是不是自动重试 ? "（自动重试）" : ""),
        类: "req" + (q.是不是自动重试 ? " retry" : ""), 跳: `blk-${tk}-req${qi}`});
    });
    (t.调用 || []).forEach((c, ci) => {
      if (!c.起止 || c.起止[0] == null) return;
      放(c.泳道 || 1, {起: c.起止[0], 止: c.起止[1],
        名: "工具执行 · " + (c.中文名 || c.工具) + (c.被拒 ? "·被拒" : ""),
        类: "tool" + (c.被拒 ? " rej" : ""), 跳: `blk-${tk}-tool${ci}`});
    });
  });
  let 分段 = "";
  s.轮.forEach((t, i) => {
    if (!t.起止 || t.起止[0] == null) return;
    if (i > 0) 分段 += `<div class="tsep" style="left:${位(t.起止[0])}"></div>`;
    分段 += `<div class="tlab" style="left:calc(${位(t.起止[0])} + 3px)">第 ${t.序数} 轮</div>`;
  });
  const 道图 = 道.map((项) => !项 ? "" : `<div class="lane">` + 项.map((x) =>
    `<button class="seg ${x.类} jump" data-jump="${x.跳}" data-frac="${(x.止 - x.起) / 跨}"
       data-left="${位(x.起)}" data-label="${esc(x.名)}" data-spent="${esc(x.名 + " · " + 秒(x.止 - x.起))}"
       style="left:${位(x.起)};width:${(x.止 - x.起) / 跨 * 100}%"
       title="${esc(x.名 + "，耗时 " + 秒(x.止 - x.起))}"><span class="lbl">${esc(x.名)}</span></button>`).join("") + `</div>`).join("");
  return `<details class="tl"><summary>这个阶段这几轮的时间条（点开看它们在真实时间上的位置）</summary>
    <div class="in"><div class="ruler">${刻度}</div><div class="lane" style="height:14px">${分段}</div>${道图}
    <p class="tlnote">横轴是后端收到事件的时刻，位置与长度一律按它算。一次工具执行往往只有几毫秒，按真实比例画出来细到看不见，所以太窄的段被拉宽并打上斜纹，真实耗时写在段的旁边，那时宽度不代表耗时。点一段就跳到下面对应的那一块。</p></div></details>`;
}

/* ───── 第二级：这个阶段里的对话 ───── */
function 插话HTML(x) {
  const 键 = 登记({标题: "用户在运行中途说的一句话",
    概念: [["pi 的概念", "用户消息（user message）"], ["pi 的概念", x.种类]],
    这是什么: "这是消息列表里的一条消息，观测台把它原样显示出来。" + x.说明,
    字段: [["原文", `<div style="white-space:pre-wrap">${esc(x.原文)}</div>`],
      ["种类", esc(x.种类)],
      ["会话条目编号", `<code>${esc(x.条目编号 || "未知")}</code>`],
      ["收到时刻", esc(x.时刻 || "未知")]], 链接: ""});
  return `<div class="steer" data-arrow="用户>执行者" data-k="${键}"${x.条目编号 ? ` id="msg-${esc(x.条目编号)}"` : ""}>
    <div class="w">用户 → 执行者　这次运行进行到一半时说的，pi 的概念叫${esc(x.种类)}</div>
    <div class="x">${esc(x.原文)}</div><div class="n">${esc(x.说明)}</div></div>`;
}
function lv2HTML(s) {
  if (s.类型 === "用户发话") {
    const 键 = 登记({标题: "用户说的一句话",
      概念: [["pi 的概念", "用户消息（user message）"], ["pi 的概念", "提示（prompt）"]],
      这是什么: "这是消息列表里的一条消息，观测台把它原样显示出来。pi 收到它以后开始一次运行。",
      字段: [["原文", `<div style="white-space:pre-wrap">${esc(s.全文)}</div>`],
        ["来源", esc(s.消息来源 || "未知")],
        ["来源的依据", esc(s.消息来源的依据 || "未知")],
        ["会话条目编号", `<code>${esc(s.条目编号 || "未知")}</code>`],
        ["时刻", esc(s.时刻)]], 链接: ""});
    return `<div class="lv2" hidden><div class="saylab">用户这一句话的全文</div>
      <div class="say human" data-k="${键}" data-arrow="用户>执行者"${s.条目编号 ? ` id="msg-${esc(s.条目编号)}"` : ""}>${esc(s.全文)}
        <span class="src">来源：${esc(s.消息来源 || "未知")}　会话条目 <code>${esc(s.条目编号 || "未知")}</code></span></div></div>`;
  }
  const 触发 = (s.触发 && !s.触发.紧挨着吗)
    ? `<button class="trig jump" data-jump="${esc(s.触发.编号)}">由${esc(s.触发.谁)}的这句话触发：「${esc(String(s.触发.原文).slice(0, 40))}${String(s.触发.原文).length > 40 ? "…" : ""}」（点一下跳回那句话）</button>`
    : "";
  const key0 = s.编号;
  return `<div class="lv2" hidden>
    ${触发}
    <div class="tlwrap" hidden>${时间条(s, key0)}</div>
    ${s.轮.map((t) => {
      const key = `${key0}-${t.序数}`;
      const 改动 = [];
      t.调用.forEach((c, ci) => {
        if (c.被拒 || !c.改动.length) return;
        c.改动.forEach((b) => 改动.push(改动块(b, `${key}-${ci}`, c.编号)));
      });
      const 没写入 = t.调用.filter((c) => (c.被拒 || !c.改动.length) && !(c.回复 && !c.回复.被拒)).map((c) =>
        `<div class="didrow ${c.被拒 ? "rej" : ""}"><div class="k">${esc(c.中文名 || c.工具)}</div>
          <div><div class="arg">${esc(c.参数摘要)}</div>
          <div class="res">${c.被拒 ? "这次调用被工具拒绝了。" : ""}${esc(c.结果摘要)}</div>
          ${c.对不上 ? `<div class="res" style="color:var(--bad)">${esc(c.对不上)}</div>` : ""}</div></div>`).join("");
      const 消息 = (t.正文 || "").trim() ? (() => {
        const 谁 = s.参与者, 听 = s.听 || (谁 === "执行者" ? "用户" : "执行者");
        const r = t.回复;
        const 键 = 登记(r ? {
          标题: `${谁}经「回复」工具说的话`, 概念: [["pi 的概念", "工具调用（tool call）"], ["业务领域的概念", "回复"]],
          这是什么: `这是第 ${t.运行序号} 次运行第 ${t.序数} 轮里执行者调用「回复」工具说的话。执行者对用户说的每一句话都经这个工具发出；下面排好的几行与终端界面、终端客户端显示的是同一份（agent 的排版函数）。`,
          字段: [["排好的样子", r.排版 ? `<pre style="white-space:pre-wrap">${esc(r.排版.join("\n"))}</pre>` : "调不动 agent 的排版函数（本机要有 node），只显示成文的话。"],
            ["成文的话", `<div style="white-space:pre-wrap">${esc(r.成文的话)}</div>`],
            ["是不是降级放行", r.降级放行 ? esc(r.降级放行说明) : "不是，按结构发出的。"],
            ["会话条目编号", r.会话条目编号 ? `<code>${esc(r.会话条目编号)}</code>` : "工具没有报出来"],
            ["出自哪一轮", `第 ${t.运行序号} 次运行的第 ${t.序数} 轮`]], 链接: ""} : {
          标题: `${谁}发出的一条消息`, 概念: [["pi 的概念", "助手消息（assistant message）"]],
          这是什么: `这是第 ${t.运行序号} 次运行第 ${t.序数} 轮的模型应答里的正文，pi 把它追加进消息列表，也发给了${听}。`,
          字段: [["正文", `<div style="white-space:pre-wrap">${esc(t.正文)}</div>`],
            ["出自哪一轮", `第 ${t.运行序号} 次运行的第 ${t.序数} 轮`]], 链接: ""});
        // 卡片只放告知与主行为：成文的话已经在上面的气泡里，标题行也不重复。
        const 成文处 = r && r.排版 ? r.排版.findIndex((l) => /^\s*成文的话：/.test(l)) : -1;
        const 卡片行 = r && r.排版 ? (成文处 < 0 ? r.排版 : r.排版.slice(0, 成文处)).filter((l) => !/^执行者（经回复工具）/.test(l)) : [];
        const 卡片 = r && (r.告知.length || r.主行为) && 卡片行.length
          ? `<pre class="replycard" style="white-space:pre-wrap;margin:4px 0 0">${esc(卡片行.join("\n"))}</pre>` : "";
        const 降级 = r && r.降级放行 ? `<div class="sub" style="color:var(--bad)">${esc(r.降级放行说明)}</div>` : "";
        return `<div class="saylab">${esc(谁)}在这一轮${r ? "经「回复」工具说的话" : "发出的一条消息"}</div>
          <div class="say" data-k="${键}" data-arrow="${esc(谁)}>${esc(听)}">${esc(t.正文)}</div>${卡片}${降级}
          <button class="from jump" data-jump="lv3-${esc(key)}">出自第 ${t.序数} 轮的${r ? "「回复」工具调用" : "模型应答"}</button>`;
      })() : "";
      return `<div class="turnblk" id="turn-${t.运行序号}-${t.序数}">
        ${(t.插话 || []).map(插话HTML).join("")}
        <div class="turnhead"><b>第 ${t.序数} 轮</b>
          <span>这一轮花了 ${Number(t.耗时秒 || 0).toFixed(2)} 秒</span>
          <button data-lv3="${esc(key)}">看这一轮的机器细节</button></div>
        ${(t.出错说明 || []).map((x) => `<p class="errnote" style="color:var(--bad);margin:4px 0">这一轮的模型请求出错了，模型既没有说话，也没有调用工具。出错的说明是：${esc(x)}</p>`).join("")}
        ${t.自动重试说明 ? `<p class="retrynote">${esc(t.自动重试说明)}</p>` : ""}
        <span id="lv3-${esc(key)}"></span>
        ${一轮机器层(t, key)}
        ${改动.join("")}${没写入}${消息}
      </div>`;
    }).join("")}
  </div>`;
}

/* ───── 画一整个区：窄带的列头 ＋ 阶段流程 ───── */
function 画区(区, stages, 列, 提示) {
  区.列 = 列;
  区.style.setProperty("--band", (列.length * 道宽) + "px");
  const maxDur = Math.max(1, ...stages.map((s) => (s.模型耗时秒 || 0) + (s.工具耗时秒 || 0)));
  const html = stages.map((s, idx) => stageHTML(s, idx, maxDur, 列)).join("");
  区.innerHTML = `<div class="bandhead">
      <div></div>
      <div class="names">${列.map((n, i) => `<span class="nm" style="left:${i * 道宽 + 道宽 / 2}px;top:${(i % 2) * 17}px;background:${人物[n].色}">${esc(人物[n].名)}</span>`).join("")}</div>
      <div class="hint">${提示 ? esc(提示) : ""}</div>
    </div>
    <div class="stream"><div class="lines">${列.map((n, i) => `<i class="ll" style="left:${i * 道宽 + 道宽 / 2}px"></i>`).join("")}</div><div class="marks"></div>${html}</div>`;
  wireFlow(区, stages);
  applyZoom(区);
}
function 道位(列, 名) { const i = 列.indexOf(名); return (i < 0 ? 0 : i) * 道宽 + 道宽 / 2; }

function stageHTML(s, idx, maxDur, 列) {
  const 坏 = (s.类型 === "异常" || s.结果 === "失败" || s.结果 === "被拒") ? " bad" : "";
  const think = Math.round(70 * ((s.模型耗时秒 || 0) / maxDur));
  const run = Math.max(s.工具耗时秒 ? 1 : 0, Math.round(70 * ((s.工具耗时秒 || 0) / maxDur)));
  const mark = s.被拒次数 ? `<span class="mark no">有 ${s.被拒次数} 次调用被工具拒绝</span>` : "";
  const fix = s.改正线索
    ? `<p class="fixline"><button class="jump" data-jump="turn-${s.改正线索.运行序号}-${s.改正线索.轮号 + 1}">后来在第 ${s.改正线索.运行序号} 次运行的第 ${s.改正线索.轮号 + 1} 轮改对了。</button></p>`
    : "";
  const sub = s.小步 || [], shown = sub.slice(0, 6), rest = sub.slice(6);
  // 评审者的嵌套阶段、评审与确认的记录：组件结构上留好位置，数据里有才画。
  const 嵌套 = s.嵌套 ? `<div class="nest p-${esc(s.嵌套.参与者)}"><div class="cap">${esc(s.嵌套.说明)}</div>${
    s.嵌套.阶段.map((x, i) => stageHTML(x, 1000 + i, maxDur, 列)).join("")}</div>` : "";
  return `<article class="stage p-${esc(s.参与者)}${坏}" id="${esc(s.编号)}" data-who="${esc(s.参与者)}"
      data-idx="${idx}" data-name="${esc(s.名称)}" data-life="${s.类型 === "用户发话" ? "说话" : "阶段"}"
      ${s.类型 === "用户发话" ? 'data-arrow="用户>执行者"' : ""} style="--x:${道位(列, s.参与者)}px">
    <div class="t">${esc(s.时刻)}</div>
    <div class="sp">${头像(s.参与者)}</div>
    <div class="c">
      ${s.启动说明 ? `<p class="boot" data-mark="boot">${esc(s.启动说明)}</p>` : ""}
      <button class="srow"><span class="sname"><i class="chev"></i><b>${esc(s.名称)}</b>${mark}
        ${(s.模型耗时秒 != null || s.工具耗时秒 != null) ? `<span class="sdur">
          <span class="bar"><i class="think" style="width:${think}px"></i><i class="run" style="width:${run}px"></i></span>
          模型在想 ${s.模型耗时秒 || 0} 秒 · 工具在跑 ${s.工具耗时秒 || 0} 秒</span>` : ""}</span>
        <p class="stext">${esc(s.一句话)}</p></button>
      ${fix}
      ${sub.length ? `<ul class="substeps">${shown.map(subLI).join("")}
        ${rest.length ? `<li class="more" data-more="${idx}">还有 ${rest.length} 个小步，点开看</li>` : ""}</ul>` : ""}
      ${(s.角色 === "写入" && cur.指导 && cur.指导.length && firstWrite(idx)) ? guideHTML(cur.指导) : ""}
      ${lv2HTML(s)}
      ${嵌套}
    </div>
  </article>`;
}
function firstWrite(idx) {
  return cur.阶段.findIndex((x) => x.角色 === "写入") === idx;
}
function subLI(x) {
  return `<li data-items='${esc(JSON.stringify(x.条目 || []))}'>${esc(x.文字)}${
    x.耗时秒 != null ? ` <span style="color:var(--ink3);font-family:var(--mono);font-size:11px">${x.耗时秒} 秒</span>` : ""}</li>`;
}
function guideHTML(g) {
  return `<details class="guidebox"><summary>执行者在动手写交付物之前读过的指导：一共 ${g.length} 份</summary><div class="in">
   <table><tbody>${g.map((x) => `<tr><td style="white-space:nowrap;color:var(--ink3)">${esc(x.种类)}</td>
     <td style="font-family:var(--mono);font-size:11.5px">${esc(x.文件)}</td>
     <td style="white-space:nowrap;color:var(--ink3)">第 ${x.运行序号} 次运行 ${esc(x.时刻)} 读的</td>
     <td style="color:var(--ink3)">内容摘要值：${esc(x.摘要值)}</td></tr>`).join("")}</tbody></table>
   <p style="margin:8px 0 0;color:var(--ink2)">这一块只摆出执行者当时读过哪些指导，不替它解释为什么这样做。
   <button style="color:var(--human);border-bottom:1px dashed var(--human)" data-openskill="1">把执行方法的原文打开看</button></p>
  </div></details>`;
}

function wireFlow(区, stages) {
  区.querySelectorAll(".stage").forEach((st) => {
    const btn = $(".srow", st); if (!btn) return;
    btn.onclick = () => {
      const box = $(":scope > .c > .lv2", st);
      if (box) { box.hidden = !box.hidden; st.classList.toggle("open", !box.hidden); }
      区.querySelectorAll(".stage").forEach((x) => x.classList.remove("sel"));
      st.classList.add("sel");
      const idx = +st.dataset.idx;
      if (stages[idx]) 高亮条目(stages[idx].条目 || []);
      布局();
    };
  });
  区.querySelectorAll("[data-lv3]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const box = 区.querySelector(`[data-lv3box="${b.dataset.lv3}"]`);
      box.hidden = !box.hidden;
      b.textContent = box.hidden ? "看这一轮的机器细节" : "收起这一轮的机器细节";
      const wrap = b.closest(".lv2") && b.closest(".lv2").querySelector(".tlwrap");
      if (wrap && !box.hidden) wrap.hidden = false;
      布局();
    };
  });
  区.querySelectorAll("[data-openf]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const bag = 区.querySelector(`[data-allf="${b.dataset.openf}"]`);
      if (bag) bag.hidden = false;
      b.remove(); 布局();
    };
  });
  区.querySelectorAll("[data-opentoggle]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const op = 区.querySelector(`.op[data-opkey="${b.dataset.opentoggle}"]`);
      if (!op) return;
      op.hidden = !op.hidden;
      b.setAttribute("aria-expanded", String(!op.hidden));
      布局();
    };
  });
  区.querySelectorAll("[data-more]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const s = stages[+b.dataset.more];
      b.parentElement.innerHTML = s.小步.map(subLI).join("");
      wireSubsteps(区); 布局();
    };
  });
  wireSubsteps(区);
}
function wireSubsteps(区) {
  区.querySelectorAll(".substeps li[data-items]").forEach((li) => {
    li.onclick = (e) => {
      e.stopPropagation();
      区.querySelectorAll(".substeps li").forEach((x) => x.classList.remove("sel")); li.classList.add("sel");
      高亮条目(JSON.parse(li.dataset.items));
    };
  });
}

/* ───── 放大级别 ───── */
function applyZoom(区) {
  区.querySelectorAll(".stage").forEach((st) => {
    const box = $(":scope > .c > .lv2", st);
    if (box) { box.hidden = zoom < 2; st.classList.toggle("open", zoom >= 2); }
  });
  区.querySelectorAll(".lv3").forEach((b) => b.hidden = zoom < 3);
  区.querySelectorAll(".tlwrap").forEach((b) => b.hidden = zoom < 3);
  区.querySelectorAll("[data-lv3]").forEach((b) => b.textContent = zoom >= 3 ? "收起这一轮的机器细节" : "看这一轮的机器细节");
}

/* ───── 末端状态 ───── */
function nowHTML(t) {
  if (!t.有没有说话)
    return `<div class="now"><b>现在的状态：</b>${esc(t.引子)}<p class="note">${esc(t.补充)}</p></div>`;
  // 原文超过六行（按换行数与字数估）才折起来，短的直接显示全文。
  const 长 = String(t.原文).split("\n").length > 6 || String(t.原文).length > 300;
  return `<div class="now"><b>现在的状态：</b>${esc(t.引子)}
    <div class="full${长 ? "" : " all"}">${esc(t.原文)}</div>
    ${长 ? `<button class="fold">全文比较长，点开看完</button>` : ""}
    <p class="note">${esc(t.补充)}</p></div>`;
}

/* ───── 看板 ───── */
/* 完成条件按集合分组，保持后端给的先后次序 */
function 按集合分组(条件) {
  const 组 = new Map();
  for (const c of 条件) {
    if (!组.has(c.集合)) 组.set(c.集合, []);
    组.get(c.集合).push(c);
  }
  return [...组];
}

function renderBoard() {
  const b = cur.看板, pane = $("#pane-board");
  if (!b) {
    pane.innerHTML = `<div class="empty">${cur.范围 === "会话" ? "这条会话所在的任务目录里还没有任务记录" : "这个任务没有读到库"}，所以没有交付物，也没有任何条目。
    任务定义里写的完成条件一条也无从核对——完成条件是跟着任务走的，没有任务就没有它们。</div>`;
    return;
  }
  const 概括 = b.概括 ? esc(b.概括) : `这份交付物现在有 <b>${b.总条目数}</b> 个条目：${
    b.集合.map((s) => `${esc(s.名称)} ${s.现有条目数} 个`).join("、")}。${esc(b.完成条件概括 || "")}`;
  // 三种状态：✓ 已满足，○ 还差，– 暂无条目（集合为空，这一条暂不需要核对）；？ 是这次核对不了
  const 勾 = (c) => ({ met: "✓", unmet: "○", empty: "–" })[c.状态] || "？";
  pane.innerHTML = `
   <p class="bsum">${概括}</p>
   <div class="dod"><div class="h">完成条件逐条核对</div>${
     b.完成条件.length
       ? `${按集合分组(b.完成条件).map(([集合, 条]) => `<div class="set">${esc(集合)}</div>
          <ul>${条.map((c) => `<li class="${c.状态 === "met" ? "yes" : c.状态 === "empty" ? "na" : "no"}"><span class="tick">${勾(c)}</span>
           <span><b>${esc(c.条件)}</b>：${esc(c.说明)}</span></li>`).join("")}</ul>`).join("")}
          ${b.完成条件是怎么核对的 ? `<div class="plain" style="color:var(--ink3);padding-top:0">${esc(b.完成条件是怎么核对的)}</div>` : ""}`
       : `<div class="plain">${esc(b.完成条件说明)}</div>`}</div>
   ${b.集合.map(setHTML).join("")}
   <div class="legend">
     <span><i class="cell"></i>还没有这类记录</span><span><i class="cell ok"></i>评审通过</span>
     <span><i class="cell done"></i>用户已确认</span>
     <span>两个小格子从左到右分别是评审与用户确认。</span></div>`;
  pane.querySelectorAll(".item").forEach((el) => {
    el.onclick = () => 跳到条目(el.dataset.code, el);
  });
}
function setHTML(s) {
  return `<div class="cset"><div class="ch2">${esc(s.名称)} <span class="n">共 ${s.现有条目数} 个，${esc(s.前缀.indexOf("没有") === 0 ? s.前缀 : "编号前缀是 " + s.前缀)}</span></div>
   ${s.条目.map((it) => `<div class="item${it.已删除 ? " gone" : ""}" data-code="${esc(it.编号)}">
     <span class="code">${esc(it.编号)}</span>
     <span class="ttl" title="${esc(it.标题)}">${esc(it.标题)}</span>
     <span class="meta" title="${it.已删除 ? `在第 ${it.在第几次修订删除} 次修订里删掉了` : ""}">${it.已删除 ? "已删除" : `第 ${it.版本} 版`}</span>
     <span class="meta">${it.来源条数} 条来源${it.状态字段 ? "｜" + esc(it.状态字段) : ""}</span>
     <i class="cell ${esc(it.评审格 || "")}" title="${esc(it.评审)}"></i><i class="cell ${esc(it.确认格 || "")}" title="${esc(it.确认)}"></i>
   </div>`).join("")}</div>`;
}

/* ───── 知识的使用 ───── */
function renderKnow() {
  const k = cur.知识仓库, pane = $("#pane-know");
  if (!k) { pane.innerHTML = `<div class="empty">没有读到这个任务目录的知识仓库。</div>`; return; }
  const groups = {};
  k.文件.forEach((f) => { (groups[f.种类] = groups[f.种类] || []).push(f); });
  const 类 = (u) => u === "执行者按需读过" ? "read" : u === "工具读过" ? "tool" : u === "启动时放进了系统提示" ? "prompt" : "cold";
  pane.innerHTML = `
    <p class="bsum">${esc(k.概括)}</p>
    <p class="knote">${esc(k.skill)}</p>
    <p class="knote">${esc(k.上下文文件)}</p>
    <p class="knote">${esc(k.来源说明)}</p>
    ${Object.entries(groups).map(([kind, rows]) => `
      <div class="kgrp"><div class="h">${esc(kind)}</div>
      ${rows.map((r) => `<div class="krow" data-stage="${esc(r.阶段 || "")}">
        <div><div class="f">${esc(r.文件)}</div><div class="d">${esc(r.一句话)}</div>
          <div class="d">内容摘要值：<span class="mono">${esc(r.摘要值)}</span>${r.变过吗 ? "（几次启动之间变过）" : ""}</div></div>
        <span class="use ${类(r.用法)}">${esc(r.用法)}</span>
      </div>`).join("")}</div>`).join("")}
    <p class="knote">这一栏按事实分四种：「执行者按需读过」是执行者自己调用 read 读的；「工具读过」是某个工具在运行时自己打开的，执行者并没有读到它的内容；「启动时放进了系统提示」是 pi 启动时放进去的（skill 只放名字与描述，上下文文件整份放）；「这次没有用到」是从头到尾没有任何人打开过。点一行跳到读它的那个阶段。</p>`;
  pane.querySelectorAll(".krow").forEach((el) => {
    el.onclick = () => {
      pane.querySelectorAll(".krow").forEach((x) => x.classList.remove("sel")); el.classList.add("sel");
      const name = el.dataset.stage; if (!name) return;
      const st = [...$("#tp-flow").querySelectorAll(".stage")].find((s) => s.dataset.name === name);
      if (st) {
        host.querySelectorAll("#tp-flow .stage").forEach((x) => x.classList.remove("sel"));
        st.classList.add("sel"); st.scrollIntoView({block: "center"});
      }
    };
  });
}

/* ───── 流程与看板的双向联动 ───── */
function 高亮条目(codes) {
  const set = new Set(codes || []);
  host.querySelectorAll("#pane-board .item").forEach((el) => el.classList.toggle("hl", set.has(el.dataset.code)));
}
function 找条目(code) {
  if (!cur.看板) return null;
  for (const s of cur.看板.集合) {
    const it = s.条目.find((x) => x.编号 === code);
    if (it) return {集合: s.名称, 条目: it};
  }
  return null;
}
function 跳到条目(code, row) {
  host.querySelectorAll("#pane-board .item").forEach((x) => x.classList.remove("sel", "hl"));
  if (row) row.classList.add("sel");
  const flow = $("#tp-flow");
  let target = null;
  flow.querySelectorAll(".stage").forEach((st) => {
    const s = cur.阶段[+st.dataset.idx];
    if (!s) return;
    const hit = (s.条目 || []).includes(code);
    st.classList.toggle("sel", hit);
    if (!hit) return;
    const box = $(":scope > .c > .lv2", st); if (box) { box.hidden = false; st.classList.add("open"); }
    const ops = [...st.querySelectorAll(".op")].filter((o) => o.dataset.code === code);
    ops.forEach((op) => {
      op.hidden = false;
      const b = st.querySelector(`[data-opentoggle="${op.dataset.opkey}"]`);
      if (b) b.setAttribute("aria-expanded", "true");
    });
    if (ops.length && !target) target = ops[0].closest(".chgblock") || ops[0];
  });
  打开条目(code);
  布局();
  if (target) {
    target.classList.add("flash");
    setTimeout(() => target.scrollIntoView({block: "center"}), 220);
    setTimeout(() => target.classList.remove("flash"), 3000);
  }
}

/* ───── 条目抽屉：可以切到它的其他版本 ───── */
function 打开条目(code, 想看的版本) {
  const got = 找条目(code);
  if (!got) {
    开抽屉(`条目 ${code}`, `<p class="hint">这个编号不在右边的交付物看板里，看板上取不到它的历次版本。
      它出现在这一次的改动里，改前改后在左边流程的那一块上。</p>`);
    return;
  }
  const 版本 = got.条目.全部版本;
  const 选 = 想看的版本 != null ? 版本.find((v) => v.版本号 === 想看的版本) : 版本[版本.length - 1];
  const 由 = 选.由第几次修订产生 != null ? `由第 ${选.由第几次修订产生} 次修订产生` : "这是这个条目建库时的初值，不是任何一次修订产生的";
  开抽屉(`条目 ${code}`, `
    <p class="hint">这个条目属于集合「${esc(got.集合)}」，现在一共有 ${版本.length} 版${got.条目.已删除 ? `，已在第 ${got.条目.在第几次修订删除} 次修订删掉` : ""}。下面默认显示最新的那一版，可以切到别的版本。</p>
    <div class="vtabs">${版本.map((v) => `<button data-ver="${v.版本号}" data-code="${esc(code)}"
      aria-pressed="${v === 选 ? "true" : "false"}">第 ${v.版本号} 版</button>`).join("")}</div>
    <p class="vmeta">第 ${选.版本号} 版：${由}${选.写入者 ? `，写入者是${esc(选.写入者)}` : ""}。
      评审：${esc(选.评审 || "还没有这类记录")}。用户确认：${esc(选.确认 || "还没有这类记录")}。</p>
    ${got.条目.说明 ? `<p class="vmeta">这个字段的说明：${esc(got.条目.说明)}</p>` : ""}
    <div class="ftable">${选.字段.map((f) => `<div class="frow"><div class="fn">${esc(f.名)}</div><div>${画值(f)}</div></div>`).join("")}</div>
    ${(选.来源 || []).length ? `<h4 style="font:600 13px var(--sans);margin:14px 0 4px">这一版的来源一共 ${选.来源.length} 条</h4>${
      选.来源.map((s) => 来源HTML(s, 6, 12.5)).join("")}` : `<p class="none">这一版没有登记来源。</p>`}`);
}

/* ───── 抽屉 ───── */
function 开抽屉(title, html) {
  $("#tp-dbody").innerHTML = html;
  $("#tp-drawer").classList.add("on"); $("#tp-drawer").setAttribute("aria-hidden", "false");
  $("#tp-scrim").classList.add("on");
  $("#tp-dbody").scrollTop = 0;
}
function 关抽屉() {
  if (!host) return;
  $("#tp-drawer").classList.remove("on"); $("#tp-drawer").setAttribute("aria-hidden", "true");
  $("#tp-scrim").classList.remove("on");
}
function 链接说明(o) {
  const lf = cur.Langfuse || {};
  if (o.链接) return `<a href="${esc(o.链接)}" target="_blank" rel="noopener">在 Langfuse 里打开这一段</a>`;
  if (o.第一级) {
    const why = (lf.状态 || {}).有没有配密钥 === false ? (lf.状态 || {}).说明 : (lf.第二级链接的说明 || (lf.状态 || {}).说明 || "");
    return `<a href="${esc(o.第一级)}" target="_blank" rel="noopener">在 Langfuse 里打开这一次运行的运行记录</a>
      <small>这里只给到第一级：直达这次运行的那条运行记录，到了那里再找这一段。直达这一段的第二级链接做不出来，原因是：${esc(why)}</small>`;
  }
  return `<span style="color:var(--ink3)">这一段没有 Langfuse 链接：它是业务领域里的记录，不在 Langfuse 里；或者这一次没有给 Langfuse 的服务地址与项目标识。</span>`;
}
function 显示细节(键) {
  const o = 库[键]; if (!o) return;
  const 概念 = (o.概念 || []).map(([类, 词]) =>
    `<span class="tag ${类.indexOf("pi") === 0 ? "pi" : 类.indexOf("业务") === 0 ? "dom" : ""}">${esc(类)}：${esc(词)}</span>`).join("");
  开抽屉(o.标题, `
    <h3>${esc(o.标题)}</h3>
    <div class="concept">${概念}</div>
    <p class="what">${esc(o.这是什么)}</p>
    <dl>${o.字段.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>
    <div class="lfbox">${链接说明(o)}
      <small>用词对应：Langfuse 里的「Pi Turn」是一条运行记录，对应 pi 的一次运行；「LLM Call」是一条生成记录，对应一次模型请求；「Tool」是一条工具记录，对应一次工具调用。</small></div>`);
}

/* ───── 跳转 ───── */
function 跳到(编号) {
  const 目标 = document.getElementById(编号);
  if (!目标) return;
  let st = 目标.closest(".stage");
  while (st) {
    const box = $(":scope > .c > .lv2", st);
    if (box) { box.hidden = false; st.classList.add("open"); }
    st = st.parentElement ? st.parentElement.closest(".stage") : null;
  }
  const op = 目标.closest(".op[hidden]");
  if (op) op.hidden = false;
  const lv3 = 目标.closest(".lv3");
  if (lv3) {
    lv3.hidden = false;
    const b = host.querySelector(`[data-lv3="${lv3.dataset.lv3box}"]`);
    if (b) b.textContent = "收起这一轮的机器细节";
  }
  const wrap = 目标.closest(".tlwrap"); if (wrap) wrap.hidden = false;
  let d = 目标.closest("details"); while (d) { d.open = true; d = d.parentElement && d.parentElement.closest("details"); }
  布局();
  目标.scrollIntoView({block: "center"});
  目标.classList.add("flash");
  setTimeout(() => 目标.classList.remove("flash"), 2200);
}

function onClick(e) {
  if (e.target.closest("[data-openskill]")) {
    e.stopPropagation();
    开抽屉("执行方法的原文",
      `<h3>执行方法的原文</h3>
       <p class="hint">这是观测台从任务目录的 ${esc(cur.执行方法.路径)} 现在读进来的全文，不一定是执行者当时读到的那一版；当时那一版的摘要值写在上面的表里。</p>
       <pre class="skill">${esc(cur.执行方法.原文)}</pre>`);
    return;
  }
  const f = e.target.closest(".now .fold");
  if (f) {
    const box = f.parentElement.querySelector(".full");
    box.classList.toggle("all");
    f.textContent = box.classList.contains("all") ? "收起" : "全文比较长，点开看完";
    return;
  }
  const ver = e.target.closest(".vtabs button");
  if (ver) { e.stopPropagation(); 打开条目(ver.dataset.code, +ver.dataset.ver); return; }
  const ref = e.target.closest(".ref");
  if (ref) { e.stopPropagation(); 打开条目(ref.dataset.code); return; }
  const jump = e.target.closest(".jump, [data-jump]");
  if (jump) { e.preventDefault(); e.stopPropagation(); 跳到(jump.dataset.jump); return; }
  const t = e.target.closest("[data-k]");
  if (!t) return;
  e.stopPropagation();
  host.querySelectorAll(".sel").forEach((x) => { if (!x.classList.contains("stage") && !x.classList.contains("item")) x.classList.remove("sel"); });
  t.classList.add("sel");
  显示细节(Number(t.dataset.k));
}

/* ───── 窄带上的激活段、连线、节点 ───── */
function 看得见(el) {
  return !!el.getClientRects().length;
}
function 布局() {
  if (!host || !host.isConnected) return;
  host.querySelectorAll(".区").forEach((区) => {
    const 列 = 区.列 || ["用户", "执行者"];
    const 流 = 区.querySelector(".stream"), 标 = 区.querySelector(".marks");
    if (!流 || !标) return;
    const 基 = 流.getBoundingClientRect();
    const X = (名) => 道位(列, 名);
    let h = "";
    区.querySelectorAll(".stage").forEach((a) => {
      const av = a.querySelector(":scope > .sp > .av");
      if (!av || !看得见(a)) return;
      const p = 人物[a.dataset.who]; if (!p) return;
      const r = a.getBoundingClientRect(), ar = av.getBoundingClientRect();
      const 上 = ar.top - 基.top + 3;
      const 下 = a.dataset.life === "阶段" ? r.bottom - 基.top - 6 : 上 + 20;
      h += `<i class="mk-act" style="left:${X(a.dataset.who) - 4.5}px;top:${上}px;height:${Math.max(下 - 上, 12)}px;--c:${p.色};--w:${p.底}"></i>`;
      if (a.closest(".nest"))
        h += `<i class="mk-av ${p.形}" style="left:${X(a.dataset.who)}px;top:${ar.top - 基.top}px;--c:${p.色}">${p.字}</i>`;
    });
    区.querySelectorAll("[data-arrow]").forEach((el) => {
      const [从, 到] = el.dataset.arrow.split(">");
      if (!人物[从] || !人物[到] || 列.indexOf(从) < 0 || 列.indexOf(到) < 0) return;
      if (!看得见(el)) return;
      const 锚 = el.classList.contains("stage") ? el.querySelector(":scope > .sp > .av") : el;
      const rr = 锚 ? 锚.getBoundingClientRect() : el.getBoundingClientRect();
      if (!rr.height) return;
      const y = rr.top - 基.top + Math.min(rr.height / 2, 12);
      const a = X(从), b = X(到);
      if (a === b) return;
      h += `<i class="mk-arw ${b > a ? "r" : "l"}" style="left:${Math.min(a, b)}px;width:${Math.abs(b - a)}px;top:${y}px;--c:${人物[从].色}"></i>`;
    });
    区.querySelectorAll('[data-mark="boot"]').forEach((el) => {
      if (!看得见(el)) return;
      const who = el.closest(".stage").dataset.who, r = el.getBoundingClientRect();
      h += `<i class="mk-nd" style="left:${X(who)}px;top:${r.top - 基.top + r.height / 2}px;--c:${人物[who].色}"></i>`;
    });
    区.querySelectorAll('[data-mark="mile"]').forEach((el) => {
      if (!看得见(el)) return;
      const st = el.closest(".stage"); if (!st) return;
      const r = el.getBoundingClientRect();
      h += `<i class="mk-mile" style="left:${X(st.dataset.who) + 10}px;top:${r.top - 基.top + r.height / 2}px"></i>`;
    });
    标.innerHTML = h;
  });
  收窄的段();
}
function 收窄的段() {
  host.querySelectorAll(".segout").forEach((n) => n.remove());
  host.querySelectorAll(".tl .lane").forEach((lane) => {
    const W = lane.clientWidth; if (!W) return;
    lane.querySelectorAll(".seg").forEach((seg) => {
      const 真宽 = Number(seg.dataset.frac) * W, 窄 = 真宽 < 44;
      seg.classList.toggle("pad", 窄);
      if (窄) seg.style.width = "14px";
      const lbl = seg.querySelector(".lbl");
      if (lbl) lbl.textContent = 窄 ? "" : seg.dataset.label;
      if (!窄) return;
      const out = document.createElement("div");
      out.className = "segout"; out.textContent = seg.dataset.spent;
      lane.appendChild(out);
      const 左 = parseFloat(seg.dataset.left) || 0;
      out.style.left = (左 / 100 * W + 20 + out.offsetWidth > W)
        ? `calc(${seg.dataset.left} - 6px - ${out.offsetWidth}px)`
        : `calc(${seg.dataset.left} + 20px)`;
      // 几个窄段挨得近时，说明文字会叠在一起，逐条往下错开一行
      const 我 = out.getBoundingClientRect();
      let 层 = 0;
      lane.querySelectorAll(".segout").forEach((前) => {
        if (前 === out) return;
        const r = 前.getBoundingClientRect();
        if (!(我.right < r.left - 4 || 我.left > r.right + 4))
          层 = Math.max(层, (Number(前.dataset.层) || 0) + 1);
      });
      out.dataset.层 = 层;
      out.style.top = (1 + 层 * 15) + "px";
      lane.style.height = Math.max(18, 18 + 层 * 15) + "px";
    });
  });
}

/* ───── 总装 ───── */
const SKELETON = `
  <div id="tp-head"></div>
  <div id="tp-alerts"></div>
  <div class="main">
    <div class="col">
      <div class="flowbar">
        <h2 class="ch">任务的完整流程 <span class="n" id="tp-flowcount"></span></h2>
        <div class="people" id="tp-people"></div>
        <span class="zoom" id="tp-zoom">
          <button data-z="1">只看阶段</button>
          <button data-z="2">阶段加对话</button>
          <button data-z="3">全部细节</button>
        </span>
      </div>
      <div class="区" id="tp-flow"></div>
      <div id="tp-now"></div>
      <div id="tp-words"></div>
    </div>
    <div class="col">
      <h2 class="ch">这个任务产出了什么</h2>
      <div class="board">
        <div class="btabs">
          <button data-pane="board" aria-pressed="true">交付物看板</button>
          <button data-pane="know" aria-pressed="false">知识的使用</button>
        </div>
        <div class="bpane" id="pane-board"></div>
        <div class="bpane" id="pane-know" hidden></div>
      </div>
    </div>
  </div>
  <div class="scrim" id="tp-scrim"></div>
  <aside class="drawer" id="tp-drawer" aria-hidden="true">
    <header><h2>检视</h2><button id="tp-dclose">关闭（Esc）</button></header>
    <div class="in" id="tp-dbody"></div>
  </aside>`;

function onKey(e) { if (e.key === "Escape") 关抽屉(); }
let 计时;
function onResize() { clearTimeout(计时); 计时 = setTimeout(布局, 120); }
function onToggle() { requestAnimationFrame(布局); }

/** 把一页数据画进 view。page 是 /api/taskpage/... 返回的那一份。 */
export function renderTaskPage(view, page) {
  cur = page;
  // 这一页自己的「名词说明」里已经讲了数据的来源，顶上那条全站提示在这两页上收起来，把第一屏让给流程。
  document.body.classList.add("tp-on");
  window.addEventListener("hashchange", () => document.body.classList.remove("tp-on"), {once: true});
  库.length = 0;
  view.innerHTML = `<div class="tp">${SKELETON}</div>`;
  host = view.querySelector(".tp");
  renderHead(); renderWords(); renderAlerts(); renderPeople();
  $("#tp-flowcount").textContent = `一共 ${cur.阶段.length} 个阶段`;
  $("#tp-zoom").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(+x.dataset.z === zoom)));
  画区($("#tp-flow"), cur.阶段, ["用户", "执行者"], "");
  // 参与者筛选挪进窄带列头的右半边（原来那里的一句窄带说明挪进了流程区末尾的名词说明），省出一行高度。
  $("#tp-flow .bandhead .hint").appendChild($("#tp-people"));
  $("#tp-now").innerHTML = nowHTML(cur.末端);
  $("#tp-flow").insertAdjacentHTML("afterbegin", 扩展消息HTML(cur.扩展写入的消息 || []));
  renderBoard(); renderKnow();

  $("#tp-zoom").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    zoom = +b.dataset.z;
    $("#tp-zoom").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    host.querySelectorAll(".区").forEach(applyZoom);
    布局();
  });
  $(".btabs").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    host.querySelectorAll(".btabs button").forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    $("#pane-board").hidden = b.dataset.pane !== "board";
    $("#pane-know").hidden = b.dataset.pane !== "know";
  });
  $("#tp-dclose").onclick = 关抽屉; $("#tp-scrim").onclick = 关抽屉;
  host.addEventListener("click", onClick);
  host.addEventListener("toggle", onToggle, true);
  // 这几个监听挂在整个窗口上，换页时先摘掉上一页挂的，免得越挂越多。
  document.removeEventListener("keydown", onKey);
  document.addEventListener("keydown", onKey);
  window.removeEventListener("resize", onResize);
  window.addEventListener("resize", onResize);
  if (observer) observer.disconnect();
  observer = new ResizeObserver(() => 布局());
  observer.observe($("#tp-flow"));
  requestAnimationFrame(布局);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => 布局());
}
