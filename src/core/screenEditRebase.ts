/**
 * 画面（原稿エディター）から届いた本文を、**画面が知らない本体の変更を消さずに**
 * 文書へ当てる（設計書6.25.9。作者の裁定「塞ぐ」、2026-10-04）。
 *
 * ## 穴
 *
 * 画面は打った本文を全文で送り、本体は文書との差を当てる（`textEdit.ts`）。
 * 本体の側で文書が変わった直後（傍点を外した・提案を当てた・メモの行を足した）は、
 * その本文が画面へ届くまで `scheduleSend` の120ミリ秒ほどかかる。その間に打つと、
 * 画面の全文はまだ本体の変更を知らないので、差を当てると**本体の変更が戻る**。
 *
 * ## 塞ぎ方
 *
 * 画面は便に「どの本文を元にしたか」（元の本文の指紋 `base`）を添える。
 * 本体は指紋から元の本文を引き、
 *
 * - 元の本文＝いまの文書 → これまでどおり差を当てる
 * - 違う → 「元→画面」（打った所）と「元→文書」（画面が知らない変更）を比べ、
 *   **重ならなければ、打った所だけを今の文書へ当て直す**
 * - 重なる・元の本文が分からない → **当てない**。画面へ打った本文を返し、
 *   画面はそれを控えて帯で知らせる（［戻す］で打った字のほうへ戻せる）
 *
 * どちらの道でも、作者の打った字も本体の変更も黙っては消えない（実装ルール1）。
 *
 * ## 元の本文は「鎖」でたどる
 *
 * 画面の便の元は、**直前に自分が送った本文**か、**最後に取り込んだ本体の本文**
 * である。本体は、送った本文と、当て終えた画面の本文（当て直したときも
 * 画面の本文のほう）を指紋で覚えておく。当てられなかった本文は「その元」を
 * 覚え、次の便の元がそれならさらに1つさかのぼる（入っていない字を、入った
 * ことにしない）。
 *
 * **文書の版番号（`document.version`）にしなかった理由**：画面が便1を送り、
 * 本体が当て、そのあと本体の変更が来て、画面が便2を送ったとき、便2の元は
 * 「便1の本文」である。版番号で持つと元は「最後に画面へ届いた文書」になり、
 * 便1の字が「画面が知らない変更」の側にも入るので、重なっていないのに
 * ぶつかったことになる。
 *
 * vscode に依存しない（単体テストで試すため。`core` の決まり）。
 */
import { computeMinimalEdit } from "./textEdit";

/**
 * 本文の指紋。**画面のスクリプト（`manuscriptEditorHtml.ts` の `textHash`）と
 * 同じ計算でなければならない**（FNV-1a 32ビット＋字数。照合だけに使う）。
 * 同じであることは `test/unit/cross/screenEditBase.test.ts` が見張る。
 */
export function textFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ("0000000" + hash.toString(16)).slice(-8) + ":" + text.length;
}

/** 当て直しの結果 */
export type RebaseResult =
  /** 文書をこの本文にする（打った所だけが変わる） */
  | { kind: "apply"; text: string }
  /** 打った所と画面が知らない変更が重なった。どちらが正しいかは決められない */
  | { kind: "conflict" };

/**
 * 「元→画面」の変更を、「元→文書」の変更のあとの文書へ当て直す。
 *
 * 変わった所はそれぞれ1か所として見る（`computeMinimalEdit`）。本体の変更が
 * 離れた2か所にあると、その間ぜんぶを変わった所と見るので、間で打った字は
 * 「重なった」に倒れる——**当て直しを誤るより、当てずに知らせるほうへ倒す。**
 *
 * **同じ位置へ両方が字を足したときも重なったと見る。** どちらを先に置くかを
 * 決められないうえ、同じ字を足していたら二重に入る。
 */
export function rebaseScreenEdit(base: string, screen: string, doc: string): RebaseResult {
  const typed = computeMinimalEdit(base, screen);
  // 画面に新しく打った所が無い：文書のままでよい（画面の字はもう入っている）
  if (!typed) return { kind: "apply", text: doc };
  const outside = computeMinimalEdit(base, doc);
  // 画面が知らない変更が無い：画面の本文そのもの
  if (!outside) return { kind: "apply", text: screen };

  const bothInsertAtSamePoint =
    typed.start === typed.end &&
    outside.start === outside.end &&
    typed.start === outside.start;
  if (bothInsertAtSamePoint) return { kind: "conflict" };

  if (typed.end <= outside.start) {
    // 打った所が前：位置はそのまま
    return {
      kind: "apply",
      text: doc.slice(0, typed.start) + typed.insert + doc.slice(typed.end),
    };
  }
  if (typed.start >= outside.end) {
    // 打った所が後ろ：本体の変更で増減したぶんだけずらす
    const shift = doc.length - base.length;
    return {
      kind: "apply",
      text: doc.slice(0, typed.start + shift) + typed.insert + doc.slice(typed.end + shift),
    };
  }
  return { kind: "conflict" };
}

/** 画面から届いた1便（`editQueue.ts` の `SentEdit` と同じ形の部分） */
export interface ScreenEditInput {
  text: string;
  /** 元の本文の指紋。無い便（指紋を添える前の画面・試験の送り手）は今までどおり当てる */
  base?: string;
}

/** 本体がどうするか */
export type ScreenEditDecision =
  /**
   * 文書をこの本文にする。`rebased` は「画面が知らない変更があったので当て直した」。
   * `baseKey` はたどり着いた元の本文の指紋（当てられなかったときに覚える）
   */
  | { kind: "apply"; text: string; rebased: boolean; baseKey?: string }
  /**
   * 当てない。`reason` は記録のため——`overlap`：重なった／`unknownBase`：
   * 元の本文を覚えていない（覚えておく数を越えた・届かなかった便の上に打った）
   */
  | { kind: "conflict"; reason: "overlap" | "unknownBase"; baseKey?: string };

type LedgerEntry =
  | { kind: "known"; text: string }
  /** 当てられなかった本文。元をさかのぼるために、その元の指紋だけを持つ */
  | { kind: "rejected"; baseKey: string | undefined };

/**
 * 元の本文の控え帳。原稿エディターの面1枚に1冊。
 *
 * 覚えるのは**最近の数十件だけ**（古い元は使われない。画面は、送るたびに
 * 元を直前の本文へ進め、本体の本文を取り込むたびにそれへ進める）。
 * 越えた古い元で便が来たら「元が分からない」として当てずに知らせる。
 */
export interface ScreenEditLedger {
  /** 画面へ送った本文（LF空間） */
  rememberSent(text: string): void;
  /** 当て終えた画面の本文（当て直したときも、画面の本文のほうを覚える） */
  rememberApplied(text: string): void;
  /** 当てられなかった画面の本文と、たどり着いた元の指紋 */
  rememberRejected(text: string, baseKey: string | undefined): void;
  /** 届いた便をどう当てるか。`doc` はいまの文書（LF空間） */
  decide(item: ScreenEditInput, doc: string): ScreenEditDecision;
}

/** 控え帳に残す件数。画面へ送った本文と当てた本文の両方が入るので、ゆとりを持たせる */
const LEDGER_LIMIT = 64;
/** 当てられなかった本文をさかのぼる回数の上限（輪になっていても止まる） */
const MAX_HOPS = 32;

export function createScreenEditLedger(limit = LEDGER_LIMIT): ScreenEditLedger {
  const entries = new Map<string, LedgerEntry>();

  const put = (key: string, entry: LedgerEntry): void => {
    // 新しく入れ直して、古い順の並びの末尾へ回す
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > limit) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  /** 指紋から、文書に入っていると分かっている元の本文までたどる */
  const resolve = (key: string): { text: string; key: string } | undefined => {
    let at: string | undefined = key;
    for (let hop = 0; hop < MAX_HOPS && at !== undefined; hop++) {
      const entry = entries.get(at);
      if (!entry) return undefined;
      if (entry.kind === "known") return { text: entry.text, key: at };
      at = entry.baseKey;
    }
    return undefined;
  };

  return {
    rememberSent(text) {
      put(textFingerprint(text), { kind: "known", text });
    },
    rememberApplied(text) {
      put(textFingerprint(text), { kind: "known", text });
    },
    rememberRejected(text, baseKey) {
      const key = textFingerprint(text);
      // 自分自身を元にした「当てられなかった」は輪になるので、元を持たせない
      put(key, { kind: "rejected", baseKey: baseKey === key ? undefined : baseKey });
    },
    decide(item, doc) {
      // 文書がもう画面の本文になっている（送り直しの便など）
      if (item.text === doc) return { kind: "apply", text: doc, rebased: false };
      if (item.base === undefined) return { kind: "apply", text: item.text, rebased: false };
      const base = resolve(item.base);
      if (!base) return { kind: "conflict", reason: "unknownBase" };
      if (base.text === doc) {
        return { kind: "apply", text: item.text, rebased: false, baseKey: base.key };
      }
      const result = rebaseScreenEdit(base.text, item.text, doc);
      if (result.kind === "conflict") {
        return { kind: "conflict", reason: "overlap", baseKey: base.key };
      }
      return { kind: "apply", text: result.text, rebased: true, baseKey: base.key };
    },
  };
}
