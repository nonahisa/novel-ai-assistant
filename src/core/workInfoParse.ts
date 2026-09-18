/**
 * 作品情報（`about.txt`）の中身を読み取る（設計書6.99）。
 *
 * **見分けは `workInfoFile.ts`、読み取りはこちら。** あちらは「このファイルは
 * 本文ではない」と言うだけで、中身は捨てていた。ところが投稿サイトの
 * バックアップには、**作者がすでに書いたキャッチコピー・紹介文・タグ・
 * ジャンル**が入っている。AIに作り直させる前に、書いてあるものを使う。
 *
 * 【見出し】の拾い方は `metadataParser.ts` と同じ形にしてある——行頭に
 * 単独で置かれた【】だけを見出しと読み、括弧付き（【紹介文（9行）】）は
 * 括弧を落とす。**行の途中にある【】は拾わない**（本文の「看板には
 * 【立入禁止】と書かれていた」を見出しと取り違えないため）。
 *
 * VS Code APIに依存しない。
 */

/** 【見出し】1つぶん */
export interface LabeledBlock {
  /** 括弧を落とした見出し（「紹介文（9行）」→「紹介文」） */
  readonly label: string;
  /** 見出しの次の行から、次の見出しの手前まで */
  readonly value: string;
}

/**
 * 行頭の【見出し】で区切る。
 *
 * **`workInfoFile.ts` も、この1つを通す。** 同じ正規表現を2か所に書くと、
 * 見出しの書き方が増えたときに片方だけが古くなる（見分けは通るのに
 * 読み取りが空、という噛み合わなさが起きる）。
 */
export function parseLabeledBlocks(rawText: string): LabeledBlock[] {
  const lines = rawText.replace(/\r\n?/g, "\n").split("\n");
  const blocks: LabeledBlock[] = [];
  let label: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (label !== null) blocks.push({ label, value: buffer.join("\n") });
  };

  for (const line of lines) {
    const matched = line.match(/^【([^】]+)】\s*$/);
    if (matched) {
      flush();
      label = normalizeLabel(matched[1]);
      buffer = [];
      continue;
    }
    if (label !== null) buffer.push(line);
  }
  flush();

  return blocks;
}

/** 「紹介文（9行）」→「紹介文」（`metadataParser.ts` と同じ落とし方） */
function normalizeLabel(label: string): string {
  return label.replace(/[（(].*?[）)]\s*$/, "").trim();
}

/**
 * 読み取った作品情報。
 *
 * **書かれていなかった項目は `null`（タグだけ空配列）にする。** 空文字と
 * 分けるのは、「作者が空にした」と「そもそも欄が無い」を取り違えないため。
 */
export interface WorkInfo {
  /** 【タイトル】 */
  readonly title: string | null;
  /** 【作者名】 */
  readonly author: string | null;
  /** 【ジャンル】 */
  readonly genre: string | null;
  /** 【キャッチコピー】 */
  readonly catchphrase: string | null;
  /** 【紹介文】。無ければ【あらすじ】を採る */
  readonly blurb: string | null;
  /** 【タグ】。箇条書きを1つずつに分けたもの */
  readonly tags: readonly string[];
}

/** 紹介文が入る見出し。**先に書いてあるほうを採る** */
const BLURB_LABELS = ["紹介文", "あらすじ"];

export function parseWorkInfo(rawText: string): WorkInfo {
  const blocks = parseLabeledBlocks(rawText);

  const find = (label: string): string | null => {
    const found = blocks.find((block) => block.label === label);
    if (!found) return null;
    const value = trimBlankEdges(found.value);
    return value === "" ? null : value;
  };

  const findAny = (labels: readonly string[]): string | null => {
    for (const label of labels) {
      const value = find(label);
      if (value !== null) return value;
    }
    return null;
  };

  return {
    // **1行に畳む。** 題が2行に分かれて書かれることはないが、末尾に
    // 空行が残っているとフォルダー名にそのまま持ち込んでしまう
    title: oneLine(find("タイトル")),
    author: oneLine(find("作者名")),
    genre: oneLine(find("ジャンル")),
    catchphrase: oneLine(find("キャッチコピー")),
    blurb: findAny(BLURB_LABELS),
    tags: parseTagList(find("タグ")),
  };
}

/**
 * 【タグ】の中身を1つずつに分ける。
 *
 * カクヨムは `- 異世界転生` のような箇条書きで書く。**箇条書きでない
 * 書き方も通す**——なろうのダウンロードツールは空白区切りで並べる。
 */
export function parseTagList(value: string | null): string[] {
  if (value === null) return [];
  const tags: string[] = [];
  for (const line of value.split("\n")) {
    const body = line.replace(/^[\s　]*[-*・][\s　]*/, "").trim();
    if (body === "") continue;
    // 箇条書きでない行は、空白で区切って並べてあるとみなす
    if (/^[-*・]/.test(line.trim())) {
      tags.push(body);
      continue;
    }
    for (const piece of body.split(/[\s　]+/)) {
      if (piece !== "") tags.push(piece);
    }
  }
  // 同じタグが2度書いてあることがある。**先に書いたほうを残す**
  return [...new Set(tags)];
}

/** 前後の空行を落とす（中の空行は残す） */
function trimBlankEdges(value: string): string {
  return value.replace(/^\n+/, "").replace(/[\s　]+$/, "");
}

/**
 * 1行に畳む。空になったら null。
 *
 * **中の空白には触らない。** 以前は `\s+` を半角空白1つへ潰していたが、
 * `\s` は全角空白（U+3000）も拾う——実物のバックアップで
 * 「成り上がり　～別視点バージョン～」の**全角空白が半角に変わった**
 * （2026-09-19、実データで判明）。作者が題に入れた空白は、題の一部である。
 */
function oneLine(value: string | null): string | null {
  if (value === null) return null;
  // 畳むのは改行だけ。前後の空白は落とす（見出しの次の空行を持ち込まない）
  const line = value.replace(/[\r\n]+/g, " ").trim();
  return line === "" ? null : line;
}
