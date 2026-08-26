/* =========================================================
   LocalApi.js — サーバ版の API をブラウザ内で再現する層

   サーバ版（InfluenzaCalendarServer）の管理画面は，次の5つを
   ローカルの Python サーバへ投げるクライアントとして作られている．

       GET  /api/bootstrap    起動時の一括取得
       GET  /api/schedule     予定データの取り直し
       POST /api/schedule     保存（検証・バックアップ・書き出し）
       GET  /api/backups      バックアップ一覧
       POST /api/restore      バックアップからの復元
       POST /api/presets      プリセットの保存

   GitHub Pages は静的ファイルしか返さないため Python は動かせない．
   そこで，この5つと «同じ形の応答» をブラウザ内で組み立てて返す．
   Admin.js 側は request() の中身が差し替わるだけで，
   残りのロジック（描画・差分表示・競合の救済）はそのまま動く．

   ---------------------------------------------------------
   サーバ版との違い（ここが運用上いちばん重要）
   ---------------------------------------------------------
   ・保存先は共有フォルダではなく «このブラウザ» （localStorage）．
     したがって別のPC・別のブラウザには伝わらない．
   ・«本番サイトへ出す» 手段はファイルのダウンロードのみ．
     保存すると ScheduleData.js と schedule.json が手元に落ちるので，
     それを従来どおり FTP でアップロードして初めて公開される．
   ・楽観ロック（409）は «同じブラウザの別タブ» に対してのみ効く．
     別端末との競合はサーバが居ないため検知できない．
     最後に FTP でアップロードした内容が本番になる．
========================================================= */
(function () {
	'use strict';

	/* =========================
	   サーバ版と一致させる定数
	   ScheduleStore.py を変更したら，ここも必ず揃えること．
	========================= */

	/* データのスキーマ版．LP側の supportedSchemaVersion と一致させる */
	var SCHEMA_VERSION = 1;

	/* ラベル種別．保存順もこの並びに固定する（読み戻したときの差分を安定させるため） */
	var LABEL_TYPES = ['vaccination', 'holiday_vaccination', 'closed'];

	/* 自由記述欄の上限．装飾タグを除いた «本文» の長さで数える */
	var MAX_TEXT_LENGTH = 200;

	/* 装飾タグを含めた生文字列の上限．
	   本文が200字でも，タグを何重にも重ねれば文字列自体はいくらでも伸びる． */
	var MAX_RAW_LENGTH = 800;

	/* 装飾の記法．ここで «正しく閉じているか» は検証しない．
	   閉じ忘れや未知のタグを保存拒否にすると医療情報そのものが保存できなくなり，
	   「[要予約]」のような正当な角括弧まで弾いてしまうため． */
	var DECORATION_TAG_PATTERN = /\[\/?(?:b|u|red|green|gray)\]/g;

	/* 日付キーの形式．必ずローカル暦日の YYYY-MM-DD */
	var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

	/* =========================
	   設定の読み込み
	   AppConfig.js が読めていなくても，既定値で動き続ける．
	========================= */
	var config = window.FLU_APP_CONFIG || {};
	var displayRange = config.displayRange || { from: '', to: '' };
	var backupGenerations = config.backupGenerations || 30;
	var lpBaseUrl = config.lpBaseUrl || '';

	/* =========================
	   保存領域（localStorage）

	   プライベートウィンドウやサイトデータのブロック設定では
	   localStorage への読み書き自体が例外を投げる．
	   その場合はメモリ上の入れ物へ退避し，«タブを閉じるまでは編集できる»
	   状態を保つ（編集できないより，落とせるほうがましなため）．
	========================= */
	var STORAGE_KEYS = {
		schedule: 'fluGIT.schedule',
		backups:  'fluGIT.backups',
		presets:  'fluGIT.presets'
	};

	/* localStorage が使えなかったときの代替．ページを閉じると消える */
	var memoryStore = {};

	/* 保存領域が使えているかどうか．画面へ注意を出すために持つ */
	var storageAvailable = true;

	function storageRead(key) {
		try {
			var raw = window.localStorage.getItem(key);
			return raw === null ? null : raw;
		} catch (error) {
			/* 例外はここで握りつぶし，代替の入れ物を見る */
			storageAvailable = false;
			return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
		}
	}

	function storageWrite(key, value) {
		/* 代替の入れ物には必ず書く．localStorage が落ちても編集を続けられるようにする */
		memoryStore[key] = value;
		try {
			window.localStorage.setItem(key, value);
			return true;
		} catch (error) {
			storageAvailable = false;
			return false;
		}
	}

	/* JSON として読み出す．壊れていたら «無かったこと» にして既定値へ倒す．
	   ここで例外を投げると，一度データが壊れた瞬間から画面が開かなくなる． */
	function readJson(key, fallback) {
		var raw = storageRead(key);
		if (!raw) {
			return fallback;
		}
		try {
			var parsed = JSON.parse(raw);
			return parsed === null ? fallback : parsed;
		} catch (error) {
			return fallback;
		}
	}

	function writeJson(key, value) {
		return storageWrite(key, JSON.stringify(value));
	}

	/* =========================
	   日本標準時

	   generatedAt は «+09:00 付きの文字列» として記録する．
	   閲覧しているPCの時計が別のタイムゾーンでも正しい値になるよう，
	   UTC に9時間足したうえで UTC 系のゲッタで組み立てる．
	   （ローカル時刻をそのまま使って +09:00 を付けると値が嘘になる）
	========================= */
	function jstParts() {
		var shifted = new Date(Date.now() + 9 * 60 * 60 * 1000);
		return {
			year:   shifted.getUTCFullYear(),
			month:  shifted.getUTCMonth() + 1,
			day:    shifted.getUTCDate(),
			hour:   shifted.getUTCHours(),
			minute: shifted.getUTCMinutes(),
			second: shifted.getUTCSeconds()
		};
	}

	function pad2(value) {
		return value < 10 ? '0' + value : String(value);
	}

	/* サーバ版 NowJst() と同じ形式: 2026-08-26T14:03:00+09:00 */
	function nowJst() {
		var t = jstParts();
		return t.year + '-' + pad2(t.month) + '-' + pad2(t.day) +
			'T' + pad2(t.hour) + ':' + pad2(t.minute) + ':' + pad2(t.second) + '+09:00';
	}

	/* サーバ版 TodayJst() と同じ形式: 2026-08-26 */
	function todayJst() {
		var t = jstParts();
		return t.year + '-' + pad2(t.month) + '-' + pad2(t.day);
	}

	/* バックアップ名に使う刻印: 20260826-140300 */
	function stampJst() {
		var t = jstParts();
		return String(t.year) + pad2(t.month) + pad2(t.day) + '-' +
			pad2(t.hour) + pad2(t.minute) + pad2(t.second);
	}

	/* =========================
	   応答の組み立て
	   Admin.js は { status, body } の形を期待している．
	   body.code は handleApiError が 'conflict' / 'unreachable' を見る．
	========================= */
	function ok(body) {
		body.ok = true;
		return Promise.resolve({ status: 200, body: body });
	}

	function fail(message, code, status) {
		return Promise.resolve({
			status: status || 400,
			body: { ok: false, message: message, code: code || 'invalid' }
		});
	}

	/* =========================
	   予定データの読み書き
	========================= */
	function emptySchedule() {
		return {
			schemaVersion: SCHEMA_VERSION,
			generatedAt: '',
			meta: {},
			days: {}
		};
	}

	/* 保存されている内容を読む．想定外の構造でも落とさず扱える形へ寄せる */
	function readSchedule() {
		var schedule = readJson(STORAGE_KEYS.schedule, null);
		if (!schedule || typeof schedule !== 'object') {
			return emptySchedule();
		}
		if (typeof schedule.schemaVersion !== 'number') { schedule.schemaVersion = SCHEMA_VERSION; }
		if (typeof schedule.generatedAt !== 'string') { schedule.generatedAt = ''; }
		if (!schedule.meta || typeof schedule.meta !== 'object') { schedule.meta = {}; }
		if (!schedule.days || typeof schedule.days !== 'object') { schedule.days = {}; }
		return schedule;
	}

	/* =========================
	   検証
	   ScheduleStore.Validate の移植．
	   サーバが居なくなっても «壊れたデータを本番へ出さない» 防御は残す．
	   ここを省くと，200字超過や «休診と接種の同居» がそのまま
	   本番の ScheduleData.js に載ってしまう．
	========================= */

	/* 装飾タグを除いた本文の長さ．Admin.js の plainLength と同じ数え方 */
	function plainLength(text) {
		return text.replace(DECORATION_TAG_PATTERN, '').length;
	}

	/* 実在する日付か（2026-02-30 のような値を弾く） */
	function isRealDate(dateString) {
		var year  = parseInt(dateString.slice(0, 4), 10);
		var month = parseInt(dateString.slice(5, 7), 10);
		var day   = parseInt(dateString.slice(8, 10), 10);
		var probe = new Date(year, month - 1, day);
		return probe.getFullYear() === year &&
			probe.getMonth() === month - 1 &&
			probe.getDate() === day;
	}

	/* 検証に失敗したら ValidationError を投げる．呼び出し側が 400 に変換する */
	function ValidationError(message) {
		this.message = message;
	}

	function validate(days) {
		if (!days || typeof days !== 'object' || Array.isArray(days)) {
			throw new ValidationError('days はオブジェクトである必要があります．');
		}

		var normalized = {};
		var dateStrings = Object.keys(days);

		for (var i = 0; i < dateStrings.length; i++) {
			var dateString = dateStrings[i];

			/* --- 日付キーの形式 --- */
			if (!DATE_PATTERN.test(dateString)) {
				throw new ValidationError('日付の形式が不正です（YYYY-MM-DD が必要）: ' + dateString);
			}

			/* --- 実在する日付か --- */
			if (!isRealDate(dateString)) {
				throw new ValidationError('存在しない日付です: ' + dateString);
			}

			/* --- 表示期間の内側か（誤って別年度を登録する事故を防ぐ） --- */
			var month = dateString.slice(0, 7);
			if (displayRange.from && month < displayRange.from) {
				throw new ValidationError(
					'表示期間（' + displayRange.from + '〜' + displayRange.to + '）より前の日付です: ' + dateString
				);
			}
			if (displayRange.to && month > displayRange.to) {
				throw new ValidationError(
					'表示期間（' + displayRange.from + '〜' + displayRange.to + '）より後の日付です: ' + dateString
				);
			}

			var rawLabels = days[dateString];
			if (!Array.isArray(rawLabels)) {
				throw new ValidationError(dateString + ' のラベルは配列である必要があります．');
			}

			/* ラベルが空の日はキーごと落とす（不要なキーを残さない） */
			if (!rawLabels.length) {
				continue;
			}

			var labels = [];
			var seenTypes = [];

			for (var j = 0; j < rawLabels.length; j++) {
				var rawLabel = rawLabels[j];
				if (!rawLabel || typeof rawLabel !== 'object' || Array.isArray(rawLabel)) {
					throw new ValidationError(dateString + ' のラベルの形式が不正です．');
				}

				var labelType = rawLabel.type;
				if (LABEL_TYPES.indexOf(labelType) === -1) {
					throw new ValidationError(dateString + ' に未知の種別があります: ' + labelType);
				}

				/* --- 同一種別の重複を禁止する --- */
				if (seenTypes.indexOf(labelType) !== -1) {
					throw new ValidationError(dateString + ' に同じ種別が重複しています: ' + labelType);
				}
				seenTypes.push(labelType);

				var label = { type: labelType };

				/* --- 自由記述3項目 --- */
				var fields = ['time', 'kind', 'target'];
				for (var k = 0; k < fields.length; k++) {
					var field = fields[k];
					var value = rawLabel[field];
					if (value === undefined || value === null) {
						value = '';
					}
					if (typeof value !== 'string') {
						throw new ValidationError(dateString + ' の ' + field + ' は文字列である必要があります．');
					}
					/* 改行コードは LF に揃える（CRLF が混ざると表示行数がずれる） */
					value = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

					/* 装飾タグは本文の長さに数えない．
					   タグのぶんで書ける文字数が減ると，装飾を付けた行だけ
					   短く書かねばならず運用上わかりにくい． */
					if (value.length > MAX_RAW_LENGTH) {
						throw new ValidationError(
							dateString + ' の ' + field + ' は装飾タグを含めた長さが上限（' +
							MAX_RAW_LENGTH + '字）を超えています．'
						);
					}
					if (plainLength(value) > MAX_TEXT_LENGTH) {
						throw new ValidationError(
							dateString + ' の ' + field + ' が長すぎます（' + MAX_TEXT_LENGTH + '字以内）．'
						);
					}
					/* 休診は詳細を持たなくてよい．空の項目はキーごと落とす */
					if (value) {
						label[field] = value;
					}
				}

				labels.push(label);
			}

			/* --- 休診と接種系の同居を禁止する（LP側の安全側表示に頼らない） --- */
			if (seenTypes.indexOf('closed') !== -1 && seenTypes.length > 1) {
				throw new ValidationError(
					dateString + ' は休診と接種のラベルが同居しています．どちらか一方にしてください．'
				);
			}

			/* 保存順を固定する */
			labels.sort(function (a, b) {
				return LABEL_TYPES.indexOf(a.type) - LABEL_TYPES.indexOf(b.type);
			});
			normalized[dateString] = labels;
		}

		/* 日付順に詰め直す（schedule.json を人が開いたときに追いやすい） */
		var sortedDays = {};
		Object.keys(normalized).sort().forEach(function (dateString) {
			sortedDays[dateString] = normalized[dateString];
		});
		return sortedDays;
	}

	/* =========================
	   配信ファイルの組み立て

	   サーバ版 _WriteFiles と同じ内容の文字列を作る．
	   キーの並び（schemaVersion → generatedAt → meta → days）まで揃えてあるので，
	   サーバ版が書いたファイルと差分を取っても «中身の違い» だけが出る．
	========================= */
	function buildScheduleJsonText(schedule) {
		return JSON.stringify(schedule, null, 2) + '\n';
	}

	function buildScheduleDataJsText(schedule) {
		return '/* 自動生成ファイル．手で編集しないこと（管理画面の保存で上書きされます） */\n' +
			'window.INFLU_SCHEDULE = ' + JSON.stringify(schedule) + ';\n';
	}

	/* =========================
	   ダウンロード

	   静的版における «共有フォルダへの書き出し» の代わり．
	   ここで落としたファイルを FTP でアップロードして初めて公開される．
	========================= */
	function downloadText(fileName, text, mimeType) {
		/* BOM は付けない．LP は <script> として読むため，
		   先頭に BOM があると解釈できない環境がある． */
		var blob = new Blob([text], { type: mimeType + ';charset=utf-8' });
		var url = URL.createObjectURL(blob);

		var anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = fileName;
		/* Firefox は DOM に繋がっていないと click() が効かない */
		document.body.appendChild(anchor);
		anchor.click();
		document.body.removeChild(anchor);

		/* 解放を少し遅らせる．即座に revoke すると保存が始まる前に無効になる */
		window.setTimeout(function () {
			URL.revokeObjectURL(url);
		}, 10000);
	}

	/* 公開用ファイル（LPが実際に読むほう）を落とす．
	   保存のたびに落ちるのはこれ1つだけ．

	   «1回の操作につき1ファイル» を厳守している理由:
	   Chrome は1つの操作で2つ目以降のダウンロードが始まると
	   «複数ファイルのダウンロードを許可しますか» と尋ね，
	   拒否されるとそのサイトからのダウンロードを以後すべて無言で捨てる．
	   この画面は «保存＝ダウンロード» が唯一の出口なので，
	   そこを塞がれると «保存したのに何も起きない» が起き続けることになる．
	   一度でも2ファイル同時に落とすと，その状態に入る余地を作ってしまう． */
	function downloadPublishFile(schedule) {
		var warnings = [];
		try {
			downloadText('ScheduleData.js', buildScheduleDataJsText(schedule), 'application/javascript');
		} catch (error) {
			warnings.push('ScheduleData.js を落とせませんでした（' + error + '）');
		}
		return warnings;
	}

	/* 人が読める正本を落とす．明示的にボタンを押したときだけ実行する．
	   LP は ScheduleData.js しか読まないため，公開自体にこのファイルは要らない． */
	function downloadJsonFile(schedule) {
		var warnings = [];
		try {
			downloadText('schedule.json', buildScheduleJsonText(schedule), 'application/json');
		} catch (error) {
			warnings.push('schedule.json を落とせませんでした（' + error + '）');
		}
		return warnings;
	}

	/* =========================
	   バックアップ（ブラウザ内）

	   サーバ版は共有フォルダの Backups/ にファイルを置くが，
	   ここでは localStorage の配列として持つ．
	   一覧の形（name / label）は Admin.js の renderBackups に合わせる．
	========================= */
	function readBackups() {
		var backups = readJson(STORAGE_KEYS.backups, []);
		return Array.isArray(backups) ? backups : [];
	}

	/* 保存の直前に «いまの内容» を1世代として残す．
	   サーバ版と同じく «書き出す前の正本» を控えるので，
	   復元すると «ひとつ前の状態» に戻る． */
	function pushBackup(schedule) {
		/* 一度も保存されていない状態は控える意味がない */
		if (!schedule.generatedAt) {
			return;
		}

		var stamp = stampJst();
		var t = jstParts();
		var entry = {
			name: 'schedule-' + stamp + '.json',
			label: t.year + '/' + pad2(t.month) + '/' + pad2(t.day) + ' ' +
				pad2(t.hour) + ':' + pad2(t.minute) + ':' + pad2(t.second),
			schedule: schedule
		};

		var backups = readBackups();

		/* 同じ秒に2回保存された場合は上書きする．
		   サーバ版もファイル名が同じになるため copy2 で上書きされる． */
		var existing = -1;
		for (var i = 0; i < backups.length; i++) {
			if (backups[i].name === entry.name) {
				existing = i;
				break;
			}
		}
		if (existing >= 0) {
			backups.splice(existing, 1);
		}

		/* 新しい順に並べる（Admin.js は先頭を最新として扱う） */
		backups.unshift(entry);

		/* 世代数を超えたぶんを捨てる．
		   localStorage は数MBで頭打ちになるため，ここを怠ると
		   ある日突然 «保存できない» が起きる． */
		while (backups.length > backupGenerations) {
			backups.pop();
		}

		writeJson(STORAGE_KEYS.backups, backups);
	}

	/* =========================
	   プリセット
	========================= */
	function readPresets() {
		var presets = readJson(STORAGE_KEYS.presets, null);
		if (Array.isArray(presets)) {
			return presets;
		}
		/* 一度も保存していなければ既定値から始める */
		return (window.FLU_DEFAULT_PRESETS || []).slice();
	}

	/* =========================
	   本番LPからの取り込み

	   lpBaseUrl が設定されていれば <script> で本番の ScheduleData.js を読む．
	   fetch を使わないのは，別ドメインでも CORS に阻まれずに読めるため．
	   （LP本体が data/ScheduleData.js を読むのとまったく同じ経路）

	   読めなくてもエラーにはしない．ブラウザ内の内容で編集を続けられる．
	========================= */
	function loadProductionSchedule() {
		return new Promise(function (resolve) {
			if (!lpBaseUrl) {
				resolve(null);
				return;
			}

			/* 取り込みの前後で window.INFLU_SCHEDULE を汚さないよう控えておく */
			var previous = window.INFLU_SCHEDULE;
			window.INFLU_SCHEDULE = undefined;

			var script = document.createElement('script');
			/* ?ts= を付けてキャッシュを避ける．
			   FTP配信先にキャッシュ制御を設定できないため，
			   これが «いま出ている内容» を確実に取る唯一の手段になる． */
			script.src = lpBaseUrl + 'data/ScheduleData.js?ts=' + Date.now();

			var settled = false;

			function finish(result) {
				if (settled) {
					return;
				}
				settled = true;
				window.INFLU_SCHEDULE = previous;
				if (script.parentNode) {
					script.parentNode.removeChild(script);
				}
				resolve(result);
			}

			script.onload = function () {
				var loaded = window.INFLU_SCHEDULE;
				finish(loaded && typeof loaded === 'object' ? loaded : null);
			};

			/* URLの誤りや通信断でもここへ来る．黙って諦めて編集を続けさせる */
			script.onerror = function () {
				finish(null);
			};

			/* 応答が返らないまま待ち続けると画面が開かない．8秒で打ち切る */
			window.setTimeout(function () {
				finish(null);
			}, 8000);

			document.body.appendChild(script);
		});
	}

	/* =========================
	   ファイルからの取り込み

	   schedule.json でも ScheduleData.js でも受け付ける．
	   ScheduleData.js は «window.INFLU_SCHEDULE = {...};» という1文なので，
	   最初の { から最後の } までを切り出せば JSON として読める．
	   eval は使わない（取り込むのは人が選んだファイルとはいえ，
	   任意のコードを実行させる経路を作らない）．
	========================= */
	function parseScheduleText(text) {
		var trimmed = String(text).replace(/^﻿/, '').trim();

		var start = trimmed.indexOf('{');
		var end = trimmed.lastIndexOf('}');
		if (start === -1 || end === -1 || end < start) {
			throw new ValidationError('予定データが見つかりません．schedule.json または ScheduleData.js を選んでください．');
		}

		var parsed;
		try {
			parsed = JSON.parse(trimmed.slice(start, end + 1));
		} catch (error) {
			throw new ValidationError('ファイルを読み取れませんでした（形式が壊れている可能性があります）．');
		}

		if (!parsed || typeof parsed !== 'object' || !parsed.days || typeof parsed.days !== 'object') {
			throw new ValidationError('予定データの形式が違います（days が含まれていません）．');
		}

		return {
			schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : SCHEMA_VERSION,
			generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
			meta: (parsed.meta && typeof parsed.meta === 'object') ? parsed.meta : {},
			days: parsed.days
		};
	}

	/* 取り込んだ内容をそのまま «保存済みの土台» として据える．
	   保存（saveSchedule）と違い，検証もダウンロードも行わず，
	   generatedAt も付け直さない．
	   ここで generatedAt を新しくしてしまうと，
	   «取り込んだ内容» と «本番に出ている内容» の新旧が逆転し，
	   次回起動時の突き合わせが狂う． */
	function adoptSchedule(schedule) {
		/* 取り込む前の内容を1世代残す（誤って取り込んでも戻せるように） */
		pushBackup(readSchedule());
		writeJson(STORAGE_KEYS.schedule, schedule);
		return schedule;
	}

	/* =========================
	   保存の本体
	   POST /api/schedule と POST /api/restore が共有する．
	========================= */
	function saveSchedule(days, baseGeneratedAt, meta) {
		var current = readSchedule();

		/* --- 楽観ロック ---
		   静的版で効くのは «同じブラウザの別タブ» に対してのみ．
		   それでも残すのは，2つのタブで別々に編集して
		   片方の作業が黙って消える事故が実際に起こりうるため．
		   なお «再読み込みして» とは案内しない．従うと未保存の変更が全部消える． */
		if (baseGeneratedAt !== null && baseGeneratedAt !== undefined &&
			current.generatedAt !== baseGeneratedAt) {
			return fail(
				'他のタブで先に保存されています．最新の内容を取り込んでから，もう一度保存してください．',
				'conflict',
				409
			);
		}

		var validated;
		try {
			validated = validate(days);
		} catch (error) {
			if (error instanceof ValidationError) {
				return fail(error.message, 'invalid', 400);
			}
			return fail('保存前の確認で想定外のエラーが発生しました: ' + error, 'internal', 500);
		}

		/* --- 書き出す前に，いまの内容をバックアップする --- */
		pushBackup(current);

		/* キーの並びはサーバ版の書き出しと揃える */
		var schedule = {
			schemaVersion: SCHEMA_VERSION,
			generatedAt: nowJst(),
			/* meta は指定が無ければ既存を引き継ぐ（将来拡張の設定を消さない） */
			meta: (meta !== null && meta !== undefined) ? meta : current.meta,
			days: validated
		};

		/* --- ブラウザ内へ保存する --- */
		var stored = writeJson(STORAGE_KEYS.schedule, schedule);

		/* --- 公開用のファイルを落とす（1ファイルだけ） --- */
		var warnings = downloadPublishFile(schedule);

		if (!stored) {
			/* 保存領域に書けなくてもファイルは落ちている＝公開はできる．
			   «保存できません» とだけ伝えると，落ちたファイルを捨ててしまう． */
			warnings.push('このブラウザに編集内容を残せませんでした（タブを閉じると消えます）．落としたファイルは有効です．');
		}

		return ok({ schedule: schedule, mirrorWarnings: warnings });
	}

	/* =========================
	   振り分け
	   Admin.js の request() から呼ばれる唯一の入口．
	========================= */
	function request(path, payload) {
		/* サーバ版と同じくクエリ文字列は落として突き合わせる */
		var route = String(path).split('?')[0];

		/* ---- 起動時の一括取得 ---- */
		if (route === '/api/bootstrap' && !payload) {
			return bootstrap();
		}

		/* ---- 予定データの取り直し ---- */
		if (route === '/api/schedule' && !payload) {
			return ok({ schedule: readSchedule() });
		}

		/* ---- 保存 ---- */
		if (route === '/api/schedule' && payload) {
			return saveSchedule(payload.days, payload.baseGeneratedAt, undefined);
		}

		/* ---- バックアップ一覧（中身は返さない．一覧に必要なのは name と label だけ） ---- */
		if (route === '/api/backups' && !payload) {
			return ok({
				backups: readBackups().map(function (entry) {
					return { name: entry.name, label: entry.label };
				})
			});
		}

		/* ---- バックアップからの復元 ---- */
		if (route === '/api/restore' && payload) {
			var name = payload.name || '';
			var backups = readBackups();
			var found = null;
			for (var i = 0; i < backups.length; i++) {
				if (backups[i].name === name) {
					found = backups[i];
					break;
				}
			}
			if (!found) {
				return fail('バックアップが見つかりません: ' + name, 'not_found', 404);
			}
			var source = found.schedule || {};
			/* 復元時は楽観ロックを掛けない（利用者が明示的に選んだ操作のため） */
			return saveSchedule(source.days || {}, null, source.meta);
		}

		/* ---- プリセットの保存 ---- */
		if (route === '/api/presets' && payload) {
			if (!Array.isArray(payload.presets)) {
				return fail('presets は配列である必要があります．', 'invalid', 400);
			}
			var savedPresets = writeJson(STORAGE_KEYS.presets, payload.presets);
			if (!savedPresets) {
				return fail('このブラウザにプリセットを保存できませんでした．', 'internal', 500);
			}
			return ok({ presets: payload.presets });
		}

		return fail('見つかりません．', 'not_found', 404);
	}

	/* =========================
	   起動時の一括取得

	   «どの内容を土台にするか» をここで決める．
	   本番から取れた内容とブラウザに残っている内容のうち，
	   generatedAt が新しいほうを採る．

	   ・保存したがまだ FTP していない → ブラウザ側が新しい → 作業を再開できる
	   ・他の人が先にアップロードした   → 本番側が新しい   → その内容から始まる

	   どちらを採ったかは必ず画面へ知らせる．
	   «空のまま保存して本番を消す» 事故は，土台が分からないことから起きる．
	========================= */
	function bootstrap() {
		var localSchedule = readSchedule();

		return loadProductionSchedule().then(function (production) {
			var schedule = localSchedule;
			var source = 'local';

			if (production && production.days) {
				var productionAt = typeof production.generatedAt === 'string' ? production.generatedAt : '';
				if (productionAt > localSchedule.generatedAt) {
					schedule = {
						schemaVersion: typeof production.schemaVersion === 'number' ? production.schemaVersion : SCHEMA_VERSION,
						generatedAt: productionAt,
						meta: (production.meta && typeof production.meta === 'object') ? production.meta : {},
						days: production.days
					};
					source = 'production';
				} else {
					source = 'local-newer';
				}
			} else if (lpBaseUrl) {
				source = 'production-unreachable';
			}

			return ok({
				schedule: schedule,
				presets: readPresets(),
				displayRange: displayRange,
				today: todayJst(),
				/* 以下は静的版の追加情報．Admin.js が起動直後の案内に使う */
				source: source,
				storageAvailable: storageAvailable,
				isEmpty: Object.keys(schedule.days).length === 0
			});
		});
	}

	/* =========================
	   公開する窓口
	========================= */
	window.FluLocalApi = {
		/* Admin.js の request() から呼ばれる */
		request: request,

		/* 「ファイルから読み込む」で使う．文字列を予定データへ変換する */
		parseScheduleText: parseScheduleText,

		/* 取り込んだ内容を «いまの土台» として据える．
		   ダウンロードは行わず generatedAt も書き換えない．
		   取り込んだ時点の内容が «保存済みの状態» になるので，
		   このあと保存しても楽観ロックに引っかからない．
		   直前の内容は1世代バックアップへ残す（誤って取り込んでも戻せる）． */
		adoptSchedule: adoptSchedule,

		/* 現在の内容を落とし直すとき（保存し直さないので generatedAt は変わらない）．
		   どちらも «1回の操作で1ファイル» を守るため，別々の窓口にしてある． */
		downloadPublishFile: downloadPublishFile,
		downloadJsonFile: downloadJsonFile,

		/* 画面の案内文で使う設定値 */
		lpBaseUrl: lpBaseUrl
	};
})();
