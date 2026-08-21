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