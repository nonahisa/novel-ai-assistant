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
 */
export type SpotlightResult =
  | { readonly shown: true; readonly view: "steps" | "actions" }
  | { readonly shown: false };

export interface ActionSpotlight {
  show(command: string): Promise<SpotlightResult>;
}

/** ツリーの実体。**拡張機能の起動時に1度だけ渡す** */
export interface SpotlightTargets {
  readonly stepView: vscode.TreeView<StepNode>;
  readonly stepProvider: StepMenuProvider;
  readonly actionView: vscode.TreeView<ActionNode>;
  readonly actionProvider: ActionListProvider;
}

export function createActionSpotlight(
  targets: SpotlightTargets
): ActionSpotlight {
  return {
    async show(command: string): Promise<SpotlightResult> {
      const stepNode = targets.stepProvider.findActionNode(command);
      if (stepNode && (await reveal(targets.stepView, stepNode))) {
        return { shown: true, view: "steps" };
      }
      const actionNode = targets.actionProvider.findActionNode(command);
      if (actionNode && (await reveal(targets.actionView, actionNode))) {
        return { shown: true, view: "actions" };
      }
      return { shown: false };
    },
  };
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
