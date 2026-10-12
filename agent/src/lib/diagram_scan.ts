/**
 * 从图的 Mermaid 文本里扫出几样东西：图里写了哪些条目的编号；系统边界图有没有画出系统（子图）与系统外面的节点；
 * 流程图有没有判断节点；对象关系图里哪些条目有连线连着。
 *
 * 都是同一个思路：只在文本里按写法找，不解析整张图。Mermaid 的写法很多，这里只认说明里教的
 * 那几种；认不准的写法一律往宽里算（宁可把不是节点的词当成节点，也不把一张画对了的图判成不对），因为扫出来的结果一处用来
 * 在保存时把关，把关错拦比放过更糟；另几处用来算灯，灯只提示、不拦操作。
 *
 * 本文件不导入别的模块：助手的工具、后端的校验都调它，页面也可以直接导入（agent/tests/web_imports.test.ts 守着）。
 */

/** 认条目编号的正则：「前缀-至少三位数字」，前后不能紧挨着英文字母或数字。prefixes 里写得不合规矩的不认；一个可用的都没有时是 null。 */
function itemIdPattern(prefixes: readonly string[]): RegExp | null {
  const usable = prefixes.filter((one) => /^[A-Z][A-Z0-9]*$/.test(one)).sort((a, b) => b.length - a.length);
  return usable.length === 0 ? null : new RegExp(`(?<![A-Za-z0-9])(?:${usable.join("|")})-\\d{3,}(?![A-Za-z0-9])`, "g");
}

/**
 * Mermaid 文本里出现的条目编号，按第一次出现的先后，不重复。prefixes 是任务定义里各集合的编号前缀。
 * 认的是「前缀-至少三位数字」，前后不能紧挨着英文字母或数字（UC-0012 与 XUC-001 都不算 UC-001）。
 */
export function drawnItemIds(mermaid: string, prefixes: readonly string[]): string[] {
  const pattern = itemIdPattern(prefixes);
  if (pattern === null) return [];
  const out: string[] = [];
  for (const hit of mermaid.match(pattern) ?? []) if (!out.includes(hit)) out.push(hit);
  return out;
}

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

/**
 * 流程图里有没有判断节点：写成 `名字{文字}` 的菱形节点。双花括号的六边形（`名字{{文字}}`）不算。
 * 注释与引号里的文字先去掉，免得把文字里的花括号当成节点。
 */
export function hasBranch(mermaid: string): boolean {
  return mermaid.split(/\r?\n/).some((raw) => /[^\s{}]\s*\{(?!\{)/.test(raw.replace(/%%.*$/, "").replace(/"[^"]*"/g, '""').replace(/\{\{[^{}]*\}\}/g, "")));
}

/** 对象关系图里不画关系的几种语句的开头。 */
const CLASS_OTHER = /^(class|note|direction|namespace|link|click|callback|style|classDef|cssClass|accTitle|accDescr|title)\b|^[<{}]|^---/;
/** 关系线：两根短横线或两个点，两头可以带三角、菱形、圆圈、箭头，前后可以各带一段写在引号里的数量。 */
const CLASS_RELATION = /\s*(?:"[^"]*"\s*)?(?:<\|?|\*|(?<=\s)o)?(?:--|\.\.)(?:\|?>|\*|o(?=\s))?\s*(?:"[^"]*"\s*)?/;

/**
 * 对象关系图里有连线连着的条目编号，按第一次出现的先后，不重复。图用 Mermaid 的类图写法画：类的名字不能带连字符，
 * 所以条目编号照说明写在方括号的文字里，例如 `class Loan["OA-003 借阅记录"]`，关系线上写的是类的名字（`Loan --> Reader`）。
 * 这里把关系线两端的名字按声明对回编号；名字用反引号括起来、里面直接写着编号的也认；一行关系线里直接写着的编号（例如写在
 * 冒号后面的说明里）也算。写在类的花括号里面的成员不算关系线。
 */
export function classLinked(mermaid: string, prefixes: readonly string[]): string[] {
  const pattern = itemIdPattern(prefixes);
  if (pattern === null) return [];
  const idsIn = (text: string): string[] => text.match(pattern) ?? [];
  const lines = mermaid.split(/\r?\n/).map((raw) => raw.replace(/%%.*$/, "").trim()).filter(Boolean);
  // 类的名字 → 它的文字里写的条目编号。
  const named = new Map<string, string[]>();
  for (const line of lines) {
    const declared = /^class\s+(`[^`]*`|[^\s[{:~<]+)\s*(?:\["([^"]*)"\])?/.exec(line);
    if (declared) named.set(declared[1], [...idsIn(declared[1]), ...idsIn(declared[2] ?? "")]);
  }
  const out: string[] = [];
  const add = (ids: readonly string[]) => {
    for (const id of ids) if (!out.includes(id)) out.push(id);
  };
  let inBody = false;
  for (const line of lines) {
    if (inBody) {
      if (line.startsWith("}")) inBody = false;
      continue;
    }
    if (/^class\b/.test(line) && line.endsWith("{")) {
      inBody = true;
      continue;
    }
    if (CLASS_OTHER.test(line)) continue;
    // 反引号括起来的名字里可以有空格，先换成不带空格的记号，找到两端之后再换回来。
    const quoted: string[] = [];
    const flat = line.replace(/`[^`]*`/g, (name) => `\u0001${quoted.push(name) - 1}\u0001`);
    const found = CLASS_RELATION.exec(flat);
    if (!found || found.index === 0) continue;
    const restore = (token: string) => token.replace(/\u0001(\d+)\u0001/g, (_, n: string) => quoted[Number(n)]);
    const left = restore(flat.slice(0, found.index).trim().split(/\s+/).pop() ?? "");
    const right = restore(flat.slice(found.index + found[0].length).split(/\s*:\s*/)[0].trim().split(/\s+/)[0] ?? "");
    if (left === "" || right === "") continue;
    add(named.get(left) ?? idsIn(left));
    add(named.get(right) ?? idsIn(right));
    add(idsIn(line));
  }
  return out;
}
