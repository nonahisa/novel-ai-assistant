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

  /**
   * 本文の用語から開いたときは、はじめから畳んでおく（作者の依頼、
   * 2026-08-28「本文から用語を右側に出す際は、デフォルトで一覧を
   * 出さない状態にしてください」）。
   *
   * **畳むのは用語から来たときだけ。** メニューから開いたときまで畳むと、
   * 一覧から選ぶための画面で何も選べなくなる。
   */
  test("用語から来たときは、畳んだ状態で出す", () => {
    const code = script();
    expect(code).toContain("if (message.collapseList) setCollapsed(true);");
    // 受けるのは focus のときだけ（init や detail では畳まない）
    const focus = code.slice(code.indexOf('case "focus":'));
    expect(focus.slice(0, 900)).toContain("message.collapseList");
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
    expect(script()).toContain("詳細メニューの「執筆AI支援 → ");
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

/**
 * 「作品情報が何も表示されません」（実機の報告、2026-08-27）の再現。
 *
 * workSelected と workInfo の宣言が無かった。workInfo は受信時の代入で
 * 暗黙のグローバルになり動いて見えたが、workSelected は選ぶまで代入されず、
 * 一覧描画の最初の読み取りで ReferenceError になって一覧が空のままだった。
 * タブの件数は workInfo しか読まないため (2) と出続け、見つけにくかった。
 */
describe("暗黙のグローバルを作らない", () => {
  test("代入している変数は、すべて宣言されている", () => {
    const code = script();

    // 宣言されている名前（let / const / var / function と、関数の引数）
    const declared = new Set<string>();
    for (const m of code.matchAll(/\b(?:let|const|var|function)\s+(\w+)/g)) {
      declared.add(m[1]);
    }
    for (const m of code.matchAll(/function\s*\w*\s*\(([^)]*)\)/g)) {
      for (const raw of m[1].split(",")) {
        const name = raw.trim();
        if (/^\w+$/.test(name)) declared.add(name);
      }
    }

    // 単純な代入の左辺（`x = ...`）。プロパティ（`a.b = ...`）と
    // 比較（`==`）・アロー（`=>`）・複合演算子は除く
    const assigned = new Set<string>();
    for (const m of code.matchAll(/(?<![.\w"'`])(\w+)\s*=(?![=>])/g)) {
      assigned.add(m[1]);
    }

    const undeclared = [...assigned].filter((name) => !declared.has(name));
    expect(undeclared, "宣言なしで代入している（暗黙のグローバル）").toEqual([]);
  });
});

/**
 * 記録の取り下げ（2026-08-16）。
 *
 * 名前が文字列の「null」になった組織が実データにできており、
 * パネルから消す手段が無かった。
 */
describe("記録を取り下げられる", () => {
  test("取り下げボタンがある", () => {
    expect(script()).toContain('post("retire"');
  });

  test("他のボタンと見た目を変える", () => {
    // 編集欄や相談の並びに同じ見た目で置くと押し間違える
    expect(script()).toContain("action danger");
    expect(HTML).toContain("button.danger");
  });

  test("消さずに残ると書く", () => {
    // 「消えない」と分かっていないと、作者は押せない
    expect(script()).toContain("回復用の場所");
  });

  test("確認はWebView側で出さない", () => {
    // WebViewの confirm は使えない。拡張機能側のモーダルで確かめる
    expect(script()).not.toContain("confirm(");
  });
});

/**
 * 名前を変えられるようにした（作者の指摘、2026-08-24。設計書6.5.7）。
 *
 * 「設定資料パネルの登場人物の名前が変更できません。（略）ドロップダウンが
 * でず、ドロップダウンがでる場合も、どうやったら保存できるかわかりません」
 *
 * 原因は2つ。**候補を `datalist` で出していたが、Chromiumでは入力欄に
 * 何の印も出ない**。そして**保存ボタンが10以上の項目の下にあり、
 * 名前を直しても画面の外だった**。
 */
describe("名前の書き換え", () => {
  test("別名は、押せる札として並べる", () => {
    expect(script()).toContain("別名から選ぶ：");
    expect(HTML).toContain("button.chip");
  });

  test("印の出ない datalist は使わない", () => {
    // 入力欄に何の変化も無いため、作者からは「出ない」としか見えない
    expect(script()).not.toContain('createElement("datalist")');
    expect(script()).not.toContain('setAttribute("list"');
  });

  test("札を押すと、入力欄へ入る", () => {
    expect(script()).toContain("control.value = suggestion");
  });

  test("欄の下に、次にやることを書ける", () => {
    expect(script()).toContain('hint.className = "hint"');
  });

  test("変えたことが分かるよう、項目に印を付ける", () => {
    expect(script()).toContain('classList.toggle("changed"');
    expect(HTML).toContain(".field.changed");
  });

  test("変更があるときは、保存の帯を下へ貼り付ける", () => {
    expect(script()).toContain('classList.toggle("dirty"');
    expect(HTML).toContain(".row.saverow.dirty");
    expect(HTML).toContain("position: sticky");
  });

  test("保存していないことを、言葉でも伝える", () => {
    expect(script()).toContain("「保存」を押すまで反映されません。");
  });

  test("初めの値と比べて「変えた」を決める", () => {
    // 初期値を控えずに「触ったか」で決めると、書き戻しても変更扱いになる
    expect(script()).toContain("control.dataset.initial");
  });
});

/**
 * AIで再読込（設計書6.31）。
 *
 * 「AIで項目を充実させる」を改め、作者が留意点を添えて読み直させる操作にした。
 * 混入と判断された記述は捨てず、行き先を選ばせる。
 */
describe("AIで再読込", () => {
  test("ボタンと見出しが「AIで再読込」になっている", () => {
    const body = script();
    expect(body).toContain('textContent = "AIで再読込"');
    // 旧「項目を充実させる」。改名の経緯はコメントに残してよいが、
    // 画面に出る文言としては残さない
    expect(body).not.toContain('textContent = "項目を充実させる"');
  });

  test("留意点の欄があり、記載例を出す", () => {
    const body = script();
    expect(body).toContain("留意点（空欄でも押せます）");
    // 何を書けばよいか分からない自由記載欄は、書かれないのと同じ
    expect(body).toContain("例：他の登場人物〇〇の情報が混入しています。");
    expect(body).toContain("空のままでも実行できます");
  });

  test("留意点を拡張機能側へ渡す", () => {
    expect(script()).toContain("notes: notes.value.trim()");
  });

  test("はじいた情報の行き先を、承認画面に並べる", () => {
    const body = script();
    expect(body).toContain("はじいた情報の行き先");
    // どちらのボタンも用意する（当たったとき／当たらなかったとき）
    expect(body).toContain("」へ挿入する");
    expect(body).toContain("新しいレコードを起こす");
  });

  test("押すまで何も書かないと、画面にも書く", () => {
    expect(script()).toContain("押すまで何も書き込みません");
  });

  test("画面は位置だけを送る（値を往復させない）", () => {
    // AIの返した文字列が画面を往復するほど、どこで変わったのか分からなくなる
    expect(script()).toContain('post("placeMisattributed", { index: item.index })');
  });

  test("項目を反映しても、行き先の一覧は消えない", () => {
    // ここで消すと、作者は行き先を選ぶ前に一覧を失う
    const body = script();
    const at = body.indexOf('case "saved"');
    expect(at).toBeGreaterThan(0);
    expect(body.slice(at, at + 900)).toContain("misattributed");
  });
});

/**
 * 入力欄の高さ（作者の要望、2026-08-28）。
 * 「文字量にあわせてフォームの大きさを可変にしてください」
 */
describe("入力欄の高さ", () => {
  test("中身に合わせて伸びる欄は、編集欄・提案・留意点の3つ", () => {
    // 相談の入力と下書きは、別の理由で行数を固定してある（増減させない）
    const uses = script().split("growWithContent(").length - 1;
    // 定義が1つ、呼び出しが3つ
    expect(uses).toBe(4);
  });

  test("行数を固定した欄は、内側でスクロールする", () => {
    const body = script();
    expect(body).toContain("question.rows = 2");
    expect(body).toContain("body.rows = 8");
  });

  test("幅が変わったら測り直す", () => {
    // 狭めると折り返しが増えるのに高さは固定のままで、
    // 内側のスクロールも切ってあるため、はみ出した行が読めなくなる
    const body = script();
    expect(body).toContain('window.addEventListener("resize"');
    expect(body).toContain("textarea[data-grow]");
  });
});

/**
 * 別人に分ける（設計書6.5.8）。
 *
 * WebViewは実機でしか動かないので、**組み立てに入っていること**だけを見る。
 */
describe("別人に分ける", () => {
  test("分ける節が、取り下げの前にある", () => {
    const body = script();
    const separate = body.indexOf("別の人物に分ける");
    const retire = body.indexOf("この記録を取り下げる");

    expect(separate).toBeGreaterThan(0);
    expect(retire).toBeGreaterThan(0);
    // どちらも「この記録そのものを直す」操作なので並べる。
    // ただし消す操作はいちばん下（押し間違えを避ける）
    expect(separate).toBeLessThan(retire);
  });

  test("押すと拡張機能側へ渡る", () => {
    // WebViewの confirm は使えないので、確認は拡張機能側で出す
    expect(script()).toContain('post("separate"');
  });

  test("札として並べる（datalistを使わない）", () => {
    // 6.5.7：Chromiumのdatalistは入力欄に何の印も出ず、
    // 作者からは「ドロップダウンが出ない」としか見えなかった
    const body = script();
    const at = body.indexOf("別人にする呼び名");
    expect(at).toBeGreaterThan(0);
    expect(body.slice(at, at + 600)).toContain('className = "chip"');
  });
});