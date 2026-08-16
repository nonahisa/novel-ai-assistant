import * as fs from "node:fs";

/**
 * 実接続の試験が使う、作者の環境の設定。
 *
 * **作品の場所をソースへ書かない。** 作者の手元の絶対パスであり、
 * 公開リポジトリに置くものではない。人によって置き場所も違うので、
 * 書いてあっても他の環境では動かない。
 *
 *   $env:NOVELAI_LIVE_WORK = "C:/path/to/作品"
 *   $env:NOVELAI_MODEL = "gemma4:e4b"   # 任意
 *   npx vitest run --config vitest.live.config.mts
 *
 * **決めていなければ試験を飛ばす。** 失敗にすると、実データを持たない
 * 環境（CI・他の開発者）で常に赤くなる。
 */

export const LIVE_MODEL = process.env.NOVELAI_MODEL ?? "gemma4:e4b";
export const OLLAMA_ENDPOINT =
  process.env.NOVELAI_OLLAMA ?? "http://localhost:11434";

/** 作品フォルダー。決めていない・見つからないなら undefined */
export function liveWorkPath(): string | undefined {
  const configured = process.env.NOVELAI_LIVE_WORK?.trim();
  if (!configured) return undefined;
  try {
    return fs.statSync(configured).isDirectory() ? configured : undefined;
  } catch {
    return undefined;
  }
}

/** 飛ばす理由。試験の見出しに出して、黙って通ったように見せない */
export const SKIP_REASON =
  "NOVELAI_LIVE_WORK に作品フォルダーを指定すると走ります";
