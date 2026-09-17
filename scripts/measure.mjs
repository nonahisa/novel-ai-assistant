// AIの出来を、手で数えずに測る（設計書6.87.15 の柱3）。
//
//   node scripts/measure.mjs <feature> [--work <作品フォルダー>] --model <モデル>
//                            [--repeat N] [--num-ctx 32768] [--endpoint URL]
//                            [--compare <前回のJSON>] [--out docs/measurements]
//
// **製品と同じ経路を通す**（`runner: "ollama"` で `<feature>.run`）。
// `prompt` だけ呼んで `validate` を飛ばす測り方は、**製品に無い不具合を
// 見つけたことになる**（CLAUDE.md の「繰り返し起きた失敗」5）。
//
// **数えるのは `measureScoring.mjs`**（純粋関数）。ここは束を起こして
// 返り値を集め、置き場所を決めて、日本語で並べるだけである。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { connect, REPO_ROOT } from "./mcpClient.mjs";
import {
  FILE_TARGET_FEATURES,
  assertFeature,
  assertToolRegistered,
  formatCompareLines,
  formatSpreadLines,
  measurementFileName,
  metricsOfRun,
  pickFreeName,
  promptToolOf,
  resultsOfResponse,
  spreadOfRuns,
  toolNameOf,
} from "./measureScoring.mjs";

/** 接続元の名乗り。**許可の印もこの名前で置く** */
const CLIENT_NAME = "measure";

/** 読み込む長さの既定。**必ず明示する**（CLAUDE.md 規則6） */
const DEFAULT_NUM_CTX = 32768;

/** 本文として読むもの（`models/types.ts` の `SUPPORTED_EXTENSIONS`） */
const BODY_EXTENSIONS = [".txt", ".md"];
/** 本文の置き場所（`models/types.ts` の `DEFAULT_MANUSCRIPT_DIR`） */
const MANUSCRIPT_DIR = "本文";
/** 許可の印の置き場所（`models/types.ts` の `AIWRITER_DIR`） */
const AIWRITER_DIR = ".aiwriter";
const PERMISSION_FILE = "external-access.json";

/* ── 引数 ─────────────────────────────────────────────── */

function parseArgs(argv) {
  const feature = argv[0];
  if (!feature || feature.startsWith("--")) {
    throw new Error(
      "feature を最初に指定してください（例: node scripts/measure.mjs proofread --model gemma4:12b）。"
    );
  }
  const options = {
    feature,
    work: null,
    model: null,
    repeat: 1,
    numCtx: DEFAULT_NUM_CTX,
    endpoint: null,
    compare: null,
    out: path.join(REPO_ROOT, "docs", "measurements"),
  };
  for (let at = 1; at < argv.length; at += 1) {
    const flag = argv[at];
    const value = argv[at + 1];
    const needsValue = () => {
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} には値が要ります。`);
      }
      at += 1;
      return value;
    };
    switch (flag) {
      case "--work":
        options.work = path.resolve(needsValue());
        break;
      case "--model":
        options.model = needsValue();
        break;
      case "--repeat":
        options.repeat = Number(needsValue());
        break;
      case "--num-ctx":
        options.numCtx = Number(needsValue());
        break;
      case "--endpoint":
        options.endpoint = needsValue();
        break;
      case "--compare":
        options.compare = path.resolve(needsValue());
        break;
      case "--out":
        options.out = path.resolve(needsValue());
        break;
      default:
        throw new Error(`知らない指定です: ${flag}`);
    }
  }
  if (!options.model) throw new Error("--model を指定してください。");
  if (!Number.isInteger(options.repeat) || options.repeat < 1) {
    throw new Error("--repeat は1以上の整数です。");
  }
  if (!Number.isInteger(options.numCtx) || options.numCtx < 1) {
    throw new Error("--num-ctx は1以上の整数です。");
  }
  return options;
}

/* ── 作品の写し ───────────────────────────────────────── */

/**
 * 作品を一時フォルダーへ写す。
 *
 * **元の台にも作者の作品にも触らない**（スキル `field-check`）。許可の印は
 * 拡張機能が書くものなので、**測定の都合でリポジトリの中へ置かない**。
 * 写しなら、印を置いても測定が終われば消える。
 */
function copyWorkToTemp(source) {
  if (!fs.existsSync(source)) {
    throw new Error(`作品フォルダーが見つかりません: ${source}`);
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "novelai-measure-"));
  const work = path.join(temp, path.basename(source) || "work");
  fs.cpSync(source, work, {
    recursive: true,
    // **持ち込まないもの**——履歴と、元の作品に付いていたかもしれない許可の印。
    // 印は必ずこちらで置き直す（元の印のまま測ると、何を許して測ったのか
    // 分からなくなる）
    filter: (from) => {
      const name = path.basename(from);
      return name !== ".git" && name !== AIWRITER_DIR && name !== "node_modules";
    },
  });
  return { temp, work };
}

/**
 * 許可の印を置く（`core/externalAccessPermission.ts` の形）。
 *
 * **接続元ごと・道具ごと。** 測定で使う道具だけを許す——ここで `"*"` を
 * 置くと、測定の台が「全部許した作品」の見本になってしまう。
 */
function writePermission(work, tools) {
  const dir = path.join(work, AIWRITER_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const body = {
    _説明:
      "測定（scripts/measure.mjs）が一時フォルダーへ置いた印です。" +
      "測定が終わるとフォルダーごと消えます。",
    clients: [
      {
        name: CLIENT_NAME,
        tools,
        sampling: false,
        decidedAt: new Date().toISOString(),
        decidedOn: os.hostname(),
        note: "scripts/measure.mjs が置いた（測定用の写し）",
      },
    ],
  };
  fs.writeFileSync(
    path.join(dir, PERMISSION_FILE),
    `${JSON.stringify(body, null, 2)}\n`,
    "utf8"
  );
}

/**
 * 本文のファイルを並べる（`mcp/tools/shared.ts` の `listBodyFiles` と同じ切り方）。
 *
 * **束へは訊かない。** 訊くには `work.scan` の許可が要り、測る道具以外を
 * 許すことになる——写しを自分で数えれば、許可は測る道具だけで済む。
 */
function listBodyFiles(work) {
  const manuscripts = path.join(work, MANUSCRIPT_DIR);
  const dir = fs.existsSync(manuscripts) ? manuscripts : work;
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) =>
      BODY_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))
    )
    .sort((a, b) => a.localeCompare(b, "ja"))
    .map((name) => path.relative(work, path.join(dir, name)));
}

/* ── 呼び方を、道具の入力の形から決める ─────────────────── */

/**
 * その道具に渡す引数を組む。
 *
 * **入力の形は束に訊く**（`tools/list` の `inputSchema`）。台本の中に
 * 「この道具は filePath が要る」と書き写すと、**道具のほうが変わったときに
 * 黙って古い呼び方をし続ける**。
 *
 * 埋められない必須の項目があれば、**そこで止める**——適当な値を入れて
 * 回すと、測ったつもりで別のものを測ることになる。
 */
function planCalls(schema, context) {
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const base = {};
  if ("folder" in properties) base.folder = context.work;
  if ("feature" in properties) base.feature = context.feature;
  if ("numCtx" in properties) base.numCtx = context.numCtx;
  if ("runner" in properties) base.runner = "ollama";
  if ("model" in properties) base.model = context.model;
  if ("endpoint" in properties && context.endpoint) {
    base.endpoint = context.endpoint;
  }

  // 埋められる名前。**optional は埋めなくてよい**ので、必須だけを見る
  const fillable = new Set([
    ...Object.keys(base),
    "filePath",
    "chunkIndex",
    "allowRemote",
    "options",
  ]);
  const missing = [...required].filter((name) => !fillable.has(name));
  if (missing.length > 0) {
    throw new Error(
      `この道具は ${missing.join("・")} が要るので、いまの台本では回せません` +
        "（measure.mjs の planCalls に、この項目の埋め方を足してください）。"
    );
  }

  /*
    **話ごとに回すかは feature で決める**（0.66.7）。道具を束ねたので、
    `filePath` はどの feature でも受け取れる形になった——形だけを見て
    「渡せるなら話数ぶん回す」とすると、**作品ぜんたいを1回見る機能
    （紹介文・章立てなど）を話数ぶん回す**ことになる。
  */
  if (!FILE_TARGET_FEATURES.includes(context.feature)) {
    return [{ label: "（作品ぜんたい）", args: base }];
  }
  if (!("filePath" in properties)) return [{ label: "（作品ぜんたい）", args: base }];

  const files = listBodyFiles(context.work);
  if (files.length === 0) {
    throw new Error(`本文が1つもありません: ${context.work}`);
  }
  return files.map((filePath) => ({
    label: filePath,
    args: { ...base, filePath },
  }));
}

/* ── 1回ぶん回す ──────────────────────────────────────── */

/**
 * チャンクは全部回す（`chunkIndex` を渡さない）。
 *
 * **1件失敗しても止めない**（製品と同じ）。理由を `failures` に残して次の
 * ファイルへ進む——ここで止めると、1話目のモデル落ちだけで測定が丸ごと消える。
 */
async function runOnce(client, toolName, calls) {
  const startedAt = Date.now();
  const raw = [];
  const results = [];
  const failures = [];
  /*
    **回している最中に古くなることがある。** 並行して版を上げてビルドし直すと、
    始めたときは新しかった束が途中から古くなる（2026-09-18 に実際に起きた）。
    **始めに1回訊いただけの答えを記録に残すと、嘘になる。**
  */
  let staleNote = null;
  for (const call of calls) {
    try {
      const value = await client.call(toolName, call.args);
      raw.push({ target: call.label, response: value });
      /*
        **返り値の形は道具によって2つある**（`measureScoring.mjs` の
        `resultsOfResponse`）。話まるごとを1回で見る道具（逸脱・各話あらすじ）は
        `results[]` ではなく `result` を1つ返すので、ここで `results[]` だけを
        拾っていたときは**何件出ても0件として記録していた**。
      */
      for (const item of resultsOfResponse(value, call.label)) results.push(item);
      for (const item of value?.failures ?? []) failures.push(item);
      if (value?.bundleStale === true) {
        // **見つけたら黙らない。** 古い束のまま測ると、直したはずのものを測る
        staleNote ??= value.note?.split("\n")[0] ?? "束が古いようです";
        console.warn(`  ※ ${staleNote}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      raw.push({ target: call.label, error: reason });
      failures.push({ chunkId: call.label, reason });
    }
  }
  return { elapsedMs: Date.now() - startedAt, raw, results, failures, staleNote };
}

/* ── 本体 ─────────────────────────────────────────────── */

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  assertFeature(options.feature);
  const toolName = toolNameOf(options.feature);
  // **表に書いた名前が、本当に登録されているか**を束のもとで確かめる
  assertToolRegistered(
    fs.readFileSync(path.join(REPO_ROOT, "src", "mcp", "server.ts"), "utf8"),
    toolName
  );
  const promptTool = promptToolOf(toolName);

  const source =
    options.work ??
    path.join(REPO_ROOT, "test", "fixtures", "seeded", options.feature);
  const answers = readJsonIfExists(path.join(source, "answers.json"));

  const { temp, work } = copyWorkToTemp(source);
  /*
    **許可の鍵は `feature`**（0.66.7、設計書6.87.15 の柱1）。道具の名前で
    置くと、いまの束はそれを鍵として見ないので**全部断られる**。
    測る feature だけを許す——ここで `"*"` を置くと、測定の台が
    「全部許した作品」の見本になってしまう。
  */
  writePermission(work, [options.feature]);

  let client = null;
  try {
    client = await connect({ clientName: CLIENT_NAME });

    const version = await client.call("mcp.version", {});
    const bundle = {
      name: version?.name ?? "",
      version: version?.version ?? "",
      stale: version?.bundle?.stale === true,
      reason: version?.bundle?.reason ?? null,
      /** 回している最中に古くなったか。回し終えてから埋める */
      staleDuringRun: null,
    };
    if (bundle.stale) {
      console.warn(`※ 束が古いようです（${bundle.reason ?? "理由不明"}）。`);
    }

    const tools = await client.listTools();
    const schema = tools.find((tool) => tool.name === toolName)?.inputSchema;
    if (!schema) {
      throw new Error(`${toolName} が tools/list にありません。`);
    }
    const calls = planCalls(schema, {
      work,
      feature: options.feature,
      model: options.model,
      numCtx: options.numCtx,
      endpoint: options.endpoint,
    });

    // プロンプト版は束に訊く（`*.run` は返さない）。**訊けなければ空のまま残す**
    let promptVersion = null;
    if (promptTool && tools.some((tool) => tool.name === promptTool)) {
      try {
        const asked = await client.call(promptTool, calls[0].args);
        promptVersion = asked?.promptVersion ?? null;
      } catch (error) {
        promptVersion = `（訊けませんでした: ${error instanceof Error ? error.message : String(error)}）`;
      }
    }

    console.log(
      `${options.feature}（${toolName}）を ${options.model} で ${options.repeat} 回まわします` +
        `（num_ctx ${options.numCtx}、対象 ${calls.length} 件）。`
    );

    const runs = [];
    for (let round = 1; round <= options.repeat; round += 1) {
      console.log(`  ${round}回目…`);
      const run = await runOnce(client, toolName, calls);
      const scored = metricsOfRun(options.feature, answers, run);
      runs.push({
        round,
        elapsedMs: run.elapsedMs,
        // **その回のあいだに束が古くなっていたか**（始めの1回の答えでは足りない）
        staleNote: run.staleNote,
        metrics: scored.metrics,
        detail: scored.detail,
        // **生のまま残す。**「提案なし 3」の正体は、生の応答を見て初めて分かった
        raw: run.raw,
      });
    }

    bundle.staleDuringRun =
      runs.find((run) => run.staleNote)?.staleNote ?? null;

    const spread = spreadOfRuns(runs);
    const lines = formatSpreadLines(spread);

    const record = {
      measuredAt: new Date().toISOString(),
      feature: options.feature,
      tool: toolName,
      model: options.model,
      numCtx: options.numCtx,
      endpoint: options.endpoint,
      repeat: options.repeat,
      bundle,
      promptVersion,
      work: { source, targets: calls.map((call) => call.label) },
      answers: answers ? path.join(source, "answers.json") : null,
      runs,
      spread,
      lines,
    };

    fs.mkdirSync(options.out, { recursive: true });
    const fileName = pickFreeName(
      measurementFileName(today(), options.feature, options.model),
      (candidate) => fs.existsSync(path.join(options.out, candidate))
    );
    const target = path.join(options.out, fileName);
    fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    console.log("");
    for (const line of lines) console.log(line);

    if (options.compare) {
      const before = readJsonIfExists(options.compare);
      if (!before?.spread) {
        console.warn(`※ 前回の記録を読めませんでした: ${options.compare}`);
      } else {
        console.log("");
        console.log(`前（${path.basename(options.compare)}） → 後（${fileName}）`);
        for (const line of formatCompareLines(before.spread, spread)) {
          console.log(line);
        }
      }
    }

    console.log("");
    console.log(`記録: ${path.relative(REPO_ROOT, target)}`);
  } finally {
    client?.close();
    // **写しは必ず消す。** 許可の印を置いたフォルダーを残さない
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
