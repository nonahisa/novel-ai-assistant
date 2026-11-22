// paths.ts は vscode を読むので、文字列だけの pathText を使う（core に vscode を持ち込まない）
import * as path from "./pathText";
import { parseEpisodeFileName, sanitizeFileName } from "./episodeParser";

/**
 * 作品一覧の右クリック［名前を変える］で、作者が打った名前を確かめる（設計書6.68.2）。
 *
 * **話数・日付・種別（プロローグ・幕間など）が変わる名前は断る。** 名前だけの改名で付け替えるのは
 * パスで話を指す記録（章立て・本の設計図・年表・投稿状態・読みの辞書・話数の無い話の各話あらすじ）
 * だけで、話数で指す記録（人物の登場話・伏線・各話あらすじ）は動かさない。話数の読みが変わる名前を
 * 通すと、それらが別の話を指すようになり、並び順も崩れる。話数を動かすのは［前に話を挿入］などの
 * 付け替えの道に任せる。
 *
 * **拡張子は変えない。** .txt と .md では原稿の開き方が違い、.md 化には別の道（本文の .md 化）がある。
 */
export type EpisodeRenameCheck =
  | { ok: true; fileName: string }
  | { ok: false; reason: string };

/** 入力欄に最初に出す名前（拡張子を外したもの） */
export function episodeRenameInputValue(fileName: string): string {
  const extension = path.extname(fileName);
  return extension ? fileName.slice(0, fileName.length - extension.length) : fileName;
}

/**
 * 入力欄で最初に選んでおく範囲（題の部分）。題が読めなければ undefined（全体を選ぶ）。
 * 作者が題だけを打ち替えれば済むようにする
 */
export function episodeRenameSelection(fileName: string): [number, number] | undefined {
  const base = episodeRenameInputValue(fileName);
  const subtitle = parseEpisodeFileName(fileName).subtitle;
  if (!subtitle) return undefined;
  const at = base.lastIndexOf(subtitle);
  return at >= 0 ? [at, at + subtitle.length] : undefined;
}

export function checkEpisodeRename(oldFileName: string, input: string): EpisodeRenameCheck {
  const extension = path.extname(oldFileName);
  let typed = input.trim();
  // 拡張子まで打った場合は外して読む（同じ拡張子だけ。違う拡張子は名前の一部として読む）
  if (extension && typed.toLowerCase().endsWith(extension.toLowerCase())) {
    typed = typed.slice(0, typed.length - extension.length);
  }
  const base = sanitizeFileName(typed);
  if (!base) return { ok: false, reason: "名前を入れてください。" };
  const fileName = `${base}${extension}`;
  if (fileName === oldFileName) return { ok: false, reason: "いまと同じ名前です。" };

  const before = parseEpisodeFileName(oldFileName);
  const after = parseEpisodeFileName(fileName);
  if (before.date !== after.date || before.dateSeq !== after.dateSeq) {
    return { ok: false, reason: "日付の部分（並び順を決めている部分）は変えられません。" };
  }
  if (before.kind !== after.kind) {
    return {
      ok: false,
      reason: `話の種類が「${before.kind}」から「${after.kind}」に変わる名前にはできません。`,
    };
  }
  if (before.chapterStart !== after.chapterStart || before.chapterEnd !== after.chapterEnd) {
    return { ok: false, reason: "話数の部分（並び順を決めている部分）は変えられません。" };
  }
  return { ok: true, fileName };
}
