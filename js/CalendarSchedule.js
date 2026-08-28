/* =========================================================
   接種可能日カレンダー：予定ラベルと詳細ポップアップ

   main.js が生成した月グリッドに対して，あとから
   「接種日 / 休日接種 / 休診」のラベルを貼り付ける．
   main.js 側のコードには一切手を加えない（既存表示の非破壊が最優先）．

   予定データは data/ScheduleData.js から読み込む．
   読み込みに失敗した場合はラベルを何も出さず，従来どおりの
   カレンダー表示のまま動作を継続する（縮退）．
========================================================= */
(function () {
	'use strict';

	/* =========================
	   ラベル種別の定義
	   表示名・色クラス・並び順はデータ側に持たせず，ここに固定で持つ．
	   不正な値が流れ込んでも見た目が壊れないようにするため．
	========================= */
	var labelTypes = {
		vaccination:         { name: '接種日', modifier: 'vaccination', order: 1 },
		holiday_vaccination: { name: '休日接種', modifier: 'holiday',     order: 2 },
		closed:              { name: '休診',     modifier: 'closed',      order: 3 }
	};

	/* このスクリプトが解釈できるデータのスキーマ版 */
	var supportedSchemaVersion = 1;

	/* 1セルに積むラベルの上限．データ異常時にセルが伸び続けるのを防ぐ */
	var maxLabelsPerDay = 2;

	/* 予定データの配信ファイル（LPルートからの相対パス） */
	var scheduleSrc = 'data/ScheduleData.js';

	/* 曜日の表示名．ポップアップの読み上げ用見出しに使う */
	var weekdayNames = ['日', '月', '火', '水', '木', '金', '土'];

	/* 文字装飾の記法．管理画面のツールバーが挿入する．
	       [b]太字[/b]  [u]下線[/u]  [red]赤[/red]  [green]緑[/green]  [gray]灰[/gray]
	   タグ名からCSSクラスへの対応表． */
	var decorationClasses = {
		b:     'is-bold',
		u:     'is-underline',
		red:   'is-red',
		green: 'is-green',
		gray:  'is-gray'
	};

	/* 走査用（g付き）．exec で1つずつ取り出す */
	var decorationPattern = /\[(\/?)(b|u|red|green|gray)\]/g;

	/* 有無の判定用（g無し）．
	   g付きの正規表現で test() を呼ぶと lastIndex が進み，
	   次の呼び出しが false になる．同じオブジェクトを使い回さない． */
	var decorationDetectPattern = /\[\/?(?:b|u|red|green|gray)\]/;

	/* 日付文字列（YYYY-MM-DD）をキーにした，正規化済みラベル配列 */
	var scheduleDays = {};

	/* 主要な要素の参照 */
	var daysElement = null;
	var monthElement = null;

	/* ポップアップは1つだけ生成して使い回す */
	var modalElements = null;

	/* ポップアップを開いた起点のセル．閉じたときにフォーカスを戻す */
	var lastFocusedCell = null;

	/* 閉じるアニメーションが終わるまでの待ち時間（ミリ秒）．
	   style.css の .cal-modal.is-closing .cal-modal__card の
	   transition-duration と必ず一致させること．
	   短すぎると消えきる前に display:none になって «ぶつ切り» に見える． */
	var closeDuration = 180;

	/* 後片付けの予約．連打されたときに予約が積み重ならないよう握っておく */
	var closeTimer = null;

	/* =========================
	   日付ユーティリティ
	   Date.toISOString() は UTC 変換で前日にずれるため使わない．
	   必ずローカル暦日から文字列を手組みする．
	========================= */
	function padZero(value) {
		return value < 10 ? '0' + value : String(value);
	}

	function formatDateString(dateObject) {
		return dateObject.getFullYear() + '-' +
			padZero(dateObject.getMonth() + 1) + '-' +
			padZero(dateObject.getDate());
	}

	/* =========================
	   データの正規化
	   受け取った生データを，描画に使える形へ整えて返す．
	   ・未知の type は捨てる
	   ・同一 type の重複は先勝ち
	   ・休診と接種系が同居していたら「休診」だけを残す（安全側に倒す）
	   ・固定の優先順で並べ，上限枚数で切る
	========================= */
	function normalizeLabels(rawList) {
		if (!rawList || Object.prototype.toString.call(rawList) !== '[object Array]') {
			return [];
		}

		var seenTypes = {};
		var normalized = [];

		for (var i = 0; i < rawList.length; i++) {
			var raw = rawList[i];

			/* オブジェクト以外・未知の種別は無視する（エラーにはしない） */
			if (!raw || !labelTypes[raw.type]) {
				continue;
			}

			/* 同じ種別が二重に入っていたら2件目以降を捨てる */
			if (seenTypes[raw.type]) {
				continue;
			}
			seenTypes[raw.type] = true;

			normalized.push({
				type: raw.type,
				time: typeof raw.time === 'string' ? raw.time : '',
				kind: typeof raw.kind === 'string' ? raw.kind : '',
				target: typeof raw.target === 'string' ? raw.target : ''
			});
		}

		/* 休診が含まれる日は，接種系ラベルを表示しない（来院させない側へ倒す） */
		if (seenTypes.closed && normalized.length > 1) {
			normalized = normalized.filter(function (label) {
				return label.type === 'closed';
			});
		}

		/* 固定の優先順に並べ替える（データの配列順は信用しない） */
		normalized.sort(function (a, b) {
			return labelTypes[a.type].order - labelTypes[b.type].order;
		});

		return normalized.slice(0, maxLabelsPerDay);
	}

	/* ラベルが詳細情報を持っているか（＝ポップアップを開く価値があるか） */
	function hasDetail(labels) {
		for (var i = 0; i < labels.length; i++) {
			if (labels[i].time || labels[i].kind || labels[i].target) {
				return true;
			}
		}
		return false;
	}

	/* =========================
	   予定データの読み込み
	   fetch ではなく script タグで読む．理由は2つ．
	   ・file:// で開いた検証時に fetch は CORS で失敗するが script は動く
	   ・?ts= を付けることでブラウザキャッシュを毎回バイパスできる
	     （FTP配信先に Cache-Control を設定できないため）
	========================= */
	function adoptSchedule() {
		try {
			var data = window.INFLU_SCHEDULE;

			/* データが無い・版が違う・days が無い場合は縮退（ラベル無し） */
			if (!data || data.schemaVersion !== supportedSchemaVersion || !data.days) {
				return;
			}

			/* 日付ごとに正規化してから保持する */
			for (var dateString in data.days) {
				if (!Object.prototype.hasOwnProperty.call(data.days, dateString)) {
					continue;
				}
				/* 日付キーの形式が想定外のものは無視する */
				if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
					continue;
				}
				var labels = normalizeLabels(data.days[dateString]);
				if (labels.length) {
					scheduleDays[dateString] = labels;
				}
			}
		} catch (error) {
			/* 何が起きてもカレンダー本体は巻き込まない */
			scheduleDays = {};
		}
	}

	function loadSchedule(onFinished) {
		/* すでに予定データが用意されている場合は，配信ファイルを取りに行かない．
		   管理画面のプレビューは，この経路で «保存前の編集中データ» を渡してくる．
		   通常のLPでは未定義なので，下の読み込み処理に進む． */
		if (window.INFLU_SCHEDULE) {
			adoptSchedule();
			onFinished();
			return;
		}

		var script = document.createElement('script');
		script.src = scheduleSrc + '?ts=' + Date.now();

		/* 読み込めたらグローバル変数を検証して取り込む */
		script.onload = function () {
			adoptSchedule();
			onFinished();
		};

		/* ファイルが無くてもカレンダーは表示し続ける．
		   なお，読み込み前に window.INFLU_SCHEDULE が用意されている場合は
		   それを採用する（管理画面のプレビューがこの経路を使う）． */
		script.onerror = function () {
			adoptSchedule();
			onFinished();
		};

		document.body.appendChild(script);
	}

	/* =========================
	   セルの日付を求める
	   main.js は data 属性を持たないため，表示内容から逆算する．
	   ・見出し「2026年8月」から当月の年月を取る
	   ・other-month のセルは，1行目なら前月・それ以外なら翌月
	========================= */
	function readDisplayedMonth() {
		var matched = /(\d+)年(\d+)月/.exec(monthElement.textContent || '');
		if (!matched) {
			return null;
		}
		return {
			year: parseInt(matched[1], 10),
			month: parseInt(matched[2], 10) - 1
		};
	}

	function resolveCellDate(cell, index, baseMonth) {
		var dateElement = cell.querySelector('.calendar-date');
		if (!dateElement) {
			return null;
		}

		var dayNumber = parseInt(dateElement.textContent, 10);
		if (isNaN(dayNumber)) {
			return null;
		}

		/* 月グリッドの前後にはみ出したセルの月をずらす（先頭行=前月，末尾行=翌月） */
		var monthOffset = 0;
		if (cell.classList.contains('other-month')) {
			monthOffset = index < 7 ? -1 : 1;
		}

		/* Date のコンストラクタが月の繰り上がり・繰り下がりを正規化してくれる */
		return formatDateString(new Date(baseMonth.year, baseMonth.month + monthOffset, dayNumber));
	}

	/* =========================
	   ラベルの描画
	   月送りのたびに main.js がセルを作り直すので，そのつど貼り直す．
	========================= */
	function applyLabels() {
		if (!daysElement || !monthElement) {
			return;
		}

		var baseMonth = readDisplayedMonth();
		if (!baseMonth) {
			return;
		}

		var cells = daysElement.querySelectorAll('.calendar-day');

		for (var i = 0; i < cells.length; i++) {
			var cell = cells[i];

			/* 二重実行に備えて，既に貼ってあるラベルを取り除く */
			var existing = cell.querySelector('.calendar-labels');
			if (existing) {
				existing.parentNode.removeChild(existing);
			}

			var dateString = resolveCellDate(cell, i, baseMonth);
			if (!dateString) {
				continue;
			}

			/* ポップアップ側から日付を引けるようセルに持たせる */
			cell.setAttribute('data-date', dateString);

			var labels = scheduleDays[dateString];
			if (!labels || !labels.length) {
				continue;
			}

			/* ラベルをまとめる箱．CSS で margin-top:auto によりセル下端へ寄せる */
			var container = document.createElement('div');
			container.className = 'calendar-labels';

			for (var j = 0; j < labels.length; j++) {
				var definition = labelTypes[labels[j].type];
				var pill = document.createElement('span');
				pill.className = 'calendar-label calendar-label--' + definition.modifier;
				/* textContent で入れることで，万一タグが混入しても実体化させない */
				pill.textContent = definition.name;
				container.appendChild(pill);
			}

			cell.appendChild(container);

			/* 詳細を持つ日だけをクリック可能にする（休診のみの日は無反応） */
			if (hasDetail(labels)) {
				cell.classList.add('is-clickable');
				cell.setAttribute('role', 'button');
				cell.setAttribute('tabindex', '0');
				cell.setAttribute('aria-haspopup', 'dialog');
				cell.setAttribute('aria-label', buildCellLabel(dateString, labels));
			}
		}
	}

	/* スクリーンリーダー向けのセル説明文を組み立てる */
	function buildCellLabel(dateString, labels) {
		var parts = dateString.split('-');
		var names = [];
		for (var i = 0; i < labels.length; i++) {
			names.push(labelTypes[labels[i].type].name);
		}
		return parseInt(parts[1], 10) + '月' + parseInt(parts[2], 10) + '日 ' +
			names.join('・') + ' 詳細を表示';
	}

	/* =========================
	   ポップアップの生成
	   DOM は body 直下に1つだけ作る（index.html には手を入れない）．
	   カード自体には overflow を掛けない．×ボタンが角からはみ出す
	   デザインのため，overflow:auto を掛けると切り取られてしまう．
	========================= */
	function buildModal() {
		var root = document.createElement('div');
		root.className = 'cal-modal';
		root.setAttribute('hidden', 'hidden');

		var backdrop = document.createElement('div');
		backdrop.className = 'cal-modal__backdrop';

		var card = document.createElement('div');
		card.className = 'cal-modal__card';
		card.setAttribute('role', 'dialog');
		card.setAttribute('aria-modal', 'true');
		card.setAttribute('aria-labelledby', 'cal-modal-title');

		/* 目には見えないが読み上げられる見出し */
		var title = document.createElement('h3');
		title.className = 'cal-modal__srtitle';
		title.id = 'cal-modal-title';

		var closeButton = document.createElement('button');
		closeButton.type = 'button';
		closeButton.className = 'cal-modal__close';
		closeButton.setAttribute('aria-label', '閉じる');

		/* «×» の文字は使わない．グリフの形と中心がフォントに左右され，
		   環境によって微妙にずれるため．線はCSSの疑似要素で描く． */
		var closeIcon = document.createElement('span');
		closeIcon.className = 'cal-modal__close-icon';
		/* 読み上げでは aria-label の「閉じる」だけを読ませ，装飾は無視させる */
		closeIcon.setAttribute('aria-hidden', 'true');
		closeButton.appendChild(closeIcon);

		/* 本文だけをスクロールさせる */
		var body = document.createElement('div');
		body.className = 'cal-modal__body';

		card.appendChild(title);
		card.appendChild(closeButton);
		card.appendChild(body);
		root.appendChild(backdrop);
		root.appendChild(card);
		document.body.appendChild(root);

		/* 背景クリックで閉じる（カード内のクリックは伝播させない） */
		backdrop.addEventListener('click', closeModal);
		closeButton.addEventListener('click', closeModal);

		/* Tab をカード内に閉じ込める．押せる要素は×だけなので Tab は無効化する */
		root.addEventListener('keydown', function (event) {
			if (event.key === 'Escape' || event.key === 'Esc') {
				closeModal();
				return;
			}
			if (event.key === 'Tab') {
				event.preventDefault();
				/* ここから先はキーボード操作．マウスで開かれていても
				   リングを出さないと «今どこにいるか» が分からなくなる． */
				root.classList.add('is-keyboard');
				closeButton.focus();
			}
		});

		return { root: root, card: card, title: title, body: body, closeButton: closeButton };
	}

	/* 本文テキストを行単位で組み立てる．「※」で始まる行は注記として小さく表示する */
	function appendTextLines(parent, text) {
		var lines = text.split(/\r?\n/);
		for (var i = 0; i < lines.length; i++) {
			var line = document.createElement('span');
			line.className = 'cal-modal__line';
			/* 「※」で始まる行は既定で小さな注記にする．
			   ただし装飾タグが明示されている行では注記スタイルを当てない．
			   注記の灰色と小さい文字が，書き手の指定した色や太字を
			   打ち消してしまうため，明示指定のほうを優先する． */
			if (lines[i].indexOf('※') === 0 && !decorationDetectPattern.test(lines[i])) {
				line.className += ' is-note';
			}
			/* 空行でも高さを保つため，空文字のときは不可視スペースの代わりに改行相当を入れる */
			if (lines[i] === '') {
				/* 空行でも高さを保つため，空文字のときは空白を1つ入れる */
				line.textContent = ' ';
			} else {
				appendDecoratedText(line, lines[i]);
			}
			parent.appendChild(line);
		}
	}

	/* 1行ぶんの文字列を装飾タグで分解し，span を組み立てて親へ足す．

	   innerHTML は使わない．textContent で入れることで，
	   入力にHTMLが混じっても «文字» としてしか扱われない．
	   保存先は複数人が触る共有フォルダなので，この性質は保ち続ける．

	   不正な記法はエラーにせず «そのままの文字» として表示する．
	   表示をやめると医療情報そのものが消えてしまうため，
	   «記号が見える» ほうへ倒している．
	     ・未知のタグ（[foo]）  … 正規表現に掛からずそのまま残る
	     ・開いていない閉じタグ … タグ自体を文字として出す
	     ・閉じ忘れ             … そこから行末まで装飾が掛かる（文字は消えない） */
	function appendDecoratedText(parent, text) {
		var openTags = [];   /* いま開いている装飾名を順に積む */
		var cursor = 0;
		var match;

		/* g付き正規表現は前回の lastIndex を引き継ぐため，走査前に必ず戻す */
		decorationPattern.lastIndex = 0;

		while ((match = decorationPattern.exec(text)) !== null) {
			/* タグの手前までを，現在の装飾状態で出す */
			appendChunk(parent, text.slice(cursor, match.index), openTags);

			var isClosing = match[1] === '/';
			var name = match[2];

			if (isClosing) {
				var at = lastIndexOfTag(openTags, name);
				if (at >= 0) {
					openTags.splice(at, 1);
				} else {
					/* 対応する開きタグが無い．書き間違いなので文字として見せる */
					appendChunk(parent, match[0], openTags);
				}
			} else {
				openTags.push(name);
			}

			cursor = match.index + match[0].length;
		}

		/* 残りを出す．閉じ忘れたタグはここまで効いたままになる */
		appendChunk(parent, text.slice(cursor), openTags);
	}

	/* 装飾状態を反映して文字を追加する */
	function appendChunk(parent, chunk, openTags) {
		if (chunk === '') {
			return;
		}
		if (openTags.length === 0) {
			/* 装飾が無い部分は要素を作らずテキストノードのまま置く */
			parent.appendChild(document.createTextNode(chunk));
			return;
		}

		var classNames = [];
		for (var i = 0; i < openTags.length; i++) {
			var className = decorationClasses[openTags[i]];
			/* 同じ装飾が二重に開かれても，クラスは1つで足りる */
			if (className && classNames.indexOf(className) < 0) {
				classNames.push(className);
			}
		}

		var span = document.createElement('span');
		span.className = classNames.join(' ');
		span.textContent = chunk;
		parent.appendChild(span);
	}

	/* 配列を後ろから探して位置を返す．無ければ -1 */
	function lastIndexOfTag(list, name) {
		for (var i = list.length - 1; i >= 0; i--) {
			if (list[i] === name) {
				return i;
			}
		}
		return -1;
	}

	/* 見出しピルと本文の組を1セット追加する */
	function appendSection(parent, pillText, bodyText) {
		if (!bodyText) {
			return;
		}
		var pill = document.createElement('span');
		pill.className = 'cal-modal__pill';
		pill.textContent = pillText;
		parent.appendChild(pill);

		var text = document.createElement('p');
		text.className = 'cal-modal__text';
		appendTextLines(text, bodyText);
		parent.appendChild(text);
	}

	/* =========================
	   ポップアップを開く
	========================= */
	function openModal(dateString, labels, originCell, byKeyboard) {
		if (!modalElements) {
			modalElements = buildModal();
		}

		var parts = dateString.split('-');
		var weekday = weekdayNames[new Date(
			parseInt(parts[0], 10),
			parseInt(parts[1], 10) - 1,
			parseInt(parts[2], 10)
		).getDay()];

		/* 読み上げ用の見出し */
		modalElements.title.textContent =
			parseInt(parts[1], 10) + '月' + parseInt(parts[2], 10) + '日（' + weekday + '）の接種情報';

		/* 本文を作り直す */
		modalElements.body.innerHTML = '';

		for (var i = 0; i < labels.length; i++) {
			var label = labels[i];
			var definition = labelTypes[label.type];

			var group = document.createElement('div');
			group.className = 'cal-modal__group';

			/* 同じ日に2種類ある場合だけ，どちらの情報かを色付きバッジで示す */
			if (labels.length > 1) {
				var badge = document.createElement('span');
				badge.className = 'calendar-label calendar-label--' + definition.modifier + ' cal-modal__badge';
				badge.textContent = definition.name;
				group.appendChild(badge);
			}

			appendSection(group, '時間', label.time);
			appendSection(group, '種類', label.kind);
			appendSection(group, '対象', label.target);

			modalElements.body.appendChild(group);
		}

		/* 閉じたときに戻す先を覚えておく */
		lastFocusedCell = originCell || null;

		/* 背面のページがスクロールしないようにする（ハンバーガーメニューと同じ手法） */
		document.body.style.overflow = 'hidden';

		/* 閉じかけの最中にもう一度開かれた場合，後片付けの予約と
		   閉じる用のクラスが残っていると «消えかけたまま» で止まる．
		   出す前に必ず打ち消す． */
		window.clearTimeout(closeTimer);
		closeTimer = null;
		modalElements.root.classList.remove('is-closing');

		/* キーボードで開いたときだけ×にフォーカスリングを出す．
		   マウス／タップで開いた場合，リングは «押せと促す» 誤った合図になる． */
		if (byKeyboard) {
			modalElements.root.classList.add('is-keyboard');
		} else {
			modalElements.root.classList.remove('is-keyboard');
		}

		modalElements.root.removeAttribute('hidden');

		/* hidden を外した直後に is-open を付けるとアニメーションが走らないため1フレーム待つ */
		requestAnimationFrame(function () {
			modalElements.root.classList.add('is-open');
			/* キーボード操作のために focus は移すが，リングは :focus-visible 側で
			   絞ってあるので，マウスで開いたときに枠は出ない． */
			modalElements.closeButton.focus();
		});
	}

	/* =========================
	   ポップアップを閉じる
	========================= */
	function closeModal() {
		if (!modalElements || modalElements.root.hasAttribute('hidden')) {
			return;
		}

		/* is-open を外して is-closing を付けると，開くときとは別の
		   «加速しながら消える» イージングに切り替わる．
		   ×ボタンは transition が短いぶん，カードより先に沈む． */
		modalElements.root.classList.remove('is-open');
		modalElements.root.classList.add('is-closing');
		document.body.style.overflow = '';

		/* 閉じるアニメーションが終わってから hidden に戻す．
		   連打で予約が積み重ならないよう，張り直す前に必ず消す． */
		window.clearTimeout(closeTimer);
		closeTimer = window.setTimeout(function () {
			modalElements.root.classList.remove('is-closing');
			modalElements.root.setAttribute('hidden', 'hidden');
			closeTimer = null;
		}, closeDuration);

		/* フォーカスを開いた場所へ返す */
		if (lastFocusedCell) {
			lastFocusedCell.focus();
			lastFocusedCell = null;
		}
	}

	/* =========================
	   セルの操作をまとめて受け取る
	   セルは月送りのたびに作り直されるため，親要素での委譲にして
	   1回だけ登録すれば済むようにする．
	========================= */
	function bindCellEvents() {
		daysElement.addEventListener('click', function (event) {
			var cell = event.target.closest('.calendar-day.is-clickable');
			if (cell) {
				/* «どう押されたか» を見分ける．
				   Chrome系では click が PointerEvent として届き，
				   pointerType はマウスなら "mouse"，タップなら "touch"，
				   キーボード由来なら空文字になる．これが最も直接的．
				   持たない環境では detail で代用する
				   （マウス／タップは1以上，Enter・Space は0）．
				   detail 単独に頼らないのは，タップから合成された click の
				   detail を 0 にする実装が存在し，タップなのに
				   キーボード扱いになってしまうため． */
				var byKeyboard = ('pointerType' in event)
					? event.pointerType === ''
					: event.detail === 0;
				openCellModal(cell, byKeyboard);
			}
		});

		daysElement.addEventListener('keydown', function (event) {
			if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') {
				return;
			}
			var cell = event.target.closest('.calendar-day.is-clickable');
			if (cell) {
				/* Space によるページスクロールを止める */
				event.preventDefault();
				openCellModal(cell, true);
			}
		});
	}

	function openCellModal(cell, byKeyboard) {
		var dateString = cell.getAttribute('data-date');
		var labels = scheduleDays[dateString];
		if (labels && labels.length) {
			openModal(dateString, labels, cell, byKeyboard);
		}
	}

	/* =========================
	   初期化
	   main.js より後に登録されるため，この時点でカレンダーは描画済み．
	========================= */
	document.addEventListener('DOMContentLoaded', function () {
		daysElement = document.getElementById('calendar-days');
		monthElement = document.getElementById('calendar-month');

		/* カレンダーが無いページでは何もしない */
		if (!daysElement || !monthElement) {
			return;
		}

		bindCellEvents();

		/* 月送りでセルが作り直されたらラベルを貼り直す．
		   ラベルの追加はセルの内側（subtree）なので，このオブザーバは再発火しない． */
		if (window.MutationObserver) {
			new MutationObserver(function () {
				applyLabels();
			}).observe(daysElement, { childList: true });
		}

		/* データを読み込んでから初回のラベルを貼る */
		loadSchedule(applyLabels);
	});
})();
