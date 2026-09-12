import { parseEpisodeFileName, toHalfWidthDigits } from "./episodeParser";

/**
 * AIが指したファイル名から、本物の話を引き当てる（相談パネルの「そこを見せて」）。
 *
 * **AIはファイル名を覚えていない。** 実機で `episode.4.txt` と指されたが、
 * 作品にあるのは `episode_0004.md` だった（2026-09-07）。そのまま開こうと
 * したためURLエンコードされた生のエラーが画面に出ている。
 *
 * ファイル名は当てずっぽうでも、**話数はたいてい合っている**——だから
 * 「数字を取り出して、その話を探す」ところまでをここで行う。
 * 引き当てられなければ `undefined` を返し、呼び出し側は作者の言葉で断る。
 *
 * VS Code APIに依存しない（ファイルの実在は呼び出し側が確かめる）。
 */

/**
 * ファイル名らしき文字列から話数を読む。読めなければ `undefined`。
 *
 * 例：`episode.4.txt` → 4 ／ `episode_0004.md` → 4 ／ `第4話 再会.md` → 4
 *
 * **数字が2つ以上あるものは引き当てない。** `2026-08-16.txt`（投稿日）や
 * `003-005_合本.txt`（範囲）を1つの話数に丸めると、**別の話を開いて
 * 「ここです」と言う**ことになる。開けないより悪い。
 */
export function episodeNumberFromHint(hint: string): number | undefined {
  const base = toHalfWidthDigits(baseName(hint));

  // 「第4話」「4話」は、ほかに数字があっても話数と読んでよい
  const labeled = /第?\s*(\d+)\s*話/.exec(base);
  if (labeled) return positive(labeled[1]);

  const runs = base.match(/\d+/g);
  if (!runs || runs.length !== 1) return undefined;
  return positive(runs[0]);
}

/**
 * 走査した話の中から、その話数のものを1つだけ返す。
 *
 * **2つ以上当たったら返さない。** 同じ話数のファイルが並んでいる作品
 * （旧版を残している、拡張子違いがある）で、どちらを指しているかは
 * こちらには決められない。
 *
 * **走査（`scanWork`）が読み取った話数があれば、そちらを先に使う。**
 * 合本（1ファイルに全話）のファイル名には範囲が書かれていないことが
 * あり（`全話.txt`）、ファイル名だけを見ていると**何話を指されても
 * 当たらなかった**（2026-09-12）。走査は中の各話のタイトルから話数を
 * 読んでいるので、そこに答えがある。
 *
 * 走査の値を持たない相手（試験の材料や、名前だけを並べた一覧）のために、
 * `parseEpisodeFileName` で読み直す道は退避先として残してある。
 */
export function resolveEpisodeByNumber<
  T extends {
    fileName: string;
    chapterStart?: number | null;
    chapterEnd?: number | null;
  },
>(episodes: readonly T[], chapter: number): T | undefined {
  const matched = episodes.filter((episode) => {
    const range = rangeOf(episode);
    if (range === null) return false;
    return chapter >= range.start && chapter <= range.end;
  });
  return matched.length === 1 ? matched[0] : undefined;
}

/** その話が受け持つ話数の範囲。読み取れなければ null */
function rangeOf(episode: {
  fileName: string;
  chapterStart?: number | null;
  chapterEnd?: number | null;
}): { start: number; end: number } | null {
  if (typeof episode.chapterStart === "number") {
    return {
      start: episode.chapterStart,
      end:
        typeof episode.chapterEnd === "number"
          ? episode.chapterEnd
          : episode.chapterStart,
    };
  }
  const parsed = parseEpisodeFileName(episode.fileName);
  if (parsed.chapterStart === null) return null;
  return {
    start: parsed.chapterStart,
    end: parsed.chapterEnd ?? parsed.chapterStart,
  };
}

/**
 * 末尾の名前だけを、拡張子を落として取り出す。
 *
 * **`core/paths` を使わない。** ここへ来るのはAIの書いた文字列で、
 * 場所として解決してよいものではない（`/` も `\` も、ただの区切りとして扱う）。
 */
function baseName(hint: string): string {
  const last = hint.split(/[\\/]/).pop() ?? "";
  return last.replace(/\.[^.]+$/, "").trim();
}

/** 0や負の数は話数にしない（`episode_0000` のような名前を弾く） */
function positive(text: string): number | undefined {
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
