import { readFileSync, writeFileSync } from "node:fs";
import { collectPendingChecks, render, SOURCE, TARGET } from "./pendingChecksLib.mjs";

/**
 * 実機確認リストから、操作メニューの「テスト中」の中身を作り直す。
 *
 *     node scripts/pendingChecks.mjs          作り直す
 *     node scripts/pendingChecks.mjs --check  ずれていないか見るだけ
 */

const markdown = readFileSync(SOURCE, "utf8");
const generated = render(collectPendingChecks(markdown));

if (process.argv.includes("--check")) {
  if (readFileSync(TARGET, "utf8") !== generated) {
    console.error(
      `${TARGET} が ${SOURCE} とずれています。node scripts/pendingChecks.mjs で作り直してください。`
    );
    process.exit(1);
  }
  console.log("ずれはありません。");
} else {
  writeFileSync(TARGET, generated);
  console.log(
    `${TARGET} を作り直しました（${collectPendingChecks(markdown).length}節）。`
  );
}
