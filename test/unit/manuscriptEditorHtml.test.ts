import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../src/views/manuscriptEditorHtml";
import { MEMO_MARKER_COLOR } from "../../src/core/sceneMemo";

/**
 * 原稿エディタの画面（設計書6.25）。
 *
 * **画面が組み立てられない不具合は、実機でしか気づけない。** ここでは
 * 「そもそもHTMLとして出来ているか」と「守るべき約束が入っているか」だけを見る。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");

describe("原稿エディタのHTML", () => {
  it("スクリプトとスタイルにnonceが入っている", () => {
    expect(html).toContain('<style nonce="NONCE123">');
    expect(html).toContain('<script nonce="NONCE123">');
  });

  it("外から何も読み込ませない（CSP）", () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-NONCE123'");
  });

  /** テンプレートの取り違えで、置き換わらない印が残っていないか */
  it("埋め込みの印が残っていない", () => {
    const body = html.slice(html.indexOf("<body"));
    expect(body).not.toContain("${");
  });

  it("縦書きと横書きを切り替えるボタンがある", () => {
    expect(html).toContain('id="dir"');
    expect(html).toContain("縦書きと横書きを切り替えます");
  });

  /**
   * 面は2つだけになった（0.25.2）。「読む」面（#read）と「並べる」面は、
   * 切り替えのボタンを外した0.24.14の時点で**開く道が無く**なっていたので
   * 消してある。打つ面は、組んで書く面の安全弁が落ちる先として要る。
   */
  it("打つ面と、組んで書く面がある", () => {
    expect(html).toContain('<textarea id="write"');
    expect(html).toContain('<div id="compose"');
    expect(html).not.toContain('id="read"');
  });

  /** 縦書きは CSS の writing-mode で効かせる */
  it("縦書きの指定が入っている", () => {
    expect(html).toContain("writing-mode: vertical-rl");
  });

  /** 英数字が1文字ずつ縦に積まれないようにする */
  /** 縦書きの日本語では、傍線（下線）は行の右に引く。変換中の線も同じ */
  it("縦書きの傍線は右に引く", () => {
    expect(html).toContain("text-underline-position: right");
  });

  it("文字の向きは mixed にしてある", () => {
    expect(html).toContain("text-orientation: mixed");
    expect(html).not.toContain("text-orientation: upright");
  });

  it("投稿サイト用のコピーがある", () => {
    expect(html).toContain('id="copy"');
  });

  it("右クリックの品書きの置き場がある", () => {
    expect(html).toContain('<div id="menu">');
  });

  /** 変換中の文字を送ると、確定のたびに二重に入る */
  it("IMEの変換中は本文を送らない", () => {
    expect(html).toContain("compositionstart");
    expect(html).toContain("compositionend");
  });

  /**
   * 文字列で組み立てているので、ここが壊れると画面が真っ白になる。
   * **`\n` のような書き方は、テンプレート文字列の側で1回ほどける**ので、
   * 生の改行が混ざっただけでも読めなくなる。
   */
  it("スクリプトがJavaScriptとして読める", () => {
    const found = html.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
    expect(found, "スクリプトが見つからない").toBeTruthy();
    expect(() => new Function(found![1])).not.toThrow();
  });

  it("タグの数が合っている", () => {
    const open = [...html.matchAll(/<div\b/g)].length;
    const close = [...html.matchAll(/<\/div>/g)].length;
    expect(open).toBe(close);
  });
});

/**
 * 日本語入力（IME）が壊れていた（作者の指摘、2026-08-24。設計書6.25.1）。
 *
 * 「入力中にカーソルが飛んだり、文字が重複したり、変換が途中で止まったり」
 *
 * **`<textarea>` にしたのはIMEを守るためだったのに、こちらから壊していた。**
 * 打った本文が文書へ入ると、その文書がそのまま画面へ送り返される。それを
 * 変換中に入れ直していた。
 */
describe("日本語入力を壊さない", () => {
  const code = html.slice(html.indexOf("<script"));

  it("変換中は、打っている面へ入れ直さない", () => {
    // ここが無いと、変換中の文字が消える・二重に入る・変換が止まる
    expect(code).toContain("if (composing)");
    expect(code).toContain("pending = text");
  });

  it("自分が送った本文が返ってきただけなら、触らない", () => {
    expect(code).toContain("lastSent");
    expect(code).toContain("if (text === lastSent) return;");
  });

  it("変換が確定したら、待たせていた書き換えを片づける", () => {
    expect(code).toContain("flushPending");
  });

  /** 打った直後に Ctrl+S を押すと、最後の数文字が保存されないため */
  it("打った本文は、まとめずにその場で送る", () => {
    expect(code).not.toContain("setTimeout(send");
    expect(code).toContain("compositionend");
  });

  it("外から書き換えが来ても、カーソルの位置を保つ", () => {
    expect(code).toContain("replaceKeepingCaret");
    expect(code).toContain("setSelectionRange");
  });

});

/**
 * 打つ面の用語（設計書6.25.6）。作者の報告（2026-08-28）は2つ。
 *
 * 1. 「文字サイズを変えるとマーカーが追随しません」
 * 2. 「用語はマーカーではなく文字色で表現してください」
 *
 * ずれの正体は**折り返し幅の差**である。打つ面（textarea）はスクロールバーの
 * ぶんだけ本文が狭く、重ねる面（#marks）は overflow:hidden でバーが無い。
 * 文字を大きくするとバーが出入りして、折り返しの位置が食い違う。
 */
describe("打つ面の用語の色", () => {
  const code = html.slice(html.indexOf("<script"));

  it("背景を塗らず、文字色で出す", () => {
    expect(html).toContain(".mark-character { color: var(--novelai-character); }");
    expect(html).toContain(".mark-location { color: var(--novelai-location); }");
    expect(html).toContain(".mark-ability { color: var(--novelai-ability); }");
    expect(html).toContain(
      ".mark-organization { color: var(--novelai-organization); }"
    );
    // 塗りが残っていると、色と帯が二重に出る
    expect(html).not.toContain("background: color-mix(in srgb, var(--novelai-");
  });

  /** 色は文字そのものに乗せるので、打つ面の**上**へ重ねる必要がある */
  it("打つ面の上へ重ねる", () => {
    const marks = html.slice(html.indexOf("#marks {"), html.indexOf("#marks.stale"));
    expect(marks).toContain("z-index");
    expect(marks).toContain("pointer-events: none");
    // 変換中の文字は textarea にしか無い。透明にすると打っている字が消える
    expect(html).toContain("color: var(--vscode-editor-foreground)");
  });

  it("スクロールバーのぶんを測って、重ねる面の枠を合わせる", () => {
    expect(code).toContain("function alignMarksBox()");
    expect(code).toContain("write.offsetWidth - write.clientWidth");
    expect(code).toContain("write.offsetHeight - write.clientHeight");
  });

  /**
   * **測り直す機会が足りていなかった**のが不具合の本体である。
   * 本文が変わったときだけでなく、大きさ・向き・窓の大きさでも測り直す。
   */
  it("大きさ・向き・窓の大きさでも測り直す", () => {
    expect(code).toContain("function scheduleAlignMarks()");
    // paint() は大きさと向きの両方をここで当てている
    expect(code).toMatch(/--novelai-size[\s\S]{0,200}scheduleAlignMarks\(\)/);
    expect(code).toContain('window.addEventListener("resize", scheduleAlignMarks)');
  });

  /** 1回の操作で何度も採寸が走らないように、1フレームへまとめる */
  it("測り直しは1フレームに1回へまとめる", () => {
    expect(code).toMatch(/scheduleAlignMarks[\s\S]{0,400}requestAnimationFrame/);
  });

  /**
   * 作者の実機報告（2026-08-29）「スクロールされるとたまに文字がズレます」。
   *
   * 目印の中身は、打ってから新しいものが届くまで（往復で120ミリ秒＋）
   * **古い本文のまま**である。0.24.12で背景の塗りから**文字色**へ変えたため、
   * 古い層がそのまま残ると「ズレた位置の色つきの字」として見えてしまう。
   *
   * **色が一瞬消えるほうが、ズレた字が見えるより軽い。**
   */
  it("本文が変わった時点で、目印を隠す", () => {
    const input = code.slice(code.indexOf('write.addEventListener("input"'));
    // 変換中（IME）でも textarea の値は変わる。**隠すのは composing より先**
    expect(input.slice(0, 300)).toContain('marks.classList.add("stale")');
    expect(input.indexOf('marks.classList.add("stale")')).toBeLessThan(
      input.indexOf("if (composing) return;")
    );
    expect(html).toContain("#marks.stale { visibility: hidden; }");
  });

  /**
   * **当てる側の照合だけでは足りない。** 一致しないと分かった時点で
   * 隠す道が無く、いったん出した層が古くなっても残っていた。
   */
  it("いまの本文と一致するときだけ出し、しないときは隠す", () => {
    const apply = code.slice(code.indexOf("function applyMarksIfMatch()"));
    const body = apply.slice(0, apply.indexOf("\n  }"));
    // 一致しない側（早戻り）で隠す
    expect(body).toContain(
      "if (!latestMarks || latestMarks.forText !== write.value) {"
    );
    expect(body).toContain('marks.classList.add("stale");');
    // 表示へ戻すのは、当てたあとの1か所だけ
    expect(body).toContain('marks.classList.remove("stale");');
    expect([...code.matchAll(/marks\.classList\.remove\("stale"\)/g)]).toHaveLength(
      1
    );
    expect(body.indexOf("marks.innerHTML = latestMarks.html")).toBeLessThan(
      body.indexOf('marks.classList.remove("stale")')
    );
  });

  /**
   * scroll の知らせは間引かれることがある（慣性のある動き・ホイールの連打）。
   * 最後の1回を取りこぼすと、目印だけが半端な位置で止まる。
   */
  it("スクロールが止まったところで、位置をもう一度写す", () => {
    expect(code).toContain("function syncMarksScroll()");
    expect(code).toContain('write.addEventListener("scroll"');
    // 持たない環境では、いままでどおり（scroll のたびの写しだけ）
    expect(code).toContain('if ("onscrollend" in write)');
    expect(code).toContain('write.addEventListener("scrollend", syncMarksScroll)');
  });
});

/**
 * 誤字脱字の提案から、この画面のまま場所を示す（作者の依頼、2026-08-28）。
 *
 * 「誤字脱字から開く場合は、現在メインで開いているエディターと同じ
 * エディターで開いたうえで場所を示してください」。
 */
describe("その行を示す", () => {
  const code = html.slice(html.indexOf("<script"));

  it("revealLine を受け取る", () => {
    expect(code).toContain('message.type === "revealLine"');
    expect(code).toContain("function revealLine(line)");
  });

  /**
   * 縦書きと横書きで転がす向きが違う。Chromium の
   * 「焦点を当てると選択まで転がす」振る舞いに任せて吸収している。
   */
  it("選び直してから、焦点を入れ直して転がす", () => {
    expect(code).toMatch(
      /setSelectionRange\(start, end\)[\s\S]{0,300}write\.blur\(\);\s*write\.focus\(\);/
    );
  });

  /**
   * **組んで書く面では、選択を置くだけでは画面が転がらない**
   * （作者の報告、2026-08-29「誤字脱字パネルから本文に飛びません」）。
   *
   * 打つ面（textarea）は焦点を入れ直せばブラウザが送ってくれるが、
   * contenteditable ではそれが起きない。カーソルは移っているのに、
   * 見えている場所は元のままである。
   */
  it("組んで書く面は、自分で画面を動かす", () => {
    const reveal = code.slice(code.indexOf("function revealLine(line)"));
    expect(reveal.slice(0, 1500)).toContain("composeNudgeIntoView(start)");

    const nudge = code.slice(code.indexOf("function composeNudgeIntoView("));
    // はみ出したぶんだけ動かす（中央には寄せない。読む面と同じ考え方）
    expect(nudge.slice(0, 900)).toContain("offRect(compose, rect)");
    expect(nudge.slice(0, 900)).toContain("compose.scrollLeft += off.left");
    expect(nudge.slice(0, 900)).toContain("compose.scrollTop += off.top");
  });

  /** 位置を測れずに動かせなかったことを、黙って終わらせない */
  it("動かせなかったら、記録に残す", () => {
    const reveal = code.slice(code.indexOf("function revealLine(line)"));
    expect(reveal.slice(0, 1500)).toContain("画面を動かせませんでした");
  });
});

/**
 * 消した面が戻ってこないようにする（0.25.2）。
 *
 * 「読む」面と「並べる」面は、0.24.14で切り替えのボタンを外した時点から
 * **入る道が無かった**（面を表す2つのフラグが、どこからも true にならない）。
 * 機構だけが約200行残っていたので消したが、**消したものは黙って戻る**——
 * 部分的に書き戻された機構は、動かないまま次に読む人を惑わせる。
 */
describe("消した「読む」「並べる」の面", () => {
  const code = html.slice(html.indexOf("<script"));

  it("切り替えのボタンを出さない", () => {
    expect(html).not.toContain('id="split"');
    expect(html).not.toContain('id="mode"');
    expect(html).not.toContain('id="composeMode"');
    expect(html).not.toContain("並べるのをやめる");
    expect(html).not.toContain("組んで書くのをやめる");
  });

  it("面のフラグそのものが無い", () => {
    expect(code).not.toContain("let reading");
    expect(code).not.toContain("let split");
  });

  it("面のCSSも、面を引く処理も無い", () => {
    expect(html).not.toContain("body.split");
    expect(html).not.toContain("body.reading");
    expect(code).not.toContain('getElementById("read")');

    /*
      **`#read` を1つも飾らないこと。** ただし「かつて読む面で作者が
      確かめた形である」という由来は、三点リーダのCSSのコメントに残して
      ある（消すと、なぜこの値なのかが分からなくなる）。そこで文中の
      言及ではなく、**規則の見出し（`{` で終わる行）**だけを見る。
    */
    const selectors = html
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.endsWith("{"));

    expect(selectors.filter((line) => line.includes("#read"))).toEqual([]);
  });

  /** 古い state に残っていても読まない（読んで無視する形も残さない） */
  it("覚えていた面を読まない", () => {
    expect(code).not.toContain("saved.reading");
    expect(code).not.toContain("saved.split");
    expect(code).toContain("vscode.setState({ vertical, size,");
  });

  /**
   * **切り分けの計器も消した**（0.25.2）。三点リーダが行の中央に来ない
   * 不具合（0.24.13〜14）を追うために、計算済みスタイルをログへ書いていた。
   * 原因（欧文フォールバックの字形）は解明・修正済みで、いまは打つたびに
   * `getComputedStyle` を走らせてログを1行出すだけになっていた。
   */
  it("三点リーダの計器が無い", () => {
    expect(code).not.toContain("composeReportEllipsis");
  });
});

/**
 * 下段と右クリックの品書き（作者の実機報告、2026-08-28）。
 *
 * - 「右クリックで出てくるメニューの一番上に名称はいりません」
 * - 「『最新話を書く』は画面右下に配置してください」
 * - 「文字の色分け説明は不要です」
 */
describe("下段と品書きの整理", () => {
  const code = html.slice(html.indexOf("<script"));

  /**
   * 品書きの先頭に用語名を出さない。**右クリックした語は本人がいちばん
   * よく分かっている**ので、1行ぶん取るほどの手がかりではない。
   */
  /**
   * 右クリックそのもので、**開いている**資料パネルが追従する
   * （作者の指示、2026-08-28）。開くのは品書きの「設定資料を見る」だけで、
   * 追従は開いているパネルに限る（画面を奪わない）。
   */
  it("右クリックの時点で previewTerm を送る", () => {
    const menuHandler = code.slice(
      code.indexOf('document.addEventListener("contextmenu"')
    );
    expect(
      menuHandler.slice(0, menuHandler.indexOf("openMenu("))
    ).toContain('type: "previewTerm"');
  });

  it("右クリックの品書きに、用語の名前を出さない", () => {
    const open = code.slice(code.indexOf("function openMenu("));
    const body = open.slice(0, open.indexOf("function termAtCaret("));
    expect(body).not.toContain('className = "head"');
    expect(body).not.toContain("head.textContent = term.name");
    // 用語があるときの入口そのものは残っている
    expect(body).toContain("設定資料を見る");
    // 使わなくなった見出しの装いも残さない
    expect(html).not.toContain("#menu .head {");
  });

  /** 書いている手の近く、画面の右下に置く */
  it("「最新話を書く」は下段の右端に寄せる", () => {
    expect(html).toContain('<div id="bottom">');
    expect(html).toContain('id="latest"');
    expect(html).toContain("#latest { margin-left: auto; }");
  });

  /**
   * 凡例は**跡形なく**外す。span も、組み立てるスクリプトも、
   * 送る側（features/manuscriptEditor.ts）も。
   * 色の意味は設定資料パネルのタブが同じ色で示す。
   */
  it("色分けの凡例を出さない", () => {
    expect(html).not.toContain('id="legend"');
    expect(code).not.toContain("legend");
    expect(html).not.toContain("#foot .swatch");
    expect(html).not.toContain('className = "swatch"');
    // 知らせの行は残す（凡例と同じ帯に同居していた）
    expect(html).toContain('id="note"');
  });
});

/**
 * 下段の字数（作者の指示、2026-08-29）。
 *
 * 常に出ていた面の説明を外し、空いたところへ
 * 「作品 ◯◯,◯◯◯字 ／ このファイル ◯,◯◯◯字 ／ 今日 +◯◯◯字」を出す。
 */
describe("下段の字数", () => {
  const code = html.slice(html.indexOf("<script"));

  it("字数を出す場所がある", () => {
    expect(html).toContain('<span id="counts"></span>');
    expect(code).toContain("function paintCounts()");
  });

  it("3つとも出す", () => {
    expect(code).toContain('"作品 "');
    expect(code).toContain('"このファイル "');
    expect(code).toContain('"今日 "');
  });

  /**
   * **面の説明は出さない。** 切り替えのボタンを外したので、
   * 「もう一度押して戻してください」は押す先の無い案内になる。
   */
  it("常に出ている面の説明は残さない", () => {
    expect(html).not.toContain("ルビ・傍点は「読む」か「並べる」で出ます");
    expect(html).not.toContain("1つのかたまりとして扱います");
    // その場で起きたことを伝える口は残す（安全弁・ルビの断り）
    expect(code).toContain("note.textContent");
  });

  /**
   * **数えるのは拡張機能側**（純／総の設定もルビの扱いも向こうが持つ）。
   * 画面で数え直すと、上の帯と下の帯で違う字数が出る。
   */
  it("このファイルの字数は、拡張機能が数えた値を使う", () => {
    const handler = code.slice(code.indexOf('message.type === "count"'));
    expect(handler.slice(0, 400)).toContain("footFile = message.value");
  });

  /** 上の帯の字数は消した（作者の指示、2026-08-29「上を消してください」）。下段と重複していた */
  it("上の帯に字数を出さない", () => {
    expect(html).not.toContain('id="count"');
    expect(code).not.toContain("countLabel");
  });

  /**
   * 4万字の作品を1打鍵ごとに走査すると打つ手が止まる。作品の合計は
   * 開いたときと保存したときにだけ測り、その間はこのファイルの増減を足す。
   */
  it("作品の合計は、測ったときからの増減を足して見せる", () => {
    const paint = code.slice(code.indexOf("function paintCounts()"));
    expect(paint.slice(0, 700)).toContain("footFile - footWorkBase");
    expect(code).toContain('message.type === "counts"');
  });

  /** 記録を止めている作者に「今日 0字」と書かない */
  it("今日の量が届かなければ、出さない", () => {
    const handler = code.slice(code.indexOf('message.type === "counts"'));
    expect(handler.slice(0, 500)).toContain(
      'typeof message.today === "number" ? message.today : null'
    );
  });
});

/**
 * 前の話・次の話（作者の指示、2026-08-29）。
 *
 * 並びを知っているのは拡張機能側なので、画面は用件を送るだけにする。
 */
describe("前の話・次の話", () => {
  const code = html.slice(html.indexOf("<script"));

  it("下段に2つのボタンを置く", () => {
    expect(html).toContain('id="prev"');
    expect(html).toContain('id="next"');
    // 縦書き・横書きのどちらでも意味が通る言葉にする
    expect(html).toContain("← 前の話");
    expect(html).toContain("次の話 →");
  });

  it("どちらへ移るかを添えて送る", () => {
    expect(code).toContain('type: "openNeighbor", direction: "prev"');
    expect(code).toContain('type: "openNeighbor", direction: "next"');
  });

  /** 「最新話を書く」は右端のまま（作者の依頼、2026-08-28） */
  it("最新話を書くは、下段の右端に残る", () => {
    expect(html).toContain("#latest { margin-left: auto; }");
  });
});

/**
 * シーンメモ（設計書6.40.3）。
 *
 * 作者の指示（2026-08-29）「シーンメモした場所は、蛍光黄色でマーカーして
 * ください」。**打つ面と組んで書く面の両方**で出す。
 */
describe("シーンメモの見え方", () => {
  const code = html.slice(html.indexOf("<script"));

  /**
   * **色の定義は core/sceneMemo.ts の1か所。** 画面はCSS変数で受ける
   * （16進を写すと、片方だけが直る日が来る）。
   */
  it("メモ行の背景に、蛍光黄色の変数が当たる", () => {
    // 打つ面に重ねる目印（#marks）
    expect(html).toContain("#marks .memo-line {");
    // 組んで書く面の段落
    expect(html).toContain("#compose p.memo, #compose div.memo {");
    // どちらも同じ変数から取る
    const uses = html.match(/var\(--novelai-memo-marker/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    // 予備の値も、core/sceneMemo.ts の蛍光黄色と同じもの
    expect(html).toContain(MEMO_MARKER_COLOR.light);
  });

  /**
   * **タグの色は行頭の小さな丸だけ**（作者の指示、2026-08-29）。
   * 背景はタグによらず蛍光黄色で揃える——作者が求めているのは
   * 「メモの場所が一目で分かる」ことである。
   */
  it("タグの色は行頭の丸で出す（背景は種類で変えない）", () => {
    expect(html).toContain("#compose .memo::before {");
    expect(html).toContain(
      "#compose .memo-todo::before { background: var(--novelai-memo-todo"
    );
    // 種類ごとの背景（塗り分け）は作らない
    expect(html).not.toContain(".memo-todo { background:");
  });

  /** 縦書きでも、丸は行の頭（上）に付く */
  it("縦書きでは、丸を行の上へ回す", () => {
    expect(html).toContain("body.vertical #compose .memo::before {");
  });

  /** 長いメモは行内で読み切れない。載せたら全文をチップに出す */
  it("メモの行に載せると、チップに全文が出る", () => {
    expect(code).toContain("function memoElementAt(");
    expect(code).toContain('fillTip(parts.tag, "memo", parts.text');
    expect(code).toContain('memo: "シーンメモ"');
  });

  it("右クリックの品書きに、メモを足す・横に開くがある", () => {
    expect(code).toContain("ここにメモを足す");
    expect(code).toContain("シーンメモを横に開く");
    expect(code).toContain('type: "addMemo", line: menuCaretLine()');
    expect(code).toContain('type: "openMemos"');
  });

  /**
   * カーソルの追従（設計書6.40.4）。**打鍵ごとには送らない。**
   * パネルは受けて光らせるだけの片方向である。
   */
  it("カーソルの位置は、まとめてから知らせる", () => {
    expect(code).toContain('type: "caret", line: line');
    const notify = code.slice(code.indexOf("function notifyCaret("));
    expect(notify.slice(0, 500)).toContain("}, 200);");
    // 同じ行に居るあいだは送らない
    expect(notify.slice(0, 500)).toContain("line === lastCaretLine");
  });
});

/**
 * 読み上げ（音読推敲。設計書6.42）。
 *
 * 声は OS のもの（Web Speech API）で、AIもネットワークも使わない。
 * **確かめるのは「原稿に触らないこと」と「使えないときに黙らないこと」**
 * ——声が出るかどうかは実機でしか分からない。
 */
describe("読み上げ", () => {
  const code = html.slice(html.indexOf("<script"));

  it("道具箱に入口があり、読み上げの列が出る", () => {
    expect(html).toContain('id="aloudToggle"');
    expect(html).toContain('<div id="aloud">');
    expect(html).toContain("body.aloud #aloud { display: flex; }");
  });

  it("列のボタンが揃っている", () => {
    expect(html).toContain("▶ 読む");
    expect(html).toContain("■ 終える");
    expect(html).toContain("⚑ 引っかかった");
    // 速さと声は選ぶもの
    expect(html).toContain('id="aloudRate"');
    expect(html).toContain('id="aloudVoice"');
  });

  /** 一時停止と再開は、同じボタンの文言で示す */
  it("読んでいる最中は、止める・続けるに変わる", () => {
    expect(code).toContain('aloudPlay.textContent = "❚❚ 止める"');
    expect(code).toContain('aloudPlay.textContent = "▶ 続ける"');
  });

  /**
   * 読んでいる文は、組んで書く面では CSS Custom Highlight API で光らせる
   * （DOMを変えないので、カーソルも取り消し履歴も動かない。設計書6.34.3）。
   */
  it("読んでいる文の色が、用語と別の名前で定義されている", () => {
    expect(html).toContain("::highlight(novelai-reading) {");
    expect(code).toContain('CSS.highlights.set("novelai-reading"');
    expect(code).toContain('CSS.highlights.delete("novelai-reading")');
  });

  /**
   * **打つ面では、選択とカーソルに触らない**（レビュー指摘、2026-08-29）。
   *
   * textarea の選択は「次に打った字が置き換える範囲」である。読み上げ中に
   * うっかり空白を打つと、**一文がまるごと空白1字に置き換わる**——原稿が
   * 壊れる。焦点を動かすのも駄目で、selectionchange が飛んで
   * カーソルの記憶（lastCaret）が読み上げ位置へずれ、あとの
   * 「ここにメモを足す」が作者の居た場所に刺さらない。
   */
  it("打つ面の追従で、選択とカーソルに触らない", () => {
    const block = code.slice(code.indexOf("const aloudToggle"));
    // 注釈の中の言及は数えない（なぜ触らないのかは注釈が説明している）
    const statements = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("*") && !line.startsWith("//"))
      .join("\n");

    expect(statements).not.toContain("setSelectionRange");
    expect(statements).not.toContain("write.focus()");
    expect(statements).not.toContain("write.blur()");

    // 代わりに、用語の重ね敷きと同じ手で背景だけを塗る
    expect(html).toContain('<div id="aloudmarks" aria-hidden="true"></div>');
    expect(html).toContain("#aloudmarks .mark-reading {");
    expect(block).toContain('span.className = "mark-reading"');
    // 画面の外なら、はみ出したぶんだけ転がす（焦点は動かさない）
    expect(block).toContain("offRect(write, rect)");
    expect(block).toContain("write.scrollTop += off.top");
  });

  /**
   * 塗りの層は、打つ面の**下**に敷く（上に置くと背景が字を覆う）。
   * 枠合わせと転がしは用語の重ね敷きと一緒に行う（別々だとずれる）。
   */
  it("塗りの層は、用語の重ね敷きと同じ枠・同じ位置で動く", () => {
    // DOM の並びで textarea より前（＝下に敷かれる）
    expect(html.indexOf('id="aloudmarks"')).toBeLessThan(
      html.indexOf('<textarea id="write"')
    );
    // 縦書き・組んで書く面・共通の寸法のどれにも入っている
    expect(html).toContain("#write, #marks, #compose, #aloudmarks {");
    expect(html).toContain("body.vertical #compose, body.vertical #aloudmarks {");
    expect(html).toContain("body.compose #aloudmarks { display: none; }");

    const sync = code.slice(code.indexOf("function syncMarksScroll()"));
    expect(sync.slice(0, 400)).toContain("aloudMarks.scrollTop = write.scrollTop");
    const align = code.slice(code.indexOf("function alignMarksBox()"));
    expect(align.slice(0, 500)).toContain("aloudMarks.style.right = right");
  });

  /** 列のぶんだけ本文の面が縮む。折り返し幅が変わるので測り直す */
  it("列の開け閉めで、重ね敷きの枠を測り直す", () => {
    const open = code.slice(code.indexOf("function aloudOpenRow()"));
    expect(open.slice(0, 500)).toContain("scheduleAlignMarks()");
  });

  /**
   * **使えないときは、消さずに押せなくして理由を出す**
   * （core/processAvailability.ts と同じ考え方）。
   */
  it("使えないときの理由が2つとも入っている", () => {
    expect(code).toContain("この環境では読み上げが使えません");
    expect(code).toContain("日本語の声が見つかりません");
    expect(code).toContain("音声を追加 で日本語を入れると使えます");
    // 消さずに押せなくする
    expect(code).toContain("aloudPlay.disabled = !ready");
    expect(html).toContain("button:disabled { opacity: 0.45; cursor: default; }");
  });

  /** 英語の声へ日本語を渡すと、仮名を1字ずつ綴るか、音にならない */
  it("日本語の声だけを一覧に出す", () => {
    expect(code).toContain('lang.indexOf("ja") === 0');
    // 一覧は非同期に揃う。開いた直後の空だけを見て決めない
    expect(code).toContain('"voiceschanged"');
  });

  /**
   * **原稿に触るのは、シーンメモの1行を挿すときだけ。**
   * 声へ渡す文字列は原文の写しで、本文には戻らない。
   */
  it("本文へ書くのは readingMark だけ", () => {
    const block = code.slice(code.indexOf("const aloudToggle"));
    expect(block).toContain('type: "readingMark", line: aloudPlan[aloudAt].line');
    // 読み上げの仕掛けからは、本文の書き換え（edit）を送らない
    expect(block).not.toContain('type: "edit"');
  });

  /**
   * `cancel()` は Chromium で onerror(interrupted) を起こす。
   * **呼ぶ場所が増えるほど、自分で止めたのか壊れたのかが分からなくなる**ので、
   * 1つの包み関数（aloudCancel）へ集める。終える・飛ぶ・一時停止は
   * すべてそこを通る。
   */
  it("speechSynthesis.cancel を呼ぶのは、包み関数の1か所だけ", () => {
    // 注釈の中の言及は数えない（なぜ1か所なのかは注釈が説明している）
    const calls = code
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("*") && !line.startsWith("//"))
      .filter((line) => line.includes("speechSynthesis.cancel("));
    expect(calls).toHaveLength(1);

    // 3つの経路が、その包み関数を通る
    const wrapper = code.slice(code.indexOf("function aloudCancel()"));
    expect(wrapper.slice(0, 700)).toContain("speechSynthesis.cancel()");
    for (const name of ["aloudFinish", "aloudJump", "aloudPause"]) {
      const body = code.slice(code.indexOf("function " + name + "("));
      expect(body.slice(0, 600), name).toContain("aloudCancel();");
    }

    // 自分で止めたぶんは、理由の欄に出さない
    expect(code).toContain('kind === "interrupted" || kind === "canceled"');
  });

  /**
   * **pause()／resume() は使わない**（設計書6.42）。Windows の Chromium は
   * 端末に入っている声（SAPI）で pause() が効かないことがあり、押しても
   * 声が止まらない。止めるのは cancel()、続けるのはその文の頭から。
   */
  it("一時停止は cancel で行い、続けるときは同じ文の頭から読み直す", () => {
    expect(code).not.toContain("speechSynthesis.pause(");
    expect(code).not.toContain("speechSynthesis.resume(");
    const resume = code.slice(code.indexOf("function aloudResume()"));
    expect(resume.slice(0, 400)).toContain("aloudSpeakSoon(aloudAt)");
  });

  /**
   * cancel() の直後に speak() を呼ぶと、新しい声が出ないことがある
   * （Chromium の癖）。**60ミリ秒置いてから積む。**
   * 待っている間にもう一度飛んだら、古い予約は黙って引き返す（世代番号）。
   */
  it("読み始めは60ミリ秒遅らせ、古い予約は世代で打ち消す", () => {
    const soon = code.slice(code.indexOf("function aloudSpeakSoon(index)"));
    expect(soon.slice(0, 500)).toContain("}, 60);");
    expect(soon.slice(0, 500)).toContain("if (generation !== aloudGeneration) return;");
    // 世代を進めるのは、止めるところ（＝包み関数）だけ
    const wrapper = code.slice(code.indexOf("function aloudCancel()"));
    expect(wrapper.slice(0, 700)).toContain("aloudGeneration++");
    expect([...code.matchAll(/aloudGeneration\+\+/g)]).toHaveLength(1);
  });

  /**
   * 詳細メニューの「原稿を読み上げる」からは、**列を出すだけ**。
   * 声の一覧が揃う前に読み始めないため（押すのは作者である）。
   */
  it("showReading は列を出すだけで、読み始めない", () => {
    expect(code).toContain('message.type === "showReading"');
    const open = code.slice(code.indexOf("function aloudOpenRow()"));
    const body = open.slice(0, open.indexOf("\n  }"));
    expect(body).toContain('document.body.classList.add("aloud")');
    expect(body).toContain("aloudLoadVoices()");
    // 自動では読み始めない
    expect(body).not.toContain("aloudStart()");
    expect(body).not.toContain("aloudJump(");
  });

  /**
   * 計画は拡張機能側が作る（core/readAloud.ts）。**画面に写しを置かない。**
   * 送る本文は、画面が持っているものそのもの（向こうの文書は120ミリ秒遅れる）。
   */
  it("文へ割るのは拡張機能側に頼む", () => {
    expect(code).toContain('type: "readingPlan", text: aloudTextNow()');
    expect(code).toContain('message.type === "readingPlan"');
    // 面によって本文の出どころが違う
    expect(code).toContain("composeOn ? composeDomToNotation(compose) : write.value");
  });

  /** 切り替えの最中に声だけが続くと、止め方の無い幽霊になる */
  it("向き・面・画面を離れたら止める", () => {
    const dir = code.slice(code.indexOf('dirButton.addEventListener("click"'));
    expect(dir.slice(0, 400)).toContain("aloudFinish()");
    expect(code).toContain('document.addEventListener("visibilitychange"');
    expect(code).toContain('window.addEventListener("pagehide"');
  });

  /**
   * 頼んでから返るまでに打たれると、届いた位置は1文字ずつずれている。
   * **ずれた場所を光らせるくらいなら、光らせない**（レビュー指摘、2026-08-29）。
   */
  it("頼んだときと本文の長さが違えば、届いた計画を捨てる", () => {
    const take = code.slice(code.indexOf("function aloudTakePlan(message)"));
    expect(take.slice(0, 900)).toContain(
      "message.textLength !== aloudTextNow().length"
    );
    // 捨てたぶんは、次の update で頼み直される（読み始めの予約も残す）
    expect(code).toContain("if (aloudOn || aloudStartAt !== null) aloudAskPlan();");
  });

  /**
   * 前の文を消すと添字が1つ手前へずれる。前だけを探すと、同じ言い回しの
   * 後ろの文に当たって**あいだを飛ばす**（レビュー指摘、2026-08-29）。
   */
  it("取り直した計画では、前の添字から外向きに同じ文を探す", () => {
    const same = code.slice(code.indexOf("function aloudSameSentence()"));
    const body = same.slice(0, same.indexOf("\n  }"));
    expect(body).toContain("const back = from - step;");
    expect(body).toContain("const forward = from + step;");
    // 後ろだけを見る形（前の添字以降で最初）に戻っていないこと
    expect(body).not.toContain("for (let i = from; i < aloudPlan.length; i++)");
  });

  /** 連打すると、1つ上の行にもう1枚メモが刺さる */
  it("引っかかったは、次の計画が届くまで押せない", () => {
    expect(code).toContain("aloudMark.disabled = !ready || !aloudOn || aloudMarking");
    expect(code).toContain("aloudMarking = true;");
    const take = code.slice(code.indexOf("function aloudTakePlan(message)"));
    expect(take.slice(0, 900)).toContain("aloudMarking = false;");
  });

  /** 終えたあとに古い断りが残っていると、次に読み始めたときに出たままになる */
  it("終えたら、前に起きたことの理由も消す", () => {
    const finish = code.slice(code.indexOf("function aloudFinish()"));
    expect(finish.slice(0, 700)).toContain('aloudProblem = "";');
  });

  /** 設定は 0.5〜2.0。列の選択肢がその範囲を覆っていないと、選べない速さが出る */
  it("速さの選択肢が、設定の範囲を端まで覆う", () => {
    for (const value of ["0.5", "0.7", "0.85", "1", "1.15", "1.3", "1.5", "2"]) {
      expect(html, value).toContain('<option value="' + value + '">');
    }
  });

  /** 速さはその場限り。設定へ書き戻すと、日によって変える使い方ができない */
  it("速さは設定へ書き戻さない", () => {
    const block = code.slice(code.indexOf("const aloudToggle"));
    expect(block).toContain("aloudRateTouched = true");
    expect(block).not.toContain('type: "config"');
    // 声だけは覚える（端末ごと）
    expect(block).toContain('type: "readingVoice", name: aloudVoiceName');
  });
});

/**
 * 画面のJSは、外側のテンプレート文字列の中にある（設計書6.25）。
 *
 * **バッククォートを1つ書くと、そこでテンプレートが閉じて画面が壊れる。**
 * 文字列の連結は `+` で書くこと。
 */
describe("画面のJSの書き方", () => {
  it("スクリプトの中にバッククォートが無い", () => {
    const found = html.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
    expect(found, "スクリプトが見つからない").toBeTruthy();
    expect(found![1].includes("`")).toBe(false);
  });
});
