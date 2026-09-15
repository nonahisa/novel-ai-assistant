/**
 * 外部AI（MCP）にこの作品を読ませてよいか（設計書6.87.10）。
 *
 * **既定は拒否**（作者の指示、2026-09-15）。**意思確認をしてから使える。**
 * 拡張機能を入れただけ・MCPサーバーを登録しただけでは、原稿は1文字も読めない。
 *
 * MCPサーバーは**VS Code が起動していなくても動く**別プロセスなので、
 * その場で作者へ問うことができない。だから**作者が先に置いた印**を見る。
 * 印が無ければ断り、**どうすれば許可できるかを返事に書く**。
 *
 * ## 置き場所は作品フォルダーの中、ただし同期しない
 *
 * `.aiwriter/external-access.json`。作品ごとに決められる粒度が自然で
 * （ある作品は読ませてよいが、別の作品はだめ、がありうる）、作品を
 * 移しても許可が付いてくる。
 *
 * **同期はしない**（`IGNORED_PATHS`）。同期すると、リポジトリを共有した
 * 編集部の機械でも許可済みになる。**許可は作者がその機械で与えるもの**である。
 *
 * ## 読めない印は「拒否」に倒す
 *
 * 壊れたJSON・見覚えのない形は、許可と読まない。**迷ったら断る**——
 * 断って困るのは作者が操作し直す手間だけだが、誤って許可すると原稿が出る。
 *
 * VS Code APIに依存しない——**MCPサーバーの束から読み、拡張機能から書く**。
 */

/** `.aiwriter/` の直下。**同期から外す**（`workRegistry.ts` の `IGNORED_PATHS`） */
export const EXTERNAL_PERMISSION_FILE = "external-access.json";

export interface ExternalAccessPermission {
  /** 許可されているか。**印が無い・読めないときは false** */
  allowed: boolean;
  /** いつ決めたか（ISO 8601）。分からなければ空 */
  decidedAt: string;
  /** どの機械で決めたか。作者が複数の機械を使うので残す */
  decidedOn: string;
  /** 作者が添えた覚え書き。無ければ空 */
  note: string;
}

export const DENIED: ExternalAccessPermission = {
  allowed: false,
  decidedAt: "",
  decidedOn: "",
  note: "",
};

/**
 * MCPが断るときの返事。**ここが唯一の定義**（写すとずれる）。
 *
 * **何が起きたか・どうすれば使えるか・なぜ既定が拒否か**の3つを書く。
 * 断っただけでは、呼んだ側は不具合と区別が付かない。
 */
export const EXTERNAL_ACCESS_DENIED_MESSAGE =
  "この作品は、外部AIの利用がまだ許可されていません（既定では拒否しています）。" +
  "許可するには、VS Code でこの作品を開き、詳細メニューの" +
  "「外部AI（MCP）の利用を許可する」を実行してください。" +
  "許可すると、この作品の本文と設定資料を外部AIが読めるようになります" +
  "（読むだけで、書き換えはしません）。" +
  "許可はいつでも取り消せます。ノックがあったことは記録に残しました。";

/**
 * 印を読む。
 *
 * @param text ファイルの中身。ファイルが無ければ呼ばない（＝拒否）
 */
export function parseExternalAccessPermission(
  text: string
): ExternalAccessPermission {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // **壊れた印は許可と読まない**
    return DENIED;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DENIED;
  }
  const raw = value as Record<string, unknown>;
  // **`true` そのものだけを許可と読む。** "yes" や 1 を許可にすると、
  // 書き損じが許可になる
  if (raw.allowed !== true) return DENIED;

  return {
    allowed: true,
    decidedAt: typeof raw.decidedAt === "string" ? raw.decidedAt : "",
    decidedOn: typeof raw.decidedOn === "string" ? raw.decidedOn : "",
    note: typeof raw.note === "string" ? raw.note : "",
  };
}

export function formatExternalAccessPermission(
  permission: ExternalAccessPermission
): string {
  /*
    **作者が開いて読める形にする。** 作者はプログラマではないので、
    何のファイルか分かるように覚え書きを添える。
  */
  return `${JSON.stringify(
    {
      _説明:
        "外部AI（MCPサーバー）にこの作品を読ませてよいかの印です。" +
        "allowed を false にするか、このファイルを消せば拒否に戻ります。" +
        "このファイルは同期されません（機械ごとの判断です）。",
      allowed: permission.allowed,
      decidedAt: permission.decidedAt,
      decidedOn: permission.decidedOn,
      note: permission.note,
    },
    null,
    2
  )}\n`;
}

/** 画面に出す一文。**いまどちらなのかを、最初に言う** */
export function describeExternalAccessPermission(
  permission: ExternalAccessPermission
): string {
  if (!permission.allowed) {
    return "外部AI（MCP）の利用：拒否（既定）。この作品は外から読めません。";
  }
  const where = permission.decidedOn ? `${permission.decidedOn} で` : "";
  const when = permission.decidedAt ? `${permission.decidedAt} に` : "";
  const decided = [when, where].filter(Boolean).join("");
  return `外部AI（MCP）の利用：許可（${decided || "決めた日時は不明"}）。この作品の本文と設定資料を外から読めます。`;
}
