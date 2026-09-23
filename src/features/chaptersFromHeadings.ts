import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { ChapterStore, ChapterStoreError } from "../core/chapterStore";
import { episodePathFor } from "../core/bookStore";
import {
  describeEpisodeSections,
  planEpisodeSections,
  readEpisodeSections,
  type EpisodeHeadingSource,
} from "../core/collectedSections";
import { formatChapterLabel } from "../core/episodeLabel";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { readWorkFormat } from "../core/workFormatStore";
import type { Chapter, ChapterSet } from "../models/chapter";
import { logFailure, useLogFile } from "../core/logger";
import { confirmRun, notifyDone } from "../views/notify";
import { withProgress } from "../views/progress";

/**
 * 話の見出しから章を立てる（設計書6.66）。
 *
 * 作者の言葉（2026-09-23）：「章立ては各作品に反映させてください」。
 *
 * なろうの合本を話ごとに分けた作品では、**章の最初の話のファイルの頭に
 * `【第N章】` と章の題が残っている**（分割は中身に触らない）。たとえば
 * 作者の「教科書チート」は7つのファイルに第一章〜第七章の見出しがあるのに、
 * 章の台帳が無いので作品一覧には章が1つも出ていなかった。
 *
 * **台帳を書くだけで章が立つ。** 原稿のファイルの並びも中身も変えない
 * ——合本を分ける（案A、`splitCollectedFile.ts`）より作者にとって安全である。
 *
 * ## 守り（合本を分けるときと同じ）
 *
 * - **台帳が空のときだけ立てる。** 1つでも章があれば「既に章があります」と
 *   言って止まる（作者の章を上書きしない。実装ルール2）
 * - **押す前に一覧で見せる。** どの章がどの話から始まるかを確認画面に並べる
 * - 台帳の書き込みは `ChapterStore` を通す。確認のあいだに外で台帳が
 *   変わっていれば保存の照合が止める
 *
 * AIは呼ばない。
 *
 * @returns 台帳を書き換えたか（呼ぶ側が作品一覧を作り直すのに使う）
 */
export async function chaptersFromHeadings(work: WorkEntry): Promise<boolean> {
  const store = new ChapterStore(work);
  let set: ChapterSet;
  try {
    set = await store.load();
  } catch (error) {
    await report("章立ての読み込み", work, error);
    return false;
  }

  /*
    **台帳に章があれば、原稿を読む前に止める。** 読んでも立てないので、
    何百話ぶんを読む手間をかける意味が無い。
  */
  if (set.chapters.length > 0) {
    void vscode.window.showInformationMessage(
      `この作品には既に章が${set.chapters.length}個あります。` +
        "作者が付けた章を上書きしないため、話の見出しからは立てません。" +
        "章を付け直すときは、章を外してからもう一度お試しください。"
    );
    return false;
  }

  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    void vscode.window.showWarningMessage("本文ファイルが見つかりません。");
    return false;
  }
  const format = await readWorkFormat(work);

  const sources = await withProgress(
    "話の見出しを読んでいます…",
    async () => {
      const read: EpisodeHeadingSource[] = [];
      for (const episode of scan.episodes) {
        read.push({
          startEpisodePath: episodePathFor(work.folderPath, episode.filePath),
          label: formatChapterLabel(episode, format) || episode.fileName,
          text: await readOrNull(work, episode.filePath),
        });
      }
      return read;
    }
  );

  const reading = readEpisodeSections(sources);

  /*
    **合本の途中に見出しがあれば、1章も立てずに止める。**

    ここで合本の頭の章だけを立てると、台帳が空でなくなる。すると後で
    「合本を話ごとに分ける」を押しても、「既に章がある」として残りの章が
    立たない（案Aの守り）——作者が一番欲しい全部の章を、こちらが先回りして
    塞ぐことになる。分けるときに章はまとめて立つので、そちらへ案内する。
  */
  if (reading.insideCollected > 0) {
    void vscode.window.showInformationMessage(
      `合本の途中に章の見出しが${reading.insideCollected}個あります。` +
        "章はファイルからしか始められないため、ここでは立てません。" +
        "先に合本を右クリックして「合本を話ごとに分ける」を選んでください（分けるときに章も立ちます）。"
    );
    return false;
  }

  const plan = planEpisodeSections({
    sources,
    reading,
    existingChapters: set.chapters,
  });

  if (plan.kind !== "create") {
    // 台帳は空と確かめてあるので、ここに来るのは「見出しが1つも無い」とき
    void vscode.window.showInformationMessage(
      "話の頭に章の見出し（【第1章】のような行）が見つかりませんでした。" +
        "章は作品一覧の右クリック「ここから章を始める」で付けられます。"
    );
    return false;
  }

  const confirmed = await confirmRun(
    `話の見出しから、章を${plan.chapters.length}個立てます。`,
    "章を立てる",
    { detail: describeEpisodeSections(plan.sections, sources, reading) }
  );
  if (!confirmed) return false;

  const chapters: Chapter[] = [...plan.chapters];
  try {
    await store.save({ ...set, chapters });
  } catch (error) {
    await report("章立ての保存", work, error);
    return false;
  }

  // 済んだ記録も、この作品のログへ（直前に触った作品へ流さない。0.81.4）
  useLogFile(work.folderPath);
  notifyDone(
    `章を${chapters.length}個立てました（「${chapters[0].name}」` +
      `${chapters.length > 1 ? "ほか" : ""}）。`
  );
  return true;
}

/**
 * 1ファイルを読む。**読めなければ null**（その話だけ飛ばして続ける）。
 *
 * 1話読めないだけで全体を止めると、残りの章まで立たない。読めなかった
 * 数は確認画面に出す（`describeEpisodeSections`）。
 */
async function readOrNull(
  work: WorkEntry,
  filePath: string
): Promise<string | null> {
  try {
    return (await readTextFile(filePath)).text;
  } catch (error) {
    useLogFile(work.folderPath);
    logFailure("話の見出しから章を立てる：読めなかった", {
      ファイル: filePath,
      内容: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 失敗はログに残してから知らせる（原因にたどり着けるようにする） */
async function report(
  what: string,
  work: WorkEntry,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  // **記録の直前に書き先を向ける**（0.43.3 と同じ）
  useLogFile(work.folderPath);
  logFailure(what, {
    作品: work.title,
    種類: error instanceof ChapterStoreError ? error.kind : "unknown",
    内容: message,
  });
  await vscode.window.showErrorMessage(message);
}
