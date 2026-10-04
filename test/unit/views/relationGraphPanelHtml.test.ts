import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { TERM_COLORS } from "../../../src/core/termColors";
import { buildRelationGraphPanelHtml } from "../../../src/views/relationGraphPanelHtml";

/**
 * 人物相関図の画面（設計書6.38.4）。
 *
 * 見え方の良し悪しは実機でしか分からない。ここで見るのは
 * 「そもそもHTMLとして出来ているか」と「守るべき約束が入っているか」だけ。
 */

const html = buildRelationGraphPanelHtml("NONCE123", "vscode-resource:");
const script = (() => {
  const found = html.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
})();

describe("人物相関図のHTML", () => {
  it("スクリプトとスタイルにnonceが入っている", () => {
    expect(html).toContain('<style nonce="NONCE123">');
    expect(html).toContain('<script nonce="NONCE123">');
  });

  it("外から何も読み込ませない（CSP）", () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-NONCE123'");
  });

  it("埋め込みの印が残っていない", () => {
    const body = html.slice(html.indexOf("<body"));
    expect(body).not.toContain("${");
  });

  /** WebViewのスクリプトにバッククォートを書かない（この作品の決まり） */
  it("バッククォートが混ざっていない", () => {
    expect(html.includes("`")).toBe(false);
  });

  it("スクリプトがJavaScriptとして読める", () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it("タグの数が合っている", () => {
    const open = [...html.matchAll(/<div\b/g)].length;
    const close = [...html.matchAll(/<\/div>/g)].length;
    expect(open).toBe(close);
  });
});

describe("画面の入口", () => {
  it("2つの図を行き来するボタンがある", () => {
    expect(html).toContain('id="toAll"');
    expect(html).toContain('id="back"');
    expect(html).toContain('id="ring2"');
  });

  it("設定資料とSVG書き出しのボタンがある", () => {
    expect(html).toContain('id="openRecord"');
    expect(html).toContain('id="export"');
  });

  it("絞り込みが4つそろっている", () => {
    // 第N話まで／関係・呼称／所属／名前で探す（設計書6.38.2）
    expect(html).toContain('id="upToChapter"');
    // 下限のつまみは消した（作者の要望、2026-10-02「下限ではなく上限」）
    expect(html).not.toContain('id="minChapters"');
    expect(html).toContain('id="kindRelation"');
    expect(html).toContain('id="kindAddress"');
    expect(html).toContain('id="affiliations"');
    expect(html).toContain('id="search"');
    expect(html).toContain('id="showIsolated"');
  });

  it("材料が無いときの案内は、拡張機能側から受け取る", () => {
    // 文言を画面に焼き込むと、絞り込みで消えた場合と区別できなくなる
    expect(script).toContain("data.emptyMessage");
  });
});

describe("画面は描くだけ", () => {
  /**
   * 図の組み立ても配置も拡張機能側で済ませてある（純粋関数のテストで守る）。
   * 画面で座標を計算し始めると、そこだけ試しようがなくなる。
   */
  it("受け取った座標をそのまま使う", () => {
    expect(script).toContain("data.layout");
    expect(script).not.toContain("buildRelationGraph");
    expect(script).not.toContain("layoutCircle");
  });

  it("関係や呼称を書き換える口が無い", () => {
    // 設計書6.38.5「画面は何も書き換えない」
    expect(script).not.toContain('post("save"');
    expect(script).not.toContain('post("edit"');
  });

  it("押したことは拡張機能へ返す", () => {
    expect(script).toContain('post("center"');
    expect(script).toContain('post("filter"');
    expect(script).toContain('post("export"');
    expect(script).toContain('post("openRecord"');
  });
});

describe("用語の色", () => {
  /**
   * 人物のノードは人物の色、所属の帯は組織の色（設計書6.38.2）。
   * 16進は `core/termColors.ts` にしか無い——写しを作らない。
   */
  it("色は termColors から受け取る", () => {
    const source = fs.readFileSync(
      "src/views/relationGraphPanelHtml.ts",
      "utf8"
    );
    expect(source).toMatch(
      /import \{ TERM_COLORS \} from "\.\.\/core\/termColors";/
    );
    for (const pair of Object.values(TERM_COLORS)) {
      expect(source).not.toContain(pair.light);
      expect(source).not.toContain(pair.dark);
    }
  });

  it("明るいテーマと暗いテーマの両方がある", () => {
    expect(html).toContain(`--novelai-character: ${TERM_COLORS.character.light};`);
    expect(html).toContain(`--novelai-character: ${TERM_COLORS.character.dark};`);
    expect(html).toContain(
      `--novelai-organization: ${TERM_COLORS.organization.light};`
    );
    expect(html).toContain("body.vscode-dark, body.vscode-high-contrast {");
  });

  it("ノードと弧が、その色を引いている", () => {
    expect(html).toContain(".g-node-circle { fill: var(--novelai-character); }");
    expect(html).toContain("stroke: var(--novelai-organization);");
  });
});

/**
 * 図の大きさ（設計書6.38.4）。
 *
 * 設定資料の隣に開くと横幅が半分しか無く、図が小さいまま出ていた
 * （作者の報告、2026-09-10）。**見え方は実機でしか分からない**ので、
 * ここで見るのは「幅だけに合わせる指定に戻っていないか」だけ。
 */
describe("図を、画面ぎりぎりまで大きく出す", () => {
  it("幅と高さの両方に収める指定になっている", () => {
    expect(html).toContain('preserveAspectRatio="xMidYMid meet"');
    const rule = html.slice(html.indexOf("svg {"), html.indexOf("svg {") + 400);
    expect(rule).toContain("width: 100%;");
    expect(rule).toContain("height: 100%;");
    expect(rule).toContain("max-height: 100%;");
    // 横幅にだけ合わせていた頃の指定が残っていないこと
    expect(html).not.toContain("height: auto;");
  });

  /**
   * 2026-10-03 に変えた。以前は最小280画素＋欄のスクロールで小ささを
   * しのいでいたが、右側が欄の外に切れて横スクロールでしか見えなかった
   * （作者の画面）。いまは欄いっぱいに広げ、見せる範囲は viewBox で決める。
   */
  it("欄はスクロールさせず、図を欄いっぱいに広げる", () => {
    expect(html).toContain(
      "#canvas { flex: 1; min-width: 0; overflow: hidden; position: relative; display: flex; }"
    );
    const rule = html.slice(html.indexOf("svg {"), html.indexOf("svg {") + 400);
    expect(rule).toContain("position: absolute;");
    expect(rule).not.toContain("min-width");
    expect(rule).not.toContain("min-height");
  });

  it("配置の幅と高さを、SVGの大きさの属性にしない", () => {
    // 属性で大きさを決めると、CSSの100%と食い違って欄からはみ出す
    expect(script).not.toContain('setAttribute("width", String(layout.width))');
    expect(script).not.toContain('"0 0 " + layout.width');
  });
});

/**
 * 拡大・縮小と移動（設計書6.38.2。作者の要望、2026-10-03「相関図の図を
 * 拡大したい」）。計算そのものは core/relationGraphViewport.ts の単体テストと、
 * 写しの同値テスト（cross/relationGraphViewportCopy.test.ts）が見る。
 * ここで見るのは、画面の操作が計算に結ばれているかだけ。
 */
describe("拡大・縮小と移動", () => {
  it("隅に［－］［＋］［全体を合わせる］がある", () => {
    expect(html).toContain('id="zoomOut"');
    expect(html).toContain('id="zoomIn"');
    expect(html).toContain('id="zoomFit"');
    expect(html).toContain(">全体を合わせる<");
    expect(html).toContain('id="zoomValue"');
  });

  it("Ctrl＋ホイールでマウスの位置を中心に拡大し、既定（VS Code全体の拡大）を止める", () => {
    const at = script.indexOf('el.canvas.addEventListener(\n  "wheel"');
    expect(at).toBeGreaterThan(0);
    const handler = script.slice(at, at + 1400);
    expect(handler).toContain("event.ctrlKey || event.metaKey");
    expect(handler).toContain("event.preventDefault()");
    expect(handler).toContain("wheelZoomFactor(event.deltaY, event.deltaMode)");
    expect(handler).toContain("event.clientX - rect.left");
    expect(handler).toContain("{ passive: false }");
  });

  it("素のホイールは図を動かす", () => {
    const at = script.indexOf('el.canvas.addEventListener(\n  "wheel"');
    const handler = script.slice(at, at + 1400);
    expect(handler).toContain("panViewBox(viewBox, -dx, -dy, canvasSize, contentBox)");
  });

  it("引いただけのときは、点や線を押したことにしない", () => {
    expect(script).toContain("DRAG_THRESHOLD");
    expect(script).toContain("if (drag.moving) dragMoved = true;");
    // 捕獲の段で click を止める（点・線の受け手より先に走る）
    const at = script.indexOf('el.graph.addEventListener(\n  "click"');
    expect(at).toBeGreaterThan(0);
    const handler = script.slice(at, at + 300);
    expect(handler).toContain("event.stopPropagation()");
    expect(handler).toContain("true\n);");
  });

  it("押した直後には捕まえない（ただのクリックを点や線へ届かせる）", () => {
    const down = script.slice(
      script.indexOf('el.graph.addEventListener("pointerdown"'),
      script.indexOf('el.graph.addEventListener("pointermove"')
    );
    expect(down).not.toContain("setPointerCapture");
  });

  it("左ボタンだけで引く（戻る・進むのボタンを取らない）", () => {
    expect(script).toContain("if (event.button !== 0 || !graphShown()) return;");
  });

  it("別の図が届いたら全体を合わせ、同じ図の引き直しでは寄せた所を保つ", () => {
    expect(script).toContain("const key = viewKeyOf(data);");
    expect(script).toContain("followFit = true;");
    const keyOf = script.slice(script.indexOf("function viewKeyOf"), script.indexOf("function viewKeyOf") + 300);
    expect(keyOf).toContain("next.mode");
    expect(keyOf).toContain("next.centerId");
    expect(keyOf).toContain("next.filter");
    expect(keyOf).toContain("next.showSecondRing");
  });

  it("名前で探して描き直しても、見ている範囲を変えない", () => {
    // renderGraph の最後で、追従中でなければ今の範囲をそのまま当て直す
    expect(script).toContain("if (viewBox === null || followFit) {");
  });

  it("欄の大きさが変わったら追従する（「図を広く」もここを通る）", () => {
    expect(script).toContain("new ResizeObserver(");
    expect(script).toContain("resizeViewBox(viewBox, canvasSize, next)");
  });

  it("Ctrl+＋／－／0 を、原稿エディターと同じキーで受ける", () => {
    expect(script).toContain('key === "+" || key === "=" || key === ";" || code === "NumpadAdd"');
    expect(script).toContain('key === "-" || key === "_" || code === "NumpadSubtract"');
    expect(script).toContain('key === "0" || code === "Numpad0"');
  });

  it("書き出すのは図の全体で、拡大中の切り抜きではない", () => {
    const at = script.indexOf("function exportSvg");
    const body = script.slice(at, at + 2400);
    expect(body).toContain('clone.setAttribute("viewBox"');
    expect(body).toContain('clone.setAttribute("width"');
  });
});

describe("脇を畳んで、図を広くする", () => {
  it("畳むボタンがある", () => {
    expect(html).toContain('id="wide"');
    expect(html).toContain("図を広く");
    expect(html).toContain("絞り込みと詳細を出す");
  });

  it("畳むと、左の絞り込みと右の詳細が消える", () => {
    expect(script).toContain("el.filters.hidden = sidesHidden;");
    expect(script).toContain("el.side.hidden = sidesHidden && !sideTemporary;");
  });

  /** 開き直しても保つ（WebViewのstate） */
  it("畳んだことを覚える", () => {
    expect(script).toContain("vscode.setState({ sidesHidden: sidesHidden });");
    expect(script).toContain("vscode.getState()");
  });

  /** 畳んでいても、線を押したら中身は見せる */
  it("線を押したときは、詳細を仮に出す", () => {
    expect(script).toContain("sideTemporary = true;");
  });
});

/**
 * 呼び合い（作者の要望、2026-10-03「人物相関図の説明に呼び合いも必要です」）。
 *
 * 2人が互いを何と呼ぶかを、片方ずつではなく**対**で見せる。片方しか記録が
 * 無いときは、無いことが分かるように書く（黙って1行だけ出すと、もう片方が
 * 抜けているのか、そもそも呼ばないのかが読めない）。
 *
 * 組み立ては画面のスクリプトの中にある（pairs:start〜end）。ここでは
 * その部分を切り出して、そのまま呼んで確かめる。
 */
describe("呼び合いを対で見せる", () => {
  const pairSource = script.slice(
    script.indexOf("/* pairs:start */"),
    script.indexOf("/* pairs:end */")
  );

  interface Label {
    from: string;
    to: string;
    kind: "relation" | "address";
    text: string;
    firstChapter: number | null;
  }
  interface Edge {
    a: string;
    b: string;
    weight: number;
    labels: Label[];
  }
  interface PairApi {
    addressPairRows(
      edge: Edge,
      fromId: string,
      fromName: string,
      toName: string,
      upTo: number | null
    ): string[];
    pairLabel(edge: Edge, fromId: string): string;
  }

  const api = (() => {
    if (pairSource.length === 0) return null;
    return new Function(pairSource + "\nreturn { addressPairRows, pairLabel };")() as PairApi;
  })();

  function label(from: string, to: string, kind: Label["kind"], text: string): Label {
    return { from, to, kind, text, firstChapter: null };
  }

  it("組み立ての区切りがある", () => {
    expect(api).not.toBeNull();
  });

  it("両方向の呼び方を、AはBを／BはAをの対で並べる", () => {
    const edge: Edge = {
      a: "a",
      b: "b",
      weight: 2,
      labels: [label("a", "b", "address", "先生"), label("b", "a", "address", "リナ")],
    };
    expect(api?.addressPairRows(edge, "a", "リナ", "ゲルト", null)).toEqual([
      "リナはゲルトを『先生』と呼ぶ",
      "ゲルトはリナを『リナ』と呼ぶ",
    ]);
    // 向きは渡した人から。逆から見れば逆の順に並ぶ
    expect(api?.addressPairRows(edge, "b", "ゲルト", "リナ", null)).toEqual([
      "ゲルトはリナを『リナ』と呼ぶ",
      "リナはゲルトを『先生』と呼ぶ",
    ]);
  });

  it("片方しか記録が無いときは、無いことを書く", () => {
    const edge: Edge = {
      a: "a",
      b: "b",
      weight: 1,
      labels: [label("a", "b", "address", "先生")],
    };
    expect(api?.addressPairRows(edge, "a", "リナ", "ゲルト", null)).toEqual([
      "リナはゲルトを『先生』と呼ぶ",
      "（ゲルトからの呼び方は記録なし）",
    ]);
  });

  it("第N話までに絞っているときは、その時点で無いと書く", () => {
    const edge: Edge = {
      a: "a",
      b: "b",
      weight: 1,
      labels: [label("b", "a", "address", "お嬢")],
    };
    expect(api?.addressPairRows(edge, "a", "リナ", "ゲルト", 3)).toEqual([
      "（リナからの呼び方は第3話までに記録なし）",
      "ゲルトはリナを『お嬢』と呼ぶ",
    ]);
  });

  it("同じ向きに呼び方が複数あれば、1行にまとめる", () => {
    const edge: Edge = {
      a: "a",
      b: "b",
      weight: 2,
      labels: [label("a", "b", "address", "先生"), label("a", "b", "address", "ゲルトさん")],
    };
    expect(api?.addressPairRows(edge, "a", "リナ", "ゲルト", null)[0]).toBe(
      "リナはゲルトを『先生』『ゲルトさん』と呼ぶ"
    );
  });

  it("関係だけの線では、呼び方が無いと1行で書く", () => {
    const edge: Edge = {
      a: "a",
      b: "b",
      weight: 1,
      labels: [label("a", "b", "relation", "師匠")],
    };
    expect(api?.addressPairRows(edge, "a", "リナ", "ゲルト", null)).toEqual([
      "どちらからの呼び方も記録なし",
    ]);
  });

  it("個人中心図の線のラベルも、渡した人から見た対で書く", () => {
    const edge: Edge = {
      a: "a",
      b: "b",
      weight: 4,
      labels: [
        label("a", "b", "relation", "弟子"),
        label("b", "a", "relation", "師匠"),
        label("a", "b", "address", "先生"),
        label("b", "a", "address", "リナ"),
      ],
    };
    expect(api?.pairLabel(edge, "a")).toBe("→弟子『先生』／←師匠『リナ』");
    expect(api?.pairLabel(edge, "b")).toBe("→師匠『リナ』／←弟子『先生』");
  });

  it("線のラベルでも、片方が空なら記録なしと書く", () => {
    const edge: Edge = {
      a: "a",
      b: "b",
      weight: 1,
      labels: [label("b", "a", "address", "お嬢")],
    };
    expect(api?.pairLabel(edge, "a")).toBe("→（記録なし）／←『お嬢』");
  });

  it("線の詳細は、呼び方を対で出す", () => {
    const side = script.slice(script.indexOf("function renderSide"), script.indexOf("function sideRow"));
    expect(side).toContain("addressPairRows(");
    expect(side).toContain("呼び合い");
  });

  it("「つながっている人」は、中心から見た対で全部を出す", () => {
    expect(script).toContain("pairLabel(entry.edge, data.centerId)");
  });

  /**
   * 関係は名前の下に書き、線の上には書かない（作者の裁定、2026-10-04「関係は人の
   * 名前の下に書く」）。言葉・置き場・揃えは拡張機能側（core/relationGraphLayout.ts の
   * layoutEgo）が決めて渡すので、画面はそれを書くだけ。全部を並べる pairLabel を図に使わない
   */
  it("名前の下には、配置が決めた言葉・位置・揃えをそのまま書き、線の上には書かない", () => {
    const graph = script.slice(script.indexOf("function renderGraph"), script.indexOf("function isProvisional"));
    expect(graph).toContain("caption.textContent = position.caption.text;");
    expect(graph).toContain('"text-anchor": position.caption.anchor');
    expect(graph).not.toContain("g-edge-label");
    expect(graph).not.toContain("pairLabel(");
  });

  it("「つながっている人」に、名前の下に中心から見た関係を書くことを書く", () => {
    const side = script.slice(script.indexOf("function renderSide"), script.indexOf("function sideRow"));
    expect(side).toContain("名前の下に");
    expect(side).toContain("全部はこの一覧か、線を押して読めます");
  });

  /**
   * 置き場の無い人の名前の下は省く（相手30人前後で、どこにも置けない人が出る）。
   * 省いたことを黙らない——数を「つながっている人」の説明に添える
   */
  it("名前の下の文字を省いたときは、その数を「つながっている人」に添える", () => {
    const side = script.slice(script.indexOf("function renderSide"), script.indexOf("function sideRow"));
    expect(side).toContain("data.layout.omittedCaptions");
    expect(side).toContain("人は名前の下の関係を省いています");
    expect(side).not.toContain("omittedEdgeLabels");
  });

  it("「この図について」に、呼び合いの見方がある", () => {
    const side = script.slice(script.indexOf("function renderSide"), script.indexOf("function sideRow"));
    expect(side).toContain("呼び合い");
    expect(side).toContain("記録なし");
  });
});

/**
 * 中心の履歴（設計書6.38.3）と、マウスの戻る・進むボタン
 * （作者の依頼、2026-09-10）。
 *
 * WebView の中では VS Code 本体の割り当てが効かないので、この画面が受ける。
 * **行き先を決めるのは拡張機能側**なので、画面は用件を送るだけである。
 */
describe("戻る・進む", () => {
  it("進むボタンを、戻るの隣に置く", () => {
    expect(html).toContain('id="forward"');
    expect(html).toContain(">進む<");
  });

  it("行き先が無ければ押せない", () => {
    expect(script).toContain("el.back.disabled = !data.canGoBack;");
    expect(script).toContain("el.forward.disabled = !data.canGoForward;");
  });

  /**
   * 押した時点（mousedown）で動かす（2026-10-04、作者の実機確認「マウスの戻るボタンで
   * 反応が欲しいです」。0.45.0 の mouseup では作者の画面で反応しなかった）。
   * VS Code 本体の横のボタンと同じ形。本物の押下で動くことは
   * e2e/relationGraph.test.ts「相関図の上でマウスの戻るボタンを押すと…」が見る
   */
  it("マウスの戻る・進むボタンを、押した時点で履歴に結ぶ", () => {
    const at = script.indexOf('document.addEventListener("mousedown"');
    expect(at).toBeGreaterThan(0);
    const handler = script.slice(at, at + 500);
    expect(handler).toContain("isSideButton(event)");
    expect(handler).toContain("stopSideButton(event)");
    expect(handler).toContain('post(event.button === 3 ? "back" : "forward")');
    expect(script).toContain("return event.button === 3 || event.button === 4;");
    expect(script).toContain("event.preventDefault();");
    expect(script).toContain("event.stopPropagation();");
  });

  /** 同じ押下で mouseup・auxclick も来るので、そちらは既定を止めるだけ（1回押して2つ動かさない） */
  it("離したとき（mouseup・auxclick）は既定を止めるだけで、用件を送らない", () => {
    for (const type of ["mouseup", "auxclick"]) {
      const at = script.indexOf(`document.addEventListener("${type}"`);
      expect(at, type).toBeGreaterThan(0);
      const end = script.indexOf("}, true);", at);
      const handler = script.slice(at, end);
      expect(handler, type).toContain("stopSideButton(event)");
      expect(handler, type).not.toContain("post(");
    }
    // 用件を送るのは mousedown の1か所だけ
    expect(script.split('post(event.button === 3 ? "back" : "forward")')).toHaveLength(2);
  });
});
