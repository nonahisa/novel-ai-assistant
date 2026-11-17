/**
 * 相談へ渡す目次の字数の上限。上げた経緯は `featureGuide.test.ts` の
 * 「目次は上限（INDEX_CHAR_LIMIT）の字数未満」の注記にある。
 *
 * **1つにしておく**——作品の質問へ渡すものは目次そのものなので、同じ上限で見る。
 * 2か所に数字を書いていたら、目次だけ 2,700 へ上げて片方が 2,600 のまま残った。
 * Mac の書き方で見る検査（`featureGuideMac.test.ts`）も、この数字を読む。
 */
export const INDEX_CHAR_LIMIT = 3100;
