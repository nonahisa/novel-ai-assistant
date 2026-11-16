/**
 * **縦書きの変換中の線を、行の右に出す入力欄**（右傍線の入力欄）の中身。設計書6.25.2 の
 * 【裁定】2026-11-16 夜（作者の判断：既定は左のまま、右は設定で選んだときだけ・テスト中）。
 *
 * ここが返すのは **WebView の中へ埋める JavaScript の文字列**（`keyLabels.ts`・
 * `views/imeEnterGuardScript.ts` と同じ置き方）。テストは同じ文字列を `new Function` で動かす
 * ——出荷しない写しを試さないため。DOM には触らない（触るのは原稿エディターの台本の側）。
 *
 * ## なぜ別の入力欄なのか
 *
 * 打つ面（textarea）と組んで書く面（contenteditable）では、変換中の線を日本語入力の層が引くので、
 * 縦書きでも行の左に出る。CSS では動かせない（6.25.2）。EditContext を使うと、日本語入力は
 * 「どこをどう書き換えたか（textupdate）」と「変換中の区切りと線の形（textformatupdate）」を
 * 知らせるだけで、字は描かない。字を1字ずつ span にして並べ、変換中の字にだけ線のクラスを付け、
 * 線の向きを CSS の text-underline-position: right で決める。モバイル版の［B 右傍線］
 * （novel-ai-android の editContextModel.ts・editContextPane.ts・tapCaret.ts・caretVisible.ts）を移した。
 *
 * ## 打つ面と同じ決まりで送受する（モバイル版と違う所）
 *
 * - **変換中は送らない。** 確定の合図（compositionend）のあと1周まわしてから送る。Windows の
 *   日本語入力は、合図のあとに確定ぶんの字を知らせることがある（6.25.2）
 * - **変換中に外から届いた本文は入れ直さず溜める。** 確定して送ってから片づける（6.25.1）
 * - **自分が送った本文の返事は、打つ面と同じ履歴（sentHistory／isOwnEcho）で見分ける。**
 *   履歴を2つ持たない（hooks で原稿エディターの関数を借りる）
 * - 送るのは本文の丸ごと。受け取る側の順番待ち（core/editQueue.ts）と書き戻し
 *   （writeTextFilePreservingFormat）は打つ面と同じ道を通る
 *
 * **この文字列の中にバッククォートも ドル記号と波かっこの並び も置かない**（埋め込む先がテンプレートリテラル）。
 */
export const RIGHT_IME_LINE_SOURCE = `
/* ── 右傍線の入力欄（設計書6.25.2） ── */

/** どの面を使うか。'rline'＝右の入力欄、'default'＝今までの面、'unsupported'＝右を選んだが使えない */
function rlChoosePane(setting, vertical, hasEditContext) {
  if (setting !== 'right') return 'default';
  if (!vertical) return 'default';
  return hasEditContext ? 'rline' : 'unsupported';
}

function rlClamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

/* サロゲートペア（𠮷 など）を半分に割らない */
function rlPrevLength(text, at) {
  const code = text.charCodeAt(at - 1);
  return code >= 0xdc00 && code <= 0xdfff && at >= 2 ? 2 : 1;
}
function rlNextLength(text, at) {
  const code = text.charCodeAt(at);
  return code >= 0xd800 && code <= 0xdbff && at + 1 < text.length ? 2 : 1;
}

/** 変換中の字の線のクラス（形が none の区切りには引かない） */
function rlLineClassAt(state, index) {
  if (!state.composing) return '';
  /* 形の名前は大文字で始まって届く環境がある（Android の WebView）。
     同じ範囲に「線なし」の区切りも重ねて届くので、線のある区切りを選ぶ */
  let format = null;
  for (let k = 0; k < state.formats.length; k++) {
    const f = state.formats[k];
    if (index >= f.start && index < f.end && String(f.style).toLowerCase() !== 'none') {
      format = f;
      break;
    }
  }
  if (!format) return '';
  const style = String(format.style).toLowerCase();
  const classes = ['rl-comp'];
  if (String(format.thickness).toLowerCase() === 'thick') classes.push('rl-thick');
  if (style === 'dotted' || style === 'dashed' || style === 'wavy') classes.push('rl-' + style);
  return classes.join(' ');
}

function rlEscape(ch) {
  return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch;
}

/**
 * 1字ずつ span にした HTML。候補の窓の位置を日本語入力へ返すとき、字の場所が要る。
 * サロゲートペアは1つの span（data-i は頭の位置、data-n は単位の数）。
 * 組んで書く面のルビ・傍点の組みは持ち込まない（地の文の字のまま並べる。テスト中の制限）
 */
function rlRenderHtml(state) {
  let html = '';
  let i = 0;
  const text = state.text;
  while (i <= text.length) {
    if (i === state.selection) html += '<span class="rl-caret" aria-hidden="true">&#8203;</span>';
    if (i === text.length) break;
    const n = rlNextLength(text, i);
    const ch = text.slice(i, i + n);
    if (ch === '\\n') {
      html += '<span data-i="' + i + '" data-n="1">\\n</span>';
    } else {
      const cls = rlLineClassAt(state, i);
      html += '<span data-i="' + i + '" data-n="' + n + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + rlEscape(ch) + '</span>';
    }
    i += n;
  }
  return html;
}

/**
 * キーをこの欄で受け持つ書き換えに読み替える。受け持たないキーは null（本体のキー割り当てへ通す）。
 * **確定の Enter は改行にしない**：isComposing・229 に加えて、合図のあとに遅れて届く確定の
 * keydown を isImeEnter（views/imeEnterGuardScript.ts の watchImeEnter）で見分ける
 */
function rlKeyKind(event, vertical, isImeEnter) {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const key = event.key;
  if (key === 'Enter') return isImeEnter(event) ? null : 'newline';
  if (key === 'Backspace') return 'backspace';
  if (key === 'Delete') return 'delete';
  if (key === (vertical ? 'ArrowUp' : 'ArrowLeft')) return 'back';
  if (key === (vertical ? 'ArrowDown' : 'ArrowRight')) return 'forward';
  return null;
}

/**
 * 押した点から、カーソルを置く位置を決める（字をこの欄が描くので、ブラウザは置いてくれない）。
 * 押した点にいちばん近い列（横書きは行）を選び、その中で押した位置に置く。
 * 字の上下のまん中より上ならその字の前、どの字よりも先なら列の末（改行で終わる列は改行の前）
 */
function rlCaretFromPoint(chars, x, y, vertical) {
  const across = function (c) { return vertical ? [c.left, c.right] : [c.top, c.bottom]; };
  const along = function (c) { return vertical ? [c.top, c.bottom] : [c.left, c.right]; };
  const pAcross = vertical ? x : y;
  const pAlong = vertical ? y : x;
  /* 大きさの無い字（改行の字が大きさ0で返る環境がある）は、列を決めるのには使わない */
  const visible = chars.filter(function (c) { return c.right > c.left || c.bottom > c.top; });
  if (visible.length === 0) return chars.length > 0 ? chars[chars.length - 1].i : undefined;
  const distance = function (c) {
    const r = across(c);
    return pAcross < r[0] ? r[0] - pAcross : pAcross > r[1] ? pAcross - r[1] : 0;
  };
  let nearest = visible[0];
  for (let k = 0; k < visible.length; k++) if (distance(visible[k]) < distance(nearest)) nearest = visible[k];
  const col = across(nearest);
  const middle = (col[0] + col[1]) / 2;
  const column = chars
    .filter(function (c) {
      const r = across(c);
      return middle >= r[0] - 0.5 && middle <= r[1] + 0.5;
    })
    .sort(function (p, q) { return along(p)[0] - along(q)[0] || p.i - q.i; });
  for (let k = 0; k < column.length; k++) {
    const c = column[k];
    const r = along(c);
    if (r[1] <= r[0] && c.newline) continue;
    if (pAlong < (r[0] + r[1]) / 2) return c.i;
  }
  const last = column[column.length - 1];
  return last.newline ? last.i : last.i + last.n;
}

/**
 * カーソルの印が欄の見える所に入るよう、欄を転がす量（x：横、y：縦。正なら右・下へ）。
 * モバイル版は窓ごと送るが、ここは欄そのものが転がる（縦書きは横へ転がる）ので、量の計算だけを借りた
 */
function rlRevealDelta(caret, pane, margin) {
  const axis = function (lo, hi, min, max) {
    if (hi > max - margin) return hi - (max - margin);
    if (lo < min + margin) return lo - (min + margin);
    return 0;
  };
  return {
    x: axis(caret.left, caret.right, pane.left, pane.right),
    y: axis(caret.top, caret.bottom, pane.top, pane.bottom),
  };
}

/**
 * 外から届いた本文で入れ直すときのカーソル（打つ面の replaceKeepingCaret と同じ式）。
 * 前から一致する所より前なら動かさない。後ろなら増減分だけずらす
 */
function rlShiftCaret(before, after, at) {
  let common = 0;
  const max = Math.min(before.length, after.length);
  while (common < max && before[common] === after[common]) common++;
  if (at <= common) return at;
  return Math.max(common, Math.min(after.length, at + after.length - before.length));
}

/**
 * 右の入力欄の1回の受け持ち。hooks は原稿エディターの台本が渡す：
 * - commit(text)：打つ面の値を揃えて send する（current と同じなら送らない・送ったら履歴に覚える）
 * - isOwnEcho・forgetSent・setEditBase・current：打つ面と同じ関数・値
 * - defer(fn)：1周まわす（setTimeout 0）
 * - tellContext(start, end, text, selection)：ページが受け持った書き換えを EditContext へ伝える
 * - render()：描き直す
 */
function rlCreateSession(initialText, hooks) {
  let state = { text: initialText, selection: initialText.length, composing: false, formats: [] };
  /* 変換中に外から届いた本文。確定してから片づける */
  let pending = null;
  /*
    打つ面の値と同じだと分かっている本文（最後に送った・入れ直した・揃えた本文）。
    欄の字がこれと違う間は、まだ送っていない字がある（確定の合図から送るまでの1周など）
  */
  let synced = initialText;

  function commitNow() {
    hooks.commit(state.text);
    synced = state.text;
  }

  /* 確定のあとに、待たせていた本文を片づける（打つ面の flushPending と同じ） */
  function flushPending() {
    const text = pending;
    pending = null;
    if (text === null) return;
    /* 打った内容のほうを優先する。まだ送っていない字があれば送り直す */
    if (state.text !== hooks.current()) { commitNow(); return; }
    incoming(text);
  }

  /* 外から届いた本文（打つ面の takeIncoming と同じ順で見る） */
  function incoming(text, undoCaret) {
    /* 自分の書き換えの返事は、いつ届いても触らない（変換中なら溜めもしない） */
    if (hooks.isOwnEcho(text)) return 'echo';
    if (state.composing) {
      /* いま入れると変換が壊れる */
      if (text !== state.text) pending = text;
      return 'held';
    }
    if (text === state.text) { hooks.setEditBase(text); return 'same'; }
    hooks.forgetSent();
    const before = state.text;
    const at = typeof undoCaret === 'number'
      ? rlClamp(undoCaret, 0, text.length)
      : rlShiftCaret(before, text, state.selection);
    state = { text: text, selection: at, composing: false, formats: [] };
    synced = text;
    hooks.tellContext(0, before.length, text, at);
    hooks.render();
    hooks.setEditBase(text);
    return 'applied';
  }

  function replace(start, end, inserted) {
    state = {
      text: state.text.slice(0, start) + inserted + state.text.slice(end),
      selection: start + inserted.length,
      composing: state.composing,
      formats: state.formats,
    };
    hooks.tellContext(start, end, inserted, state.selection);
    hooks.render();
    commitNow();
  }

  return {
    state: function () { return state; },
    isComposing: function () { return state.composing; },
    textUpdate: function (u) {
      const start = rlClamp(u.start, 0, state.text.length);
      const end = rlClamp(u.end, start, state.text.length);
      const text = state.text.slice(0, start) + u.text + state.text.slice(end);
      state = {
        text: text,
        selection: rlClamp(u.selection, 0, text.length),
        composing: state.composing,
        formats: state.formats,
      };
      hooks.render();
      /* 変換中は送らない（確定前の字を本文へ入れると、確定のたびに二重に入る） */
      if (!state.composing) commitNow();
    },
    formatUpdate: function (formats) {
      state = { text: state.text, selection: state.selection, composing: state.composing, formats: formats };
      hooks.render();
    },
    compositionStart: function () {
      state = { text: state.text, selection: state.selection, composing: true, formats: [] };
    },
    compositionEnd: function () {
      state = { text: state.text, selection: state.selection, composing: false, formats: [] };
      hooks.render();
      /* 確定ぶんの字が合図のあとに来ることがある。1周まわしてから送り、溜めた本文を片づける */
      hooks.defer(function () {
        commitNow();
        flushPending();
      });
    },
    /** ページが受け持つキー。受け持ったら true */
    key: function (kind) {
      const at = state.selection;
      const text = state.text;
      if (kind === 'newline') { replace(at, at, '\\n'); return true; }
      if (kind === 'backspace') {
        if (at > 0) replace(at - rlPrevLength(text, at), at, '');
        return true;
      }
      if (kind === 'delete') {
        if (at < text.length) replace(at, at + rlNextLength(text, at), '');
        return true;
      }
      if (kind === 'back' || kind === 'forward') {
        const to = kind === 'back'
          ? at - (at > 0 ? rlPrevLength(text, at) : 0)
          : at + (at < text.length ? rlNextLength(text, at) : 0);
        this.moveCaret(to);
        return true;
      }
      return false;
    },
    /** 貼り付け（カーソルの位置へ字を入れる） */
    insert: function (inserted) {
      if (!inserted) return;
      replace(state.selection, state.selection, inserted);
    },
    moveCaret: function (to) {
      const at = rlClamp(to, 0, state.text.length);
      state = { text: state.text, selection: at, composing: state.composing, formats: state.formats };
      hooks.tellContext(at, at, '', at);
      hooks.render();
    },
    incoming: incoming,
    /**
     * 打つ面の値に揃える（右の入力欄の外の操作——右クリックの品書きなど——が打つ面の値を
     * 書き換えて送ったとき）。送り済みの本文なので、送り直さない。変換中は触らない。
     * **まだ送っていない字があるときも触らない**——確定の合図から送るまでの1周のあいだ、
     * 打つ面の値は確定前の本文なので、揃えると確定した語が消える
     */
    adopt: function (text) {
      if (state.composing || text === state.text) return;
      if (state.text !== synced) return;
      const before = state.text;
      const at = rlShiftCaret(before, text, state.selection);
      state = { text: text, selection: at, composing: false, formats: [] };
      synced = text;
      hooks.tellContext(0, before.length, text, at);
      hooks.render();
    },
  };
}
`;
