import { isPlaceholderText } from "./placeholderText";
import { READER_TYPE_IDS } from "./readerTypeNeighbors";
import type { ReaderTypeId } from "./readerTarget";

/**
 * タイトルとサブタイトルのターゲット読者適合度（設計書6.108.6、P-41）。
 *
 * 作者の指摘③（2026-09-22 未明）：タイトル・サブタイトルの**ターゲット
 * 読者適合度**を足す。狙いの読者層（無ければ実像の層）に対して、作品の
 * タイトルと各話のサブタイトルが**その読者層に引かれる言い方か**を、
 * AI が 0〜100 と一言で返す。
 *
 * ## 数字は目安
 *
 * AI が返す点で、同じ題でも測り直すと動く（実装ルール3）。だから
 * **順位づけには使わない**——低い順に並べて「直す候補」を示すだけに
 * する（`titleFitCandidates`）。紙の表は話の順のまま出す。
 *
 * ## ここで確かめること（AI を信用しない）
 *
 * - 渡した題への答えか（知らない ID・二重の答えは捨てる）
 * - 点が 0〜100 の数か（範囲の外は丸めず捨てる。小数だけ丸める）
 * - 一言が空・指示語の返り（「一言」「空文字」など）でないか
 * - 一言の字数（超えたら切って印を付ける）
 *
 * VS Code API にも AI にも依存しない。
 */

/** 記録の置き場（`設定/ターゲットシート/` の下）。控えの置き場と同じ段 */
export const TITLE_FIT_FILE = "適合度.json";
export const TITLE_FIT_SCHEMA_VERSION = "1";

/** 1回に頼む題の数。多すぎると答えが長くなり、上限で切れる */
export const TITLE_FIT_BATCH = 40;

/** 一言の字数の上限。表の升に収まる長さ */
export const TITLE_FIT_COMMENT_MAX = 40;

/** 直す候補として挙げる数 */
export const TITLE_FIT_CANDIDATES = 5;

/** 作品タイトルの ID。各話は `e<何番目>` */
export const TITLE_FIT_TITLE_ID = "title";

export type TitleFitKind = "title" | "episode";

export interface TitleFitTarget {
  /** AI とのやり取りで使う名札（`title`・`e3`） */
  readonly id: string;
  readonly kind: TitleFitKind;
  /** 紙に出す場所の名前（「作品タイトル」「第3話」） */
  readonly label: string;
  /** 測る題そのもの */
  readonly text: string;
}

export interface TitleFitItem extends TitleFitTarget {
  readonly score: number;
  readonly comment: string;
}

/** どの読者層に向けて測ったか（その層を何から決めたか） */
export type TitleFitBasis = "aim" | "actual" | "declared";

export interface TitleFitRecord {
  readonly schemaVersion: string;
  readonly measuredAt: string;
  readonly readerType: ReaderTypeId;
  readonly basis: TitleFitBasis;
  readonly model: string;
  /** 読み取れた題（話の順） */
  readonly items: readonly TitleFitItem[];
  /** 頼んだのに見立てが返らなかった題の数。**黙って落とさない** */
  readonly unmeasured: number;
}

/**
 * 測る題を並べる。
 *
 * **題の無い話は測らない**（「第16話」だけの話に、言い方の見立ては
 * 付けられない）。ID は並びの番号から作る——話数そのものを ID に
 * すると、プロローグや合本の中の話で重なる。
 */
export function titleFitTargets(
  workTitle: string,
  episodes: readonly { label: string; title: string | null }[]
): TitleFitTarget[] {
  const targets: TitleFitTarget[] = [];
  const title = workTitle.trim();
  if (title) {
    targets.push({
      id: TITLE_FIT_TITLE_ID,
      kind: "title",
      label: "作品タイトル",
      text: title,
    });
  }
  episodes.forEach((episode, index) => {
    const text = episode.title?.trim();
    if (!text) return;
    targets.push({
      id: `e${index + 1}`,
      kind: "episode",
      label: episode.label,
      text,
    });
  });
  return targets;
}

/** 決まった数ずつに分ける（作品タイトルは最初の束に入る） */
export function titleFitBatches(
  targets: readonly TitleFitTarget[],
  size = TITLE_FIT_BATCH
): TitleFitTarget[][] {
  const batches: TitleFitTarget[][] = [];
  for (let start = 0; start < targets.length; start += size) {
    batches.push(targets.slice(start, start + size));
  }
  return batches;
}

/**
 * プロンプトに書いた言葉が、そのまま一言として返ってくる形。
 *
 * CLAUDE.md「繰り返し起きた失敗」3番——指示の言葉が答えの中身として
 * 返ってくる。プロンプトで「一言」「40字以内」と書いたので、それを捨てる。
 */
const ECHO_COMMENTS = ["一言", "ひとこと", "コメント", "40字以内", "（40字以内）"];

function isEchoComment(comment: string): boolean {
  const body = comment.replace(/[「」『』（）()\s。]/g, "");
  return ECHO_COMMENTS.some((echo) => body === echo.replace(/[（）]/g, ""));
}

export interface TitleFitParse {
  readonly items: TitleFitItem[];
  /** 捨てた理由（記録へ残す。作者の画面には出さない） */
  readonly notes: string[];
}

/**
 * AI の答えを確かめる。**形が合わなければ何も採らない**（投げない）
 * ——束1つの失敗で全体を止めない（実装スタイル）。
 */
export function parseTitleFitResponse(
  value: unknown,
  batch: readonly TitleFitTarget[]
): TitleFitParse {
  const notes: string[] = [];
  if (typeof value !== "object" || value === null) {
    return { items: [], notes: ["答えがJSONの形ではありませんでした"] };
  }
  const rawItems = (value as Record<string, unknown>).items;
  if (!Array.isArray(rawItems)) {
    return { items: [], notes: ["items が並びではありませんでした"] };
  }

  const byId = new Map(batch.map((target) => [target.id, target]));
  const seen = new Set<string>();
  const items: TitleFitItem[] = [];

  for (const raw of rawItems) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const target = byId.get(id);
    if (!target) {
      notes.push(`渡していない題への答えを捨てました: ${id || "（IDなし）"}`);
      continue;
    }
    if (seen.has(id)) {
      notes.push(`同じ題への2つ目の答えを捨てました: ${id}`);
      continue;
    }

    const score = entry.score;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      notes.push(`点が数ではありませんでした: ${id}`);
      continue;
    }
    // 範囲の外は丸めて採らない——端に寄せると、壊れた答えが
    // 「いちばん低い（高い）題」として直す候補の先頭に並ぶ
    if (score < 0 || score > 100) {
      notes.push(`点が0〜100の外でした: ${id}（${score}）`);
      continue;
    }

    const rawComment =
      typeof entry.comment === "string" ? entry.comment.trim() : "";
    if (!rawComment || isPlaceholderText(rawComment, true) || isEchoComment(rawComment)) {
      notes.push(`一言が空か、指示の言葉の返りでした: ${id}`);
      continue;
    }
    const comment =
      [...rawComment].length > TITLE_FIT_COMMENT_MAX
        ? `${[...rawComment].slice(0, TITLE_FIT_COMMENT_MAX).join("")}…`
        : rawComment;

    seen.add(id);
    items.push({ ...target, score: Math.round(score), comment });
  }

  return { items, notes };
}

/**
 * 直す候補。**点の低い順**に、決まった数まで。
 *
 * 同点は元の並び（作品タイトル → 話の順）を崩さない——並べ直すたびに
 * 順が変わると、前回の紙と見比べられない。
 */
export function titleFitCandidates(
  items: readonly TitleFitItem[],
  limit = TITLE_FIT_CANDIDATES
): TitleFitItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.score - right.item.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/**
 * 記録を読む。**形の合わないものは `undefined`**（直さない）。
 *
 * 作者が手で開くことも、別の端末から同期で降ってくることもある。
 * 欠けた欄を埋めて読むと、出どころの分からない点が紙に並ぶ。
 */
export function parseTitleFitRecord(value: unknown): TitleFitRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;

  const measuredAt = typeof raw.measuredAt === "string" ? raw.measuredAt : "";
  if (!measuredAt) return undefined;
  const readerType = READER_TYPE_IDS.find((type) => type === raw.readerType);
  if (!readerType) return undefined;
  const basis =
    raw.basis === "aim" || raw.basis === "actual" || raw.basis === "declared"
      ? raw.basis
      : undefined;
  if (!basis) return undefined;
  if (!Array.isArray(raw.items)) return undefined;

  const items: TitleFitItem[] = [];
  for (const entry of raw.items) {
    const item = parseStoredItem(entry);
    if (!item) return undefined;
    items.push(item);
  }

  return {
    schemaVersion:
      typeof raw.schemaVersion === "string"
        ? raw.schemaVersion
        : TITLE_FIT_SCHEMA_VERSION,
    measuredAt,
    readerType,
    basis,
    model: typeof raw.model === "string" ? raw.model : "",
    items,
    unmeasured:
      typeof raw.unmeasured === "number" && Number.isFinite(raw.unmeasured)
        ? raw.unmeasured
        : 0,
  };
}

function parseStoredItem(value: unknown): TitleFitItem | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const { id, kind, label, text, score, comment } = raw;
  if (typeof id !== "string" || typeof label !== "string") return undefined;
  if (typeof text !== "string" || typeof comment !== "string") return undefined;
  if (kind !== "title" && kind !== "episode") return undefined;
  if (typeof score !== "number" || !Number.isFinite(score)) return undefined;
  return { id, kind, label, text, score, comment };
}
