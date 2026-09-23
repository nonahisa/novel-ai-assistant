import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import {
  CustomFieldStore,
  CustomFieldStoreError,
} from "../core/customFieldStore";
import {
  fieldsFor,
  nextCustomFieldKey,
  validateNewField,
  withFieldsFor,
  type CustomFieldDefinition,
  type CustomFieldKind,
  type CustomFieldSet,
} from "../models/customField";
import { logFailure, useLogFile } from "../core/logger";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";

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
 * 定義を戻せば値も戻る。
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
        : `項目の定義を読めませんでした: ${errorMessage(error)}`;
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

  const picked = await pickAction(fields, choice);
  if (!picked) return;

  const updated =
    picked === "add"
      ? await addField(fields, choice)
      : await removeField(fields);
  if (!updated) return;

  try {
    // 選んだ種類の定義だけを差し替える。ほかの種類の定義には触らない
    await store.save(withFieldsFor(set, choice.kind, updated));
  } catch (error) {
    const message =
      error instanceof CustomFieldStoreError
        ? error.message
        : `項目を保存できませんでした: ${errorMessage(error)}`;
    useLogFile(work.folderPath);
    logFailure("customFields.save", { work: work.title, message });
    void vscode.window.showErrorMessage(message);
    return;
  }

  void vscode.window.showInformationMessage(
    picked === "add"
      ? `${choice.label}に項目を追加しました。設定資料を開くと、${choice.scope}に入力欄が増えています。`
      : "項目を外しました。入力済みの内容は消えていません（項目を戻せば再び表示されます）。"
  );
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

type ManageAction = "add" | "remove";

async function pickAction(
  fields: CustomFieldDefinition[],
  choice: KindChoice
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

  const picked = await vscode.window.showQuickPick([...items, cancelItem()], {
    title: `${choice.label}の項目　現在: ${current}`,
    placeHolder: "何をしますか？",
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked)) return undefined;
  return "action" in picked ? picked.action : undefined;
}

async function addField(
  fields: CustomFieldDefinition[],
  choice: KindChoice
): Promise<CustomFieldDefinition[] | undefined> {
  const label = await askText({
    title: `${choice.label}に追加する項目の名前`,
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

  return [
    ...fields,
    {
      key: nextCustomFieldKey(fields),
      label: trimmedLabel,
      hint: hint.trim(),
      multiline: length.multiline,
    },
  ];
}

async function removeField(
  fields: CustomFieldDefinition[]
): Promise<CustomFieldDefinition[] | undefined> {
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

  return fields.filter((field) => field.key !== picked.key);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
