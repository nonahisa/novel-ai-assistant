import { describe, expect, it } from "vitest";
import {
  MANUSCRIPT_RESOLVE_GRACE_MS,
  confirmDisconnectedTabs,
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
