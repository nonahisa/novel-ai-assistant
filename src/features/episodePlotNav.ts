import * as vscode from "vscode";
import * as paths from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import {
  EPISODE_PLOTS_DIR,
  episodePlotChapterFromFileName,
  episodePlotFileName,
} from "../core/resumeSheet";
import { episodePlotChapterOfPath } from "../core/episodePlotDoc";
import {
  chapterAtManuscriptLine,
  episodePlotOrder,
  neighborEpisodeChapter,
} from "../core/episodePlotOrder";
import { episodePlotChapterOf } from "../core/plotMode";
import { parseEpisodeFileName } from "../core/episodeParser";
import { pathExists } from "../core/fileSystem";
import { createForeshadowStore } from "../core/foreshadowStore";
import {
  describeForeshadowNotice,
  foreshadowNoticeForChapter,
} from "../core/foreshadowPlan";
import { logFailure, useLogFile } from "../core/logger";
import { openInDefaultEditor } from "../views/openDocument";
import { createEpisodePlot } from "./resumeWriting";

/**
 * 単話プロットへの行き来（設計書6.36・6.25。作者の依頼、2026-09-23
 * 「プロットモードと単話プロットをうまくつないでくださいね。あとエディターから
 * 単話プロット参照したいです」）。
 *
 * - **C**：単話プロットを開いているとき、前後の話の単話プロットへ移る
 *   （書いた話と予定の話を合わせた話数順。`core/episodePlotOrder.ts`）
 * - **E**：原稿エディタから、その話の単話プロットを右の列に開く。原稿で
 *   別の話へ移ったら、右に開いている単話プロットもその話のものへ切り替える
 * - **F-3**：開いたときに、その話で張った・回収予定の未回収の伏線を知らせる
 *
 * **単話プロットのファイルへは書き込まない。** 無い話で作るときは既存の
 * `createEpisodePlot`（新規作成だけ、6.36.2）を通る。伏線の知らせは画面の
 * 通知で出し、ファイルの中身には混ぜない（作者の文書に機械が書き足さない）。
 */

/** その作品の単話プロットの置き場 */
export async function episodePlotsDirOf(work: WorkEntry): Promise<string> {
  const config = await readWorkConfig(work);
  return paths.join(workPaths(work, config).settings, EPISODE_PLOTS_DIR);
}

/** 置き場にある単話プロットの話数（予定の話を含む）。置き場が無ければ空 */
export async function listEpisodePlotChapters(directory: string): Promise<number[]> {
  let entries: Array<[string, vscode.FileType]>;
  try {
    entries = await vscode.workspace.fs.readDirectory(paths.toUri(directory));
  } catch {
    return [];
  }
  const found = new Set<number>();
  for (const [name] of entries) {
    const chapter = episodePlotChapterFromFileName(name);
    if (chapter !== null) found.add(chapter);
  }
  return [...found].sort((left, right) => left - right);
}

/**
 * その話で張った・回収予定の、未回収の伏線を知らせる（設計書6.35）。
 *
 * **知らせ（通知）にした。** QuickPick の説明に添えると、開くたびに
 * 選ぶ画面を1枚挟むことになり、行き来する手が止まる。通知なら黙って
 * 消えるので、書いているあいだの邪魔にならない。何も無ければ出さない。
 * 読めなくても開くことは止めない（記録だけ残す）。
 */
export async function noticeForeshadowsFor(
  work: WorkEntry,
  chapter: number
): Promise<void> {
  let records;
  try {
    records = (await createForeshadowStore(work).loadAll()).records;
  } catch (error) {
    useLogFile(work.folderPath);
    logFailure("単話プロットの伏線の知らせ", {
      作品: work.title,
      内容: messageOf(error),
    });
    return;
  }
  const text = describeForeshadowNotice(
    `第${chapter}話`,
    foreshadowNoticeForChapter(records, chapter)
  );
  if (!text) return;
  const open = "伏線の一覧を開く";
  const picked = await vscode.window.showInformationMessage(text, open);
  if (picked === open) {
    await vscode.commands.executeCommand("novelai.openForeshadows", {
      type: "work",
      work,
    });
  }
}

/**
 * その話の単話プロットを開く。**無ければ作るか訊く**（作るのは
 * `createEpisodePlot` の1本。新規作成だけ）。
 *
 * 開き方は作者の割り当てに任せる（`openInDefaultEditor`、設計書6.17.6）。
 * `.md` を割り当てていなければ普通のテキストエディタで開き、そこで書き足せる。
 *
 * @returns 開いたか（取りやめたら false）
 */
export async function openOrCreateEpisodePlot(
  work: WorkEntry,
  chapter: number,
  showOptions: vscode.TextDocumentShowOptions
): Promise<boolean> {
  const filePath = paths.join(
    await episodePlotsDirOf(work),
    episodePlotFileName(chapter)
  );
  if (await pathExists(filePath)) {
    await openInDefaultEditor(filePath, showOptions);
    return true;
  }
  const create = "作る";
  const picked = await vscode.window.showInformationMessage(
    `第${chapter}話の単話プロットはまだありません。作りますか？`,
    {
      modal: true,
      detail: "視点・目標・展開の雛形を作って開きます（AIは書きません）。",
    },
    create
  );
  if (picked !== create) return false;
  await createEpisodePlot(work, chapter, showOptions);
  return true;
}

/**
 * 単話プロットを開いているとき、前後の話の単話プロットへ移る（C）。
 *
 * **前後は書いた話と予定の話を合わせた話数順**（本文の無い予定の話も通る）。
 * 開くのは**いま単話プロットを開いている列**——列を変えると、原稿の横で
 * 見比べていた並びが崩れる。
 */
export async function openNeighborEpisodePlot(
  work: WorkEntry,
  episodes: readonly EpisodeFile[],
  plotPath: string,
  direction: "prev" | "next",
  viewColumn: vscode.ViewColumn | undefined
): Promise<void> {
  const current = episodePlotChapterOfPath(plotPath);
  if (current === null) {
    void vscode.window.showInformationMessage(
      "単話プロット（設定/episode-plots/第N話.md）を開いてから使ってください。"
    );
    return;
  }
  const plotChapters = await listEpisodePlotChapters(paths.dirname(plotPath));
  const order = episodePlotOrder(episodes, plotChapters);
  const target = neighborEpisodeChapter(order, current, direction);
  if (target === null) {
    void vscode.window.showInformationMessage(
      direction === "prev"
        ? `第${current}話より前の話はありません。`
        : `第${current}話より後の話はありません（予定の話は、プロットモードの「予定の話を足す」で足せます）。`
    );
    return;
  }
  const opened = await openOrCreateEpisodePlot(work, target, {
    viewColumn,
    preview: false,
  });
  if (opened) await noticeForeshadowsFor(work, target);
}

/**
 * 原稿の、いまの話の話数（単話プロットの置き場を決める話数）。
 *
 * - **合本はカーソルの行の話**（`chapterAtManuscriptLine`。「次の話」と同じ決め方）
 * - そうでなければ**走査の結果**から（`episodePlotChapterOf`。プロットモードの
 *   一覧と同じ取り方——ずれると一覧の「プロット」と開く先が違う話になる）
 * - 走査に無い原稿は、ファイル名から読む
 *
 * 読めなければ null（**推測で埋めない**）。
 */
export function manuscriptEpisodePlotChapter(
  manuscriptPath: string,
  rawText: string,
  line: number,
  episodes: readonly EpisodeFile[]
): number | null {
  const inCollected = chapterAtManuscriptLine(rawText, line);
  if (inCollected !== undefined) return inCollected;
  const key = paths.pathKeyForComparison(manuscriptPath);
  const episode = episodes.find(
    (entry) => paths.pathKeyForComparison(entry.filePath) === key
  );
  if (episode) return episodePlotChapterOf(episode);
  const parsed = parseEpisodeFileName(paths.basename(manuscriptPath));
  return parsed.chapterEnd ?? parsed.chapterStart ?? null;
}

/**
 * 原稿エディタの「単話プロット」（E）。その話の単話プロットを**右の列**に開く。
 *
 * 右の列は `ViewColumn.Beside`（シーンメモのパネルと同じ扱い、設計書6.40.4）。
 * 無ければ作るか訊く。開いたら、その話の伏線を知らせる（F-3）。
 */
export async function openEpisodePlotBesideManuscript(
  work: WorkEntry,
  chapter: number | null
): Promise<void> {
  if (chapter === null) {
    void vscode.window.showInformationMessage(
      "この話は話数が読み取れないため、単話プロットの置き場を決められません（ファイル名に話数を入れると作れます）。"
    );
    return;
  }
  const opened = await openOrCreateEpisodePlot(work, chapter, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: false,
  });
  if (opened) await noticeForeshadowsFor(work, chapter);
}

/** 見えている単話プロットのタブ（列ごとの前面のタブだけを見る） */
interface VisibleEpisodePlot {
  chapter: number;
  /** その単話プロットの場所。置き場はこのファイルのあるフォルダー */
  filePath: string;
  column: vscode.ViewColumn;
}

/**
 * その作品の単話プロットが、どこかの列の前面に見えているか。
 *
 * **見えているものだけを追う。** 裏に回ったタブまで切り替えると、作者が
 * 閉じたつもりのものが勝手に動く。タブの形は2通り——普通のエディタ
 * （`TabInputText`）と、作者が `.md` を別の画面に割り当てている場合
 * （`TabInputCustom`）。
 *
 * **ファイルを読まずに答える**（タブの一覧を見るだけ）。カーソルが動くたびに
 * 呼ばれるので、単話プロットを開いていない人には何の手間もかけない。
 */
export function visibleEpisodePlotOf(
  work: WorkEntry
): VisibleEpisodePlot | undefined {
  let groups: readonly vscode.TabGroup[];
  try {
    groups = vscode.window.tabGroups.all;
  } catch {
    return undefined;
  }
  for (const group of groups) {
    const input = group.activeTab?.input;
    const uri =
      input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom
        ? input.uri
        : undefined;
    if (!uri) continue;
    const filePath = paths.fromUri(uri);
    if (!paths.isPathInside(work.folderPath, filePath)) continue;
    const chapter = episodePlotChapterOfPath(filePath);
    if (chapter !== null) return { chapter, filePath, column: group.viewColumn };
  }
  return undefined;
}

/**
 * 原稿で別の話へ移ったら、右に開いている単話プロットをその話のものへ
 * 切り替える（E）。
 *
 * - 単話プロットが見えていなければ**何もしない**（開いていない人に勝手に開かない）。
 *   どの話かを調べる（`resolveChapter`）のも、見えているときだけ
 * - その話の単話プロットが**無ければ、閉じずに残し**、ステータスバーに
 *   「この話には単話プロットがありません」と出す。移るたびに「作りますか」と
 *   訊くと、話を行き来するだけで何度も止められる。閉じると、見比べていた
 *   前の話のプロットが消える
 * - 入力の場所は原稿のまま（`preserveFocus`）。仮の開き方（`preview`）にして、
 *   話を行き来してもタブが積もらないようにする
 */
export async function followManuscriptEpisode(
  work: WorkEntry,
  resolveChapter: () => Promise<number | null>
): Promise<void> {
  const visible = visibleEpisodePlotOf(work);
  if (!visible) return;
  const chapter = await resolveChapter();
  if (chapter === null || visible.chapter === chapter) return;

  const filePath = paths.join(
    paths.dirname(visible.filePath),
    episodePlotFileName(chapter)
  );
  if (!(await pathExists(filePath))) {
    vscode.window.setStatusBarMessage(
      `第${chapter}話には単話プロットがありません（右は第${visible.chapter}話のままです）`,
      6000
    );
    return;
  }
  await openInDefaultEditor(filePath, {
    viewColumn: visible.column,
    preserveFocus: true,
    preview: true,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
