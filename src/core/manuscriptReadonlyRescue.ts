/**
 * 読み取り専用の原稿に打った字の、拡張機能の側の控え（作者の裁定、2026-10-15 23時。
 * 設計書6.25.9）。
 *
 * 設定（`files.readonlyInclude` など）で読み取り専用になった原稿では、原稿エディターで
 * 打った字は保存されない。画面は字を控える（`setState` の rescue）が、**タブを閉じると
 * 画面の状態ごと消える**——しかも VS Code は文書が未保存にならないので確認を出さない。
 * そこで拡張機能の側（作業場の覚え）にも同じ形の控えを置き、次に同じ原稿を開いたときに
 * 既存の控えの帯（「前回、原稿に入らなかった字があります」［戻す］）で取り戻せるようにする。
 *
 * **作者の原稿は書き換えない。** ［戻す］は画面へ戻すだけで、保存は作者の操作。
 *
 * 形は画面の控え（`ManuscriptRescue`）と同じ（画面は区別せずに帯で出す）。
 * ここは形の決まりだけを持つ（VS Code に依存させない。単体テストのため）。
 */
import { screenTextHash } from "./screenEditRebase";

/** 作業場の覚え（workspaceState）に置くときの名前 */
export const MANUSCRIPT_READONLY_RESCUE_STATE_KEY = "novelai.manuscriptReadonlyRescue";

/**
 * 控えの期限。**画面の控えと同じ7日**（`manuscriptEditorHtml.ts` の `RESCUE_MAX_AGE_MS`）。
 * 画面はこれより古い控えを出さないので、こちらだけ長く持っても使われない。
 * 何日も前の字は、作者が何を打ったか覚えていない
 */
export const MANUSCRIPT_READONLY_RESCUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 控えを持つ原稿の数の上限。1話ぶんの本文を丸ごと持つので、際限なく積まない
 * （古いものから落とす）。読み取り専用の原稿を何十話も続けて打つことは考えにくい
 */
export const MANUSCRIPT_READONLY_RESCUE_MAX = 20;

/** 1原稿の控え（画面の控え `ManuscriptRescue` と同じ形） */
export interface ReadonlyRescue {
  /** 原稿の鍵（`manuscriptLedgerKey`。画面の docKey と同じ） */
  docKey: string;
  /** 画面の本文（打った字を含む全文） */
  text: string;
  /** 控えた時刻（ミリ秒） */
  at: number;
  /** 元になった本文（ファイルにある本文）の字数 */
  baseLength: number;
  /** その指紋（画面の textHash と同じ8桁）。戻すとき、外で変わっていないかを見る */
  baseHash: string;
}

/** 覚えに置く形（原稿の鍵 → 控え） */
export type ReadonlyRescueStore = Record<string, ReadonlyRescue>;

/** 書いた結果。`value` が undefined なら覚えの鍵ごと消す */
export interface ReadonlyRescueWrite {
  changed: boolean;
  value: ReadonlyRescueStore | undefined;
}

/**
 * 控えを作る。`base` は**元になった本文**——読み取り専用と分かった最初の便を当てる前の
 * 文書の本文（＝ファイルにある本文）。読み取り専用でもメモリ上の文書には字が入るので、
 * 2便目以降の「当てる前の本文」は打った字を含み、元にならない
 */
export function makeReadonlyRescue(
  docKey: string,
  text: string,
  base: string,
  now: number
): ReadonlyRescue {
  return { docKey, text, at: now, baseLength: base.length, baseHash: screenTextHash(base) };
}

function parseOne(key: string, value: unknown, now: number): ReadonlyRescue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.docKey !== key ||
    typeof record.text !== "string" ||
    typeof record.at !== "number" ||
    typeof record.baseLength !== "number" ||
    typeof record.baseHash !== "string"
  ) {
    return undefined;
  }
  const age = now - record.at;
  // 未来の時刻（時計のずれ）も、期限を越えたものも使わない
  if (age < 0 || age > MANUSCRIPT_READONLY_RESCUE_TTL_MS) return undefined;
  return {
    docKey: key,
    text: record.text,
    at: record.at,
    baseLength: record.baseLength,
    baseHash: record.baseHash,
  };
}

/**
 * 覚えから読んだ値を確かめる。**形を信用しない**（手で書き換えられた・前の版の形が
 * 残っている等）。壊れたもの・期限切れのものは落とす
 */
export function parseReadonlyRescues(raw: unknown, now: number): ReadonlyRescueStore {
  const out: ReadonlyRescueStore = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const one = parseOne(key, value, now);
    if (one) out[key] = one;
  }
  return out;
}

function finish(store: ReadonlyRescueStore): ReadonlyRescueStore | undefined {
  return Object.keys(store).length > 0 ? store : undefined;
}

/** その原稿の控えを取り出す（**消さない**。作者が［戻す］か［捨てる］を選ぶまで残す） */
export function takeReadonlyRescue(
  raw: unknown,
  docKey: string,
  now: number
): ReadonlyRescue | undefined {
  return parseReadonlyRescues(raw, now)[docKey];
}

/**
 * 控えを置く（同じ原稿の控えは入れ替える）。同じ本文・同じ元なら書き直さない
 * ——画面は届かない便を4秒ごとに送り直すので、そのたびに覚えへ書かない
 */
export function putReadonlyRescue(
  raw: unknown,
  rescue: ReadonlyRescue,
  now: number
): ReadonlyRescueWrite {
  const store = parseReadonlyRescues(raw, now);
  const known = store[rescue.docKey];
  if (
    known &&
    known.text === rescue.text &&
    known.baseLength === rescue.baseLength &&
    known.baseHash === rescue.baseHash
  ) {
    return { changed: false, value: finish(store) };
  }
  delete store[rescue.docKey];
  store[rescue.docKey] = rescue;
  // 多すぎたら古い控えから落とす（いま置いた控えは残る）
  const keys = Object.keys(store).sort((a, b) => store[a].at - store[b].at);
  while (keys.length > MANUSCRIPT_READONLY_RESCUE_MAX) {
    const oldest = keys.shift();
    if (oldest === undefined || oldest === rescue.docKey) break;
    delete store[oldest];
  }
  return { changed: true, value: finish(store) };
}

/**
 * ［戻す］［捨てる］で片づいた控え。**本文が同じ控えだけを消す**——同じ原稿の別の帯
 * （重なって入らなかった字など）を片づけただけで、読み取り専用の控えを消さないため
 */
export function settleReadonlyRescue(
  raw: unknown,
  docKey: string,
  text: string,
  now: number
): ReadonlyRescueWrite {
  const store = parseReadonlyRescues(raw, now);
  const known = store[docKey];
  if (!known || known.text !== text) return { changed: false, value: finish(store) };
  delete store[docKey];
  return { changed: true, value: finish(store) };
}

/**
 * その原稿の控えを消す（読み取り専用が外れ、打った字が文書に入って未保存になった。
 * そこから先は VS Code の保存と閉じる前の確認が字を守る）
 */
export function dropReadonlyRescue(
  raw: unknown,
  docKey: string,
  now: number
): ReadonlyRescueWrite {
  const store = parseReadonlyRescues(raw, now);
  if (!store[docKey]) return { changed: false, value: finish(store) };
  delete store[docKey];
  return { changed: true, value: finish(store) };
}
