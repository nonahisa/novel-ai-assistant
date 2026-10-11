import { describe, expect, test } from "vitest";
import {
  compareVersions,
  mergeChangelogHunk,
  mergeVersionLine,
  mergeVersionTableRow,
  readSixVersions,
  resolveFile,
  splitConflicts,
  tableRegressions,
} from "../../../scripts/resolveAgentMerge.mjs";

/*
  担当の枝を合わせるときの、版まわりのぶつかりを解く道具
  （`scripts/resolveAgentMerge.mjs`。作者の指示、2026-10-11）。

  使い捨ての台本で起きた2つの失敗を、再現テストとして先頭に置く。

    1. 版の表の行を枝の側で丸ごと取り、GitHub Release・Marketplace の欄が
       古い値に戻った（本体の側のほうが新しいことがある）
    2. 解けない塊を「両方残す」で連結し、同じ行の古い形と訂正つきの形が
       両方残った

  競合マーカーは組み立てて使う（このファイル自体がぶつかった塊に見えないように）。
*/

const OPEN = "<".repeat(7) + " HEAD";
const MID = "=".repeat(7);
const CLOSE = ">".repeat(7) + " worktree-agent-x";

function conflict(ours: string, theirs: string): string {
  return `${OPEN}\n${ours}${MID}\n${theirs}${CLOSE}\n`;
}

const HANDOVER = "docs/進捗と引継ぎ.md";

function tableRow(local: string, release: string, marketplace: string, note = "（2026-10-11）"): string {
  return (
    `| 版 | **${local}**（手元） ／ GitHub Release は **v${release}**（2026-10-11） ／ ` +
    `Marketplace は **${marketplace}**${note}。**vsce の PAT はこの機械に無い** |`
  );
}

describe("今日の失敗の再現", () => {
  test("版の表：手元は枝の側、GitHub Release・Marketplace は本体の側が新しいとき、どの欄も下がらない", () => {
    // 本体はリリースを出したあと（Release・Marketplace が 0.103.3）、枝は手元の版だけ上げた
    const ours = tableRow("0.103.3", "0.103.3", "0.103.3", "（2026-10-11 16:26 に反映を確認）");
    const theirs = tableRow("0.103.5", "0.103.0", "0.103.0");
    const source = `| | |\n|---|---|\n${conflict(ours + "\n", theirs + "\n")}| 単体テスト | 1件 |\n`;

    const result = resolveFile(HANDOVER, source);

    expect(result.unresolved).toEqual([]);
    const row = result.text.split("\n").find((line) => line.startsWith("| 版 |"))!;
    expect(row).toContain("**0.103.5**（手元）");
    expect(row).toContain("GitHub Release は **v0.103.3**");
    // 欄の注記（反映を確認した時刻）は版と一緒に本体の側から来る
    expect(row).toContain("Marketplace は **0.103.3**（2026-10-11 16:26 に反映を確認）");
    expect(tableRegressions(row, [ours, theirs])).toEqual([]);
    expect(result.text).not.toContain(OPEN);
  });

  test("同じ行の古い形と訂正つきの形は、両方残さずに止めて一覧に出す", () => {
    const ours = "- 0.103.2 で送り直しが止まる件を直した\n";
    const theirs = "- 0.103.2 で送り直しが止まる件を直した（訂正：止まっていたのは開いたときの点検だけ）\n";
    const source = `## 8. 作業の記録\n\n${conflict(ours, theirs)}\n## 9. 次の節\n`;

    const result = resolveFile(HANDOVER, source);

    expect(result.resolved).toBe(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toMatchObject({
      line: 3,
      ours: ours.trimEnd(),
      theirs: theirs.trimEnd(),
    });
    // 塊はそのまま残る（連結しない）
    expect(result.text).toBe(source);
  });
});

describe("版の比べ方", () => {
  test("数で比べる（文字列なら 0.99.0 が大きくなる）", () => {
    expect(compareVersions("0.103.0", "0.99.0")).toBeGreaterThan(0);
    expect(compareVersions("v0.103.3", "0.103.3")).toBe(0);
    expect(compareVersions("0.103.4", "0.103.5")).toBeLessThan(0);
  });
});

describe("6か所の版の行", () => {
  test("package.json は大きい版", () => {
    const source = `{\n  "name": "x",\n${conflict('  "version": "0.103.4",\n', '  "version": "0.103.5",\n')}}\n`;
    const result = resolveFile("package.json", source);
    expect(result.unresolved).toEqual([]);
    expect(result.text).toBe('{\n  "name": "x",\n  "version": "0.103.5",\n}\n');
  });

  test("package.json：本体の側が大きければ本体の側", () => {
    const source = conflict('  "version": "0.103.6",\n', '  "version": "0.103.5",\n');
    expect(resolveFile("package.json", source).text).toBe('  "version": "0.103.6",\n');
  });

  test("package-lock.json：先頭の自分の版は解くが、下の依存の版は解かない", () => {
    const top = conflict('  "version": "0.103.4",\n', '  "version": "0.103.5",\n');
    const filler = "  \"x\": 1,\n".repeat(30);
    const dependency = conflict('      "version": "5.7.1",\n', '      "version": "5.8.0",\n');
    const result = resolveFile("package-lock.json", `{\n${top}${filler}${dependency}}\n`);
    expect(result.resolved).toBe(1);
    expect(result.unresolved).toHaveLength(1);
    expect(result.text).toContain('  "version": "0.103.5",\n');
    expect(result.text).toContain("5.8.0");
  });

  test("README：このリポジトリの版も Marketplace の版も、それぞれ大きいほう", () => {
    const ours = "このリポジトリの版：**0.103.4**（Marketplace に出ている版は **0.103.3**）。続き\n";
    const theirs = "このリポジトリの版：**0.103.5**（Marketplace に出ている版は **0.103.0**）。続き\n";
    const result = resolveFile("README.md", conflict(ours, theirs));
    expect(result.text).toBe(
      "このリポジトリの版：**0.103.5**（Marketplace に出ている版は **0.103.3**）。続き\n"
    );
  });

  test("設計書・プロンプト設計書の version 行と対象の行", () => {
    const result = resolveFile(
      "docs/プロンプト設計書.md",
      conflict(
        "version 0.103.4 / 2026-10-11\n（対象：`docs/設計書.md` version 0.103.4）\n",
        "version 0.103.5 / 2026-10-10\n（対象：`docs/設計書.md` version 0.103.5）\n"
      )
    );
    expect(result.text).toBe(
      "version 0.103.5 / 2026-10-11\n（対象：`docs/設計書.md` version 0.103.5）\n"
    );
  });

  test("src/mcp/version.ts", () => {
    const result = resolveFile(
      "src/mcp/version.ts",
      conflict('export const SERVER_VERSION = "0.103.4";\n', 'export const SERVER_VERSION = "0.103.5";\n')
    );
    expect(result.text).toBe('export const SERVER_VERSION = "0.103.5";\n');
  });

  test("版の行ではない塊は、版の数字が入っていても解かない", () => {
    const result = resolveFile(
      "docs/設計書.md",
      conflict("0.103.4 で入れた。\n", "0.103.5 で入れた。\n")
    );
    expect(result.unresolved).toHaveLength(1);
  });

  test("CRLF の行は CRLF のまま返す", () => {
    const source = `${OPEN}\r\n  "version": "0.103.4",\r\n${MID}\r\n  "version": "0.103.5",\r\n${CLOSE}\r\n`;
    expect(resolveFile("package.json", source).text).toBe('  "version": "0.103.5",\r\n');
  });

  test("元の形つき（diff3）の塊は読まない", () => {
    const source =
      `${OPEN}\n  "version": "0.103.4",\n${"|".repeat(7)} base\n  "version": "0.103.3",\n` +
      `${MID}\n  "version": "0.103.5",\n${CLOSE}\n`;
    const result = resolveFile("package.json", source);
    expect(result.unresolved).toHaveLength(1);
    expect(result.text).toBe(source);
  });
});

describe("版の表の行", () => {
  test("欄の数や並びが違えば解かない", () => {
    expect(
      mergeVersionTableRow(
        "| 版 | **0.1.0**（手元） ／ GitHub Release は **v0.1.0** |",
        "| 版 | **0.1.1**（手元） |"
      )
    ).toBeUndefined();
  });

  test("下がった欄を見つける", () => {
    const merged = tableRow("0.103.5", "0.103.0", "0.103.0");
    const before = tableRow("0.103.3", "0.103.3", "0.103.3");
    expect(tableRegressions(merged, [before])).toEqual([
      "GitHub Release が 0.103.3 から 0.103.0 へ下がった",
      "Marketplace が 0.103.3 から 0.103.0 へ下がった",
    ]);
  });

  test("数字と日付以外も違う行は解かない", () => {
    expect(mergeVersionLine("version 0.1.0 / 2026-10-11\n", "ver 0.1.1 / 2026-10-11\n")).toBeUndefined();
  });
});

describe("CHANGELOG", () => {
  test("両方の項を版の新しい順に並べる", () => {
    const ours = "## 0.103.4 - 2026-10-11\n\n### 修正\n\n- A\n\n";
    const theirs = "## 0.103.5 - 2026-10-11\n\n### 修正\n\n- B\n\n";
    const source = `# Change Log\n\n${conflict(ours, theirs)}## 0.103.3 - 2026-10-11\n\n- C\n`;
    const result = resolveFile("CHANGELOG.md", source);
    expect(result.unresolved).toEqual([]);
    expect(result.text).toBe(
      "# Change Log\n\n" +
        "## 0.103.5 - 2026-10-11\n\n### 修正\n\n- B\n\n" +
        "## 0.103.4 - 2026-10-11\n\n### 修正\n\n- A\n\n" +
        "## 0.103.3 - 2026-10-11\n\n- C\n"
    );
  });

  test("同じ版の項が両側にあって中身が違えば、解かない", () => {
    const outcome = mergeChangelogHunk("## 0.103.5 - x\n\n- A\n", "## 0.103.5 - x\n\n- B\n");
    expect(outcome).toHaveProperty("reason");
  });

  test("項の途中で分かれた塊は、解かない", () => {
    const outcome = mergeChangelogHunk("- A\n", "- B\n");
    expect(outcome).toHaveProperty("reason");
  });
});

describe("塊の読み取り", () => {
  test("閉じていない塊は、読んだまま文として残す", () => {
    const source = `前\n${OPEN}\n途中\n`;
    const parts = splitConflicts(source);
    expect(parts.every((part: { kind: string }) => part.kind === "text")).toBe(true);
    expect(parts.map((part: { text: string }) => part.text).join("")).toBe(source);
  });
});

describe("6か所の版を読む", () => {
  test("そろっていれば同じ版が並ぶ", () => {
    const files: Record<string, string> = {
      "package.json": '{\n  "version": "0.103.5",\n}',
      "package-lock.json":
        '{\n  "name": "n",\n  "version": "0.103.5",\n  "packages": {\n    "": {\n      "name": "n",\n      "version": "0.103.5",\n',
      "CHANGELOG.md": "# Change Log\n\n## 0.103.5 - 2026-10-11\n",
      "README.md": "このリポジトリの版：**0.103.5**（Marketplace に出ている版は **0.103.0**）",
      "docs/設計書.md": "# x\n\nversion 0.103.5 / 2026-10-11\n",
      "docs/プロンプト設計書.md": "# x\n\nversion 0.103.5 / 2026-10-11\n（対象：`docs/設計書.md` version 0.103.5）\n",
      "src/mcp/version.ts": 'export const SERVER_VERSION = "0.103.5";',
      [HANDOVER]: `| | |\n${tableRow("0.103.5", "0.103.0", "0.103.0")}\n`,
    };
    const versions = readSixVersions((file: string) => files[file]);
    expect(new Set(Object.values(versions))).toEqual(new Set(["0.103.5"]));
  });
});
