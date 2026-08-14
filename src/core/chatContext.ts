/**
 * 「いま作者がどの画面を見ているか」の判定。
 *
 * 相談パネル（`features/workChatPanel.ts`）は、開いているファイルを見て
 * 何について聞かれているのかを推し量る。**種類が分かると、AIへ渡す材料が
 * 変わる。** 本文なら前後の場面、プロットならプロット全体、設定資料なら
 * その資料、というように。
 *
 * ここは判定だけを担い、VS Code APIに依存しない。
 */

export type ChatContextKind =
  /** 本文（原稿） */
  | "manuscript"
  /** プロット（設定/plot.md） */
  | "plot"
  /** 作品紹介文・各話あらすじ（設定/synopsis.md） */
  | "synopsis"
  /** 設定資料のMarkdown（characters.md など） */
  | "settingsDoc"
  /** 作品の中の、上のどれでもないファイル */
  | "otherInWork"
  /** 作品の外。相談は受けるが、作品の材料は渡さない */
  | "outside";

export interface ClassifyInput {
  /** 作品フォルダからの相対パス。区切りは `/` でも `\` でもよい */
  relativePath: string;
  /** 設定フォルダの名前（既定は「設定」） */
  settingsDirName: string;
  /** 本文として数えられているファイルか。走査結果から渡す */
  isEpisode: boolean;
}

export function classifyChatContext(input: ClassifyInput): ChatContextKind {
  const parts = input.relativePath.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return "outside";

  // 本文かどうかは、拡張子ではなく走査結果で決める。
  // 作品によって本文の置き場所（直下か「本文」フォルダか）が違う
  if (input.isEpisode) return "manuscript";

  const fileName = parts[parts.length - 1];
  const inSettings = parts[0] === input.settingsDirName;

  if (inSettings) {
    if (fileName === "plot.md") return "plot";
    if (fileName === "synopsis.md" || fileName === "synopses.md") {
      return "synopsis";
    }
    if (fileName.endsWith(".md")) return "settingsDoc";
  }

  return "otherInWork";
}

/** 画面に出す、いま何を見ているかの短い説明 */
export function describeChatContext(
  kind: ChatContextKind,
  fileName: string,
  chapterLabel?: string | null
): string {
  switch (kind) {
    case "manuscript":
      return chapterLabel ? `${chapterLabel} の本文` : `${fileName}（本文）`;
    case "plot":
      return "プロット";
    case "synopsis":
      return "作品紹介文・各話あらすじ";
    case "settingsDoc":
      return `設定資料（${fileName}）`;
    case "otherInWork":
      return fileName;
    case "outside":
      return "作品のファイル以外";
  }
}

/**
 * AIへ渡す抜粋を切り出す。
 *
 * **選択範囲があればそれを最優先にする。** 作者が範囲を選んで質問するのは
 * 「ここについて聞きたい」という意思表示であり、全体を渡すと薄まる。
 *
 * 選択が無ければカーソル位置の前後を渡す。長い本文（73万字のファイルがある）
 * を丸ごと渡すことはできないため、必ず上限で切る。
 */
export interface ExcerptInput {
  text: string;
  /** 選択範囲。無ければ undefined */
  selection?: string;
  /** カーソルの文字位置。選択が無いときの中心 */
  caret?: number;
  maxChars: number;
}

export function buildExcerpt(input: ExcerptInput): {
  text: string;
  truncated: boolean;
} {
  const selection = input.selection?.trim();
  if (selection) {
    return selection.length <= input.maxChars
      ? { text: selection, truncated: false }
      : { text: selection.slice(0, input.maxChars), truncated: true };
  }

  if (input.text.length <= input.maxChars) {
    return { text: input.text, truncated: false };
  }

  // カーソルを中心に前後を採る。指定が無ければ冒頭から
  const caret = input.caret ?? 0;
  const half = Math.floor(input.maxChars / 2);
  const start = Math.max(0, Math.min(caret - half, input.text.length - input.maxChars));
  return {
    text: input.text.slice(start, start + input.maxChars),
    truncated: true,
  };
}
