import { memoMarkersOf, type MemoMarkers } from "../../../src/core/memoMarkers";

/**
 * メモの印の判定の見本（設計書6.40.8）。core（`scanMemoLines`）と、その写し
 * （原稿エディターの組んで書く面・出先の原稿エディターのページ）に**同じ見本を通し、
 * 同じ答えになるか**を見張る（`composeFace.test.ts`・`editorPageLogic.test.ts`）。
 */
export interface MemoMarkerSample {
  name: string;
  markers: MemoMarkers;
  lines: string[];
}

const ALL = memoMarkersOf(["slash", "backslash", "percent", "comment"]);

export const MEMO_MARKER_SAMPLES: readonly MemoMarkerSample[] = [
  {
    name: "既定（// と ／／）",
    markers: memoMarkersOf(["slash"]),
    lines: ["// TODO 足す", "　／／ 字下げ", "URL は http://example", "%% 本文", "<!-- 本文 -->"],
  },
  {
    name: "新しい印（全部オン）",
    markers: ALL,
    lines: [
      "\\\\ 半角",
      "＼＼ 全角",
      "￥￥ 円記号",
      "%% 百分率",
      "　％％ 字下げ",
      "<!-- TODO 1行で閉じた囲み -->",
      "本文",
    ],
  },
  {
    name: "// を外して %% だけ",
    markers: memoMarkersOf(["percent"]),
    lines: ["// 本文の斜線", "%% メモ", "本文"],
  },
  {
    name: "複数行の囲み",
    markers: memoMarkersOf(["comment"]),
    lines: ["本文", "<!-- 伏線 港の灯", "続き", "終わり -->", "本文"],
  },
  {
    name: "--> のあとに字（閉じ忘れと同じ扱い）",
    markers: memoMarkersOf(["comment", "slash"]),
    lines: ["<!-- メモ", "--> ここから本文", "<!-- 二 -->", "// これは付箋"],
  },
  {
    name: "閉じ忘れ",
    markers: memoMarkersOf(["comment"]),
    lines: ["本文", "<!-- 閉じていない", "本文のまま"],
  },
];
