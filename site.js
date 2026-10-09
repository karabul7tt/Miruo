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

  // 7. LANGUAGE SELECTOR DROPDOWN
  const langTrigger = document.getElementById('langTrigger');
  const langMenu = document.getElementById('langMenu');
  if (langTrigger && langMenu) {
    langTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      langMenu.classList.toggle('hidden');
    });
    document.addEventListener('click', () => {
      langMenu.classList.add('hidden');
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
