import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { describe, expect, test } from "vitest";
import { workScan } from "../../../src/mcp/tools/workScan";
import { novelMaterial, novelPrompt, novelRun } from "../../../src/mcp/tools/features";
import {
  FEATURE_COMMANDS,
  featureAlternative,
  featureNeeds,
  featureOfCommand,
} from "../../../src/core/featurePrerequisites";
import { ACTION_PREREQUISITES } from "../../../src/core/prerequisites";

/**
 * 外部AIにも、順路と代わりの道を届ける（設計書6.94、0.67.3）。
 *
 * 作者の指示（2026-09-18）の後半「**外部AIでも同様です**」。画面の関門は
 * 0.67.2 で入ったが、外部AIは前提を知らないまま呼べていた。
 *
 * ここで見るのは4つ。
 * ①`novel.scan` が前提の姿を返す ②前提の足りない feature は断られ、
 * **足りないものと代わりの名前が返る** ③揃っていれば今までどおり通る
 * ④**代わりの feature を勝手に実行しない**
 */

/** 4つの前提のうち3つ（設定資料・あらすじ・プロット）と単話プロットが揃った作り物 */
const WORK = nodePath.join(__dirname, "..", "..", "fixtures", "mcp-work");
const NUM_CTX = 32768;

/** 設定資料もあらすじもプロットも無い作品。本文だけ置く */
function bareWork(): string {
  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-prereq-"));
  const body = nodePath.join(tmp, "本文");
  fs.mkdirSync(body);
  fs.writeFileSync(
    nodePath.join(body, "001_はじまり.txt"),
    "少年は防波堤に立っていた。海はしずかだった。\n",
    "utf8"
  );
  return tmp;
}

function withBareWork(run: (folder: string) => void): void {
  const tmp = bareWork();
  try {
    run(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("novel.scan が前提の姿を返す", () => {
  test("4種類ぶんを、作者に見せる名前つきで返す", () => {
    const result = workScan({ folder: WORK });
    expect(result.prerequisites.map((item) => item.kind)).toEqual([
      "settings",
      "synopsis",
      "plot",
      "episodePlot",
    ]);
    // 名前は画面・相談・マニュアルと同じ言い方（表から引いている）
    expect(result.prerequisites.map((item) => item.label)).toEqual([
      "設定資料",
      "各話あらすじ",
      "プロット",
      "単話プロット",
    ]);
    // **作る操作の名前も返す。** 外部AIは実行できないが、作者へ伝えられる
    expect(result.prerequisites[0].makeLabel).toBe("一括抽出");
    // その前提が無いと通せない feature（表から引く。写しではない）
    expect(result.prerequisites[0].blocks).toEqual(["contradiction"]);
    expect(result.prerequisites[2].blocks).toEqual(["deviation"]);
  });

  test("揃っている作品では ready、何も無い作品では not ready", () => {
    const ready = workScan({ folder: WORK });
    expect(ready.prerequisites.every((item) => item.ready)).toBe(true);

    withBareWork((folder) => {
      const bare = workScan({ folder });
      expect(
        bare.prerequisites.map((item) => [item.kind, item.ready])
      ).toEqual([
        ["settings", false],
        ["synopsis", false],
        ["plot", false],
        ["episodePlot", false],
      ]);
      // 走査そのものは今までどおり動く（前提が無くても本文は読める）
      expect(bare.episodes).toHaveLength(1);
    });
  });
});

describe("前提の足りない feature は、実行せずに断る", () => {
  test("足りないもの・作る操作・代わりの名前が、断り文句に入っている", () => {
    withBareWork((folder) => {
      let message = "";
      try {
        novelPrompt({
          folder,
          feature: "contradiction",
          filePath: "本文/001_はじまり.txt",
          numCtx: NUM_CTX,
        });
        throw new Error("断られなかった");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      // ①足りないもの
      expect(message).toContain("「設定資料」");
      // ②それを作る操作の名前と、**作者が画面で行うこと**
      expect(message).toContain("「一括抽出」");
      expect(message).toContain("作者が画面で行います");
      // ③代わりの feature の名前（外部AIがそのまま呼べる）
      expect(message).toContain("feature: factContradiction");
      expect(message).toContain("矛盾検知（事実の照合）");
      // ④勝手に走らせないと言い切る
      expect(message).toContain("こちらでは実行しません");
      // 次に何を見ればよいか
      expect(message).toContain("novel.scan");
    });
  });

  test("代わりの道が無い feature では、代わりの行を出さない", () => {
    withBareWork((folder) => {
      expect(() =>
        novelPrompt({
          folder,
          feature: "deviation",
          filePath: "本文/001_はじまり.txt",
        })
      ).toThrow(/「プロット」が要ります/);
      expect(() =>
        novelPrompt({
          folder,
          feature: "deviation",
          filePath: "本文/001_はじまり.txt",
        })
      ).not.toThrow(/代わりに feature/);
    });
  });

  test("run と material も、材料を組む前に断る", async () => {
    const tmp = bareWork();
    try {
      await expect(
        novelRun({
          folder: tmp,
          feature: "contradiction",
          filePath: "本文/001_はじまり.txt",
          numCtx: NUM_CTX,
          runner: "ollama",
          model: "gemma4:e4b",
        })
      ).rejects.toThrow(/「設定資料」/);

      expect(() =>
        novelMaterial({
          folder: tmp,
          feature: "contradiction",
          filePath: "本文/001_はじまり.txt",
          numCtx: NUM_CTX,
        })
      ).toThrow(/「設定資料」/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("あらすじの無い作品では、プロット逆算が断られる", () => {
    withBareWork((folder) => {
      expect(() => novelPrompt({ folder, feature: "plotReverse" })).toThrow(
        /「各話あらすじ」が要ります/
      );
    });
  });

  test("前提の無い feature は、何も無い作品でもそのまま通る", () => {
    withBareWork((folder) => {
      const prompt = novelPrompt({
        folder,
        feature: "typo",
        filePath: "本文/001_はじまり.txt",
        numCtx: NUM_CTX,
      }) as { chunks: unknown[] };
      expect(prompt.chunks.length).toBeGreaterThan(0);
    });
  });
});

describe("前提が揃っていれば、今までどおり通る", () => {
  test("設定資料のある作品では、矛盾検知のプロンプトが組める", () => {
    const prompt = novelPrompt({
      folder: WORK,
      feature: "contradiction",
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
    }) as { chunks: Array<{ chunkId: string }> };
    expect(prompt.chunks.length).toBeGreaterThan(0);
  });
});

describe("代わりの feature を勝手に実行しない", () => {
  test("断りは例外で返り、代わりの機能の結果は返らない", () => {
    withBareWork((folder) => {
      // **結果が返ってきたら負け。** 返ってきていたら、頼んでいない機能の
      // 答えを「矛盾検知の結果」として受け取っていることになる
      let returned: unknown = "（返っていない）";
      try {
        returned = novelPrompt({
          folder,
          feature: "contradiction",
          filePath: "本文/001_はじまり.txt",
          numCtx: NUM_CTX,
        });
      } catch {
        // 断られたので何も返らない（これが正しい）
      }
      expect(returned).toBe("（返っていない）");
    });
  });
});

describe("前提の表は1つだけ（写しを作らない）", () => {
  test("feature の前提は `ACTION_PREREQUISITES` から引いている", () => {
    expect(featureNeeds("contradiction")).toEqual(
      ACTION_PREREQUISITES["novelai.checkContradictions"].needs
    );
    expect(featureNeeds("deviation")).toEqual(["plot"]);
    expect(featureNeeds("episodePlot")).toEqual(["episodePlot"]);
    expect(featureNeeds("plotReverse")).toEqual(["synopsis"]);
    // 前提の無い feature は空
    expect(featureNeeds("typo")).toEqual([]);
    expect(featureNeeds("factContradiction")).toEqual([]);
  });

  test("表に載っている操作は、すべて feature と結べている", () => {
    // 結べていない操作があると、画面では止まるのにMCPでは素通りする
    const unlinked = Object.keys(ACTION_PREREQUISITES).filter(
      (command) => featureOfCommand(command) === undefined
    );
    expect(unlinked).toEqual([]);
  });

  test("代わりの道も、コマンドIDではなく feature の名前で返る", () => {
    const alternative = featureAlternative("contradiction");
    expect(alternative?.feature).toBe("factContradiction");
    expect(alternative?.why).toBe(
      ACTION_PREREQUISITES["novelai.checkContradictions"].insteadOf?.why
    );
    // 代わりの道は、この1組だけ（6.94.2）
    expect(featureAlternative("deviation")).toBeUndefined();
  });

  test("対応表のコマンドIDは、すべて novelai. で始まる", () => {
    for (const command of Object.values(FEATURE_COMMANDS)) {
      expect(command).toMatch(/^novelai\./);
    }
  });
});
