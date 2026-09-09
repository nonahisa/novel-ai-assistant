import * as vscode from "vscode";
import {
  ACTION_TREE,
  actionTargetFromUri,
  type ActionCounter,
  type ActionItem,
} from "./actionList";

/**
 * 操作メニューの末尾に出す印（バッジ。設計書6.17）。
 *
 * VS Codeのツリーは、項目の末尾に**2文字までの印**を出せる（`FileDecorationProvider`）。
 * Gitの変更を示す `M` と同じ仕組みで、これが唯一の「末尾のアイコン」の手段である。
 * 項目にアイコンを2つ並べる方法は用意されていない。
 *
 * ここでは2種類を出す。
 * ・**AI**：AIを呼ぶ操作。クラウドのAIは実行のたびに課金されるので、
 *   押す前に見分けられる必要がある
 * ・**件数**：承認待ちの更新など、放っておくと溜まるもの
 *
 * **1つの項目に出せる印は1つだけ**なので、件数を優先する。
 * 件数が出るのは「更新分を反映」だけで、これはAIを呼ぶ操作ではない。
 *
 * ## 件数の範囲は、メニューごとに違う（作者の実機報告、2026-09-05）
 *
 * ・**詳細メニュー**：全作品合計。作品を選ばずに見るメニューなので、
 *   「**どこかに**溜まっている」ことが分かればよい
 * ・**簡単ステップメニュー**：最上段で選んだ作品だけ。作品を選ぶ画面なので、
 *   末尾の数字はその作品のものだと読める。**作品を選んでいないときは出さない**
 *   ——どの作品の数字か分からないものを出しても、選択中の作品の件数に見える
 *   だけである（「どこかに溜まっている」の気づきは詳細メニューが担う）
 *
 * どちらの数字を出すかは、目印のURI（`actionTargetFromUri`）が決める。
 * 同じ鍵にすると同じ数字が出るので、簡単ステップメニュー側は作品IDを混ぜる。
 */

/** 印は2文字までしか出せない。3桁以上は 99 で止める */
const MAX_BADGE_COUNT = 99;

/**
 * 件数の説明。**種類ごとに変える。**
 *
 * 以前は「未反映の更新が N 件」で決め打ちだったが、
 * 件数の種類が増えると、辞書が古いことまで「未反映の更新」と説明されて
 * 何を指しているのか分からなくなる。
 */
const COUNTER_TOOLTIPS: Record<ActionCounter, (count: number) => string> = {
  pendingUpdates: (count) => `未反映の更新が ${count} 件あります`,
  staleImeDictionary: (count) =>
    `${count} 件の作品で、設定資料がIME辞書より新しくなっています。` +
    "書き出し直してIMEへ取り込むまで、増えた語は変換に出ません",
  mergeCandidates: (count) =>
    `同じ人物とみられる組が ${count} 件あります。` +
    "まとめないと、同じ人物の設定が別々に育ってしまいます",
};

/**
 * 件数の説明（簡単ステップメニュー用）。**どの範囲の数字かを言う。**
 *
 * 全作品合計の文言をそのまま使うと、選んだ作品の件数なのか、
 * 全部を合わせた件数なのかが読み取れない。
 * 辞書は作品ごとに1つなので、`staleImeDictionary` は件数を出さず状態を述べる
 * （「1 件の作品で」と出ると、選んだ作品以外も数えたように読める）。
 */
const WORK_COUNTER_TOOLTIPS: Record<ActionCounter, (count: number) => string> = {
  pendingUpdates: (count) =>
    `選択中の作品に、未反映の更新が ${count} 件あります`,
  staleImeDictionary: () =>
    "選択中の作品で、設定資料がIME辞書より新しくなっています。" +
    "書き出し直してIMEへ取り込むまで、増えた語は変換に出ません",
  mergeCandidates: (count) =>
    `選択中の作品に、同じ人物とみられる組が ${count} 件あります。` +
    "まとめないと、同じ人物の設定が別々に育ってしまいます",
};

export class ActionDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<
    vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private readonly counts = new Map<ActionCounter, number>();

  /**
   * 作品ごとの件数（簡単ステップメニュー用）。
   *
   * 合算とは別に持つ。**合算から作品ごとの数は割り出せない**ので、
   * 選んだ作品を数え直す（`refreshWork`）。
   */
  private readonly workCounts = new Map<string, Map<ActionCounter, number>>();

  /**
   * @param load 件数を数える。数え方そのものはここに持たない
   *   （作品の登録状況に依存するため）。
   *   `workId` を渡さなければ**作品をまたいで合算した値**、
   *   渡せば**その作品だけ**の値を返す。
   */
  constructor(
    private readonly load: (
      counter: ActionCounter,
      workId?: string
    ) => Promise<number>
  ) {}

  /** 数え直して、変わっていれば描き直させる */
  async refresh(): Promise<void> {
    let changed = false;
    for (const counter of usedCounters()) {
      let next = 0;
      try {
        next = await this.load(counter);
      } catch {
        // 数えられなくてもメニューは出す。印が出ないだけ
        next = 0;
      }
      if (this.counts.get(counter) !== next) {
        this.counts.set(counter, next);
        changed = true;
      }
    }
    if (changed) this._onDidChange.fire(undefined);
  }

  /**
   * 1つの作品だけを数え直す。**簡単ステップメニューで作品を選び直したときに呼ぶ。**
   *
   * 未選択（undefined）のときは数えるものが無い。印も出さないので何もしない。
   */
  async refreshWork(workId: string | undefined): Promise<void> {
    if (workId === undefined) return;
    const before = this.workCounts.get(workId);
    const next = new Map<ActionCounter, number>();
    let changed = before === undefined;
    for (const counter of usedCounters()) {
      let count = 0;
      try {
        count = await this.load(counter, workId);
      } catch {
        // 合算と同じ扱い。読めない作品は0件（印が出ないだけ）
        count = 0;
      }
      next.set(counter, count);
      if (before?.get(counter) !== count) changed = true;
    }
    this.workCounts.set(workId, next);
    if (changed) this._onDidChange.fire(undefined);
  }

  countOf(counter: ActionCounter): number {
    return this.counts.get(counter) ?? 0;
  }

  /** その作品だけの件数。まだ数えていなければ0（印が出ないだけ） */
  countOfWork(workId: string | undefined, counter: ActionCounter): number {
    if (workId === undefined) return 0;
    return this.workCounts.get(workId)?.get(counter) ?? 0;
  }

  provideFileDecoration(
    uri: vscode.Uri
  ): vscode.FileDecoration | undefined {
    const target = actionTargetFromUri(uri);
    if (target === undefined) return undefined;
    const key = target.key;

    const counter = counterFor(key);
    if (counter) {
      // **どの範囲を数えるかは鍵が決める。** 作品を選んでいない
      // 簡単ステップメニューでは0になり、印が出ない
      const count =
        target.scope === "all"
          ? this.countOf(counter)
          : this.countOfWork(target.workId, counter);
      if (count > 0) {
        return {
          badge: String(Math.min(count, MAX_BADGE_COUNT)),
          tooltip:
            target.scope === "all"
              ? COUNTER_TOOLTIPS[counter](count)
              : WORK_COUNTER_TOOLTIPS[counter](count),
          // **自前の色を使う。** 既定の `charts.orange`（#d18616）は
          // 白地のテーマで薄く、件数も操作名も読みにくかった
          // （作者の指摘、2026-08-21）。テーマごとの濃さは
          // `package.json` の `contributes.colors` で決める
          color: new vscode.ThemeColor("novelai.pendingBadge"),
        };
      }
    }

    if (actionByCommand(key)?.usesAI) {
      return {
        badge: "AI",
        tooltip: "AIを使います（クラウドのAIは実行のたびに課金されます）",
        // **色を付けない**（作者の指示、2026-08-19）。
        // 位置（行の右端に揃う）だけで印として読める
      };
    }
    return undefined;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/**
 * その鍵に件数を出すか。
 *
 * **分類・小分類の見出しにも出す。** 閉じたままでも気づけるようにするのと、
 * 開いたあとに「どれをさらに開けばよいか」を辿れるようにするため。
 * 小分類の鍵は `nodeKey` と同じく「分類/小分類」の形。
 */
function counterFor(key: string): ActionCounter | undefined {
  for (const group of ACTION_TREE) {
    if (group.label === key) return group.counter;
    for (const entry of group.entries) {
      if (entry.kind === "action" && entry.command === key) return entry.counter;
      if (entry.kind === "section") {
        if (`${group.label}/${entry.label}` === key) return entry.counter;
        for (const item of entry.items) {
          if (item.command === key) return item.counter;
        }
      }
    }
  }
  return undefined;
}

function actionByCommand(command: string): ActionItem | undefined {
  for (const group of ACTION_TREE) {
    for (const entry of group.entries) {
      if (entry.kind === "action" && entry.command === command) return entry;
      if (entry.kind === "section") {
        const found = entry.items.find((item) => item.command === command);
        if (found) return found;
      }
    }
  }
  return undefined;
}

/** 実際に使われている件数の種類だけを数える */
function usedCounters(): ActionCounter[] {
  const counters = new Set<ActionCounter>();
  for (const group of ACTION_TREE) {
    if (group.counter) counters.add(group.counter);
    for (const entry of group.entries) {
      if (entry.kind === "action" && entry.counter) counters.add(entry.counter);
      if (entry.kind === "section") {
        if (entry.counter) counters.add(entry.counter);
        for (const item of entry.items) {
          if (item.counter) counters.add(item.counter);
        }
      }
    }
  }
  return [...counters];
}
