import * as vscode from "vscode";
import { AIRegistry, runSetupWizard } from "../ai/registry";
import { CLAUDE_CODE_EXTENSION_ID } from "../core/claudeCodeRegistration";

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
  /** 案内を出す（押し口は1つか2つ） */
  notify: (message: string, ...actions: string[]) => Promise<string | undefined>;
  /**
   * VS Code 版の Claude Code が入っているか（設計書6.87.18）。入っていれば
   * 「Claude Code とつなぐ」も並べる——会話でセットアップを進められる
   */
  claudeCodeInstalled?: () => boolean;
  /** つなぐ（`novelai.connectClaudeCode`） */
  connectClaudeCode?: () => Promise<void>;
  /**
   * 初回の道案内（`contributes.walkthroughs`。設計書6.104 の入口2）を開く。
   * 渡されたときだけ押し口を並べる
   */
  openWalkthrough?: () => Promise<void>;
}

/** 案内の押し口の名前 */
const PICK_AI = "AIを選ぶ";
export const CONNECT_CLAUDE_CODE = "Claude Code とつなぐ";
export const OPEN_WALKTHROUGH = "道案内を見る";

/**
 * 初回の道案内の ID（`package.json` の `contributes.walkthroughs[].id`）。
 * 開くときは「発行者.名前#ID」で指す。揃いは `firstRun.test.ts` が見る
 */
export const WALKTHROUGH_ID = "novelai.gettingStarted";

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

  /*
    **Claude Code が入っていれば、つなぐ口も並べる**（設計書6.87.18）。
    つなげば、Claude Code のチャットで会話しながら最初の作品まで準備できる。
    入っていない人には出さない——何のことか分からない押し口は迷わせるだけ。
  */
  const offerConnect = Boolean(deps.claudeCodeInstalled?.() && deps.connectClaudeCode);
  /*
    **道案内は、この声かけから開ける形にした**（設計書6.104 入口2）。
    VS Code は Marketplace から入れた直後に道案内を自動で開くことがあるが、
    VSIX から入れた・設定の同期で入った・すぐ閉じた人には出ない。
    声かけは1度しか出ないので、ここに押し口を置けば「最初の手順を
    どこで見るか」が必ず1度は目に入る。**声かけ自体はやめない**——
    道案内は見るだけで閉じられるが、AIを選ばないと半分が動かないことは
    ここで言っておく必要がある。
  */
  const offerWalkthrough = Boolean(deps.openWalkthrough);
  const answer = await deps.notify(
    "小説執筆へようこそ。使うAIを選ぶと、設定資料の抽出や誤字脱字の検知が使えます。" +
      "（作品の管理と文字数の集計は、AIなしでも使えます）" +
      (offerConnect
        ? "Claude Code とつなぐと、Claude Code のチャットで会話しながらセットアップを進められます。"
        : ""),
    PICK_AI,
    ...(offerConnect ? [CONNECT_CLAUDE_CODE] : []),
    ...(offerWalkthrough ? [OPEN_WALKTHROUGH] : [])
  );
  if (answer === CONNECT_CLAUDE_CODE && deps.connectClaudeCode) {
    await deps.connectClaudeCode();
    return;
  }
  if (answer === OPEN_WALKTHROUGH && deps.openWalkthrough) {
    await deps.openWalkthrough();
    return;
  }
  if (answer !== PICK_AI) return;
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
    notify: async (message, ...actions) =>
      vscode.window.showInformationMessage(message, ...actions),
    claudeCodeInstalled: () =>
      vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID) !== undefined,
    // 中身はコマンド側（動的に読む。Node の部品を抱えているため）
    connectClaudeCode: async () => {
      await vscode.commands.executeCommand("novelai.connectClaudeCode");
    },
    // ブラウザ版でも同じ口で開ける（VS Code 本体のコマンド。第3引数 false で
    // 横に開かず、いまの編集領域に出す）
    openWalkthrough: async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openWalkthrough",
        `${context.extension.id}#${WALKTHROUGH_ID}`,
        false
      );
    },
  });
}
