import { describe, expect, test } from "vitest";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";

/**
 * 執筆量パネルの応募先の欄に、**いつの情報か**（「9月23日時点の情報」）を添える
 * （設計書6.3.6.1。実機確認リスト 0.80.0）。
 *
 * 募集は書き換わるので、公募の一覧から入れた応募先には取り込んだ日を出し、
 * 応募の前に募集要項で確かめるよう促す。手で入れた応募先には出さない。
 *
 * WebView のスクリプトは文字列として埋め込まれているので、描く関数を切り出して
 * 作り物の document の上で動かす（`writingStatsPanelBars.test.ts` と同じ手）。
 */

const html = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:");
const script = (() => {
  const found = html.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
})();

/** スクリプトの最上位にある関数を1つ切り出す（字下げの無い `}` で終わる） */
function functionSource(name: string): string {
  const start = script.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`関数 ${name} が見つかりません`);
  const end = script.indexOf("\n}\n", start);
  return script.slice(start, end + 3);
}

/** 応募先の欄を描いて、できた HTML を返す */
function renderContest(contest: Record<string, unknown>): string {
  const box = { innerHTML: "", querySelectorAll: () => [] as unknown[] };
  const fakeDocument = {
    getElementById: (id: string) => (id === "contest" ? box : null),
  };
  const run = new Function(
    "document",
    "state",
    "vscode",
    [
      functionSource("escapeHtml"),
      functionSource("formatCount"),
      functionSource("renderContest"),
      "renderContest();",
    ].join("\n")
  );
  run(fakeDocument, { contest }, { postMessage: () => undefined });
  return box.innerHTML;
}

const BASE = {
  headline: "締切まであと38日です。",
  name: "第3回 みずうみ文学賞",
  url: "https://example.com/mizuumi",
  deadline: "2026-10-31",
  daysLeft: 38,
  overdue: false,
  overMax: false,
  written: 12000,
  targetChars: 20000,
  remainingChars: 8000,
  neededPerDay: 211,
};

describe("応募先の欄の「いつの情報か」", () => {
  test("公募の一覧から入れた応募先には、取り込んだ日と確かめる促しを出す", () => {
    const shown = renderContest({ ...BASE, asOf: "9月23日時点の情報" });
    expect(shown).toContain("9月23日時点の情報（応募の前に募集要項で確かめてください）");
    expect(shown).toContain("募集要項を開く");
  });

  test("手で入れた応募先（取り込んだ日が無い）には出さない", () => {
    const shown = renderContest({ ...BASE, asOf: null });
    expect(shown).not.toContain("時点の情報");
    expect(shown).not.toContain("応募の前に募集要項で確かめてください");
  });
});
