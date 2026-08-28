import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../src/views/manuscriptEditorHtml";

/**
 * 並べる面（打つ面と組み上がりの並置）の追いかけ（設計書6.25）。
 *
 * 作者の要望「原稿でルビをルビとして表示する仕組み」の第1段。
 * **打ちながら組み上がりを見続けられる**ことが目的なので、ここでは
 *
 * 1. 打つたびに読む面を全部作り直していないか
 * 2. 打っている行を、読む面が追いかけるか
 * 3. 読み返している最中に引き戻さないか
 *
 * を見る。**見た目そのものは実機でしか確かめられない**ので、
 * 画面の約束（どのしかけが入っているか）を文字列で見張る。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));

/**
 * **画面のJSは、型検査の外にある。** テンプレート文字列の中身なので、
 * 括弧の閉じ忘れ1つでも `tsc` は通り、実機で開いた瞬間に真っ白になる。
 * ここで読めるかどうかだけ確かめる（動かしはしない）。
 */
describe("画面のJS", () => {
  it("構文として読める", () => {
    const source = code.slice(
      code.indexOf(">") + 1,
      code.lastIndexOf("</script>")
    );
    expect(source.length).toBeGreaterThan(1000);
    expect(() => new Function(source)).not.toThrow();
  });
});

describe("読む面は、変わった段落だけ入れ替える", () => {
  it("差分を求めてから当てる", () => {
    expect(code).toContain("function changedRange(");
    expect(code).toContain("function patchRead(");
  });

  /**
   * 4万字の本文では段落が千を超える。並べて打っていると本文は
   * 打った少しあとに毎回届くので、丸ごと入れ直すと手が止まる。
   */
  it("丸ごとの入れ替えは、差分が使えなかったときだけ", () => {
    const assignments = [...code.matchAll(/read\.innerHTML\s*=/g)];
    expect(assignments).toHaveLength(1);
    expect(code).toContain("if (!patchRead(html)) read.innerHTML = html;");
  });

  /** 入れ直すだけでも、読んでいた場所（スクロール）は動いてしまう */
  it("中身が同じときは触らない", () => {
    expect(code).toContain("if (range === null) return true;");
  });

  /** 段落以外が混ざっていたら、細工をせずに丸ごと入れ替える */
  it("想定と違う中身なら、丸ごとの入れ替えへ戻る", () => {
    expect(code).toContain("function allLines(");
    expect(code).toContain("if (!allLines(before) || !allLines(after)) return false;");
  });

  /** 改行を1つ足すと、それ以降の data-line がすべてずれる */
  it("行番号は見比べず、入れ替えたあとで振り直す", () => {
    expect(code).toContain("function renumberLines(");
    expect(code).toContain("if (before.length !== after.length) renumberLines(range.start);");
  });
});

/**
 * 差分の範囲を求めるところだけを取り出して動かす。
 *
 * **画面のJSは webview の中にしか無い**（src/core へ写すと、片方だけが
 * 直る日が来る）。そこで、実際に配られるHTMLから印の間を切り出して
 * 動かす——**試しているのは、そのまま画面へ渡る本物**である。
 */
describe("changedRange（実際に画面へ渡る関数）", () => {
  const source = code.slice(
    code.indexOf("/* changedRange:start */"),
    code.indexOf("/* changedRange:end */")
  );

  it("印で挟んであり、切り出せる", () => {
    expect(source).toContain("function changedRange(");
  });

  const changedRange = new Function(
    source + "\nreturn changedRange;"
  )() as (
    before: string[],
    after: string[]
  ) => { start: number; oldEnd: number; newEnd: number } | null;

  it("同じなら null（触らないのが正しい）", () => {
    expect(changedRange(["あ", "い", "う"], ["あ", "い", "う"])).toBeNull();
    expect(changedRange([], [])).toBeNull();
  });

  it("先頭が一致していれば、そこから先だけ", () => {
    expect(changedRange(["あ", "い"], ["あ", "え"])).toEqual({
      start: 1,
      oldEnd: 2,
      newEnd: 2,
    });
  });

  it("末尾が一致していれば、そこまでだけ", () => {
    expect(changedRange(["い", "う"], ["え", "う"])).toEqual({
      start: 0,
      oldEnd: 1,
      newEnd: 1,
    });
  });

  it("真ん中の1つだけが変わったとき", () => {
    expect(changedRange(["あ", "い", "う"], ["あ", "え", "う"])).toEqual({
      start: 1,
      oldEnd: 2,
      newEnd: 2,
    });
  });

  /** 改行を打った場面。**1つ差し込むだけで済む**ことを確かめる */
  it("行が1つ増えたときは、差し込むだけ", () => {
    expect(changedRange(["あ", "い", "う"], ["あ", "", "い", "う"])).toEqual({
      start: 1,
      oldEnd: 1,
      newEnd: 2,
    });
  });

  it("行が1つ減ったときは、消すだけ", () => {
    expect(changedRange(["あ", "い", "う"], ["あ", "う"])).toEqual({
      start: 1,
      oldEnd: 2,
      newEnd: 1,
    });
  });

  it("全部違うときは、全部", () => {
    expect(changedRange(["あ", "い"], ["か", "き"])).toEqual({
      start: 0,
      oldEnd: 2,
      newEnd: 2,
    });
  });

  it("空から増えたとき", () => {
    expect(changedRange([], ["あ"])).toEqual({
      start: 0,
      oldEnd: 0,
      newEnd: 1,
    });
  });

  it("空になったとき", () => {
    expect(changedRange(["あ"], [])).toEqual({
      start: 0,
      oldEnd: 1,
      newEnd: 0,
    });
  });

  /**
   * **求めた範囲を当てたら、届いたものと同じになるか。**
   *
   * 画面側は「start から oldEnd までを消し、新しい start から newEnd までを
   * そこへ入れる」ことをする（patchRead）。ここでは同じ手順を配列で行う——
   * **番号の取り違えは、読む面の段落が消える・二重になる形で出る**ので、
   * 範囲の意味そのものを確かめておく。
   *
   * DOM そのものは、この環境（DOM実装なし）では動かせない。実機で見る。
   */
  const applyRange = (before: string[], after: string[]): string[] => {
    const range = changedRange(before, after);
    if (range === null) return before.slice();
    const next = before.slice();
    next.splice(
      range.start,
      range.oldEnd - range.start,
      ...after.slice(range.start, range.newEnd)
    );
    return next;
  };

  const cases: Array<[string[], string[]]> = [
    [["あ", "い", "う"], ["あ", "い", "う"]],
    [["あ", "い", "う"], ["あ", "え", "う"]],
    [["あ", "い", "う"], ["あ", "", "い", "う"]],
    [["あ", "い", "う"], ["あ", "う"]],
    [["あ", "い", "う"], ["か", "き", "く", "け"]],
    [["あ", "い", "う"], ["あ", "い", "う", "え"]],
    [["あ", "い", "う", "え"], ["あ", "い", "う"]],
    [[], ["あ", "い"]],
    [["あ", "い"], []],
    [["同", "同", "同"], ["同", "同"]],
    [["同", "同"], ["同", "同", "同"]],
  ];

  it("求めた範囲を当てると、届いたものと同じになる", () => {
    for (const [before, after] of cases) {
      expect(applyRange(before, after)).toEqual(after);
    }
  });
});

describe("打っている行の印", () => {
  it("並べているときだけ出す", () => {
    expect(html).toContain("body.split #read p.line.at-caret");
  });

  /** 縦書きでは行が上から始まるので、線も上へ */
  it("縦書きと横書きの両方に線の向きがある", () => {
    expect(html).toContain("body.vertical.split #read p.line.at-caret");
  });

  /**
   * **背景を塗らない。** 読む面の色は用語の色分けに使っており、
   * そこへ帯を敷くと本文の色が読めなくなる。
   */
  it("背景は塗らない", () => {
    const rules = [...html.matchAll(/p\.line\.at-caret\s*\{[^}]*\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule[0]).not.toContain("background");
    }
  });

  it("印は付け外しできる（外し忘れると2行に付く）", () => {
    expect(code).toContain("function clearCaretMark(");
    expect(code).toContain("function markCaretLine(");
  });
});

describe("組み上がりが、打っている行を追いかける", () => {
  it("カーソルの動きを聞いている", () => {
    expect(code).toContain('document.addEventListener("selectionchange"');
  });

  /** 変換の途中で画面が動くと、変換している文字を目で追えなくなる */
  it("変換中は追いかけない", () => {
    const listener = code.slice(
      code.indexOf('document.addEventListener("selectionchange"')
    );
    expect(listener.slice(0, 260)).toContain("if (composing) return;");
    const sync = code.slice(code.indexOf("function runSync("));
    expect(sync.slice(0, 400)).toContain("if (composing) return;");
  });

  /** 打鍵のたびに何度も呼ばれるので、1フレームに1回へまとめる */
  it("追いかけは1フレームに1回へまとめる", () => {
    expect(code).toContain("function scheduleSync(");
    expect(code).toContain("requestAnimationFrame");
  });

  /** 1行動くたびに画面が真ん中まで動くと、目が付いていけない */
  it("中央には寄せず、はみ出したぶんだけ動かす", () => {
    expect(code).toContain("function nudgeIntoView(");
    expect(code).not.toContain('block: "center"');
  });

  /** 打つ面の scroll に合わせる。逆（読む→書く）は繋がない */
  it("合わせるのは、書く面から読む面への一方向だけ", () => {
    expect(code).toContain("keepPlace(write, read)");
    expect(code).not.toContain("keepPlace(read, write)");
  });
});

describe("読み返している最中は、引き戻さない", () => {
  it("読む面へ手を出したら、しばらく眠る", () => {
    expect(code).toContain("FOLLOW_SLEEP_MS");
    expect(code).toContain('read.addEventListener("wheel", sleepFollow');
    expect(code).toContain('read.addEventListener("mousedown", sleepFollow');
  });

  /** 追いかけで動かしたぶんも scroll として届くので、合図には使わない */
  it("眠る合図に、読む面の scroll は使わない", () => {
    const listener = code.slice(
      code.indexOf('read.addEventListener("scroll"')
    );
    expect(listener.slice(0, 200)).not.toContain("sleep");
  });

  /** カーソルが行をまたいだら、また書きはじめた合図 */
  it("行をまたいだら起きる", () => {
    expect(code).toContain("function following(");
    expect(code).toContain("if (line !== sleepLine)");
    expect(code).toContain("function wakeFollow(");
  });
});
