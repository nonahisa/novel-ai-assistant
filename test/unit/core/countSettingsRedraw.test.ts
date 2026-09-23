import { describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import { needsRedraw, needsRescan } from "../../../src/core/countSettings";

/**
 * 数え方の設定を変えた「その場」で反映されるかの見張り。
 *
 * 実機確認リストの「設定を変えた瞬間に反映されるか（ファイルを開き直さなくて
 * よいか）」を、機械の側から留める。**受け口（`extension.ts` の
 * `onDidChangeConfiguration`）は在ることを目で確かめられるが、
 * 「どの設定を拾うか」はこの2つの関数が決めている**——ここに設定名を
 * 足し忘れると、画面は静かに古い数字のままになる（2026-08-21 に一度
 * 踏んだ不具合そのもの）。
 *
 * **数え直しと描き直しの区別も留める。** ルビの扱いは走査のときに効くので
 * 読み直しが要り、純／総の切り替えは両方を数えてあるので描き直すだけでよい。
 * 取り違えると、ルビを切り替えても字数が変わらない（あるいは、純／総を
 * 変えるたびに全ファイルを読み直して遅くなる）。
 *
 * 2026-09-21 追加。
 */

/**
 * `ConfigurationChangeEvent` の作り物。
 *
 * 本物は VS Code が作るので、**変わった設定名を1つ持つだけ**の形に絞る。
 * `affectsConfiguration` は前方一致でも真を返すが、ここで見たいのは
 * 「どの名前を拾うか」なので、完全一致で足りる。
 */
function changed(section: string): vscode.ConfigurationChangeEvent {
  return {
    affectsConfiguration: (name: string) => name === section,
  } as vscode.ConfigurationChangeEvent;
}

describe("数え方の設定を変えたときの作り直し", () => {
  test("純／総の切り替えは、描き直すだけでよい", () => {
    const event = changed("novelai.countMode");

    expect(needsRedraw(event)).toBe(true);
    expect(needsRescan(event)).toBe(false);
  });

  test("ルビの扱いは、読み直しが要る", () => {
    const event = changed("novelai.excludeRubyFromCount");

    expect(needsRescan(event)).toBe(true);
    // 読み直しが要るなら、描き直しも当然要る
    expect(needsRedraw(event)).toBe(true);
  });

  test("関係のない設定では、何もしない", () => {
    const event = changed("editor.fontSize");

    expect(needsRedraw(event)).toBe(false);
    expect(needsRescan(event)).toBe(false);
  });

  test("novelai の設定でも、数え方に関わらないものは拾わない", () => {
    // 拡張機能の設定なら何でも作り直す、という作りにはしない。
    // 一覧の全作品を読み直すので、関係のない設定で起こすと重い
    const event = changed("novelai.showWritingStats");

    expect(needsRedraw(event)).toBe(false);
    expect(needsRescan(event)).toBe(false);
  });
});
