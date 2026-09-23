import fs from "node:fs";
import nodePath from "node:path";
import {
  applyProfileSignals,
  type AdviceProfile,
  type AdviceProfileSignals,
} from "../core/advicePolicy";
import {
  ADVICE_MIRROR_FILE,
  adviceMirrorKey,
  findAdviceMirrorEntry,
  parseAdviceMirror,
  putAdviceMirrorEntry,
  serializeAdviceMirror,
  type AdviceMirrorEntry,
  type AdviceMirrorFile,
} from "../core/adviceProfileMirror";
import {
  parseWriterMirror,
  serializeWriterMirror,
  WRITER_MIRROR_FILE,
  type WriterMirrorFile,
} from "../core/writerProfileMirror";
import {
  applyWriterStyleSignals,
  type WriterStyleSignals,
} from "../core/writerStyle";
import type { WriterProfile } from "../core/writerProfileStore";
import { GLOBAL_STORAGE_ENV, mcpGlobalStorageRoot } from "./globalStorage";

/**
 * 助言方針の控えを、MCP サーバー側から読み書きする（設計書6.86.7・6.87.15）。
 *
 * **なぜ穴があったか。** 方針（タイプ）と調子（受容度・自信度）は
 * `globalState` に在り、VS Code の外で走るこのサーバーからは読めない。
 * その結果**外部AI経由の相談だけ、タイプの方針も調子の補正も効かなかった。**
 * 拡張機能が `globalStorageUri` の下へ控えを書き出し、ここがそれを読む。
 *
 * **控えの場所をどうやって知るか（0.71.x で選んだ道）。**
 *
 * このプロセスは VS Code の外に居るので `context.globalStorageUri` を持たない。
 * 素直なのは `.mcp.json` へ環境変数を書き足すことだが、**そうしなかった。**
 * **走っている束（`dist/mcp-server.mjs`）そのものが、既に控えと同じ場所に在る**
 * からである——拡張機能は版に依らない場所（`globalStorage/<拡張機能ID>/`）へ
 * 束を写してから登録する（6.87.15「束は、版に依らない場所へ写してから登録する」）。
 * だから**自分の居場所の親フォルダーが、そのまま控えの置き場**になる。
 *
 * この道を選ぶと、
 *
 * - **既に書かれている `.mcp.json` がそのまま効く。** 環境変数を足す形だと、
 *   作者が「AI用の指示書を置く」をもう一度走らせるまで穴が塞がらない
 * - 登録の形（`McpRegistration`・JSON・TOML の3か所）を触らずに済む
 *
 * 逃げ道として環境変数（`NOVELAI_GLOBAL_STORAGE`）も見る。束を別の場所へ
 * 写して走らせているとき（開発・試験）に、控えの置き場を明示できる。
 *
 * `fs`・`node:path` を静的に import しているのは、**この束が Node 専用**
 * だからである（`tools/accessLog.ts`・`staleness.ts` と同じ）。`core/` へは
 * 持ち込まない。
 */

/**
 * 控えの置き場を明示する環境変数。**指定があればこちらが勝つ**
 *
 * 決め方そのものは `globalStorage.ts` へ出した（窓の札も同じ保管庫を読む
 * ため。0.75.x）。ここの名前は、既存の試験が指しているので残す。
 */
export const ADVICE_STORAGE_ENV = GLOBAL_STORAGE_ENV;

function mirrorPath(): string | undefined {
  const root = mcpGlobalStorageRoot();
  return root ? nodePath.join(root, ADVICE_MIRROR_FILE) : undefined;
}

/**
 * 控えを読む。**読めなければ `undefined`**（止めない）。
 *
 * 控えが無いのは、拡張機能をまだ起動していないときや、作者が一度も
 * 診断していないときである。どちらも「方針が無い作者」として扱えばよく、
 * 相談そのものは続けられる。
 */
function readMirror(): { file: AdviceMirrorFile; path: string } | undefined {
  const path = mirrorPath();
  if (!path) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const file = parseAdviceMirror(text);
  return file ? { file, path } : undefined;
}

/**
 * その作品で使う助言方針。作品に無ければ**作者の既定**へ落ちる
 * （製品の `AdvicePolicyStore.getEffective` と同じ）。
 */
export function readAdviceProfile(folder: string): AdviceProfile | undefined {
  const mirror = readMirror();
  if (!mirror) return undefined;
  return findAdviceMirrorEntry(mirror.file, folder)?.profile;
}

export type AdviceProfileUpdate =
  | "updated"
  /** 同じ答えをもう一度渡された（**二度は効かせない**） */
  | "duplicate"
  | "unchanged"
  | "absent";

/**
 * 相談の答えから読み取った傾向を、控えへ書き戻す。
 *
 * **歯止めは `applyProfileSignals` のものをそのまま使う**（±0.5ずつ・
 * 受容度「低」は2回続かないと下げない・14日で切れる）。ここで別の計算を
 * 書くと、製品と MCP で助言の動き方が変わる。
 *
 * **方針がどこにも無ければ作らない**（`"absent"`）。製品の
 * `updateAdvicePolicy` と同じで、診断していない作者の値を推定で生やさない。
 *
 * **既定から始まった作品でも、推定は効かせる。** 書き戻し先はその作品の鍵で、
 * 作者の既定は動かない（製品が `getEffective` で読み、`set(workId)` で
 * 書くのと同じ形）。
 *
 * **同じ答えは二度効かせない**（`responseHash`）。外部AIは `novel.validate` を
 * 撃ち直せるので、そのまま効かせると ±0.5 が ±1.0 になり、
 * **歯止めそのものが撃ち直しで迂回できる。** 製品の相談は1つの答えにつき
 * 1回しか通らないので、ここを揃える。
 *
 * @param responseHash 相談の答えの指紋。省くと（古い呼び方）これまでどおり
 *   毎回効かせる——**歯止めは呼ぶ側が指紋を渡して初めて効く。**
 */
/**
 * 「撃ち直し」とみなす時間の幅（ミリ秒）。
 *
 * **撃ち直しは秒単位、相談の間隔は分単位**なので、その間に線を引く。
 * **読めない時刻は「窓の外」**として扱う——弾くほうへ倒すと、
 * 時刻が壊れた控えで推定が止まったままになる。
 */
const DUPLICATE_WINDOW_MS = 60_000;

function withinDuplicateWindow(updatedAt: string, now: Date): boolean {
  const at = Date.parse(updatedAt);
  if (Number.isNaN(at)) return false;
  const elapsed = now.getTime() - at;
  // 先の時刻（機械の時計がずれている）も窓の中とみなす。撃ち直しの
  // 可能性があるなら、弾くほうが安全である（効かせすぎない側へ倒す）
  return elapsed < DUPLICATE_WINDOW_MS;
}

export function updateAdviceProfile(
  folder: string,
  signals: AdviceProfileSignals,
  responseHash?: string,
  now: Date = new Date()
): AdviceProfileUpdate {
  const mirror = readMirror();
  if (!mirror) return "absent";

  const source = findAdviceMirrorEntry(mirror.file, folder);
  if (!source) return "absent";

  /*
    **同じ答えが続けて来たら、二度目は効かせない。** ただし**時間で区切る。**

    弾く相手は「撃ち直し」——同じ答えを秒のうちにもう一度渡された場合である。
    **別々の相談で、たまたま同じ文面が返ることがある**ので、そこまで弾くと
    **受容度「低」の連続判定が永久に成立しない**（2回続かないと下げない、
    という歯止めが、下げる側だけ効かなくなる）。**指摘がきつくて2回続けて
    同じ反応を返した作者が、いつまでも「受け取れる人」のままになる**——
    これはこの仕組みが防ごうとしている事故そのものである。

    **実際に起きうる。** 小さいモデルは同じ文面を返しやすく、2026-09-20 の
    測定では `gemma4:12b` が2つの話で2回とも同じ空の答えを返した（8章）。

    窓を60秒にしたのは、**撃ち直しは秒単位、相談の間隔は分単位**だからである。
  */
  if (
    responseHash !== undefined &&
    source.lastSignalHash === responseHash &&
    withinDuplicateWindow(source.updatedAt, now)
  ) {
    return "duplicate";
  }

  const after = applyProfileSignals(source.profile, signals, now);
  if (after === source.profile) return "unchanged";

  const key = adviceMirrorKey(folder);
  const entry: AdviceMirrorEntry = {
    key,
    // **作品の鍵で書く。** 既定から落ちてきた場合は、ここで作品の控えができる
    folderPath: source.key === key ? source.folderPath ?? folder : folder,
    workId: source.key === key ? source.workId : undefined,
    updatedAt: now.toISOString(),
    lastSignalHash: responseHash,
    profile: after,
  };

  const next = putAdviceMirrorEntry(mirror.file, entry);
  return writeMirror(mirror.path, next) ? "updated" : "absent";
}

/* ───────────────────────────────────────────────────────────────
   執筆スタイル（作家タイプ診断の5問）の控え（2026-09-23）

   **外部AI経由の相談に、段取りと直す時期を自動で乗せる。** 以前は
   `writerStyle` を明示したときだけ乗り、相談で読み取った直す時期も
   書き戻さなかった。控えの形は `core/writerProfileMirror.ts`。
   ─────────────────────────────────────────────────────────────── */

function writerMirrorPath(): string | undefined {
  const root = mcpGlobalStorageRoot();
  return root ? nodePath.join(root, WRITER_MIRROR_FILE) : undefined;
}

function readWriterMirror():
  | { file: WriterMirrorFile; path: string }
  | undefined {
  const path = writerMirrorPath();
  if (!path) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const file = parseWriterMirror(text);
  return file ? { file, path } : undefined;
}

/** 作者の執筆スタイル。**控えが無ければ `undefined`**（診断していない作者） */
export function readWriterProfile(): WriterProfile | undefined {
  return readWriterMirror()?.file.profile;
}

export type WriterProfileUpdate =
  /** 直す時期が変わった（`before`・`after` を見れば何が何へ変わったか分かる） */
  | { outcome: "updated"; before: WriterProfile; after: WriterProfile }
  /** 読み取りを数えただけ（2回続けて同じに読めたら反映） */
  | { outcome: "counted"; before: WriterProfile; after: WriterProfile }
  | { outcome: "duplicate" }
  | { outcome: "unchanged" }
  | { outcome: "absent" };

/**
 * 相談の答えから読み取った直す時期を、控えへ書き戻す。
 *
 * **歯止めは製品のものをそのまま通す**（`applyWriterStyleSignals`：2回続けて
 * 同じに読めたときだけ動く）。**同じ答えは二度効かせない**——撃ち直しで
 * 「2回続けて」が1つの答えで成立してしまう（助言方針の `updateAdviceProfile`
 * と同じ指紋と60秒の窓）。
 *
 * **診断していない作者の値は、推定で作らない**（`"absent"`。製品の
 * `updateWriterStyle` と同じ）。
 */
export function updateWriterProfile(
  signals: WriterStyleSignals,
  responseHash?: string,
  now: Date = new Date()
): WriterProfileUpdate {
  const mirror = readWriterMirror();
  if (!mirror) return { outcome: "absent" };
  const source = mirror.file;

  if (
    responseHash !== undefined &&
    source.lastSignalHash === responseHash &&
    withinDuplicateWindow(source.updatedAt, now)
  ) {
    return { outcome: "duplicate" };
  }

  const before = source.profile;
  const after = applyWriterStyleSignals(before, signals);
  if (after === before) return { outcome: "unchanged" };

  const next: WriterMirrorFile = {
    schema: source.schema,
    updatedAt: now.toISOString(),
    ...(responseHash ? { lastSignalHash: responseHash } : {}),
    profile: after,
  };
  if (!writeText(mirror.path, serializeWriterMirror(next))) {
    return { outcome: "absent" };
  }
  return before.style.revise === after.style.revise
    ? { outcome: "counted", before, after }
    : { outcome: "updated", before, after };
}

/**
 * 控えを書き戻す。
 *
 * **同じフォルダーの一時ファイルへ書いてから置き換える**（拡張機能側の
 * `atomicWriteFile` と同じ形）。途中で落ちても、読みかけの半端な控えを
 * 相手に残さない。
 *
 * **書けなくても道具を止めない**（`accessLog.ts` と同じ）。控えが更新
 * されないのは困るが、そのために作者が頼んだ相談を失敗させるのは本末転倒である。
 */
function writeMirror(path: string, file: AdviceMirrorFile): boolean {
  return writeText(path, serializeAdviceMirror(file));
}

function writeText(path: string, text: string): boolean {
  const temporary = `${path}.novelai-mcp.tmp`;
  try {
    fs.mkdirSync(nodePath.dirname(path), { recursive: true });
    fs.writeFileSync(temporary, text, "utf8");
    fs.renameSync(temporary, path);
    return true;
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // 後片付けに失敗しても言うことは無い（次の書き込みで上書きされる）
    }
    return false;
  }
}
