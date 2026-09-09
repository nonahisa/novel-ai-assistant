/**
 * 小説投稿サイトのダウンロードツールが付与するメタデータヘッダーを解析する。
 *
 * カクヨム形式の例:
 *   【タイトル】
 *   ケース００１　元A級冒険者　ジャックへの就労指導
 *
 *   【公開状態】
 *   公開済
 *
 *   【作成日時】
 *   2023-12-03 22:33:45（+09:00）
 *
 *   【公開日時】
 *   2023-12-04 00:03:20（+09:00）
 *
 *   【更新日時】
 *   2023-12-08 00:15:06（+09:00）
 *
 *   【文字数】
 *   1,826文字
 *
 *   【本文（69行）】
 *   （ここから本文）
 *
 * ヘッダーを本文の文字数に含めてしまうと、投稿サイト上の
 * 文字数と一致しなくなるため、本文部分だけを切り出す。
 *
 * バックアップの頭書き（設計書6.65.15の段D）の例:
 *
 *   -------- エピソード1開始 --------
 *   【エピソードタイトル】
 *   １話　転生
 *
 *   【本文】
 *   （ここから本文）
 *
 * **切り出しは、この関数の1か所だけで行う。** 文字数（`charCount`）も
 * EPUBの組版も段落番号（設計書6.65.10）も同じ関数を通っており、写しを
 * 作ると「画面の段落番号」と「本に入る位置」がずれる。
 */

export interface EpisodeMetadata {
  /** メタデータヘッダーが検出されたか */
  hasMetadata: boolean;
  /** 【タイトル】の値。話のサブタイトルとして使える */
  title: string | null;
  /** 【公開状態】 */
  publishState: string | null;
  /** 【作成日時】（元の文字列のまま） */
  createdAt: string | null;
  /** 【公開日時】 */
  publishedAt: string | null;
  /** 【更新日時】 */
  updatedAt: string | null;
  /** 【文字数】にサイト側が記載していた値 */
  declaredCharCount: number | null;
  /** 本文（ヘッダーを除いた部分） */
  body: string;
}

/** 【見出し】形式のブロックを表す */
interface HeaderBlock {
  label: string;
  value: string;
}

const BODY_LABELS = ["本文", "ほんぶん"];

/**
 * 話の題が入る見出し。カクヨムは【タイトル】、バックアップの頭書きは
 * 【エピソードタイトル】で、**どちらも同じ意味**である（設計書6.65.15の段D）。
 */
const TITLE_LABELS = ["タイトル", "エピソードタイトル"];

/**
 * 話の始まりの区切り行（`------- エピソード12開始 -------`）。
 *
 * 番号を持たない `---- エピソード開始 ----` も同じ意味で使われるので、
 * 数字は任意にしてある。
 */
const EPISODE_SEPARATOR = /^-{3,}\s*エピソード\s*\d*\s*開始\s*-{3,}$/;

/**
 * その行が話の区切りか。
 *
 * **判定の写しを作らない。** 合本を割れなかったときの逃げ道
 * （`bookChapters.ts`）が「区切り行しか無いファイル」を見分けるのに要る。
 * 別の正規表現を書くと、区切りの書き方が増えたときに片方だけが古くなる。
 */
export function isEpisodeSeparatorLine(line: string): boolean {
  return EPISODE_SEPARATOR.test(line.trim());
}

/**
 * 本文の後ろに続く見出し（本体の裁定、2026-09-04）。
 *
 * ダウンロードファイルは本文のあとへ【後書き】【リアクション】を続ける。
 * **作者が書いた物語ではない**ので、本にも字数にも入れない——合本
 * （`collectedFile.ts` の `isKnownLabel`）が既に外しており、単話だけが
 * 取り込んでいた非対称をここで解消する。
 *
 * **知っている見出しでしか切らない。** 本文には「看板には【立入禁止】と
 * 書かれていた」のような【】が出てくるので、どんな【】でも切る作りには
 * しない（合本側とまったく同じ判断）。
 */
const AFTER_BODY_LABELS = [
  "前書き",
  "後書き",
  "リアクション",
  "エピソードタイトル",
];

/** 本文の後ろで本文を終わらせる見出しか。章題は番号が動くので形で見る */
function endsBody(label: string): boolean {
  return AFTER_BODY_LABELS.includes(label) || /^第\d+章$/.test(label);
}

export function parseEpisodeMetadata(rawText: string): EpisodeMetadata {
  const text = rawText.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  // **合本はここでは触らない**（設計書6.65.15の段D）。区切りが2つ以上ある
  // ファイルは `collectedFile.ts` が話ごとに分ける道を持っており、こちらが
  // 半端に切ると「1話目だけの本文」と「全部入りの文字数」が混ざる
  const separators = lines.filter((line) =>
    EPISODE_SEPARATOR.test(line.trim())
  ).length;
  if (separators > 1) {
    return emptyMetadata(text);
  }

  // 頭書きの区切り行を1本だけ跨ぐ。**見つからなければ先頭のまま**
  // （頭書きの無い原稿を1文字も削らないため）
  const head = lines.slice(skipLeadingSeparator(lines)).join("\n");

  // 先頭が【...】で始まらない場合はメタデータ無しと判断する
  if (!/^\s*【[^】]+】/.test(head)) {
    return emptyMetadata(text);
  }

  const blocks = splitHeaderBlocks(head);
  if (blocks.blocks.length === 0) {
    return emptyMetadata(text);
  }

  const find = (label: string): string | null => {
    const b = blocks.blocks.find((x) => x.label === label);
    return b ? b.value.trim() || null : null;
  };

  /** 同じ意味の見出しのうち、先に書いてあるものを採る */
  const findAny = (labels: readonly string[]): string | null => {
    for (const label of labels) {
      const value = find(label);
      if (value !== null) return value;
    }
    return null;
  };

  // 【本文（69行）】のように括弧付きのラベルにも対応する
  const bodyBlock = blocks.blocks.find((b) =>
    BODY_LABELS.some((l) => b.label.startsWith(l))
  );

  // 本文ラベルが無ければメタデータ形式とみなさない
  // （【】を装飾として使っている本文を誤判定しないため）
  if (!bodyBlock) {
    return emptyMetadata(text);
  }

  return {
    hasMetadata: true,
    title: findAny(TITLE_LABELS),
    publishState: find("公開状態"),
    createdAt: find("作成日時"),
    publishedAt: find("公開日時"),
    updatedAt: find("更新日時"),
    declaredCharCount: parseDeclaredCount(find("文字数")),
    // **末尾の空行を落とすのは、後書き類で切ったときだけ**。いつも落とすと、
    // 後書きの無い原稿の末尾が1文字変わる（合本側と同じ落とし方）
    body: blocks.bodyEndedByLabel
      ? bodyBlock.value.replace(/^\n+/, "").replace(/\n+$/, "")
      : bodyBlock.value.replace(/^\n+/, ""),
  };
}

/**
 * 頭書きの区切り行を跨いだ、次の行の位置（設計書6.65.15の段D）。
 *
 * **区切りが見つからなければ 0 を返す。** 頭書きの無い原稿では、先頭の
 * 空行1つも落としてはいけない（本文がそのまま返る状態を保つ）。
 * 区切りの前に空行が入っている書き出しツールがあるので、空行だけは跨ぐ。
 */
function skipLeadingSeparator(lines: readonly string[]): number {
  let index = 0;
  while (index < lines.length && lines[index].trim() === "") index++;
  if (index < lines.length && EPISODE_SEPARATOR.test(lines[index].trim())) {
    return index + 1;
  }
  return 0;
}

/**
 * 行頭の【ラベル】で区切ってブロックに分割する。
 *
 * **本文に入ったあとは、知っている見出しでしか区切らない**（本体の裁定、
 * 2026-09-04）。どんな【】でも区切ると、本文の「看板には【立入禁止】と
 * 書かれていた」でそこが本文の終わりになる。逆に「本文に入ったら一切
 * 区切らない」（2026-09-04より前の作り）では、後ろに続く【後書き】
 * 【リアクション】まで本文に取り込んでしまう——合本側（`collectedFile.ts`）は
 * 既にこの中間を選んでおり、そちらへ揃えた。
 */
function splitHeaderBlocks(text: string): {
  blocks: HeaderBlock[];
  /** 本文が、後ろに続く見出しで終わったか（末尾の空行を落とすかの判断） */
  bodyEndedByLabel: boolean;
} {
  const lines = text.split("\n");
  const blocks: HeaderBlock[] = [];
  let current: HeaderBlock | null = null;
  let buffer: string[] = [];
  let bodyEndedByLabel = false;

  const flush = () => {
    if (current) {
      current.value = buffer.join("\n");
      blocks.push(current);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const label: string = current === null ? "" : (current as HeaderBlock).label;
    const isBodyStarted: boolean =
      label !== "" && BODY_LABELS.some((l: string) => label.startsWith(l));

    const matched: RegExpMatchArray | null = line.match(/^【([^】]+)】\s*$/);
    const found = matched ? normalizeLabel(matched[1]) : null;
    // 本文の中では、後書き類の見出しだけが本文を終わらせる
    const m = found !== null && (!isBodyStarted || endsBody(found)) ? found : null;
    if (m !== null) {
      if (isBodyStarted) bodyEndedByLabel = true;
      flush();
      current = { label: m, value: "" };
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  flush();

  return { blocks, bodyEndedByLabel };
}

/** 「本文（69行）」→「本文」のように括弧部分を落とす */
function normalizeLabel(label: string): string {
  return label.replace(/[（(].*?[）)]\s*$/, "").trim();
}

/** 「1,826文字」→ 1826 */
function parseDeclaredCount(value: string | null): number | null {
  if (!value) return null;
  const m = value.replace(/[,，]/g, "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function emptyMetadata(body: string): EpisodeMetadata {
  return {
    hasMetadata: false,
    title: null,
    publishState: null,
    createdAt: null,
    publishedAt: null,
    updatedAt: null,
    declaredCharCount: null,
    body,
  };
}
