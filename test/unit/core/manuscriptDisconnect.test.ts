import { describe, expect, it } from "vitest";
import {
  MANUSCRIPT_RESOLVE_GRACE_MS,
  confirmDisconnectedTabs,
  sameManuscriptFaceNote,
  unresolvedActiveTabs,
  type ManuscriptTabLook,
} from "../../../src/core/manuscriptDisconnect";

/**
 * 拡張機能ホストが起動し直したあと、つながりの切れた原稿エディターを見つける
 * （作者の裁定、2026-10-02「起動し直したら、開いていた原稿エディターを開き直す」）。
 *
 * 背景：2026-10-02 21:34 机のPCで、Marketplace の自動更新が拡張機能ホストを
 * 起動し直した。開いていた原稿エディターは新しい拡張機能へつながらず、
 * 打った字が文書へ届かなかった（画面に「送り直しています」の赤字）。
 *
 * 見張りたいのは、**出すべきときに出す**ことと、**ふつうに開いたときに出さない**こと。
 */

const tab = (key: string, active: boolean): ManuscriptTabLook => ({ key, active });

describe("unresolvedActiveTabs（1回目に見る）", () => {
  it("前に出ていて、つながっていないタブを拾う", () => {
    expect(unresolvedActiveTabs([tab("a", true)], new Set())).toEqual(["a"]);
  });

  it("背景のタブは拾わない（VS Code は前に出すまでつながない）", () => {
    // ふつうにウィンドウを開いたとき、背景のタブはまだ作られていない
    expect(unresolvedActiveTabs([tab("a", false)], new Set())).toEqual([]);
  });

  it("つながっているタブは拾わない", () => {
    expect(unresolvedActiveTabs([tab("a", true)], new Set(["a"]))).toEqual([]);
  });

  it("同じ原稿が2つのグループで前に出ていても1つにまとめる", () => {
    expect(
      unresolvedActiveTabs([tab("a", true), tab("a", true)], new Set())
    ).toEqual(["a"]);
  });
});

describe("confirmDisconnectedTabs（猶予のあとにもう一度見る）", () => {
  it("両方の時点でつながっていなければ、切れたと見る", () => {
    expect(
      confirmDisconnectedTabs({
        earlier: ["a"],
        tabs: [tab("a", true)],
        resolved: new Set(),
        warned: new Set(),
      })
    ).toEqual(["a"]);
  });

  it("猶予のあいだにつながったら出さない（開いた直後のつながりが遅いとき）", () => {
    expect(
      confirmDisconnectedTabs({
        earlier: ["a"],
        tabs: [tab("a", true)],
        resolved: new Set(["a"]),
        warned: new Set(),
      })
    ).toEqual([]);
  });

  it("1回目に見ていないタブは、2回目だけで切れたと見ない", () => {
    expect(
      confirmDisconnectedTabs({
        earlier: [],
        tabs: [tab("b", true)],
        resolved: new Set(),
        warned: new Set(),
      })
    ).toEqual([]);
  });

  it("猶予のあいだに背景へ回った・閉じたタブは出さない", () => {
    expect(
      confirmDisconnectedTabs({
        earlier: ["a", "b"],
        tabs: [tab("a", false)],
        resolved: new Set(),
        warned: new Set(),
      })
    ).toEqual([]);
  });

  it("一度知らせたタブは繰り返さない", () => {
    expect(
      confirmDisconnectedTabs({
        earlier: ["a", "b"],
        tabs: [tab("a", true), tab("b", true)],
        resolved: new Set(),
        warned: new Set(["a"]),
      })
    ).toEqual(["b"]);
  });

  it("ふつうに開いたとき（どのタブもつながる）は何も出さない", () => {
    const tabs = [tab("a", true), tab("b", false), tab("c", true)];
    const resolved = new Set(["a", "c"]);
    const earlier = unresolvedActiveTabs(tabs, resolved);
    expect(
      confirmDisconnectedTabs({ earlier, tabs, resolved, warned: new Set() })
    ).toEqual([]);
  });
});

describe("猶予の長さ", () => {
  it("開いた直後のつながりの遅れを覆えるだけの長さがある（5秒以上）", () => {
    expect(MANUSCRIPT_RESOLVE_GRACE_MS).toBeGreaterThanOrEqual(5000);
  });
});

/**
 * 同じ原稿の面がもう1枚つながったときの記録（作者の実機、2026-10-03。設計書6.25.11）。
 *
 * 0.96.7 の記録は台帳の数だけを見ていた。拡張機能ホストを起動し直したあとは
 * 台帳が空なので、切れた面の隣に同じ原稿の面がつながっても1枚目と数え、
 * 何も残らなかった（2枚目の行は、ウィンドウを再読み込みしたときに初めて出た）。
 * **タブの数でも見る。**
 */
describe("sameManuscriptFaceNote（同じ原稿の面の記録）", () => {
  const base = { viewType: "novelai.manuscriptEditorHorizontal", column: 2 };

  it("台帳に1枚あれば、2枚目として残す（これまでどおり）", () => {
    const note = sameManuscriptFaceNote({ ...base, ledgerFaces: 1, tabColumns: [1, 2] });
    expect(note).toContain("同じ原稿の面がもう1枚開かれました（2枚目");
    expect(note).toContain("列: 2");
  });

  it("起動し直したあと（台帳は空、タブは2枚）も残す", () => {
    const note = sameManuscriptFaceNote({ ...base, ledgerFaces: 0, tabColumns: [1, 2] });
    expect(note).toBeDefined();
    expect(note).toContain("タブ2枚");
    expect(note).toContain("列: 1・2");
    expect(note).toContain("つながっていない面が1枚");
  });

  it("その原稿のタブが自分だけなら、何も残さない", () => {
    expect(
      sameManuscriptFaceNote({ ...base, ledgerFaces: 0, tabColumns: [2] })
    ).toBeUndefined();
  });

  it("タブを読めない環境（列が空）でも、台帳が空なら何も残さない", () => {
    expect(
      sameManuscriptFaceNote({ ...base, ledgerFaces: 0, tabColumns: [] })
    ).toBeUndefined();
  });

  it("列が分からないときは「不明」と書く", () => {
    const note = sameManuscriptFaceNote({
      ...base,
      column: undefined,
      ledgerFaces: 1,
      tabColumns: [],
    });
    expect(note).toContain("列: 不明");
  });
});
