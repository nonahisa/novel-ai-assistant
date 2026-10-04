/**
 * AIの指摘を数日残すための置き場（設計書6.96）。
 *
 * **作者の指示**（2026-09-19）：「提案が一回ごとに消えるのは面倒なので、
 * 位置把握を厳にして数日保存する機能が欲しい」。
 *
 * ## ここは下書き置き場であって、台帳ではない
 *
 * 保存するのは**指摘そのもの**（どこに・何が・なぜ）と**作者の判断**だけ
 * である。設定資料・人物・伏線・章立てへは1バイトも書かないし、本文も
 * 1文字も書き換えない（6.96.2・6.96.6）。「検知結果を自動で保存しない」
 * という従来の方針が禁じていたのは、**AIの言ったことを確かめずに作者の
 * データへ流し込む**ことであって、下書きを残すことではない。
 *
 * ## 形は編集部の提案（`models/proposal.ts`）に揃える
 *
 * 1行1件の追記のみ。**本体は書き換えず、採った・退けたは別の行を足す。**
 * 同期されるファイルなので、同じ行を両方の機械が書き換える形にすると、
 * 競合したときにどちらかの記録が消える。
 *
 * ## 行番号は鍵ではない
 *
 * `hintLine` は**検知したときの行番号**にすぎない。三日ぶんの編集に
 * 耐えるため、開くたびに `original` を本文から探し直す（6.96.3、
 * `core/findingLocation.ts`）。番号（`id`）にも行を混ぜない——混ぜると、
 * 本文が1行ずれただけで同じ指摘が別物になり、退けたはずのものが復活する。
 */

/**
 * 置き場のファイル名（`.aiwriter/` の直下）。
 *
 * **拡張機能（`features/findingStore.ts`）と MCP（`mcp/tools/proposeFinding.ts`）が
 * 同じ名前を見る。** 写しを置くと、片方だけ名前を変えた日に外から置いた指摘が
 * 画面へ届かなくなる（しかも何のエラーも出ない）。
 */
export const FINDINGS_FILE_NAME = "findings.jsonl";

/** 指摘の種類。**画面で分けるためではなく、出どころを残すため** */
export type FindingCategory =
  | "typo"
  | "notation"
  | "proofread"
  | "contradiction"
  | "deviation"
  | "other";

export interface Finding {
  /** 指摘を指すための番号。判断の記録がこれを指す */
  id: string;
  /** いつ検知したか（ISO 8601）。**期限（6.96.4）の起点** */
  time: string;
  /** 作品フォルダーからの相対パス（無理なら呼び出し側が渡した形のまま） */
  file: string;
  /**
   * 検知したときの行番号（1始まり）。
   *
   * **鍵ではなく手がかりである。** 同じ原文が何度も出るときに、
   * どれを指していたのかを決めるためだけに使う。
   */
  hintLine: number;
  /** 本文に実在するはずの原文。**探し直しの鍵はこれ** */
  original: string;
  /** `original` の中で実際に置き換える範囲。無い指摘もある（矛盾など） */
  target: string;
  /** 置き換えた後。無い指摘もある（矛盾・逸脱は直し方を出さない） */
  suggestion: string;
  /** 原文の直前にあった本文。同じ語が何度も出る作品で絞るため */
  before: string;
  /** 原文の直後にあった本文 */
  after: string;
  /** なぜ挙げたか。作者が判断するための材料 */
  message: string;
  /** どの検知から出たか */
  category: FindingCategory;
  /**
   * 記録したときの**分類名**（提案パネルのタブの名前。「矛盾（事実の照合）」など）。
   *
   * **`category` だけでは足りない**（設計書6.88.9）。「矛盾」と
   * 「矛盾（事実の照合）」はどちらも `contradiction` だが、作者はこの2つを
   * **並行させて見比べる**と決めてある。種類しか残さないと、戻したときに
   * 片方のタブへ混ざり、比べるという目的そのものが成り立たない。
   *
   * 古い記録には無いので空のこともある（そのときは種類から決める）。
   */
  label: string;
  /**
   * 左右に並べて見せる指摘（矛盾・プロット逸脱）。置き換えの指摘には無い。
   *
   * **見出しごと残す。** 矛盾は「設定では／本文では」、逸脱は
   * 「プロットでは／この話では」で言葉が違う。決め打ちで組み直すと、
   * 逸脱の指摘が「設定では」と読める形で戻ってしまう。
   */
  compared?: FindingComparison;
  /**
   * どのAIが出した指摘か（設計書6.49.7）。
   *
   * **作者が採った率をモデルごとに数えるために要る。** 置き場から戻した
   * 指摘を何日か後に採ったとき、その時点の割当を引くと、あいだに割当を
   * 替えていれば別のモデルの手柄になる。出したときに控えておく。
   *
   * **番号（`id`）には混ぜない。** 同じ箇所の同じ直しを別のモデルが出したら、
   * 作者にとっては同じ指摘である（二重に並べない）。
   *
   * 0.89.6 までの記録には無い（そのときは数えない）。
   */
  producer?: FindingProducer;
  /**
   * 外から置かれた指摘か（MCP `novel.propose` の `kind: "finding"`。作者の裁定、2026-10-01）。
   *
   * **無ければ、拡張機能の中のAIが出したもの。** 外部AI（Claude Code など）が
   * 内部AIの代わりに回した指摘を、提案パネルの行で見分けられるように持つ。
   * `producer` とは分ける——あちらは採った率を数える鍵で、モデル名が分からない
   * ときは持てない。こちらは名乗り（接続元）だけでも持つ。
   *
   * **番号（`id`）には混ぜない。** 同じ箇所の同じ直しを中と外の両方が出したら、
   * 作者にとっては同じ指摘である。
   */
  origin?: FindingOrigin;
  /**
   * 置いたときの本文の指紋（設計書5.4.4）。外から置いた指摘だけが持つ。
   *
   * **当てるかどうかの鍵ではない。** 位置は開くたびに原文で探し直し
   * （6.96.3）、当てる直前にもう一度原文を照らす。ここは「置いたあとで
   * 原稿が変わったか」を作者に添えて見せるためにある——1つ当てただけで
   * 同じ話の残りが全部止まる形にはしない。
   */
  fingerprint?: FindingFingerprint;
}

/** 指摘を出したAI（`Finding.producer`） */
export interface FindingProducer {
  providerId: string;
  model: string;
}

/** 外から置いた指摘の出どころ（`Finding.origin`） */
export interface FindingOrigin {
  kind: "external";
  /** 接続元の名乗り（`claude-code` など）。**自己申告**なので身元の証明ではない */
  client: string;
  /** 置いた側が申告したモデル名。分からなければ空 */
  model: string;
}

/** 置いたときの本文の指紋（`Finding.fingerprint`） */
export interface FindingFingerprint {
  /** ファイル全体のハッシュ（`readTextFile` の `hash` と同じ作り方） */
  fileHash: string;
  /** 検算したチャンクのハッシュ。無ければ空 */
  chunkHash: string;
}

/**
 * 出どころを、提案パネルの行に出す言葉にする。
 *
 * 「外部AI（claude-code・claude-sonnet-4-5）」のように、**接続元とモデルを
 * 並べる**。名乗りが無ければ「名乗りなし」と書く——空にすると、何から
 * 来たのか分からない行になる。
 */
export function describeFindingOrigin(origin: FindingOrigin): string {
  const client = origin.client.trim() || "名乗りなし";
  const model = origin.model.trim();
  return model ? `外部AI（${client}・${model}）` : `外部AI（${client}）`;
}

/** 左右に並べる指摘の中身（`Finding.compared`） */
export interface FindingComparison {
  /** 左の見出し（「設定では」「プロットでは」） */
  leftLabel: string;
  left: string;
  /** 右の見出し（「本文では」「この話では」） */
  rightLabel: string;
  right: string;
  /** 補足（逸脱の行範囲など）。無ければ空 */
  note: string;
}

export type FindingStatus = "pending" | "accepted" | "dismissed";

/**
 * 作者の判断。
 *
 * **指摘そのものは書き換えず、これを足す。** 片方の機械で退けたものが
 * もう片方でも退くのは、この形なら自然に成立する（6.96.4）。
 */
export interface FindingDecision {
  findingId: string;
  time: string;
  /**
   * `accepted`＝採った（本文へ当てた） / `dismissed`＝退けた /
   * **`pending`＝戻した**（判断そのものを取り消した）。
   *
   * **3つ目が要る。** 適用を「戻す」と本文は元へ返るのに、置き場には
   * 「採った」が残ったままになり、その指摘は二度と一覧へ出てこなかった。
   * 追記しかしない作りなので、取り消しも**打ち消す行を足す**形でしか
   * 書けない（前の行を書き換えると、そこが同期の衝突点になる）。
   */
  status: FindingStatus;
  /** 作者の覚え書き。無ければ空 */
  note: string;
}

/**
 * 原稿箱の取り込み（MCP `outbox.import`。設計書6.115）が判断の行に残す覚え書き。
 *
 * **ここに1つだけ置く。** 取り込む側（`mcp/tools/outbox.ts`）と、提案パネルの
 * 「当てたもの」（`core/appliedFindings.ts`。誰がどこで当てたかを覚え書きから読む）が
 * 同じ文字列を見る。写しを置くと、片方の言い回しを直した日に「当てたもの」から
 * 黙って消える。`outbox.ts` は `fs` を静的に読むので、画面の側からは import できない
 * （ブラウザ版の束が起動時に落ちる。実装ルール7）——それでモデルへ置いた。
 */
export const OUTBOX_DECISION_NOTES = {
  /** ［直す］——AIの修正案を出先で当てた */
  fix: "出先で直した",
  /** ［済み］——本文には触れていない */
  done: "出先で済みにした",
  /** ［採らない］ */
  reject: "出先で採らなかった",
  /** ［自分で直す］の元のAIの指摘（本文に入ったのは作者の文で、AIの修正案ではない） */
  editOriginal: "出先で自分で直した",
  /** ［自分で直す］で足した、作者の文の置き換えの行 */
  authorEdit: "出先で作者が自分の文に置き換えた",
} as const;

export type FindingLine =
  | ({ kind: "finding" } & Finding)
  | ({ kind: "decision" } & FindingDecision);

/** 指摘と判断を突き合わせた、いまの状態 */
export interface FindingView extends Finding {
  status: FindingStatus;
  decision?: FindingDecision;
}

const CATEGORIES: ReadonlySet<string> = new Set<FindingCategory>([
  "typo",
  "notation",
  "proofread",
  "contradiction",
  "deviation",
  "other",
]);

/**
 * 指摘の番号を作る。
 *
 * **同じ指摘が二度出ても1件で済むようにする。** 検知を何度走らせても
 * 同じ場所・同じ直しなら同じ番号になるので、一覧が同じもので埋まらない。
 *
 * **行番号を含めない**（6.96.3）。含めると、本文を1行足しただけで
 * 同じ指摘が別の番号になり、退けた記録が効かなくなる。
 *
 * **分類名（`label`）は含める。** 「矛盾」と「矛盾（事実の照合）」は
 * 同じ本文の同じ箇所を、別の根拠で挙げることがある。種類だけで番号を
 * 作ると2つが1件に潰れ、**並行して見比べる**（6.88.9）ができなくなる。
 */
export function findingId(
  file: string,
  original: string,
  target: string,
  suggestion: string,
  category: string,
  label = ""
): string {
  // 絶対パスと相対パスが混ざって来るので、ファイル名だけで揃える
  // （`dismissKey` と同じ理由。同じ作品の中で名前は重ならない）
  const fileName = file.split(/[\\/]/).pop() ?? file;
  const source = `${fileName}|${original}|${target}|${suggestion}|${category}|${label}`;
  // 短い決定的な番号。暗号用途ではないので簡単な畳み込みで足りる
  let hash = 0;
  for (const char of source) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return `f${hash.toString(36)}`;
}

/**
 * 1行1件を読む。
 *
 * **読めない行は捨てて、読める行は残す。** 同期の競合で1行が壊れたときに、
 * 無事な指摘まで見えなくしない。競合マーカーの行も落とす
 * （`core/proposalStore.ts` の `parseProposalLines` と同じ作法）。
 */
export function parseFindingLines(text: string): FindingLine[] {
  const lines: FindingLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(<<<<<<<|=======|>>>>>>>)/.test(line)) continue;
    try {
      const parsed = toFindingLine(JSON.parse(line));
      if (parsed) lines.push(parsed);
    } catch {
      // 壊れた行は捨てる
    }
  }
  return lines;
}

function toFindingLine(value: unknown): FindingLine | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;

  if (record.kind === "finding") {
    const id = str(record.id);
    const file = str(record.file);
    const original = str(record.original);
    /*
      **原文の無い指摘は読まない。** 位置を探し直す手がかりが原文なので、
      それが無いと「どこの話か」を永久に決められない（6.96.3）。
    */
    if (!id || !file || !original) return undefined;
    return {
      kind: "finding",
      id,
      time: str(record.time),
      file,
      hintLine: typeof record.hintLine === "number" ? record.hintLine : 0,
      original,
      target: str(record.target),
      suggestion: str(record.suggestion),
      before: str(record.before),
      after: str(record.after),
      message: str(record.message),
      category: toCategory(record.category),
      label: str(record.label),
      compared: toComparison(record.compared),
      producer: toProducer(record.producer),
      origin: toOrigin(record.origin),
      fingerprint: toFingerprint(record.fingerprint),
    };
  }

  if (record.kind === "decision") {
    const findingId = str(record.findingId);
    const status = record.status;
    if (!findingId || !isStatus(status)) {
      return undefined;
    }
    return {
      kind: "decision",
      findingId,
      time: str(record.time),
      status,
      note: str(record.note),
    };
  }
  return undefined;
}

/**
 * 指摘と判断を突き合わせる。
 *
 * **判断は後から来たものが勝つ。** 退けてから考え直して採ることもある。
 * 追記だけの作りなので、時刻の新しいほうを見る。
 */
export function resolveFindings(lines: FindingLine[]): FindingView[] {
  const findings = new Map<string, Finding>();
  const decisions = new Map<string, FindingDecision>();

  for (const line of lines) {
    if (line.kind === "finding") {
      /*
        **同じ番号が2回来たら、後から来たものを採る。** 提案
        （`resolveProposals`）が先勝ちなのは編集部が書くものだからで、
        こちらは同じ機能が検知し直した結果である——`hintLine` と前後の
        本文が新しいほうが、探し直しの手がかりとして確かである。
      */
      findings.set(line.id, line);
      continue;
    }
    const existing = decisions.get(line.findingId);
    /*
      **同じ時刻なら、後から書かれた行が勝つ。** 時刻はミリ秒までしか無く、
      「適用してすぐ戻す」は同じミリ秒に収まる——古いほうを残す作りだと、
      本文は元へ戻っているのに置き場は「採った」のままになり、その指摘は
      二度と一覧へ出てこない（追記しかしないので、**ファイルの並びが
      そのまま起きた順**である）。
    */
    if (!existing || !isNewer(existing.time, line.time)) {
      decisions.set(line.findingId, line);
    }
  }

  const views: FindingView[] = [];
  for (const finding of findings.values()) {
    const decision = decisions.get(finding.id);
    views.push({
      ...finding,
      status: decision?.status ?? "pending",
      decision,
    });
  }
  return views;
}

/**
 * その指摘が期限切れか（設計書6.96.4）。
 *
 * **隠すためだけの判定である。** ここが `true` を返しても、ファイルからは
 * 消さない——時計のずれや、ノートPCを久しぶりに開いたときに、
 * **作者が見る前に消える**のを防ぐため。消えるのは作者が明示の操作を
 * したときだけ。
 *
 * @param retentionDays 残す日数。`0` 以下なら無期限（何も隠さない）
 */
export function isFindingExpired(
  time: string,
  retentionDays: number,
  now: Date
): boolean {
  if (!(retentionDays > 0)) return false;
  const created = Date.parse(time);
  // **日時が読めない指摘は隠さない。** 消せるものより見られるほうを採る
  if (Number.isNaN(created)) return false;
  const elapsed = now.getTime() - created;
  // 未来の日時（時計のずれ）も隠さない
  if (elapsed < 0) return false;
  return elapsed > retentionDays * 24 * 60 * 60 * 1000;
}

/**
 * 片づける（＝置き場から本当に消す）対象の番号（設計書6.96.4）。
 *
 * **同じ番号が2度書かれていることがある**（記録は追記のみで、前の行を
 * 探さない）。**1行でも期限内のものがあれば残す**——`resolveFindings` は
 * 後から来たほうを採るので、期限内の行があればそれがいまの中身である。
 * 古い行だけを見て消すと、**まだ3日経っていない指摘が消える。**
 */
export function expiredFindingIds(
  lines: readonly FindingLine[],
  retentionDays: number,
  now: Date
): Set<string> {
  const doomed = new Set<string>();
  const alive = new Set<string>();
  for (const line of lines) {
    if (line.kind !== "finding") continue;
    if (isFindingExpired(line.time, retentionDays, now)) doomed.add(line.id);
    else alive.add(line.id);
  }
  for (const id of alive) doomed.delete(id);
  return doomed;
}

function isNewer(candidate: string, current: string): boolean {
  const left = Date.parse(candidate);
  const right = Date.parse(current);
  if (Number.isNaN(left)) return false;
  if (Number.isNaN(right)) return true;
  return left > right;
}

/** 判断の印。**知らない値は読まない**（勝手に「退けた」ことにしない） */
function isStatus(value: unknown): value is FindingStatus {
  return value === "accepted" || value === "dismissed" || value === "pending";
}

/**
 * 左右に並べる指摘（`Finding.compared`）を読む。
 *
 * **無い記録のほうが多い。** 置き換えの指摘（誤字脱字など）は持たないし、
 * 0.68.2 までに残した矛盾の記録にも入っていない。読めなければ
 * `undefined` を返し、戻す側が従来どおり1文で出す。
 */
function toComparison(value: unknown): FindingComparison | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const left = str(record.left);
  const right = str(record.right);
  // 左右のどちらも空なら、並べて見せる意味が無い
  if (!left && !right) return undefined;
  return {
    leftLabel: str(record.leftLabel),
    left,
    rightLabel: str(record.rightLabel),
    right,
    note: str(record.note),
  };
}

/**
 * 指摘を出したAI（`Finding.producer`）を読む。
 *
 * **片方でも欠けていれば読まない**（`undefined`）。モデルの名前だけ、
 * プロバイダだけでは、どのモデルの手柄か決められない。
 */
function toProducer(value: unknown): FindingProducer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const providerId = str(record.providerId);
  const model = str(record.model);
  if (!providerId || !model) return undefined;
  return { providerId, model };
}

/**
 * 外から置いた印（`Finding.origin`）を読む。
 *
 * **知らない種類は読まない**（`undefined`）。読めないものを「中のAI」と
 * 見なすのは、出どころを消すのと同じだが、ここで勝手に「外部AI」と
 * 名乗らせるよりはよい——種類はいま `external` の1つしか無い。
 */
function toOrigin(value: unknown): FindingOrigin | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== "external") return undefined;
  return { kind: "external", client: str(record.client), model: str(record.model) };
}

/** 置いたときの指紋（`Finding.fingerprint`）を読む。ファイルの指紋が無ければ読まない */
function toFingerprint(value: unknown): FindingFingerprint | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const fileHash = str(record.fileHash);
  if (!fileHash) return undefined;
  return { fileHash, chunkHash: str(record.chunkHash) };
}

function toCategory(value: unknown): FindingCategory {
  // 知らない種類で止めない。並べる側は種類で分けないので害が無い
  return typeof value === "string" && CATEGORIES.has(value)
    ? (value as FindingCategory)
    : "other";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
