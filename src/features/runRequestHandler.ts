import {
  RUN_MAX_BODY_CHARS,
  RUN_MAX_PER_HOUR,
  checkRunToken,
  countRecentRuns,
  describeRunConfirm,
  findRunFeature,
  isConfirmTooLate,
  parseRunQuery,
  runRequestForLog,
  type RunDropped,
  type RunFailures,
  type RunFeatureDef,
  type RunResultBody,
  type RunStateKind,
  type RunStateRecord,
  type RunTicket,
} from "../core/runRequest";
import { paidUsageLines } from "../core/paidUsageNotice";

/**
 * 外部AIから頼まれた実行を受ける（設計書6.87.22）。
 *
 * 受け口（`vscode://nonahisa.novel-ai-assistant/run?id=…&token=…`）に届いた依頼を、
 * **合言葉 → 1回限り → 白名簿 → 登録済みの作品 → 外部AIの許可 → 回数の上限 →
 * AIの割当 → 送る量** の順に確かめ、**毎回作者に確認を出してから**走らせる。
 *
 * - **合言葉が合わない依頼は、確認も出さずに断る。** `vscode://` はウェブページの
 *   リンク1つでも開かせられる。札（MCP が保管庫に置いたもの）と合わない依頼は、
 *   誰が作ったか分からない
 * - **「今後は確認しない」は置かない。** 本文が作者のAI（クラウドのこともある）へ出る
 * - **原稿を書き換える道は1つも無い。** 走らせる機能は白名簿（読み取りと生成）だけで、
 *   結果は保管庫へ書くだけ。提案パネルにも流さない
 *
 * 画面と保管庫と機能の実行は外から渡す（VS Code を知らずに試せるように）。
 * 渡す側は `features/runRequestRunners.ts`。
 */

/** 受け口から見た作品（登録簿の1件のうち、ここで使うところだけ） */
export interface RunWork {
  id: string;
  title: string;
  folderPath: string;
}

/** 機能別AI割当で決まったAI（**鍵は持たない**） */
export interface RunAi {
  providerId: string;
  providerName: string;
  model: string;
  paid: boolean;
}

/** 送る量の見込み。読めなければ理由 */
export type RunMeasure =
  | { ok: true; bodyChars: number; episodeCount: number; filePaths: string[]; targetLabel: string }
  | { ok: false; reason: string; nextAction?: string };

/** 機能を走らせた結果（検算済み）。落ちた回は理由 */
export type RunOutcome =
  | {
      ok: true;
      promptVersion: string;
      findings: unknown[];
      dropped: RunDropped;
      failures: RunFailures;
      cancelled: boolean;
    }
  | { ok: false; reason: string; nextAction?: string; errorKind?: string };

export interface RunFailureView {
  reason: string;
  nextAction?: string;
  errorKind?: string;
}

export interface RunRequestHandlerDeps<W extends RunWork = RunWork> {
  /** ブラウザ版か（`vscode://` が届かず、MCP サーバーも無い。設計書5.8） */
  isWeb(): boolean;
  now(): number;
  /** 合言葉のハッシュ（`core/hash.ts` の `sha256Text`） */
  hash(text: string): string;
  readTicket(id: string): Promise<RunTicket | undefined>;
  /**
   * 状態を**新しく作る**。既にあれば false（＝合言葉はもう使われた）。
   * **最初に作れた1回だけが依頼を受ける**——ここが「1回限り」の錠である
   */
  claim(state: RunStateRecord): Promise<boolean>;
  /** 状態を書き直す（作った後の更新） */
  writeState(state: RunStateRecord): Promise<void>;
  listStates(): Promise<RunStateRecord[]>;
  findWork(folder: string): W | undefined;
  /** その作品で、その接続元に `run.request` を許しているか（6.87.14） */
  isAllowed(work: W, client: string): Promise<boolean>;
  /** 機能別AI割当で、その機能に使うAI。未設定なら undefined */
  resolveAi(def: RunFeatureDef): RunAi | undefined;
  measure(work: W, file: string | undefined): Promise<RunMeasure>;
  /** モーダルで確かめる。「走らせる」が押されたら true */
  confirm(message: string, detail: string): Promise<boolean>;
  run(def: RunFeatureDef, work: W, filePaths: string[]): Promise<RunOutcome>;
  /** 走らせている途中の例外を、理由と次の操作にする（`AIError.kind` ごと。規則5） */
  describeFailure(error: unknown): RunFailureView;
  warn(message: string): void;
  info(message: string): void;
  /** 記録へ1行（作品の場所・本文は入れない） */
  log(line: string): void;
}

/** 断ったときに作者へ出す見出し（知らせの頭をそろえる） */
const HEAD = "外部AIから頼まれた実行を受けませんでした。";

export async function handleRunRequest<W extends RunWork>(
  query: string,
  deps: RunRequestHandlerDeps<W>
): Promise<void> {
  /*
    **ブラウザ版では受けない**（規則7、設計書5.8）。`vscode://` がそもそも届かず、
    MCP サーバーも無いので、ここへ来るのは誰かが手で開かせたときだけである。
    黙らずに理由を出す
  */
  if (deps.isWeb()) {
    deps.log("外部AIからの実行の依頼を断りました：ブラウザ版の VS Code では受けません");
    deps.warn(
      `${HEAD}ブラウザ版の VS Code では、外部AIからの実行の依頼を受けられません` +
        "（依頼の仕組み〔vscode:// の呼び出しと MCP サーバー〕が、手元の VS Code にしか無いためです）。"
    );
    return;
  }

  const parsed = parseRunQuery(query);
  if (!parsed.ok) {
    deps.log(`外部AIからの実行の依頼を断りました：${parsed.reason}`);
    deps.warn(`${HEAD}${parsed.reason}`);
    return;
  }

  const ticket = await deps.readTicket(parsed.id);
  if (!ticket) {
    // 札が無い＝MCP サーバーが作った依頼ではない。**確認は出さない**
    deps.log(`外部AIからの実行の依頼を断りました：札の無い依頼番号（${parsed.id}）`);
    deps.warn(`${HEAD}出どころの分からない依頼です（MCP サーバーが作った依頼ではありません）。`);
    return;
  }

  const now = deps.now();
  const token = checkRunToken(ticket, parsed.token, now, deps.hash);
  if (!token.ok) {
    if (token.kind === "late") {
      /*
        合言葉は合っているが遅すぎる。**頼んだ本人には「期限切れ」と返したい**ので
        状態を作る（作れなければ、もう誰かが受けている）
      */
      await deps.claim(stateOf(ticket, "expired", now, { reason: token.reason }));
    }
    // 合わない合言葉では札の状態に触れない——依頼番号だけ当てた誰かに、正しい依頼を潰させない
    deps.log(`外部AIからの実行の依頼を断りました：${token.reason}（${ticket.id}）`);
    deps.warn(`${HEAD}${token.reason}`);
    return;
  }

  // **1回限り。** 最初に状態を作れた1回だけが受ける（同じ URI を2度開かれても走らない）
  if (!(await deps.claim(stateOf(ticket, "confirming", now)))) {
    deps.log(`外部AIからの実行の依頼を断りました：使用済みの合言葉（${ticket.id}）`);
    deps.warn(`${HEAD}この依頼はもう受けています（依頼の合言葉は1回しか使えません）。`);
    return;
  }

  const forLog = runRequestForLog(ticket);
  deps.log(`外部AIからの実行の依頼を受けました：${forLog}`);

  const refuse = async (reason: string, nextAction?: string): Promise<void> => {
    await deps.writeState(stateOf(ticket, "refused", deps.now(), { reason, nextAction }));
    deps.log(`外部AIからの実行の依頼を断りました：${forLog}：${reason}`);
    deps.warn(`${HEAD}${reason}${nextAction ? `（${nextAction}）` : ""}`);
  };

  // **白名簿の外は、確認も出さずに断る**（本文への適用・資料の保存などは入れない）
  const def = findRunFeature(ticket.feature);
  if (!def) {
    await refuse("この機能は外から頼めません（頼めるのは読み取りと生成だけです）。");
    return;
  }

  const work = deps.findWork(ticket.folder);
  if (!work) {
    await refuse(
      "登録されていない作品です。",
      "作品を登録してから、外部AIの許可を決めてください"
    );
    return;
  }

  /*
    **外部AIの許可が無い作品は断る**（6.87.10・6.87.14）。MCP の門番も確かめているが、
    ここでも見る——札を書けるのは MCP だけだが、許可を**書ける**のは拡張機能だけで、
    判断の元になる印を読むのはここが最後である（札を置いたあとで取り消されたかもしれない）
  */
  if (!(await deps.isAllowed(work, ticket.client))) {
    await refuse(
      "この作品では、外部AIからの実行の依頼（run.request）が許可されていません。",
      "詳細メニューの「作品管理 → 作品別設定 → 外部AI許可／取消」で決めてください"
    );
    return;
  }

  /*
    **続けて頼める回数の上限**（連打で料金がかさむのを防ぐ）。数えるのは作者が
    「走らせる」を押した回だけ——断った依頼まで数えると、断るほど頼めなくなる
  */
  const recent = countRecentRuns(await deps.listStates(), now);
  if (recent >= RUN_MAX_PER_HOUR) {
    await refuse(
      `この1時間に ${recent} 回走らせています（上限は1時間に ${RUN_MAX_PER_HOUR} 回）。`,
      "時間を置いてから頼んでください"
    );
    return;
  }

  const ai = deps.resolveAi(def);
  if (!ai) {
    await refuse(
      `「${def.label}」に使うAIがまだ設定されていません。`,
      "AI設定（または機能別AI割当）で使うAIを選んでください"
    );
    return;
  }

  const measured = await deps.measure(work, ticket.file);
  if (!measured.ok) {
    await refuse(measured.reason, measured.nextAction);
    return;
  }
  if (measured.bodyChars > RUN_MAX_BODY_CHARS) {
    await refuse(
      `本文が約${measured.bodyChars.toLocaleString("ja-JP")}字あり、1回の依頼の上限` +
        `（${RUN_MAX_BODY_CHARS.toLocaleString("ja-JP")}字）を超えます。`,
      "話を指定して（file）頼み直してください"
    );
    return;
  }

  const confirm = describeRunConfirm({
    ticket,
    featureLabel: def.label,
    workTitle: work.title,
    targetLabel: measured.targetLabel,
    providerName: ai.providerName,
    model: ai.model,
    paid: ai.paid,
    bodyChars: measured.bodyChars,
    episodeCount: measured.episodeCount,
    // **有料の断りは画面の確認と同じ行**（`confirmPaidUsage` と同じ部品）
    paidLines: ai.paid ? paidUsageLines(ai.providerName, ai.model) : [],
  });
  const accepted = await deps.confirm(confirm.message, confirm.detail);
  if (!accepted) {
    await deps.writeState(stateOf(ticket, "declined", deps.now()));
    deps.log(`作者が断りました：${forLog}`);
    return;
  }

  /*
    **確認が出たまま長く置かれた依頼は走らせない**（依頼から30分）。頼んだ側は
    とうに諦めているかもしれず、作品もその間に書き進んでいる
  */
  const pressedAt = deps.now();
  if (isConfirmTooLate(ticket, pressedAt)) {
    const reason = "確認が出てから時間が経ちすぎたため、走らせませんでした。";
    await deps.writeState(stateOf(ticket, "expired", pressedAt, { reason }));
    deps.log(`外部AIからの実行の依頼が期限切れでした：${forLog}`);
    deps.info(`${reason}必要なら、頼んだ側にもう一度頼んでもらってください。`);
    return;
  }

  const startedAt = new Date(pressedAt).toISOString();
  await deps.writeState(stateOf(ticket, "running", pressedAt, { startedAt }));

  let outcome: RunOutcome;
  try {
    outcome = await deps.run(def, work, measured.filePaths);
  } catch (error) {
    // **落ちずに書き残す。** 受け口は他の合図（読者の反応など）も受けている
    const failure = deps.describeFailure(error);
    await deps.writeState(
      stateOf(ticket, "failed", deps.now(), { startedAt, ...failure })
    );
    deps.log(`外部AIから頼まれた実行に失敗しました：${forLog}：${failure.reason}`);
    deps.warn(
      `外部AIから頼まれた「${def.label}」に失敗しました：${failure.reason}` +
        (failure.nextAction ? `（${failure.nextAction}）` : "")
    );
    return;
  }

  if (!outcome.ok) {
    await deps.writeState(
      stateOf(ticket, "failed", deps.now(), {
        startedAt,
        reason: outcome.reason,
        nextAction: outcome.nextAction,
        errorKind: outcome.errorKind,
      })
    );
    deps.log(`外部AIから頼まれた実行が走りませんでした：${forLog}：${outcome.reason}`);
    return;
  }

  if (outcome.cancelled) {
    await deps.writeState(
      stateOf(ticket, "declined", deps.now(), {
        startedAt,
        reason: "作者が実行の途中で止めました。",
      })
    );
    deps.log(`作者が途中で止めました：${forLog}`);
    return;
  }

  const result: RunResultBody = {
    feature: def.feature,
    featureLabel: def.label,
    workTitle: work.title,
    target: ticket.file ?? null,
    provider: { id: ai.providerId, name: ai.providerName, paid: ai.paid },
    model: ai.model,
    promptVersion: outcome.promptVersion,
    findings: outcome.findings,
    dropped: outcome.dropped,
    failures: outcome.failures,
    bodyChars: measured.bodyChars,
    startedAt,
    finishedAt: new Date(deps.now()).toISOString(),
  };
  await deps.writeState(stateOf(ticket, "done", deps.now(), { startedAt, result }));
  deps.log(`外部AIから頼まれた実行を終えました：${forLog}（${outcome.findings.length}件）`);
  deps.info(
    `外部AIから頼まれた「${def.label}」を終えました（${outcome.findings.length}件）。` +
      "結果は頼んだ側が読みます。原稿・設定資料・提案パネルは変わっていません。"
  );
}

function stateOf(
  ticket: RunTicket,
  state: RunStateKind,
  now: number,
  extra: Partial<Omit<RunStateRecord, "version" | "id" | "state" | "at">> = {}
): RunStateRecord {
  const record: RunStateRecord = {
    version: 1,
    id: ticket.id,
    state,
    at: new Date(now).toISOString(),
  };
  // undefined の項目は書かない（ファイルを読む側が「無い」と「空」を見分けられるように）
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) (record as unknown as Record<string, unknown>)[key] = value;
  }
  return record;
}
