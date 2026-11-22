// paths.ts は vscode を読むので、文字列だけの pathText を使う（core に vscode を持ち込まない）
import * as path from "./pathText";
import { parseEpisodeFileName, sanitizeFileName } from "./episodeParser";
import { nameWithSubtitle } from "./episodeCopy";

/**
 * 作品一覧の右クリック［ファイル名にサブタイトルを付ける］で、新しい名前を確かめる（設計書6.68.2）。
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

/** 話数も日付も無い名前か（並び順を決める部分が無い） */
function hasNoOrderPart(fileName: string): boolean {
  const parsed = parseEpisodeFileName(fileName);
  return parsed.chapterStart === null && parsed.date === null && !parsed.subtitle;
}

/**
 * いまファイル名に付いている題。
 *
 * 話数・日付のある名前は `parseEpisodeFileName` が読む題。話数も日付も無い名前は読み手が
 * 題を返さないので、ここで決める：
 * - 種類の語で始まる名前（`閑話_星の夜.txt`）は、最初の `_` より後ろが題
 * - 種類も読めない名前（創作メモ集の `アイデア.md` など）は、拡張子を外した名前全体が題
 *
 * 決めないと、付け直すたびに題が後ろへ積み重なる（`アイデア_題1_題2.md`。2026-11-22 に見つけた）。
 */
export function currentFileTitle(fileName: string): string | null {
  const parsed = parseEpisodeFileName(fileName);
  if (parsed.subtitle) return parsed.subtitle;
  if (!hasNoOrderPart(fileName)) return null;
  const extension = path.extname(fileName);
  const base = extension ? fileName.slice(0, fileName.length - extension.length) : fileName;
  if (parsed.kind === "不明") return base || null;
  const at = base.indexOf("_");
  return at > 0 ? base.slice(at + 1) || null : null;
}

/**
 * 題の部分だけを `title` に入れ替えた名前。話数・日付・種類の部分と拡張子は残す。
 * 変える必要が無ければ undefined。
 */
export function retitledFileName(fileName: string, title: string | null): string | undefined {
  const trimmed = title?.trim();
  if (!trimmed) return undefined;
  if (hasNoOrderPart(fileName) && parseEpisodeFileName(fileName).kind === "不明") {
    // 残す部分が無いので、名前全体を題にする
    const safe = sanitizeFileName(trimmed);
    const next = safe ? `${safe}${path.extname(fileName)}` : "";
    return next && next !== fileName ? next : undefined;
  }
  return nameWithSubtitle(fileName, currentFileTitle(fileName), trimmed);
}

/**
 * ［ファイル名にサブタイトルを付ける］で作った名前を確かめる（【タイトル】から作った名前も、打ち直した名前も）。
 *
 * 組み立てた名前は `checkEpisodeRename` に通す（題に「幕間」や数字を入れて種類・話数の読みが変わる名前を止める）。
 *
 * @param title 新しい題（話数の見出しは呼ぶ側で落としておく）
 */
export function checkSubtitleRetitle(fileName: string, title: string): EpisodeRenameCheck {
  if (!title.trim()) return { ok: false, reason: "サブタイトルを入れてください。" };
  const next = retitledFileName(fileName, title);
  if (!next) return { ok: false, reason: "いまと同じ名前です。" };
  return checkEpisodeRename(fileName, next);
}
