/**
 * ジャンル（設計書6.4.4）。
 *
 * **投稿先ごとに体系が違う。** 「小説家になろう」は大ジャンル5つの下に
 * 21のジャンルがあり、「カクヨム」は並列に12ある。同じ作品でも、
 * 出す先によって名乗るジャンルが変わる。
 *
 * したがって**1つに揃えない。** どちらの体系も持ち、作者が選んだものを
 * 出どころ付きでプロットへ書く（「ハイファンタジー（なろう）」）。
 * 勝手に対応付けると、実際には無いジャンルを名乗ることになる。
 *
 * 出どころ：
 * - https://syosetu.com/helpcenter/helppage/helppageid/59
 * - https://kakuyomu.jp/help/entry/genre
 *
 * **サイトの都合で変わるものなので、変わったらここを直す。**
 * コードの他の場所へ散らさないこと。
 *
 * VS Code APIに依存しない。
 */

export type GenreSiteKey = "narou" | "kakuyomu";

export interface GenreSite {
  key: GenreSiteKey;
  label: string;
  /** 大ジャンルを持つか。なろうだけが持つ */
  grouped: boolean;
  groups: readonly GenreGroup[];
}

export interface GenreGroup {
  /** 大ジャンル名。持たない体系では区分けの見出しとして使う */
  label: string;
  genres: readonly string[];
}

/** 小説家になろう（大ジャンル5つ / ジャンル21） */
const NAROU: GenreSite = {
  key: "narou",
  label: "小説家になろう",
  grouped: true,
  groups: [
    { label: "恋愛", genres: ["異世界", "現実世界"] },
    { label: "ファンタジー", genres: ["ハイファンタジー", "ローファンタジー"] },
    {
      label: "文芸",
      genres: [
        "純文学",
        "ヒューマンドラマ",
        "歴史",
        "推理",
        "ホラー",
        "アクション",
        "コメディー",
      ],
    },
    { label: "SF", genres: ["VRゲーム", "宇宙", "空想科学", "パニック"] },
    { label: "その他", genres: ["童話", "詩", "エッセイ", "リプレイ", "その他"] },
  ],
};

/** カクヨム（並列に12） */
const KAKUYOMU: GenreSite = {
  key: "kakuyomu",
  label: "カクヨム",
  grouped: false,
  groups: [
    {
      label: "ジャンル",
      genres: [
        "異世界ファンタジー",
        "現代ファンタジー",
        "SF",
        "ラブコメ",
        "恋愛",
        "現代ドラマ",
        "ホラー",
        "ミステリー",
        "歴史・時代・伝奇",
        "エッセイ・ノンフィクション",
        "創作論・評論",
        "詩・童話・その他",
      ],
    },
  ],
};

export const GENRE_SITES: readonly GenreSite[] = [NAROU, KAKUYOMU];

export function genreSite(key: GenreSiteKey): GenreSite {
  const found = GENRE_SITES.find((site) => site.key === key);
  if (!found) throw new Error(`未知の投稿先: ${key}`);
  return found;
}

export interface GenreChoice {
  site: GenreSiteKey;
  /** 大ジャンル。持たない体系では undefined */
  group?: string;
  genre: string;
}

/**
 * 選べるジャンルを平らに並べる。
 *
 * 大ジャンルを持つ体系では、`group` に大ジャンル名が入る。
 * 「恋愛 > 異世界」と「ファンタジー > ハイファンタジー」のように、
 * **どちらの「異世界」なのかが分からないと選べない。**
 */
export function listGenres(site: GenreSite): GenreChoice[] {
  const out: GenreChoice[] = [];
  for (const group of site.groups) {
    for (const genre of group.genres) {
      out.push({
        site: site.key,
        group: site.grouped ? group.label : undefined,
        genre,
      });
    }
  }
  return out;
}

/**
 * プロットへ書く1行にする。
 *
 * **どこの体系のジャンルかを必ず添える。** 「恋愛」も「ホラー」も
 * 両サイトにあり、指すものが違う。出どころが無いと、
 * あとから読んだ人（AIを含む）が別の体系のものと取り違える。
 */
export function formatGenre(choice: GenreChoice): string {
  const site = genreSite(choice.site);
  const name = choice.group ? `${choice.group} > ${choice.genre}` : choice.genre;
  return `${name}（${site.label}）`;
}

/** 複数の投稿先へ出す作品もある。行を分けて並べる */
export function formatGenres(choices: readonly GenreChoice[]): string {
  return choices.map((choice) => `- ${formatGenre(choice)}`).join("\n");
}
