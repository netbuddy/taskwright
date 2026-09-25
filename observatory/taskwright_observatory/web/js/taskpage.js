// 任务页与会话详情页共用的组件：按运行排的流程表，右边是交付物看板与知识的使用。
//
// 流程的单位是运行（pi 的 agent run）：用户的一句话加上助手为它做的全部轮。每次运行一行，未展开时也写出完整的
// 用户的话、助手应答与关键动作（列可隐藏、列宽可拖动）；点开一行看这次运行的各轮，每轮再点开看模型请求与工具调用（机器细节）。用户在网页上的直接操作
// 与扩展写进会话的任务现状按时刻各占一行；跨会话的任务按会话分段。数字、摘要与需要注意都由后端 taskpage.py 算好，
// 这里只按数据画。「需要注意」「交付物看板」「知识的使用」「助手应答」「关键动作」「模型交互」「工具执行」「出口」
// 「变化」都是观测台自己的呈现用语，不是 pi 的概念，见概念对照页。

import { esc } from "./util.js";

let zoom = 1;             // 放大级别跨页面保留：看完一条会话再看另一条，还停在同一档
let cur = null;           // 这一页的数据
let host = null;          // 这一页的根元素
let observer = null;

const $ = (s, r) => (r || host).querySelector(s);
const 秒 = (n) => (n == null ? "未知" : Number(n) < 1 ? Math.round(Number(n) * 1000) + " 毫秒" : Number(n).toFixed(2) + " 秒");
const secs = (s) => s == null ? "未知" : (s >= 60 ? Math.floor(s / 60) + " 分 " + Math.round(s % 60) + " 秒"
  : (s < 1 ? s + " 秒" : Math.round(s) + " 秒"));

/* 检视抽屉里的一条条目录 */
const 库 = [];
const 登记 = (o) => (库.push(o), 库.length - 1);

/* ───── 比对结果的画法：分段由后端算好，这里只上色 ───── */
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
    ? cur.会话.map((s, i) => `<a href="#/session/${encodeURIComponent(s.会话编号)}">第 ${i + 1} 条会话「${esc(s.会话名 || "未命名会话")}」的会话详情</a>`).join("、")
    : (cur.任务的键 ? `<a href="#/task/${cur.任务的键.split("/").map(encodeURIComponent).join("/")}">看这个任务的任务页</a>` : "");
  // 页头压成标题一行加事实一段：事实之间用分号接成一段连续的文字，按宽度自然折行，不再一项占一格。
  const facts = [
    另一页 ? `去${另一页}` : "",
    `任务目录是 <b>${esc(h.任务目录 || "未知")}</b>，库的格式是 <b>${esc(h.库的格式 || "未知")}</b>`,
    h.材料文件.length ? `材料文件是 <b>${h.材料文件.map(esc).join("、")}</b>`
      : (h.材料目录是任务定义登记的 ? `助手没有读到材料目录 <b>${esc(h.材料目录)}</b> 里的任何一份文件` : ""),
    `从 <b>${esc(h.开始时刻)}</b> 到 <b>${esc(h.结束时刻 || "未知")}</b>`,
    h.会话数 > 1 ? `跨了 <b>${h.会话数} 条会话（session）</b>` : "",
    `后端把 pi 进程启动了 <b>${h["pi 进程启动次数"]} 次</b>`,
    `前后一共 <b>${secs(h.总耗时秒)}</b>：模型在想 <b>${secs(h.模型在想的秒数)}</b>，工具在跑 <b>${secs(h.工具在跑的秒数)}</b>，其余是等待`,
    `用的模型是 <b>${esc(h.模型)}</b>`,
  ];
  const 同区 = (cur.同任务目录里没有写过这个任务的会话 || []).length
    ? `<p class="declnote">同一个任务目录里还有 ${cur.同任务目录里没有写过这个任务的会话.length} 条会话没有在这个任务的库里写下任何东西，所以不在这一页上：${
      cur.同任务目录里没有写过这个任务的会话.map((s) => `<a href="#/session/${encodeURIComponent(s.会话编号)}">「${esc(s.会话名 || "未命名会话")}」</a>`).join("、")}。</p>` : "";
  $("#tp-head").innerHTML = `
  <div class="head">
    <div class="line1">
      <h1>${esc(hasTask ? h.任务名 : "这条会话没有对上任务")}</h1>
      ${hasTask ? `<span class="badge">任务编号 ${esc(h.任务编号)}</span>
                  <span class="badge run">状态是${esc(h.状态)}</span>
                  ${h.交付物名称 ? `<span class="badge">交付物是「${esc(h.交付物名称)}」</span>`
                                : `<span class="badge old">这个任务的库是旧格式，没有登记交付物名称</span>`}`
               : `<span class="badge none">它所在的任务目录里还没有任务记录</span>`}
      ${cur.范围 === "会话" ? `<span class="badge">会话「${esc((cur.会话[0] || {}).会话名 || "未命名会话")}」</span>` : ""}
      ${范围 ? `<span class="badge">${esc(范围)}</span>` : ""}
    </div>
    <p class="statline">${esc(h.统计句)}。</p>
    <p class="facts">${facts.filter(Boolean).join("；")}。</p>
    <p class="lede">${esc(cur.概括)}</p>
    ${h.声明说明 ? `<p class="declnote">${esc(h.声明说明)}</p>` : ""}
    ${同区}
  </div>`;
}

/* ───── 这一页上的名词、一行运行里的几个数、观测不到什么 ───── */
function renderWords() {
  const lf = cur.Langfuse || {};
  $("#tp-words").innerHTML = `<details class="words">
  <summary>这一页上的名词、一行运行里的几个数是怎么数的、有哪些东西观测不到（点开看）</summary>
  <div class="in">
    <h4>一行是一次运行</h4>
    <p>一次运行（agent run）是 pi 从收到用户的一句话到安顿下来的一整段处理，从 agent_start 开始，到 agent_settled 结束。
    「轮」是这次运行里 pi 请求模型的次数；「工具调用」是模型在这些轮里提出、由 pi 执行的调用次数；「保存修订」是其中「保存修订」（save_revision）被工具接受的次数，每一次都让交付物形成一次新的修订；「被拒」是被工具拒绝的调用次数；「耗时」是这次运行从开始到结束的真实时间，含模型在想、工具在跑与等待。
    除序号与用户说的话以外，这几列都可以在「显示哪些列」里隐藏，选择只记在这台电脑的浏览器里。</p>
    <p>点开一行看这次运行的各轮：每轮一块，写明助手读了什么、写了什么、说了什么；再点「看这一轮的机器细节」看那一轮的模型交互与工具执行。上方三档开关一次把所有行收起、展开，或者连机器细节一起展开。</p>

    <h4>观测台自己的呈现用语，pi 里没有这几个说法</h4>
    <dl>
      <dt>助手应答</dt><dd>「助手应答」一列的第一行：助手这次运行里最后对用户说的话，完整不截断；没有对用户说话就写「没有对用户说话」。表头上的列边界可以用鼠标左右拖动，把这一列拉宽看。</dd>
      <dt>关键动作</dt><dd>「助手应答」一列第二行的小字：保存修订、完成任务之类会改动任务或交付物的调用各几次，以及被拒几次。</dd>
      <dt>用户操作</dt><dd>用户在网页上直接做的操作（改字段、删条目、撤销修订、把条目标成看过），不经过助手，所以不是一次运行；扩展把它记进会话，这里按时刻单独占一行。</dd>
      <dt>任务现状</dt><dd>扩展在会话开始或续接时写进会话的一段任务状况，不是用户打的字，也单独占一行。</dd>
      <dt>由界面点击触发</dt><dd>用户在助手回复的卡片上点了一个选项，网页替用户把选项投成一句话，这句话触发了这次运行。</dd>
      <dt>需要注意</dt><dd>只列由事实直接得出的异常，没有异常时整块不显示。</dd>
      <dt>交付物看板</dt><dd>指右边那一栏，摆的是这个任务到现在产出了什么。</dd>
      <dt>知识的使用</dt><dd>指右边那一栏的第二个页签，摆的是知识仓库里的每份文件这一次各自用到没有、怎么用到的。</dd>
      <dt>知识仓库</dt><dd>任务目录里给助手读的那些文件：执行方法（skill）所在的 .pi/skills/，与各类文档所在的 docs/。</dd>
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
      <dt>自定义消息（custom message）</dt><dd>扩展写进会话的消息，交给模型时 pi 把它转成用户角色的消息；用户操作与任务现状两种行就是它。</dd>
      <dt>工具调用（tool call）</dt><dd>模型在应答里提出、由 pi 去执行的一次调用。</dd>
      <dt>插话（steer）</dt><dd>一次运行还没有结束时又投进来的一句话，pi 把它排在下一轮给模型看，这次运行不会因此中断。</dd>
      <dt>自动重试（auto retry）</dt><dd>模型请求出错时 pi 自己再请求一次，这会让 pi 重新开始一段低层运行，它给的轮号 turnIndex 从 0 重新编。</dd>
      <dt>skill</dt><dd>pi 启动时加载的一份执行方法说明。启动时只把它的名字与描述放进系统提示，正文要助手自己用 read 去读。</dd>
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
      <dt>会话名</dt><dd>用户在产品网页里给会话起的名字，记在会话文件的 session_info 条目里。</dd>
      <dt>一次 pi 进程启动</dt><dd>后端把 pi 拉起来一次。同一条会话可以跨好几次启动。</dd>
      <dt>收到时刻</dt><dd>后端收到某一条事件的时刻，页面上的时间与长度都按它算。</dd>
      <dt>后端补记</dt><dd>后端在归档旁边另记的几样 pi 事件流里没有的事实，例如启动命令、这次加载了哪些 skill、知识仓库每份文件的摘要值。</dd>
    </dl>

    <h4>材料、执行方法与领域规矩是按这一份路径归类认出来的</h4>
    <p>页头的材料文件、「助手读过的指导」与知识的使用，都按下面这份路径归类认文件：执行方法、领域规矩、材料目录、文档模板各在哪里，读任务定义。换一类任务只要换一份任务定义，观测台的代码不用动。</p>
    <pre class="code">${esc(JSON.stringify(cur.归类声明, null, 2))}</pre>

    <h4>页头那句概括是怎么拼出来的</h4>
    <p>它是一句按固定模板拼出来的话，不是人写的结论。模板是：交付物现有多少条目 → 要完成任务还差几项 → 助手一共运行了几次、最后一次由用户的哪句话触发 → 这条会话的终态。换一份数据它自己会变。</p>

    <h4>耗时怎么算</h4>
    <p>每一行的「耗时」是这次运行从开始到结束的真实时间。页头的「模型在想」是各轮模型请求耗时之和，「工具在跑」是工具调用本身的耗时之和；两项加起来一般小于页头的总耗时，差额是等待用户与进程空转的时间。</p>

    <h4>到 Langfuse 的链接</h4>
    <p>${esc((lf.状态 || {}).说明 || "没有读到 Langfuse 的配置状态。")}</p>

    <h4>有哪些东西这一页观测不到</h4>
    <p>模型在两次工具调用之间想了什么——例如它是怎样把材料分拣成功能用例、非功能需求、约束、问题这几类的——不产生任何工具调用，只存在于那一轮应答的正文里（在「全部细节」这一档里看）。这一页只显示有事实依据的记录，不编造中间步骤，也不替助手解释它为什么这样做。</p>
  </div></details>`;
}

/* ───── 需要注意 ───── */
function renderAlerts() {
  // 按轻重分两块：重的是红底，轻的（合乎规矩、后来改对了之类的说明）是浅色底；只有轻的时整块就是浅色。
  const list = cur.需要注意 || [];
  const 一块 = (items, soft) => !items.length ? "" :
    `<div class="alerts${soft ? " soft" : ""}"><h2>${soft ? "需要注意（轻）" : "需要注意"}</h2><ul>${
      items.map((n) => `<li>${esc(n.文字)}${
        n.去哪 ? ` <button class="jump alertgo" data-jump="${esc(n.去哪)}">跳到那一轮</button>` : ""}</li>`).join("")}</ul></div>`;
  $("#tp-alerts").innerHTML = 一块(list.filter((n) => n.轻重 === "重"), false) + 一块(list.filter((n) => n.轻重 !== "重"), true);
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
  // 新格式由后端给出「修订 a → 修订 b」；旧格式（按字段记版本）照旧拼「第 N 版」。
  const ver = op.版本变化 != null ? op.版本变化
    : op.动作 === "修改" && v[0] != null ? `第 ${v[0]} 版改成第 ${v[1]} 版`
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
    字段: [["修订序号", b.修订序号 != null ? `修订 ${b.修订序号}` : "这次改动没有形成修订"],
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
      ["形成的修订", c.修订序号 != null ? `修订 ${c.修订序号}` : "这次调用没有形成修订。"]],
    链接: ""});
  const 上面画过 = c.改动.length && !c.被拒;
  const 跳 = `<button class="jump" style="color:var(--human);text-decoration:underline" data-jump="chg-${esc(key)}-${ci}">跳到对话层里那一块看改动</button>`;
  const 变化块 = c.对不上 ? `<div class="none" style="color:var(--bad)">${esc(c.对不上)}</div>`
    : 上面画过 ? (t.调用.length === 1 ? `<div>${跳}</div>` : `<div class="none">这次调用带来的改动显示在这一轮的对话层里。${跳}</div>`)
      : `<div class="none">这次调用没有改动交付物，也没有留下其他记录。</div>`;
  const 模型调用块 = (c.模型调用 || []).map((m, mi) => {
    let 提示 = m.提示;
    try { const p = JSON.parse(m.提示); 提示 = `【系统提示】\n${p.systemPrompt}\n\n【用户消息】\n${(p.messages || []).map((x) => x.content).join("\n")}`; } catch (e) { /* 原样显示 */ }
    const 键 = 登记({
      标题: `工具里的一次模型调用：${m.角色}`, 概念: [["业务领域的概念", m.角色]],
      这是什么: "这是工具在执行时自己发起的一次模型调用，不经过 pi 的运行循环，所以 Langfuse 里看不到它；提示全文与原始输出记在库里的 model_call 表。",
      字段: [["角色", esc(m.角色)], ["结果", esc(m.结果) + (m.判读序号 != null ? `（写成了第 ${m.判读序号} 条确认标记）` : "")],
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
    ${模型调用块}
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
    return `<p class="tlnote" style="padding-left:10px">${esc(带.原因 || "这次运行画不出时间条。")}</p>`;
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
  return `<details class="tl"><summary>这次运行各轮的时间条（点开看它们在真实时间上的位置）</summary>
    <div class="in"><div class="ruler">${刻度}</div><div class="lane" style="height:14px">${分段}</div>${道图}
    <p class="tlnote">横轴是后端收到事件的时刻，位置与长度一律按它算。一次工具执行往往只有几毫秒，按真实比例画出来细到看不见，所以太窄的段被拉宽并打上斜纹，真实耗时写在段的旁边，那时宽度不代表耗时。点一段就跳到下面对应的那一块。</p></div></details>`;
}

/* ───── 一次运行里的各轮 ───── */
function 插话HTML(x) {
  const 键 = 登记({标题: "用户在运行中途说的一句话",
    概念: [["pi 的概念", "用户消息（user message）"], ["pi 的概念", x.种类]],
    这是什么: "这是消息列表里的一条消息，观测台把它原样显示出来。" + x.说明,
    字段: [["原文", `<div style="white-space:pre-wrap">${esc(x.原文)}</div>`],
      ["种类", esc(x.种类)],
      ["会话条目编号", `<code>${esc(x.条目编号 || "未知")}</code>`],
      ["收到时刻", esc(x.时刻 || "未知")]], 链接: ""});
  return `<div class="steer" data-k="${键}"${x.条目编号 ? ` id="msg-${esc(x.条目编号)}"` : ""}>
    <div class="w">用户 → 助手　这次运行进行到一半时说的，pi 的概念叫${esc(x.种类)}</div>
    <div class="x">${esc(x.原文)}</div><div class="n">${esc(x.说明)}</div></div>`;
}

// 一轮：这一轮里的改动、没有写入的调用、助手经「回复」说的话，再加上收起着的机器细节。
function 轮HTML(t, key) {
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
    const r = t.回复;
    const 键 = 登记(r ? {
      标题: "助手经「回复」工具说的话", 概念: [["pi 的概念", "工具调用（tool call）"], ["业务领域的概念", "回复"]],
      这是什么: `这是第 ${t.运行序号} 次运行第 ${t.序数} 轮里助手调用「回复」工具说的话。助手对用户说的每一句话都经这个工具发出；下面排好的几行与终端界面、终端客户端显示的是同一份（agent 的排版函数）。`,
      字段: [["排好的样子", r.排版 ? `<pre style="white-space:pre-wrap">${esc(r.排版.join("\n"))}</pre>` : "调不动 agent 的排版函数（本机要有 node），只显示成文的话。"],
        ["成文的话", `<div style="white-space:pre-wrap">${esc(r.成文的话)}</div>`],
        ["是不是降级放行", r.降级放行 ? esc(r.降级放行说明) : "不是，按结构发出的。"],
        ["会话条目编号", r.会话条目编号 ? `<code>${esc(r.会话条目编号)}</code>` : "工具没有报出来"],
        ["出自哪一轮", `第 ${t.运行序号} 次运行的第 ${t.序数} 轮`]], 链接: ""} : {
      标题: "助手发出的一条消息", 概念: [["pi 的概念", "助手消息（assistant message）"]],
      这是什么: `这是第 ${t.运行序号} 次运行第 ${t.序数} 轮的模型应答里的正文，pi 把它追加进消息列表，也发给了用户。`,
      字段: [["正文", `<div style="white-space:pre-wrap">${esc(t.正文)}</div>`],
        ["出自哪一轮", `第 ${t.运行序号} 次运行的第 ${t.序数} 轮`]], 链接: ""});
    // 卡片只放告知与主行为：成文的话已经在上面的气泡里，标题行也不重复。
    const 成文处 = r && r.排版 ? r.排版.findIndex((l) => /^\s*成文的话：/.test(l)) : -1;
    const 卡片行 = r && r.排版 ? (成文处 < 0 ? r.排版 : r.排版.slice(0, 成文处)).filter((l) => !/^(?:助手|执行者)（经回复工具）/.test(l)) : [];
    const 卡片 = r && (r.告知.length || r.主行为) && 卡片行.length
      ? `<pre class="replycard" style="white-space:pre-wrap;margin:4px 0 0">${esc(卡片行.join("\n"))}</pre>` : "";
    const 降级 = r && r.降级放行 ? `<div class="sub" style="color:var(--bad)">${esc(r.降级放行说明)}</div>` : "";
    return `<div class="saylab">助手在这一轮${r ? "经「回复」工具说的话" : "发出的一条消息"}</div>
      <div class="say" data-k="${键}">${esc(t.正文)}</div>${卡片}${降级}
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
}

function guideHTML(g) {
  return `<details class="guidebox"><summary>助手在动手写交付物之前读过的指导：一共 ${g.length} 份</summary><div class="in">
   <table><tbody>${g.map((x) => `<tr><td style="white-space:nowrap;color:var(--ink3)">${esc(x.种类)}</td>
     <td style="font-family:var(--mono);font-size:11.5px">${esc(x.文件)}</td>
     <td style="white-space:nowrap;color:var(--ink3)">第 ${x.运行序号} 次运行 ${esc(x.时刻)} 读的</td>
     <td style="color:var(--ink3)">内容摘要值：${esc(x.摘要值)}</td></tr>`).join("")}</tbody></table>
   <p style="margin:8px 0 0;color:var(--ink2)">这一块只摆出助手当时读过哪些指导，不替它解释为什么这样做。
   <button style="color:var(--human);border-bottom:1px dashed var(--human)" data-openskill="1">把执行方法的原文打开看</button></p>
  </div></details>`;
}

/* ───── 按运行排的流程表 ───── */
// 序号与用户说的话固定显示；下面这几列用户可以隐藏，选择记在浏览器本地（取不到本地存储时全部显示）。
const 可选列 = [
  {键: "应答", 名: "助手应答", 头: "助手应答", 宽: "minmax(0,1fr)", 类: "rreply", 值: (r) => 应答HTML(r)},
  {键: "开始", 名: "开始时刻", 头: "开始", 宽: "5.4em", 类: "rt", 值: (r) => esc(r.时刻)},
  {键: "轮", 名: "轮数", 头: "轮", 宽: "3em", 类: "rn", 值: (r) => r.轮数},
  {键: "工具调用", 名: "工具调用次数", 头: "工具调用", 宽: "4.6em", 类: "rn", 值: (r) => r.工具调用次数},
  {键: "保存修订", 名: "保存修订次数", 头: "保存修订", 宽: "4.6em", 类: "rn", 值: (r) => r.保存修订次数, 强调: "save"},
  {键: "被拒", 名: "被拒次数", 头: "被拒", 宽: "3.4em", 类: "rn", 值: (r) => r.被拒次数, 强调: "bad"},
  {键: "耗时", 名: "耗时", 头: "耗时", 宽: "6.2em", 类: "rn", 值: (r) => secs(r.耗时秒)},
];
const 列存储键 = "taskwright-observatory.run-columns.hidden";
function 读隐藏列() {
  try { return new Set(JSON.parse(localStorage.getItem(列存储键) || "[]")); } catch (e) { return new Set(); }
}
function 写隐藏列(set) {
  try { localStorage.setItem(列存储键, JSON.stringify([...set])); } catch (e) { /* 存不下就只在这一页生效 */ }
}
const 可见列 = () => { const 藏 = 读隐藏列(); return 可选列.filter((c) => !藏.has(c.键)); };
// 每一列的宽度可以用鼠标拖动表头上的列边界改，拖过的列按像素记在浏览器本地；没拖过的用默认宽度。
const 宽存储键 = "taskwright-observatory.run-columns.widths";
const 固定列 = [{键: "序号", 宽: "3.6em"}, {键: "用户的话", 宽: "minmax(0,1fr)"}];
function 读列宽() {
  try { return JSON.parse(localStorage.getItem(宽存储键) || "{}") || {}; } catch (e) { return {}; }
}
function 写列宽(宽) {
  try { localStorage.setItem(宽存储键, JSON.stringify(宽)); } catch (e) { /* 存不下就只在这一页生效 */ }
}
const 列宽 = (宽 = 读列宽()) => [...固定列, ...可见列()].map((c) => 宽[c.键] ? `${宽[c.键]}px` : c.宽).join(" ");
const 拖边 = (键) => `<i class="grip" data-grip="${键}" title="左右拖动改这一列的宽窄，双击恢复默认宽度"></i>`;
const 运行表 = () => (cur.流程 || []).flatMap((seg) => seg.行).filter((x) => x.种类 === "运行");
const 运行 = (no) => 运行表().find((x) => x.运行序号 === no);

function 表头HTML() {
  return `<div class="rrow rhead"><span class="rno">序号${拖边("序号")}</span><span class="rsay">用户说的话${拖边("用户的话")}</span>${
    可见列().map((c) => `<span class="${c.类}">${esc(c.头)}${拖边(c.键)}</span>`).join("")}</div>`;
}

// 「助手应答」一列：第一行是这次运行最后一次成功送达的回复，完整不截断；第二行小字是关键动作。
function 应答HTML(r) {
  const 摘要 = r.有没有对用户说话 ? `<span class="full">${esc(r.助手应答)}</span>` : `<span class="silent">没有对用户说话</span>`;
  const 动作 = r.关键动作.length
    ? `<span class="acts">${r.关键动作.map((x) => `<b class="${/^被拒/.test(x) ? "bad" : ""}">${esc(x)}</b>`).join("、")}</span>` : "";
  return 摘要 + 动作;
}

function 运行行HTML(r) {
  const 格 = 可见列().map((c) => {
    const v = c.值(r);
    if (c.强调) return `<span class="${c.类} ${v ? c.强调 : "zero"}">${v || "—"}</span>`;
    return `<span class="${c.类}">${v}</span>`;
  }).join("");
  return `<button type="button" class="rrow" id="${esc(r.编号)}" data-run="${r.运行序号}" aria-expanded="false">
    <span class="rno"><i class="chev"></i>${r.运行序号}</span>
    <span class="rsay"><span class="full">${esc(r.用户的话 || "（归档里没有这次运行的提示原文）")}</span>${
      r.由界面点击触发 ? `<span class="rtag click" title="${esc(r.由界面点击触发)}">由界面点击触发</span>` : ""}${
      r.被中止 ? `<span class="rtag bad">被中止</span>` : ""}</span>${格}</button>`;
}

function 运行展开HTML(r) {
  const key0 = `run${r.运行序号}`;
  const 键 = 登记({标题: "用户说的一句话",
    概念: [["pi 的概念", "用户消息（user message）"], ["pi 的概念", "提示（prompt）"]],
    这是什么: "这是消息列表里的一条消息，观测台把它原样显示出来。pi 收到它以后开始一次运行。",
    字段: [["原文", `<div style="white-space:pre-wrap">${esc(r.用户的话)}</div>`],
      ["来源", esc(r.消息来源 || "未知")],
      ["来源的依据", esc(r.消息来源的依据 || "未知")],
      ...(r.由界面点击触发 ? [["由界面点击触发", esc(r.由界面点击触发)]] : []),
      ["会话条目编号", `<code>${esc(r.条目编号 || "未知")}</code>`],
      ["时刻", esc(r.时刻)]], 链接: ""});
  const 首个写入 = 运行表().find((x) => x.轮.some((t) => t.调用.some((c) => c.改动.length && !c.被拒)));
  const 最后 = r.轮.length ? r.轮[r.轮.length - 1].序数 : null;
  const 收尾 = r.被中止 ? "这次运行是被中止的。"
    : r.没有正常收尾 ? "归档里这次运行没有正常收尾（后面没有 agent_settled）。"
      : 最后 != null ? `第 ${最后} 轮是这次运行的最后一轮，随后 pi 发出 agent_settled，这次运行结束，一共用了 ${secs(r.耗时秒)}。`
        : "这次运行一轮也没有走。";
  const 改正 = r.改正线索
    ? `<p class="fixline"><button class="jump" data-jump="turn-${r.改正线索.运行序号}-${r.改正线索.轮号 + 1}">这次运行里被拒的调用，后来在第 ${r.改正线索.运行序号} 次运行的第 ${r.改正线索.轮号 + 1} 轮改对了。</button></p>` : "";
  return `<div class="rbody" data-body="${r.运行序号}" hidden>
    ${r.启动说明 ? `<p class="boot">${esc(r.启动说明)}</p>` : ""}
    <div class="saylab">用户这一句话的全文（这一句话触发了这次运行）</div>
    <div class="say human p-用户" data-k="${键}"${r.条目编号 ? ` id="msg-${esc(r.条目编号)}"` : ""}>${esc(r.用户的话)}<span class="src">来源：${esc(r.消息来源 || "未知")}　会话条目 <code>${esc(r.条目编号 || "未知")}</code>　${esc(r.时刻)}${
      r.由界面点击触发 ? `　由界面点击触发：${esc(r.由界面点击触发)}` : ""}</span></div>
    ${首个写入 === r && (cur.指导 || []).length ? guideHTML(cur.指导) : ""}
    <div class="tlwrap" hidden>${时间条(r, key0)}</div>
    <div class="rturns-h">这次运行一共 ${r.轮数} 轮。每轮一块：助手读了什么、写了什么、说了什么；点「看这一轮的机器细节」展开模型请求与工具调用的原始记录。</div>
    ${r.轮.map((t) => 轮HTML(t, `${key0}-${t.序数}`)).join("")}
    ${改正}
    <p class="rend">${收尾}</p>
  </div>`;
}

function 其他行HTML(x) {
  const 键 = 登记({标题: x.种类 === "用户操作" ? "用户在网页上的一次直接操作" : x.种类 === "任务现状" ? "扩展写进会话的任务现状" : "扩展写进会话的一条消息",
    概念: [["pi 的概念", "自定义消息（custom message）"]],
    这是什么: x.说明 + "pi 交给模型时把它转成一条用户角色的消息，但它不是人打的字。",
    字段: [["原文", `<div style="white-space:pre-wrap">${esc(x.原文)}</div>`],
      ["类型", `<code>${esc(x.类型)}</code>`],
      ["会话条目编号", `<code>${esc(x.条目编号 || "未知")}</code>`],
      ["时刻", esc(x.时刻 || "未知")]], 链接: ""});
  // 助手应答一列留空，开始时刻照写，其余几列合成一格写一句说明。
  const 列 = 可见列();
  const 前面 = [];
  if (列.some((c) => c.键 === "应答")) 前面.push(`<span></span>`);
  if (列.some((c) => c.键 === "开始")) 前面.push(`<span class="rt">${esc(x.时刻)}</span>`);
  const 其余 = 列.length - 前面.length;
  return `<div class="rrow other" data-k="${键}" id="${x.条目编号 ? `msg-${esc(x.条目编号)}` : esc(x.编号)}">
    <span class="rno">—</span>
    <span class="rsay"><span class="rtag ${x.种类 === "用户操作" ? "edit" : "ext"}">${esc(x.种类)}</span>${esc(x.摘要)}<span class="rwhy">${esc(x.说明)}</span></span>
    ${前面.join("")}${其余 > 0 ? `<span class="rspan" style="grid-column:${3 + 前面.length} / -1">不是一次运行，没有轮与工具调用</span>` : ""}</div>`;
}

function renderFlow() {
  const flow = $("#tp-flow");
  flow.style.setProperty("--cols", 列宽());
  const 分段 = cur.范围 === "任务";
  flow.innerHTML = (cur.流程 || []).map((seg) => `<div class="runs">
    ${分段 ? `<div class="seghead"><b>第 ${seg.会话序号} 条会话「${esc(seg.会话名 || "未命名会话")}」</b>
      <span>从 ${esc(seg.开始时刻 || "未知")} 开始，${seg.运行次数} 次运行</span>
      <span class="id" title="${esc(seg.会话编号)}">会话编号 ${esc(seg.会话编号)}</span>
      ${seg.会话编号 ? `<a href="#/session/${encodeURIComponent(seg.会话编号)}">看这条会话的会话详情</a>` : ""}</div>` : ""}
    ${表头HTML()}
    ${seg.行.map((x) => x.种类 === "运行" ? 运行行HTML(x) + 运行展开HTML(x) : 其他行HTML(x)).join("")
      || `<div class="rrow"><span></span><span class="rsay">这条会话里助手一次也没有运行过。</span></div>`}
  </div>`).join("");
  wireFlow();
  applyZoom();
}

/* 换了显示哪些列：重画流程表，已经展开的运行照旧展开 */
function 重画流程() {
  const 开着 = [...$("#tp-flow").querySelectorAll("button.rrow.open")].map((b) => b.dataset.run);
  const 档 = zoom;
  zoom = 1;
  renderFlow();
  zoom = 档;
  if (档 > 1) applyZoom();
  else 开着.forEach((no) => { const b = $(`#tp-flow button.rrow[data-run="${no}"]`); if (b) 展开运行(b, true); });
  布局();
}

function 列设置() {
  const menu = $("#tp-cols .menu");
  const 藏 = 读隐藏列();
  menu.innerHTML = `<p class="fixed">序号与用户说的话总是显示。</p>` +
    可选列.map((c) => `<label><input type="checkbox" data-col="${c.键}"${藏.has(c.键) ? "" : " checked"}> ${esc(c.名)}</label>`).join("") +
    `<p class="note">选了哪几列只记在这台电脑的浏览器里。表头上的列边界可以用鼠标左右拖动改宽窄，双击边界恢复默认。</p>` +
    `<button type="button" class="reset" data-resetwidths="1">所有列恢复默认宽度</button>`;
  menu.onclick = (e) => {
    if (!e.target.closest("[data-resetwidths]")) return;
    写列宽({});
    $("#tp-flow").style.setProperty("--cols", 列宽({})); 布局();
  };
  menu.onchange = (e) => {
    const box = e.target.closest("[data-col]"); if (!box) return;
    const set = 读隐藏列();
    if (box.checked) set.delete(box.dataset.col); else set.add(box.dataset.col);
    写隐藏列(set);
    重画流程();
  };
}

function 展开运行(row, open) {
  const body = row.nextElementSibling;
  if (!body || !body.classList.contains("rbody")) return;
  body.hidden = !open;
  row.classList.toggle("open", open);
  row.setAttribute("aria-expanded", String(open));
}

function wireFlow() {
  const flow = $("#tp-flow");
  flow.querySelectorAll("button.rrow[data-run]").forEach((b) => {
    b.onclick = () => {
      展开运行(b, !b.classList.contains("open"));
      flow.querySelectorAll(".rrow.sel").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      const r = 运行(+b.dataset.run);
      if (r) 高亮条目(r.条目 || []);
      布局();
    };
  });
  flow.querySelectorAll("[data-grip]").forEach((g) => {
    g.onmousedown = (e) => {
      e.preventDefault(); e.stopPropagation();
      const 起 = e.clientX, 原 = g.parentElement.getBoundingClientRect().width, 宽 = 读列宽();
      const move = (ev) => {
        宽[g.dataset.grip] = Math.max(32, Math.round(原 + ev.clientX - 起));
        flow.style.setProperty("--cols", 列宽(宽));
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.classList.remove("tp-resizing");
        写列宽(宽); 布局();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      document.body.classList.add("tp-resizing");
    };
    g.ondblclick = (e) => {
      e.stopPropagation();
      const 宽 = 读列宽(); delete 宽[g.dataset.grip]; 写列宽(宽);
      flow.style.setProperty("--cols", 列宽(宽)); 布局();
    };
  });
  flow.querySelectorAll("[data-lv3]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const box = flow.querySelector(`[data-lv3box="${b.dataset.lv3}"]`);
      box.hidden = !box.hidden;
      b.textContent = box.hidden ? "看这一轮的机器细节" : "收起这一轮的机器细节";
      const wrap = b.closest(".rbody") && b.closest(".rbody").querySelector(".tlwrap");
      if (wrap && !box.hidden) wrap.hidden = false;
      布局();
    };
  });
  flow.querySelectorAll("[data-openf]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const bag = flow.querySelector(`[data-allf="${b.dataset.openf}"]`);
      if (bag) bag.hidden = false;
      b.remove(); 布局();
    };
  });
  flow.querySelectorAll("[data-opentoggle]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const op = flow.querySelector(`.op[data-opkey="${b.dataset.opentoggle}"]`);
      if (!op) return;
      op.hidden = !op.hidden;
      b.setAttribute("aria-expanded", String(!op.hidden));
      布局();
    };
  });
}

/* ───── 放大级别 ───── */
function applyZoom() {
  const flow = $("#tp-flow");
  flow.querySelectorAll("button.rrow[data-run]").forEach((b) => 展开运行(b, zoom >= 2));
  flow.querySelectorAll(".lv3").forEach((b) => b.hidden = zoom < 3);
  flow.querySelectorAll(".tlwrap").forEach((b) => b.hidden = zoom < 3);
  flow.querySelectorAll("[data-lv3]").forEach((b) => b.textContent = zoom >= 3 ? "收起这一轮的机器细节" : "看这一轮的机器细节");
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
     <span class="meta" title="${it.已删除 ? `在修订 ${it.在第几次修订删除} 删掉了` : ""}">${it.已删除 ? "已删除" : (it.所在 || `第 ${it.版本} 版`)}</span>
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
  const 类 = (u) => u === "助手按需读过" ? "read" : u === "工具读过" ? "tool" : u === "启动时放进了系统提示" ? "prompt" : "cold";
  pane.innerHTML = `
    <p class="bsum">${esc(k.概括)}</p>
    <p class="knote">${esc(k.skill)}</p>
    <p class="knote">${esc(k.上下文文件)}</p>
    <p class="knote">${esc(k.来源说明)}</p>
    ${Object.entries(groups).map(([kind, rows]) => `
      <div class="kgrp"><div class="h">${esc(kind)}</div>
      ${rows.map((r) => `<div class="krow" data-run="${r.运行序号 == null ? "" : r.运行序号}">
        <div><div class="f">${esc(r.文件)}</div><div class="d">${esc(r.一句话)}</div>
          <div class="d">内容摘要值：<span class="mono">${esc(r.摘要值)}</span>${r.变过吗 ? "（几次启动之间变过）" : ""}</div></div>
        <span class="use ${类(r.用法)}">${esc(r.用法)}</span>
      </div>`).join("")}</div>`).join("")}
    <p class="knote">这一栏按事实分四种：「助手按需读过」是助手自己调用 read 读的；「工具读过」是某个工具在运行时自己打开的，助手并没有读到它的内容；「启动时放进了系统提示」是 pi 启动时放进去的（skill 只放名字与描述，上下文文件整份放）；「这次没有用到」是从头到尾没有任何人打开过。点一行跳到读它的那次运行。</p>`;
  pane.querySelectorAll(".krow").forEach((el) => {
    el.onclick = () => {
      pane.querySelectorAll(".krow").forEach((x) => x.classList.remove("sel")); el.classList.add("sel");
      if (el.dataset.run) 跳到(`run-${el.dataset.run}`);
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
  flow.querySelectorAll("button.rrow[data-run]").forEach((b) => {
    const r = 运行(+b.dataset.run);
    const hit = !!r && (r.条目 || []).includes(code);
    b.classList.toggle("sel", hit);
    if (!hit) return;
    展开运行(b, true);
    const body = b.nextElementSibling;
    const ops = [...body.querySelectorAll(".op")].filter((o) => o.dataset.code === code);
    ops.forEach((op) => {
      op.hidden = false;
      const t = body.querySelector(`[data-opentoggle="${op.dataset.opkey}"]`);
      if (t) t.setAttribute("aria-expanded", "true");
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
  const 由 = 选.来历 ? 选.来历 : 选.由第几次修订产生 != null ? `由修订 ${选.由第几次修订产生} 产生` : "这是这个条目建库时的初值，不是任何一次修订产生的";
  const 名 = (v) => v.标签 || `第 ${v.版本号} 版`;
  开抽屉(`条目 ${code}`, `
    <p class="hint">这个条目属于集合「${esc(got.集合)}」，${选.标签 ? `它改动过的修订一共 ${版本.length} 次` : `现在一共有 ${版本.length} 版`}${got.条目.已删除 ? `，已在修订 ${got.条目.在第几次修订删除} 删掉` : ""}。下面默认显示最新的内容，可以切到别的${选.标签 ? "修订" : "版本"}。</p>
    <div class="vtabs">${版本.map((v) => `<button data-ver="${v.版本号}" data-code="${esc(code)}"
      aria-pressed="${v === 选 ? "true" : "false"}">${esc(名(v))}</button>`).join("")}</div>
    <p class="vmeta">${esc(名(选))}：${由}${选.写入者 ? `，写入者是${esc(选.写入者)}` : ""}。
      评审：${esc(选.评审 || "还没有这类记录")}。用户确认：${esc(选.确认 || "还没有这类记录")}。</p>
    ${got.条目.说明 ? `<p class="vmeta">这个字段的说明：${esc(got.条目.说明)}</p>` : ""}
    <div class="ftable">${选.字段.map((f) => `<div class="frow"><div class="fn">${esc(f.名)}</div><div>${画值(f)}</div></div>`).join("")}</div>
    ${(选.来源 || []).length ? `<h4 style="font:600 13px var(--sans);margin:14px 0 4px">${esc(名(选))}的来源一共 ${选.来源.length} 条</h4>${
      选.来源.map((s) => 来源HTML(s, 6, 12.5)).join("")}` : `<p class="none">${esc(名(选))}没有登记来源。</p>`}`);
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
  if (目标.matches("button.rrow[data-run]")) 展开运行(目标, true);
  const body = 目标.closest(".rbody");
  if (body && body.hidden) 展开运行(body.previousElementSibling, true);
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
       <p class="hint">这是观测台从任务目录的 ${esc(cur.执行方法.路径)} 现在读进来的全文，不一定是助手当时读到的那一版；当时那一版的摘要值写在上面的表里。</p>
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
  host.querySelectorAll(".sel").forEach((x) => { if (!x.classList.contains("rrow") && !x.classList.contains("item")) x.classList.remove("sel"); });
  t.classList.add("sel");
  显示细节(Number(t.dataset.k));
}

/* ───── 布局：时间条里太窄的段拉宽并在旁边写出真实耗时 ───── */
function 布局() {
  if (!host || !host.isConnected) return;
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
        <h2 class="ch">任务的完整流程 <span class="n">一行是一次运行：用户的一句话，加上助手为这句话做的全部轮</span></h2>
        <details class="colpick" id="tp-cols"><summary>显示哪些列</summary><div class="menu"></div></details>
        <span class="zoom" id="tp-zoom">
          <button data-z="1">只看运行</button>
          <button data-z="2">展开每次运行</button>
          <button data-z="3">全部细节</button>
        </span>
      </div>
      <div id="tp-flow"></div>
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
  renderHead(); renderWords(); renderAlerts();
  $("#tp-zoom").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(+x.dataset.z === zoom)));
  renderFlow(); 列设置();
  $("#tp-now").innerHTML = nowHTML(cur.末端);
  renderBoard(); renderKnow();

  $("#tp-zoom").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    zoom = +b.dataset.z;
    $("#tp-zoom").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    applyZoom();
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
