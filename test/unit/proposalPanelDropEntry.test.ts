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

interface Loaded {
  renderRecordUpdate: Render;
  droppedEntries: Map<string, Set<string>>;
  /** 「まとめて適用」で送る中身を組む */
  applyAllMessage: () => {
    type: string;
    drops: { id: string; dropKeys: string[] }[];
  };
  /** 済んだレコードの印を片付ける */
  forgetDropsOf: (items: { id: string; status: string }[]) => void;
}

const loaded = ((): Loaded => {
  const body = [
    extractConst(html, "droppedEntries"),
    extractFunction(html, "escapeHtml"),
    extractFunction(html, "diffSide"),
    extractFunction(html, "dropSetOf"),
    extractFunction(html, "forgetDropsOf"),
    extractFunction(html, "applyAllMessage"),
    extractFunction(html, "renderEntries"),
    extractFunction(html, "renderRecordChanges"),
    extractFunction(html, "canApplyRecordUpdate"),
    extractFunction(html, "doneLabel"),
    extractFunction(html, "renderRecordUpdate"),
    "return {" +
      " renderRecordUpdate: renderRecordUpdate," +
      " droppedEntries: droppedEntries," +
      " applyAllMessage: applyAllMessage," +
      " forgetDropsOf: forgetDropsOf };",
  ].join("\n");
  return new Function(body)() as Loaded;
})();

const { renderRecordUpdate, droppedEntries, applyAllMessage, forgetDropsOf } =
  loaded;

function entry(key: string, text: string, state: string) {
  return { key, text, state };
}

/** 呼称の項目。「ハヤブサ先生」だけが間違っている、作者の実例 */
function addressPart() {
  return {
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
  };
}

/** 葉に分かれない項目（登場話の追記のように、1つずつは落とせない） */
function plainPart() {
  return { label: "登場話", before: "1話", after: "1話・2話", diff: [] };
}

/** 呼称の更新案 */
function addressUpdate(extra: Record<string, unknown> = {}) {
  return {
    id: "pending-1",
    name: "中神隼人",
    status: "pending",
    changes: [],
    changeParts: [addressPart()],
    ...extra,
  };
}

/**
 * 呼称の追加と、葉に分かれない「登場話の追記」を併せ持つ更新案。
 *
 * **実際の更新案はたいていこの形である。** 呼称を全部 ✕ にしても、
 * 登場話の追記は入れたい。
 */
function addressWithEpisodeUpdate() {
  return addressUpdate({ changeParts: [addressPart(), plainPart()] });
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

/**
 * 葉に分かれない変更を、道連れにしない（0.50.1）。
 *
 * 更新案は「呼称の追加＋登場話の追記」のように、葉に分かれる項目と
 * 分かれない項目を併せ持つことが多い。呼称を全部 ✕ にしただけで
 * 押せなくなると、**登場話の追記まで見送るしかなくなる。**
 */
describe("葉に分かれない変更が残っていれば、押せる", () => {
  test("呼称を全部 ✕ にしても、登場話の追記があれば押せる", () => {
    droppedEntries.clear();
    droppedEntries.set(
      "pending-1",
      new Set(["address:中神隼人:ハヤブサ先生", "address:中神隼人:先生"])
    );

    expect(renderRecordUpdate(addressWithEpisodeUpdate())).not.toMatch(
      /data-action="apply"[^>]*disabled/
    );
  });

  test("葉だけの更新で、葉が全部 ✕ なら押せない", () => {
    droppedEntries.clear();
    droppedEntries.set(
      "pending-1",
      new Set(["address:中神隼人:ハヤブサ先生", "address:中神隼人:先生"])
    );

    expect(renderRecordUpdate(addressUpdate())).toMatch(
      /data-action="apply"[^>]*disabled/
    );
  });
});

/**
 * 「まとめて適用」も、同じ印を見る（0.50.1）。
 *
 * **黙って意図と違うものが入る形だった。** ✕ を付けたあと「まとめて適用」を
 * 押すと、印が渡らないまま全部反映されていた（CLAUDE.md 規則2に反する）。
 */
describe("まとめて適用も、落とす鍵を添えて送る", () => {
  test("レコードごとに鍵をまとめて送る", () => {
    droppedEntries.clear();
    droppedEntries.set("pending-1", new Set(["address:中神隼人:ハヤブサ先生"]));
    droppedEntries.set("pending-3", new Set(["alias:灯ちゃん", "alias:あかり"]));

    const message = applyAllMessage();

    expect(message.type).toBe("applyAll");
    expect(message.drops).toEqual([
      { id: "pending-1", dropKeys: ["address:中神隼人:ハヤブサ先生"] },
      { id: "pending-3", dropKeys: ["alias:灯ちゃん", "alias:あかり"] },
    ]);
  });

  test("印の無いレコードは添えない", () => {
    droppedEntries.clear();
    // 触っただけで空の集合ができる（dropSetOf）。これを送ると無駄が増える
    droppedEntries.set("pending-2", new Set());

    expect(applyAllMessage().drops).toEqual([]);
  });
});

/**
 * 印を片付ける（0.50.1）。
 *
 * レコードidは承認待ちのファイルパスなので、持ち続けると
 * **同じパスで次の承認待ちができたときに、前の印が残ったまま描かれる。**
 */
describe("反映・見送りが通ったら、印を片付ける", () => {
  test("反映したレコードの印は消える", () => {
    droppedEntries.clear();
    droppedEntries.set("pending-1", new Set(["address:中神隼人:ハヤブサ先生"]));

    forgetDropsOf([{ id: "pending-1", status: "applied" }]);

    expect(droppedEntries.has("pending-1")).toBe(false);
  });

  test("見送ったレコードの印も消える", () => {
    droppedEntries.clear();
    droppedEntries.set("pending-1", new Set(["address:中神隼人:先生"]));

    forgetDropsOf([{ id: "pending-1", status: "dismissed" }]);

    expect(droppedEntries.has("pending-1")).toBe(false);
  });

  test("まだ片付いていないものは、印を残す", () => {
    // 失敗は押し直すことになる。印を付け直させるのは筋が違う
    droppedEntries.clear();
    droppedEntries.set("pending-1", new Set(["address:中神隼人:先生"]));
    droppedEntries.set("pending-2", new Set(["alias:灯ちゃん"]));

    forgetDropsOf([
      { id: "pending-1", status: "failed" },
      { id: "pending-2", status: "pending" },
    ]);

    expect(droppedEntries.has("pending-1")).toBe(true);
    expect(droppedEntries.has("pending-2")).toBe(true);
  });

  test("描き直しのたびに片付ける道が通っている", () => {
    // render から呼んでいないと、画面では何も変わらない
    expect(html).toContain("forgetDropsOf(items)");
  });
});
