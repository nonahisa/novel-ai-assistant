import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import {
  applyRenumberPlan,
  episodeNumberMoves,
  episodeNumberOf,
  insertedEpisodeFileName,
  planInsertion,
  type RenumberOutcome,
  type RenumberPlan,
} from "../core/episodeRenumber";
import { followEpisodeLedgers } from "./episodeLedgers";
import {
  describeEpisodePlotShiftPreview,
  followEpisodePlots,
  previewEpisodePlotShift,
  type EpisodePlotShiftPreview,
} from "./episodePlotFiles";
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
 * **ブラウザ版でも動く。** `episodeRenumberShared.ts` は `core/git.ts` を静的に読まず、
 * 名前だけのコミット（gitが要る）の中で動的に読む。ブラウザ版ではそのコミットの話だけを
 * 省く（`browserReach.test.ts` が、このファイルから Node専用へ届かないことを見張る）。
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
        "先に「話ごとのファイルに分ける」をお試しください。"
    );
    return { changed: false };
  }

  // **同じフォルダーの話だけを動かす**（設計書6.67.4）。番外編や下書きは
  // 独自の番号で並んでいるので、巻き込むと作者が触っていない番号がずれる
  const prepared = await prepareInsertion(
    work,
    episodes,
    pivot,
    path.dirname(episode.filePath)
  );
  if (!prepared.ok) {
    void vscode.window.showErrorMessage(prepared.message);
    return { changed: false };
  }
  const { plan, plotPreview } = prepared;

  const fileName = await askNewEpisodeFileName(pivot, episode.fileName);
  if (!fileName) return { changed: false };

  const plotDetail = plotPreview ? describeEpisodePlotShiftPreview(plotPreview) : "";
  const answer = await vscode.window.showWarningMessage(
    `第${pivot}話以降の${plan.renames.length}件の話数を付け替えます。`,
    {
      modal: true,
      detail: [describeRenumberTargets(work, plan), plotDetail]
        .filter((line) => line.length > 0)
        .join("\n"),
    },
    "付け替える"
  );
  if (answer !== "付け替える") return { changed: false };

  return runInsertion(work, episodes, prepared, {
    filePath: path.join(path.dirname(episode.filePath), fileName),
    bytes: new TextEncoder().encode(""),
    commitMessage: `第${pivot}話を挿入したため、第${pivot}話以降の話数を調整`,
  });
}

/** 付け替えを始めてよいと確かめた計画（`prepareInsertion` の答え） */
export interface PreparedInsertion {
  readonly ok: true;
  readonly pivot: number;
  readonly plan: RenumberPlan;
  readonly plotPreview: EpisodePlotShiftPreview | undefined;
}

/**
 * 1話ぶん割り込ませる計画を立て、**始めてよいか**を確かめる（設計書6.67.4）。
 *
 * 訊く窓は呼ぶ側が持つ（「この話の前に挿入」はサブタイトルと付け替えの確認、
 * 原稿エディターの取り込みは3つの選び方の窓。設計書6.25.13）。確かめることは
 * 2つの道で同じなので、ここに1つだけ置く。**まだ何も動かさない。**
 *
 * @returns 断るときは、作者に見せる理由
 */
export async function prepareInsertion(
  work: WorkEntry,
  episodes: readonly EpisodeFile[],
  pivot: number,
  folder: string
): Promise<PreparedInsertion | { readonly ok: false; readonly message: string }> {
  const plan = planInsertion(episodes, pivot, folder);

  const conflicted = findConflictedEpisodes(episodes, plan.renames);
  if (conflicted.length > 0) {
    return {
      ok: false,
      message:
        `競合マーカーの残る話（${conflicted
          .map((e) => e.fileName)
          .join("、")}）が付け替えの範囲に含まれるため、挿入を取りやめました。` +
        "先に競合を解決してください。",
    };
  }
  if (plan.collisions.length > 0) {
    return {
      ok: false,
      message:
        "付け替え先の名前がぶつかるため、挿入を取りやめました：" +
        plan.collisions.map((c) => c.toFileName).join("、"),
    };
  }

  /*
    **未保存のまま開かれている話があれば、始めない**（設計書6.67.2）。
    名前を変えたあとにその編集が保存されると、VS Codeは**元の名前**へ
    書き出す。同じ内容の話が2つに増え、どちらが本物か分からなくなる。
  */
  const unsaved = findUnsavedEpisodes(plan.renames.map((r) => r.fromPath));
  if (unsaved.length > 0) {
    return {
      ok: false,
      message:
        `未保存の変更がある話（${unsaved.join("、")}）が付け替えの範囲に含まれます。` +
        "保存してからやり直してください。",
    };
  }

  /*
    単話プロットも一緒にずらす（作者の裁定、2026-09-23）。**未保存で開いて
    いれば始めない**——名前を変えたあとに保存されると、元の話数の名前で
    作り直され、同じ話のプロットが2つになる（本文と同じ理由）。
  */
  const plotPreview = await previewPlotShift(work, episodes, plan, pivot);
  const unsavedPlots = plotPreview
    ? findUnsavedEpisodes(plotPreview.touchedPaths)
    : [];
  if (unsavedPlots.length > 0) {
    return {
      ok: false,
      message:
        `未保存の変更がある単話プロット（${unsavedPlots.join("、")}）の話数も付け替えることになります。` +
        "保存してからやり直してください。",
    };
  }
  return { ok: true, pivot, plan, plotPreview };
}

/**
 * 確かめた計画どおりに付け替え、空いた番号へ新しい話を作る。
 *
 * **途中で止まったら新しい話は作らない**（どこまで済んだかは
 * `reportRenumberOutcome` が出す）。中止（`isCancelled`）も同じ止まり方に乗せる
 * ——次の1件を動かす前に見て、そこで止める。済んだ分は戻さない（本文は
 * 1文字も失われず、番号が1つ飛ぶだけ。6.67.2）。
 */
export async function runInsertion(
  work: WorkEntry,
  episodes: readonly EpisodeFile[],
  prepared: PreparedInsertion,
  newEpisode: {
    /** 作る話の場所（付け替えで空いた番号の名前） */
    readonly filePath: string;
    /** 中身。「この話の前に挿入」は空、取り込みは取り込んだ文 */
    readonly bytes: Uint8Array;
    /** 名前だけの独立コミットの言葉 */
    readonly commitMessage: string;
  },
  options: { readonly isCancelled?: () => boolean } = {}
): Promise<InsertEpisodeResult & { stoppedAt?: RenumberOutcome["stoppedAt"] }> {
  const { plan, pivot } = prepared;
  const outcome = await applyRenumberPlan(plan, async (from, to) => {
    if (options.isCancelled?.()) throw new Error("中止しました");
    await vscode.workspace.fs.rename(path.toUri(from), path.toUri(to), {
      overwrite: false,
    });
  });

  // **台帳は「実際に動いた話」だけを追う**（設計書6.67.3）。途中で止まった
  // 分まで動かすと、原稿と台帳が食い違う
  const summary = await followEpisodeLedgers(work, outcome.done);
  const plots = await followEpisodePlots(work, {
    episodes,
    moved: episodeNumberMoves(outcome.done),
    delta: 1,
    pivot,
    completed: !outcome.stoppedAt,
  });
  summary.episodePlots = plots.shifted;
  summary.failures.push(...plots.failures);

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
    return { changed: outcome.done.length > 0, stoppedAt: outcome.stoppedAt };
  }

  const created = await createEpisodeFile(newEpisode.filePath, newEpisode.bytes);

  // **挿入した新しい話のファイルは、名前だけのコミットに入れない**（設計書6.67.1）。
  // `outcome.done` には付け替え（旧→新パス）しか入っておらず、新規作成した
  // ファイルは含まれないので、そのまま渡してよい
  await offerIndependentRenameCommit(work, outcome.done, newEpisode.commitMessage);

  return {
    changed: true,
    newFilePath: created ? newEpisode.filePath : undefined,
  };
}

/**
 * 単話プロットの見込み。**読めなくても本文の差し込みは止めない**——
 * 単話プロットは本文に従うもので、置き場の都合で本文を止める理由は無い。
 * 読めなかったことは、付け替えのあとの追従（`followEpisodePlots`）が
 * 失敗として知らせる。
 */
async function previewPlotShift(
  work: WorkEntry,
  episodes: readonly EpisodeFile[],
  plan: RenumberPlan,
  pivot: number
): Promise<EpisodePlotShiftPreview | undefined> {
  try {
    return await previewEpisodePlotShift(work, {
      episodes,
      moved: new Map(plan.renames.map((r) => [r.oldNumber, r.newNumber])),
      delta: 1,
      pivot,
    });
  } catch {
    return undefined;
  }
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
 * 新しい話を1つ作る（「この話の前に挿入」は空、取り込みは取り込んだ文）。
 * **既にあれば作らない**（上書きしない）。
 *
 * `atomicWriteFile` の `mode: "create"` を通すのは、存在の確認と作成の
 * あいだに割り込まれても既存のファイルを潰さないためである
 * （CLAUDE.mdの実装ルール2の②）。
 */
async function createEpisodeFile(filePath: string, bytes: Uint8Array): Promise<boolean> {
  try {
    await atomicWriteFile(filePath, bytes, {
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
