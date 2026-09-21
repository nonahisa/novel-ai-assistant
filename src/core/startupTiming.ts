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
}

/** 印を打つ口。`beginStartupTiming` が返す */
export interface StartupTiming {
  /**
   * 印を打つ。
   *
   * **同じラベルは最初の1回だけ残す。** 作品一覧は描き直されるたびに
   * `getChildren` を通るので、2回目以降で上書きすると
   * 「初回の描画にかかった時間」が消えてしまう。
   */
  mark(label: string): void;
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
 */
export function beginStartupTiming(
  now: () => number = () => performance.now()
): StartupTiming {
  const startedAt = now();
  const marks: Mark[] = [];
  const seen = new Set<string>();

  return {
    mark(label: string): void {
      if (seen.has(label)) return;
      seen.add(label);
      marks.push({ label, at: now() - startedAt });
    },
    report(): string {
      if (marks.length === 0) return NO_MARKS;
      /*
        **区間ではなく、入口からの累積で書く。** 「どこが重いか」より先に
        「どこで止まっているか」を読みたい。累積なら、作者が10秒と感じた
        瞬間がどの印の手前かをそのまま突き合わせられる。
      */
      const parts = marks.map(
        (mark) => `${mark.label} ${formatMillis(mark.at)}ms`
      );
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
 */
function formatMillis(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
