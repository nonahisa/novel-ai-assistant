import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import {
  missingPrerequisites,
  prerequisiteInfo,
  type DegradingPrerequisiteInfo,
  type Prerequisite,
  type PrerequisiteInfo,
} from "../core/prerequisites";
import {
  hasEpisodePlotFile,
  hasSettingsRecords,
  hasSynopsisEpisodes,
  hasWrittenPlot,
} from "../core/prerequisiteCheck";
import { CharacterStore } from "../core/characterStore";
import { createLocationStore, createWorldStore } from "../core/abilityStore";
import { SynopsisStore } from "../core/synopsisStore";
import { readPlotText } from "../core/plotFile";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import {
  EPISODE_PLOTS_DIR,
  episodePlotChapterFromFileName,
} from "../core/resumeSheet";
import {
  episodePlotShortfall,
  judgeEpisodePlotText,
  type EpisodePlotJudgement,
} from "../core/episodePlotDoc";
import { readTextFile } from "../core/textFile";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { findAction, type ActionItem } from "../views/actionList";
import { logFailure, useLogFile } from "../core/logger";

/**
 * 前提（設定資料・あらすじ・プロット・単話プロット）が揃っているかを見て、
 * 足りなければ**進める道だけ**を出す関門（設計書6.94）。
 *
 * 作者の要望（2026-09-18）は2つある。「相談チャットで順路を教えたり
 * できますか」と、「代替で実行できるようにもしてください」。後者が肝で、
 * **代わりの道は、名前を出すだけでなくその場で走れる**ようにしてある。
 *
 * ## 走らない道は並べない
 *
 * 前提には「無いと走れない（`blocking`）」と「走るが質が落ちる
 * （`degrades`）」がある。前者で「このまま実行する」を出すと、押した先で
 * 機能の側が同じ案内をもう一度出して終わる——**動かないものを勧めることに
 * なる。** だから `blocking` が1つでも欠けているときは、その道を出さない。
 *
 * ## 揃っていれば何も出さない
 *
 * 確認は増やさない。押した操作がそのまま動くのがいちばん速い。
 *
 * ## 「以降は訊かない」には乗せない（設計書6.89）
 *
 * 前提は作品ごとに変わる。一度の選択で固めると、別の作品で黙って
 * 素通りし、照らし合わせる相手が無いまま走ることになる。
 */

/** 関門の答え。`proceed` なら、押した操作をそのまま走らせてよい */
export type PrerequisiteDecision = "proceed" | "handled";

/**
 * 揃っている前提を数える。
 *
 * **要るものだけ見る。** 押すたびに設定資料・あらすじ・プロットを
 * 全部読むと、前提の無い操作まで遅くなる。
 *
 * **読めなかったものは「揃っている」扱いにする。** 壊れたJSONを
 * 「無い」と読むと、この関門が毎回立ちはだかる。壊れていることは
 * 機能の側が読んだときに正しく報告する（そちらが本来の持ち場である）。
 */
export async function collectPresentPrerequisites(
  work: WorkEntry,
  needs: readonly Prerequisite[]
): Promise<ReadonlySet<Prerequisite>> {
  const present = new Set<Prerequisite>();
  for (const kind of new Set(needs)) {
    if (await hasPrerequisite(work, kind)) present.add(kind);
  }
  return present;
}

async function hasPrerequisite(
  work: WorkEntry,
  kind: Prerequisite
): Promise<boolean> {
  try {
    if (kind === "settings") return await hasSettings(work);
    if (kind === "synopsis") {
      return hasSynopsisEpisodes(
        (await new SynopsisStore(work).load()).episodes.length
      );
    }
    if (kind === "plot") return hasWrittenPlot(await readPlotText(work));
    return await hasEpisodePlot(work);
  } catch (error) {
    // 読めないことを理由に作者の手を止めない（上の説明のとおり）。
    // ただし黙らない——毎回この判定が効かないなら、記録に痕跡が要る。
    // 記録の直前に書き先を作品へ向ける（この作品の決まり）
    useLogFile(work.folderPath);
    logFailure("前提の確認", {
      前提: kind,
      理由: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

/**
 * 設定資料があるか。**読むのがここの仕事で、数え方は
 * `core/prerequisiteCheck.ts` が持つ**——同じ規則を外部AIの口（MCP）も
 * 使うので、写しを作らない。
 */
async function hasSettings(work: WorkEntry): Promise<boolean> {
  const [characters, locations, world] = await Promise.all([
    new CharacterStore(work).loadAll(),
    createLocationStore(work).loadAll(),
    createWorldStore(work).loadAll(),
  ]);
  return hasSettingsRecords({
    characters: characters.characters,
    locationCount: locations.records.length,
    worldCount: world.records.length,
  });
}

/** 単話プロットの置き場の様子。ファイルの有無だけでなく、中身まで見る */
interface EpisodePlotStatus {
  /** 揃っていない理由。揃っていれば undefined */
  shortfall: string | undefined;
  /** ひな形のままのファイル（開いて書いてもらう先）。話数の順 */
  unwrittenFiles: string[];
}

/**
 * 単話プロットが揃っているか。**中身まで見る**（2026-10-01、作者の裁定）。
 *
 * 以前はファイルが1つでもあれば通していたので、作っただけで展開が空の
 * ひな形でも先へ進み、機能の側のモーダルで初めて断られていた。外部AIの口
 * （`novel.scan`・`novel.prompt`）は中身まで見ていたので、**判定は同じ関数**
 * （`core/episodePlotDoc.ts` の `judgeEpisodePlotText`・`episodePlotShortfall`）を通す。
 *
 * **粗さは変えない。1つでも書かれていれば通す。** どの話を検査するかは関門を
 * 抜けたあとに選ばせる作りで、関門の時点では「第何話ぶんが要るか」がまだ
 * 決まっていない（2026-09-18 の裁定）。選んだ話が空なら `checkEpisodePlot.ts`
 * が正しく断る。**読めないファイルは「揃っている」扱い**（6.94.6）。
 */
async function readEpisodePlotStatus(
  work: WorkEntry
): Promise<EpisodePlotStatus> {
  const config = await readWorkConfig(work);
  const directory = path.join(
    workPaths(work, config).settings,
    EPISODE_PLOTS_DIR
  );
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(path.toUri(directory));
  } catch {
    // 置き場そのものが無い＝1つも作っていない。記録には残さない
    return { shortfall: episodePlotShortfall([]), unwrittenFiles: [] };
  }
  const names = entries
    .filter(([, type]) => type === vscode.FileType.File)
    .map(([name]) => name)
    // 何を単話プロットと数えるかは `core/prerequisiteCheck.ts` の規則
    .filter((name) => hasEpisodePlotFile([name]))
    .sort(
      (a, b) =>
        (episodePlotChapterFromFileName(a) ?? Number.MAX_SAFE_INTEGER) -
          (episodePlotChapterFromFileName(b) ?? Number.MAX_SAFE_INTEGER) ||
        a.localeCompare(b)
    );

  const judged: Array<EpisodePlotJudgement & { plotPath: string; file: string }> =
    [];
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      judged.push({
        plotPath: name,
        file,
        ...judgeEpisodePlotText((await readTextFile(file)).text),
      });
    } catch {
      // 読めないことを理由に止めない（`hasPrerequisite` の決まり）
      judged.push({ plotPath: name, file, written: null });
    }
  }
  return {
    shortfall: episodePlotShortfall(judged),
    unwrittenFiles: judged
      .filter((entry) => entry.written === false)
      .map((entry) => entry.file),
  };
}

async function hasEpisodePlot(work: WorkEntry): Promise<boolean> {
  return (await readEpisodePlotStatus(work)).shortfall === undefined;
}

/**
 * ひな形のままの単話プロットで止め、書く場所（そのファイル）へ案内する。
 *
 * **「作る」道は出さない。** ファイルは既にある——作り直しても同じひな形が
 * 増えるだけで、作者に要るのは「ここへ書く」である。
 *
 * @returns 作者がファイルを開いたか
 */
export async function stopForUnwrittenEpisodePlot(
  shortfall: string,
  file: string
): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    "単話プロットの展開がまだ書かれていません。",
    { modal: true, detail: `${shortfall}\n「展開（箇条書き）」を書いてから実行してください。` },
    UNWRITTEN_OPEN_LABEL
  );
  if (answer !== UNWRITTEN_OPEN_LABEL) return false;
  await vscode.commands.executeCommand("vscode.open", path.toUri(file));
  return true;
}

export const UNWRITTEN_OPEN_LABEL = "単話プロットのファイルを開く";

/**
 * 押した操作の前提を見て、足りなければ道を出す。
 *
 * @returns `proceed` なら、呼び出し側は押された操作をそのまま走らせる
 */
export async function checkPrerequisites(
  item: ActionItem,
  work: WorkEntry
): Promise<PrerequisiteDecision> {
  const needs = item.needs ?? [];
  if (needs.length === 0) return "proceed";

  const present = await collectPresentPrerequisites(work, needs);
  const missing = missingPrerequisites(needs, present);
  // 揃っていれば何も出さない。余計な確認を増やさない
  if (missing.length === 0) return "proceed";

  // 先に作るべきものが無いときに限り、ひな形のままの単話プロットは
  // 「作る」ではなく「書く」へ案内する（ファイルは既にある）
  if (missing[0] === "episodePlot") {
    const status = await readEpisodePlotStatus(work);
    if (status.shortfall && status.unwrittenFiles.length > 0) {
      await stopForUnwrittenEpisodePlot(
        status.shortfall,
        status.unwrittenFiles[0]
      );
      return "handled";
    }
  }

  return await askPrerequisiteRoute(item, work, missing);
}

/** 選択肢の見分け。ラベルの文字列で比べない（言い回しを変えると壊れる） */
type GateChoice =
  | { readonly act: "make"; readonly kind: Prerequisite }
  | { readonly act: "instead" }
  | { readonly act: "anyway" };

/** 選択肢の1つ。「取りやめる」も同じ形で並べる（`choice` を持たないだけ） */
type GateItem = vscode.QuickPickItem & { choice?: GateChoice };

/**
 * 画面に並べる道を組む。**ファイルもコマンドも触らない。**
 *
 * `askPrerequisiteRoute` から切り出してある。何が並ぶかは作品が無くても
 * 決まる話なので、ここだけなら前提の種類を作って直接測れる——実機でしか
 * 試せない部分を減らすための分け方である。
 *
 * **「このまま実行する」を出す条件がここにある。** 足りないものが
 * すべて `degrades`（無くても走る）のときだけ出す。1つでも `blocking` が
 * 混じっていれば、進んでも機能の側が断って終わるので出さない。
 */
export function prerequisiteRoute(input: {
  readonly actionLabel: string;
  readonly missing: readonly PrerequisiteInfo[];
  readonly alternative?: { readonly label: string; readonly why: string };
}): { readonly title: string; readonly items: readonly GateItem[] } {
  // 足りないものが複数あっても、作るのは1つずつ。作者が順に片づけられる
  const first = input.missing[0];
  const items: GateItem[] = [
    {
      label: `いま「${first.makeLabel}」を実行する`,
      detail: `作り終えたら、続けて「${input.actionLabel}」を実行するか訊きます`,
      choice: { act: "make", kind: first.kind },
    },
  ];

  // 代わりの道が無い操作では、2つ目を出さない
  if (input.alternative) {
    items.push({
      label: `代わりに「${input.alternative.label}」を使う`,
      detail: input.alternative.why,
      choice: { act: "instead" },
    });
  }

  const degrades = input.missing.filter(
    (info): info is DegradingPrerequisiteInfo => info.severity === "degrades"
  );
  if (degrades.length === input.missing.length) {
    items.push({
      label: `このまま「${input.actionLabel}」を実行する`,
      // 何が起きるかを一文で断る。黙って走らせない
      detail: degrades[0].withoutWarning,
      choice: { act: "anyway" },
    });
  }

  return {
    /*
      **見出しは事実だけにする**（作者の裁定 2026-09-18）。走らない操作では
      道が「作る」と「取りやめる」の2つしか無く、そこで「どうしますか」の
      調子を強めても選べるものは増えない。何が足りないかだけを告げる。
    */
    title: `「${input.actionLabel}」には${names(input.missing)}が要ります`,
    items,
  };
}

/**
 * 足りない前提を告げて、道を選ばせる。
 *
 * **判定と切り離して公開してある。** 揃っているかを見るにはファイルが
 * 要るが、道の出し方（何が並ぶか・選んだら何が走るか）は作品が無くても
 * 確かめられる。実機でしか試せない部分を減らすための分け方である。
 */
export async function askPrerequisiteRoute(
  item: ActionItem,
  work: WorkEntry,
  missing: readonly Prerequisite[]
): Promise<PrerequisiteDecision> {
  const alternative = item.insteadOf
    ? findAction(item.insteadOf.command)
    : undefined;

  const route = prerequisiteRoute({
    actionLabel: item.label,
    missing: missing.map(prerequisiteInfo),
    ...(alternative && item.insteadOf
      ? {
          alternative: {
            label: labelOf(alternative),
            why: item.insteadOf.why,
          },
        }
      : {}),
  });

  const picked = await vscode.window.showQuickPick<GateItem>(
    [...route.items, cancelItem()],
    { title: route.title, placeHolder: "どうしますか" }
  );
  if (!picked || isCancelItem(picked) || !picked.choice) return "handled";

  switch (picked.choice.act) {
    case "anyway":
      return "proceed";
    case "instead":
      // 名前を出すだけで終わらせない。その場で走らせる
      await vscode.commands.executeCommand(item.insteadOf!.command, ref(work));
      return "handled";
    case "make":
      await makeThenReturn(item, work, picked.choice.kind);
      return "handled";
  }
}

/**
 * 前提を作ってから、元の操作へ戻す。
 *
 * **作者に同じ場所を2度探させない**（作者の指示）。ただし戻すのは
 * 揃ったときだけである——作るのを取りやめたのに元の操作が始まると、
 * 断ったはずのものが動くことになる。
 */
async function makeThenReturn(
  item: ActionItem,
  work: WorkEntry,
  kind: Prerequisite
): Promise<void> {
  const info = prerequisiteInfo(kind);
  await vscode.commands.executeCommand(info.makeCommand, ref(work));

  const present = await collectPresentPrerequisites(work, [kind]);
  if (!present.has(kind)) {
    // 作られなかった（取りやめた・途中で止めた）。黙って終わらない
    void vscode.window.showInformationMessage(
      `${info.label}がまだ無いので、「${item.label}」は実行していません。`
    );
    return;
  }

  const answer = await vscode.window.showInformationMessage(
    `${info.label}ができました。続けて「${item.label}」を実行しますか。`,
    "実行する",
    "あとにする"
  );
  if (answer !== "実行する") return;
  await vscode.commands.executeCommand(item.command, ref(work));
}

/** 名前から外した補足も戻す（「矛盾検知」だけでは2つを見分けられない） */
function labelOf(action: ActionItem): string {
  return action.note ? `${action.label}（${action.note}）` : action.label;
}

function names(missing: readonly PrerequisiteInfo[]): string {
  return missing.map((info) => `「${info.label}」`).join("と");
}

/** コマンドへ作品を渡す形。選び直しを二度させないために付ける */
function ref(work: WorkEntry): { type: "work"; work: WorkEntry } {
  return { type: "work", work };
}
