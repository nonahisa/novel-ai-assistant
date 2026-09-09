import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import {
  applyRenumberPlan,
  episodeNumberOf,
  insertedEpisodeFileName,
  planInsertion,
} from "../core/episodeRenumber";
import { followEpisodeLedgers } from "./episodeLedgers";
import {
  describeRenumberTargets,
  findConflictedEpisodes,
  findUnsavedEpisodes,
  offerIndependentRenameCommit,
  reportRenumberOutcome,
} from "./episodeRenumberShared";
import { askText } from "../views/dialogs";
import { atomicWriteFile } from "../core/atomicWrite";
import { pathExists } from "../core/fileSystem";

/**
 * この話の前に1話ぶん割り込ませる（設計書6.67.4）。
 *
 * **`../core/git.js` を静的importする `episodeRenumberShared.ts` を使う。**
 * そのため `extension.ts` からは必ず動的import（`await import(...)`）で
 * 呼ぶこと——静的importするとNode専用の口（`node:child_process`）がブラウザ
 * 版の起動時に巻き込まれる（設計書5.8.5）。
 */

export interface InsertEpisodeResult {
  /** 作品一覧を更新する必要があるか */
  changed: boolean;
  /**
   * **新しく作った話**のパス。呼び出し側が執筆量の基準を置き直し、
   * 原稿エディタで開くために使う（`addEpisode` と同じ流儀）。
   *
   * **作れなかったときは必ず undefined。** 同じ名前のファイルが既にあった
   * ときにここへその場所を入れると、**作者の既存の原稿が「いま作った話」
   * として開かれる**（そこへ書き足されると取り返しがつかない）。
   */
  newFilePath?: string;
}

export async function insertEpisodeBefore(
  work: WorkEntry,
  episode: EpisodeFile,
  episodes: readonly EpisodeFile[]
): Promise<InsertEpisodeResult> {
  const pivot = episodeNumberOf(episode.fileName);
  if (pivot === null) {
    void vscode.window.showWarningMessage(
      `「${episode.fileName}」は話数を持たないため、前に挿入できません。`
    );
    return { changed: false };
  }
  if ((episode.collectedCount ?? 0) > 1) {
    // 合本の中には何話も入っている。その前に1話足しても、中の話数とは合わない
    void vscode.window.showWarningMessage(
      `「${episode.fileName}」は複数の話がまとまったファイル（合本）です。` +
        "先に「合本を話ごとに分ける」をお試しください。"
    );
    return { changed: false };
  }

  // **同じフォルダーの話だけを動かす**（設計書6.67.4）。番外編や下書きは
  // 独自の番号で並んでいるので、巻き込むと作者が触っていない番号がずれる
  const plan = planInsertion(episodes, pivot, path.dirname(episode.filePath));

  const conflicted = findConflictedEpisodes(episodes, plan.renames);
  if (conflicted.length > 0) {
    void vscode.window.showErrorMessage(
      `競合マーカーの残る話（${conflicted
        .map((e) => e.fileName)
        .join("、")}）が付け替えの範囲に含まれるため、挿入を取りやめました。` +
        "先に競合を解決してください。"
    );
    return { changed: false };
  }
  if (plan.collisions.length > 0) {
    void vscode.window.showErrorMessage(
      "付け替え先の名前がぶつかるため、挿入を取りやめました：" +
        plan.collisions.map((c) => c.toFileName).join("、")
    );
    return { changed: false };
  }

  /*
    **未保存のまま開かれている話があれば、始めない**（設計書6.67.2）。
    名前を変えたあとにその編集が保存されると、VS Codeは**元の名前**へ
    書き出す。同じ内容の話が2つに増え、どちらが本物か分からなくなる。
  */
  const unsaved = findUnsavedEpisodes(plan.renames.map((r) => r.fromPath));
  if (unsaved.length > 0) {
    void vscode.window.showErrorMessage(
      `未保存の変更がある話（${unsaved.join("、")}）が付け替えの範囲に含まれます。` +
        "保存してからやり直してください。"
    );
    return { changed: false };
  }

  const fileName = await askNewEpisodeFileName(pivot, episode.fileName);
  if (!fileName) return { changed: false };

  const answer = await vscode.window.showWarningMessage(
    `第${pivot}話以降の${plan.renames.length}件の話数を付け替えます。`,
    { modal: true, detail: describeRenumberTargets(work, plan) },
    "付け替える"
  );
  if (answer !== "付け替える") return { changed: false };

  const outcome = await applyRenumberPlan(plan, async (from, to) => {
    await vscode.workspace.fs.rename(path.toUri(from), path.toUri(to), {
      overwrite: false,
    });
  });

  // **台帳は「実際に動いた話」だけを追う**（設計書6.67.3）。途中で止まった
  // 分まで動かすと、原稿と台帳が食い違う
  const summary = await followEpisodeLedgers(work, outcome.done);

  reportRenumberOutcome({
    action: "挿入",
    pivot,
    outcome,
    summary,
    emptyDetail:
      plan.skipped.length > 0
        ? "動かせる話が無かったため付け替えなし"
        : "後ろに話が無いため付け替えなし",
  });

  if (outcome.stoppedAt) {
    // **途中で止まったら新しい話は作らない。** 目当ての番号の場所が
    // まだ空いているとは限らず（止まった箇所より手前は動いていない）、
    // 中途半端な状態に新規作成まで重ねると余計に分かりにくくなる
    return { changed: outcome.done.length > 0 };
  }

  const newFilePath = path.join(path.dirname(episode.filePath), fileName);
  const created = await createEmptyEpisode(newFilePath);

  // **挿入した新しい話のファイルは、名前だけのコミットに入れない**（設計書6.67.1）。
  // `outcome.done` には付け替え（旧→新パス）しか入っておらず、新規作成した
  // ファイルは含まれないので、そのまま渡してよい
  await offerIndependentRenameCommit(
    work,
    outcome.done,
    `第${pivot}話を挿入したため、第${pivot}話以降の話数を調整`
  );

  return { changed: true, newFilePath: created ? newFilePath : undefined };
}

/**
 * 新しい話のファイル名を決める（設計書6.67.4）。
 *
 * **番号は訊かない。** 挿入する位置がそのまま話数であり、作者が別の番号を
 * 入れられるようにすると、いま空けたばかりの場所と食い違う。訊くのは
 * サブタイトルだけである。
 *
 * **番号の書き方・区切り・拡張子は、隣の話（挿入位置に居た話）に合わせる。**
 * 作品のファイル名の流儀は、作品自身がいちばん知っている——設定
 * （桁数・拡張子）は、まだ話が1つも無いときの初期値である。
 *
 * @returns 決まったファイル名。取りやめたら undefined（**空のサブタイトルは
 *   取りやめではない**——番号だけのファイル名になる）
 */
async function askNewEpisodeFileName(
  pivot: number,
  neighborFileName: string
): Promise<string | undefined> {
  const cfg = vscode.workspace.getConfiguration("novelai");
  const fallback = {
    digits: cfg.get<number>("episodeNumberDigits", 3),
    extension: cfg.get<string>("episodeFileExtension", ".txt"),
  };
  const nameOf = (subtitle: string) =>
    insertedEpisodeFileName({
      neighborFileName,
      number: pivot,
      subtitle,
      fallback,
    });

  const subtitle = await askText({
    title: "この話の前に挿入",
    prompt:
      `第${pivot}話のサブタイトル（無ければ空のまま）。` +
      `ファイル名は「${nameOf("サブタイトル")}」の形になります`,
    value: "",
    validateInput: (value) => {
      // 使えない記号は `sanitizeFileName` が全角へ落とすので、ここでは
      // 長さだけを見る（作者の書いた文字を黙って捨てないため）
      if (value.length > 80) return "サブタイトルが長すぎます";
      return null;
    },
  });
  if (subtitle === undefined) return undefined;
  return nameOf(subtitle);
}

/**
 * 空の話を1つ作る。**既にあれば作らない**（上書きしない）。
 *
 * `atomicWriteFile` の `mode: "create"` を通すのは、存在の確認と作成の
 * あいだに割り込まれても既存のファイルを潰さないためである
 * （CLAUDE.mdの実装ルール2の②）。
 */
async function createEmptyEpisode(filePath: string): Promise<boolean> {
  try {
    await atomicWriteFile(filePath, new TextEncoder().encode(""), {
      mode: "create",
    });
    return true;
  } catch (error) {
    const detail = (await pathExists(filePath))
      ? "同じ名前のファイルがすでにあります。"
      : error instanceof Error
        ? error.message
        : String(error);
    void vscode.window.showErrorMessage(
      `新しい話のファイルは作れませんでした（${detail}）。` +
        "話数の付け替え自体は完了しています。"
    );
    return false;
  }
}
