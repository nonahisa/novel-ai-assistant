import type { ChapterSynopsis } from "../models/synopsis";

/**
 * 感情曲線グラフ（作者の要望、2026-08-15）。
 *
 * 各話の盛り上がりと明暗を、紹介文と各話あらすじの間に図として置く。
 * 話数順に並べたときの**起伏の形**を見るためのもので、
 * 「第7話は8点」という絶対値として読むものではない。
 * AIが返す数値は同じ話でも実行のたびに多少変わる。
 *
 * **喜怒哀楽の4本は描かない。** 重ねるとどこが山なのか読み取れなくなる。
 * 主だった感情は話ごとの表に出す。
 *
 * **SVGと文字の両方を出す。** SVGはVS Codeのプレビューできれいに出るが、
 * 表示できない環境（GitHub上での閲覧など、インラインSVGを剥がすもの）が
 * ある。文字のグラフを併記しておけば、どこでも起伏は読める。
 *
 * VS Code APIに依存しない。
 */

/** 文字のグラフに使う縦棒。低いほうから高いほうへ */
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export interface EmotionPoint {
  chapter: number | null;
  label: string;
  intensity: number;
  valence: number;
  dominant: string | null;
  reason: string;
}

/** 感情値のある話だけを、話数順に取り出す */
export function collectEmotionPoints(
  episodes: readonly ChapterSynopsis[]
): EmotionPoint[] {
  return episodes
    .filter((episode) => episode.emotion !== null)
    .map((episode) => ({
      chapter: episode.chapter,
      label:
        episode.chapter !== null ? `第${episode.chapter}話` : episode.fileName,
      intensity: episode.emotion!.intensity,
      valence: episode.emotion!.valence,
      dominant: episode.emotion!.dominant,
      reason: episode.emotion!.reason,
    }));
}

/**
 * 感情曲線を Markdown として組み立てる。
 *
 * 感情値が1話ぶんも無ければ空文字を返す（節ごと出さない）。
 * 1話しか無いときも描かない。**点が1つでは曲線にならない。**
 */
export function buildEmotionCurveMarkdown(
  episodes: readonly ChapterSynopsis[]
): string {
  const points = collectEmotionPoints(episodes);
  if (points.length < 2) return "";

  const lines = [
    "## 感情曲線",
    "",
    "話数順に並べた起伏です。**数値そのものではなく、山と谷の形を見てください。**",
    "AIが測った目安なので、同じ話でも測り直すと多少変わります。",
    "縦軸は、実際に出ている幅へ合わせて引き伸ばしています（幅は図の右に書いています）。",
    "",
    buildSvg(points),
    "",
    "<!-- 図が表示されない場所のために、同じ内容を文字でも置いています -->",
    "```",
    ...buildTextChart(points),
    "```",
    "",
    ...buildTable(points),
  ];

  return lines.join("\n");
}

/**
 * 文字のグラフ。どこでも読める。
 *
 * **目盛りを0〜10に固定しない。** 感情値は1話ずつ独立に測るため、
 * 作品によっては5〜8のような狭い幅に固まる（実データで確認）。
 * 固定の目盛りだと縦棒がほぼ同じ高さになり、起伏が読み取れない。
 * 実際に出ている幅へ合わせて引き伸ばし、**その幅を横に明記する**。
 * 明記しないと「0〜10の中での高さ」と誤解される。
 */
function buildTextChart(points: EmotionPoint[]): string[] {
  const intensity = drawSeries(points.map((point) => point.intensity));
  const valence = drawSeries(points.map((point) => point.valence), true);

  return [
    `盛り上がり ${intensity.bars}  (${intensity.range})`,
    `明暗       ${valence.bars}  (${valence.range})`,
    `           ${buildAxis(points)}`,
  ];
}

/** 実際に出ている幅へ合わせて縦棒にする。幅が無いときは中央で揃える */
function drawSeries(
  values: number[],
  signedRange = false
): { bars: string; range: string } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const label = signedRange
    ? `${signed(min)}〜${signed(max)}`
    : `${min}〜${max}`;

  if (min === max) {
    // 全話が同じ値。引き伸ばすと0除算になるうえ、
    // 高低があるように見えてしまうので中ほどで揃える
    return { bars: BLOCKS[3].repeat(values.length), range: `${label}（一定）` };
  }

  const bars = values
    .map((value) => BLOCKS[scaleToBlock(value, min, max)])
    .join("");
  return { bars, range: label };
}

/**
 * 目盛り。話数が多いと全部は書けないので、5話ごとに印を置く。
 *
 * 文字のグラフは1話＝1文字なので、目盛りも1話＝1文字に揃える。
 * ずれると、どの山が何話か読み取れなくなる。
 */
function buildAxis(points: EmotionPoint[]): string {
  return points
    .map((point, index) => {
      if (index === 0 || index === points.length - 1) return "|";
      return point.chapter !== null && point.chapter % 5 === 0 ? "|" : "·";
    })
    .join("");
}

function scaleToBlock(value: number, min: number, max: number): number {
  const ratio = (value - min) / (max - min);
  const index = Math.round(ratio * (BLOCKS.length - 1));
  return Math.min(BLOCKS.length - 1, Math.max(0, index));
}

/** 話ごとの内訳。数値だけでは確かめようがないので、理由を添える */
function buildTable(points: EmotionPoint[]): string[] {
  const rows = points.map((point) => {
    const reason = point.reason.replace(/\|/g, "／").trim();
    return `| ${point.label} | ${point.intensity} | ${signed(point.valence)} | ${
      point.dominant ?? "—"
    } | ${reason || "—"} |`;
  });

  return [
    "| 話 | 盛り上がり | 明暗 | 主な感情 | 理由 |",
    "|---|---|---|---|---|",
    ...rows,
  ];
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

// ─── SVG ───

const WIDTH_PER_POINT = 34;
const MIN_WIDTH = 320;
const PLOT_HEIGHT = 120;
const PAD_LEFT = 44;
const PAD_RIGHT = 12;
const PAD_TOP = 14;
const PAD_BOTTOM = 26;

/**
 * SVGで2本の折れ線を描く。
 *
 * **色だけで区別しない。** 盛り上がりは実線、明暗は破線にする。
 * 印刷やモノクロ表示でも見分けられるようにするため。
 *
 * 文字色は `currentColor` を使う。VS Codeは明るいテーマと暗いテーマの
 * どちらでも使われるので、色を決め打ちすると片方で読めなくなる。
 */
function buildSvg(points: EmotionPoint[]): string {
  const width = Math.max(
    MIN_WIDTH,
    PAD_LEFT + PAD_RIGHT + (points.length - 1) * WIDTH_PER_POINT
  );
  const height = PAD_TOP + PLOT_HEIGHT + PAD_BOTTOM;
  const stepX =
    points.length > 1
      ? (width - PAD_LEFT - PAD_RIGHT) / (points.length - 1)
      : 0;

  const x = (index: number) => PAD_LEFT + index * stepX;
  const y = (value: number, min: number, max: number) =>
    min === max
      ? PAD_TOP + PLOT_HEIGHT / 2
      : PAD_TOP + PLOT_HEIGHT - ((value - min) / (max - min)) * PLOT_HEIGHT;

  // **実際に出ている幅へ合わせる。** 文字のグラフと同じ理由で、
  // 0〜10に固定すると起伏がつぶれて読み取れない
  const intensities = points.map((point) => point.intensity);
  const valences = points.map((point) => point.valence);
  const iMin = Math.min(...intensities);
  const iMax = Math.max(...intensities);
  const vMin = Math.min(...valences);
  const vMax = Math.max(...valences);

  const intensityPath = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${round(x(index))} ${round(y(point.intensity, iMin, iMax))}`)
    .join(" ");
  const valencePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${round(x(index))} ${round(y(point.valence, vMin, vMax))}`)
    .join(" ");

  // 明暗の0の位置。ここより下が「重い話」と読める。
  // 全話が0の側に寄っているときは線を引かない（軸の外になるため）
  const zeroY =
    vMin <= 0 && vMax >= 0 && vMin !== vMax ? round(y(0, vMin, vMax)) : null;

  const ticks = points
    .map((point, index) => {
      const show =
        index === 0 ||
        index === points.length - 1 ||
        (point.chapter !== null && point.chapter % 5 === 0);
      if (!show) return "";
      return `<text x="${round(x(index))}" y="${height - 8}" font-size="9" text-anchor="middle" fill="currentColor" opacity="0.7">${escapeXml(
        point.chapter !== null ? String(point.chapter) : "?"
      )}</text>`;
    })
    .filter(Boolean)
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="各話の盛り上がりと明暗の推移">`,
    zeroY === null
      ? ""
      : `<line x1="${PAD_LEFT}" y1="${zeroY}" x2="${width - PAD_RIGHT}" y2="${zeroY}" stroke="currentColor" stroke-width="1" opacity="0.25" />`,
    `<text x="4" y="${PAD_TOP + 8}" font-size="9" fill="currentColor" opacity="0.7">高</text>`,
    `<text x="4" y="${PAD_TOP + PLOT_HEIGHT}" font-size="9" fill="currentColor" opacity="0.7">低</text>`,
    `<path d="${intensityPath}" fill="none" stroke="currentColor" stroke-width="2" />`,
    `<path d="${valencePath}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.75" />`,
    ticks,
    `<text x="${PAD_LEFT}" y="${PAD_TOP - 4}" font-size="9" fill="currentColor" opacity="0.7">${escapeXml(
      `— 盛り上がり ${iMin}〜${iMax}　- - 明暗 ${signed(vMin)}〜${signed(vMax)}`
    )}</text>`,
    "</svg>",
  ].join("");
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
