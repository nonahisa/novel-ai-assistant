import {
  ADVICE_TYPES,
  type AdviceLevel,
  type AdviceProfile,
  type AdviceScores,
  type AdviceState,
  type AdviceHistoryEntry,
  type AdviceHistorySource,
  type AdviceTypeId,
} from "./advicePolicy";

/**
 * 助言方針の控え（設計書6.86.7・6.87.15）。
 *
 * **なぜ要るか。** 助言方針（9問の答え・点数・調子）は `globalState` に在り、
 * VS Code の外で走る MCP サーバーからは読めない。そのため**外部AI経由の相談
 * だけ、タイプの方針も調子の補正も永久に効かなかった**（0.71.0 で見つかった穴）。
 * 拡張機能が控えを書き出し、MCP がそれを読む。
 *
 * **置き場所は `globalStorageUri` の下**（MCP の束の写しと同じ場所）。
 * **作品フォルダー（`.aiwriter/` を含む）へは置かない**——あそこは
 * 作者が普段開く場所で、しかも GitHub で編集部と共有される。
 * 受容度・自信度は**作者にも見せないと決めたもの**（6.86.2）なので、
 * 作者の目に触れる場所に置いた時点で決まりが破れる。
 *
 * ここは**形と突き合わせだけ**を持つ。VS Code にも Node にも依存しないので、
 * 拡張機能側（`features/adviceProfileMirror.ts`）と MCP 側
 * （`mcp/adviceProfileMirror.ts`）が同じものを見る——写しを作ると、
 * 片方だけ直る日が来る。
 */

/** 控えのファイル名。`globalStorageUri` の直下に置く */
export const ADVICE_MIRROR_FILE = "advice-profiles.json";

/** 控えの形の版。読めない版は「無い」ものとして扱う（直しにいかない） */
export const ADVICE_MIRROR_SCHEMA = 1;

/**
 * 作者ごとの既定（`ADVICE_POLICY_DEFAULT_KEY` に当たるもの）の鍵。
 *
 * **作品フォルダーの道と踏み合わない形にする。** 正規化した道は必ず
 * 文字か `/` で始まるので、`*` で始まる名前とは衝突しない。
 */
export const ADVICE_MIRROR_DEFAULT_KEY = "*default*";

export interface AdviceMirrorEntry {
  /** 作品フォルダーの道を正規化したもの、または `ADVICE_MIRROR_DEFAULT_KEY` */
  key: string;
  /** 見たままの道（人が読むときのため。突き合わせには使わない） */
  folderPath?: string;
  /** 拡張機能が書いたときだけ入る。MCP は作品の ID を知らない */
  workId?: string;
  /**
   * この控えを最後に書いた時刻（ISO）。
   *
   * **`AdviceProfile.updatedAt` とは別物である。** あちらは「作者が9問に
   * 答えた日」で、推定で点数が動いても動かない（`advicePolicy.ts` の断り書き）。
   * どちらが新しいかを決められる手掛かりは、この欄しか無い。
   */
  updatedAt: string;
  /**
   * 最後に効かせた相談の答えの指紋。
   *
   * **同じ答えを二度効かせないために持つ。** 外部AIは `novel.validate` を
   * 撃ち直せる（間違えて2回撃つ）ので、素直に効かせると ±0.5 が ±1.0 になり、
   * **「段階が1つ動くまでおおよそ10回の相談が要る」という歯止めが
   * 撃ち直しで迂回できる**（0.71.x で塞いだ）。
   *
   * **無い控えは古いだけで、壊れてはいない。** 項目が無ければ
   * 「まだ一度も効かせていない」として読む。
   */
  lastSignalHash?: string;
  profile: AdviceProfile;
}

export interface AdviceMirrorFile {
  schema: number;
  entries: AdviceMirrorEntry[];
}

export function emptyAdviceMirror(): AdviceMirrorFile {
  return { schema: ADVICE_MIRROR_SCHEMA, entries: [] };
}

/**
 * 作品フォルダーの道を、突き合わせに使う鍵にする。
 *
 * **大文字小文字を畳む。** 作者の機械は Windows で、拡張機能が持つ道
 * （`C:\Users\…`）と MCP へ渡ってくる道（`c:/users/…`）は、同じ場所を指しても
 * 字が違う。畳まないと、同じ作品に別々の控えが2つできる。
 * Linux では別の場所が1つに畳まれうるが、**この控えは機械ごとのもの**で、
 * 畳んだ先も同じ作者の同じ機械の中にある。
 */
export function adviceMirrorKey(folderPath: string): string {
  return folderPath
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * その作品の控え。作品のものが無ければ**作者の既定**を返す。
 *
 * 落ち方は製品の `AdvicePolicyStore.getEffective` と同じ——作品に無ければ
 * 既定を使い、既定も無ければ何も返さない。
 */
export function findAdviceMirrorEntry(
  file: AdviceMirrorFile,
  folderPath: string
): AdviceMirrorEntry | undefined {
  const key = adviceMirrorKey(folderPath);
  return (
    file.entries.find((entry) => entry.key === key) ??
    file.entries.find((entry) => entry.key === ADVICE_MIRROR_DEFAULT_KEY)
  );
}

/** 鍵そのもので引く（既定へは落ちない） */
export function adviceMirrorEntryOf(
  file: AdviceMirrorFile,
  key: string
): AdviceMirrorEntry | undefined {
  return file.entries.find((entry) => entry.key === key);
}

/** 同じ鍵のものを差し替える（無ければ足す）。**元の並びは変えない** */
export function putAdviceMirrorEntry(
  file: AdviceMirrorFile,
  entry: AdviceMirrorEntry
): AdviceMirrorFile {
  const entries = file.entries.some((current) => current.key === entry.key)
    ? file.entries.map((current) => (current.key === entry.key ? entry : current))
    : [...file.entries, entry];
  return { schema: ADVICE_MIRROR_SCHEMA, entries };
}

/** 鍵で消す（作者が「方針を消す」を選んだとき） */
export function removeAdviceMirrorEntry(
  file: AdviceMirrorFile,
  key: string
): AdviceMirrorFile {
  return {
    schema: ADVICE_MIRROR_SCHEMA,
    entries: file.entries.filter((entry) => entry.key !== key),
  };
}

/**
 * 控えのほうが新しいか。
 *
 * **決められないときは false**（＝手元の `globalState` を残す）。日付が
 * 読めない・同じ時刻・控えのほうが古い、のどれでも手元を残す——
 * 作者の手元の記録を、外から来たもので押し流さないため。
 */
export function isAdviceMirrorNewer(
  mirrorUpdatedAt: string,
  knownUpdatedAt: string | undefined
): boolean {
  const mirror = Date.parse(mirrorUpdatedAt);
  if (Number.isNaN(mirror)) return false;
  if (knownUpdatedAt === undefined) return true; // まだ一度も取り込んでいない
  const known = Date.parse(knownUpdatedAt);
  if (Number.isNaN(known)) return false;
  return mirror > known;
}

export function serializeAdviceMirror(file: AdviceMirrorFile): string {
  return `${JSON.stringify(
    { schema: ADVICE_MIRROR_SCHEMA, entries: file.entries },
    null,
    2
  )}\n`;
}

/**
 * 控えを読み解く。
 *
 * **壊れていたら `undefined`。直しにいかない。** ここは作者が書いたデータでは
 * なく、拡張機能が書き出した控えである——読めなければ、次の書き出しで
 * 作り直せばよい（実装ルール2の「壊れたJSONを直さない」の理由は
 * 作者のデータを守ることなので、ここは当てはまらない）。
 */
export function parseAdviceMirror(text: string): AdviceMirrorFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.schema !== ADVICE_MIRROR_SCHEMA) return undefined;
  if (!Array.isArray(record.entries)) return undefined;

  const entries: AdviceMirrorEntry[] = [];
  for (const raw of record.entries) {
    const entry = parseEntry(raw);
    if (entry) entries.push(entry);
  }
  return { schema: ADVICE_MIRROR_SCHEMA, entries };
}

function parseEntry(value: unknown): AdviceMirrorEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const key = record.key;
  const updatedAt = record.updatedAt;
  if (typeof key !== "string" || key.length === 0) return undefined;
  if (typeof updatedAt !== "string" || updatedAt.length === 0) return undefined;
  const profile = parseAdviceProfileValue(record.profile);
  if (!profile) return undefined;

  return {
    key,
    folderPath: typeof record.folderPath === "string" ? record.folderPath : undefined,
    workId: typeof record.workId === "string" ? record.workId : undefined,
    updatedAt,
    // **指紋が無い控えは、古いだけ。** 無いことを壊れている扱いにしない
    lastSignalHash:
      typeof record.lastSignalHash === "string" ? record.lastSignalHash : undefined,
    profile,
  };
}

/**
 * 控えの中の方針を、使える形に絞る。
 *
 * **知らない値は落とす。** ここへ来る JSON は機械が書いたものだが、
 * 版をまたいだ控えが残っていることがある——形を確かめずに点数の計算へ
 * 入れると、`NaN` の点数のまま助言の調子が決まる（`parseProfileSignals` と
 * 同じ考え方）。
 */
export function parseAdviceProfileValue(
  value: unknown
): AdviceProfile | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;

  const scores = parseScores(record.scores);
  if (!scores) return undefined;
  if (typeof record.updatedAt !== "string") return undefined;

  const answers = Array.isArray(record.answers)
    ? record.answers.filter((item): item is number => isFiniteNumber(item))
    : [];

  const profile: AdviceProfile = {
    scores,
    answers,
    updatedAt: record.updatedAt,
  };

  const base = parseScores(record.baseScores);
  if (base) profile.baseScores = base;

  const state = parseState(record.state);
  if (state) profile.state = state;

  const history = parseHistory(record.history);
  if (history.length > 0) profile.history = history;

  return profile;
}

function parseScores(value: unknown): AdviceScores | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { reader, self, taste } = record;
  if (!isFiniteNumber(reader) || !isFiniteNumber(self) || !isFiniteNumber(taste)) {
    return undefined;
  }
  return { reader, self, taste };
}

function parseState(value: unknown): AdviceState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const acceptance = parseLevel(record.acceptance);
  const confidence = parseLevel(record.confidence);
  if (!acceptance || !confidence) return undefined;
  if (typeof record.updatedAt !== "string") return undefined;
  const state: AdviceState = {
    acceptance,
    confidence,
    updatedAt: record.updatedAt,
  };
  if (isFiniteNumber(record.lowStreak)) state.lowStreak = record.lowStreak;
  return state;
}

function parseLevel(value: unknown): AdviceLevel | undefined {
  return value === "low" || value === "mid" || value === "high" ? value : undefined;
}

function parseHistory(value: unknown): AdviceHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: AdviceHistoryEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const typeId = record.typeId;
    if (typeof typeId !== "string" || !(typeId in ADVICE_TYPES)) continue;
    const scores = parseScores(record.scores);
    if (!scores || typeof record.updatedAt !== "string") continue;
    const source =
      record.source === "diagnosis" || record.source === "estimated"
        ? (record.source as AdviceHistorySource)
        : undefined;
    entries.push({
      typeId: typeId as AdviceTypeId,
      scores,
      updatedAt: record.updatedAt,
      ...(source ? { source } : {}),
    });
  }
  return entries;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 中身が同じかどうかを見るための指紋。
 *
 * **`JSON.stringify` をそのまま比べない。** 鍵の並びは作った経路で変わるので、
 * 同じ中身でも字が違うことがある。中身が同じなのに違うと読むと、
 * **控えの時刻が書くたびに新しくなり**、MCP が書き戻した更新を
 * 拡張機能が「自分が書いたもの」と取り違える。
 */
export function adviceProfileFingerprint(profile: AdviceProfile): string {
  const base = profile.baseScores ?? profile.scores;
  const state = profile.state;
  const history = (profile.history ?? [])
    .map(
      (entry) =>
        `${entry.typeId}/${scoresText(entry.scores)}/${entry.updatedAt}/${entry.source ?? ""}`
    )
    .join(";");
  return [
    scoresText(profile.scores),
    scoresText(base),
    profile.answers.join(","),
    profile.updatedAt,
    state
      ? `${state.acceptance}/${state.confidence}/${state.updatedAt}/${state.lowStreak ?? 0}`
      : "",
    history,
  ].join("|");
}

function scoresText(scores: AdviceScores): string {
  return `${scores.reader},${scores.self},${scores.taste}`;
}
