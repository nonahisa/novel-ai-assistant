import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import {
  resolveOutputLimitForSend,
  resolveOutputTokensForPlanning,
  truncatedOutputAdvice,
} from "../ai/outputLimit";
import { confirmProviderReachable } from "./aiConnectivity";
import { withCancellableProgress } from "../views/progress";
import {
  buildDictationCleanPrompt,
  DICTATION_CLEAN_SCHEMA,
  DICTATION_CLEAN_SYSTEM_PROMPT,
  DICTATION_CLEAN_VERSION,
  DICTATION_MIN_CHARS,
} from "../prompts/dictationClean";
import {
  DICTATION_NOTES_SHOWN,
  parseDictationCleanResult,
  validateDictationClean,
} from "../core/dictationCleanValidation";
import {
  buildStyleNote,
  collectWorkStyle,
  readNarrativePerson,
} from "../core/workStyle";
import { fromLfText, toLf } from "../core/eolSpace";
import { manualActor, recordEdit } from "../core/actorContext";
import * as path from "../core/paths";
import { fromUri } from "../core/paths";
import { KeepWordStore } from "../core/keepWordStore";
import { blankMemoLines } from "../core/sceneMemo";
import { reportAIError } from "./reportAIError";
import {
  logFailure,
  logStep,
  responseExcerptForLog,
  useLogFile,
} from "../core/logger";
import { confirmRun, notifyDone, warnWithLog } from "../views/notify";

/**
 * 口述筆記の整文（P-35、設計書6.83）。
 *
 * **拡張機能はマイクに触らない。** 声を文字にするのはOSの音声入力
 * （Windows は Win+H、macOS は fn キー2回）で、ここが受け持つのは
 * **入り終わった文字列を本文の形へ整えること**だけである。
 *
 * ## 入口は2つ、実体は1つ
 *
 * ①原稿エディタの「口述 → 整える」（開始位置からカーソルまで）と
 * ②詳細メニューの「口述で入れた文を整える」（選択範囲）。
 * どちらもここを通す——片方だけに確認やハッシュ照合が入っている、
 * という状態を作らない。
 *
 * ## 本文の書き換え方
 *
 * **`WorkspaceEdit` で文書の範囲を置き換える**（ファイルへ直に書かない）。
 * こうしておくと `Ctrl+Z` で戻せるし、保存するのはこれまでどおりVS Codeで
 * ある。原稿エディタの `queueEdit` と同じ流儀。
 *
 * 置き換える直前に、**送った時点の本文と同じかを照合する**（AIの応答には
 * 数十秒かかり、その間に打てる）。違えば触らない。
 *
 * ## 実行の札は取らない（設計書6.76）
 *
 * AIを呼ぶのは1回だけで、しかも**作者が話し終えた直後に押す**操作である。
 * 誤字脱字の10分の裏で押したときに「『誤字脱字の検知』の完了を待って
 * います…」で止まる作りは、口述の道具として使えない。冒頭診断・単話
 * プロットと同じ扱いで、リクエストの関所だけを通して合間へ滑り込む。
 */

export interface DictationCleanRequest {
  readonly document: vscode.TextDocument;
  /** 整える範囲（原稿エディタは開始位置〜カーソル、通常のエディタは選択） */
  readonly range: vscode.Range;
  /**
   * その本文が属する作品。**分からなくても動く**——作品の作法
   * （一人称・文語体・直さない語）が渡らないだけで、整文そのものはできる。
   */
  readonly work?: WorkEntry;
  /**
   * どちらの入口から来たか。**変わるのは「元に戻す」ボタンの有無だけ**
   * （本体の裁定、2026-09-06）。
   *
   * 原稿エディタはWebViewのパネルなので、通知のボタンを押した時点で
   * **アクティブなテキストエディタが無く、`undo` コマンドが効かない。**
   * 押しても何も起きないボタンを置くくらいなら、「Ctrl+Z で戻せます」と
   * 書いておくほうが作者は迷わない。
   */
  readonly entry: "editor" | "manuscriptEditor";
}

export async function runDictationClean(
  request: DictationCleanRequest,
  registry: AIRegistry
): Promise<void> {
  const { document, range, work, entry } = request;
  if (work) useLogFile(work.folderPath);

  // **本文はLF空間で持ち回る**（`core/eolSpace.ts`）。CRLFの原稿では、
  // 改行1つにつき1字ぶん長さがずれる——長さの比で「要約された・書き足された」
  // を判定しているので、揃えずに送ると原稿の改行の数だけ判定が甘くなる
  const original = toLf(document.getText(range));
  // **短すぎるものはAIを呼ばない**（有料AIなら課金だけが起きる）。
  // 境目はプロンプト側の定数で持つ（入口が2つあるので、写しを作らない）
  if (original.trim().length < DICTATION_MIN_CHARS) {
    notifyDone("整える範囲がありません");
    return;
  }

  // 整文は「文の直し」なので、機能別AI割当は推敲（`proofread`）を借りる。
  // **新しい割当のキーは増やさない**——8つの単位は作者が使い分けたい単位で、
  // 増やすほど「どれを設定すればよいのか」が分からなくなる
  const resolved = await ensureConfigured(registry, "proofread");
  if (!resolved) return;

  // **繋がるかを、費用の確認より先に確かめる**（設計書6.51）。
  // モデル名を渡すのは、LM Studioをこの場から起こしたときの読み込みに要るため
  if (
    !(await confirmProviderReachable(resolved.provider, "口述の整文", resolved.model))
  ) {
    return;
  }

  const costNotice = resolved.provider.isPaid
    ? `\n${resolved.provider.displayName} は呼び出すたびに課金されます。`
    : "";
  // **確認は置き換える前に1回だけ。** 整えた結果をもう一度確認させると、
  // 話し終えるたびに2回押すことになる（口述はまとめて何度も行う操作である）
  const confirmed = await confirmRun(
    `口述で入れた${original.length}字を整えます（AIの呼び出しは1回）。\n` +
      `モデル: ${resolved.model}${costNotice}\n` +
      "整えたあとは Ctrl+Z で元に戻せます。"
  );
  if (!confirmed) return;

  const styleNote = await loadStyleNote(work, document.getText());

  const plannedOutputTokens = resolveOutputTokensForPlanning(
    resolved.provider.id,
    resolved.model
  );
  // **場所の確保（上）と、実際に送る上限（下）は別物である**（設計書6.77）。
  // 整文は入力とほぼ同じ長さを返すので、切り詰められると本文が途中で終わる
  const outputLimit = resolveOutputLimitForSend(
    resolved.provider.id,
    resolved.model
  );

  let response: { text: string; truncated?: boolean } | undefined;
  await withCancellableProgress(
    "口述で入れた文を整えています",
    async (_progress, token) => {
      // 中止ボタンをAIまで届かせる。受け取らないと、押しても何も起きない
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      try {
        logStep(
          `口述の整文を開始: ${original.length}字 / ` +
            `${resolved.provider.displayName} / ${resolved.model} / ` +
            `v${DICTATION_CLEAN_VERSION}`
        );
        response = await resolved.provider.generate({
          systemPrompt: DICTATION_CLEAN_SYSTEM_PROMPT,
          userPrompt: buildDictationCleanPrompt({
            dictatedText: original,
            styleNote,
          }),
          model: resolved.model,
          // **揺らさない。** 作者の言葉をそのまま返すのが仕事で、
          // 言い回しの多様さは邪魔にしかならない
          temperature: 0,
          maxOutputTokens: outputLimit.tokens,
          plannedOutputTokens,
          jsonSchema: DICTATION_CLEAN_SCHEMA as unknown as object,
          disableThinking: true,
          signal: controller.signal,
          meta: { feature: "dictationClean", workFolder: work?.folderPath },
        });
      } catch (error) {
        reportAIError("口述の整文", error);
      }
    }
  );
  if (!response) return;

  const parsed = parseDictationCleanResult(response.text);
  if (!parsed) {
    const truncated = response.truncated === true;
    logFailure("口述の整文", {
      理由: truncated
        ? "応答が出力上限で切り詰められました"
        : "応答を読み取れません",
      応答: responseExcerptForLog(response.text),
    });
    // **切り詰めは、切り詰めとして伝える**（設計書6.77）。文言は自前で
    // 書かない——上限が実測から来ているのに「設定を大きくして」と言うと、
    // 作者は直らない操作を繰り返すことになる
    void warnWithLog(
      truncated
        ? truncatedOutputAdvice(outputLimit)
        : "整えた本文を読み取れませんでした。本文は書き換えていません。"
    );
    return;
  }

  // **AIの出力を信用しない**（`core/dictationCleanValidation.ts`）。
  // 整文は結果をそのまま本文へ入れる数少ない機能なので、ここで止める
  const checked = validateDictationClean(original, parsed);
  if (!checked.ok) {
    logFailure("口述の整文", {
      理由: checked.reason,
      応答: responseExcerptForLog(parsed.text),
    });
    void warnWithLog(`${checked.reason}本文は書き換えていません。`);
    return;
  }

  const applied = await applyDictationText({
    document,
    range,
    sentText: original,
    cleanedText: checked.text,
  });
  if (!applied) return;

  // **同期される編集履歴に残す**（設計書5.6、実機確認 A-19）。本文をその場で
  // 書き換える経路のうち、ここだけが履歴も退避も通っていなかった。退避は
  // 要らない——文書は開いたままなので VS Code の取り消し（Ctrl+Z）が効き、
  // 保存前ならファイルは変わっていない。だが「誰がいつ書き換えたか」は
  // 残らないと、あとから経緯をたどれない
  if (work) {
    await recordEdit(work, {
      actor: manualActor(),
      action: "口述筆記の整文を反映した",
      file: path.basename(fromUri(document.uri)),
      detail: `${original.length}字 → ${checked.text.length}字`,
    });
  }

  await announceApplied(
    original.length,
    checked.text.length,
    checked.notes,
    entry,
    document.uri
  );
}

/**
 * 整えた本文を、文書の範囲へ置き換える。
 *
 * **送った時点の本文と同じかを照合してから置き換える。** AIの応答には
 * 数十秒かかり、その間に作者が打っていることがある（口述モードは
 * 話しながら打てる）。違っていたら**触らない**——ずれた範囲を
 * 置き換えると、口述していない部分まで巻き込む。
 *
 * **照合も書き込みもLF空間を基準にする**（`core/eolSpace.ts`）。整えた本文は
 * LFしか持たないので、CRLFの原稿へそのまま入れると**その範囲だけ改行が
 * `\n` 単独になる**（実装ルール1「改行コードを保持して書き戻す」に反する）。
 *
 * 置き換えたら true。断ったとき・書き込めなかったときは false。
 */
export async function applyDictationText(input: {
  document: vscode.TextDocument;
  range: vscode.Range;
  /** AIへ送った時点の、その範囲の本文（LF空間） */
  sentText: string;
  /** 整えた本文（LF空間。書き戻すときに文書の改行コードへ直す） */
  cleanedText: string;
}): Promise<boolean> {
  const now = toLf(input.document.getText(input.range));
  if (now !== input.sentText) {
    void vscode.window.showWarningMessage(
      "本文が変わったので置き換えません。" +
        "整えている間に、その範囲が書き換わりました。"
    );
    return false;
  }

  const change = new vscode.WorkspaceEdit();
  change.replace(
    input.document.uri,
    input.range,
    // 原稿エディタの `applyEdit` と同じ扱い（`computeDocumentEdit`）。
    // **新しく作る改行は文書の宣言に従う**——既にある行には触らない
    fromLfText(
      input.cleanedText,
      input.document.eol === vscode.EndOfLine.CRLF
    )
  );
  // **入れられたかを確かめる。** 照合を通っても書き込みそのものは失敗しうる
  // （文書が閉じられた・読み取り専用）。見ないまま完了を告げると、
  // 作者には「整えたのに何も変わらない」としか見えない
  if (!(await vscode.workspace.applyEdit(change))) {
    void vscode.window.showWarningMessage(
      "整えた本文を入れられませんでした。もう一度お試しください。"
    );
    return false;
  }
  return true;
}

/**
 * 何をしたかを知らせる。
 *
 * **件数を伴う知らせなので、消える表示にしない**（`views/notify.ts` の3）。
 * 気に入らなかったときの出口を、通知の中に置く——整文は**本文をその場で
 * 書き換える**数少ない機能である。
 *
 * **出口の形は入口で変える**（本体の裁定、2026-09-06）。普通のエディタから
 * なら `undo` コマンドが効くのでボタンを出し、原稿エディタからは効かない
 * （WebViewのパネルにはアクティブなテキストエディタが無い）ので、
 * 押し方を文で書く。**押しても何も起きないボタンを作らない。**
 */
async function announceApplied(
  before: number,
  after: number,
  notes: readonly string[],
  entry: "editor" | "manuscriptEditor",
  /** 整えた文書。**`undo` を撃つ前に、いま開いているものと突き合わせる** */
  target: vscode.Uri
): Promise<void> {
  const shown = notes.slice(0, DICTATION_NOTES_SHOWN);
  const detail = shown.length > 0 ? `\n直した点：${shown.join(" / ")}` : "";
  const headline = `口述を整えました（${before}字→${after}字）。`;

  if (entry === "manuscriptEditor") {
    void vscode.window.showInformationMessage(
      `${headline}Ctrl+Z で元に戻せます。${detail}`
    );
    return;
  }

  const answer = await vscode.window.showInformationMessage(
    `${headline}${detail}`,
    "元に戻す"
  );
  if (answer !== "元に戻す") return;

  // **`undo` は「いま開いている文書」に効く。** この通知は消えないので、
  // 押すまでに別のファイルへ移っていることがある——確かめずに撃つと、
  // 整えた原稿ではなく**別の文書の編集が1つ戻る**（0.37.5で気づいた）
  const active = vscode.window.activeTextEditor?.document.uri;
  if (!active || active.toString() !== target.toString()) {
    void vscode.window.showWarningMessage(
      "いま開いているのは別の文書なので、元に戻しませんでした。" +
        "元の文書を開いて Ctrl+Z を押してください。"
    );
    return;
  }
  await vscode.commands.executeCommand("undo");
}

/**
 * 作品の作法（一人称・文語体・直さない語）を読む。
 *
 * **誤字脱字・推敲と同じものを渡す**（設計書6.8.14）。作品が分からない
 * ときは空文字——「登録されていません」と書いて送るのは、送信量を
 * 増やすだけで何も伝えていない。
 *
 * 一人称の判定に使う本文は**開いている原稿だけ**にする。作品ぜんたいを
 * 読み直すほどの精度は要らず、口述のたびに全話を走査すると待たされる。
 */
async function loadStyleNote(
  work: WorkEntry | undefined,
  bodyText: string
): Promise<string> {
  if (!work) return "";
  try {
    const keepWords = await new KeepWordStore(work).loadWords();
    return buildStyleNote(
      collectWorkStyle({
        // シーンメモ（行頭が `//`）は本文ではないので落とす
        bodyText: blankMemoLines(bodyText),
        narrativePerson: await readNarrativePerson(work),
        keepWords: keepWords.map((entry) => entry.word),
      })
    );
  } catch {
    // 作法が読めなくても整文はできる。ここで止めるほうが害が大きい
    return "";
  }
}
