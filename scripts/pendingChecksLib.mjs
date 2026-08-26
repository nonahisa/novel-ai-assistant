
/**
 * 実機確認リストの読み取りと、書き出す中身の組み立て（副作用なし）。
 *
 * **読み込むだけで何も起きないようにする。** 試験から使うので、
 * ここに書き換えを混ぜると、試験を走らせるたびにファイルが変わる。
 *
 * 実機確認リストから、「まだ確かめていない機能」の一覧を作る。
 *
 * **文書を手で写さない。** 操作メニューの「テスト中」も、確認を助ける道具も、
 * 同じ1つの文書（`docs/実機確認リスト.md`）から作る。写すと必ず片方が古くなる
 * （引継ぎ書の目次と同じ考え方。`scripts/handoverToc.mjs`）。
 *
 * 機械が触ってよいのは、機械にしか作れないものだけである（CLAUDE.md）。
 * ここで作るのは**見出しと未確認の項目を機械的に写したもの**で、文章は書かない。
 *
 *     node scripts/pendingChecks.mjs          作り直す
 *     node scripts/pendingChecks.mjs --check  ずれていないか見るだけ（テスト用）
 */

export const SOURCE = "docs/実機確認リスト.md";
export const TARGET = "src/views/pendingChecks.ts";

/** 見出しから、番号と表題を取り出す */
function parseHeading(line) {
  const text = line.replace(/^#{2,3}\s+/, "").trim();
  // 「A-15. 作品をすべて同期（0.19.6で追加。…）」→ id: A-15 / title: 作品をすべて同期
  const numbered = /^([A-Z]-\d+)\.\s*(.+)$/.exec(text);
  if (numbered) {
    return { id: numbered[1], title: stripNote(numbered[2]) };
  }
  // 「C. GitHubへはじめて同期する（…）」→ id: C / title: GitHubへはじめて同期する
  const lettered = /^([A-Z])\.\s*(.+)$/.exec(text);
  if (lettered) {
    return { id: lettered[1], title: stripNote(lettered[2]) };
  }
  return { id: "", title: stripNote(text) };
}

/** 見出しの後ろの注記（版・警告）を落とす。一覧に出すのは短い名前だけ */
function stripNote(text) {
  return text.replace(/（[^（）]*）\s*$/, "").replace(/\*\*/g, "").trim();
}

export function collectPendingChecks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const sections = [];
  let current;

  for (const line of lines) {
    if (/^#{2,3}\s/.test(line)) {
      const { id, title } = parseHeading(line);
      current = { id, title, commands: [], items: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;

    const target = /^<!--\s*対象:\s*(.+?)\s*-->$/.exec(line.trim());
    if (target) {
      current.commands = target[1]
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "");
      continue;
    }

    const pending = /^-\s\[\s\]\s(.+)$/.exec(line);
    if (pending) current.items.push(cleanItem(pending[1]));
  }

  return sections.filter((section) => section.items.length > 0);
}

/** 項目の文。画面に出すので、強調の記号は落とす */
function cleanItem(text) {
  return text.replace(/\*\*/g, "").trim();
}

export function render(sections) {
  const total = sections.reduce((sum, section) => sum + section.items.length, 0);
  const body = sections
    .map(
      (section) =>
        `  {\n` +
        `    id: ${JSON.stringify(section.id)},\n` +
        `    title: ${JSON.stringify(section.title)},\n` +
        `    commands: [${section.commands
          .map((name) => JSON.stringify(name))
          .join(", ")}],\n` +
        `    items: [\n${section.items
          .map((item) => `      ${JSON.stringify(item)},`)
          .join("\n")}\n    ],\n` +
        `  },`
    )
    .join("\n");

  return `// このファイルは自動生成です。手で書き換えないでください。
// 作り直す: node scripts/pendingChecks.mjs
// 元の文書: ${SOURCE}

/** 実機でまだ確かめていない機能の、1かたまり */
export interface PendingCheckSection {
  /** 確認リストの番号（"A-15"）。無い節は空文字 */
  id: string;
  /** 節の名前 */
  title: string;
  /** その節で確かめる操作。無い節（環境が要るものなど）は空 */
  commands: string[];
  /** まだ確かめていない項目 */
  items: string[];
}

/** まだ確かめていないもの。**${SOURCE} から機械的に作る** */
export const PENDING_CHECKS: readonly PendingCheckSection[] = [
${body}
];

/** 残っている項目の総数 */
export const PENDING_CHECK_TOTAL = ${total};
`;
}
