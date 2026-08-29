import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../src/views/manuscriptEditorHtml";

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
