// 測定の「数え方」だけを取り出したもの（設計書6.87.15 の柱3）。
//
// **束も Ollama も要らない純粋な関数にしてある**——`measure.mjs` は
// 束を起こして返り値を集めるだけで、数えるのはここ。こうしておくと
// **数え方そのものを単体テストで確かめられる**（`test/unit/measureScoring.test.ts`）。
//
// `src/` に置いていないのは、**これが製品ではなく `scripts/` の道具だから**。
// 製品の検算（`core/proofreadValidation.ts`）は束の中で通っており、ここは
// 「通ったあとの結果を、答え合わせする」係である。

/** 漢字ひらきの札。**答え付きの台はこの理由だけを見る** */
export const KANJI_REASON = "漢字ひらき";

/* ── 道具名の対応表 ───────────────────────────────────── */

/**
 * 測れる `feature`（0.66.7 で道具を束ねたので、**行き先はどれも `novel.run`**）。
 *
 * **写しを持たない。** `measure.mjs` の中にも書くと、名前が変わったとき
 * 片方だけ直して「動くけれど別のものを測っている」が起きる。**この並びが
 * 束の feature と揃っているか**は `test/unit/mcpBundledTools.test.ts` が
 * `src/core/mcpFeatures.ts` と突き合わせて確かめる——表だけでは、
 * こちらの思い込みが残る。
 */
export const RUN_TOOL = "novel.run";
export const PROMPT_TOOL = "novel.prompt";

export const FEATURES = [
  "proofread",
  "typo",
  "notation",
  "contradiction",
  "foreshadow",
  "deviation",
  "synopsis",
  "episodePlot",
  "settings",
  "opening",
  "name",
  "plotReverse",
  "chapter",
  "blurb",
  "catchphrase",
  "chat",
];

/**
 * 本文を1話ずつ見る feature。**`filePath` を話数ぶん渡す。**
 *
 * `src/core/mcpFeatures.ts` の `FILE_TARGET_FEATURES` と同じ並びで、
 * ずれていないことをテストが見張る——**ずれると、作品ぜんたいを1回見る
 * 機能を話数ぶん回す**ことになる（同じ答えを何度も測って平均する形になり、
 * 数字は出るが意味が変わる）。
 */
export const FILE_TARGET_FEATURES = [
  "typo",
  "proofread",
  "contradiction",
  "foreshadow",
  "settings",
  "synopsis",
  "deviation",
];

/** その feature が測れるか確かめる。知らない名前なら、選べるものを並べて断る */
export function assertFeature(feature) {
  if (FEATURES.includes(feature)) return feature;
  throw new Error(
    `知らない feature です: ${feature}（選べるのは ${FEATURES.join("・")}）`
  );
}

/** `feature` を回す道具の名前（束ねたので1つだけ） */
export function toolNameOf(feature) {
  assertFeature(feature);
  return RUN_TOOL;
}

/**
 * 「プロンプトを組むだけ」の道具。**プロンプト版を訊くために要る**。
 *
 * `novel.run` は検算まで通した結果しか返さず、**何版のプロンプトで測ったかを
 * 返さない**。記録に版が無いと、あとから「前 → 後」を並べても
 * **何が変わったのかが分からない**ので、束に直接訊く。
 */
export function promptToolOf(runTool) {
  return runTool === RUN_TOOL ? PROMPT_TOOL : null;
}

/** `src/mcp/server.ts` に登録されている道具の名前を読む */
export function registeredToolNames(serverSource) {
  const names = [];
  const pattern = /server\.registerTool\(\s*"([^"]+)"/g;
  let match;
  while ((match = pattern.exec(serverSource)) !== null) names.push(match[1]);
  return names;
}

/**
 * その名前が本当に登録されているか。**無ければ止める。**
 *
 * 登録名が変わったとき、呼んでみるまで気づかないと、**断られた理由が
 * 「許可が無い」なのか「そんな道具が無い」なのか**が混ざる。
 */
export function assertToolRegistered(serverSource, toolName) {
  const names = registeredToolNames(serverSource);
  if (names.includes(toolName)) return;
  throw new Error(
    `${toolName} は src/mcp/server.ts に登録されていません（対応表を直してください）。`
  );
}

/* ── 結果の置き場所 ───────────────────────────────────── */

/** ファイル名に使えない文字を落とす（モデル名の `:` と `/`） */
export function safeForFileName(value) {
  return String(value).replace(/[:/\\]/g, "_");
}

/** `<日付>-<feature>-<model>.json`。**モデル名はそのままでは使えない** */
export function measurementFileName(dateText, feature, model) {
  return `${dateText}-${safeForFileName(feature)}-${safeForFileName(model)}.json`;
}

/**
 * 空いている名前を選ぶ。**同名があっても上書きしない**（`-2`、`-3`）。
 *
 * 測定の記録は**測った回ごとに残す**ものである。同じ日に2度回して
 * 片方が消えると、「揺れたのか良くなったのか」を確かめる材料が消える。
 *
 * @param exists 既にあるかを答える関数（ファイルを触らずに試せるようにしてある）
 */
export function pickFreeName(fileName, exists) {
  if (!exists(fileName)) return fileName;
  const stem = fileName.replace(/\.json$/, "");
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${stem}-${suffix}.json`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`${fileName} の空き名が見つかりません（-999 まで埋まっています）。`);
}

/**
 * `chunkId` からファイルの相対パスを取り出す。
 *
 * `src/mcp/tools/shared.ts` の `parseChunkId` と同じ切り方
 * （`<相対パス>#<話数>-<番号>@<最大字数>`）。**製品の形が変わったら
 * ここも変わる**ので、テストで形ごと確かめている。
 */
export function filePathOfChunkId(chunkId) {
  const at = String(chunkId).lastIndexOf("@");
  const hash = String(chunkId).lastIndexOf("#", at);
  if (at < 0 || hash < 0) return normalizePath(String(chunkId));
  return normalizePath(String(chunkId).slice(0, hash));
}

/** Windows の `\` と、答えの `/` を揃える（揃えないと1件も突き合わない） */
export function normalizePath(value) {
  return String(value).replace(/\\/g, "/");
}

function textOf(value) {
  return typeof value === "string" ? value : "";
}

/**
 * 1回の呼び出しの返り値から、`{ chunkId, accepted, rejected }` の並びを取り出す。
 *
 * **道具によって、返す形が2つある。**
 * - チャンクに切る道具（推敲・誤字脱字など）は `results[]` を返す
 * - 話まるごとを1回で見る道具（逸脱・各話あらすじ）は `runOnce` を通るので、
 *   **`result` が1つだけ**で `chunkId` を持たない（`src/mcp/tools/run.ts`）
 *
 * 後者を `results[]` としてだけ拾っていたので、**逸脱は何件指摘が出ても
 * 0件として記録されていた**（2026-09-18 の F-86 の記録が「指摘 0」なのは、
 * 数え方のほうがそもそも受け取っていなかったため）。どの話の結果かは
 * 呼び出し側が知っている（`filePath`）ので、それを `chunkId` の代わりに置く。
 */
export function resultsOfResponse(response, label) {
  if (Array.isArray(response?.results)) return response.results;
  const single = response?.result;
  if (single && typeof single === "object") {
    return [{ chunkId: label, ...single }];
  }
  return [];
}

/**
 * 1回ぶんの返り値を、ファイルごとの指摘にほぐす。
 *
 * `results[]` は `{ chunkId, accepted[], rejected[] }` の並びで、
 * 1つのファイルが複数のチャンクに割れていることがある。**答え合わせは
 * ファイル単位**（`answers.json` の `episodes[].file`）なので、ここで束ねる。
 */
export function acceptedByFile(results) {
  const byFile = new Map();
  for (const result of results ?? []) {
    const file = filePathOfChunkId(result?.chunkId ?? "");
    const list = byFile.get(file) ?? [];
    for (const issue of result?.accepted ?? []) list.push(issue);
    byFile.set(file, list);
  }
  return byFile;
}

/**
 * 推敲（P-10）の答え合わせ（`test/fixtures/seeded/proofread/README.md` の数え方）。
 *
 * - 当て字・ひらくべき語：`accepted[]`（`reason` が「漢字ひらき」）の
 *   `original` にその語が含まれ、`suggestion` にその読みが含まれていれば「拾った」
 * - `suggestion` が空なら「出たが提案なし」（拾ったとは数えない）
 * - ひらいてはいけない語・本動詞の罠：`original` に含まれ、`suggestion` から
 *   その語が消えていれば「誤検出」
 *
 * **「誤検出」は「漢字ひらき」の札だけを見る。** 長文や冗長の書き直しで
 * たまたま語が消えた場合まで数えると、**ひらいた覚えの無い誤検出**が積もる。
 *
 * **空の修正案は誤検出に数えない。** ひらいていないのだから、あれは
 * 「提案なし」であって「ひらいてはいけない語をひらいた」ではない。
 *
 * **語ごとに出現数で頭打ちにする。** 同じ語に2件の指摘が付いても、
 * 本文に1回しか無ければ拾えたのは1回である（分母が出現数のため）。
 */
export function scoreProofread(answers, results) {
  const byFile = acceptedByFile(results);

  const ateji = { found: 0, total: 0, noSuggestion: 0, byWord: {} };
  const mustOpen = { found: 0, total: 0, noSuggestion: 0, byWord: {} };
  const falsePositives = { count: 0, byWord: {} };

  for (const episode of answers?.episodes ?? []) {
    const file = normalizePath(episode?.file ?? "");
    const issues = (byFile.get(file) ?? []).filter(
      (issue) => issue?.reason === KANJI_REASON
    );

    for (const [entry, bucket] of [
      [episode?.ateji ?? [], ateji],
      [episode?.mustOpen ?? [], mustOpen],
    ]) {
      for (const item of entry) {
        const word = textOf(item?.word);
        const reading = textOf(item?.reading);
        const count = Number(item?.count) || 0;
        const mentions = issues.filter((issue) =>
          textOf(issue?.original).includes(word)
        );
        const hits = mentions.filter((issue) =>
          textOf(issue?.suggestion).includes(reading)
        ).length;
        const blanks = mentions.filter(
          (issue) => textOf(issue?.suggestion).trim() === ""
        ).length;

        bucket.total += count;
        const found = Math.min(hits, count);
        bucket.found += found;
        const blank = Math.min(blanks, count);
        bucket.noSuggestion += blank;
        const previous = bucket.byWord[word] ?? {
          found: 0,
          total: 0,
          noSuggestion: 0,
        };
        bucket.byWord[word] = {
          found: previous.found + found,
          total: previous.total + count,
          noSuggestion: previous.noSuggestion + blank,
        };
      }
    }

    for (const item of [
      ...(episode?.mustNotOpen ?? []),
      ...(episode?.verbTraps ?? []),
    ]) {
      const word = textOf(item?.word);
      const count = Number(item?.count) || 0;
      const opened = issues.filter((issue) => {
        const original = textOf(issue?.original);
        const suggestion = textOf(issue?.suggestion);
        if (!original.includes(word)) return false;
        if (suggestion.trim() === "") return false; // 提案なしは「ひらいた」ではない
        return !suggestion.includes(word);
      }).length;
      const counted = Math.min(opened, count);
      if (counted === 0) continue;
      falsePositives.count += counted;
      falsePositives.byWord[word] = (falsePositives.byWord[word] ?? 0) + counted;
    }
  }

  return { ateji, mustOpen, falsePositives };
}

/* ── 逸脱（P-11）の答え合わせ ──────────────────────────── */

/**
 * 引用どうしを比べるための均し。
 *
 * **括弧と空白しか落とさない。** 読点や句点まで落とすと、別々の文が
 * 偶然重なって「拾えた」ことになる。AIの `excerpt` は鉤括弧を付けたり
 * 付けなかったりするので、そこだけ吸収すれば足りる。
 */
export function normalizeQuote(value) {
  return String(value ?? "").replace(/[\s　「」『』（）()]/g, "");
}

/** 引用が短すぎると偶然重なる。**5字を下回るものは重なりと見ない** */
const MIN_QUOTE_OVERLAP = 5;

/** 指摘の引用と、仕込みの引用が重なるか（どちらが長くてもよい） */
export function quotesOverlap(excerpt, where) {
  const left = normalizeQuote(excerpt);
  const right = normalizeQuote(where);
  if (left.length < MIN_QUOTE_OVERLAP || right.length < MIN_QUOTE_OVERLAP) {
    return false;
  }
  return left.includes(right) || right.includes(left);
}

/** 行の範囲が重なるか（`lineEnd` が読めなければ `lineStart` の1行と見る） */
export function linesOverlap(issue, lines) {
  const start = Number(issue?.lineStart);
  if (!Number.isFinite(start)) return false;
  const endRaw = Number(issue?.lineEnd);
  const end = Number.isFinite(endRaw) && endRaw >= start ? endRaw : start;
  const from = Number(lines?.start);
  const to = Number(lines?.end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  return start <= to && end >= from;
}

/**
 * 逸脱検知（P-11）の答え合わせ
 * （`test/fixtures/seeded/deviation/README.md` の数え方）。
 *
 * - **拾えた**：同じ話の `accepted[]` に、仕込みの `where`（本文の引用）と
 *   重なる `excerpt` があるか、`lines` と行の範囲が重なる指摘があるもの
 * - **見逃し**：拾えなかった仕込み
 * - **誤検出**：`mustNotFlag` の話に付いた指摘。**プロットどおりに書いた
 *   話なので、そこに出たものはすべて誤検出である**
 *
 * **1つの指摘は1つの仕込みにしか当たらない。** 同じ指摘で2つ拾ったことに
 * すると、**1件しか出していないのに満点**になる（`deviationBudget()` は
 * 1,300字の話に1件しか通さないので、これは起こりうる）。
 *
 * **種別ちがい（逸脱／間延びの取り違え）は、拾えたに数えたうえで別に出す。**
 * 場所を当てられているかと、名前を付けられているかは別の能力で、
 * 混ぜると**どちらが弱いのか分からなくなる**。
 */
export function scoreDeviation(answers, results) {
  const byFile = acceptedByFile(results);
  const mustNotFlag = new Set(
    (answers?.mustNotFlag ?? []).map((file) => normalizePath(file))
  );

  const seeds = { found: 0, total: 0, byKind: {} };
  const missed = [];
  const falsePositives = { count: 0, byFile: {} };
  let kindMismatch = 0;
  let otherFlags = 0;

  for (const episode of answers?.episodes ?? []) {
    const file = normalizePath(episode?.file ?? "");
    const issues = byFile.get(file) ?? [];

    if (mustNotFlag.has(file)) {
      // **プロットどおりの話。ここに出たものは、中身を問わず誤検出**
      if (issues.length > 0) {
        falsePositives.count += issues.length;
        falsePositives.byFile[file] = issues.length;
      }
      continue;
    }

    // 当たった指摘を控えておく（1つの指摘を2つの仕込みに使い回さない）
    const used = new Set();
    for (const seed of episode?.seeded ?? []) {
      const kind = textOf(seed?.kind) || "（種別なし）";
      const bucket = seeds.byKind[kind] ?? { found: 0, total: 0 };
      bucket.total += 1;
      seeds.total += 1;

      const hit = issues.findIndex(
        (issue, at) =>
          !used.has(at) &&
          (quotesOverlap(issue?.excerpt, seed?.where) ||
            linesOverlap(issue, seed?.lines))
      );
      if (hit >= 0) {
        used.add(hit);
        bucket.found += 1;
        seeds.found += 1;
        if (textOf(issues[hit]?.type) !== kind) kindMismatch += 1;
      } else {
        missed.push({ file, kind, where: textOf(seed?.where) });
      }
      seeds.byKind[kind] = bucket;
    }

    // **仕込みと重ならなかった指摘。** 誤検出とは別に数える——プロットに
    // 無い展開が他にも読めた可能性があり、機械には正否を決められない
    otherFlags += issues.length - used.size;
  }

  return { seeds, missed, falsePositives, kindMismatch, otherFlags };
}

/**
 * どの feature でも数えられるもの（件数・落とした理由・失敗）。
 *
 * **答えを持たない機能はここまで。** 見逃しと誤検出は答えが無いと数えられず、
 * 件数だけを「良くなった」と読むと、**何も指摘しない実装が満点になる**。
 */
export function countGeneric(results) {
  let accepted = 0;
  let rejected = 0;
  const rejectedReasons = {};
  let noSuggestion = 0;

  for (const result of results ?? []) {
    for (const issue of result?.accepted ?? []) {
      accepted += 1;
      if (
        issue?.reason === KANJI_REASON &&
        textOf(issue?.suggestion).trim() === ""
      ) {
        noSuggestion += 1;
      }
    }
    for (const item of result?.rejected ?? []) {
      rejected += 1;
      const reason = textOf(item?.reason) || "（理由なし）";
      rejectedReasons[reason] = (rejectedReasons[reason] ?? 0) + 1;
    }
  }
  return { accepted, rejected, rejectedReasons, noSuggestion };
}

/**
 * 1回ぶんの測定を、指標の表にまとめる。
 *
 * @param feature どの機能か。答えのある機能（`proofread`・`deviation`）だけ
 *   答え合わせが付く
 * @param answers `answers.json`（無ければ null）
 * @param run `{ results, failures, elapsedMs }`
 */
export function metricsOfRun(feature, answers, run) {
  const results = run?.results ?? [];
  const failures = run?.failures ?? [];
  const generic = countGeneric(results);

  const metrics = {};
  const detail = { rejectedReasons: generic.rejectedReasons, failures };

  if (feature === "proofread" && answers) {
    const scored = scoreProofread(answers, results);
    metrics.ateji = scored.ateji.found;
    metrics.atejiTotal = scored.ateji.total;
    metrics.mustOpen = scored.mustOpen.found;
    metrics.mustOpenTotal = scored.mustOpen.total;
    metrics.falsePositives = scored.falsePositives.count;
    detail.ateji = scored.ateji.byWord;
    detail.mustOpen = scored.mustOpen.byWord;
    detail.falsePositives = scored.falsePositives.byWord;
  }

  if (feature === "deviation" && answers) {
    const scored = scoreDeviation(answers, results);
    metrics.seeded = scored.seeds.found;
    metrics.seededTotal = scored.seeds.total;
    metrics.missed = scored.seeds.total - scored.seeds.found;
    metrics.falseFlags = scored.falsePositives.count;
    metrics.kindMismatch = scored.kindMismatch;
    metrics.otherFlags = scored.otherFlags;
    detail.seeded = scored.seeds.byKind;
    detail.missed = scored.missed;
    detail.falseFlags = scored.falsePositives.byFile;
  }

  /*
    **その機能に関係のある指標だけを出す。** 「提案なし（漢字ひらきなのに
    修正案が空）」は推敲だけの話で、`countGeneric` は「漢字ひらき」の札しか
    数えないから他の機能では必ず 0 になる。**必ず 0 と分かっている行を
    毎回出すと、読む人は他の 0 も同じ種類の 0 だと思う**（逸脱を測ったとき、
    この行が先頭に出ていた）。
  */
  if (feature === "proofread") metrics.noSuggestion = generic.noSuggestion;
  metrics.accepted = generic.accepted;
  metrics.rejected = generic.rejected;
  for (const [reason, count] of Object.entries(generic.rejectedReasons)) {
    metrics[`rejected.${reason}`] = count;
  }
  metrics.failures = failures.length;
  metrics.elapsedMs = Number(run?.elapsedMs) || 0;

  return { metrics, detail };
}

/**
 * 何回か回した結果から、指標ごとの最小〜最大（揺れ幅）を出す。
 *
 * **1回の測定では、良くなったのか揺れたのか分からない**（0.66.4 で
 * 12b の「ひらくべき」が 5→2 になり、判定できなかった）。ここが柱3の眼目である。
 *
 * **ある回に出なかった指標は 0 として数える**——`rejected.over_budget` が
 * 1回だけ出たとき、「1〜1」ではなく「0〜1」が本当のところである。
 */
export function spreadOfRuns(runs) {
  const keys = new Set();
  for (const run of runs) {
    for (const key of Object.keys(run?.metrics ?? {})) keys.add(key);
  }
  const spread = {};
  for (const key of keys) {
    const values = runs.map((run) => Number(run?.metrics?.[key] ?? 0));
    spread[key] = {
      values,
      min: Math.min(...values),
      max: Math.max(...values),
    };
  }
  return spread;
}

/** 画面に出すときの日本語。**指標の名前をそのまま出さない**（作者が読む） */
const LABELS = {
  ateji: "当て字を拾えた",
  mustOpen: "ひらくべき語を拾えた",
  falsePositives: "誤検出（ひらいてはいけない語をひらいた）",
  noSuggestion: "提案なし（漢字ひらきなのに修正案が空）",
  seeded: "仕込んだ逸脱を拾えた",
  missed: "見逃し（拾えなかった仕込み）",
  falseFlags: "誤検出（プロットどおりの話に付いた指摘）",
  kindMismatch: "種別ちがい（場所は当てたが 逸脱／間延び を取り違えた）",
  otherFlags: "仕込み以外の箇所への指摘",
  accepted: "指摘（検算を通ったもの）",
  rejected: "落とした（検算で弾いたもの）",
  failures: "失敗（チャンクごと通らなかったもの）",
  elapsedMs: "所要時間",
};

/** 分母を持つ指標。**「3」ではなく「3/8」と出す** */
const DENOMINATORS = {
  ateji: "atejiTotal",
  mustOpen: "mustOpenTotal",
  seeded: "seededTotal",
};

/** 分母そのものは行にしない（分子の行に出るため） */
const HIDDEN = new Set(Object.values(DENOMINATORS));

const ORDER = [
  "ateji",
  "mustOpen",
  "falsePositives",
  "seeded",
  "missed",
  "falseFlags",
  "kindMismatch",
  "otherFlags",
  "noSuggestion",
  "accepted",
  "rejected",
];

export function labelOf(key) {
  if (LABELS[key]) return LABELS[key];
  if (key.startsWith("rejected.")) {
    return `　└ 落とした理由：${key.slice("rejected.".length)}`;
  }
  return key;
}

/** 表に出す順番。**答え合わせを先、内訳を後ろ**（読む順に合わせる） */
export function orderedKeys(spread) {
  const keys = Object.keys(spread).filter((key) => !HIDDEN.has(key));
  const rejected = keys.filter((key) => key.startsWith("rejected.")).sort();
  const rest = keys.filter(
    (key) =>
      !key.startsWith("rejected.") &&
      !ORDER.includes(key) &&
      key !== "failures" &&
      key !== "elapsedMs"
  );
  return [
    ...ORDER.filter((key) => keys.includes(key)),
    ...rejected,
    ...rest.sort(),
    ...(keys.includes("failures") ? ["failures"] : []),
    ...(keys.includes("elapsedMs") ? ["elapsedMs"] : []),
  ];
}

function formatValue(key, value, spread) {
  if (key === "elapsedMs") return `${(value / 1000).toFixed(1)}秒`;
  const denominator = DENOMINATORS[key];
  if (denominator && spread?.[denominator]) {
    return `${value}/${spread[denominator].max}`;
  }
  return String(value);
}

/** `min〜max`（同じなら1つだけ）。回ごとの値も添える */
function formatSpread(key, entry, spread) {
  const head =
    entry.min === entry.max
      ? formatValue(key, entry.min, spread)
      : `${formatValue(key, entry.min, spread)}〜${formatValue(key, entry.max, spread)}`;
  if (entry.values.length <= 1) return head;
  const each = entry.values
    .map((value) => formatValue(key, value, spread))
    .join("、");
  return `${head}（各回：${each}）`;
}

/** 画面に出す行（1指標につき1行、日本語） */
export function formatSpreadLines(spread) {
  return orderedKeys(spread).map(
    (key) => `${labelOf(key)}: ${formatSpread(key, spread[key], spread)}`
  );
}

/**
 * 前回との比較（`--compare`）。**「前 a → 後 b」で並べる。**
 *
 * **片方にしか無い指標も出す**（0 として）。`rejected.original_not_found` が
 * 消えたことは、消えたと書かないと伝わらない。
 */
export function formatCompareLines(before, after) {
  const keys = new Set([...orderedKeys(before), ...orderedKeys(after)]);
  const ordered = orderedKeys(
    Object.fromEntries([...keys].map((key) => [key, { values: [0] }]))
  );
  const lines = [];
  for (const key of ordered) {
    const left = before[key] ?? { values: [0], min: 0, max: 0 };
    const right = after[key] ?? { values: [0], min: 0, max: 0 };
    lines.push(
      `${labelOf(key)}: ${formatSpread(key, left, before)} → ${formatSpread(key, right, after)}`
    );
  }
  return lines;
}
