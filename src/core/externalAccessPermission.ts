/**
 * 外部AI（MCP）にこの作品を触らせてよいか（設計書6.87.10、6.87.14）。
 *
 * **既定は拒否**（作者の指示、2026-09-15）。**意思確認をしてから使える。**
 * 拡張機能を入れただけ・MCPサーバーを登録しただけでは、原稿は1文字も読めない。
 *
 * **許可しても全開放にしない**（作者の指示、2026-09-16
 * 「承認後も全開放とはせず、接続元やモデルなどを見分け、個別に承認するように」）。
 * 許可は**接続元（名乗り）ごと・道具ごと**に持つ。`typo.run` を許したことは、
 * `settings.run` を許したことにならない。
 *
 * MCPサーバーは**VS Code が起動していなくても動く**別プロセスなので、
 * その場で作者へ問うことができない。だから**作者が先に置いた印**を見る。
 * 印が無ければ断り、**どうすれば許可できるかを返事に書く**。断ったことは
 * 記録に残り、次に VS Code を開いたときに知らせる（6.87.14）。
 *
 * ## 名乗りは、身元の証明ではない
 *
 * 接続元の名前は MCP の `initialize` で相手が申告するもので、**偽れる。**
 * それでも「Claude Code から」「別の何かから」の区別は作者の役に立つので、
 * **目印として**使う。画面にもそう書く——鍵だと思わせない。
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

/**
 * 名乗らなかった相手の置き場所。
 *
 * **「名無し」も1つの接続元として扱う。** 空文字のまま持つと、
 * 画面で「（空欄）を許可しますか」と出て何のことか分からない。
 */
export const ANONYMOUS_CLIENT = "（名乗りなし）";

/** 「この接続元の道具は全部」を表す印 */
export const ALL_TOOLS = "*";

export interface ExternalClientPermission {
  /**
   * 接続元の名乗り（`claude-code` など）。
   *
   * **自己申告であって、身元の証明ではない。** 偽れるので、これは
   * 鍵ではなく目印である。
   */
  name: string;
  /**
   * 許した道具の名前（`typo.run` など）。**ここに無い道具は断る。**
   *
   * `ALL_TOOLS`（`"*"`）が入っていれば、この接続元には全部許した
   * ——作者が明示的にそう選んだときだけ入る。
   */
  tools: string[];
  /**
   * **呼び出し元のAIに考えさせることを許すか**（sampling。設計書6.87.12）。
   *
   * **道具ごとではなく接続元ごとに持つ。** 道具の別より**行き先の別**が
   * 重いからである——考えさせると、本文が**呼び出し元が選んだAIまで**届く。
   */
  sampling: boolean;
  /** いつ決めたか（ISO 8601）。分からなければ空 */
  decidedAt: string;
  /** どの機械で決めたか。作者が複数の機械を使うので残す */
  decidedOn: string;
  /** 作者が添えた覚え書き。無ければ空 */
  note: string;
}

export interface ExternalAccessPermission {
  /** 接続元ごとの許可。**空なら、誰にも何も許していない** */
  clients: ExternalClientPermission[];
  /**
   * 古い形の印を読んだか（0.66.1 より前の `allowed: true`）。
   *
   * **古い印は許可と読まない**（作者の指示で、接続元ごとに決め直す形に
   * なったため）。ただし**黙って無効にしない**——断り文句で、決め直しが
   * 要ることを伝えるために覚えておく。
   */
  legacy: boolean;
}

export const DENIED: ExternalAccessPermission = { clients: [], legacy: false };

/** その接続元の決まりごとを取り出す。無ければ undefined */
export function clientPermissionOf(
  permission: ExternalAccessPermission,
  client: string
): ExternalClientPermission | undefined {
  const name = clientKeyOf(client);
  return permission.clients.find((entry) => entry.name === name);
}

/** 名乗りを、印の中での呼び名に揃える（空なら「名乗りなし」） */
export function clientKeyOf(client: string | undefined): string {
  const trimmed = (client ?? "").trim();
  return trimmed ? trimmed.slice(0, 80) : ANONYMOUS_CLIENT;
}

/**
 * その接続元が、その道具を使ってよいか。
 *
 * **道具ごとに見る**（作者の指示、2026-09-16）。許可したのは
 * 「この相手が、この道具を」であって、「この相手が何でも」ではない。
 */
export function isToolAllowed(
  permission: ExternalAccessPermission,
  client: string | undefined,
  tool: string
): boolean {
  const entry = clientPermissionOf(permission, clientKeyOf(client));
  if (!entry) return false;
  return entry.tools.includes(ALL_TOOLS) || entry.tools.includes(tool);
}

/**
 * その接続元に、考えさせること（sampling）を許しているか。
 *
 * **読ませる許可とは別**（設計書6.87.12）。道具を許していても、
 * こちらは別に要る。
 */
export function isSamplingAllowed(
  permission: ExternalAccessPermission,
  client: string | undefined
): boolean {
  return clientPermissionOf(permission, clientKeyOf(client))?.sampling === true;
}

/**
 * MCPが断るときの返事。**ここが唯一の定義**（写すとずれる）。
 *
 * **何が起きたか・どうすれば使えるか・なぜ既定が拒否か**の3つを書く。
 * 断っただけでは、呼んだ側は不具合と区別が付かない。
 *
 * **道具の名前を返事に入れる。** 作者の画面には「どの相手が、どの道具を
 * 使おうとしたか」が出るので、呼んだ側と作者が同じものを見て話せる。
 */
export function externalAccessDeniedMessage(options: {
  client: string | undefined;
  tool: string;
  legacy: boolean;
}): string {
  const who = clientKeyOf(options.client);
  const head =
    `この作品では、${who} からの「${options.tool}」がまだ許可されていません` +
    "（既定では拒否しています。許可は接続元ごと・道具ごとです）。";
  const how =
    "VS Code でこの作品を開くと、いまのノックが画面に出ます。" +
    "そこで「この道具を許可」を選んでください" +
    "（詳細メニューの「外部AI（MCP）の利用を許可する」からも決められます）。";
  const why =
    "ほかの道具を許可していても、この道具は別に許可が要ります" +
    "——どこまで原稿が外へ出るかが、道具ごとに違うためです。";
  const migrate = options.legacy
    ? "この作品には古い形の許可（作品ぜんたいを一括で許可するもの）が残っています。" +
      "接続元ごと・道具ごとに決め直してください。"
    : "";
  return [head, how, why, migrate].filter(Boolean).join("");
}

/**
 * 考えさせることを断るときの返事（設計書6.87.12）。
 *
 * **読ませる許可とは別に断る。** 読ませてよいと決めた作者が、
 * **呼び出し元の選んだAIへ本文を渡すことまで許したとは限らない。**
 */
export function samplingNotPermittedMessage(client: string | undefined): string {
  return (
    `この作品では、${clientKeyOf(client)} に考えさせること（sampling）を` +
    "まだ許可していません（既定では拒否しています）。" +
    "道具を許可していても、こちらは別に許可が要ります" +
    "——考えさせると、本文が呼び出し元の選んだAIへ渡るためです。" +
    "許可するには、VS Code でこの作品を開き、詳細メニューの" +
    "「外部AI（MCP）の利用を許可する」から、その接続元の" +
    "「考えさせることも許可」を選んでください。" +
    "許可しないまま使うなら、runner を ollama（手元で完結）にしてください。"
  );
}

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

  /*
    **古い形（0.66.1 より前）は許可と読まない。** あれは作品ぜんたいを
    一括で許すもので、作者の指示（接続元ごと・道具ごと）と噛み合わない。
    **黙って無効にはせず**、決め直しが要ることを断り文句で伝える。
  */
  if (!Array.isArray(raw.clients)) {
    return { clients: [], legacy: raw.allowed === true };
  }

  const clients: ExternalClientPermission[] = [];
  for (const item of raw.clients) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    clients.push({
      name: name.slice(0, 80),
      // **文字列だけを道具名と読む**（書き損じを許可にしない）
      tools: Array.isArray(entry.tools)
        ? entry.tools.filter((tool): tool is string => typeof tool === "string")
        : [],
      // **`true` そのものだけを許可と読む**
      sampling: entry.sampling === true,
      decidedAt: typeof entry.decidedAt === "string" ? entry.decidedAt : "",
      decidedOn: typeof entry.decidedOn === "string" ? entry.decidedOn : "",
      note: typeof entry.note === "string" ? entry.note : "",
    });
  }
  return { clients, legacy: false };
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
        "外部AI（MCPサーバー）にこの作品を触らせてよいかの印です。" +
        "接続元（名乗り）ごと・道具ごとに許可します。" +
        "clients から接続元を消すか、tools から道具名を消せば拒否に戻ります。" +
        "tools に \"*\" が入っていると、その接続元には全部を許した状態です。" +
        "sampling は、呼び出し元のAIに考えさせてよいかです" +
        "（本文が、呼び出し元の選んだAIへ渡ります）。" +
        "名乗りは相手の自己申告なので、身元の証明ではありません。" +
        "このファイルは同期されません（機械ごとの判断です）。",
      clients: permission.clients,
    },
    null,
    2
  )}\n`;
}

/** 画面に出す一文。**いまどうなっているかを、最初に言う** */
export function describeExternalAccessPermission(
  permission: ExternalAccessPermission
): string {
  if (permission.clients.length === 0) {
    return permission.legacy
      ? "外部AI（MCP）の利用：拒否。古い形の許可が残っているので、接続元ごとに決め直してください。"
      : "外部AI（MCP）の利用：拒否（既定）。この作品は外から読めません。";
  }
  const parts = permission.clients.map((client) => {
    const scope = client.tools.includes(ALL_TOOLS)
      ? "全部の道具"
      : `${client.tools.length}個の道具`;
    const thinking = client.sampling ? "・考えさせることも許可" : "";
    return `${client.name}（${scope}${thinking}）`;
  });
  return `外部AI（MCP）の利用：${parts.join("、")}。ほかの接続元・道具は拒否です。`;
}
