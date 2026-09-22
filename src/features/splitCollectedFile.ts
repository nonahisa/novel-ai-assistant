import { revealFolder } from "../views/openDocument";
import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import {
  planSplit,
  unnumberedCount,
  type SplitPlan,
} from "../core/splitCollected";
import { encodeForNewFile, readTextFile } from "../core/textFile";
import { atomicWriteFile, createManagedRecoveryPath } from "../core/atomicWrite";
import { logFailure, useLogFile } from "../core/logger";
import { recordEdit } from "../core/actorContext";
import { ChapterStore, ChapterStoreError } from "../core/chapterStore";
import { episodePathFor } from "../core/bookStore";
import {
  describeSplitSections,
  planSplitSections,
  type SectionPlan,
} from "../core/collectedSections";
import type { Chapter, ChapterSet } from "../models/chapter";

/**
 * 1ファイルに全話が入ったファイルを、話ごとに分ける（設計書6.2.2）。
 *
 * 投稿サイトのダウンロードは全話を1ファイルにまとめた形で出る。
 * そのままでは**登場話数が付かず、話ごとの文字数も出ず、1文字直すたびに
 * 全体を処理し直す**ことになる。
 *
 * ## 原稿を相手にするので、順番を守る
 *
 * 1. 読む（文字コード・改行を保つ）
 * 2. 分け方を組み立て、**繋ぎ直すと元に戻ることを確かめる**
 * 3. 作者に見せて、押されたら
 * 4. **新しいファイルを作る**（既存は上書きしない）
 * 5. **元のファイルは消さず、回復先へ退避する**
 *
 * **途中で失敗したら、作ったものを消さない。** 消すと、
 * どこまで進んだのか分からなくなる。何が起きたかを伝えて止まる。
 */
export async function splitCollectedFile(
  work: WorkEntry,
  filePath: string
): Promise<void> {
  let file;
  try {
    file = await readTextFile(filePath);
  } catch {
    void vscode.window.showErrorMessage("ファイルを読み込めませんでした。");
    return;
  }

  if (file.text.includes("<<<<<<<")) {
    void vscode.window.showWarningMessage(
      "競合の印（<<<<<<<）が残っているファイルは分けられません。" +
        "先に競合を解決してください。"
    );
    return;
  }

  const directory = path.dirname(filePath);
  const extension = path.extname(filePath);
  let existing: string[] = [];
  try {
    const entries = await vscode.workspace.fs.readDirectory(
      path.toUri(directory)
    );
    existing = entries
      .filter(([, kind]) => kind === vscode.FileType.File)
      .map(([name]) => name);
  } catch {
    // 読めなくても進める。重複を避けられないだけで、
    // 作成は「既存があれば失敗する」ので原稿は壊れない
  }

  const plan = planSplit(file.text, { extension, existing });
  if (!plan) {
    void vscode.window.showInformationMessage(
      `${path.basename(filePath)} には話の区切りが見つかりませんでした。` +
        "小説家になろうのダウンロード形式（「エピソードN開始」の行）に対応しています。"
    );
    return;
  }

  // **繋ぎ直して元に戻らなければ、分けない。**
  // 「たぶん大丈夫」で原稿へ書き込んではいけない
  if (!plan.lossless) {
    void vscode.window.showErrorMessage(
      "分けたものを繋ぎ直しても元に戻らないため、中止しました。" +
        "原稿には触れていません。この形のファイルに対応できていない可能性があります。"
    );
    // **記録の直前に書き先を向ける**（0.43.3 と同じ）
    useLogFile(work.folderPath);
    logFailure("合本の分割を中止", {
      ファイル: path.basename(filePath),
      理由: "繋ぎ直しても元に戻らない",
    });
    return;
  }

  /*
    **合本の中の章の見出し（【第N章】）から、章を立てる**（作者の問い、
    2026-09-23「バックアップから章立ては読み取れませんでしたか？」）。

    章の台帳はファイルしか指せないので、合本のままでは2章目以降を置けない
    （6.66.4）。**分けたあとなら始まりの話が実在のファイルになる**ので、
    ここが章を立てられる機会になる。

    **押す前に決めて、確認画面に出す。** 台帳もこの時点で読んでおく——
    確認のあいだに外で台帳が変わったら、保存の照合（ChapterStore）が止める。
  */
  const sectionStore = new ChapterStore(work);
  const sections = await planSectionsForSplit(
    sectionStore,
    work,
    directory,
    plan
  );

  if (!(await confirm(filePath, plan, describeSplitSections(sections.plan)))) {
    return;
  }

  const created: string[] = [];
  try {
    for (const part of plan.parts) {
      const target = path.join(directory, part.fileName);
      // **既にあれば失敗する**（`mode: "create"`）。既存の原稿を上書きしない
      // **元と同じ文字コード・改行で書く**（`encodeForNewFile`）。
      // Shift_JISで表せない文字が混ざっていたら undefined が返る。
      // 代替文字に置き換えて「保存できた」ことにすると本文が壊れる
      const bytes = encodeForNewFile(part.text, file);
      if (!bytes) {
        throw new Error(
          `${part.fileName} は元の文字コード（${file.encoding}）で書けない文字を含んでいます。`
        );
      }
      await atomicWriteFile(target, bytes, { mode: "create" });
      created.push(part.fileName);
    }
  } catch (error) {
    // **作ったものは消さない。** 消すと、どこまで進んだか分からなくなる
    void vscode.window.showErrorMessage(
      `${created.length}件を作ったところで失敗しました: ${
        error instanceof Error ? error.message : String(error)
      } 元のファイルはそのままです。`
    );
    useLogFile(work.folderPath);
    logFailure("合本の分割に失敗", {
      ファイル: path.basename(filePath),
      作成済み: created.join("、"),
    });
    return;
  }

  // **章は、分けたファイルが揃ってから立てる。** 指す先が無い章を
  // 先に書くと、途中で失敗したとき「開始の話が見つからない章」が残る
  const sectionNote = await saveSections(sectionStore, work, sections);

  // **元のファイルは消さない。回復先へ退避する。**
  // 残したままだと、同じ本文を二重に数えることになる
  let recovery: string | undefined;
  try {
    recovery = await createManagedRecoveryPath(filePath);
    await vscode.workspace.fs.rename(
      path.toUri(filePath),
      path.toUri(recovery),
      { overwrite: false }
    );
  } catch (error) {
    void vscode.window.showWarningMessage(
      `${created.length}件へ分けましたが、元のファイルを退避できませんでした。` +
        "このままだと同じ本文を二重に数えます。 " +
        `${path.basename(filePath)} を手で移動してください。` +
        (sectionNote ? ` ${sectionNote}` : "")
    );
    useLogFile(work.folderPath);
    logFailure("合本の退避に失敗", {
      ファイル: path.basename(filePath),
      詳細: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  await recordEdit(work, {
    actor: "author",
    action: "合本のファイルを話ごとに分けた",
    file: path.basename(filePath),
    detail: `${created.length}件へ分割`,
  });

  const unnumbered = unnumberedCount(plan);
  const notes = [`${created.length}件に分けました。`];
  if (sectionNote) notes.push(sectionNote);
  if (unnumbered > 0) {
    notes.push(
      `${unnumbered}件は話数を読み取れず、並び順で番号を付けました。` +
        "必要ならファイル名を直してください。"
    );
  }
  if (plan.preamble.trim()) {
    notes.push(
      "最初の区切りより前にあった部分（作品の紹介など）は、" +
        "退避した元のファイルに残っています。"
    );
  }
  notes.push(`元のファイルは「${recovery}」にあります。`);

  const answer = await vscode.window.showInformationMessage(
    notes.join(" "),
    "退避先を開く"
  );
  if (answer === "退避先を開く") {
    await revealFolder(recovery);
  }
}

async function confirm(
  filePath: string,
  plan: SplitPlan,
  /** 章をどうするかの一文。章の見出しが無い合本では null（何も足さない） */
  sectionLine: string | null
): Promise<boolean> {
  const preview = plan.parts
    .slice(0, 5)
    .map((part) => `・${part.fileName}`)
    .join("\n");
  const rest =
    plan.parts.length > 5 ? `\n…ほか ${plan.parts.length - 5} 件` : "";
  const unnumbered = unnumberedCount(plan);

  const answer = await vscode.window.showWarningMessage(
    `${path.basename(filePath)} を ${plan.parts.length} 件に分けます。`,
    {
      modal: true,
      detail:
        `${preview}${rest}\n\n` +
        "前書き・後書き・リアクションも、そのまま残します。\n" +
        "元のファイルは消さず、回復用の場所へ移します。\n" +
        (unnumbered > 0
          ? `\n${unnumbered}件は話数を読み取れないため、並び順で番号を付けます。`
          : "") +
        (sectionLine ? `\n${sectionLine}` : ""),
    },
    "分ける"
  );
  return answer === "分ける";
}

/** 分けるときの章の扱いと、保存に使う台帳の中身 */
interface SectionsForSplit {
  plan: SectionPlan;
  /** 読み込んだ台帳。**読めなかった・読んでいないときは null** */
  set: ChapterSet | null;
}

/**
 * 分けたあとで立てる章を決める。**まだ何も書かない。**
 *
 * **章の見出しが無い合本では台帳を読みに行かない。** 読んで壊れていたときの
 * 記録が、章と関係のない分割のたびに残ってしまう。
 */
async function planSectionsForSplit(
  store: ChapterStore,
  work: WorkEntry,
  directory: string,
  plan: SplitPlan
): Promise<SectionsForSplit> {
  const startPathOf = (fileName: string) =>
    episodePathFor(work.folderPath, path.join(directory, fileName));

  const probe = planSplitSections({
    parts: plan.parts,
    existingChapters: [],
    startPathOf,
  });
  if (probe.kind === "none") return { plan: probe, set: null };

  let set: ChapterSet | null = null;
  try {
    set = await store.load();
  } catch (error) {
    // **読めない台帳には書かない**（壊れたJSONを直さない。実装ルール2）。
    // 分割そのものは台帳と関係なく進められるので、止めずに記録だけ残す。
    // 作者には確認画面の一文（「章の台帳を読めなかったため…」）で伝わる
    useLogFile(work.folderPath);
    logFailure("合本の分割で章の台帳を読めなかった", {
      作品: work.title,
      種類: error instanceof ChapterStoreError ? error.kind : "unknown",
      内容: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    plan: planSplitSections({
      parts: plan.parts,
      existingChapters: set ? set.chapters : null,
      startPathOf,
    }),
    set,
  };
}

/**
 * 決めておいた章を台帳へ書く。戻りは作者への一言（書くものが無ければ null）。
 *
 * **書けなくても分割は成り立っている**ので、止めずに伝える。章は
 * あとから作品一覧の右クリック（「ここから章を始める」）で付けられる。
 */
async function saveSections(
  store: ChapterStore,
  work: WorkEntry,
  sections: SectionsForSplit
): Promise<string | null> {
  const { plan, set } = sections;
  if (plan.kind !== "create" || !set) return null;

  const chapters: Chapter[] = [...plan.chapters];
  try {
    await store.save({ ...set, chapters });
    return (
      `章を${chapters.length}個立てました（「${chapters[0].name}」` +
      `${chapters.length > 1 ? "ほか" : ""}）。`
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    useLogFile(work.folderPath);
    logFailure("合本の分割で章を立てられなかった", {
      作品: work.title,
      種類: error instanceof ChapterStoreError ? error.kind : "unknown",
      内容: detail,
    });
    return `章は立てられませんでした（${detail}）。`;
  }
}
