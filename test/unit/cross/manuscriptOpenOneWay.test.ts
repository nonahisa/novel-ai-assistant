import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * 原稿を開く道は1本（作者の裁定、2026-10-03「直す」。設計書6.25.11）。
 *
 * 作品一覧・前後の話・最新話・話の新規作成・統計の行・読み上げ・行へ飛ぶ
 * ——どこから開いても、**同じ原稿のタブが既にあれば、そのタブの入口と列で
 * 開く**（2枚目を作らない）。その判断は `features/manuscriptTab.ts` の
 * `openManuscriptFile` にしか無い。
 *
 * 道ごとに代役を組むと依存が重すぎるので、**`vscode.openWith` を直に呼ぶ所を
 * ソースから数える。** 新しい開き方を足したとき、共通の口を通さずに書くと
 * ここで落ちる。
 *
 * ## 直に呼んでよい所
 *
 * - 共通の口そのもの
 * - 打った字が入らない画面の開き直し（`reopenForRescue`）——**同じタブを閉じて
 *   から**開くので、2枚目にならない。閉じた面の入口で開き直すのが目的である
 */
const SRC = join(__dirname, "../../../src");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      // 統合テストは VS Code の実物を相手にするので、数えない
      if (relative(SRC, full) === "test") continue;
      found.push(...sourceFiles(full));
    } else if (name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** その関数の本体（`marker` から始まる最初の波括弧の組） */
function bodyOf(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) return "";
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return "";
}

describe("原稿を開く道は1本", () => {
  test("`vscode.openWith` を直に呼ぶのは、共通の口と開き直しだけ", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const name = relative(SRC, file).split(sep).join("/");
      let source = withoutComments(readFileSync(file, "utf8"));
      if (name === "features/manuscriptTab.ts") continue;
      if (name === "features/manuscriptEditor.ts") {
        source = source.replace(bodyOf(source, "private async reopenForRescue("), "");
      }
      const count = source.split('"vscode.openWith"').length - 1;
      if (count > 0) offenders.push(`${name}（${count}か所）`);
    }
    expect(offenders).toEqual([]);
  });

  test("作品一覧の話の行は、共通の口を通すコマンドを使う", () => {
    const tree = withoutComments(readFileSync(join(SRC, "views/workTree.ts"), "utf8"));
    expect(tree).toContain('command: "novelai.openEpisode"');

    const extension = readFileSync(join(SRC, "extension.ts"), "utf8");
    const at = extension.search(/registerCommand\(\s*"novelai\.openEpisode"/);
    expect(at).toBeGreaterThan(-1);
    const command = bodyOf(extension.slice(at), "registerCommand(");
    expect(command).toContain("openManuscriptFile(");
  });

  /*
    新しく作った話を開く入口は、作品の種類で決める（設計書6.70。台本は縦書き）。
    `novelai.insertEpisodeBefore` だけが横書きの入口に決め打ちしていた
    （0.96.10 の担当の懸念）。`addEpisode` と同じ決め方に揃っていることを見る。
  */
  test.each(["novelai.addEpisode", "novelai.insertEpisodeBefore"])(
    "%s は、新しい話を作品の種類で決まる入口で開く",
    (commandId) => {
      const extension = withoutComments(readFileSync(join(SRC, "extension.ts"), "utf8"));
      const at = extension.search(
        new RegExp(`registerCommand\\(\\s*"${commandId.replace(/\./g, "\\.")}"`)
      );
      expect(at).toBeGreaterThan(-1);
      const command = bodyOf(extension.slice(at), "registerCommand(");
      expect(command).toContain("openManuscriptFile(");
      expect(command).toContain("manuscriptViewTypeFor(");
      expect(command).not.toContain("MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE");
    }
  );

  /*
    前に出すだけで済んだ（新しい面ができなかった）ときに、置いた見た目を
    取り残さない（設計書6.25.11）。始末の規則は core 側の純関数で確かめ、
    ここでは「前後の話へ移る道が、前に出したときにその始末を呼ぶ」ことを見る。
  */
  test("前後の話へ移る道は、前に出しただけのとき置いた見た目を始末する", () => {
    const editor = withoutComments(
      readFileSync(join(SRC, "features/manuscriptEditor.ts"), "utf8")
    );
    const body = bodyOf(editor, "private async openAsManuscript(");
    expect(body).toContain(".reused");
    expect(body).toContain("this.settleCarried(");
    const settle = bodyOf(editor, "private async settleCarried(");
    // 台帳に載るのを待ってから始末する（すぐ消すと、立ち上がりかけの画面の引き継ぎが落ちる）
    expect(settle).toContain("waitFor(");
    expect(settle).toContain("settleCarriedAppearance(");
  });
});
