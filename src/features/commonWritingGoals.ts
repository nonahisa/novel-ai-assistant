import * as vscode from "vscode";
import { askText } from "../views/dialogs";

/**
 * 全作品共通の「1日の目標」「1か月の目標」を決める（設計書6.3.6.6）。
 *
 * 作者の指摘（ノートPCの実機確認、2026-09-23）：この2つ（`novelai.stats.dailyGoal`・
 * `novelai.stats.monthlyGoal`）は VS Code の設定画面で検索しないと出せず、
 * 「それは素人にわかりにくいと思います。で、ここにメニューがありません」。
 * 目標達成の祝い（6.3.8）の1日・1か月はこの値で判定するので、決める入口が要る。
 *
 * - 入口は**作品目標設定**と、**執筆統計の画面**（1作品・全作品）の2か所
 * - **書き先はユーザー（全体）の設定**（`ConfigurationTarget.Global`）。作品にも
 *   ワークスペースにも書かない——全作品で共通の値なので、開いているフォルダーで
 *   変わってはいけない
 * - 0（または空）で未設定。全角数字・桁区切り・「字」も受ける
 */

/** 執筆統計の画面から「目標を決める」を押したときの合図（画面と拡張機能で同じ文字列を見る） */
export const COMMON_GOALS_MESSAGE = "editCommonGoals";

const DAILY_KEY = "stats.dailyGoal";
const MONTHLY_KEY = "stats.monthlyGoal";

/**
 * 入れられた字数を読む。**0 と空は「未設定」（0）**。数でないもの・負の数・小数は null。
 */
export function parseGoalInput(value: string): number | null {
  const text = value.normalize("NFKC").replace(/[,，\s]/gu, "").replace(/字$/u, "");
  if (text === "") return 0;
  if (!/^\d+$/u.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

function amount(value: number): string {
  return value > 0 ? `${value.toLocaleString("ja-JP")}字` : "未設定";
}

/** いまの値の言い方（「1日 1,000字・1か月 未設定」） */
export function commonGoalsDescription(daily: number, monthly: number): string {
  if (daily <= 0 && monthly <= 0) return "どちらも未設定";
  return `1日 ${amount(daily)}・1か月 ${amount(monthly)}`;
}

/** いまの値（設定から読む） */
export function currentCommonGoals(): { daily: number; monthly: number } {
  const config = vscode.workspace.getConfiguration("novelai");
  return {
    daily: Math.max(0, config.get<number>(DAILY_KEY, 0)),
    monthly: Math.max(0, config.get<number>(MONTHLY_KEY, 0)),
  };
}

/**
 * 1日・1か月の目標を順に訊いて、ユーザー（全体）の設定に書く。
 *
 * **1画面ずつ訊く**（作品の目標と同じ。6.3.6）。途中でやめたら何も書かない
 * ——1日だけ書いて1か月を書かないと、作者の思っていない組み合わせが残る。
 *
 * @returns 書いたか
 */
export async function editCommonWritingGoals(): Promise<boolean> {
  const current = currentCommonGoals();
  const validateInput = (value: string) =>
    parseGoalInput(value) === null ? "0以上の数を入れてください（0か空で未設定）" : null;

  const daily = await askText({
    title: "1日の目標（全作品共通）",
    prompt:
      "1日に書く字数の目標です。全作品の合計で数えます（どの作品で書いても足されます）。0か空で未設定",
    value: current.daily > 0 ? String(current.daily) : "",
    placeHolder: "1000",
    validateInput,
  });
  if (daily === undefined) return false;
  const monthly = await askText({
    title: "1か月の目標（全作品共通）",
    prompt: "1か月に書く字数の目標です。全作品の合計で数えます。0か空で未設定",
    value: current.monthly > 0 ? String(current.monthly) : "",
    placeHolder: "30000",
    validateInput,
  });
  if (monthly === undefined) return false;

  const dailyValue = parseGoalInput(daily);
  const monthlyValue = parseGoalInput(monthly);
  if (dailyValue === null || monthlyValue === null) return false;

  const config = vscode.workspace.getConfiguration("novelai");
  try {
    await config.update(DAILY_KEY, dailyValue, vscode.ConfigurationTarget.Global);
    await config.update(MONTHLY_KEY, monthlyValue, vscode.ConfigurationTarget.Global);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `目標を保存できませんでした：${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }

  // ワークスペースの設定に別の値があると、そちらが勝って画面に出ない。黙っていると
  // 「入れたのに変わらない」になるので断る（書き換えはしない。作者が置いた値かもしれない）
  const shadowed = [DAILY_KEY, MONTHLY_KEY].filter((key) => {
    const inspected = config.inspect?.(key);
    return (
      inspected !== undefined &&
      (inspected.workspaceValue !== undefined || inspected.workspaceFolderValue !== undefined)
    );
  });
  void vscode.window.showInformationMessage(
    `全作品共通の目標を ${commonGoalsDescription(dailyValue, monthlyValue)} にしました。` +
      (shadowed.length > 0
        ? "ただし、開いているフォルダーの設定に別の値があり、そちらが優先されます（VS Code の設定の「ワークスペース」から消すと、いま入れた値になります）。"
        : "")
  );
  return true;
}
