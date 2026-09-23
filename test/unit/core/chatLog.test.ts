import { describe, expect, test } from "vitest";
import {
  renderChatLogEntry,
  summarizeMaterials,
  type ChatLogEntry,
} from "../../src/core/chatLog";

const AT = new Date(2026, 7, 15, 21, 34, 56);

function entry(overrides: Partial<ChatLogEntry> = {}): ChatLogEntry {
  return {
    panel: "相談パネル",
    provider: "Ollama（ローカル）",
    model: "gemma4:e4b",
    paid: false,
    question: "この場面をもっと短くできますか？",
    reply: "冒頭の説明を削ると引き締まります。",
    ...overrides,
  };
}

describe("相談ログの組み立て", () => {
  test("日時と画面を見出しにする", () => {
    // 時系列で追えて、目的の回を探せるようにする
    const text = renderChatLogEntry(entry(), AT);

    expect(text).toContain("## 2026-08-15 21:34:56　相談パネル");
  });

  test("質問と返事を残す", () => {
    const text = renderChatLogEntry(entry(), AT);

    expect(text).toContain("この場面をもっと短くできますか？");
    expect(text).toContain("冒頭の説明を削ると引き締まります。");
  });

  test("質問と返事は引用にする", () => {
    // 見出し記号が混ざっても、文書の構造を壊さない
    const text = renderChatLogEntry(
      entry({ reply: "# 見出しに見える返事" }),
      AT
    );

    expect(text).toContain("> # 見出しに見える返事");
  });

  test("複数行の返事も全行を引用にする", () => {
    const text = renderChatLogEntry(entry({ reply: "一行目\n二行目" }), AT);

    expect(text).toContain("> 一行目\n> 二行目");
  });

  test("有料かどうかを残す", () => {
    // あとで料金を追えるようにする
    const paid = renderChatLogEntry(
      entry({ provider: "Claude", model: "claude-opus-5", paid: true }),
      AT
    );

    expect(paid).toContain("Claude（claude-opus-5）・有料");
    expect(renderChatLogEntry(entry(), AT)).toContain("・無料");
  });

  test("検索の結果と検索語を残す", () => {
    // 検索を入れてからは「なぜその場面が選ばれたか」が要る
    const text = renderChatLogEntry(
      entry({
        retrieval: "本文18件・設定資料3件を参照",
        searchTerms: ["嫉妬", "羨む"],
      }),
      AT
    );

    expect(text).toContain("検索: 本文18件・設定資料3件を参照");
    expect(text).toContain("検索語: 嫉妬、羨む");
  });

  test("渡した場面は折りたたむ", () => {
    // 毎回30件並ぶと、質問と返事が読めなくなる
    const text = renderChatLogEntry(
      entry({
        materials: [{ label: "本文・第105話", head: "滑車って、井戸に…" }],
      }),
      AT
    );

    expect(text).toContain("<details><summary>渡した場面（1件）</summary>");
    expect(text).toContain("**本文・第105話**");
  });

  test("選択肢と提案を残す", () => {
    const text = renderChatLogEntry(
      entry({
        options: ["もっと短く", "別の切り口で"],
        proposals: ["書き込み: プロットのテーマ"],
      }),
      AT
    );

    expect(text).toContain("1. もっと短く");
    expect(text).toContain("- 書き込み: プロットのテーマ");
  });

  test("提案は押されるまで実行しないと明記する", () => {
    const text = renderChatLogEntry(entry({ proposals: ["機能の起動: 誤字脱字"] }), AT);

    expect(text).toContain("押されるまで実行しません");
  });

  test("失敗も残す", () => {
    // うまくいった回だけ残すと、答えが返らなかった理由を追えない
    const text = renderChatLogEntry(
      entry({ reply: "", error: "接続できませんでした" }),
      AT
    );

    expect(text).toContain("### 失敗");
    expect(text).toContain("接続できませんでした");
    expect(text).not.toContain("### 返事");
  });

  test("APIキーらしき文字列は伏せる", () => {
    // 作者がログを貼って助けを求めることを考えると、万一の被害が大きい
    const text = renderChatLogEntry(
      entry({ reply: "鍵は sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 です" }),
      AT
    );

    expect(text).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345");
  });

  test("空の返事でも壊れない", () => {
    expect(renderChatLogEntry(entry({ reply: "" }), AT)).toContain("（空）");
  });

  test("所要時間とトークンを残す", () => {
    const text = renderChatLogEntry(
      entry({
        elapsedMs: 4200,
        usage: { inputTokens: 3120, outputTokens: 210 },
      }),
      AT
    );

    expect(text).toContain("所要: 4.2秒");
    expect(text).toContain("入力 3,120");
  });
});

describe("渡した場面の要約", () => {
  test("冒頭だけを残す", () => {
    // 全文を載せると質問と返事が読めなくなる
    const [material] = summarizeMaterials([
      { label: "本文・第1話", text: "あ".repeat(300) },
    ]);

    expect(material.label).toBe("本文・第1話");
    expect(material.head.length).toBeLessThanOrEqual(60);
  });

  test("改行を潰して1行にする", () => {
    const [material] = summarizeMaterials([
      { label: "本文", text: "一行目\n\n二行目" },
    ]);

    expect(material.head).toBe("一行目 二行目");
  });
});
