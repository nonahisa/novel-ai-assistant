import { beforeEach, describe, expect, test } from "vitest";
import { workspace } from "./support/vscodeStub";
import { logStep, setFallbackLogRoot, useLogFile } from "../../src/core/logger";

/**
 * 作品が決まらない処理のログを、どこへ置くか（作者の裁定、2026-09-19）。
 *
 * AIチューニングは**作品をまたぐ**——測るのはモデルの性質なので、どの
 * 作品を選んでも結果は同じである。それでも記録は要る。実機では書庫に
 * 作品が2つ以上あったため `logTargetWorkFolder` が書き先を決められず、
 * **12分かけて測った結果も、反映待ちで止まっていることも、どこにも
 * 残らなかった**（出力パネルはVS Codeを閉じると消える）。
 *
 * 置き場は**拡張機能の保管庫**にした。生成文書（`views/openDocument.ts`）
 * が「作品が分かるなら作品の下、分からないなら保管庫」としているのと
 * 同じ考え方で、作者に作品を選ばせない——答えが結果に影響しないのに
 * 手を止めさせることになる。
 */

/** 書き込まれた先と中身 */
let written: { path: string; text: string }[] = [];

beforeEach(() => {
  written = [];
  Object.assign(workspace, {
    fs: {
      createDirectory: async () => undefined,
      readFile: async () => {
        throw new Error("まだ無い");
      },
      writeFile: async (uri: { path?: string; fsPath?: string }, data: Uint8Array) => {
        written.push({
          path: uri.fsPath ?? uri.path ?? "",
          text: new TextDecoder().decode(data),
        });
      },
    },
  });
});

/**
 * 区切りとドライブ名の大小を揃える。
 * URIの作りで `C:` と `c:` が入れ替わるが、指す場所は同じである
 */
function logPath(raw: string): string {
  return raw.replace(/\\/g, "/").toLowerCase();
}

/** 書き込みは順番待ちの列に乗るので、1周待ってから読む */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("作品が決まらない処理のログの置き場", () => {
  test("作品が分かるときは、その作品の下へ書く", async () => {
    setFallbackLogRoot("C:/storage");
    useLogFile("C:/works/試しの作品");
    logStep("AIチューニング 開始");
    await settle();

    expect(written).toHaveLength(1);
    expect(logPath(written[0].path)).toBe(
      "c:/works/試しの作品/.aiwriter/logs/actions.log"
    );
    expect(written[0].text).toContain("AIチューニング 開始");
  });

  test("作品が決まらないときは、拡張機能の保管庫へ書く", async () => {
    setFallbackLogRoot("C:/storage");
    useLogFile(undefined);
    logStep("AIチューニング 終了");
    await settle();

    expect(written).toHaveLength(1);
    expect(logPath(written[0].path)).toBe(
      "c:/storage/.aiwriter/logs/actions.log"
    );
  });

  test("保管庫も分からないうちは、どこへも書かない", async () => {
    // 起動の途中で呼ばれたとき、**直前に触っていた作品のログへ紛れない**。
    // 作品をまたぐ処理の記録が、関係のない作品の記録に混ざるのを避ける
    setFallbackLogRoot("");
    useLogFile("C:/works/試しの作品");
    useLogFile(undefined);
    logStep("どこへも書かない");
    await settle();

    expect(written).toEqual([]);
  });
});
