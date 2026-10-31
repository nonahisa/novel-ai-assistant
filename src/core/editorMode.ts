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
 *
 * **ここへ並べるIDは `package.json` に実在するものだけ。** ただの文字列なので
 * 綴り違いは型検査を素通りし、押しても何も起きないまま気づかれない
 * （実際に3つ紛れていた）。`test/unit/core/editorMode.test.ts` が突き合わせる。
 */
const EDITOR_ALLOWED = new Set<string>([
  // 本文の校正・校閲。**これが編集部の仕事である**
  "novelai.checkTypos",
  "novelai.checkTyposForFile",
  "novelai.checkNotation",
  "novelai.checkProofread",
  "novelai.manageKeepWords",

  // 原稿を受け取り、直したものを返すために要る
  // 1作品だけ見る編集部は作品ごとの同期で足りる（`syncAllWorks` は開かない）
  "novelai.gitSync",
  "novelai.resolveConflicts",
  // 編集部と作者の両方が触ったあとは、ここを通らないと合流できない
  "novelai.resolveDivergence",
  "novelai.addWorkFromGithub",

  // 読むために要る
  "novelai.openSettingsPanel",
  "novelai.showEditHistory",
  // 提案パネルを開く（結果が届いたときもこれで開く。止めると、編集者モードで
  // 検知の結果が届くたびに「使えません」が出る）
  "novelai.openProposals",

  // **校閲の要**。ファイルを押さえ、提案の行方を見る
  "novelai.toggleReviewLock",
  "novelai.reviewProposals",
  // 編集部として参加する（作者モードの環境からも、編集者モードの環境からも押せる）。
  // 校閲を終えたら、提案とロックの外れた記録を作者へ返す
  "novelai.joinAsEditor",
  "novelai.finishReviewAndReturn",

  // **戻る道を必ず残す。** 入ったら出られない、が起きてはならない
  "novelai.switchMode",

  // 困ったときのために残す
  "novelai.openExtensionSettings",
  "novelai.showVersion",
  "novelai.showLog",
  // 不具合を伝える記録（設計書8.5）。書くのは `.aiwriter/reports/` だけで原稿に触れない
  "novelai.exportIssueReport",
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

/**
 * 作品フォルダーの印1つの様子。`unreadable` は「在るか無いかも確かめられない」
 * （ファイルでないものが置かれている・読む権限が無い など）。
 */
export type FolderMarkState = "present" | "absent" | "unreadable";

/** 作品フォルダーの印から読んだモード。`unknown` は確かめられなかった */
export type WorkFolderMode = WorkMode | "unknown";

/**
 * 作品フォルダーだけから、その作品が編集用の写し（編集部の側）かを決める
 * （設計書5.6.5・6.87.25。作者の指示 2026-10-31「MCPサーバの穴ふさぎは実行してください」）。
 *
 * **設定 `novelai.mode` は使えない。** 機械ごとの VS Code の設定で、VS Code の外で動く
 * MCP サーバーからは確実には読めない。そこで、編集部へ渡すときにだけ置かれる印を読む。
 *
 * - `editorCopy`：`.aiwriter/editor-share-manifest.json`（編集用フォルダーにだけ置く）
 * - `authorSite`：`.aiwriter/editing.json`（作者の作品にだけ置く）
 *
 * **印が無い作品は作者**。一度も渡していない普通の作品はすべてここに落ちるので、
 * ここを編集者に倒すと作者の MCP が全部止まる。両方ある（ありえない組）か、
 * 写しの印が確かめられないときは `unknown`——呼ぶ側は書く道具だけを断る。
 */
export function workModeFromMarks(marks: {
  editorCopy: FolderMarkState;
  authorSite: FolderMarkState;
}): WorkFolderMode {
  if (marks.editorCopy === "unreadable") return "unknown";
  if (marks.editorCopy === "absent") return "author";
  // 写しの印がある。作者の印も確かに在るなら、どちらとも言えない
  return marks.authorSite === "present" ? "unknown" : "editor";
}

/** MCP の道具が断ったときに、代わりに使える道として添える文 */
export const MCP_EDITOR_ALLOWED_MESSAGE_HINT =
  "指摘は novel.propose の kind: \"finding\" で提案パネルへ置けます（当てるかは作者が決めます）";

/**
 * MCP の道具を編集者モードで断るときの文（画面の `describeBlocked` と同じ考え）。
 * **何のためにそうしているかと、代わりの道まで言う。** 呼んだ外部AIが作者や
 * 編集部へそのまま伝えられるようにする。
 */
export function describeMcpBlocked(tool: string, mode: WorkFolderMode): string {
  const head =
    mode === "unknown"
      ? `この作品が編集用の写しかどうかを、作品フォルダーの印（.aiwriter/editor-share-manifest.json・` +
        `.aiwriter/editing.json）から確かめられませんでした。念のため、編集者モードとして扱います。`
      : "この作品は編集部へ渡した写し（編集者モード）です。";
  return (
    `${head}${tool} は編集者モードでは使えません。` +
    "作者の原稿と資料を、編集部の側から書き換えないためです。" +
    `${MCP_EDITOR_ALLOWED_MESSAGE_HINT}。`
  );
}

/** 一覧を外から見たいとき（テストと画面の説明で使う） */
export function editorAllowedCommands(): string[] {
  return [...EDITOR_ALLOWED].sort();
}

/**
 * 編集者モードで登録できる作品の数（設計書5.7.4）。
 *
 * **編集部は1作品だけを見る。** 校閲を頼まれた作品と、頼まれていない作品を
 * 同じ画面に並べると、取り違えて別の作品へ提案を書きかねない。
 */
export const EDITOR_WORK_LIMIT = 1;

/**
 * いま作品を足せるか。
 *
 * **これは守りではない。** 手元にファイルがある以上、別のエディタで開けば
 * 読めてしまう。**本当に守るのはGitHubの招待範囲のほうである**
 * （リポジトリ単位でしか権限をかけられないので、編集部へ渡すときは
 * その作品だけを入れたリポジトリを切り出す）。ここで止めるのは、
 * 作者と編集部の双方が取り違えないようにするためである。
 */
export function canRegisterWork(mode: WorkMode, registered: number): boolean {
  return mode === "author" || registered < EDITOR_WORK_LIMIT;
}

/** 足せないときの説明。**何のためにそうしているかまで言う** */
export function describeWorkLimit(registeredTitle: string): string {
  return (
    `編集者モードでは、作品を1つだけ登録できます（いまは「${registeredTitle}」）。` +
    "別の作品を校閲するときは、いまの登録を解除してから追加してください。" +
    "取り違えて別の作品へ提案を書かないための仕切りです。"
  );
}
