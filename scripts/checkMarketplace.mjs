/*
  Marketplace に**いま出ている版**を読む。

  **外の状態を文書だけで判断しない**（CLAUDE.md の失敗4）。引継ぎ書が古くて
  「未公開」と報告した前例があるので、配る前後にはここで確かめる。

  読むのは**公開されている情報だけ**（拡張機能の名前を投げて、版と更新日時を
  受け取る）。鍵は要らないし、こちらから作品や原稿は1文字も送らない。

  使い方： node scripts/checkMarketplace.mjs
           node scripts/checkMarketplace.mjs --json
*/
const PUBLISHER = "nonahisa";
const NAME = "novel-ai-assistant";
const ENDPOINT =
  "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";

const body = {
  filters: [
    {
      criteria: [{ filterType: 7, value: `${PUBLISHER}.${NAME}` }],
      pageNumber: 1,
      pageSize: 1,
    },
  ],
  // 版・統計・最終更新が欲しいので、その分だけ立てる
  flags: 0x1 | 0x100 | 0x2,
};

const response = await fetch(ENDPOINT, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json;api-version=7.1-preview.1",
  },
  body: JSON.stringify(body),
});

if (!response.ok) {
  console.error(`× Marketplace が ${response.status} を返しました`);
  process.exit(1);
}

const data = await response.json();
const ext = data?.results?.[0]?.extensions?.[0];
if (!ext) {
  console.error("× その名前の拡張機能が見つかりません（未公開か、名前が違う）");
  process.exit(1);
}

const version = ext.versions?.[0]?.version ?? null;
const lastUpdated = ext.lastUpdated ?? ext.versions?.[0]?.lastUpdated ?? null;
const stat = (name) =>
  ext.statistics?.find((s) => s.statisticName === name)?.value ?? null;

const out = {
  version,
  lastUpdated,
  installs: stat("install"),
  averageRating: stat("averagerating"),
  ratingCount: stat("ratingcount"),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const when = lastUpdated
    ? new Date(lastUpdated).toLocaleString("ja-JP")
    : "（不明）";
  console.log(`Marketplace に出ている版: ${version ?? "（読めない）"}`);
  console.log(`最終更新: ${when}`);
  if (out.installs !== null) console.log(`入れた数: ${out.installs}`);
  if (out.ratingCount) console.log(`評価: ${out.averageRating}（${out.ratingCount}件）`);
}
