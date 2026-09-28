/**
 * Word 自动编号怎样数、怎样写：投影（lib/docx_markdown.ts）用它把编号写在标题与列表项前面；位置表的标题取自投影，
 * 所以也经过这里。编号定义从 numbering.xml 读出之后交给这里，这里不读 XML，也不依赖任何模块。
 *
 * 数法：每套编号（w:numId）各自计数；某一级第一次出现时从它的起始值数起（w:num 里的 w:startOverride 先于 w:lvl 里的 w:start），
 * 之后每出现一次加一；上一级加一时更深的级别重新数。编号定义里没有这一级的段落不数。
 * 写法：级别文字（w:lvlText）里的 %1 到 %9 换成对应级别此刻的数，按那一级的格式（w:numFmt）写；法律式编号（w:isLgl）一律写十进制。
 */

/** 一套编号里的一级。 */
export interface NumberingLevel {
  /** 起始值（已经按 w:startOverride 覆盖过）。 */
  start: number;
  /** 编号格式（w:numFmt），没写时为 undefined。 */
  format?: string;
  /** 级别文字（w:lvlText），没写时为空。 */
  text: string;
  /** 法律式编号（w:isLgl）：引用到的各级都写十进制。 */
  legal: boolean;
}

const CN = "〇一二三四五六七八九";
const chinese = (n: number) => n < 10 ? CN[n] : n < 20 ? "十" + (n % 10 ? CN[n % 10] : "") : n < 100 ? CN[Math.floor(n / 10)] + "十" + (n % 10 ? CN[n % 10] : "") : String(n);
function roman(n: number): string {
  let out = "";
  for (const [v, s] of [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]] as const) {
    while (n >= v) { out += s; n -= v; }
  }
  return out;
}
/** 编号数字按 Word 的编号格式写出来；认不出的格式写十进制。 */
export function formatNumber(n: number, format: string | undefined): string {
  switch (format) {
    case "decimalZero": return String(n).padStart(2, "0");
    case "lowerLetter": return String.fromCharCode(97 + (n - 1) % 26).repeat(Math.floor((n - 1) / 26) + 1);
    case "upperLetter": return String.fromCharCode(65 + (n - 1) % 26).repeat(Math.floor((n - 1) / 26) + 1);
    case "lowerRoman": return roman(n).toLowerCase();
    case "upperRoman": return roman(n);
    case "chineseCounting": case "chineseCountingThousand": case "japaneseCounting": case "taiwaneseCounting": return chinese(n);
    case "ideographTraditional": return "甲乙丙丁戊己庚辛壬癸"[(n - 1) % 10];
    case "decimalEnclosedCircle": case "decimalEnclosedCircleChinese": return n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : String(n);
    case "decimalFullWidth": case "decimalFullWidth2": return [...String(n)].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("");
    default: return String(n);
  }
}

/** 一段的编号：写出来的文字（已去掉首尾空白）、是不是项目符号。 */
export interface NumberingLabel {
  label: string;
  bullet: boolean;
}

/** 按文件里的先后逐段数编号。levels 的键是「numId:级别」。 */
export class NumberingCounter {
  private counters = new Map<string, (number | undefined)[]>();
  private levels: Map<string, NumberingLevel>;
  constructor(levels: Map<string, NumberingLevel>) {
    this.levels = levels;
  }

  /** 这一段的编号（numId 与级别 ilvl 已经沿样式找好）；编号定义里没有这一级时是空的，也不计数。 */
  next(numId: string, ilvl: number): NumberingLabel {
    const lv = this.levels.get(`${numId}:${ilvl}`);
    if (!lv) return { label: "", bullet: false };
    const c = this.counters.get(numId) ?? [];
    this.counters.set(numId, c);
    c[ilvl] = (c[ilvl] ?? lv.start - 1) + 1;
    c.length = ilvl + 1;
    if (lv.format === "bullet") return { label: "", bullet: true };
    if (lv.format === "none") return { label: "", bullet: false };
    const label = lv.text.replace(/%(\d)/g, (_, k: string) => {
      const i = Number(k) - 1;
      const l = this.levels.get(`${numId}:${i}`);
      return formatNumber(c[i] ?? l?.start ?? 1, lv.legal ? "decimal" : l?.format);
    });
    return { label: label.trim(), bullet: false };
  }
}
