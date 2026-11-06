import { beforeEach, describe, expect, test } from "vitest";
import { workspace } from "../support/vscodeStub";
import {
  clearSecrets,
  logLine,
  registerSecret,
  setFallbackLogRoot,
  settleLogWrites,
  useLogFile,
} from "../../../src/core/logger";
import {
  CONNECTION_CHECK_LOG_PREFIX,
  connectionCheckLogLine,
} from "../../../src/features/aiConnectionLog";

/**
 * AI接続の確認（`novelai.testAI`）の3つの結果を、actions.log へ1行ずつ残す。
 * 実機確認ではこの記録で裏付けるので、どの段の結果か・AIの種類・モデル・成否・
 * 失敗の種別が1行で読めることと、鍵がファイルへ届かないことを見る。
 */

describe("接続確認の記録の行", () => {
  test("一覧を引く段の成功：段・AIの種類・モデル・成否・モデル数・画面の文が1行に入る", () => {
    const line = connectionCheckLogLine("ollama", "gemma4:e4b", {
      stage: "list",
      ok: true,
      message: "接続しました（モデル12件）",
      modelCount: 12,
    });
    expect(line.startsWith(CONNECTION_CHECK_LOG_PREFIX)).toBe(true);
    expect(line).toContain("一覧を引く");
    expect(line).toContain("成功");
    expect(line).toContain("AI: ollama");
    expect(line).toContain("モデル: gemma4:e4b");
    expect(line).toContain("モデル数: 12");
    expect(line).toContain("画面の文: 接続しました（モデル12件）");
    expect(line).not.toContain("\n");
  });

  test("一覧を引く段の失敗：画面に出した文をそのまま残し、種別は作らない", () => {
    const line = connectionCheckLogLine("lmstudio", "qwen", {
      stage: "list",
      ok: false,
      message: "接続できませんでした: fetch failed",
    });
    expect(line.startsWith(CONNECTION_CHECK_LOG_PREFIX)).toBe(true);
    expect(line).toContain("一覧を引く");
    expect(line).toContain("失敗");
    expect(line).toContain("AI: lmstudio");
    expect(line).toContain("画面の文: 接続できませんでした: fetch failed");
    // 一覧の段は種別を返さない。推測で埋めない（実装ルール5）
    expect(line).not.toContain("種別");
  });

  test("生成を試す段の失敗：分類した種別と生の詳細をそのまま残す", () => {
    const line = connectionCheckLogLine("claude", "claude-x", {
      stage: "generate",
      ok: false,
      kind: "insufficient_credit",
      detail: "HTTP 400\n{\"error\":\"credit balance is too low\"}",
      message: "残高が足りません。",
    });
    expect(line.startsWith(CONNECTION_CHECK_LOG_PREFIX)).toBe(true);
    expect(line).toContain("生成を試す");
    expect(line).toContain("失敗");
    expect(line).toContain("AI: claude");
    expect(line).toContain("モデル: claude-x");
    expect(line).toContain("種別: insufficient_credit");
    expect(line).toContain("credit balance is too low");
    expect(line).toContain("画面の文: 残高が足りません。");
    // 1行に収める（改行は \n の2文字に置き換えて中身は残す）
    expect(line).not.toContain("\n");
    expect(line).toContain("HTTP 400\\n{");
  });

  test("生成を試す段の失敗で種別が無い（AIError でない例外）ときは「不明」と書く", () => {
    const line = connectionCheckLogLine("gemini", "m", {
      stage: "generate",
      ok: false,
      message: "AIを呼び出せませんでした: boom",
    });
    expect(line).toContain("種別: 不明");
    expect(line).toContain("画面の文: AIを呼び出せませんでした: boom");
  });

  test("全部通ったとき：段・成否と画面の文が1行に入る", () => {
    const line = connectionCheckLogLine("sakura", "gpt-oss", {
      stage: "done",
      ok: true,
      message: "接続しました\n使用中: gpt-oss\n生成も確認しました。",
    });
    expect(line.startsWith(CONNECTION_CHECK_LOG_PREFIX)).toBe(true);
    expect(line).toContain("全部通った");
    expect(line).toContain("成功");
    expect(line).toContain("AI: sakura");
    expect(line).toContain("生成も確認しました。");
    expect(line).not.toContain("\n");
  });
});

describe("鍵は actions.log へ届かない", () => {
  let written: string[] = [];

  beforeEach(() => {
    written = [];
    clearSecrets();
    Object.assign(workspace, {
      fs: {
        createDirectory: async () => undefined,
        readFile: async () => {
          throw new Error("まだ無い");
        },
        writeFile: async (_uri: { fsPath: string }, data: Uint8Array) => {
          written.push(new TextDecoder().decode(data));
        },
      },
    });
    setFallbackLogRoot("C:/storage");
    useLogFile(undefined);
  });

  test("詳細に登録済みの鍵や鍵らしき文字列が混ざっても伏せて書く", async () => {
    const key = "my-real-secret-value-1234567890";
    registerSecret(key);
    logLine(
      connectionCheckLogLine("openai", "m", {
        stage: "generate",
        ok: false,
        kind: "authentication_failed",
        detail: `invalid key ${key} / sk-abcdefghijklmnop`,
        message: "鍵が正しくありません。",
      })
    );
    await settleLogWrites();
    const text = written.join("");
    expect(text).toContain(CONNECTION_CHECK_LOG_PREFIX);
    expect(text).not.toContain(key);
    expect(text).not.toContain("sk-abcdefghijklmnop");
    clearSecrets();
  });
});
