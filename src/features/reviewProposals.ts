import * as vscode from "vscode";
import { showQuickPickKeepingFocus } from "../views/pickerFocus";
import { fromUri } from "../core/paths";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import { formatChapterLabel, stripChapterLabel } from "../core/episodeLabel";
import { ProposalStore } from "../core/proposalStore";
import {
  categoryLabel,
  describeDecisionCounts,
  isHandCategory,
  isOpinionOnly,
  locateProposal,
  summarizeDecisions,
  type ProposalView,
} from "../models/proposal";
import { FileLockStore } from "../core/fileLockStore";
import { describeLock, normalizeFile } from "../models/fileLock";
import { isEditorMode, recordEdit } from "../core/actorContext";
import { editHistoryFile } from "../core/editHistoryFormat";
import { finishReviewLabel, saveAndSyncLabel } from "../core/syncEntryNames";
import {
  reviewLockHeldMessage,
  reviewLockReleasedOthersDetail,
  reviewLockTakenMessage,
  reviewRangeNotifyFailedMessage,
  reviewRangeStartedMessage,
  reviewLockWho,
} from "../core/reviewLockMessages";
import { reviewLockEditorLogin } from "./manuscriptReviewLock";
import { tryGitUserName } from "../core/gitAttribution";
import {
  readTextFile,
  writeTextFilePreservingFormat,
} from "../core/textFile";
import { cancelItem, isCancelItem } from "../views/dialogs";
import type { PlacedProposal } from "../core/sceneMemoRows";
import { reloadOpenDocumentAfterWrite } from "./reloadAfterWrite";
import { notifyDone } from "../views/notify";
import { logFailure, useLogFile } from "../core/logger";
import { canRunProcesses } from "../core/runtime";
import { scanWork } from "../core/scanner";
import { describeLockRange } from "../core/editingRepo";
import { activeTabFileUri } from "./manuscriptTab";
import { ProposerLoginStore } from "../core/proposerLogins";
import { editorLoginForProposal } from "./editingSite";
import { authorGithubLogin } from "./authorGithubLogin";

/**
 * 編集部からの提案を、作者が見て決める（設計書5.6）。
 *
 * **編集部は本文を書き換えない。** 届くのは「こう直したい」という
 * 申し出だけで、採るかどうかは作者が決める。
 *
 * **作者モードでは校正・メモパネルに並べる**（作者の指示 2026-11-08「編集からの
 * 提案も校正メモにうつしてください」。それまでは提案パネル）。採る・見送る・
 * 読んだは、行の押し口から `decideEditorProposal` を通る。**本文を書き換える
 * 処理を新しく作らない**（`acceptProposal` の1本。5.4のとおり、書き込み口を増やさない）。
 *
 * 編集者モードでは、置いた提案の数を知らせるだけ（採るのは作者の判断）。
 */
export async function reviewProposals(work: WorkEntry): Promise<void> {
  const store = new ProposalStore(work);
  const all = await store.load();
  const pending = all.filter((entry) => entry.status === "pending");

  if (all.length === 0) {
    void vscode.window.showInformationMessage(
      "編集者からの提案はまだありません。" +
        "編集者が校正・校閲を行い、同期すると届きます。"
    );
    return;
  }
  /*
    **採否の内訳を「採用 N・見送り N・読まれた N」で添える**（作者の決定 2026-11-01）。
    編集部が作者から送り返された採否を見る場所はここなので、意見を読んだものを
    採用に混ぜずに言う（`summarizeDecisions`）
  */
  const counts = summarizeDecisions(all);
  const decided = counts.accepted + counts.rejected + counts.read;
  const breakdown = decided > 0 ? `これまでの採否：${describeDecisionCounts(counts)}。` : "";
  if (pending.length === 0) {
    void vscode.window.showInformationMessage(
      `未決の提案はありません（これまでに ${all.length} 件の提案がありました）。` +
        breakdown
    );
    return;
  }

  // **編集者モードでは決められない。** 提案を採るのは作者の判断である
  if (isEditorMode()) {
    void vscode.window.showInformationMessage(
      `未決の提案が ${pending.length} 件あります。` +
        "採るかどうかは作者が決めます（編集者モードでは決められません）。" +
        breakdown
    );
    return;
  }

  await openEditorProposalsInMemoPanel(work);
  void vscode.window.showInformationMessage(
    `編集者からの提案が ${pending.length} 件あります。` +
      `「${MEMO_PANEL_NAME}」で1件ずつご確認ください。`
  );
}

/** 知らせに出す、並べる先の画面の名前 */
const MEMO_PANEL_NAME = "校正・メモパネル";

/**
 * 校正・メモパネルを、その作品で開く（Ctrl+Alt+M と同じ口）。
 *
 * **コマンドを通す。** `sceneMemoPanel.ts` を直に読み込むと、パネルの部品が
 * この束（提案パネルからも読まれる）へ引き込まれ、読み合いの輪ができる。
 * 作者が押した命令なので、フォーカスはパネルへ移してよい（検知の自動の開き方とは別）。
 */
async function openEditorProposalsInMemoPanel(work: WorkEntry): Promise<void> {
  await vscode.commands.executeCommand("novelai.openSceneMemos", {
    type: "work",
    work,
  });
}

/**
 * GitHub から編集部の提案を受け取った結果（「編集部の提案を見る」の前半）。
 *
 * **受け取りは Node（git）を使う**ので、中身は `shareWithEditor.ts` の
 * `receiveEditorProposals` が持ち、ここからは動的 import で呼ぶ（実装ルール7）。
 */
export type EditorReceiveOutcome =
  | {
      kind: "received";
      /** 作品の台帳へ新しく足した件数 */
      added: number;
      /** 取り寄せ（早送り）が断られ、手元にある分だけ取り込んだ */
      pullFailed: boolean;
      /** 校閲の範囲が動いた知らせ（`describeLockChanges`） */
      lockMessages: string[];
    }
  /** まだ編集部へ渡していない作品（編集用フォルダーの記録が無い） */
  | { kind: "notShared" }
  /** この環境では受け取れない（ブラウザ版） */
  | { kind: "unavailable" }
  /** 受け取りの途中で失敗した。`detail` はログへだけ残す */
  | { kind: "failed"; detail: string };

/** 試験で差し替えられる口。製品は何も渡さない */
export interface ShowEditorProposalsDeps {
  receive: (work: WorkEntry) => Promise<EditorReceiveOutcome>;
}

const defaultShowDeps: ShowEditorProposalsDeps = {
  receive: async (work) => {
    if (!canRunProcesses()) return { kind: "unavailable" };
    const { receiveEditorProposals } = await import("./shareWithEditor.js");
    return receiveEditorProposals(work);
  },
};

/**
 * 編集部の提案を見る（作者モード。作者の判断 2026-11-01「1つにまとめる」）。
 *
 * 以前は「編集部提案取込」（受け取るだけ）と「編集部提案確認」（並べるだけ）に
 * 分かれていた。自動の同期で先に受け取られていると、取込は「すべて取り込み済み」で
 * 終わり、作者は提案がどこにあるのか分からなかった（実機 2026-11-01）。
 *
 * 1. GitHub から受け取る（手動の取込と同じ道）
 * 2. 受け取った分も含めて、**未決の提案をすべて**校正・メモパネルに並べる
 *    （2026-11-08 までは提案パネル）。新しく届いた分が0件でも、未決があれば開く
 * 3. 受け取りに失敗しても、手元にある未決は並べ、理由を1文添える
 *
 * **本文には触らない。** 書くのは受け取りの中の提案と鍵の台帳だけ。
 */
export async function showEditorProposals(
  work: WorkEntry,
  deps: ShowEditorProposalsDeps = defaultShowDeps
): Promise<{ pending: number }> {
  // **編集者モードでは受け取らない。** 提案を出す側なので、置いた数を見る道へ
  if (isEditorMode()) {
    await reviewProposals(work);
    return { pending: 0 };
  }

  let outcome: EditorReceiveOutcome;
  try {
    outcome = await deps.receive(work);
  } catch (error) {
    outcome = {
      kind: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (outcome.kind === "failed") {
    // **エラーの本文は捨てずにログへ**（実装ルール5）。画面には原因を当てずに言う
    useLogFile(work.folderPath);
    logFailure("編集者の提案の受け取り", { 作品: work.title, 詳細: outcome.detail });
  }
  if (outcome.kind === "received") {
    for (const text of outcome.lockMessages) {
      void vscode.window.showInformationMessage(text);
    }
  }

  const all = await new ProposalStore(work).load();
  const pending = all.filter((entry) => entry.status === "pending");
  const trouble = describeReceiveTrouble(outcome);

  if (pending.length === 0) {
    const counts = summarizeDecisions(all);
    const decided = counts.accepted + counts.rejected + counts.read;
    const history =
      all.length > 0
        ? `これまでに ${all.length} 件の提案がありました` +
          (decided > 0 ? `（${describeDecisionCounts(counts)}）` : "") +
          "。"
        : "";
    const notShared =
      outcome.kind === "notShared"
        ? `「${work.title}」はまだ編集者へ渡していません。`
        : "";
    const text = `未決の提案はありません。${history}${notShared}${trouble}`;
    if (trouble) void vscode.window.showWarningMessage(text);
    else void vscode.window.showInformationMessage(text);
    return { pending: 0 };
  }

  /*
    **提案パネルには並べない**（作者の指示 2026-11-08）。校正・メモパネルを開けば、
    パネルが台帳の未決を読む（`loadEditorProposalsForMemo`）。開いていれば読み直す
  */
  await openEditorProposalsInMemoPanel(work);
  const added = outcome.kind === "received" && outcome.added > 0
    ? `（いま ${outcome.added} 件届きました）`
    : "";
  const head =
    `編集者からの提案が ${pending.length} 件あります${added}。` +
    `「${MEMO_PANEL_NAME}」で1件ずつご確認ください。`;
  if (trouble) {
    void vscode.window.showWarningMessage(`${head}${trouble}手元にある分を並べています。`);
  } else {
    void vscode.window.showInformationMessage(head);
  }
  return { pending: pending.length };
}

/**
 * 受け取れなかった理由の1文（受け取れたときは空）。
 *
 * **エラー文から原因を当てない**（実装ルール5）。git の文は英語で、言い当てると
 * 外れたときに作者を違う方向へ動かす。「受け取れなかった」ことだけを言い、詳細はログ。
 */
function describeReceiveTrouble(outcome: EditorReceiveOutcome): string {
  if (outcome.kind === "unavailable") {
    return "ブラウザ版ではGitHubから受け取れません。";
  }
  if (outcome.kind === "failed") {
    return "GitHubから受け取れませんでした（詳しくは「ログ」に残しました）。";
  }
  if (outcome.kind === "received" && outcome.pullFailed) {
    return "GitHubから受け取れませんでした。";
  }
  return "";
}

/**
 * 自動の同期で提案が届いたとき、開いている校正・メモパネルを読み直させる口
 * （`extension.ts` が起動時に1回だけ覚えさせる。`refreshSceneMemoFindings`）。
 *
 * 同期の後始末（`editingAutomation.ts`）は Node 側の束で動的に読まれ、パネルを
 * 引数で受け取れない。パネルの部品をここから直に読み込むと読み合いの輪ができるので、
 * 読み直す関数だけを持つ。
 *
 * **2026-11-08 までは提案パネルの選び欄へ静かに足していた**（`primeEditorProposals`）。
 * 作者モードの編集者の提案は校正・メモパネルへ移ったので、提案パネルへは足さない。
 */
let memoPanelRefresher: ((workId: string) => Promise<void>) | undefined;

export function rememberMemoPanelRefresher(
  refresh: (workId: string) => Promise<void>
): void {
  memoPanelRefresher = refresh;
}

/**
 * 届いた作品の校正・メモパネルが開いていれば読み直す（開いていなければ何もしない）。
 * **編集者モードでは何もしない**（校正・メモパネルは編集者モードで使えない画面）。
 */
export async function refreshEditorProposalsView(work: WorkEntry): Promise<void> {
  if (isEditorMode() || !memoPanelRefresher) return;
  await memoPanelRefresher(work.id);
}

/**
 * 画面に出す提案の理由（提案パネルのころの `toViewItem` と同じ組み立て）。
 *
 * - **編集部が手で書いたものは、分類を頭に添える**（「編集者の修正：…」）。
 *   検知の指摘は理由が種類の一語（「促音の誤り」等）で分かるが、手書きの理由は
 *   自由な文なので、検知から来たものか人が書いたものかが読み分けられない
 * - **出した編集者は GitHub のユーザー名で添える**（作者の答え 2026-11-07。0.138.0）。
 *   `proposer` は編集者のパソコンの git の名前なので出さない。取り込んだ時点の名前を
 *   覚えていなければ添えない
 */
export function editorProposalReason(
  proposal: Pick<ProposalView, "id" | "category" | "reason">,
  logins: ReadonlyMap<string, string>
): string {
  const said = isHandCategory(proposal.category)
    ? `${categoryLabel(proposal.category)}：${proposal.reason}`
    : proposal.reason;
  const login = logins.get(proposal.id);
  return login ? `${said}（${login} の提案）` : said;
}

/** 校正・メモパネルへ渡す1件（絶対パスはパネルの側が作品の場所と繋ぐ） */
export type EditorProposalRow = Omit<PlacedProposal, "filePath">;

/**
 * 校正・メモパネルに並べる、台帳の未決の提案（作者の指示 2026-11-08。設計書6.96.5）。
 *
 * **`proposals.jsonl` が正**（5.7.5.8）。指摘の置き場（`findings.jsonl`）には写さず、
 * 開くたびに台帳から読む。**期限（`novelai.findings.retentionDays`）は掛けない**——
 * 編集者の提案は作者が決めるまで残るもので、決めないまま隠すと送り返しが永久に走らない。
 *
 * **編集者モードでは並べない**（採るのは作者の判断。編集者モードは今のまま提案パネル）。
 */
export async function loadEditorProposalsForMemo(
  work: WorkEntry
): Promise<EditorProposalRow[]> {
  if (isEditorMode()) return [];
  const pending = (await new ProposalStore(work).load()).filter(
    (entry) => entry.status === "pending"
  );
  if (pending.length === 0) return [];
  const logins = await new ProposerLoginStore(work).load();
  return pending.map((view) => ({
    id: view.id,
    file: view.file,
    line: view.line,
    original: view.original,
    target: view.target,
    suggestion: view.suggestion,
    reason: editorProposalReason(view, logins),
    opinionOnly: isOpinionOnly(view),
  }));
}

/** 行の押し口から決めた結果 */
export interface EditorProposalDecisionOutcome {
  ok: boolean;
  /** 決められなかった理由（作者が確認の窓で止めたときは無し） */
  reason?: string;
  /** 決めたあとに添える一言 */
  detail?: string;
}

/**
 * 校正・メモパネルの行から、編集者の提案を決める（作者の指示 2026-11-08）。
 *
 * - `accept`：直しの提案は本文へ当てる（［採る］）。意見だけの提案は「読んだ」で
 *   片づける（［読んだ］。本文は変えない）
 * - `reject`：見送る（［見送る］。本文は変えない）
 *
 * **提案パネルの［適用］と同じ道を通す**：校閲中の話は断る（`confirmNotUnderReview`）→
 * `acceptProposal`（台帳の行で照らす・`writeTextFilePreservingFormat`・採否の記録・
 * 決め終えたら送り返し）→ 開いている本文の読み直し。台帳（`proposals.jsonl`）へは
 * decision の行を**足すだけ**（実装ルール2）。
 */
export async function decideEditorProposal(
  work: WorkEntry,
  proposal: Pick<PlacedProposal, "id" | "file" | "line" | "original" | "target" | "suggestion" | "opinionOnly">,
  decision: "accept" | "reject"
): Promise<EditorProposalDecisionOutcome> {
  // **編集者モードでは決めない**（採るのは作者の判断。画面からは来ない道だが、念のため）
  if (isEditorMode()) {
    return { ok: false, reason: "編集者モードでは提案を決められません。" };
  }
  const absolute = path.join(work.folderPath, proposal.file);
  if (decision === "reject") {
    await rejectProposal(work, proposal.id, editHistoryFile(work.folderPath, absolute));
    return { ok: true };
  }
  if (proposal.opinionOnly) {
    // 本文には触らないので、校閲中かどうかも確かめない（提案パネルの［読んだ］と同じ）
    const outcome = await acceptProposal(work, { ...proposal, suggestion: "" });
    return outcome.ok
      ? { ok: true, detail: "意見を読みました（本文は変えていません）。" }
      : { ok: false, reason: outcome.reason };
  }
  if (!(await confirmNotUnderReview(work, absolute))) return { ok: false };
  const outcome = await acceptProposal(work, proposal);
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  // 開いている本文（素のエディター・原稿エディター）を読み直す。提案パネルの［適用］と同じ
  await reloadOpenDocumentAfterWrite(absolute, work);
  return { ok: true };
}

/**
 * 編集者が校閲中の話か。**校閲中なら断って false を返す**（作者の裁定、2026-10-28
 * 「校閲中の範囲は書けなくする」）。提案パネルの［適用］と校正・メモパネルの［採る］が
 * 同じものを通す（2026-11-08 に提案パネルの中から出した）。
 *
 * 誰がいつから見ているかを伝え、決裂したときの解く手段（連携の解除）を添える。
 */
export async function confirmNotUnderReview(
  work: WorkEntry,
  filePath: string
): Promise<boolean> {
  const relative = normalizeFile(path.relative(work.folderPath, filePath));
  const lock = await new FileLockStore(work).lockFor(relative);
  if (!lock || lock.holderKind !== "editor") return true;

  // 以前は「それでも直す」を選べたが、校閲中の話は本文への書き込みの入口で断られる。
  // 解く手段は「編集部連携を解除」（編集部と決裂したとき）
  const action = await vscode.window.showWarningMessage(
    `${path.basename(filePath)} は編集者が校閲中のため、適用できません。`,
    {
      modal: true,
      // 名前は GitHub のユーザー名（鍵の holder の git の名前は出さない）
      detail: describeLock(lock, reviewLockWho(await reviewLockEditorLogin(work))),
    },
    "連携を解除…"
  );
  if (action === "連携を解除…") {
    await vscode.commands.executeCommand("novelai.revokeEditorAccess", { type: "work", work });
  }
  return false;
}

/**
 * 校閲を始める／終える（編集者モード）。
 *
 * **ファイル単位で押さえる。** 作品全体を止めると、編集部が第3話を
 * 見ている間、作者は第20話も書けない。
 */
export async function toggleReviewLock(work: WorkEntry): Promise<void> {
  // **前に出ているタブから取る。** 原稿エディタ（既定の開き方）は
  // `TextEditor` を持たないので、`activeTextEditor` だけでは話を開いていても
  // 空になる（2026-10-12）。タブが読めない環境のために素のエディタへも落とす
  const uri =
    activeTabFileUri() ?? vscode.window.activeTextEditor?.document.uri;

  /*
    **編集者モードの「開始」は、話数の範囲を選ばせる**（作者の裁定、2026-10-28）。
    作品丸ごとではなく、校閲する範囲だけを押さえる。開いている話がすでに押さえられて
    いるときは、これまでどおり外す問いへ進む（終了）。
  */
  if (isEditorMode()) {
    const held = uri ? await heldByEditorFile(work, uri) : false;
    if (!held) {
      await startRangeReview(work, uri);
      return;
    }
  }

  if (!uri) {
    void vscode.window.showWarningMessage(
      "校閲するファイルを開いてから実行してください。"
    );
    return;
  }

  const filePath = fromUri(uri);
  // 「中にあるか」は共通の判定に任せる（2026-09-23）。`startsWith("..")` の
  // 写しは、`..下書き` のようなフォルダーを外と誤り、別のドライブのファイル
  // （`relative` が絶対の場所を返す）を中と誤っていた
  if (!path.isPathInside(work.folderPath, filePath)) {
    void vscode.window.showWarningMessage(
      "この作品のファイルではありません。"
    );
    return;
  }
  const relative = normalizeFile(path.relative(work.folderPath, filePath));

  const store = new FileLockStore(work);
  const current = await store.lockFor(relative);
  const who = (await tryGitUserName(work.folderPath)) ?? "";
  const holderKind = isEditorMode() ? "editor" : "author";

  if (current) {
    const answer = await vscode.window.showWarningMessage(
      reviewLockHeldMessage(path.basename(relative)),
      {
        modal: true,
        detail: describeLock(current, reviewLockWho(await reviewLockEditorLogin(work))),
      },
      "外す"
    );
    if (answer !== "外す") return;
    await store.release([relative], who, holderKind);
    await recordEdit(work, {
      actor: holderKind,
      action: "校閲のロックを外した",
      // 名前だけにしない（ほかの章の同じ名前の話と取り違える。0.130.4）
      file: editHistoryFile(work.folderPath, filePath),
      // 履歴は画面に出る。鍵の holder は git の名前なので使わず、編集者の鍵なら
      // GitHub の名前、そうでなければ「ほかの人」と言う（名前を推し量らない）
      detail: current.holder && current.holder !== who
        ? reviewLockReleasedOthersDetail(
            current.holderKind === "editor"
              ? reviewLockWho(await reviewLockEditorLogin(work))
              : "ほかの人"
          )
        : "",
    });
    // 済んだ記録も、この作品のログへ（直前に触った作品へ流さない。0.81.4）
    useLogFile(work.folderPath);
    notifyDone(
      `${path.basename(relative)} のロックを外しました。`
    );
    return;
  }

  const note = await pickNote();
  if (note === undefined) return;

  await store.acquire([relative], who, holderKind, note);
  await recordEdit(work, {
    actor: holderKind,
    action: "校閲のロックをかけた",
    file: editHistoryFile(work.folderPath, filePath),
    detail: note,
  });
  void vscode.window.showInformationMessage(
    reviewLockTakenMessage(path.basename(relative)) +
      // **編集者が送るのは「校閲を終えて返す」だけ**（作者の判断 2026-11-01）。
      // 編集者モードの「保存・同期」は受け取るだけなので、「同期すると」とは言わない
      (holderKind === "editor"
        ? `「${finishReviewLabel()}」で作者へ届きます。`
        : `「${saveAndSyncLabel()}」で送ると、編集者にも伝わります。`) +
      "終わったらもう一度押して外してください。"
  );
}

/** 開いているファイルが、すでに押さえられているか */
async function heldByEditorFile(work: WorkEntry, uri: vscode.Uri): Promise<boolean> {
  const filePath = fromUri(uri);
  if (!path.isPathInside(work.folderPath, filePath)) return false;
  const relative = normalizeFile(path.relative(work.folderPath, filePath));
  return (await new FileLockStore(work).lockFor(relative)) !== undefined;
}

/** 範囲選びの1項目 */
interface EpisodePickItem extends vscode.QuickPickItem {
  /** 作品フォルダーからの相対パス（鍵の名前） */
  relative: string;
}

/**
 * 校閲する話の範囲を、始めの話と終わりの話の2つの選択で決めて、まとめて押さえる。
 *
 * 話の並びは作品一覧と同じ（`scanWork` の順）。最初の候補は前に出ているタブの話。
 * 間の話をまとめて `acquire` する（鍵は話ごとに1行ずつ）。
 */
/**
 * 校閲の範囲を選ぶ一覧の、話の行の名前。
 *
 * **題に含まれる話数は落とす**（`stripChapterLabel`）。投稿サイトから取り込んだ話は題が
 * 「第1話 薄皮の向こう側」と話数を含むので、前に「第1話」を付けると「第1話　第1話 …」と
 * 二重になった（作者の報告、2026-11-05）。見出しは作品一覧と同じ `formatChapterLabel`
 */
export function reviewEpisodeLabel(
  episode: Pick<EpisodeFile, "fileName" | "subtitle" | "kind" | "chapterStart" | "chapterEnd" | "date" | "dateSeq">
): string {
  const chapter = formatChapterLabel(episode);
  if (!chapter) return episode.fileName;
  const title = stripChapterLabel(episode.subtitle, chapter);
  return title ? `${chapter}　${title}` : chapter;
}

/**
 * 一覧の先頭に置く近道の行（「開いている話」「始めの話だけ」）。
 *
 * **話の行と見分けがつく名前にする。** 同じ名前で先頭にもう1行置くと、同じ話が二度並んだ
 * 重複に見えた（作者の報告、2026-11-05）。名前は「〈近道の名前〉：〈話〉」にする
 */
export function shortcutPickItem<T extends vscode.QuickPickItem>(item: T, note: string): T {
  return { ...item, label: `$(arrow-right) ${note}：${item.label}`, description: item.description };
}

async function startRangeReview(
  work: WorkEntry,
  activeUri: vscode.Uri | undefined
): Promise<void> {
  const { episodes } = await scanWork(work);
  if (episodes.length === 0) {
    void vscode.window.showWarningMessage("この作品には、校閲できる話がありません。");
    return;
  }
  const items: EpisodePickItem[] = episodes.map((episode) => ({
    label: reviewEpisodeLabel(episode),
    description: episode.fileName,
    relative: normalizeFile(path.relative(work.folderPath, episode.filePath)),
  }));
  const activeRelative =
    activeUri && path.isPathInside(work.folderPath, fromUri(activeUri))
      ? normalizeFile(path.relative(work.folderPath, fromUri(activeUri)))
      : undefined;
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.relative === activeRelative)
  );

  const first = await pickEpisode("校閲する範囲：始めの話を選びます", items, activeIndex, "開いている話");
  if (!first) return;
  const firstIndex = items.indexOf(first);
  const rest = items.slice(firstIndex);
  const last = await pickEpisode("校閲する範囲：終わりの話を選びます", rest, 0, "始めの話だけ");
  if (!last) return;
  const files = items
    .slice(firstIndex, items.indexOf(last) + 1)
    .map((item) => item.relative);

  const note = await pickNote();
  if (note === undefined) return;

  const who = (await tryGitUserName(work.folderPath)) ?? "";
  await new FileLockStore(work).acquire(files, who, "editor", note);
  const range = describeLockRange(files);
  await recordEdit(work, {
    actor: "editor",
    action: "校閲のロックをかけた",
    file: range,
    detail: note,
  });
  useLogFile(work.folderPath);
  // 見出しは下の帯、続き（作者へ届ける手順）は右下の知らせ（帯は1行で切れるため）
  const started = reviewRangeStartedMessage(range);
  notifyDone(started.headline, [started.note]);
  // 作者の側が書き続けないよう、鍵はすぐ届ける（記録して送る。失敗しても校閲は始められる）
  if (!canRunProcesses()) return;
  void import("./finishReview.js")
    .then((module) => module.publishLedgerQuietly(work, "校閲の範囲を知らせる"))
    .then((detail) => {
      if (detail) {
        // 画面の知らせは短くするので、止まった段（記録・送信・合わせ直し）と git の文はログへ残す
        // （残さないと、どこで止まったかを後からたどれない。0.134.2）
        useLogFile(work.folderPath);
        logFailure("校閲の範囲を知らせる", { 作品: work.title, 範囲: range, 詳細: detail });
        void vscode.window.showInformationMessage(reviewRangeNotifyFailedMessage());
      }
    })
    .catch((error: unknown) => {
      useLogFile(work.folderPath);
      logFailure("校閲の範囲を知らせる", {
        作品: work.title,
        範囲: range,
        詳細: error instanceof Error ? error.message : String(error),
      });
    });
}

/** 話を1つ選ばせる。最初の候補は `activeIndex`（並びは変えない） */
async function pickEpisode(
  title: string,
  items: EpisodePickItem[],
  activeIndex: number,
  shortcutNote: string
): Promise<EpisodePickItem | undefined> {
  /*
    **最初の候補は、前に出ているタブの話。** `showQuickPick` は最初に選ばれている項目を
    指定できないので、先頭に「開いている話」の近道を1行置き、そのあとに作品一覧と同じ並びで
    全部の話を出す。
  */
  const shortcut: EpisodePickItem | undefined = items[activeIndex]
    ? shortcutPickItem(items[activeIndex], shortcutNote)
    : undefined;
  const entries: vscode.QuickPickItem[] = [...(shortcut ? [shortcut] : []), ...items];
  const picked = await showQuickPickKeepingFocus([...entries, cancelItem()], {
    title,
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked) || !("relative" in picked)) return undefined;
  const relative = (picked as EpisodePickItem).relative;
  return items.find((item) => item.relative === relative);
}

async function pickNote(): Promise<string | undefined> {
  const picked = await showQuickPickKeepingFocus(
    [
      { label: "校閲中", note: "校閲中" },
      { label: "誤字脱字を見ています", note: "誤字脱字を見ています" },
      { label: "推敲の提案を作っています", note: "推敲の提案を作っています" },
      cancelItem(),
    ],
    {
      title: "何をしているかを、作者へ伝えます",
      placeHolder: "作者の画面に出ます",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  return "note" in picked ? picked.note : "";
}

/**
 * 承認して本文へ反映する。
 *
 * **適用の直前に本文と照合する。** 提案が届いてから作者が本文を
 * 直していることがある。合わなければ、**書き換えずに理由を出す。**
 */
export async function acceptProposal(
  work: WorkEntry,
  proposal: { id: string; file: string; line: number; original: string; target: string; suggestion: string }
): Promise<{ ok: boolean; reason?: string }> {
  /*
    **意見だけの提案（直した案が空）は、本文を書き換えない**（作者の指示 2026-11-01）。
    空の案で置き換えると、選んだ所が消える。「読んだ」の記録だけを足し（採用には
    数えない。作者の決定 2026-11-01）、送り返しは直しの提案と同じ道を通す
  */
  if (isOpinionOnly(proposal)) {
    await acknowledgeProposal(work, proposal);
    return { ok: true };
  }
  const absolute = path.join(work.folderPath, proposal.file);
  let file;
  try {
    file = await readTextFile(absolute);
  } catch {
    return { ok: false, reason: "本文を読み込めませんでした。" };
  }

  // **照らし方は置く側（編集部の手書きの提案）と同じ関数**（`locateProposal`）。
  // 置くときに「選んだ所を指す」と確かめた位置が、採るときにもそのまま当たる
  const located = locateProposal(file.text, proposal);
  if (located.kind === "originalMissing") {
    return {
      ok: false,
      reason:
        "提案が届いてから本文が変わっているため、この提案の位置を特定できませんでした。",
    };
  }
  if (located.kind === "targetMissing") {
    return { ok: false, reason: "提案の位置を特定できませんでした。" };
  }
  const lines = file.text.split("\n");
  const lineText = lines[proposal.line - 1];
  const at = located.at;
  lines[proposal.line - 1] =
    lineText.slice(0, at) +
    proposal.suggestion +
    lineText.slice(at + proposal.target.length);

  const result = await writeTextFilePreservingFormat(
    absolute,
    lines.join("\n"),
    file,
    file.hash
  );
  if (!result.ok) {
    return { ok: false, reason: "本文を書き戻せませんでした。" };
  }

  const { who, decidedByLogin, editorLogin } = await decisionNames(work, proposal.id);
  await new ProposalStore(work).decide([
    {
      proposalId: proposal.id,
      time: new Date().toISOString(),
      decidedBy: who,
      ...(decidedByLogin ? { decidedByLogin } : {}),
      status: "accepted",
      note: "",
    },
  ]);
  await recordEdit(work, {
    actor: "author",
    action: editorLogin ? `編集者 ${editorLogin} の提案を採り入れた` : "編集者の提案を採り入れた",
    editorLogin,
    // 名前だけにしない（ほかの章の同じ名前の話と取り違える。0.130.4）。
    // `proposal.file` は相対だが、提案パネルからは `path.relative` の `\` 区切りで
    // 来るので、組み立て直した場所から履歴の形へ揃える
    file: editHistoryFile(work.folderPath, absolute),
    detail: `${proposal.line}行 「${proposal.target}」→「${proposal.suggestion}」`,
  });
  startReturnIfFinished(work);
  return { ok: true };
}

/**
 * 意見だけの提案を「読んだ」として片づける。**本文には触らない。**
 *
 * **「読んだ」（`read`）で残す**（作者の決定 2026-11-01）。採った（`accepted`）にすると
 * 編集部の側で意見が「採用」に数えられ、見送り（`rejected`）にすると「意見が退けられた」と
 * 読めてしまう。読んだうえで直すかどうかは作者が本文で決める。
 */
async function acknowledgeProposal(
  work: WorkEntry,
  proposal: { id: string; file: string; line: number; target: string }
): Promise<void> {
  const { who, decidedByLogin, editorLogin } = await decisionNames(work, proposal.id);
  await new ProposalStore(work).decide([
    {
      proposalId: proposal.id,
      time: new Date().toISOString(),
      decidedBy: who,
      ...(decidedByLogin ? { decidedByLogin } : {}),
      status: "read",
      note: "意見を読んだ",
    },
  ]);
  await recordEdit(work, {
    actor: "author",
    action: editorLogin ? `編集者 ${editorLogin} の意見を読んだ` : "編集者の意見を読んだ",
    editorLogin,
    file: editHistoryFile(work.folderPath, path.join(work.folderPath, proposal.file)),
    detail: `${proposal.line}行 「${proposal.target}」`,
  });
  startReturnIfFinished(work);
}

/**
 * 採否を決めるときに書き写す名前（設計書5.7.5.9。0.138.0）。
 *
 * - `who`：作者の git の名前（今までどおり `decidedBy` に入れる。画面には出さない）
 * - `decidedByLogin`：作者の GitHub のユーザー名。編集者の側の採否の一覧で出す。引けなければ無し
 * - `editorLogin`：提案を出した編集者の GitHub のユーザー名。履歴の行に書き写すので、
 *   解除で `.aiwriter/editing.json` から名前が消えても残る
 *
 * 名前が取れなくても採否は書く（名前が無いより、採否が残らないほうが困る）。
 */
async function decisionNames(
  work: WorkEntry,
  proposalIdValue: string
): Promise<{ who: string; decidedByLogin?: string; editorLogin?: string }> {
  const [who, decidedByLogin, editorLogin] = await Promise.all([
    tryGitUserName(work.folderPath).then((name) => name ?? "", () => ""),
    authorGithubLogin(work),
    editorLoginForProposal(work, proposalIdValue).catch(() => undefined),
  ]);
  return { who, decidedByLogin, editorLogin };
}

/**
 * 採否を決め終えていれば、編集部へ静かに送り返す（作者の裁定、2026-10-28）。
 *
 * **待たない。** 送り返しは回線を使うので、提案パネルの操作を待たせない。
 * 失敗は中で知らせてログへ残し、**採否そのものは成功のまま**にする。
 * `shareWithEditor` は Node（git）を使うので、ブラウザ版の束に入れないよう
 * 動的 import にする（実装ルール7）。
 */
function startReturnIfFinished(work: WorkEntry): void {
  if (isEditorMode() || !canRunProcesses()) return;
  void import("./editingAutomation.js")
    .then((module) => module.returnDecisionsIfFinished(work))
    .catch((error: unknown) => {
      useLogFile(work.folderPath);
      logFailure("採否の送り返し", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    });
}

/**
 * 却下する。**本文には触らない**
 *
 * `file` は編集履歴へそのまま書く（作品からの相対。`editHistoryFile` で作って渡す）。
 */
export async function rejectProposal(
  work: WorkEntry,
  proposalIdValue: string,
  file: string
): Promise<void> {
  const { who, decidedByLogin, editorLogin } = await decisionNames(work, proposalIdValue);
  await new ProposalStore(work).decide([
    {
      proposalId: proposalIdValue,
      time: new Date().toISOString(),
      decidedBy: who,
      ...(decidedByLogin ? { decidedByLogin } : {}),
      status: "rejected",
      note: "",
    },
  ]);
  await recordEdit(work, {
    actor: "author",
    action: editorLogin ? `編集者 ${editorLogin} の提案を見送った` : "編集者の提案を見送った",
    editorLogin,
    file,
    detail: "",
  });
  startReturnIfFinished(work);
}
