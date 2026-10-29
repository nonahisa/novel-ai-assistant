// WebView の Content-Security-Policy（script-src 'nonce-…'）に使う使い捨ての文字列を作る。
// nonce は WebView を開くたびに作り直す前提なので、各パネルで写さずここ1か所に置く。
export function createNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
