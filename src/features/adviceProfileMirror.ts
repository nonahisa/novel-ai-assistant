// ログの書き先：作品が定まらない——控えは作者ごとの既定と全作品ぶんを
// まとめて1つのファイルへ書くので、どれか1作品のログへ寄せると、
// 他の作品を触ったときの記録が別の作品のログに紛れる（保管庫のログへ倒す）
import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { AdviceProfile } from "../core/advicePolicy";
import type { AdvicePolicyStore } from "../core/advicePolicyStore";
import {
  ADVICE_MIRROR_DEFAULT_KEY,
  ADVICE_MIRROR_FILE,
  adviceMirrorEntryOf,
  adviceMirrorKey,
  adviceProfileFingerprint,
  emptyAdviceMirror,
  isAdviceMirrorNewer,
  parseAdviceMirror,
  putAdviceMirrorEntry,
  removeAdviceMirrorEntry,
  serializeAdviceMirror,
  type AdviceMirrorEntry,
  type AdviceMirrorFile,
} from "../core/adviceProfileMirror";
import { atomicWriteFile } from "../core/atomicWrite";
import { logLine } from "../core/logger";
import { globalStorageRoot } from "./globalStoragePath";
import type { WriterProfileStore } from "../core/writerProfileStore";
import {
  parseWriterMirror,
  serializeWriterMirror,
  WRITER_MIRROR_FILE,
  WRITER_MIRROR_SCHEMA,
  writerProfileFingerprint,
  type WriterMirrorFile,
} from "../core/writerProfileMirror";
import { describeWriterStyleChange } from "../core/writerStyle";

/**
 * 助言方針の控えを、拡張機能の保管庫へ書き出す／取り込む
 * （設計書6.86.7・6.87.15）。
 *
 * **なぜ要るか。** 助言方針は `globalState` に在り、VS Code の外で走る MCP
 * サーバーからは読めない。そのため**外部AI経由の相談だけ、タイプの方針も
 * 調子（受容度・自信度）の補正も効かなかった。**
 *
 * **なぜ作品フォルダーへ置かないか。** `.aiwriter/` を含めて、あそこは
 * ①**作者が普段開く場所**で、②**GitHub で編集部と共有される**。受容度・自信度は
 * 作者にも見せないと決めたもので（6.86.2。見せると「自信のない人」という
 * ラベルになり、それ自体が地雷になる）、共有もしないと決めたものである。
 * だから `globalStorageUri` の下——**作品フォルダーの外、Git の外、
 * 作者が開かない場所**——へ置く。MCP の束の写しと同じ場所なので、
 * 束の居場所から控えの場所が分かる（`mcp/adviceProfileMirror.ts`）。
 *
 * **控えは作者のデータではない。** 元は `globalState` に在り、消えても
 * 次の起動で書き直される。だから退避は要らない（実装ルール2の3経路のうち①、
 * `writeAiInstructions.ts` の束の写しと同じ扱い）。
 *
 * 読み書きは `vscode.workspace.fs` と `core/paths.ts` だけで済ませる
 * （実装ルール7。`node:fs` を持ち込まない）。
 */

/**
 * 最後に読み書きした控えの時刻（鍵ごと）。
 *
 * **どちらが新しいかを決める唯一の手掛かり。** `AdviceProfile.updatedAt` は
 * 「作者が9問に答えた日」で、推定で点数が動いても動かない——あれで比べると、
 * MCP が書き戻した更新に永久に気づけない。
 */
const KEY_MIRROR_AT = "novelai.advicePolicyMirrorAt";

type MirrorStamps = Record<string, string>;

function stampsOf(context: vscode.ExtensionContext): MirrorStamps {
  return { ...(context.globalState.get<MirrorStamps>(KEY_MIRROR_AT) ?? {}) };
}

function mirrorFilePath(context: vscode.ExtensionContext): string {
  return path.join(globalStorageRoot(context), ADVICE_MIRROR_FILE);
}

async function readMirror(
  context: vscode.ExtensionContext
): Promise<AdviceMirrorFile | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      path.toUri(mirrorFilePath(context))
    );
    return parseAdviceMirror(new TextDecoder().decode(bytes));
  } catch {
    // まだ無い（初回）・読めない。どちらも「控えが無い」として扱う
    return undefined;
  }
}

/**
 * 控えから `globalState` へ取り込む（**起動時に1回**）。
 *
 * **外から来たもので、作者の手元を押し流さない。** 取り込むのは
 * 「最後にこちらが読み書きした時刻より、控えのほうが新しい」ときだけで、
 * 決められないとき（日付が読めない・同じ時刻）は `globalState` を残す。
 */
export async function importAdviceProfileMirror(
  context: vscode.ExtensionContext,
  policies: AdvicePolicyStore,
  works: readonly WorkEntry[]
): Promise<void> {
  const file = await readMirror(context);
  if (!file) return;

  const stamps = stampsOf(context);
  let changed = false;

  for (const entry of file.entries) {
    if (!isAdviceMirrorNewer(entry.updatedAt, stamps[entry.key])) continue;

    if (entry.key === ADVICE_MIRROR_DEFAULT_KEY) {
      await policies.setDefault(entry.profile);
      stamps[entry.key] = entry.updatedAt;
      changed = true;
      continue;
    }

    /*
      **どの作品かは、フォルダーの道で決める。** MCP は作品の ID を知らない
      ので、控えを新しく作った回には `workId` が入らない。控えに入っている
      `workId` を頼るのは、登録簿に実在するときだけ——別の機械で作られた
      控えが紛れ込んでも、知らない ID の方針が生えないようにする。
    */
    const work =
      works.find((entry2) => adviceMirrorKey(entry2.folderPath) === entry.key) ??
      works.find((entry2) => entry2.id === entry.workId);
    if (!work) continue;

    await policies.set(work.id, entry.profile);
    stamps[entry.key] = entry.updatedAt;
    changed = true;
  }

  if (!changed) return;
  await context.globalState.update(KEY_MIRROR_AT, stamps);
  // **黙って取り込まない。** 助言の調子が変わった理由が、ここにしか無い
  logLine(
    "相談: 外部AI経由の相談で動いた助言方針の推定を取り込みました" +
      "（中身は出しません）"
  );
}

/**
 * `globalState` から控えへ書き出す（**起動時と、方針が変わったとき**）。
 *
 * **中身が同じなら時刻を動かさない。** 書くたびに新しくすると、MCP が
 * 書き戻した更新を、次の起動で「自分が書いたもの」と取り違える。
 */
export async function refreshAdviceProfileMirror(
  context: vscode.ExtensionContext,
  policies: AdvicePolicyStore,
  works: readonly WorkEntry[]
): Promise<void> {
  try {
    const before = (await readMirror(context)) ?? emptyAdviceMirror();
    const now = new Date().toISOString();
    const stamps = stampsOf(context);
    let next = before;

    const alive = new Set<string>();

    const applyEntry = (
      key: string,
      profile: AdviceProfile | undefined,
      extra: { folderPath?: string; workId?: string }
    ): void => {
      if (!profile) {
        // **作者が「方針を消す」を選んだら、控えからも消す。** 残すと、
        // 消したはずの方針で外部AIが助言し続ける（6.86.8の入口）
        if (adviceMirrorEntryOf(next, key)) next = removeAdviceMirrorEntry(next, key);
        return;
      }
      alive.add(key);
      const previous = adviceMirrorEntryOf(next, key);
      const same =
        previous !== undefined &&
        adviceProfileFingerprint(previous.profile) ===
          adviceProfileFingerprint(profile);
      const entry: AdviceMirrorEntry = {
        key,
        ...extra,
        updatedAt: same ? previous.updatedAt : now,
        // **指紋は書き直さずに引き継ぐ。** 落とすと、外部AIが直前の答えを
        // もう一度渡したときに二度目が効いてしまう（歯止めの迂回）
        ...(previous?.lastSignalHash
          ? { lastSignalHash: previous.lastSignalHash }
          : {}),
        profile,
      };
      next = putAdviceMirrorEntry(next, entry);
      stamps[key] = entry.updatedAt;
    };

    applyEntry(ADVICE_MIRROR_DEFAULT_KEY, policies.getDefault(), {});
    for (const work of works) {
      // **`get` で読む（`getEffective` ではない）。** 既定は既定の鍵で
      // 持っているので、ここで書き写すと、作品ごとに既定の複製ができる
      applyEntry(adviceMirrorKey(work.folderPath), policies.get(work.id), {
        folderPath: work.folderPath,
        workId: work.id,
      });
    }
    alive.add(ADVICE_MIRROR_DEFAULT_KEY);

    /*
      **登録簿から消えた作品の控えは残さない。** MCP は道で引くので、
      作品を登録し直したり畳んだりしたあとも、古い方針で助言が続いてしまう。
      （消すのは控えだけで、`globalState` の方針には触れない。作品を
      登録し直したときに戻せるようにしておく）

      **ただし、登録が1件も無いときは何も消さない。** 登録簿がまだ
      読めていない段で起動すると `works` が空で来ることがあり、そのまま
      掃除すると**控えが一度空になる**——その隙に外部AIが読むと、方針も
      調子も渡らないまま助言することになる。`globalState` は無傷なので
      次の書き出しで戻るが、**戻るまでの間が問題**である。
      「作品が0件」と「まだ読めていない」を、こちらからは区別できない。
    */
    if (works.length > 0) {
      for (const entry of [...next.entries]) {
        if (!alive.has(entry.key)) {
          next = removeAdviceMirrorEntry(next, entry.key);
        }
      }
    }

    const text = serializeAdviceMirror(next);
    if (text === serializeAdviceMirror(before)) return; // 1バイトも触らない

    const target = mirrorFilePath(context);
    await vscode.workspace.fs.createDirectory(
      path.toUri(globalStorageRoot(context))
    );
    // **上書きの経路（指定なし）でよい。** 作者のデータではないので退避は不要
    await atomicWriteFile(target, new TextEncoder().encode(text));
    await context.globalState.update(KEY_MIRROR_AT, stamps);
  } catch (error) {
    // **黙って失敗しない。** 効かない理由が、ここにしか残らない
    logLine(
      "助言方針の控えを保管庫へ書き出せませんでした（外部AI経由の相談では、" +
        "方針と調子が効きません）：" +
        (error instanceof Error ? error.message : String(error))
    );
  }
}

/* ───────────────────────────────────────────────────────────────
   執筆スタイル（作家タイプ診断の5問）の控え（2026-09-23）

   **外部AI経由の相談に、段取りと直す時期を自動で乗せる**ために、助言方針と
   同じ置き場へ書き出す。形は `core/writerProfileMirror.ts`。取り込み・
   書き出しの約束は助言方針と同じ——

   - **取り込むのは、控えのほうが新しいときだけ**（最後にこちらが読み書き
     した時刻と比べる。決められなければ手元を残す）
   - **中身が同じなら時刻を動かさない**（動かすと、MCP の書き戻しを
     次の起動で「自分が書いたもの」と取り違える）
   - **効かせた答えの指紋は引き継ぐ**（落とすと、撃ち直しで「2回続けて
     読み取れたら反映」の歯止めが迂回できる）
   ─────────────────────────────────────────────────────────────── */

/** 最後に読み書きした執筆スタイルの控えの時刻 */
const KEY_WRITER_MIRROR_AT = "novelai.writerProfileMirrorAt";

function writerMirrorPath(context: vscode.ExtensionContext): string {
  return path.join(globalStorageRoot(context), WRITER_MIRROR_FILE);
}

async function readWriterMirror(
  context: vscode.ExtensionContext
): Promise<WriterMirrorFile | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      path.toUri(writerMirrorPath(context))
    );
    return parseWriterMirror(new TextDecoder().decode(bytes));
  } catch {
    // まだ無い（初回）・読めない。どちらも「控えが無い」として扱う
    return undefined;
  }
}

/**
 * 控えから `globalState` へ取り込む（**起動時に1回**）。
 *
 * **直す時期が変わっていたら、作者に見せる**（設計書6.90.1「変わったら
 * 必ず見せる」）。外部AI経由の相談で動いた値は、作者の目の前の相談パネルを
 * 通っていない——黙って取り込むと、案内の並びが変わった理由が分からない。
 */
export async function importWriterProfileMirror(
  context: vscode.ExtensionContext,
  profiles: WriterProfileStore
): Promise<void> {
  const file = await readWriterMirror(context);
  if (!file) return;
  const known = context.globalState.get<string>(KEY_WRITER_MIRROR_AT);
  if (!isAdviceMirrorNewer(file.updatedAt, known)) return;

  const before = profiles.get();
  // **`update` で書く（`set` ではない）。** `set` は診断日を今日にする
  // ——外から来た推定の反映で「作者が答えた日」を動かさない
  await profiles.update(file.profile);
  await context.globalState.update(KEY_WRITER_MIRROR_AT, file.updatedAt);

  logLine(
    "相談: 外部AI経由の相談で動いた執筆スタイル（直す時期）の読み取りを取り込みました"
  );
  const message = before
    ? describeWriterStyleChange(before, file.profile)
    : undefined;
  if (message) void vscode.window.showInformationMessage(message);
}

/**
 * `globalState` から控えへ書き出す（**起動時と、答えが変わったとき**）。
 *
 * 作者が答えを消したら、控えも消す——残すと、消した答えで外部AIが
 * 助言し続ける。
 */
export async function refreshWriterProfileMirror(
  context: vscode.ExtensionContext,
  profiles: WriterProfileStore
): Promise<void> {
  try {
    const target = writerMirrorPath(context);
    const before = await readWriterMirror(context);
    const profile = profiles.get();

    if (!profile) {
      if (before) {
        await vscode.workspace.fs.delete(path.toUri(target));
        await context.globalState.update(KEY_WRITER_MIRROR_AT, undefined);
      }
      return;
    }

    const same =
      before !== undefined &&
      writerProfileFingerprint(before.profile) ===
        writerProfileFingerprint(profile);
    if (same) {
      // 1バイトも触らない。時刻だけ覚え直す（取り込みの比べに使う）
      await context.globalState.update(KEY_WRITER_MIRROR_AT, before.updatedAt);
      return;
    }

    const next: WriterMirrorFile = {
      schema: WRITER_MIRROR_SCHEMA,
      updatedAt: new Date().toISOString(),
      ...(before?.lastSignalHash
        ? { lastSignalHash: before.lastSignalHash }
        : {}),
      profile,
    };
    await vscode.workspace.fs.createDirectory(
      path.toUri(globalStorageRoot(context))
    );
    // **上書きの経路（指定なし）でよい。** 作者のデータではないので退避は不要
    await atomicWriteFile(
      target,
      new TextEncoder().encode(serializeWriterMirror(next))
    );
    await context.globalState.update(KEY_WRITER_MIRROR_AT, next.updatedAt);
  } catch (error) {
    // **黙って失敗しない。** 効かない理由が、ここにしか残らない
    logLine(
      "執筆スタイルの控えを保管庫へ書き出せませんでした（外部AI経由の相談では、" +
        "段取りと直す時期が自動では乗りません）：" +
        (error instanceof Error ? error.message : String(error))
    );
  }
}
