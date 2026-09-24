import { describe, expect, test } from "vitest";
import { buildWorkChatPrompt } from "../../../src/prompts/workChat";

/**
 * 相談でAIが求めたファイルが1つも読めなかったとき（2026-09-24、実データの測定）。
 *
 * **起きていたこと**：AIが `episode_0001.txt` を求めたが実物は
 * `episode_0001.md` だった。読めないファイルは黙って飛ばし、1つも読めないと
 * 聞き直さなかったので、作者の画面には1往復目の「本文を提示して
 * いただけますか」だけが残った。作者には何が起きたのか分からない。
 *
 * 直し方：聞き直しの材料に「見つからなかった」ことと、作品にある
 * ファイルの候補を入れる。往復は増やさない（今の「1回だけ」の枠の中）。
 */
function build(extra: Partial<Parameters<typeof buildWorkChatPrompt>[0]>) {
  return buildWorkChatPrompt({
    workTitle: "試しの作品",
    contextKind: "workOnly",
    contextLabel: "作品全体",
    excerpt: "",
    excerptTruncated: false,
    fromSelection: false,
    reference: [],
    history: [],
    question: "第1話を講評してください",
    ...extra,
  });
}

describe("求めたファイルが見つからなかったときの聞き直しの材料", () => {
  test("見つからなかったことと、作品にあるファイルの候補が入る", () => {
    const prompt = build({
      missingFiles: {
        paths: ["episode_0001.txt"],
        available: [
          { path: "episode_0001.md", label: "第1話 出会い" },
          { path: "episode_0002.md", label: "第2話 別れ" },
        ],
        availableTotal: 19,
      },
    });

    expect(prompt).toContain("見つかりませんでした");
    expect(prompt).toContain("episode_0001.txt");
    expect(prompt).toContain("episode_0001.md（第1話 出会い）");
    expect(prompt).toContain("episode_0002.md（第2話 別れ）");
    // 一部だけ見せていることを明記する（「これで全部」と誤解させない）
    expect(prompt).toContain("全19件");
  });

  test("1つも読めなかったときは、もう一度求めさせずに答えさせる", () => {
    // 往復は1回だけ。ここで needFiles を返されても、もう読まない
    const prompt = build({
      missingFiles: {
        paths: ["episode_0001.txt"],
        available: [{ path: "episode_0001.md", label: "第1話 出会い" }],
        availableTotal: 1,
      },
    });

    expect(prompt).toContain("needFiles は空に");
    expect(prompt).not.toContain("【あなたが求めたファイル】");
  });

  test("一部だけ読めたときは、読めたものと見つからなかったものの両方が入る", () => {
    const prompt = build({
      requestedFiles: [{ path: "設定/plot.md", content: "プロットの本文" }],
      missingFiles: {
        paths: ["episode_0001.txt"],
        available: [],
        availableTotal: 0,
      },
    });

    expect(prompt).toContain("【あなたが求めたファイル】");
    expect(prompt).toContain("プロットの本文");
    expect(prompt).toContain("見つかりませんでした");
  });

  test("見つからなかったものが無ければ、今までどおり何も足さない", () => {
    const prompt = build({
      requestedFiles: [{ path: "episode_0001.md", content: "本文" }],
    });

    expect(prompt).not.toContain("見つかりませんでした");
  });
});

// 元から減らす側：製品の目次（話の一覧）は題しか持たず、AI は needFiles の
// パスを当て推量で書いていた。題にファイルの場所を添えていることを見張る
describe("相談の目次の話の一覧には、ファイルの場所が添えてある", () => {
  /*
    0.85.1 で組み方を `core/chatFileRequest.ts` の `formatChatOverview` へ寄せた
    （MCP の相談も同じものを通す）。**組み方そのものは中身で確かめ**、
    相談パネルがそれを通していることは源を読んで確かめる
  */
  test("題の後ろに作品フォルダーからの相対パスを付ける", async () => {
    const { formatChatOverview } = await import("../../../src/core/chatFileRequest");
    const text = formatChatOverview({
      episodes: [{ path: "本文/episode_0001.md", label: "第1話 出会い" }],
      documents: [],
    });
    expect(text).toContain("第1話 出会い（本文/episode_0001.md）");
  });

  test("相談パネルの buildOverview は、その組み方と、候補と同じ話の一覧を通す", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/features/workChatPanel.ts", "utf8");
    const start = source.indexOf("private async buildOverview");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, start + 1500);
    expect(body).toContain("this.episodeHints(work)");
    expect(body).toContain("formatChatOverview(");
    // 話の一覧の場所は作品フォルダーからの相対（区切りは / に揃える）
    const hints = source.slice(source.indexOf("private async episodeHints"));
    expect(hints).toMatch(/path\.relative\(root, episode\.filePath\)\.replace\(/);
  });
});
