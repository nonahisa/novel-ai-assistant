import {
  PROCEDURES,
  type Procedure,
  type ProcedureActionLookup,
} from "./procedures";

/**
 * 画面で指しながら案内する——その「いまどこか」の判断（設計書6.104）。
 *
 * ## なぜ `core` に置くのか
 *
 * 手順書き（`procedures.ts`）は、相談へ渡す**文字**にしかなっていなかった。
 * 足りないのは「画面で示す」ところだけである。示す側（サイドバーを光らせる・
 * コマンドを起こす）は VS Code の仕事なので `features` に置くが、
 * **いまどの段にいて、押されたら進むのか留まるのか**という判断はここに置く。
 *
 * 理由は2つある。**外（MCP・テスト）から同じ判断を呼べること**（第3段で
 * MCP の口を足すときに、判断まで書き直したくない）と、**`vscode` を
 * 持ち込まないこと**（`mcpReach.test.ts` が見張っている）である。
 *
 * ## 手順をここで考え出さない
 *
 * 並べるのは `PROCEDURES` にある道だけ。段の文（`why`・`check`）も
 * そのまま使い、案内用に書き直さない——**画面のどこにも無い手順を
 * 案内すると、作者は探しても見つけられない**（`procedures.ts` の決まりを
 * そのまま引き継ぐ）。
 *
 * ## 進むのは前へだけ（この実装で決めた振る舞い）
 *
 * 案内の途中で作者が別のことをしても壊れないように、次のように決めた。
 *
 * | 押されたもの | どうするか | なぜ |
 * |---|---|---|
 * | いまの段の操作 | 次の段へ進む | 素直な道 |
 * | **先の段**の操作 | **そこまで飛ばして進む** | 作者が順路を知っていて先へ行った。留めると、案内だけが後ろに取り残される |
 * | **済んだ段**の操作 | **動かさない** | やり直しであって寄り道ではない。戻すと、2回押すだけで案内が後戻りする |
 * | 手順に無い操作 | **動かさない。案内も消さない** | 寄り道はふつうに起きる。消すと「どこまでやったか」を失う |
 *
 * **案内が消えるのは、最後まで進んだときと、作者が「やめる」を押したとき
 * だけである。** 押した回数（`strayCount`）は数えておくが、それで勝手に
 * 畳んだりはしない——数えるのは、あとで「案内は役に立ったのか」を
 * 見るためである。
 */

/** 案内の1段。**名前まで解いてある**（コマンドIDだけの手順書きとの違い） */
export interface TourStep {
  /** 押す操作のコマンドID */
  readonly command: string;
  /** 画面に出ている操作の名前（`ACTION_TREE` から引いたもの） */
  readonly label: string;
  /** 名前から外した括弧の補足。無ければ持たない */
  readonly note?: string;
  /** 何をするか（`ProcedureStep.why`） */
  readonly why: string;
  /** 次へ進む前に何を見るか（`ProcedureStep.check`） */
  readonly check: string;
  /** 「先に◯◯が要ります。」の一行。無ければ持たない */
  readonly prerequisiteNote?: string;
}

/** 案内のいまの状態。**作り直して差し替える**（途中で書き換えない） */
export interface TourState {
  /** もとの手順書きの鍵 */
  readonly key: string;
  /** 題 */
  readonly title: string;
  readonly steps: readonly TourStep[];
  /**
   * いま案内している段の位置（0から）。
   *
   * **最後まで進むと `steps.length` になる。** そのときだけ
   * `currentStep` が undefined を返すので、終わったかどうかは
   * ここ1か所で決まる。
   */
  readonly index: number;
  /** 手順に無い操作を押した回数。案内は消さないが、数えておく */
  readonly strayCount: number;
}

/** 押された操作をどう扱ったか */
export type TourObservation =
  /** 動かさなかった（手順に無い／済んだ段のやり直し） */
  | { readonly kind: "ignored"; readonly state: TourState }
  /** 次の段へ進んだ。飛ばして進んだ場合も含む */
  | { readonly kind: "advanced"; readonly state: TourState }
  /** 最後の段を押し終えた */
  | { readonly kind: "finished"; readonly state: TourState };

/**
 * 手順書きを、案内できる形へ組む。
 *
 * 名前を引けなかった段は**落として先へ進む**（`renderProcedure` と同じ
 * 考え方）。この環境の画面に出ない操作まで案内すると、作者は探しても
 * 見つけられない。**1段も残らなければ案内を始めない**——題だけの案内は、
 * 押す場所が無いので用を成さない。
 */
export function startTour(
  procedure: Procedure,
  lookup: ProcedureActionLookup
): TourState | undefined {
  const steps: TourStep[] = [];
  for (const step of procedure.steps) {
    const action = lookup(step.command);
    if (!action) continue;
    steps.push({
      command: step.command,
      label: action.label,
      ...(action.note ? { note: action.note } : {}),
      why: step.why,
      check: step.check,
      ...(action.prerequisiteNote
        ? { prerequisiteNote: action.prerequisiteNote }
        : {}),
    });
  }
  if (steps.length === 0) return undefined;

  return {
    key: procedure.key,
    title: procedure.title,
    steps,
    index: 0,
    strayCount: 0,
  };
}

/**
 * 鍵から手順書きを引いて案内を始める。
 *
 * 画面から届くのは鍵の文字列なので、**ここで一覧と突き合わせる**
 * ——画面から渡された文字列がそのまま手順になる道は作らない
 * （相談パネルが「できること」の札を一覧と突き合わせるのと同じ流儀）。
 */
export function startTourByKey(
  key: string,
  lookup: ProcedureActionLookup,
  procedures: readonly Procedure[] = PROCEDURES
): TourState | undefined {
  const procedure = procedures.find((entry) => entry.key === key);
  return procedure ? startTour(procedure, lookup) : undefined;
}

/** いま案内している段。最後まで進んでいれば undefined */
export function currentStep(state: TourState): TourStep | undefined {
  return state.steps[state.index];
}

/** 最後まで進んだか */
export function isTourFinished(state: TourState): boolean {
  return state.index >= state.steps.length;
}

/**
 * 押された操作を受けて、案内を進めるかどうかを決める。
 *
 * **前へしか動かさない**（この規則は上の表のとおり）。判断を1か所に
 * 置いてあるので、押した経路（作者が自分で押した／「代わりに押して」）が
 * 違っても同じ結果になる——どちらを選んでも進み方が同じである、という
 * 約束（設計書6.104）はここで守られる。
 */
export function observeCommand(
  state: TourState,
  command: string
): TourObservation {
  if (isTourFinished(state)) return { kind: "ignored", state };

  // **いまの段から先だけを探す。** 済んだ段を拾うと、やり直しのたびに
  // 案内が後戻りする
  const matched = state.steps.findIndex(
    (step, position) => position >= state.index && step.command === command
  );
  if (matched < 0) {
    // 済んだ段のやり直しは「寄り道」ではないので数えない
    const isDone = state.steps.some((step) => step.command === command);
    return {
      kind: "ignored",
      state: isDone ? state : { ...state, strayCount: state.strayCount + 1 },
    };
  }

  const next = { ...state, index: matched + 1 };
  return isTourFinished(next)
    ? { kind: "finished", state: next }
    : { kind: "advanced", state: next };
}

/** 画面へ出す1段ぶん。**言い方をここで決める**（画面側に写しを作らない） */
export interface TourStepView {
  readonly key: string;
  readonly title: string;
  /** 「3つのうち1つ目」 */
  readonly position: string;
  /** 1から数えた番号 */
  readonly number: number;
  readonly total: number;
  readonly command: string;
  readonly label: string;
  readonly why: string;
  readonly check: string;
  readonly prerequisiteNote?: string;
}

/**
 * いまの段を、画面に出す形にする。
 *
 * 補足（`note`）は名前へ戻す。手順書きの文（`renderProcedure`）と
 * 同じ見え方にしておくと、相談の文で読んだものと画面の札が結びつく。
 */
export function describeStep(state: TourState): TourStepView | undefined {
  const step = currentStep(state);
  if (!step) return undefined;
  const total = state.steps.length;
  const number = state.index + 1;
  return {
    key: state.key,
    title: state.title,
    position: `${total}つのうち${number}つ目`,
    number,
    total,
    command: step.command,
    label: step.note ? `${step.label}（${step.note}）` : step.label,
    why: step.why,
    check: step.check,
    ...(step.prerequisiteNote
      ? { prerequisiteNote: step.prerequisiteNote }
      : {}),
  };
}

/**
 * 案内を終えるときの一行。
 *
 * **やめたときも、どこまで進んだかを言う。** 「やめました」だけだと、
 * 続きから始めたいときに何番目からなのかが分からない。
 */
export function describeTourEnd(
  state: TourState,
  reason: "finished" | "stopped"
): string {
  if (reason === "finished") {
    return `「${state.title}」の案内が終わりました（${state.steps.length}つすべて）。`;
  }
  const done = Math.min(state.index, state.steps.length);
  return done === 0
    ? `「${state.title}」の案内をやめました。`
    : `「${state.title}」の案内をやめました（${state.steps.length}つのうち${done}つ目まで）。`;
}
