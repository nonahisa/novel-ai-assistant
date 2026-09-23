import { READER_TYPE_IDS } from "./readerTypeNeighbors";
import { formatDayStamp } from "./timestampedFileName";
import { READER_AXIS_ORDER, type ReaderTypeId } from "./readerTarget";
import type { ReaderChatSource } from "./readerTarget";
import type { ReaderScores } from "../models/readerProfile";
import type { TargetSheet } from "./targetSheet";

/**
 * ターゲットシートの控えと推移（設計書6.108.5）。
 *
 * 作者の言葉（2026-09-21）：「ターゲットシートは見直しできる、過去からの
 * 推移を見れるよう、複数保存できるようにしてください」。
 *
 * ## なぜ控えを別ファイルにするのか
 *
 * シート本体（`設定/ターゲットシート.md`）は**最新の1枚**である。過去の
 * 値を同じファイルに積むと、作り直すたびに書き換える範囲が広がり、
 * **作者が手で書いた欄を巻き込む危険**が増える。控えは1回ぶん1ファイルで
 * **新規作成しかしない**（`atomicWriteFile` の `mode: "create"`）ので、
 * 一度残った記録は、この仕組みからは二度と書き換わらない。
 *
 * ## 同じ内容なら増やさない
 *
 * 「ターゲットシート」を2回続けて押しただけで行が増えると、推移の表が
 * 押した回数の記録になってしまう。**点数も狙いも前回と同じなら、控えは
 * 作らない。** 見直し（狙いを書き換える）か、診断のやり直し（点数が動く）
 * があったときだけ増える。
 *
 * ## 読めない控えは飛ばす。止めない
 *
 * 台帳（`設定/読者像.json`）は壊れていたら**止める**——そこを直しに
 * いくのが作者の仕事だからである。控えは違う。1件読めなかったせいで
 * シートがまるごと出ないと、作者は「何が起きたのか」すら見られない。
 * **読めた控えだけで推移を組み、読めなかった件数は紙に断り書きで残す。**
 *
 * VS Code API にも AI にも依存しない。
 */

/** 控えの置き場（`設定/` の下）。2段に分けてあるのは、写しを作らないため */
export const TARGET_SHEET_HISTORY_DIR = "ターゲットシート";
export const TARGET_SHEET_HISTORY_SUBDIR = "履歴";

export const TARGET_SHEET_HISTORY_SCHEMA_VERSION = "1";

/**
 * 推移の表に出す行数の上限。
 *
 * **控えそのものは消さない。** 消すのは表の行だけである——古い控えを
 * 消す仕組みを作ると、作者が「前はどうだったか」を見に戻る道が無くなる。
 */
export const TARGET_SHEET_HISTORY_ROWS = 20;

/**
 * 控え1件。**その日のシートが何を出していたか**をそのまま残す。
 *
 * **点数の4つ（`scores`・`source`・`top`・`affinities`）は、そろって有るか
 * そろって無いか**のどちらかである。無いのは「狙いだけを決めた日」
 * （設計書6.108.6。「ターゲット読者」の1段目だけで止めた日）で、
 * 0.75.0 の控えには必ず4つとも入っている。
 */
export interface TargetSheetHistoryEntry {
  readonly schemaVersion: string;
  /** 控えを取った時刻（ISO） */
  readonly recordedAt: string;
  /** そのときの狙い（作者の欄の1行目） */
  readonly aim: readonly ReaderTypeId[];
  /** そのときの軸の点数。**狙いだけの日は無い** */
  readonly scores?: ReaderScores;
  /** 点数の出どころ（書けているもの／向けているつもり） */
  readonly source?: ReaderChatSource;
  /** そのときのいちばん高い型 */
  readonly top?: ReaderTypeId;
  /**
   * そのときの11型の一致度。
   *
   * **点数から出し直せる値をあえて残している。** 一致度の出し方を将来
   * 変えたとき、出し直すと**過去の紙に載っていた数字が書き換わる**。
   * 推移は「あの日そう見えた」の記録なので、当時の数字のまま残す。
   */
  readonly affinities?: Readonly<Record<ReaderTypeId, number>>;
}

/**
 * 控えを組む。
 *
 * **点数も狙いも無ければ取らない**（残す値が無い）。**狙いだけなら取る**
 * ——「ターゲット読者」は3段を途中でやめられ、済んだ段だけでシートを
 * 作る（設計書6.108.6）。狙いを決めた日そのものが見直しの記録である。
 */
export function buildTargetSheetHistoryEntry(input: {
  sheet: TargetSheet;
  /** 点数の出どころ。**点数が無いときは要らない** */
  source?: ReaderChatSource;
  at: Date;
}): TargetSheetHistoryEntry | undefined {
  const actual = input.sheet.actual;
  if (!actual) {
    if (input.sheet.aim.length === 0) return undefined;
    return {
      schemaVersion: TARGET_SHEET_HISTORY_SCHEMA_VERSION,
      recordedAt: input.at.toISOString(),
      aim: [...input.sheet.aim],
    };
  }

  const affinities = {} as Record<ReaderTypeId, number>;
  for (const entry of actual.ranking) affinities[entry.type] = entry.affinity;

  return {
    schemaVersion: TARGET_SHEET_HISTORY_SCHEMA_VERSION,
    recordedAt: input.at.toISOString(),
    aim: [...input.sheet.aim],
    scores: { ...actual.scores },
    // 出どころが渡されなければ「書けているもの」と決めつけず、宣言として残す
    // （読み取り側の既定と同じ扱い）
    source: input.source ?? "declared",
    top: actual.top,
    affinities,
  };
}

/**
 * 前回と同じ中身か（同じなら控えを増やさない）。
 *
 * 見るのは**点数と狙い**だけである。一致度といちばん高い型は点数から
 * 決まるので、そちらが同じなら必ず同じになる。
 */
export function isSameAsLastHistory(
  entry: TargetSheetHistoryEntry,
  last: TargetSheetHistoryEntry | undefined
): boolean {
  if (!last) return false;
  // 狙いだけの日と、点数の付いた日は別の中身である
  if (Boolean(entry.scores) !== Boolean(last.scores)) return false;
  const sameScores = READER_AXIS_ORDER.every(
    (axis) => entry.scores?.[axis] === last.scores?.[axis]
  );
  if (!sameScores) return false;
  if (entry.aim.length !== last.aim.length) return false;
  return entry.aim.every((type, index) => type === last.aim[index]);
}

/** 新しい順に並べる。**同じ時刻なら元の並びを崩さない** */
export function sortTargetSheetHistory(
  entries: readonly TargetSheetHistoryEntry[]
): TargetSheetHistoryEntry[] {
  return [...entries].sort(
    (left, right) => timeOf(right.recordedAt) - timeOf(left.recordedAt)
  );
}

function timeOf(recordedAt: string): number {
  const at = Date.parse(recordedAt);
  // 読めない時刻は「いちばん古い」扱いにする（推測で今日にしない）
  return Number.isNaN(at) ? 0 : at;
}

/**
 * 控えのJSONを読み解く。**形の合わないものは `undefined`**（直さない）。
 *
 * 作者が手で開いて直すことも、別の端末から同期で降ってくることもある。
 * 欠けた欄を埋めて「読めたことにする」と、推移の表に**出どころの
 * 分からない行**が並ぶ。
 */
export function parseTargetSheetHistoryEntry(
  value: unknown
): TargetSheetHistoryEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;

  const recordedAt = typeof raw.recordedAt === "string" ? raw.recordedAt : "";
  if (!recordedAt) return undefined;

  const aim = Array.isArray(raw.aim)
    ? raw.aim.flatMap((entry) => {
        const type = toReaderType(entry);
        return type ? [type] : [];
      })
    : [];
  const schemaVersion =
    typeof raw.schemaVersion === "string"
      ? raw.schemaVersion
      : TARGET_SHEET_HISTORY_SCHEMA_VERSION;

  /*
    **狙いだけの控え**（設計書6.108.6）。点数の欄が1つも無く、狙いが
    読めるときだけ。点数の欄が半端に残っているものは、狙いだけの控えと
    見なさない——欠けた欄を「無かったこと」にして読むと、壊れた控えが
    別の意味の行として推移に並ぶ。
  */
  if (
    raw.scores === undefined &&
    raw.top === undefined &&
    raw.affinities === undefined &&
    raw.source === undefined
  ) {
    return aim.length > 0 ? { schemaVersion, recordedAt, aim } : undefined;
  }

  const scores = parseScores(raw.scores);
  if (!scores) return undefined;

  const top = toReaderType(raw.top);
  if (!top) return undefined;

  const affinities = {} as Record<ReaderTypeId, number>;
  const rawAffinities =
    typeof raw.affinities === "object" && raw.affinities !== null
      ? (raw.affinities as Record<string, unknown>)
      : {};
  for (const type of READER_TYPE_IDS) {
    const found = rawAffinities[type];
    if (typeof found === "number" && Number.isFinite(found)) {
      affinities[type] = found;
    }
  }

  return {
    schemaVersion,
    recordedAt,
    aim,
    scores,
    // 知らない出どころは「書けているもの」に寄せない。既定は宣言と同じ扱い
    source: raw.source === "declared" ? "declared" : "actual",
    top,
    affinities,
  };
}

function parseScores(value: unknown): ReaderScores | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const scores = {} as ReaderScores;
  for (const axis of READER_AXIS_ORDER) {
    const found = raw[axis];
    if (typeof found !== "number" || !Number.isFinite(found)) return undefined;
    scores[axis] = found;
  }
  return scores;
}

function toReaderType(value: unknown): ReaderTypeId | undefined {
  return READER_TYPE_IDS.find((type) => type === value);
}

/**
 * 控えのファイル名の候補（試す順）。
 *
 * `2026-09-21-2340.json` の形。**既存ファイルは上書きできない**ので
 * （`atomicWrite.ts`）、同じ分に2回書くときのために連番を用意する
 * ——狙いを書き換えて押し直す場面は、まさに同じ分に起きる。
 */
export function targetSheetHistoryNameCandidates(
  at: Date,
  tries = 20
): string[] {
  const minute = `${pad2(at.getHours())}${pad2(at.getMinutes())}`;
  const base = `${formatDayStamp(at)}-${minute}`;
  const names = [`${base}.json`];
  for (let n = 2; names.length < Math.max(tries, 1); n += 1) {
    names.push(`${base}-${n}.json`);
  }
  return names.slice(0, Math.max(tries, 1));
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
