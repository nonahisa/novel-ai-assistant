import {
  AUDIENCE_PROFILES,
  type ExportDocument,
  type ExportRecord,
  type ExportSection,
  type ExportSectionKind,
} from "./settingsExportProfiles";

/**
 * 提供先別の設定資料を、種別ごとの CSV にする（F6、設計書6.75.1）。
 *
 * **中身は Markdown 版と同じ `ExportDocument` から作る。** 出す・出さないの
 * 判断はここには無い。CSV 用に記録を読み直して絞ると、Markdown では伏せた
 * 名前（関係・使い手の欄）が表から漏れる。
 *
 * ## Excel で文字化けしない形
 *
 * - 先頭に BOM（`﻿`）を置く。日本語版 Excel は BOM の無い UTF-8 を
 *   Shift_JIS と取り違えて開く
 * - 行の区切りは CRLF。セルの中の改行は LF のまま、引用符で囲む
 * - `"` `,` 改行を含むセルは `"` で囲み、中の `"` は `""` に重ねる（RFC 4180）
 *
 * ## 式の注入を防ぐ（作者の裁定 2026-10-09）
 *
 * 値が `=` `+` `-` `@`（と先頭のタブ・CR）で始まるセルは、頭に `'` を付ける。
 * 受け取った相手が Excel で開いたとき、式として実行されないように。
 * 設定資料は第三者へ渡すもので、値にはAIが読み取った文字も混じる。
 * 書き出した CSV の値であって、作者の保存データは変えない。
 *
 * VS Code API に依存しない（単体テストできる）。
 */

/** Excel が UTF-8 だと分かるための印。**生の字で書かない**（ソースの検査が落ちる） */
export const CSV_BOM = "﻿";

/** 1つのセルを CSV の形にする */
export function csvCell(raw: string): string {
  const value = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function csvRow(cells: readonly string[]): string {
  return cells.map(csvCell).join(",");
}

export interface ExportCsvFile {
  kind: ExportSectionKind;
  /** ファイル名に入れる種別の名前（「登場人物」「場所」…） */
  label: string;
  /** BOM 付きの中身 */
  content: string;
}

/** 種別ごとに1ファイル。**その型が出さない種別はファイルを作らない** */
export function buildExportCsvFiles(document: ExportDocument): ExportCsvFile[] {
  return document.sections.map((section) => ({
    kind: section.kind,
    label: section.title,
    content: sectionCsv(document, section),
  }));
}

/** 掘り下げの列の名前（Markdown 版の項目名と同じ） */
const AI_NOTES_COLUMN = "AIの掘り下げ";
const MOB_COLUMN = "区分";

function sectionCsv(document: ExportDocument, section: ExportSection): string {
  const profile = AUDIENCE_PROFILES[document.audience];
  const fieldsOf: Record<ExportSectionKind, readonly string[] | null> = {
    characters: profile.characters,
    locations: profile.locations,
    abilities: profile.abilities,
    organizations: profile.organizations,
    world: profile.world,
  };
  const profileFields = fieldsOf[section.kind] ?? [];

  /*
    **列は、その型が出す項目から決める。** 値が1件も無くても列は残す——
    受け取った側が「この欄は無いのか、空なのか」を見分けられるように。
    世界観は紹介文を持たず、説明が見出しの直後の段落（lead）に当たる。
  */
  const showsReading = profileFields.includes("reading");
  const showsLead = profileFields.includes(
    section.kind === "world" ? "description" : "summary"
  );
  const grouped = section.groups.some((group) => group.title !== null);
  const hasMobs = section.mobs.length > 0;

  const records = section.groups.flatMap((group) =>
    group.records.map((record) => ({ group: group.value, record }))
  );
  const fieldColumns = mergeColumns(
    records.map(({ record }) => record.fields.map(columnOf))
  );
  const hasNotes = records.some(({ record }) => record.aiNotes.length > 0);
  // 登場話はモブの行にも入るので、名前の付いた人物に1件も無くても列を作る
  if (hasMobs && section.mobs.some((mob) => mob.chapters) && !fieldColumns.includes("登場話")) {
    fieldColumns.push("登場話");
  }

  const header = [
    "名前",
    ...(showsReading ? ["読み"] : []),
    ...(hasMobs ? [MOB_COLUMN] : []),
    ...(grouped ? [section.groupLabel] : []),
    ...(showsLead ? [section.leadLabel] : []),
    ...fieldColumns,
    ...(hasNotes ? [AI_NOTES_COLUMN] : []),
  ];

  const rows: string[][] = [];
  for (const { group, record } of records) {
    const cells = new Map<string, string>();
    cells.set("名前", record.name);
    if (showsReading) cells.set("読み", record.reading ?? "");
    if (hasMobs) cells.set(MOB_COLUMN, "人物");
    if (grouped) cells.set(section.groupLabel, group ?? "");
    if (showsLead) cells.set(section.leadLabel, record.lead ?? "");
    for (const [column, value] of fieldCells(record)) cells.set(column, value);
    if (hasNotes) cells.set(AI_NOTES_COLUMN, notesCell(record));
    rows.push(header.map((column) => cells.get(column) ?? ""));
  }
  for (const mob of section.mobs) {
    const cells = new Map<string, string>([
      ["名前", mob.name],
      [MOB_COLUMN, "モブ・集団"],
    ]);
    if (mob.chapters) cells.set("登場話", mob.chapters);
    rows.push(header.map((column) => cells.get(column) ?? ""));
  }

  return (
    CSV_BOM + [header, ...rows].map((row) => csvRow(row)).join("\r\n") + "\r\n"
  );
}

function columnOf(field: { label: string; column?: string }): string {
  return field.column ?? field.label;
}

/**
 * 同じ列へ入る項目をまとめる。
 *
 * 列の名前と項目名が違うもの（「白鳥への呼称」→「相手ごとの呼び方」）は、
 * どの項目の値かが分かるよう「白鳥への呼称：白鳥さん」と頭に付けて
 * 改行でつなぐ。
 */
function fieldCells(record: ExportRecord): Map<string, string> {
  const cells = new Map<string, string[]>();
  for (const field of record.fields) {
    const column = columnOf(field);
    const text =
      column === field.label ? field.value : `${field.label}：${field.value}`;
    const list = cells.get(column) ?? [];
    list.push(text);
    cells.set(column, list);
  }
  return new Map([...cells].map(([column, list]) => [column, list.join("\n")]));
}

function notesCell(record: ExportRecord): string {
  return record.aiNotes
    .map((note) => {
      const label = [note.topic || "全体", note.model].filter((p) => p).join(" / ");
      return `【${label}】${note.text}`;
    })
    .join("\n\n");
}

/**
 * レコードごとの列の並びを、1本の並びに合わせる。
 *
 * 先に出た順に並べるだけだと、1件目に無い列が末尾へ回る（「別名」が
 * 「登場話」の後ろに来る）。**新しい列は、そのレコードで直前にあった列の
 * すぐ後ろへ差し込む**ので、どのレコードの並びとも食い違わない。
 */
export function mergeColumns(orders: readonly (readonly string[])[]): string[] {
  const merged: string[] = [];
  for (const order of orders) {
    let previous = -1;
    for (const column of order) {
      const found = merged.indexOf(column);
      if (found >= 0) {
        previous = found;
        continue;
      }
      merged.splice(previous + 1, 0, column);
      previous += 1;
    }
  }
  return merged;
}
