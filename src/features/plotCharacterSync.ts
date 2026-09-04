import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { CharacterStore } from "../core/characterStore";
import { PendingUpdateStore } from "../core/pendingUpdates";
import { parsePlotMarkdown } from "../core/plotDoc";
import { readPlotText } from "../core/plotFile";
import {
  buildNewCharacterRecords,
  buildPlotCharacterUpdates,
  parsePlotCharacters,
  plotCharactersDigest,
  type PlotCharacterSkip,
} from "../core/plotCharacterSync";
import { logFailure } from "../core/logger";
import { readSyncDigest, writeSyncDigest } from "./syncDigest";

/**
 * plot.md の「主要登場人物」を、設定資料の更新案として積む（設計書6.4.9）。
 *
 * ## 黙って書き換えない
 *
 * プロットも設定資料も**両方とも作者のデータ**である。片方をもう片方で
 * 上書きしてよい理由は無い。だから反映は**承認待ち（`PendingUpdateStore`）
 * へ積むだけ**で、台帳へ入るのは作者が「更新分を反映」で承認したときだけ。
 * **抽出とまったく同じ道**を通る——新しい反映経路を作らない。
 *
 * ## 同じ提案を二度積まない
 *
 * 保存のたびに同じ行が増える提案パネルは、読まれなくなる。前回積んだ節の
 * 内容ハッシュを `.aiwriter/plot-sync.json` に覚え、変わったときだけ積む。
 *
 * 覚え書きの読み書きそのものは `syncDigest.ts` が持つ（相談からの反映
 * （6.72）と同じ仕掛けなので、2か所に書かない）。
 */

const STATE_FILE = "plot-sync.json";
/** 覚え書きの中の項目名。**変えると、既に反映済みの環境が積み直す** */
const STATE_KEY = "mainCharactersDigest";

export interface PlotCharacterSyncResult {
  /** 承認待ちへ積んだ件数 */
  staged: number;
  /** 資料にまだ無い名前 */
  creations: string[];
  /** 読めなかった行の数 */
  unparsed: number;
  /** 積まなかったものと理由 */
  skipped: PlotCharacterSkip[];
  /** 前回から変わっていないので、何もしなかった */
  unchanged: boolean;
}

export interface PlotCharacterSyncOptions {
  /**
   * いま画面に出ている plot.md の中身。**開いていればそちらが正しい**
   * （パネルのボタンから呼ぶときに渡す）。省略するとディスクを読む
   */
  plotText?: string;
  /**
   * 作者が自分で押した。ダイジェストが同じでも積み直し、
   * 積むものが無ければ「無かった」と知らせる（押したのに無反応にしない）
   */
  force?: boolean;
}

const EMPTY: PlotCharacterSyncResult = {
  staged: 0,
  creations: [],
  unparsed: 0,
  skipped: [],
  unchanged: false,
};

export async function syncPlotCharacters(
  work: WorkEntry,
  options: PlotCharacterSyncOptions = {}
): Promise<PlotCharacterSyncResult> {
  const text = options.plotText ?? (await readPlotText(work));
  const section = parsePlotMarkdown(text).sections.mainCharacters;
  const parsed = parsePlotCharacters(section);

  const digest = plotCharactersDigest(parsed.entries);
  const previous = await readDigest(work);
  if (!options.force && digest === previous) {
    return { ...EMPTY, unchanged: true };
  }

  const loaded = await new CharacterStore(work).loadAll();
  if (loaded.errors.length > 0) {
    // 読めない人物設定があるまま突き合わせると、「資料に居ない」と
    // 判断して同じ人物の新規案を出してしまう。覚え書きも残さない
    // （直したあとの保存で、もう一度やり直せるようにする）
    void vscode.window.showWarningMessage(
      `読み込めない人物設定が ${loaded.errors.length} 件あるため、` +
        "プロットからの反映を見送りました。"
    );
    return { ...EMPTY };
  }

  const plan = buildPlotCharacterUpdates(parsed.entries, loaded.characters);

  if (plan.updates.length > 0 || plan.creations.length > 0) {
    try {
      const store = new PendingUpdateStore(work);
      // 出どころを添えて積む。AIの読みと、作者が書いた文とでは、
      // 承認するときの見方が変わる
      if (plan.updates.length > 0) {
        await store.stage(plan.updates, { source: "plot" });
      }
      // 資料にまだ無い人は**新規の人物案**として積む。台帳へは書かない
      // ——承認したときに `applyPendingUpdates` が採番して作る
      if (plan.creations.length > 0) {
        await store.stage(buildNewCharacterRecords(plan.creations), {
          source: "plot",
          kind: "creation",
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logFailure("プロットから人物の更新案を積めませんでした", {
        作品: work.title,
        詳細: detail,
      });
      void vscode.window.showWarningMessage(
        `プロットからの更新案を保留できませんでした: ${detail}`
      );
      // 覚え書きを残さない。次の保存でもう一度試す
      return { ...EMPTY };
    }
  }

  await writeDigest(work, digest);

  const result: PlotCharacterSyncResult = {
    staged: plan.updates.length,
    creations: plan.creations.map((entry) => entry.name),
    unparsed: parsed.unparsed.length,
    skipped: plan.skipped,
    unchanged: false,
  };
  announce(result, options.force ?? false);
  return result;
}

/**
 * 作者へ1行で知らせる。
 *
 * **新しい情報が無ければ何も言わない**（設計書6.4.9）。保存のたびに
 * 「何もありませんでした」と出ると、書いている手が止まる。
 * 自分で押したときだけは、無反応にしないために必ず返事をする。
 */
function announce(result: PlotCharacterSyncResult, force: boolean): void {
  const parts: string[] = [];
  const created = result.creations.length;
  const total = result.staged + created;

  if (total > 0) {
    // **新規と更新は分けて数える。** 「更新案」とだけ言うと、
    // 資料に人が増える提案が混ざっていることが伝わらない
    const detail =
      created === 0
        ? "更新案"
        : result.staged === 0
          ? "新規案"
          : `案（新規${created}件・更新${result.staged}件）`;
    parts.push(
      `プロットから人物${total}件の${detail}を積みました` +
        "（「更新分を反映」で確認できます）。"
    );
  }

  // **拾えなかったものを黙って捨てない。** ただし、これだけのときに
  // 保存のたび口を開くと書く手が止まるので、添えるのは何か言うときだけ
  const notes: string[] = [];
  if (result.unparsed > 0) {
    notes.push(
      `${result.unparsed}行は読めませんでした（「- 名前：説明」の形なら読めます）。`
    );
  }
  notes.push(...describeSkipped(result.skipped));

  if (parts.length === 0) {
    if (!force) return;
    void vscode.window.showInformationMessage(
      ["プロットから資料へ反映するものはありませんでした。", ...notes].join("")
    );
    return;
  }

  void vscode.window.showInformationMessage([...parts, ...notes].join(""));
}

/** 積まなかった理由を、作者の言葉で1文ずつにする */
function describeSkipped(skipped: readonly PlotCharacterSkip[]): string[] {
  const lines: string[] = [];
  const confirmed = skipped
    .filter((entry) => entry.reason === "authorConfirmed")
    .map((entry) => entry.name);
  const ambiguous = skipped
    .filter((entry) => entry.reason === "ambiguous")
    .map((entry) => entry.name);

  if (confirmed.length > 0) {
    lines.push(
      `${confirmed.join("、")}は、作者が確定させた人物なので変えていません。`
    );
  }
  if (ambiguous.length > 0) {
    lines.push(
      `${ambiguous.join("、")}は、同じ呼び名の人物が資料に複数居るため当てられませんでした。`
    );
  }
  return lines;
}

/** 前回積んだ節の内容ハッシュ。無い・壊れていれば undefined */
async function readDigest(work: WorkEntry): Promise<string | undefined> {
  return readSyncDigest(work, STATE_FILE, STATE_KEY);
}

async function writeDigest(work: WorkEntry, digest: string): Promise<void> {
  await writeSyncDigest(work, STATE_FILE, STATE_KEY, digest, "プロット反映");
}
