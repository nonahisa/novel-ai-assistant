import { normalizeForComparison } from "../core/paths";

/**
 * 送信を GitHub に断られた記録（コミット）の覚え（設計書5.5.21。2026-11-14 の作者の実機）。
 *
 * 書庫に 100MB を超えるファイルの入った記録ができ、送信が断られ続けた。自動の送り直しは
 * 5分おきに同じ記録を送り、同じ断られ方を繰り返していた（1GB 近い送信を毎回やり直す）。
 *
 * **鍵は置き場と HEAD のコミットID。** git の文は毎回数字が変わりうるので、文の一致では
 * 止まらない。記録が変われば（作者が記録し直した・取り込んだ）鍵が外れて、また試す。
 * 作者が押した同期・送信はこの覚えを見ない（押したら必ず試す）。通ったら忘れる。
 *
 * **回線が無くて届かなかったときは覚えない**——それは待てば通るので、送り直しの本来の仕事。
 * 覚えるのは、送り先が受け取ったうえで断ったとき（`PushResult.rejected`）と、送る前に
 * 上限を超えるファイルが見つかったときだけ。拡張機能を起動し直すと忘れる（覚えは画面の
 * 中だけ）。
 */
export class PushRejectionMemory {
  private readonly rejected = new Map<string, { head: string; reason: string }>();

  /** この置き場のこの記録を、断られたものとして覚える */
  remember(root: string, head: string | undefined, reason: string): void {
    if (!head) return;
    this.rejected.set(normalizeForComparison(root), { head, reason });
  }

  /** この置き場のこの記録が、前に断られたものか。断りの文を返す */
  rejectedReason(root: string, head: string | undefined): string | undefined {
    if (!head) return undefined;
    const found = this.rejected.get(normalizeForComparison(root));
    return found?.head === head ? found.reason : undefined;
  }

  /** 通った・記録が変わったら忘れる */
  forget(root: string): void {
    this.rejected.delete(normalizeForComparison(root));
  }
}

/** 拡張機能の中で1つだけ（すべて同期・単独の送信・自動の送り直しが同じものを見る） */
export const globalPushRejections = new PushRejectionMemory();
