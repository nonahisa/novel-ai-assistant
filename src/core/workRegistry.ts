import * as vscode from "vscode";
import * as path from "./paths";
import { isWebRuntime } from "./runtime";
import {
  AIWRITER_DIR,
  CONFIG_FILE,
  CONFIG_SCHEMA_VERSION,
  DEFAULT_MANUSCRIPT_DIR,
  DEFAULT_SETTINGS_DIR,
  WorkConfig,
  WorkEntry,
} from "../models/types";
import { atomicWriteFile } from "./atomicWrite";
import { buildPlotTemplate } from "./plotTemplate";
import { canRegisterWork, describeWorkLimit } from "./editorMode";
import { currentMode } from "./actorContext";

const STORAGE_KEY = "novelai.works";

/**
 * 登録済み作品の一覧を保持する。
 * 実体は VSCode の globalState（ワークスペースをまたいで保持される）。
 */
export class WorkRegistry {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** 旧版ですでに登録済みの作品にも、起動時の安全な冪等migrationを適用する。 */
  async initialize(): Promise<void> {
    const failedTitles: string[] = [];
    // キャッシュを同期するかは設定で変えられる。起動のたびに突き合わせ、
    // 切り替えられていれば `.gitignore` へ打ち消し行を足す（設計書5.5.7）
    const syncCache = isCacheSyncEnabled();
    for (const work of this.list()) {
      try {
        await ensureRecoveryIgnoreRule(work.folderPath, { syncCache });
      } catch {
        // 作品登録や起動を壊さず、次回起動でも同じmigrationを再試行する。
        failedTitles.push(work.title);
      }
    }
    if (failedTitles.length > 0) {
      await vscode.window.showWarningMessage(
        `回復ファイルの除外設定を更新できない作品があります。次回起動時に再試行します: ${failedTitles.join("、")}`
      );
    }
  }

  list(): WorkEntry[] {
    const raw = this.context.globalState.get<WorkEntry[]>(STORAGE_KEY, []);
    // 登録順ではなくタイトル順で安定表示する
    return [...raw].sort((a, b) => a.title.localeCompare(b.title, "ja"));
  }

  get(id: string): WorkEntry | undefined {
    return this.list().find((w) => w.id === id);
  }

  private async save(works: WorkEntry[]): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, works);
    this._onDidChange.fire();
  }

  /**
   * 編集者モードの上限に引っかかっていないか（設計書5.7.4）。
   *
   * **登録の入口をここ1か所にまとめる。** `add` と `addExisting` の
   * どちらからでも通るので、片方だけ塞いで素通りする、が起きない。
   */
  private blockedByEditorLimit(works: WorkEntry[]): boolean {
    if (canRegisterWork(currentMode(), works.length)) return false;
    void vscode.window.showWarningMessage(
      describeWorkLimit(works[0]?.title ?? "登録済みの作品")
    );
    return true;
  }

  /** 既存フォルダを作品として登録する */
  async add(folderPath: string, title?: string): Promise<WorkEntry | undefined> {
    const works = this.context.globalState.get<WorkEntry[]>(STORAGE_KEY, []);
    const normalized = path.normalize(folderPath);

    if (works.some((w) => path.normalize(w.folderPath) === normalized)) {
      vscode.window.showWarningMessage(
        "このフォルダはすでに作品として登録されています。"
      );
      return undefined;
    }
    if (this.blockedByEditorLimit(works)) return undefined;

    const entry: WorkEntry = {
      id: `work_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      title: title ?? path.basename(normalized),
      folderPath: normalized,
      registeredAt: new Date().toISOString(),
    };

    await this.save([...works, entry]);
    return entry;
  }

  /** 既存作品の設定を検証・必要なら作成してから登録する。 */
  async addExisting(
    folderPath: string,
    title?: string
  ): Promise<WorkEntry | undefined> {
    const works = this.context.globalState.get<WorkEntry[]>(STORAGE_KEY, []);
    const normalized = path.normalize(folderPath);
    if (works.some((w) => path.normalize(w.folderPath) === normalized)) {
      vscode.window.showWarningMessage(
        "このフォルダはすでに作品として登録されています。"
      );
      return undefined;
    }
    if (this.blockedByEditorLimit(works)) return undefined;

    const entry: WorkEntry = {
      id: `work_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      title: title ?? path.basename(normalized),
      folderPath: normalized,
      registeredAt: new Date().toISOString(),
    };

    const existing = await readWorkConfig(entry);
    if (!existing) {
      await writeWorkConfig(entry, {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        workTitle: entry.title,
        manuscriptDir: DEFAULT_MANUSCRIPT_DIR,
        settingsDir: DEFAULT_SETTINGS_DIR,
        createdAt: entry.registeredAt,
      });
    }

    // **`.gitignore` の整備で登録を失敗させない。**
    //
    // ここは「作業ファイルをGitに入れない」ための後始末であって、
    // 作品を登録するのに要るものではない。以前は失敗をそのまま投げており、
    // **設定ファイル（`.aiwriter/config.json`）だけが作られて登録簿には
    // 入らない**という中途半端な状態になっていた（作者のブラウザ版で、
    // 5作品すべてがこの形になった。2026-08-22）。
    //
    // 起動時の `initialize()` は最初からこれを失敗しても続ける作りに
    // してあり、次の起動でもう一度試される。ここも同じ扱いに揃える。
    try {
      await ensureRecoveryIgnoreRule(normalized, {
        syncCache: isCacheSyncEnabled(),
      });
    } catch (error) {
      void vscode.window.showWarningMessage(
        `「${entry.title}」を登録しました。ただし .gitignore を整えられませんでした` +
          `（作業ファイルがGitに入るかもしれません）: ${
            error instanceof Error ? error.message : String(error)
          }`
      );
    }

    await this.save([...works, entry]);
    return entry;
  }

  /** 登録を解除する（フォルダ本体は削除しない） */
  async remove(id: string): Promise<void> {
    const works = this.context.globalState.get<WorkEntry[]>(STORAGE_KEY, []);
    await this.save(works.filter((w) => w.id !== id));
  }

  refresh(): void {
    this._onDidChange.fire();
  }
}

/**
 * 同期対象から外すべきもの。
 *
 * 新規作成時のひな形と、既存フォルダーを登録したときの追記で同じものを使う。
 * 以前は登録時に `.novelai-recovery/` しか追記しておらず、
 * **キャッシュがGitに入ったままだった**（設計書5.5.7と食い違っていた）。
 */
export const IGNORED_PATHS = [
  ".aiwriter/cache/",
  ".aiwriter/logs/",
  ".aiwriter/exports/",
  ".novelai-recovery/",
  "exports/",
] as const;

/** キャッシュの除外規則と、それを打ち消す規則（設計書5.5.7） */
export const CACHE_IGNORE_RULE = ".aiwriter/cache/";
export const CACHE_UNIGNORE_RULE = "!.aiwriter/cache/";

/** 設定でキャッシュを同期するか。既定は同期しない（設計書5.5.7） */
export function isCacheSyncEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<boolean>("git.syncCache", false);
}

/**
 * `.gitignore` の中で、キャッシュについて**最後に**書かれている指示を返す。
 *
 * gitの除外規則は後に書いたものが勝つ。`.gitignore` は追記しかできない
 * （作者の記述をバイト単位で保つため）ので、切り替えは
 * 「打ち消す行を足す」「もう一度除外する行を足す」で行う。
 * したがって判断材料になるのは**最後の1行だけ**である。
 */
export function lastCacheDirective(
  bytes: Uint8Array
): typeof CACHE_IGNORE_RULE | typeof CACHE_UNIGNORE_RULE | undefined {
  const lines = new TextDecoder()
    .decode(bytes)
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim());

  let found: typeof CACHE_IGNORE_RULE | typeof CACHE_UNIGNORE_RULE | undefined;
  for (const line of lines) {
    if (line === CACHE_IGNORE_RULE) found = CACHE_IGNORE_RULE;
    else if (line === CACHE_UNIGNORE_RULE) found = CACHE_UNIGNORE_RULE;
  }
  return found;
}

/**
 * 既存の作者記述をバイト単位で保ったまま、足りない除外規則だけを追記する。
 *
 * 承認待ちの更新案（`.aiwriter/pending-characters/`）と設定資料・IME辞書は
 * わざと除外しない。作者の判断待ちや読み物であり、別の環境でも見たいため。
 */
async function ensureRecoveryIgnoreRule(
  folderPath: string,
  options: { syncCache?: boolean } = {}
): Promise<void> {
  const gitignorePath = path.join(folderPath, ".gitignore");
  const uri = path.toUri(gitignorePath);
  let existing: Uint8Array;
  try {
    existing = await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") {
      throw error;
    }
    const initial = missingIgnoreRules(new Uint8Array(), options);
    await atomicWriteFile(
      gitignorePath,
      new TextEncoder().encode(`${initial.join("\n")}\n`),
      { mode: "create" }
    );
    return;
  }

  const text = new TextDecoder().decode(existing);
  const missing = missingIgnoreRules(existing, options);
  if (missing.length === 0) {
    return;
  }

  const eol = text.includes("\r\n") ? "\r\n" : text.includes("\r") ? "\r" : "\n";
  const separator = text.length === 0 || /(?:\r\n|\n|\r)$/.test(text) ? "" : eol;
  const addition = new TextEncoder().encode(
    `${separator}${missing.join(eol)}${eol}`
  );
  await appendBytes(gitignorePath, uri, addition);

  const migrated = await vscode.workspace.fs.readFile(uri);
  if (
    migrated.length < existing.length ||
    !sameBytes(migrated.subarray(0, existing.length), existing) ||
    missingIgnoreRules(migrated, options).length > 0
  ) {
    throw new Error(".gitignore の作者記述を保持したmigrationを確認できませんでした。");
  }
}

/**
 * `.gitignore` の末尾へ、渡されたバイト列だけを足す。
 *
 * **手元では `O_APPEND` の一回の追記だけを使う。** OSが保証する
 * 「既存バイトを絶対に置換・切り詰めしない」という性質を頼りにしている。
 *
 * **ブラウザ版のVS Code（vscode.dev）には `node:fs` が無い。** 読み直して
 * から書き直す形で代える。`vscode.workspace.fs` に追記の仕組みは無く、
 * ブラウザの仮想ファイルシステム（GitHubへの都度の書き込みなど）は
 * そもそも「OSレベルの追記」に相当する強い保証を持たない。**呼び出し元は
 * 書き込み後に中身を読み直して壊れていないか確かめている**ので、
 * どちらの経路でも安全側には倒れる。
 */
async function appendBytes(
  filePath: string,
  uri: vscode.Uri,
  addition: Uint8Array
): Promise<void> {
  if (isWebRuntime()) {
    const before = await vscode.workspace.fs.readFile(uri);
    const combined = new Uint8Array(before.length + addition.length);
    combined.set(before);
    combined.set(addition, before.length);
    await vscode.workspace.fs.writeFile(uri, combined);
    return;
  }

  const { open } = await import("node:fs/promises");
  const handle = await open(filePath, "a");
  try {
    let offset = 0;
    while (offset < addition.length) {
      const result = await handle.write(
        addition,
        offset,
        addition.length - offset,
        null
      );
      if (result.bytesWritten === 0) {
        throw new Error(".gitignore への追記が完了しませんでした。");
      }
      offset += result.bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * まだ書かれていない除外規則を返す。既にあるものは重ねて足さない。
 *
 * キャッシュだけは「同期する／しない」を切り替えられる（設計書5.5.7）ので、
 * 有無ではなく**最後に書かれている指示**で判断する。
 */
export function missingIgnoreRules(
  bytes: Uint8Array,
  options: { syncCache?: boolean } = {}
): string[] {
  const written = new Set(
    new TextDecoder()
      .decode(bytes)
      .split(/\r\n|\n|\r/)
      .map((line) => line.trim())
  );
  const syncCache = options.syncCache ?? false;
  const current = lastCacheDirective(bytes);

  const additions: string[] = [];
  for (const rule of IGNORED_PATHS) {
    if (rule === CACHE_IGNORE_RULE) {
      if (syncCache) {
        // 同期したいのに除外されている場合だけ打ち消す。
        // もともと何も書かれていなければ足す必要はない
        if (current === CACHE_IGNORE_RULE) additions.push(CACHE_UNIGNORE_RULE);
      } else if (current !== CACHE_IGNORE_RULE) {
        // 未記載でも、打ち消し済みでも、除外し直す
        additions.push(CACHE_IGNORE_RULE);
      }
      continue;
    }
    if (!written.has(rule)) additions.push(rule);
  }
  return additions;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}

/** 作品フォルダの各種パスを解決する */
export function workPaths(work: WorkEntry, config?: WorkConfig) {
  const manuscriptDir = config?.manuscriptDir ?? DEFAULT_MANUSCRIPT_DIR;
  const settingsDir = config?.settingsDir ?? DEFAULT_SETTINGS_DIR;
  return {
    root: work.folderPath,
    manuscript: resolveInsideWork(work.folderPath, manuscriptDir, "manuscriptDir"),
    settings: resolveInsideWork(work.folderPath, settingsDir, "settingsDir"),
    aiwriter: path.join(work.folderPath, AIWRITER_DIR),
    configFile: path.join(work.folderPath, AIWRITER_DIR, CONFIG_FILE),
  };
}

/** JSONから読み込んだ作品設定を実行時に検証する */
export function parseWorkConfig(raw: unknown): WorkConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("作品設定はJSONオブジェクトである必要があります。");
  }
  const value = raw as Record<string, unknown>;
  const required = [
    "schemaVersion",
    "workTitle",
    "manuscriptDir",
    "settingsDir",
    "createdAt",
  ] as const;

  for (const key of required) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0) {
      throw new Error(`作品設定の ${key} は空でない文字列にしてください。`);
    }
  }

  return {
    schemaVersion: (value.schemaVersion as string).trim(),
    workTitle: (value.workTitle as string).trim(),
    manuscriptDir: (value.manuscriptDir as string).trim(),
    settingsDir: (value.settingsDir as string).trim(),
    createdAt: (value.createdAt as string).trim(),
  };
}

function resolveInsideWork(root: string, subdir: string, key: string): string {
  if (path.isAbsolute(subdir)) {
    throw new Error(`${key} は作品フォルダ内の相対パスにしてください。`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, subdir);
  const relative = path.relative(resolvedRoot, resolved);
  if (path.goesOutside(resolvedRoot, relative)) {
    throw new Error(`${key} は作品フォルダ内の相対パスにしてください。`);
  }
  return resolved;
}

/** .aiwriter/config.json を読む。無ければ undefined */
export async function readWorkConfig(
  work: WorkEntry
): Promise<WorkConfig | undefined> {
  const uri = path.toUri(workPaths(work).configFile);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const config = parseWorkConfig(raw);
    workPaths(work, config);
    return config;
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
      return undefined;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`作品設定を読み込めません: ${detail}`);
  }
}

/** .aiwriter/config.json を書き込む */
export async function writeWorkConfig(
  work: WorkEntry,
  config: WorkConfig
): Promise<void> {
  const validated = parseWorkConfig(config);
  workPaths(work, validated);
  const p = workPaths(work);
  await vscode.workspace.fs.createDirectory(path.toUri(p.aiwriter));
  const body = JSON.stringify(validated, null, 2);
  await vscode.workspace.fs.writeFile(
    path.toUri(p.configFile),
    new TextEncoder().encode(body)
  );
}

/**
 * 作品フォルダの初期構造を作成する。
 *
 * @param options.withPlot プロットのテンプレート（`設定/plot.md`）を置くか。
 *   **書きながら考える作者もいる。** 使わないテンプレートを置くと、
 *   見出しだけのファイルが設定資料に混ざり、紹介文を作るときの材料にも
 *   空のプロットとして渡ってしまう。あとから「プロットをつくる」で足せる。
 */
export async function scaffoldWorkFolder(
  folderPath: string,
  title: string,
  options: { withPlot?: boolean } = {}
): Promise<void> {
  const fs = vscode.workspace.fs;
  try {
    await fs.stat(path.toUri(folderPath));
    throw new Error(
      `「${folderPath}」はすでに存在します。既存のファイルを保護するため作成を中止しました。`
    );
  } catch (error) {
    if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") {
      throw error;
    }
  }

  const dirs = [
    folderPath,
    path.join(folderPath, DEFAULT_MANUSCRIPT_DIR),
    path.join(folderPath, DEFAULT_SETTINGS_DIR),
    path.join(folderPath, DEFAULT_SETTINGS_DIR, "icons"),
    path.join(folderPath, AIWRITER_DIR),
  ];
  for (const d of dirs) {
    await fs.createDirectory(path.toUri(d));
  }

  const config: WorkConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    workTitle: title,
    manuscriptDir: DEFAULT_MANUSCRIPT_DIR,
    settingsDir: DEFAULT_SETTINGS_DIR,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.toUri(path.join(folderPath, AIWRITER_DIR, CONFIG_FILE)),
    new TextEncoder().encode(JSON.stringify(config, null, 2))
  );

  // .gitignore（キャッシュと作業ファイルを同期対象から外す）。
  // 設定資料・IME辞書・承認待ちの更新案は、別の環境でも見たいので除外しない。
  // キャッシュだけは設定で同期できる（設計書5.5.7）
  const gitignore = [
    "# 小説AI執筆補助が生成する作業ファイル（再生成できるため同期しない）",
    ...missingIgnoreRules(new Uint8Array(), { syncCache: isCacheSyncEnabled() }),
    "",
  ].join("\n");
  await writeIfAbsent(path.join(folderPath, ".gitignore"), gitignore);

  // プロットの初期テンプレート。要らないと言われたら置かない
  if (options.withPlot ?? true) {
    await writeIfAbsent(
      path.join(folderPath, DEFAULT_SETTINGS_DIR, PLOT_FILE),
      buildPlotTemplate(title)
    );
  }
}

/** プロットのファイル名。設定フォルダーの直下に置く */
export const PLOT_FILE = "plot.md";

async function writeIfAbsent(filePath: string, content: string): Promise<void> {
  const uri = path.toUri(filePath);
  try {
    await vscode.workspace.fs.stat(uri);
    return; // すでに存在するので触らない
  } catch {
    await vscode.workspace.fs.writeFile(
      uri,
      new TextEncoder().encode(content)
    );
  }
}
