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

export function parseEpisodeMetadata(rawText: string): EpisodeMetadata {
  const text = rawText.replace(/\r\n?/g, "\n");

  // 先頭が【...】で始まらない場合はメタデータ無しと判断する
  if (!/^\s*【[^】]+】/.test(text)) {
    return emptyMetadata(text);
  }

  const blocks = splitHeaderBlocks(text);
  if (blocks.blocks.length === 0) {
    return emptyMetadata(text);
  }

  const find = (label: string): string | null => {
    const b = blocks.blocks.find((x) => x.label === label);
    return b ? b.value.trim() || null : null;
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
    title: find("タイトル"),
    publishState: find("公開状態"),
    createdAt: find("作成日時"),
    publishedAt: find("公開日時"),
    updatedAt: find("更新日時"),
    declaredCharCount: parseDeclaredCount(find("文字数")),
    body: bodyBlock.value.replace(/^\n+/, ""),
  };
}

/**
 * 行頭の【ラベル】で区切ってブロックに分割する。
 * 最後のブロック（通常は本文）は以降すべてを値とする。
 */
function splitHeaderBlocks(text: string): { blocks: HeaderBlock[] } {
  const lines = text.split("\n");
  const blocks: HeaderBlock[] = [];
  let current: HeaderBlock | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current) {
      current.value = buffer.join("\n");
      blocks.push(current);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 本文に入ったら以降は分割しない（本文中の【】に反応させない）
    const label: string = current === null ? "" : (current as HeaderBlock).label;
    const isBodyStarted: boolean =
      label !== "" && BODY_LABELS.some((l: string) => label.startsWith(l));

    const m: RegExpMatchArray | null = isBodyStarted
      ? null
      : line.match(/^【([^】]+)】\s*$/);
    if (m) {
      flush();
      current = { label: normalizeLabel(m[1]), value: "" };
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  flush();

  return { blocks };
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
