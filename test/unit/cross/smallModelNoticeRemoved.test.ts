import { describe, expect, test } from "vitest";
import "../support/sweepTimeout";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 小さいモデルへの知らせを、自分からは出さない（作者の裁定 2026-10-10 朝、A11
 * 「やっぱこれも相談の時だけ答える形にしましょう」）。
 *
 * 0.101.0 で入れた2つ——検知の機能を動かす前の右下の通知と、機能別AI割当の
 * 選ぶ画面で小さいモデルの行に添える注意——を外した。測定の数字は相談パネルが
 * 訊かれたときだけ使う材料へ移した（`core/chatModelNotes.ts`）。
 * 外した部品の名前が `src/` へ戻ってこないことを見張る。
 */
const SRC = path.resolve(__dirname, "../../../src");
const BS = String.fromCharCode(92);

function sources(): { file: string; body: string }[] {
  const found: { file: string; body: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      found.push({
        file: path.relative(SRC, full).split(BS).join("/"),
        body: fs.readFileSync(full, "utf8"),
      });
    }
  };
  walk(SRC);
  return found;
}

describe("小さいモデルへの知らせを自分からは出さない（A11）", () => {
  test("知らせを出す部品のファイルが無い", () => {
    expect(fs.existsSync(path.join(SRC, "features", "smallModelNotice.ts"))).toBe(false);
    expect(fs.existsSync(path.join(SRC, "core", "smallModelNotice.ts"))).toBe(false);
  });

  test.each([
    // 右下の通知
    "noticeSmallModelOnce",
    "installSmallModelNoticeState",
    "SMALL_MODEL_NOTICE",
    // 選ぶ画面の注意
    "smallModelNote",
    "smallModelPickDetail",
    "SMALL_MODEL_PICK_NOTE",
  ])("src/ に %s が出てこない", (name) => {
    const offenders = sources()
      .filter(({ body }) => body.includes(name))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  test("選ぶ画面は、どの機能でもモデルの行の説明を同じに組む", () => {
    const assign = fs.readFileSync(path.join(SRC, "features", "assignFeatureAI.ts"), "utf8");
    expect(assign).toContain("pickProviderAndModel(registry)");
  });
});

/**
 * 機能別AI割当の誤字脱字・設定資料の抽出・伏線の行に出していた「向くモデル：
 * gemma4:26b 以上…」の案内と、割り当てたあとの知らせに添えていた理由も外した
 * （作者の裁定 2026-10-10「割当画面の案内も外してください」。A11 に揃える）。
 * 数字は相談の材料（`DETECTION_MODEL_NOTES`）にある。
 */
describe("機能別AI割当に、モデルの大きさの案内を出さない", () => {
  test.each([
    "TYPO_MODEL_ADVICE_SHORT",
    "EXTRACT_MODEL_ADVICE",
    "FORESHADOW_MODEL_ADVICE",
    "MODEL_SIZE_ADVICE",
    "MODEL_SIZE_REASON",
  ])("src/ に %s が出てこない", (name) => {
    const offenders = sources()
      .filter(({ body }) => body.includes(name))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  test("割当の画面は誤字脱字の長い案内も読まない", () => {
    const assign = fs.readFileSync(path.join(SRC, "features", "assignFeatureAI.ts"), "utf8");
    expect(assign).not.toContain("TYPO_MODEL_ADVICE");
    expect(assign).not.toContain("core/requirements");
    expect(assign).not.toContain("gemma4:26b");
  });
});

describe("残すもの", () => {
  test("誤字脱字の確認画面の、もっと大きいモデルの案内は残る", () => {
    const largerModel = fs.readFileSync(path.join(SRC, "core", "largerModelAdvice.ts"), "utf8");
    expect(largerModel.length).toBeGreaterThan(0);
  });

  test("Ollama の導入画面で e4b を勧めない言い方は残る", () => {
    const requirements = fs.readFileSync(path.join(SRC, "core", "requirements.ts"), "utf8");
    expect(requirements).toContain("CHAT_MODEL_IS_SMALL_NOTE");
    // 導入画面の誤字脱字の案内（モデルを取る前に言う）も残す
    const setup = fs.readFileSync(path.join(SRC, "features", "setupOllama.ts"), "utf8");
    expect(setup).toContain("CHAT_MODEL_IS_SMALL_NOTE");
    expect(setup).toContain("TYPO_MODEL_ADVICE");
  });

  test("MCP の頼み方の判定は製品の線（LARGE_MODEL_MIN_BILLIONS）のまま", () => {
    const capability = fs.readFileSync(path.join(SRC, "ai", "capability.ts"), "utf8");
    expect(capability).toContain("LARGE_MODEL_MIN_BILLIONS");
  });
});
