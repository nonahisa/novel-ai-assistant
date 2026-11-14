/**
 * 付箋（シーンメモ）の印を、作品ごとに選べるようにする（設計書6.40.8。作者の決定 2026-11-14 夜）。
 *
 * ## ここは vscode に触らない
 *
 * 印は「字数」「投稿用」「書き出し」「AIの入力」「読み上げ」「MCP」の全部の道で使う。
 * どの道からも同じ答えになるよう、印の一覧と解釈を純粋な関数としてここへ置く。
 * 作品の設定（`.aiwriter/config.json` の `memoMarkers`）を読むのは呼ぶ側
 * （拡張機能は `memoMarkerStore.ts`、MCP は `mcp/tools/memoMarkersOfFolder.ts`）で、
 * どちらも解釈はここの `resolveMemoMarkers` を通す。
 *
 * ## 正規表現ではなく、字の並びで持つ
 *
 * 印の判定は「行の頭の空白のあとが、この字で始まるか」だけである。正規表現で持つと、
 * バックスラッシュ（`\\`）を TS・JSON・画面のテンプレート文字列・出先のページの4層で
 * それぞれ逃がすことになり、どこか1か所で必ず数を間違える。字の並びなら JSON に
 * そのまま載せて画面へ渡せる。
 */

/** 印の名前。設定ファイルにはこの名前の並びで書く */
export type MemoMarkerId = "slash" | "backslash" | "percent" | "comment";

/** 選ぶ窓の並び順。挿すときに使う印も、この順で最初にオンのもの */
export const MEMO_MARKER_IDS: readonly MemoMarkerId[] = ["slash", "backslash", "percent", "comment"];

export interface MemoMarkerDef {
  id: MemoMarkerId;
  /** 選ぶ窓の見出し */
  label: string;
  /**
   * 選ぶ窓の説明。**例外のあるものだけ**に置く（名前に印そのものが書いてあり、
   * 「行の頭に」は全部に共通なので窓の題へ1回だけ書く。設計書6.82.1）
   */
  detail?: string;
  /** 行の頭（空白のあと）がこれで始まればメモ。囲みは空（判定は別） */
  prefixes: readonly string[];
  /** 「ここにメモを足す」で挿す字（前と後ろ）。中身は作者が打つ */
  insert: { prefix: string; suffix: string };
}

/**
 * 印の候補（スイッチは4つ。半角と全角は組で、1つのスイッチで一緒にオン・オフ）。
 *
 * 半角のバックスラッシュ（U+005C）は、日本語の字体では「¥」に見える。中身は同じ字なので、
 * 円記号に見える `¥¥` と打った行もここに当たる（全角の `￥￥` U+FFE5 は別の字なので、組に足してある）。
 */
export const MEMO_MARKER_DEFS: readonly MemoMarkerDef[] = [
  {
    id: "slash",
    label: "// と ／／",
    prefixes: ["//", "／／"],
    insert: { prefix: "// ", suffix: "" },
  },
  {
    id: "backslash",
    label: "\\\\ と ＼＼・￥￥",
    detail: "半角のバックスラッシュ2つ。日本語の字体では ¥¥ に見える",
    prefixes: ["\\\\", "＼＼", "￥￥"],
    insert: { prefix: "\\\\ ", suffix: "" },
  },
  {
    id: "percent",
    label: "%% と ％％",
    prefixes: ["%%", "％％"],
    insert: { prefix: "%% ", suffix: "" },
  },
  {
    id: "comment",
    label: "<!-- ～ -->",
    detail: "複数行でもよい。閉じていない <!-- は本文のまま",
    prefixes: [],
    insert: { prefix: "<!-- ", suffix: " -->" },
  },
];

/**
 * 判定に使う形。**画面（WebView）と出先のページへも JSON のまま渡す**ので、
 * 字の並びと真偽だけで書く（関数や正規表現を持たない）。
 */
export interface MemoMarkers {
  /** オンの印の名前（`MEMO_MARKER_IDS` の順） */
  readonly ids: readonly MemoMarkerId[];
  /** 1行の印（行の頭の空白のあと） */
  readonly prefixes: readonly string[];
  /** `<!-- ～ -->` の囲みをメモにするか */
  readonly comment: boolean;
}

function isMemoMarkerId(value: string): value is MemoMarkerId {
  return (MEMO_MARKER_IDS as readonly string[]).includes(value);
}

/** 名前の並びから判定の形を作る。知らない名前は飛ばし、並びは `MEMO_MARKER_IDS` の順に揃える */
export function memoMarkersOf(ids: readonly string[]): MemoMarkers {
  const on = MEMO_MARKER_IDS.filter((id) => ids.includes(id));
  const prefixes: string[] = [];
  for (const def of MEMO_MARKER_DEFS) {
    if (on.includes(def.id)) prefixes.push(...def.prefixes);
  }
  return { ids: on, prefixes, comment: on.includes("comment") };
}

/** 既定（設定が無い作品）。これまでと同じ `//` と `／／` だけ */
export const DEFAULT_MEMO_MARKER_IDS: readonly MemoMarkerId[] = ["slash"];
export const DEFAULT_MEMO_MARKERS: MemoMarkers = memoMarkersOf(DEFAULT_MEMO_MARKER_IDS);

/** 設定ファイルの欄が読めない（直さずに止める。実装ルール2） */
export class MemoMarkersConfigError extends Error {
  constructor(detail: string) {
    super(
      `作品の設定（.aiwriter/config.json）の memoMarkers が読めません：${detail}` +
        "（直さずに止めました。詳細メニューの作品別設定の「メモの印」で選び直すか、手で直してください）"
    );
    this.name = "MemoMarkersConfigError";
  }
}

/**
 * 設定ファイルの欄（`memoMarkers`）を、判定の形にする。
 *
 * - 欄が無い → 既定（`//` と `／／`）
 * - 名前の並び → その印。**知らない名前は飛ばす**（新しい版で印が増えたあと古い版で開いても止まらない）
 * - それ以外（文字列でない・空・知っている名前が1つも無い）→ **投げる。** 黙って既定へ戻すと、
 *   作者が選んだ印の行（`%%` など）が字数と投稿用のコピーに出てしまう
 */
export function resolveMemoMarkers(raw: unknown): MemoMarkers {
  if (raw === undefined) return DEFAULT_MEMO_MARKERS;
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string")) {
    throw new MemoMarkersConfigError("印の名前（slash・backslash・percent・comment）の並びではありません");
  }
  const known = (raw as string[]).filter(isMemoMarkerId);
  if (known.length === 0) {
    throw new MemoMarkersConfigError("オンの印が1つもありません");
  }
  return memoMarkersOf(known);
}

/** 2つの印の組が同じか（オンの名前で比べる） */
export function sameMemoMarkers(a: MemoMarkers, b: MemoMarkers): boolean {
  return a.ids.length === b.ids.length && a.ids.every((id, index) => b.ids[index] === id);
}

/** 挿すときの字。**オンの印のうち最初のもの**（`//` を外した作品では、ほかの印で挿す） */
export function memoInsertOf(markers: MemoMarkers = DEFAULT_MEMO_MARKERS): { prefix: string; suffix: string } {
  const first = MEMO_MARKER_DEFS.find((def) => markers.ids.includes(def.id));
  return first ? first.insert : MEMO_MARKER_DEFS[0].insert;
}

/** その組で、印の見出しを「・」でつないだもの（知らせと案内に使う） */
export function memoMarkerLabels(markers: MemoMarkers): string {
  return MEMO_MARKER_DEFS.filter((def) => markers.ids.includes(def.id))
    .map((def) => def.label)
    .join("・");
}

/**
 * 作品の設定ファイルの中身（`.aiwriter/config.json` の文字列）から印を作る。
 * 無ければ（undefined）既定。JSON として読めない・欄が壊れていれば投げる（直さずに止める）。
 *
 * `vscode` も `fs` も使わずに読みたい所（出先の取り込み `outboxImport.ts` は読み口を
 * 受け取って動く）のための口。読み方は `resolveMemoMarkers` と同じ。
 */
export function memoMarkersOfConfigText(text: string | undefined): MemoMarkers {
  if (text === undefined) return DEFAULT_MEMO_MARKERS;
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new MemoMarkersConfigError(
      `JSON として読めません（${error instanceof Error ? error.message : String(error)}）`
    );
  }
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).memoMarkers : undefined;
  return resolveMemoMarkers(value);
}

/**
 * 閉じていない `<!--` を保存のときに知らせるかの覚え（設計書6.40.8）。
 *
 * **同じ話・同じ場所では1回だけ。** 書いている最中は保存のたびに同じ閉じ忘れが残るので、
 * 毎回出すと作者の手が止まる。閉じたら覚えを捨てる——あとでまた閉じ忘れたら、また知らせる。
 * 場所は「話の場所（比べるための形）＋行」で覚える。
 */
export class UnclosedMemoNoticeMemory {
  private readonly told = new Map<string, number>();

  /**
   * その話のいまの閉じ忘れの行（1始まり。無ければ null）を渡す。知らせるべきなら true
   * （呼んだ側が知らせる）。
   */
  shouldNotify(fileKey: string, line: number | null): boolean {
    if (line === null) {
      this.told.delete(fileKey);
      return false;
    }
    if (this.told.get(fileKey) === line) return false;
    this.told.set(fileKey, line);
    return true;
  }
}
