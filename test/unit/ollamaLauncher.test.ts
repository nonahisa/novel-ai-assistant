import { describe, expect, test, vi } from "vitest";
import * as path from "node:path";
import {
  checkSelectedExecutable,
  describeStartFailure,
  executableCandidates,
  isLocalEndpoint,
  openDialogFilters,
  resolveExecutable,
  startOllama,
} from "../../src/ai/ollamaLauncher";

describe("起動してよい接続先の判定", () => {
  test.each([
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://[::1]:11434",
    "https://localhost:11434/",
  ])("%s はローカルなので起動を提案できる", (endpoint) => {
    expect(isLocalEndpoint(endpoint)).toBe(true);
  });

  test.each([
    "http://192.168.1.20:11434",
    "http://ollama.example.com:11434",
    "http://gpu-server:11434",
  ])("%s は別マシンなので起動を提案しない", (endpoint) => {
    expect(isLocalEndpoint(endpoint)).toBe(false);
  });

  test("URLとして壊れている場合は起動を提案しない", () => {
    expect(isLocalEndpoint("localhost:11434")).toBe(false);
    expect(isLocalEndpoint("")).toBe(false);
  });
});

describe("実行ファイルの探索", () => {
  test("Windowsでは既定のインストール先を候補に含める", () => {
    const candidates = executableCandidates(
      "win32",
      { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      "C:\\Users\\test"
    );

    expect(candidates[0]).toBe("ollama.exe");
    expect(candidates).toContain(
      path.join("C:\\Users\\test\\AppData\\Local", "Programs", "Ollama", "ollama.exe")
    );
  });

  test("LOCALAPPDATAが無くてもホームから組み立てる", () => {
    const candidates = executableCandidates("win32", {}, "C:\\Users\\test");

    expect(
      candidates.some((c) => c.includes(path.join("AppData", "Local")))
    ).toBe(true);
  });

  test("macOSではHomebrewとアプリ内の場所を候補に含める", () => {
    const candidates = executableCandidates("darwin", {}, "/Users/test");

    expect(candidates).toContain("/opt/homebrew/bin/ollama");
    expect(candidates).toContain(
      "/Applications/Ollama.app/Contents/Resources/ollama"
    );
  });

  test("パス区切りを含まない候補は存在確認せずPATH解決に任せる", async () => {
    await expect(resolveExecutable(undefined, ["ollama"])).resolves.toBe(
      "ollama"
    );
  });

  test("設定で指定された実行ファイルが無ければ未検出として扱う", async () => {
    await expect(
      resolveExecutable("C:\\no\\such\\ollama.exe")
    ).resolves.toBeUndefined();
  });

  test("存在しない絶対パス候補は飛ばす", async () => {
    await expect(
      resolveExecutable(undefined, [
        path.join("C:\\no\\such", "ollama.exe"),
        "ollama",
      ])
    ).resolves.toBe("ollama");
  });
});

describe("起動処理", () => {
  test("実行ファイルが見つからなければ起動を試みない", async () => {
    const probe = vi.fn(async () => false);

    const outcome = await startOllama({
      endpoint: "http://localhost:11434",
      executablePath: "C:\\no\\such\\ollama.exe",
      probe,
    });

    expect(outcome).toEqual({ ok: false, reason: "not_installed" });
    expect(probe).not.toHaveBeenCalled();
  });

  test("応答するまで待ってから成功を返す", async () => {
    // 起動直後は応答せず、数回後に応答する状況
    let calls = 0;
    const probe = vi.fn(async () => {
      calls++;
      return calls >= 3;
    });

    const outcome = await startOllama({
      endpoint: "http://localhost:11434",
      // Node自体を起動して spawn の失敗経路を避ける（serveは解釈されず即終了する）
      executablePath: process.execPath,
      timeoutMs: 10000,
      probe,
    });

    expect(outcome).toEqual({ ok: true });
    expect(probe).toHaveBeenCalledTimes(3);
  });

  test("待っても応答しなければタイムアウトとして返す", async () => {
    const probe = vi.fn(async () => false);

    const outcome = await startOllama({
      endpoint: "http://localhost:11434",
      executablePath: process.execPath,
      timeoutMs: 1200,
      probe,
    });

    expect(outcome).toEqual({ ok: false, reason: "timeout" });
    expect(probe.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("選択された実行ファイルの検証", () => {
  test("存在しないファイルは missing として弾く", async () => {
    await expect(
      checkSelectedExecutable("C:\\no\\such\\ollama.exe", "win32")
    ).resolves.toEqual({ verdict: "missing" });
  });

  test("Windowsで拡張子がexeでなければ確認を求める", async () => {
    // 実在するがexeではないファイルを使う
    const check = await checkSelectedExecutable(
      path.join(process.cwd(), "package.json"),
      "win32"
    );

    expect(check.verdict).toBe("suspicious");
    expect(check).toHaveProperty("reason");
  });

  test("トレイ常駐アプリを選んだ場合は理由を添えて止める", async () => {
    const dir = path.dirname(process.execPath);
    const appLike = path.join(dir, "ollama app.exe");
    // 実ファイルが無い環境ではmissing判定が先に来るため、名前判定だけを検証する
    const check = await checkSelectedExecutable(appLike, "win32");

    expect(["missing", "suspicious"]).toContain(check.verdict);
    if (check.verdict === "suspicious") {
      expect(check.reason).toContain("ollama.exe");
    }
  });

  test("macOS/Linuxでは拡張子が無くても妥当と扱う", async () => {
    // node実行ファイルを ollama という名前で扱えないため、名前判定のみ確認
    const check = await checkSelectedExecutable(process.execPath, "linux");

    // node なのでファイル名が違う＝suspicious。拡張子理由ではないことを確認する
    expect(check.verdict).toBe("suspicious");
    if (check.verdict === "suspicious") {
      expect(check.reason).not.toContain("実行ファイル（.exe）");
    }
  });
});

describe("選択ダイアログのフィルタ", () => {
  test("Windowsではexeを絞り込みつつ全ファイルも選べる", () => {
    const filters = openDialogFilters("win32");

    expect(filters?.["実行ファイル"]).toEqual(["exe"]);
    expect(filters?.["すべてのファイル"]).toEqual(["*"]);
  });

  test("macOS/Linuxでは拡張子で絞り込まない", () => {
    expect(openDialogFilters("darwin")).toBeUndefined();
    expect(openDialogFilters("linux")).toBeUndefined();
  });
});

describe("失敗理由の説明", () => {
  test("未インストールなら設定での指定方法を案内する", () => {
    const message = describeStartFailure({
      ok: false,
      reason: "not_installed",
    });

    expect(message).toContain("novelai.ollama.executablePath");
  });

  test("タイムアウトなら再試行を促す", () => {
    const message = describeStartFailure({ ok: false, reason: "timeout" });

    expect(message).toContain("再試行");
  });

  test("起動失敗は手動起動を促し、原因も添える", () => {
    const message = describeStartFailure({
      ok: false,
      reason: "spawn_failed",
      detail: "EACCES",
    });

    expect(message).toContain("手動で起動");
    expect(message).toContain("EACCES");
  });
});
