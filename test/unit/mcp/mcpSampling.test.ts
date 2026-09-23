import { describe, expect, test, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  SAMPLING_UNAVAILABLE,
  askSampling,
  clearSamplingHost,
  samplingAvailable,
  setSamplingHost,
} from "../../src/mcp/tools/sampling";
import {
  RUNNER_KINDS,
  assertRunner,
  runChunksBySampling,
} from "../../src/mcp/tools/run";
import { RUNNER_INPUT } from "../../src/mcp/tools/shared";
import { typoRun } from "../../src/mcp/tools/typo";
import { setExternalClientName } from "../../src/mcp/tools/accessLog";

/** この試験での接続元の名乗り。**許可と門番が同じ相手を見る** */
const TEST_CLIENT = "試験のクライアント";

/**
 * 呼び出し元に考えてもらう道（MCP の sampling。設計書6.87.12）。
 *
 * **作者の指示（2026-09-16）**：「２をすすめてください」。
 *
 * ## ここで見張りたいこと
 *
 * 1. **使えない呼び出し元で、黙って壊れないこと。** 対応は実装ごとに違い、
 *    **繋いでみるまで分からない**。使えないなら、**次に何を選べばよいか**を
 *    添えて断る（CLAUDE.md 規則5）
 * 2. **検算を迂回できないこと。** この道の値打ちはそこにある——`claude` の
 *    道は `prompt` だけ呼んで `validate` を通さない使い方ができてしまう
 * 3. **行き先の顔ぶれが、入力の形と食い違わないこと**（写しを作らない）
 */

const WORK = nodePath.join(__dirname, "..", "fixtures", "mcp-work");

/** 作り物のクライアント。宣言と答えを差し替えられる */
function fakeHost(options: {
  sampling?: boolean;
  reply?: { text?: string; model?: string; stopReason?: string; type?: string };
  fail?: unknown;
}) {
  const asked: Array<Record<string, unknown>> = [];
  return {
    asked,
    getClientCapabilities: () =>
      options.sampling === false ? {} : { sampling: {} },
    createMessage: async (params: Record<string, unknown>) => {
      asked.push(params);
      if (options.fail) throw options.fail;
      return {
        model: options.reply?.model ?? "テストのモデル",
        stopReason: options.reply?.stopReason ?? "endTurn",
        role: "assistant",
        content: {
          type: options.reply?.type ?? "text",
          text: options.reply?.text ?? "{}",
        },
      };
    },
  };
}

/** 型の細部は本物に合わせない（この試験が見るのは振る舞いだけ） */
function useHost(host: ReturnType<typeof fakeHost>): void {
  setSamplingHost(host as unknown as Parameters<typeof setSamplingHost>[0]);
}

/**
 * 考えさせることを許した作品を、一時に作る。
 *
 * **既定は拒否**（作者の指示、2026-09-16）なので、許した作品でしか
 * 頼めない。試験のたびに作って捨てる。
 */
function allowedWork(options: { sampling?: boolean } = {}): string {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-sampling-"));
  fs.mkdirSync(nodePath.join(folder, ".aiwriter"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(folder, ".aiwriter", "external-access.json"),
    JSON.stringify({
      clients: [
        {
          // **接続元ごと・道具ごとの許可**（0.66.1、設計書6.87.14）。
          // この試験は sampling の可否だけを見たいので、道具は全部許す
          name: TEST_CLIENT,
          tools: ["*"],
          sampling: options.sampling !== false,
          decidedAt: "2026-09-16T00:00:00.000Z",
          decidedOn: "テスト",
          note: "",
        },
      ],
    }),
    "utf8"
  );
  temporary.push(folder);
  return folder;
}

const temporary: string[] = [];

beforeEach(() => {
  setExternalClientName(TEST_CLIENT);
});

afterEach(() => {
  setExternalClientName("");
  clearSamplingHost();
  for (const folder of temporary.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("行き先の顔ぶれ", () => {
  test("**入力の形と食い違わない**（写しを作らない）", () => {
    /*
      選択肢を増やしたときに、片方だけ直すと
      「指定できるのに受け付けない」が生まれる。
    */
    const declared = RUNNER_INPUT.runner.options;
    expect([...declared].sort()).toEqual([...RUNNER_KINDS].sort());
  });

  test("知らない行き先は断る。**断り文句に3つとも出る**", () => {
    expect(() => assertRunner("てきとう")).toThrow(/ollama/);
    expect(() => assertRunner(undefined)).toThrow(/claude/);
    expect(() => assertRunner("")).toThrow(/sampling/);
  });

  test("3つとも通る", () => {
    for (const kind of RUNNER_KINDS) {
      expect(() => assertRunner(kind)).not.toThrow();
    }
  });
});

describe("使えるかどうかを、繋いでから確かめる", () => {
  test("相手がいなければ使えない", () => {
    expect(samplingAvailable()).toBe(false);
  });

  test("宣言していなければ使えない", () => {
    useHost(fakeHost({ sampling: false }));
    expect(samplingAvailable()).toBe(false);
  });

  test("宣言していれば使える", () => {
    useHost(fakeHost({}));
    expect(samplingAvailable()).toBe(true);
  });

  test("**断るときは、次に選ぶものを示す**", async () => {
    useHost(fakeHost({ sampling: false }));
    await expect(
      askSampling({ folder: allowedWork(), systemPrompt: "指示", userPrompt: "本文" })
    ).rejects.toThrow(/ollama/);
    // 断り文句は1か所だけに置く（写すとずれる）
    expect(SAMPLING_UNAVAILABLE).toContain("claude");
  });
});

describe("頼み方", () => {
  test("システムの指示は専用の欄へ入れる", async () => {
    const host = fakeHost({});
    useHost(host);
    await askSampling({
      folder: allowedWork(),
      systemPrompt: "あなたは校正者です",
      userPrompt: "本文",
    });
    expect(host.asked[0].systemPrompt).toBe("あなたは校正者です");
  });

  test("**ほかのサーバーの文脈を混ぜない**", async () => {
    const host = fakeHost({});
    useHost(host);
    await askSampling({ folder: allowedWork(), systemPrompt: "指示", userPrompt: "本文" });
    /*
      混ぜると、**測っているものが製品のプロンプトでなくなる**。
      同じ材料で比べられなくなる。
    */
    expect(host.asked[0].includeContext).toBe("none");
  });

  test("書いてよい上限を必ず渡す（仕様で必須）", async () => {
    const host = fakeHost({});
    useHost(host);
    await askSampling({ folder: allowedWork(), systemPrompt: "指示", userPrompt: "本文" });
    expect(typeof host.asked[0].maxTokens).toBe("number");
    expect(host.asked[0].maxTokens).toBeGreaterThan(0);
  });

  test("答えたモデルを受け取る（**こちらでは選べない**）", async () => {
    useHost(fakeHost({ reply: { model: "むこうが選んだモデル" } }));
    const reply = await askSampling({ folder: allowedWork(), systemPrompt: "指示", userPrompt: "本文" });
    expect(reply.model).toBe("むこうが選んだモデル");
  });

  test("途中で切れたことが分かる", async () => {
    useHost(fakeHost({ reply: { stopReason: "maxTokens" } }));
    const reply = await askSampling({ folder: allowedWork(), systemPrompt: "指示", userPrompt: "本文" });
    expect(reply.truncated).toBe(true);
  });

  test("**文字以外で答えられたら断る**", async () => {
    /*
      空の応答として検算へ流すと、「AIが何も見つけなかった」と
      区別が付かなくなる。
    */
    useHost(fakeHost({ reply: { type: "image" } }));
    await expect(
      askSampling({ folder: allowedWork(), systemPrompt: "指示", userPrompt: "本文" })
    ).rejects.toThrow(/文字以外/);
  });
});

describe("チャンクごとに回す", () => {
  test("1つ失敗しても止めず、理由を残して次へ進む", async () => {
    const result = await runChunksBySampling(
      [{ chunkId: "a" }, { chunkId: "b" }, { chunkId: "c" }],
      // 温度は製品の値を呼ぶ側から渡す（6.87.16）
      0,
      async (item) => {
        if (item.chunkId === "b") throw new Error("途中で切れました");
        return { result: item.chunkId, model: "M" };
      }
    );
    expect(result.results).toEqual(["a", "c"]);
    // **黙って飛ばさない**（件数だけでは何も分からない）
    expect(result.failures).toEqual([
      { chunkId: "b", reason: "途中で切れました" },
    ]);
  });

  test("答えたモデルを並べる", async () => {
    const result = await runChunksBySampling(
      [{ chunkId: "a" }, { chunkId: "b" }],
      // 温度は製品の値を呼ぶ側から渡す（6.87.16）
      0,
      async (item) => ({ result: item.chunkId, model: item.chunkId }),
    );
    expect(result.model).toBe("a / b");
  });

  test("**1件も通らなかったら「通しました」と言わない**", async () => {
    /*
      **2026-09-16、実機で見つけた。** 全件が許可で断られた回にも
      「呼び出し元に考えてもらい、検算まで通しました」と返しており、
      **呼んだ側からは成功したように見えていた。**

      **行き先の断りも消える**——1件も呼んでいないのだから、
      本文はどこへも渡っていない。
    */
    const result = await runChunksBySampling(
      [{ chunkId: "a" }, { chunkId: "b" }],
      // 温度は製品の値を呼ぶ側から渡す（6.87.16）
      0,
      async () => {
        throw new Error("許可していません");
      }
    );
    expect(result.note).not.toContain("通しました");
    expect(result.note).not.toContain("本文は呼び出し元へ渡って");
    expect(result.note).toContain("2件");
    expect(result.note).toContain("failures");
  });

  test("一部だけ通ったら、通った数と落ちた数を両方出す", async () => {
    const result = await runChunksBySampling(
      [{ chunkId: "a" }, { chunkId: "b" }, { chunkId: "c" }],
      // 温度は製品の値を呼ぶ側から渡す（6.87.16）
      0,
      async (item) => {
        if (item.chunkId === "b") throw new Error("途中で切れました");
        return { result: item.chunkId, model: "M" };
      }
    );
    expect(result.note).toContain("2件");
    expect(result.note).toContain("1件");
  });

  test("**原稿の行き先を約束しない**", async () => {
    const result = await runChunksBySampling([], 0, async () => ({
      result: 1,
      model: "M",
    }));
    // どのAIが答えるかは呼び出し元が決める。そこは断る
    expect(result.note).toContain("呼び出し元");
    expect(result.note).toContain("検算");
  });
});

describe("道具から使う（誤字脱字）", () => {
  /**
   * 作り物の作品を写して、考えさせる許可を置く。
   *
   * **fixture そのものには許可を置かない**——置くと、ほかの試験まで
   * 「許可済み」で動くことになり、**既定が拒否であることを確かめられなくなる。**
   */
  function copiedWork(options: { sampling?: boolean } = {}): string {
    const folder = allowedWork(options);
    fs.cpSync(WORK, folder, { recursive: true, force: false });
    // cpSync は既にある .aiwriter を上書きしないので、印は残る
    return folder;
  }

  const inputFor = (folder: string) => ({
    folder,
    filePath: nodePath.join("本文", "004_よあけ.txt"),
    numCtx: 32768,
  });

  test("**検算まで通した結果だけを返す**", async () => {
    /*
      この道の値打ちはここにある。`claude` の道は `prompt` だけ呼んで
      `validate` を通さない使い方ができてしまう（6.87.6 の3）。
    */
    useHost(
      fakeHost({
        reply: { text: JSON.stringify({ issues: [] }), model: "むこうのAI" },
      })
    );
    const result = await typoRun({ ...inputFor(copiedWork()), runner: "sampling" });
    expect(result.runner).toBe("sampling");
    if (result.runner !== "sampling") throw new Error("形が違う");
    expect(result.model).toBe("むこうのAI");
    // 検算を通った結果が並ぶ（プロンプトではない）
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]).toHaveProperty("accepted");
  });

  test("対応していない呼び出し元では、失敗として残る", async () => {
    useHost(fakeHost({ sampling: false }));
    const result = await typoRun({ ...inputFor(copiedWork()), runner: "sampling" });
    if (result.runner !== "sampling") throw new Error("形が違う");
    // **黙って空を返さない。** 理由が残る
    expect(result.results).toHaveLength(0);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0].reason).toContain("ollama");
  });

  test("**許可していない作品では、考えさせない**", async () => {
    /*
      **作者の指示（2026-09-16）**：「ここでも、初期は閉鎖で解放するときは
      外部に情報を出す旨警告を表示させてください」。

      読ませる許可があっても、**考えさせる許可は別**である
      ——考えさせると、本文が**呼び出し元の選んだAIへ渡る**。
    */
    useHost(fakeHost({}));
    const folder = copiedWork({ sampling: false });
    const result = await typoRun({ ...inputFor(folder), runner: "sampling" });
    if (result.runner !== "sampling") throw new Error("形が違う");
    expect(result.results).toHaveLength(0);
    expect(result.failures[0].reason).toContain("許可していません");
    // **次にどうすればよいかを示す**（断るだけで終わらせない）
    expect(result.failures[0].reason).toContain("ollama");
  });

  test("ほかの行き先は今までどおり", async () => {
    const result = await typoRun({ ...inputFor(copiedWork()), runner: "claude" });
    expect(result.runner).toBe("claude");
  });
});
