import * as vscode from "vscode";
import type { ActionListProvider, ActionNode } from "../views/actionList";
import type { StepMenuProvider, StepNode } from "../views/stepMenu";

/**
 * 押すべき項目を、サイドバーで光らせる（設計書6.104）。
 *
 * ## できるのは「光らせて選ぶ」ところまで
 *
 * VS Code 本体のUIに丸を重ねて描く口は、拡張機能に無い。3つのツリーは
 * `createTreeView` で作ってあるので `TreeView.reveal()` が使える——
 * **選択状態にして、そこまでスクロールして見せる**ところまでである。
 * **ここを取り違えると、作れない約束を書くことになる。**
 *
 * ## 先に簡単ステップメニュー、無ければ詳細メニュー
 *
 * 作者が普段たどるのは簡単ステップメニュー（設計書6.29）なので、まずそちらを
 * 探す。置いていない操作（「新話を投稿」など）と、作品のタイプで消えている
 * 段があるので、見つからなければ詳細メニューへ回る。**どちらにも無ければ
 * 「光らせられなかった」と正直に返す**——光ったことにして案内を続けると、
 * 作者は画面のどこにも無いものを探すことになる。
 *
 * ## 焦点は奪わない
 *
 * `focus: false` にしてある。案内は相談パネルの中に出ており、作者は
 * そこで読みながら押す。ツリーへ焦点を移すと、入力欄から抜けてしまう。
 *
 * ## 選ぶだけでは目立たない（作者の報告、2026-09-22）
 *
 * 作者「相談で光らせるが目立ちません。もう一度光らせるとかいるかも」。
 * 選択の色はテーマによっては薄く、しかも一瞬では気づけない。そこで3つ足した。
 *
 * 1. **印を残す**（`ActionDecorationProvider`。消えずに残るので、目を離しても戻れる）
 * 2. **瞬かせる**（`reveal` を2回。間に選択をいったん外すので、色が動いて目に入る）
 * 3. **もう一度光らせる**（相談パネルの札から呼び直せる。`GuidedTourHost.showAgain`）
 */
export type SpotlightResult =
  | { readonly shown: true; readonly view: "steps" | "actions" }
  | { readonly shown: false };

export interface ActionSpotlight {
  show(command: string): Promise<SpotlightResult>;
  /** 印を外す。**案内が終わった／やめたときに呼ぶ** */
  clear(): void;
}

/**
 * 印を付ける先（`ActionDecorationProvider` がこの形を満たす）。
 *
 * **細い口にする。** ここが要るのは「いまどれを指しているか」を渡すことだけで、
 * 件数の仕組みまで知る必要はない（単体で確かめられるようにするためでもある）。
 */
export interface SpotlightMarker {
  setSpotlight(command: string | undefined): void;
}

/** ツリーの実体。**拡張機能の起動時に1度だけ渡す** */
export interface SpotlightTargets {
  readonly stepView: vscode.TreeView<StepNode>;
  readonly stepProvider: StepMenuProvider;
  readonly actionView: vscode.TreeView<ActionNode>;
  readonly actionProvider: ActionListProvider;
  /** 印を付ける先。渡さなければ光らせるだけ（印は出ない） */
  readonly marker?: SpotlightMarker;
}

/** 瞬きの間合い。**目が動くだけの長さ**が要る（短すぎると1回に見える） */
export const SPOTLIGHT_BLINK_MS = 350;

/** 試験から間合いを詰めるための口。**製品はどこからも渡さない** */
export interface SpotlightTiming {
  readonly blinkMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createActionSpotlight(
  targets: SpotlightTargets,
  timing: SpotlightTiming = {}
): ActionSpotlight {
  const blinkMs = timing.blinkMs ?? SPOTLIGHT_BLINK_MS;
  const sleep =
    timing.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    async show(command: string): Promise<SpotlightResult> {
      // **先に印を付ける。** 瞬いている間も「どれか」が見えている
      targets.marker?.setSpotlight(command);

      const stepNode = targets.stepProvider.findActionNode(command);
      if (
        stepNode &&
        (await blink(
          targets.stepView,
          stepNode,
          targets.stepProvider.getParent(stepNode),
          sleep,
          blinkMs
        ))
      ) {
        return { shown: true, view: "steps" };
      }
      const actionNode = targets.actionProvider.findActionNode(command);
      if (
        actionNode &&
        (await blink(
          targets.actionView,
          actionNode,
          targets.actionProvider.getParent(actionNode),
          sleep,
          blinkMs
        ))
      ) {
        return { shown: true, view: "actions" };
      }
      // **どちらにも無ければ印も外す。** 押す場所が無いのに印だけ
      // 残ると、前の段を指したままになる
      targets.marker?.setSpotlight(undefined);
      return { shown: false };
    },
    clear(): void {
      targets.marker?.setSpotlight(undefined);
    },
  };
}

/**
 * 1つのツリーで2回光らせる（瞬き。作者の報告、2026-09-22）。
 *
 * **間に選択をいったん外す。** 選び直すだけでは、すでに選ばれている行に
 * 同じ色が乗るだけで何も動かない。ツリーの選択を解く口は拡張機能に無いので、
 * **親をいったん選ぶ**ことで外す——選択の色が親へ移って戻るので、目が動く。
 *
 * **成否は1回目だけで決める。** 1回目が通ればその画面に押す場所がある
 * ということなので、2回目や親の選び直しが失敗しても、もう片方のツリーを
 * 探しにいく必要はない。
 */
async function blink<T>(
  view: vscode.TreeView<T>,
  node: T,
  parent: T | undefined,
  sleep: (ms: number) => Promise<void>,
  blinkMs: number
): Promise<boolean> {
  if (!(await reveal(view, node))) return false;
  if (parent !== undefined) await reveal(view, parent);
  await sleep(blinkMs);
  await reveal(view, node);
  return true;
}

/**
 * 1つのツリーで光らせてみる。
 *
 * **失敗しても投げない。** `reveal` は親をたどれないときに例外を出すが、
 * 案内そのものは続けられる（押す場所は文でも伝えてある）。
 */
async function reveal<T>(
  view: vscode.TreeView<T>,
  node: T
): Promise<boolean> {
  try {
    await view.reveal(node, { select: true, focus: false, expand: true });
    return true;
  } catch {
    return false;
  }
}

/** 光らせた場所の言い方。**画面と記録で同じ言葉を使う** */
export function describeSpotlight(result: SpotlightResult): string {
  if (!result.shown) {
    return "この操作はメニューに見当たりませんでした。コマンドパレット（Ctrl+Shift+P）から探してください。";
  }
  return result.view === "steps"
    ? "簡単ステップメニューで光らせました。"
    : "詳細メニューで光らせました。";
}
