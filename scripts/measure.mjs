// AIの出来を、手で数えずに測る（設計書6.87.15 の柱3）。
//
//   node scripts/measure.mjs <feature> [--work <作品フォルダー>] --model <モデル>
//                            [--runner ollama|sakura]
//                            [--repeat N] [--num-ctx <値>] [--endpoint URL]
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
// **`num_ctx` は決め打ちしない**（2026-09-19。CLAUDE.md 規則6）。製品と同じ道
// （`contextSizeForPrompt`）で、**送るプロンプトの長さから決める**
// ——詳しくは `scripts/measureNumCtx.mjs` の冒頭。`--num-ctx` を打てば
// その値で固定できる（VRAM に載る上限を探るときのため）。
//
// **測る前に空打ちして温める**（`ollama.generate`）。モデルの読み込みを
// 所要時間から外さないと、**最後に使ったモデルが有利**になる。温めに
// かかった時間は「温め」として別に出す。
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
  GENERATE_TOOL,
  MODELS_TOOL,
  PROMPT_TOOL,
  VALIDATE_TOOL,
  assertFeature,
  assertToolRegistered,
  fixtureDirOf,
  formatCompareLines,
  formatSpreadLines,
  maxIssuesPer1000CharsOf,
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
import {
  bundledCharsPerTokenSamples,
  decideNumCtx,
  loadContextSizeForPrompt,
  measuredOf,
  outputReserveTokens,
  promptCharsOf,
} from "./measureNumCtx.mjs";

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

/**
 * 1回の呼び出しで作品ぜんたいを通す feature。**長く待つ。**
 *
 * ここに書くのは「話数ぶんのAI呼び出しが、1回の `novel.run` の中で起きる」
 * ものだけである。話ごとに回す feature（`FILE_TARGET_FEATURES`）は
 * 1話ぶんずつ返ってくるので、既定の待ち時間で足りる。
 */
const WHOLE_WORK_FEATURES = ["factContradiction"];

/**
 * 本文を切るときの基準と、決められなかったときの受け皿。
 *
 * **これを `num_ctx` として送るのはやめた**（2026-09-19）。決め打ちの 32,768 は
 * 3話・約3,700字の台には5倍近く大きく、**製品では起きない VRAM の溢れ**を
 * 作っていた。いまは `measureNumCtx.mjs` が製品の関数で決める。
 *
 * ここに残っているのは2つの役目である。
 *
 * - **本文の切り方の基準**（`novel.prompt` / `novel.run` の `numCtx` は、
 *   送る長さと**チャンクの大きさ**を兼ねている）。まず この値で切って
 *   プロンプトを組み、その長さから `num_ctx` を決める
 * - クラウド（`--runner sakura`）の切り方。あちらへ `num_ctx` は送らない
 */
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
    // **既定は「決めない」。** 打たれたときだけ、その値で固定する
    numCtx: null,
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
  // **打たれたときだけ確かめる。** 打たれていなければ、ここでは決めない
  if (
    options.numCtx !== null &&
    (!Number.isInteger(options.numCtx) || options.numCtx < 1)
  ) {
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

/* ── 組ませて控える（AIは呼ばない） ───────────────────── */

/**
 * `novel.prompt` を対象ぶん呼んで、**版・枠・送る長さ**を控える。
 *
 * **AIは呼ばない**——プロンプトを組んで返すだけの道具である。控えるのは3つ。
 *
 * - `promptVersion` … 何版で測ったか（`novel.run` は返さない）
 * - `plans` … チャンクごとの字数と枠（点数の天井を知るため）
 * - `promptChars` … **いちばん長いプロンプトの字数**。`num_ctx` をここから
 *   決める（`measureNumCtx.mjs`）。決め打ちをやめた理由はそちらの冒頭
 */
async function collectPlans(client, promptTool, calls) {
  let promptVersion = null;
  let verifyPromptVersion = null;
  let promptChars = null;
  const plans = [];
  for (const call of calls) {
    try {
      const asked = await client.call(promptTool, call.args);
      promptVersion ??= asked?.promptVersion ?? null;
      verifyPromptVersion ??= asked?.verifyPromptVersion ?? null;
      const chars = promptCharsOf(asked);
      // **いちばん長いものに合わせる。** チャンクごとに `num_ctx` を変えると
      // Ollama がそのたびにモデルを読み込み直す（設計書6.53）
      if (chars !== null) promptChars = Math.max(promptChars ?? 0, chars);
      for (const chunk of asked?.chunks ?? []) {
        plans.push({
          chunkId: chunk?.chunkId ?? call.label,
          chars: chunk?.chars ?? null,
          maxIssues: chunk?.maxIssues ?? null,
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      promptVersion ??= `（訊けませんでした: ${reason}）`;
    }
  }
  return { promptVersion, verifyPromptVersion, plans, promptChars };
}

/**
 * モデルが申告する読める長さと、同梱の実測を訊く（`ollama.models`）。
 *
 * **モデル名から当てにいかない**（CLAUDE.md 規則6）。訊けなければ
 * 理由を添えて `null` を返す——ここで既定値を作ると、**何を根拠に
 * `num_ctx` を決めたのかが記録から消える。**
 */
async function askModelInfo(client, { model, endpoint }) {
  try {
    const listed = await client.call(MODELS_TOOL, endpoint ? { endpoint } : {});
    const found = (listed?.models ?? []).find((entry) => entry?.name === model);
    if (!found) {
      return {
        contextLength: null,
        bundled: null,
        note: `${model} は手元の一覧にありません`,
      };
    }
    return {
      contextLength: found.contextLength ?? null,
      bundled: found.bundled ?? null,
      note: null,
    };
  } catch (error) {
    return {
      contextLength: null,
      bundled: null,
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ── 温める ───────────────────────────────────────────── */

/*
  **測る前に空打ちする。** Ollama はモデルを使うときに読み込むので、
  直前に別のモデルを使っていると**1回目だけ読み込みぶん遅くなる**。
  2026-09-19 の比較では、26b は載ったままで165秒、12b は読み込みから
  始まって349秒——**最後に使ったモデルが有利**になっていた。

  **短く答えさせる。** 温めに要るのは「読み込まれること」だけで、
  長い応答は時間の無駄である。`num_ctx` は本番と同じ値を送る——違う値だと、
  本番の1回目でもう一度読み込み直しになる。
*/
const WARMUP_SYSTEM_PROMPT = "ひと言だけ、日本語で短く答えてください。";
const WARMUP_USER_PROMPT = "「はい」とだけ答えてください。";

async function warmUp(client, { model, endpoint, numCtx }) {
  const startedAt = Date.now();
  try {
    await client.call(GENERATE_TOOL, {
      model,
      numCtx,
      temperature: 0,
      ...(endpoint ? { endpoint } : {}),
      systemPrompt: WARMUP_SYSTEM_PROMPT,
      userPrompt: WARMUP_USER_PROMPT,
    });
    return { elapsedMs: Date.now() - startedAt, ok: true, reason: null };
  } catch (error) {
    // **温めに失敗しても測定は続ける。** 本番でも同じ失敗をするなら、
    // そちらは `failures` に残る——ここで止めると理由が1つ減る
    return {
      elapsedMs: Date.now() - startedAt,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
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
  // （手元の Ollama では、読める長さを訊く道具と温める道具も使う）
  for (const name of sakura
    ? [PROMPT_TOOL, VALIDATE_TOOL]
    : [toolName, MODELS_TOOL, GENERATE_TOOL]) {
    assertToolRegistered(serverSource, name);
  }
  const promptTool = promptToolOf(toolName);

  /*
    **鍵が無ければ、測らずに止める**（作者へ尋ねない）。ここで止めるのは、
    作品を写す前・束を起こす前である——鍵が無いと分かっているのに
    一時フォルダーを作って許可の印を置く意味は無い。
  */
  const sakuraToken = sakura ? readSakuraToken() : null;

  /*
    **台が feature と同じ名前とは限らない**（`fixtureDirOf`）。矛盾検知は
    古い道（P-12）と新しい道（事実の照合）で**同じ仕込みを使う**
    ——台を分けると、点差が道の違いなのか台の違いなのか読めなくなる。
  */
  const source =
    options.work ??
    path.join(
      REPO_ROOT,
      "test",
      "fixtures",
      "seeded",
      fixtureDirOf(options.feature)
    );
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
    /*
      **1回の `novel.run` で何段回すかは feature によって違う。**

      事実の照合（`factContradiction`）は、作品ぜんたいから事実を抜いて
      （話数ぶん）→ 機械で突き合わせ → 候補を1件ずつ確かめる、までを
      **1回の呼び出しの中**で通す。手元の12Bで5話の台でも30分を超える。
      既定（30分）のままだと、**答えが出る直前に打ち切って「応答が
      ありません」と記録される**——測れていないのに測った形で残る。
    */
    client = await connect({
      clientName: CLIENT_NAME,
      timeoutMs: WHOLE_WORK_FEATURES.includes(options.feature)
        ? 3 * 60 * 60 * 1000
        : undefined,
    });

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
    const buildCalls = (numCtx) =>
      planCalls(schema, {
        work,
        feature: options.feature,
        model: options.model,
        numCtx,
        endpoint: options.endpoint,
        options: options.options,
        // さくらのときは、束へ渡す行き先が無い（3段をこちらで回す）
        bundleRunner: sakura ? null : "ollama",
      });

    /*
      プロンプト版と、**チャンクごとの枠**を束に訊く（`*.run` は返さない）。
      **AIは呼ばない**——`novel.prompt` はプロンプトを組んで返すだけである。

      枠（`maxIssues`）を訊くのは、**点数の天井を知るため**。推敲は
      「字数/1000×3件」しか通さないので、これを出さないと
      「12/18 までしか行けない台」の 12 を満点と読み違える
      （2026-09-18 に実際に読み違えた）。**訊けなければ空のまま残す。**

      **2つのプロンプトを通る道がある**（事実の照合は P-37 で抜いて P-12b で
      判定する）。片方の版しか残さないと、あとから「前 → 後」を並べても
      何が変わったのかが分からない。返してこない道具では null のまま。

      ここで組ませたプロンプトの長さが、下の `num_ctx` の根拠になる。
    */
    const canAskPrompt =
      Boolean(promptTool) && tools.some((tool) => tool.name === promptTool);
    /*
      **まず基準の切り方で組む。** 束の `numCtx` は「本文を切る大きさ」と
      「Ollama へ送る `num_ctx`」を兼ねているので、送る長さを知るには
      いったん切ってみるしかない。
    */
    const basisNumCtx = options.numCtx ?? DEFAULT_NUM_CTX;
    let calls = buildCalls(basisNumCtx);
    let collected = canAskPrompt
      ? await collectPlans(client, promptTool, calls)
      : { promptVersion: null, verifyPromptVersion: null, plans: [], promptChars: null };

    /*
      **`num_ctx` を製品と同じ道で決める**（2026-09-19。`measureNumCtx.mjs`）。

      クラウド（`--runner sakura`）は自分で決めるので触らない——あちらの
      `numCtx` は本文の切り方にしか効かない。
    */
    let numCtx = basisNumCtx;
    let decision = {
      numCtx: basisNumCtx,
      source: sakura
        ? "本文の切り方（クラウドへ num_ctx は送りません）"
        : "既定",
    };
    let modelInfo = null;
    if (!sakura) {
      /*
        **明示されているなら、束にもモデルにも訊かない。** ここで
        `npm run bundle:core` を要求すると、「VRAM に載る上限を探る」という
        `--num-ctx` 本来の使い道が、束ね直しの手間に引っかかって止まる。
        **決めるのは1か所**（`decideNumCtx`）のままにしておく。
      */
      let contextSizeForPrompt = null;
      let outputTokens = null;
      let measured;
      if (options.numCtx === null) {
        const borrowed = await loadContextSizeForPrompt();
        contextSizeForPrompt = borrowed.contextSizeForPrompt;
        if (borrowed.stale) {
          // **黙って古い決め方で測らない**（束ね直し忘れ）
          console.warn(
            "※ dist/core-bundle.mjs が src/core/chunker.ts より古いようです（npm run bundle:core で束ね直してください）。"
          );
        }
        modelInfo = await askModelInfo(client, {
          model: options.model,
          endpoint: options.endpoint,
        });
        if (modelInfo.note) console.warn(`※ ${modelInfo.note}`);
        // **製品の定数は源から読む**（写しを持たない。`measureNumCtx.mjs`）
        outputTokens = outputReserveTokens();
        measured = measuredOf(modelInfo.bundled, bundledCharsPerTokenSamples());
      }
      /*
        **2段のプロンプトを通る機能では、決めない**（事実の照合）。
        `novel.prompt` が見せてくれるのは第1段（本文から事実を抜く P-37）だけで、
        **第2段（P-12b で1件ずつ確かめる）の長さは分からない。** 見えている
        ほうだけで決めると、第2段のほうが長かったときに**入力が黙って
        切り捨てられる**——それは製品には無い不具合である。
      */
      const twoStage = Boolean(collected.verifyPromptVersion);
      decision = decideNumCtx({
        explicit: options.numCtx,
        promptChars: twoStage ? null : collected.promptChars,
        fallbackReason: twoStage
          ? "2段めのプロンプトの長さが分からないので決めませんでした"
          : undefined,
        outputTokens,
        contextWindow: modelInfo?.contextLength,
        measured,
        contextSizeForPrompt,
        fallback: DEFAULT_NUM_CTX,
      });
      numCtx = decision.numCtx;
    }

    /*
      **決めた値で組み直す。** 束の `numCtx` は切り方も兼ねているので、
      基準と違う値で回すなら、控えた枠（`plans`）とチャンクの名前も
      その切り方のものに揃える——揃えないと、**測ったのと違うチャンクの
      枠で点数の天井を出す**ことになる。
    */
    if (numCtx !== basisNumCtx) {
      calls = buildCalls(numCtx);
      if (canAskPrompt) {
        const again = await collectPlans(client, promptTool, calls);
        if (
          collected.plans.length > 0 &&
          again.plans.length !== collected.plans.length
        ) {
          // **切り方が変わったら黙らない。** 前の記録と数が違う理由になる
          console.warn(
            `※ num_ctx を ${basisNumCtx} → ${numCtx} にしたので、チャンクの数が ${collected.plans.length} → ${again.plans.length} に変わりました。`
          );
        }
        collected = again;
      }
    }
    const { promptVersion, verifyPromptVersion, plans } = collected;
    /*
      枠を返さない道具のために、**1000字あたりの上限を源から読んでおく**
      （`scripts/measureScoring.mjs` の `maxIssuesPer1000CharsOf`）。
      値は写さず、`src/prompts/proofread.ts` から取り出す。
    */
    const maxIssuesPer1000Chars =
      options.feature === "proofread"
        ? maxIssuesPer1000CharsOf(
            fs.readFileSync(
              path.join(REPO_ROOT, "src", "prompts", "proofread.ts"),
              "utf8"
            )
          )
        : null;

    const endpoint = sakura
      ? (options.endpoint ?? SAKURA_ENDPOINT)
      : options.endpoint;
    const route = sakura
      ? `${PROMPT_TOOL} → さくらのAI → ${VALIDATE_TOOL}`
      : toolName;
    console.log(
      `${options.feature}（${route}）を ${options.model} で ${options.repeat} 回まわします` +
        `（${sakura ? "本文の切り方" : "num_ctx"} ${numCtx}／${decision.source}、対象 ${calls.length} 件）。`
    );
    if (sakura) {
      // **鍵は出さない。** 宛先と待ち時間だけを断る（課金の目安になる）
      console.log(
        `  宛先 ${endpoint}（1チャンクあたり ${Math.round(options.timeoutMs / 1000)}秒まで待ちます）。`
      );
    }

    /*
      **温めてから測る**（手元の Ollama だけ）。読み込みを所要時間に含めると、
      **最後に使ったモデルが有利**になる——2026-09-19 の比較はそれで
      「VRAM に入らない26bのほうが速い」という形になっていた。
      かかった時間は捨てずに「温め」として別に出す。
    */
    const warmup = sakura
      ? null
      : await warmUp(client, {
          model: options.model,
          endpoint: options.endpoint,
          numCtx,
        });
    if (warmup) {
      const seconds = (warmup.elapsedMs / 1000).toFixed(1);
      console.log(
        warmup.ok
          ? `  温め（読み込みを含む）: ${seconds}秒`
          : `  温めに失敗しました（${seconds}秒）: ${warmup.reason}`
      );
    }

    const ask = sakura
      ? askBySakura(client, { ...options, endpoint }, sakuraToken)
      : askByRun(client, toolName);

    const runs = [];
    for (let round = 1; round <= options.repeat; round += 1) {
      console.log(`  ${round}回目…`);
      const run = await runOnce(calls, ask);
      const scored = metricsOfRun(options.feature, answers, {
        ...run,
        plans,
        maxIssuesPer1000Chars,
      });
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
    /*
      **何で測ったのかを、結果の行にも出す**（記録の欄だけでは、並べたときに
      見えない）。`num_ctx` が違えば所要時間はまるで変わるので、**時間の行と
      同じ画面に**無いと比べられない。
    */
    lines.push(
      `${sakura ? "本文の切り方" : "num_ctx"}: ${numCtx}（${decision.source}）`
    );
    if (warmup) {
      lines.push(
        warmup.ok
          ? `温め（読み込みを含む。上の所要時間には入っていません）: ${(warmup.elapsedMs / 1000).toFixed(1)}秒`
          : `温め: 失敗（${warmup.reason}）`
      );
    }

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
      /*
        **実際に使った値を書く**（打たれた指定ではない）。決め打ちをやめた
        ので、ここが記録ごとに変わる——`numCtxDecision` に**何を根拠に
        決めたか**を添える。欄の名前と型は今までのままにしてある
        （前の記録と並べられなくなるため）。
      */
      numCtx,
      numCtxDecision: decision,
      /** モデルが申告した読める長さと、同梱の実測（訊けた場合） */
      modelInfo,
      /** 読み込みぶん。**所要時間からは外してある** */
      warmup,
      endpoint,
      // **何を指定して測ったかを残す。** 同じ日に `categories` を変えて
      // 2度回すと、記録は `-2.json` になるだけで中身の違いが読めない
      options: options.options,
      repeat: options.repeat,
      bundle,
      promptVersion,
      verifyPromptVersion,
      /*
        **測ったチャンクの枠を残す。** あとから記録だけを見て集計をかけ直す
        とき、字数と上限が無いと天井を再現できない。
      */
      plans,
      maxIssuesPer1000Chars,
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
