import { window } from "./vscodeStub";

/**
 * 確認の選択窓（`views/notify.ts` の `confirmRun`・`confirmRunOrChoose`）に
 * テストから答えるための部品（作者の裁定 A4、2026-09-23）。
 *
 * 確認は画面中央のモーダルから**画面上部の選択窓**へ移った。それまでの
 * テストは `showInformationMessage` を差し替えて「実行」を返していたが、
 * いまは `showQuickPick` に並んだ項目から選ぶ形になる。
 *
 * **確認でない選択窓（範囲を選ぶ・作品を選ぶなど）は、差し替える前の
 * `showQuickPick` へそのまま回す。** 1つのテストの中で両方が出るため。
 */

/** 確認の窓の項目。押せるものは `button` を持つ */
interface PickItem {
  label: string;
  kind?: number;
  button?: string;
  __cancel?: boolean;
}

/** 画面に出た確認の1回ぶん */
export interface ShownConfirm {
  /** 窓の題（文の1行目） */
  readonly title: string;
  /** 押せる項目の名前（印を除いたもの）。並んだ順 */
  readonly buttons: readonly string[];
  /** 「内容」の下に並んだ行（区切りは除く） */
  readonly rows: readonly string[];
  /** 題と行を改行でつないだもの */
  readonly text: string;
  /**
   * 題と行を**改行なしで**つないだもの。**文言を探すときはここを見る**——
   * 長い行は窓の幅で折り返されるので、文の途中に改行が入ることがある
   */
  readonly flat: string;
  /** 取り消しにくい操作の印（警告）が実行に付いていたか */
  readonly warning: boolean;
}

/** その選択窓は確認か（押せる項目 `button` を持つものがあるか） */
export function isConfirmPick(items: unknown): boolean {
  return (
    Array.isArray(items) &&
    items.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as PickItem).button === "string"
    )
  );
}

/** 選択窓に渡された項目と設定から、確認の中身を読む */
export function readConfirm(
  items: readonly PickItem[],
  options?: { title?: string }
): ShownConfirm {
  const title = options?.title ?? "";
  const buttons = items
    .filter((item) => typeof item.button === "string")
    .map((item) => item.button as string);
  const separator = items.findIndex(
    (item) => item.kind === -1 && item.label === "内容"
  );
  const rows =
    separator < 0
      ? []
      : items
          .slice(separator + 1)
          .filter((item) => item.kind !== -1)
          .map((item) => item.label);
  const run = items.find((item) => typeof item.button === "string");
  return {
    title,
    buttons,
    rows,
    text: [title, ...rows].join("\n"),
    flat: [title, ...rows].join(""),
    warning: Boolean(run?.label.startsWith("$(warning)")),
  };
}

type Answer = string | undefined;

/** 差し替えた `showQuickPick` と、出た確認の記録 */
export interface ConfirmPicker {
  /** 出た確認（古い順） */
  readonly shown: ShownConfirm[];
  /** 差し替える前の `showQuickPick` へ戻す */
  restore(): void;
}

/**
 * 選択窓に出た確認を、**そのときの** `showInformationMessage`（警告の印が
 * 付いた確認は `showWarningMessage`）へ橋渡しする。
 *
 * **使うのは、確認で何を押すかを通知の差し替えで決めている試験が、1つの
 * ファイルに何十か所もあるときだけ**（人物抽出の流れ・ZIPの取り込み）。
 * 1か所ずつ書き換えると、答え方の取り違えを持ち込みやすい。橋渡しでも、
 * 製品は本物どおり選択窓（`showQuickPick`）を通るので、窓の形が壊れれば
 * ここで項目が見つからずに落ちる。
 *
 * 渡す形はモーダルだった頃と同じ `(文, { modal: true, detail }, ...ボタン)`。
 * 文は題と行を、`detail` は行だけを、どちらも**改行なしで**つないだもの
 * （長い行は窓の幅で折り返されるので、文の途中に改行が入らないようにする）。
 *
 * 確認でない選択窓は、差し替える前の `showQuickPick` へ回す。
 */
export function bridgeConfirmsToMessages(): ConfirmPicker {
  const original = window.showQuickPick;
  const shown: ShownConfirm[] = [];
  window.showQuickPick = async (items: unknown, options?: unknown) => {
    if (!isConfirmPick(items)) return original(items, options);
    const list = items as PickItem[];
    const confirm = readConfirm(list, options as { title?: string });
    shown.push(confirm);
    const show = confirm.warning
      ? window.showWarningMessage
      : window.showInformationMessage;
    const label = await show(
      confirm.flat,
      { modal: true, detail: confirm.rows.join("") },
      ...confirm.buttons
    );
    if (label === undefined) return undefined;
    return list.find((item) => item.button === label);
  };
  return {
    shown,
    restore() {
      window.showQuickPick = original;
    },
  };
}

/**
 * `window.showQuickPick` を差し替え、確認には `answer` が返す名前の項目を
 * 選ぶ（`undefined` なら閉じた扱い）。答えは固定の名前でも、出た確認を
 * 見て決める関数でもよい。
 *
 * 確認でない選択窓は、差し替える前の `showQuickPick` へ回す。
 */
export function answerConfirms(
  answer: Answer | ((shown: ShownConfirm) => Answer)
): ConfirmPicker {
  const original = window.showQuickPick;
  const shown: ShownConfirm[] = [];
  window.showQuickPick = async (items: unknown, options?: unknown) => {
    if (!isConfirmPick(items)) return original(items, options);
    const list = items as PickItem[];
    const confirm = readConfirm(list, options as { title?: string });
    shown.push(confirm);
    const label = typeof answer === "function" ? answer(confirm) : answer;
    if (label === undefined) return undefined;
    return list.find((item) => item.button === label);
  };
  return {
    shown,
    restore() {
      window.showQuickPick = original;
    },
  };
}
