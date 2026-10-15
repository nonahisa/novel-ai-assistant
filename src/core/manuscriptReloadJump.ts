/**
 * ウィンドウの再読み込みをまたいで「この原稿の、この行へ飛ぶ」を持ち越す
 * （作者の裁定 2026-10-15。設計書6.25.11）。
 *
 * 校正・メモパネルなどから行へ飛んだとき、飛び先の原稿の画面が拡張機能ホストの
 * 再起動でつながりの切れたものだと、こちらからは行を示せない。作者が
 * ［ウィンドウを再読み込み］を選んだら、再読み込みのあとに作り直された画面で
 * その行を示す。**再読み込みでこの拡張機能も読み込み直される**ので、頼みは
 * 作業場の覚え（workspaceState）に置き、作り直された画面が最初に動き出したとき
 * 1回だけ取り出す。
 *
 * ここは形の決まりだけを持つ（VS Code に依存させない。単体テストのため）。
 */

/** workspaceState に置くときの名前 */
export const MANUSCRIPT_RELOAD_JUMP_STATE_KEY = "novelai.manuscriptReloadJump";

/**
 * 頼みの有効期限。再読み込みは数秒で済むが、遅い機械や作品の多い作業場でも
 * 間に合うように広めに取る。**古い頼みは黙って捨てる**——何日も前の頼みが、
 * たまたま同じ原稿を開いたときに行を動かすと、作者には理由が分からない
 */
export const MANUSCRIPT_RELOAD_JUMP_TTL_MS = 10 * 60 * 1000;

/** 再読み込みをまたいで持ち越す頼み */
export interface ManuscriptReloadJump {
  /** 原稿の鍵（`manuscriptLedgerKey`） */
  key: string;
  /** 示す行（1始まり） */
  line: number;
  /** 頼んだ時刻（ISO） */
  savedAt: string;
}

/** 頼みを作る */
export function makeManuscriptReloadJump(
  key: string,
  line: number,
  now: Date
): ManuscriptReloadJump {
  return { key, line, savedAt: now.toISOString() };
}

/**
 * 覚えから読んだ値を確かめる。**形を信用しない**（手で書き換えられた・前の版の
 * 形が残っている等）。期限切れも undefined にする
 */
export function parseManuscriptReloadJump(
  raw: unknown,
  now: Date
): ManuscriptReloadJump | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.key !== "string" || record.key === "") return undefined;
  if (
    typeof record.line !== "number" ||
    !Number.isInteger(record.line) ||
    record.line < 1
  ) {
    return undefined;
  }
  if (typeof record.savedAt !== "string") return undefined;
  const savedAt = Date.parse(record.savedAt);
  if (Number.isNaN(savedAt)) return undefined;
  const age = now.getTime() - savedAt;
  // 未来の時刻（時計のずれ）も、期限を越えたものも使わない
  if (age < 0 || age > MANUSCRIPT_RELOAD_JUMP_TTL_MS) return undefined;
  return { key: record.key, line: record.line, savedAt: record.savedAt };
}

/**
 * 作り直された画面（鍵 `key`）が、覚えから頼みを取り出すときの判定。
 *
 * - `line`：この画面で示す行（無ければ undefined）
 * - `clear`：覚えを消すか。**使ったとき・壊れていたとき・期限切れのときは消す。**
 *   別の原稿への、まだ有効な頼みは残す（その原稿の画面がまだ作られていない
 *   ——背景のタブは前に出るまで作られない——ことがあるため）
 */
export function takeManuscriptReloadJump(
  raw: unknown,
  key: string,
  now: Date
): { line: number | undefined; clear: boolean } {
  if (raw === undefined) return { line: undefined, clear: false };
  const jump = parseManuscriptReloadJump(raw, now);
  if (!jump) return { line: undefined, clear: true };
  if (jump.key !== key) return { line: undefined, clear: false };
  return { line: jump.line, clear: true };
}
