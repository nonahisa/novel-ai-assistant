import * as vscode from "vscode";
import { AIRegistry, runSetupWizard } from "../ai/registry";

/**
 * はじめて開いたときに、使うAIを選んでもらう（作者の指示、2026-08-19）。
 *
 * **これまでは作品一覧の歯車から自分で開く必要があった。** 入れたばかりの
 * 人には、そこに何があるのか分からない。**AIを選ばないと、この拡張機能の
 * 半分は動かない。**
 *
 * 気をつけたことが3つある。
 *
 * 1. **1度しか出さない。** 起動のたびに選択画面が出るのは邪魔である。
 *    出したことを覚えておく（作品ごとではなく環境ごと）
 * 2. **既に決まっていれば出さない。** 設定の同期などで、入れた直後から
 *    使える状態のことがある
 * 3. **起動を待たせない。** `activate` の中で `await` すると、
 *    選び終わるまで拡張機能の初期化が止まる
 */

/** 出したことを覚えておく鍵 */
const SHOWN_KEY = "novelai.firstRun.aiSetupShown";

export interface FirstRunDeps {
  /** 既にAIが決まっているか */
  isConfigured: () => Promise<boolean>;
  /** 出したことがあるか */
  wasShown: () => boolean;
  markShown: () => Promise<void>;
  /** 選択画面を出す */
  runWizard: () => Promise<boolean>;
  /** 案内を出す */
  notify: (message: string, action: string) => Promise<string | undefined>;
}

/**
 * 出すべきかを決める。**VS Code APIに依存しないので単体で試せる。**
 */
export async function shouldOfferSetup(
  deps: Pick<FirstRunDeps, "isConfigured" | "wasShown">
): Promise<boolean> {
  if (deps.wasShown()) return false;
  return !(await deps.isConfigured());
}

/**
 * はじめての案内。
 *
 * **いきなり選択画面を出さない。** 何のための画面か分からないまま
 * 一覧を見せられても選べない。1行の説明を挟む。
 */
export async function offerFirstRunSetup(deps: FirstRunDeps): Promise<void> {
  if (!(await shouldOfferSetup(deps))) return;

  // **先に「出した」と覚える。** 途中で閉じられても、次の起動で
  // また出るのは邪魔である。あとから「AI設定」でいつでも開ける
  await deps.markShown();

  const answer = await deps.notify(
    "小説執筆へようこそ。使うAIを選ぶと、設定資料の抽出や誤字脱字の検知が使えます。" +
      "（作品の管理と文字数の集計は、AIなしでも使えます）",
    "AIを選ぶ"
  );
  if (answer !== "AIを選ぶ") return;
  await deps.runWizard();
}

/** VS Code に繋いだ形。**起動を待たせないよう、呼び出し側は await しない** */
export function offerFirstRunSetupInVsCode(
  context: vscode.ExtensionContext,
  registry: AIRegistry
): Promise<void> {
  return offerFirstRunSetup({
    isConfigured: async () => {
      for (const provider of registry.listProviders()) {
        if (await provider.isConfigured()) return true;
      }
      return false;
    },
    wasShown: () => context.globalState.get<boolean>(SHOWN_KEY, false),
    markShown: async () => {
      await context.globalState.update(SHOWN_KEY, true);
    },
    runWizard: () => runSetupWizard(registry),
    notify: async (message, action) =>
      vscode.window.showInformationMessage(message, action),
  });
}
