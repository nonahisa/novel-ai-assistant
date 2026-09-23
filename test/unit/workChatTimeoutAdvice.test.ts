import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { workChatTimeoutAdvice } from "../../src/features/workChatPanel";
import { maxTimeoutSeconds } from "../../src/core/modelTuning";

/**
 * 相談の時間切れの案内（ノートPCの実機、2026-09-23）。
 *
 * **上限の秒数は、そのAIの上限から出す**（作者の裁定、2026-09-23。残課題 A8）。
 * 手元のAIは1800秒まで延ばせるのに、決め打ちの600秒で「もう延ばせません」と
 * 言うと、作者は効く一手（延ばす）を知らないまま別のAIを探しに行く。
 */
describe("相談の時間切れの案内は、そのAIの上限で言う", () => {
  test("手元のAIが600秒で切れたなら、まだ延ばせると言う", () => {
    const text = workChatTimeoutAdvice({
      currentSeconds: 600,
      maxSeconds: maxTimeoutSeconds("ollama"),
      canRaise: true,
    });
    expect(text).toContain("延ば");
    expect(text).not.toContain("上限");
  });

  test("手元のAIが1800秒で切れたら、上限は1800秒と言う", () => {
    const text = workChatTimeoutAdvice({
      currentSeconds: 1800,
      maxSeconds: maxTimeoutSeconds("ollama"),
      canRaise: false,
      sentChars: 30000,
      historyChars: 0,
    });
    expect(text).toContain("上限（1800秒）");
    expect(text).not.toContain("600秒");
  });

  test("クラウドのAIは600秒で上限と言う（これまでどおり）", () => {
    const text = workChatTimeoutAdvice({
      currentSeconds: 600,
      maxSeconds: maxTimeoutSeconds("gemini"),
      canRaise: false,
    });
    expect(text).toContain("上限（600秒）");
  });

  /**
   * **呼び出し側が決め打ちの上限を渡していないこと。** 札（`timeoutAction`）と
   * 案内の両方が `maxTimeoutSeconds` を通らないと、札は1800秒を勧めるのに
   * 案内は600秒で「延ばせない」と言う食い違いになる。
   */
  test("相談パネルは、クラウドの上限の定数を直に読まない", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "features", "workChatPanel.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/\bMAX_TIMEOUT_SECONDS\b/);
    expect(source).toMatch(/maxTimeoutSeconds\(/);
  });
});
