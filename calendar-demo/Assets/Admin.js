/* =========================================================
   接種可能日カレンダー 管理画面のロジック

   状態は state に集約し，変更のたびに描画し直す（部分更新をしない）．
   ラベルの追加・削除はまずブラウザ内の state に反映し，
   「保存して更新」で初めてサーバへ送って共有フォルダへ書き出す．
========================================================= */
(function () {
	'use strict';

	/* ラベル種別の定義．表示名と色クラスはLP本体と揃える． */
	var LABEL_TYPES = {
		vaccination:         { name: '接種対応', modifier: 'vaccination' },
		holiday_vaccination: { name: '休日接種', modifier: 'holiday' },
		closed:              { name: '休診',     modifier: 'closed' }
	};

	/* 並び順の基準（LP側と同じ） */
	var TYPE_ORDER = ['vaccination', 'holiday_vaccination', 'closed'];

	/* 自由記述欄の上限．サーバ側の MAX_TEXT_LENGTH と一致させる．
	   装飾タグを除いた «本文» の長さで数える． */
	var MAX_TEXT_LENGTH = 200;

	/* 文字装飾の記法．
	   LP側 CalendarSchedule.js の decorationClasses と，
	   サーバ側 ScheduleStore.DECORATION_TAG_PATTERN と対応させること． */
	var DECORATION_TAG_PATTERN = /\[\/?(?:b|u|red|green|gray)\]/g;

	/* ツールバーに並べるボタン．左から順に表示される */
	var decorationButtons = [
		{ tag: 'b',     label: 'B',   title: '太字',   modifier: 'bold' },
		{ tag: 'u',     label: 'U',   title: '下線',   modifier: 'underline' },
		{ tag: 'red',   label: '赤',  title: '赤文字', modifier: 'red' },
		{ tag: 'green', label: '緑',  title: '緑文字', modifier: 'green' },
		{ tag: 'gray',  label: '灰',  title: '灰文字', modifier: 'gray' }
	];

	/* 装飾タグを除いた «本文» の文字数を返す．
	   サーバ側の ScheduleStore.PlainLength と同じ数え方にすること．
	   ここがずれると «画面では収まっているのに保存で弾かれる» ことになる． */
	function plainLength(text) {
		return text.replace(DECORATION_TAG_PATTERN, '').length;
	}

	/* 曜日の表示名 */
	var WEEKDAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

	var state = {
		days: {},              // 日付 -> ラベル配列（編集中の内容）
		baseGeneratedAt: '',   // 画面を開いた時点の generatedAt（楽観ロック用）
		presets: [],
		rangeFrom: '',
		rangeTo: '',
		today: '',
		year: 0,
		month: 0,              // 0起算
		selected: [],          // 選択中の日付（昇順）
		anchor: null,          // Shift範囲選択の起点
		multi: false,
		draftType: 'vaccination',
		dirty: false,          // 未保存の変更があるか
		lastApplied: null,     // 直前に適用した内容（複製用）
		previewOpened: false
	};

	/* 最後に «サーバへ保存された» 時点の内容の写し．
	   保存確認で «今回の変更» を出すために持つ．
	   state.days と参照を共有すると，適用で書き換えた瞬間に
	   こちらも変わってしまい，差分が常に «変更なし» になる．必ず複製する． */
	var savedSnapshot = {};

	/* よく使う要素をまとめて引く */
	var el = {};

	/* 保存済みの内容を控え直す．bootstrap・保存成功・復元成功・競合解消で呼ぶ */
	function takeSavedSnapshot(days) {
		savedSnapshot = JSON.parse(JSON.stringify(days || {}));
	}

	/* 最後の保存時点からの変更を洗い出す．
	   «登録日数：1日» のような総数だけでは，
	   今回追加したはずの日が入っていないことに気づけない． */
	function diffFromSaved() {
		var added = [];
		var changed = [];
		var removed = [];

		Object.keys(state.days).forEach(function (dateString) {
			var before = savedSnapshot[dateString];
			if (!before) {
				added.push(dateString);
			} else if (JSON.stringify(before) !== JSON.stringify(state.days[dateString])) {
				changed.push(dateString);
			}
		});
		Object.keys(savedSnapshot).forEach(function (dateString) {
			if (!state.days[dateString]) {
				removed.push(dateString);
			}
		});

		added.sort();
		changed.sort();
		removed.sort();
		return { added: added, changed: changed, removed: removed };
	}

	/* =========================
	   日付ユーティリティ
	   toISOString() はUTC変換で前日にずれるため使わない．
	========================= */
	function pad(value) {
		return value < 10 ? '0' + value : String(value);
	}

	function formatDate(dateObject) {
		return dateObject.getFullYear() + '-' +
			pad(dateObject.getMonth() + 1) + '-' + pad(dateObject.getDate());
	}

	function parseDate(dateString) {
		var parts = dateString.split('-');
		return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
	}

	function monthKey(year, month) {
		return year + '-' + pad(month + 1);
	}

	/* 「10月5日(月)」形式の表示名 */
	function displayDate(dateString) {
		var date = parseDate(dateString);
		return (date.getMonth() + 1) + '月' + date.getDate() + '日(' +
			WEEKDAY_NAMES[date.getDay()] + ')';
	}

	/* =========================
	   通知
	========================= */
	function showToast(message, isError) {
		el.toast.textContent = message;
		el.toast.className = isError ? 'toast toast--error' : 'toast';
		el.toast.removeAttribute('hidden');
		window.clearTimeout(showToast.timer);
		showToast.timer = window.setTimeout(function () {
			el.toast.setAttribute('hidden', 'hidden');
		}, 4000);
	}

	function showBanner(message) {
		el.banner.textContent = message;
		el.banner.removeAttribute('hidden');
	}

	function mirrorWarningText(result) {
		/* 保存はできたが «付随する処理» に問題があったときの補足文を作る．
		   静的版ではファイルのダウンロードやブラウザ内保存の失敗がここに載る．
		   ここに中身があっても «保存に失敗» ではないので，そうは書かない． */
		var warnings = (result.body && result.body.mirrorWarnings) || [];
		if (!warnings.length) {
			return '';
		}
		return '／' + warnings.join('／');
	}

	function hideBanner() {
		el.banner.setAttribute('hidden', 'hidden');
	}

	/* =========================
	   確認ダイアログ
	   ブラウザ標準の confirm より情報量を出せるようにする．
	========================= */
	function confirmDialog(title, bodyHtml, okLabel, danger) {
		return new Promise(function (resolve) {
			el.dialogTitle.textContent = title;
			el.dialogBody.innerHTML = bodyHtml;
			el.dialogOk.textContent = okLabel || '実行';
			el.dialogOk.className = danger ? 'btn btn--danger' : 'btn btn--primary';
			el.dialog.removeAttribute('hidden');
			el.dialogOk.focus();

			function cleanup(result) {
				el.dialog.setAttribute('hidden', 'hidden');
				el.dialogOk.removeEventListener('click', onOk);
				el.dialogCancel.removeEventListener('click', onCancel);
				el.dialogBackdrop.removeEventListener('click', onCancel);
				document.removeEventListener('keydown', onKeydown);
				resolve(result);
			}
			function onOk() { cleanup(true); }
			function onCancel() { cleanup(false); }
			function onKeydown(event) {
				if (event.key === 'Escape') { cleanup(false); }
			}

			el.dialogOk.addEventListener('click', onOk);
			el.dialogCancel.addEventListener('click', onCancel);
			el.dialogBackdrop.addEventListener('click', onCancel);
			document.addEventListener('keydown', onKeydown);
		});
	}

	/* =========================
	   入力を伴うダイアログ
	   ブラウザ標準の prompt は使わない．利用者が
	   «このページでこれ以上ダイアログを表示しない» を選ぶと以後まったく
	   無反応になり，「保存ボタンが効かない」という分かりにくい状態になるため．
	========================= */
	function promptDialog(title, labelText, defaultValue, okLabel) {
		return new Promise(function (resolve) {
			el.dialogTitle.textContent = title;
			el.dialogBody.innerHTML =
				'<label class="dialog__field"><span>' + escapeHtml(labelText) + '</span>' +
				'<input type="text" class="dialog__input" maxlength="40"></label>';

			var input = el.dialogBody.querySelector('.dialog__input');
			input.value = defaultValue || '';

			el.dialogOk.textContent = okLabel || '保存する';
			el.dialogOk.className = 'btn btn--primary';
			el.dialog.removeAttribute('hidden');
			input.focus();
			input.select();

			function cleanup(result) {
				el.dialog.setAttribute('hidden', 'hidden');
				el.dialogOk.removeEventListener('click', onOk);
				el.dialogCancel.removeEventListener('click', onCancel);
				el.dialogBackdrop.removeEventListener('click', onCancel);
				document.removeEventListener('keydown', onKeydown);
				resolve(result);
			}
			function onOk() { cleanup(input.value.trim() || null); }
			function onCancel() { cleanup(null); }
			function onKeydown(event) {
				if (event.key === 'Escape') {
					cleanup(null);
				} else if (event.key === 'Enter') {
					/* 入力欄でEnterを押したらそのまま確定できるようにする */
					event.preventDefault();
					onOk();
				}
			}

			el.dialogOk.addEventListener('click', onOk);
			el.dialogCancel.addEventListener('click', onCancel);
			el.dialogBackdrop.addEventListener('click', onCancel);
			document.addEventListener('keydown', onKeydown);
		});
	}

	/* HTMLへ差し込む前に必ず通す（自由記述をそのまま埋め込まないため） */
	function escapeHtml(text) {
		return String(text)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}

	/* =========================
	   通信
	========================= */
	function request(path, payload) {
		/* 静的版（GitHub Pages）にはサーバが存在しない．
		   サーバ版ではここで fetch を使い，ローカルの Python サーバへ投げていた．
		   静的版では LocalApi.js がブラウザ内で同じ形の応答を組み立てて返す．

		   戻り値の形（{ status, body }）を変えていないため，
		   この関数から下の呼び出し側はサーバ版とまったく同じコードで動く．
		   通信を1箇所に集約してあったおかげで，差し替えがここだけで済んでいる． */
		return window.FluLocalApi.request(path, payload);
	}

	/* サーバからのエラーを画面へ反映する */
	function handleApiError(result) {
		var message = (result.body && result.body.message) || '処理に失敗しました．';
		if (result.body && (result.body.code === 'unreachable' || result.body.code === 'internal')) {
			/* 静的版ではブラウザ内の保存領域が唯一の保存先になる．
			   プライベートウィンドウやサイトデータの制限で書けないことがある． */
			showBanner('このブラウザに保存できません．プライベートウィンドウやサイトデータの制限を確認してください．入力した内容は失われていません．');
		} else if (result.body && result.body.code === 'conflict') {
			/* 保存経路の競合は offerConflictMerge が受け持つ．
			   ここへ来るのはそれ以外の経路なので，
			   少なくとも «入力は消えていない» ことは伝える． */
			showBanner(message + '　入力した内容は失われていません．');
		}
		showToast(message, true);
	}

	/* =========================
	   カレンダーの描画
	========================= */
	function renderCalendar() {
		el.calTitle.textContent = state.year + '年' + (state.month + 1) + '月';

		/* 表示期間の端では月送りを止める */
		var current = monthKey(state.year, state.month);
		el.prevMonth.disabled = !!state.rangeFrom && current <= state.rangeFrom;
		el.nextMonth.disabled = !!state.rangeTo && current >= state.rangeTo;

		el.calGrid.innerHTML = '';

		/* 月曜始まりにするため，日曜(0)を末尾へ回す */
		var firstDay = new Date(state.year, state.month, 1).getDay();
		firstDay = firstDay === 0 ? 6 : firstDay - 1;

		var lastDate = new Date(state.year, state.month + 1, 0).getDate();
		var previousLastDate = new Date(state.year, state.month, 0).getDate();
		var totalCells = Math.ceil((firstDay + lastDate) / 7) * 7;

		for (var i = 0; i < totalCells; i++) {
			var dayNumber;
			var cellDate;
			var isOther = false;

			if (i < firstDay) {
				dayNumber = previousLastDate - firstDay + i + 1;
				cellDate = new Date(state.year, state.month - 1, dayNumber);
				isOther = true;
			} else if (i < firstDay + lastDate) {
				dayNumber = i - firstDay + 1;
				cellDate = new Date(state.year, state.month, dayNumber);
			} else {
				dayNumber = i - firstDay - lastDate + 1;
				cellDate = new Date(state.year, state.month + 1, dayNumber);
				isOther = true;
			}

			var dateString = formatDate(cellDate);
			var cell = document.createElement('button');
			cell.type = 'button';
			cell.className = 'cell';
			cell.setAttribute('data-date', dateString);

			var weekday = cellDate.getDay();
			if (weekday === 6) { cell.className += ' cell--sat'; }
			if (weekday === 0) { cell.className += ' cell--sun'; }

			/* 当月以外は編集対象にしない（誤って隣の月を触る事故を防ぐ） */
			if (isOther) {
				cell.className += ' cell--other';
				cell.disabled = true;
			}
			if (dateString === state.today) { cell.className += ' cell--today'; }
			if (!isOther && dateString < state.today) { cell.className += ' cell--past'; }
			if (state.selected.indexOf(dateString) !== -1) { cell.className += ' cell--selected'; }

			var dateElement = document.createElement('span');
			dateElement.className = 'cell__date';
			dateElement.textContent = dayNumber;
			cell.appendChild(dateElement);

			/* 登録済みラベルをLPと同じ色で表示する */
			var labels = state.days[dateString];
			if (labels && labels.length) {
				var box = document.createElement('span');
				box.className = 'cell__labels';
				for (var j = 0; j < labels.length; j++) {
					var chip = document.createElement('span');
					chip.className = 'chip chip--' + LABEL_TYPES[labels[j].type].modifier;
					chip.textContent = LABEL_TYPES[labels[j].type].name;
					box.appendChild(chip);
				}
				cell.appendChild(box);
			}

			el.calGrid.appendChild(cell);
		}
	}

	/* =========================
	   選択状態の描画
	========================= */
	function renderSelection() {
		if (!state.selected.length) {
			el.selectionText.textContent = '日付が選択されていません';
		} else if (state.selected.length === 1) {
			el.selectionText.textContent = displayDate(state.selected[0]);
		} else {
			el.selectionText.textContent =
				displayDate(state.selected[0]) + ' ほか' + (state.selected.length - 1) + '日';
		}

		/* 日付が選ばれていなければ適用も削除もできない */
		var hasSelection = state.selected.length > 0;
		el.apply.disabled = !hasSelection;
		el.remove.disabled = !hasSelection;
	}

	function renderDirty() {
		if (state.dirty) {
			el.dirtyMark.removeAttribute('hidden');
		} else {
			el.dirtyMark.setAttribute('hidden', 'hidden');
		}
	}

	/* 種別を選んだときの処理．
	   その種別の «既定の内容» を入力欄へ流し込み，毎回打ち直す手間を無くす．
	   ただし手で書き換えた内容があるときは黙って消さず確認する．
	   «種別を押しただけで入力が消えた» は事故として重い． */
	function selectType(type) {
		var preset = findDefaultPreset(type);

		if (!preset) {
			/* 既定が見つからない（プリセットを消した等）．種別だけ切り替える */
			state.draftType = type;
			renderEditor();
			return;
		}

		if (!hasHandEditedInput()) {
			loadIntoEditor(mergeType(preset, type));
			return;
		}

		confirmDialog(
			'入力内容を差し替えますか？',
			'<p>いま入力されている内容を破棄して，「' + LABEL_TYPES[type].name +
				'」の既定内容に置き換えます．</p>' +
				'<p class="warn">「そのまま」を選ぶと，種別だけを変えて入力は残します．</p>',
			'差し替える',
			false
		).then(function (approved) {
			if (approved) {
				loadIntoEditor(mergeType(preset, type));
				showToast('「' + LABEL_TYPES[type].name + '」の既定内容を読み込みました');
			} else {
				state.draftType = type;
				renderEditor();
			}
		});
	}

	/* プリセットの中身に，選ばれた種別を被せたものを返す．
	   プリセット側の type を信用しすぎると，取り違えたときに
	   «押した種別と違うラベルが付く» ので，必ず引数を優先する． */
	function mergeType(preset, type) {
		return {
			type: type,
			time: preset.time || '',
			kind: preset.kind || '',
			target: preset.target || ''
		};
	}

	/* 種別に対応する既定プリセットを探す．
	   isDefault が付いたものを優先し，無ければ同じ種別の先頭で代用する．
	   既定を削除されても «何も入らない» 状態にしないための保険． */
	function findDefaultPreset(type) {
		var fallback = null;
		for (var i = 0; i < state.presets.length; i++) {
			var preset = state.presets[i];
			if (preset.type !== type) {
				continue;
			}
			if (preset.isDefault) {
				return preset;
			}
			if (!fallback) {
				fallback = preset;
			}
		}
		return fallback;
	}

	/* 入力欄に何か書かれているか（3欄のいずれか） */
	function hasAnyInput() {
		return !!(el.inputTime.value || el.inputKind.value || el.inputTarget.value);
	}

	/* 入力欄が «手で書き換えられているか» を判定する．
	   空のとき，またはいずれかのプリセットそのままのときは
	   «呼び出した直後» とみなし，消えて困るものは無いと扱う． */
	function hasHandEditedInput() {
		var time = el.inputTime.value;
		var kind = el.inputKind.value;
		var target = el.inputTarget.value;

		if (!time && !kind && !target) {
			return false;
		}

		for (var i = 0; i < state.presets.length; i++) {
			var preset = state.presets[i];
			if ((preset.time || '') === time
				&& (preset.kind || '') === kind
				&& (preset.target || '') === target) {
				return false;
			}
		}
		return true;
	}

	/* =========================
	   編集パネルの描画
	========================= */
	function renderEditor() {
		var buttons = el.typeButtons.querySelectorAll('.type-btn');
		for (var i = 0; i < buttons.length; i++) {
			var isActive = buttons[i].getAttribute('data-type') === state.draftType;
			buttons[i].className = isActive ? 'type-btn is-active' : 'type-btn';
			buttons[i].setAttribute('aria-pressed', isActive ? 'true' : 'false');
		}

		/* 休診は詳細が任意であることを見た目と文言で伝える */
		var isClosed = state.draftType === 'closed';
		el.fields.className = isClosed ? 'fields is-optional' : 'fields';
		if (isClosed) {
			el.closedNote.removeAttribute('hidden');
		} else {
			el.closedNote.setAttribute('hidden', 'hidden');
		}

		updateCounters();
	}

	function updateCounters() {
		var pairs = [
			[el.inputTime, el.counterTime],
			[el.inputKind, el.counterKind],
			[el.inputTarget, el.counterTarget]
		];
		for (var i = 0; i < pairs.length; i++) {
			/* 装飾タグは数えない．タグのぶんで書ける文字が減ると，
			   装飾を付けた行だけ短く書かねばならず運用上わかりにくい． */
			var length = plainLength(pairs[i][0].value);
			pairs[i][1].textContent = length + ' / ' + MAX_TEXT_LENGTH;
			pairs[i][1].className = length > MAX_TEXT_LENGTH ? 'counter is-over' : 'counter';
		}
	}

	function renderPresets() {
		el.presetList.innerHTML = '';

		if (!state.presets.length) {
			var empty = document.createElement('li');
			empty.textContent = 'プリセットはありません';
			el.presetList.appendChild(empty);
			return;
		}

		state.presets.forEach(function (preset, index) {
			var item = document.createElement('li');

			var name = document.createElement('span');
			name.textContent = preset.name;
			item.appendChild(name);

			var actions = document.createElement('span');
			actions.className = 'preset-list__actions';

			var applyButton = document.createElement('button');
			applyButton.type = 'button';
			applyButton.className = 'btn btn--ghost btn--small';
			applyButton.textContent = '呼出';
			applyButton.addEventListener('click', function () {
				loadIntoEditor(preset);
				showToast('プリセット「' + preset.name + '」を読み込みました');
			});
			actions.appendChild(applyButton);

			var deleteButton = document.createElement('button');
			deleteButton.type = 'button';
			deleteButton.className = 'btn btn--danger-ghost btn--small';
			deleteButton.textContent = '削除';
			deleteButton.addEventListener('click', function () {
				deletePreset(index);
			});
			actions.appendChild(deleteButton);

			item.appendChild(actions);
			el.presetList.appendChild(item);
		});
	}

	function renderBackups(backups) {
		el.backupSelect.innerHTML = '';
		if (!backups.length) {
			var option = document.createElement('option');
			option.textContent = 'バックアップはありません';
			option.value = '';
			el.backupSelect.appendChild(option);
			el.restore.disabled = true;
			return;
		}
		el.restore.disabled = false;
		backups.forEach(function (backup) {
			var option = document.createElement('option');
			option.value = backup.name;
			option.textContent = backup.label;
			el.backupSelect.appendChild(option);
		});
	}

	function renderAll() {
		renderCalendar();
		renderSelection();
		renderEditor();
		renderDirty();
		refreshPreview();
	}

	/* =========================
	   編集パネルの読み書き
	========================= */
	function loadIntoEditor(label) {
		state.draftType = label.type || 'vaccination';
		el.inputTime.value = label.time || '';
		el.inputKind.value = label.kind || '';
		el.inputTarget.value = label.target || '';
		renderEditor();
	}

	function readEditor() {
		return {
			type: state.draftType,
			time: el.inputTime.value.trim(),
			kind: el.inputKind.value.trim(),
			target: el.inputTarget.value.trim()
		};
	}

	/* =========================
	   日付の選択
	========================= */
	function selectDate(dateString, withShift) {
		/* Shift＋クリックは，直前の起点からの範囲をまとめて選ぶ */
		if (withShift && state.anchor) {
			var from = state.anchor < dateString ? state.anchor : dateString;
			var to = state.anchor < dateString ? dateString : state.anchor;
			var cursor = parseDate(from);
			var end = parseDate(to);
			var range = [];
			while (cursor <= end) {
				range.push(formatDate(cursor));
				cursor.setDate(cursor.getDate() + 1);
			}
			state.selected = range;
		} else if (state.multi) {
			/* 複数日選択モードでは，押すたびに追加・解除する */
			var position = state.selected.indexOf(dateString);
			if (position === -1) {
				state.selected.push(dateString);
				state.selected.sort();
			} else {
				state.selected.splice(position, 1);
			}
			state.anchor = dateString;
		} else {
			state.selected = [dateString];
			state.anchor = dateString;
		}

		/* 単日を選び，そこに1件だけラベルがあるなら編集パネルへ読み込む */
		if (state.selected.length === 1) {
			var labels = state.days[state.selected[0]];
			if (labels && labels.length === 1) {
				loadIntoEditor(labels[0]);
			}
		}

		renderCalendar();
		renderSelection();
	}

	/* =========================
	   ラベルの適用
	========================= */
	function applyToSelection() {
		if (!state.selected.length) {
			return Promise.resolve();
		}

		var label = readEditor();

		/* 上限を超えていたら止める（サーバでも弾くが，先に気づけるようにする） */
		var fields = ['time', 'kind', 'target'];
		for (var i = 0; i < fields.length; i++) {
			if (plainLength(label[fields[i]]) > MAX_TEXT_LENGTH) {
				showToast('入力が' + MAX_TEXT_LENGTH + '字を超えています．', true);
				return Promise.resolve();
			}
		}

		/* 休診と接種系は同居できない．置き換えになる日を数えて確認を出す． */
		var conflicts = state.selected.filter(function (dateString) {
			var labels = state.days[dateString] || [];
			return labels.some(function (existing) {
				return (existing.type === 'closed') !== (label.type === 'closed');
			});
		});

		var confirmation = Promise.resolve(true);
		if (conflicts.length) {
			var listHtml = conflicts.slice(0, 10).map(function (dateString) {
				var names = state.days[dateString].map(function (existing) {
					return LABEL_TYPES[existing.type].name;
				}).join('・');
				return '<li>' + escapeHtml(displayDate(dateString)) + '：' + escapeHtml(names) + '</li>';
			}).join('');
			if (conflicts.length > 10) {
				listHtml += '<li>ほか' + (conflicts.length - 10) + '日</li>';
			}
			confirmation = confirmDialog(
				'既存のラベルを置き換えます',
				'<p>次の日には，いま指定した種別と同居できないラベルが登録されています．' +
				'「' + escapeHtml(LABEL_TYPES[label.type].name) + '」に置き換えますか？</p><ul>' + listHtml + '</ul>',
				'置き換える',
				true
			);
		}

		return confirmation.then(function (approved) {
			if (!approved) {
				return;
			}

			state.selected.forEach(function (dateString) {
				var labels = state.days[dateString] || [];

				/* 休診への切り替え，または休診からの切り替えでは既存を捨てる */
				var hasClosed = labels.some(function (existing) { return existing.type === 'closed'; });
				if (label.type === 'closed' || hasClosed) {
					labels = [];
				}

				/* 同じ種別が既にあれば内容を差し替える */
				labels = labels.filter(function (existing) { return existing.type !== label.type; });

				var stored = { type: label.type };
				if (label.time) { stored.time = label.time; }
				if (label.kind) { stored.kind = label.kind; }
				if (label.target) { stored.target = label.target; }
				labels.push(stored);

				/* 表示順を固定する */
				labels.sort(function (a, b) {
					return TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
				});

				state.days[dateString] = labels;
			});

			state.lastApplied = label;
			state.dirty = true;
			renderAll();
			showToast(state.selected.length + '日に「' + LABEL_TYPES[label.type].name + '」を適用しました（未保存）');
		});
	}

	/* =========================
	   ラベルの削除
	========================= */
	function removeFromSelection() {
		var targets = state.selected.filter(function (dateString) {
			return state.days[dateString] && state.days[dateString].length;
		});

		if (!targets.length) {
			showToast('選択した日にラベルはありません．');
			return;
		}

		var listHtml = targets.slice(0, 10).map(function (dateString) {
			return '<li>' + escapeHtml(displayDate(dateString)) + '</li>';
		}).join('');
		if (targets.length > 10) {
			listHtml += '<li>ほか' + (targets.length - 10) + '日</li>';
		}

		confirmDialog(
			'ラベルを削除します',
			'<p>次の' + targets.length + '日から，登録済みのラベルをすべて取り除きます．</p><ul>' + listHtml + '</ul>',
			'削除する',
			true
		).then(function (approved) {
			if (!approved) {
				return;
			}
			targets.forEach(function (dateString) {
				delete state.days[dateString];
			});
			state.dirty = true;
			renderAll();
			showToast(targets.length + '日のラベルを削除しました（未保存）');
		});
	}

	/* =========================
	   保存
	========================= */
	/* 差分1種類ぶんのリスト項目を組み立てる．
	   削除された日は state.days に無いので savedSnapshot 側から名前を引く． */
	function diffListHtml(prefix, dates) {
		if (!dates.length) {
			return '';
		}

		var items = dates.slice(0, 10).map(function (dateString) {
			var labels = state.days[dateString] || savedSnapshot[dateString] || [];
			var names = labels.map(function (label) {
				return LABEL_TYPES[label.type].name;
			}).join('・');
			return '<li>' + escapeHtml(prefix) + '：' + escapeHtml(displayDate(dateString)) +
				(names ? '（' + escapeHtml(names) + '）' : '') + '</li>';
		}).join('');

		if (dates.length > 10) {
			items += '<li>ほか' + (dates.length - 10) + '日</li>';
		}
		return items;
	}

	/* 他の画面が先に保存していたときの救済．
	   サーバは «上書き事故» を防ぐために保存を拒否する（409）．
	   ここで «再読み込みしてやり直す» を促すと，未保存の変更が全部消える．
	   最新を土台にして自分の変更を乗せ直す道を用意する． */
	function offerConflictMerge() {
		var diff = diffFromSaved();
		var mineCount = diff.added.length + diff.changed.length + diff.removed.length;

		confirmDialog(
			'他のタブで先に保存されています',
			/* 静的版はブラウザ内に保存するため，検知できるのは同じブラウザの別タブのみ．
			   別のPCとの競合はサーバが居ないので検知できない（README に明記）． */
			'<p>このブラウザの別のタブで先に保存が行われました．' +
			'このまま保存すると相手の変更を消してしまうため，いったん止めました．</p>' +
			'<p><strong>いまの入力（' + mineCount + '日ぶんの変更）は残っています．</strong></p>' +
			'<p>「最新を取り込む」を押すと，先に保存された内容を土台にして，' +
			'あなたの変更を乗せ直します．そのあともう一度「保存して更新」を押してください．</p>',
			'最新を取り込む',
			false
		).then(function (approved) {
			if (!approved) {
				showBanner('保存していません．いまの入力は残っているので，' +
					'「保存して更新」からやり直せます．');
				return;
			}
			mergeLatest();
		});
	}

	/* 最新を取り込み，自分の変更だけを乗せ直す */
	function mergeLatest() {
		request('/api/bootstrap').then(function (result) {
			if (result.status !== 200) {
				handleApiError(result);
				return;
			}

			var latest = (result.body.schedule && result.body.schedule.days) || {};
			var diff = diffFromSaved();

			/* 自分が触った日のうち，相手も変えていた日を «競合» として知らせる．
			   黙って上書きすると，相手の入力が理由も分からず消える． */
			var mine = diff.added.concat(diff.changed).concat(diff.removed);
			var collided = mine.filter(function (dateString) {
				return JSON.stringify(latest[dateString]) !== JSON.stringify(savedSnapshot[dateString]);
			});

			/* 最新を土台に，自分が触った日だけを乗せ直す */
			var merged = JSON.parse(JSON.stringify(latest));
			diff.added.concat(diff.changed).forEach(function (dateString) {
				merged[dateString] = state.days[dateString];
			});
			diff.removed.forEach(function (dateString) {
				delete merged[dateString];
			});

			state.days = merged;
			state.baseGeneratedAt = (result.body.schedule && result.body.schedule.generatedAt) || '';
			/* 土台は «相手が保存した内容»．ここを基準にすれば，
			   次の保存確認では自分の変更だけが «今回の変更» として並ぶ． */
			takeSavedSnapshot(latest);
			state.dirty = true;

			renderAll();
			updateLastUpdated();
			loadBackups();

			if (collided.length) {
				showBanner('最新を取り込みました．次の日は他の画面でも変更されていたため，' +
					'あなたの入力で上書きされます：' +
					collided.map(displayDate).join('，') +
					'　内容を確かめてから保存してください．');
			} else {
				hideBanner();
			}
			showToast('最新を取り込みました．もう一度「保存して更新」を押してください．');
		}).catch(function (error) {
			showToast('最新を取り込めませんでした: ' + error, true);
		});
	}

	function save() {
		var dates = Object.keys(state.days).sort();

		/* 種別ごとの件数を数えて，何を公開しようとしているかを見せる */
		var counts = { vaccination: 0, holiday_vaccination: 0, closed: 0 };
		var pastDates = [];
		dates.forEach(function (dateString) {
			state.days[dateString].forEach(function (label) {
				counts[label.type] += 1;
			});
			if (dateString < state.today) {
				pastDates.push(dateString);
			}
		});

		/* «今回どこを変えたか» を先に見せる．
		   総数だけだと «適用を押し忘れて何も変わっていない» ことに気づけず，
		   «登録したのに反映されない» という結末になる． */
		var diff = diffFromSaved();
		var changeCount = diff.added.length + diff.changed.length + diff.removed.length;

		var bodyHtml = '';
		if (changeCount === 0) {
			bodyHtml +=
				'<p class="warn">前回の保存から<strong>変更がありません</strong>．' +
				'日付を選んで種別と内容を決めたあと，' +
				'「選択日に適用」を押し忘れていないか確認してください．</p>';
		} else {
			bodyHtml += '<p>今回の変更（' + changeCount + '日ぶん）</p><ul>' +
				diffListHtml('追加', diff.added) +
				diffListHtml('変更', diff.changed) +
				diffListHtml('削除', diff.removed) +
				'</ul>';
		}

		bodyHtml +=
			'<p>保存後の全体</p><ul>' +
			'<li>登録日数：' + dates.length + '日</li>' +
			'<li>接種対応：' + counts.vaccination + '件</li>' +
			'<li>休日接種：' + counts.holiday_vaccination + '件</li>' +
			'<li>休診：' + counts.closed + '件</li>' +
			'</ul>';

		if (pastDates.length) {
			bodyHtml += '<p class="warn">過去の日付が' + pastDates.length + '日ぶん含まれています（' +
				escapeHtml(displayDate(pastDates[0])) + ' など）．月を間違えていないか確認してください．</p>';
		}
		if (!state.previewOpened) {
			bodyHtml += '<p class="warn">プレビューをまだ確認していません．公開前の見た目を確認することをおすすめします．</p>';
		}

		confirmDialog('保存して更新', bodyHtml, '保存する', false).then(function (approved) {
			if (!approved) {
				return;
			}

			el.save.disabled = true;
			request('/api/schedule', {
				days: state.days,
				baseGeneratedAt: state.baseGeneratedAt
			}).then(function (result) {
				el.save.disabled = false;

				if (result.status !== 200) {
					/* 競合は «やり直し» ではなく «取り込み» で解決する．
					   再読み込みを促すと未保存の変更が全部消えてしまう． */
					if (result.body && result.body.code === 'conflict') {
						offerConflictMerge();
						return;
					}
					handleApiError(result);
					return;
				}

				hideBanner();
				state.days = result.body.schedule.days || {};
				state.baseGeneratedAt = result.body.schedule.generatedAt;
				/* 保存できた内容が次の «変更前» になる */
				takeSavedSnapshot(state.days);
				state.dirty = false;
				renderAll();
				updateLastUpdated();
				loadBackups();
				var saveMirrorNote = mirrorWarningText(result);
				/* 静的版の «保存» はファイルを落とすところまで．
				   FTPを促さないと «保存したのに本番が変わらない» が起きる． */
				showToast('保存しました．ScheduleData.js をダウンロードしました．FTPでアップロードすると公開されます' + saveMirrorNote, saveMirrorNote !== '');
			}).catch(function (error) {
				el.save.disabled = false;
				showToast('保存に失敗しました: ' + error, true);
			});
		});
	}

	function updateLastUpdated() {
		/* 「2026-08-25T12:30:00+09:00」を「2026/08/25 12:30」に整える */
		var value = state.baseGeneratedAt;
		if (!value) {
			el.lastUpdated.textContent = '最終更新: まだ保存されていません';
			return;
		}
		var matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
		el.lastUpdated.textContent = matched
			? '最終更新: ' + matched[1] + '/' + matched[2] + '/' + matched[3] + ' ' + matched[4] + ':' + matched[5]
			: '最終更新: ' + value;
	}

	/* =========================
	   バックアップ
	========================= */
	function loadBackups() {
		request('/api/backups').then(function (result) {
			if (result.status === 200) {
				renderBackups(result.body.backups || []);
			}
		}).catch(function () {
			/* 一覧が引けなくても編集は続けられるので黙って諦める */
		});
	}

	function restore() {
		var name = el.backupSelect.value;
		if (!name) {
			return;
		}
		var label = el.backupSelect.options[el.backupSelect.selectedIndex].textContent;

		confirmDialog(
			'バックアップから復元します',
			'<p>' + escapeHtml(label) + ' 時点の内容で上書きします．</p>' +
			'<p class="warn">いま画面にある未保存の変更は失われます．</p>',
			'復元する',
			true
		).then(function (approved) {
			if (!approved) {
				return;
			}
			request('/api/restore', { name: name }).then(function (result) {
				if (result.status !== 200) {
					handleApiError(result);
					return;
				}
				hideBanner();
				state.days = result.body.schedule.days || {};
				state.baseGeneratedAt = result.body.schedule.generatedAt;
				/* 保存できた内容が次の «変更前» になる */
				takeSavedSnapshot(state.days);
				state.dirty = false;
				state.selected = [];
				renderAll();
				updateLastUpdated();
				loadBackups();
				var restoreMirrorNote = mirrorWarningText(result);
				/* 復元も1回の保存として扱うため，ここでもファイルが落ちる */
				showToast('復元しました．ScheduleData.js をダウンロードしました．FTPでアップロードすると公開されます' + restoreMirrorNote, restoreMirrorNote !== '');
			});
		});
	}

	/* =========================
	   プリセット
	========================= */
	function savePreset() {
		var label = readEditor();

		promptDialog(
			'プリセットに保存',
			'プリセット名',
			LABEL_TYPES[label.type].name + ' 標準'
		).then(function (name) {
			if (!name) {
				return;
			}
			var preset = {
				name: name,
				type: label.type,
				time: label.time,
				kind: label.kind,
				target: label.target
			};
			persistPresets(state.presets.concat([preset]), 'プリセットを保存しました');
		});
	}

	function deletePreset(index) {
		var presets = state.presets.slice();
		var removed = presets.splice(index, 1)[0];
		confirmDialog(
			'プリセットを削除します',
			'<p>「' + escapeHtml(removed.name) + '」を削除します．</p>',
			'削除する',
			true
		).then(function (approved) {
			if (approved) {
				persistPresets(presets, 'プリセットを削除しました');
			}
		});
	}

	function persistPresets(presets, message) {
		request('/api/presets', { presets: presets }).then(function (result) {
			if (result.status !== 200) {
				handleApiError(result);
				return;
			}
			state.presets = result.body.presets;
			renderPresets();
			showToast(message);
		});
	}

	/* =========================
	   プレビュー
	   LPの実ファイル（style.css / CalendarSchedule.js）を読み込む
	   iframe を作ってあるので，データを渡して読み込み直すだけでよい．
	========================= */
	function refreshPreview() {
		/* 開いていない，またはまだ一度も読み込んでいなければ何もしない */
		if (!state.previewOpened || !el.previewFrame.getAttribute('src')) {
			return;
		}
		try {
			el.previewFrame.contentWindow.location.reload();
		} catch (error) {
			/* 読み込み前などは失敗しうるが，実害はない */
		}
	}

	/* プレビュー側から呼ばれる．編集中の内容をLPと同じ形で渡す． */
	window.BuildPreviewSchedule = function () {
		return {
			schemaVersion: 1,
			generatedAt: state.baseGeneratedAt,
			meta: {},
			days: state.days
		};
	};

	/* プレビューに最初に表示させる月 */
	window.GetPreviewMonth = function () {
		return { year: state.year, month: state.month };
	};

	function togglePreview() {
		state.previewOpened = !state.previewOpened;
		if (state.previewOpened) {
			el.previewBody.removeAttribute('hidden');
			el.previewToggle.textContent = 'プレビューを閉じる';

			/* 初回だけ読み込む．2回目以降は再読み込みで最新の編集内容を反映する */
			if (!el.previewFrame.getAttribute('src')) {
				/* 静的版は公開ルート直下が index.html なので相対パスで指す．
				   絶対パス（/Static/…）だと，リポジトリ名を含む
				   GitHub Pages の URL では404になる． */
				el.previewFrame.setAttribute('src', 'Assets/Preview.html');
			} else {
				refreshPreview();
			}
		} else {
			el.previewBody.setAttribute('hidden', 'hidden');
			el.previewToggle.textContent = 'プレビューを開く';
		}
	}

	/* =========================
	   月送り
	========================= */
	function moveMonth(step) {
		var date = new Date(state.year, state.month + step, 1);
		state.year = date.getFullYear();
		state.month = date.getMonth();
		renderCalendar();
	}

	/* =========================
	   初期化
	========================= */
	function cacheElements() {
		el.banner = document.getElementById('banner');
		el.toast = document.getElementById('toast');
		el.lastUpdated = document.getElementById('last-updated');
		el.dirtyMark = document.getElementById('dirty-mark');

		el.calTitle = document.getElementById('cal-title');
		el.calGrid = document.getElementById('cal-grid');
		el.prevMonth = document.getElementById('prev-month');
		el.nextMonth = document.getElementById('next-month');
		el.multiMode = document.getElementById('multi-mode');

		el.selectionText = document.getElementById('selection-text');
		el.clearSelection = document.getElementById('clear-selection');
		el.typeButtons = document.querySelector('.type-buttons');
		el.fields = document.getElementById('detail-fields');
		el.closedNote = document.getElementById('closed-note');
		el.inputTime = document.getElementById('input-time');
		el.inputKind = document.getElementById('input-kind');
		el.inputTarget = document.getElementById('input-target');
		el.counterTime = document.getElementById('counter-time');
		el.counterKind = document.getElementById('counter-kind');
		el.counterTarget = document.getElementById('counter-target');

		el.apply = document.getElementById('apply');
		el.remove = document.getElementById('remove');
		el.duplicate = document.getElementById('duplicate');
		el.save = document.getElementById('save');

		el.presetList = document.getElementById('preset-list');
		el.presetSave = document.getElementById('preset-save');
		el.backupSelect = document.getElementById('backup-select');
		el.restore = document.getElementById('restore');

		/* 静的版だけの操作 */
		el.importButton = document.getElementById('import');
		el.importInput = document.getElementById('import-file');
		el.downloadPublish = document.getElementById('download-publish');
		el.downloadJson = document.getElementById('download-json');

		el.previewToggle = document.getElementById('preview-toggle');
		el.previewBody = document.getElementById('preview-body');
		el.previewFrame = document.getElementById('preview-frame');

		el.dialog = document.getElementById('dialog');
		el.dialogTitle = document.getElementById('dialog-title');
		el.dialogBody = document.getElementById('dialog-body');
		el.dialogOk = document.getElementById('dialog-ok');
		el.dialogCancel = document.getElementById('dialog-cancel');
		el.dialogBackdrop = document.querySelector('.dialog__backdrop');
	}

	/* =========================
	   文字装飾のツールバー
	   3つの入力欄それぞれの上に，同じ構成のボタン列を作る．
	   HTMLに3回書かずJSで生成しているのは，装飾を足すときに
	   ここ1箇所を直せば済むようにするため．
	========================= */
	function buildDecorationToolbars() {
		var targets = [el.inputTime, el.inputKind, el.inputTarget];
		for (var i = 0; i < targets.length; i++) {
			targets[i].parentNode.insertBefore(
				buildDecorationToolbar(targets[i]),
				targets[i]
			);
		}
	}

	function buildDecorationToolbar(textarea) {
		var bar = document.createElement('div');
		bar.className = 'deco-toolbar';
		bar.setAttribute('role', 'group');
		bar.setAttribute('aria-label', '文字装飾');

		decorationButtons.forEach(function (definition) {
			var button = document.createElement('button');
			button.type = 'button';
			button.className = 'deco-btn deco-btn--' + definition.modifier;
			button.textContent = definition.label;
			button.title = definition.title;
			/* 見た目の記号だけでは何のボタンか読み上げられないため補う */
			button.setAttribute('aria-label', definition.title);
			button.addEventListener('click', function () {
				wrapSelection(textarea, definition.tag);
			});
			bar.appendChild(button);
		});

		/* 解除は他と役割が違うので少し離して置く */
		var clearButton = document.createElement('button');
		clearButton.type = 'button';
		clearButton.className = 'deco-btn deco-btn--clear';
		clearButton.textContent = '解除';
		clearButton.title = '選択範囲の装飾を外す（選択していなければ全体）';
		clearButton.setAttribute('aria-label', '装飾を解除');
		clearButton.addEventListener('click', function () {
			clearSelectionDecoration(textarea);
		});
		bar.appendChild(clearButton);

		return bar;
	}

	/* 選択範囲を装飾タグで囲む．
	   選択していない場合は空のタグを入れ，カーソルを間に置く
	   （これから書く文字がそのまま装飾される）． */
	function wrapSelection(textarea, tag) {
		var start = textarea.selectionStart;
		var end = textarea.selectionEnd;
		var value = textarea.value;
		var selected = value.slice(start, end);
		var openTag = '[' + tag + ']';
		var closeTag = '[/' + tag + ']';

		textarea.value = value.slice(0, start) + openTag + selected + closeTag + value.slice(end);

		/* 囲んだ文字を選択したまま残す．続けて別の装飾を重ねられる． */
		textarea.focus();
		textarea.setSelectionRange(
			start + openTag.length,
			start + openTag.length + selected.length
		);

		updateCounters();
	}

	/* 選択範囲から装飾タグを取り除く．
	   選択していない場合は «全部消したい» という意図とみなし，欄全体を対象にする． */
	function clearSelectionDecoration(textarea) {
		var start = textarea.selectionStart;
		var end = textarea.selectionEnd;
		var value = textarea.value;

		if (start === end) {
			start = 0;
			end = value.length;
		}

		var cleaned = value.slice(start, end).replace(DECORATION_TAG_PATTERN, '');
		textarea.value = value.slice(0, start) + cleaned + value.slice(end);

		textarea.focus();
		textarea.setSelectionRange(start, start + cleaned.length);

		updateCounters();
	}

	function bindEvents() {
		/* セルは作り直されるので，親要素で委譲して受ける */
		el.calGrid.addEventListener('click', function (event) {
			var cell = event.target.closest('.cell');
			if (cell && !cell.disabled) {
				selectDate(cell.getAttribute('data-date'), event.shiftKey);
			}
		});

		el.prevMonth.addEventListener('click', function () { moveMonth(-1); });
		el.nextMonth.addEventListener('click', function () { moveMonth(1); });

		el.multiMode.addEventListener('change', function () {
			state.multi = el.multiMode.checked;
			/* 単日モードへ戻したときは選択を1つに絞る */
			if (!state.multi && state.selected.length > 1) {
				state.selected = state.selected.slice(0, 1);
				renderCalendar();
				renderSelection();
			}
		});

		el.clearSelection.addEventListener('click', function () {
			state.selected = [];
			state.anchor = null;
			renderCalendar();
			renderSelection();
		});

		el.typeButtons.addEventListener('click', function (event) {
			var button = event.target.closest('.type-btn');
			if (!button) {
				return;
			}
			var nextType = button.getAttribute('data-type');

			/* 同じ種別を押し直したときの扱い．
			   «既に既定（またはプリセット）が入っている» ときだけ何もしない．
			   手で書き換えた内容が入っている場合は selectType へ進め，
			   確認のうえで «既定へ戻す» 道を残す．
			   ここを «入力があるか» で弾くと，前の日の内容が残ったまま
			   押しても無反応になり，既定へ戻す手段が無くなってしまう．
			   （画面を開いた直後は draftType が既定値で埋まっているため，
			     空のときも必ず処理を進める必要がある） */
			if (nextType === state.draftType && hasAnyInput() && !hasHandEditedInput()) {
				return;
			}
			selectType(nextType);
		});

		[el.inputTime, el.inputKind, el.inputTarget].forEach(function (input) {
			input.addEventListener('input', updateCounters);
		});

		el.apply.addEventListener('click', applyToSelection);
		el.remove.addEventListener('click', removeFromSelection);
		el.save.addEventListener('click', save);
		el.restore.addEventListener('click', restore);
		el.presetSave.addEventListener('click', savePreset);
		el.previewToggle.addEventListener('click', togglePreview);

		/* 隠したファイル選択欄を，見た目を整えたボタンから開く */
		el.importButton.addEventListener('click', function () {
			el.importInput.click();
		});

		el.importInput.addEventListener('change', function () {
			importFromFile(el.importInput.files[0]);
			/* 同じファイルを続けて選び直せるように毎回空にする．
			   値が残っていると change が発火しない． */
			el.importInput.value = '';
		});

		el.downloadPublish.addEventListener('click', function () { downloadOne('publish'); });
		el.downloadJson.addEventListener('click', function () { downloadOne('json'); });

		el.duplicate.addEventListener('click', function () {
			if (!state.lastApplied) {
				showToast('複製できる入力がまだありません．');
				return;
			}
			loadIntoEditor(state.lastApplied);
			showToast('直前の入力を読み込みました');
		});

		/* 未保存のままタブを閉じようとしたら引き止める */
		window.addEventListener('beforeunload', function (event) {
			if (state.dirty) {
				event.preventDefault();
				event.returnValue = '';
			}
		});
	}

	/* =========================
	   静的版だけの機能：ファイルの取り込みと落とし直し

	   サーバ版は共有フォルダの正本を直接読んでいたので，
	   «いま本番に出ている内容» は常に手に入った．
	   静的版にはその経路が無いため，
	   ・本番LPのURLが設定されていれば起動時に自動で取り込む
	   ・設定されていなければ，ここでファイルから取り込む
	   の2通りを用意する．
	========================= */

	/* 起動時にどの内容を土台にしたかを知らせる．
	   «何を土台に編集しているか» が分からないまま保存すると，
	   空の内容で本番を上書きする事故につながる．必ず伝える． */
	function announceSource(body) {
		/* ブラウザに保存できない環境では，まずそれを伝える（最も影響が大きい） */
		if (body.storageAvailable === false) {
			showBanner('このブラウザには編集内容を保存できません（プライベートウィンドウなどの制限）．' +
				'タブを閉じると入力が消えます．こまめに「保存して更新」でファイルを落としてください．');
			return;
		}

		if (body.source === 'production') {
			showToast('本番サイトの現在の内容を読み込みました');
			return;
		}

		if (body.source === 'local-newer') {
			showToast('前回の続きから編集できます（本番サイトより新しい未アップロードの内容があります）');
			return;
		}

		/* 何も無い状態は，そのまま保存すると本番を空にしてしまう．
		   静的版でいちばん危ないのがこの場面なので，
		   «本番に到達できなかった» より先に，こちらを必ず伝える．
		   （到達できず，かつ手元も空，という最悪の組み合わせで
		     弱いほうの警告だけが出ることがないようにする） */
		if (body.isEmpty) {
			var reason = (body.source === 'production-unreachable')
				? '本番サイトの内容を取得できず，'
				: '';
			showBanner(reason + '登録内容が空の状態で開いています．' +
				'このまま保存すると本番サイトの登録がすべて消えます．' +
				'まず「ファイルから読み込む」で現在の ScheduleData.js を取り込んでください．');
			return;
		}

		if (body.source === 'production-unreachable') {
			showBanner('本番サイトの内容を取得できませんでした．' +
				'このブラウザに残っている内容で開いています．' +
				'内容が古い可能性があるため，必要なら「ファイルから読み込む」で現在の内容を取り込んでください．');
		}
	}

	/* 選ばれたファイルを取り込む．schedule.json / ScheduleData.js のどちらでもよい */
	function importFromFile(file) {
		if (!file) {
			return;
		}

		var reader = new FileReader();

		reader.onload = function () {
			var imported;
			try {
				imported = window.FluLocalApi.parseScheduleText(reader.result);
			} catch (error) {
				showToast(error.message || 'ファイルを読み取れませんでした．', true);
				return;
			}

			var dayCount = Object.keys(imported.days || {}).length;
			var warning = state.dirty
				? '<p class="warn">いま画面にある未保存の変更は失われます．</p>'
				: '';

			confirmDialog(
				'ファイルから読み込みます',
				'<p>' + escapeHtml(file.name) + ' の内容（' + dayCount + '日ぶん）で置き換えます．</p>' +
				warning,
				'読み込む',
				state.dirty
			).then(function (approved) {
				if (!approved) {
					return;
				}

				/* 取り込んだ内容を «保存済みの土台» として据える．
				   ここで据えておかないと，次の保存で
				   «他のタブで先に保存されています» と誤検知される． */
				window.FluLocalApi.adoptSchedule(imported);

				hideBanner();
				state.days = imported.days || {};
				state.baseGeneratedAt = imported.generatedAt || '';
				takeSavedSnapshot(state.days);
				state.dirty = false;
				state.selected = [];
				state.anchor = null;

				renderAll();
				updateLastUpdated();
				loadBackups();
				showToast('読み込みました（' + dayCount + '日ぶん）');
			});
		};

		reader.onerror = function () {
			showToast('ファイルを読み込めませんでした．', true);
		};

		reader.readAsText(file, 'utf-8');
	}

	/* いまブラウザに保存されている内容を，もう一度ファイルとして落とす．
	   «保存はしたがダウンロードを取り逃した» ときの逃げ道．
	   保存し直すわけではないので generatedAt は変わらない．

	   ここで «1回の操作につき1ファイル» を守る．
	   2ファイルまとめて落とすと，Chrome が複数ダウンロードの許可を尋ね，
	   拒否されるとそれ以降このサイトのダウンロードが無言で捨てられる． */
	function downloadOne(kind) {
		request('/api/schedule').then(function (result) {
			if (result.status !== 200) {
				handleApiError(result);
				return;
			}

			var schedule = result.body.schedule;
			if (!schedule.generatedAt) {
				showToast('まだ一度も保存されていません．', true);
				return;
			}

			var warnings = (kind === 'json')
				? window.FluLocalApi.downloadJsonFile(schedule)
				: window.FluLocalApi.downloadPublishFile(schedule);

			if (warnings.length) {
				showToast(warnings.join('／'), true);
				return;
			}
			showToast((kind === 'json' ? 'schedule.json' : 'ScheduleData.js') + ' をダウンロードしました');
		});
	}

	function bootstrap() {
		request('/api/bootstrap').then(function (result) {
			if (result.status !== 200) {
				handleApiError(result);
				return;
			}

			var body = result.body;
			state.days = (body.schedule && body.schedule.days) || {};
			state.baseGeneratedAt = (body.schedule && body.schedule.generatedAt) || '';
			/* ここが «変更前» の基準になる */
			takeSavedSnapshot(state.days);
			state.presets = body.presets || [];
			state.rangeFrom = (body.displayRange && body.displayRange.from) || '';
			state.rangeTo = (body.displayRange && body.displayRange.to) || '';
			state.today = body.today || '';

			/* 開いた月は，表示期間の中に収まるように決める */
			var start = state.rangeFrom || state.today.slice(0, 7);
			var initial = state.today.slice(0, 7);
			if (state.rangeFrom && initial < state.rangeFrom) { initial = state.rangeFrom; }
			if (state.rangeTo && initial > state.rangeTo) { initial = state.rangeTo; }
			if (!initial) { initial = start; }
			state.year = parseInt(initial.slice(0, 4), 10);
			state.month = parseInt(initial.slice(5, 7), 10) - 1;

			renderAll();
			renderPresets();
			updateLastUpdated();
			loadBackups();

			/* 何を土台に開いたかを必ず伝える（静的版で最も事故が起きやすい点） */
			announceSource(body);
		}).catch(function (error) {
			showBanner('管理画面を開始できませんでした．ページを再読み込みしてください．（' + error + '）');
		});
	}

	document.addEventListener('DOMContentLoaded', function () {
		cacheElements();
		buildDecorationToolbars();
		bindEvents();
		bootstrap();
	});
})();
