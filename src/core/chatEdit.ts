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
 * 2. **作者が押したときだけ書く。** AIが会話の流れで勝手に書くと、
 *    どこが変わったのか追えなくなる。提案として見せ、押されたら適用する。
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

  const label =
    typeof raw.label === "string" && raw.label.trim()
      ? raw.label.trim()
      : describeChatEditTarget(target);

  return { ok: true, edit: { target, content, label } };
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

export function describeChatEditTarget(target: ChatEditTarget): string {
  switch (target.kind) {
    case "plot":
      return `プロットの「${PLOT_LABELS.get(target.section) ?? target.section}」に書き込む`;
    case "blurb":
      return "作品紹介文に書き込む";
    case "catchphrase":
      return "キャッチコピーに書き込む";
    case "episodeSynopsis":
      return `第${target.chapter}話のあらすじに書き込む`;
  }
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
  | "checkNotation";

export interface ChatRun {
  kind: ChatRunKind;
  /** ボタンに出す説明 */
  label: string;
  /** AIを呼ぶ（＝料金がかかる）操作か */
  usesAI: boolean;
}

const RUNNABLE: ReadonlyMap<string, Omit<ChatRun, "kind">> = new Map([
  ["checktypos", { label: "誤字脱字を検知する", usesAI: true }],
  [
    "checktyposforfile",
    { label: "この話の誤字脱字を検知する", usesAI: true },
  ],
  ["checknotation", { label: "表記ゆれを検知する", usesAI: false }],
]);

/** 起動したい機能の指定を、許可した一覧と突き合わせる */
export function parseChatRun(raw: unknown): ChatRun | undefined {
  const key = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!key) return undefined;

  const found = RUNNABLE.get(key);
  if (!found) return undefined;

  // Map のキーは小文字に潰しているので、種別は元の綴りへ戻す
  const kind = (
    {
      checktypos: "checkTypos",
      checktyposforfile: "checkTyposForFile",
      checknotation: "checkNotation",
    } as Record<string, ChatRunKind>
  )[key];

  return { kind, label: found.label, usesAI: found.usesAI };
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
