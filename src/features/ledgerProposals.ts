import * as vscode from "vscode";
import * as path from "../core/paths";
import { AIWRITER_DIR, type WorkEntry } from "../models/types";
import {
  PENDING_LEDGER_DIR,
  isLedgerProposalId,
  parseLedgerProposalFile,
  type LedgerProposalFile,
} from "../models/ledgerProposal";
import {
  checkForeshadowAdd,
  checkForeshadowStatus,
  describeLedgerProposal,
  planChapterProposal,
  planScheduleStepProposal,
} from "../core/ledgerProposalPlan";
import { ChapterStore } from "../core/chapterStore";
import {
  addForeshadow,
  createForeshadowStore,
  saveOrUpdateForeshadow,
} from "../core/foreshadowStore";
import { ScheduleStore } from "../core/scheduleStore";
import { materializeGoalsSchedule } from "../core/scheduleEdit";
import { defaultIdMaker } from "../core/scheduleTemplates";
import { EXTERNAL_ORIGIN } from "../core/bulkApproval";
import { workLog } from "../core/logger";
import { scheduleToday } from "./scheduleData";
import type { ProposalPanel, RecordUpdateViewItem } from "./proposalPanel";

/**
 * 外部AIが置いた「台帳の案」（章立て・伏線・予定の段）を、提案パネルで作者に
 * 採否してもらう（作者の裁定 2026-10-16 の5。設計書6.87.24）。
 *
 * - 置く：MCP `novel.propose` の `kind: chapter・foreshadow・schedule`
 *   （`mcp/tools/proposeLedger.ts`。`.aiwriter/pending-ledger/` に1件1ファイル）
 * - 並べる：提案パネルを開いたとき（`primeLedgerProposals`）。分類は「章・伏線・予定の案」
 * - 採る：**今のコマンドと同じ書き方で**台帳へ書く——章＝`withChapterStartingAt`＋
 *   `ChapterStore.save`（「ここから章を始める」と同じ）、伏線＝`addForeshadow`・
 *   `saveOrUpdateForeshadow`（伏線手動追加・伏線状態変更と同じ）、予定＝`updateStep`・
 *   `addStep`＋`ScheduleStore.save`（スケジュールの画面と同じ）。書けたら案のファイルを消す
 * - 見送る：案のファイルを消す（台帳には何も書かない）。どちらもログに残す
 *
 * **採る直前に、置いたときの値といまの台帳を照らす**（`ledgerProposalPlan.ts`）。
 * 作者が案を見る前に台帳を手で直していたら止める——古い案で作者の直しを上書きしない。
 */

/** 提案パネルの分類（タブ）の名前 */
export const LEDGER_PROPOSAL_CATEGORY = "章・伏線・予定の案";

export interface LedgerProposalHooks {
  /** 章立てが変わったとき（作品一覧の折りたたみを作り直す） */
  onChaptersChanged?: (work: WorkEntry) => void;
}

function directoryOf(work: WorkEntry): string {
  return path.join(work.folderPath, AIWRITER_DIR, PENDING_LEDGER_DIR);
}

function fileOf(work: WorkEntry, id: string): string {
  return path.join(directoryOf(work), `${id}.json`);
}

/**
 * 置き場の案を全部読む。**読めないファイルは並べず、直さず、消さない**
 * （作者が開いて確かめられるように残し、ログに名前を書く）。
 */
export async function loadLedgerProposals(
  work: WorkEntry
): Promise<{ proposals: LedgerProposalFile[]; broken: Array<{ file: string; detail: string }> }> {
  let entries: Array<[string, vscode.FileType]>;
  try {
    entries = await vscode.workspace.fs.readDirectory(path.toUri(directoryOf(work)));
  } catch {
    // 置き場がまだ無い＝案が無い
    return { proposals: [], broken: [] };
  }
  const proposals: LedgerProposalFile[] = [];
  const broken: Array<{ file: string; detail: string }> = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File || !name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    try {
      const bytes = await vscode.workspace.fs.readFile(path.toUri(fileOf(work, id)));
      const parsed = parseLedgerProposalFile(JSON.parse(new TextDecoder().decode(bytes)));
      // 中の id とファイル名が食い違うものは並べない（消すときに別のファイルを指す）
      if (parsed.id !== id || !isLedgerProposalId(id)) throw new Error("ファイル名と id が食い違っています。");
      proposals.push(parsed);
    } catch (error) {
      broken.push({ file: name, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  proposals.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return { proposals, broken };
}

/** 案1件を提案パネルの1行にする */
export function ledgerProposalViewItem(file: LedgerProposalFile): RecordUpdateViewItem {
  const view = describeLedgerProposal(file);
  return {
    id: file.id,
    name: view.name,
    changes: view.changes,
    source: file.client ? `外部AI（${file.client}）` : "外部AI",
    // 「外部AIの提案をまとめて確かめる」の対象にする（出どころの印で見分ける）
    origin: EXTERNAL_ORIGIN,
    status: "pending",
    applyLabel: view.applyLabel,
  };
}

/**
 * 溜まっている案の数。メニューの「更新分を反映 残りN」と、作品を選ぶ画面の
 * 「未反映 N件」に足す（2026-10-16 の続き）。
 *
 * **読めた案だけを数える**——提案パネルに並ぶ数と同じにするため（人物の承認待ちの
 * `PendingUpdateStore.count()` も読めたものだけを数える）。壊れた案まで数えると、
 * 印を見て開いた作者には並んでいない分が「消えた」に見える。
 */
export async function countLedgerProposals(work: WorkEntry): Promise<number> {
  return (await loadLedgerProposals(work)).proposals.length;
}

/**
 * 溜まっている案を提案パネルに並べる。案が無ければ分類を作らない（空のタブを出さない）。
 *
 * - パネルを開いたとき（`extension.ts` の `loadPending`）：既定の `quiet: true`。
 *   作者が押した操作ではないので前へ出さない
 * - 「更新分を反映」から（`applyPendingCharacterUpdates`）：ほかの承認待ちが無ければ
 *   `quiet: false` で前へ出す。パネルが開いたままだと `loadPending` は走らないので、
 *   押すたびにここで並べ直す
 *
 * @returns 並べた件数
 */
export async function primeLedgerProposals(
  work: WorkEntry,
  panel: Pick<ProposalPanel, "showRecordUpdates">,
  hooks: LedgerProposalHooks = {},
  options: { quiet?: boolean } = {}
): Promise<number> {
  const { proposals, broken } = await loadLedgerProposals(work);
  const log = workLog(work.folderPath);
  for (const entry of broken) {
    log.failure("外部AIの案を読めませんでした（並べていません。直していません）", {
      ファイル: `${AIWRITER_DIR}/${PENDING_LEDGER_DIR}/${entry.file}`,
      詳細: entry.detail,
    });
  }
  if (proposals.length === 0) return 0;
  panel.showRecordUpdates(
    work,
    proposals.map(ledgerProposalViewItem),
    (id) => applyLedgerProposal(work, id, hooks),
    (id) => dismissLedgerProposal(work, id),
    LEDGER_PROPOSAL_CATEGORY,
    { quiet: options.quiet ?? true }
  );
  return proposals.length;
}

/** 案を読み直す（並べたあとに別の機械で採られた・消されたことがある） */
async function readProposal(work: WorkEntry, id: string): Promise<LedgerProposalFile | undefined> {
  if (!isLedgerProposalId(id)) return undefined;
  try {
    const bytes = await vscode.workspace.fs.readFile(path.toUri(fileOf(work, id)));
    return parseLedgerProposalFile(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}

/**
 * 作者が採った。**今のコマンドと同じ書き方で台帳へ書き**、書けたら案を消す。
 * 失敗しても例外を投げず理由を返す（パネルは1件の失敗で一覧ごと落ちてはいけない）。
 */
export async function applyLedgerProposal(
  work: WorkEntry,
  id: string,
  hooks: LedgerProposalHooks = {}
): Promise<{ ok: boolean; reason?: string }> {
  const file = await readProposal(work, id);
  if (!file) {
    return { ok: false, reason: "案のファイルがありません（別の機械で採ったか、消されています）。" };
  }
  const view = describeLedgerProposal(file);
  const log = workLog(work.folderPath);
  let outcome: { ok: boolean; reason?: string };
  try {
    outcome = await writeLedger(work, file, hooks);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.failure("外部AIの案の反映に失敗", { 案: view.summary, 詳細: detail });
    return { ok: false, reason: detail };
  }
  if (!outcome.ok) return outcome;
  log.line(`外部AIの案を採った：${view.summary}（${file.client || "名乗りなし"}・提案パネル）`);
  await removeProposal(work, id);
  return { ok: true };
}

async function writeLedger(
  work: WorkEntry,
  file: LedgerProposalFile,
  hooks: LedgerProposalHooks
): Promise<{ ok: boolean; reason?: string }> {
  const proposal = file.proposal;
  switch (proposal.type) {
    case "chapter": {
      const store = new ChapterStore(work);
      const planned = planChapterProposal(await store.load(), proposal);
      if (!planned.ok) return { ok: false, reason: planned.reason };
      await store.save(planned.value);
      hooks.onChaptersChanged?.(work);
      return { ok: true };
    }
    case "foreshadowAdd": {
      const loaded = await createForeshadowStore(work).loadAll();
      const refused = checkForeshadowAdd(loaded.records, proposal);
      if (refused) return { ok: false, reason: refused };
      await addForeshadow(work, {
        label: proposal.label,
        note: proposal.note,
        plantedChapter: proposal.plantedChapter,
        plantedQuote: proposal.plantedQuote,
        source: "ai",
        // 元をたどればAIの案なので、作者が書いた記述とは区別する（矛盾からの登録と同じ）
        autoGenerated: true,
      });
      return { ok: true };
    }
    case "foreshadowStatus": {
      const loaded = await createForeshadowStore(work).loadAll();
      const current = loaded.records.find((record) => record.id === proposal.foreshadowId);
      const refused = checkForeshadowStatus(current, proposal);
      if (refused || !current) return { ok: false, reason: refused };
      await saveOrUpdateForeshadow(work, current.id, {
        status: proposal.status,
        resolvedChapter: proposal.resolvedChapter,
        // 引用の無い案で、既にある回収の引用を消さない（伏線状態変更と同じ）
        resolvedQuote: proposal.resolvedQuote || current.resolvedQuote,
      });
      return { ok: true };
    }
    case "scheduleStep": {
      const store = new ScheduleStore(work);
      const now = new Date().toISOString();
      const current = materializeGoalsSchedule(await store.load(), proposal.scheduleId, now);
      const planned = planScheduleStepProposal(current, proposal, {
        today: scheduleToday(),
        now,
        makeId: defaultIdMaker,
      });
      if (!planned.ok) return { ok: false, reason: planned.reason };
      await store.save(planned.value);
      return { ok: true };
    }
  }
}

/** 作者が見送った。台帳には何も書かず、案を消してログに残す */
export async function dismissLedgerProposal(
  work: WorkEntry,
  id: string
): Promise<{ ok: boolean; reason?: string }> {
  const file = await readProposal(work, id);
  if (file) {
    workLog(work.folderPath).line(
      `外部AIの案を見送った：${describeLedgerProposal(file).summary}（${file.client || "名乗りなし"}・提案パネル）`
    );
  }
  await removeProposal(work, id);
  return { ok: true };
}

async function removeProposal(work: WorkEntry, id: string): Promise<void> {
  if (!isLedgerProposalId(id)) return;
  try {
    await vscode.workspace.fs.delete(path.toUri(fileOf(work, id)));
  } catch (error) {
    // 既に無い（別の機械で片付いた）なら目的は達している。ほかの失敗は記録に残す
    if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) {
      workLog(work.folderPath).failure("外部AIの案のファイルを片付けられませんでした", {
        ファイル: `${AIWRITER_DIR}/${PENDING_LEDGER_DIR}/${id}.json`,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
