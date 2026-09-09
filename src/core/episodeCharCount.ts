import type { CharCounts } from "../models/types";
import { countChars } from "./charCount";
import { parseCollectedFile, type CollectedEpisode } from "./collectedFile";
import { parseEpisodeMetadata } from "./metadataParser";

/**
 * 話の字数の数え方（設計書6.4・6.25）。
 *
 * **どの画面でも同じ数字を出す。** 作品一覧（`core/scanner.ts`）と
 * 原稿エディタの「このファイル ◯字」が別々に数えていたため、同じ話に
 * 2つの字数が出た（作者の指摘 2026-09-06）。
 *
 * - 単話：カクヨム形式の頭書き（【タイトル】〜【本文】）と、
 *   本文の後ろの【後書き】【リアクション】を外す
 * - 合本（1ファイルに全話）：話ごとに割ってから本文だけを繋ぐ。
 *   まとめて数えると、後書き・リアクション（作者の物語ではない文章）まで
 *   進捗に足す。実データの73万字の作品で1万字あった
 * - ルビの読み（`{漢字|かんじ}`）を外すのは **`.md` のときだけ**。
 *   `.txt` は投稿サイトの記法をそのまま持っていることがあり、
 *   Markdownのルビ記法とは限らない
 *
 * **写しを作らないこと。** 数え方が2か所にあると、片方だけが直る日が来る。
 */

export interface EpisodeCountOptions {
  /** ファイルの拡張子（`.md` / `.txt`。小文字・ドット付き） */
  ext: string;
  /** 設定「ルビを文字数から外す」（`countSettings.excludeRubyFromCount`） */
  excludeRuby: boolean;
}

/**
 * 既に読み解いてある結果。**同じファイルを二度読み解かないため**にある。
 *
 * 作品一覧は全ファイルを毎回走査し、合本の割り方とメタデータの解析を
 * 別の用途（話数・題・シーンメモの印）でも使っている。渡さなければ
 * ここで読み解くので、呼び出し側は普通は気にしなくてよい。
 */
export interface ParsedEpisodeText {
  /** 割ってある合本。合本でないと判っているなら null */
  collected: CollectedEpisode[] | null;
  /** 頭書きを外してある本文（`parseEpisodeMetadata(text).body`） */
  metaBody: string;
}

/**
 * 数える対象の本文を取り出す。
 *
 * 頭書きも合本の区切りも無い普通の原稿では、渡した文字列がそのまま返る。
 */
export function episodeBodyForCount(
  rawText: string,
  parsed?: ParsedEpisodeText
): string {
  const collected = parsed ? parsed.collected : parseCollectedFile(rawText);
  if (collected) {
    return collected.map((episode) => episode.body).join("\n");
  }
  return parsed ? parsed.metaBody : parseEpisodeMetadata(rawText).body;
}

/** 話の字数を数える。純／総のどちらを出すかは呼び出し側（`pickCount`）が決める */
export function countEpisodeChars(
  rawText: string,
  options: EpisodeCountOptions,
  parsed?: ParsedEpisodeText
): CharCounts {
  return countChars(
    episodeBodyForCount(rawText, parsed),
    options.ext === ".md" ? options.excludeRuby : false
  );
}
