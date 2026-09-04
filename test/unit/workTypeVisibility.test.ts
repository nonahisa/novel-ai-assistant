import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  COMMAND_FEATURES,
  FEATURE_COLUMNS,
  WORK_TREE_NODE_KINDS,
  WORK_TYPE_COLUMNS,
  WORK_TYPE_CONTEXT_UNSET,
  featureOfCommand,
  isCommandVisibleForColumn,
  isCommandVisibleForWorkType,
  workTypeContextValue,
  type WorkTypeColumn,
} from "../../src/core/workTypeVisibility";
import { allActions } from "../../src/views/actionList";

/**
 * タイプ×機能の対応表（設計書6.70.1）。
 *
 * **表は1か所しか無い。** 簡単ステップメニューと右クリック
 * （`package.json` の `when`）の両方がこれを読む。写しを作ると、
 * 片方だけ直したときに「ステップでは消えているのに右クリックには出る」
 * が起きて、しかも画面を見比べるまで気づけない。
 *
 * ここで確かめるのは3つ。
 *
 * 1. **表に漏れが無いこと**——登録したコマンドを表へ足し忘れると、
 *    どのタイプでも黙って出続ける（隠れるより安全な向きだが、
 *    分類したつもりで分類できていないことに気づけない）
 * 2. **小説では何も減らないこと**——いままでの作品の見え方を変えない
 * 3. **`package.json` の `when` が表と噛み合うこと**——正規表現は
 *    型検査もテストも通らない文字列なので、ここで実際に照合する
 */

interface PackageManifest {
  contributes: {
    commands: Array<{ command: string }>;
    menus: Record<string, Array<{ command: string; when?: string }>>;
  };
}

const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as PackageManifest;

/**
 * 表から外してよいコマンド。
 *
 * - `novelai.dev.*` は開発ビルドだけの道具（`devOnly`）。配布物には
 *   定義ごと入らないので、タイプで出し分ける対象にならない
 *
 * **「テスト中」の分類は除外しない。** 中身は他の分類の写しなので、
 * コマンドIDとしては既に表に載っている。
 */
const OUT_OF_TABLE = [/^novelai\.dev\./];

function inTable(command: string): boolean {
  return !OUT_OF_TABLE.some((pattern) => pattern.test(command));
}

/**
 * その `when` に噛み合う contextValue をすべて挙げる。
 *
 * **ノードの種別は `workTypeVisibility` から取る。** ここに写しを置くと、
 * 種別を足したとき（メモの枝、6.71）に**新しい項目だけが照合から漏れ**、
 * 検査が素通りする。
 */
function matchedContextValues(when: string): string[] {
  const candidates = WORK_TREE_NODE_KINDS.flatMap((kind) =>
    [...WORK_TYPE_COLUMNS, WORK_TYPE_CONTEXT_UNSET].map(
      (suffix) => `${kind}-${suffix}`
    )
  );
  return candidates.filter((value) => matchesViewItem(when, value));
}

/**
 * `when` の `viewItem` の条件だけを取り出して照合する。
 *
 * VS Code の式言語をここで実装したいわけではない。見るのは
 * `viewItem =~ /…/` と `viewItem == …` の2つだけで、それ以外の項
 * （`view == novelai.works`）は作品一覧のときに真になる前提で読み飛ばす。
 */
function matchesViewItem(when: string, contextValue: string): boolean {
  const regex = /viewItem\s*=~\s*\/(.+?)\/(?=\s|$)/.exec(when);
  if (regex) return new RegExp(regex[1]).test(contextValue);
  const equals = /viewItem\s*==\s*([A-Za-z0-9_-]+)/.exec(when);
  if (equals) return equals[1] === contextValue;
  // `viewItem` を見ない項目は、どのノードにも出る
  return true;
}

describe("表に漏れが無い", () => {
  test("package.json に登録した全コマンドが表に載っている", () => {
    const missing = manifest.contributes.commands
      .map((entry) => entry.command)
      .filter((command) => inTable(command) && !featureOfCommand(command));

    expect(missing, "表に無いコマンド").toEqual([]);
  });

  test("詳細メニューに並ぶ全コマンドが表に載っている", () => {
    const missing = allActions()
      .map((action) => action.command)
      .filter((command) => inTable(command) && !featureOfCommand(command));

    expect(missing).toEqual([]);
  });

  test("表に、実在しないコマンドが残っていない", () => {
    // コマンドを改名したときに、古い名前が表へ残り続けないようにする
    const declared = new Set(
      manifest.contributes.commands.map((entry) => entry.command)
    );

    expect(
      Object.keys(COMMAND_FEATURES).filter((command) => !declared.has(command))
    ).toEqual([]);
  });

  test("機能分類には、必ず1つ以上のタイプが並ぶ", () => {
    // どのタイプでも出ない分類は、機能を消したのと同じである
    for (const [feature, columns] of Object.entries(FEATURE_COLUMNS)) {
      expect(columns.length, feature).toBeGreaterThan(0);
    }
  });
});

describe("小説では、いままでどおり全部見える", () => {
  test("表に載っているコマンドは、小説ではすべて見える", () => {
    const hidden = Object.keys(COMMAND_FEATURES).filter(
      (command) => !isCommandVisibleForColumn(command, "novel")
    );

    /*
      **小説から消えてよいのは、創作メモ集にしか置き場の無い操作だけ。**

      「このメモを作品へ移管」（設計書6.71）は、移す元がメモ集の
      メモであることが前提の操作である。小説の話に出しても、
      移す先が「本文から設定資料の下へ」になってしまう。

      ここを配列で固定しているのは、**うっかり物語向けの機能を
      メモ集専用にしても気づけるようにする**ためである。
    */
    expect(hidden, "小説で消えるコマンド").toEqual([
      "novelai.transferMemoToWork",
    ]);
  });

  test("タイプを決めていない作品でも、すべて見える", () => {
    // **「決めていない」を「合わない」と読み替えない。**
    // プロットに形式を書いていない作品から機能が消えてはいけない
    for (const command of Object.keys(COMMAND_FEATURES)) {
      expect(isCommandVisibleForWorkType(command, undefined), command).toBe(
        true
      );
    }
  });

  test("表に無いコマンドは、隠さずに出す", () => {
    // 隠しすぎより見えすぎのほうが安全（漏れは上のテストが知らせる）
    expect(isCommandVisibleForColumn("novelai.まだ無いもの", "memo")).toBe(true);
  });
});

describe("タイプに合わない操作は出さない", () => {
  const storyOnly = [
    "novelai.createPlot",
    // プロットモードの画面（設計書6.4.8）
    "novelai.openPlotMode",
    "novelai.generatePlot",
    "novelai.generateSynopses",
    "novelai.checkContradictions",
    "novelai.checkForeshadows",
    "novelai.checkDeviations",
    "novelai.proposeChapters",
    "novelai.startChapter",
    "novelai.exportEpub",
    "novelai.extractSettings",
    "novelai.openSettingsPanel",
  ];

  test("物語向けは、創作メモ集とSNS記事では出ない", () => {
    for (const command of storyOnly) {
      expect(isCommandVisibleForColumn(command, "memo"), command).toBe(false);
      expect(isCommandVisibleForColumn(command, "sns"), command).toBe(false);
    }
  });

  test("物語向けは、脚本では出る", () => {
    // 脚本は物語である。数える単位が「話」なのも小説と同じ
    for (const command of storyOnly) {
      expect(isCommandVisibleForColumn(command, "script"), command).toBe(true);
    }
  });

  test("話数の挿入・削除は、番号で数えるタイプだけ", () => {
    for (const command of [
      "novelai.insertEpisodeBefore",
      "novelai.removeEpisodeAndRenumber",
    ]) {
      expect(isCommandVisibleForColumn(command, "novel"), command).toBe(true);
      expect(isCommandVisibleForColumn(command, "script"), command).toBe(true);
      // SNS記事は日付、創作メモ集は題名で並ぶ。番号を詰め直す操作が無い
      expect(isCommandVisibleForColumn(command, "sns"), command).toBe(false);
      expect(isCommandVisibleForColumn(command, "memo"), command).toBe(false);
    }
  });

  test("メモの追加・削除は、どのタイプでも出る（設計書6.71）", () => {
    // メモはどの作品にも要る。**メモ集だけのものではない**
    for (const command of ["novelai.addWorkMemo", "novelai.removeWorkMemo"]) {
      for (const column of WORK_TYPE_COLUMNS) {
        expect(
          isCommandVisibleForColumn(command, column),
          `${command}/${column}`
        ).toBe(true);
      }
    }
  });

  test("メモの移管は、創作メモ集だけに出る（設計書6.71）", () => {
    expect(isCommandVisibleForColumn("novelai.transferMemoToWork", "memo")).toBe(
      true
    );
    for (const column of ["novel", "sns", "script"] as const) {
      expect(
        isCommandVisibleForColumn("novelai.transferMemoToWork", column),
        column
      ).toBe(false);
    }
  });

  test("メモの移管は、タイプ未設定にも出ない（unsetは絞らない方針の唯一の例外）", () => {
    // 移管はファイルを作品から抜く操作で、小説の原稿を誤ってメモへ移す
    // 事故のほうが「未設定では見せる」利便より重い（本体の裁定、2026-09-04）。
    // package.json の when も episode-memo の完全一致であること
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as {
      contributes: {
        menus: Record<string, Array<{ command: string; when?: string }>>;
      };
    };
    const entry = manifest.contributes.menus["view/item/context"].find(
      (item) => item.command === "novelai.transferMemoToWork"
    );
    expect(entry?.when).toContain("/^episode-memo$/");
    expect(entry?.when).not.toContain("unset");
  });

  test("執筆統計・校正・同期・投稿キットは、どのタイプでも出る", () => {
    for (const command of [
      "novelai.showWritingStats",
      "novelai.checkTypos",
      "novelai.checkNotation",
      "novelai.checkProofread",
      "novelai.gitSync",
      "novelai.postNewEpisode",
      "novelai.copyForPosting",
      // **タイプを変える入口が消えては、間違えて選んだタイプから戻れない**
      "novelai.setPlotBasics",
    ]) {
      for (const column of WORK_TYPE_COLUMNS) {
        expect(isCommandVisibleForColumn(command, column), `${command}/${column}`).toBe(
          true
        );
      }
    }
  });
});

describe("右クリック（package.json の when）が表と噛み合う", () => {
  const contextMenu = manifest.contributes.menus["view/item/context"];

  test("作品一覧の項目は、すべてタイプ付きの contextValue で絞っている", () => {
    // `viewItem == work` のような素の値が残っていると、タイプで
    // 絞ったつもりの項目が全タイプに出続ける
    for (const entry of contextMenu) {
      expect(entry.when, entry.command).toMatch(/viewItem\s*=~/);
    }
  });

  test("出す・出さないが、表のとおりになっている", () => {
    // **unset（タイプ未設定）を含めない唯一の例外**：メモの移管。
    // ファイルを作品から抜く操作で、未設定の小説の原稿を誤ってメモへ
    // 移す事故のほうが「未設定では見せる」利便より重い（本体の裁定、2026-09-04）
    const UNSET_EXCLUDED = new Set(["novelai.transferMemoToWork"]);

    for (const entry of contextMenu) {
      const matched = matchedContextValues(entry.when ?? "");
      const kinds = new Set(matched.map((value) => value.split("-")[0]));

      // 1つのノード種別（作品・章・話）だけに出る
      expect(kinds.size, `${entry.command} の when`).toBe(1);
      const kind = [...kinds][0];

      const expected = [
        ...WORK_TYPE_COLUMNS.filter((column) =>
          isCommandVisibleForColumn(entry.command, column)
        ),
        // タイプを決めていない作品では絞り込まない（例外は上の一覧だけ）
        ...(UNSET_EXCLUDED.has(entry.command) ? [] : [WORK_TYPE_CONTEXT_UNSET]),
      ].map((suffix) => `${kind}-${suffix}`);

      expect([...matched].sort(), entry.command).toEqual(expected.sort());
    }
  });

  test("contextValue の作り方が、when の想定と同じ", () => {
    // 表と `when` が合っていても、ツリーが別の文字列を入れていれば
    // 何も出ない（実際に噛み合っていることを、両側から確かめる）
    expect(workTypeContextValue("episode", "memo")).toBe("episode-memo");
    expect(workTypeContextValue("work", "long")).toBe("work-novel");
    // メモの枝（設計書6.71）。作品と話の印に紛れないよう別の種別にする
    expect(workTypeContextValue("memoFolder", "long")).toBe("memoFolder-novel");
    expect(workTypeContextValue("memoFile", "sns")).toBe("memoFile-sns");
    expect(workTypeContextValue("chapter", undefined)).toBe(
      `chapter-${WORK_TYPE_CONTEXT_UNSET}`
    );

    const values: string[] = [];
    for (const column of [...WORK_TYPE_COLUMNS, undefined] as Array<
      WorkTypeColumn | undefined
    >) {
      values.push(`episode-${column ?? WORK_TYPE_CONTEXT_UNSET}`);
    }
    const insert = contextMenu.find(
      (entry) => entry.command === "novelai.insertEpisodeBefore"
    );
    expect(
      values.filter((value) => matchesViewItem(insert?.when ?? "", value))
    ).toEqual(["episode-novel", "episode-script", "episode-unset"]);
  });
});
