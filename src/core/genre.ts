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
 * 出どころ（2026-08-16に確認）：
 * - https://syosetu.com/helpcenter/helppage/helppageid/59
 * - https://kakuyomu.jp/help/entry/genre
 * - https://www.alphapolis.co.jp/novel/index
 * - https://www.neopage.com/search
 *
 * **サイトの都合で変わるものなので、変わったらここを直す。**
 * コードの他の場所へ散らさないこと。
 *
 * VS Code APIに依存しない。
 */

export type GenreSiteKey = "narou" | "kakuyomu" | "alphapolis" | "neopage";

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

/** アルファポリス（並列に16） */
const ALPHAPOLIS: GenreSite = {
  key: "alphapolis",
  label: "アルファポリス",
  grouped: false,
  groups: [
    {
      label: "ジャンル",
      genres: [
        "ファンタジー",
        "恋愛",
        "ミステリー",
        "ホラー",
        "SF",
        "キャラ文芸",
        "ライト文芸",
        "青春",
        "現代文学",
        "大衆娯楽",
        "経済・企業",
        "歴史・時代",
        "児童書・童話",
        "絵本",
        "BL",
        "エッセイ・ノンフィクション",
      ],
    },
  ],
};

/**
 * ネオページ（ジャンル12 / サブジャンル54）。
 *
 * **サブジャンルまで持つ。** なろうの大ジャンルと同じ扱いで、
 * ジャンル名だけでは「恋愛 > 現代恋愛」と「現実世界 > 現代ドラマ」の
 * ような近い区分を選び分けられない。
 */
const NEOPAGE: GenreSite = {
  key: "neopage",
  label: "ネオページ",
  grouped: true,
  groups: [
    {
      label: "恋愛",
      genres: [
        "現代恋愛",
        "オフィスラブ",
        "結婚生活",
        "Ｓ彼・俺様",
        "夜の世界",
        "スクールラブ",
      ],
    },
    {
      label: "異世界恋愛",
      genres: [
        "ロマファン",
        "悪役令嬢",
        "和風・中華",
        "人外ラブ",
        "フューチャーラブ",
        "恋愛ゲーム",
      ],
    },
    {
      label: "異世界ファンタジー",
      genres: [
        "冒険・バトル",
        "内政・領地経営",
        "スローライフ",
        "戦記",
        "ダークファンタジー",
      ],
    },
    {
      label: "現代ファンタジー",
      genres: [
        "現代ダンジョン",
        "都市ファンタジー",
        "異能バトル",
        "スーパーヒーロー",
      ],
    },
    {
      label: "現実世界",
      genres: [
        "ラブコメ",
        "青春学園",
        "現代ドラマ",
        "グルメ・料理",
        "仕事・職場",
        "裏社会",
        "スポーツ",
      ],
    },
    {
      label: "BL",
      genres: [
        "現代BL",
        "学園BL",
        "ファンタジーBL",
        "歴史創作BL",
        "オメガバース",
      ],
    },
    { label: "ゲーム", genres: ["VRゲーム", "ゲーム世界", "配信・ゲーマー"] },
    {
      label: "SF",
      genres: [
        "宇宙",
        "空想科学",
        "ポストアポカリプス",
        "時間SF",
        "SFコレクション",
      ],
    },
    {
      label: "歴史・時代",
      genres: ["日本歴史", "戦国", "江戸・幕末", "三国", "外国歴史"],
    },
    { label: "ミステリー", genres: ["推理・本格", "サスペンス", "警察・探偵"] },
    { label: "ホラー", genres: ["怪談", "都市伝説", "ホラーコレクション"] },
    {
      label: "文芸・その他",
      genres: [
        "雑文・エッセイ",
        "純文学",
        "童話",
        "詩",
        "ショートショート",
        "ノンフィクション",
        "ノンジャンル",
      ],
    },
  ],
};

export const GENRE_SITES: readonly GenreSite[] = [
  NAROU,
  KAKUYOMU,
  ALPHAPOLIS,
  NEOPAGE,
];

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
