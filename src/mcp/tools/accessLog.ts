import fs from "node:fs";
import nodePath from "node:path";
import { AIWRITER_DIR } from "../../models/types";
import {
  EXTERNAL_ACCESS_DIRECTORY,
  EXTERNAL_ACCESS_DENIED_DETAIL,
  EXTERNAL_ACCESS_FILE,
  formatExternalAccessLine,
  type ExternalAccessEntry,
  type ExternalExposure,
} from "../../core/externalAccessLog";
import { permissionKeyOf } from "../../core/externalAccessPermission";

/**
 * 外部AIが作品を触ったことを1行残す（設計書6.87.9）。
 *
 * **転送層が1か所で呼ぶ。** 道具ごとに書くと、新しい道具を足した人が
 * 忘れる——そして**忘れたことは作者には見えない**。`server.ts` の
 * `tool()` を通るものは全部ここを通り、通っているかは
 * `test/unit/mcp/mcpAccessLog.test.ts` が見張る。
 *
 * **書けなくても道具を止めない。** 記録が残らないのは困るが、そのために
 * 作者が頼んだ測定を失敗させるのは本末転倒である（`editHistory.ts` と同じ）。
 */

/**
 * 呼んだ相手の名乗り。
 *
 * MCP の `initialize` で受け取ったものを、転送層が入れる。
 * **名乗りは相手の自己申告**なので、身元の証明ではない。それでも
 * 「Claude Code から」「別の何かから」の区別は、作者の役に立つ。
 */
let clientName = "";

export function setExternalClientName(name: string): void {
  clientName = name.trim().slice(0, 80);
}

/** いま繋いでいる相手の名乗り。**許可の見分けにも使う**（設計書6.87.14） */
export function getExternalClientName(): string {
  return clientName;
}

/**
 * その道具が、原稿をどこまで外へ出すか。
 *
 * **道具の名前だけで決める**（`run` の行き先だけは引数を見る）。引数の中身で
 * 判断すると、新しい道具が増えたときに「どれにも当てはまらないから記録しない」
 * が起きる。ここは**知らない道具を `body`（いちばん重い）に倒す**——
 * 軽いほうへ倒すと、本当に本文が出た回を見落とす。
 *
 * **0.66.7 で道具を束ねたので、名前は10個しか無い。** 末尾で見分けていた
 * （`.run`／`Run`）のをやめ、**名前をそのまま並べる**——見分けの規則より、
 * 並んでいるほうが取りこぼしを見つけやすい。
 */
export function exposureOf(
  tool: string,
  args: Record<string, unknown> | undefined
): ExternalExposure {
  /*
    作品に触れないもの。`ollama.models` は**手元に何が入っているかを読むだけ**
    （設計書6.87.15 の柱2の2）で、こちらから本文も資料も送らない。
    `novel.propose`（設計書6.87.16）も**原稿は1文字も外へ出ない**——
    呼び出し元が持ち込んだ内容を置くだけで、こちらから本文も資料も返さない。
    `novel.notice`（0.72.0）も同じで、**渡された申告から断りを組むだけ**
    ——作品フォルダーは許可の鍵としてしか使わず、ファイルを1つも開かない。
    `guide.spotlight`（0.75.6、設計書6.104）も**画面を光らせる依頼を1行
    置くだけ**で、原稿も設定資料も読まないし、操作も実行しない。
    `windows.list`（0.75.x）は**保管庫の窓の札を読むだけ**で、作品フォルダーを
    1つも開かない（`mcp.version` と同じ）。
    `setup.request`（0.82.1、設計書6.87.18）は**作者の画面に確認を出させる
    URI を開くだけ**で、ファイルを1つも読まない。
  */
  if (
    tool === "mcp.version" ||
    tool === "windows.list" ||
    tool === "setup.request" ||
    tool === "ollama.models" ||
    tool === "novel.propose" ||
    tool === "novel.notice" ||
    tool === "guide.spotlight" ||
    /*
      `schedule.milestones`（設計書6.111.15）は**スケジュールの日付と名前だけ**を返し、
      本文も設定資料も開かない（`設定/スケジュール.json` と作品目標設定だけを読む）。
    */
    tool === "schedule.milestones"
  ) {
    return "none";
  }

  // `run` は runner で分かれる。**手元の Ollama なら、この機械から出ない**
  if (tool === "novel.run") {
    const runner = args?.runner;
    if (runner === "ollama") {
      // ただし遠くの Ollama を指していれば、出ている
      return args?.allowRemote === true && typeof args?.endpoint === "string"
        ? "body"
        : "local";
    }
    return "body";
  }

  // プロンプトを組んで返すもの——**本文がまとまって呼び出し元へ渡る**
  if (tool === "novel.prompt") return "body";

  // 走査・検算・検出・材料——抜粋と名前と件数が渡る
  if (
    tool === "novel.scan" ||
    tool === "novel.validate" ||
    tool === "novel.detect" ||
    tool === "novel.material"
  ) {
    return "excerpt";
  }

  // `ollama.generate` は呼び出し元が本文を持ち込む口。外から来た本文が
  // 手元のOllamaへ渡るだけなので、この作品の原稿が出たとは限らない。
  // **それでも軽く見ない**——持ち込まれたのが原稿の一部である見分けは付かない
  return "body";
}

/**
 * 記録する対象のファイル。**無い道具もある**（表記ゆれは作品ぜんたい）。
 *
 * 単話プロット（`plotPath`）は `options` の中に入る（0.66.7 で束ねたため）。
 * **ここを見落とすと、その機能のときだけ記録に対象が残らない。**
 */
function fileOf(args: Record<string, unknown> | undefined): string {
  const options = args?.options;
  const inOptions =
    typeof options === "object" && options !== null && !Array.isArray(options)
      ? (options as Record<string, unknown>).plotPath
      : undefined;
  const candidate = args?.filePath ?? args?.plotPath ?? inOptions;
  return typeof candidate === "string" ? candidate : "";
}

function modelOf(args: Record<string, unknown> | undefined): string {
  return args?.runner === "ollama" && typeof args?.model === "string"
    ? args.model
    : "";
}

/**
 * 補足。**件数と指し方だけ**を入れる。
 *
 * 本文・抜粋は入れない（記録が原稿の写しになると、同期先に原稿が二重に載る）。
 */
function detailOf(
  tool: string,
  args: Record<string, unknown> | undefined,
  failure: string | undefined
): string {
  if (failure) return failure;
  /*
    承認待ちへ置いた回は、**何をしたかが一目で分かる形**で残す（6.87.16）。
    人物の名前までは入れるが、**`changes` の中身は入れない**——記録が
    資料の写しになると、同期先に同じ文が二重に載る。
  */
  if (tool === "novel.propose") {
    const name = typeof args?.name === "string" ? args.name : "";
    return name ? `承認待ちへ置いた（${name}）` : "承認待ちへ置いた";
  }
  /*
    画面を指した回（0.75.6）。**何を指したかを残す**——`feature` を
    取らない道具なので、ここを書かないと記録が「guide.spotlight」だけになり、
    作者にはどの項目を光らせようとしたのか分からない。
  */
  if (tool === "guide.spotlight") {
    const pointed =
      (typeof args?.command === "string" && args.command) ||
      (typeof args?.label === "string" && args.label) ||
      "";
    return pointed ? `画面で指した（${pointed}）` : "画面で指した";
  }
  if (tool === "schedule.milestones") return "締切・発売日などの日付を読んだ";
  const parts: string[] = [];
  /*
    **どの機能だったかを残す**（0.66.7）。道具の名前は `novel.run` の1つに
    なったので、`feature` が無いと作者には「何をされたか」が見えない。
  */
  if (typeof args?.feature === "string") parts.push(args.feature);
  if (typeof args?.chunkIndex === "number") {
    parts.push(`チャンク${args.chunkIndex}`);
  }
  if (typeof args?.chunkId === "string") parts.push(args.chunkId);
  if (typeof args?.chapter === "number") parts.push(`第${args.chapter}話`);
  return parts.join(" ");
}

/**
 * 書き足す場所。**同期される側**（`cache/` と `logs/` だけが除外）。
 */
function logPathOf(folder: string): string {
  return nodePath.join(
    nodePath.resolve(folder),
    AIWRITER_DIR,
    EXTERNAL_ACCESS_DIRECTORY,
    EXTERNAL_ACCESS_FILE
  );
}

export interface RecordAccessInput {
  tool: string;
  args: unknown;
  ok: boolean;
  /** 失敗したときの短い理由。成功なら省く */
  failure?: string;
  /**
   * 許可が無くて断ったか（設計書6.87.10）。
   *
   * **断った回こそ残す。** 「誰かが繋ごうとした」ことは、許可した回より
   * 作者が知りたいことである。原稿は1文字も出ていないので `none` で残す。
   */
  denied?: boolean;
}

/**
 * 1件書き足す。
 *
 * **作品フォルダーの分かる呼び出しだけを残す。** `folder` を取らない道具
 * （`mcp.version`・`ollama.generate`）は、どの作品の記録なのか決められない。
 *
 * @returns 書けたか（テストが見るためだけに返す。呼ぶ側は見なくてよい）
 */
export function recordExternalAccess(input: RecordAccessInput): boolean {
  const args =
    typeof input.args === "object" &&
    input.args !== null &&
    !Array.isArray(input.args)
      ? (input.args as Record<string, unknown>)
      : undefined;
  const folder = args?.folder;
  if (typeof folder !== "string" || !folder.trim()) return false;

  const entry: ExternalAccessEntry = {
    time: new Date().toISOString(),
    tool: input.tool,
    /*
      **許可の鍵も残す**（0.66.7）。道具の名前は `novel.run` の1本に
      束ねられたので、名前だけでは作者が何を許可すればよいか決められない
      ——ノックの画面（6.87.14）はここを見て、その機能だけを許す。
      決め方は `permissionKeyOf` に1つだけ（許可を確かめる側と同じもの）。
    */
    key: permissionKeyOf(input.tool, args?.feature),
    client: clientName,
    file: fileOf(args),
    // 断った回は原稿が1文字も出ていないので `none`
    exposure: input.denied ? "none" : exposureOf(input.tool, args),
    model: modelOf(args),
    ok: input.ok,
    detail: input.denied
      ? EXTERNAL_ACCESS_DENIED_DETAIL
      : detailOf(input.tool, args, input.failure),
  };

  try {
    const target = logPathOf(folder);
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    /*
      **追記だけ（`a`）。** 複数のクライアント・複数の機械が同時に書いても、
      追記どうしなら行が並ぶだけで、両方残れば正しい履歴になる。
      書き換えると、そこで履歴の意味が消える。
    */
    fs.appendFileSync(target, `${formatExternalAccessLine(entry)}\n`, "utf8");
    return true;
  } catch {
    // **止めない。** 記録が残らないことより、測定を失敗させるほうが害が大きい
    return false;
  }
}
