import { readFileSync, writeFileSync } from "node:fs";
import {
  collectPendingChecks,
  render,
  renderItems,
  ITEMS_TARGET,
  SOURCE,
  TARGET,
} from "./pendingChecksLib.mjs";

/**
 * 実機確認リストから、操作メニューの「テスト中」の中身を作り直す。
 *
 *     npm run checks:menu                     作り直す
 *     node scripts/pendingChecks.mjs --check  ずれていないか見るだけ
 *
 * 2つに分けて書き出す（`pendingChecksLib.mjs` の説明を参照）。
 * 件数は配布物へ入り、**項目の文章は入らない。**
 */

const markdown = readFileSync(SOURCE, "utf8");
const sections = collectPendingChecks(markdown);
const outputs = [
  [TARGET, render(sections)],
  [ITEMS_TARGET, renderItems(sections)],
];

if (process.argv.includes("--check")) {
  const stale = outputs.filter(([file, expected]) => {
    try {
      return readFileSync(file, "utf8") !== expected;
    } catch {
      return true;
    }
  });
  if (stale.length > 0) {
    console.error(
      `${stale
        .map(([file]) => file)
        .join("・")} が ${SOURCE} とずれています。npm run checks:menu で作り直してください。`
    );
    process.exit(1);
  }
  console.log("ずれはありません。");
} else {
  for (const [file, content] of outputs) writeFileSync(file, content);
  console.log(
    `${TARGET} と ${ITEMS_TARGET} を作り直しました（${sections.length}節）。`
  );
}
