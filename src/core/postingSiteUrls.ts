import {
  postingSiteInfo,
  type PostingSiteEntry,
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
 * ほうがよい。導けるのは**なろう・カクヨム・アルファポリス**である。
 *
 * - **アルファポリス**は**作品IDだけ**導く（2026-11-01 作者の Chrome で確かめた）。
 *   作者用のページは `/mypage/` の下にあり、新しい話は
 *   `/mypage/novel/save_episode/{作品ID}`、作品の管理画面は
 *   `/mypage/content/detail/{作品ID}` で、**作品IDは数字9桁が1つだけ**出る。
 *   ヘルパー 0.14.2 はこの9桁で取り違えを照合するので、台帳にもこの9桁を入れる。
 *   読者向けの作品ページは `/novel/{作者ID}/{作品ID}` で作者IDが要るので、組み立てない。
 *   0.116.1 までは形が分からず導いていなかった（`/novel/manage/…`・`/manage/novel/…`
 *   の見当はどちらも実在しなかった）
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
    case "alphapolis": {
      // 話の編集画面（`save_episode/{作品ID}/{話ID}`）も作品IDは同じ位置にある（ヘルパーの照合と同じ）
      const parts = pathParts(url);
      const candidate =
        parts[0] === "mypage" &&
        ((parts[1] === "novel" && parts[2] === "save_episode") ||
          (parts[1] === "content" && parts[2] === "detail"))
          ? parts[3]
          : undefined;
      const workId = alphapolisWorkId(candidate);
      return workId ? { workId } : {};
    }
    case "note":
      // 上の説明のとおり、導かない
      return {};
  }
}

/**
 * アルファポリスの作品IDとして使える形（数字9桁ちょうど）なら、それを返す。
 *
 * **9桁より短くても長くても使わない。** ヘルパー 0.14.2 は投稿画面の URL の9桁と
 * 封筒の作品IDを突き合わせ、違えば取り違えとして止める。作者番号との組
 * （0.116.1 まで欄の例に出していた「作者番号／作品番号」）や桁の欠けた番号から
 * URL を組むと、存在しない画面か、別の作品の画面を開かせることになる。
 */
export function alphapolisWorkId(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return /^\d{9}$/.test(trimmed) ? trimmed : undefined;
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
 * なろうの「自分の作品の一覧」（6.68.7。作者の答え 2026-11-03 昼）。
 *
 * 作品の管理画面は数字の小説番号が要る（`workManagePageUrl`）。番号が台帳に無いあいだは、
 * 番号の要らないこの一覧を開き、そこから作者に作品を選んでもらう。形の根拠は、なろうへ投稿する
 * 公開のツール（GitHub の ichir0roie/ai-novel-core の `tool/narou.py`。2026-10 の画面と突き合わせ
 * 済みとある）が作品一覧の URL として持つ値と、本体の指示（2026-11-03）。
 */
export const NAROU_WORK_LIST_URL = "https://syosetu.com/usernovel/list/";

/** 出し直しで開く画面を決めるのに要るもの */
export interface RevisionPageInput {
  site: PostingSiteId;
  /** 台帳にあるそのサイトの作品情報（作品ID） */
  profile: PostingSiteProfile | undefined;
  /** 台帳にある投稿ページのURL（作品IDが無いときの拠りどころ） */
  postUrl?: string | null;
  /** 投稿の記録にあるサイトの話の番号（`PostingRecord.siteEpisodeId`） */
  siteEpisodeId?: string | null;
  /** サイトの中の数字の作品番号（なろうの小説番号。`PostingSiteFacts.siteWorkNumber`） */
  siteWorkNumber?: string | null;
}

/**
 * 修正版を出し直すときに開く、作品の管理画面（設計書6.68.7。作者の依頼 2026-11-03）。
 *
 * 話の編集画面を直に開けるのは、投稿の記録にサイトの話の番号があるときだけ
 * （`episodeEditPageUrl`）。無ければここで作品の管理画面を開き、そこから作者が話を選ぶ。
 *
 * ## 組み立てるのは形を確かめたサイトだけ
 *
 * - カクヨム：`/my/works/{作品ID}`（`readerStatsPageUrl` と同じ画面。話の一覧が並ぶ）
 * - アルファポリス：`/mypage/content/detail/{9桁の作品ID}`（2026-11-01 作者の Chrome で確かめた）
 * - なろう：**小説番号（`siteWorkNumber`）があるときだけ** `https://syosetu.com/usernovelmanage/top/ncode/{小説番号}/`。
 *   `ncode/` の後ろは**Nコードではなくサイト内部の数字の小説番号**である（2026-11-03 に公開の情報で
 *   確かめた）。根拠：①実在の作品ページ `ncode.syosetu.com/n8562hc/` の本文に、その作者の別作品の
 *   管理画面として `syosetu.com/usernovelmanage/top/ncode/2930206/` が載っている。同じページの感想・
 *   レビューのリンクも `ncode/1848378/` と数字で作品を指す ②なろうへ投稿する公開のツール
 *   （GitHub の ichir0roie/ai-novel-core の `tool/narou.py`・`.claude/docs/narou.md`、2026-10 の
 *   画面と突き合わせ済みと書かれている）が、同じ形に「小説の番号。Nコードではない」を入れている。
 *   Nコード（`siteProfiles.workId`）から小説番号を引く公開の道は無いので、番号はヘルパーが送り返す
 *   （作者の答え 2026-11-03 昼）。番号が無いあいだは `revisionPageUrl` が作品の一覧へ落とす
 * - note：組み立てない（作品の単位が無い）
 *
 * **推測のURLを開かせない**——とくに新しい話の投稿ページを代わりに開くと、修正版がもう1本の
 * 新しい話として公開される。組み立てられないサイトでは、呼ぶ側が開かずに案内だけ出す。
 *
 * 作品IDは台帳の値を先に見て、無ければ投稿ページのURLから導く（`readerStatsPageUrl` と同じ順）。
 *
 * @param siteWorkNumber なろうの小説番号（数字だけ受け付ける）
 * @returns 開けるURL。組み立てられなければ undefined
 */
export function workManagePageUrl(
  site: PostingSiteId,
  profile: PostingSiteProfile | undefined,
  postUrl?: string | null,
  siteWorkNumber?: string | null
): string | undefined {
  if (site === "kakuyomu") return readerStatsPageUrl(site, profile, postUrl);
  if (site === "alphapolis") {
    const workId = alphapolisManageWorkId(profile, postUrl);
    return workId
      ? `https://www.alphapolis.co.jp/mypage/content/detail/${workId}`
      : undefined;
  }
  if (site === "narou") {
    const number = narouNovelNumber(siteWorkNumber);
    return number ? `https://syosetu.com/usernovelmanage/top/ncode/${number}/` : undefined;
  }
  return undefined;
}

/** なろうの小説番号（数字だけ）。形が違えば undefined——URL のパスへそのまま入るため */
function narouNovelNumber(value: string | null | undefined): string | undefined {
  const number = (value ?? "").trim();
  return /^\d{1,20}$/.test(number) ? number : undefined;
}

/** アルファポリスの作品ID（9桁）。台帳の値が先、無ければ投稿ページのURLから */
function alphapolisManageWorkId(
  profile: PostingSiteProfile | undefined,
  postUrl?: string | null
): string | undefined {
  return alphapolisWorkId(profile?.workId) ?? deriveSiteProfile("alphapolis", postUrl).workId;
}

/** カクヨムの作品ID（数字）。台帳の値が先、無ければ投稿ページのURLから（`readerStatsPageUrl` と同じ） */
function kakuyomuManageWorkId(
  profile: PostingSiteProfile | undefined,
  postUrl?: string | null
): string | undefined {
  const stored = (profile?.workId ?? "").trim();
  return /^\d+$/.test(stored) ? stored : deriveSiteProfile("kakuyomu", postUrl).workId;
}

/**
 * 出し直しで、話の編集画面を直に開くURL（設計書6.68.7。作者の依頼 2026-11-03「再投稿ページのURLは
 * 解析できますか？」）。
 *
 * 話の編集画面はどのサイトも**サイトが振った話の番号**で話を指す。台帳はサイトを読みにいかない
 * （6.68.1）ので、番号は投稿の記録の `siteEpisodeId`（ヘルパーが投稿のあとに送り返す値）にしか無い。
 *
 * - カクヨム：`https://kakuyomu.jp/my/works/{作品ID}/episodes/{話ID}`（話IDは数字。形は本体の指示で
 *   決めた。作品の管理画面 `/my/works/{作品ID}` は確かめてあり、読者向けの話のページ
 *   `/works/{作品ID}/episodes/{話ID}` と同じ番号を使う。**編集画面のアドレスがこの形なのは、
 *   2026-11-04 に作者の Chrome で自作の話の編集画面を開いて確かめた**（題「…を編集」と［更新］の画面））
 * - アルファポリス：`https://www.alphapolis.co.jp/mypage/novel/save_episode/{9桁の作品ID}/{話ID}`
 *   （2026-11-01 作者の Chrome で作者用ページを読んだとき、新しい話の `save_episode/{作品ID}` と
 *   並んで話の編集がこの形だと分かった。設計書6.68.5。話IDは数字）
 * - なろう：`https://syosetu.com/usernoveldatamanage/updateinput/ncode/{小説番号}/noveldataid/{部分の番号}/`
 *   （根拠は `workManagePageUrl` の②と同じツールの `EDIT_URL`）。**小説番号と話の番号の両方**が
 *   要る。話の番号は `siteEpisodeId`（なろうでは「部分の番号」）
 * - note：組み立てない
 *
 * **番号の形はサイトごとに確かめる**（数字だけ）。台帳の欄は手で直せるので、形の違う番号を
 * パスへそのまま入れて別のページを開かせない。
 *
 * @returns 開けるURL。組み立てられなければ undefined（呼ぶ側は作品の管理画面へ落とす）
 */
export function episodeEditPageUrl(input: RevisionPageInput): string | undefined {
  const { site, profile, postUrl } = input;
  const episodeId = (input.siteEpisodeId ?? "").trim();
  if (!/^\d+$/.test(episodeId)) return undefined;
  if (site === "kakuyomu") {
    const workId = kakuyomuManageWorkId(profile, postUrl);
    return workId ? `https://kakuyomu.jp/my/works/${workId}/episodes/${episodeId}` : undefined;
  }
  if (site === "alphapolis") {
    const workId = alphapolisManageWorkId(profile, postUrl);
    return workId
      ? `https://www.alphapolis.co.jp/mypage/novel/save_episode/${workId}/${episodeId}`
      : undefined;
  }
  if (site === "narou") {
    const number = narouNovelNumber(input.siteWorkNumber);
    return number
      ? `https://syosetu.com/usernoveldatamanage/updateinput/ncode/${number}/noveldataid/${episodeId}/`
      : undefined;
  }
  return undefined;
}

/** 出し直しで開く画面 */
export interface RevisionPage {
  url: string;
  /**
   * `"episode"`＝話の編集画面を直に開く／`"work"`＝作品の管理画面から話を選んでもらう／
   * `"list"`＝自分の作品の一覧から作品と話を選んでもらう（なろうで小説番号が無いとき）
   */
  kind: "episode" | "work" | "list";
}

/**
 * 出し直しで開く画面を決める（6.68.7）。**話の編集画面 → 作品の管理画面 → 作品の一覧（なろう）の順。**
 *
 * @returns どれも組み立てられなければ undefined（note。何も開かず案内だけ）
 */
export function revisionPageUrl(input: RevisionPageInput): RevisionPage | undefined {
  const episode = episodeEditPageUrl(input);
  if (episode) return { url: episode, kind: "episode" };
  const work = workManagePageUrl(input.site, input.profile, input.postUrl, input.siteWorkNumber);
  if (work) return { url: work, kind: "work" };
  // なろうは小説番号が届くまで、番号の要らない自分の作品の一覧を開く（作者の答え 2026-11-03 昼）
  if (input.site === "narou") return { url: NAROU_WORK_LIST_URL, kind: "list" };
  return undefined;
}

/**
 * 「コピー（投稿サイト用）」のあとに開く、そのサイトの投稿ページ
 * （作者の依頼、2026-09-23）。
 *
 * ## 決め方
 *
 * 1. **台帳の投稿ページのURL（`sites[].newEpisodeUrl`）があれば、それ。**
 *    作者が「投稿サイトの設定」で自分の画面から貼った値で、いちばん確か
 * 2. 無ければ、**形が実機で確かめられたサイトだけ**作品IDから組み立てる。
 *    カクヨム（`/my/works/{作品ID}/episodes/new`。作者の台帳に
 *    実際に入った値と同じ形。`deriveSiteProfile` が読んでいるのもこの形）と、
 *    アルファポリス（`/mypage/novel/save_episode/{9桁の作品ID}`。2026-11-01）
 * 3. どちらも無ければ `undefined`（呼ぶ側はボタンを出さない）
 *
 * ## 組み立てないサイト
 *
 * **推測のURLを開かせない。** 違うページが開くと、作者はそこが投稿欄だと
 * 思って**別の作品へ貼る**恐れがある。空振りより悪い。
 *
 * - **なろう**：新しい話を書く画面は、Nコードではなく**サイト内部の番号**で
 *   作品を指すはずで、Nコードからは組み立てられない
 * - **note**：作品の単位が無い（記事とマガジン）
 *
 * アルファポリスは 2026-11-01 に投稿画面の形を確かめたので、9桁の作品IDから組み立てる側へ移した
 * （`newEpisodeUrlFromWorkId`）。
 *
 * **開くだけ**で、書き込みも読み取りもしない（6.68.1）。
 *
 * @param site 貼り付け先のサイト
 * @param newEpisodeUrl 台帳の投稿ページのURL（登録していなければ渡さない）
 * @param profile 台帳にあるそのサイトの作品情報
 */
export function postingPageUrl(
  site: PostingSiteId,
  newEpisodeUrl: string | null | undefined,
  profile: PostingSiteProfile | undefined
): string | undefined {
  // **開く直前にも形を確かめる。** 台帳は作者が手で直せるファイルで、
  // `javascript:` や別のサイトのURLが入っていることがありうる。
  // 読み込みでも弾いているが、ここを通さずに届く道を作らない
  const stored = siteUrl(site, newEpisodeUrl);
  if (stored) return (newEpisodeUrl ?? "").trim();

  return newEpisodeUrlFromWorkId(site, profile?.workId);
}

/**
 * 作品IDから、そのサイトの新しい話を投稿するページのURLを組み立てる。
 *
 * **組み立てるのは形が実機で確かめられたサイトだけ**（カクヨムと、2026-11-01 からアルファポリス。
 * 組み立てないサイトの理由は `postingPageUrl` の説明）。開く口（`postingPageUrl`）と、
 * 読者の反応から作品IDを登録したときに投稿先へ足す口（`planReaderStatsPostingSite`）が
 * 同じ形を使うよう、ここ1か所で組み立てる。
 *
 * @returns 組み立てられなければ undefined
 */
export function newEpisodeUrlFromWorkId(
  site: PostingSiteId,
  workId: string | null | undefined
): string | undefined {
  if (site === "alphapolis") {
    // 新しい話の投稿画面（2026-11-01 作者の Chrome で確かめた形。ヘルパー 0.14.2 が貼り込む画面）
    const id = alphapolisWorkId(workId);
    return id ? `https://www.alphapolis.co.jp/mypage/novel/save_episode/${id}` : undefined;
  }
  if (site !== "kakuyomu") return undefined;
  const trimmed = (workId ?? "").trim();
  // 作品IDの欄は自由入力なので、数字だけのときに限る（`readerStatsPageUrl` と同じ用心）
  return /^\d+$/.test(trimmed)
    ? `https://kakuyomu.jp/my/works/${trimmed}/episodes/new`
    : undefined;
}

/**
 * 「投稿サイト設定」で投稿ページのURLを訊くときの初期値（作者に約束済み、2026-10-12）。
 *
 * **URL が空のときだけ**、台帳の作品IDから組み立てた URL を下書きとして入れる
 * （作品IDは読者の反応から登録されていることがあり、同じ番号を2度打たせない）。
 * 入っていればそのまま——作者が自分の画面から貼った値がいちばん確かである。
 * 組み立てるのは `newEpisodeUrlFromWorkId` が組み立てるサイト（カクヨム・アルファポリス）だけ。
 *
 * **下書きは欄の初期値に置くだけ**で、作者が Enter を押すまで台帳には入らない。
 */
export function newEpisodeUrlDraft(
  site: PostingSiteId,
  currentUrl: string | null | undefined,
  workId: string | null | undefined
): string | undefined {
  if ((currentUrl ?? "").trim()) return currentUrl ?? undefined;
  return newEpisodeUrlFromWorkId(site, workId);
}

/** 作品IDを書き換えたとき、投稿ページのURLを合わせるかを訊く文（作者の裁定、2026-10-12） */
export const NEW_EPISODE_URL_FOLLOW_QUESTION =
  "投稿ページの URL を新しい作品IDに合わせますか";

export type NewEpisodeUrlFollowPlan =
  | { readonly kind: "none" }
  | { readonly kind: "ask"; readonly rebuilt: string };

/**
 * 投稿ページのURLが入っている作品で作品IDを書き換えたとき、URL を合わせるか
 * 訊くべきか（作者の裁定、2026-10-12 22時台）。
 *
 * **黙って組み直さない。** 投稿ページのURLは作者が自分の画面から貼った値で、
 * 作品IDの欄の打ち間違いのほうが起きやすい。かといって黙って残すと、
 * 投稿キットが古い作品の投稿欄を開き、**別の作品へ貼る**恐れがある。だから一言訊く。
 *
 * 訊かないとき：
 * - 新しい作品IDが空・組み立てられない形（数字でない、組み立てないサイト）
 * - 作品IDが変わっていない
 * - 今の URL がもう新しい作品IDを指している（URL から作品IDを読んで比べる。
 *   文字列で比べると、末尾の `/` の違いだけで訊いてしまう）
 */
export function planNewEpisodeUrlOnWorkIdChange(
  site: PostingSiteId,
  currentUrl: string | null | undefined,
  previousWorkId: string | null | undefined,
  nextWorkId: string | null | undefined
): NewEpisodeUrlFollowPlan {
  const next = (nextWorkId ?? "").trim();
  if (!next || next === (previousWorkId ?? "").trim()) return { kind: "none" };
  const url = (currentUrl ?? "").trim();
  if (!url) return { kind: "none" };
  const rebuilt = newEpisodeUrlFromWorkId(site, next);
  if (!rebuilt) return { kind: "none" };
  if (deriveSiteProfile(site, url).workId === next) return { kind: "none" };
  return { kind: "ask", rebuilt };
}

/**
 * 作者の答えを投稿先の一覧へ反映する。**いいえなら一覧をそのまま返す**
 * （元の配列も書き換えない）。
 */
export function followNewEpisodeUrl(
  sites: readonly PostingSiteEntry[],
  site: PostingSiteId,
  rebuilt: string,
  accepted: boolean
): readonly PostingSiteEntry[] {
  if (!accepted) return sites;
  return sites.map((entry) =>
    entry.site === site ? { ...entry, newEpisodeUrl: rebuilt } : entry
  );
}

/** 作者だけが開けるページだと分かったときの答え */
export interface AuthorOnlyPage {
  site: PostingSiteId;
  /** 同じ作品の、読者が開ける作品ページ。作品の番号を読めなければ入れない */
  readerUrl?: string;
}

/**
 * 作者だけが開けるページ（投稿・管理・編集の画面）かを見分ける（2026-10-25 の実機確認）。
 *
 * 作者は告知に載せる作品ページの欄へ、クリップボードに残っていたカクヨムの
 * 投稿ページ（`/my/works/…/episodes/new`）を入れ、そのまま告知に載った。
 * 読者が押すとログインを求められるか、開けないページである。
 *
 * **作者用と言い切れる形だけを拾う。** 読者向けのページを作者用と取り違えて
 * 止めると、正しいURLが入らなくなる。拾うのは次の形だけ：
 *
 * - カクヨム：`/my/` の下（作者の管理画面はすべてここ。読者向けは `/works/…`）
 * - なろう：`ncode.` の付かない `syosetu.com` の、`usernovelmanage`・`draftepisode`
 *   などで始まる管理画面（読者向けは `ncode.syosetu.com`。`deriveSiteProfile` と同じ形）
 * - アルファポリス：`/mypage/` の下（新しい話は `/mypage/novel/save_episode/{作品ID}`、
 *   作品の管理画面は `/mypage/content/detail/{作品ID}`。2026-11-01 作者の Chrome で確かめた。
 *   0.116.1 まではパスに `manage` を含むかで見ていたが、その形は実在しなかった）
 * - note：編集画面の `editor.note.com`
 *
 * 読者向けの作品ページを組み立てるのは、作品の番号の形が確かめられた
 * カクヨムとなろうだけ（`deriveSiteProfile` に任せる）。
 *
 * @returns 作者用でなければ undefined
 */
export function authorOnlyPage(value: string | null | undefined): AuthorOnlyPage | undefined {
  const trimmed = (value ?? "").trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const host = url.hostname.toLowerCase();
  const parts = pathParts(url);

  const withReader = (site: PostingSiteId): AuthorOnlyPage => {
    const readerUrl = deriveSiteProfile(site, trimmed).pageUrl;
    return readerUrl ? { site, readerUrl } : { site };
  };

  if (host === "kakuyomu.jp" && parts[0] === "my") return withReader("kakuyomu");
  if (
    (host === "syosetu.com" || host === "www.syosetu.com") &&
    /^(user|draft)/u.test(parts[0] ?? "")
  ) {
    return withReader("narou");
  }
  if (
    (host === "alphapolis.co.jp" || host.endsWith(".alphapolis.co.jp")) &&
    parts[0] === "mypage"
  ) {
    return { site: "alphapolis" };
  }
  if (host === "editor.note.com") return { site: "note" };
  return undefined;
}

/**
 * 作者用のページだったときに、入力欄の下や告知文の注意へ出す1文。
 *
 * **直す先が分かるときは、そのURLを文に入れる**（作者はそれを写せば済む）。
 * 分からないサイトは、読者向けのページを貼ってもらう。
 *
 * @returns 作者用でなければ undefined
 */
export function authorOnlyPageNotice(value: string | null | undefined): string | undefined {
  const page = authorOnlyPage(value);
  if (!page) return undefined;
  const head = `${postingSiteInfo(page.site).label}の作者だけが開けるページで、読者は開けません。`;
  return page.readerUrl
    ? `${head}読者向けの作品ページは ${page.readerUrl} です。`
    : `${head}読者が開ける作品ページのURLを貼ってください。`;
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
