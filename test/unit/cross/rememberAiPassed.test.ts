import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * AIを送る確認の「以降は訊かない」は、**送る先のAIを一緒に渡す**（セキュリティ点検「中」、2026-11-21）。
 *
 * 覚えたときのAIと違えば訊き直す判断は `views/notify.ts` の1か所にあるが、
 * 呼び出し側がAIを渡さなければ判断できない。渡し忘れた確認は安全側（毎回訊く）へ倒れるものの、
 * それでは［以降は訊かない］が永久に効かなくなる。そこでソースの形で押さえる。
 *
 * - `ai.run.*`：`{ id: "ai.run.…", ai: … }` の形で、id のすぐあとにAIを書く
 * - `ai.paid.*`：`confirmPaidUsage(` の中で渡す（プロバイダとモデルから、関数の中でAIを足す）
 */

const SRC = join(__dirname, "..", "..", "..", "src");
/** 覚えてよい確認の一覧そのもの（呼び出しではない） */
const LIST_FILE = join(SRC, "core", "confirmMemory.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** 呼び出しの括弧の範囲（文字列の中の括弧は数えない。`inferredWorkConfirm.test.ts` と同じ数え方） */
function callRange(source: string, openParen: number): [number, number] {
  let depth = 0;
  let quote: string | undefined;
  for (let index = openParen; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === "\\") {
        index++;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") {
      depth--;
      if (depth === 0) return [openParen, index];
    }
  }
  return [openParen, source.length];
}

const files = sourceFiles(SRC).filter((file) => file !== LIST_FILE);
const sites = files.flatMap((file) => {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/id: "(ai\.(?:run|paid)\.[A-Za-z]+)"/g)].map((match) => ({
    file: relative(SRC, file).replace(/\\/g, "/"),
    text,
    id: match[1],
    index: match.index ?? 0,
    after: text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 8),
  }));
});

describe("AIを送る確認は、送る先のAIを渡す", () => {
  test("見張る呼び出しが見つかる（数え方が壊れていない）", () => {
    expect(sites.length).toBeGreaterThanOrEqual(30);
  });

  test.each(sites.map((site) => [`${site.file}（${site.id}）`, site] as const))(
    "%s",
    (_name, site) => {
      const calls = [...site.text.matchAll(/\b(confirmRun|confirmRunOrChoose|confirmPaidUsage)\(/g)]
        .map((match) => ({
          name: match[1],
          range: callRange(site.text, (match.index ?? 0) + match[0].length - 1),
        }))
        .filter(({ range }) => range[0] < site.index && site.index < range[1]);
      // いちばん内側の呼び出し
      const call = calls.at(-1);
      expect(call, "確認の呼び出しの中に無い id（どの道で訊いているか分からない）").toBeDefined();
      if (call?.name === "confirmPaidUsage") return;
      // `ai: confirmAiOf(…)` か、先に組んだ並びをそのまま渡す `ai`（事実の照合）
      expect(site.after, "id のすぐあとに送る先のAI（ai:）を書く").toMatch(/^, ai\b/);
    }
  );
});
