// 任务页上传框选好文件之后弹出的对话框：这份文件是这次要整理的材料，还是放进知识库供助手参考的资料。
// 选「整理时要参考的资料」时展开三项：放进哪个库（含「新建一个库…」）、这是什么资料（五种种类）、这个任务是否选用了那个库。
// 那个库这个任务还没有选用时提示改用琥珀色，并给一个默认勾上的「同时让这个任务选用它」。上传由调用方按选择去做。

import { useEffect, useState } from "react";
import { Button, Checkbox, Input, Modal, Select } from "antd";
import type { KnowledgeKind, KnowledgeLibrary, ServiceInfo } from "../api/types";
import { formatBytes } from "../model/format";
import { GENERAL, docCountText, sortedLibraries } from "../model/knowledge";

export type UploadChoice =
  | { dest: "material" }
  | { dest: "knowledge"; library: string | null; newName: string; kind: KnowledgeKind; alsoSelect: boolean };

const NEW = "__new__";

export function UploadDestinationModal({ file, libraries, selected, info, busy, onCancel, onUpload }: {
  /** 选好的文件；null 时对话框关着。 */
  file: File | null;
  libraries: KnowledgeLibrary[];
  /** 这个任务现在选用的库。 */
  selected: string[];
  info: ServiceInfo | null;
  busy: boolean;
  onCancel: () => void;
  onUpload: (choice: UploadChoice) => void;
}) {
  const kinds = info?.knowledge_upload?.kinds ?? [];
  const [dest, setDest] = useState<"material" | "knowledge">("material");
  const [library, setLibrary] = useState<string>(GENERAL);
  const [newName, setNewName] = useState("");
  const [kind, setKind] = useState<KnowledgeKind>(kinds[0]?.kind ?? "standard");
  const [alsoSelect, setAlsoSelect] = useState(true);
  // 换了一份文件就从头选。
  useEffect(() => {
    setDest("material");
    setLibrary(GENERAL);
    setNewName("");
    setKind(kinds[0]?.kind ?? "standard");
    setAlsoSelect(true);
  }, [file]);

  const libs = sortedLibraries(libraries);
  const creating = library === NEW;
  const chosen = libs.find((l) => l.id === library) ?? null;
  const chosenName = creating ? newName.trim() || "新建的库" : chosen?.name ?? "";
  const inTask = !creating && selected.includes(library);
  const selectedNames = libs.filter((l) => selected.includes(l.id)).map((l) => l.name).join("、");
  const note = dest === "material" ? "上传之后会出现在「材料清单」里。" : `上传之后会出现在知识库「${chosenName}」里，不会出现在「材料清单」里。`;
  const ready = dest === "material" || !creating || newName.trim() !== "";

  const upload = () => onUpload(dest === "material" ? { dest }
    : { dest, library: creating ? null : library, newName: newName.trim(), kind, alsoSelect: !inTask && alsoSelect });

  return (
    <Modal title="这份文件用来做什么？" open={!!file} onCancel={onCancel} destroyOnHidden width="min(36rem, 94vw)"
      footer={<div className="updest-foot"><span className="fnote" data-testid="upload-note">{note}</span>
        <Button onClick={onCancel}>取消</Button>
        <Button type="primary" onClick={upload} disabled={!ready} loading={busy} data-testid="upload-confirm">上传</Button></div>}>
      {file && <div className="updest-file"><span>{file.name}</span><span className="fs">{formatBytes(file.size)}</span></div>}
      <div className="updest-opts">
        <label className={`updest-opt${dest === "material" ? " on" : ""}`}>
          <input type="radio" name="updest" checked={dest === "material"} onChange={() => setDest("material")} data-testid="dest-material" />
          <span><span className="ot">这次要整理的材料</span><br /><span className="od">助手会把它从头到尾读完，整理成条目，条目的来源指向它。</span></span>
        </label>
        <label className={`updest-opt${dest === "knowledge" ? " on" : ""}`}>
          <input type="radio" name="updest" checked={dest === "knowledge"} onChange={() => setDest("knowledge")} data-testid="dest-knowledge" />
          <span><span className="ot">整理时要参考的资料</span><br /><span className="od">放进知识库。助手需要时到里面查找，不会把它整理成条目。</span></span>
        </label>
      </div>
      {dest === "knowledge" && (
        <div className="updest-kb">
          <div>
            <div className="flabel">放进哪个库</div>
            <Select value={library} onChange={setLibrary} style={{ width: "100%" }} data-testid="dest-library"
              options={[
                ...libs.map((l) => ({ value: l.id, label: l.id === GENERAL ? `${l.name}（每个任务都会用到）` : `${l.name}（${docCountText(l)}）` })),
                { value: NEW, label: "新建一个库…" },
              ]} />
            {creating && <Input style={{ marginTop: "0.4rem" }} value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder="新库的名字，例如：城北区图书馆的资料" data-testid="dest-new-name" />}
          </div>
          <div>
            <div className="flabel">这是什么资料</div>
            <div className="updest-seg">
              {kinds.map((k) => (
                <label key={k.kind} className={kind === k.kind ? "on" : ""}>
                  <input type="radio" name="updest-kind" checked={kind === k.kind} onChange={() => setKind(k.kind)} />{k.name}
                </label>
              ))}
            </div>
            <div className="seg-note">种类只是一个标签，方便分辨。不管哪一种，助手都只看到文档的清单，需要时再到文档里查找相关的片段。</div>
          </div>
          <div className={`updest-hint${inTask ? "" : " amber"}`} data-testid="dest-hint">
            {inTask
              ? `这个任务现在选用了：${selectedNames}。放进去之后，助手下一次会话开始时就查得到。`
              : `这个任务还没有选用「${chosenName}」。放进去之后，要在任务页上选用它，助手才查得到。`}
            {!inTask && (
              <div><Checkbox checked={alsoSelect} onChange={(e) => setAlsoSelect(e.target.checked)} data-testid="dest-also-select">同时让这个任务选用它</Checkbox></div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
