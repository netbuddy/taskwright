# 改动之后跑哪些测试

> 本文写给改 Taskwright 代码的开发者。本文暂只有中文版。

整套测试（`scripts/test-all.sh`）要跑好几分钟，其中有一批测试会起真的后端与 pi 进程，更慢。日常改一处代码时，只需要跑受这处改动影响的那几份测试。`scripts/affected-tests.mts` 按改动的文件机械地算出这份清单，不靠人去回忆「这个函数还有谁在用」。

## 1 怎么用

```bash
node scripts/affected-tests.mts                    # 缺省：工作树相对 HEAD 的改动，加上还没跟踪的新文件
node scripts/affected-tests.mts --since main       # 某个提交或分支以来的全部改动（含还没提交的），加上未跟踪的文件
node scripts/affected-tests.mts --files agent/src/lib/stage_read.ts web/src/model/board.ts
node scripts/affected-tests.mts --json             # 同样的内容输出成 JSON，给别的脚本用
```

输出分三节，依次是 agent、backend、web 三套各自要跑的测试文件，路径都相对仓库根目录。每一节里普通测试排在前面，下面两类排在后面，并在行尾加标注：

- **真栈**：这类测试会起一个真的后端子进程，后端再起 pi，每份要几秒到几十秒。判定方法是看测试是否经测试辅助文件（例如 `backend/tests/helpers.ts` 的 `spawnBackend`）依赖后端入口 `backend/src/main.mts`。
- **计时类**：这类测试在机器负载高时偶尔超时失败，名单写在脚本的 `TIMING_TESTS` 里。它们失败时先看 `uptime`，再单独重跑那一份；单独跑能通过就不是改动造成的，不要去改测试。

如果有路径规则命中（见第 3 节），输出末尾会列出命中的规则，以及每条规则为什么要跑那几份测试。如果改动里只有说明文档这类文件，清单为空，并写明不用跑测试。

拿到清单后按套跑：

```bash
(cd agent && node --test tests/a.test.ts tests/b.test.ts)
(cd backend && node --test --import ./tests/deadline.ts tests/c.test.ts)
(cd web && npx vitest run src/test/d.test.tsx)
```

脚本只覆盖这三套。`sim` 的测试与 `observatory`、`sim` 的 pytest 不在清单里，改了这两个目录要自己跑它们。

## 2 清单是怎么算出来的

脚本不引第三方的依赖分析库，全用正则读源码，建一张三套共用的依赖图，再从改动文件出发反向走到测试文件。图里有下面几种边：

1. **导入边**：`import … from "x"`、`export … from "x"`、`import "x"`、`import("x")` 里写的相对路径。缺后缀的按 `.ts`、`.tsx`、`.mts`、`.mjs`、`.js`、`/index.ts` 的顺序补齐。web 跨包导入 `agent/src/lib` 的边也在图里，所以改 agent 的库文件会带上 web 的测试。
2. **字符串拼的路径**：测试文件里用 `join(根, "段", …)` 或 `resolve(根, "段", …)` 拼出来的仓内文件或目录，以及字面写着的仓内路径（例如 `"agent/src"`、`"styles/task-page.css"`）。依赖的是目录时，改了目录下任何文件都算。
3. **测试辅助文件按名字传路径**：`helpers.ts` 这类辅助文件里的路径常量，只传给真正用到它们的测试。脚本把辅助文件按顶层声明切开，测试从辅助文件导入了哪几个名字，就只带上这几个名字（连同它们在同一份文件里用到的其他声明）拼出的路径。这样做是为了不让「导入了 helpers」就等于「依赖整个任务类型目录」。
4. **额外边**（脚本里的 `EXTRA_EDGES`）：运行时才连上、源码里看不出来的依赖。例如后端起 pi 时用 `-e` 交给它的扩展入口 `agent/src/extension.ts`。
5. **路径规则**（脚本里的 `PATH_RULES`）：读整个目录、清单或期望文件的扫描类与快照类测试，按改动路径直接列入。例如改 `task-types/` 下的任何文件都会列入 `observatory_parity`，因为它的期望文件里记着任务类型各文件的字节数与摘要值。

运行时的三处动态导入不进图，因为它们都不指向仓里的 TypeScript 源码：`backend/src/diagram_worker.ts` 的 `import(workerData.engine)`、`backend/src/export_docx.ts` 加载的 `docx_lib.mjs`、`backend/src/pdf_projection.ts` 加载的 pdfjs。

用 `--json` 时输出里另有 `unresolved` 一项，列出测试与辅助文件里看起来像仓内路径、却拼不出来的写法（通常是中间夹了变量）。这几处的依赖脚本看不到。新增测试时如果出现在这一项里，可以改成能解析的写法，或者给脚本补一条额外边或路径规则。

## 3 什么时候要改脚本

- 新写了一份扫描整个目录的测试（守卫类、快照类），在 `PATH_RULES` 里加一条，写明它读哪里、为什么要跑。
- 新加了运行时才连上的依赖（子进程、按配置加载的模块），在 `EXTRA_EDGES` 里加一条，写明依据。
- 发现某份测试经常偶发超时，把它加进 `TIMING_TESTS`。

脚本自己的测试在 `scripts/affected-tests.test.mts`，改了脚本要跑一遍：

```bash
node --test scripts/affected-tests.test.mts
```

## 4 这份清单的局限

清单是按源码静态推出来的，可能多列（例如改了一个只被一处用到的函数，导入它所在文件的测试都会列入），但目标是不漏。下面几种情况脚本看不到，需要自己判断：

- 测试读的路径中间夹了变量，拼不出来（看 `--json` 的 `unresolved`）。
- 改的是依赖包版本、`package.json` 或 Node 版本这类环境因素。
- 提交发布前仍然要跑一遍整套测试，不能用这份清单代替。
