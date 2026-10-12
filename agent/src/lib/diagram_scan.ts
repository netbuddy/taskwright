/**
 * 从图的 Mermaid 文本里扫出几样东西：系统边界图有没有画出系统（子图）与系统外面的节点。
 *
 * 与 lib/diagram.ts 的 drawnItemIds 是同一个思路：只在文本里按写法找，不解析整张图。Mermaid 的写法很多，这里只认说明里教的
 * 那几种；认不准的写法一律往宽里算（宁可把不是节点的词当成节点，也不把一张画对了的图判成不对），因为扫出来的结果一处用来
 * 在保存时把关，把关错拦比放过更糟。
 *
 * 本文件不导入别的模块：助手的工具、后端的校验都调它，页面也可以直接导入（agent/tests/web_imports.test.ts 守着）。
 */

/** 流程图写法里的一条语句，连同它写在第几层子图里（0 是不在任何子图里）。 */
interface FlowStatement {
  text: string;
  depth: number;
}

/** 不画节点的几种语句：样式、点击、方向、无障碍说明。 */
const FLOW_DIRECTIVE = /^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/;
/** 连线的写法：两个以上的短横线或等号、带点的虚线、三个以上的波浪线，前后可以带箭头或圆点、叉。 */
const FLOW_LINK = /\s*<?(?:-{2,}|={2,}|-\.+-+|~{3,})[>ox]?\s*|\s*&\s*/;

/**
 * 把流程图写法的文本拆成语句：去掉注释与引号里的文字，按行与分号拆开，认出子图的开头与结尾。
 * 返回各条画节点或连线的语句、各个子图的名字（`subgraph` 后面的第一个词，没有写名字的不在里面）与子图一共有几个。
 */
function flowStatements(mermaid: string): { statements: FlowStatement[]; subgraphs: string[]; subgraphCount: number } {
  const statements: FlowStatement[] = [];
  const subgraphs: string[] = [];
  let subgraphCount = 0;
  let depth = 0;
  let first = true;
  for (const raw of mermaid.split(/\r?\n/)) {
    const line = raw.replace(/%%.*$/, "").replace(/"[^"]*"/g, '""').trim();
    if (line === "") continue;
    if (first) {
      first = false;
      if (/^(flowchart|graph)\b/i.test(line)) continue;
    }
    for (const piece of line.split(";")) {
      const part = piece.trim();
      if (part === "") continue;
      const opened = /^subgraph\b\s*([^\s[]*)/.exec(part);
      if (opened) {
        depth += 1;
        subgraphCount += 1;
        if (opened[1]) subgraphs.push(opened[1]);
        continue;
      }
      if (part === "end") {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (FLOW_DIRECTIVE.test(part)) continue;
      statements.push({ text: part, depth });
    }
  }
  return { statements, subgraphs, subgraphCount };
}

/** 一条语句里各个节点的名字：去掉节点的文字与连线上的字，按连线拆开，每一截取开头的那个词。 */
function flowNodeIds(statement: string): string[] {
  let text = statement;
  // 节点的文字写在方括号、圆括号、花括号里，可以套着写（例如 `a(["文字"])`），一层一层去掉。
  for (let before = ""; before !== text;) {
    before = text;
    text = text.replace(/\[[^[\]]*\]|\([^()]*\)|\{[^{}]*\}/g, "");
  }
  // 连线上的字有两种写法：夹在两根竖线之间，或者夹在连线中间（`a -- 字 --> b`、`a -. 字 .-> b`、`a == 字 ==> b`）。
  text = text.replace(/\|[^|]*\|/g, " ")
    .replace(/(?:--|==)\s+[^-=>|]*?\s+(?:-{2,}|={2,})[>ox]?/g, " --> ")
    .replace(/-\.\s*[^.|>]*?\s*\.-+[>ox]?/g, " --> ");
  const out: string[] = [];
  for (const piece of text.split(FLOW_LINK)) {
    const id = (piece ?? "").trim().split(/\s+/)[0]?.replace(/:::.*$/, "") ?? "";
    if (id !== "" && !/^[<>ox]$/.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 系统边界图画没画出两样东西：系统（一个子图），与系统外面的角色或外部系统（不在任何子图里的节点）。
 * subgraphs 是子图有几个；outside 是只出现在子图之外的节点名字（在子图里声明过、在外面只是被连线提到的节点算子图里的）。
 */
export function contextShape(mermaid: string): { subgraphs: number; outside: string[] } {
  const { statements, subgraphs, subgraphCount } = flowStatements(mermaid);
  const inside = new Set(subgraphs);
  for (const one of statements) if (one.depth > 0) for (const id of flowNodeIds(one.text)) inside.add(id);
  const outside: string[] = [];
  for (const one of statements) {
    if (one.depth > 0) continue;
    for (const id of flowNodeIds(one.text)) if (!inside.has(id) && !outside.includes(id)) outside.push(id);
  }
  return { subgraphs: subgraphCount, outside };
}
