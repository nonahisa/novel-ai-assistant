import { afterEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { deviationPrompt, deviationValidate } from "../../../src/mcp/tools/episode";
import { deviationBudget } from "../../../src/prompts/deviationCheck";

/**
 * 外から呼ぶ逸脱検知（P-11）が、製品（`features/checkDeviations.ts`）と同じものを
 * 送るか（2026-09-26、逸脱の測り直しで見つけた）。
 *
 * **製品の経路を迂回した測定は、製品に無い不具合を見つけたことになる**
 * （CLAUDE.md の「繰り返し起きた失敗」5番）。MCP の `novel.run`（feature: deviation）は
 * 次の4つで製品と違うものを送っていた。
 *
 *   1. **小さいモデル向けの観点**：製品は20B未満のモデルへ「逸脱」だけを尋ね、
 *      「間延び」を尋ねない（`ai/capability.ts` の `narrowDeviationTypes`）。MCP は
 *      いつも2つとも尋ねていたので、e4b・12b を製品と同じ条件で測れなかった
 *   2. **件数の上限**：製品は話の長さから決める（`deviationBudget`。1〜4件）。MCP は
 *      いつも5件と書いていた（検算は4件で切るので、プロンプトと検算が食い違う）
 *   3. **前後の話のあらすじ**：製品は前後2話ずつ（その話を含む）を「第N話: 」で渡す。
 *      MCP は前後1話ずつを「第N話：」で渡していた
 *   4. **シーンメモ**：製品は行頭 `//` の付箋を空行にしてから送る。MCP はそのまま送っていた
 */

const FIXTURE = nodePath.join(__dirname, "..", "..", "fixtures", "mcp-work");
const EPISODE = "本文/004_よあけ.txt";

const temporary: string[] = [];

function copyOfFixture(edit?: (folder: string) => void): string {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-mcp-deviation-"));
  fs.cpSync(FIXTURE, folder, { recursive: true });
  edit?.(folder);
  temporary.push(folder);
  return folder;
}

afterEach(() => {
  while (temporary.length > 0) {
    const folder = temporary.pop();
    if (folder) fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("MCP の逸脱検知が製品と同じものを送る", () => {
  test("small を渡すと「逸脱」だけを尋ね、版に印が付く", () => {
    const folder = copyOfFixture();
    const small = deviationPrompt({ folder, filePath: EPISODE, modelSize: "small" });
    expect(small.userPrompt).toContain("1. 逸脱：");
    expect(small.userPrompt).not.toContain("間延び：");
    expect(small.userPrompt).toContain("type には次のどれか1つだけを入れてください：逸脱\n");
    expect(small.promptVersion).toMatch(/light/);

    // 既定（large）はこれまでどおり2つとも尋ねる
    const large = deviationPrompt({ folder, filePath: EPISODE });
    expect(large.userPrompt).toContain("2. 間延び：");
    expect(large.promptVersion).not.toMatch(/light/);
  });

  test("知らない大きさは黙って丸めない", () => {
    const folder = copyOfFixture();
    expect(() =>
      deviationPrompt({ folder, filePath: EPISODE, modelSize: "tiny" })
    ).toThrow(/tiny/);
  });

  test("件数の上限は話の長さから決める（検算と同じ数）", () => {
    const folder = copyOfFixture();
    const result = deviationPrompt({ folder, filePath: EPISODE });
    const body = fs
      .readFileSync(nodePath.join(folder, EPISODE), "utf8")
      .replace(/\r\n/g, "\n");
    const expected = deviationBudget(body.trimEnd().length);
    expect(result.maxIssues).toBe(expected);
    expect(result.userPrompt).toContain(`最大${expected}件`);
  });

  test("前後2話ぶんのあらすじを、製品と同じ書き方で渡す", () => {
    const folder = copyOfFixture();
    const result = deviationPrompt({ folder, filePath: EPISODE });
    // 第4話から見て前後2話以内は第2話・第3話（第1話は3話離れている）
    expect(result.userPrompt).toContain("第2話: 船は戻らず");
    expect(result.userPrompt).toContain("第3話: 冬の終わりに便りが届く。");
    expect(result.userPrompt).not.toContain("第1話: ");
  });

  test("シーンメモ（行頭 //）は空行にして送り、検算も同じ本文で照らす", () => {
    const folder = copyOfFixture((dir) => {
      const file = nodePath.join(dir, EPISODE);
      const text = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, text.replace("　まず最初に、", "// 作者だけの付箋：ここで窓の音を足す\n　まず最初に、"), "utf8");
    });
    const result = deviationPrompt({ folder, filePath: EPISODE });
    expect(result.userPrompt).not.toContain("作者だけの付箋");
    // 行は消さずに空にする（行番号がずれないように）
    expect(result.userPrompt).toMatch(/\n2: \n3: 　まず最初に、/);

    // 付箋の文を引いた指摘は、本文に無いものとして落ちる
    const checked = deviationValidate({
      folder,
      filePath: EPISODE,
      response: JSON.stringify({
        deviations: [
          {
            lineStart: 2,
            lineEnd: 2,
            excerpt: "作者だけの付箋",
            type: "逸脱",
            reason: "プロットに無い付箋の話が挟まっている",
            plotReference: "冬の港と、防波堤の先。",
            severity: "low",
            confidence: "low",
          },
        ],
      }),
    });
    expect(checked.accepted).toHaveLength(0);
    expect(checked.rejected.map((entry) => entry.reason)).toContain("excerpt_not_found");
  });
});
