import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * 作品の種類を変えた直後に、状態バーの目安を出し直す（2026-10-04）。
 *
 * ノートPCの実機確認で、種類を「エッセイ・記事」に変えた直後は状態バーが
 * 「6字」のままで、カーソルを動かすか開き直すと「6字（読了 約1分）」になった。
 * `novelai.setWorkKind` の受け口が、一覧・原稿の下段・執筆統計は描き直すのに、
 * 状態バー（`charCountBar.refreshNow`）だけを呼んでいなかった。
 *
 * 受け口は `extension.ts` の中の無名関数で、単体では呼べないので、
 * 配線をソースから見張る（`episodePlotLinksWiring.test.ts` と同じ見張り方）。
 */

const ROOT = join(__dirname, "..", "..", "..");
const source = readFileSync(join(ROOT, "src", "extension.ts"), "utf8");

/** `registerCommand("novelai.setWorkKind", …)` の受け口の本体（次の registerCommand まで） */
function handlerBody(): string {
  const start = source.indexOf('"novelai.setWorkKind",');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("registerCommand(", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("作品の種類を変えたら、状態バーをすぐ描き直す", () => {
  test("種類を書き終えたあとで updateStatusBar を呼ぶ", () => {
    const body = handlerBody();
    const changedAt = body.indexOf("await setWorkKind(work)");
    const redrawAt = body.indexOf("updateStatusBar();");
    expect(changedAt).toBeGreaterThan(-1);
    // 書く前に呼ぶと、前の種類で数えてしまう
    expect(redrawAt).toBeGreaterThan(changedAt);
  });

  test("updateStatusBar は状態バーをすぐ数え直す口である", () => {
    // 打鍵の待ち（STATUS_BAR_TYPING_PAUSE_MS）を通る口だと、すぐには変わらない
    expect(source).toContain("const updateStatusBar = (): void => charCountBar.refreshNow();");
  });
});
