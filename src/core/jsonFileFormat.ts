import { detectEol } from "./eolAudit";
import { fromLfText } from "./eolSpace";

/**
 * 設定資料のJSONを、元のファイルの改行の形で書く（0.81.1）。
 *
 * Windows で git が CRLF にして取り出したファイルを、保存のたびに
 * `JSON.stringify(...) + "\n"`（LF）で書き直していた。**1項目を直した
 * だけで全行が差分になり**、同期のたびに作者の差分画面が埋まる
 * （ノートPCの実機確認、2026-09-23）。
 *
 * 本文の書き戻し（`textFile.ts`）と同じく「読んだままの改行で書き戻す」
 * （設計書5.4.2）を、設定資料にも当てる。**新しく作るファイルは
 * これまでどおり LF で末尾に改行を付ける。**
 *
 * VS Code に依存しない（`SettingsStore` と `CharacterStore` の両方が使う）。
 */
export interface JsonFileFormat {
  /** CRLF で書くか */
  readonly useCrlf: boolean;
  /** 末尾に改行を付けるか */
  readonly finalNewline: boolean;
}

/** 新しく作るファイルの形。これまでの書き方と同じ */
export const NEW_JSON_FILE_FORMAT: JsonFileFormat = {
  useCrlf: false,
  finalNewline: true,
};

/**
 * 既存ファイルのバイトから、改行の形を読み取る。
 *
 * 改行コードの判定は `detectEol`（走査・改行の監査と同じ）に任せる。
 * CRLF が1つでもあれば CRLF とみなす——JSON は全行を書き直すので、
 * 混ざったファイルは CRLF に揃う（git の autocrlf が作る形と同じ）。
 */
export function detectJsonFileFormat(bytes: Uint8Array): JsonFileFormat {
  const text = new TextDecoder().decode(bytes);
  return {
    useCrlf: detectEol(text).eol === "\r\n",
    finalNewline: text.endsWith("\n") || text.endsWith("\r"),
  };
}

/**
 * 値を、指定の形の JSON テキストにする（字下げは2つ。これまでと同じ）。
 *
 * `JSON.stringify` は文字列の中の改行を `\n` と書くので、生の改行は
 * 行の区切りにしか現れない。**全部を CRLF にしても値は変わらない。**
 */
export function formatJsonForFile(
  value: unknown,
  format: JsonFileFormat
): string {
  const body = JSON.stringify(value, null, 2);
  return fromLfText(format.finalNewline ? `${body}\n` : body, format.useCrlf);
}
