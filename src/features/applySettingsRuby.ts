import * as vscode from "vscode";
import * as path from "../core/paths";
import { fromUri } from "../core/paths";
import type { WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import {
  readTextFile,
  writeTextFilePreservingFormat,
} from "../core/textFile";
import {
  applyRubyInsertions,
  describeRubyResults,
  planRubyInsertions,
  type RubyFileResult,
  type RubyScope,
  type RubyTerm,
} from "../core/settingsRuby";
import { episodeTitle, formatChapterLabel } from "../core/episodeLabel";
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

  const active = vscode.window.activeTextEditor;
  const activePath = active ? fromUri(active.document.uri) : undefined;
  const openOne = markdown.find(
    (episode) =>
      activePath &&
      path.normalizeForComparison(episode.filePath) ===
        path.normalizeForComparison(activePath)
  );

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
      : "いま開いている話は、この作品の本文ではありません",
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
  termCount: number,
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
        ].join("\n"),
      }
    );
    return false;
  }

  const answer = await vscode.window.showWarningMessage(
    `${scopeLabel}に、${total}件のルビを振りますか？`,
    {
      modal: true,
      detail: [
        `読み仮名のある名前：${termCount}語`,
        "",
        describeRubyResults(results, (filePath) => path.basename(filePath)),
        "",
        "すでにルビや傍点になっているところへは振りません。",
        "取り消したくなったら、ファイルを開いて Ctrl+Z で戻せます。",
      ].join("\n"),
    },
    "振る"
  );
  return answer === "振る";
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

  // **どこへ何件入るかを、先に数える。** 本文はまだ書き換えない
  const results: RubyFileResult[] = [];
  for (const filePath of target.files) {
    try {
      const content = await readTextFile(filePath);
      results.push({
        filePath,
        count: planRubyInsertions(content.text, terms, scope).length,
      });
    } catch (error) {
      results.push({
        filePath,
        count: 0,
        skipped: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!(await confirm(results, terms.length, target.label))) return false;

  return writeAll(results, terms, scope);
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
  results: readonly RubyFileResult[],
  terms: readonly RubyTerm[],
  scope: RubyScope
): Promise<boolean> {
  const done: RubyFileResult[] = [];
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
          done.push({ filePath: entry.filePath, count: insertions.length });
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
    await vscode.window.showWarningMessage(
      `${done.length}話に${total}件のルビを振りました。${failed.length}話は振れませんでした。`,
      {
        modal: true,
        detail: describeRubyResults(failed, (filePath) =>
          path.basename(filePath)
        ),
      }
    );
    return done.length > 0;
  }

  void vscode.window.showInformationMessage(
    `${done.length}話に、${total}件のルビを振りました。`
  );
  return done.length > 0;
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
