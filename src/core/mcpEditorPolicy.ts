import type { FeatureName } from "./mcpFeatures";
import type { RunFeature } from "./runRequest";

/**
 * 編集者モードの作品で、MCP の道具のどれを許すか（設計書6.87.25・5.6.5。
 * 作者の指示 2026-10-31「MCPサーバの穴ふさぎは実行してください」）。
 *
 * 画面の `EDITOR_ALLOWED`（`editorMode.ts`）と同じく、**許すものを並べる**。
 * 新しい道具は、ここへ足すまで編集者には開かない（表に無い名前は断る）。
 * 道具の一覧と表がずれたら `test/unit/cross/mcpEditorPolicy.test.ts` が落ちる。
 *
 * 許すのは「読むだけ」「AIを走らせて答えを返すだけ」「提案パネルへ指摘を置く」。
 * 断るのは、作品のファイル（本文・設定資料・承認待ち・台帳の案・書き出し・索引など）を
 * 書くもの。**迷ったものは断る側**に置き、理由を `why` に書く。
 *
 * `.aiwriter/cache/` のチャンクの控えと、保管庫（機械の中）への記録は「書く」に数えない
 * ——作り直せる控えで、同期もされず、作者の原稿でも資料でもない。ただし控えのうち
 * **保存の道（novel.extract.commit・novel.synopsis.commit）の材料になる貯め（stash）**は、
 * 保存の道を断る以上貯めても使い道が無いので断る。
 *
 * VS Code にも Node にも依存しない（MCP の束と拡張機能の両方から読む）。
 */

type Args = Readonly<Record<string, unknown>>;

export interface McpEditorRule {
  /** 許すか。引数で分かれる道具は関数で決める */
  readonly allow: boolean | ((args: Args) => boolean);
  /** なぜそう決めたか（設計書と報告にそのまま使う） */
  readonly why: string;
}

/**
 * novel.run・novel.validate の feature ごとの判定。
 * **`Record<FeatureName, …>` なので、機能を足すと型検査がここへ足すまで通らない。**
 */
export const EDITOR_FEATURE_RULES: Readonly<
  Record<FeatureName, { readonly run: boolean; readonly validate: boolean; readonly why: string }>
> = {
  typo: { run: true, validate: true, why: "校正。編集部の仕事そのもの" },
  proofread: { run: true, validate: true, why: "推敲の指摘。答えを返すだけ" },
  notation: { run: true, validate: true, why: "表記ゆれ。答えを返すだけ" },
  contradiction: { run: true, validate: true, why: "矛盾の指摘。答えを返すだけ" },
  factContradiction: {
    run: false,
    validate: true,
    why: "novel.run は移動の照合の距離の案を .aiwriter/pending-settings/（同期される承認待ち）へ書く。validate は返すだけ",
  },
  foreshadow: { run: true, validate: true, why: "伏線の指摘。答えを返すだけ" },
  deviation: { run: true, validate: true, why: "逸脱の指摘。答えを返すだけ" },
  episodePlot: { run: true, validate: true, why: "単話プロットの緩みの指摘。答えを返すだけ" },
  episodePlotContrast: { run: true, validate: true, why: "単話プロットとの照合。答えを返すだけ" },
  settings: {
    run: false,
    validate: true,
    why: "novel.run（runner: sampling）は抽出の答えを貯める（保存の道の材料）。validate は stash が無ければ返すだけ",
  },
  settingsEnrich: { run: true, validate: true, why: "案を返すだけ（置くのは novel.propose で、それは断る）" },
  synopsis: { run: true, validate: true, why: "生成して返すだけ（保存の novel.synopsis.commit は断る）" },
  plotReverse: { run: true, validate: true, why: "生成して返すだけ" },
  chapter: { run: true, validate: true, why: "章立ての案を返すだけ（置くのは novel.propose で、それは断る）" },
  blurb: { run: true, validate: true, why: "生成して返すだけ（保存の novel.synopsis.commit は断る）" },
  catchphrase: { run: true, validate: true, why: "生成して返すだけ" },
  announce: {
    run: false,
    validate: false,
    why: "検算を通った告知文を .aiwriter/cache/announcements.json の履歴へ足す。告知は作者の広報で、編集部の仕事ではない",
  },
  opening: { run: true, validate: true, why: "冒頭診断。答えを返すだけ" },
  name: { run: true, validate: true, why: "名前の紛らわしさ。答えを返すだけ" },
  chat: { run: true, validate: true, why: "相談。答えを返すだけ（助言方針の控えは保管庫で、作品の外）" },
};

/**
 * run.request の feature ごとの判定。拡張機能（作者の VS Code の設定のAI）が走らせる。
 * **`Record<RunFeature, …>` なので、足すと型検査がここへ足すまで通らない。**
 */
export const EDITOR_RUN_REQUEST_RULES: Readonly<
  Record<RunFeature, { readonly allow: boolean; readonly why: string }>
> = {
  typo: { allow: true, why: "校正。結果は保管庫の札にだけ置く" },
  proofread: { allow: true, why: "推敲の指摘。結果を返すだけ" },
  contradiction: { allow: true, why: "矛盾の指摘。結果を返すだけ" },
  foreshadow: { allow: true, why: "伏線の指摘。結果を返すだけ" },
  deviation: { allow: true, why: "逸脱の指摘。結果を返すだけ" },
  synopsis: { allow: true, why: "生成して返すだけ（保存はしない）" },
  opening: { allow: true, why: "冒頭診断。結果を返すだけ" },
  factContradiction: {
    allow: false,
    why: "拡張機能の事実の照合は、距離の案を承認待ち（.aiwriter/pending-settings/）へ置く",
  },
  settings: {
    allow: false,
    why: "抽出の答えを .aiwriter/cache/external-extract.json へ貯める（保存の道の材料。保存の道は断る）",
  },
  vectorIndex: {
    allow: false,
    why: "検索用の索引を .aiwriter/cache/vector/ へ書き、scope: all ならほかの作品にも書く。画面の編集者モードでも開いていない",
  },
  coverBake: { allow: false, why: "設定/書籍/表紙_合成済み.png を置き換える（設定資料のフォルダーに書く）" },
  testAI: { allow: true, why: "AIへ短い文を1回送るだけで、本文も作品のファイルも触らない" },
  exportPdf: { allow: false, why: ".aiwriter/exports/ へ新しいファイルを作る。画面の編集者モードでも書き出しは開いていない" },
  exportEpub: { allow: false, why: ".aiwriter/exports/ へ新しいファイルを作る。画面の編集者モードでも書き出しは開いていない" },
};

function stashed(args: Args): boolean {
  return args.stash === true;
}

function featureRule(args: Args): (typeof EDITOR_FEATURE_RULES)[FeatureName] | undefined {
  const feature = args.feature;
  return typeof feature === "string" && Object.prototype.hasOwnProperty.call(EDITOR_FEATURE_RULES, feature)
    ? EDITOR_FEATURE_RULES[feature as FeatureName]
    : undefined;
}

/** setup.request のうち、編集用の写しでは断る段 */
const SETUP_STEPS_DENIED_FOR_EDITOR: readonly string[] = ["external-access", "register", "create"];

const READ_ONLY = "読むだけ";
const NO_FOLDER = "folder を取らないので作品の印では判定できない（作品のファイルを書かない）";

/**
 * 道具ごとの判定。**名前は `src/mcp/server.ts` の `registerTool` と同じ綴り。**
 */
export const MCP_EDITOR_POLICY: Readonly<Record<string, McpEditorRule>> = {
  "mcp.version": { allow: true, why: NO_FOLDER },
  "windows.list": { allow: true, why: NO_FOLDER },
  "notices.recent": { allow: true, why: NO_FOLDER },
  "works.list": { allow: true, why: NO_FOLDER },
  "ai.settings": { allow: true, why: NO_FOLDER },
  "guide.spotlight": {
    allow: true,
    why: "光らせる頼みを .aiwriter/history/spotlight.jsonl（外から触られた記録と同じ所）へ1行足すだけ。押すのは人で、原稿にも資料にも触らない",
  },
  "setup.request": {
    // 作品は `path` で受ける（守りはそれを作品として読む。`editorGuard.ts`）
    allow: (args) => !SETUP_STEPS_DENIED_FOR_EDITOR.includes(String(args.step)),
    why:
      "作品は path で受ける。外部AIの許可（external-access）・登録（register）・作成（create）は、" +
      "押すのは人でも作品の印や登録簿を変える段なので断る。Ollama・AI設定などの段は作品に触らないので許す" +
      "（path の無い create は作品を指さないので印では判定できない）",
  },
  "ollama.generate": { allow: true, why: "手元のAIへ投げて返すだけ" },
  "ollama.models": { allow: true, why: READ_ONLY },
  "novel.scan": { allow: true, why: READ_ONLY },
  "novel.prompt": { allow: true, why: "プロンプトを組んで返すだけ（貯めた答えを読むことはあるが書かない）" },
  "novel.detect": { allow: true, why: "コードで探して返すだけ" },
  "novel.material": { allow: true, why: READ_ONLY },
  "novel.notice": { allow: true, why: READ_ONLY },
  "novel.search": { allow: true, why: READ_ONLY },
  "novel.read": { allow: true, why: READ_ONLY },
  "pending.list": { allow: true, why: READ_ONLY },
  "outbox.pack": { allow: true, why: "読むだけ（期限の日数は数えるのに使い、何も消さない）" },
  "cover.ink": { allow: true, why: READ_ONLY },
  "run.result": { allow: true, why: "保管庫の結果を読むだけ" },
  "schedule.milestones": {
    allow: true,
    why: "読むだけ（folders を複数取り、folder を取らないので作品の印では判定しない）",
  },
  "novel.validate": {
    allow: (args) => !stashed(args) && (featureRule(args)?.validate ?? false),
    why: "検算して返すだけ。stash: true（保存の道の材料を貯める）と、告知（履歴へ足す）は断る",
  },
  "novel.run": {
    allow: (args) => !stashed(args) && (featureRule(args)?.run ?? false),
    why: "AIを走らせて返すだけ。stash: true と、作品へ書く feature（事実の照合・抽出・告知）は断る",
  },
  "novel.propose": {
    allow: (args) => args.kind === "finding",
    why: "kind: finding（提案パネルへ指摘を置く）は編集部の仕事そのもの。設定資料の案・章立て・伏線・予定の案は断る",
  },
  "run.request": {
    allow: (args) => {
      const feature = args.feature;
      return (
        typeof feature === "string" &&
        Object.prototype.hasOwnProperty.call(EDITOR_RUN_REQUEST_RULES, feature) &&
        EDITOR_RUN_REQUEST_RULES[feature as RunFeature].allow
      );
    },
    why: "結果を返すだけの機能は許す。作品へ書く機能（抽出・事実の照合・索引・表紙・書き出し）は断る",
  },
  "novel.extract.commit": { allow: false, why: "新しい記録を 設定/ へ保存し、承認待ちへも置く（dryRun も道具ごと断る）" },
  "novel.synopsis.commit": { allow: false, why: "設定/chapter_synopses.json・synopsis.md を書く（dryRun も道具ごと断る）" },
  "outbox.import": { allow: false, why: "本文・メモ・採否を作品へ書き込む" },
};

/** 編集者モードの作品で、その呼び出しを許すか。**表に無い道具は断る** */
export function isMcpToolAllowedForEditor(tool: string, args: unknown): boolean {
  if (!Object.prototype.hasOwnProperty.call(MCP_EDITOR_POLICY, tool)) return false;
  const rule = MCP_EDITOR_POLICY[tool].allow;
  if (typeof rule === "boolean") return rule;
  const record =
    typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Args) : {};
  return rule(record);
}
