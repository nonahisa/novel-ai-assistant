import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

/*
  **Mac として組み立てる。** 拡張機能の側のキーの書き方は `runtime.isMacHost()` で決まるので、
  そこだけを Mac に差し替える（メニューの説明は読み込んだときに直るので、import より先に効く vi.mock で）
*/
vi.mock("../../../src/core/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/runtime")>()),
  isMacHost: () => true,
}));

import { buildGuideBundles, extraGuideForHost } from "../../../src/core/featureGuide";
import { buildPrintGuide, emptyHeaderFooter } from "../../../src/core/printHtml";
import { describeSpotlight } from "../../../src/features/actionSpotlight";
import { buildUserManual } from "../../../src/features/openManual";
import { buildSceneMemoUnrestorableHtml } from "../../../src/views/sceneMemoPanelHtml";

/**
 * Mac の実機の報告（2026-11-07）：キーは ⌘ で効くのに、画面の文が「Ctrl+P で印刷」「Ctrl+Enterで送信」の
 * ままだった。Mac として組み立てた主な画面の文に、Windows の書き方のキーが残らないことを見る。
 *
 * 置き場所は cross（マニュアル・印刷の案内・知らせ・WebView のソースをまたぐため）。
 */

/** Windows の書き方のキー（「Ctrl+」「Shift+」「Alt+」の後ろにキーが続くもの）。「Win+H」は Windows のキーなので見ない */
const WINDOWS_KEY = /(?<![A-Za-z])(?:Ctrl|Shift|Alt)\+\S/;

/**
 * 「右クリック」（作者の問い 2026-11-08「右クリックはMacではどう操作しますか？」）。
 * Mac では文ごとに最初の1回へ「（Mac は control＋クリック）」を添える（`keysInText`）
 */
const RIGHT_CLICK = /右クリック/;
const RIGHT_CLICK_NOTE = "右クリック（Mac は control＋クリック）";

/** 組み立てた文の最初の「右クリック」に添え書きがあるか（無い文・右クリックの無い文は通す） */
function firstRightClickHasNote(text: string): boolean {
  const at = text.indexOf("右クリック");
  return at < 0 || text.startsWith(RIGHT_CLICK_NOTE, at);
}

describe("Mac として組み立てた画面の文に「Ctrl+」が残らない", () => {
  test("マニュアル（画面と考え方・メニューの説明）", () => {
    const manual = buildUserManual();
    const left = manual.split("\n").filter((line) => WINDOWS_KEY.test(line));
    expect(left).toEqual([]);
    expect(manual).toContain("⌘S");
    expect(manual).toContain("⌥⌘T");
  });

  test("AI へ渡す使い方の説明（相談で「ショートカットは？」と訊かれたときの束）", () => {
    expect(extraGuideForHost()).not.toMatch(WINDOWS_KEY);
    const keys = buildGuideBundles().find((bundle) => bundle.key === "keys");
    expect(keys?.text).toContain("⌘F");
    expect(keys?.text).not.toMatch(WINDOWS_KEY);
  });

  test("印刷の案内帯（Mac のブラウザの印刷は ⌘P）", () => {
    const guide = buildPrintGuide("A4", emptyHeaderFooter());
    expect(guide).not.toMatch(WINDOWS_KEY);
    expect(guide).toContain("⌘P で印刷の画面を開き");
    // Windows では今までどおり
    expect(buildPrintGuide("A4", emptyHeaderFooter(), "other")).toContain("Ctrl+P で印刷の画面を開き");
  });

  test("マニュアル・使い方の説明の「右クリック」には、行ごとに最初の1回へ Mac の押し方が添えてある", () => {
    const texts = [buildUserManual(), extraGuideForHost(), ...buildGuideBundles().map((bundle) => bundle.text)];
    const left = texts
      .flatMap((text) => text.split("\n"))
      .filter((line) => !firstRightClickHasNote(line));
    expect(left).toEqual([]);
    expect(buildUserManual()).toContain(RIGHT_CLICK_NOTE);
  });

  test("校正・メモパネルを開き直せない画面・メニューに見当たらないときの知らせ", () => {
    expect(buildSceneMemoUnrestorableHtml("csp")).toContain("⌥⌘M");
    expect(buildSceneMemoUnrestorableHtml("csp")).not.toMatch(WINDOWS_KEY);
    expect(describeSpotlight({ shown: false })).toContain("⇧⌘P");
  });
});

/* ── ソースの見張り：画面に出す文のキーが、必ず直す部品を通っていること ── */

/** 直す部品の呼び方（どれかが同じ行にあれば、その行のキーは OS に合わせて出る） */
const CONVERTERS = ["keysForHost(", "keysInText(", "novelaiKeys(", "data-keys"];

/**
 * 部品を通さない理由がある行（画面に出ない、または出すときに直している）。
 * 足すときは理由を書く。
 */
const ALLOWED: Array<{ file: string; includes: string; why: string }> = [
  {
    file: "src/views/manuscriptEditorHtml.ts",
    includes: "取り消し（Ctrl+Z）で同じ本文が戻ったときに起きます",
    why: "ログ（type: log）へ残す文で、画面には出ない",
  },
  // 原稿エディターの知らせ。入れ先の #note・#unsentText・#saveFailText に data-keys が付いていて、
  // WebView の中の見張り（novelaiApplyKeyLabels）が入った字を直す（下の試験で印を見る）。
  // 台本の文を包まないのは、単体テストが台本を切り出して動かすため（包むと切り出した所で名前が無い）
  ...[
    "「開発者: ウィンドウの再読み込み」を",
    "本文を選んで Ctrl+C で写してください。",
    "Ctrl+S を試してください。",
    "選んだところを写せませんでした。Ctrl+C を試してください",
    "Ctrl+C のあと Delete キーで消してください",
  ].map((includes) => ({
    file: "src/views/manuscriptEditorHtml.ts",
    includes,
    why: "data-keys の付いた知らせの欄へ入る",
  })),
  // 右クリック（2026-11-08）
  ...["IMEを右クリック →「単語の追加」", "IMEを右クリック →「辞書ツール」"].map((includes) => ({
    file: "src/core/imeDictionary.ts",
    includes,
    why: "Windows のタスクバーの IME の操作。Mac では macHowTo（dictionaryHowTo）を出す",
  })),
  {
    file: "src/features/manuscriptEditor.ts",
    includes: "原稿エディタ：右クリックの設定資料——",
    why: "ログへ残す文で、画面には出ない",
  },
  {
    file: "src/views/manuscriptEditorHtml.ts",
    includes: "原稿エディタ：右クリックの位置を本文の位置に直せませんでした",
    why: "ログ（type: log）へ残す文で、画面には出ない",
  },
  {
    file: "src/test/manuscriptTyping.ts",
    includes: "原稿エディター：右クリックの貼り付け・コピーは",
    why: "統合テストの試験の名前で、作者の画面には出ない",
  },
  {
    file: "src/views/epubEditorPanelHtml.ts",
    includes: "<!-- 右クリックの自前メニュー",
    why: "HTML の注釈で、画面には出ない",
  },
];

/** `EXTRA_GUIDE` は Windows の書き方で持ち、出すときに extraGuideForHost で直す */
const EXTRA_GUIDE_FILE = "src/core/featureGuide.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/**
 * 注釈を除いた行の中身。`/* … *\/` は行をまたいで追う（WebView の台本・CSS の注釈も同じ形）。
 * `//` は直前が「:」のもの（https://）を除いて行の注釈とみなす
 */
function codeLines(text: string): Array<{ line: number; code: string }> {
  const result: Array<{ line: number; code: string }> = [];
  let inBlock = false;
  text.split("\n").forEach((raw, index) => {
    let code = "";
    let at = 0;
    while (at < raw.length) {
      if (inBlock) {
        const end = raw.indexOf("*/", at);
        if (end < 0) {
          at = raw.length;
          break;
        }
        inBlock = false;
        at = end + 2;
        continue;
      }
      const block = raw.indexOf("/*", at);
      let lineComment = raw.indexOf("//", at);
      while (lineComment > 0 && raw[lineComment - 1] === ":") lineComment = raw.indexOf("//", lineComment + 2);
      if (lineComment >= 0 && (block < 0 || lineComment < block)) {
        code += raw.slice(at, lineComment);
        at = raw.length;
        break;
      }
      if (block >= 0) {
        code += raw.slice(at, block);
        inBlock = true;
        at = block + 2;
        continue;
      }
      code += raw.slice(at);
      at = raw.length;
    }
    result.push({ line: index + 1, code });
  });
  return result;
}

describe("画面に出す文のキーは、OS に合わせる部品を通す", () => {
  test("原稿エディターの知らせの欄は、キーの書き方を直す印を持ち、台本が見張りを始める", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../src/views/manuscriptEditorHtml.ts"), "utf8");
    for (const id of ["note", "unsentText", "saveFailText"]) {
      expect(source, id).toMatch(new RegExp(`<span id="${id}" data-keys[ >]`));
    }
    expect(source).toContain("novelaiApplyKeyLabels(document);");
  });

  test("src の注釈でない行の「Ctrl+…」「右クリック」は、keysForHost・keysInText・novelaiKeys・data-keys のどれかと同じ行にある", () => {
    const root = path.resolve(__dirname, "../../..");
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(root, "src"))) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (rel === "src/core/keyLabels.ts") continue; // 規則そのもの
      const text = readFileSync(file, "utf8");
      const lines = codeLines(text);
      let inExtraGuide = false;
      for (const { line, code } of lines) {
        if (rel === EXTRA_GUIDE_FILE && code.includes("export const EXTRA_GUIDE = `")) inExtraGuide = true;
        if (inExtraGuide) {
          if (code.startsWith("`.trim();")) inExtraGuide = false;
          continue;
        }
        if (!WINDOWS_KEY.test(code) && !RIGHT_CLICK.test(code)) continue;
        if (CONVERTERS.some((name) => code.includes(name))) continue;
        if (ALLOWED.some((allowed) => allowed.file === rel && code.includes(allowed.includes))) continue;
        offenders.push(`${rel}:${line}: ${code.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
