import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 設計書と引継ぎ書の、目次と節番号を守る（2026-08-16）。
 *
 * 設計書に目次を付けたときに、**6.18 が2つある**ことが分かった。
 * 別セッションが「作中の時間」を、こちらが「相談で使う検索」を、
 * それぞれ 6.18 として足していた。両方がコードと引継ぎ書から番号で
 * 参照されており、どちらを指しているのか読めない状態だった。
 *
 * 番号は70か所以上から参照される（CLAUDE.md）。**目視では見つからない**ので、
 * ここで機械に見張らせる。
 */

/** VS Code のMarkdownプレビューが見出しから作るリンク先と同じ規則 */
function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(
      /[\][!/'"#$%&()*+,./:;<=>?@\\^_{|}~`。，、；：？！…—·ˉ¨‘’“”～‖∶＂＇｀｜〔〕〈〉《》「」『』．〖〗【】（）［］｛｝]/g,
      ""
    )
    .replace(/\s+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

interface Heading {
  level: number;
  text: string;
  /** その見出しの行番号（0始まり）。目次に載せる範囲を絞るのに使う */
  line: number;
}

function headings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], line: index });
  });
  return out;
}

/** 見出しから作られるリンク先。同名は -1, -2 が付く */
function anchors(lines: string[]): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const heading of headings(lines)) {
    const base = slugify(heading.text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

interface DocSpec {
  name: string;
  path: string;
  /**
   * 目次に載せなくてよい見出し。
   *
   * 引継ぎ書の「8. 作業の記録」は日付順の記録が94節あり、
   * 並べると目次が目次でなくなる。**章そのものは目次に載せる。**
   */
  skipSectionsAfter?: string;
}

const DOCS: DocSpec[] = [
  { name: "設計書", path: "docs/設計書.md" },
  {
    name: "引継ぎ書",
    path: "docs/進捗と引継ぎ.md",
    skipSectionsAfter: "8. 作業の記録（日付順・読み飛ばして構いません）",
  },
];

for (const doc of DOCS) {
  const text = readFileSync(doc.path, "utf-8");
  const lines = text.split(/\r?\n/);
  const all = headings(lines);

  const skipFrom = doc.skipSectionsAfter
    ? (all.find((h) => h.text === doc.skipSectionsAfter)?.line ?? Infinity)
    : Infinity;

  /** 目次に載っているべき見出し */
  const expected = all.filter(
    (h) =>
      h.text !== "目次" &&
      h.text !== "いまの状態" &&
      (h.level === 2 || (h.level === 3 && h.line < skipFrom))
  );

  describe(`${doc.name}の節番号`, () => {
    test("同じ番号の節が2つ無い", () => {
      const numbers = all
        .filter((h) => h.level >= 2 && h.level <= 4)
        // 日付の見出し（`2026-08-05 …`）を節番号と間違えない。
        // 数字のあとにハイフンが続くものは日付とみなす
        .map((h) => /^(\d+(?:\.\d+)*)(?![-\d])/.exec(h.text)?.[1])
        .filter((n): n is string => Boolean(n));

      const duplicated = [
        ...new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i)),
      ];

      expect(duplicated, `重複している節番号: ${duplicated.join("、")}`).toEqual(
        []
      );
    });
  });

  describe(`${doc.name}の目次`, () => {
    const listed = new Set(
      [...text.matchAll(/^\s*- \[(.+?)\]\(#.+?\)\s*$/gm)].map((m) => m[1])
    );

    test("目次がある", () => {
      expect(text).toContain("## 目次");
    });

    test("章と節がすべて載っている", () => {
      // 節を足したのに目次へ入れ忘れると、目次から辿れない節ができる
      const missing = expected
        .map((h) => h.text)
        .filter((title) => !listed.has(title));

      expect(missing, `目次に無い見出し: ${missing.join(" / ")}`).toEqual([]);
    });

    test("リンク先がすべて実在する", () => {
      // 押しても飛ばないリンクは、無いより悪い
      const known = anchors(lines);
      const broken = [...text.matchAll(/\[([^\]]+?)\]\(#([^)]+?)\)/g)]
        .map((m) => ({ label: m[1], anchor: m[2] }))
        .filter((link) => !known.has(link.anchor));

      expect(
        broken.map((b) => `${b.label} → #${b.anchor}`),
        "飛ばないリンク"
      ).toEqual([]);
    });
  });
}
