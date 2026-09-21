import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { countEpisodeChars } from "../../src/core/episodeCharCount";
import type { DeviceWritingStats, WritingBaseline } from "../../src/models/writingStats";

/**
 * 字数の数え方を、**作者の実データ**で留める。
 *
 * **書き込みは一切しない。** 製品が書いた台帳
 * （`<作品>/.aiwriter/stats/<端末>.json` の `baseline`）と、
 * いま数え直した結果が合うかだけを見る。
 *
 *   $env:NOVELAI_WORKS = "C:/path/to/作品を集めたフォルダー"
 *   npx vitest run --config vitest.live.config.mts test/live/charCountAcrossWorks.test.ts
 *
 * **期待値をここへ書かない。** `701638` のような数字を焼き込むと、
 * 作者が1字書き足すたびに試験を直すことになる。台帳と突き合わせる形なら、
 * 作品が増えても書き換えが要らない。
 *
 * **数え方をここで作り直さない。** 製品の関数（`countEpisodeChars` /
 * `countChars`）をそのまま呼ぶ。写しを置くと、製品が壊れたときに
 * 試験も同じように壊れて、合ってしまう。
 */
const ROOT = process.env.NOVELAI_WORKS?.trim();

/**
 * 設定「ルビを文字数から外す」の既定値（`package.json` の
 * `novelai.countSettings.excludeRubyFromCount`）。台帳はこの既定で
 * 測られている。
 */
const EXCLUDE_RUBY = true;

/**
 * 走査（`core/scanner.ts` の `decodeText`）と同じ読み方をする。
 *
 * **これは文字コードの判定であって、数え方ではない。** 数え方は
 * 製品の関数にだけ置く。`decodeText` は export されていないので、
 * ここに同じ順序（BOM付きUTF-8 → UTF-8 → Shift_JIS）を置く。
 */
function decodeText(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/**
 * その作品の台帳から、**いちばん新しく測った基準**を選ぶ。
 *
 * 台帳は端末ごとに1ファイルある（設計書5.5.6）。別の端末の基準は
 * 測った時点が古く、今のファイルとは合わない。ファイル別の内訳を
 * 持たない古い記録も使えないので、そこは除く。
 */
function newestBaseline(
  statsDir: string
): { deviceId: string; baseline: WritingBaseline } | null {
  let best: { deviceId: string; baseline: WritingBaseline } | null = null;
  for (const name of fs.readdirSync(statsDir)) {
    if (!name.endsWith(".json")) continue;
    let stats: DeviceWritingStats;
    try {
      stats = JSON.parse(fs.readFileSync(path.join(statsDir, name), "utf-8"));
    } catch {
      continue; // 壊れた台帳は直さず飛ばす（実装ルール2）
    }
    const baseline = stats.baseline;
    if (!baseline || !baseline.files) continue;
    if (!best || baseline.at > best.baseline.at) {
      best = { deviceId: stats.deviceId ?? name, baseline };
    }
  }
  return best;
}

describe.skipIf(!ROOT)("実データの字数を台帳と突き合わせる（読むだけ）", () => {
  test("作品ごとのファイル数と純文字数が、製品が書いた基準と一致する", () => {
    const works = fs
      .readdirSync(ROOT!, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(ROOT!, entry.name));

    const report: string[] = [];
    const problems: string[] = [];
    let checked = 0;

    for (const work of works) {
      const statsDir = path.join(work, ".aiwriter", "stats");
      // 台帳が無い作品は飛ばす（まだ一度も測っていない）
      if (!fs.existsSync(statsDir)) continue;
      const found = newestBaseline(statsDir);
      if (!found) continue;

      const { baseline } = found;
      const files = baseline.files!;
      const workName = path.basename(work);
      let net = 0;
      let gross = 0;
      let counted = 0;

      for (const [key, recorded] of Object.entries(files)) {
        const file = path.join(work, ...key.split("/"));
        if (!fs.existsSync(file)) {
          // 台帳を書いたあとで消された／名前が変わったファイル。
          // 数え方の話ではないので、合計から外して記録だけ残す
          problems.push(`${workName}/${key}: 台帳にあるがファイルが無い`);
          continue;
        }
        const text = decodeText(fs.readFileSync(file));
        const ext = path.extname(file).toLowerCase();
        const counts = countEpisodeChars(text, { ext, excludeRuby: EXCLUDE_RUBY });

        if (counts.net !== recorded.net || counts.gross !== recorded.gross) {
          problems.push(
            `${workName}/${key}: 純 ${counts.net}字（台帳 ${recorded.net}字・差 ${
              counts.net - recorded.net
            }字） 総 ${counts.gross}字（台帳 ${recorded.gross}字・差 ${
              counts.gross - recorded.gross
            }字）`
          );
        }
        net += counts.net;
        gross += counts.gross;
        counted++;
      }

      // 台帳の `fileCount` は競合を含む話も数えているが、内訳には載らない
      // （直った瞬間に「数万字書いた」ことになるため。`toMeasurement`）
      const expectedFileCount = baseline.fileCount - baseline.conflictedCount;
      if (counted !== expectedFileCount) {
        problems.push(
          `${workName}: ファイル数 ${counted}件（台帳 ${expectedFileCount}件）`
        );
      }
      if (net !== baseline.net) {
        problems.push(
          `${workName}: 純文字数の合計 ${net}字（台帳 ${baseline.net}字・差 ${
            net - baseline.net
          }字）`
        );
      }
      if (gross !== baseline.gross) {
        problems.push(
          `${workName}: 総文字数の合計 ${gross}字（台帳 ${baseline.gross}字・差 ${
            gross - baseline.gross
          }字）`
        );
      }

      report.push(
        `${workName}: ${counted}ファイル 純${net}字 総${gross}字` +
          `（台帳 ${baseline.at} / 端末 ${found.deviceId}）`
      );
      checked++;
    }

    console.log("\n" + report.join("\n"));
    expect(checked, "台帳のある作品が1つも見つからない").toBeGreaterThan(0);
    expect(problems.join("\n"), "台帳と食い違った").toBe("");
  });
});
