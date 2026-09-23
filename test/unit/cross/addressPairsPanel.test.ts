import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildAddressListView,
  buildCharacterAddressView,
  type AddressLine,
  type AddressScope,
} from "../../../src/core/addressPairsView";
import { buildSettingsPanelHtml } from "../../../src/views/settingsPanelHtml";
import { emptyCharacter } from "../../../src/models/character";
import type { AddressForm, AddressTerm, Character } from "../../../src/models/character";

/**
 * 呼び合いを画面へ出す（設計書6.92）。
 *
 * 作者の依頼（2026-09-13）：「人物設定のパネルに、登場人物間の二人称を
 * 表示させることは可能でしょうか？　本編から開いている場合には、その話で
 * 登場している人物のみ表示するとか。」
 *
 * 組み立てそのもの（`addressPairs.ts`）は別の試験が見ている。ここで守るのは
 * **出し方**である——呼ぶ側と呼ばれる側が分かれること、1組も無いときに
 * 見出しだけを並べないこと、要確認を畳んでも件数と理由が読めること、
 * 話で絞ったらそう言うこと、そして絞りを外せること。
 */

function form(partial: Partial<AddressForm> & { term: string }): AddressForm {
  return {
    term: partial.term,
    category: partial.category ?? null,
    context: partial.context ?? null,
    firstChapter: partial.firstChapter ?? null,
    lastChapter: partial.lastChapter ?? null,
    status: partial.status ?? "current",
    evidence: null,
  };
}

function term(
  targetName: string,
  forms: Array<Partial<AddressForm> & { term: string }>
): AddressTerm {
  return {
    targetName,
    targetId: null,
    authorLocked: false,
    forms: forms.map(form),
  };
}

function person(
  id: string,
  name: string,
  options: { chapters?: number[]; terms?: AddressTerm[] } = {}
): Character {
  return {
    ...emptyCharacter(id, name),
    appearedChapters: options.chapters ?? [],
    addressTerms: options.terms ?? [],
  };
}

/** 呼ぶ側・呼ばれる側・壊れた組が混ざった、実データに近い並び */
const cast: Character[] = [
  person("char_1", "灰原直哉", {
    chapters: [1, 2, 3],
    terms: [term("香坂結", [{ term: "結", firstChapter: 1, lastChapter: 3 }])],
  }),
  person("char_2", "香坂結", {
    chapters: [1, 2, 3],
    terms: [term("灰原直哉", [{ term: "灰原くん", firstChapter: 1 }])],
  }),
  // 第9話にしか出ない。話で絞ったときに落ちる側
  person("char_3", "黒木先生", {
    chapters: [9],
    terms: [term("灰原直哉", [{ term: "灰原", firstChapter: 9 }])],
  }),
  // 抽出が呼ばれ方を本人のレコードへ入れたもの（実データで25件あった形）
  person("char_4", "宮下エルシー", {
    chapters: [1, 2],
    terms: [
      term("宮下エルシー", [
        { term: "エルシーさん", context: "灰原から呼ばれた際" },
      ]),
      term("名無しの旅人", [{ term: "あなた" }]),
    ],
  }),
];

const whole: AddressScope = { chapter: null, showAll: false };

/** その節・一覧が画面へ出す文字列を、まとめて取り出す */
function textsOf(lines: AddressLine[]): string[] {
  return lines.flatMap((line) => [line.text, line.issue ?? ""]);
}

describe("人物ごとの呼び合いの節", () => {
  test("呼ぶ側と呼ばれる側が分かれる", () => {
    const view = buildCharacterAddressView(cast, "char_1", whole);
    expect(view).toBeDefined();
    expect(view?.calls.map((line) => line.text)).toEqual([
      "灰原直哉 → 香坂結：結（第1〜3話）",
    ]);
    expect(view?.calledBy.map((line) => line.text)).toEqual([
      "香坂結 → 灰原直哉：灰原くん（第1話から）",
      "黒木先生 → 灰原直哉：灰原（第9話から）",
    ]);
  });

  test("1組も無ければ節ごと出さない", () => {
    const alone = [person("char_9", "通りすがり")];
    expect(buildCharacterAddressView(alone, "char_9", whole)).toBeUndefined();
  });

  test("使える組が無ければ、要確認だけでは節を出さない", () => {
    // 見出しと断り書きだけが並ぶと壊れて見える。
    // 要確認は「作品情報」の一覧で読む
    const view = buildCharacterAddressView(cast, "char_4", whole);
    expect(view).toBeUndefined();
  });

  test("要確認に回った件数は、使える組があるときに添える", () => {
    const mixed: Character[] = [
      ...cast,
      person("char_5", "三崎ハル", {
        chapters: [1],
        terms: [
          term("香坂結", [{ term: "ゆい" }]),
          // 資料に居ない相手。黙って消さず、件数として残す
          term("居ない人", [{ term: "きみ" }]),
        ],
      }),
    ];
    const view = buildCharacterAddressView(mixed, "char_5", whole);
    expect(view?.calls.map((line) => line.text)).toEqual([
      "三崎ハル → 香坂結：ゆい",
    ]);
    expect(view?.needsCheckNote).toContain("1件");
    expect(view?.needsCheckNote).toContain("呼び合い");
  });
});

describe("呼び合いの一覧", () => {
  test("使える組を並べ、要確認は畳んだ見出しに件数を出す", () => {
    const view = buildAddressListView(cast, whole);
    expect(view.summary).toBe("作品ぜんたい：3組");
    expect(view.usable.map((line) => line.text)).toEqual([
      "灰原直哉 → 香坂結：結（第1〜3話）",
      "香坂結 → 灰原直哉：灰原くん（第1話から）",
      "黒木先生 → 灰原直哉：灰原（第9話から）",
    ]);
    // 自分あて1組と、資料に無い相手1組
    expect(view.needsCheckLabel).toBe("要確認（2件）");
    expect(view.needsCheck).toHaveLength(2);
  });

  test("要確認には理由の札が付く", () => {
    const view = buildAddressListView(cast, whole);
    expect(view.needsCheck.map((line) => line.issue)).toEqual([
      "自分あて",
      "資料に無い相手",
    ]);
    // 「自分あて」を壊れているだけで済ませない。向きが逆なだけで読める
    expect(view.needsCheckHint).toContain("呼ばれ方");
  });

  test("使える組に、要確認が混ざらない", () => {
    const view = buildAddressListView(cast, whole);
    expect(view.usable.some((line) => line.issue)).toBe(false);
    expect(textsOf(view.usable).join("")).not.toContain("宮下エルシー");
  });

  test("1組も無ければ、どこで作れるかまで書く", () => {
    const view = buildAddressListView([person("char_9", "通りすがり")], whole);
    expect(view.emptyNote).toContain("設定資料を抽出");
    expect(view.needsCheckLabel).toBe("");
  });
});

describe("話で絞る", () => {
  const first: AddressScope = { chapter: 1, showAll: false };

  test("絞ったことを、件数と一緒に言う", () => {
    const view = buildAddressListView(cast, first);
    expect(view.summary).toBe("第1話に出る人どうし：2組");
    // 第9話にしか出ない人は落ちる
    expect(textsOf(view.usable).join("")).not.toContain("黒木先生");
  });

  test("人物ごとの節でも、絞ったとそう書く", () => {
    const view = buildCharacterAddressView(cast, "char_1", first);
    expect(view?.notice).toBe("第1話に出る人どうしだけを出しています。");
    expect(view?.calledBy.map((line) => line.text)).toEqual([
      "香坂結 → 灰原直哉：灰原くん（第1話から）",
    ]);
  });

  test("その話で使っていない呼び方は出さない", () => {
    const later: Character[] = [
      person("char_1", "灰原直哉", {
        chapters: [1, 5],
        terms: [
          term("香坂結", [
            { term: "香坂さん", firstChapter: 1, lastChapter: 2 },
            { term: "結", firstChapter: 5 },
          ]),
        ],
      }),
      person("char_2", "香坂結", { chapters: [1, 5] }),
    ];
    const view = buildAddressListView(later, { chapter: 1, showAll: false });
    expect(view.usable.map((line) => line.text)).toEqual([
      "灰原直哉 → 香坂結：香坂さん（第1〜2話）",
    ]);
  });

  test("絞って0組でも、全部なら見られることを書く", () => {
    const view = buildAddressListView(cast, { chapter: 7, showAll: false });
    expect(view.summary).toBe("第7話に出る人どうし：0組");
    expect(view.emptyNote).toContain("全部を見る");
  });

  test("絞りは外せる", () => {
    const filtered = buildAddressListView(cast, first);
    expect(filtered.toggle).toEqual({ label: "全部を見る", all: true });

    const all = buildAddressListView(cast, { chapter: 1, showAll: true });
    expect(all.summary).toBe("作品ぜんたい：3組");
    expect(all.toggle).toEqual({
      label: "第1話に出る人どうしだけ",
      all: false,
    });
  });

  test("絞って空になった人物でも、外す札は残す", () => {
    // 節ごと消すと、絞りを外す道が資料の画面から消える
    const view = buildCharacterAddressView(cast, "char_3", {
      chapter: 1,
      showAll: false,
    });
    expect(view).toBeDefined();
    expect(view?.calls).toEqual([]);
    expect(view?.calledBy).toEqual([]);
    expect(view?.notice).toContain("この話にはありません");
    expect(view?.toggle).toEqual({ label: "全部を見る", all: true });
  });

  test("人物ごとの節にも、同じ切り替えを添える", () => {
    const view = buildCharacterAddressView(cast, "char_1", first);
    expect(view?.toggle).toEqual({ label: "全部を見る", all: true });
  });

  test("本文から開いていなければ、切り替えは出さない", () => {
    expect(buildAddressListView(cast, whole).toggle.label).toBe("");
    expect(buildCharacterAddressView(cast, "char_1", whole)?.toggle.label).toBe(
      ""
    );
    expect(buildCharacterAddressView(cast, "char_1", whole)?.notice).toBe("");
  });
});

describe("画面に出す文字列", () => {
  /** 節と一覧が出す文言を、絞りの有無ごとに全部集める */
  function everyText(): string[] {
    const out: string[] = [];
    for (const scope of [
      whole,
      { chapter: 1, showAll: false },
      { chapter: 1, showAll: true },
      { chapter: 7, showAll: false },
    ]) {
      const list = buildAddressListView(cast, scope);
      out.push(
        list.summary,
        list.needsCheckLabel,
        list.needsCheckHint,
        list.emptyNote,
        list.toggle.label,
        ...textsOf(list.usable),
        ...textsOf(list.needsCheck)
      );
      for (const id of ["char_1", "char_2", "char_4"]) {
        const view = buildCharacterAddressView(cast, id, scope);
        if (!view) continue;
        out.push(
          view.notice,
          view.needsCheckNote,
          view.toggle.label,
          ...textsOf(view.calls),
          ...textsOf(view.calledBy)
        );
      }
    }
    return out;
  }

  test("Markdownの記号を混ぜない", () => {
    // WebViewはHTMLを自分で組み立てるのでMarkdownは解釈されない。
    // 「**」や「#」を書くと、記号がそのまま画面に出る
    for (const text of everyText()) {
      expect(text).not.toContain("**");
      expect(text.trimStart().startsWith("#")).toBe(false);
    }
  });

  test("人物名は、記号が入っていてもそのまま持つ", () => {
    // 名前は作者が自由に付けられる。ここで落としたり書き換えたりすると、
    // 画面に出る名前が資料の名前と違うものになる
    const tricky: Character[] = [
      person("char_1", "<b>灰原</b> & 直哉", {
        chapters: [1],
        terms: [term("香坂＜結＞", [{ term: '"ゆい"' }])],
      }),
      person("char_2", "香坂＜結＞", { chapters: [1] }),
    ];
    const view = buildAddressListView(tricky, whole);
    expect(view.usable[0].text).toBe(
      '<b>灰原</b> & 直哉 → 香坂＜結＞："ゆい"'
    );
  });

  test("呼び合いの行は innerHTML で入れない", () => {
    /*
      名前に「<」が入っていても画面が壊れないのは、行を textContent で
      入れているからである。**ここが抜け道にならないよう見張る。**
      innerHTML を使ってよいのは、整形済みのHTMLを受け取る
      メモと相談の本文だけ（どちらも markdownLite が記号を逃がしている）。
    */
    const source = readFileSync(
      "src/views/settingsPanelHtml.ts",
      "utf-8"
    );
    const uses = source
      .split("\n")
      .map((line) => line.trim())
      // 注釈で触れているだけの行は数えない（plainTextUi の走査と同じ扱い）
      .filter((line) => !line.startsWith("*") && !line.startsWith("//"))
      .filter((line) => line.includes("innerHTML"));
    expect(uses).toEqual([
      "body.innerHTML = note.html;",
      "body.innerHTML = turn.html;",
    ]);
  });

  test("画面のスクリプトが、JavaScriptとして読める", () => {
    /*
      **WebViewのスクリプトは型検査もビルドも通らない。**
      テンプレート文字列の中なので、書き損じても `npm run check` は
      通ってしまい、開いた瞬間に真っ白になるまで気づけない。
    */
    const html = buildSettingsPanelHtml("NONCE123", "vscode-resource:");
    const start = html.indexOf('<script nonce="NONCE123">');
    const script = html.slice(
      html.indexOf(">", start) + 1,
      html.indexOf("</script>", start)
    );
    expect(script).toContain("addressScope");
    expect(() => new Function(script)).not.toThrow();
  });

  test("パネルの画面に、呼び合いの入口と切り替えの口がある", () => {
    const html = buildSettingsPanelHtml("nonce", "vscode-resource:");
    // 作品情報タブの4つ目として出す（読むだけの区画）
    expect(html).toContain('{ id: "addresses", name: "呼び合い" }');
    // 絞りの切り替えは拡張機能側へ投げる（画面には判断させない）
    expect(html).toContain('post("addressScope"');
  });
});
