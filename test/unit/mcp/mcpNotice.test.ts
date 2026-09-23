import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { novelNotice } from "../../../src/mcp/tools/notice";
import { assertExternalAccessAllowed } from "../../../src/mcp/tools/permission";
import { setExternalClientName } from "../../../src/mcp/tools/accessLog";
import { LARGE_MODEL_MIN_BILLIONS } from "../../../src/ai/types";

/**
 * 実行前に出る「断り」を、**画面を押さずに読む**（`novel.notice`、0.72.0）。
 *
 * ## なぜこの検査が要るか
 *
 * 矛盾検知の確認画面に出る断りは、**モデルの大きさで切り替わる**
 * （設計書6.10.8。20B以上ならゆるめ、20B未満なら抑える）。いちばん新しい
 * 仕組みの出口なのに、**読むには画面を押すしかなかった**——実機確認の
 * 手だての順（ファイル → テスト → MCP → computer-use → 作者）でいちばん
 * 高いところにしか無かったということである。
 *
 * ここで見張るのは5つ。
 *
 * 1. 大きいモデルでは「挙げます」、小さいモデルでは「指摘しません」
 * 2. **プロット逸脱では、抑制の断りを返さない**（あの機能に抑制は無い）
 * 3. 申告が取れないときの落とし先（手元は抑える側・クラウドはゆるめる側）
 * 4. **大きさだけ渡されたら、製品と同じように階級を導く**（0.72.1）
 * 5. **許可の無い作品では断る**（ほかの道具とまったく同じ関門を通る）
 */

const FOLDER = "C:/どこか/作品";

function notice(
  overrides: Partial<Parameters<typeof novelNotice>[0]> = {}
): ReturnType<typeof novelNotice> {
  return novelNotice({
    folder: FOLDER,
    feature: "contradiction",
    providerId: "sakura",
    model: "preview/gemma-4-31B-it",
    parameterSize: "31.0B",
    ...overrides,
  });
}

describe("矛盾検知の断りは、モデルの大きさで切り替わる", () => {
  it("20B以上なら、確信が持てない箇所も挙げると断る", () => {
    const result = notice({ parameterSize: "25.2B" });

    expect(result.forAuthor).toContain("確信が持てない箇所も挙げます");
    expect(result.forAuthor).not.toContain("指摘しません");
    expect(result.profile.suppressUncertainContradictions).toBe(false);
  });

  it("20B未満なら、確信の持てない箇所は指摘しないと断る", () => {
    const result = notice({ parameterSize: "12B" });

    expect(result.forAuthor).toContain("確信の持てない箇所は指摘しません");
    expect(result.forAuthor).not.toContain("確信が持てない箇所も挙げます");
    expect(result.profile.suppressUncertainContradictions).toBe(true);
  });

  it("ちょうど20Bは、大きい側（ゆるめる）", () => {
    // 境目を跨いだときに、どちらへ倒れるかは文面が変わる分かれ目である
    expect(notice({ parameterSize: "20B" }).forAuthor).toContain(
      "確信が持てない箇所も挙げます"
    );
  });

  it("ログ向けの一言にも、抑えたことが出る", () => {
    // **画面とログで食い違わせない**（`ai/capability.ts` の断り書き）
    const small = notice({ parameterSize: "12B", tier: "standard" });

    expect(small.forLog).toContain("確信の持てない指摘は抑える");
    expect(notice({ parameterSize: "31.0B", tier: "high" }).forLog).not.toContain(
      "確信の持てない指摘は抑える"
    );
  });
});

describe("プロット逸脱では、抑制の断りを返さない", () => {
  it("作者向けの断りは空になる", () => {
    // 抑制は矛盾検知にしか無い。ここに文が出たら、**ありもしない仕組みを
    // 名乗っている**ことになる
    expect(
      notice({ feature: "deviation", parameterSize: "12B" }).forAuthor
    ).toBe("");
    expect(
      notice({ feature: "deviation", parameterSize: "31.0B" }).forAuthor
    ).toBe("");
  });

  it("ログ向けの一言にも、抑制は出ない", () => {
    const result = notice({
      feature: "deviation",
      parameterSize: "12B",
      tier: "light",
    });

    expect(result.forLog).not.toContain("確信の持てない指摘は抑える");
    // 逸脱で立つ札のほうは、ちゃんと立っている
    expect(result.profile.narrowDeviationTypes).toBe(true);
    expect(result.profile.warnDeviationIneffective).toBe(true);
  });
});

describe("申告が取れないときの落とし先", () => {
  it("手元のAIで大きさが分からなければ、抑える側", () => {
    // 分からないのに大きいとみなすと、**モデル情報が取れなかった日だけ
    // 誤検出が増える**（`ai/capability.ts`）
    expect(
      notice({ providerId: "ollama", parameterSize: undefined }).forAuthor
    ).toContain("指摘しません");
  });

  it("クラウドで大きさが分からなければ、ゆるめる側", () => {
    expect(
      notice({ providerId: "claude", parameterSize: undefined }).forAuthor
    ).toContain("確信が持てない箇所も挙げます");
  });

  it("階級も大きさも取れなければ、ollama だけを軽量とみなす", () => {
    // **手掛かりが1つも無いとき**の落とし先。`inferTier` は大きさが読めない
    // ollama を light、それ以外を high とするので、従来の判定と同じになる
    expect(
      notice({ providerId: "ollama", tier: undefined, parameterSize: undefined })
        .profile.narrowContradictionCategories
    ).toBe(true);
    expect(
      notice({ providerId: "sakura", tier: undefined, parameterSize: undefined })
        .profile.narrowContradictionCategories
    ).toBe(false);
  });
});

/**
 * **階級を渡さず大きさだけ渡したときの穴**（0.72.1）。
 *
 * 製品はモデル情報を作る時点で `inferTier` を通すので、階級は必ず付いている
 * （`ai/ollamaProvider.ts` ほか）。ところがこの道具は渡された `tier` を
 * そのまま使っていたため、**大きさだけ渡すと「地力は不明」に落ちて、製品なら
 * 立たない絞りが立った**——`gemma4:26b`（25.2B）で「観点を絞る」と返る。
 *
 * これは**呼ぶ側に `inferTier` の規則の写しを強いる**形で、写しは必ず古くなる。
 * 実際に 2026-09-21 に取り違えが起きた。**境目はここでも直書きしない**
 * （`LARGE_MODEL_MIN_BILLIONS` から組み立てる）。
 */
describe("階級が渡されなければ、大きさから導く", () => {
  /** 境目ちょうど（大きい側） */
  const AT_BORDER = `${LARGE_MODEL_MIN_BILLIONS}B`;
  /** 境目の手前（小さい側）。0.1B だけ足りない */
  const BELOW_BORDER = `${LARGE_MODEL_MIN_BILLIONS - 0.1}B`;

  it("大きさだけ渡せば、製品と同じく高性能とみなす（絞らない）", () => {
    // これが今回の穴そのもの。25.2B は `gemma4:26b` が Ollama へ申告する値
    const result = notice({ providerId: "ollama", parameterSize: "25.2B" });

    // **穴そのものを先に見る**——直す前はここが「地力は不明・観点を絞る」だった
    expect(result.profile.narrowContradictionCategories).toBe(false);
    expect(result.forLog).toBe("高性能");
    expect(result.tier).toBe("high");
  });

  it("境目ちょうども、高性能側へ倒れる", () => {
    expect(notice({ providerId: "ollama", parameterSize: AT_BORDER }).tier).toBe(
      "high"
    );
  });

  it("境目の手前なら標準で、絞りも抑制も立つ", () => {
    const result = notice({
      providerId: "ollama",
      parameterSize: BELOW_BORDER,
    });

    expect(result.tier).toBe("standard");
    expect(result.profile.narrowContradictionCategories).toBe(true);
    expect(result.profile.suppressUncertainContradictions).toBe(true);
  });

  it("階級を明示したら、そちらが勝つ", () => {
    // 作り物の組み合わせ（大きいのに標準、など）を試せる余地は残す
    const result = notice({
      providerId: "ollama",
      parameterSize: "25.2B",
      tier: "standard",
    });

    expect(result.tier).toBe("standard");
    expect(result.profile.narrowContradictionCategories).toBe(true);
  });

  it("導いたのか渡されたのかが、返り値から分かる", () => {
    // **どちらで動いたか分からないまま結果だけ見ると、また取り違える**
    expect(notice({ providerId: "ollama", parameterSize: "25.2B" }).tierSource).toBe(
      "inferred"
    );
    expect(
      notice({ providerId: "ollama", parameterSize: "25.2B", tier: "high" })
        .tierSource
    ).toBe("given");
    // 手掛かりが何も無くても、導いた結果は返す（「不明」を返り値に残さない）
    expect(
      notice({ providerId: "ollama", parameterSize: undefined }).tierSource
    ).toBe("inferred");
  });
});

describe("要る申告が無ければ断る", () => {
  it("model が空なら断る（断りはモデルごとに変わる）", () => {
    expect(() => notice({ model: "   " })).toThrow(/model が要ります/);
  });

  it("folder が空なら断る（許可を確かめる先が無い）", () => {
    expect(() => notice({ folder: "" })).toThrow(/folder が要ります/);
  });
});

describe("許可の関門は、ほかの道具と同じ", () => {
  const temporary: string[] = [];

  afterEach(() => {
    setExternalClientName("");
    for (const folder of temporary.splice(0)) {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  /** 印を置いた（あるいは置かない）作品を、一時に作る */
  function work(permission?: unknown): string {
    const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-notice-"));
    if (permission !== undefined) {
      fs.mkdirSync(nodePath.join(folder, ".aiwriter"), { recursive: true });
      fs.writeFileSync(
        nodePath.join(folder, ".aiwriter", "external-access.json"),
        JSON.stringify(permission),
        "utf8"
      );
    }
    temporary.push(folder);
    return folder;
  }

  function allowing(client: string, tools: string[]): Record<string, unknown> {
    return {
      clients: [
        {
          name: client,
          tools,
          sampling: false,
          decidedAt: "2026-09-21T00:00:00.000Z",
          decidedOn: "テスト",
          note: "",
        },
      ],
    };
  }

  it("印の無い作品では断る", () => {
    setExternalClientName("Claude Code");
    const folder = work();

    expect(() =>
      assertExternalAccessAllowed(
        { folder, feature: "contradiction" },
        "novel.notice"
      )
    ).toThrow();
  });

  it("**ほかの機能を許していても、この機能は別に要る**", () => {
    setExternalClientName("Claude Code");
    const folder = work(allowing("Claude Code", ["deviation"]));

    expect(() =>
      assertExternalAccessAllowed(
        { folder, feature: "contradiction" },
        "novel.notice"
      )
    ).toThrow();
    // 許してあるほうは通る
    expect(() =>
      assertExternalAccessAllowed(
        { folder, feature: "deviation" },
        "novel.notice"
      )
    ).not.toThrow();
  });
});
