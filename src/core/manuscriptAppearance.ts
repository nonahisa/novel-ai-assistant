/**
 * 原稿エディタの見た目を、どう決めるか（設計書6.25.5）。
 *
 * 決め手が4つある——**前の話から持って来た見た目**・**入口で決まった向き**
 * （「原稿（横書）」で開いた）・**画面が覚えていた値**・**設定の既定**。
 * どれが勝つかを画面側とこちらの2か所に書くと、片方だけが直る日が来るので、
 * ここ1か所に置いて**画面へは決まった結果だけを渡す**。
 */

/** 原稿ごとに覚える見た目 */
export interface ManuscriptAppearance {
  /** 縦書きか */
  vertical: boolean;
  /** 文字の大きさ（px。画面の「＋」「ー」） */
  size: number;
  /** 組んで書く面にいるか（設計書6.34） */
  compose: boolean;
}

/**
 * 画面が覚えていた値（`vscode.getState()`）。
 *
 * **どれも任意にしてある。** はじめて開く原稿では空で、古い state には
 * 当時まだ無かった項目が欠けている。
 */
export interface SavedAppearance {
  vertical?: boolean;
  size?: number;
  compose?: boolean;
}

/** 文字の大きさの既定（画面の初期値と揃える） */
export const MANUSCRIPT_SIZE_DEFAULT = 16;

/** 画面の「＋」「ー」が動ける範囲。ここから外れた値は畳む */
const SIZE_MIN = 9;
const SIZE_MAX = 40;

/**
 * この原稿を、どの見た目で開くかを決める。
 *
 * 向きの優先順位は **入口 ＞ 引き継ぎ ＞ 覚えていた値 ＞ 設定の既定**。
 * 入口をいちばん強くするのは、メニューで「縦書きで開く」「横書きで開く」と
 * 選んだのに別の向きで開いたら、選んだ意味が無いためである。
 * 大きさと組んで書くには入口が無いので、**引き継ぎ ＞ 覚えていた値 ＞ 既定**。
 *
 * @param carry 前の話から持って来た見た目（設計書6.25.5）。
 *   前後の話を行き来したときだけ入る
 * @param forceVertical 入口で向きが決まっているなら、その向き
 */
export function resolveInitialAppearance(input: {
  saved?: SavedAppearance;
  carry?: ManuscriptAppearance;
  forceVertical?: boolean;
  verticalDefault: boolean;
  sizeDefault?: number;
}): ManuscriptAppearance {
  const { saved, carry, forceVertical, verticalDefault } = input;
  const sizeDefault = clampSize(input.sizeDefault, MANUSCRIPT_SIZE_DEFAULT);
  return {
    vertical:
      typeof forceVertical === "boolean"
        ? forceVertical
        : carry
          ? carry.vertical
          : typeof saved?.vertical === "boolean"
            ? saved.vertical
            : verticalDefault,
    size: clampSize(carry ? carry.size : saved?.size, sizeDefault),
    /*
      **組んで書くが標準**（作者の指定、2026-08-29）。覚えていないなら
      組んで書くから始め、「やめる」を押した原稿だけ打つ面で開く。
    */
    compose: carry ? carry.compose : saved?.compose !== false,
  };
}

/**
 * 次に開く原稿のために置かれた見た目を、**1回だけ**取り出す。
 *
 * 取り出したら消すのは、引き継ぐのが「前後の話を行き来した、その1回」に
 * 限るためである。残しておくと、あとで同じ原稿をふつうに開いたときに
 * 古い見た目が蘇り、その原稿が覚えている値を黙って押し流す。
 */
export function takeCarriedAppearance(
  pending: Map<string, ManuscriptAppearance>,
  key: string
): ManuscriptAppearance | undefined {
  const carried = pending.get(key);
  if (!carried) return undefined;
  pending.delete(key);
  return carried;
}

/**
 * 大きさを画面が扱える範囲へ畳む。
 *
 * **画面から届く値も、覚えていた値も信用しない**（`getState` は作者が
 * 書き換えられる場所ではないが、古い版の値が残ることはある）。
 */
function clampSize(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(value)));
}
