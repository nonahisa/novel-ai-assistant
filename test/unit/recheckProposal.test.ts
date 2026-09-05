import { describe, expect, test, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

import {
  excerptForRecheck,
  isQuoteStillPresent,
  parseRecheckAnswer,
  recheckProposal,
} from "../../src/features/recheckProposal";
import { AIError, type GenerateParams, type GenerateResult } from "../../src/ai/types";

/**
 * 指摘の再チェック（P-23）。
 *
 * 作者の依頼（2026-08-27）：「なおし方を作者が決める系のものは『再チェック』
 * ボタンを追加してください。なおして解消されたか確認したいです」
 * 「誤字脱字の提案パネルでも、違うそうじゃないという提案がきます。
 * 手書きで書き直して解消したか確認したいです」。
 *
 * ここで守りたいのは3つ。
 *
 * 1. **直し忘れは、AIを呼ばずに分かること。** 引用がそのまま残っていれば
 *    本文は変わっていない。ここで課金してはいけない
 * 2. **行番号を当てにしすぎないこと。** 本文が書き直された後なので、
 *    行は増減している。まず引用文で探す
 * 3. **読めなかったものを「解消した」に丸めないこと。** 通信の失敗や
 *    応答の崩れで、本物の指摘が黙って消える
 */

/** 直す前の本文。2行目に誤字がある */
const BEFORE = [
  "　夕暮れの校庭に、影が長く伸びていた。",
  "　彼は走つた。息が切れるまで走つた。",
  "　誰も追ってはこない。",
  "　それでも足は止まらなかった。",
].join("\n");

/** 作者が手で書き直したあと。**修正案（走った）とは違う直し方** */
const AFTER = [
  "　夕暮れの校庭に、影が長く伸びていた。",
  "　彼は駆けた。息が切れるまで駆けた。",
  "　誰も追ってはこない。",
  "　それでも足は止まらなかった。",
].join("\n");

const ITEM = {
  line: 2,
  original: "　彼は走つた。息が切れるまで走つた。",
  target: "走つた",
  suggestion: "走った",
  reason: "促音の誤り",
};

describe("引用がまだ在るか（無料の照合）", () => {
  test("そのまま残っていれば、在ると答える", () => {
    expect(isQuoteStillPresent(BEFORE, ITEM.original)).toBe(true);
  });

  test("書き直されていれば、無いと答える", () => {
    expect(isQuoteStillPresent(AFTER, ITEM.original)).toBe(false);
  });

  test("前後の空白だけの違いは、在るものとして扱う", () => {
    // 照合の幅は `core/textLocate.ts` に合わせる（あちらも前後の空白は落とす）
    expect(isQuoteStillPresent(BEFORE, `  ${ITEM.original}  `)).toBe(true);
  });

  /**
   * **空の引用は「変わっていない」の証拠にならない。**
   * 何とも照合できていないだけなので、在るとは言わない
   */
  test("引用が空なら、在るとは言わない", () => {
    expect(isQuoteStillPresent(BEFORE, "")).toBe(false);
    expect(isQuoteStillPresent(BEFORE, "   ")).toBe(false);
  });

  test("改行コードが違っても照合できる", () => {
    expect(isQuoteStillPresent(BEFORE.replace(/\n/g, "\r\n"), ITEM.original)).toBe(
      true
    );
  });
});

describe("該当箇所の切り出し", () => {
  test("引用で見つけたら、その前後を行番号付きで返す", () => {
    const excerpt = excerptForRecheck(BEFORE, {
      quote: ITEM.original,
      line: ITEM.line,
    });

    expect(excerpt.foundByQuote).toBe(true);
    expect(excerpt.line).toBe(2);
    // 行番号は1始まり。提案パネルの `line` とそのまま噛み合う
    expect(excerpt.text.split("\n")[0]).toBe(
      "1: 　夕暮れの校庭に、影が長く伸びていた。"
    );
    expect(excerpt.text).toContain("2: 　彼は走つた。");
  });

  /**
   * **行番号を当てにしすぎない。** 本文が書き直された後なので、
   * 行が増えていれば元の番号は別の場所を指す。
   */
  test("行がずれていても、引用のあるところを中心にする", () => {
    const inserted = ["　（前の日の話）", ...BEFORE.split("\n")].join("\n");
    const excerpt = excerptForRecheck(inserted, {
      quote: ITEM.original,
      line: ITEM.line,
    });

    expect(excerpt.foundByQuote).toBe(true);
    // 元は2行目。1行増えたので3行目にある
    expect(excerpt.line).toBe(3);
  });

  test("引用が見つからなければ、記録されていた行の周りを返す", () => {
    const excerpt = excerptForRecheck(AFTER, {
      quote: ITEM.original,
      line: ITEM.line,
    });

    expect(excerpt.foundByQuote).toBe(false);
    expect(excerpt.line).toBe(2);
    // 書き直された後の文が入っていないと、AIは判断できない
    expect(excerpt.text).toContain("　彼は駆けた。");
  });

  test("行番号が本文の外を指していても落ちない", () => {
    const excerpt = excerptForRecheck(AFTER, { quote: "存在しない引用", line: 999 });
    expect(excerpt.line).toBe(4);
    expect(excerpt.foundByQuote).toBe(false);
  });

  /** **中心の行だけは、長くても必ず入れる。** 落とすと何も判断できない */
  test("中心の行が字数の上限を超えていても、その行は入る", () => {
    const long = "あ".repeat(500);
    const excerpt = excerptForRecheck(["前", long, "後"].join("\n"), {
      quote: long,
      line: 2,
      maxChars: 10,
    });

    expect(excerpt.text).toContain(long);
  });

  /** **チャンク全体は送らない。** 前後が分かれば足りる */
  test("字数の上限を超えるぶんの前後は足さない", () => {
    const lines = ["あ".repeat(100), "い".repeat(100), "中心", "う".repeat(100)];
    const excerpt = excerptForRecheck(lines.join("\n"), {
      quote: "中心",
      line: 3,
      maxChars: 120,
    });

    // 100字が1行だけ入り、2行目は入らない
    expect(excerpt.text).toContain("中心");
    expect(excerpt.text.length).toBeLessThan(260);
  });

  test("行数の上限を超えて広げない", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `${index}行目の本文`);
    const excerpt = excerptForRecheck(lines.join("\n"), {
      quote: "20行目の本文",
      line: 21,
      around: 2,
    });

    // 中心の1行と、前後2行ずつ
    expect(excerpt.text.split("\n")).toHaveLength(5);
  });

  test("改行コードが違っても行番号がずれない", () => {
    const excerpt = excerptForRecheck(BEFORE.replace(/\n/g, "\r\n"), {
      quote: ITEM.original,
      line: ITEM.line,
    });
    expect(excerpt.line).toBe(2);
    expect(excerpt.text).toContain("2: 　彼は走つた。");
  });
});

describe("AIの答えを読む", () => {
  test("素直なJSONを読む", () => {
    expect(parseRecheckAnswer('{"resolved": true, "reason": "誤字が直っています"}'))
      .toEqual({ resolved: true, reason: "誤字が直っています" });
  });

  test("前後に文が付いていても読む", () => {
    const answer = parseRecheckAnswer(
      '判定します。\n```json\n{"resolved": false, "reason": "まだ促音が抜けています"}\n```'
    );
    expect(answer?.resolved).toBe(false);
  });

  /**
   * スキーマで boolean を指定しても、**守らないモデルがある。**
   * 文字列で返ってきたぶんは拾う
   */
  test("真偽値が文字列で返っても読む", () => {
    expect(parseRecheckAnswer('{"resolved": "true", "reason": ""}')?.resolved).toBe(
      true
    );
    expect(parseRecheckAnswer('{"resolved": "false", "reason": ""}')?.resolved).toBe(
      false
    );
  });

  /** **指示の言葉がそのまま返ってくる**のは、この作品で繰り返し起きている */
  test("「解消」「未解消」で返ってきても読む", () => {
    expect(parseRecheckAnswer('{"resolved": "解消", "reason": ""}')?.resolved).toBe(
      true
    );
    expect(
      parseRecheckAnswer('{"resolved": "未解消", "reason": ""}')?.resolved
    ).toBe(false);
  });

  test("中身の無い理由は、理由として扱わない", () => {
    expect(parseRecheckAnswer('{"resolved": true, "reason": "特になし"}')?.reason)
      .toBe("");
  });

  /**
   * **読めなかったものを「解消した」に丸めない。**
   * 呼び出し側は指摘をそのまま残す
   */
  test("読めなければ undefined を返す", () => {
    expect(parseRecheckAnswer("解消しました")).toBeUndefined();
    expect(parseRecheckAnswer('{"reason": "理由だけ"}')).toBeUndefined();
    expect(parseRecheckAnswer('{"resolved": "たぶん", "reason": ""}')).toBeUndefined();
    expect(parseRecheckAnswer("")).toBeUndefined();
  });
});

describe("1件を確かめる", () => {
  const calls: GenerateParams[] = [];

  beforeEach(() => {
    calls.length = 0;
  });

  function replying(text: string, extra: Partial<GenerateResult> = {}) {
    return {
      generate: async (params: GenerateParams): Promise<GenerateResult> => {
        calls.push(params);
        return { text, truncated: false, elapsedMs: 1, ...extra };
      },
    };
  }

  function throwing(error: unknown) {
    return {
      generate: async (params: GenerateParams): Promise<GenerateResult> => {
        calls.push(params);
        throw error;
      },
    };
  }

  function request(content: string, provider: { generate: typeof replying }) {
    return {
      // `id` は出力上限の台帳を引くのに要る（`ai/outputLimit.ts`）。
      // 偽物なので、台帳に無い名前でよい——設定値がそのまま使われる
      provider: {
        ...(provider as unknown as {
          generate: (p: GenerateParams) => Promise<GenerateResult>;
        }),
        id: "ollama",
      },
      model: "gemma4:e4b",
      workFolder: "C:/小説/いじめられっ子",
      category: "誤字脱字",
      fileName: "001.txt",
      content,
      item: ITEM,
    };
  }

  /** **直し忘れは、その場で分かるのがいちばん役に立つ。** 課金しない */
  test("本文が変わっていなければ、AIを呼ばない", async () => {
    const provider = replying('{"resolved": true, "reason": ""}');
    const outcome = await recheckProposal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      request(BEFORE, provider as any)
    );

    expect(outcome.kind).toBe("unchanged");
    expect(calls).toHaveLength(0);
  });

  test("書き直されていれば、AIに1回だけ聞く", async () => {
    const provider = replying('{"resolved": true, "reason": "駆けたに直っています"}');
    const outcome = await recheckProposal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      request(AFTER, provider as any)
    );

    expect(calls).toHaveLength(1);
    expect(outcome).toEqual({
      kind: "resolved",
      reason: "駆けたに直っています",
    });
  });

  test("まだ当てはまるなら、理由を添えて残す", async () => {
    const provider = replying('{"resolved": false, "reason": "促音がまだ抜けています"}');
    const outcome = await recheckProposal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      request(AFTER, provider as any)
    );

    expect(outcome).toEqual({
      kind: "unresolved",
      reason: "促音がまだ抜けています",
    });
  });

  /**
   * **通信の失敗で、本物の指摘を消さない。**
   * 矛盾の検証（P-12b）と同じ考え方である
   */
  test("AIが落ちたら失敗として返す（解消にしない）", async () => {
    const provider = throwing(new AIError("接続できません", "not_running"));
    const outcome = await recheckProposal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      request(AFTER, provider as any)
    );

    expect(outcome.kind).toBe("failed");
  });

  test("取りやめたことは、失敗と分けて伝える", async () => {
    const provider = throwing(new AIError("中止", "aborted"));
    const outcome = await recheckProposal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      request(AFTER, provider as any)
    );

    expect(outcome).toMatchObject({ kind: "failed" });
    expect(outcome.kind === "failed" && outcome.reason).toContain("取りやめ");
  });

  test("答えが読めなければ失敗として返す", async () => {
    const provider = replying("たぶん直っていると思います");
    const outcome = await recheckProposal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      request(AFTER, provider as any)
    );

    expect(outcome.kind).toBe("failed");
    // **エラーの本文を捨てない**（CLAUDE.md）。原因にたどり着けなくなる
    expect(outcome.kind === "failed" && outcome.detail).toContain("たぶん");
  });

  test("答えが途中で切れていたら失敗として返す", async () => {
    const provider = replying('{"resolved": tr', { truncated: true });
    const outcome = await recheckProposal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      request(AFTER, provider as any)
    );

    expect(outcome.kind).toBe("failed");
  });

  test("送信量の記録は、再チェックとして数える", async () => {
    const provider = replying('{"resolved": true, "reason": ""}');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recheckProposal(request(AFTER, provider as any));

    expect(calls[0].meta).toEqual({
      feature: "recheck",
      workFolder: "C:/小説/いじめられっ子",
    });
  });

  /**
   * **`numCtx` は渡さない**（0.22.14）。実物から見積もる受け皿に任せる。
   * ここで決め打ちすると、モデルを変えたときに黙って切り詰められる
   */
  test("コンテキスト長を決め打ちしない", async () => {
    const provider = replying('{"resolved": true, "reason": ""}');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recheckProposal(request(AFTER, provider as any));

    expect(calls[0].numCtx).toBeUndefined();
    // 判断であって創作ではないので、揺らさない
    expect(calls[0].temperature).toBe(0);
  });

  /**
   * **修正案の無い指摘（推敲の「長すぎる文」など）こそ、この機能の出発点。**
   * 直し方は作者が決めるので、直ったかどうかは確かめるしかない
   */
  test("修正案が無い指摘でも確かめられる", async () => {
    const provider = replying('{"resolved": true, "reason": "二文に分かれています"}');
    const outcome = await recheckProposal({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(request(AFTER, provider as any) as any),
      category: "推敲",
      item: { ...ITEM, suggestion: "" },
    });

    expect(outcome.kind).toBe("resolved");
    // 「（なし）」のような言葉を送らない。それ自体が判断材料に読まれる
    expect(calls[0].userPrompt).not.toContain("そのときの修正案");
  });

  test("修正案があれば、参考として添える", async () => {
    const provider = replying('{"resolved": true, "reason": ""}');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recheckProposal(request(AFTER, provider as any));

    expect(calls[0].userPrompt).toContain("そのときの修正案");
    expect(calls[0].userPrompt).toContain("走った");
    // 書き直されたあとの本文が入っていないと、判断できない
    expect(calls[0].userPrompt).toContain("　彼は駆けた。");
  });
});

/**
 * 画面側の口（WebViewを要するので、その道が残っているかを見る）。
 */
describe("再チェックの口", () => {
  const html = () => readFileSync("src/views/proposalPanelHtml.ts", "utf-8");

  test("押すと、再チェックを送る道がある", () => {
    // 正規表現もエスケープも使わない。潰れても「見つからない」としか出ない
    expect(html()).toContain('data-action="recheck"');
  });

  test("解消が確かめられたものは、一覧から外す", () => {
    expect(html()).toContain(".issue.resolved { display: none; }");
  });

  /** AIの答えは数十秒かかる。押した手応えが無いと、壊れたようにしか見えない */
  test("再チェック中は、その行の操作を止める", () => {
    expect(html()).toContain("再チェック中…");
    expect(html()).toContain("item.busy ? ' disabled' : ''");
  });
});
