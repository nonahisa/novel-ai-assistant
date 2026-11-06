import { describe, expect, test, vi } from "vitest";
import {
  detectPackageManager,
  installWithBrew,
  interpretBrewResult,
  type CommandResult,
} from "../../../src/core/packageInstall";
import {
  REQUIREMENTS,
  manualInstallNote,
} from "../../../src/core/requirements";

/**
 * WindowsのほかにMacとLinuxでも案内する（作者の指示、2026-08-19）。
 *
 * これまで自動で入るのは **Windowsのwingetだけ**で、それ以外は
 * 「配布ページを開く」で終わっていた。Marketplaceで配っている以上、
 * Macの方も入れる。
 *
 * **Linuxは自動で入れない。** 公式の案内が `curl … | sh` の形で、
 * **取ってきたスクリプトを拡張機能が黙って実行するのは筋が悪い。**
 * 何が走るのかを見せて、作者に判断してもらう。
 */
function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}
function ng(stdout = "", code = 1): CommandResult {
  return { code, stdout, stderr: "" };
}

describe("使えるパッケージ管理を調べる", () => {
  test("Windowsで winget があれば winget", async () => {
    const run = vi.fn(async () => ok("v1.6"));

    expect(await detectPackageManager(run, "win32")).toBe("winget");
    expect(run).toHaveBeenCalledWith("winget", ["--version"], {
      timeoutMs: 15000,
    });
  });

  test("Windowsで winget が無ければ none", async () => {
    expect(await detectPackageManager(async () => ng(), "win32")).toBe("none");
  });

  test("macOSで Homebrew があれば brew", async () => {
    expect(await detectPackageManager(async () => ok("4.0"), "darwin")).toBe(
      "brew"
    );
  });

  test("macOSで Homebrew が無ければ manual", async () => {
    // **「入れられない」で終わらせない。** 配布ページから入れる道は残る
    expect(await detectPackageManager(async () => ng(), "darwin")).toBe(
      "manual"
    );
  });

  test("Linuxは manual", async () => {
    // **自動では入れない。** 何が走るかを見せて作者に判断してもらう
    const run = vi.fn(async () => ok());

    expect(await detectPackageManager(run, "linux")).toBe("manual");
    expect(run).not.toHaveBeenCalled();
  });

  test("知らないOSは none", async () => {
    expect(await detectPackageManager(async () => ok(), "aix")).toBe("none");
  });
});

describe("Homebrewの結果を読む", () => {
  test("成功", () => {
    expect(interpretBrewResult(ok()).kind).toBe("installed");
  });

  test("すでに入っているのは、失敗ではない", () => {
    // **終了コードだけで決めない**（wingetと同じ理由）
    expect(interpretBrewResult(ng("ollama is already installed")).kind).toBe(
      "already"
    );
  });

  test("時間切れは、その旨を出す", () => {
    const outcome = interpretBrewResult({ code: -1, stdout: "", stderr: "" });

    expect(outcome.kind).toBe("failed");
    expect(outcome).toHaveProperty("detail", expect.stringContaining("回線"));
  });

  test("失敗したら、出力の末尾を理由として渡す", () => {
    const outcome = interpretBrewResult(ng("line1\nline2\nError: no formula"));

    expect(outcome.kind).toBe("failed");
    expect(JSON.stringify(outcome)).toContain("no formula");
  });

  test("brew install を呼ぶ", async () => {
    const run = vi.fn(async () => ok());
    await installWithBrew("ollama", { run });

    expect(run).toHaveBeenCalledWith(
      "brew",
      ["install", "ollama"],
      expect.objectContaining({ timeoutMs: 20 * 60 * 1000 })
    );
  });
});

describe("要件ごとの入れ方", () => {
  const ollama = REQUIREMENTS.find((r) => r.id === "ollama")!;

  test("Ollamaは3つのOSぶん揃っている", () => {
    expect(ollama.wingetId).toBe("Ollama.Ollama");
    expect(ollama.brewFormula).toBe("ollama");
    expect(ollama.manualSteps?.command).toContain("ollama.com/install.sh");
  });

  test("手順には、配布ページも添える", () => {
    // **コマンドが使えない環境もある。** 逃げ道を残す
    expect(ollama.manualSteps?.page).toContain("ollama.com");
  });

  test("スクリプトを実行することを、隠さずに書く", () => {
    // **取ってきたスクリプトをそのまま実行する形である。**
    // それを伏せて「この1行で入ります」とだけ言わない
    expect(ollama.manualSteps?.note).toContain("スクリプト");
  });

  test("Macの案内に「Linux」と出さない", () => {
    // Homebrew の無い Mac でも install.sh の1行を出すが、添え書きが
    // 「Linuxでは、この1行で入ります」のままで、Mac の方を迷わせていた
    const note = manualInstallNote(ollama.manualSteps!, "darwin");

    expect(note).not.toContain("Linux");
    expect(note).toContain("Mac");
    expect(note).toContain("スクリプト");
  });

  test("Linuxの案内は、これまでの文のまま", () => {
    const note = manualInstallNote(ollama.manualSteps!, "linux");

    expect(note).toBe(ollama.manualSteps!.note);
    expect(note).toContain("Linuxでは、この1行で入ります。");
  });

  test("GitとGitHub CLIも、Macの案内に「Linux」「apt」と出さない", () => {
    // Homebrew の無い Mac で「多くのLinuxでは…sudo apt install」と出ていた
    for (const id of ["git", "gh"]) {
      const requirement = REQUIREMENTS.find((r) => r.id === id)!;
      const note = manualInstallNote(requirement.manualSteps!, "darwin");

      expect(note, id).not.toContain("Linux");
      expect(note, id).not.toContain("apt");
      expect(note, id).toContain("Mac");
    }
  });

  test("GitのMacの案内は、Appleのコマンドラインツールの道を示す", () => {
    // git-scm.com の Mac の頁が示す入れ方（2026-11-06 に確かめた）
    const git = REQUIREMENTS.find((r) => r.id === "git")!;

    expect(manualInstallNote(git.manualSteps!, "darwin")).toContain(
      "xcode-select --install"
    );
  });

  test("GitとGitHub CLIのLinuxの案内は、これまでの文のまま", () => {
    for (const id of ["git", "gh"]) {
      const requirement = REQUIREMENTS.find((r) => r.id === id)!;

      expect(manualInstallNote(requirement.manualSteps!, "linux"), id).toBe(
        `多くのLinuxでは、パッケージ管理から入ります（例：sudo apt install ${id}）。`
      );
    }
  });

  test("GitとGitHub CLIにも入れ方がある", () => {
    for (const id of ["git", "gh"]) {
      const requirement = REQUIREMENTS.find((r) => r.id === id)!;
      expect(requirement.brewFormula, id).toBeTruthy();
      expect(requirement.manualSteps?.page, id).toBeTruthy();
    }
  });

  test("モデルはパッケージ管理では入らない", () => {
    // Ollama自身が取得するもので、winget や brew の対象ではない
    for (const id of ["chatModel", "embeddingModel"]) {
      const requirement = REQUIREMENTS.find((r) => r.id === id)!;
      expect(requirement.wingetId, id).toBeUndefined();
      expect(requirement.brewFormula, id).toBeUndefined();
    }
  });
});
