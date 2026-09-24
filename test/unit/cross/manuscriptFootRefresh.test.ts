import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * 開いている原稿エディターの下段を、いつ描き直すか
 * （ノートPCの実機確認、2026-09-25）。
 *
 * ## 種類を変えた直後に、読了の目安が出ない
 *
 * エッセイに変えても、開いていた原稿の下段には「読了 約N分」が出ず、
 * 別の話へ移ると出た。下段の目安は、画面を開いたときに読んだ種類で
 * 測り続けていたため（開いている間は種類を読み直さない）。
 *
 * ## 一言が第1話には出て、第2話には出なかった
 *
 * 一言（「今日の目標に届きました」）を決めるのは `footCheer` で、**どの話かは
 * 見ていない**（1日・1月の達成は全作品で共有、作品の達成はその作品の原稿で）。
 * 同じ日・同じ作品なら、どの話にも出るのが正しい。
 *
 * 出なかったのは描き直しの時機の問題である。下段（字数・今日・一言）を
 * 測り直すのは「開いたとき」と「**その原稿を**保存したとき」だけで、
 * **先に開いてあった別の話の画面は、達成の前の下段のまま**残っていた。
 * タブを切り替えて前へ出しても本文を送り直すだけで、下段は測り直さない。
 *
 * どちらも `resolveCustomTextEditor` の中にあり、代役で組むには依存が
 * 多すぎるので、源の形で見張る（`manuscriptFollowsDisk.test.ts` と同じ手）。
 */

const read = (file: string): string => readFileSync(file, "utf8");

/** 関数の頭から n 文字（その関数の中を見るため） */
function body(source: string, head: string, length: number): string {
  const at = source.indexOf(head);
  expect(at, `見つからない: ${head}`).toBeGreaterThanOrEqual(0);
  return source.slice(at, at + length);
}

describe("種類を変えたら、開いている原稿の下段を描き直す", () => {
  const editor = () => read("src/features/manuscriptEditor.ts");

  test("種類を変えるコマンドは、変えたあとに開いている原稿の種類を読み直させる", () => {
    const command = body(read("src/extension.ts"), '"novelai.setWorkKind"', 1400);
    expect(command.indexOf("refreshManuscriptKinds(")).toBeGreaterThan(
      command.indexOf("setWorkKind(work)")
    );
  });

  test("開いている原稿の台帳から、種類の読み直しを頼む口がある", () => {
    const refresh = body(editor(), "export async function refreshManuscriptKinds(", 600);
    expect(refresh).toContain("openManuscripts");
    expect(refresh).toContain(".refreshKind()");
  });

  test("読み直した種類で、下段の字数と目安を送り直す", () => {
    const resolve = body(editor(), "async resolveCustomTextEditor(", 40000);
    const entry = body(resolve, "refreshKind:", 900);
    expect(entry).toContain("this.kindOfDocument(document)");
    expect(entry).toContain("this.sendCount(");
    // 画面から届く「数えて」も、読み直した種類で測る（開いたときの種類に戻らない）
    const count = body(resolve, 'case "count":', 300);
    expect(count).toContain("measureKind");
  });
});

describe("達成の一言を、開いている原稿すべてに行き渡らせる", () => {
  test("保存で達成が増えたら、開いている原稿すべての下段を測り直す", () => {
    const record = body(
      read("src/extension.ts"),
      "async function recordWritingProgress(",
      2400
    );
    expect(record).toContain("celebrations.afterSave(work, outcome)");
    expect(record).toContain("refreshAllManuscriptCounts()");
    // 保存した原稿そのものは、達成が無くても測り直す（これまでどおり）
    expect(record).toContain("refreshManuscriptCounts(filePath)");
  });

  test("開いている原稿すべての下段を測り直す口がある", () => {
    const refresh = body(
      read("src/features/manuscriptEditor.ts"),
      "export function refreshAllManuscriptCounts(",
      600
    );
    expect(refresh).toContain("openManuscripts");
    expect(refresh).toContain(".refreshCounts()");
  });

  test("タブを切り替えて前へ出たら、下段も測り直す（日が替わった一言も消える）", () => {
    const editor = read("src/features/manuscriptEditor.ts");
    const view = body(editor, "panel.onDidChangeViewState(", 900);
    expect(view).toMatch(/if \(event\.webviewPanel\.visible\) \{[\s\S]*?void send\(\);[\s\S]*?void this\.sendFootCounts\(panel, document\);/);
  });
});
