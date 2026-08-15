import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 設計書の目次と節番号を守る（2026-08-16）。
 *
 * 目次を作ったときに、**6.18 が2つある**ことが分かった。別セッションが
 * 「作中の時間」を、こちらが「相談で使う検索」を、それぞれ 6.18 として
 * 足していた。両方がコードと引継ぎ書から番号で参照されており、
 * どちらを指しているのか読めない状態だった。
 *
 * 番号は70か所以上から参照される（CLAUDE.md）。**目視では見つからない**ので、
 * ここで機械に見張らせる。
 */

const DOC = readFileSync("docs/設計書.md", "utf-8");
const LINES = DOC.split(/\r?\n/);

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
}

function headings(): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  for (const line of LINES) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2] });
  }
  return out;
}

/** 見出しから作られるリンク先。同名は -1, -2 が付く */
function anchors(): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const heading of headings()) {
    const base = slugify(heading.text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

describe("設計書の節番号", () => {
  test("同じ番号の節が2つ無い", () => {
    // 6.18 が2つあり、コードと引継ぎ書の参照がどちらを指すのか
    // 読めなくなっていた（実際に起きた）
    const numbers = headings()
      .filter((h) => h.level >= 2 && h.level <= 4)
      .map((h) => /^(\d+(?:\.\d+)*)/.exec(h.text)?.[1])
      .filter((n): n is string => Boolean(n));

    const duplicated = [
      ...new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i)),
    ];

    expect(duplicated, `重複している節番号: ${duplicated.join("、")}`).toEqual([]);
  });
});

describe("設計書の目次", () => {
  test("目次がある", () => {
    expect(DOC).toContain("## 目次");
  });

  test("章（##）と節（###）がすべて載っている", () => {
    // 節を足したのに目次へ入れ忘れると、目次から辿れない節ができる
    const listed = new Set(
      [...DOC.matchAll(/^\s*- \[(.+?)\]\(#.+?\)\s*$/gm)].map((m) => m[1])
    );
    const missing = headings()
      .filter((h) => h.level === 2 || h.level === 3)
      .map((h) => h.text)
      .filter((text) => text !== "目次" && !listed.has(text));

    expect(missing, `目次に無い見出し: ${missing.join(" / ")}`).toEqual([]);
  });

  test("リンク先がすべて実在する", () => {
    // 押しても飛ばないリンクは、無いより悪い
    const known = anchors();
    const broken = [...DOC.matchAll(/^\s*- \[(.+?)\]\(#(.+?)\)\s*$/gm)]
      .map((m) => ({ label: m[1], anchor: m[2] }))
      .filter((link) => !known.has(link.anchor));

    expect(
      broken.map((b) => `${b.label} → #${b.anchor}`),
      "飛ばないリンク"
    ).toEqual([]);
  });
});
