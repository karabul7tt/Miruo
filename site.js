// ============================================================
// MIRUO OFFICIAL WEBSITE - RAVE STYLE PORTAL & CELESTIAL ENGINE
// ============================================================

(function () {
  'use strict';

  // 1. CELESTIAL PINK/VIOLET SHOOTING STARFIELD & STARBURSTS
  const canvas = document.getElementById('starCanvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    let width = 0;
    let height = 0;
    let dpr = window.devicePixelRatio || 1;

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    window.addEventListener('resize', resize);
    resize();

    // Constant twinkling stars
    const starColors = ['#FFFFFF', '#FFE2F1', '#FF9CD1', '#E882B2', '#D8B4E2', '#A64D79'];
    const totalStars = Math.max(140, Math.min(260, Math.floor((width * height) / 6000)));
    const stars = [];

    for (let i = 0; i < totalStars; i++) {
      stars.push({
        x: Math.random() * width,
        y: Math.random() * height,
        size: Math.random() * 1.8 + 0.6,
        color: starColors[Math.floor(Math.random() * starColors.length)],
        alpha: Math.random() * 0.7 + 0.3,
        speed: Math.random() * 0.035 + 0.012,
        phase: Math.random() * Math.PI * 2,
        isCross: Math.random() < 0.12 // 12% are 4-point starbursts
      });
    }

    // Active Shooting Stars (Meteors)
    const shootingStars = [];
    const sparkParticles = [];

    function spawnShootingStar(customX, customY, customAngle) {
      // 35 to 55 degrees downward sweep
      const angle = customAngle !== undefined ? customAngle : (Math.PI / 4) + (Math.random() - 0.5) * 0.35;
      const speed = Math.random() * 10 + 16; // 16px - 26px per frame
      const length = Math.random() * 160 + 180; // 180px - 340px long dramatic tail
      const thickness = Math.random() * 1.8 + 1.4;

      const startX = customX !== undefined ? customX : Math.random() * (width * 0.95) + (width * 0.05);
      const startY = customY !== undefined ? customY : Math.random() * (height * 0.4);

      shootingStars.push({
        x: startX,
        y: startY,
        dx: -Math.cos(angle) * speed,
        dy: Math.sin(angle) * speed,
        length: length,
        thickness: thickness,
        alpha: 1.0,
        fadeSpeed: Math.random() * 0.014 + 0.010,
        colorHead: '#FFFFFF',
        colorMid: '#FF6EB4',
        colorTail: '#A64D79'
      });
    }

    // Always maintain 3 to 5 active shooting stars across the canvas
    function checkSpawn() {
      if (shootingStars.length < 3) {
        spawnShootingStar();
      }
      if (shootingStars.length < 5 && Math.random() < 0.25) {
        spawnShootingStar();
      }
    }

    // Initial warm-up: populate 3 shooting stars immediately
    for (let i = 0; i < 3; i++) {
      spawnShootingStar(
        Math.random() * width,
        Math.random() * (height * 0.6)
      );
    }

    // Interactive meteor shower on click or tap
    function triggerShower(clientX, clientY) {
      const count = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        const offsetAngle = (Math.PI / 4) + (Math.random() - 0.5) * 0.7;
        spawnShootingStar(
          clientX + (Math.random() - 0.5) * 60,
          clientY + (Math.random() - 0.5) * 40,
          offsetAngle
        );
      }
    }

    window.addEventListener('click', (e) => {
      // Don't hijack button clicks
      if (e.target.closest('a') || e.target.closest('button') || e.target.closest('.device-card') || e.target.closest('.faq-item')) return;
      triggerShower(e.clientX, e.clientY);
    });

    window.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches[0]) {
        const t = e.touches[0];
        if (e.target.closest('a') || e.target.closest('button') || e.target.closest('.device-card') || e.target.closest('.faq-item')) return;
        triggerShower(t.clientX, t.clientY);
      }
    }, { passive: true });

    // Draw 4-point cross starburst (✨)
    function drawCrossStar(x, y, radius, alpha, color) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, y - radius * 2.8);
      ctx.quadraticCurveTo(x, y, x + radius * 2.8, y);
      ctx.quadraticCurveTo(x, y, x, y + radius * 2.8);
      ctx.quadraticCurveTo(x, y, x - radius * 2.8, y);
      ctx.quadraticCurveTo(x, y, x, y - radius * 2.8);
      ctx.fill();

      // Glowing center core
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(x, y, radius * 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Animation Loop
    function render() {
      ctx.clearRect(0, 0, width, height);

      // 1. Draw Static & Twinkling Stars
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        s.phase += s.speed;
        const currentAlpha = Math.max(0.18, Math.min(1.0, s.alpha + Math.sin(s.phase) * 0.42));

        if (s.isCross && s.size > 1.2) {
          drawCrossStar(s.x, s.y, s.size * 1.5, currentAlpha, s.color);
        } else {
          ctx.save();
          ctx.globalAlpha = currentAlpha;
          ctx.fillStyle = s.color;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
          ctx.fill();

          if (s.size > 1.4) {
            ctx.fillStyle = '#FFB6DE';
            ctx.globalAlpha = currentAlpha * 0.28;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.size * 2.8, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }
      }

      // 2. Spawn and update meteors
      checkSpawn();

      // Spark particles
      for (let i = sparkParticles.length - 1; i >= 0; i--) {
        const sp = sparkParticles[i];
        sp.x += sp.vx;
        sp.y += sp.vy;
        sp.alpha -= sp.fade;
        if (sp.alpha <= 0) {
          sparkParticles.splice(i, 1);
          continue;
        }
        ctx.save();
        ctx.globalAlpha = sp.alpha;
        ctx.fillStyle = sp.color;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, sp.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      for (let i = shootingStars.length - 1; i >= 0; i--) {
        const ss = shootingStars[i];
        ss.x += ss.dx;
        ss.y += ss.dy;
        ss.alpha -= ss.fadeSpeed;

        if (ss.alpha <= 0 || ss.x < -300 || ss.y > height + 300) {
          shootingStars.splice(i, 1);
          continue;
        }

        // Spawn trailing spark particles
        if (Math.random() < 0.45) {
          sparkParticles.push({
            x: ss.x + (Math.random() - 0.5) * 4,
            y: ss.y + (Math.random() - 0.5) * 4,
            vx: ss.dx * 0.1 + (Math.random() - 0.5) * 1.5,
            vy: ss.dy * 0.1 + (Math.random() - 0.5) * 1.5,
            size: Math.random() * 1.5 + 0.8,
            alpha: ss.alpha * 0.8,
            fade: 0.04,
            color: '#FFB6DE'
          });
        }

        const headX = ss.x;
        const headY = ss.y;
        const norm = Math.sqrt(ss.dx * ss.dx + ss.dy * ss.dy);
        const tailX = headX - (ss.dx / norm) * ss.length;
        const tailY = headY - (ss.dy / norm) * ss.length;

        ctx.save();
        ctx.globalAlpha = Math.max(0, ss.alpha);

        // Radiant multi-stop comet gradient
        const grad = ctx.createLinearGradient(headX, headY, tailX, tailY);
        grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
        grad.addColorStop(0.12, 'rgba(255, 192, 225, 0.95)');
        grad.addColorStop(0.38, 'rgba(247, 107, 182, 0.85)');
        grad.addColorStop(0.70, 'rgba(166, 77, 121, 0.45)');
        grad.addColorStop(1, 'rgba(106, 30, 85, 0)');

        ctx.strokeStyle = grad;
        ctx.lineWidth = ss.thickness;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(headX, headY);
        ctx.lineTo(tailX, tailY);
        ctx.stroke();

        // Glowing white nucleus
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.arc(headX, headY, ss.thickness * 1.5, 0, Math.PI * 2);
        ctx.fill();

        // High-energy pink aura around the comet head
        ctx.fillStyle = '#FF6EB4';
        ctx.globalAlpha = Math.max(0, ss.alpha) * 0.65;
        ctx.beginPath();
        ctx.arc(headX, headY, ss.thickness * 4.2, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
      }

      requestAnimationFrame(render);
    }
    requestAnimationFrame(render);
  }

  // 2. TOAST NOTIFICATION HELPER
  function showToast(message) {
    let toast = document.getElementById('toastNotice');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toastNotice';
      toast.className = 'toast-notice';
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<span class="toast-icon">✨</span><span>${message}</span>`;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 3800);
  }

  // 3. PLATFORM AUTO-DETECTION
  function detectOS() {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    if (/iPhone|iPad|iPod/i.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
      return 'ios';
    }
    if (/Android/i.test(ua)) {
      return 'android';
    }
    if (/Win/i.test(platform) || /Windows/i.test(ua)) {
      return 'windows';
    }
    if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) {
      return 'mac';
    }
    return 'mac';
  }

  const currentOS = detectOS();
  document.querySelectorAll('[data-platform]').forEach((el) => {
    if (el.getAttribute('data-platform') === currentOS) {
      el.classList.add('active-platform');
      const badge = el.querySelector('.platform-detected-pill');
      if (badge) badge.style.display = 'inline-block';
    }
  });

  // 4. CHROME-STYLE DOWNLOAD MODAL (FOR MAC & WINDOWS)
  const downloadModal = document.getElementById('downloadModal');
  const modalCloseBtn = document.getElementById('modalCloseBtn');
  const modalIcon = document.getElementById('modalIcon');
  const modalTitle = document.getElementById('modalTitle');
  const modalSub = document.getElementById('modalSub');
  const modalDirectLink = document.getElementById('modalDirectLink');
  const modalStepsContainer = document.getElementById('modalStepsContainer');

  function openDownloadModal(platform) {
    if (!downloadModal) return;

    if (platform === 'mac') {
      modalIcon.innerHTML = `
        <svg style="width:38px; height:38px; fill:#FFFFFF;" viewBox="0 0 170 170">
          <path d="M150.37 130.25c-2.45 5.66-5.35 10.87-8.71 15.66-4.58 6.53-8.33 11.05-11.22 13.56-4.48 4.12-9.28 6.23-14.42 6.35-3.69 0-8.14-1.05-13.32-3.18-5.19-2.12-9.97-3.17-14.34-3.17-4.58 0-9.49 1.05-14.75 3.17-5.26 2.13-9.5 3.24-12.74 3.35-4.35.13-9.16-1.9-14.42-6.08-3.7-3.03-7.61-7.7-11.73-14-4.89-7.39-8.77-15.66-11.64-24.81-2.87-9.15-4.31-18.06-4.31-26.74 0-14.15 3.73-25.79 11.2-34.93 7.47-9.14 16.73-13.84 27.79-14.1 4.58 0 9.87 1.25 15.87 3.76 6 2.5 9.87 3.86 11.6 4.09 1.53-.23 5.43-1.6 11.71-4.09 6.28-2.51 11.53-3.71 15.75-3.6 11.64.63 21.05 5.09 28.23 13.38-10.23 6.18-15.24 14.86-15.03 26.04.2 8.78 3.5 16.14 9.88 22.08 6.39 5.95 14.07 9.38 23.05 10.29-1.9 5.86-4.14 11.51-6.72 16.94zm-30.82-108.97c0 7.37-2.73 14.28-8.19 20.73-5.46 6.45-12.1 10.27-19.92 11.46-.22-1.09-.33-2.12-.33-3.09 0-7.3 2.74-14.23 8.21-20.78 5.47-6.55 12.2-10.42 20.19-11.61.04 1.09.04 2.19.04 3.29z"/>
        </svg>
      `;
      modalTitle.innerText = 'Miruo for Mac İndiriliyor...';
      modalSub.innerText = 'İndirme işlemi birkaç saniye içinde otomatik başlayacak.';
      modalDirectLink.href = '/download/mac';
      modalDirectLink.innerText = 'İndirme başlamadıysa: Buraya tıklayın (.dmg)';

      modalStepsContainer.innerHTML = `
        <div class="step-card">
          <div class="step-badge">1</div>
          <div class="step-text">
            <b>DMG Dosyasını Açın</b>
            <p>İndirilenler klasörünüzdeki <code>Miruo-macOS-Installer.dmg</code> dosyasına çift tıklayın.</p>
          </div>
        </div>
        <div class="step-card">
          <div class="step-badge">2</div>
          <div class="step-text">
            <b>Uygulamalar'a Sürükleyin</b>
            <p>Miruo baykuş simgesini <b>Applications</b> klasörüne sürükleyip bırakın.</p>
          </div>
        </div>
        <div class="step-card">
          <div class="step-badge">3</div>
          <div class="step-text">
            <b>Arkadaşlarınla İzle</b>
            <p>Launchpad'den Miruo'yu açıp oda kodunu girin, sıfır gecikmeyle izlemeye başlayın!</p>
          </div>
        </div>
      `;

      // Trigger file download
      const dlLink = document.createElement('a');
      dlLink.href = '/download/mac';
      dlLink.download = 'Miruo-macOS-Installer.dmg';
      document.body.appendChild(dlLink);
      dlLink.click();
      document.body.removeChild(dlLink);

    } else if (platform === 'windows') {
      modalIcon.innerHTML = `
        <svg style="width:36px; height:36px; fill:#FFFFFF;" viewBox="0 0 24 24">
          <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.951-1.8"/>
        </svg>
      `;
      modalTitle.innerText = 'Miruo for Windows İndiriliyor...';
      modalSub.innerText = 'İndirme işlemi birkaç saniye içinde otomatik başlayacak.';
      modalDirectLink.href = '/download/windows';
      modalDirectLink.innerText = 'İndirme başlamadıysa: Buraya tıklayın (.exe)';

      modalStepsContainer.innerHTML = `
        <div class="step-card">
          <div class="step-badge">1</div>
          <div class="step-text">
            <b>Setup Dosyasını Açın</b>
            <p>İndirilen <code>Miruo-Windows-Setup.exe</code> dosyasına tıklayıp çalıştırın.</p>
          </div>
        </div>
        <div class="step-card">
          <div class="step-badge">2</div>
          <div class="step-text">
            <b>Kurulumu Tamamlayın</b>
            <p>Ekrana gelen yükleme sihirbazını onaylayarak kurulumu 5 saniyede tamamlayın.</p>
          </div>
        </div>
        <div class="step-card">
          <div class="step-badge">3</div>
          <div class="step-text">
            <b>Miruo'yu Başlatın</b>
            <p>Masaüstündeki Miruo kısayoluna tıklayın ve arkadaşlarınla partiye dal!</p>
          </div>
        </div>
      `;

      // Trigger file download
      const dlLink = document.createElement('a');
      dlLink.href = '/download/windows';
      dlLink.download = 'Miruo-Windows-Setup.exe';
      document.body.appendChild(dlLink);
      dlLink.click();
      document.body.removeChild(dlLink);
    }

    downloadModal.classList.remove('hidden');
  }

  function closeDownloadModal() {
    if (!downloadModal) return;
    downloadModal.classList.add('hidden');
  }

  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', closeDownloadModal);
  }

  if (downloadModal) {
    downloadModal.addEventListener('click', (e) => {
      if (e.target === downloadModal) closeDownloadModal();
    });
  }

  // 5. PLATFORM ACTIONS:
  // - Apple/iPhone: DIRECT redirect to App Store (no modal!)
  // - Android: Show "Çok Yakında" notification (no download!)
  // - Mac & Windows: Direct download + Chrome-style install guide modal
  document.querySelectorAll('[data-download]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const platform = btn.getAttribute('data-download');

      if (platform === 'ios') {
        // User requested: "apple basınca direkt app store atıcak"
        window.location.href = 'https://apps.apple.com/app/miruo/id6738928411';
        return;
      }

      if (platform === 'android') {
        window.open('https://play.google.com/store/apps/details?id=com.miruo.app', '_blank');
        showToast('Google Play Store açılıyor... 🚀');
        return;
      }

      if (platform === 'mac' || platform === 'windows') {
        openDownloadModal(platform);
      }
    });
  });

  // 6. MIRUO OWL EYE TRACKER & AUTO-ROTATION CONTROLLER
  const pupilLeft = document.getElementById('brandOwlPupilLeft');
  const pupilRight = document.getElementById('brandOwlPupilRight');
  const navOwlSvg = document.getElementById('navOwlSvg');

  if (pupilLeft && pupilRight && navOwlSvg) {
    let idleTimer = null;

    function handleMouseMove(e) {
      const rect = navOwlSvg.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = Math.max(-1, Math.min(1, (e.clientX - cx) / 250));
      const dy = Math.max(-1, Math.min(1, (e.clientY - cy) / 250));

      pupilLeft.style.animation = 'none';
      pupilRight.style.animation = 'none';

      const move = 4.2;
      pupilLeft.style.transform = `translate(${dx * move}px, ${dy * move}px)`;
      pupilRight.style.transform = `translate(${dx * move}px, ${dy * move}px)`;

      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        pupilLeft.style.animation = '';
        pupilRight.style.animation = '';
        pupilLeft.style.transform = '';
        pupilRight.style.transform = '';
      }, 1800);
    }

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
  }

  // 6. FAQ ACCORDION INTERACTIVITY
  document.querySelectorAll('.faq-question, .rave-faq-head').forEach((q) => {
    q.addEventListener('click', () => {
      const item = q.closest('.faq-item') || q.closest('.rave-faq-bar');
      if (item) {
        const wasActive = item.classList.contains('active');
        const container = item.parentElement;
        if (container) {
          container.querySelectorAll('.faq-item, .rave-faq-bar').forEach(i => i.classList.remove('active'));
        }
        if (!wasActive) {
          item.classList.add('active');
        }
      }
    });
  });

  // 7. MULTI-LANGUAGE I18N SYSTEM (TR, EN, DE, ES)
  const miruoTranslations = {
    tr: {
      nav_security: "Güvenlik",
      nav_privacy: "Gizlilik",
      nav_faq: "SSS",
      nav_press: "Basın",
      nav_contact: "İletişim",
      nav_back_home: "← Ana Sayfaya Dön",
      footer_privacy: "Gizlilik",
      footer_security: "Güvenlik",
      footer_terms: "Hizmet Şartları",
      footer_faq: "SSS",
      footer_press: "Basın",
      footer_contact: "İletişim",
      footer_copy: "© 2026 Miruo Inc.",
      hero_title: "BİRLİKTE İZLE",
      modal_title: "Miruo İndiriliyor...",
      modal_sub: "İndirme işlemi birkaç saniye içinde otomatik başlayacak.",
      modal_direct_link: "İndirme başlamadıysa: Buraya tıklayın",
      sec_title: "Miruo'yu nasıl güvende tutuyoruz",
      sec_sub: "Kullanıcılarımızın güvenliğini ve gizliliğini korumak için en yüksek standartlarda uçtan uca şifreleme, sunucu güvenliği ve sıfır veri kaydı protokolleri uyguluyoruz.",
      sec_c1_title: "Uçtan Uca Şifreleme",
      sec_c1_desc: "Ses ve canlı veri akışlarınız WebRTC DTLS-SRTP endüstri standardı ile doğrudan eşler arasında şifrelenir. Araya hiçbir üçüncü taraf giremez.",
      sec_c2_title: "Sıfır Sunucu Kaydı",
      sec_c2_desc: "Canlı odalardaki sesli görüşmeleriniz ve mesajlarınız sunucularımızda asla depolanmaz veya izlenmez. Akış doğrudan cihazlar arası gerçekleşir.",
      sec_c3_title: "Parola & Hash Koruması",
      sec_c3_desc: "Parolalarınız düz metin olarak asla tutulmaz. Her kullanıcıya özel rastgele tuz (salt) ve güçlü scrypt algoritmasıyla şifrelenerek saklanır.",
      sec_c4_title: "Spam ve Bot Tespiti",
      sec_c4_desc: "Kötü niyetli parola denemelerine ve spam botlara karşı akıllı istek sınırlayıcı (Rate Limiter) ve DoS koruma mekanizmaları devrededir.",
      sec_c5_title: "XSS & Girdi Güvenliği",
      sec_c5_desc: "Sohbet mesajları ve oda komutları katı filtrelerden geçirilir; script kod enjeksiyonu ve yetkisiz istekler anında etkisiz hale getirilir.",
      sec_c6_title: "Hesap Silme Güvencesi",
      sec_c6_desc: "Kullanıcı gizliliğine tam saygı duyuyoruz. Ayarlar menüsünden hesabınızı dilediğiniz an tek tıkla kalıcı olarak silebilirsiniz.",
      faq_title: "Sıkça Sorulan Sorular",
      faq_q1: "Miruo nedir ve nasıl çalışır?",
      faq_a1: "Miruo; arkadaşlarınızla mesafeler ne olursa olsun aynı anda, sıfır gecikmeyle YouTube ve videoları birlikte izlemenizi, canlı sesli ve yazılı sohbet etmenizi sağlayan yeni nesil bir ortak izleme platformudur.",
      faq_q2: "Miruo tamamen ücretsiz mi?",
      faq_a2: "Evet! Miruo'yu indirmek, arkadaşlarınızla oda açmak ve birlikte izlemek tamamen ücretsizdir.",
      faq_q3: "Hangi cihazlar Miruo'yu destekliyor?",
      faq_a3: "Miruo; Mac, iPhone (iOS), Android telefonlar ve Windows bilgisayarlarla tam uyumludur. Farklı cihazlardaki arkadaşlarınız aynı odaya katılabilir.",
      faq_q4: "Birlikte izlerken senkronizasyon nasıl sağlanıyor?",
      faq_a4: "Miruo'nun senkronizasyon motoru sayesinde odadaki biri videoyu durdurduğunda, başlattığında veya ileri sardığında tüm katılımcıların ekranları milisaniyelik gecikmeyle aynı anda güncellenir.",
      faq_q5: "Odaya arkadaşlarımı nasıl davet edebilirim?",
      faq_a5: "Oda oluşturduktan sonra oda bağlantısını veya 6 haneli oda kodunu kopyalayıp WhatsApp, Telegram veya Discord üzerinden arkadaşlarınızla paylaşarak tek tıkla katılmalarını sağlayabilirsiniz.",
      faq_q6: "Sesli ve yazılı sohbet özelliği var mı?",
      faq_a6: "Evet! Oda içerisinde dilediğiniz gibi metin sohbeti yapabilir, isterseniz mikrofonunuzu açarak arkadaşlarınızla konuşarak izleyebilirsiniz.",
      faq_q7: "Hesabımı dilediğim zaman kalıcı olarak silebilir miyim?",
      faq_a7: "Evet, kullanıcı kontrolüne tam saygı duyuyoruz. Uygulama içi Ayarlar menüsünden hesabınızı dilediğiniz an tek tıkla kalıcı olarak silebilirsiniz; tüm verileriniz sunucudan silinir.",
      faq_q8: "Video izlemek için ek bir hesap açmam gerekir mi?",
      faq_a8: "Hayır. YouTube ve desteklenen içerikleri doğrudan oda içerisinde arkadaşlarınızla anında izlemeye başlayabilirsiniz.",
      contact_title: "Bize Ulaşın",
      contact_name_label: "Adınızı girin",
      contact_name_placeholder: "Ahmet Yılmaz",
      contact_email_label: "E-postanızı girin",
      contact_email_placeholder: "ahmet@ornek.com",
      contact_user_label: "Kullanıcı adı",
      contact_user_placeholder: "@ahmetdoe123",
      contact_subject_label: "Konuyu girin",
      contact_subject_placeholder: "Nasıl yardımcı olabiliriz?",
      contact_msg_label: "Mesajınızı girin",
      contact_msg_placeholder: "Lütfen sorunuzu veya endişenizi ayrıntılı olarak açıklayın...",
      contact_submit_btn: "Mesajı gönder",
      contact_sent_btn: "Mesajınız Gönderildi ✓",
      contact_toast: "Mesajınız başarıyla iletildi! En kısa sürede dönüş yapacağız.",
      press_title: "Basın ve Medya Kiti",
      press_lead: "Miruo'nun doğuş hikâyesi, kurumsal kimliği ve vizyonu.",
      press_story_title: "Hikâyemiz",
      press_story_p: "Miruo, fiziksel mesafelerin birlikte eğlenmeye ve film geceleri düzenlemeye engel olamayacağı inancıyla yola çıktı. Sıfır gecikmeli yeni nesil senkronizasyon motorumuz ve sevimli baykuş maskotumuz ile Mac, iOS, Android ve Windows kullanıcılarını tek bir sanal salonda bir araya getiriyoruz.",
      press_assets_title: "Resmi Marka Varlıkları",
      press_asset1_title: "Resmi Baykuş Maskotu",
      press_asset1_sub: "512x512 PNG",
      press_asset2_title: "Tipografi Logosu",
      press_asset2_sub: "Vektörel Font & Renkler",
      press_download_btn: "İndir (.PNG)",
      priv_badge: "GİZLİLİK POLİTİKASI",
      priv_title: "Miruo Gizlilik İlkeleri",
      priv_date: "Son Güncelleme: 9 Ekim 2026",
      priv_highlight: "Miruo olarak kişisel gizliliğinize en üst düzeyde saygı duyuyoruz. Kişisel verilerinizi asla satmayız, kiralamayız ve izniniz olmadan üçüncü taraflarla paylaşmayız.",
      priv_s1_h: "1. Toplanan Bilgiler",
      priv_s1_p: "Miruo'yu kullanırken temel hizmetleri sunabilmemiz için minimum düzeyde veri işlenir: e-posta adresiniz, belirlediğiniz kullanıcı adınız ve oturum doğrulama anahtarları.",
      priv_s2_h: "2. Bilgilerin Kullanım Amacı",
      priv_s2_p: "Toplanan veriler yalnızca hesabınızı güvenceye almak, oda bağlantılarını kurmak ve kesintisiz video senkronizasyonu sağlamak için kullanılır.",
      priv_s3_h: "3. Üçüncü Taraflar ve Reklam",
      priv_s3_p: "Miruo'da üçüncü taraf reklam takipçileri kesinlikle bulunmaz. Odalardaki canlı sesli görüşmeleriniz uçtan uca şifrelenir ve sunucuda asla kaydedilmez.",
      priv_s4_h: "4. Tek Tıkla Kalıcı Hesap Silme",
      priv_s4_p: "Kullanıcılarımız diledikleri zaman Ayarlar ekranındaki \"Hesabı Kalıcı Olarak Sil\" butonunu kullanarak tüm kişisel verilerini, hesaplarını ve kayıtlarını sunucularımızdan anında ve geri döndürülemez şekilde silebilirler.",
      priv_s5_h: "5. KVKK ve GDPR Uyumluluğu",
      priv_s5_p: "Kullanıcılarımız 6698 sayılı Kişisel Verilerin Korunması Kanunu (KVKK) ve AB Genel Veri Koruma Tüzüğü (GDPR) kapsamında verilerine erişme, düzeltme talep etme ve silinmesini isteme hakkına sahiptir.",
      priv_s5_contact: "İletişim ve veri talepleri için:",
      terms_badge: "KULLANIM KOŞULLARI",
      terms_title: "Miruo Hizmet Şartları",
      terms_date: "Son Güncelleme: 9 Ekim 2026",
      terms_s1_h: "1. Genel Kabul",
      terms_s1_p: "Miruo web sitesini, masaüstü veya mobil uygulamalarını kullanarak bu koşulları kabul etmiş sayılırsınız. Miruo, arkadaş gruplarının yasal olarak erişebildikleri medyaları birlikte eşzamanlı izlemelerini sağlayan bir iletişim aracıdır.",
      terms_s2_h: "2. Hizmet Kapsamı ve Telif Hakları",
      terms_s2_p: "Miruo, telif hakkıyla korunan video dosyalarını kendi sunucularında barındırmaz veya saklamaz. İzlenen içerikler YouTube veya kullanıcıların yasal abonelikleri üzerinden cihazlarında yerel olarak oynatılır ve WebRTC protokolüyle zaman damgaları senkronize edilir.",
      terms_s3_h: "3. Topluluk ve Davranış Kuralları",
      terms_s3_p: "Miruo odalarında nefret söylemi, taciz, yasa dışı içerik paylaşımı ve sunucu altyapısına kaba kuvvet (brute-force) veya DoS saldırısı girişiminde bulunmak kesinlikle yasaktır.",
      terms_s4_h: "4. Hesap Güvenliği ve Fesih",
      terms_s4_p: "Hesabınızın güvenliği sizin sorumluluğunuzdadır. Kullanıcılar diledikleri zaman hesaplarını uygulama içinden kalıcı olarak silebilirler.",
      terms_s5_h: "5. İletişim",
      terms_s5_p: "Şartlar hakkında sorularınız için:"
    },
    en: {
      nav_security: "Security",
      nav_privacy: "Privacy",
      nav_faq: "FAQ",
      nav_press: "Press",
      nav_contact: "Contact",
      nav_back_home: "← Back to Home",
      footer_privacy: "Privacy",
      footer_security: "Security",
      footer_terms: "Terms of Service",
      footer_faq: "FAQ",
      footer_press: "Press",
      footer_contact: "Contact",
      footer_copy: "© 2026 Miruo Inc.",
      hero_title: "WATCH TOGETHER",
      modal_title: "Downloading Miruo...",
      modal_sub: "Your download will start automatically in a few seconds.",
      modal_direct_link: "If download didn't start: Click here",
      sec_title: "How we keep Miruo safe",
      sec_sub: "We implement end-to-end encryption, strict server security, and zero-data-logging protocols to protect your safety and privacy.",
      sec_c1_title: "End-to-End Encryption",
      sec_c1_desc: "Your voice and live media streams are encrypted peer-to-peer using WebRTC DTLS-SRTP industry standards. No third parties can intercept.",
      sec_c2_title: "Zero Server Logs",
      sec_c2_desc: "Your voice chats and room messages are never stored or tracked on our servers. Streaming happens directly device-to-device.",
      sec_c3_title: "Password & Hash Protection",
      sec_c3_desc: "Passwords are never stored in plain text. Every user password is protected using unique cryptographic salts and the strong scrypt algorithm.",
      sec_c4_title: "Spam & Bot Protection",
      sec_c4_desc: "Intelligent rate limiting and DoS shields defend against brute-force password attacks and abusive bots.",
      sec_c5_title: "XSS & Input Sanitization",
      sec_c5_desc: "Chat messages and room payloads are strictly sanitized against script injection (XSS) and unauthorized commands.",
      sec_c6_title: "Permanent Account Deletion",
      sec_c6_desc: "We respect user control. You can permanently delete your account and all associated data with one click in the Settings menu.",
      faq_title: "Frequently Asked Questions",
      faq_q1: "What is Miruo and how does it work?",
      faq_a1: "Miruo is a next-generation watch party platform that lets you watch YouTube and videos in real time with zero latency, alongside live voice and text chat.",
      faq_q2: "Is Miruo completely free?",
      faq_a2: "Yes! Downloading Miruo, creating watch rooms, and enjoying videos with your friends is 100% free.",
      faq_q3: "Which devices does Miruo support?",
      faq_a3: "Miruo is compatible with Mac, iPhone (iOS), Android phones, and Windows computers. Friends across different devices can join the same room seamlessly.",
      faq_q4: "How does playback synchronization work?",
      faq_a4: "Miruo's sync engine ensures that when anyone pauses, plays, or seeks, everyone's screen updates simultaneously within milliseconds.",
      faq_q5: "How can I invite friends to my room?",
      faq_a5: "After creating a room, copy your room link or 6-digit code and share it via WhatsApp, Telegram, or Discord for one-click entry.",
      faq_q6: "Is there voice and text chat?",
      faq_a6: "Yes! You can chat with text anytime and turn on high-definition voice chat to talk while watching.",
      faq_q7: "Can I permanently delete my account at any time?",
      faq_a7: "Yes. You can permanently delete your account and all related data anytime directly from the in-app Settings menu.",
      faq_q8: "Do I need an extra account to watch videos?",
      faq_a8: "No. You can immediately enjoy YouTube and supported media inside your room without extra logins.",
      contact_title: "Contact Us",
      contact_name_label: "Your Name",
      contact_name_placeholder: "John Doe",
      contact_email_label: "Your Email",
      contact_email_placeholder: "john@example.com",
      contact_user_label: "Username",
      contact_user_placeholder: "@johndoe123",
      contact_subject_label: "Subject",
      contact_subject_placeholder: "How can we help you?",
      contact_msg_label: "Your Message",
      contact_msg_placeholder: "Please describe your inquiry or feedback in detail...",
      contact_submit_btn: "Send Message",
      contact_sent_btn: "Message Sent ✓",
      contact_toast: "Your message was sent successfully! We will get back to you shortly.",
      press_title: "Press & Media Kit",
      press_lead: "The story behind Miruo, our brand identity, and vision.",
      press_story_title: "Our Story",
      press_story_p: "Miruo was built on the belief that physical distance should never prevent friends from having fun and hosting movie nights. Powered by our zero-latency sync engine and cheerful owl mascot, we unite Mac, iOS, Android, and Windows users in one synchronized virtual cinema.",
      press_assets_title: "Official Brand Assets",
      press_asset1_title: "Official Owl Mascot",
      press_asset1_sub: "512x512 PNG",
      press_asset2_title: "Typography Logo",
      press_asset2_sub: "Vector Font & Colors",
      press_download_btn: "Download (.PNG)",
      priv_badge: "PRIVACY POLICY",
      priv_title: "Miruo Privacy Policy",
      priv_date: "Last Updated: October 9, 2026",
      priv_highlight: "At Miruo, we hold your privacy in the highest regard. We never sell, rent, or monetize your personal data, nor do we share it with third parties without your consent.",
      priv_s1_h: "1. Data We Collect",
      priv_s1_p: "When using Miruo, we only process the minimum data required to deliver core functionality: your email address, chosen username, and secure session tokens.",
      priv_s2_h: "2. How We Use Your Data",
      priv_s2_p: "Collected data is exclusively used to secure your account, facilitate room connections, and deliver uninterrupted synchronized playback.",
      priv_s3_h: "3. Third Parties & Advertising",
      priv_s3_p: "Miruo contains zero third-party ad trackers. Live voice and video sessions in rooms are encrypted end-to-end and never stored or listened to on our servers.",
      priv_s4_h: "4. One-Click Permanent Account Deletion",
      priv_s4_p: "Users can permanently and irreversibly erase all personal data, accounts, and records from our servers at any time via the \"Permanently Delete Account\" button in Settings.",
      priv_s5_h: "5. GDPR & Data Privacy Rights",
      priv_s5_p: "Users have the full right to access, rectify, or request deletion of their data in compliance with GDPR and relevant data protection laws.",
      priv_s5_contact: "For inquiries and data requests:",
      terms_badge: "TERMS OF USE",
      terms_title: "Miruo Terms of Service",
      terms_date: "Last Updated: October 9, 2026",
      terms_s1_h: "1. Acceptance of Terms",
      terms_s1_p: "By using Miruo via web, desktop, or mobile applications, you agree to these terms. Miruo is a communication tool enabling groups of friends to enjoy legally accessible media together.",
      terms_s2_h: "2. Scope of Service & Copyright",
      terms_s2_p: "Miruo does not host or store copyrighted video files on its servers. Watched media plays locally on each client device through YouTube or official subscriptions, synchronized via WebRTC.",
      terms_s3_h: "3. Community & Conduct Guidelines",
      terms_s3_p: "Hate speech, harassment, distribution of unlawful material, or attempting brute-force and DoS attacks against infrastructure is strictly forbidden.",
      terms_s4_h: "4. Account Security & Termination",
      terms_s4_p: "You are responsible for your account security. Users may permanently terminate their account from within the app settings at any time.",
      terms_s5_h: "5. Contact",
      terms_s5_p: "For questions regarding these terms:"
    },
    de: {
      nav_security: "Sicherheit",
      nav_privacy: "Datenschutz",
      nav_faq: "FAQ",
      nav_press: "Presse",
      nav_contact: "Kontakt",
      nav_back_home: "← Zurück zur Startseite",
      footer_privacy: "Datenschutz",
      footer_security: "Sicherheit",
      footer_terms: "Nutzungsbedingungen",
      footer_faq: "FAQ",
      footer_press: "Presse",
      footer_contact: "Kontakt",
      footer_copy: "© 2026 Miruo Inc.",
      hero_title: "GEMEINSAM SCHAUEN",
      modal_title: "Miruo wird heruntergeladen...",
      modal_sub: "Der Download startet in wenigen Sekunden automatisch.",
      modal_direct_link: "Falls der Download nicht startet: Hier klicken",
      sec_title: "Wie wir Miruo sicher halten",
      sec_sub: "Wir setzen Ende-zu-Ende-Verschlüsselung, strenge Serversicherheit und Zero-Log-Protokolle ein, um Ihre Sicherheit und Privatsphäre zu schützen.",
      sec_c1_title: "Ende-zu-Ende-Verschlüsselung",
      sec_c1_desc: "Sprach- und Videoströme werden nach dem WebRTC DTLS-SRTP Industriestandard direkt zwischen Peers verschlüsselt.",
      sec_c2_title: "Keine Serverprotokolle",
      sec_c2_desc: "Sprachchats und Raumnachrichten werden niemals auf unseren Servern gespeichert oder überwacht.",
      sec_c3_title: "Passwort- & Hash-Schutz",
      sec_c3_desc: "Passwörter werden niemals im Klartext gespeichert. Jedes Passwort wird mit individuellem Salt und scrypt geschützt.",
      sec_c4_title: "Spam- & Bot-Schutz",
      sec_c4_desc: "Intelligente Ratenbegrenzung und DoS-Schutzmechanismen wehren Brute-Force-Angriffe ab.",
      sec_c5_title: "XSS- & Eingabesicherheit",
      sec_c5_desc: "Chatnachrichten und Befehle werden streng bereinigt, um Script-Injection zuverlässig zu verhindern.",
      sec_c6_title: "Dauerhafte Kontolöschung",
      sec_c6_desc: "Volle Kontrolle für Nutzer: Löschen Sie Ihr Konto jederzeit mit einem einzigen Klick in den Einstellungen.",
      faq_title: "Häufig gestellte Fragen",
      faq_q1: "Was ist Miruo und wie funktioniert es?",
      faq_a1: "Miruo ist eine moderne Plattform, mit der Sie YouTube und Videos in Echtzeit ohne Verzögerung gemeinsam mit Freunden ansehen können.",
      faq_q2: "Ist Miruo kostenlos?",
      faq_a2: "Ja! Das Herunterladen, Erstellen von Räumen und gemeinsame Ansehen ist vollkommen kostenlos.",
      faq_q3: "Welche Geräte werden unterstützt?",
      faq_a3: "Miruo ist mit Mac, iPhone (iOS), Android und Windows kompatibel.",
      faq_q4: "Wie funktioniert die Synchronisation?",
      faq_a4: "Wenn jemand pausiert oder vorspult, synchronisieren sich alle Bildschirme im Raum innerhalb von Millisekunden.",
      faq_q5: "Wie lade ich Freunde ein?",
      faq_a5: "Kopieren Sie den Raumlink oder den 6-stelligen Code und teilen Sie ihn per WhatsApp, Telegram oder Discord.",
      faq_q6: "Gibt es Sprach- und Textchat?",
      faq_a6: "Ja! Sie können jederzeit Textnachrichten senden oder den HD-Sprachchat einschalten.",
      faq_q7: "Kann ich mein Konto dauerhaft löschen?",
      faq_a7: "Ja, in den Einstellungen können Sie Ihr Konto und alle Daten jederzeit mit einem Klick dauerhaft löschen.",
      faq_q8: "Benötige ich ein Extrakonto für Videos?",
      faq_a8: "Nein, YouTube und unterstützte Medien können direkt im Raum gestartet werden.",
      contact_title: "Kontaktieren Sie uns",
      contact_name_label: "Ihr Name",
      contact_name_placeholder: "Max Mustermann",
      contact_email_label: "Ihre E-Mail",
      contact_email_placeholder: "max@beispiel.de",
      contact_user_label: "Benutzername",
      contact_user_placeholder: "@maxmuster",
      contact_subject_label: "Betreff",
      contact_subject_placeholder: "Wie können wir Ihnen helfen?",
      contact_msg_label: "Ihre Nachricht",
      contact_msg_placeholder: "Bitte beschreiben Sie Ihr Anliegen detailliert...",
      contact_submit_btn: "Nachricht senden",
      contact_sent_btn: "Nachricht gesendet ✓",
      contact_toast: "Ihre Nachricht wurde erfolgreich übermittelt!",
      press_title: "Presse- & Medienkit",
      press_lead: "Die Entstehungsgeschichte, Markenidentität und Vision von Miruo.",
      press_story_title: "Unsere Geschichte",
      press_story_p: "Miruo entstand aus der Überzeugung, dass räumliche Distanz gemeinsamen Filmabenden niemals im Weg stehen sollte.",
      press_assets_title: "Offizielle Marken-Assets",
      press_asset1_title: "Offizielles Eulen-Maskottchen",
      press_asset1_sub: "512x512 PNG",
      press_asset2_title: "Typografie-Logo",
      press_asset2_sub: "Vektor-Schriftart & Farben",
      press_download_btn: "Herunterladen (.PNG)",
      priv_badge: "DATENSCHUTZRICHTLINIE",
      priv_title: "Miruo Datenschutzrichtlinie",
      priv_date: "Zuletzt aktualisiert: 9. Oktober 2026",
      priv_highlight: "Bei Miruo hat Ihre Privatsphäre höchste Priorität. Wir verkaufen Ihre Daten niemals und geben sie nicht ohne Erlaubnis weiter.",
      priv_s1_h: "1. Erfasste Daten",
      priv_s1_p: "Wir verarbeiten nur die minimal notwendigen Daten: E-Mail-Adresse, Benutzername und sichere Sitzungstoken.",
      priv_s2_h: "2. Verwendungszweck",
      priv_s2_p: "Daten werden ausschließlich zur Kontoverwaltung und Videosynchronisation genutzt.",
      priv_s3_h: "3. Dritte & Werbung",
      priv_s3_p: "Miruo enthält keine Werbe-Tracker. Sprachchats sind Ende-zu-Ende verschlüsselt und werden nicht aufgezeichnet.",
      priv_s4_h: "4. Ein-Klick-Kontolöschung",
      priv_s4_p: "Nutzer können ihr Konto und alle Daten in den Einstellungen jederzeit dauerhaft und unwiderruflich löschen.",
      priv_s5_h: "5. DSGVO-Rechte",
      priv_s5_p: "Nutzer haben das volle Recht auf Auskunft, Berichtigung und Löschung ihrer Daten gemäß DSGVO.",
      priv_s5_contact: "Für Datenanfragen:",
      terms_badge: "NUTZUNGSBEDINGUNGEN",
      terms_title: "Miruo Nutzungsbedingungen",
      terms_date: "Zuletzt aktualisiert: 9. Oktober 2026",
      terms_s1_h: "1. Allgemeine Bedingungen",
      terms_s1_p: "Durch die Nutzung von Miruo akzeptieren Sie diese Bedingungen für gemeinsames, synchronisiertes Streamen.",
      terms_s2_h: "2. Leistungsumfang & Urheberrecht",
      terms_s2_p: "Miruo hostet keine Videodateien. Medien werden direkt über offizielle YouTube-Player oder Abonnements synchronisiert.",
      terms_s3_h: "3. Community-Richtlinien",
      terms_s3_p: "Belästigung, Hassrede und Angriffe auf die Serverinfrastruktur sind strengstens untersagt.",
      terms_s4_h: "4. Kündigung & Kontolöschung",
      terms_s4_p: "Nutzer können die Nutzung jederzeit beenden und ihr Konto in den Einstellungen löschen.",
      terms_s5_h: "5. Kontakt",
      terms_s5_p: "Bei Fragen zu den Nutzungsbedingungen:"
    },
    es: {
      nav_security: "Seguridad",
      nav_privacy: "Privacidad",
      nav_faq: "Preguntas",
      nav_press: "Prensa",
      nav_contact: "Contacto",
      nav_back_home: "← Volver al inicio",
      footer_privacy: "Privacidad",
      footer_security: "Seguridad",
      footer_terms: "Términos del Servicio",
      footer_faq: "Preguntas Frecuentes",
      footer_press: "Prensa",
      footer_contact: "Contacto",
      footer_copy: "© 2026 Miruo Inc.",
      hero_title: "VER JUNTOS",
      modal_title: "Descargando Miruo...",
      modal_sub: "La descarga comenzará automáticamente en unos segundos.",
      modal_direct_link: "Si la descarga no empieza: Haz clic aquí",
      sec_title: "Cómo mantenemos seguro Miruo",
      sec_sub: "Implementamos cifrado de extremo a extremo, seguridad estricta del servidor y protocolos sin registro para proteger su seguridad y privacidad.",
      sec_c1_title: "Cifrado Extremo a Extremo",
      sec_c1_desc: "Sus transmisiones de voz y video están cifradas directamente entre pares según el estándar industrial WebRTC DTLS-SRTP.",
      sec_c2_title: "Sin Registros en Servidores",
      sec_c2_desc: "Las conversaciones de voz y mensajes nunca se almacenan ni monitorean en nuestros servidores.",
      sec_c3_title: "Protección de Contraseñas",
      sec_c3_desc: "Las contraseñas se protegen con sal criptográfica única y el potente algoritmo scrypt.",
      sec_c4_title: "Protección contra Spam y Bots",
      sec_c4_desc: "Límites inteligentes de peticiones y escudos DoS protegen contra ataques de fuerza bruta.",
      sec_c5_title: "Seguridad contra XSS",
      sec_c5_desc: "Los mensajes y comandos se filtran rigurosamente para neutralizar cualquier inyección de código.",
      sec_c6_title: "Eliminación Permanente de Cuenta",
      sec_c6_desc: "Respetamos el control del usuario. Puede eliminar su cuenta permanentemente con un solo clic en Ajustes.",
      faq_title: "Preguntas Frecuentes",
      faq_q1: "¿Qué es Miruo y cómo funciona?",
      faq_a1: "Miruo es una plataforma de nueva generación para ver YouTube y videos en tiempo real sin latencia con amigos.",
      faq_q2: "¿Miruo es completamente gratis?",
      faq_a2: "¡Sí! Descargar Miruo, crear salas y ver contenido con amigos es 100% gratuito.",
      faq_q3: "¿Qué dispositivos son compatibles?",
      faq_a3: "Miruo es compatible con Mac, iPhone (iOS), teléfonos Android y Windows.",
      faq_q4: "¿Cómo funciona la sincronización?",
      faq_a4: "Cuando alguien pausa o avanza, las pantallas de todos en la sala se sincronizan en milisegundos.",
      faq_q5: "¿Cómo invito a mis amigos?",
      faq_a5: "Copia el enlace de la sala o el código de 6 dígitos y compártelo por WhatsApp, Telegram o Discord.",
      faq_q6: "¿Hay chat de voz y texto?",
      faq_a6: "¡Sí! Puedes chatear por texto o encender el chat de voz de alta fidelidad mientras ves contenido.",
      faq_q7: "¿Puedo eliminar mi cuenta permanentemente?",
      faq_a7: "Sí, puedes eliminar tu cuenta y todos tus datos en cualquier momento desde los Ajustes.",
      faq_q8: "¿Necesito una cuenta adicional para ver videos?",
      faq_a8: "No, puedes disfrutar de YouTube y contenidos compatibles directamente sin registros adicionales.",
      contact_title: "Contáctenos",
      contact_name_label: "Su Nombre",
      contact_name_placeholder: "Carlos Pérez",
      contact_email_label: "Su Correo",
      contact_email_placeholder: "carlos@ejemplo.com",
      contact_user_label: "Usuario",
      contact_user_placeholder: "@carlosp123",
      contact_subject_label: "Asunto",
      contact_subject_placeholder: "¿Cómo podemos ayudarle?",
      contact_msg_label: "Su Mensaje",
      contact_msg_placeholder: "Por favor describa su consulta en detalle...",
      contact_submit_btn: "Enviar Mensaje",
      contact_sent_btn: "Mensaje Enviado ✓",
      contact_toast: "¡Su mensaje se envió con éxito!",
      press_title: "Kit de Prensa y Medios",
      press_lead: "La historia detrás de Miruo, nuestra identidad de marca y recursos oficiales.",
      press_story_title: "Nuestra Historia",
      press_story_p: "Miruo nació con la convicción de que la distancia nunca debe impedir noches de cine y diversión entre amigos.",
      press_assets_title: "Recursos Oficiales de Marca",
      press_asset1_title: "Mascota Búho Oficial",
      press_asset1_sub: "512x512 PNG",
      press_asset2_title: "Logo Tipográfico",
      press_asset2_sub: "Fuente Vectorial y Colores",
      press_download_btn: "Descargar (.PNG)",
      priv_badge: "POLÍTICA DE PRIVACIDAD",
      priv_title: "Política de Privacidad de Miruo",
      priv_date: "Última actualización: 9 de octubre de 2026",
      priv_highlight: "En Miruo protegemos su privacidad. Nunca vendemos sus datos personales ni los compartimos sin su permiso.",
      priv_s1_h: "1. Datos que recopilamos",
      priv_s1_p: "Solo procesamos datos mínimos necesarios: correo electrónico, nombre de usuario y claves de sesión.",
      priv_s2_h: "2. Uso de la información",
      priv_s2_p: "Los datos se utilizan exclusivamente para autenticación segura y sincronización de video.",
      priv_s3_h: "3. Terceros y Publicidad",
      priv_s3_p: "Miruo no contiene rastreadores de anuncios. Las sesiones de voz en salas son cifradas extremo a extremo y nunca se graban.",
      priv_s4_h: "4. Eliminación de cuenta en un clic",
      priv_s4_p: "Los usuarios pueden eliminar permanentemente toda su información del servidor desde Ajustes.",
      priv_s5_h: "5. Derechos de Protección de Datos",
      priv_s5_p: "Los usuarios disponen de plenos derechos de acceso, rectificación y supresión de datos conforme al RGPD.",
      priv_s5_contact: "Para solicitudes de datos:",
      terms_badge: "TÉRMINOS DE USO",
      terms_title: "Términos del Servicio de Miruo",
      terms_date: "Última actualización: 9 de octubre de 2026",
      terms_s1_h: "1. Aceptación General",
      terms_s1_p: "Al usar Miruo mediante web, escritorio o móvil, usted acepta estos términos de uso compartido.",
      terms_s2_h: "2. Alcance y Derechos de Autor",
      terms_s2_p: "Miruo no aloja archivos de video con derechos de autor. Los contenidos se reproducen directamente vía YouTube o suscripciones oficiales.",
      terms_s3_h: "3. Normas de Comunidad",
      terms_s3_p: "Está terminantemente prohibido el acoso, discurso de odio o ataques contra la infraestructura del servidor.",
      terms_s4_h: "4. Seguridad y Cancelación",
      terms_s4_p: "Usted es responsable de la seguridad de su cuenta y puede cerrarla cuando lo desee.",
      terms_s5_h: "5. Contacto",
      terms_s5_p: "Para preguntas sobre estos términos:"
    },
    pt: {
      nav_security: "Segurança",
      nav_privacy: "Privacidade",
      nav_faq: "FAQ",
      nav_press: "Imprensa",
      nav_contact: "Contato",
      nav_back_home: "← Voltar ao Início",
      footer_privacy: "Privacidade",
      footer_security: "Segurança",
      footer_terms: "Termos de Serviço",
      footer_faq: "FAQ",
      footer_press: "Imprensa",
      footer_contact: "Contato",
      footer_copy: "© 2026 Miruo Inc.",
      hero_title: "ASSISTIR JUNTO",
      modal_title: "Baixando o Miruo...",
      modal_sub: "O download começará automaticamente em alguns segundos.",
      modal_direct_link: "Se o download não começar: Clique aqui",
      sec_title: "Como mantemos o Miruo seguro",
      sec_sub: "Implementamos criptografia de ponta a ponta, segurança rigorosa no servidor e políticas de zero registros para proteger sua privacidade.",
      sec_c1_title: "Criptografia de Ponta a Ponta",
      sec_c1_desc: "Seus fluxos de voz e vídeo são criptografados diretamente entre participantes com WebRTC DTLS-SRTP.",
      sec_c2_title: "Zero Registros no Servidor",
      sec_c2_desc: "Conversas de voz e mensagens nas salas nunca são armazenadas nem monitoradas em nossos servidores.",
      sec_c3_title: "Proteção de Senha e Hash",
      sec_c3_desc: "Suas senhas nunca são salvas em texto simples. Cada usuário é protegido com salt exclusivo e o forte algoritmo scrypt.",
      sec_c4_title: "Proteção contra Spam e Bots",
      sec_c4_desc: "Mecanismos inteligentes de limitação de requisições e defesa DoS barram tentativas de invasão.",
      sec_c5_title: "Segurança contra XSS",
      sec_c5_desc: "Mensagens e comandos passam por filtros rígidos contra injeção de scripts maliciosos.",
      sec_c6_title: "Exclusão Permanente de Conta",
      sec_c6_desc: "Respeitamos seu controle. Você pode excluir sua conta permanentemente a qualquer momento nas Configurações.",
      faq_title: "Perguntas Frequentes",
      faq_q1: "O que é o Miruo e como funciona?",
      faq_a1: "O Miruo é uma plataforma de nova geração para assistir ao YouTube e vídeos sincronizados com amigos em tempo real, sem atraso.",
      faq_q2: "O Miruo é gratuito?",
      faq_a2: "Sim! Baixar o Miruo, criar salas e assistir com amigos é 100% gratuito.",
      faq_q3: "Quais dispositivos são compatíveis?",
      faq_a3: "O Miruo é compatível com Mac, iPhone (iOS), Android e computadores Windows.",
      faq_q4: "Como funciona a sincronização?",
      faq_a4: "Quando alguém pausa ou avança, as telas de todos na sala atualizam instantaneamente em milissegundos.",
      faq_q5: "Como convidar amigos para a sala?",
      faq_a5: "Copie o link da sala ou o código de 6 dígitos e compartilhe pelo WhatsApp, Telegram ou Discord.",
      faq_q6: "Tem bate-papo por voz e texto?",
      faq_a6: "Sim! Você pode conversar por texto a qualquer momento ou ligar o microfone para falar ao vivo enquanto assiste.",
      faq_q7: "Posso excluir minha conta permanentemente?",
      faq_a7: "Sim, você pode apagar sua conta e todos os dados a qualquer momento nas Configurações do app.",
      faq_q8: "Preciso de uma conta extra para assistir vídeos?",
      faq_a8: "Não. Você pode reproduzir conteúdos do YouTube diretamente dentro da sala sem cadastros extras.",
      contact_title: "Fale Conosco",
      contact_name_label: "Seu Nome",
      contact_name_placeholder: "João Silva",
      contact_email_label: "Seu E-mail",
      contact_email_placeholder: "joao@exemplo.com",
      contact_user_label: "Nome de usuário",
      contact_user_placeholder: "@joaosilva123",
      contact_subject_label: "Assunto",
      contact_subject_placeholder: "Como podemos ajudar?",
      contact_msg_label: "Sua Mensagem",
      contact_msg_placeholder: "Descreva sua dúvida ou sugestão em detalhes...",
      contact_submit_btn: "Enviar mensagem",
      contact_sent_btn: "Mensagem Enviada ✓",
      contact_toast: "Sua mensagem foi enviada com sucesso!",
      press_title: "Kit de Imprensa e Mídia",
      press_lead: "A história de origem, identidade visual e ativos oficiais de imprensa do Miruo.",
      press_story_title: "Nossa História",
      press_story_p: "O Miruo nasceu da convicção de que a distância física nunca deve impedir amigos de se reunirem para assistir a filmes e se divertirem juntos.",
      press_assets_title: "Ativos Oficiais da Marca",
      press_asset1_title: "Mascote Coruja Oficial",
      press_asset1_sub: "512x512 PNG",
      press_asset2_title: "Logo Tipográfico",
      press_asset2_sub: "Fonte Vetorial e Cores",
      press_download_btn: "Baixar (.PNG)",
      priv_badge: "POLÍTICA DE PRIVACIDADE",
      priv_title: "Política de Privacidade do Miruo",
      priv_date: "Última atualização: 9 de outubro de 2026",
      priv_highlight: "No Miruo respeitamos profundamente sua privacidade. Nunca vendemos ou compartilhamos seus dados pessoais com terceiros sem seu consentimento.",
      priv_s1_h: "1. Dados Coletados",
      priv_s1_p: "Processamos apenas o mínimo necessário: seu endereço de e-mail, nome de usuário escolhido e tokens de autenticação.",
      priv_s2_h: "2. Como Usamos Seus Dados",
      priv_s2_p: "Os dados coletados são usados exclusivamente para proteger sua conta e garantir sincronização perfeita de vídeo.",
      priv_s3_h: "3. Terceiros e Publicidade",
      priv_s3_p: "O Miruo não possui rastreadores de anúncios. Sessões de voz e vídeo são criptografadas e nunca gravadas em servidores.",
      priv_s4_h: "4. Exclusão de Conta em Um Clique",
      priv_s4_p: "Os usuários podem apagar permanentemente todos os seus dados dos servidores nas Configurações a qualquer momento.",
      priv_s5_h: "5. Direitos de Privacidade e LGPD",
      priv_s5_p: "Usuários têm pleno direito de acessar, corrigir ou solicitar a exclusão total de seus dados pessoais.",
      priv_s5_contact: "Para solicitações de dados:",
      terms_badge: "TERMOS DE USO",
      terms_title: "Termos de Serviço do Miruo",
      terms_date: "Última atualização: 9 de outubro de 2026",
      terms_s1_h: "1. Aceitação Geral",
      terms_s1_p: "Ao utilizar o Miruo na web, desktop ou dispositivos móveis, você concorda com estes termos de uso.",
      terms_s2_h: "2. Escopo do Serviço e Direitos Autorais",
      terms_s2_p: "O Miruo não armazena arquivos de vídeo com direitos autorais. O conteúdo é reproduzido diretamente através do YouTube ou assinaturas oficiais.",
      terms_s3_h: "3. Diretrizes da Comunidade",
      terms_s3_p: "É expressamente proibido assédio, discurso de ódio ou tentativas de ataques contra a infraestrutura do servidor.",
      terms_s4_h: "4. Segurança e Cancelamento",
      terms_s4_p: "Você é responsável pela segurança de sua conta e pode encerrá-la a qualquer momento.",
      terms_s5_h: "5. Contato",
      terms_s5_p: "Para dúvidas sobre estes termos:"
    },
    ru: {
      nav_security: "Безопасность",
      nav_privacy: "Конфиденциальность",
      nav_faq: "FAQ",
      nav_press: "Пресса",
      nav_contact: "Контакты",
      nav_back_home: "← На главную",
      footer_privacy: "Конфиденциальность",
      footer_security: "Безопасность",
      footer_terms: "Условия использования",
      footer_faq: "FAQ",
      footer_press: "Пресса",
      footer_contact: "Контакты",
      footer_copy: "© 2026 Miruo Inc.",
      hero_title: "СМОТРЕТЬ ВМЕСТЕ",
      modal_title: "Загрузка Miruo...",
      modal_sub: "Загрузка начнется автоматически через несколько секунд.",
      modal_direct_link: "Если загрузка не началась: Нажмите сюда",
      sec_title: "Как мы защищаем Miruo",
      sec_sub: "Мы используем сквозное шифрование, строгую безопасность серверов и протоколы без сохранения данных для вашей защиты.",
      sec_c1_title: "Сквозное шифрование",
      sec_c1_desc: "Голосовые и видеопотоки шифруются напрямую между устройствами по стандарту WebRTC DTLS-SRTP.",
      sec_c2_title: "Без логов на сервере",
      sec_c2_desc: "Голосовые звонки и сообщения в комнатах никогда не сохраняются и не отслеживаются на серверах.",
      sec_c3_title: "Защита паролей и хэширование",
      sec_c3_desc: "Пароли никогда не хранятся в открытом виде, каждый пароль защищен индивидуальной солью и алгоритмом scrypt.",
      sec_c4_title: "Защита от спама и ботов",
      sec_c4_desc: "Интеллектуальное ограничение запросов и защита от DoS отражают попытки подбора паролей.",
      sec_c5_title: "Защита от XSS",
      sec_c5_desc: "Сообщения и команды строго фильтруются для предотвращения внедрения стороннего кода.",
      sec_c6_title: "Удаление аккаунта в один клик",
      sec_c6_desc: "Полный контроль: вы можете безвозвратно удалить свой аккаунт в любой момент в настройках.",
      faq_title: "Часто задаваемые вопросы",
      faq_q1: "Что такое Miruo и как это работает?",
      faq_a1: "Miruo — это платформа нового поколения для совместного просмотра YouTube и видео с друзьями в реальном времени без задержек.",
      faq_q2: "Miruo полностью бесплатен?",
      faq_a2: "Да! Скачивание Miruo, создание комнат и совместный просмотр на 100% бесплатны.",
      faq_q3: "Какие устройства поддерживаются?",
      faq_a3: "Miruo работает на Mac, iPhone (iOS), Android и компьютерах с Windows.",
      faq_q4: "Как работает синхронизация?",
      faq_a4: "Когда кто-то ставит на паузу или перематывает, экраны всех участников синхронизируются за миллисекунды.",
      faq_q5: "Как пригласить друзей?",
      faq_a5: "Скопируйте ссылку на комнату или 6-значный код и отправьте в WhatsApp, Telegram или Discord.",
      faq_q6: "Есть ли голосовой и текстовый чат?",
      faq_a6: "Да! Вы можете переписываться в чате или включить голосовую связь во время просмотра.",
      faq_q7: "Можно ли навсегда удалить аккаунт?",
      faq_a7: "Да, вы можете в любой момент удалить свой аккаунт и все связанные данные в Настройках.",
      faq_q8: "Нужен ли дополнительный аккаунт для видео?",
      faq_a8: "Нет, контент YouTube доступен для просмотра прямо в комнате без лишних регистраций.",
      contact_title: "Связаться с нами",
      contact_name_label: "Ваше имя",
      contact_name_placeholder: "Иван Иванов",
      contact_email_label: "Ваш Email",
      contact_email_placeholder: "ivan@example.com",
      contact_user_label: "Имя пользователя",
      contact_user_placeholder: "@ivan123",
      contact_subject_label: "Тема",
      contact_subject_placeholder: "Чем мы можем помочь?",
      contact_msg_label: "Ваше сообщение",
      contact_msg_placeholder: "Опишите ваш вопрос или предложение подробно...",
      contact_submit_btn: "Отправить сообщение",
      contact_sent_btn: "Сообщение отправлено ✓",
      contact_toast: "Ваше сообщение успешно отправлено!",
      press_title: "Пресс-кит и медиа",
      press_lead: "История создания, фирменный стиль и официальные медиаматериалы Miruo.",
      press_story_title: "Наша история",
      press_story_p: "Miruo создан с верой в то, что расстояние не должно мешать друзьям собираться вместе и смотреть любимые фильмы.",
      press_assets_title: "Фирменные материалы",
      press_asset1_title: "Официальный маскот Сова",
      press_asset1_sub: "512x512 PNG",
      press_asset2_title: "Типографический логотип",
      press_asset2_sub: "Векторный шрифт и цвета",
      press_download_btn: "Скачать (.PNG)",
      priv_badge: "КОНФИДЕНЦИАЛЬНОСТЬ",
      priv_title: "Политика конфиденциальности Miruo",
      priv_date: "Последнее обновление: 9 октября 2026 г.",
      priv_highlight: "Мы уважаем вашу конфиденциальность. Мы никогда не продаем и не передаем ваши данные третьим лицам.",
      priv_s1_h: "1. Собираемые данные",
      priv_s1_p: "Мы обрабатываем минимум данных: адрес электронной почты, логин и токены авторизации.",
      priv_s2_h: "2. Использование данных",
      priv_s2_p: "Данные используются исключительно для безопасности аккаунта и синхронизации видеопотоков.",
      priv_s3_h: "3. Третьи стороны и реклама",
      priv_s3_p: "В Miruo нет рекламных трекеров. Голосовые сессии защищены сквозным шифрованием и не записываются.",
      priv_s4_h: "4. Удаление данных в один клик",
      priv_s4_p: "Пользователи могут в любой момент навсегда удалить все свои данные с серверов в Настройках.",
      priv_s5_h: "5. Права пользователей",
      priv_s5_p: "Вы имеете полное право запросить доступ, исправление или удаление своих персональных данных.",
      priv_s5_contact: "По вопросам данных:",
      terms_badge: "УСЛОВИЯ ИСПОЛЬЗОВАНИЯ",
      terms_title: "Условия использования Miruo",
      terms_date: "Последнее обновление: 9 октября 2026 г.",
      terms_s1_h: "1. Принятие условий",
      terms_s1_p: "Используя Miruo, вы соглашаетесь с данными условиями совместного просмотра контента.",
      terms_s2_h: "2. Объем услуг и авторские права",
      terms_s2_p: "Miruo не размещает видеофайлы на своих серверах. Воспроизведение происходит через официальные плееры YouTube.",
      terms_s3_h: "3. Правила сообщества",
      terms_s3_p: "Оскорбления, домогательства и любые попытки атак на серверную инфраструктуру строго запрещены.",
      terms_s4_h: "4. Безопасность и прекращение",
      terms_s4_p: "Вы несете ответственность за свой аккаунт и можете закрыть его в любой момент.",
      terms_s5_h: "5. Контакты",
      terms_s5_p: "По вопросам данных условий:"
    }
  };

  function applyLanguage(lang) {
    if (!miruoTranslations[lang]) lang = 'tr';
    try {
      localStorage.setItem('miruo_lang', lang);
    } catch (e) {}

    document.documentElement.lang = lang;
    const dict = miruoTranslations[lang];

    // Text content translation
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (dict[key] !== undefined) {
        el.textContent = dict[key];
      }
    });

    // Placeholder translation
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (dict[key] !== undefined) {
        el.placeholder = dict[key];
      }
    });

    // Synchronize select value
    const footerSelect = document.getElementById('footerLangSelect');
    if (footerSelect && footerSelect.value !== lang) {
      footerSelect.value = lang;
    }
  }

  // Initialize Language
  let activeLang = 'tr';
  try {
    activeLang = localStorage.getItem('miruo_lang') || 'tr';
  } catch (e) {}

  applyLanguage(activeLang);

  const footerLangSelect = document.getElementById('footerLangSelect');
  if (footerLangSelect) {
    footerLangSelect.value = activeLang;
    footerLangSelect.addEventListener('change', function () {
      applyLanguage(this.value);
    });
  }

  // 8. SMOOTH SCROLLING FOR NAVIGATION LINKS
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', function (e) {
      const targetId = this.getAttribute('href');
      if (targetId && targetId !== '#') {
        const target = document.querySelector(targetId);
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth' });
        }
      }
    });
  });

  // Expose
  window.openDownloadModal = openDownloadModal;
  window.showToast = showToast;

  // Auto open modal if requested via URL hash/query
  if (window.location.hash === '#mac' || window.location.search.includes('download=mac')) {
    setTimeout(() => openDownloadModal('mac'), 200);
  } else if (window.location.hash === '#windows' || window.location.search.includes('download=windows')) {
    setTimeout(() => openDownloadModal('windows'), 200);
  }
})();
