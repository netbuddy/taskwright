// 助手回复的有限 Markdown：只开段落、列表（- * + 与 1. 两种）、加粗（**…**）、行内代码（`…`）。
// 标题与表格不开：以 # 开头的行、竖线表格的行都当作普通文字原样显示。用户消息不经这里。
// 不用 innerHTML，全部拼成 React 元素，模型输出里的尖括号只会当作文字显示。

import type { ReactNode } from "react";

type Block = { kind: "p"; lines: string[] } | { kind: "ul" | "ol"; items: string[] };

const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.、)]\s+(.*)$/;

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    const last = blocks[blocks.length - 1];
    if (!line.trim()) {
      blocks.push({ kind: "p", lines: [] }); // 空行结束当前块
    } else if (bullet || ordered) {
      const kind = bullet ? "ul" : "ol";
      const content = (bullet ?? ordered)![1];
      if (last && last.kind === kind) last.items.push(content);
      else blocks.push({ kind, items: [content] });
    } else if (last && last.kind === "p" && last.lines.length > 0) {
      last.lines.push(line);
    } else {
      blocks.push({ kind: "p", lines: [line] });
    }
  }
  return blocks.filter((b) => (b.kind === "p" ? b.lines.length > 0 : b.items.length > 0));
}

/** 行内：`代码` 与 **加粗**；配不上对的记号原样留着。 */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    if (match[1] !== undefined) out.push(<code key={key++}>{match[1]}</code>);
    else out.push(<strong key={key++}>{match[2]}</strong>);
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseBlocks(text).map((b, i) => {
        if (b.kind === "ul") return <ul key={i}>{b.items.map((t, j) => <li key={j}>{renderInline(t)}</li>)}</ul>;
        if (b.kind === "ol") return <ol key={i}>{b.items.map((t, j) => <li key={j}>{renderInline(t)}</li>)}</ol>;
        if (b.kind !== "p") return null;
        return (
          <p key={i}>
            {b.lines.map((line, j) => (
              <span key={j}>{j > 0 && <br />}{renderInline(line)}</span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
