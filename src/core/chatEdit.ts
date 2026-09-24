import { PLOT_SECTIONS, type PlotSectionKey } from "./plotDoc";

/**
 * 相談パネルからの加筆修正（P-21の`edit`）の解釈。
 *
 * 作者から「小説本文以外、プロットやあらすじや設定資料集の加筆修正を、
 * chat画面から行うことを許可」された（2026-08-15）。ただし次の2つは
 * 許可の有無に関わらず守る。
 *
 * 1. **本文（原稿）は絶対に書き換えない。** 許可の対象外であり、
 *    書き換えるならハッシュ照合を含む専用の経路（`textFile.ts`）が要る。
 * 2. **頼まれていない書き込みはしない。** 2026-09-21の裁定までは
 *    「作者が押したときだけ書く」だったが、頼んだ作業をもう一度訊かれるのは
 *    意味が無いという指摘を受け、**頼まれた書き込みはその場で行う**形にした
 *    （設計書6.4.7）。**歯止めは「頼まれたときしか `edit` を付けない」**
 *    （`prompts/workChat.ts`）と、**書いたあとに取り消せること**が担う。
 *    ここ（解釈の関門）の役目は変わらない——本文を弾き、上限を超えたら捨てる。
 *
 * **書き込み先は「真実の在り処」であって、読み物のMarkdownではない。**
 * `characters.md` などはJSONから毎回作り直される生成物なので、そこへ
 * 書いても次の生成で消える。この対応を間違えると、作者は「保存したのに
 * 消えた」という一番たちの悪い壊れ方に出会う。
 *
 * VS Code APIに依存しない。
 */

export type ChatEditTarget =
  /** プロットの項目（設定/plot.md） */
  | { kind: "plot"; section: PlotSectionKey }
  /** 作品紹介文（設定/synopsis.md） */
  | { kind: "blurb" }
  /** キャッチコピー（設定/synopsis.md） */
  | { kind: "catchphrase" }
  /** 各話あらすじ（設定/chapter_synopses.json） */
  | { kind: "episodeSynopsis"; chapter: number };

export interface ChatEdit {
  target: ChatEditTarget;
  content: string;
  /** ボタンに出す説明。AIが付けなければこちらで組み立てる */
  label: string;
}

export type ChatEditRejection =
  | "unknown_target"
  | "manuscript_not_allowed"
  | "empty_content"
  | "too_long";

/** 1回の書き込みで受け付ける上限。丸ごと差し替えを防ぐ意味もある */
const MAX_CONTENT_CHARS = 4_000;

const PLOT_KEYS = new Set<string>(PLOT_SECTIONS.map((section) => section.key));

const PLOT_LABELS = new Map<string, string>(
  PLOT_SECTIONS.map((section) => [section.key, section.heading])
);

/**
 * AIが返した編集指示を解釈する。
 *
 * 受け付ける `target` の書き方：
 * - `plot.theme` のようにプロットの項目
 * - `blurb` / `catchphrase`
 * - `episode.7` のように話数を添えた各話あらすじ
 */
export function parseChatEdit(
  raw: unknown
): { ok: true; edit: ChatEdit } | { ok: false; reason: ChatEditRejection } {
  if (!isRecord(raw)) return { ok: false, reason: "unknown_target" };

  const targetText =
    typeof raw.target === "string" ? raw.target.trim().toLowerCase() : "";
  const content = typeof raw.content === "string" ? raw.content.trim() : "";

  if (!content) return { ok: false, reason: "empty_content" };
  if (content.length > MAX_CONTENT_CHARS) return { ok: false, reason: "too_long" };

  // 本文を名指しされたら、はっきり断る（黙って無視すると原因が分からない）
  if (
    targetText.startsWith("manuscript") ||
    targetText.startsWith("episodebody") ||
    targetText.startsWith("本文")
  ) {
    return { ok: false, reason: "manuscript_not_allowed" };
  }

  const target = parseTarget(targetText);
  if (!target) return { ok: false, reason: "unknown_target" };

  /*
    **見出しはAIの言葉を信じない**（作者の指摘、2026-09-07）。

    実機では「テーマの明確化」というAIの `label` のままボタンが出ており、
    押すと `設定/plot.md` の「テーマ」が書き換わった。**どのファイルの
    どこが変わるのかが、押す前に読み取れない。** 書き込み先はこちらが
    知っているのだから、こちらが名乗る。AIの言葉は補足として括弧で添える
    （何のつもりの提案かは、それはそれで手掛かりになる）。
  */
  const note = typeof raw.label === "string" ? raw.label.trim() : "";
  const label = describeChatEditButton(target, note);

  return { ok: true, edit: { target, content, label } };
}

/**
 * 書き込み先を「ファイルと項目名」で言う。
 *
 * 作者の作品ファイルへ書く操作なので、**押す前にどこが変わるかが
 * 一目で分かる形にする。**
 */
export function describeChatEditDestination(target: ChatEditTarget): {
  /** 作品フォルダーからの位置。作者が普段見ている呼び方に合わせる */
  file: string;
  /** その中のどこか */
  item: string;
} {
  switch (target.kind) {
    case "plot":
      return {
        file: "設定/plot.md",
        item: PLOT_LABELS.get(target.section) ?? target.section,
      };
    case "blurb":
      return { file: "設定/synopsis.md", item: "作品紹介文" };
    case "catchphrase":
      return { file: "設定/synopsis.md", item: "キャッチコピー" };
    case "episodeSynopsis":
      return {
        file: "設定/chapter_synopses.json",
        item: `第${target.chapter}話のあらすじ`,
      };
  }
}

/** ボタンの見出し。`note` はAIが付けた説明（あれば括弧で添える） */
export function describeChatEditButton(
  target: ChatEditTarget,
  note = ""
): string {
  const where = describeChatEditDestination(target);
  const head = `${where.file} の「${where.item}」を書き換える`;
  // AIの言葉をそのまま繰り返すだけなら添えない（同じ文が二度出る）
  return note && note !== head ? `${head}（${note}）` : head;
}

function parseTarget(text: string): ChatEditTarget | undefined {
  if (text === "blurb") return { kind: "blurb" };
  if (text === "catchphrase") return { kind: "catchphrase" };

  const [head, tail] = splitOnce(text, ".");

  if (head === "plot" && tail && PLOT_KEYS.has(tail)) {
    return { kind: "plot", section: tail as PlotSectionKey };
  }

  if (head === "episode" && tail) {
    const chapter = Number(tail);
    if (Number.isSafeInteger(chapter) && chapter > 0) {
      return { kind: "episodeSynopsis", chapter };
    }
  }

  return undefined;
}

export function describeChatEditRejection(reason: ChatEditRejection): string {
  switch (reason) {
    case "manuscript_not_allowed":
      return "本文（原稿）はこの画面から書き換えられません。誤字脱字の指摘から適用してください。";
    case "unknown_target":
      return "書き込み先を特定できませんでした。";
    case "empty_content":
      return "書き込む内容が空でした。";
    case "too_long":
      return `一度に書き込める長さ（${MAX_CONTENT_CHARS}字）を超えています。`;
  }
}

/**
 * 相談パネルから起動してよい標準機能。
 *
 * 作者から「誤字脱字や表記ゆれのチェックを頼まれた場合は、承諾制で
 * chat画面側から標準機能を起動することを許可」された（2026-08-15）。
 *
 * **AIが任意のコマンドを実行できる作りにはしない。** ここに並べたものだけを
 * 起動できる。AIが返した文字列をそのまま `executeCommand` へ渡すと、
 * 作品の削除やファイルの上書きを含むあらゆる操作が、会話の一言で
 * 動かせるようになってしまう。
 */
export type ChatRunKind =
  /** 誤字脱字を検知（作品全体） */
  | "checkTypos"
  /** 誤字脱字を検知（いま開いている話だけ） */
  | "checkTyposForFile"
  /** 表記ゆれを検知 */
  | "checkNotation"
  /** 推敲（冗長・同語反復・係り受け・長文） */
  | "checkProofread"
  /** プロットからの逸脱・間延びを検知 */
  | "checkDeviations"
  /** 設定資料と本文の矛盾を検知 */
  | "checkContradictions"
  /** 設定資料をまとめて抽出 */
  | "extractSettings"
  /** 種別を絞った抽出 */
  | "extractCharacters"
  | "extractLocations"
  | "extractAbilities"
  | "extractOrganizations"
  | "extractWorld"
  /** 設定資料集のMarkdownを出力 */
  | "generateSettingsDocs"
  /** 設定資料集を開く */
  | "openSettingsPanel"
  /** 重複した人物をまとめる */
  | "unifyCharacters"
  /** 承認待ちの更新を反映 */
  | "applyPendingUpdates"
  /** 各話あらすじ */
  | "generateSynopses"
  /** 作品紹介文 */
  | "generateWorkBlurb"
  /** キャッチコピー案 */
  | "generateCatchphrases"
  /** 紹介文・あらすじを開く */
  | "openSynopsisDocs"
  /** 本文からプロットを逆算 */
  | "generatePlot"
  /** 応募先をAIに提案してもらう（隠し機能。設計書6.3.6.5） */
  | "suggestContests";

export interface ChatRun {
  kind: ChatRunKind;
  /** ボタンに出す説明 */
  label: string;
  /** AIを呼ぶ（＝料金がかかる）操作か */
  usesAI: boolean;
}

/**
 * 起動できる機能の一覧。
 *
 * **AIが提案しそうな操作を載せておく。** 載っていない操作を提案されると、
 * 作者は「やります」と言われたのに何も起きない画面を見ることになる
 * （実機で「資料抽出→設定資料集を出力」を勧められたが起動できなかった）。
 *
 * **それでも任意のコマンドは実行させない。** ここに並べたものだけである。
 * とくに**消す操作・作品の登録を変える操作は入れない。**
 * 会話の一言でファイルが消えては取り返しがつかない。
 */
const RUNNABLE: ReadonlyMap<string, { kind: ChatRunKind } & Omit<ChatRun, "kind">> =
  new Map(
    (
      [
        // 校正・校閲
        ["checkTypos", "誤字脱字を検知する", true],
        ["checkTyposForFile", "この話の誤字脱字を検知する", true],
        ["checkNotation", "表記ゆれを検知する", false],
        ["checkProofread", "推敲する", true],
        ["checkContradictions", "設定と本文の矛盾を検知する", true],
        ["checkDeviations", "プロットからの逸脱を検知する", true],
        // 資料をためる
        ["extractSettings", "設定資料をまとめて抽出する", true],
        ["extractCharacters", "登場人物を抽出する", true],
        ["extractLocations", "場所を抽出する", true],
        ["extractAbilities", "能力を抽出する", true],
        ["extractOrganizations", "組織を抽出する", true],
        ["extractWorld", "世界観を抽出する", true],
        ["generateSettingsDocs", "設定資料集を出力する", false],
        ["openSettingsPanel", "設定資料集を開く", false],
        ["unifyCharacters", "重複した人物をまとめる", false],
        ["applyPendingUpdates", "承認待ちの更新を反映する", false],
        // 整える
        ["generateSynopses", "各話あらすじを作る", true],
        ["generateWorkBlurb", "作品紹介文を作る", true],
        ["generateCatchphrases", "キャッチコピー案を作る", true],
        ["openSynopsisDocs", "紹介文・あらすじを開く", false],
        // メニューは「本文からプロットを逆算」。ここは相談の中で押す札なので、
        // この表の言い回し（「〜する」）に揃えたまま、比喩だけ名前に合わせる
        ["generatePlot", "本文からプロットを逆算する", true],
        // 応募先（設計書6.3.6.5）。**詳細メニューに無い隠し機能**で、入口は相談と
        // コマンドパレットだけ（作者の裁定、2026-09-23）
        ["suggestContests", "応募先をAIに提案してもらう", true],
      ] as Array<[ChatRunKind, string, boolean]>
    ).map(([kind, label, usesAI]) => [
      kind.toLowerCase(),
      { kind, label, usesAI },
    ])
  );

/**
 * 起動できる機能を、そのまま並べて返す。
 *
 * 大きい相談パネルの「できること」に出すために使う。**画面側に一覧を
 * 書き写さない。** 写すと、機能を足したときに片方だけ古くなり、
 * しかも押しても何も起きないボタンとしてしか現れない
 * （`runnableFeatureList` がAIに対して同じ理由で存在する）。
 */
export function runnableFeatures(): ChatRun[] {
  return [...RUNNABLE.values()].map((item) => ({ ...item }));
}

/** AIに見せる、起動できる機能の一覧。プロンプトと実装を食い違わせないため */
export function runnableFeatureList(): string {
  return [...RUNNABLE.values()]
    .map((item) => `- ${item.kind}: ${item.label}${item.usesAI ? "（AIを使う）" : ""}`)
    .join("\n");
}

/** 起動したい機能の指定を、許可した一覧と突き合わせる */
export function parseChatRun(raw: unknown): ChatRun | undefined {
  const key = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!key) return undefined;

  const found = RUNNABLE.get(key);
  if (!found) return undefined;

  return { kind: found.kind, label: found.label, usesAI: found.usesAI };
}

/**
 * 「この箇所を見せて」の指示。
 *
 * 作者から「会話内容に応じて開いている画面の変更」と
 * 「会話の中の該当箇所をハイライト」を求められた（2026-08-15）。
 * ファイルを開くことと箇所を光らせることは、作者から見れば
 * 「そこを見せて」という1つの動きなので、1つの指示にまとめている。
 *
 * `path` を省けば「いま開いているファイルの中の、この箇所」。
 * `text` を省けば「このファイルを開くだけ」。
 */
export interface ChatLocate {
  /** 作品フォルダーからの相対パス。省略時はいま開いているファイル */
  path?: string;
  /** 光らせたい箇所の原文（逐語）。省略するとファイルを開くだけ */
  text?: string;
  label: string;
}

export function parseChatLocate(raw: unknown): ChatLocate | undefined {
  if (!isRecord(raw)) return undefined;

  const rawPath = typeof raw.path === "string" ? raw.path.trim() : "";
  // パスの安全確認は読み込みと同じ関門を通す。
  // ここを緩めると、作品の外のファイルを開かせられる
  const path = rawPath ? sanitizeRequestedPaths([rawPath], 1)[0] : undefined;
  if (rawPath && !path) return undefined;

  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!path && !text) return undefined;

  const label =
    typeof raw.label === "string" && raw.label.trim()
      ? raw.label.trim()
      : text
        ? "該当箇所を開く"
        : `${path} を開く`;

  return { path, text: text || undefined, label };
}

function splitOnce(text: string, separator: string): [string, string | undefined] {
  const at = text.indexOf(separator);
  if (at === -1) return [text, undefined];
  return [text.slice(0, at), text.slice(at + separator.length)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * AIが読みたがったファイルの指定を、安全なものだけに絞る。
 *
 * 作者から「必要に応じて小説一覧に登録されたフォルダ内のファイルに
 * アクセスすることを許可」された。**登録された作品フォルダの中だけ**に
 * 限る必要がある。`..` を含む指定や絶対パスを弾かないと、
 * 作品の外のファイルを読み出せてしまう。
 */
export function sanitizeRequestedPaths(
  raw: unknown,
  maxFiles: number
): string[] {
  if (!Array.isArray(raw)) return [];
  const cleaned: string[] = [];

  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const value = entry.trim().replace(/\\/g, "/");
    if (!value) continue;

    // 絶対パス・ドライブ指定・親への遡りは受け付けない
    if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) continue;
    if (value.split("/").some((part) => part === "..")) continue;
    // 拡張機能の作業用フォルダは読ませない（キャッシュ・ログ・APIキーの痕跡）
    if (value.startsWith(".aiwriter/") || value.startsWith(".novelai-recovery/")) {
      continue;
    }

    if (cleaned.includes(value)) continue;
    cleaned.push(value);
    if (cleaned.length >= maxFiles) break;
  }

  return cleaned;
}

/** 拡張子違いの引き当てを行う原稿の拡張子。作品の本文はこの2つで書かれる */
const MANUSCRIPT_EXTENSIONS = [".txt", ".md"];

/**
 * 求められたファイルが無いとき、同じフォルダーで拡張子だけ違う原稿を探す。
 *
 * 実データの測定（2026-09-24）で、AIが `episode_0001.txt` を求めたのに
 * 実物は `episode_0001.md` だった。AIはファイル名を当て推量で書くことがあり、
 * 拡張子は特に取り違えやすい。
 *
 * **引き当てるのは候補がちょうど1つのときだけ。** 2つ以上あるとどれを
 * 求めたのか決められず、当て推量で別の話を読ませると、違う話についての
 * 答えが返る（実装ルール3：AIの出力を信用しない）。名前の一部が似ている
 * だけのもの（`episode_00010`）は候補にしない。
 *
 * - `requested`：`sanitizeRequestedPaths` を通した相対パス（`/` 区切り）
 * - `siblingNames`：同じフォルダーにあるファイルの名前
 * - 戻り値：読むべき相対パス。引き当てられなければ `undefined`
 *
 * 拡張子の無い指定（`episode_0001`）も、候補が1つなら引き当てる。
 * 原稿でない拡張子（`.json` など）は引き当てない——設定のJSONを求められて
 * 同名のMarkdown（生成物）を渡すのは別物になる。
 */
export function findExtensionVariant(
  requested: string,
  siblingNames: readonly string[]
): string | undefined {
  const normalized = requested.replace(/\\/g, "/");
  // 外へ出る指定には答えない。絞り込みで落ちているはずだが、
  // この関数だけを使う呼び出し側が現れても外を指さないように
  if (normalized.split("/").some((part) => part === "..")) return undefined;

  const slash = normalized.lastIndexOf("/");
  const folder = slash >= 0 ? normalized.slice(0, slash + 1) : "";
  const base = normalized.slice(slash + 1);
  const { stem, ext } = splitExtension(base);
  if (!stem) return undefined;
  if (ext && !MANUSCRIPT_EXTENSIONS.includes(ext.toLowerCase())) {
    return undefined;
  }

  const candidates = new Set<string>();
  for (const name of siblingNames) {
    if (name === base) continue;
    const other = splitExtension(name);
    if (other.stem !== stem) continue;
    const otherExt = other.ext.toLowerCase();
    if (!MANUSCRIPT_EXTENSIONS.includes(otherExt)) continue;
    if (otherExt === ext.toLowerCase()) continue;
    candidates.add(name);
  }

  if (candidates.size !== 1) return undefined;
  const [only] = candidates;
  return folder + only;
}

function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  // 先頭の点（`.gitignore`）は拡張子ではない
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** 見つからなかったときにAIへ示す、作品にあるファイルの候補 */
export interface FileHint {
  /** 作品フォルダーからの相対パス（`/` 区切り） */
  path: string;
  /** 「第1話 出会い」のような表示名 */
  label: string;
}

/**
 * 求められたファイルが見つからなかったとき、代わりに示す候補を選ぶ。
 *
 * **求められた名前と同じ番号を持つものを先に並べる。** AIは
 * `episode_0015.txt` のように番号で求めることが多く、目次の先頭だけを
 * 見せると肝心の話が入らない（219話の作品もある）。番号が当たらなければ
 * 先頭から並べる。上限で切るので、送る量は作品の大きさに比例しない。
 */
export function pickFileHints(
  missing: readonly string[],
  available: readonly FileHint[],
  limit: number
): FileHint[] {
  const wantedNumbers = new Set(missing.flatMap(numbersIn));
  const matched = available.filter((hint) =>
    numbersIn(hint.path).some((value) => wantedNumbers.has(value))
  );
  const rest = available.filter((hint) => !matched.includes(hint));
  return [...matched, ...rest].slice(0, Math.max(0, limit));
}

/** ファイル名に含まれる数（`episode_0015.md` なら 15）。フォルダー名は見ない */
function numbersIn(location: string): number[] {
  const base = location.slice(location.replace(/\\/g, "/").lastIndexOf("/") + 1);
  return (base.match(/\d+/g) ?? []).map(Number);
}
