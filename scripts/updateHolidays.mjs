// 同梱する日本の祝日の一覧を取り直す（設計書6.111.12）。
//
//   npm run holidays            … 取り直して src/core/holidaysJpData.ts を書き直す
//   node scripts/updateHolidays.mjs --check
//                               … 取りに行かず、同梱の一覧が古くないかだけ見る（配布の前段）
//
// 出どころは holidays-jp（https://holidays-jp.github.io/）。Google カレンダーの
// 日本の祝日を元にした、去年・今年・来年の「日付 → 祝日名」の JSON である。
//
// **--check は落とさない。** 古いと言うだけで、配布は止めない（祝日の一覧が
// 半年古くても、スケジュールの逆算がずれるのは新しく決まった祝日の1日だけ）。
// 止めると、取りに行けない日（回線・サイトの休み）に配布ができなくなる。
//
// 生成物は TypeScript の形にしてある。JSON のまま import すると tsconfig に
// resolveJsonModule を足すことになり、束（拡張機能・ブラウザ版・MCP）の全部へ
// 影響が出るため。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOLIDAYS_URL = "https://holidays-jp.github.io/api/v1/date.json";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "src", "core", "holidaysJpData.ts");
/** 取得からこれより古ければ、取り直しを勧める */
const STALE_DAYS = 182;

function todayKey() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** 返ってきた JSON を確かめる。**形が違えば書かない**（壊れた一覧を同梱しない） */
function validate(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("祝日の一覧が、日付と名前の組になっていません");
  }
  const dates = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || typeof value !== "string" || !value.trim()) {
      throw new Error(`祝日の一覧に読めない行があります：${key}`);
    }
    dates[key] = value.trim();
  }
  const keys = Object.keys(dates).sort();
  if (keys.length < 30) throw new Error(`祝日が${keys.length}件しかありません（3年分なら50件ほど）`);
  const sorted = {};
  for (const key of keys) sorted[key] = dates[key];
  return sorted;
}

function render(dates, fetchedAt) {
  const lines = Object.entries(dates).map(
    ([date, name]) => `    ${JSON.stringify(date)}: ${JSON.stringify(name)},`
  );
  return [
    "import type { HolidaySet } from \"./holidays\";",
    "",
    "/**",
    " * 同梱の日本の祝日（設計書6.111.12）。**自動生成——手で直さない。**",
    " *",
    " * 取り直すときは `npm run holidays`（`scripts/updateHolidays.mjs`）。配布の前段",
    " * （`npm run package:vsix`）が、来年の分が無い・取得から半年を超えたら知らせる。",
    " */",
    "export const BUNDLED_HOLIDAYS: HolidaySet = {",
    `  source: ${JSON.stringify(HOLIDAYS_URL)},`,
    `  fetchedAt: ${JSON.stringify(fetchedAt)},`,
    "  dates: {",
    ...lines,
    "  },",
    "};",
    "",
  ].join("\n");
}

/** 同梱の一覧の取得日と、含む年。読めなければ null */
function readBundled() {
  let text;
  try {
    text = readFileSync(target, "utf8");
  } catch {
    return null;
  }
  const fetched = /fetchedAt:\s*"(\d{4}-\d{2}-\d{2})"/.exec(text);
  const years = new Set([...text.matchAll(/"(\d{4})-\d{2}-\d{2}":/g)].map((m) => Number(m[1])));
  return fetched ? { fetchedAt: fetched[1], years } : null;
}

function check() {
  const today = todayKey();
  const nextYear = Number(today.slice(0, 4)) + 1;
  const bundled = readBundled();
  const problems = [];
  if (!bundled) {
    problems.push(`同梱の祝日の一覧（${path.relative(root, target)}）を読めません`);
  } else {
    if (!bundled.years.has(nextYear)) problems.push(`来年（${nextYear}年）の祝日が入っていません`);
    const age = daysBetween(bundled.fetchedAt, today);
    if (age > STALE_DAYS) problems.push(`取得から${age}日たっています（${bundled.fetchedAt}）`);
  }
  if (problems.length === 0) {
    console.log(`祝日の一覧：新しい（取得 ${bundled.fetchedAt}）`);
    return;
  }
  const bar = "!".repeat(60);
  console.warn(
    [bar, "祝日の一覧が古くなっています：", ...problems.map((p) => `  ・${p}`), "  npm run holidays で取り直してから配布してください（配布は止めません）。", bar].join("\n")
  );
}

async function update() {
  const response = await fetch(HOLIDAYS_URL, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`祝日の一覧を取れませんでした（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  const dates = validate(JSON.parse(text));
  const fetchedAt = todayKey();
  writeFileSync(target, render(dates, fetchedAt), "utf8");
  const keys = Object.keys(dates);
  console.log(`祝日の一覧を書き直しました：${keys.length}件（${keys[0]}〜${keys[keys.length - 1]}、取得 ${fetchedAt}）`);
}

if (process.argv.includes("--check")) {
  check();
} else {
  update().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
