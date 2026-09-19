import { sha1Text } from "./hash";

/**
 * チャンク処理キャッシュの中身（設計書6.27.6、6.87.17）。
 *
 * **`vscode` を持ち込まない。** この台帳は拡張機能（`chunkCache.ts`）だけの
 * ものではなく、**MCPサーバー（別プロセス。VS Code が動いていなくても走る）**も
 * 同じファイルを読み書きする（設計書6.87.8）。`vscode.workspace.fs` を直に
 * 呼ぶ形のままだと、外から呼ぶ束に `vscode` が混ざって**Node 単体では
 * 読み込んだ瞬間に落ちる**（`mcpReach.test.ts`）。
 *
 * そこで**読み書きの手段だけを外から渡してもらう**（`ChunkCacheIo`）。
 * 鍵の作り方・混ぜ方・間引きの決まりは、どちらのプロセスから来ても
 * ここ1か所である——写しを置くと、片方だけ直す日が来る。
 */

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

export interface CacheEntry {
  key: string;
  createdAt: string;
  /**
   * 最後にこの項目が当たった日時（ISO）。
   *
   * **古い形式のファイルには無い**ので省略できる。無いものは `createdAt` を
   * 「最後に使った日」とみなす（作られてから一度も当たっていない状態と同じ扱い）。
   */
  lastUsedAt?: string;
  value: unknown;
}

/**
 * ファイルの読み書きの手段。
 *
 * **手元の VS Code は `vscode.workspace.fs`、MCPサーバーは `node:fs`** と
 * 経路が違うだけで、やることは同じ。`write` は**原子的に置き換える**こと
 * （書きかけを相手のプロセスに読ませない）。
 */
export interface ChunkCacheIo {
  /** 読めなければ `undefined`。キャッシュは失われても作り直せる */
  read(file: string): Promise<Uint8Array | undefined>;
  /** 置き場所を作ってから、原子的に置き換える */
  write(file: string, bytes: Uint8Array): Promise<void>;
  /** 掃除した件数などの記録。作者が「遅くなった理由」を追えるように残す */
  log(message: string): void;
}

/** 最後に使った日からこれだけ経った項目は捨てる */
export const CHUNK_CACHE_MAX_IDLE_DAYS = 180;

/**
 * 期限切れを落としたあとに残す件数の目安。
 *
 * **硬い上限ではない**（`evictStale` を参照）。減らすのは最後に使った日が
 * 1日以上前の項目だけなので、今日触れた項目ばかりならこの数を超えたまま残る。
 */
export const CHUNK_CACHE_MAX_ENTRIES = 4000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * チャンク単位の処理結果キャッシュ。
 *
 * 一度処理した内容を再処理しないための仕組み。
 * キーには内容ハッシュに加えてプロンプトversionとモデル名を含める。
 * 異なるモデルで生成された結果は品質が揃わないため再利用しない。
 *
 * **捨てる基準は「作った日」ではなく「最後に使った日」**（設計書6.27.6）。
 * 同じAI・同じモデル・同じ版なら、当たっているあいだAIは一度も呼ばれない。
 * 作った日で切ると、毎日使われている鍵まで期限で落ちて、無料で数十秒だった
 * 作業が有料で数十分に戻る。当たるたびに日付を進めるので、**使われ続けている
 * 鍵は期限でも上限でも消えない**——消えるのは、本文を直した・プロンプトの版を
 * 上げた・モデルを替えたせいで二度と当たらなくなった鍵だけである。
 */
export class ChunkCacheStore {
  private entries = new Map<string, CacheEntry>();
  private dirty = false;
  /** 期限切れの判定を試験できるように、時計を差し替えられるようにしてある */
  private readonly now: () => Date;

  constructor(
    private readonly file: string,
    private readonly io: ChunkCacheIo,
    options: { now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    this.entries.clear();
    this.dirty = false;
    for (const entry of await this.readFromDisk()) {
      this.entries.set(entry.key, entry);
    }
  }

  async save(): Promise<void> {
    /*
      **書く前に読み直して混ぜる**（設計書6.87.17）。

      同じ `chunks.json` を、拡張機能とMCPサーバー（別プロセス）が持つ。
      素直に上書きすると、**こちらが握っているあいだに相手が貯めたぶんを
      丸ごと失う**——しかも保存時には間引きも掛かるので、古い内容を握った
      まま上書きすると被害が大きい。

      **混ぜてから間引く。** 順番が逆だと、落としたばかりの項目が混ぜ直しで
      戻ってきて、同じ掃除を二度することになる（記録にも二重に出る）。
    */
    await this.mergeFromDisk();
    // 掃除は dirty に関わらず毎回試す。読むだけで終わった回でも、
    // 期限切れは落としておきたい（落としたら dirty が立つので書き出される）
    this.evictStale();
    if (!this.dirty) return;
    const body = JSON.stringify([...this.entries.values()], null, 0);
    await this.io.write(this.file, new TextEncoder().encode(body));
    this.dirty = false;
  }

  get(chunkHash: string, base: CacheKeyBase): unknown | undefined {
    const entry = this.entries.get(makeKey(chunkHash, base));
    if (!entry) return undefined;
    this.markUsed(entry);
    return entry.value;
  }

  async set(
    chunkHash: string,
    base: CacheKeyBase,
    value: unknown
  ): Promise<void> {
    const key = makeKey(chunkHash, base);
    this.entries.set(key, {
      key,
      createdAt: this.now().toISOString(),
      value,
    });
    this.dirty = true;
  }

  get size(): number {
    return this.entries.size;
  }

  /** ファイルにある項目を読む。読めない・壊れているときは空として扱う */
  private async readFromDisk(): Promise<CacheEntry[]> {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await this.io.read(this.file);
    } catch {
      // キャッシュは失われても再生成できるため、読めなくても続行する
      return [];
    }
    if (!bytes) return [];
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isCacheEntry);
    } catch {
      return [];
    }
  }

  /**
   * ファイルにある項目を、手元の項目へ取り込む。
   *
   * - 片方にしか無い鍵は**残す**（消さない）
   * - 同じ鍵が両方にあれば、**最後に使った日が新しいほう**を残す
   *
   * **取り込みでは `dirty` を立てない。** 向こうの項目はもうファイルに
   * 入っているので、こちらに書き戻す用事は無い——立てると、読むだけで
   * 終わった回にも差分が出てGit同期が汚れる（設計書5.5.7）。
   */
  private async mergeFromDisk(): Promise<void> {
    for (const theirs of await this.readFromDisk()) {
      const mine = this.entries.get(theirs.key);
      if (!mine || lastUsedTime(theirs) > lastUsedTime(mine)) {
        this.entries.set(theirs.key, theirs);
      }
    }
  }

  /**
   * 「最後に使った日」を今日にする。
   *
   * **1日未満の再利用では書き換えない。** `.aiwriter/cache/` はGit同期の対象に
   * できる（設計書5.5.7、`workRegistry.ts` の `isCacheSyncEnabled`）ので、
   * 当たるたびに日付を進めると、読むだけの操作でも差分が出続けて同期が汚れる。
   * 捨てる判定は日単位なので、日付が1日ぶんずれても結論は変わらない。
   */
  private markUsed(entry: CacheEntry): void {
    const now = this.now();
    if (!isIdleForADay(entry, now.getTime())) return;
    entry.lastUsedAt = now.toISOString();
    this.dirty = true;
  }

  /**
   * 使われていない項目を捨てる。
   *
   * 期限（最後に使った日から `CHUNK_CACHE_MAX_IDLE_DAYS` 日）を過ぎたものを
   * 落とし、それでも `CHUNK_CACHE_MAX_ENTRIES` を超えていれば、最後に使った日が
   * 古い順に、目安の件数まで落とす。**どちらの経路も見るのは「最後に使った日」
   * だけ**なので、今回当たった鍵（今日の日付になっている）は捨てられない。
   */
  private evictStale(): void {
    const before = this.entries.size;
    const now = this.now().getTime();
    const deadline = now - CHUNK_CACHE_MAX_IDLE_DAYS * DAY_MS;
    for (const [key, entry] of this.entries) {
      if (lastUsedTime(entry) < deadline) this.entries.delete(key);
    }
    if (this.entries.size > CHUNK_CACHE_MAX_ENTRIES) {
      // **上限は柔らかい。** 捨てる候補を「最後に使った日が1日以上前」に限り、
      // 今日触れた項目は上限を超えていても残す（超過を許す）。
      //
      // 硬い上限にすると、1回の走査で作った項目どうしが押し合う。走査で作る
      // 項目は全部その日の日付なので、上限に当たった時点で**同じ実行の中で
      // 先に作ったぶん**が押し出され、次の実行でそれを作り直すとまた末尾が
      // 押し出される——という往復になり、キャッシュがほとんど効かなくなる。
      // 4,000件は本番の7経路（矛盾・逸脱・伏線×2・推敲・誤字脱字・人物抽出）で
      // 割ると約570チャンクぶんなので、大きい作品では1回の走査で届きうる。
      // 一時的に膨らむほうが、AIを呼び直す費用よりずっと安い。
      const excess = this.entries.size - CHUNK_CACHE_MAX_ENTRIES;
      const removable = [...this.entries.values()]
        .filter((entry) => isIdleForADay(entry, now))
        .sort((left, right) => lastUsedTime(left) - lastUsedTime(right));
      for (const entry of removable.slice(0, excess)) {
        this.entries.delete(entry.key);
      }
    }
    const removed = before - this.entries.size;
    if (removed === 0) return;
    this.dirty = true;
    // 黙って消さない。次の実行が遅くなる理由を作者が追えるようにする
    this.io.log(
      `チャンクキャッシュ：使われていない ${removed} 件を捨てました（残り ${this.entries.size} 件）`
    );
  }
}

/**
 * 最後に使ってから1日以上経っているか。
 *
 * 日付を進める判定（`markUsed`）と、上限で捨てる判定（`evictStale`）で
 * **同じ境を使う**。別々に数字を書くと、片方だけ動かしたときに
 * 「日付は進めないのに捨てる対象にはなる」項目が生まれる。
 */
function isIdleForADay(entry: CacheEntry, now: number): boolean {
  return now - lastUsedTime(entry) >= DAY_MS;
}

/**
 * 最後に使った日時をミリ秒で返す。
 * `lastUsedAt` の無い古い項目は、作った日を最後に使った日とみなす。
 */
function lastUsedTime(entry: CacheEntry): number {
  const time = Date.parse(entry.lastUsedAt ?? entry.createdAt);
  // 読み込みで日付を検証しているのでここへは来ないが、万一読めない値が
  // 入り込んだら「いちばん古い」とみなして掃除に任せる（判定不能で居座らせない）
  return Number.isFinite(time) ? time : 0;
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
    // `lastUsedAt` は古い形式のファイルには無いので、欠けているのは正常。
    // ただし入っていて読めない値なら、掃除の判定を誤って当たる鍵を捨てかねないので
    // その項目ごと読まない（`createdAt` で代用すると、実際より古く見えてしまう）
    (entry.lastUsedAt === undefined ||
      (typeof entry.lastUsedAt === "string" &&
        isValidIsoDate(entry.lastUsedAt))) &&
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
