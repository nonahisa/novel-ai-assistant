import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  EXPERTS_BADGE,
  expertsCellText,
  expertsPickText,
  readExpertCounts,
} from "../../../src/core/modelExperts";
import {
  buildTuningStatsMarkdown,
  modelPickDetail,
  tuningStatsEntries,
} from "../../../src/core/tuningStats";
import { OllamaProvider } from "../../../src/ai/ollamaProvider";
import { workspace } from "../support/vscodeStub";

/**
 * 「大きいけれど速い型」を見せる（作者の指示、2026-09-19「見せてください」）。
 *
 * 作者の機械（VRAM 8GB）で同じ測定台を3回ずつ測ったところ、**VRAMに入らない
 * 17.3GBのモデル（`gemma4:26b`）が、入る7.0GBのモデル（`gemma4:12b`）の
 * 2倍速かった**。理由は `/api/show` に出ていて、26b だけが部品を128個持ち、
 * そのうち8個しか使わない。
 *
 * ここで確かめるのは4通り。
 *
 * 1. **部品の数がある**……`gemma4:26b` の実測値（128と8）をそのまま使う
 * 2. **無い**……`gemma4:12b`・`qwen3:8b` には項目そのものが無い
 * 3. **アーキテクチャ名が違う**……前置きは `gemma4.` とは限らない。
 *    名前を固定していないか（CLAUDE.md 規則6）
 * 4. **取れない**……`/api/show` が失敗した・項目ごと返らない
 *
 * そして、**2と4のどちらでも「部品を分けていません」とは言わない。**
 * 分からないのと、分かっていて分けていないのは違う。
 */

/** `gemma4:26b` の実測（2026-09-19、作者の機械のOllama）。要る項目だけ */
const GEMMA4_26B = {
  "general.architecture": "gemma4",
  "gemma4.context_length": 262144,
  "gemma4.expert_count": 128,
  "gemma4.expert_feed_forward_length": 704,
  "gemma4.expert_used_count": 8,
};

/** `gemma4:12b` の実測。**expert の項目が無い** */
const GEMMA4_12B = {
  "general.architecture": "gemma4",
  "gemma4.context_length": 262144,
};

/** `qwen3:8b` の実測。こちらも expert の項目が無く、前置きも違う */
const QWEN3_8B = {
  "general.architecture": "qwen3",
  "qwen3.context_length": 40960,
};

describe("部品の数を読む", () => {
  test("部品の数があれば、そのまま読む（gemma4:26b の実測）", () => {
    expect(readExpertCounts(GEMMA4_26B)).toEqual({ total: 128, used: 8 });
  });

  test("項目が無いモデルは、分からないままにする（gemma4:12b・qwen3:8b の実測）", () => {
    // **「部品を分けていない」とは返さない。** 返せるのは「分からない」だけ
    expect(readExpertCounts(GEMMA4_12B)).toBeUndefined();
    expect(readExpertCounts(QWEN3_8B)).toBeUndefined();
  });

  test("アーキテクチャ名が違っても読める（前置きを固定しない）", () => {
    // 名乗った名前で引く。`gemma4.` を決め打ちしていたら、ここで落ちる
    expect(
      readExpertCounts({
        "general.architecture": "qwen3next",
        "qwen3next.context_length": 262144,
        "qwen3next.expert_count": 512,
        "qwen3next.expert_used_count": 10,
      })
    ).toEqual({ total: 512, used: 10 });
  });

  test("名乗りが無くても、末尾一致で拾う", () => {
    expect(
      readExpertCounts({
        "mystery.expert_count": 64,
        "mystery.expert_used_count": 4,
      })
    ).toEqual({ total: 64, used: 4 });
  });

  test("取れないときは、何も返さない", () => {
    // `/api/show` が失敗した・model_info ごと返らなかった
    expect(readExpertCounts(undefined)).toBeUndefined();
    expect(readExpertCounts({})).toBeUndefined();
  });

  test("片方しか無い・数が揃わないものは読まない", () => {
    // 持っている数だけでは「一部だけ使う」と言えない
    expect(
      readExpertCounts({
        "general.architecture": "gemma4",
        "gemma4.expert_count": 128,
      })
    ).toBeUndefined();
    // 全部使うなら、大きいぶんだけ遅い。札を出す理由が無い
    expect(
      readExpertCounts({
        "general.architecture": "x",
        "x.expert_count": 8,
        "x.expert_used_count": 8,
      })
    ).toBeUndefined();
    // 0 や文字列は読まずに捨てる
    expect(
      readExpertCounts({
        "general.architecture": "x",
        "x.expert_count": 0,
        "x.expert_used_count": 0,
      })
    ).toBeUndefined();
    expect(
      readExpertCounts({
        "general.architecture": "x",
        "x.expert_count": "128",
        "x.expert_used_count": "8",
      })
    ).toBeUndefined();
  });
});

describe("画面に出す文面", () => {
  test("仕組みの名前を出さず、何が嬉しいかを書く", () => {
    const text = expertsPickText({ total: 128, used: 8 });
    expect(text).toBe(
      "大きいけれど速い型（部品128個のうち、一度に使うのは8個だけ。" +
        "メモリに全部載らなくても遅くなりにくい）"
    );
    // 専門用語をそのまま画面へ出さない（作者はプログラマではない）
    expect(text).not.toMatch(/MoE|expert|エキスパート|専門家/i);
    expect(EXPERTS_BADGE).toBe("大きいけれど速い型");
  });

  test("表の欄は、1つで読み切れる短さにする", () => {
    expect(expertsCellText({ total: 128, used: 8 })).toBe(
      "大きいけれど速い型（128個中8個ずつ）"
    );
  });
});

describe("モデルを選ぶ画面", () => {
  test("分かっていれば、対応機能の隣に出す", () => {
    expect(
      modelPickDetail(["tools"], undefined, { total: 128, used: 8 })
    ).toBe(
      "対応: tools ／ 大きいけれど速い型（部品128個のうち、一度に使うのは" +
        "8個だけ。メモリに全部載らなくても遅くなりにくい）"
    );
  });

  test("測った値より前に置く（測る前から分かる手がかりだから）", () => {
    const detail = modelPickDetail(
      [],
      { outputTokensPerSecond: 12.3 },
      { total: 128, used: 8 }
    );
    expect(detail).toBe(
      "大きいけれど速い型（部品128個のうち、一度に使うのは8個だけ。" +
        "メモリに全部載らなくても遅くなりにくい） ／ 実測 12.3 トークン/秒"
    );
  });

  test("分からないモデルでは、これまでと1文字も変わらない", () => {
    expect(modelPickDetail(["tools"], { outputTokensPerSecond: 12.3 })).toBe(
      "対応: tools ／ 実測 12.3 トークン/秒"
    );
    expect(modelPickDetail([], undefined, undefined)).toBeUndefined();
  });
});

describe("実測の一覧", () => {
  /** 表の行（見出しと区切りを除く）を、セルの配列にして返す */
  function rows(markdown: string): string[][] {
    return markdown
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .slice(2)
      .map((line) =>
        line
          .slice(1, -1)
          .split("|")
          .map((cell) => cell.trim())
      );
  }

  test("部品の使い方を、速さと同じ表に並べる", () => {
    const markdown = buildTuningStatsMarkdown([
      {
        providerLabel: "Ollama",
        model: "gemma4:26b",
        tuning: { outputTokensPerSecond: 20 },
        experts: { total: 128, used: 8 },
      },
      {
        providerLabel: "Ollama",
        model: "gemma4:12b",
        tuning: { outputTokensPerSecond: 10 },
      },
    ]);

    const table = rows(markdown);
    expect(table[0][10]).toBe("大きいけれど速い型（128個中8個ずつ）");
    // **分からない行は「—」。** 「ふつうの型」とは書かない
    expect(table[1][10]).toBe("—");
    // その「—」が何を意味するかを、表の前で断る
    expect(markdown).toContain(
      "この欄の「—」は、部品を分けていないという意味ではなく、分からないという意味です。"
    );
  });

  test("訊く手を渡さなければ、どの行にも出ない", () => {
    // クラウドのAIは答えてくれない。台帳の行はそのまま並ぶ
    const entries = tuningStatsEntries(
      new Map([["sakura/gpt-oss-120b", { outputTokensPerSecond: 98.7 }]]),
      (id) => id
    );
    expect(entries[0].experts).toBeUndefined();
    expect(rows(buildTuningStatsMarkdown(entries))[0][10]).toBe("—");
  });

  test("訊けた行にだけ添える", () => {
    const entries = tuningStatsEntries(
      new Map([
        ["ollama/gemma4:26b", { outputTokensPerSecond: 20 }],
        ["sakura/gpt-oss-120b", { outputTokensPerSecond: 98.7 }],
      ]),
      (id) => id,
      (providerId, model) =>
        providerId === "ollama" && model === "gemma4:26b"
          ? { total: 128, used: 8 }
          : undefined
    );
    expect(entries.map((e) => e.experts)).toEqual([
      { total: 128, used: 8 },
      undefined,
    ]);
  });
});

describe("Ollamaから取る", () => {
  beforeEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubShow(modelInfo: unknown): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!url.endsWith("/api/show")) throw new Error(`想定外の口: ${url}`);
        return new Response(
          JSON.stringify({ capabilities: ["completion"], model_info: modelInfo }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
  }

  test("/api/show の部品の数を、そのままモデル情報へ入れる", async () => {
    stubShow(GEMMA4_26B);
    const info = await new OllamaProvider().getModel("gemma4:26b");
    expect(info?.experts).toEqual({ total: 128, used: 8 });
    // 文脈長の読み取りは、これまでどおり同じ `model_info` から取れている
    expect(info?.contextWindow).toBe(262144);
  });

  test("項目の無いモデルでは、欄そのものを持たない", async () => {
    stubShow(GEMMA4_12B);
    const info = await new OllamaProvider().getModel("gemma4:12b");
    expect(info?.experts).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(info, "experts")).toBe(false);
  });

  test("Ollamaが止まっていても、例外にはしない（欄が空になるだけ）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("接続できません");
      })
    );
    await expect(
      new OllamaProvider().describeExperts("gemma4:26b")
    ).resolves.toBeUndefined();
  });

  test("describeExperts は /api/show の値を返す", async () => {
    stubShow(GEMMA4_26B);
    await expect(
      new OllamaProvider().describeExperts("gemma4:26b")
    ).resolves.toEqual({ total: 128, used: 8 });
  });
});
