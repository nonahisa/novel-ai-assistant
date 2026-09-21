// 測定の「数え方」だけを取り出したもの（設計書6.87.15 の柱3）。
//
// **束も Ollama も要らない純粋な関数にしてある**——`measure.mjs` は
// 束を起こして返り値を集めるだけで、数えるのはここ。こうしておくと
// **数え方そのものを単体テストで確かめられる**（`test/unit/measureScoring.test.ts`）。
//
// `src/` に置いていないのは、**これが製品ではなく `scripts/` の道具だから**。
// 製品の検算（`core/proofreadValidation.ts`）は束の中で通っており、ここは
// 「通ったあとの結果を、答え合わせする」係である。

/**
 * 数え方でくり返し使う入れものの形。
 *
 * **JSで `{ byKind: {} }` と書くと「鍵を1つも持たない型」に推論され、
 * あとから足した鍵を名前で引けなくなる**（型検査が `byKind["人物"]` を断る）。
 * ここで形に名前を付けておき、各集計の頭で `@type` として貼る。
 * 中身の検査（`checkJs`）は入れていないので、これは**呼ぶ側のための説明**である。
 *
 * @typedef {{ found: number, total: number }} FoundTotal
 * @typedef {{ found: number, total: number, byKind: Record<string, FoundTotal> }} SeedTally
 * @typedef {{ count: number, byFile: Record<string, number> }} FalsePositiveByFile
 * @typedef {{ found: number, total: number, noSuggestion: number }} OpenWordTally
 */

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
/**
 * 検算の道具。**クラウドで測るときに要る**（`--runner sakura`）。
 *
 * 手元の Ollama は `novel.run` の中で検算まで通るが、クラウドへは
 * こちらから投げるので、**戻し先を自分で呼ぶ**。`prompt` だけ呼んで
 * ここを飛ばす測り方は、製品に無い不具合を見つけたことになる。
 */
export const VALIDATE_TOOL = "novel.validate";

/**
 * 手元の Ollama を直に触る道具。**測定台は2つのことに使う。**
 *
 * - `ollama.models` … モデルが申告する読める長さと、同梱の実測を訊く
 *   （`num_ctx` を製品と同じ道で決めるのに要る。`measureNumCtx.mjs`）
 * - `ollama.generate` … **測る前に空打ちして温める。** これをしないと、
 *   最後に使ったモデルだけが「読み込み済み」で有利になる
 *   （2026-09-19 に、26bだけ載ったまま測って165秒／12bは349秒と出た）
 */
export const MODELS_TOOL = "ollama.models";
export const GENERATE_TOOL = "ollama.generate";

export const FEATURES = [
  "proofread",
  "typo",
  "notation",
  "contradiction",
  "factContradiction",
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

/**
 * 同じ答え付きの台（`test/fixtures/seeded/contradiction/`）で測る feature。
 *
 * **古い道（P-12）と新しい道（6.88 の事実の照合）を、同じ仕込みで比べる**
 * ためにある。台を分けると、点差が「道の違い」なのか「台の違い」なのかが
 * 分からなくなる——それでは並べて読む意味が無い。
 */
export const CONTRADICTION_FEATURES = ["contradiction", "factContradiction"];

/**
 * その feature の答え付きの台があるフォルダー名。
 *
 * 既定は feature と同じ名前（`test/fixtures/seeded/<feature>`）で、
 * **台を共有するものだけここに書く。**
 */
export function fixtureDirOf(feature) {
  return CONTRADICTION_FEATURES.includes(feature) ? "contradiction" : feature;
}

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

  /** @type {OpenWordTally & { byWord: Record<string, OpenWordTally> }} */
  const ateji = { found: 0, total: 0, noSuggestion: 0, byWord: {} };
  /** @type {OpenWordTally & { byWord: Record<string, OpenWordTally> }} */
  const mustOpen = { found: 0, total: 0, noSuggestion: 0, byWord: {} };
  /** @type {{ count: number, byWord: Record<string, number> }} */
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

  /** @type {SeedTally} */
  const seeds = { found: 0, total: 0, byKind: {} };
  /** @type {Array<{ file: string, kind: string, where: string }>} */
  const missed = [];
  /** @type {FalsePositiveByFile} */
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

/* ── 矛盾（P-12）の答え合わせ ──────────────────────────── */

/**
 * 指摘の行が、仕込みの行の範囲に入るか。
 *
 * **逸脱と形が違う。** 逸脱の指摘は `lineStart`〜`lineEnd` の範囲を持つが、
 * 矛盾の指摘（`core/contradictionValidation.ts` の `AcceptedContradiction`）は
 * `line` を**1つだけ**持つ。範囲どうしの重なりではなく、点が範囲に入るかで見る。
 */
export function lineWithin(issue, lines) {
  const line = Number(issue?.line);
  if (!Number.isFinite(line)) return false;
  const from = Number(lines?.start);
  const to = Number(lines?.end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  return line >= from && line <= to;
}

/** その指摘が、仕込み（または罠）の場所を指しているか */
function pointsAt(issue, target) {
  return (
    quotesOverlap(issue?.excerpt, target?.where) ||
    lineWithin(issue, target?.lines)
  );
}

/**
 * 矛盾検知（P-12）の答え合わせ
 * （`test/fixtures/seeded/contradiction/README.md` の数え方）。
 *
 * - **拾えた**：同じ話の `accepted[]` に、仕込みの `where` と重なる `excerpt` が
 *   あるか、`line` が仕込みの `lines` に入る指摘があるもの
 * - **見逃し**：拾えなかった仕込み
 * - **誤検出**：`mustNotFlag` に当たった指摘。`where` のある項目（罠）は
 *   **その箇所を指した指摘**、`where` の無い項目は**その話に付いた指摘すべて**
 * - **区分ちがい**：場所は当てたが `category` が仕込みの `kind` と違うもの
 *
 * **`mustNotFlag` の形が逸脱と違う。** あちらはファイル名の配列で足りたが、
 * 矛盾の罠は「作中で変わってよい箇所」なので、**変化が起きた話の中の一点**を
 * 指す必要がある——その話には仕込みも同居するため、話まるごとでは数えられない。
 *
 * **1つの指摘は1つの仕込みにしか当たらない**（逸脱と同じ）。仕込みを先に、
 * 罠をあとに当てる——順序を逆にすると、範囲が隣り合ったときに罠が仕込みの
 * 指摘を横取りし、**拾えているのに誤検出として数える**ことになる。
 */
export function scoreContradiction(answers, results) {
  const byFile = acceptedByFile(results);

  // 話まるごと（`where` なし）と、箇所ごと（`where` あり）に分ける
  const wholeFiles = new Set();
  const trapsByFile = new Map();
  for (const entry of answers?.mustNotFlag ?? []) {
    const file = normalizePath(entry?.file ?? "");
    if (!file) continue;
    if (!entry?.where) {
      wholeFiles.add(file);
      continue;
    }
    const list = trapsByFile.get(file) ?? [];
    list.push(entry);
    trapsByFile.set(file, list);
  }

  /** @type {SeedTally} */
  const seeds = { found: 0, total: 0, byKind: {} };
  /** @type {Array<{ file: string, kind: string, where: string }>} */
  const missed = [];
  /** @type {FalsePositiveByFile} */
  const falsePositives = { count: 0, byFile: {} };
  let kindMismatch = 0;
  let otherFlags = 0;

  const addFalsePositive = (file, count) => {
    if (count <= 0) return;
    falsePositives.count += count;
    falsePositives.byFile[file] = (falsePositives.byFile[file] ?? 0) + count;
  };

  for (const episode of answers?.episodes ?? []) {
    const file = normalizePath(episode?.file ?? "");
    const issues = byFile.get(file) ?? [];

    if (wholeFiles.has(file)) {
      // **設定と1つも食い違っていない話。ここに出たものは、中身を問わず誤検出**
      addFalsePositive(file, issues.length);
      continue;
    }

    const used = new Set();
    for (const seed of episode?.seeded ?? []) {
      const kind = textOf(seed?.kind) || "（区分なし）";
      const bucket = seeds.byKind[kind] ?? { found: 0, total: 0 };
      bucket.total += 1;
      seeds.total += 1;

      const hit = issues.findIndex(
        (issue, at) => !used.has(at) && pointsAt(issue, seed)
      );
      if (hit >= 0) {
        used.add(hit);
        bucket.found += 1;
        seeds.found += 1;
        // 区分は `category`（逸脱の `type` ではない）
        if (textOf(issues[hit]?.category) !== kind) kindMismatch += 1;
      } else {
        missed.push({ file, kind, where: textOf(seed?.where) });
      }
      seeds.byKind[kind] = bucket;
    }

    // **罠に付いた指摘は誤検出。** 仕込みを当て終えてから数える
    for (const trap of trapsByFile.get(file) ?? []) {
      let hits = 0;
      issues.forEach((issue, at) => {
        if (used.has(at) || !pointsAt(issue, trap)) return;
        used.add(at);
        hits += 1;
      });
      addFalsePositive(file, hits);
    }

    // **仕込みにも罠にも当たらなかった指摘。** 誤検出とは別に数える——
    // 作り物とはいえ他にも読める食い違いがありえて、機械には正否を決められない
    otherFlags += issues.length - used.size;
  }

  return { seeds, missed, falsePositives, kindMismatch, otherFlags };
}

/* ── 誤字脱字（P-09）の答え合わせ ──────────────────────── */

/**
 * その指摘を当てたあとの本文（の抜粋）。
 *
 * **製品の当て方をそのまま真似る。** AI指摘パネルは `original` の中の
 * `target` を `suggestion` へ置き換える（`core/typoCheckValidation.ts` が
 * 「`target` が `original` に含まれること」を検算で保証している）。
 *
 * **語の一致ではなく、当てた結果で測る**のには理由がある。モデルは同じ
 * 直しを違う切り方で返してくる——「ゆっくりりと」→「ゆっくりと」と返す
 * モデルもいれば、「りり」→「り」と返すモデルもいる。**どちらも本文は
 * 正しく直る**のに、語だけを見比べると後者を「直し方が違う」と数えて
 * しまう。当てた結果で見れば、切り方の好みで点が動かない。
 */
export function applyTypoFix(issue) {
  const original = textOf(issue?.original);
  const target = textOf(issue?.target);
  const suggestion = textOf(issue?.suggestion);
  if (!target || !original.includes(target)) return original;
  return original.replace(target, suggestion);
}

/**
 * 誤字脱字検知（P-09）の答え合わせ
 * （`test/fixtures/seeded/typo/README.md` の数え方）。
 *
 * - **拾えた**：同じ話の `accepted[]` に、仕込みの `wrong` を引用に含み、
 *   かつ**当てると `right` になって `wrong` が消える**指摘があるもの
 *
 * **`right` は配列でもよい。** 打ちかけの字は正解が1つに決まらない——
 * 「ｓっと」は「すっと」でも「さっと」でも本文が正しくなる。README は
 * 「当てた結果で測る」と書いてあるのに、実装が鍵の文字列1つとの一致を
 * 見ていたので、**日本語として正しい直しを減点していた**（2026-09-19。
 * Opus と Haiku が「さっと」で減点され、Sonnet だけが満点になった）。
 * - **直し方が違う**：場所は当てたが、当てても直らないもの。
 *   **拾えたには数えない**——押しても本文が正しくならない指摘である
 * - **見逃し**：拾えなかった仕込み
 * - **誤検出**：罠の語を引用に含み、**当てるとその語が変わってしまう**指摘。
 *   同じ窓の中に罠があるだけで、直す先が別の語なら数えない
 * - **仕込み以外の指摘**：どちらにも当たらなかったもの
 *
 * **1つの指摘は1つの仕込みにしか当たらない**（逸脱・矛盾と同じ）。
 * 仕込みを先に、罠をあとに当てる——順序を逆にすると、仕込みと罠が
 * 近い行にあるとき、**拾えているのに誤検出として数える**ことになる。
 *
 * **誤検出は「語」ではなく「指摘」で数える。** 作者が消して回るのは
 * 指摘の件数だからである（推敲の台は語の出現数で頭打ちにしているが、
 * あちらは「その語を何回ひらいたか」を測っている）。1つの指摘が罠の語を
 * 2つ含むことはありうるので、`byWord` の合計は `count` より大きくなる。
 */
export function scoreTypo(answers, results) {
  const byFile = acceptedByFile(results);

  /** @type {SeedTally} */
  const seeds = { found: 0, total: 0, byKind: {} };
  /** @type {Array<{ file: string, kind: string, wrong: string, note: string }>} */
  const missed = [];
  /**
   * @type {{
   *   count: number,
   *   items: Array<{ file: string, kind: string, wrong: string, suggestion: string }>,
   * }}
   */
  const wrongFix = { count: 0, items: [] };
  /**
   * @type {{
   *   count: number,
   *   byWord: Record<string, number>,
   *   byKind: Record<string, number>,
   *   items: Array<{ file: string, kind: string, word: string, target: string, suggestion: string }>,
   * }}
   */
  const falsePositives = { count: 0, byWord: {}, byKind: {}, items: [] };
  let otherFlags = 0;

  for (const episode of answers?.episodes ?? []) {
    const file = normalizePath(episode?.file ?? "");
    const issues = byFile.get(file) ?? [];
    const fixed = issues.map((issue) => applyTypoFix(issue));
    // 当たった指摘を控えておく（1つの指摘を2つの仕込みに使い回さない）
    const used = new Set();

    for (const seed of episode?.seeded ?? []) {
      const kind = textOf(seed?.kind) || "（種別なし）";
      const wrong = textOf(seed?.wrong);
      // **正解は複数ありうる。** 文字列1つでも配列でも受ける
      const rights = (Array.isArray(seed?.right) ? seed.right : [seed?.right])
        .map((value) => textOf(value))
        .filter((value) => value !== "");
      const bucket = seeds.byKind[kind] ?? { found: 0, total: 0 };
      bucket.total += 1;
      seeds.total += 1;

      const pointed = issues
        .map((issue, at) => at)
        .filter(
          (at) =>
            !used.has(at) &&
            (textOf(issues[at]?.original).includes(wrong) ||
              textOf(issues[at]?.target).includes(wrong))
        );
      const hit = pointed.find(
        (at) =>
          rights.some((right) => fixed[at].includes(right)) &&
          !fixed[at].includes(wrong)
      );

      if (hit !== undefined) {
        used.add(hit);
        bucket.found += 1;
        seeds.found += 1;
      } else if (pointed.length > 0) {
        // **場所は当てている。** 直し方だけが違うので、見逃しとは分けて出す
        used.add(pointed[0]);
        wrongFix.count += 1;
        wrongFix.items.push({
          file,
          kind,
          wrong,
          suggestion: textOf(issues[pointed[0]]?.suggestion),
        });
        missed.push({ file, kind, wrong, note: "場所は当てたが直らない" });
      } else {
        missed.push({ file, kind, wrong, note: "指摘が出なかった" });
      }
      seeds.byKind[kind] = bucket;
    }

    for (const trap of episode?.mustNotFlag ?? []) {
      const word = textOf(trap?.word);
      const kind = textOf(trap?.kind) || "（種別なし）";
      for (let at = 0; at < issues.length; at += 1) {
        if (used.has(at)) continue;
        if (!textOf(issues[at]?.original).includes(word)) continue;
        // **その語が変わらないなら、直す先は別の語である**
        if (fixed[at].includes(word)) continue;
        falsePositives.count += 1;
        falsePositives.byWord[word] = (falsePositives.byWord[word] ?? 0) + 1;
        falsePositives.byKind[kind] = (falsePositives.byKind[kind] ?? 0) + 1;
        falsePositives.items.push({
          file,
          kind,
          word,
          target: textOf(issues[at]?.target),
          suggestion: textOf(issues[at]?.suggestion),
        });
        // 1つの指摘を2つの罠で二重に数えない（`byWord` は語ごとに出す）
        used.add(at);
      }
    }

    /*
      **仕込みにも罠にも当たらなかった指摘。** 作り物なので誤検出である
      公算は高いが、機械には正否を決められない（書いた側が見落とした
      誤字がありうる）。逸脱・設定資料の台と同じく、別に数える。
    */
    otherFlags += issues.length - used.size;
  }

  return { seeds, missed, wrongFix, falsePositives, otherFlags };
}

/* ── 設定資料の抽出（P-04a）の答え合わせ ───────────────── */

/**
 * 名前を突き合わせるための均し。
 *
 * **空白と区切り記号しか落とさない。** 「リーナ・ヴェイル」と
 * 「リーナ ヴェイル」は同じ人だが、それ以上落とすと別人どうしが偶然そろう
 * ——「ヴェイル子爵」と「ヴェイル家」を畳んでしまうと、**罠2（親子の家名）と
 * 罠10（場所と組織）がどちらも測れなくなる**。
 */
export function normalizeEntityName(value) {
  return String(value ?? "").replace(/[\s　・･=＝]/gu, "");
}

/** 答えの1項目が名乗ってよい形（正式名・別表記・あるべき別名） */
function entityFormsOf(entry) {
  return [
    textOf(entry?.name),
    ...(entry?.also ?? []),
    ...(entry?.aliases ?? []),
  ]
    .map(normalizeEntityName)
    .filter(Boolean);
}

/** 受け取ったレコードが名乗っている形（名前＋別名） */
function recordFormsOf(record) {
  return [textOf(record?.name), ...(record?.aliases ?? [])]
    .map(normalizeEntityName)
    .filter(Boolean);
}

/** 名前でも別名でも、どれかが重なるレコードを探す */
function findByForms(records, forms, used) {
  return records.find(
    (record) =>
      !used?.has(record) &&
      recordFormsOf(record).some((form) => forms.includes(form))
  );
}

/** `{ data: {...} }` でも生のレコードでも中身を取り出す */
function dataOf(entry) {
  const data = entry?.data;
  return data && typeof data === "object" ? data : (entry ?? {});
}

/**
 * 設定資料の抽出の返り値を、1つの台帳にほぐす。
 *
 * **種別によって、積もり方が違う**（`src/mcp/tools/settings.ts`）。
 *
 * - `characters` は**チャンクごと**の結果（`validateCharacterExtractResult`）
 * - `settings`（能力・場所・組織・世界観・総称・落としたもの）は
 *   `SettingsExtractionCollector` が**そのファイルの先頭から積み上げた**もの
 *   （`candidates()` が集約の中身をまるごと返す）。全部足すと、チャンクが
 *   2つある話で同じ場所を2回数えることになるので、**ファイルごとに
 *   最後の結果だけ**を見る
 *
 * ファイルが変われば `novel.run` が別の呼び出しになり、集約もやり直される
 * （`measure.mjs` は `filePath` を話数ぶん渡す）。だから**ファイルごとに
 * 最後を取り、それらを名前で畳む**。
 */
export function settingsLedgerOf(results) {
  const lastByFile = new Map();
  const characters = new Map();
  const characterRejected = [];
  const dropped = {
    別人の呼び名: 0,
    途中で切れた別名: 0,
    共有された姓: 0,
    身内を指す別名: 0,
    // **落とした理由で分ける**（作者の裁定、2026-09-19「構造でも切る」）。
    // 言い回しの表は言い換えられるたびに増えるので、構造だけで落ちた数が
    // 見えないと、表を足す意味があったのかを測れない
    言い回しで落とした関係: 0,
    文の形で落とした関係: 0,
    向きを直した関係: 0,
  };

  for (const result of results ?? []) {
    lastByFile.set(filePathOfChunkId(result?.chunkId ?? ""), result);

    const people = result?.characters ?? {};
    for (const entry of people.accepted ?? []) {
      const data = dataOf(entry);
      const name = textOf(data?.name).trim();
      if (!name) continue;
      const key = normalizeEntityName(name);
      const person = characters.get(key) ?? {
        name,
        aliases: [],
        relations: [],
      };
      for (const alias of data?.aliases ?? []) {
        const text = textOf(alias).trim();
        if (text && !person.aliases.includes(text)) person.aliases.push(text);
      }
      for (const relation of data?.relations ?? []) {
        person.relations.push({
          name: textOf(relation?.name),
          relation: textOf(relation?.relation),
        });
      }
      characters.set(key, person);
    }
    for (const item of people.rejected ?? []) {
      characterRejected.push({
        name: textOf(item?.name),
        reason: textOf(item?.reason) || "（理由なし）",
      });
    }
    // **落とした別名も数える。** 罠1（兄妹が同じ一般語で呼ばれる）の
    // 見張りが働いたかは、ここの数にしか出ない
    dropped.別人の呼び名 += (people.droppedSharedBodyAliases ?? []).length;
    dropped.途中で切れた別名 += (people.droppedTruncatedAliases ?? []).length;
    dropped.共有された姓 += (people.droppedSharedFamilyNameAliases ?? []).length;
    dropped.身内を指す別名 += (people.droppedRelativeAliases ?? []).length;
    // 推測・断りを関係として書いたもの（「明記されていないが〜」）と、
    // 関係の欄に文が入っていたもの。**でっち上げの関係が0になったのは
    // 検算が効いたからだ**と読めるように、落とした数もここへ出す
    for (const entry of people.droppedRelations ?? []) {
      const reason = textOf(entry?.reason);
      if (reason === "sentence_shaped") dropped.文の形で落とした関係 += 1;
      else dropped.言い回しで落とした関係 += 1;
    }
    dropped.向きを直した関係 += (people.correctedRelations ?? []).length;
  }

  const named = (entries) => {
    const byName = new Map();
    for (const entry of entries ?? []) {
      const data = dataOf(entry);
      const name = textOf(data?.name).trim();
      if (!name) continue;
      const key = normalizeEntityName(name);
      const record = byName.get(key) ?? { name, aliases: [] };
      for (const alias of data?.aliases ?? []) {
        const text = textOf(alias).trim();
        if (text && !record.aliases.includes(text)) record.aliases.push(text);
      }
      byName.set(key, record);
    }
    return [...byName.values()];
  };

  const abilities = [];
  const locations = [];
  const organizations = [];
  const worldItems = [];
  const settingRejected = [];
  const rules = [];
  let abilityTerm = null;

  for (const result of lastByFile.values()) {
    const settings = result?.settings ?? {};
    abilities.push(...(settings.abilities ?? []));
    locations.push(...(settings.locations ?? []));
    organizations.push(...(settings.organizations ?? []));
    for (const entry of settings.worldItems ?? []) {
      const data = dataOf(entry);
      worldItems.push({
        name: textOf(data?.name),
        description: textOf(data?.description),
        category: textOf(entry?.category ?? data?.category),
      });
    }
    for (const item of settings.rejected ?? []) {
      settingRejected.push({
        name: textOf(item?.name),
        reason: textOf(item?.reason) || "（理由なし）",
      });
    }
    for (const rule of settings.rules ?? []) {
      const text = textOf(rule).trim();
      if (text && !rules.includes(text)) rules.push(text);
    }
    // **最初に読み取れた総称を使う**（製品の集約と同じ扱い）
    abilityTerm ??= settings.abilityTerm ?? null;
  }

  return {
    characters: [...characters.values()],
    abilities: named(abilities),
    locations: named(locations),
    organizations: named(organizations),
    worldItems,
    abilityTerm,
    rules,
    rejected: [...characterRejected, ...settingRejected],
    dropped,
  };
}

/** 答えの `expected` と台帳をつなぐ並び（世界観だけ当て方が違うので外す） */
const SETTINGS_NAMED_KINDS = [
  ["characters", "人物"],
  ["abilities", "能力"],
  ["locations", "場所"],
  ["organizations", "組織"],
];

/**
 * 設定資料の抽出（P-04a）の答え合わせ
 * （`test/fixtures/seeded/settings/README.md` の数え方）。
 *
 * **抽出は「何も出さない」が満点にならない代わりに、「でっち上げる」が
 * 見えなくなる。** だから拾えた数だけでなく、**出てはいけないものが
 * 出た数**を必ず並べて出す（CLAUDE.md の「繰り返し起きた失敗」2）。
 *
 * - **拾えた**：`expected` の1項目について、名前か別名のどれかが重なる
 *   レコードがあるもの。**1つのレコードは1つの項目にしか当たらない**
 * - **別名**：拾えた項目の `aliases` が、そのレコードの名前か別名にあるか
 * - **でっち上げ**：`mustNotAppear` に挙げた名前・別名で出たもの
 * - **誤って統合した組**：`mustStaySeparate` の2人が、1つのレコードの
 *   名前と別名に同居しているもの
 * - **誤って分けた組**：`mustMerge` の `forms` が、本人とは別の
 *   レコードの名前になっているもの
 * - **でっち上げの関係**：本文に無い関係語（血縁など）を書いたもの
 * - **仕込み以外**：答えにも罠にも当たらなかったレコード。**でっち上げとは
 *   別に数える**——作り物とはいえ他にも読める固有名詞がありえて、
 *   機械には正否を決められない
 */
export function scoreSettings(answers, results) {
  const ledger = settingsLedgerOf(results);
  const expected = answers?.expected ?? {};

  /** @type {SeedTally} */
  const entities = { found: 0, total: 0, byKind: {} };
  /** @type {Array<{ kind: string, name: string }>} */
  const missed = [];
  /** @type {{ found: number, total: number, missed: Array<{ name: string, alias: string }> }} */
  const aliases = { found: 0, total: 0, missed: [] };
  /** 当てた項目 → そのレコード（誤統合・誤分割の判定に使い回す） */
  const matched = new Map();
  const usedByKind = new Map();

  for (const [kind, label] of SETTINGS_NAMED_KINDS) {
    const records = ledger[kind] ?? [];
    const used = new Set();
    usedByKind.set(kind, used);
    const bucket = { found: 0, total: 0 };

    for (const entry of expected[kind] ?? []) {
      bucket.total += 1;
      entities.total += 1;
      const forms = entityFormsOf(entry);
      const record = findByForms(records, forms, used);
      if (record) {
        used.add(record);
        matched.set(entry, record);
        bucket.found += 1;
        entities.found += 1;
      } else {
        missed.push({ kind: label, name: textOf(entry?.name) });
      }

      // **別名は、項目が見つからなくても分母に数える。** 見つからなければ
      // その別名も拾えていない（分母を減らすと、拾えなかったぶん点が上がる）
      for (const alias of entry?.aliases ?? []) {
        aliases.total += 1;
        const has =
          record !== undefined &&
          recordFormsOf(record).includes(normalizeEntityName(alias));
        if (has) aliases.found += 1;
        else aliases.missed.push({ name: textOf(entry?.name), alias });
      }
    }
    entities.byKind[label] = bucket;
  }

  // 世界観だけは、見出しをAIが付けるので名前では当てられない。
  // **中身の語で当てる**（`keywords` は「すべて満たす」／内側は「どれか」）
  const worldBucket = { found: 0, total: 0 };
  const usedWorld = new Set();
  for (const entry of expected.world ?? []) {
    worldBucket.total += 1;
    entities.total += 1;
    const hit = (ledger.worldItems ?? []).find((candidate) => {
      if (usedWorld.has(candidate)) return false;
      const text = `${candidate.name} ${candidate.description}`;
      return (entry?.keywords ?? []).every((group) =>
        (Array.isArray(group) ? group : [group]).some((word) =>
          text.includes(word)
        )
      );
    });
    if (hit) {
      usedWorld.add(hit);
      worldBucket.found += 1;
      entities.found += 1;
    } else {
      missed.push({ kind: "世界観", name: textOf(entry?.label) });
    }
  }
  entities.byKind["世界観"] = worldBucket;

  /* ── でっち上げ（出てはいけないものが出た） ── */
  /** @type {{ count: number, items: Array<{ kind: string, name: string, alias?: string }> }} */
  const fabricated = { count: 0, items: [] };
  const forbidden = answers?.mustNotAppear ?? {};
  for (const [kind, label] of SETTINGS_NAMED_KINDS) {
    for (const name of forbidden[kind] ?? []) {
      const key = normalizeEntityName(name);
      for (const record of ledger[kind] ?? []) {
        if (normalizeEntityName(record.name) !== key) continue;
        fabricated.count += 1;
        fabricated.items.push({ kind: label, name: record.name });
        usedByKind.get(kind)?.add(record);
      }
    }
  }
  // 一般語を別名にしたもの（「お子さま」「執事」）。**どの人物に付いたかを残す**
  for (const alias of forbidden.aliases ?? []) {
    const key = normalizeEntityName(alias);
    for (const record of ledger.characters ?? []) {
      if (!(record.aliases ?? []).some((a) => normalizeEntityName(a) === key)) {
        continue;
      }
      fabricated.count += 1;
      fabricated.items.push({ kind: "別名", name: record.name, alias });
    }
  }

  /* ── 誤って統合した組 ── */
  const wrongMerge = { count: 0, total: 0, items: [] };
  for (const pair of answers?.mustStaySeparate ?? []) {
    wrongMerge.total += 1;
    const forms = (pair?.names ?? []).map((name) => {
      const entry = (expected.characters ?? []).find(
        (item) => textOf(item?.name) === name
      );
      return entry ? entityFormsOf(entry) : [normalizeEntityName(name)];
    });
    if (forms.length < 2) continue;
    const merged = (ledger.characters ?? []).find((record) => {
      const own = recordFormsOf(record);
      return forms.every((group) => group.some((form) => own.includes(form)));
    });
    if (merged) {
      wrongMerge.count += 1;
      wrongMerge.items.push({
        names: pair?.names ?? [],
        mergedInto: merged.name,
        aliases: merged.aliases,
      });
    }
  }

  /* ── 誤って分けた組 ── */
  const wrongSplit = { count: 0, total: 0, items: [] };
  for (const entry of answers?.mustMerge ?? []) {
    wrongSplit.total += 1;
    const main = normalizeEntityName(entry?.name);
    const split = (ledger.characters ?? []).filter((record) => {
      const own = normalizeEntityName(record.name);
      if (own === main) return false;
      return (entry?.forms ?? []).some(
        (form) => normalizeEntityName(form) === own
      );
    });
    if (split.length > 0) {
      wrongSplit.count += 1;
      wrongSplit.items.push({
        name: textOf(entry?.name),
        splitInto: split.map((record) => record.name),
      });
    }
  }

  /* ── でっち上げの関係（本文に無い血縁など） ── */
  const relations = { count: 0, items: [] };
  for (const rule of answers?.forbiddenRelations ?? []) {
    const [left, right] = rule?.between ?? [];
    const formsOf = (name) => {
      const entry = (expected.characters ?? []).find(
        (item) => textOf(item?.name) === name
      );
      return entry ? entityFormsOf(entry) : [normalizeEntityName(name)];
    };
    const sides = [
      [formsOf(left), formsOf(right), right],
      [formsOf(right), formsOf(left), left],
    ];
    for (const [ownForms, otherForms, otherName] of sides) {
      for (const record of ledger.characters ?? []) {
        if (!recordFormsOf(record).some((form) => ownForms.includes(form))) {
          continue;
        }
        for (const relation of record.relations ?? []) {
          if (!otherForms.includes(normalizeEntityName(relation.name))) continue;
          const word = (rule?.words ?? []).find((item) =>
            relation.relation.includes(item)
          );
          if (!word) continue;
          relations.count += 1;
          relations.items.push({
            from: record.name,
            to: otherName,
            relation: relation.relation,
          });
        }
      }
    }
  }

  /* ── 能力の総称（罠8） ── */
  const abilityTerm = {
    expected: textOf(answers?.abilityTerm),
    actual: ledger.abilityTerm,
    ok:
      normalizeEntityName(ledger.abilityTerm) ===
      normalizeEntityName(answers?.abilityTerm),
  };

  /* ── 指示文の混入（罠9） ── */
  const ruleLeak = { count: 0, items: [] };
  for (const rule of ledger.rules ?? []) {
    const marker = (answers?.rules?.mustNotContain ?? []).find((word) =>
      rule.includes(word)
    );
    if (!marker) continue;
    ruleLeak.count += 1;
    ruleLeak.items.push({ rule, marker });
  }

  /* ── 仕込み以外のレコード ── */
  const otherRecords = { count: 0, items: [] };
  for (const [kind, label] of SETTINGS_NAMED_KINDS) {
    const used = usedByKind.get(kind) ?? new Set();
    for (const record of ledger[kind] ?? []) {
      if (used.has(record)) continue;
      otherRecords.count += 1;
      otherRecords.items.push({ kind: label, name: record.name });
    }
  }

  return {
    entities,
    missed,
    aliases,
    fabricated,
    wrongMerge,
    wrongSplit,
    relations,
    abilityTerm,
    ruleLeak,
    otherRecords,
    ledger,
  };
}

/**
 * 設定資料の抽出で、件数と落とした理由を数える。
 *
 * **`countGeneric` は使えない。** あちらは `results[].accepted[]` を見るが、
 * 設定資料の返り値は `characters` と `settings` に分かれていて、しかも
 * `settings` はファイルの先頭から積み上がっている（`settingsLedgerOf`）。
 * そのまま通すと、**指摘0件・落とした0件**という何も測っていない数字が出る。
 */
export function countSettingsGeneric(results) {
  const ledger = settingsLedgerOf(results);
  const accepted =
    ledger.characters.length +
    ledger.abilities.length +
    ledger.locations.length +
    ledger.organizations.length +
    ledger.worldItems.length;
  const rejectedReasons = {};
  for (const item of ledger.rejected) {
    rejectedReasons[item.reason] = (rejectedReasons[item.reason] ?? 0) + 1;
  }
  return {
    accepted,
    rejected: ledger.rejected.length,
    rejectedReasons,
    noSuggestion: 0,
    dropped: ledger.dropped,
  };
}

/* ── 指摘の枠（上限）と、枠の抜け道 ──────────────────── */

/**
 * `src/prompts/proofread.ts` から `MAX_ISSUES_PER_1000_CHARS` を読む。
 *
 * **写しを持たない。** `.mjs` からは `.ts` を import できないので、
 * `registeredToolNames()` と同じやり方で**源のファイルから取り出す**。
 * ここに `3` と書いてしまうと、製品の上限を変えたときに測定だけが
 * 古い上限で「満点」を出す。
 */
export function maxIssuesPer1000CharsOf(promptSource) {
  const match = /MAX_ISSUES_PER_1000_CHARS\s*=\s*(\d+)/.exec(
    String(promptSource)
  );
  if (!match) {
    throw new Error(
      "src/prompts/proofread.ts に MAX_ISSUES_PER_1000_CHARS が見つかりません（製品の上限の書き方が変わったなら、数え方も直してください）。"
    );
  }
  return Number(match[1]);
}

/**
 * その字数のチャンクで挙げてよい件数。
 *
 * **`src/prompts/proofread.ts` の `issueBudget()` と同じ式**である。
 * 値（1000字あたり何件か）は `maxIssuesPer1000CharsOf()` で源から読むので
 * 写していないが、**式の形だけはここにある**——`.mjs` から `.ts` を
 * import できないため。**式がずれていないことは
 * `test/unit/measureScoring.test.ts` が製品の `issueBudget()` と
 * 突き合わせて確かめる**（表だけでは、こちらの思い込みが残る）。
 */
export function issueBudgetOf(chars, perThousand) {
  // 短いチャンクでも1件は挙げられるようにする（製品と同じ）
  return Math.max(1, Math.round(((Number(chars) || 0) / 1000) * perThousand));
}

/**
 * そのチャンクたちの上限の合計（＝**そのモデルが出せる指摘の最大数**）。
 *
 * **これを出さないと、点数を読み違える。** 2026-09-18 に さくらの31Bが
 * 「当て字7/8・ひらくべき5/10」＝ちょうど12語を当てたのを、
 * 「ひらくべき語は半分しか拾えない」と読んだ。実際は12件の枠を
 * 使い切っていて、**それ以上は出しようがなかった**。
 *
 * @param plans `[{ chunkId, chars, maxIssues }]`。`maxIssues` があれば
 *   **製品（`novel.prompt`）がそのチャンクへ渡した枠そのもの**なので優先する。
 *   無ければ `chars` と `perThousand` から同じ式で出す
 * @returns 1つも分からなければ null（分からないものを 0 と出さない）
 */
export function budgetCeilingOf(plans, perThousand) {
  let total = 0;
  let known = 0;
  for (const plan of plans ?? []) {
    const given = Number(plan?.maxIssues);
    if (Number.isFinite(given) && given > 0) {
      total += given;
      known += 1;
      continue;
    }
    const chars = Number(plan?.chars);
    if (!Number.isFinite(chars) || !Number.isFinite(Number(perThousand))) {
      continue;
    }
    total += issueBudgetOf(chars, Number(perThousand));
    known += 1;
  }
  return known > 0 ? total : null;
}

/**
 * 台に仕込んである語の数（当て字＋ひらくべき語）。**分母ではなく分子の天井**
 * を読むために要る——仕込みが上限を超えていれば、満点は取れない。
 */
export function seededWordCount(answers) {
  let total = 0;
  for (const episode of answers?.episodes ?? []) {
    for (const item of [
      ...(episode?.ateji ?? []),
      ...(episode?.mustOpen ?? []),
    ]) {
      total += Number(item?.count) || 0;
    }
  }
  return total;
}

/**
 * **1件に複数語を詰めた指摘**を数える。
 *
 * `original` に「然し、諦めるにはまだ早いでしょう。あなたなら出来ることを」と
 * 2語まとめて書くと、**1件の枠で2語ぶん当たる**。実測で Opus は12件中4件を
 * 詰めて、12件の枠で16語を当てた。素直に1語1件で答えるモデルほど損をするので、
 * **点数と並べて出さないと比べられない**。
 *
 * 数えるのは「漢字ひらき」の札だけ（答え合わせがその札しか見ないため）。
 * **同じ語が2回出ても1語**と数える——枠を回避できるのは、別の語が
 * 2つ以上入っているときだけである。
 */
export function countPackedItems(answers, results) {
  const byFile = acceptedByFile(results);
  const examples = [];
  let count = 0;

  for (const episode of answers?.episodes ?? []) {
    const file = normalizePath(episode?.file ?? "");
    const words = [...(episode?.ateji ?? []), ...(episode?.mustOpen ?? [])]
      .map((item) => textOf(item?.word))
      .filter((word) => word !== "");
    const issues = (byFile.get(file) ?? []).filter(
      (issue) => issue?.reason === KANJI_REASON
    );
    for (const issue of issues) {
      const original = textOf(issue?.original);
      const hit = new Set(words.filter((word) => original.includes(word)));
      if (hit.size < 2) continue;
      count += 1;
      examples.push({ file, original, words: [...hit] });
    }
  }

  return { count, examples };
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
 * @param run `{ results, failures, elapsedMs, plans, maxIssuesPer1000Chars }`。
 *   `plans` は測ったチャンクの `{ chunkId, chars, maxIssues }`（`novel.prompt`
 *   が返すもの）。**あれば指摘の上限を出す**——無ければ上限の行は出さない
 *
 * `detail` は**機能ごとに中身が入れ替わる袋**なので、鍵を並べ切らずに
 * 「名前→中身」の表として返す。どの機能でも必ず入る2つ（落とした理由・失敗）と、
 * 名前で引いて確かめている2つだけを、形まで書いてある。
 *
 * @returns {{
 *   metrics: Record<string, number>,
 *   detail: {
 *     rejectedReasons: Record<string, number>,
 *     failures: Array<{ chunkId?: string, reason?: string }>,
 *     packedItems?: Array<{ file: string, original: string, words: string[] }>,
 *     settingsFound?: Record<string, FoundTotal>,
 *     [key: string]: unknown,
 *   },
 * }}
 */
export function metricsOfRun(feature, answers, run) {
  const results = run?.results ?? [];
  const failures = run?.failures ?? [];
  /*
    **設定資料の抽出だけ、返り値の形が違う**（`countSettingsGeneric`）。
    `countGeneric` を通すと、何件出ていても「指摘0件・落とした0件」になる。
  */
  const generic =
    feature === "settings"
      ? countSettingsGeneric(results)
      : countGeneric(results);

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

    /*
      **枠と抜け道を、点数と一緒に出す。** どちらも書かないと、
      「12/18 までしか行けない台」で測った 12 を満点と読み違えるし、
      2語まとめて答えたモデルの 16 を素直なモデルの 12 と並べてしまう。
    */
    metrics.seededWords = seededWordCount(answers);
    const ceiling = budgetCeilingOf(run?.plans, run?.maxIssuesPer1000Chars);
    if (ceiling !== null) metrics.budgetCeiling = ceiling;
    const packed = countPackedItems(answers, results);
    metrics.packedItems = packed.count;
    detail.packedItems = packed.examples;
  }

  /*
    **誤字脱字（P-09）。** この作品でいちばん重い失敗が起きた場所である
    （64件中62件が素通り）。**拾えた数と、でっち上げた数を必ず並べる**——
    片方だけ見ると、**何も指摘しない実装が満点**になる。
  */
  if (feature === "typo" && answers) {
    const scored = scoreTypo(answers, results);
    metrics.typoFound = scored.seeds.found;
    metrics.typoFoundTotal = scored.seeds.total;
    metrics.typoMissed = scored.seeds.total - scored.seeds.found;
    metrics.typoWrongFix = scored.wrongFix.count;
    metrics.typoFalsePositives = scored.falsePositives.count;
    metrics.typoOtherFlags = scored.otherFlags;

    detail.typoFound = scored.seeds.byKind;
    detail.typoMissed = scored.missed;
    detail.typoWrongFix = scored.wrongFix.items;
    detail.typoFalsePositives = scored.falsePositives.items;
    detail.typoFalsePositivesByWord = scored.falsePositives.byWord;
    detail.typoFalsePositivesByKind = scored.falsePositives.byKind;
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
    **指標の名前を逸脱と分ける。** 見出し（`LABELS`）は指標の名前から引くので、
    同じ `seeded` を使い回すと、矛盾を測っても「仕込んだ逸脱を拾えた」と出る。
  */
  if (CONTRADICTION_FEATURES.includes(feature) && answers) {
    const scored = scoreContradiction(answers, results);
    metrics.seededContradictions = scored.seeds.found;
    metrics.seededContradictionsTotal = scored.seeds.total;
    metrics.missedContradictions = scored.seeds.total - scored.seeds.found;
    metrics.falseFlagsContradiction = scored.falsePositives.count;
    metrics.categoryMismatch = scored.kindMismatch;
    metrics.otherFlagsContradiction = scored.otherFlags;
    detail.seededContradictions = scored.seeds.byKind;
    detail.missedContradictions = scored.missed;
    detail.falseFlagsContradiction = scored.falsePositives.byFile;
  }

  /*
    **設定資料の抽出（P-04a）。** 拾えた数だけを出さない——抽出は
    「何も出さない」が満点にならない代わりに、**「でっち上げる」が
    見えなくなる**。でっち上げ・誤統合・誤分割を必ず隣に並べる。
  */
  if (feature === "settings" && answers) {
    const scored = scoreSettings(answers, results);
    metrics.settingsFound = scored.entities.found;
    metrics.settingsFoundTotal = scored.entities.total;
    metrics.settingsMissed = scored.entities.total - scored.entities.found;
    metrics.settingsAliases = scored.aliases.found;
    metrics.settingsAliasesTotal = scored.aliases.total;
    metrics.settingsFabricated = scored.fabricated.count;
    metrics.settingsWrongMerge = scored.wrongMerge.count;
    metrics.settingsWrongMergeTotal = scored.wrongMerge.total;
    metrics.settingsWrongSplit = scored.wrongSplit.count;
    metrics.settingsWrongSplitTotal = scored.wrongSplit.total;
    metrics.settingsFakeRelations = scored.relations.count;
    // **0か1で出す。** 合っているかどうかしか無い（罠8）
    metrics.settingsAbilityTerm = scored.abilityTerm.ok ? 1 : 0;
    metrics.settingsRuleLeak = scored.ruleLeak.count;
    metrics.settingsOtherRecords = scored.otherRecords.count;

    detail.settingsFound = scored.entities.byKind;
    detail.settingsMissed = scored.missed;
    detail.settingsAliasesMissed = scored.aliases.missed;
    detail.settingsFabricated = scored.fabricated.items;
    detail.settingsWrongMerge = scored.wrongMerge.items;
    detail.settingsWrongSplit = scored.wrongSplit.items;
    detail.settingsFakeRelations = scored.relations.items;
    detail.settingsAbilityTerm = scored.abilityTerm;
    detail.settingsRuleLeak = scored.ruleLeak.items;
    detail.settingsOtherRecords = scored.otherRecords.items;

    /*
      **黙って落とした別名も数に出す**（`droppedSharedFamilyNameAliases` など）。
      罠1・罠2の見張りが働いたかは、ここの数にしか現れない——0件のまま
      誤統合が起きていれば、**見張りが素通りした**ということである。
    */
    for (const [kind, count] of Object.entries(generic.dropped ?? {})) {
      if (count > 0) metrics[`dropped.${kind}`] = count;
    }
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
 *
 * @param {Array<{ metrics?: Record<string, number | undefined> }>} runs
 *   回ごとに出る指標が違うので、値が欠けている（`undefined`）ことを型でも認める
 *   ——欠けた回を 0 として数えるのが、この関数の仕事そのものである
 * @returns {Record<string, { values: number[], min: number, max: number }>}
 *   指標の名前は機能ごとに増えるので、鍵を並べずに「名前→幅」の表として返す。
 */
export function spreadOfRuns(runs) {
  /** @type {Set<string>} */
  const keys = new Set();
  for (const run of runs) {
    for (const key of Object.keys(run?.metrics ?? {})) keys.add(key);
  }
  /** @type {Record<string, { values: number[], min: number, max: number }>} */
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
  budgetCeiling: "指摘の上限",
  // 上限が分からなかったときだけ、単独の行として出る
  seededWords: "仕込み（当て字＋ひらくべき語）",
  packedItems: "1件に複数語を詰めた指摘",
  ateji: "当て字を拾えた",
  mustOpen: "ひらくべき語を拾えた",
  falsePositives: "誤検出（ひらいてはいけない語をひらいた）",
  noSuggestion: "提案なし（漢字ひらきなのに修正案が空）",
  typoFound: "仕込んだ誤字を拾えた（当てると本文が直るもの）",
  typoMissed: "見逃し（拾えなかった仕込み）",
  typoWrongFix: "直し方が違う（場所は当てたが、当てても直らない）",
  typoFalsePositives: "誤検出（罠に付いた指摘。造語・方言・ルビ・正しい同音異義語）",
  typoOtherFlags: "仕込み以外の箇所への指摘",
  seeded: "仕込んだ逸脱を拾えた",
  missed: "見逃し（拾えなかった仕込み）",
  falseFlags: "誤検出（プロットどおりの話に付いた指摘）",
  kindMismatch: "種別ちがい（場所は当てたが 逸脱／間延び を取り違えた）",
  otherFlags: "仕込み以外の箇所への指摘",
  seededContradictions: "仕込んだ矛盾を拾えた",
  missedContradictions: "見逃し（拾えなかった仕込み）",
  falseFlagsContradiction: "誤検出（罠と、矛盾の無い話に付いた指摘）",
  categoryMismatch: "区分ちがい（場所は当てたが 人物／状態／時系列 を取り違えた）",
  otherFlagsContradiction: "仕込み以外の箇所への指摘",
  settingsFound: "出るべきものを拾えた（人物・能力・場所・組織・世界観）",
  settingsMissed: "見逃し（出るべきなのに出なかった）",
  settingsAliases: "あるべき別名を拾えた",
  settingsFabricated: "でっち上げ（出てはいけないものが出た）",
  settingsWrongMerge: "誤って統合した組（別人を1件にまとめた）",
  settingsWrongSplit: "誤って分けた組（同じ人物を別レコードにした）",
  settingsFakeRelations: "でっち上げの関係（本文に無い血縁などを書いた）",
  settingsAbilityTerm: "能力の総称が合っている（1＝合っている）",
  settingsRuleLeak: "指示文の混入（rules にプロンプトの文が入った）",
  settingsOtherRecords: "仕込み以外に出たレコード",
  accepted: "指摘（検算を通ったもの）",
  rejected: "落とした（検算で弾いたもの）",
  failures: "失敗（チャンクごと通らなかったもの）",
  elapsedMs: "所要時間",
};

/** 分母を持つ指標。**「3」ではなく「3/8」と出す** */
const DENOMINATORS = {
  ateji: "atejiTotal",
  mustOpen: "mustOpenTotal",
  typoFound: "typoFoundTotal",
  seeded: "seededTotal",
  seededContradictions: "seededContradictionsTotal",
  settingsFound: "settingsFoundTotal",
  settingsAliases: "settingsAliasesTotal",
  settingsWrongMerge: "settingsWrongMergeTotal",
  settingsWrongSplit: "settingsWrongSplitTotal",
};

/** 分母そのものは行にしない（分子の行に出るため） */
const HIDDEN = new Set(Object.values(DENOMINATORS));

const ORDER = [
  // **上限を先に出す。** これを見ないと、その下の点数の天井が分からない
  "budgetCeiling",
  "seededWords",
  "ateji",
  "mustOpen",
  "falsePositives",
  "packedItems",
  // 誤字脱字。**拾えた → 見逃し → 誤検出**の順に読ませる
  "typoFound",
  "typoMissed",
  "typoWrongFix",
  "typoFalsePositives",
  "typoOtherFlags",
  "seeded",
  "missed",
  "falseFlags",
  "kindMismatch",
  "otherFlags",
  "seededContradictions",
  "missedContradictions",
  "falseFlagsContradiction",
  "categoryMismatch",
  "otherFlagsContradiction",
  // 設定資料の抽出。**拾えた → 見逃し → でっち上げ**の順に読ませる
  "settingsFound",
  "settingsMissed",
  "settingsAliases",
  "settingsFabricated",
  "settingsWrongMerge",
  "settingsWrongSplit",
  "settingsFakeRelations",
  "settingsAbilityTerm",
  "settingsRuleLeak",
  "settingsOtherRecords",
  "noSuggestion",
  "accepted",
  "rejected",
];

/**
 * 検算で落とした理由の日本語。**生の名前も残す**（記録の突き合わせに要る）。
 *
 * 語は製品の `describeRejectedCandidates`（`features/extractCharacters.ts`）と
 * `settingsExtractionValidation.ts` から取った。**ここに無い理由は
 * そのまま出す**——知らない理由を勝手に訳すと、製品が名前を変えたことに
 * 気づけなくなる。
 */
const REJECT_REASON_JA = {
  invalid_shape: "形式不正",
  invalid_name: "名前が不正",
  pronoun_name: "代名詞の名前",
  descriptive_name: "説明的な名前",
  non_person: "人物以外",
  collective: "集団",
  ungrounded: "本文根拠なし",
  not_an_ability: "能力ではない",
  not_a_place: "場所ではない",
  not_worldview: "世界観ではない",
};

export function labelOf(key) {
  if (LABELS[key]) return LABELS[key];
  if (key.startsWith("rejected.")) {
    const reason = key.slice("rejected.".length);
    const japanese = REJECT_REASON_JA[reason];
    return `　└ 落とした理由：${reason}${japanese ? `（${japanese}）` : ""}`;
  }
  // 別名を黙って落とした件数（設定資料の抽出だけ）。見出しは答えの側で日本語
  if (key.startsWith("dropped.")) {
    const what = key.slice("dropped.".length);
    // 関係の検算は別名の話ではない。同じ見出しに混ぜると、記録を読んだとき
    // 「別名を落とした」と取り違える
    return what.endsWith("関係")
      ? `　└ 関係の検算：${what}`
      : `　└ 落とした別名：${what}`;
  }
  return key;
}

/** 表に出す順番。**答え合わせを先、内訳を後ろ**（読む順に合わせる） */
export function orderedKeys(spread) {
  const hidden = new Set(HIDDEN);
  /*
    **仕込みの語数は、上限の行の中に出す**（「12件（仕込みは18語）」）。
    上限が分からないときだけ単独の行にする——上限と並べて初めて
    「満点が取れるか」が読めるので、片方だけ出しても意味が薄い。
  */
  if ("budgetCeiling" in (spread ?? {})) hidden.add("seededWords");
  const keys = Object.keys(spread).filter((key) => !hidden.has(key));
  const rejected = keys.filter((key) => key.startsWith("rejected.")).sort();
  // **落とした別名は、落とした理由のすぐ後ろへ。** どちらも「黙って
  // 捨てなかったこと」の内訳で、離れていると別の話に見える
  const dropped = keys.filter((key) => key.startsWith("dropped.")).sort();
  const rest = keys.filter(
    (key) =>
      !key.startsWith("rejected.") &&
      !key.startsWith("dropped.") &&
      !ORDER.includes(key) &&
      key !== "failures" &&
      key !== "elapsedMs"
  );
  return [
    ...ORDER.filter((key) => keys.includes(key)),
    ...rejected,
    ...dropped,
    ...rest.sort(),
    ...(keys.includes("failures") ? ["failures"] : []),
    ...(keys.includes("elapsedMs") ? ["elapsedMs"] : []),
  ];
}

function formatValue(key, value, spread) {
  if (key === "elapsedMs") return `${(value / 1000).toFixed(1)}秒`;
  /*
    **上限の行に、仕込みの語数を並べて書く。** 「12件」だけでは
    多いのか少ないのか分からず、「18語」だけでは天井が分からない。
  */
  if (key === "budgetCeiling") {
    const seeded = Number(spread?.seededWords?.max);
    return Number.isFinite(seeded) && seeded > 0
      ? `${value}件（仕込みは${seeded}語）`
      : `${value}件`;
  }
  if (key === "seededWords") return `${value}語`;
  if (key === "packedItems") return `${value}件`;
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

/**
 * 数字だけでは読み違える行に添える断り。
 *
 * **測り方の欠陥は、数字の隣に書かないと伝わらない。** 記録を読み返す人は
 * `lines` しか見ないことがあるので、README ではなくここに出す。
 */
export function notesFor(key, spread) {
  const notes = [];

  if (key === "budgetCeiling") {
    const ceiling = Number(spread?.budgetCeiling?.max) || 0;
    const seeded = Number(spread?.seededWords?.max) || 0;
    if (seeded > ceiling) {
      notes.push(
        `　※ 仕込みが上限を超えているので、満点は取れません（上限${ceiling}件に対して仕込み${seeded}語）。`
      );
    }
  }

  if (key === "packedItems") {
    const packed = Number(spread?.packedItems?.max) || 0;
    if (packed > 0) {
      notes.push(
        `　※ 1件に複数語を詰めた指摘が ${packed} 件あります（枠の上限を回避できるため、他のモデルと比べるときは注意）。`
      );
    }
  }

  /*
    **誤字脱字は、片方だけ見ると壊れたまま満点になる。**

    「何も指摘しない実装」は誤検出0で満点に見えるし、「片端から指摘する
    実装」は拾えた数だけなら満点に見える。**両方の断りを数字の隣に置く。**
  */
  if (key === "typoFound") {
    const found = Number(spread?.typoFound?.max) || 0;
    const total = Number(spread?.typoFoundTotal?.max) || 0;
    if (total > 0 && found === 0) {
      notes.push(
        "　※ 1件も拾えていません。誤検出が0でも、これは「動いている」ではありません。"
      );
    }
  }
  if (key === "typoFalsePositives" && (Number(spread?.typoFalsePositives?.max) || 0) > 0) {
    notes.push(
      "　※ 造語・方言・ルビ・正しい同音異義語を直そうとしています。種別ごとの内訳は記録の detail.typoFalsePositivesByKind にあります。"
    );
  }
  if (key === "typoWrongFix" && (Number(spread?.typoWrongFix?.max) || 0) > 0) {
    notes.push(
      "　※ 場所は当てたのに、当てても本文が直らない指摘があります（押しても直らない＝作者の手間だけが増える）。"
    );
  }

  /*
    **設定資料の抽出は、拾えた数だけを見ると読み違える。** 数字の隣に
    断りを置く——記録を読み返す人は `lines` しか見ないことがある。
  */
  if (key === "settingsFabricated" && (Number(spread?.settingsFabricated?.max) || 0) > 0) {
    notes.push(
      "　※ 本文に無いものが資料に載ります。拾えた数が多くても、ここが多ければ使えません。"
    );
  }
  if (key === "settingsWrongMerge" && (Number(spread?.settingsWrongMerge?.max) || 0) > 0) {
    notes.push(
      "　※ 別人が1件に潰れています（罠1・罠2）。誰が誰に吸収されたかは記録の detail.settingsWrongMerge にあります。"
    );
  }
  if (key === "settingsAbilityTerm" && (Number(spread?.settingsAbilityTerm?.min) || 0) === 0) {
    notes.push(
      "　※ 能力の総称が合っていません（罠8）。返ってきた語は記録の detail.settingsAbilityTerm にあります。"
    );
  }
  if (key === "settingsRuleLeak" && (Number(spread?.settingsRuleLeak?.max) || 0) > 0) {
    notes.push(
      "　※ rules にプロンプトの指示文が混ざっています（罠9）。そのまま資料へ載る文言です。"
    );
  }

  return notes;
}

/** 画面に出す行（1指標につき1行、日本語）。断りはその行のすぐ下に置く */
export function formatSpreadLines(spread) {
  const lines = [];
  for (const key of orderedKeys(spread)) {
    lines.push(`${labelOf(key)}: ${formatSpread(key, spread[key], spread)}`);
    for (const note of notesFor(key, spread)) lines.push(note);
  }
  return lines;
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
