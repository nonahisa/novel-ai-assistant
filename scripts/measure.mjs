// AIの出来を、手で数えずに測る（設計書6.87.15 の柱3）。
//
//   node scripts/measure.mjs <feature> [--work <作品フォルダー>] --model <モデル>
//                            [--runner ollama|sakura]
//                            [--repeat N] [--num-ctx 32768] [--endpoint URL]
//                            [--timeout 180]
//                            [--compare <前回のJSON>] [--out docs/measurements]
//                            [--option 名前=値 ...]
//
// **製品と同じ経路を通す。** 行き先は2つある。
//   - `--runner ollama`（既定）：`novel.run` が検算まで通す（1段）
//   - `--runner sakura`：`novel.prompt` → こちらから さくらへ投げる →
//     `novel.validate`（3段。MCP の `claude` 経路と同じ形）
// どちらも**製品の検算を通る**。`prompt` だけ呼んで `validate` を飛ばす
// 測り方は、**製品に無い不具合を見つけたことになる**（CLAUDE.md の
// 「繰り返し起きた失敗」5）。
//
// **さくらの鍵は環境変数 `SAKURA_AI_ACCOUNT_TOKEN` からだけ読む**
// （引数でもファイルでも対話でも受け取らない）。**記録にもログにも出さない。**
//
// **数えるのは `measureScoring.mjs`**（純粋関数）。ここは束を起こして
// 返り値を集め、置き場所を決めて、日本語で並べるだけである。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { connect, REPO_ROOT } from "./mcpClient.mjs";
import {
  FILE_TARGET_FEATURES,
  PROMPT_TOOL,
  VALIDATE_TOOL,
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
import {
  DEFAULT_SAKURA_TIMEOUT_MS,
  SAKURA_ENDPOINT,
  askSakura,
  readSakuraToken,
  runSakuraChunks,
} from "./measureSakura.mjs";

/**
 * 測れる行き先。
 *
 * **`sakura` を束（製品）の `runner` に足したのではない。** 製品の `runner` は
 * `ollama`／`claude`／`sampling` のままで、これは**測定の台本が3段を
 * 自分で回す**ための名前である。
 */
const RUNNERS = ["ollama", "sakura"];

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
    // **既定は今までどおり手元の Ollama。** クラウドは課金されるので、
    // 指定しないかぎり外へ出さない
    runner: "ollama",
    repeat: 1,
    numCtx: DEFAULT_NUM_CTX,
    endpoint: null,
    /** さくらへ1チャンク投げたときに待つミリ秒（`--timeout` は秒で受ける） */
    timeoutMs: DEFAULT_SAKURA_TIMEOUT_MS,
    compare: null,
    out: path.join(REPO_ROOT, "docs", "measurements"),
    // feature ごとの追加の指定（`novel.run` の `options`）。**空なら渡さない**
    options: {},
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
      case "--runner":
        options.runner = needsValue();
        break;
      case "--timeout":
        // **秒で受けて、ミリ秒で持つ。** 作者が打つのは秒である
        options.timeoutMs = Number(needsValue()) * 1000;
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
      /*
        **`--option 名前=値` を繰り返す形にしてある**（JSON をまるごと渡さない）。
        PowerShell から JSON を渡すと引用符の扱いで壊れやすく、しかも壊れたことに
        気づかないまま「既定で測った」記録が残る（スキル `shell-safety`）。
        いま要るのは `categories=light|all` のような短い値だけなので、
        **値は文字列のまま**渡す——形の検証は束の `options` が行う。
      */
      case "--option": {
        const pair = needsValue();
        const at = pair.indexOf("=");
        if (at <= 0) {
          throw new Error(`--option は 名前=値 の形で指定してください: ${pair}`);
        }
        options.options[pair.slice(0, at)] = pair.slice(at + 1);
        break;
      }
      default:
        throw new Error(`知らない指定です: ${flag}`);
    }
  }
  if (!options.model) throw new Error("--model を指定してください。");
  if (!RUNNERS.includes(options.runner)) {
    throw new Error(
      `知らない --runner です: ${options.runner}（選べるのは ${RUNNERS.join("・")}）`
    );
  }
  if (!Number.isInteger(options.repeat) || options.repeat < 1) {
    throw new Error("--repeat は1以上の整数です。");
  }
  if (!Number.isInteger(options.numCtx) || options.numCtx < 1) {
    throw new Error("--num-ctx は1以上の整数です。");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) {
    throw new Error("--timeout は1以上の秒数です。");
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
  /*
    **束へ渡す `runner` は、測定の `--runner` とは別物である。**
    `--runner sakura` のときは `novel.prompt`／`novel.validate` を呼ぶので、
    束へ渡す行き先は無い（`bundleRunner` は null）。ここで既定の "ollama" を
    埋めると、**さくらで測ったつもりで手元の Ollama が回る。**
  */
  if ("runner" in properties && context.bundleRunner) {
    base.runner = context.bundleRunner;
    if ("model" in properties) base.model = context.model;
    if ("endpoint" in properties && context.endpoint) {
      base.endpoint = context.endpoint;
    }
  }
  // **空なら渡さない。** `options: {}` を渡すと、記録の上では
  // 「何か指定して測った」ように見える
  if ("options" in properties && Object.keys(context.options ?? {}).length > 0) {
    base.options = context.options;
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
async function runOnce(calls, ask) {
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
      const outcome = await ask(call);
      for (const item of outcome.raw ?? []) raw.push(item);
      for (const item of outcome.results ?? []) results.push(item);
      for (const item of outcome.failures ?? []) failures.push(item);
      if (outcome.staleNote) {
        // **見つけたら黙らない。** 古い束のまま測ると、直したはずのものを測る
        staleNote ??= outcome.staleNote;
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

/** 束が「古い」と言っていたら、その1行だけを取り出す */
function staleNoteOf(value) {
  if (value?.bundleStale !== true) return null;
  return value.note?.split("\n")[0] ?? "束が古いようです";
}

/**
 * 手元の Ollama で回す（1段）。**検算は束の中で通る。**
 */
function askByRun(client, toolName) {
  return async (call) => {
    const value = await client.call(toolName, call.args);
    return {
      raw: [{ target: call.label, response: value }],
      /*
        **返り値の形は道具によって2つある**（`measureScoring.mjs` の
        `resultsOfResponse`）。話まるごとを1回で見る道具（逸脱・各話あらすじ）は
        `results[]` ではなく `result` を1つ返すので、ここで `results[]` だけを
        拾っていたときは**何件出ても0件として記録していた**。
      */
      results: resultsOfResponse(value, call.label),
      failures: value?.failures ?? [],
      staleNote: staleNoteOf(value),
    };
  };
}

/**
 * さくらのAI（クラウド）で回す（3段）。
 *
 * `novel.prompt` → こちらから さくらへ投げる → `novel.validate`。
 * **チャンクごとに投げる**（推敲は話ごとにチャンクへ切れる）ので、
 * 1チャンクの失敗では止まらない——理由は `failures` に残る。
 *
 * **鍵はここで受け取ったものを、`Authorization` ヘッダへ渡すだけ。**
 * 記録（`raw`）へ入るのは、プロンプトの応答と検算の結果だけである。
 */
function askBySakura(client, options, token) {
  return async (call) => {
    const promptResponse = await client.call(PROMPT_TOOL, call.args);
    const outcome = await runSakuraChunks({
      promptResponse,
      baseArgs: call.args,
      // **`token` などを後ろに置く。** 前に置くと、呼ぶ側の指定で
      // 鍵や宛先が差し替えられる形になる
      ask: (params) =>
        askSakura({
          ...params,
          token,
          model: options.model,
          endpoint: options.endpoint ?? SAKURA_ENDPOINT,
          timeoutMs: options.timeoutMs,
          log: (line) => console.log(`    ${line}`),
        }),
      validate: (args) => client.call(VALIDATE_TOOL, args),
      log: (line) => console.warn(line),
    });
    return {
      raw: [{ target: call.label, chunks: outcome.raw }],
      results: outcome.results,
      failures: outcome.failures,
      staleNote: staleNoteOf(promptResponse),
    };
  };
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
  const sakura = options.runner === "sakura";
  const toolName = toolNameOf(options.feature);
  /*
    **どの道具の形で引数を組むかは、行き先で変わる。**
    Ollama は `novel.run` の1本、さくらは `novel.prompt` → `novel.validate`。
    引数の形は**呼ぶ道具に訊く**（台本の中に書き写さない）。
  */
  const planTool = sakura ? PROMPT_TOOL : toolName;
  const serverSource = fs.readFileSync(
    path.join(REPO_ROOT, "src", "mcp", "server.ts"),
    "utf8"
  );
  // **表に書いた名前が、本当に登録されているか**を束のもとで確かめる
  for (const name of sakura ? [PROMPT_TOOL, VALIDATE_TOOL] : [toolName]) {
    assertToolRegistered(serverSource, name);
  }
  const promptTool = promptToolOf(toolName);

  /*
    **鍵が無ければ、測らずに止める**（作者へ尋ねない）。ここで止めるのは、
    作品を写す前・束を起こす前である——鍵が無いと分かっているのに
    一時フォルダーを作って許可の印を置く意味は無い。
  */
  const sakuraToken = sakura ? readSakuraToken() : null;

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
    const schema = tools.find((tool) => tool.name === planTool)?.inputSchema;
    if (!schema) {
      throw new Error(`${planTool} が tools/list にありません。`);
    }
    const calls = planCalls(schema, {
      work,
      feature: options.feature,
      model: options.model,
      numCtx: options.numCtx,
      endpoint: options.endpoint,
      options: options.options,
      // さくらのときは、束へ渡す行き先が無い（3段をこちらで回す）
      bundleRunner: sakura ? null : "ollama",
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

    const endpoint = sakura
      ? (options.endpoint ?? SAKURA_ENDPOINT)
      : options.endpoint;
    const route = sakura
      ? `${PROMPT_TOOL} → さくらのAI → ${VALIDATE_TOOL}`
      : toolName;
    console.log(
      `${options.feature}（${route}）を ${options.model} で ${options.repeat} 回まわします` +
        `（num_ctx ${options.numCtx}、対象 ${calls.length} 件）。`
    );
    if (sakura) {
      // **鍵は出さない。** 宛先と待ち時間だけを断る（課金の目安になる）
      console.log(
        `  宛先 ${endpoint}（1チャンクあたり ${Math.round(options.timeoutMs / 1000)}秒まで待ちます）。`
      );
    }

    const ask = sakura
      ? askBySakura(client, { ...options, endpoint }, sakuraToken)
      : askByRun(client, toolName);

    const runs = [];
    for (let round = 1; round <= options.repeat; round += 1) {
      console.log(`  ${round}回目…`);
      const run = await runOnce(calls, ask);
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
      /*
        **どの経路で測ったかを残す**（あとから数字だけを見ても分かるように）。
        `runner` が違えば、通った道具も、原稿の行き先も違う。
        **`endpoint` は書くが、鍵は書かない**（`Authorization` はここへ来ない）。
      */
      runner: options.runner,
      tool: sakura ? `${PROMPT_TOOL} → ${VALIDATE_TOOL}` : toolName,
      model: options.model,
      numCtx: options.numCtx,
      endpoint,
      // **何を指定して測ったかを残す。** 同じ日に `categories` を変えて
      // 2度回すと、記録は `-2.json` になるだけで中身の違いが読めない
      options: options.options,
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
