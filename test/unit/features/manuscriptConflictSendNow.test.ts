import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 「重なった」と断った直後は、待たずに本文を画面へ送る（作者の裁定、2026-10-04。設計書6.25.9）。
 *
 * 本体は画面へ本文を送るとき、続けざまの変更をまとめるために120ミリ秒待つ（`scheduleSend`。
 * 続く変更で延びる）。断ったあともこの送りで返していたので、届く前に作者が［それでも戻す］を
 * 押すと、画面は古い本文を元にした便を送り、本体はもう一度「重なった」と断っていた。
 *
 * 源の形で見張る（`resolveCustomTextEditor` を代役で組むには依存が多すぎる。
 * `manuscriptSendOrder.test.ts`・`cross/manuscriptFollowsDisk.test.ts` と同じやり方）。
 * 画面の側（どちらの順で届いても戻す便の元が新しい本文になる）は
 * `views/manuscriptEditorUnsent.test.ts`、押して一度で通ることは E2E の
 * `manuscriptEditor.test.ts`「…同じ語の上へ打つと…」が見る。
 */
const source = readFileSync("src/features/manuscriptEditor.ts", "utf8");

function between(startMark: string, endMark: string): string {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + startMark.length);
  expect(start, `${startMark} が見つからない（形が変わったらこのテストを直す）`).toBeGreaterThan(-1);
  expect(end, `${endMark} が見つからない`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("断った直後の送り", () => {
  test("断った分岐は、まとめる送り（scheduleSend）でなく、いま送る（sendNow）を呼ぶ", () => {
    const branch = between('if (decision.kind === "conflict") {', 'return "conflict";');
    expect(branch).toContain("sendNow();");
    expect(branch).not.toContain("scheduleSend()");
  });

  test("sendNow は待っている便を取りやめ、時計を挟まずに send を呼ぶ", () => {
    const body = between("const sendNow = (): Promise<void> => {", "};");
    expect(body).toContain("clearTimeout(sendTimer)");
    expect(body).toContain("sendTimer = undefined");
    expect(body).toMatch(/return send\(\)/);
    // 待ってから送る形（setTimeout）を持ち込まない
    expect(body).not.toContain("setTimeout");
  });
});
