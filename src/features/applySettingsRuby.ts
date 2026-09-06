import * as vscode from "vscode";
import * as path from "../core/paths";
import { fromUri } from "../core/paths";
import type { WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import {
  decodeBytes,
  readTextFile,
  writeTextFilePreservingFormat,
} from "../core/textFile";
import {
  applyRubyInsertions,
  canRevertRuby,
  countByTerm,
  describeRubyResults,
  describeRubyTermTotals,
  planRubyInsertions,
  splitSingleCharTerms,
  type RubyFileResult,
  type RubyScope,
  type RubyTerm,
} from "../core/settingsRuby";
import { manualActor, recordEdit } from "../core/actorContext";
import { episodeTitle, formatChapterLabel } from "../core/episodeLabel";
import { openManuscriptTabUris } from "./manuscriptEditor";
import { logFailure, logStep } from "../core/logger";
import { withCancellableProgress } from "../views/progress";
import { cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 設定資料の読み仮名を、本文のルビとして振る（設計書6.12.5）。
 *
 * 作者の指示（2026-08-23）：「設定資料のパネルに『ルビを追加』という
 * ボタンを追加してください。すべてのページか、開いているページか、
 * 特定の話数だけかを選択できるようにしてください」。
 *
 * ## 本文を書き換える操作である
 *
 * 設定資料の画面から押すが、変わるのは**原稿のほう**である。だから
 * 原稿を守る手順をそのまま通す——読み込み時のハッシュを照合し、
 * 文字コードと改行を保って書き戻す（設計書5.4.1）。
 *
 * **振る前に、どこへ何件入るかを話ごとに見せる。** まとめて何十件も
 * 入る操作なので、押した結果を見てから決められるようにする。
 */

/** 対象の話を選ぶ */
async function pickScope(
  work: WorkEntry
): Promise<{ files: string[]; label: string } | undefined> {
  const scan = await scanWork(work);
  // **ルビは .md でしか使えない。** .txt を混ぜても振れないので、
  // 選ぶ段階から外す（選ばせてから断ると、二度手間になる）
  const markdown = scan.episodes.filter(
    (episode) => episode.ext.toLowerCase() === ".md"
  );

  if (markdown.length === 0) {
    const answer = await vscode.window.showWarningMessage(
      "ルビを振れる本文（.md）がありません。",
      {
        modal: true,
        detail:
          "ルビはMarkdown（.md）でしか使えません。\n" +
          "「本文を .md にする」で変換してから、もう一度お試しください。",
      },
      "本文を .md にする"
    );
    if (answer === "本文を .md にする") {
      // この作品の .txt を変える話をしている。引数無しだと作品選択へ戻す
      await vscode.commands.executeCommand("novelai.convertToMarkdown", {
        type: "work",
        work,
      });
    }
    return undefined;
  }

  // **押した時点でアクティブなのは設定資料パネルである。** このボタンは
  // パネルの中にあるので、`activeTextEditor` だけを見ると「いま開いている話」は
  // 一度も出ない（実機、2026-09-06）。開いているタブ全部から本文を探す
  const candidates = [
    vscode.window.activeTextEditor?.document.uri,
    ...openManuscriptTabUris(),
  ]
    .filter((uri): uri is vscode.Uri => uri !== undefined)
    .map((uri) => path.normalizeForComparison(fromUri(uri)));
  const openOne = candidates
    .map((candidate) =>
      markdown.find(
        (episode) =>
          path.normalizeForComparison(episode.filePath) === candidate
      )
    )
    .find((episode) => episode !== undefined);

  const items: Array<
    vscode.QuickPickItem & { choice?: "all" | "open" | "pick" }
  > = [
    {
      label: "$(book) すべての話",
      description: `${markdown.length}話`,
      detail: "この作品の本文（.md）すべてが対象です",
      choice: "all",
    },
  ];
  if (openOne) {
    items.push({
      label: "$(file) いま開いている話",
      description: path.basename(openOne.filePath),
      detail: openOne.filePath,
      choice: "open",
    });
  }
  items.push({
    label: "$(list-selection) 話を選ぶ",
    description: "複数選べます",
    detail: "話数の一覧から、振りたいものだけを選びます",
    choice: "pick",
  });

  const picked = await vscode.window.showQuickPick<
    vscode.QuickPickItem & { choice?: "all" | "open" | "pick" }
  >([...items, cancelItem()], {
    title: "どこにルビを振りますか",
    placeHolder: openOne
      ? undefined
      : "本文を開いていれば「いま開いている話」も選べます",
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked) || !picked.choice) return undefined;

  if (picked.choice === "all") {
    return {
      files: markdown.map((episode) => episode.filePath),
      label: `すべての話（${markdown.length}話）`,
    };
  }
  if (picked.choice === "open" && openOne) {
    return {
      files: [openOne.filePath],
      label: path.basename(openOne.filePath),
    };
  }

  const chosen = await vscode.window.showQuickPick(
    markdown.map((episode) => {
      const chapter = formatChapterLabel(episode);
      const title = episodeTitle(episode, chapter);
      return {
        label: [chapter, title].filter(Boolean).join(" ") || episode.fileName,
        description: episode.fileName,
        filePath: episode.filePath,
      };
    }),
    {
      canPickMany: true,
      title: "ルビを振る話を選んでください",
      placeHolder: "複数選べます",
      ignoreFocusOut: true,
    }
  );
  if (!chosen || chosen.length === 0) return undefined;
  return {
    files: chosen.map((item) => item.filePath),
    label: `選んだ${chosen.length}話`,
  };
}

/**
 * どこまで振るかを訊く。
 *
 * **既定は「各話の最初の1回だけ」。** 投稿作品でよくある形で、
 * 出てくるたびに振ると読みにくくなる。ただし作者の好みなので、
 * すべてに振る道も同じ画面に出す。
 */
async function confirm(
  results: readonly RubyFileResult[],
  terms: { usable: readonly RubyTerm[]; singleChar: readonly RubyTerm[] },
  scopeLabel: string
): Promise<boolean> {
  const total = results.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) {
    await vscode.window.showInformationMessage(
      "ルビを振るところが見つかりませんでした。",
      {
        modal: true,
        detail: [
          "設定資料に読み仮名のある名前が、本文に見つかりませんでした。",
          "",
          "・すでにルビが振ってあるところには、重ねて振りません",
          "・読み仮名の入っていないレコードは対象外です",
          ...(terms.singleChar.length > 0
            ? ["・1文字の語は、ほかの語の一部に当たるので対象外です"]
            : []),
        ].join("\n"),
      }
    );
    return false;
  }

  const byTerm = describeRubyTermTotals(results);
  const detail = [
    `読み仮名のある名前：${terms.usable.length}語`,
    "",
    describeRubyResults(results, (filePath) => path.basename(filePath)),
  ];
  // **何にルビが付くのかを、押す前に見せる。** 合計と話ごとの件数だけでは、
  // 思っていない語に当たっていることに気づけない（実機で「因」が
  // 「原因」に当たった、2026-09-06）
  if (byTerm) {
    detail.push("", "語ごとの件数", byTerm);
  }
  detail.push("", "すでにルビや傍点になっているところへは振りません。");
  if (terms.singleChar.length > 0) {
    detail.push(describeSingleCharTerms(terms.singleChar));
  }
  // **Ctrl+Z では戻らない。** 書き込みは「削除→作り直し」なので、
  // VS Codeの取り消し履歴に載らない（設計書6.12.5）
  detail.push(
    "元の本文は退避します。振ったあとの通知の「元に戻す」で戻せます。"
  );

  const answer = await vscode.window.showWarningMessage(
    `${scopeLabel}に、${total}件のルビを振りますか？`,
    { modal: true, detail: detail.join("\n") },
    "振る"
  );
  return answer === "振る";
}

/** 外した1文字の語を、確認画面に1行で出す（多いと読めないので5語まで） */
function describeSingleCharTerms(terms: readonly RubyTerm[]): string {
  const shown = terms.slice(0, 5).map((term) => term.text);
  const rest = terms.length > shown.length ? "、…" : "";
  return `1文字の語（${shown.join("、")}${rest}）は、ほかの語の一部に当たりやすいので対象外です。`;
}

/** どこまで振るかを先に訊く */
async function pickRubyScope(): Promise<RubyScope | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(list-ordered) 各話の最初の1回だけ",
        detail:
          "投稿作品でよくある形です。出てくるたびに振ると読みにくくなります",
        scope: "first" as const,
      },
      {
        label: "$(list-unordered) 出てくるところすべて",
        detail: "同じ名前に何度もルビが付きます",
        scope: "all" as const,
      },
      cancelItem(),
    ],
    {
      title: "同じ名前が何度も出てきたら",
      placeHolder: "あとから1件ずつ消すこともできます",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  return "scope" in picked ? picked.scope : undefined;
}

/**
 * 読み仮名のある名前を集める。
 *
 * **別名は含めない。** 別名に読み仮名の欄が無いので、正しい読みが分からない。
 */
export function collectRubyTerms(
  records: ReadonlyArray<{ name: string; reading: string | null }>
): RubyTerm[] {
  const byText = new Map<string, RubyTerm>();
  for (const record of records) {
    const text = record.name?.trim();
    const reading = record.reading?.trim();
    if (!text || !reading) continue;
    // 名前が読みと同じなら振る意味がない（ひらがなの名前など）
    if (text === reading) continue;
    if (!byText.has(text)) byText.set(text, { text, reading });
  }
  return [...byText.values()];
}

export async function applySettingsRuby(
  work: WorkEntry,
  terms: readonly RubyTerm[]
): Promise<boolean> {
  if (terms.length === 0) {
    await vscode.window.showInformationMessage(
      "読み仮名の入っている資料がありません。",
      {
        modal: true,
        detail:
          "人物・能力・場所などの「読み」を埋めてから、もう一度お試しください。",
      }
    );
    return false;
  }

  const target = await pickScope(work);
  if (!target) return false;

  const scope = await pickRubyScope();
  if (!scope) return false;

  // **1文字の語は、ここで外す。** 「因」が「原因」に当たるような当たり方を
  // するので、数える段階から対象にしない（設計書6.12.5）
  const { usable, singleChar } = splitSingleCharTerms(terms);

  // **どこへ何件入るかを、先に数える。** 本文はまだ書き換えない
  const results: RubyFileResult[] = [];
  for (const filePath of target.files) {
    try {
      const content = await readTextFile(filePath);
      const insertions = planRubyInsertions(content.text, usable, scope);
      results.push({
        filePath,
        count: insertions.length,
        byTerm: countByTerm(insertions),
      });
    } catch (error) {
      results.push({
        filePath,
        count: 0,
        skipped: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!(await confirm(results, { usable, singleChar }, target.label))) {
    return false;
  }

  return writeAll(work, results, usable, scope);
}

/**
 * 振ったあとの1話。**「元に戻す」に必要なものだけを控える。**
 *
 * `recoveryPath` は書き換える前の本文の退避先、`hashAfter` は振った直後の
 * 本文のハッシュ。戻す前に本文が変わっていないかを、これで確かめる。
 */
interface AppliedRuby {
  filePath: string;
  count: number;
  recoveryPath?: string;
  hashAfter?: string;
}

/**
 * 書き戻す。**1件失敗しても残りは進める。**
 *
 * **数えたときの本文を、そのまま書き戻さない。** 数えてから作者が確認する
 * までの間に、本文が変わっていることがある。古い本文を書き戻すと、
 * **その間の書き込みが消える。** 直前に読み直し、**そこから数え直して**
 * から入れる（設計書5.4.1）。件数が変わることはあるので、最後の報告には
 * 実際に入った数を出す。
 */
async function writeAll(
  work: WorkEntry,
  results: readonly RubyFileResult[],
  terms: readonly RubyTerm[],
  scope: RubyScope
): Promise<boolean> {
  const done: AppliedRuby[] = [];
  const failed: RubyFileResult[] = [];
  const targets = results.filter((entry) => entry.count > 0);

  await withCancellableProgress("ルビを振っています…", async (progress, token) => {
    let index = 0;
    for (const entry of targets) {
      if (token.isCancellationRequested) break;
      progress.report({
        message: `${path.basename(entry.filePath)}（${++index}/${targets.length}）`,
      });

      try {
        const current = await readTextFile(entry.filePath);
        const insertions = planRubyInsertions(current.text, terms, scope);
        if (insertions.length === 0) continue;

        const result = await writeTextFilePreservingFormat(
          entry.filePath,
          applyRubyInsertions(current.text, insertions),
          current,
          current.hash
        );
        if (result.ok) {
          // 戻すときのために、退避先と「振った直後の姿」を控える。
          // 読み直しに失敗しても振ったこと自体は成功なので、
          // hashAfter を欠いたまま記録する（その話は戻せない）
          let hashAfter: string | undefined;
          try {
            hashAfter = (await readTextFile(entry.filePath)).hash;
          } catch {
            hashAfter = undefined;
          }
          done.push({
            filePath: entry.filePath,
            count: insertions.length,
            recoveryPath: result.recoveryPath,
            hashAfter,
          });
          // **同期される編集履歴にも残す**（設計書5.6）。
          // 本文をまとめて書き換える操作なので、いつ誰が振ったかが
          // 残っていないと、あとから経緯をたどれない
          await recordEdit(work, {
            actor: manualActor(),
            action: "設定資料からルビを振った",
            file: path.basename(entry.filePath),
            detail: `${insertions.length}件（${
              scope === "first" ? "各話の最初の1回だけ" : "出てくるところすべて"
            }）`,
          });
        } else {
          failed.push({
            ...entry,
            skipped: describeFailure(result.reason),
          });
        }
      } catch (error) {
        failed.push({
          ...entry,
          skipped: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  const total = done.reduce((sum, entry) => sum + entry.count, 0);
  if (done.length > 0) {
    logStep(`設定資料からルビを振った: ${done.length}話・${total}件`);
  }

  if (failed.length > 0) {
    for (const entry of failed) {
      logFailure("設定資料からのルビ", {
        ファイル: path.basename(entry.filePath),
        詳細: entry.skipped ?? "（理由なし）",
      });
    }
    const answer = await vscode.window.showWarningMessage(
      `${done.length}話に${total}件のルビを振りました。${failed.length}話は振れませんでした。`,
      {
        modal: true,
        detail: describeRubyResults(failed, (filePath) =>
          path.basename(filePath)
        ),
      },
      // 振れた話だけでも戻せるようにする。ここで出さないと、
      // 一部が失敗した回だけ戻す手段が無くなる
      ...(done.length > 0 ? ["元に戻す"] : [])
    );
    if (answer === "元に戻す") await revertRubyApplication(work, done);
    return done.length > 0;
  }

  // **通知の答えを待たない。** ここで待つと、押されなかった場合に
  // 通知が消えるまで呼び出し元が止まる
  void vscode.window
    .showInformationMessage(
      `${done.length}話に、${total}件のルビを振りました。`,
      "元に戻す"
    )
    .then((answer) =>
      answer === "元に戻す" ? revertRubyApplication(work, done) : undefined
    );
  return done.length > 0;
}

/**
 * 振ったルビを、退避してある本文から書き戻す（設計書6.12.5）。
 *
 * **Ctrl+Z では戻せない。** `writeTextFilePreservingFormat` は
 * 「削除→作り直し」で書くので、VS Codeの取り消し履歴に載らない。
 * 退避（`.novelai-recovery` の `.bak`）は前からあったが、名前がハッシュなので
 * 作者には見つけられなかった（実機で判明、2026-09-06）。
 *
 * **振ったあとに書き足された話は戻さない。** 退避した本文で上書きすると、
 * その書き足しが消える。ハッシュで確かめて、違っていれば飛ばす。
 */
async function revertRubyApplication(
  work: WorkEntry,
  applied: readonly AppliedRuby[]
): Promise<void> {
  const reverted: AppliedRuby[] = [];
  const skipped: Array<{ filePath: string; reason: string }> = [];

  await withCancellableProgress("ルビを戻しています…", async (progress, token) => {
    let index = 0;
    for (const entry of applied) {
      if (token.isCancellationRequested) break;
      progress.report({
        message: `${path.basename(entry.filePath)}（${++index}/${applied.length}）`,
      });

      try {
        if (!entry.recoveryPath || !entry.hashAfter) {
          skipped.push({
            filePath: entry.filePath,
            reason: "退避した本文の場所が分かりません",
          });
          continue;
        }

        const current = await readTextFile(entry.filePath);
        if (!canRevertRuby({ hashAfter: entry.hashAfter }, current.hash)) {
          skipped.push({
            filePath: entry.filePath,
            reason: "振ったあとに本文が変わっています",
          });
          continue;
        }

        const bytes = await vscode.workspace.fs.readFile(
          path.toUri(entry.recoveryPath)
        );
        // 書き戻しも原稿を守る手順を通す。これでルビ入りの版も退避される
        const result = await writeTextFilePreservingFormat(
          entry.filePath,
          decodeBytes(bytes).text,
          current,
          current.hash
        );
        if (!result.ok) {
          skipped.push({
            filePath: entry.filePath,
            reason: describeFailure(result.reason),
          });
          continue;
        }

        reverted.push(entry);
        await recordEdit(work, {
          actor: manualActor(),
          action: "設定資料のルビを戻した",
          file: path.basename(entry.filePath),
          detail: `${entry.count}件`,
        });
      } catch (error) {
        skipped.push({
          filePath: entry.filePath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  if (reverted.length === 0 && skipped.length === 0) return; // 中止された

  const total = reverted.reduce((sum, entry) => sum + entry.count, 0);
  if (reverted.length > 0) {
    logStep(`設定資料のルビを戻した: ${reverted.length}話・${total}件`);
  }

  if (skipped.length > 0) {
    for (const entry of skipped) {
      logFailure("設定資料のルビを戻す", {
        ファイル: path.basename(entry.filePath),
        詳細: entry.reason,
      });
    }
    await vscode.window.showWarningMessage(
      `${reverted.length}話のルビを戻しました。${skipped.length}話は戻せませんでした。`,
      {
        modal: true,
        detail: skipped
          .map((entry) => `　${path.basename(entry.filePath)}：${entry.reason}`)
          .join("\n"),
      }
    );
    return;
  }

  void vscode.window.showInformationMessage(
    `${reverted.length}話のルビを戻しました。`
  );
}

function describeFailure(reason: string): string {
  switch (reason) {
    case "unsaved_changes":
      return "開いたまま保存していない変更があります";
    case "conflict_markers":
      return "競合の印（<<<<<<<）が残っています";
    case "modified_externally":
      return "数えたあとに、他の場所から変更されました";
    default:
      return "書き込めませんでした";
  }
}
