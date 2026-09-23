import { stripCodeFence } from "./synopsisValidation";
import { findReaderTypeLabels, readerLeakNote } from "./publicityReader";
import {
  BLURB_MAX_CHARS,
  BLURB_MIN_CHARS,
  CATCHPHRASE_MAX_CHARS,
  type CatchphraseCandidate,
} from "../prompts/blurb";

/**
 * 作品紹介文（P-06）とキャッチコピー（P-08）の応答を読む。
 *
 * **`features/generateBlurb.ts` から切り出した**（0.66.0。設計書6.87.3）。
 * MCP の束は `vscode` へ届くものを持ち込めないので、判断の部分だけを
 * `core` へ移した。**元のファイルが再輸出する**ので、使う側の書き方は
 * 今までどおりである。
 *
 * **字数はコードで測り直す**（CLAUDE.md 規則3）。AIは「300〜400字」と
 * 言われても外す——超えたことを黙って通すと、投稿サイトの入力欄で
 * 弾かれるのは作者である。
 */

export interface BlurbResponse {
  blurb: string;
  spoilerCheck: string | null;
}

export function parseBlurbResponse(text: string): BlurbResponse | null {
  const value = parseJson(text);
  if (!value || typeof value.blurb !== "string") return null;
  const blurb = value.blurb.trim();
  if (!blurb) return null;
  return {
    blurb,
    spoilerCheck:
      typeof value.spoilerCheck === "string" ? value.spoilerCheck : null,
  };
}

export function parseCatchphraseResponse(text: string): CatchphraseCandidate[] {
  const value = parseJson(text);
  if (!value || !Array.isArray(value.catchphrases)) return [];
  return value.catchphrases
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry)
    )
    .filter((entry) => typeof entry.text === "string")
    .map((entry) => ({
      text: (entry.text as string).trim().replace(/\s+/g, " "),
      kind: typeof entry.kind === "string" ? entry.kind : "",
      intent: typeof entry.intent === "string" ? entry.intent : null,
    }));
}

/**
 * 紹介文の字数を測る。**短すぎ・長すぎの両方を見る。**
 *
 * 長いほうだけを見ると、「1行で終わった紹介文」が満点で通る
 * （CLAUDE.md の「見逃しと誤検出の両方を測る」と同じ考え）。
 */
export function measureBlurb(blurb: string): {
  chars: number;
  tooShort: boolean;
  tooLong: boolean;
} {
  return {
    chars: blurb.length,
    tooShort: blurb.length < BLURB_MIN_CHARS,
    tooLong: blurb.length > BLURB_MAX_CHARS,
  };
}

/**
 * 紹介文に層の呼び名（「考察層」など）が出ていたときの注意。出ていなければ `undefined`。
 *
 * **捨てない**（字数と同じ扱い）。400字の紹介文の1語のために全部を
 * 作り直させるより、どこを直せばよいかを言って作者に直してもらうほうが早い。
 * プロンプトへ層の名前を書いて渡すので、そのまま返ってくる前提で見る
 * （CLAUDE.md の失敗3）。
 */
export function blurbReaderLeakNote(blurb: string): string | undefined {
  const labels = findReaderTypeLabels(blurb);
  if (labels.length === 0) return undefined;
  return readerLeakNote(labels);
}

/** 層の呼び名で落とした案の理由の頭。画面側はこれで見分ける（文言の写しを作らない） */
export const READER_LEAK_REASON_HEAD = "読者層の呼び名";

/**
 * 字数に収まり、層の呼び名を含まないキャッチコピーだけを残す。
 * **落としたぶんは理由とともに返す**
 *
 * **層の呼び名が入った案は落とす**（字数超えと同じ扱い）。30字の中の
 * 「すきま層」は言い換えると別の案になるので、貼れない案を選ばせない。
 */
export function screenCatchphrases(candidates: readonly CatchphraseCandidate[]): {
  kept: CatchphraseCandidate[];
  dropped: Array<{ candidate: CatchphraseCandidate; reason: string }>;
} {
  const kept: CatchphraseCandidate[] = [];
  const dropped: Array<{ candidate: CatchphraseCandidate; reason: string }> = [];
  for (const candidate of candidates) {
    if (!candidate.text) {
      dropped.push({ candidate, reason: "empty" });
      continue;
    }
    if (candidate.text.length > CATCHPHRASE_MAX_CHARS) {
      dropped.push({
        candidate,
        reason: `${candidate.text.length}字（上限${CATCHPHRASE_MAX_CHARS}字）`,
      });
      continue;
    }
    const labels = findReaderTypeLabels(candidate.text);
    if (labels.length > 0) {
      dropped.push({
        candidate,
        reason: `${READER_LEAK_REASON_HEAD}（${labels.join("・")}）が入っています`,
      });
      continue;
    }
    kept.push(candidate);
  }
  return { kept, dropped };
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stripCodeFence(text));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
