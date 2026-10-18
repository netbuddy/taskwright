// 设置页面的「上传」一栏：任务材料与知识库文档单个文件的上限，各一个数，单位 MB，1 到后端给的最大值（50）。
// 数存在服务的设置文件里，所有人共用；保存之后下一次上传就按新的算。保存成功后重新取一次服务信息，
// 上传框的说明与发送之前的大小检查（都按服务信息里的上限）随之换成新的。

import { useCallback, useEffect, useState } from "react";
import { Button, InputNumber } from "antd";
import { api } from "../../api/client";
import type { UploadLimitsView } from "../../api/types";
import { useService } from "../ServiceControls";
import { useToast } from "../Toasts";

export function UploadSettings() {
  const service = useService();
  const toast = useToast();
  const [view, setView] = useState<UploadLimitsView | null>(null);
  const [material, setMaterial] = useState<number | null>(null);
  const [knowledge, setKnowledge] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const show = useCallback((next: UploadLimitsView) => {
    setView(next);
    setMaterial(next.material_mb);
    setKnowledge(next.knowledge_mb);
    setError("");
  }, []);
  useEffect(() => {
    api.uploadLimits().then(show).catch((e: Error) => setError(e.message));
  }, [show]);

  const cap = view?.cap_mb ?? 50;
  const valid = (v: number | null) => v !== null && Number.isInteger(v) && v >= 1 && v <= cap;
  const changed = !!view && (material !== view.material_mb || knowledge !== view.knowledge_mb);

  const save = async () => {
    if (!valid(material) || !valid(knowledge)) return;
    setSaving(true);
    try {
      show(await api.setUploadLimits(material!, knowledge!));
      service.refresh();
      toast.success("上传上限已保存，下一次上传就按新的算。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const row = (label: string, value: number | null, set: (v: number | null) => void, fallback: number | undefined, testid: string) => (
    <div className="inl" data-testid={testid}>
      <span className="ulabel">{label}</span>
      <InputNumber size="small" min={1} max={cap} precision={0} value={value} onChange={(v) => set(typeof v === "number" ? v : null)}
        disabled={!view} data-testid={`${testid}-input`} />
      <span>MB</span>
      {fallback !== undefined && <span className="muted small">没有改过时是 {fallback} MB</span>}
    </div>
  );

  return (
    <div data-testid="upload-settings">
      <div className="page-title"><h1>上传</h1></div>
      <p className="lede">
        单个文件最大能传多大。任务材料在任务页与对话区上传，知识库文档在知识库页面上传，两种各有一个上限，都不能超过 {cap} MB。
        这里的设置存在服务上，用这个服务的人都按它算。
      </p>

      <div className="section-title first">单个文件的上限</div>
      {row("任务材料", material, setMaterial, view?.defaults.material_mb, "upload-material")}
      {row("知识库文档", knowledge, setKnowledge, view?.defaults.knowledge_mb, "upload-knowledge")}
      {view && (!valid(material) || !valid(knowledge)) && <div className="ferr" data-testid="upload-invalid">请填 1 到 {cap} 的整数。</div>}
      <div className="inl">
        <Button size="small" type="primary" loading={saving} disabled={!changed || !valid(material) || !valid(knowledge)} onClick={() => void save()}
          data-testid="upload-save">保存</Button>
      </div>
      {error && <div className="ferr" data-testid="upload-error">{error}</div>}
    </div>
  );
}
