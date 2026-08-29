import { describe, expect, test } from "vitest";
import { buildNameEntries } from "../../src/features/nameCheck";
import {
  describeRenameRecordsResult,
  pendingRenameKey,
  type PendingRename,
  type RenameRecordsResult,
} from "../../src/features/nameRename";
import { buildNameCheckPanelHtml } from "../../src/views/nameCheckPanelHtml";
import { findNameCollisions } from "../../src/core/nameCollision";

const HTML = buildNameCheckPanelHtml("test-nonce", "vscode-webview:");

function record(id: string, name: string) {
  return { id, name, reading: null, aliases: [] as string[] };
}

describe("画面へ渡す名前の一覧", () => {
  test("種別ごとに正しい印を付ける", () => {
    const entries = buildNameEntries({
      characters: [{ id: "c1", name: "アリア", reading: "ありあ", aliases: [] }],
      abilities: [record("ab1", "アリサの剣")],
      locations: [record("lo1", "アリサ")],
      organizations: [record("or1", "アリサ団")],
    });
    expect(entries.map((entry) => entry.kind)).toEqual([
      "character",
      "ability",
      "location",
      "organization",
    ]);
  });

  test("名前の空いたレコードは渡さない", () => {
    // AIの抽出が名前「null」の組織を作った実績がある
    const entries = buildNameEntries({
      characters: [],
      abilities: [],
      locations: [record("lo1", "  ")],
      organizations: [],
    });
    expect(entries).toHaveLength(0);
  });

  test("人物以外も衝突の相手になる", () => {
    // 地名と人名が同じ響きなら、読者はやはり取り違える
    const entries = buildNameEntries({
      characters: [{ id: "c1", name: "アリア", reading: null, aliases: [] }],
      abilities: [],
      locations: [record("lo1", "アリサ")],
      organizations: [],
    });
    const result = findNameCollisions(entries);
    expect(result.collisions).toHaveLength(1);
    // 人物以外が相手なので1段弱い
    expect(result.collisions[0].strength).toBe("weak");
  });
});

describe("待っている付け替え", () => {
  test("鍵は作品ごとに分ける", () => {
    // 書庫では複数の作品を並行して直す
    expect(pendingRenameKey("work-1")).not.toBe(pendingRenameKey("work-2"));
    expect(pendingRenameKey("work-1")).toContain("work-1");
  });
});

describe("資料へ反映した結果の伝え方", () => {
  const pending: PendingRename = {
    characterId: "char_001",
    oldName: "マルキオ",
    newName: "レオン",
    newReading: "れおん",
    mapping: [],
    createdAt: "2026-08-29T00:00:00.000Z",
  };
  const empty: RenameRecordsResult = {
    characterUpdated: false,
    settingsUpdated: 0,
    plotUpdated: false,
    synopsisDocUpdated: false,
    chapterSynopsesUpdated: 0,
    foreshadowsUpdated: 0,
    failures: [],
  };

  test("直したところを並べる", () => {
    const text = describeRenameRecordsResult(pending, {
      ...empty,
      characterUpdated: true,
      settingsUpdated: 2,
      plotUpdated: true,
      foreshadowsUpdated: 1,
    });
    expect(text).toContain("マルキオ");
    expect(text).toContain("レオン");
    expect(text).toContain("他の資料 2件");
    expect(text).toContain("プロット");
    expect(text).toContain("伏線 1件");
  });

  test("0件のときこそ理由を出す", () => {
    // パネルが空のままだと、作者は壊れていると受け取る
    const text = describeRenameRecordsResult(pending, empty);
    expect(text).toContain("直すところがありませんでした");
  });

  test("直せなかったものを黙って飲み込まない", () => {
    const text = describeRenameRecordsResult(pending, {
      ...empty,
      characterUpdated: true,
      failures: ["伏線台帳：書き込めませんでした"],
    });
    expect(text).toContain("1件は直せませんでした");
    expect(text).toContain("伏線台帳");
  });
});

describe("点検画面のHTML", () => {
  test("CSPとnonceが入っている", () => {
    expect(HTML).toContain("Content-Security-Policy");
    expect(HTML).toContain("script-src 'nonce-test-nonce'");
    expect(HTML).toContain("default-src 'none'");
  });

  test("外部のライブラリを読み込まない", () => {
    // WebViewは既定で外部への通信を禁じている。同梱してCSPを緩めない
    expect(HTML).not.toContain("http://");
    expect(HTML).not.toContain("https://");
  });

  test("WebViewのスクリプトにバッククォートを書かない", () => {
    // HTML全体がテンプレート文字列なので、中に置くと組み立てが壊れる
    const script = HTML.slice(HTML.indexOf("<script"), HTML.indexOf("</script>"));
    expect(script).not.toContain("`");
  });

  test("押せる3つの口がある", () => {
    expect(HTML).toContain("data-suggest");
    expect(HTML).toContain("data-rename");
    expect(HTML).toContain("data-places");
  });

  test("AIを使う操作にだけ印を出す", () => {
    // 判定はAIを使わない。押す前に見分けられないと、料金の話が伝わらない
    expect(HTML).toContain("候補を出す（AI）");
    expect(HTML).toContain("「候補を出す（AI）」だけがAIを使います");
  });

  test("読みが無い名前は、見ていないと断る", () => {
    expect(HTML).toContain("読みが無いので見ていない名前");
  });

  test("落とした候補も出す", () => {
    // 黙って減らすと、10件頼んだのに6件しか出ないのが不具合に見える
    expect(HTML).toContain("落としました");
  });

  test("何も書き換わらないことを画面に書く", () => {
    expect(HTML).toContain("更新");
  });
});
