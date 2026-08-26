//フォトギャラリー
const swiper = new Swiper('.swiper', {
      loop: true,
      pagination: {
        el: '.swiper-pagination',
        clickable: true,
      },
      navigation: {
        nextEl: '.swiper-button-next',
        prevEl: '.swiper-button-prev',
      },
      simulateTouch: true, // スマホはスワイプ、PCはボタンでも操作可
    });



// ハンバーガーメニュー
document.addEventListener('DOMContentLoaded', () => {
  const hamburger = document.querySelector('.hamburger-morph');
  const nav = document.querySelector('.nav-morph');

  hamburger.addEventListener('click', () => {
    hamburger.classList.toggle('active');
    nav.classList.toggle('active');

    const isOpen = hamburger.classList.contains('active');
    hamburger.setAttribute('aria-expanded', isOpen);
    nav.setAttribute('aria-hidden', !isOpen);
    document.body.style.overflow = isOpen ? 'hidden' : '';
  });
});



//カレンダー
document.addEventListener('DOMContentLoaded', function () {

	const monthElement = document.getElementById('calendar-month');
	const daysElement = document.getElementById('calendar-days');

	const prevButton = document.querySelector('.calendar-prev');
	const nextButton = document.querySelector('.calendar-next');

	/* =========================
	   表示できる期間
	========================= */
	const minDate = new Date(2026, 7, 1);  // 2026年8月
	const maxDate = new Date(2027, 2, 1);  // 2027年3月
	const holidays = [
	'2026-08-11',
	'2026-09-21',
	'2026-09-22',
	'2026-09-23',
	'2026-10-12',
	'2026-11-03',
	'2026-11-23',
	'2027-01-01',
	'2027-01-11',
	'2027-02-11',
	'2027-02-23',
	'2027-03-21',
	'2027-03-22'
	];  // 祝日の指定
	let currentDate = new Date(2026, 7, 1);

	/* =========================
	   カレンダー作成
	========================= */
	function createCalendar(date) {
		const year = date.getFullYear();
		const month = date.getMonth();

		/* 月タイトル */
		monthElement.textContent =
			year + '年' + (month + 1) + '月';

		/* 日付部分を空にする */
		daysElement.innerHTML = '';
		let firstDay = new Date(year, month, 1).getDay();
		firstDay = firstDay === 0 ? 6 : firstDay - 1;

		/* 月の日数 */
		const lastDate = new Date(year, month + 1, 0).getDate();

		/* 前月の日数 */
		const previousLastDate =
			new Date(year, month, 0).getDate();

		const totalCells =
			Math.ceil((firstDay + lastDate) / 7) * 7;

		/* 今日 */
		const today = new Date();

		/* =========================
		   マス生成
		========================= */
		for (let i = 0; i < totalCells; i++) {
			const cell = document.createElement('div');
			cell.classList.add('calendar-day');
			let dayNumber;
			let cellDate;

			/* 前月 */
			if (i < firstDay) {
				dayNumber =
					previousLastDate - firstDay + i + 1;
				cellDate =
					new Date(year, month - 1, dayNumber);
				cell.classList.add('other-month');
			}

			/* 当月 */
			else if (i < firstDay + lastDate) {
				dayNumber =
					i - firstDay + 1;
				cellDate =
					new Date(year, month, dayNumber);
			}

			/* 翌月 */
			else {
				dayNumber =
					i - firstDay - lastDate + 1;
				cellDate =
					new Date(year, month + 1, dayNumber);
				cell.classList.add('other-month');
			}

			/* 曜日 */
			const dayOfWeek = cellDate.getDay();
			if (dayOfWeek === 0) {
				cell.classList.add('sunday');
			}
			if (dayOfWeek === 6) {
				cell.classList.add('saturday');
			}
			
			const dateString =
				  cellDate.getFullYear() + '-' +
				  String(cellDate.getMonth() + 1).padStart(2, '0') + '-' +
				  String(cellDate.getDate()).padStart(2, '0');
			if (holidays.includes(dateString)) {
				cell.classList.add('holiday');
			}

			/* 日付 */
			const dateElement =
				document.createElement('span');
			dateElement.classList.add('calendar-date');
			dateElement.textContent = dayNumber;
			cell.appendChild(dateElement);

			/* 今日 */
			if (
				cellDate.getFullYear() === today.getFullYear() &&
				cellDate.getMonth() === today.getMonth() &&
				cellDate.getDate() === today.getDate()
			) {
				cell.classList.add('today');
			}
			daysElement.appendChild(cell);
		}

		/* =========================
		   ボタン制御
		========================= */
		prevButton.disabled =
			currentDate <= minDate;

		nextButton.disabled =
			currentDate >= maxDate;
	}

	/* =========================
	   前月
	========================= */
	prevButton.addEventListener('click', function () {
		if (currentDate <= minDate) {
			return;
		}
		currentDate = new Date(
			currentDate.getFullYear(),
			currentDate.getMonth() - 1,
			1
		);
		createCalendar(currentDate);
	});

	/* =========================
	   次月
	========================= */
	nextButton.addEventListener('click', function () {
		if (currentDate >= maxDate) {
			return;
		}
		currentDate = new Date(
			currentDate.getFullYear(),
			currentDate.getMonth() + 1,
			1
		);
		createCalendar(currentDate);
	});

	/* 初期表示 */
	createCalendar(currentDate);

});



//スライドショー
$(function() {
  $('.slider').slick({
    autoplay: true, //自動再生ON
	fade: true, // fedeオン
	speed: 1400,//スライドのスピード。初期値は300。
	arrows: false, //左右矢印OFF
    dots: false, //ドットインジケーターOFF
    centerMode: false, //両サイドに前後のスライド表示
    centerPadding: '0px', //左右のスライドのpadding
    slidesToShow: 1, //一度に表示するスライド数
	pauseOnHover: false, //ホバーすると自動再生を一時停止する
	pauseOnFocus: false, //フォーカスすると一時停止する
  });
});



//アコーディオン
$('.accordion-title').on('click', function() {
  let findElm = $(this).next(".accordion-text");
  $(findElm).slideToggle();
    
  if($(this).hasClass('close')){
    $(this).removeClass('close');
  } else {
    $(this).addClass('close');
  }
});



//スクロールアニメ
$(function() {
  $(window).scroll(function() {
    $(".scroll-anime").each(function() {
      let scroll = $(window).scrollTop();
      let blockPosition = $(this).offset().top;
      let windowHeihgt = $(window).height();
      if (scroll > blockPosition - windowHeihgt + 250) {
        $(this).addClass("blockIn");
      }
    });
  });
});