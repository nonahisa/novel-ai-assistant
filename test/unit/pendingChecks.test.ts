import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error 生成器は .mjs（型は付いていない）
import {
  collectPendingChecks,
  render,
  renderItems,
  ITEMS_TARGET,
  SOURCE,
  TARGET,
} from "../../scripts/pendingChecksLib.mjs";
import { ACTION_TREE, allActions, type ActionGroup } from "../../src/views/actionList";
import {
  buildPendingCheckGroup,
  unreachableSections,
} from "../../src/views/pendingCheckMenu";
import { PENDING_CHECKS, PENDING_CHECK_TOTAL } from "../../src/views/pendingChecks";
import type { PendingCheckSection } from "../../src/views/pendingChecks";

/**
 * 操作メニューの「テスト中」（作者の依頼、2026-08-26）。
 *
 * **文書を手で写さない。** メニューの中身は `docs/実機確認リスト.md` から
 * 機械的に作る。写すと必ず片方が古くなる。
 */

describe("確認リストから作った一覧", () => {
  test("文書とずれていない", () => {
    // ここが落ちたら `npm run checks:menu` で作り直す。
    // **古い数字がメニューに残るのを防ぐための見張りである**
    const sections = collectPendingChecks(readFileSync(SOURCE, "utf8"));

    expect(readFileSync(TARGET, "utf8")).toBe(render(sections));
    expect(readFileSync(ITEMS_TARGET, "utf8")).toBe(renderItems(sections));
  });

  test("配布物へ入るほうに、項目の文章を入れない", () => {
    // 確認リストには作者の作品名のような、外へ出すつもりのない言葉が入る
    // （作者の指定、2026-08-26）
    const shipped = readFileSync(TARGET, "utf8");

    expect(shipped).not.toContain("じいちゃんの自分史");
    // 件数は入る（メニューの「残り8」に要る）
    expect(shipped).toContain("count:");
  });

  test("指している操作は、すべて実在する", () => {
    // 文書に書いたコマンドIDを打ち間違えると、**何も出ない**まま気づけない
    const known = new Set(allActions().map((action) => action.command));

    for (const section of PENDING_CHECKS) {
      for (const command of section.commands) {
        expect(known, `${section.id}: ${command}`).toContain(command);
      }
    }
  });

  test("済んだ印の付いた項目は数えない", () => {
    const markdown = [
      "### A-99. 試し",
      "",
      "<!-- 対象: novelai.showVersion -->",
      "",
      "- [x] 済んだもの",
      "- [ ] まだのもの",
    ].join("\n");

    const sections = collectPendingChecks(markdown) as PendingCheckSection[];

    expect(sections).toHaveLength(1);
    expect(sections[0].items).toEqual(["まだのもの"]);
  });

  test("項目が残っていない節は落とす", () => {
    const markdown = ["### A-98. 全部済み", "", "- [x] 済んだもの"].join("\n");

    expect(collectPendingChecks(markdown)).toEqual([]);
  });

  test("見出しの注記は落として、短い名前にする", () => {
    const markdown = [
      "### A-15. 作品をすべて同期（0.19.6で追加。**原稿がGitHubへ出る**）",
      "",
      "- [ ] 何か",
    ].join("\n");

    const sections = collectPendingChecks(markdown) as PendingCheckSection[];

    expect(sections[0].id).toBe("A-15");
    expect(sections[0].title).toBe("作品をすべて同期");
  });
});

/** 組み立てた分類から、指定した小分類の1件目を取り出す */
function firstItemOf(group: ActionGroup | undefined, label: string) {
  const section = group?.entries.find(
    (entry) => entry.kind === "section" && entry.label === label
  );
  return section?.kind === "section" ? section.items[0] : undefined;
}

describe("「テスト中」の組み立て", () => {
  test("最下段に置く", () => {
    // 作者の指定。日々使う操作の邪魔をしない
    expect(ACTION_TREE.at(-1)?.label).toBe("テスト中");
  });

  test("元のメニューと同じ並びで、分類ごとに分ける", () => {
    const testing = ACTION_TREE.at(-1);
    const labels = (testing?.entries ?? [])
      .filter((entry) => entry.kind === "section")
      .map((entry) => entry.label);

    // 元の分類の並びを崩さない（作者が見慣れた順に出す）
    const original = ACTION_TREE.filter((group) => !group.generated).map(
      (group) => group.label
    );
    const mirrored = labels.filter((label) => original.includes(label));

    expect(mirrored).toEqual(original.filter((label) => mirrored.includes(label)));
  });

  test("残り件数を右に出す", () => {
    const group = buildPendingCheckGroup(
      [
        {
          kind: "group",
          label: "作品管理",
          icon: "book",
          entries: [
            {
              kind: "action",
              command: "novelai.syncAllWorks",
              label: "作品をすべて同期",
              icon: "sync",
              requiresWork: false,
              detail: "",
            },
          ],
        },
      ],
      [
        {
          id: "A-15",
          title: "作品をすべて同期",
          commands: ["novelai.syncAllWorks"],
          count: 2,
        },
      ]
    );

    // 開発ビルドでは「確認を回す（開発用）」が先頭に入る。名前で探す
    const item = firstItemOf(group, "作品管理");
    expect(item?.description).toBe("残り2");
    // **押したときの動きは元と同じ。** 別のコマンドを挟まない
    expect(item?.command).toBe("novelai.syncAllWorks");
  });

  test("複数の節が同じ操作を指していたら、足して数える", () => {
    const group = buildPendingCheckGroup(
      [
        {
          kind: "group",
          label: "資料管理",
          icon: "book",
          entries: [
            {
              kind: "action",
              command: "novelai.openSettingsPanel",
              label: "設定資料集を閲覧",
              icon: "book",
              requiresWork: true,
              detail: "",
            },
          ],
        },
      ],
      [
        { id: "A-10", title: "ルビ", commands: ["novelai.openSettingsPanel"], count: 1 },
        { id: "A-14", title: "改名", commands: ["novelai.openSettingsPanel"], count: 2 },
      ]
    );

    const item = firstItemOf(group, "資料管理");
    expect(item?.description).toBe("残り3");
    // どの節のことかを、ホバーで辿れるようにする
    expect(item?.detail).toContain("A-10");
    expect(item?.detail).toContain("A-14");
  });

  test("残りが無ければ、分類ごと作らない", () => {
    // 全部済めば、この分類は自然に消える
    expect(buildPendingCheckGroup(ACTION_TREE, [])).toBeUndefined();
  });

  test("写しなので、全操作の数には入れない", () => {
    // 入れると同じコマンドIDが2度出てきて、AIも同じ機能を2回案内する
    const commands = allActions().map((action) => action.command);

    expect(new Set(commands).size).toBe(commands.length);
  });

  test("操作から辿れない節を、数えられる", () => {
    // 環境が要るもの・見るだけのものは押す操作が無い。**黙って落とさない**
    const orphans = unreachableSections(PENDING_CHECKS, ACTION_TREE);
    const counted = orphans.reduce((sum, section) => sum + section.count, 0);
    const known = new Set(allActions().map((action) => action.command));

    expect(counted).toBeLessThan(PENDING_CHECK_TOTAL);
    // **押せる操作を1つも持たない節だけ**が辿れない側に来る
    // （押す操作が無い節と、メニューに無い操作を指している節）
    for (const section of orphans) {
      expect(section.commands.filter((command) => known.has(command))).toEqual(
        []
      );
    }
  });

  /**
   * **本番ビルドで、行も説明も出ないまま総数にだけ残るのを防ぐ**
   * （作者の裁定、2026-09-03）。
   *
   * 開発ビルド限定の操作（`devOnly`）は、本番ビルドでは木から枝ごと落ちる。
   * 「テスト中」は木を歩いてコマンドが一致した項目だけを写すので、
   * **その節を指す行は生まれない**。総数には入ったままなので、
   * 説明でも触れないと**その分が黙って消える**。
   */
  test("木に無いコマンドしか指していない節は、辿れない側へ回す", () => {
    const tree = [
      {
        kind: "group" as const,
        label: "作品管理",
        icon: "book",
        entries: [
          {
            kind: "action" as const,
            command: "novelai.syncAllWorks",
            label: "作品をすべて同期",
            icon: "sync",
            requiresWork: false,
            detail: "",
          },
        ],
      },
    ];
    const pending = [
      {
        id: "A-15",
        title: "作品をすべて同期",
        commands: ["novelai.syncAllWorks"],
        count: 2,
      },
      {
        // 本番ビルドでは落ちている操作を指す節
        id: "F-53",
        title: "流しながら受け取る実験",
        commands: ["novelai.dev.toggleOllamaStream"],
        count: 5,
      },
    ];

    expect(unreachableSections(pending, tree).map((section) => section.id)).toEqual(
      ["F-53"]
    );

    const group = buildPendingCheckGroup(tree, pending);
    // 総数には入れたまま、辿れない側の説明へ回す
    expect(group?.tooltip).toContain("残り7件");
    expect(group?.tooltip).toContain("5件は、ここからは辿れません");
    expect(group?.tooltip).toContain("F-53");
  });
});

describe("F5で、開発用の道具が出ること", () => {
  /**
   * **F5は開発ビルドを使わなければならない**（2026-08-27、作者の問いで発覚）。
   *
   * 本番ビルドでは `__DEV_HELPERS__` が false に畳まれ、道具もメニューの項目も
   * 枝ごと落ちる。F5が本番ビルドを走らせていたため、**作った道具が
   * 拡張機能開発ホストに出ていなかった。**
   *
   * 見た目には何も壊れないので、**ここで見張らないと次も同じことが起きる。**
   */
  /** コメント付きJSONを読む。行コメントだけを落とす */
  function readJsonc(path: string): unknown {
    const newline = String.fromCharCode(10);
    const text = readFileSync(path, "utf8")
      .split(newline)
      .filter((line) => !line.trim().startsWith("//"))
      .join(" ");
    return JSON.parse(text);
  }

  test("F5は、本番ビルドを走らせない", () => {
    const launch = readJsonc(".vscode/launch.json") as {
      configurations: Array<{ preLaunchTask?: string }>;
    };

    for (const config of launch.configurations) {
      // 本番ビルド（npm: build）だと、開発用の道具が落ちたまま起動する
      expect(config.preLaunchTask).not.toBe("npm: build");
    }
  });

  test("F5が指す仕事が、実在する", () => {
    const launch = readJsonc(".vscode/launch.json") as {
      configurations: Array<{ preLaunchTask?: string }>;
    };
    const tasks = readJsonc(".vscode/tasks.json") as {
      tasks: Array<{ label: string; script: string }>;
    };

    for (const config of launch.configurations) {
      if (!config.preLaunchTask) continue;
      const task = tasks.tasks.find((entry) => entry.label === config.preLaunchTask);
      expect(task, config.preLaunchTask).toBeDefined();
      // その仕事が呼ぶ npm script も実在すること
      const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
        scripts: Record<string, string>;
      };
      expect(pkg.scripts[task!.script], task!.script).toBeDefined();
      // **--production を渡していないこと**（渡すと道具が落ちる）
      expect(pkg.scripts[task!.script]).not.toContain("--production");
    }
  });
});
