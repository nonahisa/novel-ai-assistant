import * as vscode from "vscode";
import { startTour } from "../core/guidedTour";
import { PROCEDURES, type Procedure } from "../core/procedures";
import { findAction, REQUIRES_WORK_HINT } from "../views/actionList";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { procedureActionLookup } from "./featureGuide";

/**
 * 場面別案内——ヘルプから、場面を選んで画面で案内してもらう
 * （作者の依頼、2026-09-23「利用シーンごとのチュートリアルが欲しいです」）。
 *
 * ## 新しい案内を作らない
 *
 * 場面ごとの手順は、相談の「画面で案内してもらう」がすでに持っている
 * （`core/procedures.ts` の `PROCEDURES`）。ただし相談で話題が当たった
 * ときにしか出てこず、**どんな場面の案内があるのかを一覧できる入口が
 * 無かった。** ここはその入口だけを足す。
 *
 * 選んだあとは、相談の札と**同じ案内**（`GuidedTourHost.start`）を起こす。
 * 手順の写しを作ると、片方だけ直したときに「ヘルプから見た手順」と
 * 「相談から見た手順」が食い違い、どちらが正しいのか分からなくなる。
 *
 * ## 作品が要る場面と、要らない場面
 *
 * 1段目が作品を要さない操作（新規執筆・フォルダー登録）なら、作品が
 * 1つも無くても始められる。そうでない場面は、詳細メニューと同じく
 * **消さずに理由を添える**（`REQUIRES_WORK_HINT`）。選ばれたら始めずに
 * 理由を出し、作品を用意する場面へ移れるようにする
 * ——理由だけでは、次に何をすればよいか分からない。
 *
 * 作品が登録されていれば、どの作品で進めるかは案内の各段が訊く
 * （コマンド登録の包み `guardPrerequisites` と各操作の作品選択。
 * 詳細メニューから押したときと同じ決まり方にする）。
 */

/** コマンドID */
export const SCENE_GUIDE_COMMAND = "novelai.openSceneGuide";

/**
 * 画面に出す名前。0.79.0 の名前の流儀（短い体言止め）に合わせる。
 *
 * 詳細メニューの名前は `ACTION_TREE` が持つ。ここは試験から照らし合わせる
 * ための控えで、画面へ出すのは木の側である。
 */
export const SCENE_GUIDE_LABEL = "場面別案内";

/** 選択肢の1つ（1つの場面） */
export interface SceneChoice {
  readonly key: string;
  readonly title: string;
  readonly whenToRead: string;
  /** 案内できる段の数 */
  readonly steps: number;
  /** 始めるのに、登録済みの作品が要るか */
  readonly needsWork: boolean;
}

/**
 * その場面を始めるのに作品が要るか。
 *
 * **1段目だけを見る。** 「新しい作品を始める」は2段目から先で作品を
 * 要するが、1段目で作品ができるので、作品が無くても始められる。
 * 名前を引けない段（この環境の画面に無い操作）は案内でも飛ばすので、
 * ここでも飛ばして、実際に最初に案内される段で決める。
 */
export function sceneNeedsWork(procedure: Procedure): boolean {
  for (const step of procedure.steps) {
    if (!procedureActionLookup(step.command)) continue;
    return findAction(step.command)?.requiresWork ?? true;
  }
  return true;
}

/**
 * 選べる場面の一覧。並びは `PROCEDURES` のまま。
 *
 * **案内を組めない場面は出さない。** 段が1つも残らない場面を並べると、
 * 押しても何も始まらない（相談の札が組めない手順を誘わないのと同じ）。
 */
export function sceneChoices(): SceneChoice[] {
  const choices: SceneChoice[] = [];
  for (const procedure of PROCEDURES) {
    const tour = startTour(procedure, procedureActionLookup);
    if (!tour) continue;
    choices.push({
      key: procedure.key,
      title: procedure.title,
      whenToRead: procedure.whenToRead,
      steps: tour.steps.length,
      needsWork: sceneNeedsWork(procedure),
    });
  }
  return choices;
}

/** 選択画面の1行 */
export interface SceneQuickPickItem extends vscode.QuickPickItem {
  description: string;
  readonly choice: SceneChoice;
}

/** 選択画面の行を組む（画面に触れないので、ここだけ単体で確かめられる） */
export function sceneQuickPickItems(
  choices: readonly SceneChoice[],
  hasWork: boolean
): SceneQuickPickItem[] {
  return choices.map((choice) => {
    const blocked = choice.needsWork && !hasWork;
    return {
      label: choice.title,
      description: blocked
        ? `${choice.steps}段・${REQUIRES_WORK_HINT}`
        : `${choice.steps}段`,
      detail: choice.whenToRead,
      choice,
    };
  });
}

/**
 * 場面を選ばせて、案内を始める場面の鍵を返す。選ばなければ undefined。
 *
 * @param hasWork 作品が1つでも登録されているか（詳細メニューの押せる判定と同じ物差し）
 */
export async function pickScene(hasWork: boolean): Promise<string | undefined> {
  const choices = sceneChoices();
  const picked = await vscode.window.showQuickPick(
    [...sceneQuickPickItems(choices, hasWork), cancelItem()],
    {
      title: SCENE_GUIDE_LABEL,
      placeHolder:
        "案内してほしい場面を選んでください（押す場所を順に光らせて示します）",
      matchOnDetail: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("choice" in picked)) {
    return undefined;
  }
  if (!picked.choice.needsWork || hasWork) return picked.choice.key;

  // 作品が要る場面を、作品が無いまま選んだ。始めずに、作品を用意する
  // 場面へ移れるようにする（理由だけでは次の手が分からない）
  const starters = choices.filter((choice) => !choice.needsWork);
  const next = await vscode.window.showInformationMessage(
    `「${picked.choice.title}」は、${REQUIRES_WORK_HINT}。先に作品を用意する場面から案内できます。`,
    ...starters.map((choice) => choice.title)
  );
  return starters.find((choice) => choice.title === next)?.key;
}
