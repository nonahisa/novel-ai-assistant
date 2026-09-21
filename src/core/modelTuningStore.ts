import * as vscode from "vscode";
import { atomicWriteFile } from "./atomicWrite";
import { fileReader } from "./fileRead";
import { logLine } from "./logger";
import * as path from "./paths";

/**
 * AIチューニングの台帳の**置き場**（設計書6.49）。
 *
 * ## なぜ設定から出したか（作者の報告、2026-09-18）
 *
 * 「製品版でさくらのAIのqwenをチューニングしたのですが、しばらくすると
 * 一覧から消えます」。
 *
 * 台帳は `novelai.modelTuning` という**設定1つぶんの塊**だった。書き込みは
 * 「表を読む → 1件差し替える → 表ごと書き戻す」なので、**2つの窓**
 * （製品版と拡張機能開発ホスト）を同時に開いていると、片方が読んでから
 * 書くまでの間にもう片方が書いたぶんが**痕跡なく消える。**
 * `saveModelTuning` の待ち行列は、コード自身のコメントが断っているとおり
 * **同じプロセスの中しか守らない。**
 *
 * もう1つ、設定は**設定同期で機械をまたいで運ばれる。** 台帳が持つのは
 * 「この機械で、このモデルが、どれだけ読めたか」であり、読める長さは
 * VRAM 次第で機械ごとに違う。同梱表が「ローカルの読める長さは載せない」
 * としているのと同じ理由で、**共有してはいけない値**である。
 *
 * ## 作者の裁定：人物や設定資料と同じように、ファイルで持つ
 *
 * 置き場は `<拡張機能の保管庫>/model-tuning.json`。**保管庫は同期されず、
 * 機械ごとに別**なので、「機械ごとに分ける」も同時に満たされる
 * （`machineId` のような鍵は足さない——ファイルが既に機械ごとである）。
 *
 * 中身の形は**設定のときと同じ**（`{ "プロバイダ/モデル": { …欄 } }`）
 * なので、読み取りは `parseModelTuning` がそのまま使える。
 *
 * ## 同梱の初期値は、これまでどおり
 *
 * `core/bundledTuning.ts` と、読むときに混ぜる `mergeBundledTuning` は
 * 何も変えていない（作者の念押し「クラウド版を製品に同梱するのは
 * 変わっていない」）。ここが扱うのは**作者自身の実測だけ**である。
 */

/** 台帳のファイル名。**保管庫の直下に置く**（生成文書とは別の階） */
export const TUNING_STORE_FILE = "model-tuning.json";

/**
 * 書き込みが**実際に入ったか**（作者の報告、2026-09-19）。
 *
 * 手元の Ollama を12分かけて測り、「設定に反映」を押したのに台帳が
 * 1バイトも変わらなかった。原因は書き込みそのものではなく、**書けなかった
 * ことが呼び出し側へ伝わらない**ことである——下の `writeTuningEntry` は
 * 断ったときも諦めたときも、ログへ1行残して静かに戻る。受け取った側は
 * 成功と区別できないので、「覚えました」と言うしかなかった。
 *
 * **例外は投げないままにする。** 測った結果を作者へ見せる流れを台帳の
 * 都合で止めないのは、これまでどおり正しい（見せるものは手元にある）。
 * 変えるのは「黙って戻る」ところだけで、**結果を返して、言う言わないは
 * 呼び出し側に決めさせる。**
 */
export type TuningWriteOutcome =
  /** 台帳へ入った（書いたあとに読み直して確かめた） */
  | "written"
  /** 台帳が壊れていて、上書きせずに断った */
  | "unreadable"
  /** 置き場が渡っていないので、書く先が無い */
  | "no_store"
  /** 何度やり直しても残らなかった（別の窓が同じ台帳を書いている） */
  | "lost";

/**
 * 書き込みをやり直す回数。
 *
 * 1回目で入らないのは「読んでから書くまでのあいだに、別の窓が書いた」
 * ときである。やり直せば**今度は相手の書いたものを土台にできる**ので、
 * 消えたほうが自分で入れ直せる。無限には粘らない——粘っている間、
 * 呼び出し側（測定の完了通知）が待たされる。
 */
const WRITE_TRIES = 3;

/**
 * 手元の写しを読み直す間隔。
 *
 * 台帳を引く関数（`resolveTimeoutMs` など）は**同期**で、AIを呼ぶたびに
 * 通る。ファイルの読み出しは非同期なので、**読むのは手元の写しから**に
 * して、古くなっていたら裏で読み直しを始める。
 *
 * **これが無いと、別の窓で測った値がこの窓へ一生入ってこない。** 設定の
 * ときは VS Code が勝手に配ってくれていた仕事で、ファイルにした以上は
 * こちらで持つ必要がある。
 */
const REFRESH_INTERVAL_MS = 2000;

/** 保管庫の場所（`setTuningStoreRoot` で一度だけ渡る）。無ければ読み書きしない */
let storeRoot: string | undefined;

/** 手元の写し。**同期で引く側はここだけを見る** */
let cachedTable: Record<string, unknown> = {};

/** 最後にファイルから読めた時刻（`REFRESH_INTERVAL_MS` の判断に使う） */
let loadedAt = 0;

/** いま走っている読み直し。二重に走らせない */
let loading: Promise<void> | undefined;

/**
 * ファイルが**壊れている**か。
 *
 * 壊れたJSONは直さない（実装ルール2）。空の表として扱って上書きすると、
 * 作者が何時間もかけて測った値がその場で消える。読みは諦めるしかないが、
 * **書き込みは断る。**
 */
let broken = false;

/**
 * 台帳の置き場を、起動時に一度だけ渡す（`extension.ts`）。
 *
 * 手本は `views/openDocument.ts` の `setGeneratedStorageRoot`。
 * **各所へ `ExtensionContext` を持ち回らない**——台帳を引く場所は
 * プロバイダ6つと機能側に散らばっており、その全部に引数を足すのは
 * この件と関係のないところまで書き換えることになる。
 */
export async function setTuningStoreRoot(root: vscode.Uri): Promise<void> {
  // **`vscode-userdata:` は手元に実体があるので OS のパスへ倒す。**
  // 拡張機能開発ホストでは `globalStorageUri` がこの仕組みで渡ってくる。
  // `fromUri` の一般規則（`file:` 以外は URI の文字列）に任せると
  // `C:\vscode-userdata:\…` という無い場所を指して落ちる
  // （生成文書で実際に踏んだ穴。2026-09-05）。ブラウザ版の `vscode-vfs:`
  // などは実体が無いので、これまでどおり文字列のまま
  storeRoot =
    root.scheme === "vscode-userdata" ? root.fsPath : path.fromUri(root);
  cachedTable = {};
  loadedAt = 0;
  broken = false;
  try {
    // **起動の1回だけは、引っ越しも通す**（`loadOrMigrate`）。以後の
    // 読み直し（`reloadTuningStore`）は読むだけ——分けないと「作者が
    // 消した」と「まだ一度も作っていない」を区別できず、消したはずの
    // 記録が設定から蘇る
    const table = await loadOrMigrate();
    if (table !== undefined) cachedTable = table;
  } catch (error) {
    // **ここで投げると、拡張機能そのものが起動しない。** 台帳が読めない
    // のは「測る前の状態で動く」だけのことなので、記録に残して先へ進む
    logLine(
      "AIチューニングの台帳を読み込めませんでした：" +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
  loadedAt = Date.now();
}

/** 台帳のファイルの場所。置き場が渡っていなければ undefined */
function storeFile(): string | undefined {
  return storeRoot === undefined
    ? undefined
    : path.join(storeRoot, TUNING_STORE_FILE);
}

/**
 * 台帳の生の表（同期）。**引く側はこれを読む。**
 *
 * 返すのは手元の写しで、古ければ裏で読み直しを始める
 * （`REFRESH_INTERVAL_MS`）。**中身を書き換えないこと**——書き換えは
 * `writeTuningEntry` / `forgetModelTuning` を通す。
 */
export function tuningStoreTable(): Record<string, unknown> {
  if (storeRoot !== undefined && Date.now() - loadedAt > REFRESH_INTERVAL_MS) {
    void reloadTuningStore();
  }
  return cachedTable;
}

/** ファイルが壊れていて、書き込みを断っている状態か（画面が理由を出すのに使う） */
export function isTuningStoreBroken(): boolean {
  return broken;
}

/**
 * ファイルから読み直す。**呼び出し側が「いまの中身」を要るときに使う**
 * （記録を消す画面など）。失敗しても投げない——引けないだけで、
 * 作者の操作を止める理由にはならない。
 */
export async function reloadTuningStore(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const table = await readTuningFile();
      if (table !== undefined) cachedTable = table;
    } catch {
      // **投げない。** ここは同期の読み出し（`tuningStoreTable`）から
      // 待たずに呼ばれることがあり、投げると行き場の無い失敗になる
    } finally {
      // 読めても読めなくても時刻は進める。読めない置き場で
      // 毎回読みにいくと、AIを呼ぶたびに失敗が積み上がる
      loadedAt = Date.now();
      loading = undefined;
    }
  })();
  return loading;
}

/**
 * 台帳のファイルを読む。
 *
 * - 置き場が無い／ファイルが無い → `{}`（まだ何も測っていない、と同じ）
 * - 読めるが JSON として壊れている → `undefined`（**壊れている**）
 *
 * 壊れているときに `{}` を返さないのは、**そのまま書き戻して作者の実測を
 * 消さない**ため（実装ルール2）。
 */
async function readTuningFile(): Promise<Record<string, unknown> | undefined> {
  const file = storeFile();
  if (file === undefined) return {};

  let text: string;
  try {
    // **読むだけなので、手元では Node の `fs` を通る**（`core/fileRead.ts`、
    // 設計書6.107）。台帳は起動直後に読まれ、`vscode.workspace.fs` の
    // 列に並ぶと一覧が出るのを後ろへずらす。**書き込みは `atomicWriteFile`
    // のまま**——退避と照合の道は速さのために迂回しない
    const bytes = await (await fileReader()).readFile(file);
    text = new TextDecoder().decode(bytes);
  } catch {
    // まだ無いだけ（初回）か、読めない置き場か。どちらも「空」として扱う
    // ——ここで壊れている扱いにすると、初回から書き込みを断ってしまう
    return {};
  }

  if (text.trim().length === 0) return {};

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return noteBroken(file, "中身が表の形ではありません");
    }
    broken = false;
    return { ...(parsed as Record<string, unknown>) };
  } catch (error) {
    return noteBroken(file, error instanceof Error ? error.message : String(error));
  }
}

/** 壊れていることを、一度だけ記録に残す（呼び出しのたびに書くとログが埋まる） */
function noteBroken(file: string, reason: string): undefined {
  if (!broken) {
    broken = true;
    logLine(
      `AIチューニングの台帳（${file}）が読めません：${reason}。` +
        "直すまで書き込みを止めます（測った値を上書きしないため）。"
    );
  }
  return undefined;
}

/** 表をファイルへ書く。**上書きは一時ファイル経由**（`atomicWriteFile` の既定） */
async function writeTuningFile(table: Record<string, unknown>): Promise<void> {
  const file = storeFile();
  if (file === undefined || storeRoot === undefined) return;
  /*
    **置き場を先に作る。** 拡張機能の保管庫は、VS Code が勝手に作って
    くれるとは限らない（初めてその拡張機能を動かした機械では無い）。
    `atomicWriteFile` は一時ファイルを同じ場所へ置くので、無いままだと
    **最初の1件目から書けない**——しかも失敗するのは引っ越しの最中で、
    作者の実測が新しい置き場へ渡らないまま終わる。
  */
  await vscode.workspace.fs.createDirectory(path.toUri(storeRoot));
  // 作者が開いて読むことがあるので、字下げして書く
  const text = `${JSON.stringify(table, null, 2)}\n`;
  // **`replaceGuarded`（`mode: "replace"` ＋ `expectedHash`）は使わない。**
  // あれは正規ファイルへ触れずに提案を回復パスへ残す経路で、必ず失敗する
  // （実装ルール2）。ここは `SettingsStore` 系と同じ①の経路
  await atomicWriteFile(file, new TextEncoder().encode(text));
  cachedTable = { ...table };
  loadedAt = Date.now();
}

/**
 * 書き込みを、順番に1つずつ通す。
 *
 * **同じプロセスの中の競合だけを塞ぐ。** もとの `modelTuning.ts` の
 * `tuningWriteQueue` をそのまま持ってきたもので、別の窓との取り合いは
 * 下の「書いて、読み直して、消えていたらやり直す」が受け持つ。
 */
let writeQueue: Promise<void> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const done = writeQueue.then(work);
  // 1つ失敗しても、次を止めない。列そのものは常に進める
  writeQueue = done.then(
    () => undefined,
    () => undefined
  );
  return done;
}

/**
 * そのモデルぶんの調整値を、**指定した欄だけ差し替えて**書く。
 *
 * `undefined` を渡した欄は消える。残る欄が1つも無くなったら鍵ごと落とす。
 * 読めない欄・知らない欄（作者が手で書いた覚え書き）はそのまま残す。
 *
 * ## 書いたあと、必ず読み直して確かめる
 *
 * 別の窓が、こちらが読んでから書くまでのあいだに書いていることがある。
 * そのときは**こちらの欄が消えている**ので、読み直してやり直す——
 * やり直しでは相手の書いたものを土台にするから、両方が残る。
 *
 * @returns 入ったかどうか（`TuningWriteOutcome`）。**呼び出し側は、これを
 *   見てから作者へ報告すること**——見ないと、書けていないのに「覚えました」
 *   と言うことになる（作者の報告、2026-09-19）
 */
export async function writeTuningEntry(
  key: string,
  fields: Readonly<Record<string, unknown>>
): Promise<TuningWriteOutcome> {
  return enqueue(async (): Promise<TuningWriteOutcome> => {
    /*
      **書く先が無いことを、先に見分ける。**

      置き場が渡っていないと `readTuningFile` は空の表を返し、
      `writeTuningFile` は何もせずに戻るので、下の確かめは「消えた」と
      判定して3回やり直したうえで諦める。**理由がまるで違うものを同じ
      札で返さない**——別の窓との取り合いなら窓を閉じれば直るが、
      置き場が無いのは閉じても直らない。
    */
    if (storeFile() === undefined) {
      logLine(
        `AIチューニングの台帳の置き場が無いため、${key} の` +
          `${Object.keys(fields).join("・")} を書きませんでした。`
      );
      return "no_store";
    }

    for (let attempt = 1; attempt <= WRITE_TRIES; attempt += 1) {
      const before = await readTuningFile();
      if (before === undefined) {
        // **壊れたファイルの上から書かない**（実装ルール2）。読めない理由は
        // `readTuningFile` が一度だけ書いているが、**断ったことは毎回書く**
        // ——書き込みは滅多に起きないし、黙って効かないのがいちばん困る
        logLine(
          `AIチューニングの台帳が読めないため、${key} の` +
            `${Object.keys(fields).join("・")} を書きませんでした。`
        );
        return "unreadable";
      }

      const next = { ...before };
      const entry = asRecord(next[key]);
      for (const [name, value] of Object.entries(fields)) {
        if (value === undefined) delete entry[name];
        else entry[name] = value;
      }
      if (Object.keys(entry).length === 0) delete next[key];
      else next[key] = entry;

      await writeTuningFile(next);

      const after = await readTuningFile();
      if (after === undefined) return "unreadable";
      const lost = [
        ...missingFields(after[key], fields),
        ...vanishedKeys(before, after, [key]),
      ];
      if (lost.length === 0) return "written";

      if (attempt === WRITE_TRIES) {
        // **黙って諦めない**（CLAUDE.md「エラーは握りつぶさない」）。
        // ただし例外は投げない——測定の結果を作者へ見せる流れを、
        // 台帳の都合で止めない（見せるものは既に手元にある）
        logLine(
          `AIチューニングの台帳：${key} の ${lost.join("・")} が` +
            `${WRITE_TRIES}回試しても書けませんでした` +
            "（別の窓が同時に書いている可能性があります）。"
        );
      }
    }
    return "lost";
  });
}

/**
 * 記録を**鍵ごと**消す（詳細メニュー「AIチューニングの記録を消す」）。
 *
 * 設定のときは「設定画面を開いて JSON を手で削る」しか道が無かった。
 * ファイルへ移すと設定画面から見えなくなるので、**消せる口をこちらで持つ**
 * （作者の裁定、2026-09-18）。
 *
 * @returns 実際に消えた件数
 */
export async function forgetModelTuning(
  keys: readonly string[]
): Promise<number> {
  if (keys.length === 0) return 0;
  return enqueue(async () => {
    let removed = 0;
    for (let attempt = 1; attempt <= WRITE_TRIES; attempt += 1) {
      const before = await readTuningFile();
      if (before === undefined) {
        logLine(
          "AIチューニングの台帳が読めないため、記録を消せませんでした" +
            `（${keys.join("・")}）。`
        );
        return 0;
      }

      const next = { ...before };
      removed = 0;
      for (const key of keys) {
        if (key in next) {
          delete next[key];
          removed += 1;
        }
      }
      if (removed === 0) return 0;

      await writeTuningFile(next);

      const after = await readTuningFile();
      if (after === undefined) return removed;
      const stillThere = keys.filter((key) => key in after);
      const lost = vanishedKeys(before, after, keys);
      if (stillThere.length === 0 && lost.length === 0) return removed;

      if (attempt === WRITE_TRIES) {
        logLine(
          "AIチューニングの台帳：記録を消しきれませんでした" +
            `（残り ${stillThere.join("・")}／巻き添え ${lost.join("・")}）。`
        );
      }
    }
    return removed;
  });
}

/**
 * 設定 `novelai.modelTuning` から、**1回だけ**写す。
 *
 * ファイルがまだ無いときだけ走る。**設定は消さない**——作者のデータを
 * 勝手に消さない（実装ルール2）。写したあとは設定を読まないので、
 * 残っていても使われない。
 *
 * **生のまま写す。** `parseModelTuning` を通すと、こちらが解釈できない欄
 * （作者が手で書いた覚え書き）が引っ越しで消える。
 */
async function migrateFromSettings(): Promise<Record<string, unknown>> {
  const raw: unknown = vscode.workspace
    .getConfiguration("novelai")
    .get<unknown>("modelTuning");
  const table = asRecord(raw);
  const count = Object.keys(table).length;
  if (count === 0) return {};

  await writeTuningFile(table);
  logLine(
    `AIチューニングの台帳を、設定から拡張機能の保管庫へ移しました（${count}件）。` +
      "設定のほうはそのまま残していますが、以後は読みません。"
  );
  return table;
}

/** 素の物なら浅い写しを、そうでなければ空の物を返す（元は書き換えない） */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/** 入れたはずの欄で、書けていないものの名前 */
function missingFields(
  saved: unknown,
  fields: Readonly<Record<string, unknown>>
): string[] {
  const entry = asRecord(saved);
  return Object.entries(fields)
    .filter(([name, value]) =>
      value === undefined ? name in entry : entry[name] !== value
    )
    .map(([name]) => name);
}

/** 読んだときにはあったのに、書いたあとで消えている鍵（`except` は除く） */
function vanishedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  except: readonly string[]
): string[] {
  return Object.keys(before).filter(
    (key) => !except.includes(key) && !(key in after)
  );
}

/**
 * ファイルが無ければ設定から引っ越し、あればそのまま読む。
 *
 * `readTuningFile` は「ファイルが無い」も「置き場が無い」も `{}` を返すので、
 * **引っ越しをするかどうかはファイルの有無で決める**（`{}` で判断すると、
 * 作者が全部消したあとで設定から蘇ってしまう）。
 */
async function loadOrMigrate(): Promise<Record<string, unknown> | undefined> {
  const file = storeFile();
  if (file === undefined) return {};
  try {
    // 有無を訊くだけ（読むだけの道）。上と同じ理由で `core/fileRead.ts` を通す
    await (await fileReader()).stat(file);
  } catch {
    // まだ無い＝この機械で初めて動いた。設定に中身があれば写す
    return migrateFromSettings();
  }
  return readTuningFile();
}
