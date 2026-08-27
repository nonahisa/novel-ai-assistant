import * as vscode from "vscode";
import * as path from "./paths";
import { sha1Text } from "./hash";
import { WorkEntry } from "../models/types";
import { atomicWriteFile } from "./atomicWrite";
import { workPaths } from "./workRegistry";

export interface CacheKeyBase {
  feature: string;
  promptVersion: string;
  /**
   * どのAIサービスで処理したか（`ollama` / `lmstudio` / `claude` …）。
   *
   * **モデル名だけでは足りない**（設計書6.28.7）。Ollama と LM Studio は
   * 同じ重みを同じ名前（`gemma4:e4b` など）で持てるので、モデル名だけを
   * 鍵にすると**別のプロバイダで作った結果を再利用してしまう**。
   */
  providerId: string;
  model: string;
}

interface CacheEntry {
  key: string;
  createdAt: string;
  value: unknown;
}

/**
 * チャンク単位の処理結果キャッシュ。
 *
 * 一度処理した内容を再処理しないための仕組み。
 * キーには内容ハッシュに加えてプロンプトversionとモデル名を含める。
 * 異なるモデルで生成された結果は品質が揃わないため再利用しない。
 */
export class ChunkCache {
  private entries = new Map<string, CacheEntry>();
  private dirty = false;

  constructor(private readonly work: WorkEntry) {}

  private async filePath(): Promise<string> {
    const p = workPaths(this.work);
    return path.join(p.aiwriter, "cache", "chunks.json");
  }

  async load(): Promise<void> {
    this.entries.clear();
    this.dirty = false;
    const file = await this.filePath();
    try {
      const bytes = await vscode.workspace.fs.readFile(
        path.toUri(file)
      );
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        if (isCacheEntry(entry)) {
          this.entries.set(entry.key, entry);
        }
      }
    } catch {
      // キャッシュは失われても再生成できるため、読めなくても続行する
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const file = await this.filePath();
    await vscode.workspace.fs.createDirectory(
      path.toUri(path.dirname(file))
    );
    const body = JSON.stringify([...this.entries.values()], null, 0);
    await atomicWriteFile(file, new TextEncoder().encode(body));
    this.dirty = false;
  }

  get(chunkHash: string, base: CacheKeyBase): unknown | undefined {
    return this.entries.get(makeKey(chunkHash, base))?.value;
  }

  async set(
    chunkHash: string,
    base: CacheKeyBase,
    value: unknown
  ): Promise<void> {
    const key = makeKey(chunkHash, base);
    this.entries.set(key, {
      key,
      createdAt: new Date().toISOString(),
      value,
    });
    this.dirty = true;
  }

  /** 特定機能のキャッシュを破棄する */
  clearFeature(feature: string): void {
    for (const [key, entry] of [...this.entries]) {
      if (entry.key.startsWith(`${feature}:`)) {
        this.entries.delete(key);
        this.dirty = true;
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.key === "string" &&
    typeof entry.createdAt === "string" &&
    isValidIsoDate(entry.createdAt) &&
    "value" in entry
  );
}

function isValidIsoDate(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value
    );
  if (!match) {
    return false;
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);

  // Date.parse は 2 月 30 日を翌月へ繰り上げるため、暦日を先に検証する。
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  const days = [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * 鍵を組み立てる。
 *
 * **プロバイダIDを足したので、既存のキャッシュは一度すべて作り直しになる**
 * （鍵の文字列が変わるため。設計書6.28.7が「機能別割当と同じ版で行う」と
 * 決めたのは、飛ぶ回数を1回にまとめるためである）。無料AIなら時間だけ、
 * 有料AIなら処理し直したぶんの費用がかかる。
 */
function makeKey(chunkHash: string, base: CacheKeyBase): string {
  const digest = sha1Text(
    `${base.promptVersion}|${base.providerId}|${base.model}|${chunkHash}`
  ).slice(0, 24);
  return `${base.feature}:${digest}`;
}
