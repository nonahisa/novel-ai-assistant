import { describe, expect, test } from "vitest";
import { buildSettingsPanelHtml } from "../../src/views/settingsPanelHtml";

/**
 * 設定資料パネルの見づらさを直した（作者の指摘、2026-08-16）。
 *
 * - タブが5つを1行へ押し込んでおり、幅260pxでは1つ52pxしか無く
 *   「登場人／物(84)」のように語の途中で改行されていた
 * - 一覧を畳めず、資料そのものを読む幅が狭かった
 * - 作品紹介文・キャッチコピー・各話あらすじは `設定/synopsis.md` を
 *   自分で開くしか見る方法が無かった（「閲覧がわかりにくい」）
 *
 * **WebViewは実機でしか動かない。** ここでは、組み立てが壊れていないこと
 * （スクリプトが読めること、必要な部品が入っていること）だけを見る。
 */

const HTML = buildSettingsPanelHtml("test-nonce", "vscode-resource:");

/** `<script>` の中身を取り出す */
function script(): string {
  const found = HTML.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/);
  expect(found, "スクリプトが見つからない").toBeTruthy();
  return found![1];
}

describe("画面の組み立て", () => {
  test("スクリプトがJavaScriptとして読める", () => {
    // 文字列で組み立てているので、ここが壊れるとパネルが真っ白になる
    expect(() => new Function(script())).not.toThrow();
  });

  test("値をHTMLへ埋め込まない", () => {
    // 作品には作者が書いた任意の文字列が入る。埋め込むと引用符ひとつで壊れる
    expect(HTML).toContain("postMessage");
  });
});

describe("一覧を畳める", () => {
  test("畳むボタンと戻すボタンがある", () => {
    expect(HTML).toContain('id="sidebar-toggle"');
    expect(HTML).toContain('id="reopen"');
  });

  test("畳んだら一覧が消え、戻すボタンが出る", () => {
    expect(HTML).toContain("body.collapsed #sidebar { display: none; }");
    expect(HTML).toContain("body.collapsed #reopen { display: block; }");
  });

  test("戻すボタンは詳細を描き直しても消えない", () => {
    // 詳細は選び直すたびに replaceChildren で作り直される。
    // 中へ入れっぱなしにすると、畳んだまま戻せなくなる
    expect(script()).toContain("el.detail.replaceChildren(el.reopen)");
  });

  test("畳んだ状態を覚える", () => {
    expect(script()).toContain("vscode.setState");
  });
});

describe("タブが詰まらない", () => {
  test("折り返す", () => {
    expect(HTML).toContain("flex-wrap: wrap");
  });

  test("1つあたりの幅を確保する", () => {
    // これが無いと語の途中で改行される
    expect(HTML).toMatch(/min-width:\s*7\dpx/);
  });

  test("語の途中で折り返さない", () => {
    expect(HTML).toContain("white-space: nowrap");
  });
});

describe("作品情報を設定資料集で見られる", () => {
  test("タブがある", () => {
    expect(script()).toContain("作品情報");
  });

  test("紹介文・キャッチコピー・各話あらすじが並ぶ", () => {
    const code = script();
    expect(code).toContain("作品紹介文");
    expect(code).toContain("キャッチコピー");
    expect(code).toContain("各話あらすじ");
  });

  test("まだ無いときは、どこで作れるかを書く", () => {
    // 「まだありません」だけでは、作者は次に何をすればよいか分からない
    expect(script()).toContain("操作メニューの「執筆AI支援 → ");
  });

  test("読むだけにする（書き換えの口を持たない）", () => {
    // 真実の在り処は synopsis.md と chapter_synopses.json 側にある。
    // ここで書き換えられると、どちらが正しいのか分からなくなる
    const code = script();
    const workDetail = code.slice(
      code.indexOf("function renderWorkDetail"),
      code.indexOf("function missingNote")
    );
    expect(workDetail).not.toContain("textarea");
    expect(workDetail).not.toContain('post("save"');
  });
});
