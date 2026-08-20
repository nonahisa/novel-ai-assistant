import * as vscode from "vscode";
import {
  ACTION_TREE,
  actionKeyFromUri,
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

export class ActionDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<
    vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private readonly counts = new Map<ActionCounter, number>();

  /**
   * @param load 件数を数える。作品をまたいで合算した値を返す。
   *   数え方そのものはここに持たない（作品の登録状況に依存するため）。
   */
  constructor(
    private readonly load: (counter: ActionCounter) => Promise<number>
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

  countOf(counter: ActionCounter): number {
    return this.counts.get(counter) ?? 0;
  }

  provideFileDecoration(
    uri: vscode.Uri
  ): vscode.FileDecoration | undefined {
    const key = actionKeyFromUri(uri);
    if (key === undefined) return undefined;

    const counter = counterFor(key);
    if (counter) {
      const count = this.countOf(counter);
      if (count > 0) {
        return {
          badge: String(Math.min(count, MAX_BADGE_COUNT)),
          tooltip: COUNTER_TOOLTIPS[counter](count),
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
