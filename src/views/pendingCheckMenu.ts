import type { ActionGroup, ActionItem, ActionSection } from "./actionList";
import type { PendingCheckSection } from "./pendingChecks";

/**
 * 「テスト中」の分類を組み立てる（作者の依頼、2026-08-26）。
 *
 * 作者の依頼：「操作メニューの最下段に『テスト中』を新設し、その下に操作メニューと
 * 同じメニュー構造でテストが終わっていない機能を並べてください」。
 *
 * ## なぜ要るのか
 *
 * 実機で確かめていない機能が300件以上たまっている（`docs/実機確認リスト.md`）。
 * **確認リストを開いてから、その機能をメニューで探す**のが毎回の手間だった。
 * メニューの側に「まだ確かめていないもの」を並べれば、**そこから直に押せる。**
 *
 * ## 並べ方は、元のメニューと同じにする
 *
 * 作者が見ているのは操作メニューであり、**確認リストの番号（A-15）ではない。**
 * 元の分類（作品管理・執筆AI支援…）をそのまま小分類にして、その下に操作を置く。
 * 元の小分類の名前は、操作の説明へ添える（階層をこれ以上深くしない）。
 *
 * ## 数はここで作らない
 *
 * 未確認の件数は `pendingChecks.ts`（`docs/実機確認リスト.md` から自動生成）が持つ。
 * **文書を手で写さない。** 写すと必ず片方が古くなる。
 *
 * ## 配布物には件数だけを入れる（作者の指定、2026-08-26）
 *
 * 確認リストの**項目の文章**には、作者の作品名のような外へ出すつもりのない言葉が
 * 入る。ここで組み立てる説明にも**文章を入れない**——出すのは件数と節の番号だけで、
 * 何を確かめるのかは開発ビルドの道具（`src/dev/checkRunner.ts`）が見せる。
 */

/** 組み立てた結果。作れなかった（残りが無い）ときは undefined */
export function buildPendingCheckGroup(
  tree: readonly ActionGroup[],
  pending: readonly PendingCheckSection[]
): ActionGroup | undefined {
  const byCommand = indexByCommand(pending);
  if (byCommand.size === 0) return undefined;

  const sections: ActionSection[] = [];

  // **開発ビルドでだけ、回すための道具を先頭に置く**（作者の依頼、2026-08-26）。
  // 本番ビルドでは `__DEV_HELPERS__` が false に畳まれ、この枝ごと落ちる
  if (__DEV_HELPERS__) {
    sections.push({
      kind: "section",
      label: "確認を回す（開発用）",
      icon: "beaker",
      items: [
        {
          kind: "action",
          command: "novelai.runChecks",
          label: "実機確認を回す",
          icon: "checklist",
          requiresWork: false,
          devOnly: true,
          detail:
            "確認リストの節を選ぶと、**その機能をその場で実行**できます。" +
            "通った項目に印を付けると、**確認リストへ書き戻します**。" +
            "配布物には入りません（開発ビルドだけの道具です）。",
        },
        {
          kind: "action",
          command: "novelai.reflectOperationLog",
          label: "操作ログを確認リストへ反映",
          icon: "sync",
          requiresWork: false,
          devOnly: true,
          detail:
            "F5で押した操作の記録を、確認リストの節ごとに" +
            "**最終実行と回数**として書き足します。" +
            "**通ったかの印（[x]）には触りません**——" +
            "押したことと通ったことは別で、判断は作者がします。",
        },
      ],
    });
  }
  for (const group of tree) {
    if (group.generated) continue;
    const items = pendingItemsOf(group, byCommand);
    if (items.length === 0) continue;
    sections.push({
      kind: "section",
      label: group.label,
      icon: group.icon,
      items,
    });
  }
  if (sections.length === 0) return undefined;

  return {
    kind: "group",
    label: "テスト中",
    icon: "beaker",
    generated: true,
    entries: sections,
    // **辿れない節の見分けには、木そのものが要る**（本番ビルドでは
    // 開発用の項目が落ちるので、指し先が消えている節が出る）
    tooltip: describeGroup(pending, tree),
  };
}

/** その節が指す操作ごとに、残っている項目をまとめる */
function indexByCommand(
  pending: readonly PendingCheckSection[]
): Map<string, PendingCheckSection[]> {
  const map = new Map<string, PendingCheckSection[]>();
  for (const section of pending) {
    for (const command of section.commands) {
      const list = map.get(command) ?? [];
      list.push(section);
      map.set(command, list);
    }
  }
  return map;
}

/** その分類の中で、まだ確かめていない操作を拾う（小分類の中も見る） */
function pendingItemsOf(
  group: ActionGroup,
  byCommand: Map<string, PendingCheckSection[]>
): ActionItem[] {
  const items: ActionItem[] = [];
  for (const entry of group.entries) {
    if (entry.kind === "action") {
      const made = toPendingItem(entry, undefined, byCommand);
      if (made) items.push(made);
      continue;
    }
    for (const item of entry.items) {
      const made = toPendingItem(item, entry.label, byCommand);
      if (made) items.push(made);
    }
  }
  return items;
}

/**
 * 元の操作を、「テスト中」に並べる形へ写す。
 *
 * **押したときの動きは元と同じにする。** ここから押せることが要点なので、
 * 別のコマンドを挟まない（挟むと、元のメニューと動きが違う道が2つできる）。
 */
function toPendingItem(
  item: ActionItem,
  sectionLabel: string | undefined,
  byCommand: Map<string, PendingCheckSection[]>
): ActionItem | undefined {
  const sections = byCommand.get(item.command);
  if (!sections || sections.length === 0) return undefined;

  const remaining = sections.reduce((sum, section) => sum + section.count, 0);
  const ids = sections.map((section) => section.id).filter((id) => id !== "");

  return {
    ...item,
    // 薄字で右に出る。**数が無いと、どれから手を付けるか決められない**
    description: `残り${remaining}`,
    detail: describePending(item, sectionLabel, sections, ids),
  };
}

/** ホバーの説明。**何を見ればよいのかを、その場に出す** */
function describePending(
  item: ActionItem,
  sectionLabel: string | undefined,
  sections: readonly PendingCheckSection[],
  ids: readonly string[]
): string {
  const where = sectionLabel ? `${sectionLabel} → ${item.label}` : item.label;
  const total = sections.reduce((sum, section) => sum + section.count, 0);

  return [
    `**${where}**`,
    "",
    `- まだ確かめていない項目: ${total}件`,
    `- 確認リスト: ${ids.length > 0 ? ids.join("・") : "番号なし"}`,
    "",
    // **項目の文章はここに出さない**（配布物へ入るため）。何を確かめるのかは、
    // 確認リストと、開発ビルドの「実機確認を回す」で見る
    "押すと、その機能をそのまま実行します。",
  ].join("\n");
}

/**
 * どの操作からも辿れない節。
 *
 * 辿れないのは2通りある。
 *
 * 1. **押す操作が無い**（`<!-- 対象: -->` を書けない節）。環境が要るもの
 *    （G節）や、見るだけのもの（作品一覧の印）がこれにあたる
 * 2. **指している操作が、いまのメニューに無い。** 開発ビルド限定の操作
 *    （`devOnly`）は本番ビルドで枝ごと落ちるので、その節を指す行は
 *    上の `pendingItemsOf` からも生まれない（作者の裁定、2026-09-03）
 *
 * **2を見落とすと、その分が黙って消える。** 行は出ないのに総数には
 * 入ったままなので、作者からは「数が合わない」としか見えない。
 * 木を渡して**実在するコマンドを1つでも持つか**で判断する。
 *
 * **黙って落とさない**——数を作者へ伝えて、確認リストを直に見てもらう。
 */
export function unreachableSections(
  pending: readonly PendingCheckSection[],
  tree: readonly ActionGroup[]
): PendingCheckSection[] {
  const known = commandsIn(tree);
  return pending.filter(
    (section) => !section.commands.some((command) => known.has(command))
  );
}

/** その木に実在するコマンドID（小分類の中も見る） */
function commandsIn(tree: readonly ActionGroup[]): Set<string> {
  const known = new Set<string>();
  for (const group of tree) {
    for (const entry of group.entries) {
      if (entry.kind === "action") {
        known.add(entry.command);
        continue;
      }
      for (const item of entry.items) known.add(item.command);
    }
  }
  return known;
}

/**
 * 分類そのものの説明。
 *
 * **辿れない節があることを、必ず伝える。** 環境が要るもの（AIの鍵）や
 * 見るだけのもの（作品一覧の印）、いまのメニューに無い操作を指しているもの
 * （開発ビルド限定の道具）は、ここからは辿れない。黙って落とすと、
 * **並んでいるものが全部だと読めてしまう。**
 */
function describeGroup(
  pending: readonly PendingCheckSection[],
  tree: readonly ActionGroup[]
): string {
  const total = pending.reduce((sum, section) => sum + section.count, 0);
  const orphans = unreachableSections(pending, tree);
  const orphanCount = orphans.reduce((sum, section) => sum + section.count, 0);

  const lines = [
    `**実機でまだ確かめていないもの（残り${total}件）**`,
    "",
    "`docs/実機確認リスト.md` から自動で作っています。押すと、その機能を実行します。",
  ];
  if (orphanCount > 0) {
    lines.push(
      "",
      `うち**${orphanCount}件は、ここからは辿れません**` +
        `（${orphans.map((section) => section.id || section.title).join("・")}）。` +
        "押す操作が無いもの（見るだけ・環境が要るもの）と、" +
        // 開発ビルド限定の道具は、配布物では枝ごと落ちる（設計書6.63.1の実験など）。
        // **辿れない理由が違うだけで、黙って消してよい理由にはならない**
        "いまのメニューに無い操作を指しているものです。確認リストを直接ご覧ください。"
    );
  }
  return lines.join("\n");
}
