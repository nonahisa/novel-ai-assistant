/**
 * VS Code 標準のMarkdownプレビューへ、ルビの表示を差し込む（設計書6.12）。
 * ついでに、シーンメモの行をプレビューから隠す（設計書6.40.2）。
 *
 * **独自のプレビュー画面を作らない。** 作者がすでに使っている
 * プレビュー（`Ctrl+Shift+V`）にそのまま出るほうが良い。
 *
 * **markdown-it を import しない。** 実体はVS Codeから渡ってくるので、
 * こちらが要るのは「触る部分の形」だけである。型のためだけに
 * `@types/markdown-it` を足すと、配布物とは関係のない依存が増える。
 */
import { rubyToHtml } from "./ruby";
import { isMemoLine } from "./sceneMemo";

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
  /**
   * 解析の前に本文へ手を入れる口。
   *
   * **省略できる形にしてある。** 型はVS Codeから渡ってくる実物に
   * 合わせた最小限で、この口が無い（あるいは形が違う）環境でも
   * ルビの表示だけは効かせたい。
   */
  core?: {
    ruler: {
      before(
        beforeName: string,
        ruleName: string,
        rule: (state: { src: string }) => void
      ): void;
    };
  };
}

/**
 * プレビューからシーンメモの行を落とす。
 *
 * **囲みコード（``` ～ ```）の中は触らない。** プログラムのコードには
 * 行頭の `//` コメントが普通にあり、まとめて落とすと**説明の文書が
 * 壊れる**（この拡張機能自身の `docs/` がそれである）。
 *
 * 字下げのコードブロック（半角4つ）は、そもそも `isMemoLine` が
 * 「行の先頭が `//`」しか認めないので、放っておいて当たらない。
 */
export function hideMemoLinesInMarkdown(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  /** いま囲みの中なら、その囲みの記号（``` か ~~~） */
  let fence: string | null = null;

  for (const line of lines) {
    // 囲みの開始・終了は、行頭から3つまでの空きを許すのがMarkdownの決まり
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      out.push(line);
      if (marker && marker[1][0] === fence) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1][0];
      out.push(line);
      continue;
    }
    if (isMemoLine(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * `{漢字|かんじ}` を `<ruby>` として描き、シーンメモの行を隠す。
 *
 * **`text` の描画結果に対して当てる。** markdown-it は本文を先に
 * HTMLエスケープしてから渡してくるので、ここで作る `<ruby>` タグは
 * 作者が書いた文字と混ざらない。
 *
 * メモのほうは**解析より前**に落とす。行の切れ目が要るので、
 * 段落へ畳まれたあとでは元がどの行だったのか分からない。
 */
export function extendMarkdownItWithRuby<T extends MarkdownItLike>(md: T): T {
  const renderText = md.renderer.rules.text;
  md.renderer.rules.text = (tokens, index, options, env, self) => {
    const rendered = renderText
      ? renderText(tokens, index, options, env, self)
      : self.renderToken(tokens, index, options);
    return rubyToHtml(rendered);
  };

  try {
    md.core?.ruler.before("normalize", "novelaiSceneMemo", (state) => {
      state.src = hideMemoLinesInMarkdown(state.src);
    });
  } catch {
    /*
      **プレビューそのものは止めない。** ここで投げると、ルビの差し込みごと
      諦めることになる（VS Code は拡張に失敗したプレビューを開かない）。
      メモが見えてしまうのは読みにくいだけで、原稿は無傷である。
    */
  }
  return md;
}
