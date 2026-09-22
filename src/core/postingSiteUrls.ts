import {
  postingSiteInfo,
  type PostingSiteId,
  type PostingSiteProfile,
} from "../models/posting";
import { narouNcode } from "./postingSiteRecords";

/**
 * 投稿ページのURLから、作品IDと作品ページを導く（設計書6.68.5）。
 *
 * ## なぜ導くのか
 *
 * 「作品ID・作品ページ・ジャンルを入れる」は3つとも手入力だった。だが
 * **作品IDと作品ページは、直前に貼ってもらった投稿ページのURLに書いてある**
 * ——作者の指摘（2026-09-22）は「ジャンル以外は更新用URLから抽出できます」
 * である。同じ数字を2度打たせない。
 *
 * ## 何を導いて、何を導かないか
 *
 * **形が確かめられたサイトだけ導く。** `core/snsShare.ts` の `workListUrl`
 * と同じ線で、埋めた先が存在しないページになるくらいなら、空のまま訊く
 * ほうがよい。いまのところ導けるのは**なろうとカクヨム**だけである。
 *
 * - **アルファポリス**は導かない。投稿画面のパスの形が実機で確かめられて
 *   おらず（貼り込み係 `content/sites.js` も「投稿画面のパスは実機未確認」
 *   として3つの候補を並べている）、`models/posting.ts` の例
 *   （`/novel/manage/000000/0000`）と貼り込み係が当てている形
 *   （`/manage/novel/{数字}/episode/new`）で作品IDの部数まで食い違う。
 *   **片方だけの番号を作品IDの欄へ入れると、作品を指せないIDが台帳に残る**
 *   （`models/posting.ts` の `workIdExample` に、その失敗の記録がある）
 * - **note**には「作品」の単位が無い（記事とマガジン）ので導きようがない
 *
 * ## サイトへは触りにいかない
 *
 * ここが読むのは**渡された文字列だけ**である（6.68.1）。HTTPは発しないし、
 * ページの実在も確かめない。VS Code API にも依存しない。
 */

/** 投稿ページのURLから読めたもの。読めなかった欄は入れない */
export interface DerivedSiteProfile {
  /** サイト内の作品ID */
  workId?: string;
  /** 読者が見る作品ページのURL */
  pageUrl?: string;
}

/**
 * 投稿ページのURLから、そのサイトの作品IDと作品ページを導く。
 *
 * @param site どのサイトの投稿ページか
 * @param postUrl 作者が貼った「新規エピソード投稿ページ」のURL
 * @returns 読めた欄だけを入れたもの。1つも読めなければ空の object
 */
export function deriveSiteProfile(
  site: PostingSiteId,
  postUrl: string | null | undefined
): DerivedSiteProfile {
  const url = siteUrl(site, postUrl);
  if (!url) return {};

  switch (site) {
    case "narou": {
      /*
        管理画面のパスは `.../ncode/n1234ab/` の形で、前に来る部分は画面に
        よって変わる（投稿メニュー・作品トップなど）。**`ncode` の次の区画を
        見る**ことにして、前の部分の形には頼らない。
      */
      const parts = pathParts(url);
      const at = parts.indexOf("ncode");
      const ncode = at >= 0 ? narouNcode(parts[at + 1]) : undefined;
      if (!ncode) return {};
      return { workId: ncode, pageUrl: `https://ncode.syosetu.com/${ncode}/` };
    }
    case "kakuyomu": {
      // `https://kakuyomu.jp/my/works/{id}/episodes/new`。作品IDは数字だけ
      const parts = pathParts(url);
      const workId =
        parts[0] === "my" && parts[1] === "works" && /^\d+$/.test(parts[2] ?? "")
          ? parts[2]
          : undefined;
      if (!workId) return {};
      return { workId, pageUrl: `https://kakuyomu.jp/works/${workId}` };
    }
    case "alphapolis":
    case "note":
      // 上の説明のとおり、この2つは導かない
      return {};
  }
}

/**
 * 読者の反応を読む管理画面のURL（設計書6.79.7）。
 *
 * **開くだけで、読みにはいかない。** 開いた先で数字を拾うのは貼り込み係
 * （ブラウザ拡張）であり、母艦はその結果を封筒で受けるだけである
 * （`core/readerStatsEnvelope.ts`）。
 *
 * 作品IDは**台帳の値を先に見る**。作者が手で入れた値のほうが確かで、
 * 投稿ページのURLは登録し直しの途中で古いことがある。
 *
 * カクヨム以外を導かない理由は `deriveSiteProfile` と同じで、加えて
 * アルファポリスは貼り込み係の読み取り自体が `supported: false` のまま
 * である（管理画面のDOMを実機で見られていない）。
 *
 * @param profile 台帳にあるそのサイトの作品情報
 * @param postUrl 台帳にある投稿ページのURL（作品IDが無いときの拠りどころ）
 * @returns 開けるURL。導けなければ undefined（呼ぶ側はボタンを出さない）
 */
export function readerStatsPageUrl(
  site: PostingSiteId,
  profile: PostingSiteProfile | undefined,
  postUrl?: string | null
): string | undefined {
  if (site !== "kakuyomu") return undefined;

  const stored = (profile?.workId ?? "").trim();
  // **形を確かめてから使う。** 作品IDの欄は自由入力で、作品名やURLの断片が
  // 入っていることがある（`snsShare.ts` の `workListUrl` と同じ用心）
  const workId = /^\d+$/.test(stored)
    ? stored
    : deriveSiteProfile(site, postUrl).workId;
  return workId ? `https://kakuyomu.jp/my/works/${workId}` : undefined;
}

/**
 * そのサイトのURLとして読めるかを確かめて返す。
 *
 * 確かめるのは**プロトコルとドメインだけ**（6.68.1）。台帳は作者が手で
 * 直せるので、導く前にここを通す。
 */
function siteUrl(
  site: PostingSiteId,
  value: string | null | undefined
): URL | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return undefined;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

  const host = url.hostname.toLowerCase();
  const { domain } = postingSiteInfo(site);
  if (host !== domain && !host.endsWith(`.${domain}`)) return undefined;
  return url;
}

/** パスを区画に割る（前後や連続の `/` は落とす） */
function pathParts(url: URL): string[] {
  return url.pathname.split("/").filter((part) => part);
}
