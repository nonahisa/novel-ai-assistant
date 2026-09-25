import { describe, expect, test } from "vitest";
import {
  buildFeatureIndex,
  buildGuideBundles,
} from "../../../src/features/featureGuide";
import { ACTION_TREE, type ActionItem } from "../../../src/views/actionList";

/**
 * 相談で、メニューに出していない操作（ルビ付与など）を、メニューの中に
 * あるかのように案内していた（0.86.10 の担当の報告）。
 *
 * 目次（`buildFeatureIndex`）は、詳細メニューから外した操作
 * （`hiddenFromActionList`）も、外す前の分類・小分類の下に並べていた。
 * AIはそれを写して「詳細メニューの『作品執筆』→『原稿整備』→『ルビ付与』」と
 * 案内する。作者が詳細メニューを開いても、そこには無い。
 *
 * 実際の入口（原稿エディターの上のバー・右クリック、簡単ステップメニュー、
 * 画面の中のボタンなど）と一緒に出す。入口はマニュアルと同じ出どころから導く。
 */

function allActions(): ActionItem[] {
  return ACTION_TREE.flatMap((group) =>
    group.entries.flatMap((entry) => (entry.kind === "section" ? entry.items : [entry]))
  );
}

/** 手元の画面に在って、詳細メニューには出さない操作（旧入口は相談に載せないので除く） */
const hiddenActions = allActions().filter(
  (action) => action.hiddenFromActionList && !action.browserOnly && !action.supersededBy
);

/** 目次の1行に出る名前（補足つき） */
const rendered = (action: ActionItem): string =>
  `${action.label}${action.note ? `（${action.note}）` : ""}`;

const index = buildFeatureIndex();
const HIDDEN_HEADING = "【詳細メニューに無い操作";

describe("目次", () => {
  test("前提：メニューに出さない操作がある（ルビ付与・傍点付与など）", () => {
    expect(hiddenActions.map((action) => action.command)).toEqual(
      expect.arrayContaining(["novelai.addRuby", "novelai.addEmphasis", "novelai.openVertical"])
    );
  });

  test("メニューに出さない操作を、詳細メニューの分類の下に並べない", () => {
    const menuPart = index.split(HIDDEN_HEADING)[0];
    const menuLines = menuPart.split("\n").map((line) => line.trim());
    for (const action of hiddenActions) {
      const name = `・${rendered(action)}`;
      const listed = menuLines.some(
        (line) => line === name || line === `${name}（AIを使う）`
      );
      expect(listed, `詳細メニューの下に並んでいる: ${rendered(action)}`).toBe(false);
    }
  });

  test("メニューに出さない操作は、実際の入口と一緒に名前を出す（名前は欠かさない）", () => {
    expect(index).toContain(HIDDEN_HEADING);
    const hiddenPart = index.split(HIDDEN_HEADING)[1].split("【")[0];
    for (const action of hiddenActions) {
      expect(hiddenPart, `入口の欄に無い: ${rendered(action)}`).toContain(rendered(action));
    }
    // ルビ付与は原稿エディターの中にある（詳細メニューではない）
    const rubyLine = hiddenPart.split("\n").find((line) => line.includes("ルビ付与"));
    expect(rubyLine).toContain("原稿エディター");
  });

  test("詳細メニューに出る操作は、これまでどおり分類の下に並ぶ", () => {
    const menuPart = index.split(HIDDEN_HEADING)[0];
    expect(menuPart).toContain("・誤字脱字検知（AIを使う）");
    expect(menuPart).toContain("■ 作品執筆");
  });
});

describe("説明の束", () => {
  const lines = buildGuideBundles()
    .flatMap((bundle) => bundle.text.split("\n"))
    .map((line) => line.trim());

  test("メニューに出さない操作の説明には、実際の入口と「詳細メニューには無い」を添える", () => {
    for (const action of hiddenActions) {
      // 補足まで含めて探す（「矛盾検知」と「矛盾検知（事実の照合）」は別の操作）
      const line = lines.find((entry) => entry.startsWith(`- ${rendered(action)}`));
      expect(line, `束に無い: ${action.label}`).toBeDefined();
      expect(line, action.label).toContain("詳細メニューには無い");
    }
    const ruby = lines.find((entry) => entry.startsWith("- ルビ付与"));
    expect(ruby).toContain("原稿エディター");
  });

  test("詳細メニューに出る操作の説明には、入口の断りを付けない", () => {
    const typos = lines.find((entry) => entry.startsWith("- 誤字脱字検知"));
    expect(typos).toBeDefined();
    expect(typos).not.toContain("詳細メニューには無い");
  });
});
