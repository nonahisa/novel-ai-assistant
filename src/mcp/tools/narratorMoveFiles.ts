import * as fs from "node:fs";
import * as nodePath from "node:path";
import { AIWRITER_DIR } from "../../models/types";
import { parseCharacter, type Character } from "../../models/character";
import { describeNarratorMove, findNarratorMoves } from "../../core/narratorMoves";
import {
  NARRATOR_MOVE_DISMISSED_FILE,
  PENDING_MOVES_DIR,
  assembleNarratorMoveReview,
  describeNarratorMoveReviewItem,
  pendingNarratorMoveFileName,
  planNarratorMoveStaging,
  readPendingNarratorMoveFile,
  type NarratorMoveStaleReason,
  type PendingNarratorMove,
} from "../../core/pendingNarratorMoves";
import { blankMemoLines } from "../../core/sceneMemo";
import { isNarratorRecord, workNarratorContextOf } from "../../core/sceneNarrators";
import { pastSceneSourcesOf } from "./contradiction";
import { SETTINGS_SUBDIRS, describeError, readSettingsRecords } from "./shared";

/**
 * 語り手の取り違えの移す案（設計書6.5.12）を、MCP の道で積む・読む
 * （0.102.12。作者の指示 2026-10-11「語り手の残り」）。
 *
 * 0.102.3 で移す案の承認待ち（`.aiwriter/pending-moves/`）を作ったとき、
 * 積むのは製品の［設定資料を抽出］の終わりだけにした（読み書きの
 * `PendingNarratorMoveStore` が `vscode.workspace.fs` を使うため）。そのため
 * 外部AIで抽出して `novel.extract.commit` で保存した作品では、移す案が
 * 積まれず、`pending.list` にも並ばなかった。
 *
 * **見つけ方・積む決め方・並べ方は、製品と同じ関数を通す**（`findNarratorMoves`・
 * `planNarratorMoveStaging`・`assembleNarratorMoveReview`。どれも `vscode` を
 * 持たない）。ここが持つのは Node の `fs` でファイルを出し入れするところだけ
 * ——写しを作ると、画面と外から見えるものが片方だけ直ってずれる。
 *
 * **移す・見送るは、ここからはしない。** 移し先を選ぶのは作者で、選ぶ口は
 * 提案パネルにしか無い（`pending.list` の結果にもそう書く）。
 */

/** 置き場（作品フォルダーからの相対。返事にそのまま出す） */
const MOVES_RELATIVE = `${AIWRITER_DIR}/${PENDING_MOVES_DIR}`;

function movesDirOf(folder: string): string {
  return nodePath.join(nodePath.resolve(folder), AIWRITER_DIR, PENDING_MOVES_DIR);
}

/**
 * 承認待ちの移す案を読む。**壊れたものは直さず `errors` へ積む**（製品の
 * `PendingNarratorMoveStore.loadAll` と同じ。並びも同じ）。
 */
export function readPendingNarratorMovesFs(folder: string): {
  moves: PendingNarratorMove[];
  errors: Array<{ file: string; message: string }>;
} {
  const moves: PendingNarratorMove[] = [];
  const errors: Array<{ file: string; message: string }> = [];
  const directory = movesDirOf(folder);
  let names: string[];
  try {
    names = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
  } catch {
    // 置き場が無い＝承認待ちが無い
    return { moves, errors };
  }
  for (const name of names) {
    const relative = `${MOVES_RELATIVE}/${name}`;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(nodePath.join(directory, name), "utf8"));
      moves.push(readPendingNarratorMoveFile(parsed, relative));
    } catch (error) {
      errors.push({ file: relative, message: describeError(error) });
    }
  }
  moves.sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      left.stagedAt.localeCompare(right.stagedAt) ||
      left.key.localeCompare(right.key)
  );
  return { moves, errors };
}

/**
 * 見送った案の鍵。**読めなければ空**（製品の `NarratorMoveDismissedHistory.load`
 * と同じ。記録が無くても積むことはできる——見送った案がまた出るだけ）。
 */
function readDismissedKeys(folder: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(
        nodePath.join(nodePath.resolve(folder), AIWRITER_DIR, "cache", NARRATOR_MOVE_DISMISSED_FILE),
        "utf8"
      )
    );
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

/** 積んだ（積む）案1件。作者が読む言葉で返す */
export interface StagedNarratorMove {
  /** 承認待ちのファイル（作品フォルダーからの相対） */
  file: string;
  sourceName: string;
  /** 提案パネルの出どころの欄と同じ一行（「移す案：役割「皇子」（第12話）」） */
  label: string;
}

export interface NarratorMoveStagingResult {
  staged: StagedNarratorMove[];
  /** 書こうとして失敗したもの */
  failed: Array<{ file: string; reason: string }>;
  /** 1件も調べられなかった理由（あれば。黙って0件にしない） */
  skipped?: string;
}

/**
 * 抽出の保存の終わりに、主人公の資料に疑う値があれば移す案を積む
 * （製品の `stageNarratorMovesAfterExtraction` と同じ決め方）。
 *
 * - 見るのは**台帳に保存済みの主人公**。今回の保存で承認待ちへ回った変更は
 *   まだ台帳に無く、承認したあとの次の保存で積まれる（製品と同じ）
 * - 移し先の候補には、今回新しく作った人物も入る（呼ぶ側が書いたあとで呼ぶ）
 * - **新規作成だけ**（`wx`）で書く。鍵がファイル名なので、同じ案は同じ名前に
 *   なり、二重には積めない。既にあれば積まない
 * - 読めない承認待ちがある主人公の案は積まない（同じ名前へ書くと、壊れた
 *   ファイルを置き換えてしまう）
 * - `dryRun` なら書かずに、積む案だけを返す
 */
export function stageNarratorMovesFs(
  folder: string,
  options: { dryRun: boolean; now?: string }
): NarratorMoveStagingResult {
  const result: NarratorMoveStagingResult = { staged: [], failed: [] };
  const ledger = readSettingsRecords(folder, SETTINGS_SUBDIRS.characters, parseCharacter);
  if (ledger.unreadableFiles.length > 0) {
    // 読めない人物があると語り手も移し先も決めきれない（製品と同じく積まない）
    result.skipped = `読めない人物ファイルがあるため、移す案は調べていません（${ledger.unreadableFiles.join("、")}）。`;
    return result;
  }
  const sources = pastSceneSourcesOf(folder);
  if (sources.length === 0) return result;
  // 語り手の決め方は製品の抽出・「AIで再読込」と同じ（全話を繋いだ本文）
  const context = workNarratorContextOf(
    sources.map((source) => blankMemoLines(source.text)).join("\n"),
    ledger.records
  );
  if (!context) return result;

  const found = ledger.records
    .filter((person: Character) => isNarratorRecord([person.name, ...person.aliases], context))
    .map((person) => ({ source: person, items: findNarratorMoves(person, context, sources) }))
    .filter((entry) => entry.items.length > 0);
  if (found.length === 0) return result;

  const pending = readPendingNarratorMovesFs(folder);
  const plan = planNarratorMoveStaging(found, {
    pendingKeys: new Set(pending.moves.map((move) => move.key)),
    dismissedKeys: readDismissedKeys(folder),
    now: options.now ?? new Date().toISOString(),
  }).filter(
    (payload) =>
      !pending.errors.some((error) =>
        nodePath.basename(error.file).startsWith(`${payload.sourceId}_`)
      )
  );

  const directory = movesDirOf(folder);
  for (const payload of plan) {
    const name = pendingNarratorMoveFileName(payload.sourceId, payload.key);
    const entry: StagedNarratorMove = {
      file: `${MOVES_RELATIVE}/${name}`,
      sourceName: payload.sourceName,
      label: describeNarratorMove(payload.item).label,
    };
    if (options.dryRun) {
      result.staged.push(entry);
      continue;
    }
    try {
      fs.mkdirSync(directory, { recursive: true });
      // **新規作成だけ**（`wx`）。同じ鍵のファイルは同じ案なので、あれば積まない
      fs.writeFileSync(
        nodePath.join(directory, name),
        `${JSON.stringify(payload, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" }
      );
      result.staged.push(entry);
    } catch (error) {
      if ((error as { code?: unknown }).code === "EEXIST") continue;
      result.failed.push({ file: entry.file, reason: describeError(error) });
    }
  }
  return result;
}

/** `pending.list` の移す案1件 */
export interface NarratorMoveListItem {
  /** 承認待ちのファイル（作品フォルダーからの相対） */
  file: string;
  /** 値を外す人物（主人公）の id と、いまの名前（台帳に居なければ積んだときの名前） */
  sourceId: string;
  sourceName: string;
  /** 提案パネルの出どころの欄と同じ一行 */
  label: string;
  /** 提案パネルの行の本文（いまの値・なぜ疑ったか） */
  changes: string[];
  /** 移し先の候補（いまの台帳に居る人だけ）と、既定（名指しできた案だけ） */
  destinations: Array<{ id: string; name: string }>;
  defaultDestination: string | null;
  status: "pending" | "stale" | "blocked";
  /** 古い案の理由（`stale` のときだけ） */
  staleReason?: string;
}

export interface NarratorMoveListResult {
  /** 承認待ちのファイルの数（読めないものを含む） */
  total: number;
  items: NarratorMoveListItem[];
  /** 読めない案（壊れたJSON・知らない形）。**製品も直さず残す** */
  unreadable: Array<{ file: string; message: string }>;
  /** 人物の台帳が読めず、組み立てを見合わせているときの、読めないファイル */
  blockedBy: string[];
}

const STALE_LABELS: Record<NarratorMoveStaleReason, string> = {
  missing: "値を外す人物が台帳にいません（まとめたか消しました）",
  noChange: "この値はもう資料にありません（直したか、別の承認で外れています）",
};

/**
 * 承認待ちの移す案を、提案パネルと同じ組み立てで読む（読むだけ）。
 * 古い案は画面に並ばないので後ろへ回す（人物の承認待ちと同じ）。
 */
export function listNarratorMovesFs(folder: string): NarratorMoveListResult {
  const pending = readPendingNarratorMovesFs(folder);
  const result: NarratorMoveListResult = {
    total: pending.moves.length + pending.errors.length,
    items: [],
    unreadable: pending.errors,
    blockedBy: [],
  };
  if (pending.moves.length === 0) return result;

  const ledger = readSettingsRecords(folder, SETTINGS_SUBDIRS.characters, parseCharacter);
  if (ledger.unreadableFiles.length > 0) {
    // 製品も、読めない人物があれば組み立てない（片付けもしない）
    result.blockedBy = ledger.unreadableFiles.map(
      (name) => `設定/${SETTINGS_SUBDIRS.characters}/${name}`
    );
    result.items = pending.moves.map((move) => ({
      file: move.filePath,
      sourceId: move.sourceId,
      sourceName: move.sourceName,
      label: describeNarratorMove(move.item).label,
      changes: [],
      destinations: [],
      defaultDestination: null,
      status: "blocked",
    }));
    return result;
  }

  const assembled = assembleNarratorMoveReview(pending.moves, ledger.records);
  result.items = [
    ...assembled.items.map((item): NarratorMoveListItem => {
      const text = describeNarratorMoveReviewItem(item);
      return {
        file: item.move.filePath,
        sourceId: item.source.id,
        sourceName: item.source.name,
        label: text.source,
        changes: text.changes,
        destinations: item.options,
        defaultDestination: item.defaultId,
        status: "pending",
      };
    }),
    ...assembled.stale.map(({ move, reason }): NarratorMoveListItem => ({
      file: move.filePath,
      sourceId: move.sourceId,
      sourceName: move.sourceName,
      label: describeNarratorMove(move.item).label,
      changes: [],
      destinations: [],
      defaultDestination: null,
      status: "stale",
      staleReason: STALE_LABELS[reason],
    })),
  ];
  return result;
}
