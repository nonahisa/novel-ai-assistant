import * as vscode from "vscode";
import * as path from "../core/paths";
import { fromUri } from "../core/paths";
import type { WorkEntry } from "../models/types";
import { ProposalStore } from "../core/proposalStore";
import { isEditorMode, recordEdit } from "../core/actorContext";
import { editHistoryFile } from "../core/editHistoryFormat";
import { tryGitUserName } from "../core/gitAttribution";
import { readTextFile } from "../core/textFile";
import { normalizeFile } from "../models/fileLock";
import {
  HAND_EDIT_CATEGORY,
  HAND_MEMO_CATEGORY,
  buildHandProposal,
  handProposalTarget,
  locateProposal,
} from "../models/proposal";
import { notifyDone } from "../views/notify";
import { askText } from "../views/dialogs";
import { useLogFile } from "../core/logger";

/**
 * 編集部が自分の言葉で直しを書き、提案として置く（設計書5.6.1.1。作者の指示
 * 2026-11-01「作る」）。
 *
 * 編集部役の実機確認で、「校閲開始」まで進んだあと**どうやって校閲するのか
 * 分からず止まった**。提案を作る道が検知の［適用］しかなく、編集部が読んで
 * 気づいたことを書く場所が無かったためである。
 *
 * - **本文は書き換えない。** 置き場は検知の［適用］と同じ提案の台帳
 *   （`ProposalStore`）。作者は提案パネルで採る／見送るだけ
 * - **校閲中の範囲の外でも置ける。** 検知の［適用］（`proposeIssue`）も範囲を
 *   見ずに置くので、それに揃える。本文に書かないので、作者の書きかけと
 *   ぶつからない
 * - 選んだ所が置く直前のファイルにあるかを確かめる（`locateProposal`。採る側と
 *   同じ照らし方）。保存していない変更があると、作者へ届く原稿と合わない
 */

/** 何を置くか。`edit` は「直しを提案する」、`memo` は編集者モードの「ここにメモを足す」 */
export type HandProposalKind = "edit" | "memo";

/**
 * 選ばずに押したときの案内。**詳細メニューから押した人に、右クリックの道も教える**
 * （作者の決定 2026-11-01）。メニューは本文の外にあるので、押す前に本文で選んでおく必要がある
 */
export const PICK_FIRST_MESSAGE =
  "修正したい所を本文で選んでから押してください（右クリックからも出せます）。";

/** コマンドから押されたときに要るもの。試験で差し替えるため外から渡す */
export interface ProposeEditCommandDeps {
  /** 前面の原稿エディターへ「いまの選択で頼んで」と送る。前面に無ければ false */
  askManuscript: () => boolean;
  /** 素のエディター（いちばん最近前に出ていたもの） */
  activeEditor: () =>
    | { document: vscode.TextDocument; selection: vscode.Range }
    | undefined;
  /** 選んだ所で手書きの提案へ進む（作品を引くのは呼ぶ側） */
  propose: (document: vscode.TextDocument, range: vscode.Range) => Promise<void>;
}

export type ProposeEditCommandOutcome =
  | "notEditor"
  | "manuscript"
  | "noSelection"
  | "proposed";

/**
 * コマンド「直しを提案する」の受け口（詳細メニュー・コマンドパレット。設計書5.6.1.1）。
 *
 * - **作者モードでは押せない理由を出す**（編集部連携のほかの項目と同じく、メニューには
 *   出したまま押したときに言う。`finishReviewAndReturn` と同じ形）。本文が開いていない
 *   ときに選び方の案内が先に出ると、モードの違いが伝わらない
 * - **前面の原稿エディターを先に見る。** 選んでいる所は画面の中にしか無いので、画面へ
 *   頼み返す（傍点のキーと同じ形）。選んでいなければ画面が空の範囲を返し、
 *   `proposeByHand` が同じ案内を出す
 * - 無ければ素のエディターの選択を使う。選んでいなければ案内だけ出す
 */
export async function proposeEditFromCommand(
  deps: ProposeEditCommandDeps
): Promise<ProposeEditCommandOutcome> {
  if (!isEditorMode()) {
    void vscode.window.showInformationMessage(
      "「修正を提案する」は、編集者モードで使う操作です。作者の環境では本文をそのまま直せます。"
    );
    return "notEditor";
  }
  if (deps.askManuscript()) return "manuscript";
  const editor = deps.activeEditor();
  const { start, end } = editor?.selection ?? {};
  if (
    !editor ||
    !start ||
    !end ||
    (start.line === end.line && start.character === end.character)
  ) {
    void vscode.window.showInformationMessage(PICK_FIRST_MESSAGE);
    return "noSelection";
  }
  await deps.propose(editor.document, editor.selection);
  return "proposed";
}

/** 選んだ所の、画面に出す短い引用（長い文は頭だけ） */
function quote(text: string): string {
  return text.length > 20 ? `${text.slice(0, 20)}…` : text;
}

/**
 * 選んだ所を対象に、手書きの提案を置く。置けたら true。
 *
 * @param range 選んだ範囲。空なら（メモのとき）その行ぜんたいを指す
 */
export async function proposeByHand(
  work: WorkEntry,
  document: vscode.TextDocument,
  range: vscode.Range,
  kind: HandProposalKind
): Promise<boolean> {
  // **作者は本文をそのまま直せる。** 作者の提案は誰も受け取らないので置かない
  if (!isEditorMode()) {
    void vscode.window.showInformationMessage(
      "修正を提案として置くのは、編集者モードの操作です。作者の環境では本文をそのまま直せます。"
    );
    return false;
  }

  const filePath = fromUri(document.uri);
  if (!path.isPathInside(work.folderPath, filePath)) {
    void vscode.window.showWarningMessage("この作品のファイルではありません。");
    return false;
  }
  // 行を丸ごと選ぶ（3回押し）と、終わりが次の行の頭になる。その行の中の選択として読む
  if (range.end.line === range.start.line + 1 && range.end.character === 0) {
    const lineEnd = document.lineAt(range.start.line).text.length;
    range = new vscode.Range(
      range.start,
      new vscode.Position(range.start.line, lineEnd)
    );
  }
  // 提案は1行の中の置き換えで表す（採る側の `acceptProposal` も1行で照らす）
  if (range.start.line !== range.end.line) {
    void vscode.window.showWarningMessage(
      "提案は1行の中で選んでください（行をまたいだ選択は置けません）。"
    );
    return false;
  }
  const empty = range.start.character === range.end.character;
  if (kind === "edit" && empty) {
    // 詳細メニューから押して原稿エディターが選んでいない所を返したときも、ここへ来る
    void vscode.window.showWarningMessage(PICK_FIRST_MESSAGE);
    return false;
  }

  const line = range.start.line + 1;
  const picked = handProposalTarget(
    document.lineAt(range.start.line).text,
    range.start.character,
    range.end.character
  );
  if (!picked.ok) {
    void vscode.window.showWarningMessage(picked.reason);
    return false;
  }

  const answers = await askHandProposal(kind, picked.target);
  if (!answers) return false;

  const relative = normalizeFile(path.relative(work.folderPath, filePath));
  const built = buildHandProposal({
    file: relative,
    line,
    original: picked.original,
    target: picked.target,
    suggestion: answers.suggestion,
    reason: answers.reason,
    proposer: (await tryGitUserName(work.folderPath)) ?? "",
    time: new Date().toISOString(),
    category: kind === "memo" ? HAND_MEMO_CATEGORY : HAND_EDIT_CATEGORY,
  });
  if (!built.ok) {
    void vscode.window.showWarningMessage(built.reason);
    return false;
  }
  const proposal = built.proposal;

  /*
    **置く直前に、ファイルの本文と照らす**（実装ルール3。既存の提案と同じ照らし方）。
    画面の文書には保存していない変更が乗っていることがある。作者へ届くのは
    ファイルのほうなので、そこで選んだ所を指していなければ置かない
  */
  let saved;
  try {
    saved = await readTextFile(filePath);
  } catch {
    void vscode.window.showWarningMessage("本文を読み込めませんでした。");
    return false;
  }
  const located = locateProposal(saved.text, proposal);
  // 選んでいないときは行ぜんたいを指すので、行の頭に当たれば合っている
  const expectedAt = empty ? 0 : range.start.character;
  if (located.kind !== "found" || located.at !== expectedAt) {
    void vscode.window.showWarningMessage(
      "選んだ所が、保存されている本文と合いません。保存してから、もう一度選んでください。"
    );
    return false;
  }

  try {
    await new ProposalStore(work).propose([proposal]);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `提案を書き出せませんでした: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }

  await recordEdit(work, {
    actor: "editor",
    action: kind === "memo" ? "メモを提案として置いた" : "修正を提案した",
    // 名前だけにしない（ほかの章の同じ名前の話と取り違える。0.130.4）
    file: editHistoryFile(work.folderPath, filePath),
    detail: proposal.suggestion
      ? `${line}行 「${proposal.target}」→「${proposal.suggestion}」`
      : `${line}行 「${quote(proposal.target)}」への意見`,
  });
  // 済んだ記録は、この作品のログへ（直前に触った作品へ流さない。0.81.4）
  useLogFile(work.folderPath);
  notifyDone(
    `${path.basename(filePath)} ${line}行目に提案を置きました。「校閲を終えて返す」で作者へ届きます。`
  );
  return true;
}

/**
 * 直した案と理由（メモのときは意見だけ）を訊く。取りやめたら undefined。
 *
 * **直した案の欄には、選んだ所をそのまま入れておく。** 1字直すために全部を
 * 打ち直さずに済む。手を入れずに進めたら、直していない＝意見だけとして扱う
 * （`buildHandProposal`）。
 */
async function askHandProposal(
  kind: HandProposalKind,
  target: string
): Promise<{ suggestion: string; reason: string } | undefined> {
  if (kind === "memo") {
    const memo = await askText({
      title: "ここにメモを足す（編集者モード：本文には書かず、作者への提案として置きます）",
      prompt: `「${quote(target)}」の行への意見・気づいたこと`,
      validateInput: (value) =>
        value.trim() === "" ? "作者へ伝えることを書いてください。" : undefined,
    });
    if (memo === undefined) return undefined;
    return { suggestion: "", reason: memo };
  }

  const suggestion = await askText({
    title: "修正を提案する（1/2）：修正案",
    prompt: `「${quote(target)}」をどう直すか。空にすると、意見だけを送ります`,
    value: target,
  });
  if (suggestion === undefined) return undefined;
  const opinionOnly = suggestion === "" || suggestion === target;
  const reason = await askText({
    title: "修正を提案する（2/2）：理由・意見",
    prompt: opinionOnly
      ? "作者へ伝える意見をひと言（修正案が無いので、こちらは必ず書いてください）"
      : "直す理由をひと言（空でも送れます）",
    validateInput: (value) =>
      opinionOnly && value.trim() === ""
        ? "修正案が無いときは、意見を書いてください。"
        : undefined,
  });
  if (reason === undefined) return undefined;
  return { suggestion, reason };
}
