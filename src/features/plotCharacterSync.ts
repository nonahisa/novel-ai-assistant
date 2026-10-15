import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { CharacterStore } from "../core/characterStore";
import { PendingUpdateStore, type PendingUpdate } from "../core/pendingUpdates";
import { parsePlotMarkdown } from "../core/plotDoc";
import { readPlotText } from "../core/plotFile";
import {
  buildPlotCharacterUpdates,
  parsePlotCharacters,
  plotCharactersDigest,
  type PlotCharacterPlan,
  type PlotCharacterSkip,
} from "../core/plotCharacterSync";
import { logFailure, useLogFile } from "../core/logger";
import { readSyncDigest, writeSyncDigest } from "./syncDigest";
import { readRoleRenameOffers } from "./roleRenameOffers";
import { stageCharacterPlan } from "./stageCharacterPlan";

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
  /**
   * 資料の役名の人物を名前に直す案として積んだもの（元の名前 → 名前）。
   * `staged` にも数えてある
   */
  renamed: Array<{ from: string; to: string }>;
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

/**
 * **こちらが自分で保存した plot.md**（場所 → 保存した中身。LF空間）。
 *
 * プロットモードの［入れる］は、plot.md がエディターで開いていれば文書へ当てて保存する
 * （`plotNameSuggest.ts`。ディスクを直に書くと Ctrl+S が「ファイルのほうが新しい」で断られたため）。
 * その保存でも「保存からの反映」が走ると、［入れる］がもう置いた案の上に、同じ保存の反映が
 * 役名だけの人物（ヒロイン・班長）の新規の案と、置いたばかりの直す案への重ね書きを積み、
 * 知らせも1つ増えた（画面テスト plotRenamePending、2026-10-16）。ディスクへ書いていたころは
 * 保存の知らせが出ないので、この反映は走らなかった。**こちらの保存では反映を走らせず、
 * 作者が次に保存したときに走る、という前の振る舞いに揃える。**
 *
 * 時間ではなく**中身で**見分ける。保存の知らせが届く前に作者が打ち足していれば、中身が違うので
 * 反映は走る（作者の書いた分を取りこぼさない）。
 */
const ownPlotSaves = new Map<string, string>();

function ownSaveKey(filePath: string): string {
  return path.pathKeyForComparison(filePath);
}

/** これから自分で保存する plot.md の中身を覚える（保存の前に呼ぶ） */
export function noteOwnPlotSave(filePath: string, lfText: string): void {
  ownPlotSaves.set(ownSaveKey(filePath), lfText);
}

/** 保存できなかったときに忘れる（残すと、作者が同じ中身で保存したときに反映が走らない） */
export function forgetOwnPlotSave(filePath: string): void {
  ownPlotSaves.delete(ownSaveKey(filePath));
}

/**
 * 保存されたのが、こちらが自分で保存した中身か。**当たったら1度きりで忘れる**
 * （次の保存は作者のもの）
 */
export function consumeOwnPlotSave(filePath: string, savedText: string): boolean {
  const key = ownSaveKey(filePath);
  const expected = ownPlotSaves.get(key);
  if (expected === undefined) return false;
  ownPlotSaves.delete(key);
  return expected === savedText.replace(/\r\n?/g, "\n");
}

const EMPTY: PlotCharacterSyncResult = {
  staged: 0,
  creations: [],
  renamed: [],
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

  const store = new PendingUpdateStore(work);
  let plan: PlotCharacterPlan<PendingUpdate>;
  try {
    // **承認待ちも突き合わせる**（設計書6.4.9）。名前を直す案（主人公 →
    // 相馬 誠）が承認待ちのうちは、資料に「相馬 誠」はまだいない。
    // 読めないまま進めると同じ人を新規に積むので、読めなければ止める
    const pending = (await store.loadAll()).updates;
    plan = buildPlotCharacterUpdates(parsed.entries, loaded.characters, pending, {
      // 前に置いた直す案（作者が見送ったもの）は置き直さない
      renameOffered: await readRoleRenameOffers(work),
    });
    // 積み方は相談からの反映（6.72）と同じ部品を通る
    await stageCharacterPlan(work, store, plan, pending, "plot");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // **記録の直前に書き先を向ける**（0.43.3 と同じ）
    useLogFile(work.folderPath);
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

  await writeDigest(work, digest);

  const result: PlotCharacterSyncResult = {
    staged: plan.updates.length + plan.pendingOverlays.length + plan.renames.length,
    creations: plan.creations.map((entry) => entry.name),
    renamed: plan.renames.map((rename) => ({ from: rename.from, to: rename.to })),
    unparsed: parsed.unparsed.length,
    skipped: plan.skipped,
    unchanged: false,
  };
  announce(work, result, options.force ?? false);
  return result;
}

/**
 * 作者へ1行で知らせる。
 *
 * **新しい情報が無ければ何も言わない**（設計書6.4.9）。保存のたびに
 * 「何もありませんでした」と出ると、書いている手が止まる。
 * 自分で押したときだけは、無反応にしないために必ず返事をする。
 * 例外は見送った名前の案があるとき（`announceDeclinedRenames`）。
 */
function announce(
  work: WorkEntry,
  result: PlotCharacterSyncResult,
  force: boolean
): void {
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
        "（「設定資料更新分反映」で確認できます）。"
    );
    // 名前が変わる案は、紹介文の更新とは重さが違う。**どの人の名前を
    // どう直すのか**を、承認の画面を開く前に見えるようにする
    if (result.renamed.length > 0) {
      parts.push(
        `${result.renamed.map((entry) => `${entry.from}→${entry.to}`).join("、")}は、` +
          "資料の人物の名前を直す案です（承認するまで資料は変わりません）。"
      );
    }
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
    if (!force) {
      announceDeclinedRenames(work, result.skipped);
      return;
    }
    void vscode.window.showInformationMessage(
      ["プロットから資料へ反映するものはありませんでした。", ...notes].join("")
    );
    return;
  }

  void vscode.window.showInformationMessage([...parts, ...notes].join(""));
}

/**
 * 作品ごとの、もう出した「置き直していません」の文。VS Code を開いている
 * 間だけ覚える（ディスクには残さない）。
 */
const declinedNoticesShown = new Map<string, Set<string>>();

/**
 * 名前を直す案を見送った作品では、反映するものが無い保存でも一言出す
 * （作者の裁定、2026-10-12）。
 *
 * 黙ると、plot.md に名前を書いたのに資料へ出てこない理由が分からない。
 * ほかの見送り（読めない行など）はこれまでどおり添えるだけにする——
 * それだけで保存のたびに口を開くと、書く手が止まる。
 *
 * **同じ文は、作品ごとに1回の起動で1回だけ。** 見送った案は直さない限り
 * 残り続けるので、欄を直して保存するたびに同じ文が出るとうるさい。
 * 名前を書き換えれば文が変わるので、そのときはもう一度出る。
 */
function announceDeclinedRenames(
  work: WorkEntry,
  skipped: readonly PlotCharacterSkip[]
): void {
  const lines = describeSkipped(
    skipped.filter((entry) => entry.reason === "renameOffered")
  );
  if (lines.length === 0) return;
  const message = ["プロットから資料へ反映するものはありませんでした。", ...lines].join("");
  const shown = declinedNoticesShown.get(work.folderPath) ?? new Set<string>();
  if (shown.has(message)) return;
  shown.add(message);
  declinedNoticesShown.set(work.folderPath, shown);
  void vscode.window.showInformationMessage(message);
}

/**
 * 積まなかった理由を、作者の言葉で1文ずつにする。
 *
 * **相談からの反映（6.72）もこれを使う**（突き合わせの規則が同じなので、
 * 見送りの言い方も揃える。相談の拾い出しは役名を持たないので、
 * 役名の2つの理由は相談からは出てこない）
 */
export function describeSkipped(skipped: readonly PlotCharacterSkip[]): string[] {
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
      `${ambiguous.join("、")}は、同じ呼び名の人物が資料か承認待ちに複数居るため当てられませんでした。`
    );
  }
  // 役名の人物がいるので新規にしなかった（設計書6.4.9）。黙って飛ばすと、
  // 名前を入れたのに資料へ出てこない理由が分からない
  for (const entry of skipped.filter((item) => item.reason === "sameRole")) {
    lines.push(
      `${entry.name}は、設定資料か承認待ちに役名「${entry.role ?? ""}」の人物がいるため、` +
        `新しい人物としては積んでいません（その人物の名前を「${entry.name}」に直すと揃います）。`
    );
  }
  // 前に置いた直す案を見送られた（設計書6.4.9）。置き直さないことを言う
  // ——黙ると、plot.md に名前を書いたのに資料へ出てこない理由が分からない
  for (const entry of skipped.filter((item) => item.reason === "renameOffered")) {
    lines.push(
      `${entry.name}は、役名「${entry.role ?? ""}」の人物の名前を直す案を前に置いたため、` +
        "置き直していません（直す場合は、設定資料でその人物の名前を直してください）。"
    );
  }
  return lines;
}

/**
 * plot.md を**こちらで書き足したあと**、反映済みの印を追いつかせる
 * （設計書6.4.8「名前の候補を出す」）。
 *
 * 名前を選んで「主人公（相馬 誠）」と書き足したときは、同じ人を承認待ちへ
 * 読みつきで置き、役名だけの古い案は片付けてある。印を古いままにすると、
 * 次の保存で同じ人をもう一度積む（読みの無い案で）。
 *
 * **書き足す前の欄が反映済みだったときだけ**印を進める。反映していない
 * 書きかけが欄にあれば、印は進めない——進めるとその書きかけが
 * 一度も積まれないまま「反映済み」になる。
 */
export async function markPlotCharactersSynced(
  work: WorkEntry,
  beforeText: string,
  afterText: string
): Promise<boolean> {
  const digestOf = (text: string): string =>
    plotCharactersDigest(
      parsePlotCharacters(parsePlotMarkdown(text).sections.mainCharacters).entries
    );
  if ((await readDigest(work)) !== digestOf(beforeText)) return false;
  await writeDigest(work, digestOf(afterText));
  return true;
}

/** 前回積んだ節の内容ハッシュ。無い・壊れていれば undefined */
async function readDigest(work: WorkEntry): Promise<string | undefined> {
  return readSyncDigest(work, STATE_FILE, STATE_KEY);
}

async function writeDigest(work: WorkEntry, digest: string): Promise<void> {
  await writeSyncDigest(work, STATE_FILE, STATE_KEY, digest, "プロット反映");
}
