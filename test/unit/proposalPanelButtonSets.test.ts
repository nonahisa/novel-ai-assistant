import { describe, expect, test } from "vitest";
import { buildProposalPanelHtml } from "../../src/views/proposalPanelHtml";

/**
 * 分類ごとに、出るボタンの組（実機確認リスト A-1・A-16・F-49 の代わり）。
 *
 * **「プロット逸脱には『伏線として登録』が出ない」「矛盾には出る」**の
 * ような約束は、これまで画面を撮って目で数えていた（作者の指示、
 * 2026-09-08「機械にできるものを統合テストへ」）。
 *
 * 描画は WebView の中で動くので、組み上がったHTMLから関数を取り出して
 * **実際に走らせて**確かめる（`proposalDiffMarking.test.ts` と同じ手口）。
 * 文字列を探すだけの検査では、出す条件を間違えても通ってしまう。
 *
 * ボタンの見た目（大きさ・間隔・枠に収まるか）は
 * `proposalPanelButtons.test.ts` が見ており、収まり具合だけは実機で見る。
 */

const html = buildProposalPanelHtml("test-nonce", "vscode-webview:");

/** WebView のスクリプトから、中括弧の対応を数えて1つ切り出す */
function extractFunction(source: string, name: string): string {
  const head = source.indexOf("function " + name + "(");
  expect(head, name + " が見つからない").toBeGreaterThanOrEqual(0);
  let depth = 0;
  let started = false;
  for (let i = head; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
      started = true;
    } else if (source[i] === "}") {
      depth--;
      if (started && depth === 0) return source.slice(head, i + 1);
    }
  }
  throw new Error(name + " の終わりが見つからない");
}

/** ラベルの表（const 宣言）をそのまま切り出す */
function extractConst(source: string, name: string): string {
  const head = source.indexOf("const " + name + " =");
  expect(head, name + " が見つからない").toBeGreaterThanOrEqual(0);
  const end = source.indexOf("};", head);
  const semicolon = source.indexOf(";", head);
  // 1行の表（`{ a: 1 }`）と複数行の表の両方に対応する
  return source.slice(head, (end >= 0 && end < semicolon ? end + 1 : semicolon) + 1);
}

type Render = (item: unknown) => string;

const { renderItem } = ((): { renderItem: Render } => {
  const body = [
    extractConst(html, "CONFIDENCE_LABEL"),
    extractConst(html, "STATUS_LABEL"),
    extractFunction(html, "escapeHtml"),
    extractFunction(html, "diffSide"),
    extractFunction(html, "renderDiff"),
    // 更新案の葉を1つずつ落とす仕掛け（0.50.0）。`renderRecordUpdate` が
    // 「反映する」を押せるかの判定に使うので、一緒に取り出す
    extractConst(html, "droppedEntries"),
    extractFunction(html, "dropSetOf"),
    extractFunction(html, "renderEntries"),
    extractFunction(html, "canApplyRecordUpdate"),
    extractFunction(html, "renderRecordChanges"),
    extractFunction(html, "doneLabel"),
    extractFunction(html, "renderRecordUpdate"),
    extractFunction(html, "renderContradiction"),
    extractFunction(html, "canKeep"),
    extractFunction(html, "renderItem"),
    "return { renderItem: renderItem };",
  ].join("\n");
  return new Function(body)() as { renderItem: Render };
})();

/** 描いたHTMLから、押せるボタンの名前を出てくる順に拾う */
function buttonsOf(item: unknown): string[] {
  const rendered = renderItem(item);
  return [...rendered.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(
    (found) => found[1]
  );
}

/** 誤字脱字・推敲の指摘（1件） */
function typoIssue(extra: Record<string, unknown> = {}) {
  return {
    id: "1",
    fileName: "01.md",
    line: 3,
    confidence: "high",
    status: "pending",
    target: "返されるかもしれあい",
    suggestion: "返されるかもしれない",
    original: "そう返されるかもしれあい。",
    reason: "誤字",
    ...extra,
  };
}

/** 矛盾・プロット逸脱の指摘（`excerpt` があるとこの形で描かれる） */
function contradictionIssue(extra: Record<string, unknown> = {}) {
  return {
    id: "2",
    fileName: "05.md",
    line: 12,
    confidence: "medium",
    status: "pending",
    category: "人物",
    excerpt: "彼は左手で剣を抜いた。",
    settingSays: "右利き",
    textSays: "左手で抜いている",
    ...extra,
  };
}

/** 設定資料の更新（`changes` があるとこの形で描かれる） */
function recordUpdate(extra: Record<string, unknown> = {}) {
  return {
    id: "3",
    name: "薬師寺",
    status: "pending",
    changes: ["紹介: （未設定） → 剣の使い手"],
    ...extra,
  };
}

describe("誤字脱字・推敲に出るボタン", () => {
  test("修正案があるときは、適用／無視／今後直さない／再チェック", () => {
    expect(buttonsOf(typoIssue({ canRecheck: true }))).toEqual([
      "適用",
      "無視",
      "今後直さない",
      "再チェック",
    ]);
  });

  test("修正案が無ければ「適用」を出さず、「本文を見る」にする", () => {
    // 推敲は「どう直すか」を書かせないことがある。押しても何も起きない
    // ボタンを出さない
    const buttons = buttonsOf(
      typoIssue({ suggestion: "", canRecheck: true, target: "長い一文" })
    );

    expect(buttons).toContain("本文を見る");
    expect(buttons).not.toContain("適用");
  });

  test("語として登録できない長さなら、「今後直さない」を出さない", () => {
    // 推敲は一文まるごとを指すので、語としては登録できない
    const long = "あ".repeat(30);

    expect(buttonsOf(typoIssue({ target: long }))).not.toContain("今後直さない");
  });

  test("表記ゆれの指摘にだけ「AIに訊く」が出る", () => {
    const withNotation = buttonsOf(
      typoIssue({ notation: { label: "良い／よい", forms: [] } })
    );

    expect(withNotation).toContain("AIに訊く");
    expect(buttonsOf(typoIssue())).not.toContain("AIに訊く");
  });

  test("適用したあとは「戻す」だけになる", () => {
    expect(buttonsOf(typoIssue({ status: "applied" }))).toEqual(["戻す"]);
  });

  test("無視したあとは、押せるボタンが無い", () => {
    expect(buttonsOf(typoIssue({ status: "dismissed" }))).toEqual([]);
  });
});

describe("矛盾に出るボタン", () => {
  test("本文を見る／設定資料を見る／無視／伏線として登録／再チェック", () => {
    expect(
      buttonsOf(
        contradictionIssue({ canRegisterForeshadow: true, canRecheck: true })
      )
    ).toEqual([
      "本文を見る",
      "設定資料を見る",
      "無視",
      "伏線として登録",
      "再チェック",
    ]);
  });

  test("プロット逸脱には「伏線として登録」が出ない", () => {
    // 逸脱は「意図して置いた伏線だった」という道を持たない（設計書6.35.4）
    const buttons = buttonsOf(
      contradictionIssue({
        canRegisterForeshadow: false,
        canRecheck: true,
        openTarget: "plot",
      })
    );

    expect(buttons).not.toContain("伏線として登録");
    // 飛び先はプロット。「設定資料を見る」とは言わない
    expect(buttons).toContain("プロットを見る");
  });

  test("照らす相手が無ければ、そのボタンごと出さない", () => {
    // 単話プロットの検査（P-27）は本文を見ていない
    const buttons = buttonsOf(
      contradictionIssue({
        openTarget: "none",
        jumpLabel: "単話プロットを見る",
      })
    );

    expect(buttons).toEqual(["単話プロットを見る", "無視"]);
  });

  test("再チェック中は、この行の操作を全部止める", () => {
    const rendered = renderItem(
      contradictionIssue({ canRecheck: true, busy: true })
    );

    expect(rendered).toContain("再チェック中…");
    // ボタンの数だけ disabled が付く
    const buttons = rendered.match(/<button/g) ?? [];
    const disabled = rendered.match(/ disabled>/g) ?? [];
    expect(disabled.length).toBe(buttons.length);
  });
});

describe("設定資料の更新に出るボタン", () => {
  test("反映する／見送る", () => {
    expect(buttonsOf(recordUpdate())).toEqual(["反映する", "見送る"]);
  });

  test("押した結果に合わせて、呼び名を変えられる", () => {
    // 伏線の候補は「登録」、回収の候補は「回収済みにする」（設計書6.35.2）
    expect(buttonsOf(recordUpdate({ applyLabel: "登録" }))).toEqual([
      "登録",
      "見送る",
    ]);
  });

  test("反映したあとは、押せるボタンが無い", () => {
    expect(buttonsOf(recordUpdate({ status: "applied" }))).toEqual([]);
  });
});
