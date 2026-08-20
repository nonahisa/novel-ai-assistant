/**
 * VS Code 標準のMarkdownプレビューへ、ルビの表示を差し込む（設計書6.12）。
 *
 * **独自のプレビュー画面を作らない。** 作者がすでに使っている
 * プレビュー（`Ctrl+Shift+V`）にそのまま出るほうが良い。
 *
 * **markdown-it を import しない。** 実体はVS Codeから渡ってくるので、
 * こちらが要るのは「触る部分の形」だけである。型のためだけに
 * `@types/markdown-it` を足すと、配布物とは関係のない依存が増える。
 */
import { rubyToHtml } from "./ruby";

/** 触る部分だけの形。`any` を使わずに済ませるための最小の定義 */
export interface MarkdownItLike {
  renderer: {
    rules: {
      text?: (
        tokens: unknown[],
        index: number,
        options: unknown,
        env: unknown,
        self: { renderToken(tokens: unknown[], index: number, options: unknown): string }
      ) => string;
    };
  };
}

/**
 * `{漢字|かんじ}` を `<ruby>` として描く。
 *
 * **`text` の描画結果に対して当てる。** markdown-it は本文を先に
 * HTMLエスケープしてから渡してくるので、ここで作る `<ruby>` タグは
 * 作者が書いた文字と混ざらない。
 */
export function extendMarkdownItWithRuby<T extends MarkdownItLike>(md: T): T {
  const renderText = md.renderer.rules.text;
  md.renderer.rules.text = (tokens, index, options, env, self) => {
    const rendered = renderText
      ? renderText(tokens, index, options, env, self)
      : self.renderToken(tokens, index, options);
    return rubyToHtml(rendered);
  };
  return md;
}
