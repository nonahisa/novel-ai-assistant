/**
 * 編集者モード（設計書5.6）。
 *
 * **編集部にできるのは、本文の校正・校閲だけ**（2026-08-19、作者の判断）。
 *
 * 編集部は別のGitHubアカウントで、自分の環境にこの拡張機能を入れて使う。
 * その環境を「編集者モード」にすると、**執筆と設定資料づくりの機能が消える。**
 *
 * **なぜ隠すのか。** 押せてしまうと、いつか押される。設定資料の抽出を
 * 編集部が走らせると、作者の資料がAIの読みで書き換わりうる。
 * 「やらない約束」で守るより、**できないようにするほうが確実**である。
 *
 * **消すのではなく、押せなくして理由を出す**（操作メニューの既存の作りに合わせる）。
 * 何ができないのかが見えないと、編集部は「壊れている」と思う。
 *
 * VS Code APIに依存しない。
 */

export type WorkMode = "author" | "editor";

export const DEFAULT_MODE: WorkMode = "author";

/**
 * 編集者モードでも使えるコマンド。
 *
 * **許すものを並べる**（禁じるものを並べない）。機能を足したときに、
 * うっかり編集部へ開いてしまうことがないようにする。
 * 新しいコマンドは、**明示的に足すまで編集者には見えない。**
 */
const EDITOR_ALLOWED = new Set<string>([
  // 本文の校正・校閲。**これが編集部の仕事である**
  "novelai.checkTypos",
  "novelai.checkTyposForFile",
  "novelai.checkNotation",
  "novelai.checkProofread",
  "novelai.manageKeepWords",

  // 原稿を受け取り、直したものを返すために要る
  "novelai.syncWork",
  "novelai.resolveConflicts",
  "novelai.addWorkFromGithub",

  // 読むために要る
  "novelai.showWordCount",
  "novelai.openSettingsPanel",
  "novelai.showEditHistory",

  // **校閲の要**。ファイルを押さえ、提案の行方を見る
  "novelai.toggleReviewLock",
  "novelai.reviewProposals",

  // **戻る道を必ず残す。** 入ったら出られない、が起きてはならない
  "novelai.switchMode",

  // 困ったときのために残す
  "novelai.openExtensionSettings",
  "novelai.showVersion",
  "novelai.openLog",
]);

/** そのコマンドは、いまのモードで使えるか */
export function isCommandAllowed(command: string, mode: WorkMode): boolean {
  return mode === "author" || EDITOR_ALLOWED.has(command);
}

/** 編集者モードで使えないときの説明。**何のためにそうしているかまで言う** */
export const EDITOR_BLOCKED_HINT =
  "編集者モードでは使えません（本文の校正・校閲のみ）";

export function describeBlocked(command: string): string {
  if (command.startsWith("novelai.extract") || command.includes("Settings")) {
    return (
      "編集者モードでは設定資料を変更できません。" +
      "作者の資料がAIの読みで書き換わるのを防ぐためです。"
    );
  }
  return (
    "編集者モードでは、本文の校正・校閲だけを行えます。" +
    "この操作は作者の環境で実行してください。"
  );
}

/** 一覧を外から見たいとき（テストと画面の説明で使う） */
export function editorAllowedCommands(): string[] {
  return [...EDITOR_ALLOWED].sort();
}
