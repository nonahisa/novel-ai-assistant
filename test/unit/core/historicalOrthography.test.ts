import { describe, expect, test } from "vitest";
import {
  KYUJITAI_TO_SHINJITAI,
  onlyModernization,
} from "../../../src/core/historicalOrthography";
import { validateTypoIssues } from "../../../src/core/typoCheckValidation";
import type { Chunk } from "../../../src/core/chunker";

/**
 * 誤字脱字の検算で、**旧字体→新字体・歴史的仮名遣い→現代仮名遣いへ置き換えるだけの
 * 提案**を、文語体の作品では落とす（作者の裁定、2026-10-15 の5）。
 *
 * 測定（docs/measurements/2026-10-15-ai-measure.md の 2552）で、じいちゃんの自分史
 * （文語体）に「機會→機会」「やうやく→ようやく」「だらう→だろう」が画面まで残った。
 * これまでの検算は決まった語の一覧（`ARCHAIC_FORMS`）だけだったため。
 *
 * **誤検出と見逃しの両方を見張る**（CLAUDE.md の失敗2）。落とす側だけを試すと、
 * 何でも落とす実装が満点になる。
 */

function chunkOf(text: string): Chunk {
  return {
    filePath: "C:/works/x/episode_0001.txt",
    text,
    startLine: 0,
    hash: "h",
  } as Chunk;
}

function judgeIn(archaicWork: boolean, text: string, target: string, suggestion: string) {
  return validateTypoIssues(
    {
      issues: [
        {
          line: 1,
          original: text,
          target,
          suggestion,
          reason: "誤変換",
          confidence: "medium",
        },
      ],
    },
    chunkOf(text),
    [],
    [],
    { archaicWork }
  );
}

/** 測定で実際に返った、現代表記へ直すだけの提案（旧字・旧かなの範囲のもの） */
const MEASURED: Array<[string, string, string]> = [
  ["やうやく辿り着いた。", "やうやく", "ようやく"],
  ["好い機會であつた。", "機會", "機会"],
  ["上官を毆打した。", "毆打", "殴打"],
  ["幾日か經り、", "經り", "経り"],
  ["さうであらう。", "あらう", "あろう"],
  ["雨になるだらう。", "だらう", "だろう"],
];

describe("旧字・旧かなを今の書き方へ置き換えるだけの提案（文語体の作品なら落とす）", () => {
  test.each(MEASURED)("落とす: %s の「%s」→「%s」", (text, target, suggestion) => {
    const result = judgeIn(true, text, target, suggestion);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("archaic_form");
  });

  test.each([
    ["與へて", "与えて"],
    ["ゐる", "いる"],
    ["ゑがお", "えがお"],
    ["言ふ", "言う"],
    ["思ひ出", "思い出"],
    ["かへる", "かえる"],
    ["おほきい", "おおきい"],
    ["とほる", "とおる"],
    ["會ふ", "会う"],
    ["しやう", "しょう"],
    ["やつて來た", "やって来た"],
    ["けふ", "きょう"],
    ["てふてふ", "ちょうちょう"],
    ["くわし", "かし"],
    ["ちぢむ", "ちじむ"],
    ["學校へ歸る", "学校へ帰る"],
    ["國體", "国体"],
  ])("置き換えだけと見る: 「%s」→「%s」", (target, suggestion) => {
    expect(onlyModernization(target, suggestion)).toBe(true);
  });
});

describe("本物の誤字を巻き込まない（見逃しの見張り）", () => {
  test.each(MEASURED)(
    "現代文の作品では落とさない（R17 の門）: %s",
    (text, target, suggestion) => {
      const result = judgeIn(false, text, target, suggestion);
      expect(result.rejected.filter((entry) => entry.reason === "archaic_form")).toEqual([]);
    }
  );

  test.each([
    // 逆向き（今の書き方を旧かな・旧字へ戻す）は、置き換えではない
    ["ようやく", "やうやく"],
    ["機会", "機會"],
    // 置き換えに別の直しが混ざっている。**全部が置き換えのときだけ**落とす
    ["機會を得た", "機会を得て"],
    ["やうやく着いた", "ようやく付いた"],
    // 旧字でない字を別の字へ直す（本物の誤変換）
    ["機會", "機械"],
    ["經營", "経理"],
    // 助詞の「わ」を「は」へ直すのは本物の誤字（向きが逆）
    ["私わ", "私は"],
    // 語頭のハ行はそのまま（はな→わな は置き換えではない）
    ["はな", "わな"],
    ["へいき", "えいき"],
    // 既存の「通す」一覧（typoRealWorks.test.ts）
    ["ｈっきりと", "はっきりと"],
    ["ことはことは", "ことは"],
    ["溢れ出だした", "溢れ出した"],
    ["波うった", "波打った"],
    ["書き止め", "書き留め"],
    // 同じ語は「置き換え」ではない（no_change が別に落とす）
    ["機会", "機会"],
  ])("置き換えと見ない: 「%s」→「%s」", (target, suggestion) => {
    expect(onlyModernization(target, suggestion)).toBe(false);
  });

  test("文語体の作品でも、置き換えに別の直しが混ざった提案は通す", () => {
    const text = "好い機會を得た。";
    const result = judgeIn(true, text, "機會を得た", "機会を得て");
    expect(result.rejected.filter((entry) => entry.reason === "archaic_form")).toEqual([]);
  });
});

describe("旧字体の表の形", () => {
  test("鍵も値も1字で、鍵と値が同じ項目が無い", () => {
    const entries = Object.entries(KYUJITAI_TO_SHINJITAI);
    expect(entries.length).toBeGreaterThan(300);
    for (const [old, now] of entries) {
      expect([...old]).toHaveLength(1);
      expect([...now]).toHaveLength(1);
      expect(old).not.toBe(now);
    }
  });

  test("新字体の側に、旧字体の鍵が混ざっていない（新→旧の書き違いを見張る）", () => {
    const olds = new Set(Object.keys(KYUJITAI_TO_SHINJITAI));
    const wrong = Object.values(KYUJITAI_TO_SHINJITAI).filter((now) => olds.has(now));
    expect(wrong).toEqual([]);
  });
});

/**
 * 同音の漢字による書きかえ（附近→付近）と、漢字をひらく直し（儘→まま）も、
 * 文語体の作品では落とす（作者の裁定、2026-10-15 深夜の1）。
 * **送り仮名の違いと、別の語への言い換えは残す**（同じ裁定）。
 */
const MEASURED_KAKIKAE: Array<[string, string, string]> = [
  // 測定 2552 で実際に返ったもの
  ["附近の村に宿を取つた。", "附近", "付近"],
  ["町を廻つて歸つた。", "廻つて", "回って"],
  ["國の為に盡くした。", "為に", "ために"],
  ["何の為か分からぬ。", "為", "ため"],
  ["此処に居り、", "居り", "おり"],
  ["其の儘にした。", "儘", "まま"],
];

describe("同音の漢字の書きかえ・漢字をひらく直し（文語体の作品なら落とす）", () => {
  test.each(MEASURED_KAKIKAE)("落とす: %s の「%s」→「%s」", (text, target, suggestion) => {
    const result = judgeIn(true, text, target, suggestion);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("archaic_form");
  });

  test.each([
    // 同音の漢字による書きかえ
    ["附属", "付属"],
    ["見廻る", "見回る"],
    ["聯合", "連合"],
    ["編輯", "編集"],
    ["蒐集", "収集"],
    ["叮嚀に", "丁寧に"],
    ["臆測", "憶測"],
    ["醗酵", "発酵"],
    ["註釈", "注釈"],
    // 漢字をひらく
    ["此の", "この"],
    ["其の", "その"],
    ["此処", "ここ"],
    ["事", "こと"],
    ["様に", "ように"],
    ["為めに", "ために"],
    ["迄", "まで"],
    ["殆ど", "ほとんど"],
    // 旧字体のままひらく（爲→為→ため、樣→様→よう）
    ["爲に", "ために"],
    ["此の樣に", "このように"],
    // 旧かな・旧字と混ざっても、全部が置き換えなら落とす
    ["其の儘にして置かう", "そのままにして置こう"],
    ["附近を廻つた", "付近を回った"],
  ])("置き換えだけと見る: 「%s」→「%s」", (target, suggestion) => {
    expect(onlyModernization(target, suggestion)).toBe(true);
  });
});

describe("書きかえ・ひらく表で本物の誤字を巻き込まない（見逃しの見張り）", () => {
  test.each(MEASURED_KAKIKAE)(
    "現代文の作品では落とさない（R17 の門）: %s",
    (text, target, suggestion) => {
      const result = judgeIn(false, text, target, suggestion);
      expect(result.rejected.filter((entry) => entry.reason === "archaic_form")).toEqual([]);
    }
  );

  test.each([
    // 送り仮名の違いは残す（作者の裁定）
    ["然かも", "然も"],
    ["繰返へし", "繰返し"],
    ["判り易い", "分かりやすい"],
    // 別の語への言い換えは残す（作者の裁定）
    ["頒ける", "配る"],
    ["此の", "あの"],
    ["其の儘", "そのとおり"],
    // 逆向き（今の書き方を古い書き方へ戻す）
    ["付近", "附近"],
    ["回って", "廻って"],
    ["ために", "為に"],
    ["まま", "儘"],
    ["この", "此の"],
    // 書きかえ・ひらくに別の直しが混ざっている
    ["附近へ行つた", "付近に行った"],
    ["其の儘で", "そのままに"],
    // 書きかえの相手でない字への直し（本物の誤変換）
    ["附近", "不近"],
    ["廻って", "周って"],
    ["事", "琴"],
  ])("置き換えと見ない: 「%s」→「%s」", (target, suggestion) => {
    expect(onlyModernization(target, suggestion)).toBe(false);
  });

  test("文語体の作品でも、書きかえに別の直しが混ざった提案は通す", () => {
    const text = "附近へ行つた。";
    const result = judgeIn(true, text, "附近へ行つた", "付近に行った");
    expect(result.rejected.filter((entry) => entry.reason === "archaic_form")).toEqual([]);
  });
});
