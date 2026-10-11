import type { ImageSupport } from "../ai/imageInput";
import { ORIENT_LAYOUTS, ORIENT_TOPS, type OrientLayout, type OrientTop } from "../prompts/photoOrient";
import { isLocalProviderId } from "./localProviders";

/**
 * 写真の向きと見開きを尋ねた答え（P-49、設計書6.117.11）の検算・突き合わせと、
 * 尋ねてよいかの決まり。VS Code に依存しない。
 */

/** 時計回りに回す角度 */
export type PhotoRotation = 0 | 90 | 180 | 270;

/** 1枚の写真への1回の答え */
export interface PhotoOrientAnswer {
  /** その写真を正しい向きにするために、時計回りに回す角度 */
  readonly rotation: PhotoRotation;
  readonly spread: boolean;
}

/** 2回の答えを突き合わせた推し */
export interface PhotoOrientGuess {
  /** 見えている写真を正しい向きにするために、時計回りに回す角度 */
  readonly rotation: PhotoRotation;
  /** 左右に切るか。2回の答えが食い違ったら undefined（画面は縦横比の既定に任せる） */
  readonly spread: boolean | undefined;
}

/**
 * 字の頭が向いている辺 → 時計回りに回す角度。
 * 頭が左の辺を向いていれば、時計回りに90度回すと左の辺が上へ来る。
 */
const ROTATION_FOR_TOP: Readonly<Record<OrientTop, PhotoRotation>> = {
  up: 0,
  left: 90,
  down: 180,
  right: 270,
};

/**
 * 1回の答えを読む。**列挙に無い値・欠けた項目は undefined**（AIの出力を信用しない、規則3）。
 */
export function parsePhotoOrient(raw: string): PhotoOrientAnswer | undefined {
  const parsed = parseObject(raw);
  if (!parsed) return undefined;
  const top = parsed.top;
  const layout = parsed.layout;
  if (typeof top !== "string" || !(ORIENT_TOPS as readonly string[]).includes(top)) return undefined;
  if (typeof layout !== "string" || !(ORIENT_LAYOUTS as readonly string[]).includes(layout)) {
    return undefined;
  }
  return {
    rotation: ROTATION_FOR_TOP[top as OrientTop],
    spread: (layout as OrientLayout) === "spread",
  };
}

/** 回した写し1枚への答え */
export interface PhotoOrientProbe {
  /** 見えている写真から、時計回りに何度回した写しか */
  readonly turn: number;
  /** 読めなかった・失敗したら undefined */
  readonly answer: PhotoOrientAnswer | undefined;
}

/**
 * 回した写しへの答えを、見えている写真を回す角度へ読み替えて突き合わせる。
 *
 * 時計回りに t 度回した写しへの答えが r 度なら、見えている写真は (t + r) 度回せば直る。
 * **2つ以上が同じ角度になったときだけ推す**（同じ数で2つに割れたら推さない）。
 * 写真を見ずにいつも同じ辺を答えるモデルは、回した写しごとに読み替えた角度が
 * ばらけるので、ここで外れる（P-49 の冒頭）。
 *
 * 見開きは、一致した答えどうしで見開きの答えも揃ったときだけ推す。
 */
export function combinePhotoOrient(probes: readonly PhotoOrientProbe[]): PhotoOrientGuess | undefined {
  const groups = new Map<PhotoRotation, PhotoOrientAnswer[]>();
  for (const probe of probes) {
    if (!probe.answer) continue;
    const rotation = ((((probe.turn + probe.answer.rotation) % 360) + 360) % 360) as PhotoRotation;
    const group = groups.get(rotation) ?? [];
    group.push(probe.answer);
    groups.set(rotation, group);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const [best, runnerUp] = ranked;
  if (!best || best[1].length < 2) return undefined;
  if (runnerUp && runnerUp[1].length === best[1].length) return undefined;
  const spreads = new Set(best[1].map((answer) => answer.spread));
  return {
    rotation: best[0],
    spread: spreads.size === 1 ? best[1][0].spread : undefined,
  };
}

/**
 * 尋ねている途中で、もう答えが決まったか（残りを尋ねなくてよいか）。
 * 2つ一致した時点で、残り1つが何を答えても推しは変わらない
 */
export function photoOrientSettled(probes: readonly PhotoOrientProbe[]): boolean {
  return combinePhotoOrient(probes) !== undefined;
}

/**
 * 横長と見なす縦横比（幅÷高さ）。これ以上なら見開きとして「左右に切る」を既定で入れる
 * （設計書6.117.3。画面〈`views/photoTranscribePanelHtml.ts`〉もこれを使う）
 */
export const SPREAD_ASPECT = 1.2;

/** 写真を画面でどう置くか（回す角度と、左右に切るか） */
export interface PhotoPlacement {
  readonly rotation: PhotoRotation;
  readonly split: boolean;
}

/**
 * 推しを、画面の置き方へ直す。
 *
 * 見開きを推せたらそれに従い、推せなかったら（2回の答えが割れた）、
 * **推した向きに回したあとの縦横比**で決める——横倒しの1ページは回す前は
 * 横長なので、回す前の縦横比で切ると真ん中で切ってしまう。
 *
 * @param width 見えている写真の幅（px）
 * @param height 見えている写真の高さ（px）
 */
export function placePhotoByGuess(guess: PhotoOrientGuess, width: number, height: number): PhotoPlacement {
  const sideways = guess.rotation % 180 !== 0;
  const w = sideways ? height : width;
  const h = sideways ? width : height;
  return {
    rotation: guess.rotation,
    split: guess.spread ?? w >= h * SPREAD_ASPECT,
  };
}

/**
 * 向きを尋ねてよいか。**手元のAI（Ollama・LM Studio）で、写真を読めると
 * 申告しているモデルだけ**。
 *
 * - クラウドへは尋ねない。書き起こす前の下ごしらえで、作者が送るのを
 *   確かめる前に写真を外へ出すことになるため（設計書6.117.5 の確認より前に走る）
 * - 「分からない」（申告が無い）でも尋ねない。文字だけのモデルは写真を見ないまま
 *   それらしい列挙を返し、それが正しい向きのように画面に出てしまう
 */
export function shouldAskPhotoOrient(providerId: string, support: ImageSupport): boolean {
  return isLocalProviderId(providerId) && support.kind === "yes";
}

/** 写真の札に出す1行 */
export function describePhotoOrientGuess(guess: PhotoOrientGuess): string {
  const turn =
    guess.rotation === 0
      ? "そのまま"
      : guess.rotation === 90
        ? "右へ90度"
        : guess.rotation === 180
          ? "180度"
          : "左へ90度";
  const layout = guess.spread === undefined ? "" : guess.spread ? "・見開き" : "・1ページ";
  return `向きを推しました：${turn}${layout}（手元のAI）。違っていれば下のボタンで直してください。`;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
