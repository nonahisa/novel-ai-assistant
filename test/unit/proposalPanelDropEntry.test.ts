import { describe, expect, test } from "vitest";
import { buildProposalPanelHtml } from "../../src/views/proposalPanelHtml";

/**
 * 更新案の中の1つだけに ✕ を出す（作者の依頼、2026-09-12）。
 *
 * 「呼称にハヤブサ先生があり、これが間違いです。この画面でここだけ
 * 消したりできないでしょうか？」
 *
 * 描画は WebView の中で動くので、組み上がったHTMLから関数を取り出して
 * **実際に走らせて**確かめる（`proposalPanelButtonSets.test.ts` と同じ手口）。
 */

const html = buildProposalPanelHtml("test-nonce", "vscode-webview:");

/** WebView のスクリプトから、中括弧の対応を数えて1つ切り出す */
function extractFunction(source: string, name: string): string {
  const head = source.indexOf("function " + name + "(");
  expect(head, name + " が見つからない").toBeGreaterThanOrEqual(0);
  let depth = 0;
  let started = false;
  for (let i = head; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
      started = true;
    } else if (source[i] === "}") {
      depth--;
      if (started && depth === 0) return source.slice(head, i + 1);
    }
  }
  throw new Error(name + " の終わりが見つからない");
}

/** 1行の const 宣言をそのまま切り出す */
function extractConst(source: string, name: string): string {
  const head = source.indexOf("const " + name + " =");
  expect(head, name + " が見つからない").toBeGreaterThanOrEqual(0);
  return source.slice(head, source.indexOf(";", head) + 1);
}

type Render = (item: unknown) => string;

const loaded = ((): {
  renderRecordUpdate: Render;
  droppedEntries: Map<string, Set<string>>;
} => {
  const body = [
    extractConst(html, "droppedEntries"),
    extractFunction(html, "escapeHtml"),
    extractFunction(html, "diffSide"),
    extractFunction(html, "dropSetOf"),
    extractFunction(html, "renderEntries"),
    extractFunction(html, "renderRecordChanges"),
    extractFunction(html, "canApplyRecordUpdate"),
    extractFunction(html, "doneLabel"),
    extractFunction(html, "renderRecordUpdate"),
    "return { renderRecordUpdate: renderRecordUpdate, droppedEntries: droppedEntries };",
  ].join("\n");
  return new Function(body)() as {
    renderRecordUpdate: Render;
    droppedEntries: Map<string, Set<string>>;
  };
})();

const { renderRecordUpdate, droppedEntries } = loaded;

function entry(key: string, text: string, state: string) {
  return { key, text, state };
}

/** 呼称の更新案。「ハヤブサ先生」だけが間違っている、作者の実例 */
function addressUpdate(extra: Record<string, unknown> = {}) {
  return {
    id: "pending-1",
    name: "中神隼人",
    status: "pending",
    changes: [],
    changeParts: [
      {
        label: "呼称",
        before: "中神隼人→センパイ",
        after: "中神隼人→ハヤブサ先生・先生・センパイ",
        diff: [],
        entries: [
          entry("address:中神隼人:ハヤブサ先生", "中神隼人→ハヤブサ先生", "added"),
          entry("address:中神隼人:先生", "中神隼人→先生", "added"),
          entry("address:中神隼人:センパイ", "中神隼人→センパイ", "kept"),
          entry("address:中神隼人:隼人", "中神隼人→隼人", "removed"),
        ],
      },
    ],
    ...extra,
  };
}

/** 葉に分かれない項目（今までどおりの塗り分け） */
function summaryUpdate() {
  return {
    id: "pending-2",
    name: "灯",
    status: "pending",
    changes: [],
    changeParts: [
      { label: "紹介", before: "高校生", after: "転校生", diff: [] },
    ],
  };
}

/** 描いたHTMLから、押せる ✕ の鍵を拾う */
function dropKeysOf(item: unknown): string[] {
  return [
    ...renderRecordUpdate(item).matchAll(
      /data-action="dropEntry"[^>]*data-key="([^"]*)"/g
    ),
  ].map((found) => found[1]);
}

describe("✕ は「足される値」にだけ出す", () => {
  test("added の葉にだけ ✕ が付く", () => {
    droppedEntries.clear();

    // **消える値を引き止める話は別**（今回は追加の取りやめだけ）。
    // removed・kept に ✕ を出すと、押しても何も起きない
    expect(dropKeysOf(addressUpdate())).toEqual([
      "address:中神隼人:ハヤブサ先生",
      "address:中神隼人:先生",
    ]);
  });

  test("葉のある項目は、更新案の側を1つずつ並べる", () => {
    droppedEntries.clear();
    const rendered = renderRecordUpdate(addressUpdate());

    expect(rendered).toContain("中神隼人→ハヤブサ先生");
    expect(rendered).toContain("中神隼人→センパイ");
    expect(rendered).toContain("中神隼人→隼人");
  });

  test("葉の無い項目には ✕ を出さない", () => {
    droppedEntries.clear();

    expect(dropKeysOf(summaryUpdate())).toEqual([]);
    expect(renderRecordUpdate(summaryUpdate())).toContain("転校生");
  });
});

describe("印を付けた葉には取り消し線を引く", () => {
  test("落とす印の付いた葉だけが dropped になる", () => {
    droppedEntries.clear();
    droppedEntries.set("pending-1", new Set(["address:中神隼人:ハヤブサ先生"]));

    const rendered = renderRecordUpdate(addressUpdate());
    const leaves = [
      ...rendered.matchAll(/<span class="entry ([^"]*)">([^<]*)/g),
    ].map((found) => [found[1], found[2]]);

    expect(leaves).toContainEqual([
      "added dropped",
      "中神隼人→ハヤブサ先生",
    ]);
    expect(leaves).toContainEqual(["added", "中神隼人→先生"]);
  });

  test("取り消し線はCSSで引く", () => {
    expect(html).toContain(".entry.dropped");
    expect(html).toContain("text-decoration: line-through");
  });
});

describe("全部に印を付けたら反映は押せない", () => {
  test("added が1つでも残っていれば押せる", () => {
    droppedEntries.clear();
    droppedEntries.set("pending-1", new Set(["address:中神隼人:ハヤブサ先生"]));

    const rendered = renderRecordUpdate(addressUpdate());
    expect(rendered).toContain('data-action="apply"');
    expect(rendered).not.toMatch(/data-action="apply"[^>]*disabled/);
  });

  test("added を全部落とすと押せなくなる", () => {
    // 何も足さない反映は、見送ると同じ
    droppedEntries.clear();
    droppedEntries.set(
      "pending-1",
      new Set(["address:中神隼人:ハヤブサ先生", "address:中神隼人:先生"])
    );

    expect(renderRecordUpdate(addressUpdate())).toMatch(
      /data-action="apply"[^>]*disabled/
    );
  });

  test("葉に分かれない項目だけの更新は、いつでも押せる", () => {
    droppedEntries.clear();

    expect(renderRecordUpdate(summaryUpdate())).not.toMatch(
      /data-action="apply"[^>]*disabled/
    );
  });
});

describe("落とす印は、反映を押すまで送らない", () => {
  test("✕ は画面の中だけで処理し、反映のときに鍵を添える", () => {
    // 押すたびに送ると、まだ何も決めていないうちに書き換わる
    expect(html).toContain("toggleDrop(");
    expect(html).toContain("dropKeys:");
  });
});
