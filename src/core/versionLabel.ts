/**
 * サイドバーの見出しの脇に出す、版の小さな札（作者の依頼、2026-09-22
 * 「開いたときにバージョンがわかるようどこか邪魔にならないところに
 * バージョンを入れてください」）。
 *
 * ## なぜ見出しの脇なのか
 *
 * 2026-09-21 に作者は**タイトルバーへ版を出す**ことを望み、VS Code が
 * そこを拡張機能に貸さないので取り下げた。だが `TreeView.description` は
 * **見出しの右に薄い字で出る**——押す物が減るわけでも、項目が1つ増える
 * わけでもないので、「邪魔にならないところ」の条件を満たす。
 *
 * ## ここで版を持たない
 *
 * 版は `package.json` から読んで渡す（`context.extension.packageJSON`）。
 * **この層に書き写すと、上げ忘れた日に画面が嘘をつく**——版を揃える6か所
 * （スキル `docs-sync`）を7か所に増やすことになる。
 *
 * VS Code API に依存しない（`core` の決まり）。
 */

/**
 * 版の札を組む。**空や空白だけなら札を出さない**（`undefined` を返す）。
 *
 * `TreeView.description` は `undefined` を渡すと何も出さないので、
 * 「版が読めなかった」ときに `v` や `v（不明）` のような字が残らない。
 * 読めないこと自体は `showVersion`（ヘルプの「バージョンを確認」）が
 * 「（不明）」と言う仕事で、**見出しの脇は、分かるときだけ静かに出す**。
 */
export function menuVersionLabel(version: string | undefined): string | undefined {
  const trimmed = (version ?? "").trim();
  if (!trimmed) return undefined;
  // 先頭の「v」を二重に付けない（package.json が "v1.2.3" で来ても耐える）
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}
