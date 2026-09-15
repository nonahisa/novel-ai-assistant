import * as path from "path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { workScan } from "../../src/mcp/tools/workScan";
import {
  PROOFREAD_RUN_INPUT,
  proofreadPrompt,
  proofreadRun,
  proofreadValidate,
} from "../../src/mcp/tools/proofread";
import {
  TYPO_RUN_INPUT,
  typoPrompt,
  typoRun,
  typoValidate,
} from "../../src/mcp/tools/typo";
import { TYPO_CHECK_VERSION } from "../../src/prompts/typoCheck";
import {
  CHAT_RUN_INPUT,
  chatPrompt,
  chatRun,
  chatValidate,
} from "../../src/mcp/tools/chat";
import { WORK_CHAT_VERSION } from "../../src/prompts/workChat";
import { contradictionMaterial } from "../../src/mcp/tools/contradiction";
import { foreshadowPrompt } from "../../src/mcp/tools/foreshadow";
import { ollamaGenerate } from "../../src/mcp/tools/ollama";

/**
 * 外から呼ぶ口（MCPのツール）を、**転送層を通さずに**確かめる（設計書6.87.8）。
 *
 * ツールの中身は `src/mcp/tools/*.ts` にあり、`server.ts` は配線だけなので、
 * ここではハンドラを直に呼ぶ。stdio を立てて確かめるのは
 * `scripts/smokeMcp.mjs`（あちらは束ができてからでないと走らない）。
 *
 * **本物の原稿は読まない。** 作り物のフォルダー（`test/fixtures/mcp-work`）
 * だけを相手にする。
 */
const WORK = path.join(__dirname, "..", "fixtures", "mcp-work");

/** 手元で使う想定のモデルと同じくらいの上限。チャンクの大きさはここから決まる */
const NUM_CTX = 32768;

describe("work.scan", () => {
  test("3話入りの合本と単話で、合わせて4話を返す", () => {
    const result = workScan({ folder: WORK });

    // ファイルは2つ、話は4つ（**合本を1件として返さない**）
    expect(result.fileCount).toBe(2);
    expect(result.episodes).toHaveLength(4);
    expect(result.episodes.map((episode) => episode.chapter)).toEqual([
      4, 1, 2, 3,
    ]);
    expect(result.episodes.map((episode) => episode.insideCollected)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    // 合本の中の話にはタイトルが付いている
    expect(result.episodes[1].title).toBe("灯");
    // 頭書き（【タイトル】【あらすじ】）は字数に入れない
    expect(result.episodes[1].chars).toBeGreaterThan(0);
    expect(result.episodes[1].chars).toBeLessThan(60);
    expect(result.skipped).toEqual([]);
  });

  test("作品フォルダーの外は読めない", () => {
    // `..` で外へ出る指定は断る（`core/pathText.ts` の `goesOutside`）。
    // **読めてしまうと、作者が渡していないファイルをAIへ送ることになる**
    expect(() =>
      proofreadPrompt({
        folder: WORK,
        filePath: path.join("..", "..", "..", "package.json"),
        numCtx: NUM_CTX,
      })
    ).toThrow(/作品フォルダーの外/);
  });
});

describe("proofread", () => {
  test("runner を省くとエラーになる（既定を作らない）", async () => {
    // 転送層は zod で弾く。**`runner` は必須**
    const shape = z.object(PROOFREAD_RUN_INPUT);
    const parsed = shape.safeParse({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
    });
    expect(parsed.success).toBe(false);

    // ハンドラを直に呼んでも、既定へ倒れずに止まる
    await expect(
      proofreadRun({
        folder: WORK,
        filePath: "本文/004_よあけ.txt",
        numCtx: NUM_CTX,
      } as unknown as Parameters<typeof proofreadRun>[0])
    ).rejects.toThrow(/runner/);
  });

  test("runner が claude なら、プロンプトと戻し先が返る（本文は投げない）", async () => {
    const result = await proofreadRun({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
      runner: "claude",
    });

    expect(result.runner).toBe("claude");
    if (result.runner !== "claude") throw new Error("claude のはず");
    expect(result.validateWith).toBe("proofread.validate");
    expect(result.systemPrompt.length).toBeGreaterThan(0);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].chunkId).toContain("004_よあけ.txt");
    // 本文が入っていること（行番号付き）
    expect(result.chunks[0].userPrompt).toContain("まず最初に");
  });

  test("文体メモを空のまま投げない（F-21）", () => {
    const result = proofreadPrompt({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
    });
    // `設定/plot.md` の人称と `設定/keep_words.json` の語が載る
    expect(result.narrativeStyle).toBe("三人称一元");
    expect(result.styleNote).toContain("掠れて");
    expect(result.chunks[0].userPrompt).toContain("掠れて");
  });

  test("本文に実在しない原文の指摘は、検算で落ちる", () => {
    const prompts = proofreadPrompt({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
    });
    const chunkId = prompts.chunks[0].chunkId;

    const response = JSON.stringify({
      issues: [
        {
          line: 2,
          original: "まず最初に",
          suggestion: "まず",
          reason: "冗長",
          explanation: "同じ意味が重なっている",
          confidence: "high",
        },
        {
          line: 2,
          original: "この言い回しは本文のどこにもない",
          suggestion: "なおす",
          reason: "冗長",
          explanation: "でっち上げ",
          confidence: "high",
        },
      ],
    });

    const result = proofreadValidate({ folder: WORK, chunkId, response });

    expect(result.accepted.map((issue) => issue.original)).toEqual([
      "まず最初に",
    ]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe("original_not_found");
  });

  test("作者が「直さない」と決めた語を含む指摘は出さない", () => {
    const prompts = proofreadPrompt({
      folder: WORK,
      filePath: "本文/collected.txt",
      numCtx: NUM_CTX,
    });
    const chunkId = prompts.chunks[prompts.chunks.length - 1].chunkId;
    const response = JSON.stringify({
      issues: [
        {
          line: 1,
          original: "掠れて読めなかった",
          suggestion: "かすれて読めなかった",
          reason: "漢字ひらき",
          explanation: "ひらがなにする",
          confidence: "high",
        },
      ],
    });

    const result = proofreadValidate({ folder: WORK, chunkId, response });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toBe("kept_word");
  });

  test("chunkId の形が違えば、そこで止まる", () => {
    expect(() =>
      proofreadValidate({
        folder: WORK,
        chunkId: "本文/004_よあけ.txt",
        response: "{}",
      })
    ).toThrow(/chunkId/);
  });
});

/**
 * 誤字脱字（P-08）を外から呼ぶ（0.64.1）。
 *
 * 作者の指定「まずはテストに利用できる部分を優先したい」に対して、
 * **いちばん測り直したいのがここ**である。見るのは4つ——
 * プロンプトに辞書と作法が載ること、検算が製品と同じに効くこと、
 * **辞書はプロンプトでだけ切って検算では切らないこと**、`runner` の必須。
 */
describe("typo", () => {
  test("チャンクごとにプロンプトを返す", () => {
    const result = typoPrompt({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
    });

    expect(result.promptVersion).toBe(TYPO_CHECK_VERSION);
    expect(result.validateWith).toBe("typo.validate");
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].chunkId).toContain("004_よあけ.txt");
    expect(result.chunks[0].userPrompt).toContain("まず最初に");
  });

  test("固有名詞の辞書と、作品の書き方をプロンプトへ載せる", () => {
    const result = typoPrompt({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
    });

    // `設定/characters/` の name と aliases が辞書に入る
    expect(result.chunks[0].userPrompt).toContain("少年");
    expect(result.chunks[0].userPrompt).toContain("灯の子");
    expect(result.dictionaryCount).toBeGreaterThan(0);
    // **空のまま投げない**（設計書6.8.14。文語体で漢字ひらきが乱発する）
    expect(result.styleNote).toContain("掠れて");
    expect(result.chunks[0].userPrompt).toContain("掠れて");
  });

  /**
   * **通るものが通ることも見る。** 落ちる側だけを見ていると、
   * 何もかも落とす実装が満点になる（CLAUDE.md「見逃しと誤検出の
   * 両方を測ること」）。
   */
  test("本文にある語の指摘は、検算を通る", () => {
    const prompts = typoPrompt({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
    });
    const chunkId = prompts.chunks[0].chunkId;

    const response = JSON.stringify({
      issues: [
        {
          line: 2,
          original: "まず最初に、少年は窓を開けた。",
          target: "窓を開けた",
          suggestion: "窓を空けた",
          reason: "誤変換",
          confidence: "high",
        },
      ],
    });

    const result = typoValidate({ folder: WORK, chunkId, response });

    expect(result.accepted.map((issue) => issue.target)).toEqual(["窓を開けた"]);
    expect(result.rejected).toEqual([]);
  });

  test("固有名詞を誤字だと言われても、検算で落ちる", () => {
    const prompts = typoPrompt({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
    });
    const chunkId = prompts.chunks[0].chunkId;

    const response = JSON.stringify({
      issues: [
        {
          line: 2,
          // **original（前後を含む箇所）と target（誤っている語）は別の欄で、
          // どちらも必須である。** 片方だけでは `parseIssue` が形として弾き、
          // 「固有名詞だから落ちた」のか「形が違って落ちた」のか区別が付かない。
          // **実際に束を起動して踏んだ**（0.64.1）——単体テストは件数しか
          // 見ていなかったので、3件とも invalid_shape で落ちていても通っていた
          original: "まず最初に、少年は窓を開けた。",
          target: "少年",
          suggestion: "少女",
          reason: "変換ミス",
          confidence: "high",
        },
      ],
    });

    const result = typoValidate({ folder: WORK, chunkId, response });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    // **理由まで見る。** 件数だけだと、形が違って落ちた回も通ってしまう
    expect(result.rejected[0].reason).toBe("protected_term");
  });

  test("本文に実在しない語の指摘は、検算で落ちる", () => {
    const prompts = typoPrompt({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
    });
    const chunkId = prompts.chunks[0].chunkId;

    const response = JSON.stringify({
      issues: [
        {
          line: 2,
          original: "この語は本文のどこにもない",
          target: "この語は本文のどこにもない",
          suggestion: "なおす",
          reason: "脱字",
          confidence: "high",
        },
      ],
    });

    const result = typoValidate({ folder: WORK, chunkId, response });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).not.toBe("invalid_shape");
  });

  test("応答がJSONとして読めなければ、そこで止まる", () => {
    const prompts = typoPrompt({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
    });
    expect(() =>
      typoValidate({
        folder: WORK,
        chunkId: prompts.chunks[0].chunkId,
        response: "これはJSONではありません",
      })
    ).toThrow(/JSON/);
  });

  test("chunkId の形が違えば、そこで止まる", () => {
    expect(() =>
      typoValidate({
        folder: WORK,
        chunkId: "本文/004_よあけ.txt",
        response: "{}",
      })
    ).toThrow(/chunkId/);
  });

  /**
   * **runner に既定を作らない**（設計書6.87.8 の5）。手元へ投げるのと
   * Anthropic へ本文を渡すのとでは、作者にとっての意味がまるで違う。
   * 転送層の zod と、ハンドラの中の両方で断る。
   */
  test("runner を省くと、転送層で断られる", () => {
    const schema = z.object(TYPO_RUN_INPUT);
    expect(
      schema.safeParse({
        folder: WORK,
        filePath: "本文/004_よあけ.txt",
        numCtx: NUM_CTX,
      }).success
    ).toBe(false);
  });

  test("runner が claude なら、プロンプトと戻し先だけを返す", async () => {
    const result = await typoRun({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
      runner: "claude",
    });

    expect(result.runner).toBe("claude");
    if (result.runner !== "claude") throw new Error("claude のはず");
    expect(result.validateWith).toBe("typo.validate");
    // **検算を通していないものは製品の結果ではない**、と必ず言う
    expect(result.note).toContain("validate");
    expect(result.chunks[0].userPrompt).toContain("まず最初に");
  });

  test("runner が ollama なのに model が無ければ、そこで止まる", async () => {
    await expect(
      typoRun({
        folder: WORK,
        filePath: "本文/004_よあけ.txt",
        numCtx: NUM_CTX,
        runner: "ollama",
      })
    ).rejects.toThrow(/model/);
  });
});

/**
 * 相談（P-21）を外から呼ぶ（0.64.2）。
 *
 * **ほかの機能と違って、チャンクが無い**（1つの問いに1つの答え）。
 * 見るのは、**3つの診断をどう扱うか**である——
 *
 * | 診断 | どこに在るか | ここでの扱い |
 * |---|---|---|
 * | ターゲット読者 | 作品の `設定/読者像.json` | **読める**ので、渡さなくても足す |
 * | 助言方針 | `globalState` | 答え（9問）を渡せば足す |
 * | 執筆スタイル | `globalState` | 答え（5問）を渡せば足す |
 *
 * **渡さない軸は1字も送らない**（製品の決まり。未診断の作者と同じ）。
 */
describe("chat", () => {
  test("問いとシステムの指示を組む", () => {
    const result = chatPrompt({ folder: WORK, question: "第4話の続きに迷っています" });

    expect(result.promptVersion).toBe(WORK_CHAT_VERSION);
    expect(result.validateWith).toBe("chat.validate");
    expect(result.userPrompt).toContain("第4話の続きに迷っています");
    // 材料に、作品の登場人物が入る
    expect(result.reference.join("\n")).toContain("少年");
  });

  /**
   * **読者診断だけは、渡さなくても足せる。** 作品フォルダーの中に在るからで、
   * ここが「MCPから読める診断」と「読めない診断」の分かれ目である。
   */
  test("読者診断は、作品のファイルから読んで足す", () => {
    const result = chatPrompt({ folder: WORK, question: "どう思いますか" });

    expect(result.diagnoses.readerType).toBe(true);
    expect(result.systemPrompt).toContain("【この作品の読者】");
  });

  test("助言方針と執筆スタイルは、渡さなければ1字も送らない", () => {
    const result = chatPrompt({ folder: WORK, question: "どう思いますか" });

    expect(result.diagnoses.advicePolicy).toBe(false);
    expect(result.diagnoses.writerStyle).toBe(false);
    // **足さなかったことを、理由ごと知らせる**
    expect(result.diagnoses.omitted.join("\n")).toContain("adviceAnswers");
    expect(result.diagnoses.omitted.join("\n")).toContain("writerStyle");
    expect(result.systemPrompt).not.toContain("【この作者の書き方】");
  });

  test("診断の答えを渡すと、製品の関数が組み立てて足す", () => {
    const result = chatPrompt({
      folder: WORK,
      question: "どう思いますか",
      adviceAnswers: [2, 1, 2, 0, 2, 0, 2, 1, 2],
      // **即興派で、書き終えてから直す作者**。相談へ渡すのはこの2軸だけ
      writerStyle: {
        situation: "posted",
        plan: "improviser",
        revise: "after_all",
        material: "memo",
        outlet: "serial",
      },
    });

    expect(result.diagnoses.advicePolicy).toBe(true);
    expect(result.diagnoses.writerStyle).toBe(true);
    expect(result.systemPrompt).toContain("【この作者の書き方】");
    expect(result.diagnoses.omitted).toEqual([]);
  });

  /**
   * **知らない値は受け取らない**（`buildWriterStyle` の約束）。
   * 黙って既定へ倒すと、答えていない値で助言の調子が決まる。
   */
  test("執筆スタイルに知らない値が混ざれば、足さずに理由を言う", () => {
    const result = chatPrompt({
      folder: WORK,
      question: "どう思いますか",
      writerStyle: {
        situation: "posted",
        plan: "そんな段取りは無い",
        revise: "after_all",
        material: "memo",
        outlet: "serial",
      },
    });

    expect(result.diagnoses.writerStyle).toBe(false);
    expect(result.diagnoses.omitted.join("\n")).toContain("選択肢に無い値");
  });

  test("本文を指すと、抜粋を材料に添える", () => {
    const result = chatPrompt({
      folder: WORK,
      question: "この書き出しはどうでしょう",
      filePath: "本文/004_よあけ.txt",
    });

    expect(result.userPrompt).toContain("まず最初に");
  });

  test("作品フォルダーの外は読めない", () => {
    expect(() =>
      chatPrompt({
        folder: WORK,
        question: "これは",
        filePath: path.join("..", "..", "..", "package.json"),
      })
    ).toThrow(/作品フォルダーの外/);
  });

  test("応答を読み解き、提案が入っていたかを知らせる", () => {
    const response = JSON.stringify({
      reply: "第4話の書き出しは、静かで良いと思います。",
      options: ["続きを書く", "別の入り方を考える"],
      edit: { target: "plot", text: "夜明けから始める" },
    });

    const result = chatValidate({ response });

    expect(result.answer.reply).toContain("静かで良い");
    expect(result.answer.options).toHaveLength(2);
    // **MCPは実行しない。** 入っていたことだけを知らせる
    expect(result.proposals.edit).toBe(true);
    expect(result.proposals.run).toBe(false);
  });

  /**
   * **JSONとして読めなくても、答えを捨てない**（製品の `parseWorkChatAnswer`）。
   * 相談は「形が合っているか」より「作者に答えが届くか」が大事な機能で、
   * AIが素の文で返したときは、それをそのまま答えとして扱う。
   *
   * **ここで自前の門番を足さない。** 足すと「製品では読める応答が
   * MCPでは捨てられる」という差ができる。
   */
  test("JSONでない応答は、本文がそのまま答えになる（製品と同じ）", () => {
    const result = chatValidate({ response: "書き出しは静かでよいと思います。" });

    expect(result.answer.reply).toBe("書き出しは静かでよいと思います。");
    expect(result.answer.options).toEqual([]);
    expect(result.proposals.edit).toBe(false);
  });

  test("runner を省くと、転送層で断られる", () => {
    const schema = z.object(CHAT_RUN_INPUT);
    expect(
      schema.safeParse({ folder: WORK, question: "どう思いますか" }).success
    ).toBe(false);
  });

  test("runner が claude なら、プロンプトと戻し先だけを返す", async () => {
    const result = await chatRun({
      folder: WORK,
      question: "どう思いますか",
      runner: "claude",
    });

    expect(result.runner).toBe("claude");
    if (result.runner !== "claude") throw new Error("claude のはず");
    expect(result.validateWith).toBe("chat.validate");
    expect(result.note).toContain("validate");
    // 何を足したかは、この道でも分かる
    expect(result.diagnoses.readerType).toBe(true);
  });
});

describe("contradiction.material", () => {
  test("本文に出てくる人物だけを、その話の時点で返す", () => {
    const result = contradictionMaterial({
      folder: WORK,
      filePath: "本文/collected.txt",
      numCtx: NUM_CTX,
    });

    expect(result.settingsCount.people).toBe(1);
    const first = result.chunks[0];
    // 「少年」は本文に出てくるので、材料がある
    expect(first.hasAnything).toBe(true);
    expect(first.characterDetails).toContain("少年");
    // 第1話には、それより前のあらすじは無い
    expect(first.previousSynopses).toBe("");
    // 第2話以降には、前の話のあらすじが載る
    const second = result.chunks.find((chunk) => chunk.chapterLabel === "第2話");
    expect(second?.previousSynopses).toContain("第1話");
  });
});

describe("foreshadow.prompt", () => {
  test("張った話より前の本文には、回収の確認を掛けない", () => {
    const result = foreshadowPrompt({
      folder: WORK,
      filePath: "本文/collected.txt",
      numCtx: NUM_CTX,
      mode: "resolve",
    });

    expect(result.ledger.open).toBe(1);
    // 第1話（張った話）から後だけが対象。**張った箇所を「回収」と言わせない**
    for (const chunk of result.chunks) {
      expect(chunk.targetIds).toEqual(["foreshadow_0001"]);
    }
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  test("detect では台帳の名前を渡して、同じものを二度出させない", () => {
    const result = foreshadowPrompt({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
    });
    expect(result.mode).toBe("detect");
    expect(result.chunks[0].userPrompt).toContain("帰らない父の船");
  });
});

describe("ollama.generate", () => {
  test("手元でない宛先は、allowRemote が無ければ断る（投げない）", async () => {
    await expect(
      ollamaGenerate({
        endpoint: "http://example.com:11434",
        model: "dummy",
        systemPrompt: "s",
        userPrompt: "u",
        numCtx: 4096,
      })
    ).rejects.toThrow(/allowRemote/);
  });
});
