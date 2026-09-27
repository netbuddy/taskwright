/**
 * Word 段落是不是标题、是第几级：投影（lib/docx_markdown.ts，分段清单从投影里的 # 取标题）与材料区推导章节
 * （web/src/model/docx.ts）共用这一份规则，两处各自把样式表交给它。
 *
 * 按下面的顺序看，前一步得出结果就不看后一步：
 * 1. 段落自身写的大纲级别（w:outlineLvl）；
 * 2. 段落所用样式的大纲级别，样式自己没写时沿继承关系（w:basedOn）往上找；
 * 3. 样式名：英文「heading N」（不分大小写，中间可以没有空格）或中文「标题 N」（中间可以没有空格），N 是 1 到 9 时是第 N 级。
 *    样式名取样式定义里的名字（w:name），取不到时用样式编号（w:styleId）；沿继承关系往上找时同样适用。
 * 三步都没有结果的段落不是标题。大纲级别 0 到 8 是第 1 到第 9 级；写成 9（Word 里的「正文」）或别的值时结论就是「不是标题」，
 * 不再看后面的步骤，作者有意取消的标题不会被样式名认回来。
 * 只认作者通过大纲级别或样式声明的标题，不按字号、加粗、编号去猜。不依赖任何模块，前端也直接引用。
 */

/** 一个样式里与标题有关的三项；取不到的项不写或写 null。 */
export interface HeadingStyle {
  /** 样式名（w:name）。 */
  name?: string | null;
  /** 上级样式的编号（w:basedOn）。 */
  basedOn?: string | null;
  /** 样式里写的大纲级别（w:pPr/w:outlineLvl）。 */
  outline?: string | number | null;
}

const NAMED = /^(?:heading|标题)\s*([1-9])$/i;

/** 一个写出来的大纲级别的结论：0 到 8 是标题（返回级别），别的值不是标题（返回 null）。 */
const fromOutline = (v: string | number): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < 9 ? n : null;
};

/** 从 styleId 起沿继承关系列出样式编号与定义（遇到环或找不到定义就停；找不到定义的那一个也列出，给样式名那一步用编号）。 */
function chain(styleId: string | null | undefined, style: (id: string) => HeadingStyle | undefined): [string, HeadingStyle | undefined][] {
  const out: [string, HeadingStyle | undefined][] = [];
  const seen = new Set<string>();
  for (let id = styleId; id && !seen.has(id); ) {
    seen.add(id);
    const s = style(id);
    out.push([id, s]);
    if (!s) break;
    id = s.basedOn;
  }
  return out;
}

/**
 * 段落的大纲级别：0 是一级标题，8 是九级标题，null 不是标题。own 是段落自身写的大纲级别，styleId 是段落所用样式的编号
 * （w:pStyle），style 按编号查样式定义（查不到返回 undefined）。
 */
export function headingLevel(
  own: string | number | null | undefined,
  styleId: string | null | undefined,
  style: (id: string) => HeadingStyle | undefined,
): number | null {
  if (own != null && own !== "") return fromOutline(own);
  const styles = chain(styleId, style);
  for (const [, s] of styles) if (s?.outline != null && s.outline !== "") return fromOutline(s.outline);
  for (const [id, s] of styles) {
    const m = NAMED.exec((s?.name || id).trim());
    if (m) return Number(m[1]) - 1;
  }
  return null;
}
