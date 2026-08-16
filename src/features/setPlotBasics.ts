import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import { parsePlotMarkdown, type PlotSections } from "../core/plotDoc";
import { plotPath, readPlotText, writePlotSections } from "../core/plotFile";
import {
  formatGenres,
  GENRE_SITES,
  listGenres,
  type GenreChoice,
} from "../core/genre";
import { cancelItem, isCancelItem } from "../views/dialogs";
import {
  suggestWorkFormat,
  WORK_FORMATS,
  type WorkFormatDef,
} from "../core/workFormat";

/**
 * プロットの「形式」と「ジャンル」を決める（設計書6.4.4）。
 *
 * 作者の要望。プロットは自由に書けるMarkdownなので**手で書いてもよい**。
 * それでも選択肢を用意するのは、**ジャンルが投稿先ごとに違う**ためである。
 * 「小説家になろう」は大ジャンル5つの下に21、「カクヨム」は並列に12。
 * 正しい名前を覚えている作者はいないし、覚える必要も無い。
 *
 * **書き込みは `updatePlotMarkdown` 経由。** 作者が書いた他の節や、
 * 自分で立てた見出しには触れない。
 */
export async function setPlotBasics(work: WorkEntry): Promise<void> {
  const current = parsePlotMarkdown(await readPlotText(work));

  const format = await pickFormat(work, current.sections);
  if (!format) return;

  const genres = await pickGenres();
  if (!genres) return;

  const updates: Partial<PlotSections> = { format: format.label };
  // ジャンルを決めないまま進むこともできる。**空で上書きしない。**
  // 決めなかったことを、既に書いてあるジャンルを消す指示と取らない
  if (genres.length > 0) updates.genre = formatGenres(genres);

  await writePlotSections(work, updates);

  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(await plotPath(work))
  );
  await vscode.window.showTextDocument(document);

  vscode.window.showInformationMessage(
    genres.length > 0
      ? `形式を「${format.label}」、ジャンルを${genres.length}件、プロットへ書きました。`
      : `形式を「${format.label}」としてプロットへ書きました。`
  );
}

/**
 * 形式を選ぶ。
 *
 * いまの分量から当てはまりそうなものを既定として挙げるが、**決めつけない。**
 * 短編集とSNS記事は字数から判らないので、勧めるのは連載ものだけになる。
 */
async function pickFormat(
  work: WorkEntry,
  sections: PlotSections
): Promise<WorkFormatDef | undefined> {
  const measured = await measure(work);
  const suggested = measured
    ? suggestWorkFormat(measured.chars, measured.episodes)
    : undefined;
  const written = sections.format.trim();

  const picked = await vscode.window.showQuickPick(
    WORK_FORMATS.map((format) => ({
      label: format.label,
      description:
        written === format.label
          ? "いまプロットに書かれています"
          : suggested?.key === format.key && measured
            ? `いまの分量の目安（${measured.episodes}話 / ${measured.chars.toLocaleString("ja-JP")}字）`
            : undefined,
      detail: format.description,
      format,
    })).concat([{ ...cancelItem(), format: undefined } as never]),
    {
      title: `「${work.title}」の形式`,
      placeHolder: "あとから変えられます",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  return picked.format;
}

/**
 * ジャンルを選ぶ。
 *
 * **投稿先を先に選ばせる。** 33件を1つの一覧に並べると、
 * 「恋愛」も「ホラー」も両サイトにあって見分けが付かない。
 *
 * 複数の投稿先へ出す作品もあるので、投稿先ごとに続けて選べるようにする。
 * 空のまま進むこともできる（決めていない段階でプロットは書ける）。
 */
async function pickGenres(): Promise<GenreChoice[] | undefined> {
  const chosen: GenreChoice[] = [];

  for (;;) {
    const site = await vscode.window.showQuickPick(
      [
        ...GENRE_SITES.map((site) => ({
          label: site.label,
          detail: `${listGenres(site).length}件から選びます`,
          site,
        })),
        {
          label: chosen.length > 0 ? "$(check) これで決定" : "$(circle-slash) ジャンルは決めない",
          detail:
            chosen.length > 0
              ? chosen.map((choice) => choice.genre).join("、")
              : "あとからプロットへ直接書けます",
          site: undefined,
        },
        // **形式の選択まで取りやめる出口。** 上の「これで決定」とは違う。
        // 決めたジャンルも、選んだ形式も書き込まずに閉じる
        { ...cancelItem("すべて取りやめる"), site: undefined },
      ],
      {
        title: "どこのジャンル体系で決めますか",
        placeHolder: "投稿先ごとに体系が違うため、出どころを添えて書きます",
        ignoreFocusOut: true,
      }
    );
    // 取り消し（Escまたは「すべて取りやめる」）は、全体の取り消しとして扱う
    if (!site || isCancelItem(site)) return undefined;
    if (!site.site) return chosen;

    const picked = await vscode.window.showQuickPick(
      listGenres(site.site).map((choice) => ({
        // 大ジャンルを持つ体系では、どちらの「異世界」かが分からないと選べない
        label: choice.group ? `${choice.group} > ${choice.genre}` : choice.genre,
        choice,
      })),
      {
        title: `${site.site.label}のジャンル`,
        placeHolder: "複数選べます",
        canPickMany: true,
        ignoreFocusOut: true,
      }
    );
    for (const item of picked ?? []) {
      const already = chosen.some(
        (choice) =>
          choice.site === item.choice.site && choice.genre === item.choice.genre
      );
      if (!already) chosen.push(item.choice);
    }
  }
}

/** いまの分量。読めなければ undefined（勧めないだけで、選択は続けられる） */
async function measure(
  work: WorkEntry
): Promise<{ chars: number; episodes: number } | undefined> {
  try {
    const scan = await scanWork(work);
    return {
      chars: scan.stats.totals.net,
      episodes: scan.episodes.length,
    };
  } catch {
    return undefined;
  }
}
