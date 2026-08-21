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
  "novelai.addWorkFromGithub",
  "novelai.gitRestore",
  "novelai.setupGithub",
  "novelai.setupOllama",
  "novelai.runFullSetup",
  "novelai.setupVectorSearch",
  "novelai.gitSync",
  "novelai.resolveConflicts",
  "novelai.selectOllamaExecutable",
  "novelai.shareWithEditor",
  "novelai.collectEditorProposals",
]);

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
  if (command.startsWith("novelai.setup") || command === "novelai.runFullSetup") {
    return (
      "ブラウザ版のVS Codeでは、Ollamaの導入や外部プロセスの起動ができません。" +
      "クラウドのAI（Gemini・OpenAI・さくらのAI Engine・Claude）をお使いください。"
    );
  }
  if (
    command.startsWith("novelai.git") ||
    command === "novelai.addWorkFromGithub" ||
    command === "novelai.resolveConflicts"
  ) {
    return (
      "ブラウザ版のVS Codeでは、gitコマンドを起動できません。" +
      "GitHubのリポジトリを直接開く（github.dev）か、手元のVS Codeをお使いください。"
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
