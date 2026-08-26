/**
 * 分岐したときに「畳めるか」を、畳む前に見る（設計書5.5.16）。
 *
 * **`git merge-tree --write-tree` を使う。** 作業ツリーにもブランチにも触らずに、
 * 畳んだ結果のツリーを算出して衝突を教えてくれる。**押す前に何が起きるかを
 * 出せる**ので、5.5.14（すべて同期）の確認画面と同じ形にできる。
 *
 * **判定を「ファイル名が重なるか」で行ってはならない。** 作者の置き場で実際に
 * 起きた分岐では、重なった6件のうち5件は**両方の環境で同じ原稿を取り込んだ**
 * もので、中身まで同じだった。名前で見ていたら、畳める分岐が行き止まりになる。
 *
 * ここは純粋関数だけを置く（vscodeにもプロセスにも触らない）。
 * 実際に走らせるのは `features/resolveDivergence.ts`。
 */

export type MergePreviewKind =
  /** 衝突なく畳める */
  | "clean"
  /** 衝突する */
  | "conflicted"
  /** gitが古くて判定できない（`--write-tree` は Git 2.38 以降） */
  | "unsupported"
  /** 走らせられなかった */
  | "failed";

export interface MergePreview {
  kind: MergePreviewKind;
  /** 衝突したファイル（リポジトリからの相対パス） */
  conflicts: string[];
  /** そのうち、拡張機能が自動で書くもの。規則で畳める */
  autoWritten: string[];
  /** 作者のもの。**機械が決めない**（設計書5.5.4） */
  authored: string[];
  /** 畳んだ結果のツリー。衝突が無いときだけ意味を持つ */
  tree?: string;
  detail?: string;
}

/**
 * 予測を取るためのgitの引数。
 *
 * - `--write-tree`：結果のツリーを作る（**作業ツリーは変わらない**）
 * - `--name-only`：衝突したファイル名だけを出す
 * - `-z`：NUL区切り。**原稿のファイル名には何が入っているか分からない**ので、
 *   引用や改行で壊れない形で受け取る
 */
export function mergeTreeArgs(ours: string, theirs: string): string[] {
  return ["merge-tree", "--write-tree", "--name-only", "-z", ours, theirs];
}

/**
 * 拡張機能が自動で書くファイルか。
 *
 * **ここを広く取ってはいけない。** `.aiwriter/` の下には作者の判断が要るものも
 * 入っている。
 *
 * | 場所 | 畳めるか | 理由 |
 * |---|---|---|
 * | `.aiwriter/stats/` | 畳める | 端末ごとのファイル。読み込むときに合算する（5.5.6） |
 * | `.aiwriter/cache/` | 畳める | 作り直せる |
 * | `.aiwriter/config.json` | 畳める | 作品名と置き場の名前。食い違うのは登録した時刻ぐらいである |
 * | `.aiwriter/history/`・提案・ロック | **畳めない** | **追記型**（5.6）。片方を残すと、もう片方の環境で書かれた記録が消える |
 * | `.aiwriter/pending-characters/` | **畳めない** | AIの提案だが、作者が承認する前のものである |
 * | `.aiwriter/extracted.json` | **畳めない** | 抽出済みの話の記録。正しくは両方の和集合で、片方を残すと再抽出が走る |
 * | 原稿・設定資料 | **畳めない** | 作者のもの |
 */
export function isAutoWrittenPath(filePath: string): boolean {
  // Windowsの区切り（\）を / に揃える。符号で書くのは、正規表現の中の
  // 円記号が読みにくいためである
  const normalized = filePath.replace(/[\u005C]/g, "/");
  return (
    /(^|\/)\.aiwriter\/stats\//.test(normalized) ||
    /(^|\/)\.aiwriter\/cache\//.test(normalized) ||
    /(^|\/)\.aiwriter\/config\.json$/.test(normalized)
  );
}

/** gitの返事を読む。**終了コードで分ける**（0＝衝突なし、1＝衝突あり） */
export function parseMergeTree(result: {
  code: number;
  stdout: string;
  stderr: string;
}): MergePreview {
  const empty = { conflicts: [], autoWritten: [], authored: [] };

  // `--write-tree` は Git 2.38 以降。古いgitでは「そんな指定は無い」と言われる
  if (looksUnsupported(result)) {
    return {
      kind: "unsupported",
      ...empty,
      detail: "この操作には Git 2.38 以降が要ります。",
    };
  }

  const fields = result.stdout.split("\0");
  const tree = fields[0]?.trim();

  if (result.code === 0) {
    return { kind: "clean", ...empty, tree: tree || undefined };
  }

  if (result.code !== 1) {
    return {
      kind: "failed",
      ...empty,
      detail: (result.stderr || result.stdout).trim() || "判定できませんでした。",
    };
  }

  // 1件目はツリー。そのあと空の欄が来るまでが衝突したファイル
  const conflicts: string[] = [];
  for (const field of fields.slice(1)) {
    if (field === "") break;
    conflicts.push(field);
  }

  return {
    kind: "conflicted",
    conflicts,
    autoWritten: conflicts.filter(isAutoWrittenPath),
    authored: conflicts.filter((file) => !isAutoWrittenPath(file)),
    tree: tree || undefined,
  };
}

/** 自動で畳んでよいか。**作者のものが1件でもあれば畳まない** */
export function canFoldAutomatically(preview: MergePreview): boolean {
  if (preview.kind === "clean") return true;
  if (preview.kind !== "conflicted") return false;
  // 「原稿以外なら自動で」という例外は作らない。
  // 判定を1回間違えたら原稿が消える（設計書5.5.16）
  return preview.conflicts.length > 0 && preview.authored.length === 0;
}

/** 押す前に見せる一言 */
export function describeMergePreview(preview: MergePreview): string {
  switch (preview.kind) {
    case "clean":
      return "衝突はありません。そのまま合わせられます。";
    case "conflicted":
      if (preview.authored.length === 0) {
        return (
          `${preview.autoWritten.length}件が食い違っていますが、` +
          "どれも拡張機能が自動で書くファイルです。この端末の側を残して合わせられます。"
        );
      }
      return (
        `${preview.authored.length}件は作者が書いたものです。` +
        "どちらを残すかは自動で決められません。"
      );
    case "unsupported":
      return preview.detail ?? "この操作には新しいGitが要ります。";
    case "failed":
      return `畳めるかを調べられませんでした: ${preview.detail ?? "理由は不明です"}`;
  }
}

function looksUnsupported(result: { code: number; stderr: string }): boolean {
  if (result.code === 0 || result.code === 1) return false;
  return /unknown option|usage: git merge-tree|not a git command/i.test(
    result.stderr
  );
}
