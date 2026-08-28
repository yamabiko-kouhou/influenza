/* =========================================================
   入力プリセットの初期値

   管理画面で「現在の入力をプリセットに保存」を押すと，
   ブラウザ内（localStorage）に保存された内容が以後は優先されます．
   このファイルは «ブラウザに何も保存されていないとき» の出発点です．

   isDefault: true を付けたものが，種別ボタンを押したときに自動で入ります．
   種別ごとに1つだけ true にしてください．

   AppConfig.js と同じく JSON ではなく JS にしてあります
   （file:// で開いたときに fetch が CORS で失敗するため）．
========================================================= */
window.FLU_DEFAULT_PRESETS = [
	{
		name: '平日標準（接種日）',
		type: 'vaccination',
		isDefault: true,
		time: '午前：9:00～13:00\n午後：14:30～18:15',
		kind: '皮下注射\n[red][b]※フルミストは接種できません[/b][/red]',
		target: '12歳(中学生)以上'
	},
	{
		name: '土曜午前のみ',
		type: 'vaccination',
		isDefault: false,
		time: '午前：9:00～13:00',
		kind: '皮下注射\n[red][b]※フルミストは接種できません[/b][/red]',
		target: '12歳(中学生)以上'
	},
	{
		name: '休日接種 標準',
		type: 'holiday_vaccination',
		isDefault: true,
		time: '14:30～17:30',
		kind: '皮下注射\nフルミスト',
		target: '小学生以上'
	},
	{
		name: '休診',
		type: 'closed',
		isDefault: true,
		time: '',
		kind: '',
		target: ''
	}
];
