/**
 * 素のテキストエディターで、作者が自分で読み取り専用を外して校閲中の話に打ったとき
 * （0.141.1。作者の答え 2026-11-07「打った時点で戻す」。設計書5.7.5.2）。
 *
 * 読み取り専用（`editorLockReadonly.ts`）は VS Code の画面の機能なので、吹き出しの
 * 「Click here to set writeable」から作者が外せる。外して打っても、範囲の話は作者が書けない
 * 決まり（5.7.5）なので、**打った時点で**次を順にする：
 *
 * 1. 打った字を含む本文を、原稿エディターと同じ控え（［戻す］の控え。7日）へ回す
 * 2. 文書をファイルの中身へ戻す（原稿のファイルには書かない）
 * 3. 読み取り専用を掛け直す
 *
 * そして右下に知らせる（1分に1回まで）。**自分で戻した書き換えでもう一度走らない**よう、
 * 戻している間の知らせは無視する（戻したあとは文書がファイルの中身と同じなので、そこでも止まる）。
 *
 * VS Code に依らない（口を差し替えて単体テストで見る。つなぐのは `editorLockGuard.ts`）。
 */

export interface LockedEditRevertDeps {
  /**
   * その文書に編集者の鍵があれば、知らせの括弧の中（「編集者 kmizu・11月7日 18:30 から」）。
   * 鍵が無い・作者モードでない・読めないときは undefined（何もしない）
   */
  lockDetail(uri: string): Promise<string | undefined>;
  /** いま前に出ている**素のテキストエディター**の文書（原稿エディターが前なら undefined） */
  activePlainEditorUri(): string | undefined;
  /** ファイルにある本文（改行は LF にそろえたもの） */
  readFileText(uri: string): Promise<string>;
  /** 打った字を含む本文を控えへ回す（`text`・`base` とも改行は LF） */
  rescue(uri: string, text: string, base: string): Promise<void>;
  /** 文書をファイルの中身へ戻す（保存しない） */
  revert(uri: string): Promise<void>;
  /** 読み取り専用を掛け直す */
  reapplyReadonly(uri: string): Promise<void>;
  /** 右下の知らせ（`uri` は［連携を解除…］で作品を引くため） */
  notify(message: string, uri: string): void;
  now?: () => number;
}

/** 同じ話への知らせの間（打つたびに出さない） */
export const LOCKED_EDIT_NOTICE_INTERVAL_MS = 60_000;

export class LockedPlainEditReverter {
  /** 戻している途中の文書（この間に届く書き換えの知らせは、自分で戻した分） */
  private readonly reverting = new Set<string>();
  private readonly notifiedAt = new Map<string, number>();

  constructor(private readonly deps: LockedEditRevertDeps) {}

  /**
   * 文書が書き換わったとき。
   *
   * @param readText いまの文書の本文（改行は LF）。**戻す直前に読み直す**——鍵を読んでいる間に
   *   打った字も控えへ入れるため
   */
  async onChange(uri: string, fileName: string, readText: () => string): Promise<void> {
    if (this.reverting.has(uri)) return;
    // 原稿エディター（カスタムエディター）が前のときは、そちらの関所と帯が受け持つ
    if (this.deps.activePlainEditorUri() !== uri) return;
    const detail = await this.deps.lockDetail(uri);
    if (detail === undefined) return;
    if (this.reverting.has(uri) || this.deps.activePlainEditorUri() !== uri) return;
    const base = await this.deps.readFileText(uri);
    this.reverting.add(uri);
    try {
      const typed = readText();
      // 打って消した（ファイルの中身と同じ）なら、戻すものも控えるものも無い
      if (typed === base) return;
      await this.deps.rescue(uri, typed, base);
      await this.deps.revert(uri);
    } finally {
      this.reverting.delete(uri);
    }
    await this.deps.reapplyReadonly(uri);
    const now = (this.deps.now ?? Date.now)();
    const last = this.notifiedAt.get(uri);
    if (last !== undefined && now - last < LOCKED_EDIT_NOTICE_INTERVAL_MS) return;
    this.notifiedAt.set(uri, now);
    this.deps.notify(`「${fileName}」は編集者が校閲中のため、書けません（${detail}）。打った字は控えました。`, uri);
  }
}
