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
    expect(isCommandAvailableInRuntime("novelai.gitSync", true)).toBe(true);
    expect(isCommandAvailableInRuntime("novelai.gitSync", false)).toBe(false);
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

  it("git系は、github.devか手元への案内を出す", () => {
    expect(describeProcessesBlocked("novelai.gitSync")).toContain(
      "github.dev"
    );
    expect(describeProcessesBlocked("novelai.addWorkFromGithub")).toContain(
      "github.dev"
    );
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
