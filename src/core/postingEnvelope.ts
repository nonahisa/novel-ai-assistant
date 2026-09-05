import { POSTING_SITES, type PostingSiteId } from "../models/posting";

/**
 * 貼り込み係（Chrome拡張）へ渡すJSON封筒（設計書6.79.3）。
 *
 * ## 何のためのものか
 *
 * 投稿画面の欄を埋めるのはブラウザ側の拡張で、こちらは**変換済みの本文を
 * クリップボードへ置くだけ**である。母艦（この拡張機能）が投稿サイトへ
 * HTTPを発することは無く、送信ボタンを押すのは作者である（6.79.2）。
 *
 * ## なぜ純粋関数にしてあるか
 *
 * この形は**別プロジェクト（ブラウザ拡張）との約束事**なので、片方だけが
 * 変わると向こう側が黙って動かなくなる。組み立てと読み取りを対で置き、
 * 往復のテストで形を固定する。
 *
 * **組み立ては `JSON.stringify` だけを使う。** 文字列を継ぎ足して手で組むと、
 * 本文の引用符・改行・バックスラッシュで壊れる——本文はまさにそれらを
 * 含むものである。
 *
 * VS Code API には依存しない。
 */

/**
 * 封筒の形式版数。**読む側はこの数値と一致するときだけ受け取る。**
 *
 * 欄の意味を変えるときに上げる。上げずに意味だけ変えると、古いブラウザ拡張が
 * 違う欄へ貼り込むことになる。
 */
export const POSTING_ENVELOPE_VERSION = 1;

/** 封筒の目印になる欄の名前（ただのJSONを封筒と読み違えないため） */
const MARKER = "novelai-post";

export interface PostingEnvelope {
  /** 形式版数。`POSTING_ENVELOPE_VERSION` と一致するものだけを受ける */
  [MARKER]: typeof POSTING_ENVELOPE_VERSION;
  site: PostingSiteId;
  /**
   * 台帳の作品ID（6.68.5の `siteProfiles.workId`）。**入っていれば**、
   * 貼り込み係が投稿画面のURLと突き合わせて取り違えを止める（6.79.6の2）。
   *
   * 入れていない作品も多いので任意。**空文字は入れない**——向こう側が
   * 「IDが空の作品」として照合してしまう。
   */
  workId?: string;
  /** 題名の欄へ入れる文字列（話の見出し） */
  title: string;
  /** 変換済みの本文（サイトごとのルビ・傍点の記法は既存の6.68.4が正） */
  body: string;
}

/*
  **前書き・後書きの欄は作らない。** 母艦に相当するデータが無いためで、
  空欄を先回りして作ると「入れる場所があるのに常に空」になる。
  作るときは形式版数を上げ、ブラウザ拡張と一緒に足す（6.79.3）。
*/

/**
 * 貼り込み係へ渡せるサイト（設計書6.79.1・6.79.8）。
 *
 * **noteは出さない。** 規約の原文ページが機械取得を拒むため人の目での
 * 確認が済んでおらず、対応は後回しと決まっている。ここが唯一の判断の
 * 置き場で、画面はこれを引く（写しを作ると片方だけ増える）。
 *
 * **なろうも出さない**（0.33.2で外した）。規約の判断が作者の手元で
 * 止まっており、**貼り込み係の側も `supported: false`** のままである——
 * 封筒だけ渡せる状態にしておくと、作者が投稿画面でボタンを押しても
 * 何も起きず、なぜ起きないのかが分からない（上の「対応していない
 * サイトでは選択肢そのものを出さない」と同じ理由）。
 * **解禁するときは、貼り込み係側の `supported`／`matches` と同時に戻す。**
 */
const PASTE_HELPER_SITES: readonly PostingSiteId[] = [
  "kakuyomu",
  "alphapolis",
];

/** 貼り込み係へ渡せるサイトを、`POSTING_SITES` の並びで返す */
export function pasteHelperSites(): readonly PostingSiteId[] {
  return POSTING_SITES.filter((info) =>
    PASTE_HELPER_SITES.includes(info.id)
  ).map((info) => info.id);
}

export function supportsPasteHelper(site: PostingSiteId): boolean {
  return PASTE_HELPER_SITES.includes(site);
}

/**
 * 封筒を組み立てる。返すのは**クリップボードへ入れる文字列**である。
 *
 * @param input.workId 空・空白だけなら欄ごと書かない
 */
export function buildPostingEnvelope(input: {
  site: PostingSiteId;
  workId?: string | null;
  title: string;
  body: string;
}): string {
  const workId = (input.workId ?? "").trim();
  return JSON.stringify({
    [MARKER]: POSTING_ENVELOPE_VERSION,
    site: input.site,
    ...(workId ? { workId } : {}),
    title: input.title,
    body: input.body,
  });
}

/**
 * 封筒を読む。**封筒でなければ `null`**（例外は投げない）。
 *
 * クリップボードには何が入っているか分からない——本文の断片も、別の
 * アプリがコピーしたものもありうる。**読めなければ何もしない**のが
 * 貼り込み係の約束（6.79.3）なので、読み取り側も「読めなかった」を
 * 静かに返す形にしてある。
 *
 * 母艦側では、いまのところテストと将来の取り込み経路が使う
 * （読者の反応の封筒 `novelai-stats` は6.79.7の別の形）。
 */
export function parsePostingEnvelope(raw: string): PostingEnvelope | null {
  // クリップボード経由なので、前後に改行や空白が付くことがある
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const value = parsed as Record<string, unknown>;
  // **知らない版数は読まない。** 「たぶん大丈夫」で通すと、欄の意味が
  // 変わったときに違う欄へ貼り込むことになる
  if (value[MARKER] !== POSTING_ENVELOPE_VERSION) return null;

  const site = value.site;
  if (typeof site !== "string") return null;
  const known = POSTING_SITES.find((info) => info.id === site);
  if (!known) return null;

  const { title, body, workId } = value;
  if (typeof title !== "string" || typeof body !== "string") return null;
  if (workId !== undefined && typeof workId !== "string") return null;

  const trimmedWorkId = (workId ?? "").trim();
  return {
    [MARKER]: POSTING_ENVELOPE_VERSION,
    site: known.id,
    ...(trimmedWorkId ? { workId: trimmedWorkId } : {}),
    title,
    body,
  };
}
