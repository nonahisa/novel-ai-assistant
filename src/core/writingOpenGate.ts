/**
 * 「その日にその話の起点をもう置いたか」の覚え（作者の答え、2026-11-12）。
 *
 * 話を開くたびに起点を置き直すと、開き直しで今日の字数が0に戻ってしまう。
 * 日付（一日の区切りを適用済みの鍵）ごとに1回だけ通す。日付が変われば
 * また1回通る（開いたまま日付をまたいだときの置き直し）。
 *
 * 覚えは手元の動いているあいだだけ。VS Code を閉じて開き直したあとは
 * もう一度置くが、記録済みの分は起点にすでに入っているので、
 * 失うのは「VS Code の外で変わった差」だけである。
 */
export class OpenDayGate {
  private readonly claimed = new Map<string, string>();

  /** 通してよければ true（その日の1回目）。通したら覚える */
  claim(key: string, day: string): boolean {
    if (this.claimed.get(key) === day) return false;
    this.claimed.set(key, day);
    return true;
  }

  /** 起点を置けなかったとき、次に開いたときもう一度通すために忘れる */
  release(key: string): void {
    this.claimed.delete(key);
  }
}
