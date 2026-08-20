import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { planSplit, rebuild, unnumberedCount } from "../../src/core/splitCollected";

/**
 * 合本の分割を、**作者の実データ**で確かめる。
 *
 * **書き込みは一切しない。** 分け方を組み立てて、繋ぎ直すと元に戻るかだけを見る。
 *
 *   $env:NOVELAI_WORKS = "C:/path/to/作品を集めたフォルダー"
 *   npx vitest run --config vitest.live.config.mts test/live/splitRealFiles.test.ts
 */
const ROOT = process.env.NOVELAI_WORKS?.trim();

function collectedFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "backups") continue;
    const dir = path.join(root, entry.name);
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".txt")) continue;
      const file = path.join(dir, name);
      const text = fs.readFileSync(file, "utf-8");
      if (/^-{3,}\s*エピソード\s*\d+\s*開始/m.test(text)) found.push(file);
    }
  }
  return found;
}

describe.skipIf(!ROOT)("実データの合本を分ける（書き込みはしない）", () => {
  test("繋ぎ直すと1文字も違わない", () => {
    const files = collectedFiles(ROOT!);
    expect(files.length, "合本が見つからない").toBeGreaterThan(0);

    const report: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf-8");
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      const plan = planSplit(text, { extension: ".txt" });
      expect(plan, file).not.toBeNull();

      // **これが要。** 合わなければ、その形には対応できていない
      expect(rebuild(plan!.preamble, plan!.parts, eol), file).toBe(text);
      expect(plan!.lossless, file).toBe(true);

      report.push(
        `${path.basename(path.dirname(file))}/${path.basename(file)}: ` +
          `${plan!.parts.length}話（話数不明 ${unnumberedCount(plan!)}件）` +
          ` 先頭=${plan!.parts[0].fileName}`
      );
    }
    console.log("\n" + report.join("\n"));
    fs.writeFileSync(
      process.env.NOVELAI_REPORT?.trim() ?? "split-real.txt",
      report.join("\n"),
      "utf-8"
    );
  });
});
