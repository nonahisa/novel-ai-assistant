/**
 * 製品が作品の記録や本文を書いたことを、見ている画面へ知らせる掛け口
 * （作者の裁定 2026-11-06「提案を採るなど製品が書き換えたら、すぐ欄を新しくする」）。
 *
 * タイムラインの欄（`features/episodeTimeline.ts`）は、保存（`onDidSaveTextDocument`）の
 * ときにしか読み直していなかった。提案パネルの［適用］は `workspace.fs` で書くので
 * 保存の知らせが来ず、欄は古いまま残った。
 *
 * ## 掛ける場所
 *
 * 本文の書き戻し（`textFile.ts`）だけでなく、**記録を書く側**（編集履歴・操作ログ・
 * 指摘の置き場・編集者の提案の採否）にも掛ける。［適用］は本文を書いた**あと**に
 * 記録を3つ続けて書くので、本文の時点だけで知らせると、記録がまだ無い状態で
 * 読み直して古いまま止まる。
 *
 * **`vscode` に依存しない**（ただの呼び先の束）。`atomicWrite.ts` の `setWriteObserver` は
 * 設定の監視が「自分の書き込み」を見分けるのに使っている1つきりの口なので、流用しない。
 */

type Listener = (filePath: string) => void;

const listeners = new Set<Listener>();

/** 書いたことを聞く。返した関数を呼ぶと外れる */
export function onWorkRecordWritten(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 書いたことを知らせる。**聞き手が投げても、書いた側の処理は止めない**
 * （知らせは見た目の更新のためで、書き込みそのものは済んでいる）。
 */
export function notifyWorkRecordWritten(filePath: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(filePath);
    } catch {
      // 画面の更新の失敗で、記録の書き込みを失敗扱いにしない
    }
  }
}
