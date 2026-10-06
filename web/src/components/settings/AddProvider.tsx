// 添加模型服务：第一步选它提供哪一类模型（用途），第二步选种类，第三步填写，「保存」时后端先检查连得上。
// 一个模型服务只提供一类模型，同一个地址两类模型都有时添加两次；没有这类模型的种类不列出来。
// 被拒（rejected）时停在这个画面，按 data.field 把后端的那句话写在对应的输入框下面；名称可以不填，由后端按种类起名。

import { useState } from "react";
import { Button, Input, Radio } from "antd";
import { RightOutlined } from "@ant-design/icons";
import { api, ApiError } from "../../api/client";
import type { ModelType, Provider, ProviderKind } from "../../api/types";
import { useToast } from "../Toasts";
import { LoginCommand } from "./ProviderDetail";
import { DEFAULT_URL, KIND_NAME, LOGIN_NOTE, ONE_PURPOSE_TEXT, PURPOSES, PURPOSE_ORDER, kindChoices, kindGroup } from "./text";

type Field = "name" | "base_url" | "api_key" | "kind" | "purpose";

export function AddProvider({ onAdded, onCancel }: { onAdded: (provider: Provider) => void; onCancel: () => void }) {
  const toast = useToast();
  const [purpose, setPurpose] = useState<ModelType>("language");
  const [kind, setKind] = useState<ProviderKind>("ollama");
  const [name, setName] = useState("");
  const [url, setUrl] = useState(DEFAULT_URL.ollama ?? "");
  const [key, setKey] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const group = kindGroup(kind);
  const kinds = kindChoices(purpose);

  const choose = (next: ProviderKind) => {
    setKind(next);
    setUrl(DEFAULT_URL[next] ?? "");
    setKey("");
    setAdvanced(false);
    setErrors({});
  };

  const choosePurpose = (next: ModelType) => {
    setPurpose(next);
    setErrors({});
    // 选着的种类没有这类模型时，回到头一个种类。
    if (PURPOSES[next].notOfferedBy.includes(kind)) choose(kindChoices(next)[0][0]);
  };

  const save = async () => {
    setSaving(true);
    setErrors({});
    try {
      const body: { purpose: ModelType; kind: ProviderKind; name?: string; base_url?: string; api_key?: string } = { purpose, kind };
      if (name.trim()) body.name = name.trim();
      if (group !== "codex" && url.trim()) body.base_url = url.trim();
      if ((group === "cloud" || group === "compatible") && key.trim()) body.api_key = key.trim();
      const { provider } = await api.addProvider(body);
      toast.success(`已添加模型服务「${provider.name}」。`);
      onAdded(provider);
    } catch (error) {
      if (error instanceof ApiError && error.code === "rejected") {
        const field = (error.data.field as Field | undefined) ?? "kind";
        setErrors({ [field]: error.message });
        if (field === "base_url" && group === "cloud") setAdvanced(true);
      } else {
        toast.error(error instanceof ApiError ? error.message : "添加没有成功。");
      }
    } finally {
      setSaving(false);
    }
  };

  const status = (field: Field) => (errors[field] ? "error" as const : undefined);
  const urlRow = (required: boolean) => (
    <div className="frow">
      <div className="flabel">接口地址{required && <span className="req">*</span>}</div>
      <Input className="mono" value={url} status={status("base_url")} onChange={(e) => setUrl(e.target.value)} data-testid="add-url" />
      {errors.base_url && <div className="ferr" data-testid="err-base_url">{errors.base_url}</div>}
      {group === "local" && <div className="fhelp">这是 {KIND_NAME[kind]} 的默认地址。模型服务运行在内网的另一台电脑上时，把 127.0.0.1 换成那台电脑的地址。</div>}
      {group === "cloud" && <div className="fhelp">通常不用改。</div>}
    </div>
  );
  const nameRow = (
    <div className="frow">
      <div className="flabel">名称<span className="opt2">可以不填</span></div>
      <Input value={name} status={status("name")} onChange={(e) => setName(e.target.value)} data-testid="add-name" />
      {errors.name && <div className="ferr" data-testid="err-name">{errors.name}</div>}
      <div className="fhelp">在清单里显示的名字。不填时按种类起一个名字。</div>
    </div>
  );
  const keyRow = (optional: boolean) => (
    <div className="frow">
      <div className="flabel">API 密钥{optional ? <span className="opt2">可以不填</span> : <span className="req">*</span>}</div>
      <Input.Password value={key} status={status("api_key")} onChange={(e) => setKey(e.target.value)} placeholder="输入完整的 API 密钥" autoComplete="off" data-testid="add-key" />
      {errors.api_key && <div className="ferr" data-testid="err-api_key">{errors.api_key}</div>}
      <div className="fhelp">存进去之后不再显示，只显示末四位。</div>
    </div>
  );

  return (
    <div data-testid="add-provider">
      <div className="muted small crumb"><a role="button" onClick={onCancel}>模型</a> › 添加模型服务</div>
      <div className="page-title"><h1>添加模型服务</h1></div>
      <p className="lede">先选它提供哪一类模型，再选种类、填写。保存时会检查能不能连上这个模型服务。</p>
      <div className="section-title first">第一步：选它提供哪一类模型</div>
      <Radio.Group value={purpose} onChange={(e) => choosePurpose(e.target.value)} className="kinds" data-testid="add-purpose">
        {PURPOSE_ORDER.map((p) => (
          <Radio key={p} value={p} className={`opt${p === purpose ? " on" : ""}`} data-testid={`purpose-${p}`}>
            <span className="ot">{PURPOSES[p].name}</span><span className="od">{PURPOSES[p].choice}</span>
          </Radio>
        ))}
      </Radio.Group>
      <div className="fhelp">{ONE_PURPOSE_TEXT}</div>
      {errors.purpose && <div className="ferr" data-testid="err-purpose">{errors.purpose}</div>}
      <div className="section-title">第二步：选种类</div>
      <Radio.Group value={kind} onChange={(e) => choose(e.target.value)} className="kinds" data-testid="add-kind">
        {kinds.map(([k, desc]) => (
          <Radio key={k} value={k} className={`opt${k === kind ? " on" : ""}`} data-testid={`kind-${k}`}>
            <span className="ot">{KIND_NAME[k]}</span><span className="od">{desc}</span>
          </Radio>
        ))}
      </Radio.Group>
      <div className="section-title">第三步：填写 <span className="plain">（{KIND_NAME[kind]}，{PURPOSES[purpose].name}）</span></div>
      <div className="card frm">
        {group === "local" && <>{nameRow}{urlRow(false)}<div className="fhelp">本地的模型服务不需要 API 密钥。</div></>}
        {group === "cloud" && (
          <>
            {nameRow}{keyRow(false)}
            <div className={`fold${advanced ? " open" : ""}`}>
              <a role="button" className="fh" onClick={() => setAdvanced(!advanced)}><RightOutlined className="fic" />高级</a>
              {advanced && <div className="fb">{urlRow(false)}</div>}
            </div>
          </>
        )}
        {group === "compatible" && <>{nameRow}{urlRow(true)}{keyRow(true)}</>}
        {group === "codex" && (
          <div className="login">
            <div>保存之后，在这个模型服务的详情里显示是否已经登录。还没有登录的话，请在运行任务服务的这台电脑上打开命令行，运行下面第一行的命令，等它启动后输入第二行的指令，照提示登录。</div>
            <LoginCommand />
            <div className="fhelp">{LOGIN_NOTE}</div>
          </div>
        )}
        {errors.kind && <div className="ferr" data-testid="err-kind">{errors.kind}</div>}
      </div>
      <div className="formfoot">
        <Button type="primary" loading={saving} onClick={() => void save()} data-testid="add-save">{saving ? "正在检查连得上……" : "保存"}</Button>
        <Button onClick={onCancel} disabled={saving}>取消</Button>
      </div>
    </div>
  );
}
