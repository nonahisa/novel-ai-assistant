import { describe, expect, test } from "vitest";
import {
  SETUP_STEPS,
  SETUP_URI_PATH,
  alreadyRegisteredNotice,
  buildSetupUri,
  describeSetupRequest,
  parseSetupQuery,
  setupRequestForLog,
  validateSetupRequest,
} from "../../../src/core/setupRequest";

/**
 * Claude Code からのセットアップの依頼（設計書6.87.18）。
 *
 * **URI はウェブページのリンク1つでも開かせられる。** だから受け口は
 * 白名簿で確かめる——知らない段・知らない鍵・長すぎる値・制御文字は断る。
 * MCP の道具（開く側）と拡張機能（受ける側）が**同じ判定**を使うので、
 * 片方だけ通る依頼は作れない。
 */

function queryOf(uri: string): string {
  const index = uri.indexOf("?");
  return index < 0 ? "" : uri.slice(index + 1);
}

describe("段の表", () => {
  test("段の名前は重ならない", () => {
    const steps = SETUP_STEPS.map((def) => def.step);
    expect(new Set(steps).size).toBe(steps.length);
  });

  test("どの段も、呼ぶコマンドと画面に出す名前を持つ", () => {
    for (const def of SETUP_STEPS) {
      expect(def.command).toMatch(/^novelai\./u);
      expect(def.label.length).toBeGreaterThan(0);
    }
  });

  test("決まった8段がある", () => {
    expect(SETUP_STEPS.map((def) => def.step).sort()).toEqual(
      [
        "ai",
        "create",
        "diagnosis",
        "external-access",
        "lmstudio",
        "ollama",
        "register",
        "vector",
      ].sort()
    );
  });
});

describe("組んで読むと、同じ依頼に戻る", () => {
  test("引数の無い段", () => {
    const uri = buildSetupUri({ step: "ollama" });
    expect(uri).toBe(`vscode://nonahisa.novel-ai-assistant${SETUP_URI_PATH}?step=ollama`);
    expect(parseSetupQuery(queryOf(uri))).toEqual({
      ok: true,
      request: { step: "ollama" },
    });
  });

  test("作成：日本語の作品名と種類・形式・始め方", () => {
    const request = {
      step: "create" as const,
      title: "星の降る町 & 第二部",
      kind: "novel" as const,
      format: "long" as const,
      start: "plot" as const,
    };
    const parsed = parseSetupQuery(queryOf(buildSetupUri(request)));
    expect(parsed).toEqual({ ok: true, request });
  });

  test("登録：空白と日本語を含む絶対パス", () => {
    const request = {
      step: "register" as const,
      path: "C:\\Users\\作者\\Documents\\小説 置き場\\星の町",
      title: "星の町",
    };
    expect(parseSetupQuery(queryOf(buildSetupUri(request)))).toEqual({
      ok: true,
      request,
    });
  });

  test("登録：アドレス欄から貼って紛れ込んだ前後の空白は落として受ける（2026-09-24）", () => {
    // ` C:\…` は先頭が空白なので、落とさないと「絶対パスでない」と断っていた
    const parsed = validateSetupRequest({
      step: "register",
      path: "  C:\\Users\\nonah\\Documents\\novels  ",
    });
    expect(parsed).toEqual({
      ok: true,
      request: { step: "register", path: "C:\\Users\\nonah\\Documents\\novels" },
    });
  });
});

describe("登録済みの場所が来たとき", () => {
  test("失敗とは言わず、どの作品として登録済みかを添えて次へ進める", () => {
    const notice = alreadyRegisteredNotice("たゆたう鉛");
    expect(notice).toContain("「たゆたう鉛」");
    expect(notice).toContain("すでに登録されています");
    expect(notice).toContain("次へ進めます");
    expect(notice).not.toMatch(/失敗|できませんでした/u);
  });
});

describe("断る", () => {
  test("知らない段", () => {
    const result = parseSetupQuery("step=format-disk");
    expect(result.ok).toBe(false);
  });

  test("段が無い", () => {
    expect(parseSetupQuery("title=x").ok).toBe(false);
  });

  test("知らない鍵は、名前を挙げて断る（黙って落とさない）", () => {
    const result = parseSetupQuery("step=ollama&force=1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("force");
  });

  test("その段が受けない鍵も断る", () => {
    // 導入の段に作品名を渡しても意味が無い。**受けたふりをしない**
    expect(parseSetupQuery("step=ollama&title=x").ok).toBe(false);
  });

  test("同じ鍵が2つ", () => {
    expect(parseSetupQuery("step=create&title=a&title=b").ok).toBe(false);
  });

  test("登録にパスが無い", () => {
    expect(parseSetupQuery("step=register").ok).toBe(false);
  });

  test("相対パス", () => {
    expect(
      parseSetupQuery(`step=register&path=${encodeURIComponent("..\\作品")}`).ok
    ).toBe(false);
  });

  test("制御文字を含む値", () => {
    const title = `題${String.fromCharCode(0)}名`;
    expect(
      parseSetupQuery(`step=create&title=${encodeURIComponent(title)}`).ok
    ).toBe(false);
  });

  test("フォルダー名に使えない文字を含む作品名", () => {
    expect(validateSetupRequest({ step: "create", title: "a/b" }).ok).toBe(false);
    expect(validateSetupRequest({ step: "create", title: "   " }).ok).toBe(false);
  });

  test("長すぎる値", () => {
    expect(
      validateSetupRequest({ step: "create", title: "あ".repeat(201) }).ok
    ).toBe(false);
  });

  test("知らない種類・形式・始め方", () => {
    expect(validateSetupRequest({ step: "create", kind: "poem" }).ok).toBe(false);
    expect(validateSetupRequest({ step: "create", format: "huge" }).ok).toBe(false);
    expect(validateSetupRequest({ step: "create", start: "later" }).ok).toBe(false);
  });

  test("読めるだけの古い形式（脚本）は選ばせない", () => {
    // 台本は種類で選ぶ（設計書6.109）
    expect(validateSetupRequest({ step: "create", format: "script" }).ok).toBe(false);
  });

  test("「いまは決めない」は形式として受ける", () => {
    expect(validateSetupRequest({ step: "create", format: "unset" }).ok).toBe(true);
  });

  test("文字列でない値", () => {
    expect(validateSetupRequest({ step: "create", title: 3 }).ok).toBe(false);
  });
});

describe("作者に見せる文と、記録に残す文", () => {
  test("確認には、受けた答えを全部並べる", () => {
    const lines = describeSetupRequest({
      step: "create",
      title: "星の町",
      kind: "novel",
      format: "long",
      start: "plot",
    });
    const text = lines.join("\n");
    expect(text).toContain("星の町");
    expect(text).toContain("小説");
    expect(text).toContain("長編");
    expect(text).toContain("プロット");
  });

  test("記録には値（作品名・パス）を入れない", () => {
    const line = setupRequestForLog({
      step: "register",
      path: "C:\\秘密の作品",
      title: "秘密",
    });
    expect(line).toContain("register");
    expect(line).toContain("path");
    expect(line).not.toContain("秘密");
  });
});
