// ログの書き先：作品ごと（`useLogFile(work.folderPath)`）
import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { atomicWriteFile } from "../core/atomicWrite";
import {
  ReaderTargetStore,
  ReaderTargetStoreError,
} from "../core/readerTargetStore";
import { hasReaderProfile, type ReaderProfile } from "../models/readerProfile";
import type { ReaderChatSource } from "../core/readerTarget";
import type { ReaderScores } from "../models/readerProfile";
import { targetSheetFor, type TargetSheet } from "../core/targetSheet";
import {
  buildTargetSheetDoc,
  DEFAULT_AUTHOR_BLOCK,
  extractAuthorBlock,
  isTargetSheetDoc,
  readAimTypes,
  TARGET_SHEET_FILE,
  TARGET_SHEET_TITLE,
} from "../core/targetSheetDoc";
import {
  buildTargetSheetHistoryEntry,
  isSameAsLastHistory,
  parseTargetSheetHistoryEntry,
  sortTargetSheetHistory,
  targetSheetHistoryNameCandidates,
  TARGET_SHEET_HISTORY_DIR,
  TARGET_SHEET_HISTORY_SUBDIR,
  type TargetSheetHistoryEntry,
} from "../core/targetSheetHistory";
import { openInDefaultEditor } from "../views/openDocument";
import { warnWithLog } from "../views/notify";
import { logFailure, logStep, useLogFile } from "../core/logger";

/**
 * ターゲットシートを作り直して開く（設計書6.108、第1段と第2段）。
 *
 * **AIを1度も呼ばない。** 材料は読者像の台帳（`設定/読者像.json`）と、
 * 作者が手で書いた「狙い」の欄だけである。助言（第3段）は次の版。
 *
 * ## 書くのは2つだけ
 *
 * - `設定/ターゲットシート.md`（最新の1枚。**作者の欄は運び直す**）
 * - `設定/ターゲットシート/履歴/<日付-時刻>.json`（控え。**新規作成のみ**）
 *
 * **原稿には一切書き込まない。** 台帳（読者像）も読むだけである。
 *
 * ## 実行したふりをしない（6.107の教訓）
 *
 * 読者像がまだ無ければ、**紙を作らずに止めて**「先に『ターゲット読者
 * 診断』を」と言う。空の紙を置くと、作者は「出たのに中身が無い」という
 * 一番分かりにくい形に出くわす。
 */
export async function openTargetSheet(work: WorkEntry): Promise<boolean> {
  useLogFile(work.folderPath);

  const profile = await loadProfile(work);
  if (!profile) return false;

  const basis = sheetBasis(profile);
  if (!basis) {
    await warnWithLog(
      `${TARGET_SHEET_TITLE}：この作品の読者像がまだありません。` +
        "先に「ターゲット読者診断」を済ませてください。" +
        "　そのあとでもう一度この操作を押すと、11の読者層との一致度が出ます。"
    );
    return false;
  }

  const config = await readWorkConfig(work);
  const settings = workPaths(work, config).settings;
  const sheetPath = path.join(settings, TARGET_SHEET_FILE);

  const existing = await readTextIfExists(sheetPath);
  if (existing !== undefined && !isTargetSheetDoc(existing)) {
    // 作者が自分で置いた同名のファイルを、黙って作り直さない
    // （設定資料の `GENERATED_MARKER` と同じ考え方）
    await warnWithLog(
      `設定/${TARGET_SHEET_FILE} は作者が書いたファイルのようです。上書きを避けるため作り直しませんでした。` +
        "　名前を変えて避けてから、もう一度お試しください。"
    );
    await openInDefaultEditor(sheetPath, { preview: false });
    return false;
  }

  const authorBlock =
    existing === undefined
      ? DEFAULT_AUTHOR_BLOCK
      : (extractAuthorBlock(existing) ?? DEFAULT_AUTHOR_BLOCK);

  const sheet = targetSheetFor({
    aim: readAimTypes(authorBlock),
    scores: basis.scores,
  });

  const notices: string[] = [];
  const historyDir = path.join(
    settings,
    TARGET_SHEET_HISTORY_DIR,
    TARGET_SHEET_HISTORY_SUBDIR
  );
  const at = new Date();
  const history = await recordHistory(historyDir, sheet, basis.source, at, notices);

  const doc = buildTargetSheetDoc({
    workTitle: work.title,
    sheet,
    authorBlock,
    source: basis.source,
    history,
    notices,
    generatedAt: at,
  });

  try {
    await vscode.workspace.fs.createDirectory(path.toUri(settings));
    // **①の経路（指定なし・上書き）**。生成物なので世代退避は持たない
    // ——作者の欄は上で運び直してあり、`設定/` はGit管理下で戻せる
    await atomicWriteFile(sheetPath, new TextEncoder().encode(doc));
  } catch (error) {
    logFailure(TARGET_SHEET_TITLE, { 理由: messageOf(error) });
    await warnWithLog(
      `設定/${TARGET_SHEET_FILE} を書けませんでした。${messageOf(error)}`
    );
    return false;
  }

  await openInDefaultEditor(sheetPath, { preview: false });
  return true;
}

/** 台帳を読む。**読めなければ止める**（壊れたJSONは直さない） */
async function loadProfile(
  work: WorkEntry
): Promise<ReaderProfile | undefined> {
  try {
    return await new ReaderTargetStore(work).load();
  } catch (error) {
    if (error instanceof ReaderTargetStoreError) {
      await warnWithLog(`読者像を読めませんでした。${error.message}`);
      return undefined;
    }
    throw error;
  }
}

/**
 * どの点数で測るか。
 *
 * **実像（書けているもの）を先に採る。** 相談へ渡す読者像
 * （`chatReaderBasis`）は宣言を先に採るが、あちらは「作者が向かおうと
 * している先へ助言を添える」ための選び方である。このシートの「実態」の
 * 欄が見たいのは**書けているもの**なので、逆の順になる。
 *
 * 実像がまだ無ければ宣言で出す（紙の側に出どころを書く）。どちらも
 * 無ければ `undefined`——**推測で埋めない**。
 */
function sheetBasis(
  profile: ReaderProfile
): { scores: ReaderScores; source: ReaderChatSource } | undefined {
  if (!hasReaderProfile(profile)) return undefined;
  if (profile.actual) {
    return { scores: profile.actual.scores, source: "actual" };
  }
  if (profile.declared) {
    return { scores: profile.declared.scores, source: "declared" };
  }
  return undefined;
}

/**
 * 控えを1件足して、推移に出す一覧を返す（新しい順）。
 *
 * **同じ点数・同じ狙いなら足さない。** 押した回数が推移になっては、
 * 見直しの記録として使えない。
 *
 * 控えが書けなくても、シートそのものは出す（断り書きを残す）。
 */
async function recordHistory(
  historyDir: string,
  sheet: TargetSheet,
  source: ReaderChatSource,
  at: Date,
  notices: string[]
): Promise<TargetSheetHistoryEntry[]> {
  const history = await readHistory(historyDir, notices);
  const entry = buildTargetSheetHistoryEntry({ sheet, source, at });
  if (!entry) return history;

  if (isSameAsLastHistory(entry, history[0])) {
    logStep("ターゲットシート：控えは前回と同じなので作りませんでした");
    return history;
  }

  try {
    await vscode.workspace.fs.createDirectory(path.toUri(historyDir));
    const body = `${JSON.stringify(entry, null, 2)}\n`;
    const bytes = new TextEncoder().encode(body);
    // **新規作成のみ**（②の経路）。一度残った控えは書き換えない
    let written = false;
    for (const name of targetSheetHistoryNameCandidates(at)) {
      try {
        await atomicWriteFile(path.join(historyDir, name), bytes, {
          mode: "create",
        });
        written = true;
        break;
      } catch {
        // その名前は先客がいる（同じ分に2回押した）。次の候補へ
      }
    }
    if (!written) throw new Error("空いている名前がありませんでした");
  } catch (error) {
    logFailure("ターゲットシートの控え", { 理由: messageOf(error) });
    notices.push(
      `今回の控えを残せませんでした（${messageOf(error)}）。推移には出ません。`
    );
    return history;
  }

  return [entry, ...history];
}

/** 控えを読む。**読めない1件で止めない**（飛ばして件数を残す） */
async function readHistory(
  historyDir: string,
  notices: string[]
): Promise<TargetSheetHistoryEntry[]> {
  let names: [string, vscode.FileType][] = [];
  try {
    names = await vscode.workspace.fs.readDirectory(path.toUri(historyDir));
  } catch {
    // まだ1件も無い（置き場そのものが無い）
    return [];
  }

  const entries: TargetSheetHistoryEntry[] = [];
  let unreadable = 0;
  for (const [name, type] of names) {
    if (type === vscode.FileType.Directory) continue;
    if (!name.endsWith(".json")) continue;
    const text = await readTextIfExists(path.join(historyDir, name));
    if (text === undefined) {
      unreadable += 1;
      continue;
    }
    let parsed: TargetSheetHistoryEntry | undefined;
    try {
      parsed = parseTargetSheetHistoryEntry(JSON.parse(text));
    } catch {
      parsed = undefined;
    }
    if (parsed) entries.push(parsed);
    else unreadable += 1;
  }

  if (unreadable > 0) {
    notices.push(
      `控えのうち${unreadable}件を読めませんでした（こちらでは直しません）。`
    );
  }
  return sortTargetSheetHistory(entries);
}

/** ファイルを読む。**無ければ `undefined`**（空文字と区別する） */
async function readTextIfExists(
  filePath: string
): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(path.toUri(filePath));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
