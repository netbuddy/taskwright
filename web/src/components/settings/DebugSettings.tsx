// 设置页面的「调试」一栏，只在服务开着调试模式（带 --debug 启动）时出现。现在只有一项：提示词目录。
// 有阶段的任务每次运行开始时，系统提示由几份说明文件拼成；设了提示词目录之后，目录里有哪一份就用哪一份代替产品自带的，
// 没有的照旧。改了目录里的文件，下一句话就生效，不用重启。下面的清单列出固定的十五个文件名各自在目录里的情形。

import { useCallback, useEffect, useState } from "react";
import { Button, Input } from "antd";
import { api } from "../../api/client";
import type { PromptDirView } from "../../api/types";

const STATE_TEXT: Record<PromptDirView["files"][number]["state"], string> = { used: "用目录里的这一份", absent: "目录里没有，用原来的", refused: "目录里有，但是不用" };

export function DebugSettings() {
  const [view, setView] = useState<PromptDirView | null>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const show = useCallback((next: PromptDirView) => { setView(next); setValue(next.prompt_dir ?? ""); setError(""); }, []);
  const load = useCallback(() => {
    api.promptDir().then(show).catch((e: Error) => setError(e.message));
  }, [show]);
  useEffect(() => { load(); }, [load]);

  const save = async (path: string) => {
    setSaving(true);
    try {
      show(await api.setPromptDir(path));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dbg" data-testid="debug-settings">
      <div className="page-title"><h1>调试</h1></div>
      <p className="lede">
        这一栏只在服务带 --debug 启动时出现，请只在自己的电脑上用。
      </p>

      <div className="section-title first">提示词目录</div>
      <p className="lede">
        有阶段的任务实例，助手每次开始工作时拿到的说明由几份文件拼成。在这里填一个目录，目录里有哪一份文件，就用它代替原来的那一份；没有的照旧。
        改了目录里的文件，对助手说下一句话时就生效，不用重启。产品只读这个目录，不往里写。
      </p>
      <div className="inl">
        <Input size="small" placeholder="目录的绝对路径，例如 /data/prompts" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off"
          spellCheck={false} data-testid="prompt-dir-input" onPressEnter={() => void save(value)} />
        <Button size="small" type="primary" loading={saving} onClick={() => void save(value)} data-testid="prompt-dir-save">保存</Button>
        <Button size="small" disabled={saving || !view?.prompt_dir} onClick={() => void save("")} data-testid="prompt-dir-clear">不用目录</Button>
        <Button size="small" disabled={saving} onClick={load} data-testid="prompt-dir-reload">重新查看</Button>
      </div>
      {error && <div className="ferr" data-testid="prompt-dir-error">{error}</div>}
      {view && view.prompt_dir === null && <div className="note" data-testid="prompt-dir-none">现在没有设目录，用的都是原来的说明。</div>}
      {view?.note && <div className="ferr" data-testid="prompt-dir-note">{view.note}</div>}

      {view && view.prompt_dir !== null && (
        <table className="pfiles" data-testid="prompt-dir-files">
          <thead><tr><th>文件名</th><th>这一次运行会怎样</th></tr></thead>
          <tbody>
            {view.files.map((one) => (
              <tr key={one.name} className={one.state} data-testid={`prompt-file-${one.name}`}>
                <td><code>{one.name}</code></td>
                <td>{STATE_TEXT[one.state]}{one.reason ? `：${one.reason}` : "。"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="note">
        system.md 是系统提示，common.md 是每个阶段都要用的说明，reading.md、clarifying.md、modeling.md、writing.md、reviewing.md、document.md
        依次是核读材料、澄清、整理建模、写条目、评审确认、编写文档六个阶段各自的一段；task-type 目录下的同名文件是任务类型那一级的。
        一份空文件的意思是这一部分不要。
      </div>
    </div>
  );
}
