/**
 * 起動の所要時間を計る（設計書6.107）。
 *
 * 作者の機械では、メニューや作品一覧が出るまでに**10秒以上**かかる。
 * 母艦で同じデータを測っても説明がつかない（本文4.0MBの走査が43ms、
 * JSON 1,142件が89ms、19作品の `git status` で0.7秒）ので、
 * **作者の機械で、どこが重いのかを計るしかない。**
 *
 * **当てずっぽうで速くしない。** 数字が出る前に直すと、直っていないのに
 * 直したことになる。ここは計って書き出すだけで、何も速くしない。
 *
 * **`vscode` に依存させない**（`views`/`features` → `core` → `models` の向き）。
 * 印を打つ場所も書き出す場所も `extension.ts` 側にあり、ここは
 * 「入口から何ミリ秒か」を覚えて1行に組むだけである。
 */

/** 打った印ひとつ。`at` は起動の入口からの経過ミリ秒 */
interface Mark {
  readonly label: string;
  readonly at: number;
  /** 印に添える注記。無ければ `undefined` */
  readonly note?: string;
}

/** 印を打つ口。`beginStartupTiming` が返す */
export interface StartupTiming {
  /**
   * 印を打つ。
   *
   * **同じラベルは最初の1回だけ残す。** 作品一覧は描き直されるたびに
   * `getChildren` を通るので、2回目以降で上書きすると
   * 「初回の描画にかかった時間」が消えてしまう。
   *
   * @param note 印に添える一言（例「最長 教科書チート 2,100ms」）。
   *   **累積の数字だけでは、中で何件を相手にしたのかが分からない。**
   *   登録簿のように作品ごとに回る処理では、いちばん遅かった1件が
   *   分かると次にどこを見ればよいかが決まる。空文字は書かない
   *   （括弧だけが残って読めなくなる）
   */
  mark(label: string, note?: string): void;
  /** これまでの印を1行にまとめる */
  report(): string;
}

/** 印が1つも無いときに出す文言。空行を書いても読めないので、理由を書く */
const NO_MARKS = "起動の所要時間：記録がありません";

/**
 * 起動の入口で呼び、印を打つ口を受け取る。
 *
 * @param now 現在時刻（ミリ秒）。テストから差し替えられるように引数にする。
 *   既定が `Date.now()` でないのは、**時計合わせで巻き戻る**ことがあるため
 *   （経過時間を測るのに使ってはいけない）。`performance.now()` は
 *   Node にもブラウザの Web Worker にもある
 * @param beforeEntryMs **束の読み込みから `activate` の入口までにかかった時間**。
 *   静的importは呼ばれなくても読み込みの時点で全部走るので、
 *   `activate` の中をいくら刻んでも、ここが重ければ1つも印が付かない
 *   まま何秒も過ぎる。**入口より前は入口から測れない**ので、
 *   外（`extension.ts` の先頭）で測った値を受け取って先頭に添える。
 *   渡さなければ、これまでどおり印だけを並べる
 */
export function beginStartupTiming(
  now: () => number = () => performance.now(),
  beforeEntryMs?: number
): StartupTiming {
  const startedAt = now();
  const marks: Mark[] = [];
  const seen = new Set<string>();

  return {
    mark(label: string, note?: string): void {
      if (seen.has(label)) return;
      seen.add(label);
      // 空の注記は括弧だけが残るので、無かったことにする
      marks.push({ label, at: now() - startedAt, note: note || undefined });
    },
    report(): string {
      if (marks.length === 0) return NO_MARKS;
      /*
        **区間ではなく、入口からの累積で書く。** 「どこが重いか」より先に
        「どこで止まっているか」を読みたい。累積なら、作者が10秒と感じた
        瞬間がどの印の手前かをそのまま突き合わせられる。
      */
      const parts = marks.map(
        (mark) =>
          `${mark.label} ${formatStartupMillis(mark.at)}ms` +
          (mark.note ? `（${mark.note}）` : "")
      );
      /*
        **入口までの時間は、いちばん前に置く。** 起動は「束を読む →
        入口 → 印」の順に進むので、読む順と並び順を揃える。
        これだけは入口からの累積ではないため、ラベルで言い切る。
      */
      if (beforeEntryMs !== undefined) {
        parts.unshift(
          `束の読み込みから入口まで ${formatStartupMillis(beforeEntryMs)}ms`
        );
      }
      return `起動の所要時間：${parts.join(" → ")}`;
    },
  };
}

/**
 * ミリ秒を3桁区切りにする。
 *
 * `toLocaleString` を使わないのは、**動く場所で区切り方が変わる**ため
 * （ブラウザの言語設定しだいでは区切りが付かないこともある）。
 * ログは作者と開発側が同じ形で読む必要がある。
 *
 * **外へも出す。** 注記（`mark` の第2引数）は呼び出し側で組み立てるので、
 * そこで別の書き方をすると、同じ1行の中に区切りのある数字と無い数字が
 * 混ざる。
 */
export function formatStartupMillis(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
