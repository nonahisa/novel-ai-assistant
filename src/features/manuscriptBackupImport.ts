import * as vscode from "vscode";
import { showQuickPickKeepingFocus } from "../views/pickerFocus";
import * as path from "../core/paths";
import { fromUri } from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { MissingEpisodeFile } from "../core/backupMissingEpisodes";
import { BACKUP_DROP_MAX_BYTES } from "../core/backupFileKinds";
import {
  backupImportEntries,
  describeBackupImportChoices,
  numberRangeLabel,
  planBackupImport,
  type BackupImportEntry,
} from "../core/episodeBackupImport";
import {
  IMPORT_CANCEL_LABEL,
  IMPORT_CHOICE_LABELS,
  adaptImportedNotation,
  appendSubtitle,
  erasedCharCount,
  isEpisodeBodyEmpty,
  type ImportChoice,
} from "../core/episodeImport";
import { nextChapterNumber, parseEpisodeFileName } from "../core/episodeParser";
import {
  episodeNameStyleOf,
  episodeNumberOf,
  nextEpisodeFileNameLike,
  planInsertion,
} from "../core/episodeRenumber";
import { messageOf } from "../core/errorMessage";
import { findLatestEpisode } from "../core/latestEpisode";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { copyEmphasisFor } from "../core/postingCopyTargets";
import type { EmphasisSite } from "../core/ruby";
import { canRunProcesses } from "../core/runtime";
import { encodeForNewFile, readTextFile, type TextFileContent } from "../core/textFile";
import { BACKUP_FILE_EXTENSIONS, WorkZipError, inspectWorkBackup, type WorkZipInspection } from "../core/workZip";
import { withCancellableProgress } from "../views/progress";
import { nameNewEpisodes, writeNewEpisodes, type NamedEpisodeFile } from "./addEpisodeFiles";
import { showBackupOpenDialog } from "./backupPickFolder";
import {
  cancelledBeforeWriting,
  episodeNaming,
  nextEpisodeName,
  titlePlaceOf,
  writeIntoCurrent,
  type ImportScan,
  type ManuscriptImportResult,
  type TitlePlace,
} from "./manuscriptImport";
import { episodeTitleSlot } from "../core/metadataParser";
import { renamedFileName } from "../core/episodeRename";
import { registeredPostingSites } from "./postingCopyRegistered";

/**
 * 原稿エディターの［入力］→「バックアップから」（0.150.0。設計書6.25.13）。
 * 投稿サイトのバックアップ（作品の取り込みと同じく ZIP・アルファポリスやなろうの .txt）を
 * 選び、その中の話を**開いている作品へ足す**。
 *
 * ## 流れ
 *
 * 1. バックアップを選ぶ窓（作品の取り込みと同じ絞り込み・前に選んだ場所）
 * 2. 読む（`inspectWorkBackup`。**読むだけで、1文字も書かない**）。話へ割るのは
 *    既にある作品へ足すときと同じ `backupEpisodesOf`（`episodeBackupImport.ts`）
 * 3. 中の話を並べ、足す話を選ばせる（**全部を選んだ状態から外す**形）
 * 4. 足す先を訊く（決まりは 0.147.0 の「テキストファイルから」と同じ。何話も選んだら
 *    空の話へは入れず、［上書きする］も出さない）
 *
 * ## 書き方（実装ルール1・2）
 *
 * 0.147.0 の取り込み（`manuscriptImport.ts`）と同じ道を通す。写さない。
 *
 * - 1話を開いている話へ（空の話・上書き）：`writeIntoCurrent`（`writeTextFilePreservingFormat`）
 * - ［次の話として足す］：「この話の前に挿入」と同じ `prepareInsertion`／`runInsertion`。
 *   **何話ぶんでも、後ろの話は一度にその数だけずらす**（名前の付け替え・台帳と
 *   単話プロットの追従・名前だけのコミット）。**ずらす前に、全部の話が書けるかを確かめる**。
 *   途中で止まったら新しい話は作らず、どこまで済んだかを出す
 * - ［最後に加える］：`addEpisodeFiles.ts`（`mode: "create"` だけ）。ほかの話には触らない
 * - 文字コード・改行・BOM は手元の原稿に合わせる（`encodeForNewFile`）
 * - ルビ・傍点の書き方は 0.147.0 の「テキストファイルから」と同じ `adaptImportedNotation` を
 *   通す。バックアップの本文は投稿サイトの記法（`｜漢字《かんじ》`・`《《傍点》》`）なので、
 *   **.txt の作品へはそのまま、.md の作品へは `{漢字|かんじ}`・`{{傍点}}` へ**直す。
 *   投稿先に合わせた傍点の書き換え（`emphasis`）が効くのは Markdown から .txt へ入れる
 *   ときだけで、バックアップの道では効かない——サイトの記法どうしを読み替えると、
 *   作者が書いた字そのものに手が入るため（0.150.0 で決めた）
 *
 * **`insertEpisode.ts` は動的 import**（`core/git.ts` に届く。設計書5.8.5）。ブラウザ版では
 * ［次の話として足す］を並べない（0.147.0 と同じ）。
 */
export async function importBackupIntoWork(input: {
  readonly work: WorkEntry;
  readonly filePath: string;
  readonly scan: ImportScan;
  readonly document?: vscode.TextDocument;
  readonly renameHooks?: {
    beforeRename?: (from: string, to: string) => void;
    afterRename?: (from: string) => void;
  };
}): Promise<ManuscriptImportResult> {
  const { work, filePath, scan } = input;
  const none: ManuscriptImportResult = { changed: false };
  useLogFile(work.folderPath);

  const current = scan.episodes.find((episode) => path.isSamePath(episode.filePath, filePath));
  if (!current) {
    void vscode.window.showWarningMessage(
      "この原稿は作品の話として認識できないため、取り込めません。作品の本文フォルダーにある話を開いてください。"
    );
    return none;
  }

  const read = await pickAndReadBackup();
  if (!read) return none;
  const { sourceName, inspection } = read;

  const { entries, empty } = backupImportEntries(inspection);
  if (entries.length === 0) {
    void vscode.window.showWarningMessage(
      `「${sourceName}」には、本文の入った話がありませんでした（何も足していません）。`
    );
    return none;
  }

  const picked = await pickEntries(entries, sourceName);
  if (!picked || picked.length === 0) return none;

  // 未保存の変更があれば先に保存する（0.147.0 と同じ。空かどうかを画面で見ている中身で決める）
  if (input.document?.isDirty) {
    const saved = await input.document.save();
    if (!saved || input.document.isDirty) {
      void vscode.window.showWarningMessage(
        "開いている話を保存できなかったため、取り込みをやめました（何も書いていません）。保存してからもう一度お試しください。"
      );
      return none;
    }
  }

  let disk: TextFileContent;
  try {
    disk = await readTextFile(filePath);
  } catch (error) {
    logFailure("原稿エディターのバックアップの取り込み：開いている話を読めなかった", {
      ファイル: filePath,
      詳細: messageOf(error),
    });
    void vscode.window.showErrorMessage(
      `開いている話（${current.fileName}）を読めなかったため、取り込みをやめました：${messageOf(error)}`
    );
    return none;
  }
  if (disk.hasConflictMarkers) {
    void vscode.window.showErrorMessage(
      `開いている話（${current.fileName}）に同期の競合の印（<<<<<<< など）が残っているため、取り込みをやめました。先に競合を解決してください。`
    );
    return none;
  }

  const count = picked.length;
  const folder = path.dirname(current.filePath);
  const number = episodeNumberOf(current.fileName);
  const pivot = number === null ? null : number + 1;
  const shiftPlan =
    pivot === null || !canRunProcesses() ? null : planInsertion(scan.episodes, pivot, folder, count);
  const latest = findLatestEpisode(scan.episodes);
  const collected = (current.collectedCount ?? 0) > 1;
  const plan = planBackupImport({
    bodyEmpty: isEpisodeBodyEmpty(disk.text),
    collected,
    numbered: number !== null,
    isLatest: latest !== undefined && path.isSamePath(latest.filePath, current.filePath),
    shiftCount: shiftPlan?.renames.length ?? 0,
    count,
  });

  // ルビと傍点は作品の投稿先に合わせる（0.147.0 と同じ決め方）
  const emphasis = copyEmphasisFor(await registeredPostingSites(work));
  const lastNumber = nextChapterNumber(
    scan.episodes.map((episode) => parseEpisodeFileName(episode.fileName))
  );

  /*
    1話を開いている話へ入れるとき（空の話・上書き）の題の扱いは、**窓を出す前に決めて窓に書く**。
    0.147.0 は「題にしますか」と訊いてから題の欄を書き換えるが、ここは訊かずに通るので、
    **作者が題の欄に書いた題は書き換えない**（欄が空のときだけ入れる）。ファイル名に付けるときは
    新しい名前を窓に出す
  */
  const single = count === 1 ? await singleTitlePlan(picked[0], current, disk.text, collected) : null;

  let choice: ImportChoice | "fill";
  if (plan.kind === "fill") {
    // 訊かずに入れる道でも、何をどこへ入れるかは先に確かめる（作者の原稿へ書くため）
    const ok = await confirmFill(picked[0], sourceName, current.fileName, single?.line);
    if (!ok) return none;
    choice = "fill";
  } else {
    const answer = await askChoice(
      plan.choices,
      count,
      {
        sourceName,
        entries: picked,
        nextFrom: pivot ?? undefined,
        shiftCount: shiftPlan?.renames.length ?? 0,
        lastFrom: lastNumber,
        erasedChars: erasedCharCount(disk.text, current.ext),
      },
      plan.choices.includes("overwrite") && single?.line
        ? `［${IMPORT_CHOICE_LABELS.overwrite}］のとき：${single.line}`
        : undefined
    );
    if (!answer) return none;
    choice = answer;
  }

  const emptyNote =
    empty.length > 0
      ? [`本文の無い${empty.length}話は並べていません（${empty.slice(0, 5).join("、")}${empty.length > 5 ? " ほか" : ""}）。`]
      : [];

  return withCancellableProgress(`「${sourceName}」から取り込んでいます…`, async (_progress, token) => {
    const cancelled = () => token.isCancellationRequested;
    switch (choice) {
      case "fill":
      case "overwrite": {
        const entry = picked[0];
        const place = single?.place ?? null;
        const notes = [...emptyNote];
        if (single?.notice) notes.push(single.notice);
        return writeIntoCurrent({
          work,
          current,
          disk,
          imported: { text: entry.body, notation: "plain", chars: entry.chars, notes },
          title: place === null ? null : entry.title,
          titlePlace: place,
          keptTitleInBody: false,
          emphasis,
          renameHooks: input.renameHooks,
          sourceName: `${sourceName} の「${entry.label}」`,
          overwrite: choice === "overwrite",
          cancelled,
        });
      }
      case "next":
        if (pivot === null) return none;
        return addAllAsNext({
          work,
          scan,
          current,
          folder,
          pivot,
          reference: disk,
          entries: picked,
          emphasis,
          sourceName,
          notes: emptyNote,
          cancelled,
        });
      case "last":
        if (cancelled()) return cancelledBeforeWriting();
        return addAllAsLast({
          work,
          scan,
          entries: picked,
          emphasis,
          sourceName,
          notes: emptyNote,
          cancelled,
        });
    }
  });
}

/** バックアップを選んで読む。**読むだけ**。読めなければ理由を出して undefined */
async function pickAndReadBackup(): Promise<
  { sourceName: string; inspection: WorkZipInspection } | undefined
> {
  const picked = await showBackupOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "この中の話を選ぶ",
    title: "話を足すバックアップを選ぶ（ZIP／テキスト）",
    filters: { "バックアップ（ZIP／テキスト）": [...BACKUP_FILE_EXTENSIONS] },
  });
  if (!picked) return undefined;
  const sourceName = path.basename(fromUri(picked));
  try {
    const bytes = await vscode.workspace.fs.readFile(picked);
    if (bytes.length > BACKUP_DROP_MAX_BYTES) {
      void vscode.window.showWarningMessage(
        `「${sourceName}」は大きすぎるため読みませんでした（${Math.round(
          BACKUP_DROP_MAX_BYTES / 1024 / 1024
        )}MBまで）。投稿サイトのバックアップかどうか、ご確認ください。`
      );
      return undefined;
    }
    // 作品の取り込み（`importWorkFromZip`）と同じ読み方を通す
    return { sourceName, inspection: inspectWorkBackup(bytes, sourceName) };
  } catch (error) {
    if (error instanceof WorkZipError) {
      await vscode.window.showWarningMessage(error.message, { modal: true, detail: error.detail });
      return undefined;
    }
    logFailure("原稿エディターのバックアップの取り込み：バックアップを読めなかった", {
      ファイル: sourceName,
      詳細: messageOf(error),
    });
    void vscode.window.showErrorMessage(`バックアップを読めませんでした：${messageOf(error)}`);
    return undefined;
  }
}

/**
 * 足す話を選ばせる。**全部を選んだ状態から外す**形（いちばん多いのは全部足すこと）。
 * 並びはバックアップの中の順のまま（足す順もこの順）。
 */
async function pickEntries(
  entries: readonly BackupImportEntry[],
  sourceName: string
): Promise<BackupImportEntry[] | undefined> {
  const items = entries.map((entry) => ({
    label: entry.label,
    description: `${entry.chars}字`,
    picked: true,
    entry,
  }));
  const chosen = await showQuickPickKeepingFocus(items, {
    title: `「${sourceName}」から足す話を選んでください（${entries.length}話）`,
    placeHolder: "足さない話のチェックを外してから OK を押してください",
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!chosen) return undefined;
  // 選んだ順ではなく、バックアップの中の順に並べ直す
  return chosen.map((item) => item.entry).sort((a, b) => a.order - b.order);
}

/**
 * 1話を開いている話へ入れるときの、題の置き場と窓・知らせの一言。
 *
 * - 冒頭の題の欄が**空**ならそこへ入れる（欄に題が入っていれば触らない。作者が書いた題だから）
 * - 題の欄が無く、ファイル名にサブタイトルが無ければ名前に付ける（新しい名前を窓に出す）
 * - どちらでもなければ付けない（知らせに書く）
 */
async function singleTitlePlan(
  entry: BackupImportEntry,
  current: ImportScan["episodes"][number],
  lfText: string,
  collected: boolean
): Promise<{ place: TitlePlace | null; line?: string; notice?: string }> {
  if (!entry.title) return { place: null };
  const place = await titlePlaceOf(current, lfText, entry.title, collected);
  if (place === "header") {
    if (episodeTitleSlot(lfText)?.empty) {
      return { place, line: `題「${entry.title}」を冒頭の題の欄に入れます。` };
    }
    return {
      place: null,
      line: "冒頭の題の欄にはもう題が入っているので、題は変えません。",
      notice: `題「${entry.title}」は付けていません（冒頭の題の欄にもう題が入っているため）。`,
    };
  }
  if (place === "rename") {
    return {
      place,
      line: `ファイル名を「${renamedFileName(current, entry.title)}」に変えます（題「${entry.title}」をサブタイトルにします）。`,
    };
  }
  return {
    place: null,
    notice: `題「${entry.title}」は、この話に題の置き場（冒頭の題の欄・サブタイトルの無いファイル名）が無いため付けていません。`,
  };
}

/** 空の話へ1話を入れる前の確かめ */
async function confirmFill(
  entry: BackupImportEntry,
  sourceName: string,
  fileName: string,
  /** 題をどうするかの一言（`singleTitlePlan`） */
  titleLine?: string
): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `「${entry.label}」を、この話（${fileName}）へ入れます。`,
    {
      modal: true,
      detail:
        `取り込む元：${sourceName}（${entry.chars}字）\n` +
        "この話の本文は空なので、本文の欄へ入れます（冒頭の欄のほかの項目はそのまま）。" +
        "前書き・後書き・リアクションなど、本文の外の欄は入りません。" +
        (titleLine ? `\n${titleLine}` : ""),
    },
    { title: "入れる" },
    { title: IMPORT_CANCEL_LABEL, isCloseAffordance: true }
  );
  return answer?.title === "入れる";
}

/** 足す先を訊く。［やめる］・窓を閉じたら undefined */
async function askChoice(
  choices: readonly ImportChoice[],
  count: number,
  detail: Omit<Parameters<typeof describeBackupImportChoices>[0], "choices">,
  /** 窓の説明の末尾に足す一言（上書きのときの題の扱い） */
  extraLine?: string
): Promise<ImportChoice | undefined> {
  const items: (vscode.MessageItem & { choice?: ImportChoice })[] = [
    ...choices.map((choice) => ({ title: IMPORT_CHOICE_LABELS[choice], choice })),
    { title: IMPORT_CANCEL_LABEL, isCloseAffordance: true },
  ];
  const answer = await vscode.window.showWarningMessage(
    count > 1
      ? `${count}話を足します。どこへ足しますか？`
      : "この話には本文が入っています。取り込む話をどうしますか？",
    {
      modal: true,
      detail: [...describeBackupImportChoices({ choices, ...detail }), ...(extraLine ? [extraLine] : [])].join(
        "\n"
      ),
    },
    ...items
  );
  return answer?.choice;
}

/**
 * ［次の話として足す］。開いている話のすぐ次へ、選んだ話を順に差し込む。
 * あとの話の番号は**一度に足す話の数だけ**ずらす（「この話の前に挿入」と同じ道）。
 */
async function addAllAsNext(input: {
  readonly work: WorkEntry;
  readonly scan: ImportScan;
  readonly current: ImportScan["episodes"][number];
  readonly folder: string;
  readonly pivot: number;
  readonly reference: TextFileContent;
  readonly entries: readonly BackupImportEntry[];
  readonly emphasis: EmphasisSite;
  readonly sourceName: string;
  readonly notes: readonly string[];
  readonly cancelled: () => boolean;
}): Promise<ManuscriptImportResult> {
  const { work, scan, current, folder, pivot, entries, sourceName } = input;
  const count = entries.length;

  /*
    **番号をずらす前に、全部の話が書けるかを確かめる。** ずらしてから1話でも書けないと
    分かると、番号が空いたまま残る。名前も中身もここで決めておく
  */
  const files: { filePath: string; bytes: Uint8Array }[] = [];
  for (const [index, entry] of entries.entries()) {
    const fileName = nextEpisodeName(scan.episodes, current, folder, pivot + index, entry.title);
    const text = adaptImportedNotation(entry.body, "plain", fileName, input.emphasis);
    const bytes = encodeForNewFile(text, input.reference);
    if (!bytes) {
      void vscode.window.showErrorMessage(
        `取り込んでいません（どの話も足していません）。「${entry.label}」に、手元の原稿の文字コード（${input.reference.encoding}）では書けない文字が入っています。`
      );
      return { changed: false };
    }
    files.push({ filePath: path.join(folder, fileName), bytes });
  }

  const { prepareInsertion, runInsertion } = await import("./insertEpisode.js");
  const prepared = await prepareInsertion(work, scan.episodes, pivot, folder, count);
  if (!prepared.ok) {
    void vscode.window.showErrorMessage(prepared.message);
    return { changed: false };
  }
  if (input.cancelled()) return cancelledBeforeWriting();

  const range = numberRangeLabel(pivot, count);
  const result = await runInsertion(
    work,
    scan.episodes,
    prepared,
    {
      files,
      commitMessage: `${range}をバックアップから取り込んで差し込んだため、第${pivot}話以降の話数を調整`,
    },
    { isCancelled: input.cancelled }
  );

  if (result.stoppedAt) {
    // どこまで済んだかは付け替えの知らせ（`reportRenumberOutcome`）が出している
    /*
      **空いた番号を言い切らない。** 何話ぶんもずらすときは、ずらし終えた話とまだの話の
      あいだに空きができ、その場所は止まった所で変わる（1話ぶんの 0.147.0 とは違い、
      「第N話が空いた」の1つでは言えない）。動いた話の名前は付け替えの知らせに出ている
    */
    void vscode.window.showWarningMessage(
      `「${sourceName}」の話はまだどこにも入れていません。話の番号を後ろへずらす途中で止まりました` +
        `（「${result.stoppedAt.rename.fromFileName}」の付け替えで止まりました）。ずらし終えた話とまだの話のあいだで番号が空いています。` +
        "本文は1文字も失われていません。" +
        "作品一覧で並びを確かめ、止まった理由を取り除いてから、ずらした話の名前を戻してください（どの話を動かしたかは、付け替えの知らせのとおりです）。"
    );
    return { changed: result.changed };
  }
  const created = result.createdPaths ?? [];
  if (created.length === 0) return { changed: result.changed };

  const head =
    created.length === count
      ? `「${sourceName}」から${count}話を、${range}として足しました。`
      : `「${sourceName}」から足せたのは${count}話のうち${created.length}話です（${range}の番号は空けてあります。足せなかった話は知らせのとおりです）。`;
  logStep(`原稿エディター：${head}`);
  const text = [head, ...input.notes].join("\n");
  if (created.length === count) void vscode.window.showInformationMessage(text);
  else void vscode.window.showWarningMessage(text);
  return { changed: true, newFilePath: created[0] };
}

/** ［最後に加える］。最後の話の次の番号から順に足す。ほかの話には触らない（`mode: "create"` だけ） */
async function addAllAsLast(input: {
  readonly work: WorkEntry;
  readonly scan: ImportScan;
  readonly entries: readonly BackupImportEntry[];
  readonly emphasis: EmphasisSite;
  readonly sourceName: string;
  readonly notes: readonly string[];
  readonly cancelled: () => boolean;
}): Promise<ManuscriptImportResult> {
  const { work, scan, entries, sourceName } = input;
  const naming = episodeNaming();
  const first = nextChapterNumber(
    scan.episodes.map((episode) => parseEpisodeFileName(episode.fileName))
  );
  const latest = findLatestEpisode(scan.episodes);
  const separator = latest ? (episodeNameStyleOf(latest.fileName)?.separator ?? null) : null;

  const files: MissingEpisodeFile[] = entries.map((entry, index) => ({
    order: entry.order,
    label: entry.label,
    part: null,
    number: first + index,
    // 手元の流儀が読めない（話が1つも無い・番号の無い名前だけ）ときは設定から作る
    defaultFileName: nextEpisodeFileNameLike({
      latestFileName: null,
      number: first + index,
      fallback: naming,
    }),
    renamable: true,
    // 中身は名前（拡張子）が決まってから寄せる
    content: { kind: "text", text: "" },
  }));
  const existing = scan.episodes.map((episode) =>
    path.relative(scan.manuscriptDir, episode.filePath).replace(/\\/g, "/")
  );
  const result = nameNewEpisodes(files, scan, existing);
  const byOrder = new Map(entries.map((entry) => [entry.order, entry] as const));
  const named: NamedEpisodeFile[] = result.named.map(({ file, name }) => {
    const entry = byOrder.get(file.order);
    const finalName = entry?.title ? appendSubtitle(name, entry.title, separator) : name;
    const text = entry ? adaptImportedNotation(entry.body, "plain", finalName, input.emphasis) : "";
    return { name: finalName, file: { ...file, content: { kind: "text", text } } };
  });

  const written = await writeNewEpisodes(work, scan, named, { isCancelled: input.cancelled });
  const skipped = [...result.skipped, ...written.skipped];
  const skippedText = skipped.map((entry) => `${entry.label}：${entry.reason}`);
  if (written.cancelled) {
    /*
      中止は次の1話を書く前に見る。**書いた話は戻さない**（新しいファイルを足しただけで、
      ほかの話には触っていない）。何話まで足したかを先に言う
    */
    const rest = named.length - written.added.length - written.skipped.length;
    const text =
      `取り込みを中止しました。残りの${rest}話は足していません。` +
      (written.added.length > 0
        ? `足したのは${written.added.length}話です（${written.added
            .map((entry) => path.basename(entry.path))
            .join("、")}）。`
        : "");
    logStep(`原稿エディター：「${sourceName}」から最後に足す途中で中止：${text}`);
    void vscode.window.showWarningMessage([text, ...skippedText].join("\n"));
    return written.added.length > 0
      ? { changed: true, newFilePath: written.added[0].path }
      : { changed: false };
  }
  if (written.added.length === 0) {
    logStep(`原稿エディター：「${sourceName}」の話を最後に足せませんでした：${skippedText.join("、")}`);
    void vscode.window.showErrorMessage(
      [`取り込んでいません（どの話も足していません）。`, ...skippedText].join("\n")
    );
    return { changed: false };
  }
  const added = written.added.map((entry) => entry.path);
  const range = numberRangeLabel(first, entries.length);
  const head =
    skipped.length === 0
      ? `「${sourceName}」から${entries.length}話を、最後の話のあとに足しました（${range}）。`
      : `「${sourceName}」から足せたのは${entries.length}話のうち${added.length}話です。足せなかった話：`;
  logStep(`原稿エディター：${head}${skippedText.join("、")}`);
  const text = [head, ...skippedText, ...input.notes].join("\n");
  if (skipped.length === 0) void vscode.window.showInformationMessage(text);
  else void vscode.window.showWarningMessage(text);
  return { changed: true, newFilePath: added[0] };
}
