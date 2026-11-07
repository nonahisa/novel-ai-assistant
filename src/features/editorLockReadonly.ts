/**
 * 編集者が校閲中の話を、素のテキストエディターで読み取り専用にする
 * （設計書5.7.5.2。作者の裁定 2026-11-07）。
 *
 * 使うのは VS Code の命令 `setActiveEditorReadonlyInSession`（1.79 から）。**設定ファイルは
 * 書き換えず、この窓のあいだだけ効く。** 解くときは `resetActiveEditorReadonlyInSession` で、
 * 作者の設定（`files.readonlyInclude` など）どおりの状態へ戻す——`setActiveEditorWriteableInSession`
 * だと、作者が設定で読み取り専用にしていた原稿まで書けるようにしてしまう。
 *
 * **命令は「いま前に出ている画面」に効く**（URI を渡せない）。そのため、
 * - 読み取り専用にするのは、校閲中の話の**素のエディター**が前にいるときだけ。原稿エディター
 *   （カスタムエディター）が前にいるときに呼ぶと、原稿エディターの文書が読み取り専用になる
 *   （原稿エディターは帯と関所で止めている）
 * - 解くのは、読み取り専用にした話の画面が前に出たとき（素のエディターでも原稿エディターでも。
 *   どちらも同じ文書に効く）。前に出ていなければ、次に前に出たときに解く
 *
 * VS Code に依らない（命令と前の画面を差し替え口にして、単体テストで見る）。
 */

export const READONLY_IN_SESSION_COMMAND = "workbench.action.files.setActiveEditorReadonlyInSession";
export const RESET_READONLY_IN_SESSION_COMMAND = "workbench.action.files.resetActiveEditorReadonlyInSession";

/** 前に出ている画面（`kind` は素のテキストエディターか、それ以外か） */
export interface ActiveEditorView {
  readonly uri: string;
  readonly kind: "text" | "other";
}

export interface ReadonlyKeeperDeps {
  active(): ActiveEditorView | undefined;
  /** その文書に編集者の鍵がかかっているか（作者モードのときだけ true になる形で渡す） */
  isLocked(uri: string): Promise<boolean>;
  execute(command: string): PromiseLike<unknown>;
}

export class SessionReadonlyKeeper {
  /** こちらが読み取り専用にした文書（URI の文字列） */
  private readonly madeReadonly = new Set<string>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ReadonlyKeeperDeps) {}

  /**
   * 前に出ている画面を、鍵に合わせる。**1つずつ順に**（画面の切り替えと鍵の書き込みが
   * 続けて来ても、命令が前後しない）。
   */
  settle(): Promise<void> {
    this.chain = this.chain.then(() => this.settleNow()).catch(() => undefined);
    return this.chain;
  }

  /**
   * 掛け直す（0.140.1）。作者が画面の吹き出しから読み取り専用を外しても、こちらの印は
   * 「掛けた」のまま残るので、印を忘れてから合わせ直す（`editorLockRevert.ts`）
   */
  reapply(uri: string): Promise<void> {
    this.chain = this.chain
      .then(() => {
        this.madeReadonly.delete(uri);
        return this.settleNow();
      })
      .catch(() => undefined);
    return this.chain;
  }

  private async settleNow(): Promise<void> {
    const active = this.deps.active();
    if (!active) return;
    const wasReadonly = this.madeReadonly.has(active.uri);
    // 素のエディターでなく、こちらが読み取り専用にもしていない画面は、鍵を読むまでもない
    if (active.kind !== "text" && !wasReadonly) return;
    let locked: boolean;
    try {
      locked = await this.deps.isLocked(active.uri);
    } catch {
      // 鍵が読めないときは書かせる側へ倒す
      locked = false;
    }
    /*
      **確かめている間に前の画面が替わったら呼ばない。** 命令は前にいる画面に効くので、
      別の話（校閲中でない話）を読み取り専用にしてしまう。替わった先は、替わった知らせで
      もう一度ここへ来る
    */
    if (this.deps.active()?.uri !== active.uri) return;
    if (locked && active.kind === "text" && !wasReadonly) {
      try {
        await this.deps.execute(READONLY_IN_SESSION_COMMAND);
        this.madeReadonly.add(active.uri);
      } catch {
        // 古い VS Code など。保存したときの警告は別に出ている
      }
      return;
    }
    if (!locked && wasReadonly) {
      try {
        await this.deps.execute(RESET_READONLY_IN_SESSION_COMMAND);
        this.madeReadonly.delete(active.uri);
      } catch {
        // 解けなかった。次に前に出たときにもう一度試す
      }
    }
  }
}
