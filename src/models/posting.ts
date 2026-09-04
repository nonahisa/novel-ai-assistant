/**
 * 投稿状態の台帳（設計書6.68.2）。
 *
 * **自動投稿はしない**（6.68.1）。4サイトとも投稿用の公式APIが無く、
 * 画面の自動操作は規約違反でアカウント凍結の危険がある。ここが持つのは
 *
 *   - どの話を、どのサイトへ、いつ出したか（`posts`）
 *   - 作者が貼った「新規エピソード投稿ページ」のURL（`sites`）
 *
 * の2つだけで、**サイトへ触りにいく処理は1つも無い。**
 *
 * 話の指し方は**作品フォルダからの相対パス**（章立て・挿絵・年表と同じ）。
 * 話数は並べ替えや改題で動くが、パスはその話そのものを指し続ける。
 *
 * VS Code API には依存しない（`models` の約束）。
 */

import { normalizeEpisodePath } from "./chapter";
import {
  invalid,
  objectValue,
  optionalBoolean,
  optionalObjectArray,
  optionalString,
  requireNonEmptyString,
} from "./jsonValidation";

/** 保存先のファイル名。`設定/` の直下に置く（Gitで同期する） */
export const POSTING_FILE = "投稿状態.json";

export const POSTING_SCHEMA_VERSION = "1";

export type PostingSiteId = "narou" | "kakuyomu" | "alphapolis" | "note";

export interface PostingSiteInfo {
  id: PostingSiteId;
  /** 作者に見せる名前。IDのままでは何のことか分からない */
  label: string;
  /**
   * 投稿ページのURLとして受け付けるドメイン。
   *
   * **確かめるのは「そのサイトか」だけ**（6.68.1）。作品IDやパスの形は
   * サイト側の都合で変わるうえ、確かめるにはページを読みにいくことになる。
   * 読みにいかないのがこの機能の前提なので、ドメインで止める。
   */
  domain: string;
  /** 入力欄に出す例。どこのURLを貼ればよいのかを言葉より早く伝える */
  urlExample: string;
  /**
   * ルビの出し方（`core/ruby.ts` の `RubyStyle["id"]` と同じ値）。
   *
   * **値を書き写しているのは、`models` が `core` に依存しないため**
   * （依存の向きは views/features → core → models）。取り違えると
   * 貼り付けた先で記号が並ぶので、`test/unit/posting.test.ts` が見張る。
   */
  notation: "site" | "paren";
  /**
   * 傍点の出し方（`core/ruby.ts` の `EmphasisSite` と同じ値）。
   *
   * **ルビの記法があるサイトでだけ効く。** noteは括弧書き（`paren`）へ
   * 落とすので、ここに何を書いても結果は変わらない。
   */
  emphasis: "kakuyomu" | "narou";
}

/**
 * 対象にできるサイト（作者の依頼、2026-09-04）。
 *
 * **並びは作者が投稿する順**（なろう→カクヨム→アルファポリス→note）に
 * してある。キットはこの順にサイトを回る。
 */
export const POSTING_SITES: readonly PostingSiteInfo[] = [
  {
    id: "narou",
    label: "小説家になろう",
    domain: "syosetu.com",
    urlExample:
      "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n0000aa/",
    notation: "site",
    // なろうには傍点の記法が無く、ルビで代用する（6.12.4）
    emphasis: "narou",
  },
  {
    id: "kakuyomu",
    label: "カクヨム",
    domain: "kakuyomu.jp",
    urlExample: "https://kakuyomu.jp/my/works/0000000000/episodes/new",
    notation: "site",
    emphasis: "kakuyomu",
  },
  {
    id: "alphapolis",
    label: "アルファポリス",
    domain: "alphapolis.co.jp",
    urlExample: "https://www.alphapolis.co.jp/novel/manage/000000/0000",
    notation: "site",
    // アルファポリスもなろうと同じくルビで代用する
    emphasis: "narou",
  },
  {
    id: "note",
    label: "note",
    domain: "note.com",
    urlExample: "https://note.com/notes/new",
    // **noteにはルビの記法が無い**ので括弧書きへ落とす（6.68.3）
    notation: "paren",
    emphasis: "kakuyomu",
  },
];

export function postingSiteInfo(id: PostingSiteId): PostingSiteInfo {
  const found = POSTING_SITES.find((site) => site.id === id);
  // 一覧に無いIDは読み込みで弾いている。ここへ来るのは書き間違えのとき
  if (!found) invalid(`site（${id}）`);
  return found;
}

/** サイトの名前を並べる（「小説家になろう・note」） */
export function postingSiteLabels(ids: readonly PostingSiteId[]): string {
  // **並びは `POSTING_SITES` の順に揃える。** 呼ぶ場所ごとに順番が違うと、
  // 一覧の印とキットの案内で「どのサイトが遅れているか」の並びが食い違う
  return POSTING_SITES.filter((site) => ids.includes(site.id))
    .map((site) => site.label)
    .join("・");
}

export interface PostingSiteEntry {
  site: PostingSiteId;
  /** 作者が貼った新規エピソード投稿ページのURL（作品IDを含む） */
  newEpisodeUrl: string;
}

export interface PostingRecord {
  /** 作品フォルダからの相対パス（区切りは `/`） */
  episodePath: string;
  site: PostingSiteId;
  /** 投稿したと作者が答えた日時（ISO8601） */
  postedAt: string;
  /**
   * **導入時にまとめて入れた記録**（基準線）。実際の投稿には付けない。
   *
   * この機能を使い始めるまでに出した話は、こちらが日時を知らない
   * （`postedAt` は導入した時刻でしかない）。**「投稿しました」と答えた
   * 記録と混ぜない**ようにしておかないと、あとから台帳を読んだときに
   * 実際の更新日時として読まれてしまう。
   *
   * 省略できる（既にある台帳を読めなくしないため。無い＝実投稿）。
   */
  importedBaseline?: boolean;
}

export interface PostingLedger {
  schemaVersion: string;
  /** この作品を出すサイトと、その投稿ページ。空なら投稿キットは未設定 */
  sites: PostingSiteEntry[];
  posts: PostingRecord[];
}

export function emptyPostingLedger(): PostingLedger {
  return { schemaVersion: POSTING_SCHEMA_VERSION, sites: [], posts: [] };
}

/**
 * 投稿ページのURLとして受けられるか。理由が分かる文字列を返す（問題なければ null）。
 *
 * **中身は見ない**（6.68.1）。確かめるのは
 *
 *   1. `http`／`https` のURLであること（`javascript:` などを開かせない）
 *   2. そのサイトのドメインであること（カクヨムの欄になろうのURLを貼らない）
 *
 * の2つだけである。ページを読みにいくことは一切しない。
 */
export function validateNewEpisodeUrl(
  site: PostingSiteId,
  value: string
): string | null {
  const info = postingSiteInfo(site);
  const trimmed = value.trim();
  if (!trimmed) return "投稿ページのURLを入力してください。";

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return `URLとして読めません。http:// か https:// から始まるURLを貼ってください（例：${info.urlExample}）。`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "http:// か https:// から始まるURLを貼ってください。";
  }

  const host = url.hostname.toLowerCase();
  if (host !== info.domain && !host.endsWith(`.${info.domain}`)) {
    return `${info.label}のURL（${info.domain}）を貼ってください（例：${info.urlExample}）。`;
  }
  return null;
}

/**
 * 作者が手で編集したJSONを読む。**壊れていたら例外を投げる。**
 *
 * 勝手に直して上書きすると、作者が貼ったURLや投稿の記録が黙って消える
 * （章立て・本の設計図と同じ約束）。
 */
export function parsePostingLedger(raw: unknown): PostingLedger {
  const value = objectValue(raw, `設定/${POSTING_FILE}`);
  optionalString(value.schemaVersion, "schemaVersion");

  const sites =
    optionalObjectArray(value.sites, "sites", (entry, entryPath) => {
      const site = requireSiteId(entry.site, `${entryPath}.site`);
      requireNonEmptyString(entry.newEpisodeUrl, `${entryPath}.newEpisodeUrl`);
      const url = (entry.newEpisodeUrl as string).trim();
      // **別のサイトのURLは直さずに止める。** 直したところで正しいURLは
      // こちらには分からず、黙って別のページを開くほうが危ない
      if (validateNewEpisodeUrl(site, url)) {
        invalid(`${entryPath}.newEpisodeUrl`);
      }
      return { site, newEpisodeUrl: url };
    }) ?? [];

  assertUniqueSites(sites);

  const posts =
    optionalObjectArray(value.posts, "posts", (entry, entryPath) => {
      requireNonEmptyString(entry.episodePath, `${entryPath}.episodePath`);
      const site = requireSiteId(entry.site, `${entryPath}.site`);
      requireNonEmptyString(entry.postedAt, `${entryPath}.postedAt`);
      optionalBoolean(entry.importedBaseline, `${entryPath}.importedBaseline`);
      return {
        episodePath: normalizeEpisodePath(entry.episodePath as string),
        site,
        postedAt: (entry.postedAt as string).trim(),
        // **無い印は書き足さない。** `false` を入れると、既存の台帳を
        // 読んで書き戻すだけで中身が増える
        ...(entry.importedBaseline === true ? { importedBaseline: true } : {}),
      };
    }) ?? [];

  return {
    schemaVersion:
      (value.schemaVersion as string | undefined) ?? POSTING_SCHEMA_VERSION,
    sites,
    posts,
  };
}

function requireSiteId(value: unknown, path: string): PostingSiteId {
  if (typeof value !== "string") invalid(path);
  const found = POSTING_SITES.find((site) => site.id === value);
  // **知らないサイトは読み飛ばさない。** 飛ばすと、そのサイトへ出した
  // 記録だけが消えて「まだ出していない」ことになる
  if (!found) invalid(path);
  return found.id;
}

/**
 * 同じサイトが2つ登録されていないことを確かめる。
 *
 * **後勝ちで畳まず、読めないと言って止める**（章立ての開始の重複と同じ）。
 * URLが2つあるとき、どちらが本当かは作者にしか分からない。
 */
export function assertUniqueSites(sites: readonly PostingSiteEntry[]): void {
  const seen = new Set<PostingSiteId>();
  for (const entry of sites) {
    if (seen.has(entry.site)) {
      invalid(`sites（${postingSiteInfo(entry.site).label}が2つあります）`);
    }
    seen.add(entry.site);
  }
}

/** 対象サイトを置き換える。**元の台帳は書き換えない** */
export function withSites(
  ledger: PostingLedger,
  sites: readonly PostingSiteEntry[]
): PostingLedger {
  const next = sites.map((entry) => ({ ...entry }));
  assertUniqueSites(next);
  return { ...ledger, sites: next };
}

export function isPosted(
  ledger: PostingLedger,
  episodePath: string,
  site: PostingSiteId
): boolean {
  const wanted = normalizeEpisodePath(episodePath);
  return ledger.posts.some(
    (post) => post.site === site && post.episodePath === wanted
  );
}

/**
 * 「投稿しました」を記録する。**元の台帳は書き換えない**——保存に失敗した
 * ときに、画面の中だけが進んだ状態を作らないため（章立てと同じ流儀）。
 *
 * 同じ話・同じサイトの記録は**1件に保つ**（日時は新しいほうで上書き）。
 * 2件あっても読みは変わらないが、出し直すたびに台帳が伸びていく。
 */
export function withPost(
  ledger: PostingLedger,
  episodePath: string,
  site: PostingSiteId,
  postedAt: string
): PostingLedger {
  const wanted = normalizeEpisodePath(episodePath);
  const kept = ledger.posts.filter(
    (post) => !(post.site === site && post.episodePath === wanted)
  );
  return {
    ...ledger,
    posts: [...kept, { episodePath: wanted, site, postedAt }],
  };
}

/**
 * 投稿済みの基準線を引く（設計書6.68.2）。
 *
 * **導入前に出した話まで「未投稿」と数えないため**の記録である。19話まで
 * 書いてからこの機能を使い始めた作品で、全話に「未投稿2」の印が並んでも
 * 誰の役にも立たない。初回に「どの話まで出しましたか」を1度だけ訊く。
 *
 * **既にある記録は1つも書き換えない。** 実際に投稿した記録（日時つき）を、
 * あとから引いた基準線で塗り替えてはいけない。
 *
 * @param episodePaths 投稿済みとみなす話。空なら1件も入れない（「最初から」）
 * @param postedAt 導入した時刻。**本当の投稿日時ではない**ので、
 *   `importedBaseline` の印を付けて見分けられるようにする
 */
export function withBaselinePosts(
  ledger: PostingLedger,
  episodePaths: readonly string[],
  sites: readonly PostingSiteId[],
  postedAt: string
): PostingLedger {
  const added: PostingRecord[] = [];
  for (const episodePath of episodePaths) {
    const wanted = normalizeEpisodePath(episodePath);
    for (const site of sites) {
      if (isPosted(ledger, wanted, site)) continue;
      added.push({
        episodePath: wanted,
        site,
        postedAt,
        importedBaseline: true,
      });
    }
  }
  if (added.length === 0) return { ...ledger, posts: [...ledger.posts] };
  return { ...ledger, posts: [...ledger.posts, ...added] };
}

/**
 * その話で、まだ出していないサイト。
 *
 * **登録したサイトの中だけを見る。** noteに出していない作品で note を
 * 「未投稿」と数えると、いつまでも印が消えない（6.68.3の3）。
 */
export function unpostedSites(
  ledger: PostingLedger,
  episodePath: string
): PostingSiteId[] {
  return ledger.sites
    .map((entry) => entry.site)
    .filter((site) => !isPosted(ledger, episodePath, site))
    // 画面に出す順を `POSTING_SITES` に揃える（`postingSiteLabels` と同じ理由）
    .sort(
      (left, right) =>
        POSTING_SITES.findIndex((site) => site.id === left) -
        POSTING_SITES.findIndex((site) => site.id === right)
    );
}

/**
 * まだ出しきっていない、いちばん古い話（6.68.3の1）。
 *
 * @param episodePaths 話の相対パス。**話数順に並んでいること**
 *   （走査の結果をそのまま渡す。ここでは並べ替えない——番号を持たない話や
 *   日付の話の順は、走査のほうが正しく知っている）
 */
export function firstUnpostedEpisodePath(
  ledger: PostingLedger,
  episodePaths: readonly string[]
): string | undefined {
  if (ledger.sites.length === 0) return undefined;
  return episodePaths.find((episodePath) => unpostedSites(ledger, episodePath).length > 0);
}
