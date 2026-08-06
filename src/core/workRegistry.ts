import * as vscode from "vscode";
import * as path from "path";
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
import { hashBytes } from "./textFile";

const STORAGE_KEY = "novelai.works";

/**
 * 登録済み作品の一覧を保持する。
 * 実体は VSCode の globalState（ワークスペースをまたいで保持される）。
 */
export class WorkRegistry {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

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

    await ensureRecoveryIgnoreRule(normalized);

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

/** 既存の作者記述をバイト単位で保ったまま、回復ディレクトリだけ除外する。 */
async function ensureRecoveryIgnoreRule(folderPath: string): Promise<void> {
  const gitignorePath = path.join(folderPath, ".gitignore");
  const uri = vscode.Uri.file(gitignorePath);
  let existing: Uint8Array;
  try {
    existing = await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") {
      throw error;
    }
    await atomicWriteFile(
      gitignorePath,
      new TextEncoder().encode(".novelai-recovery/\n"),
      { mode: "create" }
    );
    return;
  }

  const text = new TextDecoder().decode(existing);
  if (text.split(/\r\n|\n|\r/).some((line) => line.trim() === ".novelai-recovery/")) {
    return;
  }

  const eol = text.includes("\r\n") ? "\r\n" : text.includes("\r") ? "\r" : "\n";
  const separator = text.length === 0 || /(?:\r\n|\n|\r)$/.test(text) ? "" : eol;
  const addition = new TextEncoder().encode(`${separator}.novelai-recovery/${eol}`);
  const next = new Uint8Array(existing.length + addition.length);
  next.set(existing);
  next.set(addition, existing.length);
  await atomicWriteFile(gitignorePath, next, {
    mode: "replace",
    expectedHash: hashBytes(existing),
  });
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
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${key} は作品フォルダ内の相対パスにしてください。`);
  }
  return resolved;
}

/** .aiwriter/config.json を読む。無ければ undefined */
export async function readWorkConfig(
  work: WorkEntry
): Promise<WorkConfig | undefined> {
  const uri = vscode.Uri.file(workPaths(work).configFile);
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
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(p.aiwriter));
  const body = JSON.stringify(validated, null, 2);
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(p.configFile),
    new TextEncoder().encode(body)
  );
}

/** 作品フォルダの初期構造を作成する */
export async function scaffoldWorkFolder(
  folderPath: string,
  title: string
): Promise<void> {
  const fs = vscode.workspace.fs;
  try {
    await fs.stat(vscode.Uri.file(folderPath));
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
    await fs.createDirectory(vscode.Uri.file(d));
  }

  const config: WorkConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    workTitle: title,
    manuscriptDir: DEFAULT_MANUSCRIPT_DIR,
    settingsDir: DEFAULT_SETTINGS_DIR,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(
    vscode.Uri.file(path.join(folderPath, AIWRITER_DIR, CONFIG_FILE)),
    new TextEncoder().encode(JSON.stringify(config, null, 2))
  );

  // .gitignore（キャッシュと出力物を同期対象から外す）
  const gitignore = [
    "# 小説AI執筆補助が生成する作業ファイル",
    ".aiwriter/cache/",
    ".aiwriter/logs/",
    ".aiwriter/exports/",
    ".novelai-recovery/",
    "",
    "# 設定資料の出力物（再生成可能なため）",
    "exports/",
    "",
  ].join("\n");
  await writeIfAbsent(path.join(folderPath, ".gitignore"), gitignore);

  // プロットの初期テンプレート
  const plotTemplate = [
    `# ${title}`,
    "",
    "## タイトル",
    "",
    "## ログライン",
    "<!-- 誰が / どんな状況で / 何を目指し / 何が障害か を一文で -->",
    "",
    "## テーマ",
    "",
    "## モチーフ",
    "",
    "## 世界観",
    "",
    "## 舞台",
    "",
    "## 人称",
    "<!-- 一人称 / 三人称一元 / 三人称多元 -->",
    "",
    "## 主人公の行動原理",
    "",
    "## あらすじ",
    "- ",
    "",
    "## 主要登場人物",
    "- ",
    "",
  ].join("\n");
  await writeIfAbsent(
    path.join(folderPath, DEFAULT_SETTINGS_DIR, "plot.md"),
    plotTemplate
  );
}

async function writeIfAbsent(filePath: string, content: string): Promise<void> {
  const uri = vscode.Uri.file(filePath);
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
