/**
 * ブラウザ版（vscode.dev / github.dev）では使えない操作（設計書5.8.5）。
 *
 * **消すのではなく、押せなくして理由を出す**（`editorMode.ts` と同じ考え方）。
 * 何ができないのかが見えないと、なぜその項目が消えたのか分からない。
 *
 * ここに挙げるのは、外部プロセス（git・Ollama・パッケージ導入）を
 * 起動する操作。ブラウザには「外部プロセスを起動する」という概念自体が
 * 無いので、`canRunProcesses()` が偽のときは常に使えない
 * （編集者モードのように、条件次第で使えるようになる類のものではない）。
 *
 * VS Code APIに依存しない。
 */

/**
 * 外部プロセスが要る、**操作メニューに載っている**コマンド。
 *
 * `extension.ts` では `novelai.gitPull` / `novelai.gitPush` も
 * `canRunProcesses()` を確かめているが、この2つは操作メニューに項目が無い
 * （「同期」〈`novelai.gitSync`〉の中のQuickPickからしか選べない。
 * `gitSync` 自体をここで塞いでいるので、その先へは進めない）。
 * **ここに挙げるのは、操作メニューで実在するIDだけ**にする。挙げても
 * 対応する項目が無ければ、下のテスト（`processAvailability.test.ts`）が
 * 「実在しないIDを禁じている」と気づけずに黙って素通りしてしまう。
 */
const REQUIRES_PROCESSES = new Set<string>([
  "novelai.gitRestore",
  "novelai.setupGithub",
  "novelai.setupOllama",
  // LM Studioも手元で動くAIで、導入（winget）も起動の確認も外部プロセスが要る
  "novelai.setupLmStudio",
  "novelai.runFullSetup",
  "novelai.setupVectorSearch",
  "novelai.resolveConflicts",
  "novelai.selectOllamaExecutable",
  "novelai.shareWithEditor",
  "novelai.collectEditorProposals",
  // **すべて同期はgitコマンドを直に打つ**ので、ブラウザでは動かせない。
  // 1作品ずつの `novelai.gitSync` と違い、ソース管理へ案内して代わりに
  // させる形にできない（置き場ごとに記録・取り込み・送信を順に行うため）
  "novelai.syncAllWorks",
  // **分岐を合わせるのもgitコマンドを直に打つ**（設計書5.5.16）。
  // ソース管理へ案内して代わりにさせる形にはできない
  "novelai.resolveDivergence",
  // **PDF出力は、組んだHTMLを手元のブラウザへ渡して印刷させる。**
  // 外部プロセスこそ起動しないが、`openExternal` に渡せるのは手元の
  // ファイル（`file:`）だけで、ブラウザ版の作品は `vscode-vfs://github/…`
  // にある。ブラウザからブラウザへファイルを渡す道が無い以上、
  // 判定は `canRunProcesses()` と同じところで分かれる
  "novelai.exportPdf",
]);

/**
 * **`novelai.gitSync`（同期）はここに入れない。** ブラウザでは押せて、
 * VS Code のソース管理へ案内する（設計書5.8.9）。gitコマンドは打てないが、
 * **保存する道そのものは在る**ので、行き止まりにしない。
 *
 * **`novelai.addWorkFromGithub`（GitHubから作品を追加）も入れない**
 * （設計書5.8.12）。0.15.2までは塞いで「アドレス欄を書き換えてください」と
 * 案内していたが、それは**いま開いているものを閉じる**遠回りだった。
 * `git clone` の代わりにGitHubの中身を直に読む仕組みを指せば、開き直さずに
 * 登録できる。**やることが同じなら、道具が違っても塞がない。**
 */

/** そのコマンドは、いまの実行環境（Node／ブラウザ）で使えるか */
export function isCommandAvailableInRuntime(
  command: string,
  canRunProcesses: boolean
): boolean {
  return canRunProcesses || !REQUIRES_PROCESSES.has(command);
}

/** ブラウザ版で使えないときの説明 */
export const PROCESSES_BLOCKED_HINT =
  "ブラウザ版では使えません（外部プロセスを起動できないため）";

export function describeProcessesBlocked(command: string): string {
  // **細かく決めたものを先に見る。** 下の `startsWith("novelai.setup")` は
  // 範囲が広く、`novelai.setupGithub` まで飲み込む（実際に飲み込んでいた）
  //
  // **すでに vscode.dev に居る人へ「github.dev を開いてください」と言わない。**
  // 操作ごとに、その場から取れる手を示す
  if (command === "novelai.setupGithub") {
    return (
      "ブラウザ版では、この設定は要りません。" +
      "GitHubのリポジトリを開いている時点で、つながっています。" +
      "保存は「作品管理」→「GitHubと同期」からご覧ください。"
    );
  }
  // **案内文にサービス名を決め打ちしない。** 下の `startsWith("novelai.setup")`
  // は「Ollamaの導入」と言い切るので、LM Studioの案内に混ざると別のものを指す
  // （Geminiを使っているのに「Claudeの…」と出た不具合と同じ形）
  if (command === "novelai.setupLmStudio") {
    return (
      "ブラウザ版のVS Codeでは、LM Studioのような手元で動くAIは使えません" +
      "（外部プロセスを起動できないためです）。" +
      "クラウドのAI（Gemini・OpenAI・さくらのAI Engine・Claude）をお使いください。"
    );
  }
  if (command.startsWith("novelai.setup") || command === "novelai.runFullSetup") {
    return (
      "ブラウザ版のVS Codeでは、Ollamaの導入や外部プロセスの起動ができません。" +
      "クラウドのAI（Gemini・OpenAI・さくらのAI Engine・Claude）をお使いください。"
    );
  }
  if (command === "novelai.gitRestore") {
    return (
      "ブラウザ版では、過去の版に戻せません（gitコマンドを起動できないためです）。" +
      "GitHubのサイトでファイルの履歴を開くと、過去の中身を見て写せます。"
    );
  }
  if (command === "novelai.resolveConflicts") {
    return (
      "ブラウザ版では、競合の解決ができません（gitコマンドを起動できないためです）。" +
      "手元のVS Codeで解決してください。"
    );
  }
  if (command === "novelai.exportPdf") {
    return (
      "ブラウザ版では、印刷用のファイルをブラウザへ渡せません" +
      "（作品がパソコンの中に無いためです）。" +
      "手元のVS Codeで開いてからお使いください。"
    );
  }
  if (command === "novelai.shareWithEditor" || command === "novelai.collectEditorProposals") {
    return (
      "編集部とのやり取りはgitコマンドを使うため、ブラウザ版では使えません。" +
      "手元のVS Codeをお使いください。"
    );
  }
  return PROCESSES_BLOCKED_HINT;
}

/** 一覧を外から見たいとき（テストと画面の説明で使う） */
export function processRequiredCommands(): string[] {
  return [...REQUIRES_PROCESSES].sort();
}
