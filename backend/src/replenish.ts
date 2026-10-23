/**
 * 导入后补齐材料：从不带材料的数据包导入的任务，材料表里有材料而文件不在（D1 的「缺失的材料」）。用户重新上传原件时，程序重算它的文字版、
 * 分段清单与位置表，与导出时记下的指纹比对：原件不是导出时那一份的不收；是那一份就放回原处。
 *
 * 导出时的指纹（数据包清单文件里这个任务的材料清单与 projection 一节）在导入时写成材料目录里的 .expected.json（expectedFromPack）。
 * 它是导入这台机器的状态，不是领域事实：不进任务库，导出时也不带（data_pack.ts）；材料清单（library.ts 的 materials）不列以点开头的文件。
 *
 * 原件的校验值与导出时不同的不收（service.ts 拒绝，不走到这里）。原件相同时，补齐的结果写回 .expected.json 里它那一项的 check：
 * 三样派生文件各同不同与结论（restored 已恢复；unverified 没有可比的）。本机重算的派生文件与导出时不同（解析规则或参数变了）时
 * 不告诉用户，就用本机重算的，只在后端日志里写一行（derivedLogLine）。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PDF_LOCATIONS_FORMAT_VERSION, PDF_LOCATION_RULES_VERSION } from "../../agent/src/lib/pdf_locations.ts";
import type { SegmentParams } from "../../agent/src/lib/segments.ts";
import type { Manifest, PackFingerprint, PackMaterial, PackProjection, PackTask } from "./data_pack.ts";
import { PDFJS_VERSION } from "./pdf_projection.ts";

/** 材料目录里导出时指纹的文件名。 */
export const EXPECTED_NAME = ".expected.json";
/** 这个文件的格式版本。 */
export const EXPECTED_VERSION = 1;

/** 一样派生文件的核对结果：same 相同；different 不同（导出时有、现在没有生成也算）；absent_before 导出时没有这一样，无从比。 */
export interface DerivedCheck {
  name: string;
  result: "same" | "different" | "absent_before";
}

/** 一份材料补齐之后的核对结果。 */
export interface ReplenishCheck {
  /** 补齐的时刻。 */
  at: string;
  /** 原件与导出时相比：收下的都是 same；没有导出时的校验值可比（unverified）时是 null。 */
  original: "same" | null;
  /** 三样派生文件各自与导出时比的结果（只记下，不告诉用户）。 */
  derived: DerivedCheck[];
  /** restored：原件与导出时相同，已经放回原处；unverified：没有导出时的校验值可比。 */
  verdict: "restored" | "unverified";
}

export interface ExpectedMaterial extends PackMaterial {
  check?: ReplenishCheck;
}

export interface ExpectedFile {
  version: number;
  exported_at: string;
  product_version: string;
  /** 导出时生成派生文件的规则版本与参数；早先的包没有记，是 null。 */
  projection: PackProjection | null;
  materials: ExpectedMaterial[];
}

/** 材料目录（相对任务目录，以斜杠结尾）里 .expected.json 的全路径。 */
export function expectedPath(taskDir: string, materialsDir: string): string {
  return join(taskDir, materialsDir, EXPECTED_NAME);
}

/** 读 .expected.json；没有、读不出、不是这个格式时是 null。 */
export function readExpected(taskDir: string, materialsDir: string): ExpectedFile | null {
  try {
    const value = JSON.parse(readFileSync(expectedPath(taskDir, materialsDir), "utf-8"));
    return value && typeof value === "object" && Array.isArray(value.materials) ? value as ExpectedFile : null;
  } catch {
    return null;
  }
}

/** 写 .expected.json：先写临时文件再改名。 */
export function writeExpected(taskDir: string, materialsDir: string, value: ExpectedFile): void {
  const file = expectedPath(taskDir, materialsDir);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(temp, file);
}

/**
 * 导入一个任务时要写的 .expected.json 与它所在的材料目录：包不带材料、清单里有这个任务的材料清单时才有；带了材料的包、早先没有
 * 材料清单的包是 null。材料目录取材料路径的那一层（材料都在同一层）。
 */
export function expectedFromPack(manifest: Pick<Manifest, "with_materials" | "exported_at" | "product_version" | "projection">, task: PackTask): { dir: string; value: ExpectedFile } | null {
  if (manifest.with_materials || !task.materials || task.materials.length === 0) return null;
  const dir = `${dirname(task.materials[0].path)}/`;
  return {
    dir,
    value: { version: EXPECTED_VERSION, exported_at: manifest.exported_at, product_version: manifest.product_version, projection: manifest.projection ?? null, materials: task.materials },
  };
}

/** 本机现在生成派生文件的规则版本与参数（与导出时的 projection 一节同形）。 */
export function projectionNow(segments: SegmentParams): PackProjection {
  return { pdf_location_rules_version: PDF_LOCATION_RULES_VERSION, pdf_locations_format_version: PDF_LOCATIONS_FORMAT_VERSION, pdfjs_version: PDFJS_VERSION, segment_params: { ...segments } };
}

const paramsText = (p: SegmentParams) => `标题层级 ${p.heading_depth}、每块至多 ${p.max_paragraphs} 段、至少 ${p.min_paragraphs} 段`;
const projectionText = (p: PackProjection | null) => (p
  ? `PDF 位置规则版本 ${p.pdf_location_rules_version}、位置表格式版本 ${p.pdf_locations_format_version}、pdf.js ${p.pdfjs_version}、分段参数 ${paramsText(p.segment_params)}`
  : "没有记下");

/**
 * 补齐的一份材料与导出时的指纹比：entry 是 .expected.json 里这份材料的那一项（没有、或者没记校验值时是 unverified），derived 是本机
 * 重算出的派生文件的指纹（路径相对任务目录）。原件的校验值已经由调用方核对过相同。
 */
export function compareReplenished(entry: ExpectedMaterial | undefined, derived: readonly PackFingerprint[], at: string): ReplenishCheck {
  if (!entry || entry.sha256 === null) return { at, original: null, derived: [], verdict: "unverified" };
  const checks: DerivedCheck[] = derived.map((one) => {
    const before = entry.derived.find((d) => d.path === one.path);
    return { name: one.path, result: !before ? "absent_before" : before.sha256 === one.sha256 ? "same" : "different" };
  });
  for (const before of entry.derived) {
    if (!derived.some((one) => one.path === before.path)) checks.push({ name: before.path, result: "different" });
  }
  return { at, original: "same", derived: checks, verdict: "restored" };
}

/**
 * 本机重算的派生文件与导出时不同时写进后端日志的那一行：任务号、材料路径、哪几样不同、导出时与本机的规则版本与分段参数。
 * 没有不同时是 null。
 */
export function derivedLogLine(taskId: string, path: string, check: ReplenishCheck, then: PackProjection | null, now: PackProjection): string | null {
  const differ = check.derived.filter((one) => one.result === "different").map((one) => one.name);
  if (differ.length === 0) return null;
  return `补齐材料：任务 ${taskId} 的材料 ${path} 原件与导出时相同，本机重算的 ${differ.join("、")} 与导出时不同，已用本机重算的；`
    + `导出时 ${projectionText(then)}；本机 ${projectionText(now)}`;
}

/** 这份材料的核对结果；没有补齐过、没有 .expected.json 时是 null。 */
export function checkOf(taskDir: string, materialsDir: string, path: string): ReplenishCheck | null {
  return readExpected(taskDir, materialsDir)?.materials.find((one) => one.path === path)?.check ?? null;
}

/** .expected.json 在不在。 */
export const hasExpected = (taskDir: string, materialsDir: string) => existsSync(expectedPath(taskDir, materialsDir));
