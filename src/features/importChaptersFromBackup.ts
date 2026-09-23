import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { Chapter, ChapterSet } from "../models/chapter";
import { siteProfile } from "../models/posting";
import { ChapterStore, ChapterStoreError } from "../core/chapterStore";
import { episodePathFor } from "../core/bookStore";
import {
  addMissingChapters,
  describeChapterImportPlan,
  localOutlineOf,
  planChapterImport,
  type ChapterImportPlan,
  type LocalOutlineSource,
  type OutlineEpisode,
} from "../core/chapterOutline";
import { parseChaptersClipboard } from "../core/chapterEnvelope";
import { formatChapterLabel } from "../core/episodeLabel";
import { logFailure, logLine, useLogFile } from "../core/logger";
import { PostingStore } from "../core/postingStore";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { readWorkFormat } from "../core/workFormatStore";
import {
  BACKUP_FILE_EXTENSIONS,
  inspectWorkBackup,
  WorkZipError,
} from "../core/workZip";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { confirmRun, confirmRunOrChoose, notifyDone } from "../views/notify";
import { withProgress } from "../views/progress";
import { showBackupOpenDialog } from "./backupPickFolder";

/**
 * バックアップから章立てだけを取り込む（残課題 B7。設計書6.66.6）。
 *
 * 作者の問い（2026-09-23）：「なろうやカクヨムのバックアップから章立ては
 * 読み取れませんでしたか？」
 *
 * ## 出どころ
 *
 * - **小説家になろう・アルファポリス**：バックアップのファイル（ZIP／.txt）を選ぶ。
 *   章の題はバックアップの中にある（`WorkZipInspection.outline`）
 * - **カクヨム**：バックアップに章が無い。ヘルパーが作品管理の画面の「大見出し」を
 *   読んでクリップボードへ置く（`chapterEnvelope.ts`）。ヘルパーから呼ばれたときは
 *   `vscode://…/import-chapters` で始まる
 *
 * ## 守り（実装ルール1・2）
 *
 * - **本文には1文字も触らない。** 書くのは `設定/章立て.json` だけ（`ChapterStore`）
 * - **章立てが既にあれば上書きしない。** 違いを並べ、「足りない章だけ足す」
 *   「置き換える」「やめる」から作者が選ぶ
 * - **話を推測で割り当てない。** 合わない話が1つでもあれば、一覧で見せて止める
 *   （照らし方は `chapterOutline.ts` の1か所）
 * - 確認のあいだに外で章立てが変わっていれば、`ChapterStore` の照合が保存を止める
 *
 * AIは呼ばない。
 */

/** 取り込んだあとにすること（作品一覧を作り直す） */
export interface ChapterImportDeps {
  /** 登録された作品（ヘルパーから呼ばれたとき、どの作品かを探す） */
  listWorks(): readonly WorkEntry[];
  /** 章立てを書き換えたあと */
  afterChange(work: WorkEntry): void;
}

/**
 * 作品一覧・詳細メニューの「バックアップから章立て」。
 *
 * @returns 章立てを書き換えたか
 */
export async function importChaptersFromBackup(work: WorkEntry): Promise<boolean> {
  const source = await vscode.window.showQuickPick(
    [
      {
        label: "バックアップのファイルから",
        description: "小説家になろう・アルファポリス",
        detail: "ダウンロードしたバックアップ（ZIP／テキスト）の章の見出しを読みます。",
        value: "file" as const,
      },
      {
        label: "ヘルパーで読んだ章立てから",
        description: "カクヨム",
        detail:
          "カクヨムのバックアップには章が入っていません。作品管理の画面で、" +
          "統合小説執筆環境ヘルパーの右クリック「章立てを統合小説執筆環境へ渡す」を押してから選んでください（クリップボードから読みます）。",
        value: "clipboard" as const,
      },
      cancelItem("取りやめる"),
    ],
    {
      title: `「${work.title}」に章立てを取り込む（原稿は書き換えません）`,
      placeHolder: "章立てをどこから読みますか",
      ignoreFocusOut: true,
    }
  );
  if (!source || isCancelItem(source) || !("value" in source)) return false;

  const outline =
    source.value === "file"
      ? await outlineFromBackupFile()
      : await outlineFromClipboard(work);
  if (!outline) return false;
  return applyChapterOutline(work, outline.outline, outline.sourceName);
}

/**
 * ヘルパーから呼ばれたとき（`vscode://nonahisa.novel-ai-assistant/import-chapters`）。
 *
 * **作品は作品IDで探す。** 投稿サイトの設定にカクヨムの作品IDを登録した作品が
 * ちょうど1つならそこへ、そうでなければ作者に選んでもらう（推し量って決めない）。
 */
export async function importChaptersFromHelper(deps: ChapterImportDeps): Promise<void> {
  const read = await readChaptersClipboard("uri");
  if (!read) return;

  const works = deps.listWorks();
  if (works.length === 0) {
    void vscode.window.showInformationMessage(
      "章立てを取り込む作品がありません。先に作品を登録してください。"
    );
    return;
  }
  const work =
    (read.workId ? await workByKakuyomuId(works, read.workId) : undefined) ??
    (await askWork(works));
  if (!work) return;

  if (await applyChapterOutline(work, read.outline, "カクヨムの作品管理の画面")) {
    deps.afterChange(work);
  }
}

/**
 * 新しく取り込んだ作品に、バックアップの章立てを置く（`importWorkFromZip.ts` から）。
 *
 * **訊かずに立てる。** いま作ったばかりの作品で、作者が付けた章はまだ無い
 * ——確認を1つ増やすより、立てたことを記録と知らせで言うほうが「打鍵ゼロ」（6.99）に
 * 合う。それでも**章立てが空でなければ触らない**（念のための守り。実装ルール2）。
 *
 * **合本のままでは章の2つ目以降を置けない**（章立てはファイルしか指せない。6.66.4）。
 * なろう・アルファポリスの取り込みは合本1つを置くので、章が2つ以上あれば
 * 立てずに、「話ごとのファイルに分ける」で章が立つことを伝える（分ける操作が
 * 同じ見出しから章を立てる。`collectedSections.ts` の `planSplitSections`）。
 * 取り込みで勝手に分けないのは、取り込みが原稿を1文字も変えずに置く約束だから（6.66.5）。
 *
 * @returns 記録と知らせに書く一文。章の見出しが無ければ undefined
 */
export async function placeImportedChapters(
  work: WorkEntry,
  outline: readonly OutlineEpisode[]
): Promise<{ readonly created: number; readonly note: string } | undefined> {
  if (!outline.some((episode) => episode.part !== null)) return undefined;
  try {
    const store = new ChapterStore(work);
    const set = await store.load();
    if (set.chapters.length > 0) return undefined;
    const plan = planChapterImport({
      outline,
      locals: await readLocalOutline(work),
      existing: set.chapters,
    });
    if (plan.kind === "create") {
      await store.save({ ...set, chapters: [...plan.chapters] });
      return {
        created: plan.chapters.length,
        note:
          `章立てを${plan.chapters.length}個立てました（${plan.chapters
            .slice(0, 3)
            .map((chapter) => `「${chapter.name}」`)
            .join("")}${plan.chapters.length > 3 ? "ほか" : ""}）。` +
          "章立ての記録に書いただけで、原稿は書き換えていません。",
      };
    }
    if (plan.kind === "insideCollected") {
      return {
        created: 0,
        note:
          `章の見出しが${plan.count}個あります。全話が1つのファイルに入っているため、章立てはまだ立てていません。` +
          "作品一覧でそのファイルを右クリックして「話ごとのファイルに分ける」を選ぶと、分けるときに章も立ちます。",
      };
    }
    return {
      created: 0,
      note:
        "バックアップに章の見出しはありますが、章立ては立てませんでした。" +
        "作品を右クリックして「バックアップから章立て」を選ぶと、理由を確かめられます。",
    };
  } catch (error) {
    // **章が立たなくても、取り込みそのものは成り立っている**（下書きと同じ扱い）
    report("取り込んだ作品の章立て", work, error);
    return {
      created: 0,
      note: "章立てを立てられませんでした（記録に理由を残しました）。「バックアップから章立て」でもう一度試せます。",
    };
  }
}

/* ── 読む ─────────────────────────────────────────────── */

interface OutlineSource {
  readonly outline: readonly OutlineEpisode[];
  /** 確認の画面に出す出どころの名前 */
  readonly sourceName: string;
}

async function outlineFromBackupFile(): Promise<OutlineSource | undefined> {
  const picked = await showBackupOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "この章立てを読む",
    title: "章立てを読むバックアップを選ぶ（ZIP／テキスト）",
    filters: { "バックアップ（ZIP／テキスト）": [...BACKUP_FILE_EXTENSIONS] },
  });
  if (!picked) return undefined;
  const filePath = path.fromUri(picked);
  try {
    const bytes = await withProgress("バックアップを読んでいます…", async () =>
      vscode.workspace.fs.readFile(picked)
    );
    // **取り込みと同じ読み方を通す**（`inspectWorkBackup`）。読むだけで、1文字も書かない
    const inspection = inspectWorkBackup(bytes, path.basename(filePath));
    return { outline: inspection.outline, sourceName: path.basename(filePath) };
  } catch (error) {
    if (error instanceof WorkZipError) {
      await vscode.window.showWarningMessage(error.message, {
        modal: true,
        detail: error.detail,
      });
      return undefined;
    }
    useLogFile(undefined);
    logFailure("章立ての取り込み：バックアップを読めなかった", {
      ファイル: filePath,
      詳細: error instanceof Error ? error.message : String(error),
    });
    void vscode.window.showErrorMessage(
      `バックアップを読めませんでした：${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

/**
 * メニューから選んだ作品へ、クリップボードの章立てを当てる。
 *
 * **作品IDが食い違えば止める。** 選んだ作品にカクヨムの作品IDが登録してあり、
 * ヘルパーが読んだ画面の作品IDと違うなら、別の作品の章立てである。
 * 題の照らし合わせで止まることも多いが、ここで先に言うほうが作者に分かりやすい。
 */
async function outlineFromClipboard(work: WorkEntry): Promise<OutlineSource | undefined> {
  const read = await readChaptersClipboard("menu");
  if (!read) return undefined;
  if (read.workId) {
    let known: string | undefined;
    try {
      known = siteProfile(await new PostingStore(work).load(), "kakuyomu")?.workId?.trim();
    } catch {
      // 投稿の記録を読めなければ、作品IDでは確かめない（題と話数の照らし合わせは通る）
    }
    if (known && known !== read.workId) {
      void vscode.window.showWarningMessage(
        `クリップボードの章立ては、別の作品（カクヨムの作品ID ${read.workId}）のものです。` +
          `「${work.title}」に登録されている作品IDは ${known} です。取り込みませんでした。`
      );
      return undefined;
    }
  }
  return { outline: read.outline, sourceName: "カクヨムの作品管理の画面" };
}

/** クリップボードの章立てを読む。**章立てでなければ中身には触れない**（クリップボードは作者の私物） */
async function readChaptersClipboard(
  trigger: "menu" | "uri"
): Promise<{ outline: readonly OutlineEpisode[]; workId: string | null } | undefined> {
  let text: string;
  try {
    text = await vscode.env.clipboard.readText();
  } catch (error) {
    useLogFile(undefined);
    logLine(
      `章立てを取り込むためにクリップボードを読めませんでした：${
        error instanceof Error ? error.message : String(error)
      }`
    );
    void vscode.window.showWarningMessage(
      "クリップボードを読めなかったため、章立てを取り込めませんでした。"
    );
    return undefined;
  }
  const parsed = parseChaptersClipboard(text);
  if (!parsed.ok) {
    if (parsed.kind === "invalid") {
      void vscode.window.showWarningMessage(parsed.reason);
      return undefined;
    }
    void vscode.window.showInformationMessage(
      (trigger === "uri"
        ? "クリップボードに章立てがありませんでした。"
        : "クリップボードに、ヘルパーで読んだ章立てがありませんでした。") +
        "カクヨムの作品管理の画面を開き、統合小説執筆環境ヘルパーの右クリック「章立てを統合小説執筆環境へ渡す」を押してから、もう一度お試しください。"
    );
    return undefined;
  }
  return { outline: parsed.outline, workId: parsed.workId };
}

/* ── 作品へ当てる ─────────────────────────────────────── */

/**
 * 章立てを作品へ当てる。確認を取ってから `ChapterStore` へ書く。
 *
 * @returns 章立てを書き換えたか
 */
export async function applyChapterOutline(
  work: WorkEntry,
  outline: readonly OutlineEpisode[],
  sourceName: string
): Promise<boolean> {
  const store = new ChapterStore(work);
  let set: ChapterSet | null;
  try {
    set = await store.load();
  } catch (error) {
    // **壊れた章立ては直さず止める**（実装ルール2）。計画は unreadable になる
    report("章立ての読み込み", work, error);
    set = null;
  }

  const locals = await readLocalOutline(work);
  const plan = planChapterImport({
    outline,
    locals,
    existing: set ? set.chapters : null,
  });
  const detail = [`読んだ元：${sourceName}`, "", ...describeChapterImportPlan(plan)].join("\n");

  const chapters = await chooseChapters(work, plan, detail);
  if (!chapters || !set) return false;

  try {
    await store.save({ ...set, chapters: [...chapters] });
  } catch (error) {
    report("章立ての保存", work, error);
    void vscode.window.showErrorMessage(
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
  useLogFile(work.folderPath);
  notifyDone(
    `「${work.title}」の章立てを${chapters.length}個にしました（原稿は書き換えていません）。`
  );
  return true;
}

/**
 * 計画を見せて、書く章立てを決める。**書かないときは undefined。**
 */
async function chooseChapters(
  work: WorkEntry,
  plan: ChapterImportPlan,
  detail: string
): Promise<readonly Chapter[] | undefined> {
  switch (plan.kind) {
    case "none":
      void vscode.window.showInformationMessage(
        "章の見出しが見つかりませんでした。章は作品一覧の右クリック「ここから章を始める」で付けられます。"
      );
      return undefined;
    case "same":
    case "unreadable":
      void vscode.window.showInformationMessage(describeChapterImportPlan(plan).join(""));
      return undefined;
    case "mismatch":
    case "insideCollected":
      await vscode.window.showWarningMessage("章立ては取り込みませんでした。", {
        modal: true,
        detail,
      });
      return undefined;
    case "create":
      return (await confirmRun(
        `バックアップの章立てから、章を${plan.chapters.length}個立てます。`,
        "章を立てる",
        { detail, work }
      ))
        ? plan.chapters
        : undefined;
    case "differs": {
      const added = addMissingChapters(plan.existing, plan.proposed);
      const canAdd = added.length > plan.existing.length;
      const addLabel = "足りない章だけ足す";
      const replaceLabel = "バックアップの章立てに置き換える";
      const answer = await confirmRunOrChoose(
        "この作品には既に章立てがあります。どうしますか？",
        canAdd ? addLabel : replaceLabel,
        {
          kind: "warning",
          work,
          detail: [
            detail,
            "",
            canAdd
              ? `「${addLabel}」：いまの章は名前も含めてそのまま残り、バックアップにだけある章が加わります。`
              : "",
            `「${replaceLabel}」：いまの章立てをバックアップのものに入れ替えます（話は消えません。この作品にだけある章は外れます）。`,
          ]
            .filter((line) => line !== "")
            .join("\n"),
          choices: canAdd ? [replaceLabel] : [],
        }
      );
      if (!answer) return undefined;
      if (answer.kind === "run") return canAdd ? added : plan.proposed;
      return answer.label === replaceLabel ? plan.proposed : undefined;
    }
  }
}

/**
 * 手元の話を、作品一覧に出る順で読む。**読めなかったファイルは、ファイル名の話数と題だけで照らす**
 * （1話読めないだけで全体を止めない）。
 */
async function readLocalOutline(work: WorkEntry) {
  const scan = await scanWork(work);
  const format = await readWorkFormat(work);
  const sources = await withProgress("この作品の話を読んでいます…", async () => {
    const read: LocalOutlineSource[] = [];
    for (const episode of scan.episodes) {
      read.push({
        relPath: episodePathFor(work.folderPath, episode.filePath),
        label: formatChapterLabel(episode, format) || episode.fileName,
        fileNumber: episode.chapterStart,
        fileSubtitle: episode.subtitle,
        text: await readOrNull(work, episode.filePath),
      });
    }
    return read;
  });
  return localOutlineOf(sources);
}

async function readOrNull(work: WorkEntry, filePath: string): Promise<string | null> {
  try {
    return (await readTextFile(filePath)).text;
  } catch (error) {
    useLogFile(work.folderPath);
    logFailure("章立ての取り込み：話を読めなかった", {
      ファイル: filePath,
      内容: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 投稿サイトの設定にカクヨムの作品IDを登録した作品が、ちょうど1つならそれ */
async function workByKakuyomuId(
  works: readonly WorkEntry[],
  workId: string
): Promise<WorkEntry | undefined> {
  const found: WorkEntry[] = [];
  for (const work of works) {
    try {
      const ledger = await new PostingStore(work).load();
      if (siteProfile(ledger, "kakuyomu")?.workId?.trim() === workId) found.push(work);
    } catch {
      // 投稿の記録を読めない作品は候補にしない（選ぶ画面には出る）
    }
  }
  return found.length === 1 ? found[0] : undefined;
}

async function askWork(works: readonly WorkEntry[]): Promise<WorkEntry | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...works.map((work) => ({ label: work.title, description: work.folderPath, work })),
      cancelItem("取り込まずに終わる"),
    ],
    {
      title: "章立てを取り込む作品（一覧から選びます）",
      placeHolder:
        "カクヨムの章立てを、どの作品へ取り込みますか（投稿サイトの設定に作品IDを登録すると、次からは訊きません）",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("work" in picked)) return undefined;
  return picked.work;
}

/** 失敗はログに残す（原因にたどり着けるように） */
function report(what: string, work: WorkEntry, error: unknown): void {
  useLogFile(work.folderPath);
  logFailure(what, {
    作品: work.title,
    種類: error instanceof ChapterStoreError ? error.kind : "unknown",
    内容: error instanceof Error ? error.message : String(error),
  });
}
