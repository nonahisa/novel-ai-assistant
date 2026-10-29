import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import {
  CustomFieldStore,
  CustomFieldStoreError,
} from "../core/customFieldStore";
import { CharacterStore } from "../core/characterStore";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../core/abilityStore";
import {
  fieldsFor,
  nextCustomFieldKey,
  restorableKeysFor,
  retiredKeysFor,
  validateNewField,
  withFieldRemoved,
  withFieldRestored,
  withFieldsFor,
  type CustomFieldDefinition,
  type CustomFieldKind,
  type CustomFieldSet,
} from "../models/customField";
import { logFailure, useLogFile } from "../core/logger";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import { messageOf } from "../core/errorMessage";

/**
 * 設定資料に作者が項目を足す・外す。
 *
 * 定義したその作品の**同じ種類の全レコード**に同じ項目が並ぶ。人物ごとに
 * 違う項目にすると見比べられなくなるし、どの人物に何を書いたか作者が
 * 覚えていられない。
 *
 * **人物以外の種類にも足せる**（作者の裁定、2026-09-23 問11 B）。場所に
 * 「気候」、組織に「設立年」のように、作品に要る欄は種類ごとに違う。
 * 先に種類を選ばせ、そのあとは人物のときと同じ流れにする。
 *
 * 外すときは値を消さない。項目名を付け替えている途中かもしれないし、
 * 「消したら値まで消えた」は作者に見えない損失になる。
 * 「項目を追加」で足し直すと新しいキーになる（外したキーを使い回すと値が
 * 別の項目に化けるため）。外した項目は「外した項目を戻す」で**同じキーのまま**
 * 戻せる（作者の裁定、2026-10-24 夜）。戻せば各資料に残っていた値がそのまま出る。
 */

/**
 * 種類の呼び名。「全員の」「すべての場所の」と、足した先を言い分ける。
 * 並びは設定資料パネルのタブと同じにする（見慣れた順で探せるように）
 */
const KIND_CHOICES: ReadonlyArray<{
  kind: CustomFieldKind;
  label: string;
  /** 「〜の設定資料に入力欄が増えます」の「〜」 */
  scope: string;
  example: string;
}> = [
  { kind: "character", label: "人物", scope: "全員", example: "誕生日 / 身長 / 好きな食べ物 / 家紋" },
  { kind: "ability", label: "能力", scope: "すべての能力", example: "習得の条件 / 系統" },
  { kind: "organization", label: "組織", scope: "すべての組織", example: "設立年 / 本拠地 / 紋章" },
  { kind: "location", label: "場所", scope: "すべての場所", example: "気候 / 人口 / 名物" },
  { kind: "world", label: "世界観", scope: "すべての世界観の項目", example: "出典 / 関わる人物" },
];

export async function manageCustomFields(work: WorkEntry): Promise<void> {
  const store = new CustomFieldStore(work);

  let set: CustomFieldSet;
  try {
    set = await store.load();
  } catch (error) {
    // 壊れたJSONを空として扱って上書きすると、作者が書いた定義が消える
    const message =
      error instanceof CustomFieldStoreError
        ? error.message
        : `項目の定義を読めませんでした: ${messageOf(error)}`;
    // **記録の直前に書き先を向ける**（0.43.3 と同じ）
    useLogFile(work.folderPath);
    logFailure("customFields.load", { work: work.title, message });
    void vscode.window.showErrorMessage(
      `${message} ファイルを直してから、もう一度お試しください。`
    );
    return;
  }

  const choice = await pickKind(set);
  if (!choice) return;
  const fields = fieldsFor(set, choice.kind);

  const restorable = restorableKeysFor(set, choice.kind);
  const picked = await pickAction(fields, choice, restorable.length > 0);
  if (!picked) return;

  let next: CustomFieldSet;
  let doneMessage: string;
  if (picked === "add") {
    // **一度使ったキーを二度と振らないため、値として残っているキーも集める。**
    // 外したキーの記録（retiredKeys）を持つ前の版で外した項目は、
    // レコードの値にしか痕跡が無い
    const used = await collectUsedKeys(work, choice);
    if (!used) return;
    const updated = await addField(fields, choice, [
      ...retiredKeysFor(set, choice.kind),
      ...used,
    ]);
    if (!updated) return;
    // 選んだ種類の定義だけを差し替える。ほかの種類の定義には触らない
    next = withFieldsFor(set, choice.kind, updated);
    doneMessage = `${choice.label}に項目を追加しました。設定資料を開くと、${choice.scope}に入力欄が増えています。`;
  } else if (picked === "restore") {
    const key = await pickFieldToRestore(work, choice, restorable);
    if (key === undefined) return;
    // 見出し・説明・長さは外したときに覚えていないので、ここで訊き直す。
    // キーだけは外す前と同じものを使う——新しく振ると、各資料に残っている
    // 値と結び付かず、戻した意味が無くなる
    const details = await askFieldDetails(fields, choice, "戻す項目");
    if (!details) return;
    const restored: CustomFieldDefinition = { key, ...details };
    next = withFieldRestored(set, choice.kind, restored);
    doneMessage = `「${restored.label}」を戻しました。各資料に残っていた内容が、そのまま表に出ます。`;
  } else {
    const key = await pickFieldToRemove(fields);
    if (key === undefined) return;
    // 外したキーを覚える。値は各レコードに残るので、同じキーを
    // 次の項目へ振ると、その値が新しい項目に化けて現れる
    next = withFieldRemoved(set, choice.kind, key);
    doneMessage =
      "項目を外しました。入力済みの内容は消えていません（各資料のファイルに残っています）。" +
      "「外した項目を戻す」で戻せます。";
  }

  try {
    await store.save(next);
  } catch (error) {
    const message =
      error instanceof CustomFieldStoreError
        ? error.message
        : `項目を保存できませんでした: ${messageOf(error)}`;
    useLogFile(work.folderPath);
    logFailure("customFields.save", { work: work.title, message });
    void vscode.window.showErrorMessage(message);
    return;
  }

  void vscode.window.showInformationMessage(doneMessage);
}

type KindChoice = (typeof KIND_CHOICES)[number];

/**
 * どの種類の資料に項目を足すか。
 *
 * **いまある項目を並べて見せる**——どの種類に何を足したかを、作者が
 * 覚えていなくても選べるようにする。
 */
async function pickKind(set: CustomFieldSet): Promise<KindChoice | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...KIND_CHOICES.map((choice) => {
        const fields = fieldsFor(set, choice.kind);
        return {
          label: choice.label,
          description:
            fields.length > 0
              ? `現在: ${fields.map((field) => field.label).join("、")}`
              : "（まだありません）",
          choice,
        };
      }),
      cancelItem(),
    ],
    {
      title: "どの資料に項目を足しますか",
      placeHolder: "種類を選んでください",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  return "choice" in picked ? picked.choice : undefined;
}

type ManageAction = "add" | "remove" | "restore";

async function pickAction(
  fields: CustomFieldDefinition[],
  choice: KindChoice,
  canRestore: boolean
): Promise<ManageAction | undefined> {
  const current =
    fields.length > 0
      ? fields.map((field) => field.label).join("、")
      : "（まだありません）";

  const items: Array<vscode.QuickPickItem & { action: ManageAction }> = [
    {
      label: "$(add) 項目を追加",
      description: `${choice.scope}の設定資料に入力欄が増えます`,
      action: "add",
    },
  ];
  if (fields.length > 0) {
    items.push({
      label: "$(remove) 項目を外す",
      description: "入力済みの内容は消えません",
      action: "remove",
    });
  }
  // 外した項目が無ければ出さない（押しても選ぶものが無い）
  if (canRestore) {
    items.push({
      label: "$(history) 外した項目を戻す",
      description: "各資料に残っている内容が、そのまま表に出ます",
      action: "restore",
    });
  }

  const picked = await vscode.window.showQuickPick([...items, cancelItem()], {
    title: `${choice.label}の項目　現在: ${current}`,
    placeHolder: "何をしますか？",
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked)) return undefined;
  return "action" in picked ? picked.action : undefined;
}

/**
 * その種類のレコードに値として残っている追加項目のキー。
 *
 * **読めないレコードがあれば止める**（undefined を返す）。そのレコードに
 * どのキーの値が残っているか分からないまま番号を振ると、外した項目の
 * 値を新しい項目へ紛れ込ませるおそれがある。壊れたJSONは直さない。
 */
async function collectUsedKeys(
  work: WorkEntry,
  choice: KindChoice
): Promise<Set<string> | undefined> {
  let loaded: LoadedRecords;
  try {
    loaded = await loadRecordsOf(work, choice.kind);
  } catch (error) {
    const message = `${choice.label}の資料を読めませんでした: ${messageOf(error)}`;
    useLogFile(work.folderPath);
    logFailure("customFields.scanValues", { work: work.title, message });
    void vscode.window.showErrorMessage(message);
    return undefined;
  }
  if (loaded.errors.length > 0) {
    const files = loaded.errors.map((entry) => entry.file).join("、");
    useLogFile(work.folderPath);
    logFailure("customFields.scanValues", {
      work: work.title,
      errors: loaded.errors,
    });
    void vscode.window.showErrorMessage(
      `${choice.label}の資料に読めないファイルがあるため、項目を足せません（${files}）。` +
        "外した項目の値と新しい項目が混ざらないよう、ファイルを直してから、もう一度お試しください。"
    );
    return undefined;
  }
  const keys = new Set<string>();
  for (const record of loaded.records) {
    for (const key of Object.keys(record.customFields ?? {})) keys.add(key);
  }
  return keys;
}

interface LoadedRecords {
  records: Array<{ customFields?: Record<string, string> }>;
  errors: Array<{ file: string; message: string }>;
}

async function loadRecordsOf(
  work: WorkEntry,
  kind: CustomFieldKind
): Promise<LoadedRecords> {
  switch (kind) {
    case "character": {
      const { characters, errors } = await new CharacterStore(work).loadAll();
      return { records: characters, errors };
    }
    case "ability":
      return createAbilityStore(work).loadAll();
    case "organization":
      return createOrganizationStore(work).loadAll();
    case "location":
      return createLocationStore(work).loadAll();
    case "world":
      return createWorldStore(work).loadAll();
  }
}

async function addField(
  fields: CustomFieldDefinition[],
  choice: KindChoice,
  usedKeys: string[]
): Promise<CustomFieldDefinition[] | undefined> {
  const details = await askFieldDetails(fields, choice, "追加する項目");
  if (!details) return undefined;
  return [...fields, { key: nextCustomFieldKey(fields, usedKeys), ...details }];
}

/**
 * 項目の見出し・説明・長さを訊く。足すときと戻すときで同じ問いにする。
 *
 * `what` は「追加する項目」「戻す項目」——題に出して、いまどちらを
 * しているかを作者が見失わないようにする。
 */
async function askFieldDetails(
  fields: CustomFieldDefinition[],
  choice: KindChoice,
  what: string
): Promise<Omit<CustomFieldDefinition, "key"> | undefined> {
  const label = await askText({
    title: `${choice.label}に${what}の名前`,
    placeHolder: `例: ${choice.example}`,
    prompt: "設定資料に出す見出しになります。",
    validateInput: (value) => validateNewField(fields, value) ?? null,
  });
  if (label === undefined) return undefined;

  const trimmedLabel = label.trim();

  const hint = await askText({
    title: `「${trimmedLabel}」の説明（省略できます）`,
    placeHolder: "例: 本文中で誕生日に触れている箇所があれば書く",
    // AIの再読込（6.31.1）が追加項目を埋めるのは、いまは人物だけである。
    // 人物以外で「AIに渡す」と書くと、使われない説明を書かせることになる
    prompt:
      choice.kind === "character"
        ? "AIに項目を埋めさせるときに渡す説明です。" +
          "何を書いてほしいかが具体的なほど、外れた答えが減ります。"
        : "何を書く欄かの覚え書きです。",
  });
  if (hint === undefined) return undefined;

  const length = await vscode.window.showQuickPick(
    [
      {
        label: "短い（1行）",
        description: "誕生日・身長など",
        multiline: false,
      },
      {
        label: "長い（複数行）",
        description: "生い立ち・口癖など",
        multiline: true,
      },
      cancelItem(),
    ],
    {
      title: `「${trimmedLabel}」の長さ`,
      placeHolder: "入力欄の高さに使います",
      // 説明を Enter した直後に横のパネルへ焦点が戻ると、閉じない設定が無い
      // この画面だけ一瞬で閉じ、項目が黙って保存されなかった（ノートPC、2026-09-23）
      ignoreFocusOut: true,
    }
  );
  if (!length || !("multiline" in length)) return undefined;

  return {
    label: trimmedLabel,
    hint: hint.trim(),
    multiline: length.multiline,
  };
}

/**
 * どの外した項目を戻すか。
 *
 * 外したときに見出しを覚えていない（`retiredKeys` はキーだけ）ので、
 * **各資料に残っている値の例**を並べて、どの項目だったかを作者が
 * 思い出せるようにする。キー（field_003 など）は作者に見せない。
 *
 * 資料の読み込みに失敗しても止めない——戻すのは同じキーを定義へ戻す
 * だけで、値を混ぜる心配が無い（足すときとは違う）。読めなかったことは
 * 記録に残し、例が欠けていることを言い添える。
 */
async function pickFieldToRestore(
  work: WorkEntry,
  choice: KindChoice,
  keys: string[]
): Promise<string | undefined> {
  const values = new Map<string, string[]>();
  let unreadable = false;
  try {
    const loaded = await loadRecordsOf(work, choice.kind);
    if (loaded.errors.length > 0) {
      unreadable = true;
      useLogFile(work.folderPath);
      logFailure("customFields.restoreScan", {
        work: work.title,
        errors: loaded.errors,
      });
    }
    for (const record of loaded.records) {
      for (const [key, value] of Object.entries(record.customFields ?? {})) {
        if (!value.trim()) continue;
        values.set(key, [...(values.get(key) ?? []), value]);
      }
    }
  } catch (error) {
    unreadable = true;
    useLogFile(work.folderPath);
    logFailure("customFields.restoreScan", {
      work: work.title,
      message: messageOf(error),
    });
  }

  const picked = await vscode.window.showQuickPick(
    [
      ...keys.map((key, index) => {
        const found = values.get(key) ?? [];
        return {
          label:
            found.length > 0
              ? `値の例: ${found
                  .slice(0, 3)
                  .map((value) => `「${shortenForPick(value)}」`)
                  .join("")}`
              : "値の入っていない項目",
          description:
            found.length > 0
              ? `値のある資料 ${found.length}件`
              : "どの資料にも内容が残っていません",
          detail: `外した順で ${index + 1}番目`,
          key,
        };
      }),
      cancelItem(),
    ],
    {
      title: `${choice.label}の外した項目を戻す`,
      placeHolder: unreadable
        ? "読めない資料があったため、値の例が欠けていることがあります"
        : "戻す項目を選んでください。見出しはこのあと付け直します",
      ignoreFocusOut: true,
    }
  );
  if (!picked || !("key" in picked)) return undefined;
  return picked.key;
}

/** 値の例は1行に収める。長い生い立ちなどで品書きが読めなくならないように */
function shortenForPick(value: string): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  return oneLine.length > 16 ? `${oneLine.slice(0, 16)}…` : oneLine;
}

async function pickFieldToRemove(
  fields: CustomFieldDefinition[]
): Promise<string | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...fields.map((field) => ({
        label: field.label,
        description: field.hint,
        key: field.key,
      })),
      cancelItem(),
    ],
    {
      title: "外す項目",
      placeHolder: "入力済みの内容は消えません。表示されなくなるだけです",
      ignoreFocusOut: true,
    }
  );
  if (!picked || !("key" in picked)) return undefined;

  return picked.key;
}
