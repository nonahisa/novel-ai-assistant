import { findNameOccurrences } from "./nameOccurrences";
import { NAME_PART_SEPARATOR } from "./termIndex";
import { buildUniqueContext } from "./uniqueContext";

/**
 * 名前の付け替えの計画（設計書6.37.3）。
 *
 * **対応表を先に作り、作者に確認させてから走る。** 「マルキオ・イークェス」を
 * 「レオン・ヴァイス」にするとき、本文には「マルキオ」だけで出ている箇所も
 * 「イークェス卿」もある。推測でまとめて置き換えると、直してほしくない
 * ところまで書き換わる。
 *
 * ここは**計画を立てるだけで、1文字も書き込まない。** 本文の置換は提案
 * パネルの既存の適用経路（ハッシュ照合・`writeTextFilePreservingFormat`）を
 * 通す（CLAUDE.md 規則1・2）。
 *
 * VS Code API に依存しない純粋関数だけを置く。
 */

/**
 * 対応の種類。
 *
 * - `full`：フルネームまるごと
 * - `part`：姓・名などの部分
 * - `alias`：別名。**既定では空**（変えない）で、作者が入れたときだけ動く
 */
export type RenameMappingKind = "full" | "part" | "alias";

export interface RenameMappingEntry {
  from: string;
  /** 置き換え先。空文字は「変えない」 */
  to: string;
  kind: RenameMappingKind;
  /**
   * 一括で当てるか。
   *
   * **2文字以下の `from` は既定で false。** 「灯」「ミナ」のような短い名前は
   * 普通名詞や別の名前の一部と重なりやすく、まとめて置き換えると本文が壊れる
   * （設計書6.37.3）。作者が個別に選んだときだけ有効になる。
   */
  enabled: boolean;
}

/** 一括の既定から外す長さ。ここ以下は作者が選んだときだけ動く */
const SHORT_NAME_MAX = 2;

export interface RenameSource {
  name: string;
  reading?: string | null;
  aliases?: string[];
}

/**
 * 対応表の初期値を作る（設計書6.37.3）。
 *
 * 旧フルネーム→新、旧姓→新姓、旧名→新名、各別名→空（変えない）。
 * **部分の数が合わないときは、部分の対応を作らない**——「姓 名」を
 * 一語の名前へ変えるとき、どちらの部分がどこへ行くのかは機械には決められない。
 * 勝手に当てはめると、姓だけが名へ化けたような置換が混ざる。
 */
export function buildRenameMapping(
  character: RenameSource,
  newName: string,
  newReading?: string | null
): RenameMappingEntry[] {
  const oldName = character.name.trim();
  const nextName = newName.trim();
  const mapping: RenameMappingEntry[] = [];

  if (oldName && nextName && oldName !== nextName) {
    mapping.push(entry(oldName, nextName, "full"));
  }

  const oldParts = splitParts(oldName);
  const newParts = splitParts(nextName);
  // 数が合わないなら、対応の付けようがない。**推測しない**
  if (oldParts.length > 1 && oldParts.length === newParts.length) {
    oldParts.forEach((part, index) => {
      const to = newParts[index];
      if (!part || !to || part === to) return;
      // 同じ組が2度並ばないようにする（姓と名が同じ文字列のときに起きる）
      if (mapping.some((existing) => existing.from === part)) return;
      mapping.push(entry(part, to, "part"));
    });
  }

  for (const alias of character.aliases ?? []) {
    const from = alias.trim();
    if (!from) continue;
    if (mapping.some((existing) => existing.from === from)) continue;
    // 別名の付け替え先は作者に訊く。**推測で別名を変えない**（6.37.3）
    mapping.push(entry(from, "", "alias"));
  }

  // 読みは本文の置換には使わない（本文に読みがそのまま出るとは限らない）。
  // レコードへは `applyMappingToRecord` の `newReading` で入れる
  void newReading;

  return mapping;
}

function entry(
  from: string,
  to: string,
  kind: RenameMappingKind
): RenameMappingEntry {
  return {
    from,
    to,
    kind,
    // 置き換え先が空なら動きようがない。短い名前は既定で外す
    enabled: Boolean(to) && from.length > SHORT_NAME_MAX,
  };
}

function splitParts(name: string): string[] {
  if (!NAME_PART_SEPARATOR.test(name)) return name ? [name] : [];
  return name.split(NAME_PART_SEPARATOR).filter(Boolean);
}

/** 本文の置換の1件。提案パネルへ渡す `AcceptedTypoIssue` と同じ形にしてある */
export interface RenamePlanItem {
  /** 1始まり */
  line: number;
  /** その1か所を指せる前後の文脈（提案パネルの `original`） */
  original: string;
  /** 置き換える語（`target`） */
  target: string;
  /** 置き換え後（`suggestion`） */
  suggestion: string;
  reason: string;
}

/** 実際に当てる対応だけを取り出す。空の付け替え先と、外された対応は動かさない */
export function activeMapping(
  mapping: readonly RenameMappingEntry[]
): RenameMappingEntry[] {
  return mapping.filter((item) => item.enabled && item.from && item.to);
}

/**
 * 本文に当てたときに、どこがどう変わるかを並べる。
 *
 * **長い名前を先に当てる**（`findNameOccurrences` が `termIndex` の
 * 重なり解消を通す）。「ミナ」と「ミナモト」が両方対象のとき、
 * 「ミナモト」を「ミナ」＋「モト」に割らない。
 */
export function planTextReplacements(
  text: string,
  mapping: readonly RenameMappingEntry[]
): RenamePlanItem[] {
  const active = activeMapping(mapping);
  if (active.length === 0) return [];

  const toByFrom = new Map(active.map((item) => [item.from, item.to]));
  const lines = text.split("\n");

  return findNameOccurrences(
    text,
    active.map((item) => item.from)
  ).flatMap((occurrence) => {
    const to = toByFrom.get(occurrence.name);
    if (!to) return [];
    const lineText = lines[occurrence.line - 1] ?? "";
    return [
      {
        line: occurrence.line,
        original: buildUniqueContext(
          lineText,
          occurrence.column,
          occurrence.name.length
        ),
        target: occurrence.name,
        suggestion: to,
        reason: `名前の付け替え：${occurrence.name} → ${to}`,
      },
    ];
  });
}

/**
 * 文字列へ対応表を当てる。
 *
 * **一度置き換えたところは、もう一度見ない。** 「アリア」→「ミナ」と
 * 「ミナ」→「サラ」が同じ表にあると、順に当てれば「アリア」が「サラ」まで
 * 流れてしまう。1回の走査で当てて、当てた先は触らない。
 */
export function applyMappingToText(
  text: string,
  mapping: readonly RenameMappingEntry[]
): string {
  const active = activeMapping(mapping);
  if (active.length === 0 || !text) return text;

  const toByFrom = new Map(active.map((item) => [item.from, item.to]));
  const occurrences = findNameOccurrences(
    text,
    active.map((item) => item.from)
  );
  if (occurrences.length === 0) return text;

  let result = "";
  let cursor = 0;
  for (const occurrence of occurrences) {
    const to = toByFrom.get(occurrence.name);
    if (to === undefined || !to) continue;
    result += text.slice(cursor, occurrence.start) + to;
    cursor = occurrence.end;
  }
  return result + text.slice(cursor);
}

/**
 * 資料のレコードへ対応表を当てる（設計書6.37.3）。
 *
 * **作者が書いたものは触らない**（CLAUDE.md 規則2）。`authorNotes` と
 * `exportNote` は対象外で、識別子（`id`・`schemaVersion`・`updatedAt`）も
 * 名前ではないので当てない。
 *
 * 触るのは**そのレコードが直に持つ文字列と文字列の配列**である。入れ子の
 * 構造（呼称・関係・食い違いの記録）はここでは触らない——`authorLocked` の
 * 呼称のように、当ててはいけないものが混じっている。
 *
 * @param options 本人のレコードなら、新しい名前と読みをここで渡す。
 *   `name` は対応表任せにできない（2文字以下の名前は対応表が既定で
 *   無効になっているため、本人の名前が変わらないことがある）。
 */
export interface RecordRenameOptions {
  /** 本人のレコードに入れる新しい名前 */
  newName?: string;
  /** 同、新しい読み。`null` を渡せば読みを空にする */
  newReading?: string | null;
  /**
   * 別名から落とす旧名。
   *
   * **旧名を別名に残さない**（6.37.3）。残すと用語ハイライトが旧名を
   * 拾い続け、付け替えたはずの名前が本文の色分けに出てくる。
   */
  dropAliases?: string[];
}

/** 名前ではないので、対応表を当てない項目 */
const UNTOUCHED_FIELDS = new Set([
  // 作者が書いたもの（CLAUDE.md 規則2）
  "authorNotes",
  "exportNote",
  // 識別子・機械の値
  "id",
  "schemaVersion",
  "updatedAt",
  "createdAt",
  "sourceHash",
  "promptVersion",
  "model",
  "iconSource",
  "icon",
  "status",
  "spoilerLevel",
  "source",
  // **ファイルの居場所は名前ではない。** 各話あらすじの `fileName` に
  // 人物名が入っていることがあり、当ててしまうと本文との対応が切れる
  "fileName",
  "filePath",
  "ext",
  "kind",
]);

export function applyMappingToRecord<T extends object>(
  record: T,
  mapping: readonly RenameMappingEntry[],
  options: RecordRenameOptions = {}
): T {
  // レコードの型は種別ごとに違う（人物・能力・伏線…）が、ここが見るのは
  // 「文字列の項目」だけなので、まとめて辞書として扱う
  const source = record as Record<string, unknown>;
  const next: Record<string, unknown> = { ...source };

  for (const [key, value] of Object.entries(source)) {
    if (UNTOUCHED_FIELDS.has(key)) continue;
    if (typeof value === "string") {
      next[key] = applyMappingToText(value, mapping);
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      next[key] = (value as string[]).map((item) =>
        applyMappingToText(item, mapping)
      );
    }
  }

  if (options.newName !== undefined && typeof source.name === "string") {
    next.name = options.newName;
  }
  if (options.newReading !== undefined && "reading" in source) {
    next.reading = options.newReading;
  }

  if (Array.isArray(next.aliases)) {
    const drop = new Set(
      [...(options.dropAliases ?? []), options.newName ?? ""]
        .map((alias) => alias.trim())
        .filter(Boolean)
    );
    const seen = new Set<string>();
    next.aliases = (next.aliases as unknown[])
      .filter((alias): alias is string => typeof alias === "string")
      .map((alias) => alias.trim())
      .filter((alias) => {
        if (!alias || drop.has(alias) || seen.has(alias)) return false;
        seen.add(alias);
        return true;
      });
  }

  return next as T;
}
