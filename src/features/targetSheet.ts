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
import type { AuthorReaderProfile } from "../core/authorReaderType";
import { targetSheetCircles } from "../core/targetSheetCircles";
import { TARGET_READER_ENTRY_TITLE } from "../prompts/readerTarget";
import {
  parseTitleFitRecord,
  TITLE_FIT_FILE,
  type TitleFitRecord,
} from "../core/titleFit";

/**
 * 「ターゲット読者」の入口の名前。**写しを作らない**——相談の案内
 * （`prompts/readerTarget.ts`）と同じ定数を使い、`package.json` の title との
 * 一致はテストが見張る。
 */
export const TARGET_READER_TITLE = TARGET_READER_ENTRY_TITLE;

/** シートの置き場と、いまの中身 */
export interface TargetSheetState {
  readonly settings: string;
  readonly sheetPath: string;
  /** いま置いてある紙。**無ければ `undefined`** */
  readonly existing?: string;
  /**
   * 作者が自分で置いた同名のファイルか（印が無い）。
   * **そうなら書かない**——狙いを書き込むこともしない。
   */
  readonly authorOwned: boolean;
  /** 運び直す作者の欄。紙が無ければ初期値 */
  readonly authorBlock: string;
}

/** シートの置き場と作者の欄を読む（書かない） */
export async function readTargetSheetState(
  work: WorkEntry
): Promise<TargetSheetState> {
  const config = await readWorkConfig(work);
  const settings = workPaths(work, config).settings;
  const sheetPath = path.join(settings, TARGET_SHEET_FILE);
  const existing = await readTextIfExists(sheetPath);
  const authorOwned = existing !== undefined && !isTargetSheetDoc(existing);
  const authorBlock =
    existing === undefined || authorOwned
      ? DEFAULT_AUTHOR_BLOCK
      : (extractAuthorBlock(existing) ?? DEFAULT_AUTHOR_BLOCK);
  return { settings, sheetPath, existing, authorOwned, authorBlock };
}

/**
 * 作者が置いた同名のファイルがあるときの断り（書かずに開いて見せる）。
 * 設定資料の `GENERATED_MARKER` と同じ考え方——上書きしてから謝っても
 * 文章は戻らない。
 */
export async function refuseAuthorOwnedSheet(
  state: TargetSheetState
): Promise<void> {
  await warnWithLog(
    `設定/${TARGET_SHEET_FILE} は作者が書いたファイルのようです。上書きを避けるため作り直しませんでした。` +
      "　名前を変えて避けてから、もう一度お試しください。"
  );
  await openInDefaultEditor(state.sheetPath, { preview: false });
}

export interface OpenTargetSheetOptions {
  /**
   * 作者の欄をこれに差し替えて作る（「ターゲット読者」の1段目で狙いを
   * 選んだとき）。渡さなければ、いまの紙から運び直す。
   */
  readonly authorBlock?: string;
  /** 作者自身の読者タイプ（3つの輪の1つ）。**未診断なら渡さない** */
  readonly authorReader?: AuthorReaderProfile;
  /** 3段目で読み取れなかった軸の呼び名 */
  readonly unmeasured?: readonly string[];
  /**
   * 読者像（いま答えた段を含むもの）。渡さなければ台帳から読む。
   * 台帳へ保存できなかったときも、答えた段をシートに載せるため。
   */
  readonly profile?: ReaderProfile;
}

/**
 * ターゲットシートを作り直して開く（設計書6.108・6.108.6）。
 *
 * **ここではAIを呼ばない。** 材料は読者像の台帳（`設定/読者像.json`）・
 * 作者の欄（狙いと理由）・作者自身の読者タイプ・タイトルの適合度の記録
 * （測ったときに残したもの）である。助言（第3段）は次の版。
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
 * 狙いも読者像もまだ無ければ、**紙を作らずに止めて**「先に『ターゲット
 * 読者』を」と言う。空の紙を置くと、作者は「出たのに中身が無い」という
 * 一番分かりにくい形に出くわす。**狙いだけなら作る**（設計書6.108.6：
 * 狙いだけでも一致度は出ないが、狙いの記録と推移は残る）。
 */
export async function openTargetSheet(
  work: WorkEntry,
  options: OpenTargetSheetOptions = {}
): Promise<boolean> {
  useLogFile(work.folderPath);

  const profile = options.profile ?? (await loadProfile(work));
  if (!profile) return false;

  const state = await readTargetSheetState(work);
  if (state.authorOwned) {
    await refuseAuthorOwnedSheet(state);
    return false;
  }
  const { settings, sheetPath } = state;
  const authorBlock = options.authorBlock ?? state.authorBlock;
  const aim = readAimTypes(authorBlock);

  const basis = sheetBasis(profile);
  if (!basis && aim.length === 0) {
    await warnWithLog(
      `${TARGET_SHEET_TITLE}：この作品の狙いも読者像もまだありません。` +
        `先に「${TARGET_READER_TITLE}」で、狙い（どんな読者に読んでもらいたいか）を` +
        "選ぶか、書き方の判断に答えてください。"
    );
    return false;
  }

  const sheet = targetSheetFor({ aim, scores: basis?.scores });

  const notices: string[] = [];
  const historyDir = path.join(
    settings,
    TARGET_SHEET_HISTORY_DIR,
    TARGET_SHEET_HISTORY_SUBDIR
  );
  const at = new Date();
  const history = await recordHistory(historyDir, sheet, basis?.source, at, notices);
  const titleFit = await readTitleFitRecord(settings, notices);

  const doc = buildTargetSheetDoc({
    workTitle: work.title,
    sheet,
    authorBlock,
    source: basis?.source,
    history,
    notices,
    profile,
    unmeasured: options.unmeasured,
    circles: targetSheetCircles({
      authorReader: options.authorReader,
      aim,
      actual: profile.actual,
    }),
    titleFit,
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
  source: ReaderChatSource | undefined,
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

/** 適合度の記録の置き場（`設定/ターゲットシート/適合度.json`） */
export function titleFitPath(settings: string): string {
  return path.join(settings, TARGET_SHEET_HISTORY_DIR, TITLE_FIT_FILE);
}

/**
 * 適合度の記録を読む。**無ければ `undefined`**。
 *
 * 読めない（壊れている）ときも `undefined` だが、**断り書きを残す**
 * ——控えと同じで、記録1つのせいでシートがまるごと出ないほうが困る。
 * 直しはしない（作者が見て決める）。
 */
export async function readTitleFitRecord(
  settings: string,
  notices: string[]
): Promise<TitleFitRecord | undefined> {
  const text = await readTextIfExists(titleFitPath(settings));
  if (text === undefined) return undefined;
  let record: TitleFitRecord | undefined;
  try {
    record = parseTitleFitRecord(JSON.parse(text));
  } catch {
    record = undefined;
  }
  if (!record) {
    notices.push(
      `設定/${TARGET_SHEET_HISTORY_DIR}/${TITLE_FIT_FILE} を読めませんでした（こちらでは直しません）。` +
        "適合度の欄は空にしてあります。"
    );
  }
  return record;
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
