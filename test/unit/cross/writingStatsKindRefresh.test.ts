import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * 作品の種類を変えたら、開いている執筆統計も描き直す
 * （ブラウザ版の実機確認、2026-09-25）。
 *
 * エッセイに変えても、開いていた執筆統計には「目安」の列も「種類の目安」の
 * 札も出ず、タブを切り替えても変わらなかった。閉じて開き直すと出た。
 *
 * 画面の側（`renderEpisodes`）は届いた数字から列を組み直すので、足りなかった
 * のは**描き直しを頼む時機**だけである。0.86.3 で原稿エディターには同じ時機で
 * 種類を読み直させた（`manuscriptFootRefresh.test.ts`）が、執筆統計は漏れていた。
 * 種類は描き直しのたびに読み直している（`buildStatsPanelData` →
 * `readWorkKind`。変えた側が覚えを捨てる）ので、頼みさえすれば新しい種類で出る。
 *
 * コマンドの中身は `activate` の奥にあり、代役で組むには依存が多すぎるので、
 * 源の形で見張る（`manuscriptFootRefresh.test.ts` と同じ手）。
 */

const read = (file: string): string => readFileSync(file, "utf8");

/** 関数の頭から n 文字（その関数の中を見るため） */
function body(source: string, head: string, length: number): string {
  const at = source.indexOf(head);
  expect(at, `見つからない: ${head}`).toBeGreaterThanOrEqual(0);
  return source.slice(at, at + length);
}

describe("種類を変えたら、開いている執筆統計を描き直す", () => {
  test("種類を変えるコマンドは、変えたあとに執筆統計の描き直しを頼む", () => {
    const command = body(read("src/extension.ts"), '"novelai.setWorkKind"', 1800);
    // 次のコマンドの登録より手前だけを見る（隣のコマンドの呼び出しを数えない）
    const own = command.slice(0, command.indexOf("registerCommand(", 1));
    const changedAt = own.indexOf("setWorkKind(work)");
    expect(changedAt).toBeGreaterThanOrEqual(0);
    expect(own.indexOf("refreshWritingStatsPanel(work, deviceId)")).toBeGreaterThan(
      changedAt
    );
  });

  test("描き直しでは、そのたびに作品の種類を読み直す（開いたときの種類を持ち続けない）", () => {
    const panel = read("src/features/writingStatsPanel.ts");
    const refresh = body(panel, "export async function refreshWritingStatsPanel(", 600);
    expect(refresh).toContain("buildStatsPanelData(work, deviceId)");
    const build = body(panel, "async function buildStatsPanelData(", 2000);
    expect(build).toContain("kindOrUndefined(work)");
    const kind = body(panel, "async function kindOrUndefined(", 300);
    expect(kind).toContain("readWorkKind(work)");
  });
});
