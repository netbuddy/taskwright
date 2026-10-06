// 一个模型服务的详情（设置页面「模型」一栏的右边）：名称、种类、用途、接口地址、API 密钥，获取模型列表，模型的清单，手工添加一个模型，删除。
// 清单里的模型是哪一类，看模型服务的用途，不逐个标；只有要填上下文长度的那一类（语言模型）才有上下文长度一栏。
// 清单里的改动（勾选、上下文长度、手工添加）先留在页面上，点「保存改动」一次交给后端（整个替换模型清单）。
// Codex 订阅另有「更新模型目录」：平时不访问外网，点了先问一句，再访问一次外网把可选模型的目录更新过来，更新好之后随即重新获取模型列表。
// editable 为假或者是手工登记的模型服务时只能看：按钮不显示，勾选框、下拉与输入框是灰的。现在的后端 editable 恒为 true，这条只读的路留着。

import { useEffect, useMemo, useState } from "react";
import { App as AntApp, Button, Checkbox, Input, InputNumber } from "antd";
import { CopyOutlined, PlusOutlined, ReloadOutlined, WarningOutlined } from "@ant-design/icons";
import { api, ApiError } from "../../api/client";
import type { ModelConfig, Provider, ProviderModel } from "../../api/types";
import { formatTime } from "../../model/format";
import { useToast } from "../Toasts";
import {
  LOGIN_COMMAND, LOGIN_INSTRUCTION, LOGIN_INSTRUCTION_HINT, LOGIN_NOTE, MANY_MODELS, PURPOSES, READONLY_PROVIDER_TEXT, REFRESH_CATALOG_CONFIRM, REFRESH_CATALOG_DONE,
  REFRESH_CATALOG_LABEL, RELOGIN_TEXT, allModelsListedText, formatNumber, inUseText, kindName,
  tellsModelType, whereToFind,
} from "./text";

export interface FetchNote {
  result: "listed" | "not_offered" | "failed";
  message: string;
}

interface Props {
  config: ModelConfig;
  provider: Provider;
  editable: boolean;
  /** 正在获取这个模型服务的模型列表。 */
  fetching: boolean;
  /** 上一次获取模型列表的结果（只留没有列出来时的那句话）。 */
  fetchNote: FetchNote | null;
  onFetch: () => void;
  /** 后端返回了这个模型服务的新样子（保存、检查、换密钥之后）。 */
  onChanged: (provider: Provider) => void;
  onDeleted: () => void;
  /** 清单里有没有保存的改动，切换到别的模型服务之前要问一句。 */
  onDirty: (dirty: boolean) => void;
}

type Row = ProviderModel & { fromUser?: boolean };

const sameModels = (a: ProviderModel[], b: ProviderModel[]) =>
  a.length === b.length && a.every((m, i) => m.id === b[i].id && m.enabled === b[i].enabled && m.context_window === b[i].context_window);

export function ProviderDetail({ config, provider, editable, fetching, fetchNote, onFetch, onChanged, onDeleted, onDirty }: Props) {
  const toast = useToast();
  const { modal } = AntApp.useApp();
  const canEdit = editable && provider.managed;
  const [rows, setRows] = useState<Row[]>(provider.models);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [whereOpen, setWhereOpen] = useState<Set<string>>(new Set());
  const [looking, setLooking] = useState<Set<string>>(new Set());
  const [lookNote, setLookNote] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState("");
  const [checking, setChecking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  // 后端给了新的模型清单（保存、获取模型列表之后）：页面上的清单换成它。
  useEffect(() => { setRows(provider.models); setSaveError(null); }, [provider.models]);
  const dirty = !sameModels(rows, provider.models);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);

  const change = (id: string, patch: Partial<Row>) => {
    setRows((list) => list.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    // 填上了上下文长度，先前「查不到」的那句话就不再显示。
    if (patch.context_window != null) setLookNote((n) => ({ ...n, [id]: "" }));
  };

  const many = rows.length > MANY_MODELS;
  const visible = useMemo(() => {
    const order = rows.map((m, i) => ({ m, i }));
    order.sort((a, b) => (many ? Number(b.m.enabled) - Number(a.m.enabled) : 0) || a.i - b.i);
    let list = order.map((x) => x.m);
    // 平时只列勾上的（按保存过的样子算，免得一取消勾选这一行就不见了）；展开之后可以按模型名筛选。
    if (many && !showAll) list = list.filter((m) => m.enabled || provider.models.find((p) => p.id === m.id)?.enabled || !provider.models.some((p) => p.id === m.id));
    else if (many && filter.trim()) list = list.filter((m) => m.id.toLowerCase().includes(filter.trim().toLowerCase()));
    return list;
  }, [rows, many, showAll, filter, provider.models]);
  const hidden = many && !showAll ? rows.length - visible.length : 0;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const { provider: next } = await api.updateProvider(provider.id, {
        models: rows.map((m) => ({ id: m.id, enabled: m.enabled, context_window: m.context_window })),
      });
      onChanged(next);
      toast.success(`已保存模型服务「${provider.name}」的模型清单。`);
    } catch (error) {
      if (error instanceof ApiError && (error.code === "rejected" || error.code === "in_use")) setSaveError(error.message);
      else toast.error(error instanceof ApiError ? error.message : "保存没有成功。");
    } finally {
      setSaving(false);
    }
  };

  const look = async (id: string) => {
    setLooking((s) => new Set(s).add(id));
    setLookNote((n) => ({ ...n, [id]: "" }));
    try {
      const got = await api.contextWindow(provider.id, id);
      if (got.context_window !== null) change(id, { context_window: got.context_window, context_source: "service" });
      else setLookNote((n) => ({ ...n, [id]: got.message }));
    } catch (error) {
      setLookNote((n) => ({ ...n, [id]: error instanceof ApiError ? error.message : "没有查到上下文长度。" }));
    } finally {
      setLooking((s) => { const next = new Set(s); next.delete(id); return next; });
    }
  };

  const recheck = async () => {
    setChecking(true);
    try {
      const { provider: next } = await api.checkProvider(provider.id);
      onChanged(next);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "检查没有完成。");
    } finally {
      setChecking(false);
    }
  };

  const refreshCatalog = async () => {
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const got = await api.refreshCatalog(provider.id);
      if (got.result === "refreshed") {
        toast.success(REFRESH_CATALOG_DONE);
        onFetch();
      } else {
        setRefreshNote(got.message);
      }
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "更新模型目录没有做成。");
    } finally {
      setRefreshing(false);
    }
  };

  /** 更新之前先问一句：会访问一次外网。 */
  const confirmRefresh = () => {
    modal.confirm({ title: REFRESH_CATALOG_LABEL, content: REFRESH_CATALOG_CONFIRM, okText: "更新", cancelText: "取消", onOk: () => { void refreshCatalog(); } });
  };

  const remove = () => {
    modal.confirm({
      title: `删除模型服务「${provider.name}」？`,
      content: "删除之后，它的模型不再出现在可选的模型里。以后要用，需要重新添加。",
      okText: "删除", cancelText: "取消", okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteProvider(provider.id);
          toast.success(`已删除模型服务「${provider.name}」。`);
          onDeleted();
        } catch (error) {
          toast.error(error instanceof ApiError ? error.message : "删除没有成功。");
        }
      },
    });
  };

  const codex = provider.kind === "codex";
  const needsContextWindow = PURPOSES[provider.purpose].needsContextWindow;
  const unreachable = provider.managed && !codex && provider.status !== null && !provider.status.ok;

  return (
    <div className="det" data-testid="provider-detail">
      {!provider.managed && <div className="ro-note small" data-testid="readonly-provider">{READONLY_PROVIDER_TEXT}</div>}
      {unreachable && (
        <div className="alert warn" data-testid="unreachable">
          <WarningOutlined />
          <span>连不上这个模型服务。{provider.status?.message && <span className="why">{provider.status.message}</span>}</span>
          <span className="sp" />
          {editable && <Button size="small" icon={<ReloadOutlined />} loading={checking} onClick={() => void recheck()}>{checking ? "正在检查……" : "重新检查"}</Button>}
        </div>
      )}
      <div className="dhead"><h2>{provider.name}</h2></div>
      <div className="kv">
        {provider.managed && <><div className="k">种类</div><div className="v">{kindName(provider.kind)}</div></>}
        {provider.managed && <><div className="k">用途</div><div className="v" data-testid="provider-purpose">{PURPOSES[provider.purpose].name}</div></>}
        {provider.base_url !== null && <><div className="k">接口地址</div><div className="v mono">{provider.base_url}</div></>}
        {provider.key !== null && <><div className="k">API 密钥</div><div className="v"><KeyLine provider={provider} editable={canEdit} onChanged={onChanged} /></div></>}
        {codex && <><div className="k">登录</div><div className="v"><CodexLogin provider={provider} editable={canEdit} checking={checking} onRecheck={() => void recheck()} /></div></>}
      </div>

      {provider.managed && (
        <div className="fetchbar">
          {canEdit && (
            <Button size="small" icon={<ReloadOutlined />} loading={fetching} disabled={dirty || refreshing} onClick={onFetch} data-testid="fetch-models">
              {fetching ? "正在获取……" : "获取模型列表"}
            </Button>
          )}
          {canEdit && codex && (
            <Button size="small" loading={refreshing} disabled={dirty || fetching} onClick={confirmRefresh} data-testid="refresh-catalog">
              {refreshing ? "正在更新……" : REFRESH_CATALOG_LABEL}
            </Button>
          )}
          <span className="muted">{provider.models_fetched_at ? `上一次获取：${formatTime(provider.models_fetched_at)}` : "还没有获取过模型列表。"}</span>
          {canEdit && dirty && <span className="muted">先保存或者放弃清单里的改动，再获取模型列表。</span>}
        </div>
      )}
      {fetchNote && fetchNote.result === "not_offered" && <div className="alert" data-testid="fetch-note">{fetchNote.message}</div>}
      {fetchNote && fetchNote.result === "failed" && <div className="alert warn" data-testid="fetch-note"><WarningOutlined /><span>{fetchNote.message}</span></div>}
      {refreshNote && <div className="alert warn" data-testid="refresh-note"><WarningOutlined /><span>{refreshNote}</span></div>}

      {rows.length > 0 && (
        <>
          <div className="mhint">
            {canEdit && "勾上的模型才会出现在「更换」时可选的模型里。"}
            {canEdit && !tellsModelType(provider.kind) && <span data-testid="all-models-listed">{allModelsListedText(provider.purpose)}</span>}
          </div>
          {many && showAll && (
            <div className="mfilter">
              <Input size="small" placeholder="按模型名筛选" value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="model-filter" />
              <a role="button" onClick={() => { setShowAll(false); setFilter(""); }}>只显示勾上的</a>
            </div>
          )}
          <table className="mtab" data-testid="model-table">
            <colgroup><col style={{ width: "2.4rem" }} /><col />{needsContextWindow && <col style={{ width: "15rem" }} />}</colgroup>
            <thead><tr><th /><th>模型名</th>{needsContextWindow && <th>上下文长度</th>}</tr></thead>
            <tbody>
              {visible.map((m) => (
                <ModelRow key={m.id} provider={provider} model={m} editable={canEdit} needsContextWindow={needsContextWindow}
                  whereOpen={whereOpen.has(m.id)} looking={looking.has(m.id)} lookNote={lookNote[m.id] ?? ""}
                  onChange={(patch) => change(m.id, patch)} onLook={() => void look(m.id)}
                  onWhere={() => setWhereOpen((s) => { const next = new Set(s); if (next.has(m.id)) next.delete(m.id); else next.add(m.id); return next; })} />
              ))}
              {hidden > 0 && (
                <tr className="more"><td /><td colSpan={needsContextWindow ? 2 : 1}>另有 {hidden} 个模型没有勾上。<a role="button" onClick={() => setShowAll(true)} data-testid="show-all">显示全部 {rows.length} 个</a></td></tr>
              )}
              {many && showAll && filter.trim() && visible.length === 0 && (
                <tr className="more"><td /><td colSpan={needsContextWindow ? 2 : 1}>没有名字里含「{filter.trim()}」的模型。</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {canEdit && !codex && <ManualAdd rows={rows} needsContextWindow={needsContextWindow} onAdd={(m) => setRows((list) => [...list, m])} />}

      {canEdit && (dirty || saveError) && (
        <div className="savebar">
          <Button type="primary" size="small" loading={saving} disabled={!dirty} onClick={() => void save()} data-testid="save-models">保存改动</Button>
          <Button size="small" disabled={saving || !dirty} onClick={() => { setRows(provider.models); setSaveError(null); }}>放弃改动</Button>
          {saveError && <div className="ferr" data-testid="save-error">{saveError}</div>}
        </div>
      )}

      {canEdit && (
        <div className="dfoot2">
          {provider.in_use.length > 0 ? (
            <>
              <Button size="small" disabled data-testid="delete-provider">删除这个模型服务</Button>
              <span className="muted" data-testid="delete-blocked">{inUseText(config, provider)}</span>
            </>
          ) : (
            <Button size="small" danger onClick={remove} data-testid="delete-provider">删除这个模型服务</Button>
          )}
        </div>
      )}
    </div>
  );
}

function ModelRow({ provider, model, editable, needsContextWindow, whereOpen, looking, lookNote, onChange, onLook, onWhere }: {
  provider: Provider; model: Row; editable: boolean; needsContextWindow: boolean; whereOpen: boolean; looking: boolean; lookNote: string;
  onChange: (patch: Partial<Row>) => void; onLook: () => void; onWhere: () => void;
}) {
  const empty = model.context_window === null;
  return (
    <>
      <tr className={model.enabled ? undefined : "off"} data-testid={`model-${model.id}`}>
        <td><Checkbox checked={model.enabled} disabled={!editable} onChange={(e) => onChange({ enabled: e.target.checked })} aria-label={`勾选 ${model.id}`} /></td>
        <td className="mn">{model.id}</td>
        {needsContextWindow && (
          <td>
            <div className="ctxcell">
              <InputNumber size="small" min={1} precision={0} controls={false} placeholder="还没有填" disabled={!editable}
                value={model.context_window ?? null} onChange={(v) => onChange({ context_window: typeof v === "number" ? v : null, context_source: typeof v === "number" ? "user" : null })}
                formatter={(v) => (v ? formatNumber(Number(v)) : "")} parser={(v) => Number((v ?? "").replace(/[^0-9]/g, "")) || (null as unknown as number)}
                style={{ width: "8rem" }} aria-label={`${model.id} 的上下文长度`} />
              {editable && provider.managed && (
                <Button size="small" onClick={onLook} loading={looking} data-testid={`look-${model.id}`}>{looking ? "正在查……" : "查"}</Button>
              )}
            </div>
            {empty && <div className="cnote"><a role="button" onClick={onWhere}>到哪里看这个数字</a></div>}
            {lookNote && <div className="cnote">{lookNote}</div>}
          </td>
        )}
      </tr>
      {needsContextWindow && empty && whereOpen && (
        <tr className="exp"><td /><td colSpan={2}><div className="expbox">{whereToFind(provider.kind)}</div></td></tr>
      )}
    </>
  );
}

/** 「手工添加一个模型」：模型名，加上上下文长度（只有要填它的那一类模型有这一项）。加进页面上的清单，随「保存改动」一起交给后端。 */
function ManualAdd({ rows, needsContextWindow, onAdd }: { rows: Row[]; needsContextWindow: boolean; onAdd: (m: Row) => void }) {
  const [name, setName] = useState("");
  const [ctx, setCtx] = useState<number | null>(null);
  const [error, setError] = useState("");
  const add = () => {
    const id = name.trim();
    if (!id) return setError("请填写模型名。");
    if (rows.some((m) => m.id === id)) return setError("这个模型已经在清单里了。");
    if (needsContextWindow && ctx === null) return setError("语言模型要填上下文长度才能添加。不知道填多少时，请查看模型服务的说明。");
    onAdd({ id, enabled: true, context_window: needsContextWindow ? ctx : null, context_source: needsContextWindow ? "user" : null, fromUser: true });
    setName(""); setCtx(null); setError("");
  };
  return (
    <div className="madd">
      <div className="mt">手工添加一个模型</div>
      <div className="maddrow">
        <Input size="small" className="nm" placeholder="模型名" value={name} onChange={(e) => setName(e.target.value)} data-testid="add-model-name" />
        {needsContextWindow && (
          <InputNumber size="small" min={1} precision={0} controls={false} placeholder="上下文长度" value={ctx} onChange={(v) => setCtx(typeof v === "number" ? v : null)}
            style={{ width: "8rem" }} data-testid="add-model-ctx" />
        )}
        <Button size="small" icon={<PlusOutlined />} onClick={add} data-testid="add-model">添加</Button>
      </div>
      {error && <div className="ferr">{error}</div>}
    </div>
  );
}

/** API 密钥一行：「已设置，末四位 3f9c」与「重新输入」；只读时只写「已设置」。 */
function KeyLine({ provider, editable, onChanged }: { provider: Provider; editable: boolean; onChanged: (p: Provider) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const key = provider.key!;
  const save = async () => {
    if (!value.trim()) return setError("请输入完整的 API 密钥。");
    setSaving(true);
    setError("");
    try {
      const { provider: next } = await api.updateProvider(provider.id, { api_key: value.trim() });
      onChanged(next);
      setOpen(false);
      setValue("");
      toast.success("API 密钥已保存。");
    } catch (error) {
      if (error instanceof ApiError && error.code === "rejected") setError(error.message);
      else toast.error(error instanceof ApiError ? error.message : "保存没有成功。");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      {key.set ? (key.last4 && editable ? `已设置，末四位 ${key.last4}` : "已设置") : "没有设置"}
      {editable && <a role="button" className="gap" onClick={() => { setOpen(!open); setError(""); }} data-testid="rekey">{key.set ? "重新输入" : "输入密钥"}</a>}
      {open && (
        <>
          <div className="inl">
            <Input.Password size="small" placeholder="输入完整的 API 密钥" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" data-testid="new-key" />
            <Button size="small" type="primary" loading={saving} onClick={() => void save()}>保存</Button>
            <Button size="small" onClick={() => { setOpen(false); setValue(""); setError(""); }}>取消</Button>
          </div>
          {error && <div className="ferr">{error}</div>}
          <div className="note">密钥存进去之后不再显示，只显示末四位。</div>
        </>
      )}
    </>
  );
}

/** Codex 订阅的登录状态：只看登录凭据在不在；没有登录时给出登录的两步与「重新检查」。只在更早的入口登录过时，另写一句要重新登录。 */
function CodexLogin({ provider, editable, checking, onRecheck }: { provider: Provider; editable: boolean; checking: boolean; onRecheck: () => void }) {
  const loggedIn = provider.status?.logged_in === true;
  return (
    <div className="login" data-testid="codex-login">
      {loggedIn ? <div>已经登录。</div> : (
        <>
          <div className="st">还没有登录。</div>
          {provider.status?.relogin === true && <div data-testid="codex-relogin">{RELOGIN_TEXT}</div>}
          {editable && <>
            <div>请在运行任务服务的这台电脑上打开命令行，运行下面第一行的命令，等它启动后输入第二行的指令，照提示登录，然后回到这里点「重新检查」。</div>
            <LoginCommand />
          </>}
        </>
      )}
      {editable && <Button size="small" icon={<ReloadOutlined />} loading={checking} onClick={onRecheck}>{checking ? "正在检查……" : "重新检查"}</Button>}
      <div className="note">{LOGIN_NOTE}</div>
    </div>
  );
}

/** 登录的两步：第一行是启动的命令，「复制」只复制它；第二行是启动之后要输入的指令与一句说明。 */
export function LoginCommand() {
  const toast = useToast();
  const copy = () => {
    navigator.clipboard?.writeText(LOGIN_COMMAND).then(() => toast.success("已复制。"), () => toast.error("没能复制，请手工选中复制。"));
  };
  return (
    <>
      <div className="cmd"><code data-testid="login-command">{LOGIN_COMMAND}</code><Button size="small" icon={<CopyOutlined />} onClick={copy}>复制</Button></div>
      <div className="cmd next"><code data-testid="login-instruction">{LOGIN_INSTRUCTION}</code><span className="hint">{LOGIN_INSTRUCTION_HINT}</span></div>
    </>
  );
}
