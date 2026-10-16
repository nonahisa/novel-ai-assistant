import { basename, pathKeyForComparison } from "./pathText";

/**
 * **こちらが自分で保存した plot.md**（場所 → 保存した中身。LF空間）。
 *
 * プロットを書く口は、plot.md がエディターで開いていれば文書へ当てて保存する
 * （`openDocumentEdit.ts`。ディスクを直に書くと Ctrl+S が「ファイルのほうが新しい」で断られたため）。
 * その保存でも「保存からの反映」（`extension.ts`、設計書6.4.9）が走ると、プロットモードの［入れる］が
 * もう置いた案の上に、役名だけの人物の新規の案と、置いたばかりの直す案への重ね書きを積み、
 * 知らせも1つ増えた（画面テスト plotRenamePending、2026-10-16）。ディスクへ書いていたころは
 * 保存の知らせが出ないので、この反映は走らなかった。**こちらの保存では反映を走らせず、
 * 作者が次に保存したときに走る、という前の振る舞いに揃える。**
 *
 * 時間ではなく**中身で**見分ける。保存の知らせが届く前に作者が打ち足していれば、中身が違うので
 * 反映は走る（作者の書いた分を取りこぼさない）。
 *
 * もとは `features/plotCharacterSync.ts` にあった。プロットの節を書く口（`plotFile.ts`）からも
 * 覚えさせるため core へ移した（features からは import できない）。
 */
const ownPlotSaves = new Map<string, string>();

function ownSaveKey(filePath: string): string {
  return pathKeyForComparison(filePath);
}

/** 保存からの反映が見るファイルか（`extension.ts` の受け口と同じ見分け方） */
export function isPlotFilePath(filePath: string): boolean {
  return basename(filePath).toLowerCase() === "plot.md";
}

/**
 * 見分けに使う形へ揃える。
 *
 * **保存の前の加工を見ない。** `files.trimTrailingWhitespace`・`files.insertFinalNewline`・
 * `files.trimFinalNewlines` は、こちらが覚えた中身を保存の直前に書き換える。中身をそのまま
 * 比べると外れて、こちらの保存で反映が走る（0.107.8 で残った懸念）。どれも字は変えない
 * （行末の空白と末尾の改行だけ）ので、そこを落として比べても、作者の打ち足しは取りこぼさない
 */
function comparable(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/** これから自分で保存する plot.md の中身を覚える（保存の前に呼ぶ） */
export function noteOwnPlotSave(filePath: string, lfText: string): void {
  ownPlotSaves.set(ownSaveKey(filePath), lfText);
}

/** 保存できなかったときに忘れる（残すと、作者が同じ中身で保存したときに反映が走らない） */
export function forgetOwnPlotSave(filePath: string): void {
  ownPlotSaves.delete(ownSaveKey(filePath));
}

/**
 * 保存されたのが、こちらが自分で保存した中身か。**当たったら1度きりで忘れる**
 * （次の保存は作者のもの）
 */
export function consumeOwnPlotSave(filePath: string, savedText: string): boolean {
  const key = ownSaveKey(filePath);
  const expected = ownPlotSaves.get(key);
  if (expected === undefined) return false;
  ownPlotSaves.delete(key);
  return comparable(expected) === comparable(savedText);
}
