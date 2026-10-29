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
 * 件数は3種（`ActionCounter`：承認待ちの更新・IME辞書の古さ・同じ人物とみられる組）で、
 * 付くのは「設定資料更新分反映」「IME辞書出力」「人物重複統合」と、それを含む
 * 分類・小分類である。どの操作もAIを呼ばないので、AIの印と取り合わない。
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
 *
 * ## 3種類目——いま案内が指している項目（設計書6.104。作者の報告、2026-09-22）
 *
 * 作者「相談で光らせるが目立ちません」。`TreeView.reveal()` でできるのは
 * **選ぶ**ところまでで、選択の色はテーマによっては薄い。そこで、
 * 案内が指している項目にだけ**「▶」の印と色**を残す。
 * **印は消えずに残る**ので、目を離して戻ってきても、どれを押すのかが分かる。
 *
 * **1つの項目に出せる印は1つだけ**なので、案内の印を**いちばん優先**する。
 * 案内の最中は「いま押すべき1つ」がすべてに勝つ——そのために出している印だからである。
 */

/** 印は2文字までしか出せない。3桁以上は 99 で止める */
const MAX_BADGE_COUNT = 99;

/**
 * 案内が指している項目の印。
 *
 * **相談パネルの「画面で案内してもらう」の札と同じ形**にしてある。
 * 押した札と、光った行が同じ記号で結びつく。
 */
const SPOTLIGHT_BADGE = "▶";

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

  /** 全作品の合計（詳細メニュー用）。**作品ごとの件数の和**として作る */
  private readonly counts = new Map<ActionCounter, number>();

  /**
   * 作品ごとの件数（簡単ステップメニュー用。合計の元でもある）。
   *
   * 以前は合計と作品ごとを別々に数えていて、作品を選び直すだけで全作品の
   * 資料を読み直していた（2026-10-29 の測定：写しで1回93ms・ファイル431回）。
   * 作品ごとに覚えて、合計はその和にする。数え直すのは変わった作品だけ。
   */
  private readonly workCounts = new Map<string, Map<ActionCounter, number>>();

  /**
   * 作品ごとの数え直しの番号。**後から始めた数え直しが残る**ようにする。
   * 数え直しは await せずに重なる（抽出のあと・反映のあとなど）ので、
   * 遅れて返った古い数が新しい数を上書きしないため
   */
  private readonly countSequence = new Map<string, number>();

  /**
   * いま案内（設計書6.104）が指している操作のコマンドID。
   *
   * **鍵は2つのメニューで共通**（`actionTargetFromUri` が返す `key` は
   * どちらもコマンドID）なので、1つ持てば簡単ステップメニューと
   * 詳細メニューの両方に印が出る。
   */
  private spotlighted: string | undefined;

  /**
   * @param load その作品だけの件数を数える。数え方そのものはここに持たない
   *   （作品の登録状況に依存するため）。
   * @param listWorkIds 登録されている作品。合計に入れる作品と、
   *   全部数えるときの範囲を決める。
   */
  constructor(
    private readonly load: (
      counter: ActionCounter,
      workId: string
    ) => Promise<number>,
    private readonly listWorkIds: () => readonly string[]
  ) {}

  /**
   * 数え直して、変わっていれば描き直させる。
   *
   * `workId` を渡すと**その作品だけ**数え直す（抽出・反映など、作品の分かる
   * 操作のあと）。渡さなければ全作品を数える（起動直後・登録簿の変化など、
   * どの作品が変わったか分からないとき）。
   * **まだ数えていない作品があれば、作品を渡されても全部数える**——
   * 合計が欠けたまま出ないようにするため。
   */
  async refresh(workId?: string): Promise<void> {
    const listed = this.listWorkIds();
    const all =
      workId === undefined || listed.some((id) => !this.workCounts.has(id));
    const targets = all ? [...listed] : [workId];
    const results = await Promise.all(targets.map((id) => this.countWork(id)));

    let changed = false;
    for (const [index, id] of targets.entries()) {
      const result = results[index];
      /*
        後から始めた数え直しに追い越された（`countSequence`）。**書く直前にも
        確かめる**（2026-10-30、母艦のレビュー）。その作品を数え終えた時点では
        いちばん新しくても、ほかの作品を待つ `Promise.all` の間に同じ作品の
        数え直しが始まって済んでいれば、ここで書くと古い数で上書きする
      */
      if (!result || this.countSequence.get(id) !== result.sequence) continue;
      const next = result.counts;
      const before = this.workCounts.get(id);
      if (!before || [...next].some(([counter, count]) => before.get(counter) !== count)) {
        changed = true;
      }
      this.workCounts.set(id, next);
    }
    // 登録から外れた作品は覚えておかない（合計にも入れない）
    const known = new Set(this.listWorkIds());
    for (const id of [...this.workCounts.keys()]) {
      if (!known.has(id)) {
        this.workCounts.delete(id);
        this.countSequence.delete(id);
        changed = true;
      }
    }
    if (this.recountTotals(known)) changed = true;
    if (changed) this._onDidChange.fire(undefined);
  }

  /**
   * 1作品を数える。後から同じ作品の数え直しが始まっていれば undefined
   * （古い数で上書きしない）
   */
  private async countWork(
    workId: string
  ): Promise<{ sequence: number; counts: Map<ActionCounter, number> } | undefined> {
    const sequence = (this.countSequence.get(workId) ?? 0) + 1;
    this.countSequence.set(workId, sequence);
    const next = new Map<ActionCounter, number>();
    for (const counter of usedCounters()) {
      let count = 0;
      try {
        count = await this.load(counter, workId);
      } catch {
        // 数えられなくてもメニューは出す。読めない作品は0件（印が出ないだけ）
        count = 0;
      }
      next.set(counter, count);
    }
    return this.countSequence.get(workId) === sequence ? { sequence, counts: next } : undefined;
  }

  /** 合計を作品ごとの件数の和で作り直す。変わったら true */
  private recountTotals(listed: ReadonlySet<string>): boolean {
    let changed = false;
    for (const counter of usedCounters()) {
      let total = 0;
      for (const [id, byCounter] of this.workCounts) {
        if (listed.has(id)) total += byCounter.get(counter) ?? 0;
      }
      if (this.counts.get(counter) !== total) {
        this.counts.set(counter, total);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * 案内が指している項目を差し替える（`undefined` で印を外す）。
   *
   * **同じものなら描き直させない。** 印の描き直しはツリー全体に及ぶので、
   * 段が変わっていないのに毎回起こすと、読んでいる最中の画面がちらつく。
   */
  setSpotlight(command: string | undefined): void {
    if (this.spotlighted === command) return;
    this.spotlighted = command;
    this._onDidChange.fire(undefined);
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

    // **案内の印を最優先で出す**（設計書6.104）。件数やAIの印より、
    // 「いま押すのはここ」のほうが強くなければ、光らせた意味が無い
    if (this.spotlighted !== undefined && key === this.spotlighted) {
      return {
        badge: SPOTLIGHT_BADGE,
        tooltip: "案内：ここを押してください",
        // 既定の選択色は薄くて気づけなかった（作者の報告、2026-09-22）。
        // 警告の色は明るいテーマでも濃く出るので、色そのものが目印になる
        color: new vscode.ThemeColor("list.warningForeground"),
      };
    }

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
