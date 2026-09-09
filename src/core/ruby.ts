/**
 * ルビ（振り仮名）と傍点の記法変換（設計書6.12）。
 *
 * **拡張機能の中では `{漢字|かんじ}` と `{{強調}}` で書く。** Markdownの
 * 拡張として広く使われている形で、投稿サイトごとの記法に引きずられずに済む。
 *
 * ## ルビは1つの記法で足りる
 *
 * **投稿サイトへは `｜漢字《かんじ》` で出す。** 2026-08-19に調べたところ、
 * **なろう・カクヨム・アルファポリスのいずれでも通る**。ネオページも
 * カクヨムと同じ記法である（2026-08-23、作者の確認）。1つの記法で
 * 賄えるので、サイトごとに出し分ける必要がない。
 *
 * アルファポリスにはもう1つ `#漢字__かんじ__#` があるので、そちらも
 * 読み書きできるようにしてある（他所から持ち込んだ原稿を取り込めるように）。
 *
 * ## 傍点は、サイトによって書き方が違う
 *
 * **ここだけは1つの記法で賄えない。**
 *
 * | サイト | 傍点 |
 * |---|---|
 * | カクヨム・ネオページ | `《《強調》》`（専用の記法がある） |
 * | なろう・アルファポリス | 専用記法が無く、**ルビで代用する**（`｜強調《・・》`） |
 *
 * そのため、**傍点が入っているときだけ**「どのサイトへ貼るか」を訊く。
 * 入っていなければ訊かない——訊いても答えが変わらない（5.7.3）。
 *
 * VS Code APIに依存しない。
 */

/** 拡張機能の中で使う記法 `{漢字|かんじ}` */
const INTERNAL = /\{([^{}|\r\n]+)\|([^{}|\r\n]*)\}/g;

/**
 * 投稿サイトの記法 `｜漢字《かんじ》`。
 *
 * 縦線は半角 `|` でも全角 `｜` でもよい（どのサイトも両方を受ける）。
 */
const SITE_BAR = /[|｜]([^|｜《》\r\n]+)《([^《》\r\n]*)》/g;

/**
 * 縦線を省いた `漢字《かんじ》`。
 *
 * **漢字が続くところだけを拾う。** なろうとカクヨムは、漢字の直後に
 * 《》が来た場合にかぎり縦線を省ける。ひらがなや記号まで拾うと、
 * 会話の中の二重山括弧（`《《強調》》` など）を巻き込む。
 */
const SITE_BARE = /([\u4E00-\u9FFF\u3005々]+)《([^《》\r\n]*)》/g;

/** アルファポリスのもう1つの記法 `#漢字__かんじ__#` */
const SITE_HASH = /#([^#\r\n]+?)__([^#\r\n]*?)__#/g;

/** 拡張機能の中で使う傍点 `{{強調}}` */
const EMPHASIS_INTERNAL = /\{\{([^{}\r\n]+)\}\}/g;

/** カクヨム・ネオページの傍点 `《《強調》》` */
const EMPHASIS_KAKUYOMU = /《《([^《》\r\n]+)》》/g;

/**
 * 傍点の代わりに使われるルビ。読み仮名が中黒だけのもの。
 *
 * **なろうとアルファポリスには傍点の記法が無い**ので、ルビで代用する
 * （`｜強調《・・》`）。取り込むときは、これを傍点として読む。
 *
 * **数は合っていなくてもよい。** 中黒だけの読み仮名を振ることは
 * ふつう無いので、それが出てきた時点で傍点だと判断してよい。
 */
const EMPHASIS_AS_RUBY = /[|｜]([^|｜《》\r\n]+)《([・･]+)》/g;

/*
 * ## 記法を、正規表現の**文字列**としても配る
 *
 * 原稿エディタは `.txt` の本文を、この記法のまま組んで見せる
 * （設計書6.12・6.25）。読む面・印刷用は `import` できるが、
 * **組んで書く面のJSは webview のテンプレート文字列の中にあって
 * `import` が効かない**。あちらへは文字列を埋め込むしかない。
 *
 * そこで、上の正規表現から `source`（本体の文字列）を取り出して配る。
 * **写しを書かない**——同じ規則を2か所に書けば、片方だけが直る日が
 * 必ず来る（`core/manuscriptRender.ts` の `NOTATION_RULES` が仲介する）。
 *
 * 捕獲の番号まで含めて意味があるので、**組み合わせるときは順番を変えない**。
 */

/** `｜漢字《かんじ》`。捕獲は［親文字, 読み］の2つ */
export const SITE_RUBY_BAR_SOURCE = SITE_BAR.source;

/** `漢字《かんじ》`（縦線なし）。捕獲は［親文字, 読み］の2つ */
export const SITE_RUBY_BARE_SOURCE = SITE_BARE.source;

/** `《《強調》》`（カクヨム・ネオページ）。捕獲は［中の文字］の1つ */
export const SITE_EMPHASIS_SOURCE = EMPHASIS_KAKUYOMU.source;

/** 傍点の代わりに使うルビの読み（文字数ぶんの中黒） */
function dotsFor(base: string): string {
  return "・".repeat(Array.from(base).length);
}

/** 貼り付け先のサイト。傍点の書き方だけが変わる */
export type EmphasisSite = "kakuyomu" | "narou";

export interface EmphasisSiteChoice {
  id: EmphasisSite;
  label: string;
  detail: string;
}

/**
 * 傍点があるときに選んでもらう先。
 *
 * **サイト名で並べる。** 記法で並べると、作者は自分の貼り付け先が
 * どちらなのかを記号から逆算することになる。
 */
export const EMPHASIS_SITES: EmphasisSiteChoice[] = [
  {
    id: "kakuyomu",
    label: "カクヨム・ネオページ",
    detail: "傍点を 《《強調》》 で出します（この2つは同じ記法です）",
  },
  {
    id: "narou",
    label: "小説家になろう・アルファポリス",
    detail:
      "傍点の記法が無いため、ルビで代用します（｜強調《・・》）。ルビはそのままです",
  },
];

export interface RubyStyle {
  /**
   * `paren` は**括弧書き**（`漢字（かんじ）`）。
   *
   * noteにはルビの記法が無いので、読みを本文の中へ落とす（設計書6.68.3）。
   * **`RUBY_STYLES` には入れない**——投稿キットがサイトから選ぶもので、
   * 「どの形で書き出しますか」で作者に選ばせる場面が無い。
   */
  id: "site" | "alphapolis-hash" | "html" | "paren";
  label: string;
  detail: string;
}

/**
 * 出せる記法。
 *
 * **1つ目で足りることを、作者に伝わる言葉で書く。**
 * 選択肢が並ぶと「どれを選べばいいのか」で手が止まる。
 */
export const RUBY_STYLES: RubyStyle[] = [
  {
    id: "site",
    label: "投稿サイト用（｜漢字《かんじ》）",
    detail:
      "なろう・カクヨム・アルファポリスのいずれでも、そのまま貼り付けられます",
  },
  {
    id: "alphapolis-hash",
    label: "アルファポリスの別記法（#漢字__かんじ__#）",
    detail: "上の記法で不都合があったときだけ使ってください",
  },
  {
    id: "html",
    label: "HTML（<ruby>）",
    detail: "自分のサイトやEPUBへ持っていく場合",
  },
];

/** ルビの中身を1件ずつ取り出す */
export function findRuby(text: string): Array<{ base: string; reading: string }> {
  const found: Array<{ base: string; reading: string }> = [];
  for (const match of text.matchAll(INTERNAL)) {
    found.push({ base: match[1], reading: match[2] });
  }
  return found;
}

/** 傍点が入っているか。入っていなければ、貼り付け先を訊く必要が無い */
export function hasEmphasis(text: string): boolean {
  EMPHASIS_INTERNAL.lastIndex = 0;
  return EMPHASIS_INTERNAL.test(text);
}

/** 傍点の中身を1件ずつ取り出す */
export function findEmphasis(text: string): string[] {
  return [...text.matchAll(EMPHASIS_INTERNAL)].map((match) => match[1]);
}

/**
 * `{漢字|かんじ}` と `{{強調}}` を投稿サイトの記法へ。
 *
 * @param site 傍点の書き方だけがこれで変わる。ルビは変わらない
 */
export function toSiteNotation(
  text: string,
  style: RubyStyle["id"] = "site",
  site: EmphasisSite = "kakuyomu"
): string {
  switch (style) {
    case "site":
      return text
        .replace(EMPHASIS_INTERNAL, (_, base: string) =>
          site === "kakuyomu" ? `《《${base}》》` : `｜${base}《${dotsFor(base)}》`
        )
        .replace(INTERNAL, (_, base, reading) =>
          reading ? `｜${base}《${reading}》` : base
        );
    case "alphapolis-hash":
      // アルファポリスには傍点の記法が無いので、ルビでの代用に揃える
      return text
        .replace(
          EMPHASIS_INTERNAL,
          (_, base: string) => `#${base}__${dotsFor(base)}__#`
        )
        .replace(INTERNAL, (_, base, reading) =>
          reading ? `#${base}__${reading}__#` : base
        );
    case "paren":
      /*
        **noteにはルビの記法が無い**（設計書6.68.3）。`｜漢字《かんじ》` を
        そのまま貼れば、読者の目の前に記号が並ぶ。読みは括弧に入れて
        本文の中へ落とし、**傍点は印だけを落として文字を残す**
        （ルビでの代用も効かないため。`stripRuby` と同じ「印は本文ではない」）。
      */
      return text
        .replace(EMPHASIS_INTERNAL, "$1")
        .replace(INTERNAL, (_, base: string, reading: string) =>
          reading ? `${base}（${reading}）` : base
        );
    case "html":
      return text
        .replace(
          EMPHASIS_INTERNAL,
          (_, base: string) =>
            `<span style="text-emphasis: filled dot; -webkit-text-emphasis: filled dot;">${escapeHtml(
              base
            )}</span>`
        )
        .replace(INTERNAL, (_, base, reading) =>
          reading
            ? `<ruby>${escapeHtml(base)}<rt>${escapeHtml(reading)}</rt></ruby>`
            : escapeHtml(base)
        );
  }
}

/**
 * 投稿サイトの記法を `{漢字|かんじ}` へ戻す。
 *
 * **すでに投稿した原稿を取り込むときに使う。** 縦線ありを先に処理する。
 * 先に縦線なしを当てると、`｜漢字《かんじ》` の縦線が置いてけぼりになる。
 */
export function fromSiteNotation(text: string): string {
  return (
    text
      // **傍点を先に読む。** 中黒だけの読み仮名をルビとして取り込むと、
      // 傍点だったものが「・・」というルビになって残る
      .replace(EMPHASIS_KAKUYOMU, (_, base: string) => `{{${base}}}`)
      .replace(EMPHASIS_AS_RUBY, (_, base: string) => `{{${base}}}`)
      .replace(SITE_BAR, (_, base, reading) => `{${base}|${reading}}`)
      .replace(SITE_HASH, (_, base, reading) => `{${base}|${reading}}`)
      .replace(SITE_BARE, (_, base, reading) => `{${base}|${reading}}`)
  );
}

/**
 * 投稿サイトの記法が入っているか（取り込む価値があるか）。
 *
 * **`.txt` を `.md` にするとき、中に既にルビや傍点があれば直す**
 * （設計書6.12.4）。名前を変えただけでは、プレビューでもルビとして
 * 表示されず、「ルビを振る」の対象にもならない。
 */
export function countSiteNotation(text: string): {
  ruby: number;
  emphasis: number;
} {
  const emphasis =
    [...text.matchAll(EMPHASIS_KAKUYOMU)].length +
    [...text.matchAll(EMPHASIS_AS_RUBY)].length;
  // 傍点として読むぶんを、ルビから差し引く（同じ並びを二重に数えない）
  const withoutEmphasis = text
    .replace(EMPHASIS_KAKUYOMU, "")
    .replace(EMPHASIS_AS_RUBY, "");
  const ruby =
    [...withoutEmphasis.matchAll(SITE_BAR)].length +
    [...withoutEmphasis.matchAll(SITE_HASH)].length +
    [...withoutEmphasis.replace(SITE_BAR, "").matchAll(SITE_BARE)].length;
  return { ruby, emphasis };
}

/** プレビュー用のHTML。ルビ以外はそのまま返す（呼ぶ側で escape 済みを想定しない） */
export function rubyToHtml(text: string): string {
  return toSiteNotation(text, "html");
}

/**
 * ルビを取り除いて、本文だけにする。
 *
 * **投稿サイトは読み仮名を字数に数えない**ので、文字数の計測でも使う。
 */
export function stripRuby(text: string): string {
  // 傍点の印も落とす。**印は本文ではない**ので、字数に数えない
  return text.replace(EMPHASIS_INTERNAL, "$1").replace(INTERNAL, "$1");
}

/**
 * 傍点として正しい形か。理由が分かる文字列を返す（問題なければ null）。
 *
 * **読み仮名が無いぶん、ルビより条件はゆるい。** それでも記号は弾く
 * ——`}` が混ざると、そこで印が閉じてしまう。
 */
export function validateEmphasis(base: string): string | null {
  if (!base.trim()) return "傍点を付ける文字がありません。";
  if (/[{}|｜《》#\r\n]/u.test(base)) {
    return "傍点に使えない記号（{ } | ｜ 《 》 #）が入っています。";
  }
  if (Array.from(base).length > 30) {
    return "傍点を付ける文字が長すぎます（30文字まで）。";
  }
  return null;
}

/**
 * 見つかった件数を、作者に読める言葉にする。
 *
 * **ルビと傍点で言い分ける。** 「12件のルビ」とだけ出ていると、
 * 傍点まで直されることに気づけない。
 */
export function describeSiteNotation(text: string): string {
  const { ruby, emphasis } = countSiteNotation(text);
  const parts: string[] = [];
  if (ruby > 0) parts.push(`ルビ${ruby}件`);
  if (emphasis > 0) parts.push(`傍点${emphasis}件`);
  return parts.length > 0 ? parts.join("と") : "投稿サイトの記法";
}

/**
 * ルビとして正しい形か。理由が分かる文字列を返す（問題なければ null）。
 */
export function validateRuby(base: string, reading: string): string | null {
  if (!base.trim()) return "ルビを振る文字がありません。";
  if (!reading.trim()) return "読み仮名がありません。";
  if (/[{}|｜《》#\r\n]/u.test(base) || /[{}|｜《》#\r\n]/u.test(reading)) {
    return "ルビに使えない記号（{ } | ｜ 《 》 #）が入っています。";
  }
  if (base.length > 30) return "ルビを振る文字が長すぎます（30文字まで）。";
  if (reading.length > 30) return "読み仮名が長すぎます（30文字まで）。";
  return null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
