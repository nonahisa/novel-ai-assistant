import { describe, expect, test } from "vitest";
import {
  browserFromProgId,
  browserFromSetting,
  decideSiteLinkGuide,
  isHelperSiteUrl,
  parseRegProgId,
} from "../../../src/core/externalBrowser";

/**
 * 投稿サイトのリンクを開くブラウザが Chrome か（作者の依頼 2026-10-12）。
 * Chrome でないと分かったときだけ、初回に案内を出す。**読めなければ出さない。**
 */

describe("VS Code の設定 workbench.externalBrowser から", () => {
  test("chrome（名前・実行ファイルのパス）なら Chrome", () => {
    expect(browserFromSetting("chrome")?.chrome).toBe(true);
    expect(browserFromSetting(" Chrome ")?.chrome).toBe(true);
    expect(
      browserFromSetting("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")?.chrome
    ).toBe(true);
  });

  test("edge・firefox は Chrome でなく、名前が分かる", () => {
    expect(browserFromSetting("edge")).toEqual({ chrome: false, name: "Microsoft Edge" });
    expect(browserFromSetting("firefox")).toEqual({ chrome: false, name: "Firefox" });
    expect(
      browserFromSetting("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe")
    ).toEqual({ chrome: false, name: "Microsoft Edge" });
  });

  test("空・未設定なら undefined（OS の既定を見に行く）", () => {
    expect(browserFromSetting(undefined)).toBeUndefined();
    expect(browserFromSetting("")).toBeUndefined();
    expect(browserFromSetting("   ")).toBeUndefined();
  });

  test("知らない名前は Chrome でないとだけ分かる（名前は推し量らない）", () => {
    expect(browserFromSetting("vivaldi")).toEqual({ chrome: false });
  });
});

describe("Windows の既定のブラウザ（ProgId）から", () => {
  test("ChromeHTML（ベータ等の Chrome… も）は Chrome", () => {
    expect(browserFromProgId("ChromeHTML")?.chrome).toBe(true);
    expect(browserFromProgId("ChromeBHTML")?.chrome).toBe(true);
  });

  test("Edge・Firefox（後ろに印が付く）は名前が分かる", () => {
    expect(browserFromProgId("MSEdgeHTM")).toEqual({ chrome: false, name: "Microsoft Edge" });
    expect(browserFromProgId("FirefoxURL-308046B0AF4A39CB")).toEqual({
      chrome: false,
      name: "Firefox",
    });
  });

  test("知らない ProgId は Chrome でない・名前なし。空は undefined", () => {
    expect(browserFromProgId("SomeBrowserURL")).toEqual({ chrome: false });
    expect(browserFromProgId(undefined)).toBeUndefined();
    expect(browserFromProgId("")).toBeUndefined();
  });

  test("reg query の出力から ProgId を拾う", () => {
    const stdout =
      "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice\r\n" +
      "    ProgId    REG_SZ    MSEdgeHTM\r\n\r\n";
    expect(parseRegProgId(stdout)).toBe("MSEdgeHTM");
    expect(parseRegProgId("エラー: 指定されたレジストリ キーまたは値が見つかりませんでした。")).toBeUndefined();
  });
});

describe("案内を出すか", () => {
  test("設定が chrome なら出さない（登録簿が Edge でも）", () => {
    expect(decideSiteLinkGuide({ setting: "chrome", progId: "MSEdgeHTM", shown: false })).toEqual({
      show: false,
    });
  });

  test("設定が空で ProgId が ChromeHTML なら出さない", () => {
    expect(decideSiteLinkGuide({ setting: "", progId: "ChromeHTML", shown: false })).toEqual({
      show: false,
    });
  });

  test("設定が空で ProgId が Edge なら、名前つきで出す", () => {
    expect(decideSiteLinkGuide({ setting: undefined, progId: "MSEdgeHTM", shown: false })).toEqual({
      show: true,
      browserName: "Microsoft Edge",
    });
  });

  test("名前の分からないブラウザは「既定のブラウザ」と書く", () => {
    expect(decideSiteLinkGuide({ setting: "", progId: "SomeBrowserURL", shown: false })).toEqual({
      show: true,
      browserName: "既定のブラウザ",
    });
  });

  test("設定も登録簿も読めなければ出さない（推し量らない）", () => {
    expect(decideSiteLinkGuide({ setting: undefined, progId: undefined, shown: false })).toEqual({
      show: false,
    });
  });

  test("一度出したら、Edge でも出さない", () => {
    expect(decideSiteLinkGuide({ setting: "edge", progId: "MSEdgeHTM", shown: true })).toEqual({
      show: false,
    });
  });
});

describe("ヘルパーが働くサイトのリンクか", () => {
  test("投稿サイトと Narou.fun", () => {
    expect(isHelperSiteUrl("https://kakuyomu.jp/my/works/1/episodes/new")).toBe(true);
    expect(isHelperSiteUrl("https://ncode.syosetu.com/n1234ab/")).toBe(true);
    expect(isHelperSiteUrl("https://www.alphapolis.co.jp/novel/1/2")).toBe(true);
    expect(isHelperSiteUrl("https://note.com/someone")).toBe(true);
    expect(isHelperSiteUrl("https://db.narou.fun/novels/n1234ab")).toBe(true);
  });

  test("ほかのサイト・似せたドメイン・http(s) でないものは違う", () => {
    expect(isHelperSiteUrl("https://github.com/nonahisa/novel-ai-helper")).toBe(false);
    expect(isHelperSiteUrl("https://example.com/contest")).toBe(false);
    expect(isHelperSiteUrl("https://evilkakuyomu.jp/")).toBe(false);
    expect(isHelperSiteUrl("javascript:alert(1)")).toBe(false);
    expect(isHelperSiteUrl("壊れたURL")).toBe(false);
  });
});
