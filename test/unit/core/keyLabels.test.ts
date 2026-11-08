import { describe, expect, test } from "vitest";
import { KEY_LABEL_SCRIPT, keyLabel, keysInText } from "../../../src/core/keyLabels";

/**
 * 画面に出すキーの名前を OS に合わせる部品（2026-11-07、Mac の実機の報告「画面の文が Ctrl のまま」）。
 *
 * 書き方は VS Code が Mac で出す札（「⌥⌘M」）に合わせる。WebView の中の台本（`KEY_LABEL_SCRIPT`）も
 * 同じ直し方をすることを、同じ見本で突き合わせる。
 */

/** WebView の台本を、偽の navigator の上で動かして `novelaiKeys` を取り出す */
function scriptKeys(platform: string, userAgentPlatform?: string): (text: string) => string {
  const navigator = {
    platform,
    userAgentData: userAgentPlatform === undefined ? undefined : { platform: userAgentPlatform },
  };
  const factory = new Function("navigator", `${KEY_LABEL_SCRIPT}\nreturn novelaiKeys;`) as (
    nav: typeof navigator
  ) => (text: string) => string;
  return factory(navigator);
}

/** 実際に画面へ出している文の形（Mac での書き方） */
const SAMPLES: Array<[string, string]> = [
  ["Ctrl+P で印刷の画面を開き", "⌘P で印刷の画面を開き"],
  ["聞きたいことを書いてください（Ctrl+Enterで送信）", "聞きたいことを書いてください（⌘Enterで送信）"],
  ["整えたあとは Ctrl+Z で元に戻せます。", "整えたあとは ⌘Z で元に戻せます。"],
  ["コマンドパレット（Ctrl+Shift+P）から", "コマンドパレット（⇧⌘P）から"],
  ["全部選んでコピー（Ctrl+A → Ctrl+C）し、", "全部選んでコピー（⌘A → ⌘C）し、"],
  [".md はプレビュー（Ctrl+Shift+V）で", ".md はプレビュー（⇧⌘V）で"],
  ["Ctrl+Alt+K: 傍点", "⌥⌘K: 傍点"],
  ["Ctrl+/: ここにメモを足す", "⌘/: ここにメモを足す"],
  ["F8 / Shift+F8: 次のメモへ", "F8 / ⇧F8: 次のメモへ"],
  ["Alt+↑ / Alt+↓: 前の話", "⌥↑ / ⌥↓: 前の話"],
  ["Ctrl+＋ / Ctrl+－ / Ctrl+0、Ctrl+マウスホイール", "⌘＋ / ⌘－ / ⌘0、⌘+マウスホイール"],
  ["Ctrl+Z / Ctrl+Y: 取り消し / やり直し", "⌘Z / ⇧⌘Z: 取り消し / やり直し"],
  ["「キーボード ショートカット」（Ctrl+K Ctrl+S）", "「キーボード ショートカット」（⌘K ⌘S）"],
  ["Enter で次、Shift+Enter で前", "Enter で次、⇧Enter で前"],
  ["Ctrl+Alt+… と Ctrl+/・F8 のキー", "⌥⌘… と ⌘/・F8 のキー"],
  ["図を小さくします（Ctrl+－。Ctrl+ホイールを奥へ）", "図を小さくします（⌘－。⌘+ホイールを奥へ）"],
  // 右クリックには、文ごとに最初の1回だけ Mac の押し方を添える（2026-11-08 作者の問い）
  ["作品を右クリックして選びます", "作品を右クリック（Mac は control＋クリック）して選びます"],
  [
    "話を右クリック →「名前を変える」。章も右クリックで同じ",
    "話を右クリック（Mac は control＋クリック） →「名前を変える」。章も右クリックで同じ",
  ],
  ["Ctrl+S のあと右クリック", "⌘S のあと右クリック（Mac は control＋クリック）"],
  // 行が変われば、また添える（マニュアルは1つの長い文字列で、行ずつ拾い読みされる）
  [
    "- 話を右クリック\n- 章を右クリック",
    "- 話を右クリック（Mac は control＋クリック）\n- 章を右クリック（Mac は control＋クリック）",
  ],
  // もう添えてある文には足さない（WebView の見張りが同じ字を何度も直すため）
  ["右クリック（Mac は control＋クリック）で開く", "右クリック（Mac は control＋クリック）で開く"],
  // Windows のキーと、キーでない「+」には触らない
  ["Windowsは Win+H、macOSは fnキー", "Windowsは Win+H、macOSは fnキー"],
  ["XCtrl+P と 1+2", "XCtrl+P と 1+2"],
];

describe("keyLabel（keybindings の書き方 → 札）", () => {
  test("Windows は Ctrl+Alt+M、Mac は ⌥⌘M。並びは Ctrl → Shift → Alt → Cmd", () => {
    expect(keyLabel("ctrl+alt+m", "other")).toBe("Ctrl+Alt+M");
    expect(keyLabel("cmd+alt+m", "mac")).toBe("⌥⌘M");
    expect(keyLabel("cmd+shift+ctrl+alt+k", "mac")).toBe("⌃⇧⌥⌘K");
    expect(keyLabel("alt+shift+ctrl+k", "other")).toBe("Ctrl+Shift+Alt+K");
    expect(keyLabel("cmd+/", "mac")).toBe("⌘/");
    expect(keyLabel("shift+f8", "mac")).toBe("⇧F8");
  });

  test("2段のキーは空白でつなぐ", () => {
    expect(keyLabel("ctrl+k ctrl+s", "other")).toBe("Ctrl+K Ctrl+S");
    expect(keyLabel("cmd+k cmd+s", "mac")).toBe("⌘K ⌘S");
  });

  test("読めない修飾・キーは黙って別の札を作らずに止める", () => {
    expect(() => keyLabel("hyper+k", "mac")).toThrow(/修飾/);
    expect(() => keyLabel("ctrl+pagedown", "other")).toThrow(/札/);
  });
});

describe("keysInText（文の中のキー）", () => {
  test("Windows・Linux では文を変えない", () => {
    for (const [windows] of SAMPLES) expect(keysInText(windows, "other")).toBe(windows);
  });

  test("Mac では ⌘・⇧・⌥ の札にする（Ctrl は Mac のふだんの修飾 ⌘）", () => {
    for (const [windows, mac] of SAMPLES) expect(keysInText(windows, "mac"), windows).toBe(mac);
  });
});

describe("WebView の台本（KEY_LABEL_SCRIPT）", () => {
  test("Mac の WebView では keysInText と同じ直し方をする（navigator.platform）", () => {
    const keys = scriptKeys("MacIntel");
    for (const [windows] of SAMPLES) expect(keys(windows), windows).toBe(keysInText(windows, "mac"));
  });

  test("userAgentData があればそちらを見る", () => {
    expect(scriptKeys("", "macOS")("Ctrl+S")).toBe("⌘S");
    expect(scriptKeys("MacIntel", "Windows")("Ctrl+S")).toBe("Ctrl+S");
  });

  test("Windows の WebView では文を変えない", () => {
    const keys = scriptKeys("Win32");
    for (const [windows] of SAMPLES) expect(keys(windows)).toBe(windows);
  });

  test("data-keys の要素：属性と字を直し、あとから入った知らせの字も直す（Mac のときだけ）", () => {
    for (const platform of ["MacIntel", "Win32"]) {
      const attributes: Record<string, string> = { title: "保存（Ctrl+S）" };
      const element = {
        nodeType: 1,
        children: [] as unknown[],
        textContent: "Ctrl+C で写してください",
        getAttribute: (name: string) => attributes[name] ?? null,
        setAttribute: (name: string, value: string) => {
          attributes[name] = value;
        },
      };
      const watchers: Array<(records: Array<{ target: unknown }>) => void> = [];
      class FakeObserver {
        constructor(callback: (records: Array<{ target: unknown }>) => void) {
          watchers.push(callback);
        }
        observe(): void {}
      }
      const document = { querySelectorAll: () => [element] };
      const apply = new Function(
        "navigator",
        "document",
        "MutationObserver",
        `${KEY_LABEL_SCRIPT}\nreturn novelaiApplyKeyLabels;`
      )({ platform }, document, FakeObserver) as (root: unknown) => void;
      apply(document);
      element.textContent = "保存の返事がありません。Ctrl+S を試してください。";
      for (const watch of watchers) watch([{ target: element }]);
      if (platform === "MacIntel") {
        expect(attributes.title).toBe("保存（⌘S）");
        expect(element.textContent).toBe("保存の返事がありません。⌘S を試してください。");
      } else {
        expect(attributes.title).toBe("保存（Ctrl+S）");
        expect(element.textContent).toContain("Ctrl+S");
        expect(watchers).toEqual([]);
      }
    }
  });

  test("埋め込む先のテンプレートリテラルを壊す字を持たない", () => {
    expect(KEY_LABEL_SCRIPT).not.toContain("`");
    expect(KEY_LABEL_SCRIPT).not.toContain("${");
  });
});
