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

/**
 * 許可の鍵（0.66.7）。
 *
 * **道具を束ねても、作者が選んだ粒度は変えない**（設計書6.87.15 の柱1）。
 * 0.66.6 までは道具ごと（`typo.run`）だったが、いまは道具が
 * `novel.prompt`／`novel.validate`／`novel.run` の3本に束ねられ、
 * **何をするかは `feature` が決める**。だから鍵も `feature` にする
 * ——`prompt`／`validate`／`run` の別は鍵に含めない（同じ feature なら、
 * 本文がどこまで出るかは `runner` で決まる）。
 *
 * **作者が既に置いた印を無効にしない。** 作品の `.aiwriter/external-access.json`
 * には古い道具名（`typo.run`）で書かれた許可が実在する。**印のファイルは
 * 書き換えず、読むときに読み替える**——書き換えると、作者が見ていないところで
 * 許可の中身が変わることになる。
 *
 * **読み替えは広げない。** `typo.run` は `typo` だけを許す。`settings.propose`
 * は `novel.propose` だけで、設定資料の抽出（`settings`）には届かない
 * ——ここを取り違えると、**許していない作品の原稿が外へ出る。**
 */
export const LEGACY_TOOL_KEYS: Readonly<Record<string, string>> = {
  "work.scan": "novel.scan",
  // **提案の道具は feature ではない。** `settings` へ寄せると、
  // 承認待ちへ置くことだけを許した印が、設定資料の抽出まで許してしまう
  "settings.propose": "novel.propose",
  "typo.prompt": "typo",
  "typo.validate": "typo",
  "typo.run": "typo",
  "proofread.prompt": "proofread",
  "proofread.validate": "proofread",
  "proofread.run": "proofread",
  "contradiction.material": "contradiction",
  "contradiction.prompt": "contradiction",
  "contradiction.validate": "contradiction",
  "contradiction.run": "contradiction",
  "foreshadow.prompt": "foreshadow",
  "foreshadow.validate": "foreshadow",
  "foreshadow.run": "foreshadow",
  "settings.prompt": "settings",
  "settings.validate": "settings",
  "settings.run": "settings",
  "chat.prompt": "chat",
  "chat.validate": "chat",
  "chat.run": "chat",
  "notation.detect": "notation",
  "notation.prompt": "notation",
  "notation.validate": "notation",
  "notation.run": "notation",
  "episode.synopsisPrompt": "synopsis",
  "episode.synopsisValidate": "synopsis",
  "episode.synopsisRun": "synopsis",
  "episode.deviationPrompt": "deviation",
  "episode.deviationValidate": "deviation",
  "episode.deviationRun": "deviation",
  "episode.plotPrompt": "episodePlot",
  "episode.plotValidate": "episodePlot",
  "episode.plotRun": "episodePlot",
  "opening.prompt": "opening",
  "opening.validate": "opening",
  "opening.run": "opening",
  "name.collisions": "name",
  "name.prompt": "name",
  "name.validate": "name",
  "name.run": "name",
  "plot.reversePrompt": "plotReverse",
  "plot.reverseValidate": "plotReverse",
  "plot.reverseRun": "plotReverse",
  "chapter.proposePrompt": "chapter",
  "chapter.proposeValidate": "chapter",
  "chapter.proposeRun": "chapter",
  "blurb.prompt": "blurb",
  "blurb.validate": "blurb",
  "blurb.run": "blurb",
  "blurb.catchphrasePrompt": "catchphrase",
  "blurb.catchphraseValidate": "catchphrase",
  "blurb.catchphraseRun": "catchphrase",
};

/** 鍵から、その鍵に読み替わる古い道具名。**印を読むときだけ使う** */
const LEGACY_NAMES_BY_KEY = new Map<string, string[]>();
for (const [legacy, key] of Object.entries(LEGACY_TOOL_KEYS)) {
  LEGACY_NAMES_BY_KEY.set(key, [...(LEGACY_NAMES_BY_KEY.get(key) ?? []), legacy]);
}

/**
 * `feature` を引数で受ける道具（0.66.7 で束ねたもの）。
 *
 * **この道具たちの鍵は `feature` のほう**である。道具の名前で鍵を作ると、
 * `novel.run` を1度許しただけで16の機能が全部通ってしまう。
 */
const FEATURE_KEYED_TOOLS = new Set([
  "novel.prompt",
  "novel.validate",
  "novel.run",
  "novel.detect",
  "novel.material",
  /*
    **断りを読む道具も、機能ごと**（`novel.notice`、0.72.0）。原稿は1文字も
    返さないが、**許可の粒度を道具ごとに揺らさない**ほうが作者には分かりやすい
    ——「矛盾検知は外部AIに触らせてよいが、逸脱は嫌だ」と決めた作者にとって、
    どちらの断りも読めてしまうのは、決めたことと食い違って見える。
  */
  "novel.notice",
]);

/**
 * その呼び出しの許可の鍵。
 *
 * **ここが唯一の決め方。** 許可を確かめる側（`mcp/tools/permission.ts`）と
 * 記録する側（`mcp/tools/accessLog.ts`）が別々に決めると、**断られた鍵と
 * 作者が許可する鍵がずれて、いくら許可しても通らない**という形になる。
 *
 * @param feature 引数の `feature`。文字列でなければ道具の名前を鍵にする
 *   （＝許可されていない鍵になり、断る側に倒れる）
 */
export function permissionKeyOf(tool: string, feature: unknown): string {
  if (!FEATURE_KEYED_TOOLS.has(tool)) return tool;
  return typeof feature === "string" && feature.trim() ? feature : tool;
}

export interface ExternalClientPermission {
  /**
   * 接続元の名乗り（`claude-code` など）。
   *
   * **自己申告であって、身元の証明ではない。** 偽れるので、これは
   * 鍵ではなく目印である。
   */
  name: string;
  /**
   * 許した鍵（`typo`・`novel.scan` など）。**ここに無い鍵は断る。**
   *
   * 0.66.6 までの印には古い道具名（`typo.run`）が入っている。
   * **そのまま読める**（`LEGACY_TOOL_KEYS` で読み替える）ので、
   * 作者が置き直す必要はない。
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
 * その接続元が、その鍵を使ってよいか。
 *
 * **道具ごとに見る**（作者の指示、2026-09-16）。許可したのは
 * 「この相手が、これを」であって、「この相手が何でも」ではない。
 *
 * **古い道具名で書かれた印も、そのまま効く**（0.66.7）。`typo.run` と
 * 書いてあれば `typo` を許したものとして読む——**印のファイルは
 * 書き換えない**（読むときに読み替えるだけ）。
 */
export function isToolAllowed(
  permission: ExternalAccessPermission,
  client: string | undefined,
  key: string
): boolean {
  const entry = clientPermissionOf(permission, clientKeyOf(client));
  if (!entry) return false;
  if (entry.tools.includes(ALL_TOOLS) || entry.tools.includes(key)) return true;
  return (LEGACY_NAMES_BY_KEY.get(key) ?? []).some((legacy) =>
    entry.tools.includes(legacy)
  );
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
  /*
    **道順は、実際に在る場所を書く**（0.66.2）。作者が探して見つけられず
    （2026-09-16）、メニューの置き場所を移した——**断り文句のほうも直さないと、
    呼んだ側が作者に古い道順を伝えることになる。**
  */
  const how =
    "VS Code でこの作品を開くと、いまのノックが画面に出ます。" +
    "そこで「この道具だけ許可」を選んでください" +
    "（詳細メニューの「拡張機能の設定 → 作品ごとの設定 → 外部AIの利用を許可する／取り消す」" +
    "からも決められます）。";
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
    "「拡張機能の設定 → 作品ごとの設定 → 外部AIの利用を許可する／取り消す」から、" +
    "その接続元の「考えさせることも許可する」を選んでください。" +
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
