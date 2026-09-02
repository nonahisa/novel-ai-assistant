import * as vscode from "vscode";
import * as path from "./paths";
import { BOOK_DIR } from "../models/book";
import { atomicWriteFile } from "./atomicWrite";
import { imageMediaType } from "./epubPackage";

/**
 * 表紙・裏表紙の「焼いた画像」（設計書6.65.8）。
 *
 * ## なぜファイルに残すのか
 *
 * イラストの上に題名を重ねる合成ができるのは**エディター画面のcanvasだけ**
 * である。しかし書き出しは、パネルを開かずメニューからもできる。書き出しの
 * たびに合成し直す設計にすると、パネルの無い経路で表紙が組めない。そこで
 * 「表紙を焼く」で `設定/書籍/表紙_合成済み.png` へ保存し、書き出しは
 * **そのファイルを読むだけ**にした。`設定/` はGit管理下なので、同期も
 * 復元もできる。
 *
 * ## 画面から届いたものは信用しない
 *
 * canvas の `toDataURL` は本来PNGしか返さないが、届くのは
 * **WebViewからのpostMessage**である。形を検めずに保存すると、拡張子だけ
 * PNGの別物が本へ入る。ここで先頭8バイト（PNGの印）まで確かめる。
 *
 * ## Node専用のAPIを使わない
 *
 * base64の復元は `Buffer` ではなく `atob` と `Uint8Array` で書く
 * （設計書5.8。ブラウザ版でも動く必要がある）。
 */

/** 表紙と裏表紙。焼いた画像はこの2枚しかない */
export type CoverSide = "front" | "back";

/**
 * 焼いた画像のファイル名。
 *
 * **「_合成済み」を名前に入れてある。** これがあるから、作者が手で置いた
 * `表紙.png` とぶつからず、生成物として上書きしてよいと分かる。
 */
export const BAKED_COVER_FILES: Record<CoverSide, string> = {
  front: "表紙_合成済み.png",
  back: "裏表紙_合成済み.png",
};

/**
 * 受け取る画像の上限。
 *
 * 表紙1枚に20MBは十分すぎるが、**postMessage で文字列として届く**ので、
 * 際限なく受け取ると復元の途中で memory を使い切る。復元する前に断る。
 */
export const MAX_BAKED_COVER_BYTES = 20 * 1024 * 1024;

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/** PNGの先頭8バイト。ここが違えば、名前だけPNGの別物である */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function bakedCoverPath(settingsDir: string, side: CoverSide): string {
  return path.join(settingsDir, BOOK_DIR, BAKED_COVER_FILES[side]);
}

/**
 * canvas から届いた dataURL を、PNGのバイト列に戻す。
 *
 * 断るときは**何が悪いのかが分かる言葉**にする。作者に見えるのは通知だけで、
 * 「保存できませんでした」だけでは元イラストを小さくすればよいのか、
 * パネルを開き直せばよいのか判断できない。
 */
export function decodePngDataUrl(dataUrl: string): Uint8Array {
  const value = (dataUrl ?? "").trim();

  if (!value.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error(
      "焼いた画像を受け取れませんでした（PNGとして届いていません）。" +
        "パネルを開き直してからもう一度お試しください。"
    );
  }

  const payload = value.slice(PNG_DATA_URL_PREFIX.length);

  // **復元する前に大きさを見る。** base64は4文字で3バイトなので、
  // 文字数から中身の大きさが分かる（20MBの文字列を展開してから
  // 「大きすぎます」と言うのでは遅い）
  const estimated = Math.floor((payload.length * 3) / 4);
  if (estimated > MAX_BAKED_COVER_BYTES) {
    throw new Error(
      `焼いた表紙が大きすぎます（およそ${Math.round(
        estimated / 1024 / 1024
      )}MB、上限は${MAX_BAKED_COVER_BYTES / 1024 / 1024}MB）。` +
        "元のイラストの寸法を小さくしてからもう一度お試しください。"
    );
  }

  if (payload.length === 0 || payload.length % 4 !== 0) {
    throw new Error(brokenMessage());
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw new Error(brokenMessage());
  }

  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    throw new Error(brokenMessage());
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  if (!startsWithPngMagic(bytes)) {
    throw new Error(
      "焼いた画像がPNGとして読めませんでした。" +
        "パネルを開き直してからもう一度お試しください。"
    );
  }

  return bytes;
}

function brokenMessage(): string {
  return (
    "焼いた画像を復元できませんでした（受け取ったデータが壊れています）。" +
    "パネルを開き直してからもう一度お試しください。"
  );
}

function startsWithPngMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * 焼いた画像を保存する。
 *
 * **上書きしてよい経路（指定なし）を使う。** 焼いた画像は本文からでも
 * 設定資料からでもなく「合成の結果」であり、作者が手で書いたものではない。
 * 名前に「_合成済み」が入っているので、作者の手置きファイルとぶつかる
 * こともない（CLAUDE.md 実装ルール2の例外にあたる）。
 */
export async function saveBakedCover(
  settingsDir: string,
  side: CoverSide,
  dataUrl: string
): Promise<{ filePath: string; bytes: number }> {
  const bytes = decodePngDataUrl(dataUrl);
  const target = bakedCoverPath(settingsDir, side);

  await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
  await atomicWriteFile(target, bytes);

  return { filePath: target, bytes: bytes.length };
}

/** 本へ入れる1枚の画像 */
export interface CoverSource {
  /** 種類の判定に使う名前（ZIPの中の名前は `epubPackage.ts` が決める） */
  fileName: string;
  data: Uint8Array;
  /** 焼いた画像のときだけ、焼いた時刻。元イラストをそのまま使うときは null */
  bakedAt: Date | null;
}

/**
 * 本へ入れる表紙を決める。**焼いた画像 → 元イラスト → 無し**の順。
 *
 * **裏表紙もまったく同じ拾い方をする。** 当初は「裏表紙は焼いたものだけ」
 * にしていたが、それだと `backCoverImagePath` を書いた作者から見て、
 * 焼くまで何も起きない。表紙が元イラストのまま入るのに裏表紙だけ入らない
 * のは、作者に説明できない食い違いである（本体の裁定）。
 *
 * **指定があるのに読めなければ例外にする。** 黙って扉に差し替えると、
 * 表紙を用意したつもりの本が表紙なしで出来上がる。
 */
export async function readCoverSource(
  workFolder: string,
  settingsDir: string,
  side: CoverSide,
  imagePath: string | null
): Promise<CoverSource | null> {
  const baked = await bakedCoverInfo(settingsDir, side);
  if (baked) {
    return {
      fileName: BAKED_COVER_FILES[side],
      data: await vscode.workspace.fs.readFile(path.toUri(baked.filePath)),
      bakedAt: baked.bakedAt,
    };
  }

  if (!imagePath) return null;

  return {
    fileName: imagePath,
    data: await vscode.workspace.fs.readFile(
      path.toUri(path.join(workFolder, imagePath))
    ),
    bakedAt: null,
  };
}

/**
 * 焼いた画像が「あるか・いつのものか」だけを見る（設計書6.65.8）。
 *
 * **中身は読まない。** エディター画面は、焼いた画像があるかどうかで
 * 見せ方を変えるが、バイト列は要らない（`asWebviewUri` で読む）。
 * 読めないときは「無い」と同じ扱いにする——本へ入らないことに変わりはない。
 */
export async function bakedCoverInfo(
  settingsDir: string,
  side: CoverSide
): Promise<{ filePath: string; bakedAt: Date } | null> {
  const filePath = bakedCoverPath(settingsDir, side);
  try {
    const stat = await vscode.workspace.fs.stat(path.toUri(filePath));
    return { filePath, bakedAt: new Date(stat.mtime) };
  } catch {
    return null;
  }
}

/**
 * 焼いた画像を消す（設計書6.65.8）。消せたら、その場所を返す。
 *
 * ## なぜ消す道が要るのか
 *
 * 焼いた画像は元イラストより先に拾われる。焼いたあとで元イラストを
 * 差し替えたり、`coverImagePath` を空にしたりすると、**画面と本の中身が
 * 食い違う**（本には古い焼き上がりが入り続ける）。作者が選んで消せる
 * ようにしておけば、どちらの場合も「画面で見えているもの＝本に入るもの」に
 * 戻せる。
 *
 * **消してよいのは `_合成済み` の2つだけ**である。だから場所は
 * `bakedCoverPath` からしか取らない——組み立てで作ると、作者の手置きの
 * 表紙を消す道ができてしまう。
 *
 * 無いものを消そうとしたときは null を返す（呼び出し側が「消すものが
 * ありません」と言えるように）。
 */
export async function deleteBakedCover(
  settingsDir: string,
  side: CoverSide
): Promise<string | null> {
  const baked = await bakedCoverInfo(settingsDir, side);
  if (!baked) return null;

  await vscode.workspace.fs.delete(path.toUri(baked.filePath));
  return baked.filePath;
}

/**
 * 元イラストを dataURL にして返す（エディター画面へ渡すため）。
 *
 * ## なぜ `asWebviewUri` だけで済ませないのか
 *
 * 画面は普段 `asWebviewUri` の画像を出す。ところが**別の在りかから来た
 * 画像を canvas へ描くと、その canvas は読み出せなくなる**（`toDataURL`
 * が落ちる）ブラウザの決まりがある。読み込みに `crossOrigin` を付けて
 * おくと、汚れる代わりに読み込みそのものが失敗するので、そのときだけ
 * ここへ中身を取りにくる。**焼けないより、少し重いほうがよい。**
 *
 * base64は `Buffer` を使わずに作る（設計書5.8）。
 */
export async function readImageDataUrl(
  workFolder: string,
  relativePath: string
): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(
    path.toUri(path.join(workFolder, relativePath))
  );
  return `data:${imageMediaType(relativePath)};base64,${toBase64(bytes)}`;
}

function toBase64(bytes: Uint8Array): string {
  // 一度に渡すと引数の数の上限に当たる。3万字ずつ文字にしてから繋ぐ
  const CHUNK = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

/**
 * 焼いた時刻の言い方（設計書6.65.8の最後）。
 *
 * **書き出しの完了通知に出す。** 合成の指定を変えたのに焼き直していない
 * ことは検知できないので、せめて「いつ焼いたものが入ったか」を見せる。
 * 同じ日に何度も焼き直すので、**分まで**出す。
 */
export function describeBakedAt(at: Date): string {
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `${at.getFullYear()}年${at.getMonth() + 1}月${at.getDate()}日 ${time}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * エディター画面で、焼いた画像を見せているときの一言（設計書6.65.8）。
 *
 * **焼いたあとは、合成の欄を触っても本の表紙は変わらない**（焼き直すまで）。
 * 画面が合成の途中経過を見せ続けると、作者は「これが本に入る」と読む。
 * プレビューも書き出しと同じ拾い順（焼いた→元→無し）にしたうえで、
 * いつ焼いたものを見ているのかをここで言う。
 */
export function describeBakedPreview(at: Date): string {
  return (
    `焼いた画像を表示中（${describeBakedAt(at)}）。` +
    "合成をやり直すには焼き直してください。"
  );
}

/**
 * 書き出しの完了通知に添える、表紙まわりの一言（設計書6.65.8の最後）。
 *
 * **焼いた画像が古いことは検知できない。** book.json の合成指定を変えた
 * のに焼き直していない、という取り違えを機械では見つけられないので、
 * 「いつ焼いたものが入ったか」を毎回見せる。
 *
 * 焼いていない表紙・裏表紙には、**焼く道があること**を伝える。合成した
 * つもりで元イラストがそのまま入っているのは、黙って出してよい違いではない。
 */
export function describeCoverUse(
  cover: CoverSource | null,
  backCover: CoverSource | null
): string {
  const lines: string[] = [];

  if (!cover) {
    lines.push("表紙は題名だけの扉にしました。");
  } else if (cover.bakedAt) {
    lines.push(`表紙は${describeBakedAt(cover.bakedAt)}に焼いたものです。`);
  } else {
    // 裏表紙と同じ一言を出す。焼き忘れの危険は表紙も同じ（本体の裁定）
    lines.push(
      "表紙は元イラストをそのまま使いました" +
        "（文字を重ねるにはEPUBエディターで「表紙を焼く」を押してください）。"
    );
  }

  if (backCover?.bakedAt) {
    lines.push(
      `裏表紙は${describeBakedAt(backCover.bakedAt)}に焼いたものです。`
    );
  } else if (backCover) {
    lines.push(
      "裏表紙は元イラストをそのまま使いました" +
        "（文字を重ねるにはEPUBエディターで「裏表紙を焼く」を押してください）。"
    );
  }

  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}
