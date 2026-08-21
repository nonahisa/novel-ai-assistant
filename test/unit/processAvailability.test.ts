import { describe, expect, it } from "vitest";
import {
  describeProcessesBlocked,
  isCommandAvailableInRuntime,
  processRequiredCommands,
} from "../../src/core/processAvailability";
import { allActions } from "../../src/views/actionList";

/**
 * ブラウザ版では使えない操作（設計書5.8.5）。
 *
 * `editorMode.ts` と同じ「消すのではなく、押せなくして理由を出す」考え方。
 * ここで見張るのは、**一覧（`REQUIRES_PROCESSES`）が実際のコマンドと
 * ずれていないか**——`extension.ts` で `canRunProcesses()` を確かめている
 * コマンドと、ここに並ぶIDが1対1で揃っているかは、機械でしか見張れない
 * （この作品で繰り返し起きている「対策は書いたが一部の経路だけ通っていない」
 * という失敗の形）。
 */

describe("実行環境で使えるか", () => {
  it("一覧に無いコマンドは、環境を問わず使える", () => {
    expect(isCommandAvailableInRuntime("novelai.checkTypos", true)).toBe(
      true
    );
    expect(isCommandAvailableInRuntime("novelai.checkTypos", false)).toBe(
      true
    );
  });

  it("一覧にあるコマンドは、外部プロセスを起動できるときだけ使える", () => {
    // 競合の解決は、ブラウザに代わりの道が無い（手元でやるしかない）
    expect(isCommandAvailableInRuntime("novelai.resolveConflicts", true)).toBe(
      true
    );
    expect(isCommandAvailableInRuntime("novelai.resolveConflicts", false)).toBe(
      false
    );
  });
});

describe("一覧に挙げたコマンドは、すべて操作メニューに実在する", () => {
  // **打ち間違えたIDを機械で見つける。** 存在しないコマンドを禁じても、
  // 何も止められていないのに気づけない
  const commands = new Set(allActions().map((a) => a.command));

  for (const command of processRequiredCommands()) {
    it(command, () => {
      expect(commands.has(command), command).toBe(true);
    });
  }
});

describe("押せない理由の説明", () => {
  it("Ollama・パッケージ導入は、クラウドAIへの案内を出す", () => {
    expect(describeProcessesBlocked("novelai.setupOllama")).toContain(
      "クラウドのAI"
    );
    expect(describeProcessesBlocked("novelai.runFullSetup")).toContain(
      "クラウドのAI"
    );
  });

  /**
   * **すでに vscode.dev に居る人へ「github.dev を開いてください」と言わない。**
   * 操作ごとに、その場から取れる手を示す。
   */
  it("別のリポジトリを開く道を、その場のやり方で示す", () => {
    const text = describeProcessesBlocked("novelai.addWorkFromGithub");
    expect(text).toContain("vscode.dev");
    // 開いたあと何をすればよいかまで書く
    expect(text).toContain("フォルダから作品を追加");
  });

  it("過去の版は、GitHubのサイトで見られると伝える", () => {
    expect(describeProcessesBlocked("novelai.gitRestore")).toContain("GitHub");
  });

  it("同期の設定は、ブラウザでは要らないと伝える", () => {
    expect(describeProcessesBlocked("novelai.setupGithub")).toContain("要りません");
  });

  it("競合の解決は、手元でと伝える", () => {
    expect(describeProcessesBlocked("novelai.resolveConflicts")).toContain(
      "手元のVS Code"
    );
  });

  it("同期そのものは塞がない（ソース管理へ案内するため）", () => {
    // **行き止まりにしない。** gitコマンドは打てないが、保存する道は在る
    expect(isCommandAvailableInRuntime("novelai.gitSync", false)).toBe(true);
  });

  it("編集部とのやり取りは、手元への案内を出す", () => {
    expect(describeProcessesBlocked("novelai.shareWithEditor")).toContain(
      "手元のVS Code"
    );
  });

  it("知らないコマンドでも、既定の説明を返す（落ちない）", () => {
    expect(describeProcessesBlocked("novelai.unknown")).toBeTruthy();
  });
});
