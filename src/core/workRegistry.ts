import * as vscode from "vscode";
import * as path from "./paths";
import { isWebRuntime } from "./runtime";
import {
  AIWRITER_DIR,
  CONFIG_FILE,
  CONFIG_SCHEMA_VERSION,
  DEFAULT_MANUSCRIPT_DIR,
  DEFAULT_SETTINGS_DIR,
  WorkAnnounceConfig,
  WorkConfig,
  WorkEntry,
  WorkKindKey,
} from "../models/types";
import { atomicWriteFile } from "./atomicWrite";
import { buildPlotTemplate } from "./plotTemplate";
import { parseWorkKind } from "./workKind";
import { parseNameOrigin } from "./nameOriginFit";
import { canRegisterWork, describeWorkLimit } from "./editorMode";
import { currentMode } from "./actorContext";
import { parseSeriesConfig } from "./seriesLink";
import { fileReader, isNotFound } from "./fileRead";
import { AI_INSTRUCTION_TARGETS } from "./aiInstructions";
import { logFailure } from "./logger";
import {
  detectJsonFileFormat,
  formatJsonForFile,
  type JsonFileFormat,
} from "./jsonFileFormat";

const STORAGE_KEY = "novelai.works";

/**
 * `maintainWorks()` が何にどれだけかかったか（設計書6.107）。
 *
 * **累積の数字だけでは、整備が重い理由が分からない。** 作品ごとに
 * `stat` と `.gitignore` の読み書きを回しているので、遅い置き場に
 * 1件だけ載っている作品が全体を引っ張ることがある（ネットワーク
 * ドライブ・OneDrive の取り寄せ）。**いちばん遅かった1件の題**が
 * 分かれば、次にどこを見ればよいかがその場で決まる。
 *
 * **`stat` と `.gitignore` を分けて数える。** 前者はフォルダーが在るかを
 * 訊くだけ、後者は読んで足りなければ書く。どちらが重いかで、疑う先が
 * 変わる（取り寄せの遅さなのか、書き込みの遅さなのか）。
 *
 * **ここでは何も書き出さない。** `core` は `vscode` の通知にもログにも
 * 触らず、数字を返すだけにする（印を打つのは `extension.ts` 側）。
 */
export interface WorkRegistryInitReport {
  /** 見た作品の数（登録簿の件数） */
  readonly count: number;
  /** いちばん時間のかかった作品にかかったミリ秒。0件なら 0 */
  readonly slowestMs: number;
  /** その作品の題。0件なら `undefined` */
  readonly slowestTitle?: string;
  /** その作品が登録簿の何番目だったか（1始まり）。0件なら `undefined` */
  readonly slowestOrder?: number;
  /** フォルダーの有無の確認（`stat`）に費やした合計ミリ秒 */
  readonly statMs: number;
  /** `.gitignore` の読み書きに費やした合計ミリ秒 */
  readonly ignoreMs: number;
  /**
   * **順番待ちに費やした合計ミリ秒**（設計書6.107。0.74.9）。
   *
   * 0.74.7 で読み口を Node の `fs` へ替えたあと、整備は「4番目 8.8秒、
   * 6番目 2.1秒、15番目 1.3秒」とバラバラの位置で詰まり、速い作品は
   * 4〜33ms で終わった。**遅いのはファイルではなく、`await` が
   * 再開できないこと**の疑いが強い——同じスレッドで走っている作品一覧の
   * 走査が CPU を握っていれば、こうなる。
   *
   * そこで `stat` の直前で**いったん列の後ろへ回り**、戻ってくるまでに
   * 何ミリ秒かかったかを測る。**ここが大きければ順番待ち、`statMs` や
   * `ignoreMs` が大きければ I/O** と読める。
   */
  readonly yieldMs: number;
  /**
   * **作品ごとの内訳**（回った順＝登録簿の順）。
   *
   * ノートPCで3回測ったところ、**遅い作品が毎回入れ替わり、どれか1件が
   * 必ず8.7秒前後**だった（2026-09-21）。最長の1件だけでは、
   * 「1件目だから遅い」（最初の1回だけ効く何か）のか「その作品が
   * たまたま遅い置き場にある」のかが**1回の計測では見分けられない**。
   * 全部を順に並べれば、次の起動と突き合わせるだけで決まる。
   */
  readonly works: readonly WorkMaintainTiming[];
}

/** 作品1件ぶんの内訳（`WorkRegistryInitReport.works`） */
export interface WorkMaintainTiming {
  /** 登録簿の何番目か（1始まり） */
  readonly order: number;
  readonly title: string;
  /**
   * この作品の番が回ってくるまでの待ち（設計書6.107）。
   * **`statMs`・`ignoreMs` には含めない**（順番待ちと I/O を分けるため）
   */
  readonly yieldMs: number;
  /** フォルダーの有無の確認（`stat`）にかかったミリ秒 */
  readonly statMs: number;
  /** `.gitignore` の読み書きにかかったミリ秒。飛ばしたなら 0 */
  readonly ignoreMs: number;
}

/**
 * いったん列の後ろへ回る（設計書6.107）。
 *
 * **順番待ちを I/O と切り分けるために挟む。** ここで待たされた時間は、
 * 同じスレッドで走っている別の処理（作品一覧の走査）が CPU を
 * 握っていた時間である。
 *
 * `setImmediate` は Node のグローバルなので `node:` の import は要らない。
 * **ブラウザ版には無い**ので、そのときは `setTimeout(0)` へ倒す（規則7）。
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof setImmediate === "function") setImmediate(() => resolve());
    else setTimeout(() => resolve(), 0);
  });
}

/**
 * 登録済み作品の一覧を保持する。
 * 実体は VSCode の globalState（ワークスペースをまたいで保持される）。
 *
 * **読むのに下ごしらえは要らない。** `list()` は globalState をその場で
 * 読むだけなので、作ってすぐ使える。作品ごとの整備（`maintainWorks()`）は
 * **一覧を出してから**でよく、起動の道には載せない（設計書6.107）。
 */
export class WorkRegistry {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * 旧版ですでに登録済みの作品にも、安全な冪等migrationを適用する。
   *
   * **起動の道から外して呼ぶ**（設計書6.107）。ここがしているのは
   * (a) フォルダーが在るかの確認と (b) `.gitignore` の移行だけで、
   * **どちらも作品一覧を描く前に終わっている必要が無い。** 作者の
   * ノートPCでは16作品の往復に15.2秒かかっており、そのあいだ一覧は
   * 空のままだった（2026-09-21の計測）。登録簿そのものは globalState を
   * 読むだけなので、`list()` はこれを待たずに使える。
   *
   * 名前が `initialize` でないのはそのためである——「これを済ませないと
   * 登録簿が使えない」という読み方をされると、また起動の道へ戻る。
   *
   * @param noticeUnregistered 整備のあとに呼ぶ。**書庫にあるのに登録されて
   *   いない作品を知らせる口**（設計書6.97.4）。すぐ下の「フォルダーが
   *   見つかりません」のちょうど裏返しなので隣に置いてあるが、**画面を出すのは
   *   `features` の仕事**なので、`core` から呼ばずに外から渡してもらう
   *   （依存の向きを逆流させない）。
   * @returns 作品ごとの所要時間の最大とその題、`stat` と `.gitignore` の
   *   合計（設計書6.107）。**戻り値は使わなくてよい**——起動の数字を
   *   出さない呼び手は、そのまま捨ててよい。
   */
  async maintainWorks(
    noticeUnregistered?: (works: readonly WorkEntry[]) => void
  ): Promise<WorkRegistryInitReport> {
    const failedTitles: string[] = [];
    const missingWorks: WorkEntry[] = [];
    // いちばん遅かった1件（設計書6.107）。`Date.now()` を使わないのは、
    // 時計合わせで巻き戻ると経過時間が負になるため
    let slowestMs = 0;
    let slowestTitle: string | undefined;
    let slowestOrder: number | undefined;
    // 何に費やしたかの内訳（設計書6.107）
    let statMs = 0;
    let ignoreMs = 0;
    // 順番待ち（0.74.9）。I/O と切り分けるために別で数える
    let yieldMs = 0;
    // 作品ごとの内訳。回った順にそのまま積む（設計書6.107）
    const timings: WorkMaintainTiming[] = [];
    // キャッシュを同期するかは設定で変えられる。起動のたびに突き合わせ、
    // 切り替えられていれば `.gitignore` へ打ち消し行を足す（設計書5.5.7）
    const syncCache = isCacheSyncEnabled();
    const works = this.list();
    for (const [index, work] of works.entries()) {
      /*
        **`stat` の直前で、いったん列の後ろへ回る**（設計書6.107。0.74.9）。

        戻ってくるまでにかかった時間が、そのまま「順番待ち」である。
        **`startedAt` はこの待ちのあとに取る**——待ちを混ぜると、
        「最長の1件」が I/O の重さではなく待ち時間で決まってしまい、
        いままで読んできた数字と意味が変わる。
      */
      const yieldStartedAt = performance.now();
      await yieldToEventLoop();
      const workYieldMs = performance.now() - yieldStartedAt;
      yieldMs += workYieldMs;

      const startedAt = performance.now();
      /*
        **フォルダーが無い作品は、触らずに飛ばす。**

        ここの整備は「あるものを整える」仕事であって、**無いものを作る仕事では
        ない**。`vscode.workspace.fs.writeFile` は親フォルダーを作るので、
        無い作品へ `.gitignore` を書きにいくと**空の作品フォルダーができあがる**。

        2026-09-19、作者の `Documents` が OneDrive に丸ごと別の場所へ移された
        直後の起動で、**登録済み全作品ぶんの空フォルダーが元の場所に作られた**。
        作者から見ると「作品を開いたら全部空になっていた」という形になり、
        **データが消えた場合と見分けがつかない。**

        登録簿からは**消さない**。外付けドライブが繋がっていないだけ、
        同期がまだ終わっていないだけ、ということがある。判断は作者に委ねる。
      */
      const statStartedAt = performance.now();
      const present = await isWorkFolderPresent(work.folderPath);
      const workStatMs = performance.now() - statStartedAt;
      statMs += workStatMs;
      let workIgnoreMs = 0;
      if (!present) {
        missingWorks.push(work);
      } else {
        const ignoreStartedAt = performance.now();
        try {
          await ensureRecoveryIgnoreRule(work.folderPath, { syncCache });
        } catch {
          // 作品登録や起動を壊さず、次回起動でも同じmigrationを再試行する。
          failedTitles.push(work.title);
        } finally {
          // **失敗した時間も数える。** 遅い置き場では「待たされた末に
          // 失敗する」ことがあり、そこを外すと合計が実感と合わなくなる
          workIgnoreMs = performance.now() - ignoreStartedAt;
          ignoreMs += workIgnoreMs;
        }
      }
      timings.push({
        order: index + 1,
        title: work.title,
        yieldMs: workYieldMs,
        statMs: workStatMs,
        ignoreMs: workIgnoreMs,
      });
      /*
        **飛ばした作品も測る**（設計書6.107）。繋がっていないドライブや
        取り寄せ中のクラウドでは、`stat` ひとつが何秒も返らないことがある。
        「無かったから速い」とは限らない。
      */
      const elapsed = performance.now() - startedAt;
      if (elapsed > slowestMs) {
        slowestMs = elapsed;
        slowestTitle = work.title;
        // **何番目かも覚える。** 3回の計測で遅い作品が入れ替わったので、
        // 「1件目だから遅い」のかを見分けるのに順番が要る（設計書6.107）
        slowestOrder = index + 1;
      }
    }
    if (missingWorks.length > 0) {
      /*
        **ボタンの答えを待たない**（設計書5.7.8。2026-09-23）。作者が
        知らせを放っておいても、後ろ（未登録の作品の知らせ・起動の数字）は
        先へ進む。答えは後から受け、途中で投げたものはログへ残す
        （握りつぶすと、外せなかった理由を誰も追えない）。
      */
      void offerToUnregisterMissingWorks(this, missingWorks).catch((error) => {
        logFailure("見つからない作品の登録解除", {
          詳細: error instanceof Error ? error.message : String(error),
        });
      });
    }
    if (failedTitles.length > 0) {
      await vscode.window.showWarningMessage(
        `回復ファイルの除外設定を更新できない作品があります。次回起動時に再試行します: ${failedTitles.join("、")}`
      );
    }

    /*
      **登録されているのにフォルダが無い**のが上。**フォルダはあるのに
      登録されていない**のがこちら（設計書6.97.4）。別の機械で作品を足して
      `git pull` したときに起きる。

      **待たない。** 書庫の走査はフォルダーの中を読むので、起動の完了を
      そのぶん遅らせてしまう。知らせは1行で、押さなければ何も起きない
      ので、遅れて出ても困らない
    */
    noticeUnregistered?.(this.list());

    return {
      count: works.length,
      slowestMs,
      slowestTitle,
      slowestOrder,
      statMs,
      ignoreMs,
      yieldMs,
      works: timings,
    };
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

  /**
   * その場所に登録されている作品（2026-09-24）。
   *
   * **比べ方は `path.isSameFolder` の1か所に任せる**——ドライブ文字や
   * フォルダー名の大小（Windows）、末尾の区切り、前後の空白が違っても
   * 同じ作品を返す。以前は `path.normalize` の完全一致で、フォルダー選び
   * （`c:\…`）で登録した作品に、アドレス欄から貼った `C:\…` を足すと
   * 二重に登録できた（作者の報告）。
   */
  findByFolder(folderPath: string): WorkEntry | undefined {
    return findWorkByFolder(
      this.context.globalState.get<WorkEntry[]>(STORAGE_KEY, []),
      folderPath
    );
  }

  /**
   * 登録済みなら、どの作品として登録済みかを添えて断る（2026-09-24）。
   * 作品名が無いと、作者はどの登録と重なったのかを一覧から探すことになる。
   */
  private blockedAsDuplicate(works: WorkEntry[], folderPath: string): boolean {
    const existing = findWorkByFolder(works, folderPath);
    if (!existing) return false;
    void vscode.window.showWarningMessage(
      `このフォルダは「${existing.title}」としてすでに登録されています。`
    );
    return true;
  }

  /** 既存フォルダを作品として登録する */
  async add(folderPath: string, title?: string): Promise<WorkEntry | undefined> {
    const works = this.context.globalState.get<WorkEntry[]>(STORAGE_KEY, []);
    // **保存する表記は、前後の空白と末尾の区切りだけを落とした形。**
    // 大小は変えない（作者が見るフォルダー名と一覧の表記を揃えておく）
    const normalized = path.tidyFolderPath(folderPath);

    if (this.blockedAsDuplicate(works, normalized)) return undefined;
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
    // 比べ方と保存する表記は `add` と同じ（2026-09-24）
    const normalized = path.tidyFolderPath(folderPath);
    if (this.blockedAsDuplicate(works, normalized)) return undefined;
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

  /**
   * 作品の題を変える（設計書6.1.1）。
   *
   * **フォルダーは動かさない。** 置き場所が変わるとGitHubの同期先も
   * 登録も書庫の並びも切れる。ここで変えるのは呼び名だけである。
   *
   * `save` を通すので `onDidChange` が飛び、作品一覧とステータスバーが
   * 追随する（登録・解除と同じ流儀）。
   */
  async rename(id: string, title: string): Promise<WorkEntry | undefined> {
    const works = this.context.globalState.get<WorkEntry[]>(STORAGE_KEY, []);
    const target = works.find((w) => w.id === id);
    if (!target) return undefined;

    const trimmed = title.trim();
    // 空にはできない（一覧から名前が消える）。変わっていなければ書かない
    if (trimmed.length === 0 || trimmed === target.title) return target;

    const renamed: WorkEntry = { ...target, title: trimmed };
    await this.save(works.map((w) => (w.id === id ? renamed : w)));
    return renamed;
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
 * 作品の並びから、その場所の作品を引く（`WorkRegistry.findByFolder` の中身）。
 *
 * 登録簿そのものを持たない呼び手（登録簿の写しの一覧を受け取る所）も
 * 同じ比べ方で引けるよう、関数として外に出してある。
 */
export function findWorkByFolder<T extends { folderPath: string }>(
  works: readonly T[],
  folderPath: string
): T | undefined {
  const key = path.folderKeyForComparison(folderPath);
  if (!key) return undefined;
  return works.find((work) => path.folderKeyForComparison(work.folderPath) === key);
}

/**
 * そのファイルが属する作品を引く（2026-09-24。`extension.ts` の
 * `findWorkForPath` の中身を、テストできるようにここへ出した）。
 *
 * **深い作品フォルダーを先に見て、入れ子なら内側を選ぶ。**
 * 中にあるかの判定は `paths.isPathInside` に任せる——ブラウザ版では
 * 登録簿の場所（生の日本語）と開いた本文の場所（`fromUri` で符号化される）の
 * 表記が割れるので、符号を解いて比べる所を1つにしておく。
 * 深さも符号を解いた長さで比べる（符号化された側だけ長く見えないように）。
 */
export function findWorkForFile<T extends { folderPath: string }>(
  works: readonly T[],
  filePath: string
): T | undefined {
  const depth = (work: T): number =>
    path.decodeUriEscapes(work.folderPath).length;
  return [...works]
    .sort((a, b) => depth(b) - depth(a))
    .find((work) => path.isPathInside(work.folderPath, filePath));
}

/** 見つからない作品の知らせと、確認のダイアログに出すボタン（作品一覧の右クリックと同じ語） */
const UNREGISTER_LABEL = "登録を解除";

/**
 * 「作品フォルダーが見つかりません」を知らせ、押されたら登録だけを外す
 * （設計書5.7.8。作者の裁定、2026-09-23）。
 *
 * 作者の実機で、取り込みの試しで作って後で消した作品の登録が残り、
 * **起動のたびに**この知らせが出た。外す手段は作品一覧の右クリックにしか
 * 無く、知らせからは辿れなかった。
 *
 * - **押した時点で、もう一度フォルダーを確かめる。** 知らせは起動直後に
 *   出るが、作者が押すのはドライブを繋ぎ直した・同期が終わった後かもしれない。
 *   戻っていた作品は外さず、戻っていたことを短く知らせる
 * - **1件なら確認、複数なら選ばせる。** 確認の文面は作品一覧の
 *   「作品の登録を解除」（`novelai.removeWork`）と同じにする——同じ操作が
 *   入口で違う言い方をすると、別のことが起きるのかと身構えさせる。
 *   複数のときは**既定で何も選ばない**（戻ってくる作品を巻き込まないため、
 *   外すものを作者が1つずつ指す）
 * - **登録だけを外す。** ここは登録簿（globalState）しか触らない。
 *   フォルダーもファイルも消さない
 *
 * 作品一覧は `WorkRegistry.remove` が鳴らす `onDidChange` で追随する
 * （登録・解除・改題と同じ流儀。`core` から `views` を呼ばない）。
 *
 * @param isPresent 押した時点の確かめ方。試験から差し替える
 * @returns 登録を外した作品の id
 */
export async function offerToUnregisterMissingWorks(
  registry: Pick<WorkRegistry, "get" | "remove">,
  missing: readonly WorkEntry[],
  isPresent: (folderPath: string) => Promise<boolean> = isWorkFolderPresent
): Promise<readonly string[]> {
  if (missing.length === 0) return [];

  const choice = await vscode.window.showWarningMessage(
    `作品フォルダーが見つかりません: ${missing.map((w) => w.title).join("、")}。` +
      `移動・改名されたか、ドライブが繋がっていない可能性があります。` +
      `登録はそのまま残してあります（フォルダーを作り直してはいません）。` +
      `もう使わない作品なら「${UNREGISTER_LABEL}」で一覧から外せます（フォルダーとファイルは消しません）。`,
    UNREGISTER_LABEL
  );
  if (choice !== UNREGISTER_LABEL) return [];

  // 押すまでのあいだに状況が変わっていることがある。1件ずつ確かめ直す
  const returned: WorkEntry[] = [];
  const stillMissing: WorkEntry[] = [];
  for (const work of missing) {
    // 作品一覧の右クリックで先に外した、などで、もう登録に無い
    const current = registry.get(work.id);
    if (!current) continue;
    if (await isPresent(current.folderPath)) returned.push(current);
    else stillMissing.push(current);
  }

  if (returned.length > 0) {
    void vscode.window.showInformationMessage(
      `作品フォルダーが見つかるようになっていたので、登録はそのままにしました: ` +
        returned.map((w) => w.title).join("、")
    );
  }
  if (stillMissing.length === 0) return [];

  let targets: readonly WorkEntry[];
  let confirmMessage: string;
  if (stillMissing.length === 1) {
    targets = stillMissing;
    confirmMessage =
      `「${stillMissing[0].title}」の登録を解除しますか？\n` +
      `フォルダとファイルは削除されません。`;
  } else {
    const picked = await vscode.window.showQuickPick(
      stillMissing.map((work) => ({
        label: work.title,
        description: work.folderPath,
        // 既定では何も選ばない（外すものは作者が指す）
        picked: false,
        work,
      })),
      {
        canPickMany: true,
        title: "登録を解除する作品を選ぶ",
        placeHolder:
          "登録を解除する作品に印を付けてください（フォルダーとファイルは削除されません）",
        ignoreFocusOut: true,
      }
    );
    if (!picked || picked.length === 0) return [];
    targets = picked.map((item) => item.work);
    confirmMessage =
      `次の${targets.length}作品の登録を解除しますか？\n` +
      targets.map((w) => `「${w.title}」`).join("、") +
      `\nフォルダとファイルは削除されません。`;
  }

  const confirmed = await vscode.window.showWarningMessage(
    confirmMessage,
    { modal: true },
    UNREGISTER_LABEL
  );
  if (confirmed !== UNREGISTER_LABEL) return [];

  const removed: string[] = [];
  for (const work of targets) {
    await registry.remove(work.id);
    removed.push(work.id);
  }
  return removed;
}

/**
 * 同期対象から外すべきもの。
 *
 * 新規作成時のひな形と、既存フォルダーを登録したときの追記で同じものを使う。
 * 以前は登録時に `.novelai-recovery/` しか追記しておらず、
 * **キャッシュがGitに入ったままだった**（設計書5.5.7と食い違っていた）。
 */
/**
 * MCP の登録ファイルの置き先（`.mcp.json`・`.codex/config.toml`・
 * `.gemini/settings.json`）。
 *
 * **置き先の表（`aiInstructions.ts`）から導く。** ここへ写しを書くと、
 * 置き先を1つ足したときに片方だけ直す日が来て、**新しい登録だけが
 * 同期される**という形で表に出る。
 */
const MCP_REGISTRATION_PATHS: readonly string[] = AI_INSTRUCTION_TARGETS.map(
  (target) => target.registrationPath
).filter((value): value is string => value !== undefined);

/**
 * **登録ファイルを書けない置き先の指示書**（いまは
 * `.aiwriter/novel-assist.md` の1つ）。
 *
 * 指示書はふつう文章だけなので同期してよいのだが、**この1つだけは例外**
 * である。登録ファイル（`.mcp.json` ほか）を置けない相手には、
 * `buildToolLocationPreamble` が**本文として束の絶対パスを書き込む**
 * ——中身が機械に依存する。同期すると、別の機械には存在しない場所を
 * 指す手引きが届く（登録ファイルと同じ壊れ方）。
 *
 * ここも置き先の表から導く。「登録の口が無い＝束の場所を本文に書く」は
 * `aiInstructions.ts` が決めていることなので、条件を写すと食い違う。
 */
const MACHINE_BOUND_INSTRUCTION_PATHS: readonly string[] =
  AI_INSTRUCTION_TARGETS.filter((target) => !target.registrationPath).map(
    (target) => target.instructionPath
  );

export const IGNORED_PATHS: readonly string[] = [
  ".aiwriter/cache/",
  ".aiwriter/logs/",
  ".aiwriter/exports/",
  // その場で組み立てた読み物（執筆再開の1枚・冒頭診断・伏線の一覧等）の
  // 置き場（設計書6.17.7）。作り直せるうえ20件・30日で自動で消えるので、
  // 同期すると追加と削除の差分が出続ける。**`.aiwriter/` 全体は除外して
  // いない**（承認待ち等は同期する）ので、置き場を足すたびにここへ書く
  ".aiwriter/generated/",
  /*
    外部AIの利用許可の印（設計書6.87.10）。**同期しない**——同期すると、
    リポジトリを共有した編集部の機械でも許可済みになる。
    **許可は作者がその機械で与えるもの**である。
  */
  ".aiwriter/external-access.json",
  /*
    外部AIからの「この項目を光らせて」という依頼（設計書6.104。0.75.6）。
    **同期しない**——隣の `history/external.jsonl` は「原稿がどこまで外へ
    出たか」でどの機械から見ても同じ話だが、こちらは**いまこの機械の画面で
    光らせてほしい**という、その場限りの頼みである。同期すると、別の機械で
    何日も前の依頼が急に光る。
  */
  ".aiwriter/history/spotlight.jsonl",
  /*
    AI用の指示書を「開いて使うか、開かずに使うか」の控え（設計書6.87.14
    の末尾）。**同期しない**——その機械でどう使うかの話なので、
    リポジトリを共有した相手の機械へ持ち越さない。
  */
  ".aiwriter/ai-instruction-usage.json",
  /*
    MCP の登録（設計書6.87.15 柱5）。**同期しない**——登録には束
    （`dist/mcp-server.mjs`）への**絶対パス**が入っており、束の場所は
    その機械ごとに違う。同期すると、別の機械には**存在しないパスを指す
    登録**が届き、繋がらない（作者がこれで詰まった。2026-09-20。
    デスクトップで置いたつもりでノートPCへ同期されると思っていた）。

    **指示書のほうは、1つを除いて同期してよい**（`SKILL.md`・`AGENTS.md`・
    `GEMINI.md`）。あちらは文章だけで、機械に依存しない。**除く1つは
    `.aiwriter/novel-assist.md`** で、あれだけは登録ファイルを置けない
    相手向けなので、**本文に束の絶対パスが書き込まれる**
    （`buildToolLocationPreamble`）。
  */
  ...MCP_REGISTRATION_PATHS,
  ...MACHINE_BOUND_INSTRUCTION_PATHS,
  ".novelai-recovery/",
  "exports/",
];

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
 * 作品のフォルダーが今そこに在るか（`fileSystem.ts` の `isDirectory` と同じ判断）。
 *
 * **読むだけなので、手元では Node の `fs` で訊く**（`core/fileRead.ts`、設計書6.107）。
 * 起動直後の `vscode.workspace.fs` は要求が列に並び、**16作品ぶんで
 * 1番目が13.6秒**かかっていた（Node なら16件で合計13ms）。ここは
 * 起動の道のいちばん手前なので、後ろの全部がその列に付き合わされる。
 *
 * 見つからない・読めないは、これまでどおり「無い」に倒す。繋がっていない
 * ドライブや取り寄せ中のクラウドと、消えた作品は見分けられない。
 */
async function isWorkFolderPresent(folderPath: string): Promise<boolean> {
  try {
    const reader = await fileReader();
    return (await reader.stat(folderPath)).type === "directory";
  } catch {
    return false;
  }
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
    // **読むだけなので、手元では Node の `fs` を通る**（設計書6.107）。
    // 16作品ぶんのこの読みで、1件目だけで11.3秒かかっていた
    existing = await (await fileReader()).readFile(gitignorePath);
  } catch (error) {
    // **「見つからない」の形は経路で違う**（Node は `ENOENT`、
    // VS Code は `FileNotFound`）。見分けは `fileRead.ts` の1か所に置く
    if (!isNotFound(error)) {
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

  const announce = parseAnnounceConfig(value.announce);
  // シリーズの連結（設計書6.95）。**壊れていても投げない**——`announce` と
  // 同じ理由で、手で書き間違えたせいで作品そのものが開けなくなるのは困る
  const series = parseSeriesConfig(value.series);
  // 作品の種類（設計書6.109）。**知らない値は無かったことにする**（投げない）
  // ——新しい版で種類が増えたあと古い版で開いても、作品は開ける
  const kind = parseWorkKind(value.kind);
  // 名前の系統（設計書6.37.2）。`kind` と同じく、知らない値は無かったことにする
  const nameOrigin = parseNameOrigin(value.nameOrigin);

  return {
    schemaVersion: (value.schemaVersion as string).trim(),
    workTitle: (value.workTitle as string).trim(),
    manuscriptDir: (value.manuscriptDir as string).trim(),
    settingsDir: (value.settingsDir as string).trim(),
    createdAt: (value.createdAt as string).trim(),
    // **持っているときだけ入れる。** `announce: undefined` を常に置くと、
    // 書き戻したJSONに欄が現れたり消えたりして、Gitの差分が毎回濁る
    ...(announce ? { announce } : {}),
    ...(series ? { series } : {}),
    ...(kind ? { kind } : {}),
    ...(nameOrigin ? { nameOrigin } : {}),
  };
}

/**
 * 更新告知の設定（設計書6.41）を読む。
 *
 * **壊れていても投げない。** ここは告知文を作るときにしか使わない欄で、
 * 手で書き間違えたせいで作品そのものが開けなくなるほうが困る。
 * 読めない形なら `announce` ごと無かったことにして、他の欄は読む。
 */
function parseAnnounceConfig(raw: unknown): WorkAnnounceConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;

  // 欄そのものの型が違うときは、作者が何を意図したか決められない。
  // 半端に読むと「設定したはずのタグが黙って消える」ので、丸ごと捨てる
  if (value.hashtags !== undefined && !Array.isArray(value.hashtags)) {
    return undefined;
  }
  if (value.workUrl !== undefined && typeof value.workUrl !== "string") {
    return undefined;
  }

  // **揃えてから重ねを落とす。** 「創作」と「#創作」は書き方が違うだけで
  // 同じタグなので、そのまま並べると投稿に同じものが2つ出る。
  // `Set` は先に入れたほうを残すので、作者が書いた順が保たれる
  const hashtags = [
    ...new Set(
      (value.hashtags ?? [])
        .filter((item: unknown): item is string => typeof item === "string")
        .map(normalizeHashtag)
        .filter((tag: string) => tag.length > 0)
    ),
  ];

  return {
    hashtags,
    workUrl: typeof value.workUrl === "string" ? value.workUrl.trim() : "",
  };
}

/**
 * ハッシュタグの形を揃える。
 *
 * 作者は「創作」とも「#創作」とも書く。**空白はタグを切ってしまう**ので
 * 落とす（「# 創作」と書かれても1つのタグとして通す）。
 *
 * **全角の「＃」も落とす。** 日本語入力ではこちらがそのまま出るので、
 * 半角だけを見ていると「#＃創作」になり、投稿サイトではタグとして
 * 扱われない。先頭の `#`／`＃` をまとめて落としてから半角を1つ付けるので、
 * 何度通しても同じ形になる。
 */
function normalizeHashtag(raw: string): string {
  const body = raw.replace(/\s+/gu, "").replace(/^[#＃]+/u, "");
  return body ? `#${body}` : "";
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
  /*
    **読み口を通す**（設計書6.107。0.75.1）。ここは
    `vscode.workspace.fs.readFile` を直に叩いていた。走査の下ごしらえで
    作品ごとに1回呼ばれるので、混んだ拡張機能ホストでは16作品ぶんの往復が
    そのまま待ち時間になる（本文の読みを一括にしたあと、**下ごしらえだけで
    46秒**残っていた。作者の実機、0.75.0 の計測）。
    **読むだけ**なので、手元では Node の `fs` で読んでよい。
  */
  const configFile = workPaths(work).configFile;
  try {
    const reader = await fileReader();
    const bytes = await reader.readFile(configFile);
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const config = parseWorkConfig(raw);
    workPaths(work, config);
    return config;
  } catch (error) {
    // 「まだ無い」は両方の経路で形が違う（`isNotFound` が吸収する）
    if (isNotFound(error)) {
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
  const format = await existingConfigFormat(p.configFile);
  await vscode.workspace.fs.writeFile(
    path.toUri(p.configFile),
    new TextEncoder().encode(formatJsonForFile(validated, format))
  );
}

/**
 * 設定ファイルを新しく作るときの形。**これまでと1バイトも変えない**
 * （LF・末尾に改行なし）。登録で作る設定ファイルは長くこの形で、
 * 作品のリポジトリにもこの形で入っている。
 */
const NEW_CONFIG_FORMAT: JsonFileFormat = {
  useCrlf: false,
  finalNewline: false,
};

/**
 * 既にある設定ファイルの改行の形（2026-09-25、ノートPCの実機確認）。
 *
 * 種類を変える・作品名を変えるなどで1項目を書き足すたびに、Windows で
 * git が CRLF にして取り出したファイルを LF・末尾改行なしで書き直していた。
 * **1項目の変更で全行が差分になる**——設定資料で直した件（0.81.1）と同じ
 * なので、同じ部品（`jsonFileFormat.ts`）で読んだままの形に戻して書く。
 *
 * 読めなければ（無い・読み取りの失敗）新しく作るときの形にする。
 * 形が分からないだけで、書くこと自体はこれまでどおり続ける。
 */
async function existingConfigFormat(configFile: string): Promise<JsonFileFormat> {
  try {
    return detectJsonFileFormat(
      await vscode.workspace.fs.readFile(path.toUri(configFile))
    );
  } catch {
    return NEW_CONFIG_FORMAT;
  }
}

/**
 * 作品フォルダの初期構造を作成する。
 *
 * @param options.withPlot プロットのテンプレート（`設定/plot.md`）を置くか。
 *   **書きながら考える作者もいる。** 使わないテンプレートを置くと、
 *   見出しだけのファイルが設定資料に混ざり、紹介文を作るときの材料にも
 *   空のプロットとして渡ってしまう。あとから「プロットを作る」で足せる。
 */
export async function scaffoldWorkFolder(
  folderPath: string,
  title: string,
  options: {
    withPlot?: boolean;
    /**
     * 作品の種類（設計書6.109）。小説（または省略）なら何も書かない
     * ——**これまでと1バイトも変わらない設定ファイル**になる。
     */
    kind?: WorkKindKey;
  } = {}
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
    // 小説は書かない。書かなくても小説として読まれるので、これまでの
    // 作品と同じ形の設定ファイルにしておく（欄が増えるのは選んだときだけ）
    ...(options.kind && options.kind !== "novel" ? { kind: options.kind } : {}),
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
      buildPlotTemplate(title, options.kind)
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
