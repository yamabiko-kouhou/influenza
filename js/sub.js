// ハンバーガーメニュー
(function($) {
  var $nav   = $('#navArea');
  var $btn   = $('#nav-btn');
  var $links = $('#sp-nav a');
  var open   = 'open';
   // メニュー開閉
  $btn.on('click', function() {
    if (!$nav.hasClass(open)) {
      $nav.addClass(open);
      $btn.addClass('active');
    } else {
      $nav.removeClass(open);
      $btn.removeClass('active');
    }
  });
  // ×ボタンまたはメニュー内リンクをクリックしたら閉じる
  $links.on('click', function() {
    $nav.removeClass(open);
    $btn.removeClass('active');
  });

})(jQuery);



//ヘッダーの色を背景色によって切り替える＆ヒーロー画像過ぎたらロゴを小さくする
document.addEventListener("DOMContentLoaded", function () {
  const header = document.querySelector("header");
  const bgSections = document.querySelectorAll("section.bg");
  const hero = document.querySelector(".hero");

  function checkScroll() {
    // hero を過ぎたら小さく
    if (window.scrollY > hero.offsetHeight) {
      header.classList.add("scrolled");
    } else {
      header.classList.remove("scrolled");
    }
    // bg セクション上かどうか判定
    const headerRect = header.getBoundingClientRect();
    let onBg = false;
    bgSections.forEach(section => {
      const rect = section.getBoundingClientRect();
      if (headerRect.bottom > rect.top && headerRect.top < rect.bottom) {
        onBg = true;
      }
    });
    if (onBg) {
      header.classList.add("white");
    } else {
      header.classList.remove("white");
    }
  }
  window.addEventListener("scroll", checkScroll);
  window.addEventListener("resize", checkScroll);
  checkScroll();
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