import {
  RUN_MAX_BODY_CHARS,
  RUN_MAX_PER_HOUR,
  checkRunToken,
  countRecentRuns,
  describeIndexConfirm,
  describeRunConfirm,
  findRunFeature,
  isConfirmTooLate,
  isRunIndexFeature,
  isRunCoverFeature,
  isRunTestAiFeature,
  describeCoverConfirm,
  describeTestAiConfirm,
  describeExportConfirm,
  isRunExportFeature,
  runFeatureLabel,
  type RunExportFeature,
  type RunExportRow,
  RUN_TEST_AI_FEATURE,
  RUN_TEST_AI_LABEL,
  type RunTestAiRow,
  parseRunQuery,
  runCoverSideLabel,
  runRequestForLog,
  RUN_COVER_FEATURE,
  RUN_COVER_LABEL,
  RUN_INDEX_FEATURE,
  RUN_INDEX_LABEL,
  type RunCoverRow,
  type RunCoverSpec,
  type RunIndexRow,
  type RunDropped,
  type RunFailures,
  type RunFeatureDef,
  type RunResultBody,
  type RunStateKind,
  type RunHandledBy,
  type RunStateRecord,
  type RunTicket,
} from "../core/runRequest";
import { VECTOR_INDEX_VERSION } from "../core/vectorIndexFormat";
import type { PdfExportPlanLines } from "../core/pdfExportConfig";

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
  /**
   * 送る量を見積もる。**機能によって送る量が違う**（冒頭診断は第1話の冒頭だけ）
   * ので機能も渡す——作品全体の字数を確認に出すと、送る量の提示が嘘になる
   */
  measure(work: W, file: string | undefined, def?: RunFeatureDef): Promise<RunMeasure>;
  /**
   * モーダルで確かめる。ボタン（既定は「走らせる」）が押されたら true。
   * 表紙を焼く依頼だけ「焼く」にする——確認の文面が「「焼く」を押さずに」と言うため。
   *
   * `more` は［詳しく］で開く行（有料のAIのモデル名と料金の細かい断り。設計書7.1.1）。
   * 渡せば窓に［詳しく］のボタンが並び、押すと行を足した窓で訊き直す
   */
  confirm(
    message: string,
    detail: string,
    button?: string,
    more?: readonly string[]
  ): Promise<boolean>;
  run(def: RunFeatureDef, work: W, filePaths: string[]): Promise<RunOutcome>;
  /** 走らせている途中の例外を、理由と次の操作にする（`AIError.kind` ごと。規則5） */
  describeFailure(error: unknown): RunFailureView;
  warn(message: string): void;
  info(message: string): void;
  /** 記録へ1行（作品の場所・本文は入れない） */
  log(line: string): void;
  /** 索引づくり（`vectorIndex`）の手足。無ければ索引づくりは断る */
  index?: RunIndexDeps<W>;
  /** 表紙を焼く（`coverBake`）の手足。無ければ断る */
  cover?: RunCoverDeps<W>;
  /** AI接続確認（`testAI`）の手足。無ければ断る */
  testAi?: RunTestAiDeps;
  /** 書き出し（`exportPdf`・`exportEpub`）の手足。無ければ断る */
  export?: RunExportDeps<W>;
  /**
   * 依頼を受けた VS Code（`vscode.version`・`vscode.env.appRoot`）。書く記録すべてに添える。
   * 試験用の VS Code が `vscode://` の受け手に居座り、依頼が作者の知らない窓へ
   * 届いたことがある（2026-10-17）。無ければ添えない
   */
  handledBy?(): RunHandledBy;
}

/**
 * 書き出しの手足（2026-10-16 の棚卸しの10件目）。中身は［PDF出力］［EPUB出力］と
 * 同じ組み立てで、**訊く段・ブラウザを開く・フォルダーを開く知らせは通らない**
 * （渡す側は `features/runRequestRunners.ts`）。
 */
export interface RunExportDeps<W extends RunWork = RunWork> {
  /**
   * 書き出せるか（本文があるか）と、確認に出す話の数。**本文は読まない**。
   * PDF なら使う紙・向き・範囲も（前回の［PDF出力］の設定。作者の裁定 2026-10-16 夜の3）
   */
  inspect(
    work: W,
    feature: RunExportFeature
  ): Promise<
    | { ok: true; episodeCount: number; pdfPlan?: PdfExportPlanLines }
    | { ok: false; reason: string; nextAction?: string }
  >;
  /** 書き出す。作れたら結果の1行 */
  run(
    work: W,
    feature: RunExportFeature
  ): Promise<{ ok: true; row: RunExportRow } | { ok: false; reason: string; nextAction?: string }>;
}

/**
 * AI接続確認の手足（2026-10-16）。中身は［AI接続確認］コマンドと同じ2段
 * （接続 → 短い文を1回だけ生成）で、**コマンドは叩かない**（コマンドは結果を
 * 画面の知らせにしか出さず、返さない）。
 */
export interface RunTestAiDeps {
  /** 確かめるAI（AI設定で選んだAI。コマンドと同じ）。未設定なら undefined */
  resolve(): RunAi | undefined;
  /** 試す。**繋がらなかったのも答え**として返す（例外は仕組みごと落ちたときだけ） */
  run(): Promise<RunTestAiRow>;
}

/** 焼く前に分かること（確認に並べる） */
export type RunCoverInspect =
  | { ok: true; bookVertical: boolean; bakedExists: boolean; bakedRelative: string }
  | { ok: false; reason: string; nextAction?: string };

/**
 * 表紙を焼く手足（設計書6.65.9・6.87.22。2026-10-15）。
 *
 * **焼くのは EPUBエディターの画面の canvas**（［表紙を焼く］と同じ関数）。
 * ここは VS Code を知らないので、開く・焼かせる・待つは渡す側（`epubEditorPanel.ts`）。
 */
export interface RunCoverDeps<W extends RunWork = RunWork> {
  /** 焼けるか（元イラストの指定があるか・読めるか）と、確認に出すこと。**本文は読まない** */
  inspect(work: W, cover: RunCoverSpec): Promise<RunCoverInspect>;
  /** 焼く。焼けたら結果の1行 */
  bake(
    work: W,
    cover: RunCoverSpec
  ): Promise<{ ok: true; row: RunCoverRow } | { ok: false; reason: string; nextAction?: string }>;
}

/** 索引づくりの手足（設計書6.87.23。0.99.19） */
export interface RunIndexDeps<W extends RunWork = RunWork> {
  /** 意味検索（ベクトル検索）が「入」か */
  enabled(): boolean;
  /** 埋め込みのモデル（`novelai.vectorSearch.model`） */
  model(): string;
  /** 登録済みの全作品（`scope: "all"` のとき） */
  listWorks(): W[];
  /** 手元の Ollama で埋め込めるか（**回す前に1回だけ**） */
  check(): Promise<{ ok: true } | { ok: false; reason: string; nextAction?: string }>;
  /** 渡した作品を順に回す（進捗と中止は中で出す）。作品ごとの行を返す */
  build(works: W[]): Promise<RunIndexRow[]>;
}

/** 断ったときに作者へ出す見出し（知らせの頭をそろえる） */
const HEAD = "外部AIから頼まれた実行を受けませんでした。";

export async function handleRunRequest<W extends RunWork>(
  query: string,
  rawDeps: RunRequestHandlerDeps<W>
): Promise<void> {
  const deps = withHandledBy(rawDeps);
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
  // 索引づくり（`vectorIndex`）は白名簿とは別に通し、回数の上限のあとで分かれる
  const def = findRunFeature(ticket.feature);
  if (
    !def &&
    !isRunIndexFeature(ticket.feature) &&
    !isRunCoverFeature(ticket.feature) &&
    !isRunTestAiFeature(ticket.feature) &&
    !isRunExportFeature(ticket.feature)
  ) {
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

  /*
    表紙を焼く依頼も、回数の上限を通す（ほかの依頼と同じ作法）。AIも料金も無いが、
    確認のモーダルを作者の画面へ出させる回数であることに変わりはない
  */
  if (isRunCoverFeature(ticket.feature)) {
    await handleCoverRequest(ticket, work, deps, refuse, forLog);
    return;
  }

  // AI接続確認も回数の上限を通す（有料のAIなら、短い文1回ぶんでも料金がかかる）
  if (isRunTestAiFeature(ticket.feature)) {
    await handleTestAiRequest(ticket, work, deps, refuse, forLog);
    return;
  }

  // 書き出しも回数の上限を通す（表紙を焼くと同じ理由：確認のモーダルを出させる回数）
  if (isRunExportFeature(ticket.feature)) {
    await handleExportRequest(ticket, ticket.feature, work, deps, refuse, forLog);
    return;
  }

  if (!def) {
    // ここへ来るのは索引づくりだけ（上の白名簿の確かめで、ほかは断ってある）
    await handleIndexRequest(ticket, work, deps, refuse, forLog);
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

  /*
    **判定に別のAIを使う機能（事実の照合）は、判定のAIも先に引く。** 片方だけ
    見せて走らせると、判定の段で有料のAIへ本文の抜粋が出ることを作者が知らない。
    引き方は同じ受け口（`resolveAi`）に、割当の鍵だけ差し替えて渡す
  */
  let verifier: RunAi | undefined;
  if (def.verifyAssigned) {
    verifier = deps.resolveAi({ ...def, assigned: def.verifyAssigned, verifyAssigned: undefined });
    if (!verifier) {
      await refuse(
        `「${def.label}」の判定に使うAI（矛盾検知の割当）がまだ設定されていません。`,
        "AI設定（または機能別AI割当）で使うAIを選んでください"
      );
      return;
    }
  }

  const measured = await deps.measure(work, ticket.file, def);
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
    // **有料の断りは画面の確認と同じ3行**（`describeRunConfirm` が
    // `core/paidUsageNotice.ts` で組む）。判定のAIだけが有料でも出す
    def,
    ...(verifier
      ? { verifier: { providerName: verifier.providerName, model: verifier.model, paid: verifier.paid } }
      : {}),
  });
  const accepted = await deps.confirm(confirm.message, confirm.detail, undefined, confirm.more);
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
    ...(verifier
      ? {
          verifyProvider: { id: verifier.providerId, name: verifier.providerName, paid: verifier.paid },
          verifyModel: verifier.model,
        }
      : {}),
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

/**
 * 索引づくりの依頼（設計書6.87.23）。合言葉・1回限り・登録・許可・回数の上限は
 * 呼ぶ側で通してある。
 *
 * **全作品のときも、作品ごとに許可を確かめる。** 許可の無い作品は回さず、
 * 結果に `skipped` と理由で並べる（`schedule.milestones` と同じ作法）。
 * **確認の前に本文を読まない**——作品の題と数だけを見せる。
 */
async function handleIndexRequest<W extends RunWork>(
  ticket: RunTicket,
  work: W,
  deps: RunRequestHandlerDeps<W>,
  refuse: (reason: string, nextAction?: string) => Promise<void>,
  forLog: string
): Promise<void> {
  const index = deps.index;
  if (!index) {
    await refuse("この拡張機能では、外から索引づくりを頼めません。");
    return;
  }
  if (!index.enabled()) {
    await refuse(
      "意味検索（ベクトル検索）が「切」になっています。",
      "設定管理の「ベクトル検索準備」で準備してから頼んでください"
    );
    return;
  }

  const candidates = ticket.scope === "all" ? index.listWorks() : [work];
  const targets: W[] = [];
  const skipped: RunIndexRow[] = [];
  for (const candidate of candidates) {
    if (await deps.isAllowed(candidate, ticket.client)) {
      targets.push(candidate);
    } else {
      skipped.push({
        workTitle: candidate.title,
        folder: candidate.folderPath,
        status: "skipped",
        seconds: 0,
        reason:
          "この作品では外部AIからの実行の依頼（run.request）が許可されていません" +
          "（作品管理 → 作品別設定 → 外部AI許可／取消）",
      });
    }
  }
  if (targets.length === 0) {
    await refuse("索引を作ってよい作品がありません（どの作品にも外部AIの許可がありません）。");
    return;
  }

  const check = await index.check();
  if (!check.ok) {
    await refuse(check.reason, check.nextAction);
    return;
  }

  const model = index.model();
  const confirm = describeIndexConfirm({
    ticket,
    works: targets.map((target) => ({ title: target.title })),
    skipped: skipped.map((row) => ({ title: row.workTitle, reason: "許可が無い" })),
    model,
  });
  if (!(await deps.confirm(confirm.message, confirm.detail))) {
    await deps.writeState(stateOf(ticket, "declined", deps.now()));
    deps.log(`作者が断りました：${forLog}`);
    return;
  }

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

  let rows: RunIndexRow[];
  try {
    rows = await index.build(targets);
  } catch (error) {
    // 作品ごとの失敗は build の中で受け止める。ここへ来るのは仕組みごと落ちたとき
    const failure = deps.describeFailure(error);
    await deps.writeState(stateOf(ticket, "failed", deps.now(), { startedAt, ...failure }));
    deps.log(`外部AIから頼まれた索引づくりに失敗しました：${forLog}：${failure.reason}`);
    deps.warn(`外部AIから頼まれた索引づくりに失敗しました：${failure.reason}`);
    return;
  }

  const all = [...rows, ...skipped];
  const failed = all.filter((row) => row.status === "failed");
  const cancelled = all.filter((row) => row.status === "cancelled");
  const result: RunResultBody = {
    feature: RUN_INDEX_FEATURE,
    featureLabel: RUN_INDEX_LABEL,
    workTitle: ticket.scope === "all" ? `全作品（${candidates.length}作品）` : work.title,
    target: null,
    provider: { id: "ollama", name: "Ollama（手元・無料）", paid: false },
    model,
    promptVersion: `vector-index-v${VECTOR_INDEX_VERSION}`,
    findings: all,
    dropped: { count: 0, notes: [] },
    failures: {
      count: failed.length,
      notes: [
        ...failed.map((row) => `${row.workTitle}：${row.reason ?? "理由不明"}`),
        ...(cancelled.length > 0 ? [`作者が途中で止めました（${cancelled.length}作品）`] : []),
      ],
    },
    // 本文は外へ送っていない（手元の Ollama だけ）
    bodyChars: 0,
    startedAt,
    finishedAt: new Date(deps.now()).toISOString(),
  };
  await deps.writeState(stateOf(ticket, "done", deps.now(), { startedAt, result }));
  const done = all.filter((row) => row.status === "done").length;
  deps.log(
    `外部AIから頼まれた索引づくりを終えました：${forLog}（できた ${done}・失敗 ${failed.length}・中止 ${cancelled.length}・飛ばした ${skipped.length}）`
  );
  deps.info(
    `外部AIから頼まれた索引づくりを終えました（できた ${done}作品` +
      (failed.length ? `・失敗 ${failed.length}作品` : "") +
      (cancelled.length ? `・中止 ${cancelled.length}作品` : "") +
      "）。原稿・設定資料は変わっていません。"
  );
}

/**
 * 表紙を焼く依頼（設計書6.65.9・6.87.22。2026-10-15）。合言葉・1回限り・登録・許可・
 * 回数の上限は呼ぶ側で通してある。
 *
 * **確認の前に、焼けるかを確かめる**（元イラストの指定が無いと、画面は黙って何も
 * 焼かない）。焼けない理由は確認を出さずに返す——押させてから「焼けません」と
 * 言うより、作者の手間が少ない。
 */
async function handleCoverRequest<W extends RunWork>(
  ticket: RunTicket,
  work: W,
  deps: RunRequestHandlerDeps<W>,
  refuse: (reason: string, nextAction?: string) => Promise<void>,
  forLog: string
): Promise<void> {
  const coverDeps = deps.cover;
  if (!coverDeps) {
    await refuse("この拡張機能では、外から表紙を焼く依頼を受けられません。");
    return;
  }
  const cover = ticket.cover;
  if (!cover) {
    // 札を読むときに断っているので来ないはず。来たら黙って既定の体裁で焼かない
    await refuse("どの面をどの体裁で焼くか（cover）が依頼に入っていません。");
    return;
  }

  const inspected = await coverDeps.inspect(work, cover);
  if (!inspected.ok) {
    await refuse(inspected.reason, inspected.nextAction);
    return;
  }

  const confirm = describeCoverConfirm({
    ticket,
    cover,
    workTitle: work.title,
    bookVertical: inspected.bookVertical,
    bakedExists: inspected.bakedExists,
    bakedRelative: inspected.bakedRelative,
  });
  if (!(await deps.confirm(confirm.message, confirm.detail, "焼く"))) {
    await deps.writeState(stateOf(ticket, "declined", deps.now()));
    deps.log(`作者が断りました：${forLog}`);
    return;
  }

  const pressedAt = deps.now();
  if (isConfirmTooLate(ticket, pressedAt)) {
    const reason = "確認が出てから時間が経ちすぎたため、焼きませんでした。";
    await deps.writeState(stateOf(ticket, "expired", pressedAt, { reason }));
    deps.log(`外部AIからの実行の依頼が期限切れでした：${forLog}`);
    deps.info(`${reason}必要なら、頼んだ側にもう一度頼んでもらってください。`);
    return;
  }

  const startedAt = new Date(pressedAt).toISOString();
  await deps.writeState(stateOf(ticket, "running", pressedAt, { startedAt }));

  const side = runCoverSideLabel(cover.side);
  let baked: Awaited<ReturnType<RunCoverDeps<W>["bake"]>>;
  try {
    baked = await coverDeps.bake(work, cover);
  } catch (error) {
    const failure = deps.describeFailure(error);
    baked = { ok: false, reason: failure.reason, nextAction: failure.nextAction };
  }
  if (!baked.ok) {
    await deps.writeState(
      stateOf(ticket, "failed", deps.now(), {
        startedAt,
        reason: baked.reason,
        nextAction: baked.nextAction,
      })
    );
    deps.log(`外部AIから頼まれた${side}を焼けませんでした：${forLog}：${baked.reason}`);
    deps.warn(`外部AIから頼まれた${side}を焼けませんでした：${baked.reason}`);
    return;
  }

  const result: RunResultBody = {
    feature: RUN_COVER_FEATURE,
    featureLabel: RUN_COVER_LABEL,
    workTitle: work.title,
    target: null,
    // AIは呼ばない。**呼んでいないことを結果の形で言う**（測る道としての約束の欄は埋める）
    provider: { id: "none", name: "AIを呼びません（EPUBエディターの canvas で焼く）", paid: false },
    model: "",
    promptVersion: "cover-bake-v1",
    findings: [baked.row],
    dropped: { count: 0, notes: [] },
    failures: { count: 0, notes: [] },
    // 本文は読みも送りもしない
    bodyChars: 0,
    startedAt,
    finishedAt: new Date(deps.now()).toISOString(),
  };
  await deps.writeState(stateOf(ticket, "done", deps.now(), { startedAt, result }));
  deps.log(`外部AIから頼まれた${side}を焼きました：${forLog}`);
  // 焼いたことの知らせは EPUBエディターの［表紙を焼く］と同じ道が出す（重ねて出さない）
}

/**
 * AI接続確認の依頼（2026-10-16 の棚卸しの6件目）。合言葉・1回限り・登録・許可・
 * 回数の上限は呼ぶ側で通してある。
 *
 * **本文は量らない・送らない**（送るのは「はい」と答えさせる短い文1回だけ）。
 * **繋がらなかったのは「確かめた答え」なので `done`**——`failed` にすると、
 * 頼んだ側は「確かめる仕組みが失敗した」と読み、作者のAIの状態が伝わらない。
 */
async function handleTestAiRequest<W extends RunWork>(
  ticket: RunTicket,
  work: W,
  deps: RunRequestHandlerDeps<W>,
  refuse: (reason: string, nextAction?: string) => Promise<void>,
  forLog: string
): Promise<void> {
  const testAi = deps.testAi;
  if (!testAi) {
    await refuse("この拡張機能では、外からAI接続確認を頼めません。");
    return;
  }
  const ai = testAi.resolve();
  if (!ai) {
    await refuse("AIがまだ設定されていません。", "「AI設定」から使うAIを選んでください");
    return;
  }

  const confirm = describeTestAiConfirm({
    ticket,
    workTitle: work.title,
    providerName: ai.providerName,
    model: ai.model,
    paid: ai.paid,
  });
  if (!(await deps.confirm(confirm.message, confirm.detail, undefined, confirm.more))) {
    await deps.writeState(stateOf(ticket, "declined", deps.now()));
    deps.log(`作者が断りました：${forLog}`);
    return;
  }

  const pressedAt = deps.now();
  if (isConfirmTooLate(ticket, pressedAt)) {
    const reason = "確認が出てから時間が経ちすぎたため、試しませんでした。";
    await deps.writeState(stateOf(ticket, "expired", pressedAt, { reason }));
    deps.log(`外部AIからの実行の依頼が期限切れでした：${forLog}`);
    deps.info(`${reason}必要なら、頼んだ側にもう一度頼んでもらってください。`);
    return;
  }

  const startedAt = new Date(pressedAt).toISOString();
  await deps.writeState(stateOf(ticket, "running", pressedAt, { startedAt }));

  let row: RunTestAiRow;
  try {
    row = await testAi.run();
  } catch (error) {
    // 繋がらないことは run の中で答えにしている。ここへ来るのは仕組みごと落ちたとき
    const failure = deps.describeFailure(error);
    await deps.writeState(stateOf(ticket, "failed", deps.now(), { startedAt, ...failure }));
    deps.log(`外部AIから頼まれたAI接続確認に失敗しました：${forLog}：${failure.reason}`);
    deps.warn(`外部AIから頼まれたAI接続確認に失敗しました：${failure.reason}`);
    return;
  }

  const result: RunResultBody = {
    feature: RUN_TEST_AI_FEATURE,
    featureLabel: RUN_TEST_AI_LABEL,
    workTitle: work.title,
    target: null,
    provider: { id: ai.providerId, name: ai.providerName, paid: ai.paid },
    model: ai.model,
    promptVersion: "test-ai-v1",
    findings: [row],
    dropped: { count: 0, notes: [] },
    failures: { count: 0, notes: [] },
    // 本文は送らない（短い確かめの文だけ）
    bodyChars: 0,
    startedAt,
    finishedAt: new Date(deps.now()).toISOString(),
  };
  await deps.writeState(stateOf(ticket, "done", deps.now(), { startedAt, result }));
  deps.log(`外部AIから頼まれたAI接続確認を終えました：${forLog}（${row.ok ? "通った" : `止まった：${row.stage}`}）`);
  /*
    作者の画面にも結果を出す。**繋がらなかったときは警告にする**——作者のAIが
    いま動かないことは、頼んだ側より先に作者が知るべきことである
  */
  if (row.ok) {
    deps.info(`外部AIから頼まれたAI接続確認：${row.message}`);
  } else {
    deps.warn(
      `外部AIから頼まれたAI接続確認：${row.message}` + (row.nextAction ? `（${row.nextAction}）` : "")
    );
  }
}

/**
 * 書き出しの依頼（2026-10-16 の棚卸しの10件目）。合言葉・1回限り・登録・許可・
 * 回数の上限は呼ぶ側で通してある。
 *
 * **新しいファイルを作るだけ**なので、作者の裁定3のとおり毎回確かめてから作る。
 * 本文が無い作品は確認を出さずに断る（押させてから「作れません」と言うより手間が少ない）。
 */
async function handleExportRequest<W extends RunWork>(
  ticket: RunTicket,
  feature: RunExportFeature,
  work: W,
  deps: RunRequestHandlerDeps<W>,
  refuse: (reason: string, nextAction?: string) => Promise<void>,
  forLog: string
): Promise<void> {
  const exporter = deps.export;
  if (!exporter) {
    await refuse("この拡張機能では、外から書き出しを頼めません。");
    return;
  }
  const label = runFeatureLabel(feature) ?? feature;

  const inspected = await exporter.inspect(work, feature);
  if (!inspected.ok) {
    await refuse(inspected.reason, inspected.nextAction);
    return;
  }

  const confirm = describeExportConfirm({
    ticket,
    workTitle: work.title,
    episodeCount: inspected.episodeCount,
    pdfPlan: inspected.pdfPlan,
  });
  if (!(await deps.confirm(confirm.message, confirm.detail, "作る"))) {
    await deps.writeState(stateOf(ticket, "declined", deps.now()));
    deps.log(`作者が断りました：${forLog}`);
    return;
  }

  const pressedAt = deps.now();
  if (isConfirmTooLate(ticket, pressedAt)) {
    const reason = "確認が出てから時間が経ちすぎたため、作りませんでした。";
    await deps.writeState(stateOf(ticket, "expired", pressedAt, { reason }));
    deps.log(`外部AIからの実行の依頼が期限切れでした：${forLog}`);
    deps.info(`${reason}必要なら、頼んだ側にもう一度頼んでもらってください。`);
    return;
  }

  const startedAt = new Date(pressedAt).toISOString();
  await deps.writeState(stateOf(ticket, "running", pressedAt, { startedAt }));

  let made: Awaited<ReturnType<RunExportDeps<W>["run"]>>;
  try {
    made = await exporter.run(work, feature);
  } catch (error) {
    const failure = deps.describeFailure(error);
    made = { ok: false, reason: failure.reason, nextAction: failure.nextAction };
  }
  if (!made.ok) {
    await deps.writeState(
      stateOf(ticket, "failed", deps.now(), {
        startedAt,
        reason: made.reason,
        nextAction: made.nextAction,
      })
    );
    deps.log(`外部AIから頼まれた${label}ができませんでした：${forLog}：${made.reason}`);
    deps.warn(`外部AIから頼まれた${label}ができませんでした：${made.reason}`);
    return;
  }

  const result: RunResultBody = {
    feature,
    featureLabel: label,
    workTitle: work.title,
    target: null,
    // AIは呼ばない。**呼んでいないことを結果の形で言う**（表紙を焼くと同じ）
    provider: { id: "none", name: "AIを呼びません（書き出し）", paid: false },
    model: "",
    promptVersion: `${feature}-v1`,
    findings: [made.row],
    dropped: { count: 0, notes: [] },
    failures: {
      count: made.row.conflicted.length,
      notes: made.row.conflicted.length
        ? [`未解決の競合で外した話 ${made.row.conflicted.length}件`]
        : [],
    },
    // 本文はどこへも送らない
    bodyChars: 0,
    startedAt,
    finishedAt: new Date(deps.now()).toISOString(),
  };
  await deps.writeState(stateOf(ticket, "done", deps.now(), { startedAt, result }));
  deps.log(`外部AIから頼まれた${label}を終えました：${forLog}`);
  // 作者の画面にも一言（どこに作ったか）。フォルダーを開くボタンは出さない（返事を待たない）
  deps.info(`外部AIから頼まれた${label}で、${made.row.filePath} を作りました。原稿は変わっていません。`);
}

/**
 * 書く記録すべてに、受けた VS Code を添える。`stateOf` を呼ぶ所（25か所）を1つずつ
 * 直すと付け忘れが出るので、書く口（`claim`・`writeState`）の側で1回だけ包む
 */
function withHandledBy<W extends RunWork>(deps: RunRequestHandlerDeps<W>): RunRequestHandlerDeps<W> {
  const host = deps.handledBy;
  if (!host) return deps;
  const stamp = (state: RunStateRecord): RunStateRecord => ({ ...state, handledBy: host() });
  return {
    ...deps,
    claim: (state) => deps.claim(stamp(state)),
    writeState: (state) => deps.writeState(stamp(state)),
  };
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
