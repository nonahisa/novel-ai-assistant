import { describe, expect, it } from "vitest";
import { buildSceneMemoPanelHtml } from "../../../src/views/sceneMemoPanelHtml";

/**
 * ［AIに相談］の答えを、押した指摘の行のすぐ下に出す（P-47。作者の報告
 * 2026-10-05「表示される位置が離れすぎています。パネル内に表示するか…」）。
 *
 * 画面の関数（`renderRow`・`renderAdvice`）を切り出して実際に組ませ、
 * 出てくるHTMLを見る（文字列の有無だけでは並び順が分からない）。
 */

const html = buildSceneMemoPanelHtml("NONCE123", "vscode-resource:");
const script = html.slice(html.indexOf("<script"), html.indexOf("</script>"));

function sliceFn(name: string, next: string): string {
  const start = script.indexOf(`function ${name}(`);
  const end = script.indexOf(`function ${next}(`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

function makeRenderRow(): (row: Record<string, unknown>) => string {
  const escape = sliceFn("escapeHtml", "sendFilter").split("el.prev.addEventListener")[0];
  const source = [
    escape,
    sliceFn("renderActions", "renderAdvice"),
    sliceFn("renderAdvice", "renderRow"),
    sliceFn("renderRow", "render"),
  ].join("\n");
  // 画面の関数をそのまま組ませる（data は行の光りにだけ使う）
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function("data", `${source}\nreturn renderRow;`) as (data: {
    activeKey: string;
  }) => (row: Record<string, unknown>) => string;
  return make({ activeKey: "" });
}

const baseRow = {
  kind: "finding",
  key: "f:1",
  findingId: "1",
  filePath: "C:/a/001.txt",
  line: 4,
  sameLine: false,
  tag: "推敲",
  tagClass: "finding-proofread",
  text: "視点：ここだけ外から見ています",
  note: "",
  chapterLabel: "第1話",
  title: "",
  fixAction: "reveal",
  canConsult: true,
  canConsultInChat: true,
};

describe("［AIに相談］の答えを行の下に出す", () => {
  const renderRow = makeRenderRow();

  it("助言が無ければ、行の下に何も出さない", () => {
    const out = renderRow({ ...baseRow, advice: null });
    expect(out).not.toContain('class="advice"');
    expect(out).toContain(">AIに相談</button>");
  });

  it("考えている間は「考えています…」と［止める］が、行の中（押し口の列より前）に出る", () => {
    const out = renderRow({ ...baseRow, advice: { status: "thinking" } });
    expect(out).toContain("考えています…");
    expect(out).toContain('data-act="stopAdvice"');
    expect(out.indexOf('class="advice"')).toBeGreaterThan(out.indexOf('class="main"'));
    expect(out.indexOf('class="advice"')).toBeLessThan(out.indexOf('class="acts"'));
  });

  it("答えは引っかかりの1文と言い換え例を並べ、［閉じる］と「相談パネルで続ける」を1つずつ置く", () => {
    const out = renderRow({
      ...baseRow,
      advice: {
        status: "answered",
        point: "ここだけ視点が外へ出ています。",
        examples: [{ from: "見ている彼女を", to: "窓辺の自分を" }],
        noNeed: false,
        cached: false,
      },
    });
    expect(out).toContain("ここだけ視点が外へ出ています。");
    expect(out).toContain("「見ている彼女を」</span> → 「窓辺の自分を」");
    expect(out.match(/data-act="closeAdvice"/g)).toHaveLength(1);
    expect(out.match(/data-act="consultInChat"/g)).toHaveLength(1);
    expect(out).toContain(">相談パネルで続ける</button>");
  });

  it("相談パネルへ渡す口が無ければ「相談パネルで続ける」を出さない", () => {
    const out = renderRow({
      ...baseRow,
      canConsultInChat: false,
      advice: {
        status: "answered",
        point: "直す必要は薄い。",
        examples: [],
        noNeed: true,
        cached: true,
      },
    });
    expect(out).not.toContain("consultInChat");
    expect(out).toContain('data-act="closeAdvice"');
  });

  it("失敗は理由と［閉じる］だけ", () => {
    const out = renderRow({
      ...baseRow,
      advice: { status: "failed", reason: "AIの答えを読み取れませんでした。" },
    });
    expect(out).toContain("AIの答えを読み取れませんでした。");
    expect(out).toContain('data-act="closeAdvice"');
    expect(out).not.toContain("consultInChat");
  });

  it("AIの答えは逃がしてから組む", () => {
    const out = renderRow({
      ...baseRow,
      advice: {
        status: "answered",
        point: "<b>強調</b>",
        examples: [{ from: "<i>", to: '"x"' }],
        noNeed: false,
        cached: false,
      },
    });
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("<i>");
    expect(out).toContain("&lt;b&gt;");
  });

  it("押した口は、拡張機能へ同じ名前で送る", () => {
    expect(html).toContain(
      'act === "stopAdvice" || act === "closeAdvice" || act === "consultInChat"'
    );
    expect(html).toContain("post(act, { findingId: row.findingId })");
  });
});
