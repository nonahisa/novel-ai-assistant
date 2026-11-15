import { describe, expect, test } from "vitest";
import { sjisMarkPlaces, SJIS_MARK_CONTEXT_CHARS, type SjisMarkOccurrence } from "../../../src/core/sjisMarkFinding";

/**
 * 〓を拾う関数を「前から1回なめる」形に直した（実装の残り 124行）ので、直す前の関数と
 * 返す値がまったく同じことを確かめる。校正・メモパネルが〓を探し直す鍵（行・前後の字・位置）が
 * 1字でもずれると場所が合わなくなる。直す前の関数はここへ写してある（〓ごとに行の頭まで戻る形）。
 */
const MARK = "〓";

function referenceCountBreaks(segment: string): number {
  return (segment.match(/\r\n|\r|\n/g) ?? []).length;
}

function referenceSjisMarkPlaces(text: string): SjisMarkOccurrence[] {
  const found: SjisMarkOccurrence[] = [];
  let line = 1;
  let counted = 0;
  for (let at = text.indexOf(MARK); at >= 0; at = text.indexOf(MARK, at + MARK.length)) {
    line += referenceCountBreaks(text.slice(counted, at));
    counted = at;
    const lineStart = Math.max(text.lastIndexOf("\n", at - 1), text.lastIndexOf("\r", at - 1)) + 1;
    const rest = text.slice(at + MARK.length, at + MARK.length + SJIS_MARK_CONTEXT_CHARS * 2 + 2);
    const lineEnd = rest.search(/\r|\n/);
    const head = text.slice(Math.max(lineStart, at - SJIS_MARK_CONTEXT_CHARS * 2), at);
    const before = Array.from(head).slice(-SJIS_MARK_CONTEXT_CHARS).join("");
    const after = Array.from(lineEnd < 0 ? rest : rest.slice(0, lineEnd)).slice(0, SJIS_MARK_CONTEXT_CHARS).join("");
    found.push({ index: at, line, before, after, context: `${before}${MARK}${after}` });
  }
  return found;
}

const BODY = "あいうえおかきくけこさしすせそ";
const SAMPLES: Array<[string, string]> = [
  ["〓なし", `${BODY}\n${BODY}\n`],
  ["空", ""],
  ["LF・行の途中", `${BODY}\nあい〓うえお\n${BODY}\nかき〓くけ\n`],
  ["CRLF・行の途中", `${BODY}\r\nあい〓うえお\r\n${BODY}\r\nかき〓くけ\r\n`],
  ["CR だけ・行の途中", `${BODY}\rあい〓うえお\r${BODY}\rかき〓くけ\r`],
  ["行の頭（LF）", `${BODY}\n〓あいう\n〓\n${BODY}`],
  ["行の頭（CRLF）", `${BODY}\r\n〓あいう\r\n〓\r\n${BODY}`],
  ["行の頭（CR）", `${BODY}\r〓あいう\r〓\r${BODY}`],
  ["本文の先頭", `〓あいう\n${BODY}`],
  ["行の終わり（LF）", `${BODY}〓\n${BODY}〓\n`],
  ["行の終わり（CRLF）", `${BODY}〓\r\n${BODY}〓\r\n`],
  ["行の終わり（CR）", `${BODY}〓\r${BODY}〓\r`],
  ["本文の終わり", `${BODY}\n${BODY}〓`],
  ["続けて並ぶ（LF）", `${BODY}\nあ〓〓〓〓〓〓い\n〓〓〓\n`],
  ["続けて並ぶ（CRLF）", `${BODY}\r\nあ〓〓〓〓〓〓い\r\n〓〓〓\r\n`],
  ["続けて並ぶ（CR）", `${BODY}\rあ〓〓〓〓〓〓い\r〓〓〓\r`],
  ["改行が混じる", "a〓\r\nb〓\rc〓\nd〓\n\n\r\r\n〓\r\r〓"],
  ["空行が続く", "\n\n\n〓\n\n\r\n\r\n〓\r\r\r〓"],
  ["サロゲートと前後4字超", "𠮟𠮟𠮟𠮟𠮟𠮟𠮟〓𠮟𠮟𠮟𠮟𠮟𠮟\n❤️❤️〓❤️"],
  ["CR の直後に〓が来て LF が続く", "あ\r〓\nい\n〓\r"],
];

describe("sjisMarkPlaces（前から1回なめる形）が直す前と同じ値を返す", () => {
  for (const [name, text] of SAMPLES) {
    test(name, () => {
      expect(sjisMarkPlaces(text)).toEqual(referenceSjisMarkPlaces(text));
    });
  }

  test("ばらばらな本文を作って、直す前と全部同じ", () => {
    // 乱数は固定の種（毎回同じ本文。落ちたら再現できる）
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed >> 8;
    };
    const pieces = ["あ", "い", "〓", "〓", "\n", "\r", "\r\n", "𠮟", "❤️", "a"];
    for (let round = 0; round < 300; round++) {
      let text = "";
      const length = next() % 60;
      for (let at = 0; at < length; at++) text += pieces[next() % pieces.length];
      expect(sjisMarkPlaces(text), JSON.stringify(text)).toEqual(referenceSjisMarkPlaces(text));
    }
  });
});
