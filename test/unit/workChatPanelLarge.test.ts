import { describe, expect, test } from "vitest";
import { buildWorkChatPanelHtml } from "../../src/views/workChatPanelHtml";

/**
 * 大きい相談パネル（作者の要望、2026-08-28）。
 *
 * 「メニューのAI相談を大きいパネルにして、できることを増やしておいてください」
 * 「本文領域に大きく表示できるようにすること。**現在の領域は残してください**」
 *
 * **WebViewは実機でしか動かない。** ここで見るのは、組み立てが壊れて
 * いないことと、片方にしか出さないものが混ざっていないことだけである。
 */

const LARGE = buildWorkChatPanelHtml("test-nonce", "vscode-resource:", {
  large: true,
});
const SIDEBAR = buildWorkChatPanelHtml("test-nonce", "vscode-resource:");

function script(html: string): string {
  const found = html.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/);
  expect(found, "スクリプトが見つからない").toBeTruthy();
  return found![1];
}

describe("画面の組み立て", () => {
  test("どちらもJavaScriptとして読める", () => {
    // 文字列で組み立てているので、ここが壊れるとパネルが真っ白になる
    expect(() => new Function(script(LARGE))).not.toThrow();
    expect(() => new Function(script(SIDEBAR))).not.toThrow();
  });

  test("既存の呼び出し（2引数）はこれまでどおり", () => {
    // 横のパネルの見た目は変えない、が作者の指定である
    expect(SIDEBAR).toContain('<body>');
    expect(LARGE).toContain('<body class="large">');
  });
});

describe("ツールバーは大きい画面だけに出す", () => {
  test("3つのボタンと「できること」が入る", () => {
    expect(LARGE).toContain('id="choose-work"');
    expect(LARGE).toContain("作品を選ぶ");
    expect(LARGE).toContain('id="save-note"');
    expect(LARGE).toContain("会話をメモに保存");
    expect(LARGE).toContain('id="open-manual"');
    expect(LARGE).toContain("使い方を開く");
    expect(LARGE).toContain("<summary>できること</summary>");
  });

  test("横のパネルには入らない", () => {
    // 狭いところに置くと、肝心の会話が下へ押し出される
    expect(SIDEBAR).not.toContain('id="toolbar"');
    expect(SIDEBAR).not.toContain('id="choose-work"');
    expect(SIDEBAR).not.toContain('id="save-note"');
    expect(SIDEBAR).not.toContain('id="open-manual"');
    // 見出しそのものが無いことを見る（受け口のコードは両方が持つ）
    expect(SIDEBAR).not.toContain("<summary>できること</summary>");
  });

  test("「できること」は畳んでおく", () => {
    // 21個の札を最初から広げると、会話の場が無くなる
    expect(LARGE).toContain("<details>");
    expect(LARGE).not.toContain("<details open>");
  });
});

describe("読みやすい幅にする", () => {
  test("中央に寄せて、幅を抑える", () => {
    // 横に長い行は目が戻る場所を見失う
    expect(LARGE).toContain("max-width: 62em");
    expect(LARGE).toContain("body.large #log > *");
  });

  test("入力欄を少し高くする", () => {
    expect(LARGE).toContain("body.large textarea { min-height: 72px; }");
  });
});

describe("2つの画面で同じ会話を見る", () => {
  // 送受信の口は、大きい画面かどうかに関わらず持つ。
  // **横のパネルも受け取る側になる**ので、片方だけに入れてはいけない
  for (const [name, html] of [
    ["大きい画面", LARGE],
    ["横のパネル", SIDEBAR],
  ] as const) {
    test(`${name}が、続きから見せる仕組みを持つ`, () => {
      const code = script(html);

      // 後から開いた側へ、これまでの会話が届く
      expect(code).toContain("'history'");
      // もう片方で送られた質問を積んで、待ち状態にする
      expect(code).toContain("'asked'");
      // もう片方で「最初から」が押された
      expect(code).toContain("'cleared'");
    });
  }

  test("受け取った消去を、送り返さない", () => {
    // 送り返すと2つの画面で行ったり来たりする
    const code = script(LARGE);
    const at = code.indexOf("message.type === 'cleared'");
    expect(at).toBeGreaterThan(0);
    expect(code.slice(at, at + 200)).not.toContain("postMessage");
  });

  test("届いた履歴では、提案のボタンを作り直さない", () => {
    // 提案は出た側の画面に残っている。同じものが2つ並ぶと、
    // どちらを押したのか分からなくなる
    const code = script(LARGE);
    const at = code.indexOf("message.type === 'history'");
    const handler = code.slice(at, code.indexOf("message.type === 'asked'"));

    expect(handler).not.toContain("appendEdit");
    expect(handler).not.toContain("appendRun");
    expect(handler).not.toContain("appendReload");
  });
});

/**
 * 面の行き来（作者の指定、2026-09-03）。
 *
 * 詳細メニューから相談の項目を消したので、**画面の中で行き来できないと
 * 大きく開く道が無くなる**。横の細いパネルには「メインに表示」、
 * 大きい画面には「サブに戻す」を出す。
 *
 * **両方に両方を出さない。** いま見ている面へ移るボタンが並んでいると、
 * どちらが今の面なのか分からなくなる。
 */
describe("メインとサブを行き来する", () => {
  /** 入力欄の下の並び（「最初から」「送る」が入っている行）を取り出す */
  function composerRow(html: string): string {
    const found = html.match(
      /<div id="composer">[\s\S]*?<div class="row">([\s\S]*?)<\/div>/
    );
    expect(found, "入力欄の下の並びが見つからない").toBeTruthy();
    return found![1];
  }

  test("横のパネルには「メインに表示」だけを出す", () => {
    expect(SIDEBAR).toContain('id="to-main"');
    expect(SIDEBAR).toContain("メインに表示");
    expect(SIDEBAR).not.toContain('id="to-sub"');
    expect(SIDEBAR).not.toContain("サブに戻す");
  });

  test("大きい画面には「サブに戻す」だけを出す", () => {
    expect(LARGE).toContain('id="to-sub"');
    expect(LARGE).toContain("サブに戻す");
    expect(LARGE).not.toContain('id="to-main"');
    expect(LARGE).not.toContain("メインに表示");
  });

  test("「最初から」「送る」と同じ並びの、左側に置く", () => {
    for (const [name, html, id] of [
      ["横のパネル", SIDEBAR, "to-main"],
      ["大きい画面", LARGE, "to-sub"],
    ] as const) {
      const row = composerRow(html);

      expect(row, `${name}：同じ並びに入っていない`).toContain(`id="${id}"`);
      expect(row.indexOf(`id="${id}"`), `${name}：「最初から」より右にある`)
        .toBeLessThan(row.indexOf('id="clear"'));
      expect(row.indexOf(`id="${id}"`), `${name}：「送る」より右にある`)
        .toBeLessThan(row.indexOf('id="send"'));
    }
  });

  test("押すと拡張機能側へ渡す（webviewからコマンドを呼ばない）", () => {
    // 面の切り替えはコマンドの実行なので、拡張機能側の仕事である
    expect(script(SIDEBAR)).toContain("type: 'showInMain'");
    expect(script(LARGE)).toContain("type: 'showInSub'");
  });

  test("相手の面のボタンが無くても落ちない", () => {
    // ツールバーと同じ理由。有無を確かめずに触ると画面が真っ白になる
    for (const html of [SIDEBAR, LARGE]) {
      const code = script(html);
      expect(code).toContain("if (toMainEl)");
      expect(code).toContain("if (toSubEl)");
    }
  });

  test("考えている間は押せない", () => {
    // 答えを待っている最中に面を畳むと、届いた答えの行き先が変わる
    for (const html of [SIDEBAR, LARGE]) {
      const code = script(html);
      const at = code.indexOf("function setBusy");
      const body = code.slice(at, at + 500);

      expect(body).toContain("toMainEl");
      expect(body).toContain("toSubEl");
    }
  });
});

/**
 * 相談を資料へ反映する（設計書6.72）。
 *
 * **入口はこのボタンだけ**である（コマンドは作らない）。横のパネルで
 * 相談を終えたときに大きく開き直させないため、両方の面に出す。
 */
describe("相談を資料へ反映するボタン", () => {
  for (const [name, html] of [
    ["大きい画面", LARGE],
    ["横のパネル", SIDEBAR],
  ] as const) {
    test(`${name}に出る`, () => {
      expect(html).toContain('id="apply-settings"');
      expect(html).toContain("相談を資料へ反映");
    });

    test(`${name}：会話が無いうちは押せない`, () => {
      // 1往復も無い会話を送っても、AIを呼んで空振りするだけ
      expect(html).toContain('id="apply-settings" disabled');
      const code = script(html);
      expect(code).toContain("exchanges === 0");
    });

    test(`${name}：押すと拡張機能側へ渡す`, () => {
      expect(script(html)).toContain("type: 'applyToSettings'");
    });

    test(`${name}：走っている間は二度押せない`, () => {
      const code = script(html);
      const at = code.indexOf("function updateApplyState");
      const body = code.slice(at, at + 300);

      expect(body).toContain("busy || applying || exchanges === 0");
      // 終わったら押せる状態へ戻す（戻し忘れると二度と押せない）
      expect(code).toContain("message.type === 'applyToSettingsDone'");
    });

    test(`${name}：ボタンが無くても落ちない`, () => {
      // ツールバーと同じ理由。有無を確かめずに触ると画面が真っ白になる
      expect(script(html)).toContain("if (applyToSettingsEl)");
    });
  }
});

describe("「できること」から機能を起動する", () => {
  test("押すと拡張機能側へ渡る", () => {
    expect(script(LARGE)).toContain("type: 'quickRun'");
  });

  test("一覧は拡張機能側から受け取る", () => {
    // 画面へ書き写すと、機能を足したときに押しても何も起きない札が並ぶ
    const code = script(LARGE);
    expect(code).toContain("message.quickRuns");
    expect(code).toContain("renderQuickRuns");
  });

  test("AIを使うかどうかを、押す前に出す", () => {
    // クラウドのAIは実行のたびに課金される
    expect(script(LARGE)).toContain("（AIを使います）");
  });

  test("考えている間は押せない", () => {
    const code = script(LARGE);
    const at = code.indexOf("function renderQuickRuns");
    const body = code.slice(at, at + 700);

    expect(body).toContain("button.disabled = busy");
    expect(body).toContain("if (busy) return;");
  });

  test("作品を選ぶ・メモに保存も、拡張機能側へ渡す", () => {
    const code = script(LARGE);
    expect(code).toContain("type: 'chooseWork'");
    expect(code).toContain("type: 'saveNote'");
    expect(code).toContain("type: 'openManual'");
  });

  test("ツールバーが無くても落ちない", () => {
    // 横のパネルにはボタンが無い。有無を確かめずに触ると、
    // 読み込んだ瞬間に落ちて画面が真っ白になる
    const code = script(SIDEBAR);
    expect(code).toContain("if (chooseWorkEl)");
    expect(code).toContain("if (saveNoteEl)");
    expect(code).toContain("if (!quickRunListEl) return;");
  });
});

/**
 * 「作品情報が何も表示されません」（設定資料パネルで実際に起きた、2026-08-27）と
 * 同じ壊れ方を、この画面でも防ぐ。宣言のない代入は暗黙のグローバルになり、
 * 読み取りの順によっては ReferenceError で画面が丸ごと止まる。
 */
describe("暗黙のグローバルを作らない", () => {
  for (const [name, html] of [
    ["大きい画面", LARGE],
    ["横のパネル", SIDEBAR],
  ] as const) {
    test(`${name}：代入している変数は、すべて宣言されている`, () => {
      const code = script(html);

      // 宣言されている名前（let / const / var / function と、関数の引数）
      const declared = new Set<string>();
      for (const m of code.matchAll(/\b(?:let|const|var|function)\s+(\w+)/g)) {
        declared.add(m[1]);
      }
      for (const m of code.matchAll(/function\s*\w*\s*\(([^)]*)\)/g)) {
        for (const raw of m[1].split(",")) {
          const trimmed = raw.trim();
          if (/^\w+$/.test(trimmed)) declared.add(trimmed);
        }
      }

      // **文字列の中身は先に落とす。** この画面は innerHTML を
      // 組み立てており、`<div class="who">` の `class=` を代入と
      // 読んでしまう（設定資料パネルの写しのままでは誤検知する）
      const withoutStrings = code
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');

      // 単純な代入の左辺（`x = ...`）。プロパティ（`a.b = ...`）と
      // 比較（`==`）・アロー（`=>`）・複合演算子は除く
      const assigned = new Set<string>();
      for (const m of withoutStrings.matchAll(/(?<![.\w"'`])(\w+)\s*=(?![=>])/g)) {
        assigned.add(m[1]);
      }

      const undeclared = [...assigned].filter((entry) => !declared.has(entry));
      expect(undeclared, "宣言なしで代入している（暗黙のグローバル）").toEqual(
        []
      );
    });
  }
});
