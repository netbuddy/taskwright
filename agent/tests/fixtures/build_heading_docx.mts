// 测试夹具：写出标题级别识别用的三份小 Word 文件（定义在 ../heading_fixtures.ts），放到 web/src/test/fixtures/，前后端测试都用。
// 改了定义后重新运行：node agent/tests/fixtures/build_heading_docx.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { headingFixtures } from "../heading_fixtures.ts";

const dir = join(import.meta.dirname, "../../../web/src/test/fixtures");
for (const [name, bytes] of Object.entries(headingFixtures())) writeFileSync(join(dir, name), bytes);
