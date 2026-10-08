import {
  AUDIENCE_PROFILES,
  EXPORT_AUDIENCES,
  type ExportAudience,
  type ExportDocument,
  type ExportSectionKind,
} from "./settingsExportProfiles";
import { formatDayTime } from "./timestampedFileName";

/**
 * 提供先別の設定資料の「前回書き出した時点との差分」（F6、設計書6.75.1）。
 *
 * ## 控えは書き出しのたびに取る
 *
 * 書き出すたびに、**渡した中身**（出す・出さないを絞ったあとの資料）を
 * `.aiwriter/settings-exports/<提供先>.json` へ控える。差分はこの控えと、
 * いま書き出す資料を比べる。
 *
 * **git の履歴からは取らない。** ①ブラウザ版では git を打てない（設計書5.8）、
 * ②コミットと書き出しの時点は一致しない（書き出したあとに直してコミット
 * することも、コミットせずに書き出すこともある）、③履歴にあるのは
 * 絞る前の資料で、「相手が受け取ったもの」を復元するには絞り直しが要る。
 *
 * ## 控えの鍵は提供先だけ（範囲は鍵にしない）
 *
 * 連載中の作品では「第12話まで渡した → 次は第15話まで」が普通の流れで、
 * そこで知りたいのは**前回この相手へ渡したものから何が増えたか**である。
 * 範囲まで鍵にすると、範囲を変えるたびに「前回が無い」になる。前回の範囲は
 * 差分の冒頭に書く。
 *
 * VS Code API に依存しない（単体テストできる）。
 */

export const SNAPSHOT_VERSION = 1;

/** 控えのレコード。欄の名前と値の組を、資料に出た順に持つ */
export interface SnapshotRecord {
  /** 突き合わせの鍵。同じ種別に同じ名前が2つあれば「名前#2」 */
  key: string;
  name: string;
  values: Array<[string, string]>;
}

export interface SnapshotSection {
  kind: ExportSectionKind;
  title: string;
  records: SnapshotRecord[];
}

export interface ExportSnapshot {
  version: number;
  audience: ExportAudience;
  chapter: number | null;
  /** ISO 8601 */
  exportedAt: string;
  sections: SnapshotSection[];
}

/** 渡した資料を、比べられる形にする */
export function snapshotOf(document: ExportDocument, at: Date): ExportSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    audience: document.audience,
    chapter: document.chapter,
    exportedAt: at.toISOString(),
    sections: document.sections.map((section) => {
      const seen = new Map<string, number>();
      const keyOf = (name: string) => {
        const count = (seen.get(name) ?? 0) + 1;
        seen.set(name, count);
        return count === 1 ? name : `${name}#${count}`;
      };

      const records: SnapshotRecord[] = [];
      for (const group of section.groups) {
        for (const record of group.records) {
          const values: Array<[string, string]> = [];
          const add = (label: string, value: string) => {
            // 同じ名前の欄が2つあれば（作者が足した項目が既定の項目と同じ
            // 名前のとき）1つにつなぐ。消えた・足されたと誤って言わないため
            const found = values.find(([existing]) => existing === label);
            if (found) found[1] = `${found[1]}\n${value}`;
            else values.push([label, value]);
          };
          if (record.reading) add("読み", record.reading);
          if (group.value !== null) add(section.groupLabel, group.value);
          if (record.lead) add(section.leadLabel, record.lead);
          for (const field of record.fields) add(field.label, field.value);
          if (record.aiNotes.length > 0) {
            add(
              "AIの掘り下げ",
              record.aiNotes.map((note) => note.text).join("\n\n")
            );
          }
          records.push({ key: keyOf(record.name), name: record.name, values });
        }
      }
      for (const mob of section.mobs) {
        const values: Array<[string, string]> = [["区分", "モブ・集団"]];
        if (mob.chapters) values.push(["登場話", mob.chapters]);
        records.push({ key: keyOf(mob.name), name: mob.name, values });
      }
      return { kind: section.kind, title: section.title, records };
    }),
  };
}

/**
 * 控えを読む。形が違えば null（**直さない**。呼び出し側が「前回の控えを
 * 読めない」と伝え、今回の書き出しで新しい控えを置く）。
 */
export function parseSnapshot(text: string): ExportSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  if (value.version !== SNAPSHOT_VERSION) return null;
  if (!EXPORT_AUDIENCES.includes(value.audience as ExportAudience)) return null;
  if (value.chapter !== null && typeof value.chapter !== "number") return null;
  if (typeof value.exportedAt !== "string") return null;
  if (!Array.isArray(value.sections)) return null;
  for (const section of value.sections) {
    if (!isObject(section) || typeof section.kind !== "string") return null;
    if (typeof section.title !== "string" || !Array.isArray(section.records)) {
      return null;
    }
    for (const record of section.records) {
      if (!isObject(record)) return null;
      if (typeof record.key !== "string" || typeof record.name !== "string") {
        return null;
      }
      if (!Array.isArray(record.values)) return null;
      for (const pair of record.values) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          typeof pair[0] !== "string" ||
          typeof pair[1] !== "string"
        ) {
          return null;
        }
      }
    }
  }
  return value as unknown as ExportSnapshot;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface FieldChange {
  label: string;
  /** 前回の値。前回は無かった欄なら null */
  before: string | null;
  /** 今回の値。今回は無くなった欄なら null */
  after: string | null;
}

export interface SectionDiff {
  kind: ExportSectionKind;
  title: string;
  added: SnapshotRecord[];
  removed: SnapshotRecord[];
  changed: Array<{ name: string; changes: FieldChange[] }>;
}

/** 種別ごとの差分。変わりの無い種別は入れない */
export function diffSnapshots(
  previous: ExportSnapshot,
  current: ExportSnapshot
): SectionDiff[] {
  const kinds: ExportSectionKind[] = [];
  for (const section of [...current.sections, ...previous.sections]) {
    if (!kinds.includes(section.kind)) kinds.push(section.kind);
  }

  const result: SectionDiff[] = [];
  for (const kind of kinds) {
    const before = previous.sections.find((section) => section.kind === kind);
    const after = current.sections.find((section) => section.kind === kind);
    const beforeRecords = before?.records ?? [];
    const afterRecords = after?.records ?? [];
    const beforeByKey = new Map(beforeRecords.map((record) => [record.key, record]));
    const afterKeys = new Set(afterRecords.map((record) => record.key));

    const diff: SectionDiff = {
      kind,
      title: after?.title ?? before?.title ?? kind,
      added: afterRecords.filter((record) => !beforeByKey.has(record.key)),
      removed: beforeRecords.filter((record) => !afterKeys.has(record.key)),
      changed: [],
    };
    for (const record of afterRecords) {
      const old = beforeByKey.get(record.key);
      if (!old) continue;
      const changes = diffValues(old.values, record.values);
      if (changes.length > 0) diff.changed.push({ name: record.name, changes });
    }
    if (diff.added.length + diff.removed.length + diff.changed.length > 0) {
      result.push(diff);
    }
  }
  return result;
}

function diffValues(
  before: ReadonlyArray<[string, string]>,
  after: ReadonlyArray<[string, string]>
): FieldChange[] {
  const old = new Map(before);
  const now = new Map(after);
  const changes: FieldChange[] = [];
  for (const [label, value] of after) {
    const previous = old.get(label);
    if (previous === undefined) changes.push({ label, before: null, after: value });
    else if (previous !== value) changes.push({ label, before: previous, after: value });
  }
  for (const [label, value] of before) {
    if (!now.has(label)) changes.push({ label, before: value, after: null });
  }
  return changes;
}

export interface DiffMarkdownOptions {
  workTitle: string;
}

/** 差分を Markdown 1枚にする */
export function buildExportDiffMarkdown(
  previous: ExportSnapshot,
  current: ExportSnapshot,
  options: DiffMarkdownOptions
): string {
  const profile = AUDIENCE_PROFILES[current.audience];
  const lines: string[] = [
    `# ${options.workTitle} 設定資料の前回との差分（${profile.label}）`,
    "",
    `- **前回の書き出し**: ${describeMoment(previous)}`,
    `- **今回**: ${describeMoment(current)}`,
    "",
    "前回この提供先へ書き出した資料と、いま書き出す資料を比べています。" +
      "「消えた項目」は今回の資料に載らなくなったもので、設定から消したほかに、" +
      "名前を変えた・公開の印を変えた・範囲を狭めた場合も含みます。",
    "",
  ];

  const sections = diffSnapshots(previous, current);
  if (sections.length === 0) {
    lines.push("前回から変わったところはありません。", "");
    return lines.join("\n");
  }

  for (const section of sections) {
    lines.push(`## ${section.title}`, "");
    if (section.added.length > 0) {
      lines.push("### 足された項目", "");
      for (const record of section.added) lines.push(`- ${record.name}`);
      lines.push("");
    }
    if (section.changed.length > 0) {
      lines.push("### 変わった欄", "");
      for (const record of section.changed) {
        lines.push(`#### ${record.name}`, "");
        for (const change of record.changes) {
          lines.push(
            `- **${change.label}**: ${quote(change.before)} → ${quote(change.after)}`
          );
        }
        lines.push("");
      }
    }
    if (section.removed.length > 0) {
      lines.push("### 消えた項目", "");
      for (const record of section.removed) lines.push(`- ${record.name}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function describeMoment(snapshot: ExportSnapshot): string {
  const at = new Date(snapshot.exportedAt);
  const when = Number.isNaN(at.getTime()) ? "日時不明" : formatDayTime(at);
  const scope =
    snapshot.chapter === null ? "全話ぶん" : `第${snapshot.chapter}話まで`;
  return `${when}（${scope}）`;
}

/** 箇条書き1行に収める。改行は「／」に置き換えて見せる（値そのものは変えない） */
function quote(value: string | null): string {
  if (value === null) return "（なし）";
  return `「${value.replace(/\r?\n/g, "／")}」`;
}
