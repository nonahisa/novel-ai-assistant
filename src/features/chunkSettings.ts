import * as vscode from "vscode";
import {
  parseChunkSizeMode,
  resolveChunkChars,
  resolveMergeChars,
  type ChunkSizeMode,
  type ResolvedChunkSize,
} from "../core/chunker";

/**
 * チャンクの大きさに関する設定を、1か所で読む（設計書6.23）。
 *
 * **同じ設定が、機能によって効いたり効かなかったりしていた。**
 * `novelai.chunkChars` を見ていたのは誤字脱字検知と設定資料の抽出だけで、
 * **推敲と矛盾検知は設定を無視していつも自動**だった（2026-08-23に判明）。
 * 作者から見て理由の無い違いなので、読むところを1つにまとめる。
 */

export interface ChunkSettings {
  mode: ChunkSizeMode;
  /** 1チャンクの字数 */
  chunk: ResolvedChunkSize;
  /** まとめて送るときの1回ぶんの字数。0ならまとめない */
  mergeChars: number;
}

export function readChunkSettings(contextWindow: number): ChunkSettings {
  const config = vscode.workspace.getConfiguration("novelai");
  const mode = parseChunkSizeMode(config.get<string>("chunkSizeMode"));

  const chunk = resolveChunkChars({
    mode,
    configured: config.get<number>("chunkChars"),
    contextWindow,
  });
  const mergeChars = resolveMergeChars({
    mode,
    configured: config.get<number>("mergeChunkChars"),
    chunkChars: chunk.chars,
  });

  return { mode, chunk, mergeChars };
}

/**
 * 何を根拠に決めたかを、ログへ残す言葉にする。
 *
 * **「20,000字で処理します」だけでは、なぜその値なのか分からない。**
 * 設定を直したのに変わらない、という問い合わせの元になる。
 */
export function describeChunkSettings(settings: ChunkSettings): string {
  const source =
    settings.chunk.from === "model"
      ? "モデルのコンテキスト長から"
      : settings.chunk.from === "setting"
        ? "設定の指定値"
        : "字数の指定が無いためモデルから";
  const merge =
    settings.mergeChars > 0
      ? `／まとめ送信 ${settings.mergeChars}字`
      : "／まとめ送信なし";
  return `1チャンク ${settings.chunk.chars}字（${source}）${merge}`;
}
