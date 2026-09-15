import { describe, expect, it } from "vitest";
import {
  MANUSCRIPT_SIZE_DEFAULT,
  resolveInitialAppearance,
  takeCarriedAppearance,
} from "../../src/core/manuscriptAppearance";
import type { ManuscriptAppearance } from "../../src/core/manuscriptAppearance";
import { buildManuscriptEditorHtml } from "../../src/views/manuscriptEditorHtml";

/**
 * 原稿エディタの見た目の引き継ぎ（設計書6.25.5）。
 *
 * 作者の依頼（2026-09-12）は「前の話や次の話でファイル間を動いた場合、
 * 縦書き横書き、書体、倍率は元の設定に合わせて」。前後の話は**新しい画面**
 * を開くので、画面が覚えている値（`vscode.getState`）は引き継がれない。
 */

const carried: ManuscriptAppearance = {
  vertical: false,
  size: 20,
  compose: true,
};

describe("resolveInitialAppearance", () => {
  it("持って来た見た目は、その原稿が覚えていた値より強い", () => {
    // 前の話で横書き・20・組んで書くにして「次の話 →」を押した場面。
    // 次の話が縦書き・16を覚えていても、いま見ている見た目で開く
    expect(
      resolveInitialAppearance({
        saved: { vertical: true, size: 16, compose: false },
        carry: carried,
        verticalDefault: true,
      })
    ).toEqual({ vertical: false, size: 20, compose: true });
  });

  it("持って来た値が無ければ、その原稿が覚えていた値で開く", () => {
    expect(
      resolveInitialAppearance({
        saved: { vertical: false, size: 24, compose: false },
        verticalDefault: true,
      })
    ).toEqual({ vertical: false, size: 24, compose: false });
  });

  it("どちらも無ければ、設定の既定と初期値で開く", () => {
    expect(resolveInitialAppearance({ verticalDefault: true })).toEqual({
      vertical: true,
      size: MANUSCRIPT_SIZE_DEFAULT,
      // **組んで書くが標準**（作者の指定、2026-08-29）
      compose: true,
    });
    expect(resolveInitialAppearance({ verticalDefault: false })).toEqual({
      vertical: false,
      size: MANUSCRIPT_SIZE_DEFAULT,
      compose: true,
    });
  });

  /**
   * **0.63.1 まで、ここは逆だった**（入口 ＞ 引き継ぎ）。2026-09-15に直した。
   *
   * 「次の話 →」「最新話を書く」で開くときの入口は、**作者が選び直した
   * ものではない**——前のタブの viewType がそのまま渡るだけである。
   * 本文を開くときの既定は横書きの入口なので、**横書きで開いた原稿を
   * 「縦書きにする」で縦にしてから次へ進むと、毎回横書きに戻っていた**
   * （実機、2026-09-15。A-13の項目20）。
   *
   * メニューの「縦書きで開く」は引き継ぎを置かない（`vscode.openWith` を
   * 呼ぶだけ）ので、**引き継ぎが在る＝作者は入口を選び直していない**と読める。
   */
  it("持って来た向きは、受け継いだだけの入口より強い", () => {
    expect(
      resolveInitialAppearance({
        saved: { vertical: false, size: 16, compose: true },
        // 縦書きで見ていた原稿から「次の話 →」を押した
        carry: { vertical: true, size: 20, compose: false },
        // 受け継いだ入口は横書き（本文を開くときの既定）
        forceVertical: false,
        verticalDefault: false,
      })
    ).toEqual({ vertical: true, size: 20, compose: false });
  });

  it("持って来た向きが横書きなら、横書きのまま開く", () => {
    expect(
      resolveInitialAppearance({
        saved: { vertical: true, size: 16, compose: true },
        carry: { vertical: false, size: 20, compose: false },
        forceVertical: false,
        verticalDefault: true,
      })
    ).toEqual({ vertical: false, size: 20, compose: false });
  });

  it("引き継ぎが無いときは、入口が覚えていた値より強い", () => {
    // メニューで「原稿（横書）で開く」を選んだとき。ここは変えていない
    expect(
      resolveInitialAppearance({
        saved: { vertical: true, size: 16, compose: true },
        forceVertical: false,
        verticalDefault: true,
      })
    ).toEqual({ vertical: false, size: 16, compose: true });
  });

  it("古い覚えに欠けがあっても、欠けたところだけ既定で埋める", () => {
    expect(
      resolveInitialAppearance({ saved: { size: 18 }, verticalDefault: true })
    ).toEqual({ vertical: true, size: 18, compose: true });
  });

  it("画面が扱えない大きさは畳む", () => {
    expect(
      resolveInitialAppearance({ saved: { size: 400 }, verticalDefault: true })
        .size
    ).toBe(40);
    expect(
      resolveInitialAppearance({ saved: { size: 1 }, verticalDefault: true })
        .size
    ).toBe(9);
    expect(
      resolveInitialAppearance({
        saved: { size: Number.NaN },
        verticalDefault: true,
      }).size
    ).toBe(MANUSCRIPT_SIZE_DEFAULT);
  });
});

describe("takeCarriedAppearance", () => {
  it("取り出せるのは1回だけ（2回目は無い）", () => {
    const pending = new Map<string, ManuscriptAppearance>([
      ["c:/works/002.md", carried],
    ]);
    expect(takeCarriedAppearance(pending, "c:/works/002.md")).toEqual(carried);
    // 置きっぱなしにすると、あとでふつうに開いたときに古い見た目が蘇り、
    // その原稿が覚えている値を黙って押し流す
    expect(takeCarriedAppearance(pending, "c:/works/002.md")).toBeUndefined();
    expect(pending.size).toBe(0);
  });

  it("置かれていない原稿では何も返さない", () => {
    const pending = new Map<string, ManuscriptAppearance>();
    expect(takeCarriedAppearance(pending, "c:/works/001.md")).toBeUndefined();
  });
});

describe("画面と拡張機能の結び", () => {
  const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");

  it("画面は、覚えていた値を添えて名乗る", () => {
    // これが欠けると、拡張機能側は覚えていた値を知らずに既定で決めてしまう
    expect(html).toContain('{ type: "ready", saved: saved }');
  });

  it("画面は、見た目が変わるたびに知らせる", () => {
    expect(html).toContain('type: "appearance"');
  });

  it("画面は、決まった見た目を受け取って当てる", () => {
    expect(html).toContain("message.initialAppearance");
  });

  it("画面は、見た目の決め方を写し持たない", () => {
    /*
      **規則は core/manuscriptAppearance.ts ただ1か所**（写しを置かない。
      termColors.ts と同じ考え方）。0.47.9 より前は、入口の向きと設定の
      既定を突き合わせる規則が画面側にもあった。
    */
    expect(html).not.toContain("verticalDefault");
    expect(html).not.toContain("forceVertical");
  });
});
