import { describe, expect, test } from "vitest";
import {
  measureParts,
  renderUsageRow,
  usageLogHeader,
  type UsageLogEntry,
} from "../../src/core/usageLog";

const AT = new Date(2026, 7, 27, 9, 5, 3);

function entry(overrides: Partial<UsageLogEntry> = {}): UsageLogEntry {
  return {
    feature: "typo_check",
    provider: "Ollama（ローカル）",
    model: "gemma4:e4b",
    paid: false,
    systemChars: 235,
    userChars: 8_765,
    ...overrides,
  };
}

describe("送信量の記録", () => {
  test("時刻と機能名を1行目に置く", () => {
    const row = renderUsageRow(entry(), AT);

    expect(row).toContain("| 2026-08-27 09:05:03 | typo_check |");
  });

  test("指示＋本文の合計を出す", () => {
    // systemPrompt と userPrompt を足したもの。これが実際に送る量
    const row = renderUsageRow(entry(), AT);

    expect(row).toContain("| 9,000 |");
  });

  test("有料のAIは印を付ける", () => {
    // あとから料金を追えるようにする。無料のときは何も足さない
    const paid = renderUsageRow(entry({ paid: true }), AT);
    const free = renderUsageRow(entry({ paid: false }), AT);

    expect(paid).toContain("gemma4:e4b・有料");
    expect(free).toContain("| gemma4:e4b |");
  });

  test("本文の割合を出す", () => {
    // 小さいほど見落としが増える。この数字を見るために作った
    const row = renderUsageRow(
      entry({
        systemChars: 800,
        userChars: 9_200,
        parts: { 本文: 2_000, 指示: 7_200 },
      }),
      AT
    );

    expect(row).toContain("| 20% |");
  });

  test("内訳を渡していないときは、本文の割合を空にする", () => {
    // 0%と書くと「本文を送っていない」ように読めるが、
    // 実際は「内訳を渡していない」だけである
    const row = renderUsageRow(entry(), AT);

    expect(row).not.toContain("0%");
  });

  test("内訳は多い順に並べる", () => {
    // 重いものから目に入るようにする
    const row = renderUsageRow(
      entry({ parts: { 本文: 8_000, 世界観: 12_400, あらすじ: 1_800 } }),
      AT
    );

    expect(row).toContain("世界観 12,400・本文 8,000・あらすじ 1,800");
  });

  test("スキーマは合計へ足さず、別の欄に出す", () => {
    // プロンプトとは別枠で送られる。入力トークンに乗るかは
    // プロバイダによって違うので、足すと分からなくなる
    const row = renderUsageRow(entry({ schemaChars: 4_200 }), AT);

    expect(row).toContain("| 9,000 | 4,200 |");
  });

  test("確保したコンテキスト長と入力トークンを並べる", () => {
    // 入力がこれに近いと、入力が黙って切り捨てられる
    const row = renderUsageRow(
      entry({
        numCtx: 60_452,
        usage: { inputTokens: 58_900, outputTokens: 1_024 },
      }),
      AT
    );

    expect(row).toContain("| 60,452 | 58,900 | 1,024 |");
  });

  test("切り詰めを備考に出す", () => {
    const row = renderUsageRow(entry({ truncated: true }), AT);

    expect(row).toContain("**切り詰め**");
  });

  test("失敗した回も残す", () => {
    // うまくいった回だけ残すと、答えが返らなかった理由を追えない
    const row = renderUsageRow(
      entry({ error: "timeout: 応答がありません" }),
      AT
    );

    expect(row).toContain("**失敗**: timeout: 応答がありません");
  });

  test("何も起きていない回の備考は空にする", () => {
    // 毎行に何か書くと、失敗の行が埋もれる
    const row = renderUsageRow(entry(), AT);

    expect(row.trimEnd().endsWith("|  |")).toBe(true);
  });

  test("縦棒が混ざっても表が壊れない", () => {
    // モデル名やエラー文に | が入ると、その行から先が読めなくなる
    const row = renderUsageRow(
      entry({ model: "gpt|4", error: "壊れた\n応答" }),
      AT
    );

    expect(row).not.toContain("gpt|4");
    expect(row).toContain("gpt／4");
    expect(row).toContain("壊れた 応答");
  });

  test("APIキーらしき文字列を伏せる", () => {
    // 作者がログを貼って助けを求めることを考えると、被害が大きい
    const row = renderUsageRow(
      entry({ error: "拒否されました: sk-abcdefgh12345678" }),
      AT
    );

    expect(row).not.toContain("sk-abcdefgh12345678");
    expect(row).toContain("sk-***");
  });

  test("本文そのものは記録しない", () => {
    // 記録するのは字数だけ。原稿がログへ漏れてはいけない
    const row = renderUsageRow(
      entry({ parts: { 本文: 8_000 } }),
      AT
    );

    expect(row).toContain("本文 8,000");
  });
});

describe("ファイルの先頭", () => {
  test("表の見出しを作る", () => {
    const header = usageLogHeader("C:/works/わたしの小説");

    expect(header).toContain("# わたしの小説 の送信量");
    expect(header).toContain("| 時刻 | 機能 | モデル |");
    expect(header).toContain("|---|---|---|");
  });

  test("切り方を説明する", () => {
    // 作者が数字の意味を読み取れるようにする
    const header = usageLogHeader("C:/works/わたしの小説");

    expect(header).toContain("本文そのものは記録しません");
    expect(header).toContain("novelai.usageLog.enabled");
  });
});

describe("内訳の組み立て", () => {
  test("指示は引き算で出す", () => {
    // 部品を1つずつ足す形にすると、プロンプトの組み立て方を変えたときに
    // 合計が合わなくなり、しかも合わないことに気づけない
    const parts = measureParts("a".repeat(10_000), { 本文: 8_000, 辞書: 500 });

    expect(parts).toEqual({ 本文: 8_000, 辞書: 500, 指示: 1_500 });
  });

  test("その回に無かった部品は落とす", () => {
    // 「作法 0字」と並べても読みにくいだけ
    const parts = measureParts("a".repeat(1_000), { 本文: 900, 作法: 0 });

    expect(parts).toEqual({ 本文: 900, 指示: 100 });
  });

  test("部品の合計が全体を超えても、負の数を出さない", () => {
    // 数え方を間違えたときに「-500字」と出ると、記録全体が信用できなくなる
    const parts = measureParts("a".repeat(100), { 本文: 900 });

    expect(parts.指示).toBe(0);
  });
});
