import { join } from "./pathText";
import { environmentVariable } from "./runtime";

/**
 * 起動のあいだ、**誰が CPU を握っていたか**を自分で採る（設計書6.107）。
 *
 * ## なぜ要るのか
 *
 * `core/loopLag.ts` は「握られているか」までしか言わない。握られていた場合、
 * **握っていたのが誰か**は、関数の単位で見るしかない。VS Code の
 * 「Developer: Start Extension Host Profile」でも採れるが、**作者の機械では
 * 押して回ってもらうことになる**し、押した時点ではもう起動は終わっている。
 * 起動の最初の数十秒は、外から押して採れない。
 *
 * そこで**拡張機能が自分で採る**。`activate` の入口で始め、作品一覧の
 * 初回描画（か上限の60秒）で止めて、`.cpuprofile` を保管庫のログの隣へ置く。
 *
 * ## 立てるのは開発時だけ
 *
 * **設定項目にはしない。** 環境変数 `NOVELAI_STARTUP_PROFILE` が立って
 * いるときだけ動く。作者が設定画面で踏める場所に置くと、意味の分からない
 * 項目が1つ増えるうえ、立てたまま忘れれば毎回プロファイルが溜まる。
 * **作者の環境では立てない。ノートの計測用である。**
 *
 * ## 規則7（ブラウザ版）
 *
 * `node:inspector` も `node:fs/promises` も**動的 import でしか触らない**。
 * ブラウザ版には `process` が無いので、そもそも入口で引き返す。
 */

/** 立っていたら採る、環境変数の名前 */
export const STARTUP_PROFILE_ENV = "NOVELAI_STARTUP_PROFILE";

/**
 * 採取の上限（ミリ秒）。
 *
 * **止め忘れの保険である。** 止めるのは「作品一覧の初回描画」だが、
 * サイドバーを一度も開かない起動では合図が来ない
 * （`core/maintenanceTrigger.ts` と同じ抜け方）。採りっぱなしにすると
 * プロファイルが際限なく膨らむ。
 */
export const STARTUP_PROFILE_LIMIT_MS = 60_000;

/**
 * 採取を頼まれているか。
 *
 * **`core/runtime.ts` の読み口を通す。** ブラウザ版には `process` が無いので、
 * 素で触ると落ちる（読み口はそのとき undefined を返す）。
 *
 * 値は「空でなく `0` でもない」なら立っているとみなす。`=1` だけを見ると、
 * `=true` と書いた人が黙って何も採れないことになる。
 */
export function isStartupProfileRequested(): boolean {
  const value = environmentVariable(STARTUP_PROFILE_ENV);
  return value !== undefined && value !== "" && value !== "0";
}

export interface StartupProfileOptions {
  /**
   * 書き出し先の根。**保管庫のログと同じ場所**（`core/logger.ts` の
   * `fallbackLogRoot`）を渡す。決まっていなければ何も書けないので、
   * そのときは採取そのものを始めない
   */
  readonly logRoot: string | undefined;
  /**
   * 書き終えたときに呼ぶ（置いた場所を渡す）。
   *
   * **記録するのは呼び手の仕事。** ここから `logStep` を呼ぶと、
   * `core` が `vscode` を引き込むことになる
   */
  readonly onSaved?: (filePath: string) => void;
  /** 失敗したときに呼ぶ。**起動は止めない**（採れなかっただけである） */
  readonly onFailed?: (error: unknown) => void;
  /** 採取の上限。試験から短くするために引数にする */
  readonly limitMs?: number;
  /** 時刻。ファイル名に使う。試験から固定するために引数にする */
  readonly now?: () => Date;
}

export interface StartupProfile {
  /**
   * 採取を止めて書き出す。
   *
   * **二度呼んでもよい**（上限のタイマーと初回描画の合図が、どちらも
   * 呼びうる）。2回目からは何もしない。
   */
  stop(): Promise<void>;
}

/**
 * `node:inspector` の `Session` のうち、ここで使う分だけ。
 *
 * **型を借りるために `node:inspector` を静的 import しない**（規則7）。
 * `import type` なら実行時には消えるが、この作品は「静的 import は
 * 書かない」を形で守っているので、必要な形だけをここへ写す。
 */
interface InspectorSessionLike {
  connect(): void;
  disconnect(): void;
  post(
    method: string,
    callback: (error: Error | null, params?: { profile?: unknown }) => void
  ): void;
}

/** コールバックの `post` を、待てる形に直す */
function post(
  session: InspectorSessionLike,
  method: string
): Promise<{ profile?: unknown } | undefined> {
  return new Promise((resolve, reject) => {
    session.post(method, (error, params) => {
      if (error) reject(error);
      else resolve(params);
    });
  });
}

/**
 * ファイル名に使う時刻（`yyyyMMdd-HHmmss`）。
 *
 * **現地時刻で書く**（`core/logger.ts` の `formatLogTime` と同じ理由）。
 * UTC で書くと、隣に並ぶ `actions.log` の行と9時間ずれて、どの起動の
 * プロファイルなのかが突き合わせられない。
 */
export function profileFileStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * 起動のプロファイルを採り始める。
 *
 * 頼まれていなければ（環境変数が立っていない・ブラウザ版・書き先が
 * 決まっていない）**何もせずに `undefined` を返す**。呼び手は場合分けを
 * しなくてよい（`profile?.stop()` と書けばよい）。
 */
export async function startStartupProfile(
  options: StartupProfileOptions
): Promise<StartupProfile | undefined> {
  if (!isStartupProfileRequested()) return undefined;
  const { logRoot } = options;
  if (!logRoot) {
    options.onFailed?.(
      new Error("ログの置き場所が決まっていないので、採取を始めない")
    );
    return undefined;
  }

  let session: InspectorSessionLike;
  try {
    // **動的 import**（規則7）。静的に書くと、呼ばれなくても
    // ブラウザ版が読み込んだ瞬間に落ちる
    const inspector = await import("node:inspector");
    session = new inspector.Session() as unknown as InspectorSessionLike;
    session.connect();
    await post(session, "Profiler.enable");
    await post(session, "Profiler.start");
  } catch (error) {
    options.onFailed?.(error);
    return undefined;
  }

  let stopped = false;
  const limitMs = options.limitMs ?? STARTUP_PROFILE_LIMIT_MS;
  const nowDate = options.now ?? (() => new Date());

  const finish = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearTimeout(limitTimer);
    try {
      const result = await post(session, "Profiler.stop");
      session.disconnect();
      const target = join(
        logRoot,
        ".aiwriter",
        "logs",
        `startup-${profileFileStamp(nowDate())}.cpuprofile`
      );
      // **ここも動的 import**（規則7）。この道は Node でしか通らない
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(logRoot, ".aiwriter", "logs"), { recursive: true });
      await writeFile(target, JSON.stringify(result?.profile), "utf8");
      options.onSaved?.(target);
    } catch (error) {
      // **採れなくても起動は止めない。** 診断のための仕掛けである
      options.onFailed?.(error);
    }
  };

  /*
    **上限で自分から止まる。** 合図（作品一覧の初回描画）はサイドバーを
    開かないと来ない。`unref` は付けない——VS Code の拡張機能ホストは
    このタイマーで終われなくなる作りではないし、ブラウザ版には無い。
  */
  const limitTimer = setTimeout(() => {
    void finish();
  }, limitMs);

  return { stop: finish };
}
