import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 拡張機能が起動する口（`package.json` の `activationEvents`）を見張る。
 *
 * 背景（2026-10-10 13:28 作者の VS Code・0.101.8）：ほかの拡張機能の自動更新で
 * 拡張機能ホストが起動し直した。原稿エディターのタブは後ろにあり、作者が前に出して
 * 打つと画面には「打った字が原稿に入りません」の赤字が出たが、［ウィンドウを
 * 再読み込み］のモーダルは出なかった。拡張機能ホストのログでは、新しいホストで
 * この拡張機能が**一度も起動していなかった**（13:53 に Markdown の拡張機能から
 * 呼ばれるまで25分）。見張り（`watchDisconnectedManuscripts`）は `activate` の中で
 * 登録するので、起動しなければ働かない。
 *
 * 後ろにあった原稿エディターは古い画面が残っている（`retainContextWhenHidden`）ので、
 * 前に出しても `resolveCustomTextEditor` は呼ばれず、`onCustomEditor` の口も開かない。
 * 起動し直したホストが前のホストで開いた口を開き直すとは限らない（13:28 は開き直さず、
 * 10:54 に働いたのは相談パネルが見えていて `onView` が開いたから）。
 * 起動し直しのたびに必ず開く口は `onStartupFinished` だけなので、それを持つ。
 * 設計書6.25.9。
 */
const PACKAGE_JSON = path.resolve(__dirname, "../../../package.json");

describe("起動の口", () => {
  it("拡張機能ホストが起動し直したあと、原稿エディターに触れなくても起動する（onStartupFinished）", () => {
    const manifest = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8")) as {
      activationEvents?: string[];
    };
    expect(
      manifest.activationEvents ?? [],
      "起動し直したあとに起動しないと、つながりの切れた原稿エディターの見張りが働きません"
    ).toContain("onStartupFinished");
  });
});
