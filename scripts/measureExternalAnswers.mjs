/*
  **製品の外で作った答え**を、製品と同じ検算に通して数える。

  ローカルLLMの測定（`scripts/measure.mjs`）は「プロンプトを組んで、AIへ投げて、
  検算する」を一息でやるが、こちらは**投げる先が人（または会話の中のモデル）**
  である場合に使う。答えのJSONをファイルで受け取り、
  `novel.validate` → 採点（`measureScoring.mjs`）だけを行う。

  **プロンプトは `novel.prompt` が組んだものをそのまま使うこと。** ここで
  作り直すと、測っている条件が製品と違うものになる（CLAUDE.md の失敗5）。

  使い方：
    node scripts/measureExternalAnswers.mjs \
      --work test/fixtures/seeded/typo \
      --feature typo \
      --answers <answer-1.json…が入ったフォルダ> \
      --label claude-opus-5 \
      [--record docs/measurements/<名前>.json]

  `--answers` のフォルダには `answer-1.json`・`answer-2.json`… を、
  `novel.prompt` が返したチャンクの順に置く。
*/
import fs from "node:fs";
import path from "node:path";
import { connect } from "./mcpClient.mjs";
import { scoreTypo, scoreSettings } from "./measureScoring.mjs";

function parseArgs(argv) {
  const out = {};
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[at + 1];
    out[key] = next && !next.startsWith("--") ? next : true;
    if (out[key] !== true) at += 1;
  }
  return out;
}

const SCORERS = { typo: scoreTypo, settings: scoreSettings };

const args = parseArgs(process.argv.slice(2));
const work = path.resolve(args.work ?? "");
const feature = String(args.feature ?? "");
const answersDir = path.resolve(args.answers ?? "");
const label = String(args.label ?? "外部の答え");

if (!work || !feature || !answersDir) {
  console.error("--work・--feature・--answers は必ず指定してください");
  process.exit(1);
}
const score = SCORERS[feature];
if (!score) {
  console.error(
    "この機能の数え方がありません: " + feature + "（使えるのは " + Object.keys(SCORERS).join("・") + "）"
  );
  process.exit(1);
}

const mcp = await connect({ clientName: "claude-code", timeoutMs: 120_000 });
const scan = await mcp.call("novel.scan", { folder: work });
const files = scan.episodes.filter((e) => e.chapter).map((e) => e.filePath);

// **プロンプトは製品に組ませる。** チャンクの切れ目も順番も製品の答えを使う
const chunks = [];
for (const filePath of files) {
  const prompt = await mcp.call("novel.prompt", {
    folder: work,
    feature,
    filePath,
    numCtx: Number(args.numCtx ?? 16384),
  });
  for (const chunk of prompt.chunks) {
    chunks.push({ filePath, chunkId: chunk.chunkId, chars: chunk.chars });
  }
}

const results = [];
const raw = [];
for (let at = 0; at < chunks.length; at += 1) {
  const chunk = chunks[at];
  const file = path.join(answersDir, "answer-" + (at + 1) + ".json");
  if (!fs.existsSync(file)) {
    console.log("× " + chunk.chunkId + "：答えのファイルがありません（" + file + "）");
    continue;
  }
  const response = fs.readFileSync(file, "utf8");
  const validated = await mcp.call("novel.validate", {
    folder: work,
    feature,
    filePath: chunk.filePath,
    chunkId: chunk.chunkId,
    response,
  });
  results.push({ chunkId: chunk.chunkId, ...validated });
  raw.push({ target: chunk.chunkId, aiText: response, validated });
  const accepted = validated?.accepted?.length ?? 0;
  const rejected = validated?.rejected?.length ?? 0;
  console.log("  " + chunk.chunkId + "  通った" + accepted + "件 / 弾かれた" + rejected + "件");
  for (const item of validated?.rejected ?? []) {
    console.log("    × " + (item.reason ?? "") + " " + JSON.stringify(item.issue ?? item));
  }
}
mcp.close();

const answers = JSON.parse(fs.readFileSync(path.join(work, "answers.json"), "utf8"));
const scored = score(answers, results);

console.log("\n=== " + label + " ===");
if (feature === "typo") {
  console.log("拾えた: " + scored.seeds.found + "/" + scored.seeds.total);
  console.log("誤検出（罠を直してしまった）: " + scored.falsePositives.count);
  console.log("直し方が違う（場所は当てた）: " + scored.wrongFix.count);
  console.log("仕込み以外の指摘: " + scored.otherFlags);
  for (const miss of scored.missed) {
    console.log("  見逃し: " + miss.kind + "「" + miss.wrong + "」— " + miss.note);
  }
  for (const item of scored.falsePositives.items) {
    console.log("  誤検出: " + item.kind + "「" + item.word + "」→「" + item.suggestion + "」");
  }
} else {
  console.log(JSON.stringify(scored, null, 2));
}

if (typeof args.record === "string") {
  const record = {
    measuredAt: new Date().toISOString(),
    feature,
    runner: "external",
    tool: "novel.prompt → 外で答える → novel.validate",
    model: label,
    numCtx: Number(args.numCtx ?? 16384),
    work: { source: work, targets: files },
    answers: path.join(work, "answers.json"),
    plans: chunks,
    runs: [{ round: 1, scored, raw }],
  };
  fs.mkdirSync(path.dirname(args.record), { recursive: true });
  fs.writeFileSync(args.record, JSON.stringify(record, null, 1), "utf8");
  console.log("\n記録: " + args.record);
}
