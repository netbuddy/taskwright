// 测试夹具：写出位置规则用的小 Word 文件（定义在 ../location_fixtures.ts），以及它们、三份标题样例与主样例的位置表
// （「文件名.docx.locations.json」，lib/docx_location_input.ts 算出），都放到 web/src/test/fixtures/。前端比较测试读位置表，
// 不直接调用后端的整理代码（它依赖 Node 自带模块）；agent/tests/docx_locations.test.ts 核对存着的与现算的逐字相同。
// 改了定义或规则后重新运行：node agent/tests/fixtures/build_location_docx.mts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locationTable } from "../../src/lib/docx_location_input.ts";
import { locationFixtures, locationTableFixtures } from "../location_fixtures.ts";

const dir = join(import.meta.dirname, "../../../web/src/test/fixtures");
for (const [name, bytes] of Object.entries(locationFixtures())) writeFileSync(join(dir, name), bytes);
for (const [name, text] of Object.entries(locationTableFixtures(readFileSync, locationTable))) writeFileSync(join(dir, name), text, "utf-8");
