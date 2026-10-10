# sim：用户 agent（模拟用户）

一个扮演用户的 agent，按一份用户画像（user persona）与执行者多轮对话，用来积累执行者的失败样本。它用 pi 以 RPC 方式跑，
只有两个工具：「看界面」（look）与「回应」（respond），两个工具都走后端任务服务的 HTTP 接口，与网页前端走同一条路。
演练结束后由代码做第一层（用户 agent 有没有按画像演）与第二层（库里的事实）判定。

## 目录

| 路径 | 是什么 |
|---|---|
| `extension.ts` | 用户 agent 的扩展入口，只登记 look 与 respond。 |
| `tools/look.ts`、`tools/respond.ts` | 两个工具。respond 的「单独调用、合格即结束本轮」骨架引用 `agent/src/lib/speak.ts`。 |
| `lib/screen.ts` | 界面渲染与回应翻译的纯函数（执行者的话怎样显示、按钮走 actions 还是 messages）。 |
| `lib/backend.ts` | 两个工具访问后端的小函数（Node 自带 fetch），后端地址等从环境变量取。 |
| `profiles/user_agent.json` | 用户 agent 的启动配置（模型 gpt-6-luna、思考档位 medium、工具只有 look,respond）。 |
| `prompts/user_agent_system_prompt.md` | 用户 agent 的系统提示；`{{用户画像}}` 处由 `launch_user.py` 填入画像里给扮演者读的部分。 |
| `personas/librarian.json` | 示例用户画像，与 examples/library-lending 配套。隐藏事实的关键词与接受底线的判据给判定程序用，不给扮演者看。 |
| `personas/library-short.json`、`personas/library-long.json` | 评测用的两份画像，分别与示例材料的短版（`requirements.md`）和长版（`requirements-styled.docx`）配套。 |
| `expectations/` | 评测用的「至少应有」清单，每份材料一张，与上面两份画像同名。 |
| `material_text.py` | 取一份材料的文字：文本材料按原文读，Word 材料取产品的文字版（经 `agent/src/cli/docx_projection.mts`）。 |
| `launch_user.py` | 起用户 agent：按用户画像拼好系统提示，再把 `user_agent_driver.mts` 作为子进程启动，经标准输入与标准输出按行交换 JSON。 |
| `user_agent_driver.mts` | Node 驱动程序：用后端的会话类（`backend/src/pi_session.ts`）组装命令行、启动并驱动用户 agent 的 pi，归档也由会话类写。 |
| `run.py` | 驾驭程序：跑一次演练。 |
| `judge.py` | 判定程序：第一、二层判定，出判定报告。 |
| `evals.py` | 评测的命令行：多遍演练、每遍算灯与清单、写汇总、两次评测的对照。 |
| `lamps.py` | 评测的灯：工作的五个阶段各自「算够」的判据，一共十二盏。 |
| `expectations.py` | 按「至少应有」清单核对一遍演练的结果。 |
| `questions.py` | 列出助手问过的问题，挑出模拟用户答不上的问题。 |
| `tests/` | 单元测试与集成测试。 |

## 跑一次演练

需要的环境：Node.js 与 PATH 里的 pi（驾驭程序用 `node backend/src/main.mts` 起任务服务，用户 agent 经 Node 驱动程序启动）；
能导入观测台包 `taskwright_observatory` 的 `python3`（判定程序用它读任务库、核对完成条件）。不需要旧版的 Python 后端包。
没有安装观测台包时，把它放进 `PYTHONPATH` 也可以：`PYTHONPATH=observatory:. python3 -m sim.run …`。

```bash
# 在代码仓根目录下；Langfuse 可选，接法见 docs/deployment.md
python3 -m sim.run --persona sim/personas/librarian.json --materials-dir examples/library-lending --port 8791
```

驾驭程序自己起一个后端任务服务（端口由 `--port` 给），建任务、上传材料、新建会话，起用户 agent，每轮用一句固定的话唤起它，
直到停止条件；记录写进 `<sim-root>/sim-<序号>/`（`--sim-root` 缺省为当前目录下的 `sim-runs`），最后出 `判定报告.md` 并往 `<sim-root>/sim-summary.jsonl` 追加一行。
Langfuse 环境标签是 `sim-<序号>`，执行者与用户 agent 两边相同。单独重出判定报告：`python3 -m sim.judge <演练目录>`。

## 评测

评测用来回答「助手的说明改了之后，是变好了还是变差了」：同一份画像接连演练几遍，每遍用同一把尺子量，再把两次评测并排比。
尺子有两层，都由程序算，不用模型当裁判：

- **灯**：工作的五个阶段（核读材料、澄清、整理建模、写条目、评审确认）各自「算够」的判据，一共十二盏，例如「每个标签为『流程』的页
  至少有一条以『例外：』开头的例子」「没有待核实的条目」。灯只说明这一段还差什么。现在按演练结束时的任务数据算。
  一盏灯的结果是通过、未通过、不适用（它要看的那一类页或条目一个都没有）或算不了（要用的数据取不到）；后两种不计入通过率。
- **「至少应有」清单**：每份材料一张，写明读透这份材料至少应当整理出哪些主题页、例外、问题与条目。清单是下限，
  按关键词组核对：一组里是同义的几种写法，出现一种就算命中。

```bash
# 跑一次评测：三遍，每遍最多 30 轮（画像里的隐藏事实多，缺省的 12 轮问不完）
python3 -m sim.evals run --persona sim/personas/library-short.json --expect sim/expectations/library-short.json \
    --materials-dir examples/library-lending --repeat 3 --max-rounds 30 --port 8791 --label <这一次评测的名字>

# 换了清单，或者往画像的「答不上的说法」里加了新说法之后，对跑过的一遍重算（同一次评测的另外几遍一并重算）
python3 -m sim.evals judge <演练目录> [--expect <清单文件>] [--persona <画像文件>]

# 两次评测的对照
python3 -m sim.evals compare <前一次的标签> <后一次的标签>
```

`run` 的其余参数与 `sim.run` 相同。几遍是一遍接一遍跑的，每遍各自起后端。标签是这一次评测的名字（例如助手说明的版本），
在一个 `--sim-root` 里不能重复；一次 `run` 只接一份画像，两份材料就是两次 `run`、两个标签。

写出的文件：

| 文件 | 内容 |
|---|---|
| `<sim-root>/sim-<序号>/评测.json` | 这一遍的灯、清单的核对结果、助手问过的问题、模拟用户答不上的问题。 |
| `<sim-root>/评测汇总_<标签>.md` 与 `.json` | 一次评测的汇总：每盏灯每一遍的结果与通过了几遍，清单每一组命中了几遍，各遍的问题。 |
| `<sim-root>/evals.jsonl` | 每次评测一行：时间、标签、代码提交号、模型、材料、画像、清单、遍数、各灯通过率、清单命中率、各遍目录。 |

**模拟用户答不上的问题**是请人过目的清单，不是结论：模拟用户的话里出现了「不知道」「要问一下」一类说法（程序自带几种，
画像的「答不上的说法」一键可以再列）时，把上一轮助手问的问题列出来。画像里确实没有这件事的，补进画像的隐藏事实再重新评测；
上一轮的问题碰到了某条隐藏事实的「问到的迹象」时单独列出，那多半是模拟用户演错了。

在观测台里看：`python3 -m taskwright_observatory --sim-root <sim-root>`，「评测」页签有评测列表、一次评测的详情与两次评测的对照，
详情里每一格都能点到那一遍演练的任务页。

不接真模型试一遍：先起假模型端点（`tools/fake-model/`，`--agent-dir` 给一个新建的空目录），把 `PI_CODING_AGENT_DIR` 设成那个目录，
`run` 时加 `--profile fake --user-model fake/fake-model`。`tests/test_evals.py` 里有一份让助手与模拟用户各走两轮的脚本。

## 测试

```bash
cd sim && node --test 'tests/*.test.ts'
cd .. && python3 -m pytest sim -q
```
