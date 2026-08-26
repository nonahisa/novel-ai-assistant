/**
 * ビルドのときに `esbuild.js` が埋める印。
 *
 * 本番ビルドでは `false` に畳まれ、`if (__DEV_HELPERS__)` の中は
 * まるごと落ちる（中の動的importも消えるので、そのファイルは束に入らない）。
 *
 * **型検査と試験では `true` として扱う。** 開発用の道具も型検査の対象にする
 * ためで、`vitest` から読み込めるようにもなる。
 */
declare const __DEV_HELPERS__: boolean;
