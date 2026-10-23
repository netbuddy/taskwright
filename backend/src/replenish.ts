/**
 * 导入后补齐材料：从不带材料的数据包导入的任务，材料表里有材料而文件不在（D1 的「缺失的材料」）。用户重新上传原件时，程序重算它的文字版、
 * 分段清单与位置表，与导出时记下的指纹比对，告诉用户是不是导出时那一份。
 *
 * 导出时的指纹（数据包清单文件里这个任务的材料清单与 projection 一节）在导入时写成材料目录里的 .expected.json（expectedFromPack）。
 * 它是导入这台机器的状态，不是领域事实：不进任务库，导出时也不带（data_pack.ts）；材料清单（library.ts 的 materials）不列以点开头的文件。
 *
 * 一份材料补齐之后，核对的结果写回 .expected.json 里它那一项的 check：原件同不同、三样派生文件各同不同、结论（restored 已恢复、
 * mismatch 与导出时不同、unverified 没有可比的）、用户接受了没有，以及程序能说的原因。依据「与导出时不同、用户还没接受」的材料的条目
 * 现算为待核实（mismatchedMaterials），不存状态。
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
  /** 原件与导出时同不同；没有导出时的校验值可比（unverified）时是 null。 */
  original: "same" | "different" | null;
  derived: DerivedCheck[];
  /** restored：原件与派生文件都与导出时相同；mismatch：有不同；unverified：没有导出时的校验值可比。 */
  verdict: "restored" | "mismatch" | "unverified";
  /** 用户接受了与导出时的不同（只对 mismatch 有意义）。 */
  accepted: boolean;
  /** 为什么不同：程序能说的几句；没有不同时是空的。 */
  reasons: string[];
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

/** 原件与导出时不同时的那句话。 */
export const ORIGINAL_DIFFERENT_TEXT = "上传的不是导出时那份文件（校验值不同）";

const paramsText = (p: SegmentParams) => `标题层级 ${p.heading_depth}、每块至多 ${p.max_paragraphs} 段、至少 ${p.min_paragraphs} 段`;

/** 原件相同而派生文件不同时，程序能说的原因：导出时与本机的规则版本与参数哪几样不同。isPdf 时才比 PDF 的那几样。 */
function derivedReason(then: PackProjection | null, now: PackProjection, isPdf: boolean): string {
  if (!then) return "本机生成的文字版、分段清单或位置表与导出时不同；导出时的解析规则与参数没有记下，说不出哪里不同";
  const pairs: [string, string, string][] = [];
  if (isPdf && then.pdf_location_rules_version !== now.pdf_location_rules_version) pairs.push(["PDF 位置规则版本", String(then.pdf_location_rules_version), String(now.pdf_location_rules_version)]);
  if (isPdf && then.pdf_locations_format_version !== now.pdf_locations_format_version) pairs.push(["位置表格式版本", String(then.pdf_locations_format_version), String(now.pdf_locations_format_version)]);
  if (isPdf && then.pdfjs_version !== now.pdfjs_version) pairs.push(["pdf.js 版本", then.pdfjs_version, now.pdfjs_version]);
  if (JSON.stringify(then.segment_params) !== JSON.stringify(now.segment_params)) pairs.push(["分段参数", paramsText(then.segment_params), paramsText(now.segment_params)]);
  if (pairs.length === 0) return "本机生成的文字版、分段清单或位置表与导出时不同；导出时与本机的解析规则和参数相同，说不出原因";
  return `本机的解析规则或参数与导出时不同（导出时 ${pairs.map(([what, a]) => `${what} ${a}`).join("，")}；本机 ${pairs.map(([what, , b]) => `${what} ${b}`).join("，")}）`;
}

/**
 * 补齐的一份材料与导出时的指纹比：entry 是 .expected.json 里这份材料的那一项（没有时是 unverified），original 与 derived 是补齐的
 * 原件与重算出的派生文件的指纹（路径相对任务目录）。
 */
export function compareReplenished(entry: ExpectedMaterial | undefined, then: PackProjection | null, now: PackProjection,
  original: PackFingerprint, derived: readonly PackFingerprint[], at: string): ReplenishCheck {
  if (!entry || entry.sha256 === null) return { at, original: null, derived: [], verdict: "unverified", accepted: false, reasons: [] };
  const sameOriginal = entry.sha256 === original.sha256;
  const checks: DerivedCheck[] = derived.map((one) => {
    const before = entry.derived.find((d) => d.path === one.path);
    return { name: one.path, result: !before ? "absent_before" : before.sha256 === one.sha256 ? "same" : "different" };
  });
  for (const before of entry.derived) {
    if (!derived.some((one) => one.path === before.path)) checks.push({ name: before.path, result: "different" });
  }
  const derivedDiffer = checks.some((one) => one.result === "different");
  const reasons = !sameOriginal ? [ORIGINAL_DIFFERENT_TEXT] : derivedDiffer ? [derivedReason(then, now, /\.pdf$/i.test(entry.path))] : [];
  return { at, original: sameOriginal ? "same" : "different", derived: checks, verdict: sameOriginal && !derivedDiffer ? "restored" : "mismatch", accepted: false, reasons };
}

/** 补齐之后与导出时不同、用户还没有接受的材料的路径（相对任务目录）。依据它们的条目现算为待核实。 */
export function mismatchedMaterials(taskDir: string, materialsDir: string): Set<string> {
  const expected = readExpected(taskDir, materialsDir);
  return new Set((expected?.materials ?? []).filter((one) => one.check?.verdict === "mismatch" && !one.check.accepted).map((one) => one.path));
}

/** 这份材料的核对结果；没有补齐过、没有 .expected.json 时是 null。 */
export function checkOf(taskDir: string, materialsDir: string, path: string): ReplenishCheck | null {
  return readExpected(taskDir, materialsDir)?.materials.find((one) => one.path === path)?.check ?? null;
}

/** .expected.json 在不在。 */
export const hasExpected = (taskDir: string, materialsDir: string) => existsSync(expectedPath(taskDir, materialsDir));
