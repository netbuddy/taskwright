/**
 * PDF 材料的文字规范化：整理（写投影时对每块文字做一次）与比较（核对摘录、在页面的文字层里找摘录时两边都做）。
 *
 * 为什么要有：PDF 的文字层里，字的编码不一定是原文的编码。实测到的有——
 * - 部首字符：常用汉字被写成康熙部首区（U+2F00 到 U+2FD5）或部首补充区（U+2E80 到 U+2EFF）里外形相同的字符，
 *   例如「工」写成 U+2F2F、「风」写成 U+2EDB。助手读到的是部首字符，写出来的是通用汉字，逐字核对就对不上；
 * - 两端对齐的行里，字与字之间被插了空格（「单 时 ， 汇 率」）；
 * - 软连字符与零宽字符；
 * - 英文单词在行末被断开时多出的连字符，它与词里本来的连字符在文字层里分不开。
 *
 * 两层各做什么：
 * - tidyPdfText（整理）：部首字符换成通用汉字；去掉软连字符与零宽字符；连续三个以上「中日韩字符加一个空格」的地方把空格去掉。
 *   别的原样保留，连字符不动（去掉会把 high-level 这类词改错）。
 * - comparablePdfText（比较）：先整理；再做 NFKC（全角与半角、连字、兼容字符归到同一个写法）；去掉全部空白；去掉连字符。
 *   它仍然是逐字相等的比较，只是不比较这几样。
 *
 * 部首补充区的对照表取自 Unicode 18.0.0 的 EquivalentUnifiedIdeograph.txt
 * （https://www.unicode.org/Public/UCD/latest/ucd/EquivalentUnifiedIdeograph.txt）里 U+2E81 到 U+2EF3 的 114 行；
 * U+2E80 在那份文件里没有对应的字，不换。康熙部首区的 214 个字符用 NFKC 就能换对，不用表。
 *
 * 页面也导入本文件，所以这里不导入任何模块，只用字符串自带的方法。字符范围一律用码位数字写，源文件里不出现看不见的字符。
 */

/** 部首补充区的字符与它对应的通用汉字，两个一对，用空格隔开（有 14 个通用汉字在基本平面之外，所以按码位拆，不按下标拆）。 */
const RADICAL_SUPPLEMENT_PAIRS = "⺁厂 ⺂乛 ⺃乚 ⺄乙 ⺅亻 ⺆冂 ⺇𠘨 ⺈刀 ⺉刂 ⺊卜 ⺋㔾 ⺌小 ⺍小 ⺎兀 ⺏尣 ⺐尢 ⺑𡯂 ⺒巳 ⺓幺 ⺔彑 ⺕𫜹 ⺖忄 ⺗心 ⺘扌 ⺙攵 ⺛旡 ⺜日 ⺝月 ⺞歺 ⺟母 ⺠民 ⺡氵 ⺢氺 ⺣灬 ⺤爫 ⺥爫 ⺦丬 ⺧牛 ⺨犭 ⺩王 ⺪𤴔 ⺫目 ⺬示 ⺭礻 ⺮𥫗 ⺯糹 ⺰纟 ⺱罓 ⺲罒 ⺳㓁 ⺴冗 ⺵𦉫 ⺶羊 ⺷𦍌 ⺸𦍋 ⺹耂 ⺺肀 ⺻聿 ⺼肉 ⺽𦥑 ⺾艹 ⺿艹 ⻀艹 ⻁虎 ⻂衤 ⻃覀 ⻄西 ⻅见 ⻆角 ⻇𧢲 ⻈讠 ⻉贝 ⻊𧾷 ⻋车 ⻌辶 ⻍辶 ⻎辶 ⻏邑 ⻐钅 ⻑長 ⻒镸 ⻓长 ⻔门 ⻕𨸏 ⻖阝 ⻗雨 ⻘青 ⻙韦 ⻚页 ⻛风 ⻜飞 ⻝食 ⻞𩙿 ⻟飠 ⻠饣 ⻡𩠐 ⻢马 ⻣骨 ⻤鬼 ⻥鱼 ⻦鸟 ⻧卤 ⻨麦 ⻩黄 ⻪黾 ⻫斉 ⻬齐 ⻭歯 ⻮齿 ⻯竜 ⻰龙 ⻱龜 ⻲亀 ⻳龟";

const RADICAL_SUPPLEMENT = new Map<string, string>(RADICAL_SUPPLEMENT_PAIRS.split(" ").map((pair) => {
  const [radical, ideograph] = Array.from(pair);
  return [radical, ideograph];
}));

const at = (codePoint: number) => String.fromCodePoint(codePoint);
const range = (from: number, to: number) => `${at(from)}-${at(to)}`;

/** 两个部首区：部首补充 U+2E80 到 U+2EFF，康熙部首 U+2F00 到 U+2FD5。 */
const RADICAL = new RegExp(`[${range(0x2e80, 0x2fd5)}]`, "g");
/** 软连字符 U+00AD、零宽字符 U+200B 到 U+200D、字节顺序标记 U+FEFF。 */
const INVISIBLE = new RegExp(`[${at(0xad)}${range(0x200b, 0x200d)}${at(0xfeff)}]`, "g");
/** 中日韩字符：部首、标点（不含全角空格）、假名、汉字 U+2E80 到 U+9FFF（跳过 U+3000），兼容汉字 U+F900 到 U+FAFF，全角与半角形式 U+FF00 到 U+FFEF。 */
const CJK = `[${range(0x2e80, 0x2fff)}${range(0x3001, 0x9fff)}${range(0xf900, 0xfaff)}${range(0xff00, 0xffef)}]`;
/** 连续三个以上「中日韩字符加一个空格」：两端对齐撑开的字。 */
const SPACED_CJK = new RegExp(`(?:${CJK} ){2,}${CJK}`, "g");
/** 连字符：连字符减号 U+002D、连字符 U+2010、不换行连字符 U+2011。 */
const HYPHEN = new RegExp(`[${at(0x2d)}${at(0x2010)}${at(0x2011)}]`, "g");

/** 整理：写 PDF 投影时对每块文字做一次（见开头的说明）。 */
export function tidyPdfText(text: string): string {
  return text
    .replace(RADICAL, (c) => RADICAL_SUPPLEMENT.get(c) ?? c.normalize("NFKC"))
    .replace(INVISIBLE, "")
    .replace(SPACED_CJK, (run) => run.replace(/ /g, ""));
}

/** 比较：核对摘录时两边都做，做完逐字比较（见开头的说明）。 */
export function comparablePdfText(text: string): string {
  return tidyPdfText(text).normalize("NFKC").replace(/\s+/g, "").replace(HYPHEN, "");
}
