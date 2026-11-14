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
  // 編集部が自分の言葉で書く直し・意見（作者の指示 2026-11-01）。**本文には書かず
  // 提案として置く**。「ここにメモを足す」も編集者モードでは行を挿さず、意見の提案になる
  "novelai.proposeEditByHand",
  "novelai.addSceneMemo",

  // 原稿を受け取るために要る。**編集者モードの「保存・同期」は受け取るだけ**
  // （作者の判断 2026-11-01。記録も送信もしない。送るのは「校閲を終えて返す」だけ）。
  // `gitSync` は作品一覧の右クリックから呼ばれるので残すが、編集者モードでは
  // 「保存・同期」と同じ受け取りへ回す（`extension.ts`）。`syncAllWorks` は開かない
  "novelai.saveAndSync",
  "novelai.gitSync",
  "novelai.resolveConflicts",
  // **「分岐合流」（`novelai.resolveDivergence`）は開かない**（作者の判断 2026-11-02）。
  // 編集者の「保存・同期」は受け取るだけで、2台の原稿を合わせるのは作者の仕事。
  // 分かれたときは「校閲を終えて返す」へ案内する（`describeBlocked`）
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

  // 編集者メニュー（作者の指示 2026-11-05 夜。設計書5.6.6）。編集者は複数の作品に参加でき、
  // 一番上で切り替える。「この作品の編集を終える」は作品の登録を外す（フォルダーは消さない）。
  // 置いた提案と作者の採否は、本文の場所へ飛べる一覧で見る（読むだけ）
  "novelai.chooseEditorWork",
  "novelai.removeWork",
  "novelai.listPlacedProposals",
  "novelai.viewAuthorDecisions",

  // **戻る道を必ず残す。** 入ったら出られない、が起きてはならない
  "novelai.switchMode",

  // 困ったときのために残す
  "novelai.openExtensionSettings",
  "novelai.showVersion",
  "novelai.showLog",
  // 不具合を伝える記録（設計書8.5）。書くのは `.aiwriter/reports/` だけで原稿に触れない
  "novelai.exportIssueReport",
  // コミュニティ（Discord）を開く（1.0.0）。開くだけで原稿に触れない
  "novelai.openCommunity",
]);

/**
 * 相談の目次・マニュアルが「どこにあるか」を言うときに見るモード（2026-11-01）。
 *
 * core は VS Code の設定を読めない（`actorContext.ts` は vscode に依る）ので、
 * `extension.ts` が起動時とモードを切り替えたときに入れる。入れない所（MCP サーバー・
 * 単体テスト）では作者モードとして扱う。**押せるかの判定には使わない**（それは
 * `isCommandAllowed` に呼び出し側がモードを渡す）。
 */
let modeForGuide: WorkMode = DEFAULT_MODE;

export function setActiveModeForGuide(mode: WorkMode): void {
  modeForGuide = mode;
}

export function activeModeForGuide(): WorkMode {
  return modeForGuide;
}

/** そのコマンドは、いまのモードで使えるか */
export function isCommandAllowed(command: string, mode: WorkMode): boolean {
  return mode === "author" || EDITOR_ALLOWED.has(command);
}

/** 編集者モードで使えないときの説明。**何のためにそうしているかまで言う** */
export const EDITOR_BLOCKED_HINT =
  "編集者モードでは使えません（本文の校正・校閲のみ）";

/**
 * 編集者が作者へ返す入口の名前（詳細メニューの「校閲を終えて返す」）。
 *
 * **`syncEntryNames.ts` の `finishReviewLabel()` を読まない**——あちらは
 * `actionTree.ts` を読み、`actionTree.ts` はこのファイルを読むので、輪になる。
 * 名前がずれたら `editorMode.test.ts` が木の名前と突き合わせて止める。
 */
const FINISH_REVIEW_LABEL = "校閲を終えて返す";

export function describeBlocked(command: string): string {
  // 分かれたときに押せる所を言う（作者の判断 2026-11-02）。「作者の環境で」だけでは、
  // 編集者は分かれたままの原稿をどうすればよいか分からない
  if (command === "novelai.resolveDivergence") {
    return (
      "編集者モードでは、2台の原稿を合わせる操作は使えません。" +
      "編集者の「保存・同期」は受け取るだけで、合わせるのは作者が行います。" +
      `原稿が作者の側と分かれたときは、「${FINISH_REVIEW_LABEL}」で提案を作者へ返してください。`
    );
  }
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
      : "この作品は編集者へ渡した写し（編集者モード）です。";
  return (
    `${head}${tool} は編集者モードでは使えません。` +
    "作者の原稿と資料を、編集者の側から書き換えないためです。" +
    `${MCP_EDITOR_ALLOWED_MESSAGE_HINT}。`
  );
}

/** 一覧を外から見たいとき（テストと画面の説明で使う） */
export function editorAllowedCommands(): string[] {
  return [...EDITOR_ALLOWED].sort();
}
