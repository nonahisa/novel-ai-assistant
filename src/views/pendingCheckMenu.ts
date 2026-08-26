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
 * 未確認の項目は `pendingChecks.ts`（`docs/実機確認リスト.md` から自動生成）が持つ。
 * **文書を手で写さない。** 写すと必ず片方が古くなる。
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
    tooltip: describeGroup(pending),
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

  const remaining = sections.reduce(
    (sum, section) => sum + section.items.length,
    0
  );
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
  const lines = [
    `**${where}**（確認リスト ${ids.length > 0 ? ids.join("・") : "番号なし"}）`,
    "",
  ];

  for (const section of sections) {
    for (const check of section.items.slice(0, MAX_SHOWN)) {
      lines.push(`- ${check}`);
    }
  }

  const total = sections.reduce((sum, section) => sum + section.items.length, 0);
  const shown = sections.reduce(
    (sum, section) => sum + Math.min(section.items.length, MAX_SHOWN),
    0
  );
  // **省いた件数は必ず書く。** 黙って切ると、これで全部だと読めてしまう
  if (total > shown) lines.push(`- ほか${total - shown}件`);

  lines.push("", "押すと、その機能をそのまま実行します。");
  return lines.join("\n");
}

/** ホバーに並べる項目の数。**多すぎると画面から溢れて読めない** */
const MAX_SHOWN = 6;

/**
 * どの操作からも辿れない節。
 *
 * 環境が要るもの（G節）や、見るだけのもの（作品一覧の印）は、押す操作が無い。
 * **黙って落とさない**——数を作者へ伝えて、確認リストを直に見てもらう。
 */
export function unreachableSections(
  pending: readonly PendingCheckSection[]
): PendingCheckSection[] {
  return pending.filter((section) => section.commands.length === 0);
}

/**
 * 分類そのものの説明。
 *
 * **押す操作の無い節があることを、必ず伝える。** 環境が要るもの（AIの鍵）や
 * 見るだけのもの（作品一覧の印）は、ここからは辿れない。黙って落とすと、
 * **並んでいるものが全部だと読めてしまう。**
 */
function describeGroup(pending: readonly PendingCheckSection[]): string {
  const total = pending.reduce((sum, section) => sum + section.items.length, 0);
  const orphans = unreachableSections(pending);
  const orphanCount = orphans.reduce(
    (sum, section) => sum + section.items.length,
    0
  );

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
        "押す操作が無いもの（見るだけ・環境が要るもの）です。確認リストを直接ご覧ください。"
    );
  }
  return lines.join("\n");
}
