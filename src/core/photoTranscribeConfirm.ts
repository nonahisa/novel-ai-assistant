import { isLocalProviderId } from "./localProviders";

/**
 * 写真を送る前の確かめの文（設計書6.117.5）。**文言はここ1か所。** VS Code に依存しない。
 *
 * **毎回出す。「以降は訊かない」を付けない**（作者の裁定、2026-10-11「写真を
 * 外のAIへ送る前に、必ず確かめる」）。写真は原稿の材料そのもので、どこへ
 * 渡るかを作者が毎回見て決める。
 */
export interface PhotoSendConfirmInput {
  readonly providerId: string;
  /** AIの名前（`AIProvider.displayName`） */
  readonly providerName: string;
  readonly model: string;
  /** 送るページの数（見開きを切れば1枚が2ページ） */
  readonly pages: number;
  /** 作者が選んだ写真の枚数 */
  readonly photos: number;
  /** 呼ぶたびに課金されるか */
  readonly isPaid: boolean;
}

export interface PhotoSendConfirm {
  /** モーダルの見出し */
  readonly message: string;
  /** モーダルの本文 */
  readonly detail: string;
  /** 進むボタン */
  readonly proceed: string;
}

export function describePhotoSend(input: PhotoSendConfirmInput): PhotoSendConfirm {
  const ai = `『${input.providerName}（${input.model}）』`;
  const count =
    input.pages === input.photos
      ? `この写真 ${input.pages}枚`
      : `この写真 ${input.pages}枚（写真 ${input.photos}枚を切り分けた ${input.pages}ページ）`;
  /*
    **手元かどうかは `isLocalProviderId` だけで決める**（写しを作らない）。
    VS Code 経由は、どこへ繋がっているかがこちらから分からないので外として扱う
    （知らないIDはクラウド扱い）
  */
  if (isLocalProviderId(input.providerId)) {
    return {
      message: `${count}を${ai}で読みます。`,
      detail: "写真はこのパソコンの外へは出ません。",
      proceed: "書き起こす",
    };
  }
  return {
    message: `${count}を${ai}へ送ります。`,
    detail:
      "写真は外のサービスに渡ります。" +
      (input.isPaid ? "\n呼び出すたびに課金されます。" : ""),
    proceed: "送って書き起こす",
  };
}
