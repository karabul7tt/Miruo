/**
 * Koltuk (CouchSync) — Client-side Core Architecture
 * - P2P WebRTC Audio/Video + Screen Share
 * - Dual Engine Player (YouTube IFrame + Native Video)
 * - Smart Audio Ducking (Web Audio API Analyser)
 * - Virtual Living Room Interactive Touch & Reactions
 */

// Supabase Auth Integration
const DEFAULT_SUPABASE_URL = 'https://qvmdzfhjfdoqjmqipvux.supabase.co';
const DEFAULT_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF2bWR6ZmhqZmRvcWptcWlwdnV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0MTk0NDYsImV4cCI6MjEwNjk5NTQ0Nn0.lkqfTJCr5ZJT6SDi13k8RKlOpabBZE8TiT42ehwYqzM';

const savedUrl = localStorage.getItem('miruo_supabase_url');
const savedKey = localStorage.getItem('miruo_supabase_anon_key');

const SUPABASE_CONFIG = {
  url: (savedUrl && savedUrl.includes('supabase.co')) ? savedUrl : DEFAULT_SUPABASE_URL,
  anonKey: (savedKey && !savedKey.includes('.signature') && savedKey.length > 50) ? savedKey : DEFAULT_SUPABASE_KEY
};
localStorage.setItem('miruo_supabase_url', SUPABASE_CONFIG.url);
localStorage.setItem('miruo_supabase_anon_key', SUPABASE_CONFIG.anonKey);

let supabaseClient = null;
function initSupabase() {
  try {
    if (window.supabase && typeof window.supabase.createClient === 'function') {
      supabaseClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
      console.log('[Miruo] Supabase Auth initialized successfully with project:', SUPABASE_CONFIG.url);

      // Check existing session from Supabase
      supabaseClient.auth.getSession().then(({ data: { session } }) => {
        if (session && session.user) {
          applySupabaseSessionUser(session.user);
        }
      }).catch(err => console.warn('[Miruo] getSession warning:', err));

      // Listen for auth state changes (OAuth callback, login, logout)
      supabaseClient.auth.onAuthStateChange((event, session) => {
        console.log('[Miruo] Supabase auth state change event:', event);
        if (session && session.user) {
          applySupabaseSessionUser(session.user);
        }
      });
    }
  } catch (err) {
    console.warn('[Miruo] Supabase init warning:', err);
  }
}

function syncUserProfileToSupabase(user) {
  if (!user || !supabaseClient) return;
  try {
    if (supabaseClient.auth && user.name) {
      supabaseClient.auth.updateUser({
        data: {
          username: user.name,
          name: user.name,
          avatar_url: user.avatarUrl || '',
          avatar_bg: user.avatarBg || ''
        }
      }).catch(e => console.warn('[Supabase Profile Update Error]:', e));
    }
    supabaseClient.from('profiles').upsert({
      id: user.id,
      username: user.name,
      avatar_url: user.avatarUrl || '',
      updated_at: new Date().toISOString()
    }).catch(e => console.warn('[Supabase profiles upsert info]:', e));
  } catch (err) {
    console.warn('[Supabase sync error]:', err);
  }
}

function applySupabaseSessionUser(sbUser) {
  if (!sbUser) return;
  const meta = sbUser.user_metadata || {};
  const displayName = meta.full_name || meta.name || meta.username || sbUser.email?.split('@')[0] || 'Kullanıcı';
  const user = {
    id: sbUser.id,
    name: displayName,
    email: sbUser.email || '',
    avatarUrl: meta.avatar_url || meta.picture || '',
    avatarChar: displayName.charAt(0).toUpperCase(),
    avatarBg: meta.avatar_bg || 'from-violet-600 to-indigo-700',
    defaultRoom: 'ODA-77'
  };
  localStorage.setItem('miruo_user', JSON.stringify(user));
  state.userId = user.id;
  state.username = user.name;
  if (typeof updateUserUI === 'function') {
    updateUserUI(user);
  }
  syncUserProfileToSupabase(user);
}

initSupabase();

// ==========================================
// UNIVERSAL PHOTO & GALLERY PICKER BRIDGE
// (Native iOS PHPickerViewController + Web File Input fallback)
// ==========================================
function triggerPhotoPicker(target = 'avatar') {
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pickImage) {
    try {
      window.webkit.messageHandlers.pickImage.postMessage({ target: target });
      return;
    } catch (e) {
      console.warn('[Miruo] Native image picker bridge warning:', e);
    }
  }

  // Web Browser / Standard HTML fallback
  if (target === 'avatar') {
    const el = (dom && dom.avatarFileInput) || document.getElementById('avatarFileInput');
    if (el) el.click();
  } else if (target === 'chat') {
    const el = document.getElementById('chatImageFileInput');
    if (el) el.click();
  } else if (target === 'signup') {
    const el = (dom && dom.signUpAvatarFileInput) || document.getElementById('signUpAvatarFileInput');
    if (el) el.click();
  }
}
window.triggerPhotoPicker = triggerPhotoPicker;

window.handleNativeImagePicked = function(base64Data, target) {
  if (!base64Data) return;
  if (target === 'avatar') {
    pendingAvatarUrl = base64Data;
    pendingAvatarBg = '';
    const previewEl = (dom && dom.editAvatarPreview) || document.getElementById('editAvatarPreview');
    if (previewEl) {
      previewEl.innerHTML = `<img src="${pendingAvatarUrl}" class="w-full h-full object-cover" alt="PP">`;
      previewEl.className = 'w-22 h-22 rounded-2xl overflow-hidden shadow-xl border-2 border-white/20 ring-4 ring-white/5 flex items-center justify-center';
    }
    showToast('Profil fotoğrafı seçildi! "Kaydet"e basın ✨');
  } else if (target === 'chat') {
    sendChatMessage('', base64Data);
    showToast('📷 Fotoğraf sohbete yüklendi!');
    const stickerPopover = document.getElementById('chatStickerPopover');
    if (stickerPopover) stickerPopover.classList.add('hidden');
  } else if (target === 'signup') {
    selectedSignUpAvatarData = base64Data;
    const previewEl = (dom && dom.signUpAvatarPreview) || document.getElementById('signUpAvatarPreview');
    if (previewEl) {
      previewEl.innerHTML = `<img src="${base64Data}" class="w-full h-full object-cover rounded-full" alt="Avatar">`;
    }
    showToast('Kayıt fotoğrafı seçildi ✨');
  }
};

// ==========================================
// MULTI-LANGUAGE (i18n) ENGINE (TR / EN / DE)
// ==========================================
const I18N = {
  tr: {
    app_title: 'Miruo — Birlikte Gör & İzle',
    tagline: 'Birlikte İzle & Konuş',
    nav_settings: 'Ayarlar',
    nav_friends: 'Arkadaşlar',
    nav_profile: 'Profil',
    nav_explore: 'Keşfet',
    hero_title: 'Birlikte İzle. Birlikte Gül. Senkronize.',
    hero_subtitle: 'YouTube, Netflix, Prime ve daha fazlasını arkadaşlarınla sıfır gecikmeyle, sesli ve görüntülü sohbet eşliğinde aynı anda izle.',
    create_room: 'Oda Kur',
    join_room: 'Hızlı Katıl',
    live_rooms: 'Canlı Odalar',
    search_rooms_ph: 'Oda veya arkadaş ara...',
    no_rooms_found: 'Aramanıza uygun oda bulunamadı.',
    watch_platforms: 'İzleme Platformları',
    all_platforms: 'Tüm Platformlar',
    tab_profile: 'Profil & PP',
    tab_settings: 'Ayarlar',
    tab_accounts: 'Hesaplar',
    display_name: 'Görünen İsim (Kullanıcı Adı)',
    default_room_code: 'Varsayılan / Ortak Oda Kodu',
    registered_email: 'Kayıtlı E-posta',
    active_session: 'Aktif Oturum',
    save_changes: 'Değişiklikleri Kaydet',
    logout: 'Oturumu Kapat',
    select_photo: 'Fotoğraf Seç',
    upload_photo: 'Fotoğraf Yükle',
    remove_photo: 'Kaldır',
    preset_avatars: 'veya hazır renkli avatar seçin:',
    language_title: 'Uygulama Dili / Language / Sprache',
    ducking_title: 'Akıllı Ses Kısma (Ducking) Seviyesi',
    ducking_desc: 'Partner konuştuğunda film sesinin düşeceği hedef ses düzeyi.',
    mic_sens_title: 'Mikrofon Hassasiyeti (Konuşma Eşiği)',
    pip_corner_title: 'Tam Ekran Kamera Konumu',
    pip_corner_desc: 'Tam ekran modunda video kameranın duracağı köşe:',
    pip_show_camera: 'Tam ekranda kamera görünsün',
    corner_br: '↘️ Sağ Alt (Varsayılan)',
    corner_bl: '↙️ Sol Alt',
    corner_tr: '↗️ Sağ Üst',
    corner_tl: '↖️ Sol Üst',
    accounts_info: 'Platform hesaplarınıza (YouTube, Netflix, Prime vb.) dahili tarayıcı üzerinden doğrudan giriş yapabilirsiniz. YouTube Premium ve üyelikleriniz cihazınızda güvenle saklanır.',
    open_in_browser: 'Giriş Yap / Aç ↗',
    yt_card_sub: 'Oynatma listeleri, arama & Premium',
    netflix_card_sub: 'Dizi & Film İzleme',
    prime_card_sub: 'Amazon Prime Yayını',
    disney_card_sub: 'Disney, Marvel & Star Wars',
    create_room_title: 'Yeni İzleme Odası',
    room_name_label: 'Oda Adı',
    platform_label: 'İçerik Platformu',
    public_room: 'Açık Oda (Herkes katılabilir)',
    private_room: 'Özel / Kilitli (Sadece kodla)',
    create_and_start: 'Oluştur & Başlat',
    cancel: 'Vazgeç',
    join_modal_title: 'Odaya Katıl',
    join_code_ph: 'ODA KODU VEYA LİNK GİR...',
    join_btn: 'Katıl',
    auth_title: 'Miruo\'ya Giriş Yap',
    login_tab: 'Giriş Yap',
    register_tab: 'Kayıt Ol',
    email_label: 'E-posta Adresi',
    password_label: 'Şifre',
    remember_me: 'Beni Hatırla',
    forgot_password: 'Şifremi Unuttum?',
    login_btn: 'Giriş Yap',
    register_btn: 'Hesap Oluştur',
    rave_title: 'YouTube',
    rave_subtitle: 'Video seçin ve odadakilerle birlikte izleyin.',
    rave_search_ph: 'YouTube\'da şarkı, klip, sanatçı, dizi veya kanal ara...',
    rave_search_btn: 'Ara',
    rave_tab_trending: '🔥 Trendler',
    rave_tab_music: '🎵 Popüler Müzik',
    rave_tab_lofi: '☕ 24/7 Lo-Fi',
    rave_footer_info: 'Odadakilerle senkronize izlemek için videoya dokunun',
    stage_waiting: 'İzlemek için bir video seçin veya bağlantı yapıştırın',
    chat_tab: 'Sohbet',
    people_tab: 'Katılımcılar',
    chat_ph: 'Mesaj yaz...',
    send: 'Gönder',
    leave_room: 'Ayrıl',
    change_video: 'Video Değiştir',
    refresh_btn: 'Yenile',
    invite_copied: 'Oda davet linki kopyalandı! 📋',
    profile_updated: 'Profil ve tercihler güncellendi ✨',
    lang_changed: 'Uygulama dili Türkçe olarak ayarlandı 🇹🇷',
    synced: 'Senkronize edildi',
    room_participants_title: 'Odadakiler',
    room_participants_sub: 'Katılımcı rolleri ve oda yönetimi',
    host_banner_title: 'Oda Sahibisin:',
    host_banner_desc: 'Katılımcılara video açma izni verebilir, yönetici yapabilir veya odadan çıkarabilirsin.',
    copy_invite_link: 'Oda Davet Linkini Kopyala',
    cam_toggle: 'Kamera',
    kick_user_label: 'Çıkar',
    role_admin_label: 'Yönetici',
    role_dj_label: 'Video Açabilir',
    role_member_label: 'İzleyici'
  },
  en: {
    app_title: 'Miruo — Watch & See Together',
    tagline: 'Watch & Talk Together',
    nav_settings: 'Settings',
    nav_friends: 'Friends',
    nav_profile: 'Profile',
    nav_explore: 'Explore',
    hero_title: 'Watch Together. Laugh Together. Synchronized.',
    hero_subtitle: 'Watch YouTube, Netflix, Prime and more with friends in zero latency alongside live voice and video chat.',
    create_room: 'Create Room',
    join_room: 'Quick Join',
    live_rooms: 'Live Rooms',
    search_rooms_ph: 'Search rooms or friends...',
    no_rooms_found: 'No rooms found matching your search.',
    watch_platforms: 'Streaming Platforms',
    all_platforms: 'All Platforms',
    tab_profile: 'Profile & PP',
    tab_settings: 'Settings',
    tab_accounts: 'Accounts',
    display_name: 'Display Name (Username)',
    default_room_code: 'Default / Shared Room Code',
    registered_email: 'Registered Email',
    active_session: 'Active Session',
    save_changes: 'Save Changes',
    logout: 'Log Out',
    select_photo: 'Choose Photo',
    upload_photo: 'Upload Photo',
    remove_photo: 'Remove',
    preset_avatars: 'or choose a preset avatar:',
    language_title: 'App Language / Dil / Sprache',
    ducking_title: 'Smart Audio Ducking Level',
    ducking_desc: 'Target movie audio volume when your partner speaks.',
    mic_sens_title: 'Microphone Sensitivity (Voice Gate)',
    pip_corner_title: 'Fullscreen Camera Position',
    pip_corner_desc: 'Corner where camera overlay stays in fullscreen:',
    pip_show_camera: 'Show camera in fullscreen',
    corner_br: '↘️ Bottom Right (Default)',
    corner_bl: '↙️ Bottom Left',
    corner_tr: '↗️ Top Right',
    corner_tl: '↖️ Top Left',
    accounts_info: 'You can log into your platform accounts (YouTube, Netflix, Prime etc.) directly via the in-app browser. Your YouTube Premium and subscriptions are saved securely on your device.',
    open_in_browser: 'Sign In / Open ↗',
    yt_card_sub: 'Playlists, search & Premium',
    netflix_card_sub: 'Movies & TV Shows',
    prime_card_sub: 'Amazon Prime Streaming',
    disney_card_sub: 'Disney, Marvel & Star Wars',
    create_room_title: 'New Watch Room',
    room_name_label: 'Room Name',
    platform_label: 'Content Platform',
    public_room: 'Public Room (Anyone can join)',
    private_room: 'Private / Locked (Code only)',
    create_and_start: 'Create & Start',
    cancel: 'Cancel',
    join_modal_title: 'Join Room',
    join_code_ph: 'ENTER ROOM CODE OR LINK...',
    join_btn: 'Join',
    auth_title: 'Sign in to Miruo',
    login_tab: 'Sign In',
    register_tab: 'Sign Up',
    email_label: 'Email Address',
    password_label: 'Password',
    remember_me: 'Remember Me',
    forgot_password: 'Forgot Password?',
    login_btn: 'Sign In',
    register_btn: 'Create Account',
    rave_title: 'YouTube',
    rave_subtitle: 'Choose a video and watch together with the room.',
    rave_search_ph: 'Search songs, clips, artists or channels on YouTube...',
    rave_search_btn: 'Search',
    rave_tab_trending: '🔥 Trending',
    rave_tab_music: '🎵 Popular Music',
    rave_tab_lofi: '☕ 24/7 Lo-Fi',
    rave_footer_info: 'Tap any video to watch in sync with friends',
    stage_waiting: 'Select a video or paste a link to start watching',
    chat_tab: 'Chat',
    people_tab: 'Participants',
    chat_ph: 'Type a message...',
    send: 'Send',
    leave_room: 'Leave',
    change_video: 'Change Video',
    refresh_btn: 'Refresh',
    invite_copied: 'Room invite link copied! 📋',
    profile_updated: 'Profile and preferences updated ✨',
    lang_changed: 'Language set to English 🇬🇧',
    synced: 'Synchronized',
    room_participants_title: 'Room Participants',
    room_participants_sub: 'Participant roles and room management',
    host_banner_title: 'Room Host:',
    host_banner_desc: 'You can grant video control permissions, make admins, or remove participants.',
    copy_invite_link: 'Copy Room Invite Link',
    cam_toggle: 'Camera',
    kick_user_label: 'Kick',
    role_admin_label: 'Admin',
    role_dj_label: 'Video Control',
    role_member_label: 'Viewer'
  },
  de: {
    app_title: 'Miruo — Zusammen Sehen & Schauen',
    tagline: 'Gemeinsam schauen & sprechen',
    nav_settings: 'Einstellungen',
    nav_friends: 'Freunde',
    nav_profile: 'Profil',
    nav_explore: 'Entdecken',
    hero_title: 'Gemeinsam schauen. Gemeinsam lachen. Synchron.',
    hero_subtitle: 'Schauen Sie YouTube, Netflix, Prime und mehr mit Freunden ohne Verzögerung bei gleichzeitigem Sprach- und Video-Chat.',
    create_room: 'Raum erstellen',
    join_room: 'Schnell beitreten',
    live_rooms: 'Live-Räume',
    search_rooms_ph: 'Räume oder Freunde suchen...',
    no_rooms_found: 'Keine passenden Räume gefunden.',
    watch_platforms: 'Streaming-Plattformen',
    all_platforms: 'Alle Plattformen',
    tab_profile: 'Profil & PP',
    tab_settings: 'Einstellungen',
    tab_accounts: 'Konten',
    display_name: 'Anzeigename (Benutzername)',
    default_room_code: 'Standard- / Raumcode',
    registered_email: 'Registrierte E-Mail',
    active_session: 'Aktive Sitzung',
    save_changes: 'Änderungen speichern',
    logout: 'Abmelden',
    select_photo: 'Foto wählen',
    upload_photo: 'Foto hochladen',
    remove_photo: 'Entfernen',
    preset_avatars: 'oder wählen Sie einen Avatar:',
    language_title: 'App-Sprache / Language / Dil',
    ducking_title: 'Intelligente Audio-Absenkung',
    ducking_desc: 'Ziel-Lautstärke des Films, wenn der Partner spricht.',
    mic_sens_title: 'Mikrofon-Empfindlichkeit (Voice Gate)',
    pip_corner_title: 'Vollbild-Kameraposition',
    pip_corner_desc: 'Ecke für die Kameraüberlagerung im Vollbild:',
    pip_show_camera: 'Kamera im Vollbild anzeigen',
    corner_br: '↘️ Unten Rechts (Standard)',
    corner_bl: '↙️ Unten Links',
    corner_tr: '↗️ Oben Rechts',
    corner_tl: '↖️ Oben Links',
    accounts_info: 'Sie können sich über den In-App-Browser direkt bei Ihren Plattformkonten (YouTube, Netflix, Prime usw.) anmelden. Ihr YouTube Premium und Ihre Abonnements werden sicher auf Ihrem Gerät gespeichert.',
    open_in_browser: 'Anmelden / Öffnen ↗',
    yt_card_sub: 'Playlists, Suche & Premium',
    netflix_card_sub: 'Serien & Filme',
    prime_card_sub: 'Amazon Prime Streaming',
    disney_card_sub: 'Disney, Marvel & Star Wars',
    create_room_title: 'Neuer Raum',
    room_name_label: 'Raumname',
    platform_label: 'Plattform',
    public_room: 'Öffentlicher Raum (Jeder kann beitreten)',
    private_room: 'Privater Raum (Nur mit Code)',
    create_and_start: 'Erstellen & Starten',
    cancel: 'Abbrechen',
    join_modal_title: 'Raum beitreten',
    join_code_ph: 'RAUMCODE ODER LINK EINGEBEN...',
    join_btn: 'Beitreten',
    auth_title: 'Bei Miruo anmelden',
    login_tab: 'Anmelden',
    register_tab: 'Registrieren',
    email_label: 'E-Mail-Adresse',
    password_label: 'Passwort',
    remember_me: 'Angemeldet bleiben',
    forgot_password: 'Passwort vergessen?',
    login_btn: 'Anmelden',
    register_btn: 'Konto erstellen',
    rave_title: 'YouTube',
    rave_subtitle: 'Video auswählen und gemeinsam im Raum ansehen.',
    rave_search_ph: 'Auf YouTube nach Videos, Musik oder Kanälen suchen...',
    rave_search_btn: 'Suchen',
    rave_tab_trending: '🔥 Trends',
    rave_tab_music: '🎵 Beliebte Musik',
    rave_tab_lofi: '☕ 24/7 Lo-Fi',
    rave_footer_info: 'Tippen Sie auf ein Video, um es synchron anzusehen',
    stage_waiting: 'Wählen Sie ein Video oder fügen Sie einen Link ein',
    chat_tab: 'Chat',
    people_tab: 'Teilnehmer',
    chat_ph: 'Nachricht schreiben...',
    send: 'Senden',
    leave_room: 'Verlassen',
    change_video: 'Video ändern',
    refresh_btn: 'Aktualisieren',
    invite_copied: 'Raum-Einladungslink kopiert! 📋',
    profile_updated: 'Profil und Einstellungen aktualisiert ✨',
    lang_changed: 'Sprache auf Deutsch gesetzt 🇩🇪',
    synced: 'Synchronisiert',
    room_participants_title: 'Teilnehmer',
    room_participants_sub: 'Teilnehmerrollen und Raumverwaltung',
    host_banner_title: 'Raumleiter:',
    host_banner_desc: 'Sie können Videoberechtigungen vergeben, Administratoren ernennen oder Teilnehmer entfernen.',
    copy_invite_link: 'Raum-Einladungslink kopieren',
    cam_toggle: 'Kamera',
    kick_user_label: 'Entfernen',
    role_admin_label: 'Moderator',
    role_dj_label: 'Video-Erlaubnis',
    role_member_label: 'Zuschauer'
  }
};

let currentLang = localStorage.getItem('miruo_lang') || 'tr';

function applyLanguage(lang) {
  if (!I18N[lang]) lang = 'tr';
  currentLang = lang;
  localStorage.setItem('miruo_lang', lang);
  document.documentElement.lang = lang;

  const dict = I18N[lang];
  if (dict.app_title) document.title = dict.app_title;

  // Update text nodes with [data-i18n]
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key]) {
      el.textContent = dict[key];
    }
  });

  // Update placeholders with [data-i18n-placeholder]
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (dict[key]) {
      el.placeholder = dict[key];
    }
  });

  // Update active style on lang-btns
  document.querySelectorAll('#langSelectorGroup .lang-btn').forEach(btn => {
    if (btn.getAttribute('data-lang') === lang) {
      btn.className = 'lang-btn active p-2.5 rounded-xl border-2 border-rose-500 bg-rose-500/20 text-center font-bold text-white cursor-pointer transition-all shadow-sm';
    } else {
      btn.className = 'lang-btn p-2.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-center font-medium text-gray-300 cursor-pointer transition-all';
    }
  });

  // Update badge in settings
  const badge = document.getElementById('currentLangBadge');
  if (badge) {
    if (lang === 'tr') badge.textContent = '🇹🇷 Türkçe';
    else if (lang === 'en') badge.textContent = '🇬🇧 English';
    else if (lang === 'de') badge.textContent = '🇩🇪 Deutsch';
  }
}

// Standard Miruo Branded Room URL generator
function getMiruoRoomUrl(roomId) {
  const code = (roomId || state.roomId || 'ODA-77').toUpperCase();
  return `https://miruo.app/oda/${encodeURIComponent(code)}`;
}

// Global State
const state = {
  roomId: '',
  userId: 'user_' + Math.random().toString(36).substring(2, 8),
  username: 'Kullanıcı',
  peerId: null,
  activeMode: 'youtube', // 'youtube' | 'screenshare' | 'direct'
  
  // Room Playback Queue & Browsing State
  roomQueue: [],
  isBrowsingNextVideo: false,
  
  // Media Playback
  ytPlayer: null,
  ytReady: false,
  isPlaying: false,
  duration: 0,
  currentTime: 0,
  isRemoteAction: false,
  
  // WebRTC
  pc: null,
  dataChannel: null,
  localStream: null,
  screenStream: null,
  isMicOn: false,
  isCamOn: false,
  isScreenSharing: false,

  // Audio Ducking
  audioCtx: null,
  duckingTargetVolume: 0.3, // 30%
  speechThreshold: 0.08,    // RMS volume threshold
  isDucked: false,
  duckTimeout: null,
  normalVolume: 100,

  // Sleep Mode
  isSleepMode: false,

  // Room Host & DJ Permissions
  isHost: true,
  hostName: 'Sen',
  userRole: 'owner', // 'owner' | 'admin' | 'dj' | 'member'
  controlMode: 'host_only', // 'host_only' | 'everyone'
  hasDjPermission: true,    // Whether current user can control media

  // Friends & Invite
  friendCode: '',
  friends: [],

  // Live Room Participants (Zoom style status tracker)
  participants: {},
  isChatVisible: true
};

// ICE Configuration (Public STUN servers)
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// DOM References
const dom = {
  // Navigation & Room
  mainHeader: document.getElementById('mainHeader'),
  raveFabPlusBtn: document.getElementById('raveFabPlusBtn'),
  roomBadge: document.getElementById('roomBadge'),
  currentRoomDisplay: document.getElementById('currentRoomDisplay'),
  peerStatusBadge: document.getElementById('peerStatusBadge'),
  peerStatusText: document.getElementById('peerStatusText'),
  duckingBadge: document.getElementById('duckingBadge'),
  toggleSleepBtn: document.getElementById('toggleSleepBtn'),
  sleepOverlay: document.getElementById('sleepOverlay'),
  exitSleepBtn: document.getElementById('exitSleepBtn'),
  ambientGlow: document.getElementById('ambientGlow'),

  // Tabs & Multi-Platform Switchers
  tabYoutube: document.getElementById('tabYoutube'),
  tabNetflix: document.getElementById('tabNetflix'),
  tabPrime: document.getElementById('tabPrime'),
  tabSpotify: document.getElementById('tabSpotify'),
  tabScreenShare: document.getElementById('tabScreenShare'),
  tabDirectVideo: document.getElementById('tabDirectVideo'),
  tabYtBadge: document.getElementById('tabYtBadge'),
  tabNetflixBadge: document.getElementById('tabNetflixBadge'),

  // Platform Input Sections
  youtubeInputSection: document.getElementById('youtubeInputSection'),
  netflixInputSection: document.getElementById('netflixInputSection'),
  netflixSectionBadge: document.getElementById('netflixSectionBadge'),
  netflixStartStreamBtn: document.getElementById('netflixStartStreamBtn'),
  screenShareInputSection: document.getElementById('screenShareInputSection'),
  directVideoInputSection: document.getElementById('directVideoInputSection'),
  youtubeUrlInput: document.getElementById('youtubeUrlInput'),
  loadYoutubeBtn: document.getElementById('loadYoutubeBtn'),
  startScreenShareBtn: document.getElementById('startScreenShareBtn'),
  stopScreenShareBtn: document.getElementById('stopScreenShareBtn'),
  selectLocalFileBtn: document.getElementById('selectLocalFileBtn'),
  localVideoFileInput: document.getElementById('localVideoFileInput'),
  directVideoUrlInput: document.getElementById('directVideoUrlInput'),
  loadDirectUrlBtn: document.getElementById('loadDirectUrlBtn'),
  mediaSearchInput: document.getElementById('mediaSearchInput'),
  searchMediaBtn: document.getElementById('searchMediaBtn'),
  toggleCustomLinkBtn: document.getElementById('toggleCustomLinkBtn'),
  customLinkContainer: document.getElementById('customLinkContainer'),
  mediaPickerGrid: document.getElementById('mediaPickerGrid'),
  welcomeAvatarPicker: document.getElementById('welcomeAvatarPicker'),

  // Stage, Fullscreen & Viewports
  stageContainer: document.getElementById('stageContainer'),
  stageFloatingFullscreenBtn: document.getElementById('stageFloatingFullscreenBtn'),
  stageFullscreenIcon: document.getElementById('stageFullscreenIcon'),
  toggleFullscreenBtn: document.getElementById('toggleFullscreenBtn'),
  dockFullscreenIcon: document.getElementById('dockFullscreenIcon'),
  ytPlayerContainer: document.getElementById('ytPlayerContainer'),
  nativeVideoPlayer: document.getElementById('nativeVideoPlayer'),
  remoteScreenPlayer: document.getElementById('remoteScreenPlayer'),
  emptyStatePlaceholder: document.getElementById('emptyStatePlaceholder'),
  syncToast: document.getElementById('syncToast'),
  syncToastMsg: document.getElementById('syncToastMsg'),
  duckingLiveNotice: document.getElementById('duckingLiveNotice'),
  touchLayer: document.getElementById('touchLayer'),

  // Floating PIPs
  partnerPipCard: document.getElementById('partnerPipCard'),
  partnerVideo: document.getElementById('partnerVideo'),
  partnerVideoPlaceholder: document.getElementById('partnerVideoPlaceholder'),
  partnerAudioMeter: document.getElementById('partnerAudioMeter'),
  partnerVoiceIndicator: document.getElementById('partnerVoiceIndicator'),
  closePartnerPipBtn: document.getElementById('closePartnerPipBtn'),
  selfPipCard: document.getElementById('selfPipCard'),
  selfVideo: document.getElementById('selfVideo'),
  selfVideoPlaceholder: document.getElementById('selfVideoPlaceholder'),
  closeSelfPipBtn: document.getElementById('closeSelfPipBtn'),
  selfPipAvatarInitial: document.getElementById('selfPipAvatarInitial'),

  // YouTube Live Classic Format Split Layout & Live Chat Sidebar
  roomMainSplitLayout: document.getElementById('roomMainSplitLayout'),
  roomPlayerColumn: document.getElementById('roomPlayerColumn'),
  roomChatSidebar: document.getElementById('roomChatSidebar'),
  closeChatSidebarBtn: document.getElementById('closeChatSidebarBtn'),
  openChatFloatingBtn: document.getElementById('openChatFloatingBtn'),
  toggleChatToolbarBtn: document.getElementById('toggleChatToolbarBtn'),
  chatToolbarBtnText: document.getElementById('chatToolbarBtnText'),

  // Media Controls
  mainPlayPauseBtn: document.getElementById('mainPlayPauseBtn'),
  playIcon: document.getElementById('playIcon'),
  pauseIcon: document.getElementById('pauseIcon'),
  currentTimeDisplay: document.getElementById('currentTimeDisplay'),
  durationDisplay: document.getElementById('durationDisplay'),
  seekSlider: document.getElementById('seekSlider'),
  toggleMicBtn: document.getElementById('toggleMicBtn'),
  micBtnText: document.getElementById('micBtnText'),
  micIcon: document.getElementById('micIcon'),
  toggleCamBtn: document.getElementById('toggleCamBtn'),
  camBtnText: document.getElementById('camBtnText'),
  camIcon: document.getElementById('camIcon'),

  // Header User Profile Elements
  userProfileBtn: document.getElementById('userProfileBtn'),
  userProfileDropdown: document.getElementById('userProfileDropdown'),
  userNameHeader: document.getElementById('userNameHeader'),
  userAvatarHeader: document.getElementById('userAvatarHeader'),
  editProfileBtn: document.getElementById('editProfileBtn'),
  logoutBtn: document.getElementById('logoutBtn'),

  // Auth & Onboarding Modal (Matching reference design)
  authModal: document.getElementById('authModal'),
  authTabSignIn: document.getElementById('authTabSignIn'),
  authTabSignUp: document.getElementById('authTabSignUp'),
  signUpNameField: document.getElementById('signUpNameField'),
  authHeadingTitle: document.getElementById('authHeadingTitle'),
  authSubtitle: document.getElementById('authSubtitle'),
  authNameInput: document.getElementById('authNameInput'),
  authContactInput: document.getElementById('authContactInput'),
  authPasswordInput: document.getElementById('authPasswordInput'),
  togglePasswordVisibility: document.getElementById('togglePasswordVisibility'),
  rememberMeCheck: document.getElementById('rememberMeCheck'),
  authSubmitBtn: document.getElementById('authSubmitBtn'),
  googleLoginBtn: document.getElementById('googleLoginBtn'),
  appleLoginBtn: document.getElementById('appleLoginBtn'),
  authFooterAction: document.getElementById('authFooterAction'),
  authFooterText: document.getElementById('authFooterText'),
  closeAuthModalBtn: document.getElementById('closeAuthModalBtn'),
  openAuthModalBtn: document.getElementById('openAuthModalBtn'),
  forgotPasswordBtn: document.getElementById('forgotPasswordBtn'),
  authStatusAlert: document.getElementById('authStatusAlert'),
  authContactLabel: document.getElementById('authContactLabel'),
  signUpAvatarSection: document.getElementById('signUpAvatarSection'),
  signUpAvatarClickArea: document.getElementById('signUpAvatarClickArea'),
  signUpAvatarPreview: document.getElementById('signUpAvatarPreview'),
  signUpAvatarFileInput: document.getElementById('signUpAvatarFileInput'),
  triggerSignUpAvatarFileBtn: document.getElementById('triggerSignUpAvatarFileBtn'),
  signUpPasswordConfirmField: document.getElementById('signUpPasswordConfirmField'),
  authPasswordConfirmInput: document.getElementById('authPasswordConfirmInput'),
  authRememberRow: document.getElementById('authRememberRow'),

  // Phone Login & Auth Method Switcher
  authMethodEmailBtn: document.getElementById('authMethodEmailBtn'),
  authMethodPhoneBtn: document.getElementById('authMethodPhoneBtn'),
  authEmailSection: document.getElementById('authEmailSection'),
  authPhoneSection: document.getElementById('authPhoneSection'),
  authPhoneInput: document.getElementById('authPhoneInput'),
  authPhoneOtpField: document.getElementById('authPhoneOtpField'),
  phoneOtpDigitsGroup: document.getElementById('phoneOtpDigitsGroup'),
  phoneOtpBackBtn: document.getElementById('phoneOtpBackBtn'),
  phoneOtpResendBtn: document.getElementById('phoneOtpResendBtn'),
  phoneOtpTimerSpan: document.getElementById('phoneOtpTimerSpan'),

  // Settings & Profile Unified Fields
  mobileNavSettingsBtn: document.getElementById('mobileNavSettingsBtn'),
  accountProviderIcon: document.getElementById('accountProviderIcon'),
  accountProviderName: document.getElementById('accountProviderName'),
  profileAuthBadge: document.getElementById('profileAuthBadge'),
  changeEmailNewInput: document.getElementById('changeEmailNewInput'),
  changeEmailSubmitBtn: document.getElementById('changeEmailSubmitBtn'),
  changeEmailAlert: document.getElementById('changeEmailAlert'),
  changePassCurrentInput: document.getElementById('changePassCurrentInput'),
  changePassNewInput: document.getElementById('changePassNewInput'),
  changePassConfirmInput: document.getElementById('changePassConfirmInput'),
  changePasswordSubmitBtn: document.getElementById('changePasswordSubmitBtn'),
  changePassAlert: document.getElementById('changePassAlert'),
  settingsForgotPasswordLink: document.getElementById('settingsForgotPasswordLink'),

  // Kimler Katılabilir (Room Access Modal) Elements
  roomAccessBtn: document.getElementById('roomAccessBtn'),
  roomAccessModal: document.getElementById('roomAccessModal'),
  closeRoomAccessModalBtn: document.getElementById('closeRoomAccessModalBtn'),
  roomAccessModalCode: document.getElementById('roomAccessModalCode'),
  roomAccessLinkInput: document.getElementById('roomAccessLinkInput'),
  copyRoomAccessLinkBtn: document.getElementById('copyRoomAccessLinkBtn'),
  saveRoomAccessBtn: document.getElementById('saveRoomAccessBtn'),

  // Dedicated Friends Tab Elements
  friendsTabSection: document.getElementById('friendsTabSection'),
  tabMyFriendCodeDisplay: document.getElementById('tabMyFriendCodeDisplay'),
  tabCopyMyFriendCodeBtn: document.getElementById('tabCopyMyFriendCodeBtn'),
  tabAddFriendInput: document.getElementById('tabAddFriendInput'),
  tabSubmitAddFriendBtn: document.getElementById('tabSubmitAddFriendBtn'),
  tabFriendSearchInput: document.getElementById('tabFriendSearchInput'),
  tabFriendsContainer: document.getElementById('tabFriendsContainer'),
  tabFriendsOnlineCount: document.getElementById('tabFriendsOnlineCount'),

  // Reset Password Modal Elements
  resetPasswordModal: document.getElementById('resetPasswordModal'),
  resetBackBtn: document.getElementById('resetBackBtn'),
  closeResetModalBtn: document.getElementById('closeResetModalBtn'),
  stepDot1: document.getElementById('stepDot1'),
  stepDot2: document.getElementById('stepDot2'),
  stepDot3: document.getElementById('stepDot3'),
  resetStep1: document.getElementById('resetStep1'),
  resetStep2: document.getElementById('resetStep2'),
  resetStep3: document.getElementById('resetStep3'),
  resetStepSuccess: document.getElementById('resetStepSuccess'),
  resetStep1Alert: document.getElementById('resetStep1Alert'),
  resetStep2Alert: document.getElementById('resetStep2Alert'),
  resetStep3Alert: document.getElementById('resetStep3Alert'),
  resetEmailInput: document.getElementById('resetEmailInput'),
  resetSendCodeBtn: document.getElementById('resetSendCodeBtn'),
  resetBackToLoginBtn1: document.getElementById('resetBackToLoginBtn1'),
  resetEmailSentDisplay: document.getElementById('resetEmailSentDisplay'),
  otpDigit1: document.getElementById('otpDigit1'),
  otpDigit2: document.getElementById('otpDigit2'),
  otpDigit3: document.getElementById('otpDigit3'),
  otpDigit4: document.getElementById('otpDigit4'),
  otpDigit5: document.getElementById('otpDigit5'),
  otpDigit6: document.getElementById('otpDigit6'),
  resetVerifyCodeBtn: document.getElementById('resetVerifyCodeBtn'),
  resetResendCodeBtn: document.getElementById('resetResendCodeBtn'),
  resetTimerSpan: document.getElementById('resetTimerSpan'),
  resetNewPasswordInput: document.getElementById('resetNewPasswordInput'),
  resetConfirmPasswordInput: document.getElementById('resetConfirmPasswordInput'),
  toggleNewPassVis: document.getElementById('toggleNewPassVis'),
  toggleConfirmPassVis: document.getElementById('toggleConfirmPassVis'),
  strengthBar1: document.getElementById('strengthBar1'),
  strengthBar2: document.getElementById('strengthBar2'),
  strengthBar3: document.getElementById('strengthBar3'),
  strengthText: document.getElementById('strengthText'),
  resetSaveNewPasswordBtn: document.getElementById('resetSaveNewPasswordBtn'),
  resetFinishBtn: document.getElementById('resetFinishBtn'),

  // Rave YouTube Modal & Mobile Browser Bridge
  raveYoutubeModal: document.getElementById('raveYoutubeModal'),
  closeRaveYoutubeBtn: document.getElementById('closeRaveYoutubeBtn'),
  openNativeYtBrowserBtn: document.getElementById('openNativeYtBrowserBtn'),
  raveYtSearchInput: document.getElementById('raveYtSearchInput'),
  clearRaveYtSearchBtn: document.getElementById('clearRaveYtSearchBtn'),
  submitRaveYtSearchBtn: document.getElementById('submitRaveYtSearchBtn'),
  raveYtVideoGrid: document.getElementById('raveYtVideoGrid'),
  openRaveYtFromRoomBtn: document.getElementById('openRaveYtFromRoomBtn'),

  // Profile Edit & Settings Hub Modal
  profileEditModal: document.getElementById('profileEditModal'),
  closeProfileEditBtn: document.getElementById('closeProfileEditBtn'),
  editProfileNameInput: document.getElementById('editProfileNameInput'),
  editProfileRoomInput: document.getElementById('editProfileRoomInput'),
  saveProfileBtn: document.getElementById('saveProfileBtn'),
  logoutBtn: document.getElementById('logoutBtn'),
  editAvatarPreview: document.getElementById('editAvatarPreview'),
  triggerAvatarUploadBtn: document.getElementById('triggerAvatarUploadBtn'),
  triggerAvatarUploadBtn2: document.getElementById('triggerAvatarUploadBtn2'),
  removeAvatarPhotoBtn: document.getElementById('removeAvatarPhotoBtn'),
  avatarPreviewClickArea: document.getElementById('avatarPreviewClickArea'),
  avatarFileInput: document.getElementById('avatarFileInput'),
  profileTabBtnProfile: document.getElementById('profileTabBtnProfile'),
  profileTabBtnSettings: document.getElementById('profileTabBtnSettings'),
  profileTabBtnAccounts: document.getElementById('profileTabBtnAccounts'),
  profilePaneProfile: document.getElementById('profilePaneProfile'),
  profilePaneSettings: document.getElementById('profilePaneSettings'),
  profilePaneAccounts: document.getElementById('profilePaneAccounts'),
  profileEmailDisplay: document.getElementById('profileEmailDisplay'),
  profileAuthBadge: document.getElementById('profileAuthBadge'),
  toggleYtAccountBtn: document.getElementById('toggleYtAccountBtn'),
  toggleNetflixAccountBtn: document.getElementById('toggleNetflixAccountBtn'),
  togglePrimeAccountBtn: document.getElementById('togglePrimeAccountBtn'),
  toggleDisneyAccountBtn: document.getElementById('toggleDisneyAccountBtn'),

  // Explore Lobby, Provider Picker & Workspace Switching
  viewMyRoomBtn: document.getElementById('viewMyRoomBtn'),
  viewExploreBtn: document.getElementById('viewExploreBtn'),
  exploreLobbySection: document.getElementById('exploreLobbySection'),
  providerPickerSection: document.getElementById('providerPickerSection'),
  closeProviderPickerBtn: document.getElementById('closeProviderPickerBtn'),
  providerSearchInput: document.getElementById('providerSearchInput'),
  roomWorkspaceSection: document.getElementById('roomWorkspaceSection'),
  publicRoomsGrid: document.getElementById('publicRoomsGrid'),
  refreshRoomsBtn: document.getElementById('refreshRoomsBtn'),
  backToLobbyBtn: document.getElementById('backToLobbyBtn'),
  roomTopSearchBtn: document.getElementById('roomTopSearchBtn'),
  quickEnterPrivateRoomBtn: document.getElementById('quickEnterPrivateRoomBtn'),
  activeRoomTitle: document.getElementById('activeRoomTitle'),
  roomBadge: document.getElementById('roomBadge'),
  nowPlayingTitle: document.getElementById('nowPlayingTitle'),
  nowPlayingAvatar: document.getElementById('nowPlayingAvatar'),
  nowPlayingHeartBtn: document.getElementById('nowPlayingHeartBtn'),
  nowPlayingNextBtn: document.getElementById('nowPlayingNextBtn'),
  copyRaveInviteBtn: document.getElementById('copyRaveInviteBtn'),
  raveInviteLinkText: document.getElementById('raveInviteLinkText'),
  privacyStatusIcon: document.getElementById('privacyStatusIcon'),
  privacyStatusText: document.getElementById('privacyStatusText'),
  nowPlayingProviderBadge: document.getElementById('nowPlayingProviderBadge'),
  webPlayerFrame: document.getElementById('webPlayerFrame'),
  nowPlayingShareBtn: document.getElementById('nowPlayingShareBtn'),
  roomTopShareBtn: document.getElementById('roomTopShareBtn'),
  roomShareModal: document.getElementById('roomShareModal'),
  closeRoomShareBtn: document.getElementById('closeRoomShareBtn'),

  // Mobile Navigation
  mobileNavExploreBtn: document.getElementById('mobileNavExploreBtn'),
  mobileNavCreateBtn: document.getElementById('mobileNavCreateBtn'),
  mobileNavFriendsBtn: document.getElementById('mobileNavFriendsBtn'),
  mobileNavProfileBtn: document.getElementById('mobileNavProfileBtn'),

  // Create Room Modal
  openCreateRoomBtn: document.getElementById('openCreateRoomBtn'),
  createRoomModal: document.getElementById('createRoomModal'),
  closeCreateRoomBtn: document.getElementById('closeCreateRoomBtn'),
  newRoomTitleInput: document.getElementById('newRoomTitleInput'),
  selectPrivateRoomBtn: document.getElementById('selectPrivateRoomBtn'),
  selectPublicRoomBtn: document.getElementById('selectPublicRoomBtn'),
  submitCreateRoomBtn: document.getElementById('submitCreateRoomBtn'),

  // Settings
  settingsModal: document.getElementById('settingsModal'),
  openSettingsModalBtn: document.getElementById('openSettingsModalBtn'),
  closeSettingsBtn: document.getElementById('closeSettingsBtn'),
  duckingLevelSlider: document.getElementById('duckingLevelSlider'),
  duckingLevelVal: document.getElementById('duckingLevelVal'),
  micSensSlider: document.getElementById('micSensSlider'),
  micSensVal: document.getElementById('micSensVal'),
  pipShowInFullscreenCheckbox: document.getElementById('pipShowInFullscreenCheckbox'),
  openPlatformAccountsFromSettingsBtn: document.getElementById('openPlatformAccountsFromSettingsBtn'),

  // Platform Accounts Modal
  openPlatformAccountsBtn: document.getElementById('openPlatformAccountsBtn'),
  openPlatformAccountsMenuBtn: document.getElementById('openPlatformAccountsMenuBtn'),
  platformAccountsModal: document.getElementById('platformAccountsModal'),
  closePlatformAccountsBtn: document.getElementById('closePlatformAccountsBtn'),
  roomPlatformAccountQuickBtn: document.getElementById('roomPlatformAccountQuickBtn'),
  roomAccountsStatusLabel: document.getElementById('roomAccountsStatusLabel'),
  linkedAccountsCountBadge: document.getElementById('linkedAccountsCountBadge'),
  ytAccountStatusBadge: document.getElementById('ytAccountStatusBadge'),
  ytAccountUsername: document.getElementById('ytAccountUsername'),
  toggleYtAccountBtn: document.getElementById('toggleYtAccountBtn'),
  netflixAccountStatusBadge: document.getElementById('netflixAccountStatusBadge'),
  netflixAccountUsername: document.getElementById('netflixAccountUsername'),
  toggleNetflixAccountBtn: document.getElementById('toggleNetflixAccountBtn'),
  primeAccountStatusBadge: document.getElementById('primeAccountStatusBadge'),
  primeAccountUsername: document.getElementById('primeAccountUsername'),
  togglePrimeAccountBtn: document.getElementById('togglePrimeAccountBtn'),
  platformConnectForm: document.getElementById('platformConnectForm'),
  platformConnectFormTitle: document.getElementById('platformConnectFormTitle'),
  platformAccountNameInput: document.getElementById('platformAccountNameInput'),
  submitPlatformAccountBtn: document.getElementById('submitPlatformAccountBtn'),
  cancelPlatformAccountBtn: document.getElementById('cancelPlatformAccountBtn'),

  // Host & Permissions
  roomHostBadge: document.getElementById('roomHostBadge'),
  roomHostName: document.getElementById('roomHostName'),
  toggleRoomPermissionBtn: document.getElementById('toggleRoomPermissionBtn'),
  permLockIcon: document.getElementById('permLockIcon'),
  permModeText: document.getElementById('permModeText'),
  roomInviteBtn: document.getElementById('roomInviteBtn'),
  guestPermissionNotice: document.getElementById('guestPermissionNotice'),
  requestDjPermissionBtn: document.getElementById('requestDjPermissionBtn'),
  hostPermissionRequestToast: document.getElementById('hostPermissionRequestToast'),
  requestingUserName: document.getElementById('requestingUserName'),
  grantDjPermissionBtn: document.getElementById('grantDjPermissionBtn'),
  denyDjPermissionBtn: document.getElementById('denyDjPermissionBtn'),

  // Friends Modal
  openFriendsBtn: document.getElementById('openFriendsBtn'),
  friendsModal: document.getElementById('friendsModal'),
  closeFriendsModalBtn: document.getElementById('closeFriendsModalBtn'),
  myFriendCodeDisplay: document.getElementById('myFriendCodeDisplay'),
  copyMyFriendCodeBtn: document.getElementById('copyMyFriendCodeBtn'),
  addFriendInput: document.getElementById('addFriendInput'),
  submitAddFriendBtn: document.getElementById('submitAddFriendBtn'),
  friendSearchInput: document.getElementById('friendSearchInput'),
  friendsListContainer: document.getElementById('friendsListContainer'),
  friendsCountDisplay: document.getElementById('friendsCountDisplay'),

  // Room Chat
  toggleChatBtn: document.getElementById('toggleChatBtn'),
  chatUnreadDot: document.getElementById('chatUnreadDot'),
  roomChatPanel: document.getElementById('roomChatPanel'),
  closeChatBtn: document.getElementById('closeChatBtn'),
  chatMessagesContainer: document.getElementById('chatMessagesContainer'),
  chatMessageInput: document.getElementById('chatMessageInput'),
  sendChatMessageBtn: document.getElementById('sendChatMessageBtn'),

  // Zoom-Style Participants Panel & Modal
  roomParticipantsModal: document.getElementById('roomParticipantsModal'),
  roomParticipantsPanel: document.getElementById('roomParticipantsPanel') || document.getElementById('roomParticipantsModal'),
  toggleParticipantsBtn: document.getElementById('toggleParticipantsBtn'),
  closeParticipantsBtn: document.getElementById('closeParticipantsBtn'),
  participantsListContainer: document.getElementById('participantsListContainer'),
  roomMemberCountBadge: document.getElementById('roomMemberCountBadge'),
  participantsCountHeader: document.getElementById('participantsCountHeader'),
  hostRoleNotice: document.getElementById('hostRoleNotice'),
  copyInviteFromParticipantsBtn: document.getElementById('copyInviteFromParticipantsBtn'),
  roomVideoGrid: document.getElementById('roomVideoGrid'),

  // Room Playback Queue & Browsing / Suggestions
  roomQueueBadgeBtn: document.getElementById('roomQueueBadgeBtn'),
  roomQueueCount: document.getElementById('roomQueueCount'),
  roomQueueModal: document.getElementById('roomQueueModal'),
  closeQueueModalBtn: document.getElementById('closeQueueModalBtn'),
  roomQueueList: document.getElementById('roomQueueList'),
  hostBrowsingNotice: document.getElementById('hostBrowsingNotice'),
  hostBrowsingNoticeText: document.getElementById('hostBrowsingNoticeText'),
  raveCurrentlyPlayingBanner: document.getElementById('raveCurrentlyPlayingBanner'),
  raveCurrentlyPlayingTitle: document.getElementById('raveCurrentlyPlayingTitle'),
  raveVideoActionSheet: document.getElementById('raveVideoActionSheet'),
  closeRaveActionSheetBtn: document.getElementById('closeRaveActionSheetBtn'),
  raveActionThumb: document.getElementById('raveActionThumb'),
  raveActionTitle: document.getElementById('raveActionTitle'),
  raveActionChannel: document.getElementById('raveActionChannel'),
  raveActionPlayNowBtn: document.getElementById('raveActionPlayNowBtn'),
  raveActionQueueBtn: document.getElementById('raveActionQueueBtn'),
  hostSuggestionBanner: document.getElementById('hostSuggestionBanner'),
  closeSuggestionBannerBtn: document.getElementById('closeSuggestionBannerBtn'),
  suggestionThumb: document.getElementById('suggestionThumb'),
  suggestionTitle: document.getElementById('suggestionTitle'),
  suggestionSender: document.getElementById('suggestionSender'),
  acceptSuggestionPlayNowBtn: document.getElementById('acceptSuggestionPlayNowBtn'),
  acceptSuggestionQueueBtn: document.getElementById('acceptSuggestionQueueBtn'),
  roomQuickSearchBtnText: document.getElementById('roomQuickSearchBtnText')
};

// Universal responsive click & tap handler
function addInstantTap(el, handler) {
  if (!el) return;
  el.addEventListener('click', (e) => {
    handler(e);
  });
}

// ==========================================
// 1. SIGNALING SYSTEM (WebSocket & Fallback)
// ==========================================
let ws = null;

function connectSignaling() {
  if (window.location.protocol === 'file:' || !window.location.host) {
    console.log('📱 Miruo Bağımsız Cihaz Modunda Çalışıyor (IP bağlantısı aranmıyor)');
    return;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/?room=${encodeURIComponent(state.roomId)}&userId=${state.userId}`;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('✅ Sinyal sunucusuna bağlanıldı.');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleSignalMessage(msg);
      } catch (e) {
        console.error('Signal parse error:', e);
      }
    };

    ws.onerror = (err) => {
      console.warn('WS hatası, HTTP Fallback kontrol ediliyor...', err);
      connectFallbackSSE();
    };

    ws.onclose = () => {
      console.log('WS bağlantısı kapandı.');
    };
  } catch (err) {
    connectFallbackSSE();
  }
}

function sendSignal(msg) {
  const payload = { ...msg, roomId: state.roomId, userId: state.userId };
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  } else if (window.location.host && window.location.protocol !== 'file:') {
    // HTTP POST fallback
    fetch('/api/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: state.roomId, userId: state.userId, data: payload })
    }).catch(() => {});
  }
}

function connectFallbackSSE() {
  if (window._sseConnected) return;
  window._sseConnected = true;
  const evtSource = new EventSource(`/api/events?room=${encodeURIComponent(state.roomId)}&userId=${state.userId}`);
  evtSource.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleSignalMessage(msg);
    } catch (err) {}
  };
}

function handleSignalMessage(msg) {
  switch (msg.type) {
    case 'init':
      if (msg.peers && msg.peers.length > 0) {
        state.peerId = msg.peers[0];
        updatePeerStatus(true);
        // Start WebRTC Call as initiator
        initiateWebRTC(true);
      } else {
        updatePeerStatus(false);
      }
      break;

    case 'peer-joined':
      state.peerId = msg.userId;
      updatePeerStatus(true);
      showToast('Partner odaya katıldı ❤️');
      initiateWebRTC(true);
      break;

    case 'peer-left':
      state.peerId = null;
      updatePeerStatus(false);
      showToast('Partner odadan ayrıldı');
      break;

    case 'offer':
      handleRtcOffer(msg.offer);
      break;

    case 'answer':
      handleRtcAnswer(msg.answer);
      break;

    case 'ice-candidate':
      handleRtcCandidate(msg.candidate);
      break;

    case 'sync-event':
      handleRemoteSync(msg.payload);
      break;

    case 'touch-event':
      renderTouchEffect(msg.x, msg.y, false);
      break;

    case 'reaction-event':
      spawnFloatingReaction(msg.emoji, false);
      break;

    case 'sleep-mode':
      applySleepMode(msg.enabled, false);
      break;

    case 'perm-change':
      handleRemotePermissionChange(msg.mode, msg.hostName);
      break;

    case 'request-dj':
      handleDjPermissionRequested(msg.fromUser);
      break;

    case 'grant-dj':
      handleDjPermissionGranted(msg.toUser);
      break;

    case 'chat-message':
      renderChatMessage(msg.sender, msg.text, false, msg.time, msg.imageUrl, msg.avatarUrl);
      break;

    case 'media-status':
      updateRemoteParticipantStatus(msg.userId, msg.username, msg.isMicOn, msg.isCamOn);
      break;

    case 'platform-switch':
      switchRoomPlatform(msg.platform);
      showToast(`Partner platformu değiştirdi: ${msg.platform} 🔄`);
      break;

    case 'kick-user':
      handleRemoteUserKicked(msg.targetUserId, msg.targetUsername);
      break;

    case 'role-update':
      handleRemoteRoleUpdate(msg.targetUserId, msg.newRole, msg.targetUsername);
      break;

    case 'host-browsing':
      handleRemoteBrowsingNotice(msg.isBrowsing, msg.user);
      break;

    case 'video-suggestion':
      handleIncomingVideoSuggestion(msg);
      break;

    case 'queue-update':
      handleRemoteQueueUpdate(msg.queue);
      break;

    case 'video-changed':
      handleRemoteVideoChanged(msg.user, msg.title, msg.videoId);
      break;
  }
}

function updatePeerStatus(connected) {
  if (!dom.peerStatusBadge) return;
  if (connected) {
    dom.peerStatusBadge.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs bg-emerald-500/10 text-emerald-300 border border-emerald-500/20';
    dom.peerStatusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400"></span><span>Bağlandı ❤️</span>';
  } else {
    dom.peerStatusBadge.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs bg-amber-500/10 text-amber-300 border border-amber-500/20';
    dom.peerStatusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-400 animate-ping"></span><span>Partner Bekleniyor...</span>';
  }
}

// ==========================================
// 2. WebRTC PEER CONNECTION (AV & Data)
// ==========================================
function setupWebRTC() {
  if (state.pc) {
    try { state.pc.close(); } catch (e) {}
  }

  state.pc = new RTCPeerConnection(rtcConfig);

  // Send ICE candidates
  state.pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({ type: 'ice-candidate', candidate: event.candidate });
    }
  };

  // Remote Tracks (Webcam, Mic, Screen Share)
  state.pc.ontrack = (event) => {
    const stream = event.streams[0];
    if (stream) {
      const hasVideo = stream.getVideoTracks().length > 0;
      const isScreenTrack = event.track.label.toLowerCase().includes('screen') || 
                           event.track.label.toLowerCase().includes('display') ||
                           event.track.contentHint === 'detail';

      if (isScreenTrack || state.activeMode === 'screenshare') {
        dom.remoteScreenPlayer.srcObject = stream;
        dom.remoteScreenPlayer.classList.remove('hidden');
        dom.ytPlayerContainer.classList.add('hidden');
        dom.nativeVideoPlayer.classList.add('hidden');
        dom.emptyStatePlaceholder.classList.add('hidden');
      } else if (hasVideo) {
        dom.partnerVideo.srcObject = stream;
        dom.partnerVideoPlaceholder.classList.add('hidden');
      }

      // Route audio to ducking analyzer
      if (event.track.kind === 'audio') {
        setupAudioDucking(stream);
      }
    }
  };

  // Setup Data Channel for sub-millisecond sync
  state.pc.ondatachannel = (event) => {
    state.dataChannel = event.channel;
    setupDataChannelEvents(state.dataChannel);
  };
}

function initiateWebRTC(isInitiator) {
  setupWebRTC();

  if (isInitiator) {
    state.dataChannel = state.pc.createDataChannel('couchSyncChannel');
    setupDataChannelEvents(state.dataChannel);

    // Add local tracks if available
    if (state.localStream) {
      state.localStream.getTracks().forEach(track => state.pc.addTrack(track, state.localStream));
    }
    if (state.screenStream) {
      state.screenStream.getTracks().forEach(track => state.pc.addTrack(track, state.screenStream));
    }

    state.pc.createOffer().then(offer => {
      return state.pc.setLocalDescription(offer);
    }).then(() => {
      sendSignal({ type: 'offer', offer: state.pc.localDescription });
    }).catch(err => console.error('Create offer error:', err));
  }
}

function handleRtcOffer(offer) {
  setupWebRTC();

  if (state.localStream) {
    state.localStream.getTracks().forEach(track => state.pc.addTrack(track, state.localStream));
  }
  if (state.screenStream) {
    state.screenStream.getTracks().forEach(track => state.pc.addTrack(track, state.screenStream));
  }

  state.pc.setRemoteDescription(new RTCSessionDescription(offer)).then(() => {
    return state.pc.createAnswer();
  }).then(answer => {
    return state.pc.setLocalDescription(answer);
  }).then(() => {
    sendSignal({ type: 'answer', answer: state.pc.localDescription });
  }).catch(err => console.error('Handle offer error:', err));
}

function handleRtcAnswer(answer) {
  if (state.pc) {
    state.pc.setRemoteDescription(new RTCSessionDescription(answer)).catch(err => {
      console.error('Handle answer error:', err);
    });
  }
}

function handleRtcCandidate(candidate) {
  if (state.pc) {
    state.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => {
      console.error('Add ICE error:', err);
    });
  }
}

function setupDataChannelEvents(channel) {
  channel.onopen = () => console.log('⚡ P2P DataChannel Açıldı! (Sıfır Gecikme Senkron)');
  channel.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'sync') handleRemoteSync(data.payload);
      if (data.type === 'touch') renderTouchEffect(data.x, data.y, false);
      if (data.type === 'reaction') spawnFloatingReaction(data.emoji, false);
      if (data.type === 'sleep') applySleepMode(data.enabled, false);
      if (data.type === 'perm_change') handleRemotePermissionChange(data.mode, data.hostName);
      if (data.type === 'request_dj') handleDjPermissionRequested(data.fromUser);
      if (data.type === 'grant_dj') handleDjPermissionGranted(data.toUser);
      if (data.type === 'chat') renderChatMessage(data.sender, data.text, false, data.time, data.imageUrl, data.avatarUrl);
      if (data.type === 'media_status') updateRemoteParticipantStatus(data.userId, data.username, data.isMicOn, data.isCamOn);
      if (data.type === 'platform_switch') {
        switchRoomPlatform(data.platform);
        showToast(`Partner platformu değiştirdi: ${data.platform} 🔄`);
      }
      if (data.type === 'kick_user') handleRemoteUserKicked(data.targetUserId, data.targetUsername);
      if (data.type === 'role_update') handleRemoteRoleUpdate(data.targetUserId, data.newRole, data.targetUsername);
      if (data.type === 'host_browsing') handleRemoteBrowsingNotice(data.isBrowsing, data.user);
      if (data.type === 'video_suggestion') handleIncomingVideoSuggestion(data);
      if (data.type === 'queue_update') handleRemoteQueueUpdate(data.queue);
      if (data.type === 'video_changed') handleRemoteVideoChanged(data.user, data.title, data.videoId);
    } catch (err) {}
  };
}

function sendP2PData(type, payload) {
  const data = JSON.stringify({ type, ...payload });
  if (state.dataChannel && state.dataChannel.readyState === 'open') {
    state.dataChannel.send(data);
  } else {
    // Fallback to signaling server
    if (type === 'sync') sendSignal({ type: 'sync-event', payload });
    if (type === 'touch') sendSignal({ type: 'touch-event', x: payload.x, y: payload.y });
    if (type === 'reaction') sendSignal({ type: 'reaction-event', emoji: payload.emoji });
    if (type === 'sleep') sendSignal({ type: 'sleep-mode', enabled: payload.enabled });
    if (type === 'perm_change') sendSignal({ type: 'perm-change', mode: payload.mode, hostName: payload.hostName });
    if (type === 'request_dj') sendSignal({ type: 'request-dj', fromUser: payload.fromUser });
    if (type === 'grant_dj') sendSignal({ type: 'grant-dj', toUser: payload.toUser });
    if (type === 'chat') sendSignal({ type: 'chat-message', sender: payload.sender, text: payload.text, time: payload.time, imageUrl: payload.imageUrl, avatarUrl: payload.avatarUrl });
    if (type === 'media_status') sendSignal({ type: 'media-status', userId: payload.userId, username: payload.username, isMicOn: payload.isMicOn, isCamOn: payload.isCamOn });
    if (type === 'platform_switch') sendSignal({ type: 'platform-switch', platform: payload.platform });
    if (type === 'kick_user') sendSignal({ type: 'kick-user', targetUserId: payload.targetUserId, targetUsername: payload.targetUsername });
    if (type === 'role_update') sendSignal({ type: 'role-update', targetUserId: payload.targetUserId, newRole: payload.newRole, targetUsername: payload.targetUsername });
    if (type === 'host_browsing') sendSignal({ type: 'host-browsing', isBrowsing: payload.isBrowsing, user: payload.user });
    if (type === 'video_suggestion') sendSignal({ type: 'video-suggestion', videoId: payload.videoId, title: payload.title, thumb: payload.thumb, fromUser: payload.fromUser });
    if (type === 'queue_update') sendSignal({ type: 'queue-update', queue: payload.queue });
    if (type === 'video_changed') sendSignal({ type: 'video-changed', user: payload.user, title: payload.title, videoId: payload.videoId });
  }
}

// ==========================================
// 3. SMART AUDIO DUCKING (Web Audio API)
// ==========================================
function setupAudioDucking(remoteAudioStream) {
  try {
    if (!state.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      state.audioCtx = new AudioCtx();
    }
    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume();
    }

    const source = state.audioCtx.createMediaStreamSource(remoteAudioStream);
    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    // Audio Analysis Loop
    function analyzeVoice() {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const avg = sum / bufferLength;
      const normalizedLevel = avg / 255;

      // Update partner audio visualizer
      dom.partnerAudioMeter.style.width = `${Math.min(100, normalizedLevel * 250)}%`;

      if (normalizedLevel > state.speechThreshold) {
        // Partner is speaking!
        dom.partnerVoiceIndicator.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse';
        triggerAudioDucking(true);
      } else {
        dom.partnerVoiceIndicator.className = 'w-1.5 h-1.5 rounded-full bg-gray-500';
      }

      requestAnimationFrame(analyzeVoice);
    }

    analyzeVoice();
  } catch (err) {
    console.warn('Audio Ducking başlatılamadı:', err);
  }
}

function triggerAudioDucking(shouldDuck) {
  if (shouldDuck) {
    if (state.duckTimeout) clearTimeout(state.duckTimeout);

    if (!state.isDucked) {
      state.isDucked = true;
      dom.duckingLiveNotice.style.opacity = '1';

      // Drop Media Volume
      if (state.ytPlayer && state.ytReady && typeof state.ytPlayer.setVolume === 'function') {
        state.normalVolume = state.ytPlayer.getVolume() || 100;
        state.ytPlayer.setVolume(Math.round(state.normalVolume * state.duckingTargetVolume));
      }
      if (dom.nativeVideoPlayer) {
        dom.nativeVideoPlayer.volume = state.duckingTargetVolume;
      }
    }

    // Auto restore after 600ms of silence
    state.duckTimeout = setTimeout(() => {
      restoreAudioDucking();
    }, 600);
  }
}

function restoreAudioDucking() {
  if (state.isDucked) {
    state.isDucked = false;
    dom.duckingLiveNotice.style.opacity = '0';

    if (state.ytPlayer && state.ytReady && typeof state.ytPlayer.setVolume === 'function') {
      state.ytPlayer.setVolume(state.normalVolume);
    }
    if (dom.nativeVideoPlayer) {
      dom.nativeVideoPlayer.volume = 1.0;
    }
  }
}

// ==========================================
// 4. MEDIA ENGINE (YouTube + HTML5 + Screen)
// ==========================================

// YouTube IFrame API Initialization
window.onYouTubeIframeAPIReady = function() {
  state.ytReady = true;
  console.log('🎬 YouTube API Hazır.');
};

function loadYoutubeVideo(urlOrId) {
  let videoId = extractYouTubeId(urlOrId);
  if (!videoId) {
    showToast('Geçerli bir YouTube linki girin!');
    return;
  }

  state.activeMode = 'youtube';
  state.currentVideoId = videoId;
  state.currentProvider = 'YouTube';
  if (dom.nowPlayingProviderBadge) dom.nowPlayingProviderBadge.textContent = 'YouTube';
  switchActiveTab('youtube');

  dom.emptyStatePlaceholder.classList.add('hidden');
  dom.ytPlayerContainer.classList.remove('hidden');
  dom.nativeVideoPlayer.classList.add('hidden');
  dom.remoteScreenPlayer.classList.add('hidden');
  if (dom.webPlayerFrame) dom.webPlayerFrame.classList.add('hidden');

  // Immediately hide the overlay so video is visible and touchable!
  if (dom.ravePlayerOverlay) {
    dom.ravePlayerOverlay.classList.add('opacity-0', 'pointer-events-none');
    dom.ravePlayerOverlay.classList.remove('opacity-90');
  }

  // Direct responsive embed iframe that plays 100% reliably in WKWebView
  // controls=0: completely eliminates YouTube's red scrubber bar, controls, and branding so only Miruo controls show!
  // Uses youtube.com (not nocookie) to allow shared session cookies with logged in YouTube Premium accounts!
  const originParam = (window.location.origin && window.location.origin !== 'null') ? `&origin=${encodeURIComponent(window.location.origin)}` : '';
  dom.ytPlayerContainer.innerHTML = `
    <iframe id="miruoYtIframe" 
            src="https://www.youtube.com/embed/${videoId}?autoplay=1&playsinline=1&enablejsapi=1&controls=0&disablekb=1&fs=0&rel=0&modestbranding=1&iv_load_policy=3${originParam}" 
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" 
            allowfullscreen 
            class="w-full h-full border-0 pointer-events-auto">
    </iframe>
  `;

  state.isPlaying = true;
  updatePlayPauseUI(true);

  // Hook iframe load to enable postMessage events
  const ytFrame = document.getElementById('miruoYtIframe');
  if (ytFrame) {
    ytFrame.addEventListener('load', () => {
      setTimeout(() => {
        if (ytFrame.contentWindow) {
          ytFrame.contentWindow.postMessage(JSON.stringify({ event: 'listening' }), '*');
        }
      }, 500);
    });
  }

  // Update Now Playing card & stage overlay
  fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`)
    .then(r => r.json())
    .then(d => {
      const vTitle = d.title || 'YouTube Videosu';
      const vAuthor = d.author_name || 'YouTube';
      if (dom.raveOverlayTitle) dom.raveOverlayTitle.textContent = vTitle;
      const stageSubtitle = document.getElementById('stageSubtitleText');
      if (stageSubtitle) stageSubtitle.textContent = `${vAuthor}'da YouTube`;
      if (dom.nowPlayingTitle) dom.nowPlayingTitle.textContent = vTitle;
    }).catch(() => {});

  // Send video change to peer with timestamp for zero-latency sync
  sendP2PData('sync', { action: 'load_yt', videoId, sentAt: Date.now() });
  startPlaybackTracking();
  startSyncHeartbeat();
  showToast('🎬 Video başlatıldı');
}

function fallbackToDirectYtEmbed(videoId) {
  if (!videoId) return;
  loadYoutubeVideo(videoId);
}

function loadTwitchStream(channelOrUrl, title) {
  state.activeMode = 'twitch';
  state.currentProvider = 'Twitch';
  if (dom.nowPlayingProviderBadge) dom.nowPlayingProviderBadge.textContent = 'Twitch';
  if (dom.nowPlayingTitle) dom.nowPlayingTitle.textContent = title || 'Twitch Canlı Yayını';
  
  let channel = channelOrUrl || '';
  if (channel.includes('twitch.tv/')) {
    channel = channel.split('twitch.tv/')[1].split('/')[0].split('?')[0];
  }
  
  dom.emptyStatePlaceholder.classList.add('hidden');
  dom.ytPlayerContainer.classList.add('hidden');
  dom.nativeVideoPlayer.classList.add('hidden');
  if (dom.webPlayerFrame) {
    dom.webPlayerFrame.classList.remove('hidden');
    const parentHost = window.location.hostname || 'localhost';
    dom.webPlayerFrame.src = `https://player.twitch.tv/?channel=${channel}&parent=${parentHost}&parent=localhost&parent=127.0.0.1&autoplay=true&muted=false`;
  }
  showToast(`🟣 Twitch: ${channel} yayını açıldı!`);
}

function loadDirectVideo(url, title) {
  state.activeMode = 'direct';
  state.currentProvider = 'Web Video';
  if (dom.nowPlayingProviderBadge) dom.nowPlayingProviderBadge.textContent = 'Web Video';
  if (dom.nowPlayingTitle) dom.nowPlayingTitle.textContent = title || 'Video İçeriği';
  
  dom.emptyStatePlaceholder.classList.add('hidden');
  dom.ytPlayerContainer.classList.add('hidden');
  if (dom.webPlayerFrame) dom.webPlayerFrame.classList.add('hidden');
  
  dom.nativeVideoPlayer.classList.remove('hidden');
  dom.nativeVideoPlayer.src = url;
  dom.nativeVideoPlayer.play().catch(e => console.log('Autoplay deferred:', e));
  showToast(`🎬 Video başlatıldı!`);
}

function loadWebStream(url, title, provider = 'Web') {
  state.activeMode = 'web';
  state.currentProvider = provider;
  if (dom.nowPlayingProviderBadge) dom.nowPlayingProviderBadge.textContent = provider;
  if (dom.nowPlayingTitle) dom.nowPlayingTitle.textContent = title || `${provider} İçeriği`;
  
  dom.emptyStatePlaceholder.classList.add('hidden');
  dom.ytPlayerContainer.classList.add('hidden');
  dom.nativeVideoPlayer.classList.add('hidden');
  if (dom.webPlayerFrame) {
    dom.webPlayerFrame.classList.remove('hidden');
    dom.webPlayerFrame.src = url;
  }
  showToast(`🌐 ${provider} içeriği odaya aktarıldı!`);
}

function extractYouTubeId(url) {
  if (!url) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/);
  return match ? match[1] : null;
}

function onYtStateChange(event) {
  if (state.isRemoteAction) return;

  if (event.data === YT.PlayerState.PLAYING) {
    state.isPlaying = true;
    updatePlayPauseUI(true);
    sendP2PData('sync', { action: 'play', time: state.ytPlayer.getCurrentTime() });
  } else if (event.data === YT.PlayerState.PAUSED) {
    state.isPlaying = false;
    updatePlayPauseUI(false);
    sendP2PData('sync', { action: 'pause', time: state.ytPlayer.getCurrentTime() });
  }
}

function sendYtCommand(func, args = []) {
  const ytFrame = document.getElementById('miruoYtIframe');
  if (ytFrame && ytFrame.contentWindow) {
    ytFrame.contentWindow.postMessage(JSON.stringify({
      event: 'command',
      func: func,
      args: args
    }), '*');
  } else if (state.ytPlayer && typeof state.ytPlayer[func] === 'function') {
    state.ytPlayer[func](...args);
  }
}

function handleRemoteSync(payload) {
  if (!payload) return;
  state.isRemoteAction = true;
  const transit = payload.sentAt ? Math.max(0, (Date.now() - payload.sentAt) / 1000) : 0;

  if (payload.action === 'load_yt') {
    if (state.currentVideoId !== payload.videoId) {
      loadYoutubeVideo(payload.videoId);
    }
    showToast('Partner videoyu başlattı 🎬');
  }

  if (payload.action === 'play') {
    const targetTime = (typeof payload.time === 'number' ? payload.time : state.currentTime) + transit;
    if (state.activeMode === 'youtube') {
      if (Math.abs(state.currentTime - targetTime) > 0.3) {
        sendYtCommand('seekTo', [targetTime, true]);
        state.currentTime = targetTime;
      }
      sendYtCommand('playVideo');
    } else if (dom.nativeVideoPlayer) {
      if (Math.abs(dom.nativeVideoPlayer.currentTime - targetTime) > 0.3) {
        dom.nativeVideoPlayer.currentTime = targetTime;
      }
      dom.nativeVideoPlayer.play();
    }
    state.isPlaying = true;
    updatePlayPauseUI(true);
    showToast('Oynatılıyor ▶');
  }

  if (payload.action === 'pause') {
    const targetTime = typeof payload.time === 'number' ? payload.time : state.currentTime;
    if (state.activeMode === 'youtube') {
      sendYtCommand('pauseVideo');
      if (typeof payload.time === 'number') {
        sendYtCommand('seekTo', [targetTime, true]);
        state.currentTime = targetTime;
      }
    } else if (dom.nativeVideoPlayer) {
      dom.nativeVideoPlayer.pause();
      if (typeof payload.time === 'number') dom.nativeVideoPlayer.currentTime = targetTime;
    }
    state.isPlaying = false;
    updatePlayPauseUI(false);
    showToast('Durduruldu ⏸');
  }

  if (payload.action === 'seek') {
    const targetTime = payload.time || 0;
    if (state.activeMode === 'youtube') {
      sendYtCommand('seekTo', [targetTime, true]);
    } else if (dom.nativeVideoPlayer) {
      dom.nativeVideoPlayer.currentTime = targetTime;
    }
    state.currentTime = targetTime;
    if (dom.seekSlider && state.duration > 0) {
      dom.seekSlider.value = (targetTime / state.duration) * 100;
    }
    showToast('Sarıldı ⏩');
  }

  if (payload.action === 'heartbeat') {
    if (payload.isPlaying) {
      const targetTime = (payload.time || 0) + transit;
      const drift = Math.abs(state.currentTime - targetTime);
      if (drift > 0.35) {
        if (state.activeMode === 'youtube') {
          sendYtCommand('seekTo', [targetTime, true]);
        } else if (dom.nativeVideoPlayer) {
          dom.nativeVideoPlayer.currentTime = targetTime;
        }
        state.currentTime = targetTime;
      }
      if (!state.isPlaying) {
        if (state.activeMode === 'youtube') sendYtCommand('playVideo');
        else if (dom.nativeVideoPlayer) dom.nativeVideoPlayer.play();
        state.isPlaying = true;
        updatePlayPauseUI(true);
      }
    } else if (!payload.isPlaying && state.isPlaying) {
      if (state.activeMode === 'youtube') sendYtCommand('pauseVideo');
      else if (dom.nativeVideoPlayer) dom.nativeVideoPlayer.pause();
      state.isPlaying = false;
      updatePlayPauseUI(false);
    }
  }

  setTimeout(() => {
    state.isRemoteAction = false;
  }, 300);
}

// 2.5s Sync Heartbeat to guarantee zero drift between host and peers
let syncHeartbeatInterval = null;
function startSyncHeartbeat() {
  if (syncHeartbeatInterval) clearInterval(syncHeartbeatInterval);
  syncHeartbeatInterval = setInterval(() => {
    if (state.isHost && state.isPlaying && (state.activeMode === 'youtube' || state.activeMode === 'direct')) {
      sendP2PData('sync', {
        action: 'heartbeat',
        time: state.currentTime,
        isPlaying: state.isPlaying,
        sentAt: Date.now()
      });
    }
  }, 2500);
}

// Playback Tracking (Timeline Slider & Duration)
let trackingInterval = null;
function startPlaybackTracking() {
  if (trackingInterval) clearInterval(trackingInterval);
  trackingInterval = setInterval(() => {
    if (state.activeMode === 'youtube') {
      if (state.isPlaying && !state.isUserDraggingSeek) {
        state.currentTime = Math.min((state.duration || 999999), (state.currentTime || 0) + 0.5);
      }
    } else if (state.activeMode === 'direct' && dom.nativeVideoPlayer) {
      state.currentTime = dom.nativeVideoPlayer.currentTime || 0;
      state.duration = dom.nativeVideoPlayer.duration || 0;
    }

    if (state.duration > 0) {
      if (dom.currentTimeDisplay) dom.currentTimeDisplay.textContent = formatTime(state.currentTime);
      if (dom.durationDisplay) dom.durationDisplay.textContent = formatTime(state.duration);
      if (dom.seekSlider && !state.isUserDraggingSeek) {
        dom.seekSlider.value = (state.currentTime / state.duration) * 100;
      }
    }
  }, 500);
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function updatePlayPauseUI(playing) {
  if (playing) {
    dom.playIcon.classList.add('hidden');
    dom.pauseIcon.classList.remove('hidden');
  } else {
    dom.playIcon.classList.remove('hidden');
    dom.pauseIcon.classList.add('hidden');
  }
}

function updateDurationUI(dur) {
  dom.durationDisplay.textContent = formatTime(dur);
}

function togglePlayPause() {
  if (state.activeMode === 'youtube') {
    state.isPlaying = !state.isPlaying;
    sendYtCommand(state.isPlaying ? 'playVideo' : 'pauseVideo');
    updatePlayPauseUI(state.isPlaying);
    sendP2PData('sync', {
      action: state.isPlaying ? 'play' : 'pause',
      time: state.currentTime,
      sentAt: Date.now()
    });
    return;
  }
  if (state.activeMode === 'direct' && dom.nativeVideoPlayer) {
    if (dom.nativeVideoPlayer.paused) {
      dom.nativeVideoPlayer.play();
      state.isPlaying = true;
      sendP2PData('sync', { action: 'play', time: dom.nativeVideoPlayer.currentTime, sentAt: Date.now() });
    } else {
      dom.nativeVideoPlayer.pause();
      state.isPlaying = false;
      sendP2PData('sync', { action: 'pause', time: dom.nativeVideoPlayer.currentTime, sentAt: Date.now() });
    }
    updatePlayPauseUI(state.isPlaying);
  }
}

// YouTube postMessage Bridge for Frame-Accurate Zero-Latency Scrubber & Play State Sync
window.addEventListener('message', (event) => {
  if (!event.data) return;
  let data = event.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) { return; }
  }
  if (!data || typeof data !== 'object') return;

  if (data.event === 'infoDelivery' && data.info) {
    if (typeof data.info.duration === 'number' && data.info.duration > 0) {
      state.duration = data.info.duration;
      if (dom.durationDisplay) dom.durationDisplay.textContent = formatTime(state.duration);
    }
    if (typeof data.info.currentTime === 'number') {
      state.currentTime = data.info.currentTime;
      if (dom.currentTimeDisplay) dom.currentTimeDisplay.textContent = formatTime(state.currentTime);
      if (dom.seekSlider && !state.isUserDraggingSeek && state.duration > 0) {
        dom.seekSlider.value = (state.currentTime / state.duration) * 100;
      }
    }
    if (typeof data.info.playerState === 'number') {
      // 1: playing, 2: paused, 0: ended
      if (data.info.playerState === 0) {
        // Video finished! Auto-advance to next track if queue has items
        if (state.roomQueue && state.roomQueue.length > 0) {
          handleNextTrack();
        }
      }
      const isNowPlaying = data.info.playerState === 1;
      if (isNowPlaying !== state.isPlaying && !state.isRemoteAction) {
        state.isPlaying = isNowPlaying;
        updatePlayPauseUI(isNowPlaying);
      }
    }
  } else if (data.event === 'onReady') {
    sendYtCommand('addEventListener', ['onStateChange']);
  }
});

// Screen Sharing (Netflix / Dizi / Browser)
async function startScreenSharing() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always', frameRate: 60 },
      audio: true
    });

    state.screenStream = stream;
    state.isScreenSharing = true;
    state.activeMode = 'screenshare';

    dom.nativeVideoPlayer.srcObject = stream;
    dom.nativeVideoPlayer.play();
    dom.nativeVideoPlayer.classList.remove('hidden');
    dom.ytPlayerContainer.classList.add('hidden');
    dom.emptyStatePlaceholder.classList.add('hidden');

    dom.startScreenShareBtn.classList.add('hidden');
    dom.stopScreenShareBtn.classList.remove('hidden');

    // Add track to WebRTC peer
    if (state.pc) {
      stream.getTracks().forEach(track => {
        state.pc.addTrack(track, stream);
      });
      // Renegotiate
      initiateWebRTC(true);
    }

    stream.getVideoTracks()[0].onended = () => {
      stopScreenSharing();
    };

    showToast('Ekran yayını başlatıldı! (Netflix vb.)');
  } catch (err) {
    console.error('Ekran paylaşımı hatası:', err);
    showToast('Ekran paylaşımı iptal edildi veya reddedildi.');
  }
}

function stopScreenSharing() {
  if (state.screenStream) {
    state.screenStream.getTracks().forEach(t => t.stop());
    state.screenStream = null;
  }
  state.isScreenSharing = false;
  dom.startScreenShareBtn.classList.remove('hidden');
  dom.stopScreenShareBtn.classList.add('hidden');
  showToast('Ekran yayını sonlandırıldı.');
}

// ==========================================
// 4.5 MULTI-PLATFORM SWITCHER, FULLSCREEN & RAVE PiP
// ==========================================

// Fullscreen Stage Manager (With Rave Floating PiP Overlay Support)
function toggleFullscreen() {
  if (!dom.stageContainer) return;
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (!isFs) {
    if (dom.stageContainer.requestFullscreen) {
      dom.stageContainer.requestFullscreen().catch(err => console.warn('Fullscreen hatası:', err));
    } else if (dom.stageContainer.webkitRequestFullscreen) {
      dom.stageContainer.webkitRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
}

function updateFullscreenUI() {
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  const enterSvg = `<path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>`;
  const exitSvg = `<path stroke-linecap="round" stroke-linejoin="round" d="M9 4v4H5M9 8L4 3m11 1v4h4m-4 0l5-5M9 20v-4H5m4 0l-5 5m11-1v-4h4m-4 0l5 5"/>`;
  
  if (dom.stageFullscreenIcon) dom.stageFullscreenIcon.innerHTML = isFs ? exitSvg : enterSvg;
  if (dom.dockFullscreenIcon) dom.dockFullscreenIcon.innerHTML = isFs ? exitSvg : enterSvg;

  // Apply PiP in fullscreen visibility rules
  applyPipFullscreenSettings(isFs);
}

// Rave-Style PiP Webcam Positioning Settings
let pipSettings = {
  corner: 'bottom-right', // 'bottom-right', 'bottom-left', 'top-right', 'top-left'
  showInFullscreen: true
};

function loadPipSettings() {
  try {
    const saved = localStorage.getItem('miruo_pip_settings');
    if (saved) {
      pipSettings = Object.assign(pipSettings, JSON.parse(saved));
    }
  } catch (e) {}
  applyPipPositioning();
}

function savePipSettings() {
  localStorage.setItem('miruo_pip_settings', JSON.stringify(pipSettings));
  applyPipPositioning();
  showToast('Kamera yerleşimi güncellendi 📹');
}

function applyPipPositioning() {
  const cornerClass = `pip-pos-${pipSettings.corner}`;
  const corners = ['pip-pos-bottom-right', 'pip-pos-bottom-left', 'pip-pos-top-right', 'pip-pos-top-left'];
  
  [dom.partnerPipCard, dom.selfPipCard].forEach(card => {
    if (!card) return;
    corners.forEach(c => card.classList.remove(c));
    card.classList.add(cornerClass);
  });

  document.querySelectorAll('.pip-corner-btn').forEach(btn => {
    const isCurrent = btn.dataset.corner === pipSettings.corner;
    btn.className = isCurrent
      ? 'pip-corner-btn active p-2 rounded-xl border-2 border-rose-500 bg-rose-500/15 text-left font-semibold text-white'
      : 'pip-corner-btn p-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-left text-gray-300';
  });

  if (dom.pipShowInFullscreenCheckbox) {
    dom.pipShowInFullscreenCheckbox.checked = pipSettings.showInFullscreen;
  }
}

function applyPipFullscreenSettings(isFullscreen) {
  const hide = isFullscreen && !pipSettings.showInFullscreen;
  if (dom.partnerPipCard) dom.partnerPipCard.classList.toggle('pip-hidden-fullscreen', hide);
  if (dom.selfPipCard) dom.selfPipCard.classList.toggle('pip-hidden-fullscreen', hide);
}

// In-Room Multi-Platform Switcher (YouTube <-> Netflix <-> Prime <-> Spotify <-> Screen Share)
function switchRoomPlatform(platform) {
  const allTabs = [dom.tabYoutube, dom.tabNetflix, dom.tabPrime, dom.tabSpotify, dom.tabScreenShare, dom.tabDirectVideo];
  allTabs.forEach(t => t && t.classList.remove('active'));

  if (dom.youtubeInputSection) dom.youtubeInputSection.classList.add('hidden');
  if (dom.netflixInputSection) dom.netflixInputSection.classList.add('hidden');
  if (dom.screenShareInputSection) dom.screenShareInputSection.classList.add('hidden');
  if (dom.directVideoInputSection) dom.directVideoInputSection.classList.add('hidden');

  const p = (platform || 'youtube').toLowerCase();
  state.activePlatform = platform;

  if (p === 'youtube') {
    state.activeMode = 'youtube';
    if (dom.tabYoutube) dom.tabYoutube.classList.add('active');
    if (dom.youtubeInputSection) dom.youtubeInputSection.classList.remove('hidden');
    searchAndRenderMedia('', 'all');
    if (dom.ytPlayerContainer) dom.ytPlayerContainer.classList.remove('hidden');
    if (dom.nativeVideoPlayer) dom.nativeVideoPlayer.classList.add('hidden');
    if (dom.remoteScreenPlayer) dom.remoteScreenPlayer.classList.add('hidden');
  } else if (p === 'netflix' || p === 'prime') {
    state.activeMode = 'screenshare';
    const tabEl = p === 'netflix' ? dom.tabNetflix : dom.tabPrime;
    if (tabEl) tabEl.classList.add('active');
    if (dom.netflixInputSection) {
      dom.netflixInputSection.classList.remove('hidden');
      if (dom.netflixSectionBadge) {
        dom.netflixSectionBadge.textContent = p === 'netflix' ? 'NETFLIX P2P' : 'PRIME VIDEO P2P';
        dom.netflixSectionBadge.className = p === 'netflix' 
          ? 'px-2 py-0.5 rounded-md bg-red-600/20 text-red-300 font-bold text-[10px]'
          : 'px-2 py-0.5 rounded-md bg-blue-600/20 text-blue-300 font-bold text-[10px]';
      }
    }
    // Pause YouTube if playing
    if (state.ytPlayer && typeof state.ytPlayer.pauseVideo === 'function') {
      try { state.ytPlayer.pauseVideo(); } catch (e) {}
    }
    showToast(`${platform} moduna geçildi! Sekmeyi sesle paylaşarak birlikte izleyin 🎬`);
  } else if (p === 'spotify') {
    state.activeMode = 'youtube';
    if (dom.tabSpotify) dom.tabSpotify.classList.add('active');
    if (dom.youtubeInputSection) {
      dom.youtubeInputSection.classList.remove('hidden');
      if (dom.youtubeUrlInput) {
        dom.youtubeUrlInput.placeholder = 'Spotify veya YouTube Music / Şarkı linki yapıştırın...';
        dom.youtubeUrlInput.focus();
      }
    }
    showToast('Spotify / Ortak Müzik moduna geçildi 🎵');
  } else if (p === 'screenshare') {
    state.activeMode = 'screenshare';
    if (dom.tabScreenShare) dom.tabScreenShare.classList.add('active');
    if (dom.screenShareInputSection) dom.screenShareInputSection.classList.remove('hidden');
  } else if (p === 'direct') {
    state.activeMode = 'direct';
    if (dom.tabDirectVideo) dom.tabDirectVideo.classList.add('active');
    if (dom.directVideoInputSection) dom.directVideoInputSection.classList.remove('hidden');
    if (dom.ytPlayerContainer) dom.ytPlayerContainer.classList.add('hidden');
    if (dom.nativeVideoPlayer) dom.nativeVideoPlayer.classList.remove('hidden');
  }

  // Broadcast platform change to peer
  sendP2PData('platform_switch', { platform });
}

// Backward compatibility helper
function switchActiveTab(mode) {
  switchRoomPlatform(mode);
}

// Persistent Platform Accounts Manager (YouTube, Netflix, Prime, Disney+ Sessions)
let platformAccounts = {
  youtube: null,
  netflix: null,
  prime: null,
  disney: null
};

let activePromptPlatform = null;

function loadPlatformAccounts() {
  try {
    const saved = localStorage.getItem('miruo_platform_accounts');
    if (saved) {
      platformAccounts = Object.assign(platformAccounts, JSON.parse(saved));
    }
  } catch (e) {}
  updatePlatformAccountsUI();
}

function savePlatformAccounts() {
  localStorage.setItem('miruo_platform_accounts', JSON.stringify(platformAccounts));
  updatePlatformAccountsUI();
}

function updatePlatformAccountsUI() {
  // Platform sessions (YouTube Premium, Netflix, Prime) persist automatically in native in-app browser cookies
}

function openPlatformAccountsModal() {
  if (typeof openProfileEditModal === 'function') {
    openProfileEditModal('accounts');
  }
}

function closePlatformAccountsModal() {
  if (dom.profileEditModal) dom.profileEditModal.classList.add('hidden');
}

// ==========================================
// 5. LIVING ROOM INTERACTIONS (Touch & Reactions)
// ==========================================
function renderTouchEffect(normX, normY, isLocal = true) {
  const rect = dom.stageContainer.getBoundingClientRect();
  const screenX = rect.left + normX * rect.width;
  const screenY = rect.top + normY * rect.height;

  // Floating Heart
  const heart = document.createElement('div');
  heart.className = 'touch-heart';
  heart.textContent = '❤️';
  heart.style.left = `${screenX}px`;
  heart.style.top = `${screenY}px`;
  dom.touchLayer.appendChild(heart);

  // Ripple Ring
  const ring = document.createElement('div');
  ring.className = 'touch-ring';
  ring.style.left = `${screenX}px`;
  ring.style.top = `${screenY}px`;
  dom.touchLayer.appendChild(ring);

  setTimeout(() => {
    heart.remove();
    ring.remove();
  }, 1400);

  if (isLocal) {
    sendP2PData('touch', { x: normX, y: normY });
  }
}

function spawnFloatingReaction(emoji, isLocal = true) {
  // User explicitly requested: "şu videodaki sen emojileri kaldır kendi klavyesinden emoji atmak isteyen atar senin klişe şeylerine gerek yok"
  // Floating reactions on video are disabled; users send emojis via native chat keyboard.
  return;
}

function applySleepMode(enabled, isLocal = true) {
  state.isSleepMode = enabled;
  if (enabled) {
    dom.sleepOverlay.style.opacity = '1';
    dom.sleepOverlay.style.pointerEvents = 'auto';
    dom.ambientGlow.style.opacity = '0.05';
    showToast('İyi uykular... 🌙');
  } else {
    dom.sleepOverlay.style.opacity = '0';
    dom.sleepOverlay.style.pointerEvents = 'none';
    dom.ambientGlow.style.opacity = '0.3';
  }

  if (isLocal) {
    sendP2PData('sleep', { enabled });
  }
}

// Draggable PIP Functionality (Camera freely draggable anywhere over video stage)
function makeDraggable(el) {
  if (!el) return;
  let isDown = false;
  let startX = 0;
  let startY = 0;
  let startElX = 0;
  let startElY = 0;

  function onPointerDown(clientX, clientY) {
    isDown = true;
    const parent = el.offsetParent || el.parentElement || document.body;
    const parentRect = parent.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    // Calculate current position relative to parent
    startElX = elRect.left - parentRect.left;
    startElY = elRect.top - parentRect.top;

    // Remove CSS right/bottom constraints and lock position in px
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.left = startElX + 'px';
    el.style.top = startElY + 'px';

    startX = clientX;
    startY = clientY;
    el.classList.add('pip-dragging');
  }

  function onPointerMove(clientX, clientY, e) {
    if (!isDown) return;
    if (e && e.cancelable) e.preventDefault();

    const parent = el.offsetParent || el.parentElement || document.body;
    const parentRect = parent.getBoundingClientRect();

    const deltaX = clientX - startX;
    const deltaY = clientY - startY;

    let newX = startElX + deltaX;
    let newY = startElY + deltaY;

    // Bounds checking inside parent
    const maxW = parentRect.width - el.offsetWidth - 6;
    const maxH = parentRect.height - el.offsetHeight - 6;

    newX = Math.max(6, Math.min(newX, Math.max(6, maxW)));
    newY = Math.max(6, Math.min(newY, Math.max(6, maxH)));

    el.style.left = newX + 'px';
    el.style.top = newY + 'px';
  }

  function onPointerUp() {
    if (!isDown) return;
    isDown = false;
    el.classList.remove('pip-dragging');
  }

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target && e.target.closest('button')) return;
    onPointerDown(e.clientX, e.clientY);
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    onPointerMove(e.clientX, e.clientY, e);
  });

  document.addEventListener('mouseup', () => {
    onPointerUp();
  });

  // Touch support for mobile devices
  el.addEventListener('touchstart', (e) => {
    if (e.target && e.target.closest('button')) return;
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      onPointerDown(touch.clientX, touch.clientY);
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!isDown) return;
    if (e.touches.length > 0) {
      const touch = e.touches[0];
      onPointerMove(touch.clientX, touch.clientY, e);
    }
  }, { passive: false });

  document.addEventListener('touchend', () => {
    onPointerUp();
  });

  document.addEventListener('touchcancel', () => {
    onPointerUp();
  });
}

function showToast(msg) {
  dom.syncToastMsg.textContent = msg;
  dom.syncToast.style.opacity = '1';
  setTimeout(() => {
    dom.syncToast.style.opacity = '0';
  }, 2500);
}

const MIC_ON_SVG = `<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>`;
const MIC_OFF_SVG = `<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>`;
const CAM_ON_SVG = `<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>`;
const CAM_OFF_SVG = `<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1m5 0h6a2 2 0 0 1 2 2v4"/><polyline points="23 7 16 12 23 17"/><line x1="1" y1="1" x2="23" y2="23"/>`;

function updateAVToolbarUI() {
  const micSvg = document.getElementById('micIconSvg');
  const camSvg = document.getElementById('camIconSvg');
  const micDot = document.getElementById('micStatusDot');
  const avText = document.getElementById('avStatusText');

  if (dom.toggleMicBtn) {
    if (state.isMicOn) {
      dom.toggleMicBtn.className = 'w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-emerald-500 hover:bg-emerald-600 text-white border border-emerald-400 ring-4 ring-emerald-500/30 animate-pulse flex items-center justify-center font-bold shadow-lg transition-all active:scale-95 shrink-0 cursor-pointer';
      if (micSvg) {
        micSvg.innerHTML = MIC_ON_SVG;
        micSvg.setAttribute('class', 'w-4 h-4 sm:w-4.5 sm:h-4.5 text-white');
      }
      if (micDot) micDot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse';
    } else {
      dom.toggleMicBtn.className = 'w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-white/10 hover:bg-white/20 text-gray-300 border border-white/10 flex items-center justify-center font-bold shadow-lg transition-all active:scale-95 shrink-0 cursor-pointer';
      if (micSvg) {
        micSvg.innerHTML = MIC_OFF_SVG;
        micSvg.setAttribute('class', 'w-4 h-4 sm:w-4.5 sm:h-4.5 text-red-400');
      }
      if (micDot) micDot.className = 'w-1.5 h-1.5 rounded-full bg-gray-500';
    }
  }

  if (dom.toggleCamBtn) {
    if (state.isCamOn) {
      dom.toggleCamBtn.className = 'w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-gradient-to-r from-rose-500 to-pink-600 hover:opacity-90 text-white border border-rose-400 ring-4 ring-rose-500/30 animate-pulse flex items-center justify-center font-bold shadow-lg transition-all active:scale-95 shrink-0 cursor-pointer';
      if (camSvg) {
        camSvg.innerHTML = CAM_ON_SVG;
        camSvg.setAttribute('class', 'w-4 h-4 sm:w-4.5 sm:h-4.5 text-white');
      }
    } else {
      dom.toggleCamBtn.className = 'w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-white/10 hover:bg-white/20 text-gray-300 border border-white/10 flex items-center justify-center font-bold shadow-lg transition-all active:scale-95 shrink-0 cursor-pointer';
      if (camSvg) {
        camSvg.innerHTML = CAM_OFF_SVG;
        camSvg.setAttribute('class', 'w-4 h-4 sm:w-4.5 sm:h-4.5 text-red-400');
      }
    }
  }

  if (avText) {
    if (state.isMicOn && state.isCamOn) avText.textContent = 'Mikrofon & Kamera Açık (Canlı)';
    else if (state.isMicOn) avText.textContent = 'Mikrofon Canlı • Kamera Kapalı';
    else if (state.isCamOn) avText.textContent = 'Kamera Canlı • Mikrofon Kapalı';
    else avText.textContent = 'Mikrofon & Kamera Kapalı';
  }
}

// Camera & Mic Controls
async function toggleMic() {
  // 1-Tap Toggle: Tap to open, tap again to close
  state.isMicOn = !state.isMicOn;

  if (state.isMicOn) {
    if (!state.localStream && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (dom.selfVideo) dom.selfVideo.srcObject = state.localStream;
        if (state.pc) {
          state.localStream.getAudioTracks().forEach(t => state.pc.addTrack(t, state.localStream));
          initiateWebRTC(true);
        }
      } catch (e) {
        console.warn('Microphone hardware not available in simulator/environment:', e);
      }
    } else if (state.localStream) {
      const audioTrack = state.localStream.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = true;
    }
    showToast('🎙️ Mikrofon Açık (Canlı)');
  } else {
    if (state.localStream) {
      const audioTrack = state.localStream.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = false;
    }
    showToast('🔇 Mikrofon Kapatıldı');
  }

  updateAVToolbarUI();
  if (dom.micBtnText) {
    dom.micBtnText.textContent = state.isMicOn ? 'Mikrofon Kapat' : 'Mikrofon Aç';
  }
  broadcastMyMediaStatus();
  renderParticipantsList();
}

async function toggleCam() {
  // If camera is already ON, turn it OFF directly!
  if (state.isCamOn) {
    state.isCamOn = false;
    if (state.localStream) {
      state.localStream.getVideoTracks().forEach(track => {
        track.enabled = false;
      });
    }
    if (dom.selfPipCard) {
      dom.selfPipCard.classList.add('hidden');
    }
    updateAVToolbarUI();
    broadcastMyMediaStatus();
    renderParticipantsList();
    renderVideoGrid();
    showToast('📷 Kamera Kapatıldı');
    return;
  }

  // Turning camera ON
  const savedUserObj = JSON.parse(localStorage.getItem('miruo_user') || '{}');
  const selfAvatar = state.avatarUrl || savedUserObj.avatarUrl || '';
  if (dom.selfPipAvatarInitial) {
    if (selfAvatar) {
      dom.selfPipAvatarInitial.innerHTML = `<img src="${selfAvatar}" class="w-full h-full object-cover rounded-full" alt="Avatar">`;
    } else {
      dom.selfPipAvatarInitial.textContent = (state.username || 'M').charAt(0).toUpperCase();
    }
  }

  try {
    // IMPORTANT: audio MUST BE false! Requesting audio: true during camera toggle
    // hijacks iOS AVAudioSession from video player and freezes video playback!
    if (!state.localStream) {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });
    } else if (state.localStream.getVideoTracks().length === 0) {
      const videoStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });
      const videoTrack = videoStream.getVideoTracks()[0];
      state.localStream.addTrack(videoTrack);
    }

    const videoTrack = state.localStream ? state.localStream.getVideoTracks()[0] : null;
    if (videoTrack) {
      videoTrack.enabled = true;
      state.isCamOn = true;

      if (dom.selfVideo) {
        dom.selfVideo.srcObject = state.localStream;
        dom.selfVideo.playsInline = true;
        dom.selfVideo.muted = true;
        dom.selfVideo.autoplay = true;
        const playPromise = dom.selfVideo.play();
        if (playPromise !== undefined) {
          playPromise.catch(err => console.warn('Self video play warning:', err));
        }

        const handleVideoCheck = () => {
          if (dom.selfVideo && dom.selfVideo.videoWidth > 0 && dom.selfVideo.readyState >= 2) {
            if (dom.selfVideoPlaceholder) dom.selfVideoPlaceholder.classList.add('hidden');
          } else {
            if (dom.selfVideoPlaceholder) dom.selfVideoPlaceholder.classList.remove('hidden');
          }
        };

        dom.selfVideo.onloadedmetadata = handleVideoCheck;
        dom.selfVideo.onplaying = handleVideoCheck;
        setTimeout(handleVideoCheck, 350);
        setTimeout(handleVideoCheck, 1000);
      }

      if (dom.selfPipCard) {
        dom.selfPipCard.classList.remove('hidden');
      }

      updateCamButtonUI(true);

      if (state.pc) {
        try {
          const senders = state.pc.getSenders ? state.pc.getSenders() : [];
          const videoSender = senders.find(s => s.track && s.track.kind === 'video');
          if (videoSender) {
            videoSender.replaceTrack(videoTrack);
          } else {
            state.pc.addTrack(videoTrack, state.localStream);
            initiateWebRTC(true);
          }
        } catch (err) {
          console.warn('WebRTC cam track error:', err);
        }
      }

      broadcastMyMediaStatus();
      renderParticipantsList();
      renderVideoGrid();
      showToast('📹 Canlı Kamera Açıldı (Sürüklenebilir)');
    } else {
      throw new Error('Video track not available');
    }
  } catch (e) {
    console.warn('Kamera donanımı bulunamadı veya simülatörde çalışıyor, canlı önizleme açılıyor:', e);
    state.isCamOn = true;
    if (dom.selfPipCard) {
      dom.selfPipCard.classList.remove('hidden');
    }
    if (dom.selfVideoPlaceholder) {
      dom.selfVideoPlaceholder.classList.remove('hidden');
    }
    updateCamButtonUI(true);
    broadcastMyMediaStatus();
    renderParticipantsList();
    renderVideoGrid();
    showToast('📹 Canlı Kamera Önizleme Açıldı (Sürüklenebilir)');
  }
}

// YouTube Live Format Chat Sidebar Visibility Manager
function setChatVisibility(visible) {
  state.isChatVisible = visible;
  if (dom.roomChatSidebar) {
    dom.roomChatSidebar.classList.toggle('hidden', !visible);
  }
  if (dom.openChatFloatingBtn) {
    dom.openChatFloatingBtn.classList.toggle('hidden', visible);
  }
  if (dom.chatToolbarBtnText) {
    dom.chatToolbarBtnText.textContent = visible ? 'Sohbet' : 'Sohbeti Aç';
  }
  if (dom.toggleChatToolbarBtn) {
    dom.toggleChatToolbarBtn.classList.toggle('bg-rose-500/20', visible);
    dom.toggleChatToolbarBtn.classList.toggle('text-rose-300', visible);
    dom.toggleChatToolbarBtn.classList.toggle('border-rose-500/40', visible);
  }
}

function updateCamButtonUI(isOn) {
  state.isCamOn = isOn;
  updateAVToolbarUI();
}

function renderVideoGrid() {
  if (!dom.roomVideoGrid) return;

  const anyCamOn = state.isCamOn || Object.values(state.participants).some(p => p.isCamOn);
  if (!anyCamOn && !state.isMicOn) {
    dom.roomVideoGrid.classList.add('hidden');
    return;
  }

  dom.roomVideoGrid.classList.remove('hidden');
  dom.roomVideoGrid.innerHTML = '';

  // 1. Self Tile
  const selfTile = document.createElement('div');
  selfTile.className = 'relative w-28 h-28 sm:w-32 sm:h-32 rounded-2xl overflow-hidden bg-black/60 border border-white/10 shadow-lg shrink-0 flex flex-col items-center justify-center';

  if (state.isCamOn && state.localStream) {
    const v = document.createElement('video');
    v.className = 'w-full h-full object-cover mirror';
    v.autoplay = true;
    v.muted = true;
    v.playsInline = true;
    v.srcObject = state.localStream;
    selfTile.appendChild(v);
  } else {
    const pulseRing = state.isMicOn ? 'ring-2 ring-emerald-400 ring-offset-2 ring-offset-black animate-pulse' : '';
    const selfAv = state.avatarUrl 
      ? `<img src="${state.avatarUrl}" class="w-full h-full object-cover rounded-full" alt="PP">` 
      : (state.username || 'K').charAt(0).toUpperCase();
    selfTile.innerHTML = `
      <div class="w-12 h-12 rounded-full overflow-hidden bg-gradient-to-tr from-rose-500 to-indigo-600 flex items-center justify-center text-white font-bold text-base shadow-md ${pulseRing}">
        ${selfAv}
      </div>
      <span class="text-[10px] text-gray-400 mt-1 font-medium">Kamera Kapalı</span>
    `;
  }

  const selfBadge = document.createElement('div');
  selfBadge.className = 'absolute bottom-1.5 left-1.5 right-1.5 px-2 py-0.5 rounded-lg bg-black/60 backdrop-blur-md border border-white/10 flex items-center justify-between text-[10px] text-white';
  selfBadge.innerHTML = `
    <span class="truncate font-semibold">${state.username || 'Sen'} (Sen)</span>
    <span class="${state.isMicOn ? 'text-emerald-400' : 'text-red-400'}">${state.isMicOn ? '🎙️' : '🔇'}</span>
  `;
  selfTile.appendChild(selfBadge);
  dom.roomVideoGrid.appendChild(selfTile);

  // 2. Remote / Partner / Simulated Tiles
  const otherMembers = [];
  Object.values(state.participants).forEach(p => {
    if (p.userId !== state.userId) otherMembers.push(p);
  });
  if (otherMembers.length === 0 && activeRoomBots && activeRoomBots.length > 0) {
    activeRoomBots.slice(0, 3).forEach((b, idx) => {
      otherMembers.push({
        userId: 'bot_' + b.name,
        username: b.name,
        avatar: b.avatar,
        avatarColor: b.color,
        isMicOn: idx === 0,
        isCamOn: false,
        role: idx === 0 ? 'video_control' : 'member'
      });
    });
  }

  otherMembers.forEach(m => {
    const tile = document.createElement('div');
    tile.className = 'relative w-28 h-28 sm:w-32 sm:h-32 rounded-2xl overflow-hidden bg-black/60 border border-white/10 shadow-lg shrink-0 flex flex-col items-center justify-center';

    if (m.isCamOn && m.stream) {
      const v = document.createElement('video');
      v.className = 'w-full h-full object-cover mirror';
      v.autoplay = true;
      v.playsInline = true;
      v.srcObject = m.stream;
      tile.appendChild(v);
    } else {
      const pulseRing = m.isMicOn ? 'ring-2 ring-emerald-400 ring-offset-2 ring-offset-black animate-pulse' : '';
      const avHtml = m.avatar
        ? `<img src="${m.avatar}" class="w-12 h-12 rounded-full object-cover shadow-md ${pulseRing}" alt="PP">`
        : `<div class="w-12 h-12 rounded-full bg-gradient-to-tr ${m.avatarColor || 'from-indigo-500 to-purple-600'} flex items-center justify-center text-white font-bold text-base shadow-md ${pulseRing}">
             ${(m.username || 'K').charAt(0).toUpperCase()}
           </div>`;
      tile.innerHTML = `
        ${avHtml}
        <span class="text-[10px] text-gray-400 mt-1 font-medium">${m.isCamOn ? 'Canlı' : 'Kamera Kapalı'}</span>
      `;
    }

    const badge = document.createElement('div');
    badge.className = 'absolute bottom-1.5 left-1.5 right-1.5 px-2 py-0.5 rounded-lg bg-black/60 backdrop-blur-md border border-white/10 flex items-center justify-between text-[10px] text-white';
    badge.innerHTML = `
      <span class="truncate font-semibold">${m.username}</span>
      <span class="${m.isMicOn ? 'text-emerald-400' : 'text-red-400'}">${m.isMicOn ? '🎙️' : '🔇'}</span>
    `;
    tile.appendChild(badge);
    dom.roomVideoGrid.appendChild(tile);
  });
}

// ==========================================
// 5.5 EXPLORE LOBBY & COMMUNITY ROOMS
// ==========================================
const SIMULATED_BOT_PROFILES = [
  { name: 'Ece_99', avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&auto=format&fit=crop&q=80', char: 'E', color: 'from-pink-500 to-rose-600' },
  { name: 'Can_TR', avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=120&auto=format&fit=crop&q=80', char: 'C', color: 'from-blue-500 to-indigo-600' },
  { name: 'Melis_Vibes', avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=120&auto=format&fit=crop&q=80', char: 'M', color: 'from-purple-500 to-indigo-600' },
  { name: 'Barış_99', avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=120&auto=format&fit=crop&q=80', char: 'B', color: 'from-emerald-500 to-teal-600' },
  { name: 'Zeynep_K', avatar: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=120&auto=format&fit=crop&q=80', char: 'Z', color: 'from-amber-500 to-orange-600' },
  { name: 'Emre_Can', avatar: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=120&auto=format&fit=crop&q=80', char: 'E', color: 'from-rose-500 to-purple-600' },
  { name: 'Deniz_06', avatar: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=120&auto=format&fit=crop&q=80', char: 'D', color: 'from-cyan-500 to-blue-600' },
  { name: 'Selin_K', avatar: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=120&auto=format&fit=crop&q=80', char: 'S', color: 'from-fuchsia-500 to-pink-600' }
];

const BOT_CHAT_MESSAGES = [
  "bu parça bağımlılık yaptı yaa 🔥",
  "selam herkese, ses gayet net geliyor 👋",
  "efsane seçim elinize sağlık",
  "klibi ilk defa izliyorum çok iyiymiş",
  "sesi bir tık daha açabilir misiniz?",
  "sırada hangi şarkı var acaba? 🎧",
  "kalp bıraktım ❤️",
  "bunu listeme kaydettim hemen 👍",
  "gece moduna çok yakıştı bu parça",
  "herkese keyifli dinlemeler ✨",
  "sonraki benden olsun mu? 🎶",
  "harika senkronize oldu çok iyi",
  "ritim mükemmel 🔥🔥",
  "arkadaşları da çağırdım geliyorlar"
];

let botChatInterval = null;
let activeRoomBots = [];

function startBotsForActiveRoom() {
  if (botChatInterval) clearInterval(botChatInterval);
  
  // Pick 4 to 7 random bots
  const shuffled = [...SIMULATED_BOT_PROFILES].sort(() => 0.5 - Math.random());
  const count = Math.floor(4 + Math.random() * 4);
  activeRoomBots = shuffled.slice(0, count);

  // Update badge count
  const totalViewers = activeRoomBots.length + 1;
  if (dom.roomMemberCountBadge) dom.roomMemberCountBadge.textContent = String(totalViewers);

  // Bot join notifications in chat
  setTimeout(() => {
    activeRoomBots.slice(0, 2).forEach(bot => {
      appendBotJoinMessage(bot.name, bot.color);
    });
  }, 800);

  // Periodic bot chat messages (Every 5-8 seconds)
  botChatInterval = setInterval(() => {
    if (!dom.roomWorkspaceSection || dom.roomWorkspaceSection.classList.contains('hidden')) {
      clearInterval(botChatInterval);
      return;
    }
    const randomBot = activeRoomBots[Math.floor(Math.random() * activeRoomBots.length)];
    const randomMsg = BOT_CHAT_MESSAGES[Math.floor(Math.random() * BOT_CHAT_MESSAGES.length)];
    appendBotChatMessage(randomBot, randomMsg);

    // 40% chance to drop floating reaction
    if (Math.random() > 0.55) {
      const reactions = ['❤️', '🔥', '👏', '✨', '🎉'];
      const em = reactions[Math.floor(Math.random() * reactions.length)];
      spawnFloatingReaction(em, false);
    }
  }, 5500 + Math.random() * 3500);
}

function stopBotsForActiveRoom() {
  if (botChatInterval) {
    clearInterval(botChatInterval);
    botChatInterval = null;
  }
}

function appendBotJoinMessage(botName, botColor) {
  if (!dom.chatMessagesContainer) return;
  const msgEl = document.createElement('div');
  msgEl.className = 'flex items-center gap-2 text-gray-400 text-[11px] py-1';
  msgEl.innerHTML = `
    <div class="w-5 h-5 rounded-full bg-gradient-to-tr ${botColor || 'from-rose-500 to-indigo-600'} flex items-center justify-center text-[9px] font-bold text-white shadow-xs">
      ${botName.charAt(0)}
    </div>
    <span><strong class="text-gray-200">@${escapeHtml(botName)}</strong> odaya katıldı 👋</span>
  `;
  dom.chatMessagesContainer.appendChild(msgEl);
  dom.chatMessagesContainer.scrollTop = dom.chatMessagesContainer.scrollHeight;
}

function appendBotChatMessage(bot, message) {
  if (!dom.chatMessagesContainer) return;
  const msgEl = document.createElement('div');
  msgEl.className = 'flex items-start gap-2.5 max-w-[88%] text-xs py-1';
  msgEl.innerHTML = `
    <div class="w-6 h-6 rounded-full bg-gradient-to-tr ${bot.color || 'from-rose-500 to-indigo-600'} flex items-center justify-center text-[10px] font-bold text-white shrink-0 shadow-sm mt-0.5 overflow-hidden">
      ${bot.avatar ? `<img src="${bot.avatar}" class="w-full h-full object-cover" alt="PP">` : bot.char}
    </div>
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-1.5 mb-0.5">
        <span class="font-bold text-[11px] text-gray-300">@${escapeHtml(bot.name)}</span>
        <span class="text-[9px] text-gray-500">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="bg-white/10 text-white rounded-2xl rounded-tl-sm px-3 py-1.5 w-fit shadow-xs leading-relaxed text-xs">
        ${escapeHtml(message)}
      </div>
    </div>
  `;
  dom.chatMessagesContainer.appendChild(msgEl);
  dom.chatMessagesContainer.scrollTop = dom.chatMessagesContainer.scrollHeight;
}

function switchToExplore() {
  stopBotsForActiveRoom();
  if (dom.mainHeader) dom.mainHeader.classList.remove('hidden');
  const mobileNav = document.getElementById('mobileBottomNav');
  if (mobileNav) mobileNav.classList.remove('hidden');
  const friendsTab = document.getElementById('friendsTabSection');
  if (friendsTab) {
    friendsTab.classList.add('hidden');
    friendsTab.classList.remove('flex');
  }
  if (dom.exploreLobbySection) {
    dom.exploreLobbySection.classList.remove('hidden');
    dom.exploreLobbySection.classList.add('flex');
  }
  if (dom.providerPickerSection) {
    dom.providerPickerSection.classList.add('hidden');
    dom.providerPickerSection.classList.remove('flex');
  }
  if (dom.roomWorkspaceSection) {
    dom.roomWorkspaceSection.classList.add('hidden');
    dom.roomWorkspaceSection.classList.remove('flex');
  }
  if (dom.mobileNavExploreBtn) {
    dom.mobileNavExploreBtn.className = 'flex flex-col items-center gap-1 text-white font-bold py-1 px-3 transition-all cursor-pointer';
  }
  if (dom.mobileNavFriendsBtn) {
    dom.mobileNavFriendsBtn.className = 'flex flex-col items-center gap-1 text-gray-400 hover:text-white py-1 px-3 transition-all cursor-pointer';
  }
  if (dom.viewExploreBtn) {
    dom.viewExploreBtn.className = 'px-3.5 py-1.5 rounded-lg font-semibold text-rose-300 bg-rose-500/15 border border-rose-500/30 flex items-center gap-2 transition-all';
  }
  if (dom.viewMyRoomBtn) {
    dom.viewMyRoomBtn.className = 'px-3.5 py-1.5 rounded-lg font-medium text-gray-400 hover:text-white flex items-center gap-2 transition-all';
  }
  loadPublicRooms();
}

function switchToProviderPicker() {
  stopBotsForActiveRoom();
  if (dom.mainHeader) dom.mainHeader.classList.add('hidden');
  const mobileNav = document.getElementById('mobileBottomNav');
  if (mobileNav) mobileNav.classList.add('hidden');
  if (dom.exploreLobbySection) {
    dom.exploreLobbySection.classList.add('hidden');
    dom.exploreLobbySection.classList.remove('flex');
  }
  if (dom.roomWorkspaceSection) {
    dom.roomWorkspaceSection.classList.add('hidden');
    dom.roomWorkspaceSection.classList.remove('flex');
  }
  if (dom.providerPickerSection) {
    dom.providerPickerSection.classList.remove('hidden');
    dom.providerPickerSection.classList.add('flex');
  }
}

function switchToMyRoom() {
  // Hide explore header, provider picker and bottom nav when inside a room!
  if (dom.mainHeader) dom.mainHeader.classList.add('hidden');
  const mobileNav = document.getElementById('mobileBottomNav');
  if (mobileNav) mobileNav.classList.add('hidden');
  if (dom.exploreLobbySection) {
    dom.exploreLobbySection.classList.add('hidden');
    dom.exploreLobbySection.classList.remove('flex');
  }
  if (dom.providerPickerSection) {
    dom.providerPickerSection.classList.add('hidden');
    dom.providerPickerSection.classList.remove('flex');
  }
  if (dom.roomWorkspaceSection) {
    dom.roomWorkspaceSection.classList.remove('hidden');
    dom.roomWorkspaceSection.classList.add('flex');
  }
  // Ensure YouTube Live Classic format (video left, chat right) is active by default
  setChatVisibility(true);
  if (dom.viewMyRoomBtn) {
    dom.viewMyRoomBtn.className = 'px-3.5 py-1.5 rounded-lg font-semibold text-rose-300 bg-rose-500/15 border border-rose-500/30 flex items-center gap-2 transition-all';
  }
  if (dom.viewExploreBtn) {
    dom.viewExploreBtn.className = 'px-3.5 py-1.5 rounded-lg font-medium text-gray-400 hover:text-white flex items-center gap-2 transition-all';
  }
  if (dom.activeRoomTitle) dom.activeRoomTitle.textContent = state.roomId;
  if (dom.raveInviteLinkText) dom.raveInviteLinkText.textContent = getMiruoRoomUrl(state.roomId);
  updatePermissionUI();
  renderParticipantsList();
  broadcastMyMediaStatus();
  searchAndRenderMedia('', 'all');

  // Start bots in room!
  startBotsForActiveRoom();
}

// Random impersonal room codes: ODA-XXXX (e.g. ODA-7492).
function localRoomCode() {
  return 'ODA-' + Math.floor(1000 + Math.random() * 9000);
}

function requestRoomCode(meta) {
  return fetch('/api/create-room', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta)
  })
    .then(res => res.json())
    .then(data => (data && data.room && data.room.id) || localRoomCode())
    .catch(() => localRoomCode());
}

function createAndJoinRoom(title, isPrivate = false, category = 'YouTube', videoId = null) {
  state.isHost = true;
  state.hostName = state.username;
  state.controlMode = 'host_only';
  state.hasDjPermission = true;

  requestRoomCode({
    name: title || `${category} Partisi`,
    isPrivate: isPrivate,
    host: state.username,
    category: category,
    videoId: videoId
  }).then(code => {
    state.roomId = code;
    if (dom.activeRoomTitle) dom.activeRoomTitle.textContent = state.roomId;
    if (dom.currentRoomDisplay) dom.currentRoomDisplay.textContent = state.roomId;
    if (dom.raveInviteLinkText) dom.raveInviteLinkText.textContent = getMiruoRoomUrl(state.roomId);
    switchToMyRoom();
    connectSignaling();
    if (videoId) setTimeout(() => loadYoutubeVideo(videoId), 400);
  });
}

// Join an existing room by its code. Typos are rejected instead of silently creating an empty room.
function joinRoomByCode(rawCode) {
  const code = (rawCode || '').trim().toUpperCase().replace(/\s+/g, '');
  if (code.length < 4) { showToast('Oda kodunu gir (örn. KODA-47)'); return; }
  fetch('/api/room-exists?code=' + encodeURIComponent(code))
    .then(r => r.json())
    .then(d => {
      if (!d.exists) { showToast('Bu kodla bir oda bulunamadı'); return; }
      state.isHost = false;
      state.roomId = d.room.id;
      state.hostName = d.room.host;
      if (dom.activeRoomTitle) dom.activeRoomTitle.textContent = state.roomId;
      if (dom.currentRoomDisplay) dom.currentRoomDisplay.textContent = state.roomId;
      switchToMyRoom();
      connectSignaling();
      showToast(`${d.room.name || state.roomId} odasına katıldın`);
    })
    .catch(() => showToast('Sunucuya ulaşılamadı, bağlantını kontrol et'));
}


function getPlatformBadge(category = '') {
  const cat = (category || '').toLowerCase();
  if (cat.includes('netflix')) {
    return `
      <span class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-red-950/60 text-red-300 border border-red-600/30 font-mono flex items-center gap-1.5 shadow-sm">
        <svg class="w-3.5 h-3.5 text-red-500 fill-current" viewBox="0 0 24 24"><path d="M5.398 0v24c1.815-.224 3.73-.559 5.398-.895V0H5.398zm7.804 0v16.197l5.398 6.721V0h-5.398z"/></svg>
        <span>Netflix</span>
      </span>
    `;
  }
  if (cat.includes('prime')) {
    return `
      <span class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-blue-950/60 text-blue-300 border border-blue-500/30 font-mono flex items-center gap-1.5 shadow-sm">
        <svg class="w-3.5 h-3.5 text-blue-400 fill-current" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-9l6 4.5-6 4.5z"/></svg>
        <span>Prime Video</span>
      </span>
    `;
  }
  if (cat.includes('spotify') || cat.includes('müzik') || cat.includes('music')) {
    return `
      <span class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-950/60 text-emerald-300 border border-emerald-500/30 font-mono flex items-center gap-1.5 shadow-sm">
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#1ED760"/><path fill="#0F0D0B" d="M16.5 14.8c-.2.3-.5.4-.8.2-2.2-1.3-5-1.6-8.2-.9-.3.1-.6-.1-.7-.4-.1-.3.1-.6.4-.7 3.6-.8 6.7-.5 9.1 1 .3.2.4.5.2.8zm1.1-2.4c-.2.4-.6.5-1 .3-2.5-1.5-6.4-2-9.4-1.1-.4.1-.8-.1-.9-.5-.1-.4.1-.8.5-.9 3.4-1 7.7-.5 10.5 1.2.4.2.5.6.3 1zm.1-2.5c-3-1.8-8-2-10.8-.9-.5.1-.9-.1-1.1-.6-.1-.5.1-.9.6-1.1 3.3-1 8.8-.8 12.3 1.3.4.3.6.8.3 1.2-.3.4-.8.5-1.3.1z"/></svg>
        <span>Spotify</span>
      </span>
    `;
  }
  if (cat.includes('anime')) {
    return `
      <span class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-purple-950/60 text-purple-300 border border-purple-500/30 font-mono flex items-center gap-1.5 shadow-sm">
        <svg class="w-3.5 h-3.5 text-purple-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
        <span>Anime</span>
      </span>
    `;
  }
  if (cat.includes('twitch') || cat.includes('oyun')) {
    return `
      <span class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-indigo-950/60 text-indigo-300 border border-indigo-500/30 font-mono flex items-center gap-1.5 shadow-sm">
        <svg class="w-3.5 h-3.5 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 12h4m-2-2v4m10-2h.01m-3 0h.01"/></svg>
        <span>Twitch Canlı</span>
      </span>
    `;
  }
  return `
    <span class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-rose-950/60 text-rose-300 border border-rose-500/30 font-mono flex items-center gap-1.5 shadow-sm">
      <svg class="w-3.5 h-3.5 text-rose-500 fill-current" viewBox="0 0 24 24"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
      <span>${category || 'YouTube'}</span>
    </span>
  `;
}

function renderStackedAvatars(avatars) {
  if (!avatars || avatars.length === 0) {
    return `
      <div class="w-6 h-6 rounded-full bg-gradient-to-tr from-purple-500 to-indigo-600 flex items-center justify-center text-[10px] font-bold text-white border-2 border-[#0C0E17] shadow-sm">U</div>
    `;
  }
  return avatars.slice(0, 4).map((av) => {
    const isImgUrl = typeof av === 'string' && (av.startsWith('http://') || av.startsWith('https://') || av.startsWith('/'));
    if (isImgUrl) {
      return `<img src="${av}" alt="Katılımcı" class="w-6 h-6 rounded-full object-cover border-2 border-[#0C0E17] shadow-sm shrink-0" loading="lazy">`;
    }
    if (av && av.url) {
      return `<img src="${av.url}" alt="Katılımcı" class="w-6 h-6 rounded-full object-cover border-2 border-[#0C0E17] shadow-sm shrink-0" loading="lazy">`;
    }
    return `
      <div class="w-6 h-6 rounded-full bg-gradient-to-tr ${av.bg || 'from-rose-500 to-purple-600'} flex items-center justify-center text-[10px] font-bold text-white border-2 border-[#0C0E17] shadow-sm" title="Katılımcı">
        ${av.initial || 'M'}
      </div>
    `;
  }).join('');
}

const DEFAULT_COMMUNITY_ROOMS = [
  {
    id: 'O-SES-RAVE',
    name: 'O SES RAVE • 🎤',
    category: 'YouTube',
    host: 'RaveTR',
    mediaTitle: 'O SES RAVE • 🎤',
    videoId: '4NRXx6U8ABQ',
    viewers: 10,
    avatars: [
      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=120&auto=format&fit=crop&q=80'
    ]
  },
  {
    id: 'ANIL-EMRE',
    name: 'Anıl Emre Daldal - B. (Official Video)',
    category: 'YouTube',
    host: 'EmreFan',
    mediaTitle: 'Anıl Emre Daldal - B. (Official Video)',
    videoId: 'ezkd3wzB6s8',
    viewers: 5,
    avatars: [
      'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=120&auto=format&fit=crop&q=80'
    ]
  },
  {
    id: 'RENTA-BARON',
    name: 'rentaBARON MU KİM ??',
    category: 'YouTube',
    host: 'Renta',
    mediaTitle: 'rentaBARON MU KİM ??',
    videoId: 'mDYqT0_9nJA',
    viewers: 3,
    avatars: [
      'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=120&auto=format&fit=crop&q=80'
    ]
  },
  {
    id: 'HALILISKO',
    name: 'Halilişko Patatesi Bırakıyor, Chatin Falına Baktım | MUHABBET SPOR',
    category: 'YouTube',
    host: 'MuhabbetSpor',
    mediaTitle: 'Halilişko Patatesi Bırakıyor | MUHABBET SPOR',
    videoId: 'jfKfPfyJRdk',
    viewers: 3,
    avatars: [
      'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&auto=format&fit=crop&q=80'
    ]
  },
  {
    id: 'MED-CEZIR',
    name: 'Med Cezir',
    category: 'YouTube',
    host: 'CezaFan',
    mediaTitle: 'Ceza - Med Cezir (Official)',
    videoId: 'b9EkMc79ZSU',
    viewers: 2,
    avatars: [
      'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=120&auto=format&fit=crop&q=80'
    ]
  },
  {
    id: 'GEL-GOR-BENI',
    name: 'Gel Gör Beni Aşk Neyledi',
    category: 'YouTube',
    host: 'BarisAkarsu',
    mediaTitle: 'Barış Akarsu - Gel Gör Beni Aşk Neyledi',
    videoId: 'aM3ElTrVrcM',
    viewers: 2,
    avatars: [
      'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=120&auto=format&fit=crop&q=80'
    ]
  }
];

function renderRoomList(roomsToRender) {
  if (!dom.publicRoomsGrid) return;
  dom.publicRoomsGrid.innerHTML = '';
  
  roomsToRender.forEach(r => {
    const card = document.createElement('button');
    card.type = 'button';
    const thumbUrl = r.thumb || (r.videoId ? `https://img.youtube.com/vi/${r.videoId}/hqdefault.jpg` : 'https://img.youtube.com/vi/jfKfPfyJRdk/hqdefault.jpg');
    
    // Rave capsule pill style (matching screenshot 1)
    card.className = 'w-full text-left bg-[#0C0E17]/90 hover:bg-[#141824] border border-white/10 hover:border-white/20 rounded-3xl p-3 sm:p-4 flex items-center gap-3.5 sm:gap-4 transition-all shadow-xl hover:scale-[1.01] active:scale-[0.98] group cursor-pointer overflow-hidden relative select-none';
    card.innerHTML = `
      <!-- Left: Rounded video thumbnail with translucent play button -->
      <div class="relative w-28 sm:w-36 aspect-video rounded-2xl overflow-hidden bg-black shrink-0 border border-white/10 shadow-md pointer-events-none">
        <img src="${escapeHtml(thumbUrl)}" class="w-full h-full object-cover group-hover:scale-105 transition-transform" alt="Thumbnail" loading="lazy">
        <div class="absolute inset-0 bg-black/25 flex items-center justify-center">
          <div class="w-7 h-7 rounded-full bg-black/60 backdrop-blur-sm border border-white/30 text-white flex items-center justify-center text-xs pl-0.5">▶</div>
        </div>
      </div>

      <!-- Right: Title, Category & Overlapping Avatars with +viewers badge (Rave Layout) -->
      <div class="flex-1 min-w-0 flex flex-col justify-between py-0.5 pointer-events-none">
        <div>
          <div class="flex items-center gap-2 mb-1">
            <span class="text-[10px] font-bold text-rose-400 bg-rose-500/15 px-2 py-0.5 rounded-full uppercase tracking-wider">${escapeHtml(r.category || 'YouTube')}</span>
          </div>
          <h4 class="text-sm sm:text-base font-bold text-white tracking-tight group-hover:text-rose-200 transition-colors truncate">
            ${escapeHtml(r.mediaTitle || r.name)}
          </h4>
          <p class="text-[11px] sm:text-xs text-gray-400 truncate mt-0.5">${escapeHtml(r.name)}</p>
        </div>

        <!-- Bottom: Host & Overlapping Avatars + Red Pill Badge -->
        <div class="flex items-center justify-between mt-2 pt-1 border-t border-white/5">
          <span class="text-[10px] sm:text-[11px] text-gray-500 truncate">Kurucu: @${escapeHtml(r.host || 'admin')}</span>
          <div class="flex items-center gap-2 shrink-0">
            <div class="flex items-center -space-x-2">
              ${renderStackedAvatars(r.avatars)}
            </div>
            <span class="px-2 py-0.5 rounded-full text-[10px] sm:text-[11px] font-black bg-rose-600 text-white shadow-sm font-mono">+${r.viewers || 1}</span>
          </div>
        </div>
      </div>
    `;

    // Entire capsule card is clickable to enter the room
    const enterRoom = (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      const roomId = r.id;
      state.roomId = roomId;
      state.hostName = r.host || 'Yönetici';
      state.isHost = (r.host === state.username);
      state.controlMode = 'host_only';
      state.hasDjPermission = state.isHost;
      if (dom.currentRoomDisplay) dom.currentRoomDisplay.textContent = roomId;
      switchToMyRoom();
      connectSignaling();
      if (r.videoId) {
        setTimeout(() => { loadYoutubeVideo(r.videoId); }, 300);
      }
      showToast(`${r.name} odasına katıldınız! ✨`);
    };

    addInstantTap(card, enterRoom);
    dom.publicRoomsGrid.appendChild(card);
  });
}

function loadPublicRooms() {
  fetch('/api/public-rooms')
    .then(res => res.json())
    .then(data => {
      if (data && data.rooms && data.rooms.length > 0) {
        renderRoomList(data.rooms);
      } else {
        renderRoomList(DEFAULT_COMMUNITY_ROOMS);
      }
    })
    .catch(err => {
      console.warn('API fetch failed, rendering fallback community rooms:', err);
      renderRoomList(DEFAULT_COMMUNITY_ROOMS);
    });
}

// ==========================================
// 5.8 ROOM HOST, DJ PERMISSIONS & FRIENDS SYSTEM
// ==========================================
function updatePermissionUI() {
  if (dom.roomHostName) {
    dom.roomHostName.textContent = state.isHost ? 'Sen' : (state.hostName || 'Yönetici');
  }

  // Toggle button appearance for host
  if (dom.toggleRoomPermissionBtn) {
    if (state.isHost) {
      dom.toggleRoomPermissionBtn.classList.remove('hidden');
      if (state.controlMode === 'host_only') {
        dom.permModeText.textContent = 'Sadece Yönetici';
        dom.toggleRoomPermissionBtn.className = 'px-2.5 py-1 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs font-semibold flex items-center gap-1.5 transition-all';
        dom.permLockIcon.innerHTML = '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>';
      } else {
        dom.permModeText.textContent = 'Herkes Açabilir';
        dom.toggleRoomPermissionBtn.className = 'px-2.5 py-1 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-semibold flex items-center gap-1.5 transition-all';
        dom.permLockIcon.innerHTML = '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 019.9-1"/>';
      }
    } else {
      // Non-host: hide the toggle mode button
      dom.toggleRoomPermissionBtn.classList.add('hidden');
    }
  }

  // Determine whether current user has rights to control media
  const canControl = state.isHost || state.controlMode === 'everyone' || state.hasDjPermission || state.userRole === 'owner' || state.userRole === 'admin' || state.userRole === 'dj';

  if (dom.roomQuickSearchBtnText) {
    dom.roomQuickSearchBtnText.textContent = canControl ? 'Değiştir' : 'Öner';
  }

  // Toggle input controls and notice bar
  if (dom.guestPermissionNotice) {
    if (canControl) {
      dom.guestPermissionNotice.classList.add('hidden');
      dom.guestPermissionNotice.classList.remove('flex');
      if (dom.youtubeInputSection && state.activeMode === 'youtube') dom.youtubeInputSection.classList.remove('hidden');
      if (dom.screenShareInputSection && state.activeMode === 'screenshare') dom.screenShareInputSection.classList.remove('hidden');
      if (dom.directVideoInputSection && state.activeMode === 'direct') dom.directVideoInputSection.classList.remove('hidden');
    } else {
      dom.guestPermissionNotice.classList.remove('hidden');
      dom.guestPermissionNotice.classList.add('flex');
      if (dom.youtubeInputSection) dom.youtubeInputSection.classList.add('hidden');
      if (dom.screenShareInputSection) dom.screenShareInputSection.classList.add('hidden');
      if (dom.directVideoInputSection) dom.directVideoInputSection.classList.add('hidden');
    }
  }
}

function handleRemotePermissionChange(newMode, hostName) {
  state.controlMode = newMode;
  if (hostName) state.hostName = hostName;
  updatePermissionUI();
  showToast(newMode === 'everyone' ? 'Oda Yöneticisi video açma iznini herkese verdi! 🔓' : 'Oda Yöneticisi kontrolleri kilitledi (Sadece Yönetici) 🔒');
}

function handleDjPermissionRequested(fromUser) {
  if (!state.isHost) return;
  if (dom.requestingUserName) dom.requestingUserName.textContent = fromUser || 'Misafir';
  if (dom.hostPermissionRequestToast) {
    dom.hostPermissionRequestToast.classList.remove('hidden');
    dom.hostPermissionRequestToast.classList.add('flex');
  }
  showToast(`${fromUser || 'Misafir'} video açma yetkisi istedi! ✋`);
}

function handleDjPermissionGranted(toUser) {
  state.hasDjPermission = true;
  updatePermissionUI();
  showToast('🎉 Tebrikler! Oda yöneticisi size video açma yetkisi verdi.');
}

// Default seed friends (With unique usernames)
const DEFAULT_FRIENDS = [
  { id: 'f1', name: 'Selin Yılmaz', username: 'selin', status: 'online', statusText: 'Çevrimiçi', avatar: 'S' },
  { id: 'f2', name: 'Can Demir', username: 'can', status: 'in_room', statusText: 'Film Odasında', avatar: 'C' },
  { id: 'f3', name: 'Merve Kaya', username: 'merve', status: 'idle', statusText: 'Boşta', avatar: 'M' }
];

function loadFriends() {
  const saved = localStorage.getItem('miruo_friends');
  if (saved) {
    try {
      state.friends = JSON.parse(saved);
    } catch (e) {
      state.friends = DEFAULT_FRIENDS;
    }
  } else {
    state.friends = DEFAULT_FRIENDS;
    localStorage.setItem('miruo_friends', JSON.stringify(state.friends));
  }

  // Display user's unique username (@kullanici)
  const currentUsername = '@' + (state.username || 'kullanici').replace(/^@/, '');
  if (dom.myFriendCodeDisplay) dom.myFriendCodeDisplay.textContent = currentUsername;
  if (dom.tabMyFriendCodeDisplay) dom.tabMyFriendCodeDisplay.textContent = currentUsername;

  renderFriendsList();
  renderFriendsTab();
}

function renderFriendsList(filterText = '') {
  if (!dom.friendsListContainer) return;
  dom.friendsListContainer.innerHTML = '';
  
  const query = (filterText || '').toLowerCase().trim().replace(/^@/, '');
  const listToRender = query 
    ? state.friends.filter(f => (f.name && f.name.toLowerCase().includes(query)) || (f.username && f.username.toLowerCase().includes(query)))
    : state.friends;

  if (dom.friendsCountDisplay) dom.friendsCountDisplay.textContent = state.friends.length;

  if (listToRender.length === 0) {
    dom.friendsListContainer.innerHTML = query 
      ? `<p class="text-xs text-gray-400 text-center py-4">"${escapeHtml(query)}" ile eşleşen kullanıcı bulunamadı.</p>`
      : '<p class="text-xs text-gray-500 text-center py-4">Henüz ekli arkadaşın yok. Kullanıcı adını girerek ekleyebilirsin!</p>';
    return;
  }

  listToRender.forEach(fr => {
    const item = document.createElement('div');
    item.className = 'flex items-center justify-between p-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 transition-all';
    
    let badgeColor = 'bg-emerald-400';
    if (fr.status === 'in_room') badgeColor = 'bg-purple-400';
    if (fr.status === 'idle') badgeColor = 'bg-amber-400';

    item.innerHTML = `
      <div class="flex items-center gap-2.5">
        <div class="w-8 h-8 rounded-full bg-gradient-to-tr from-rose-500 to-indigo-600 flex items-center justify-center text-xs font-bold text-white shadow-sm">
          ${fr.avatar || fr.name.charAt(0)}
        </div>
        <div>
          <div class="flex items-center gap-1.5">
            <span class="text-xs font-semibold text-white block">${fr.name}</span>
            <span class="text-[10px] font-bold text-rose-300">@${(fr.username || fr.name).replace(/^@/, '')}</span>
          </div>
          <span class="text-[10px] text-gray-400 flex items-center gap-1">
            <span class="w-1.5 h-1.5 rounded-full ${badgeColor}"></span>
            <span>${fr.statusText || 'Çevrimiçi'}</span>
          </span>
        </div>
      </div>

      <div class="flex items-center gap-1.5">
        <button class="invite-friend-btn px-2.5 py-1 bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 rounded-lg text-[11px] font-semibold transition-all flex items-center gap-1 cursor-pointer" data-name="${fr.name}">
          <svg class="w-3 h-3 text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6m0-6L10 14"/></svg>
          <span>Odaya Çağır</span>
        </button>
      </div>
    `;

    addInstantTap(item.querySelector('.invite-friend-btn'), () => {
      const inviteUrl = `${window.location.origin}/?room=${encodeURIComponent(state.roomId)}`;
      navigator.clipboard.writeText(inviteUrl).then(() => {
        showToast(`${fr.name} için davet linki kopyalandı! 📋`);
      });
    });

    dom.friendsListContainer.appendChild(item);
  });
}

async function addFriend(nameOrUsername) {
  const query = (nameOrUsername || '').trim();
  if (!query) return;

  const cleanUsername = query.replace(/^@/, '').trim();
  const currentMyUsername = (state.username || '').replace(/^@/, '').trim();

  if (cleanUsername.toLowerCase() === currentMyUsername.toLowerCase()) {
    showToast('⚠️ Kendini arkadaş olarak ekleyemezsin!');
    return;
  }

  const already = state.friends.find(f => (f.username || f.name).toLowerCase().replace(/^@/, '') === cleanUsername.toLowerCase());
  if (already) {
    showToast(`ℹ️ @${cleanUsername} zaten arkadaş listenizde!`);
    return;
  }

  // Check backend search for user
  let friendName = cleanUsername;
  let friendAvatar = null;
  try {
    const res = await fetch(`/api/users/search?q=${encodeURIComponent(cleanUsername)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.users && data.users.length > 0) {
        const found = data.users.find(u => (u.username || '').toLowerCase() === cleanUsername.toLowerCase());
        if (found) {
          friendName = found.fullName || found.username;
          friendAvatar = found.avatarUrl;
        }
      }
    }
  } catch (e) {}

  const newFriend = {
    id: 'f_' + Date.now(),
    name: friendName,
    username: cleanUsername,
    avatarUrl: friendAvatar,
    status: 'online',
    statusText: 'Çevrimiçi',
    avatar: cleanUsername.charAt(0).toUpperCase()
  };

  state.friends.unshift(newFriend);
  localStorage.setItem('miruo_friends', JSON.stringify(state.friends));
  renderFriendsList(dom.friendSearchInput ? dom.friendSearchInput.value : '');
  renderFriendsTab(dom.tabFriendSearchInput ? dom.tabFriendSearchInput.value : '');
  if (dom.addFriendInput) dom.addFriendInput.value = '';
  if (dom.tabAddFriendInput) dom.tabAddFriendInput.value = '';
  showToast(`@${cleanUsername} arkadaşlarına eklendi! 🎉`);
}

function renderFriendsTab(filterText = '') {
  const container = document.getElementById('tabFriendsContainer');
  const codeDisplay = document.getElementById('tabMyFriendCodeDisplay');
  const onlineCountDisplay = document.getElementById('tabFriendsOnlineCount');
  if (!container) return;

  const currentUsername = '@' + (state.username || 'kullanici').replace(/^@/, '');
  if (codeDisplay) codeDisplay.textContent = currentUsername;
  const myCodeModal = document.getElementById('myFriendCodeDisplay');
  if (myCodeModal) myCodeModal.textContent = currentUsername;

  const query = (filterText || '').toLowerCase().trim().replace(/^@/, '');
  const listToRender = query 
    ? state.friends.filter(f => (f.name && f.name.toLowerCase().includes(query)) || (f.username && f.username.toLowerCase().includes(query)))
    : state.friends;

  const onlineFriends = state.friends.filter(f => f.status === 'online' || f.status === 'in_room');
  if (onlineCountDisplay) onlineCountDisplay.textContent = `${onlineFriends.length} Çevrimiçi`;

  if (listToRender.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center bg-[#0C0E17] border border-white/10 rounded-2xl">
        <p class="text-xs text-gray-400">${query ? `"${escapeHtml(query)}" ile eşleşen kullanıcı bulunamadı.` : 'Henüz arkadaş eklemedin.'}</p>
        <p class="text-[11px] text-gray-500 mt-1">Arkadaşının kullanıcı adını (@kullanici) yukarıdan girerek hemen ekleyebilirsin.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  listToRender.forEach(fr => {
    const card = document.createElement('div');
    card.className = 'p-3 sm:p-3.5 rounded-2xl bg-[#0C0E17] border border-white/10 hover:border-white/20 transition-all flex items-center justify-between gap-3 shadow-md';
    const isOnline = fr.status === 'online' || fr.status === 'in_room';

    card.innerHTML = `
      <div class="flex items-center gap-3 min-w-0">
        <div class="relative shrink-0">
          ${fr.avatarUrl ? 
            `<img src="${fr.avatarUrl}" class="w-10 h-10 rounded-full object-cover border border-white/20" alt="Avatar">` :
            `<div class="w-10 h-10 rounded-full bg-gradient-to-tr from-rose-500 to-indigo-600 flex items-center justify-center font-bold text-white text-xs shadow-sm">${(fr.avatar || fr.name.charAt(0) || 'A').toUpperCase()}</div>`
          }
          <span class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#0C0E17] ${isOnline ? 'bg-emerald-400' : 'bg-gray-500'}"></span>
        </div>
        <div class="truncate">
          <div class="flex items-center gap-2">
            <span class="text-xs font-bold text-white truncate">${fr.name}</span>
            <span class="text-[10px] font-bold text-rose-300">@${(fr.username || fr.name).replace(/^@/, '')}</span>
          </div>
          <span class="text-[10px] ${isOnline ? 'text-emerald-400' : 'text-gray-500'} block">
            ${fr.currentRoom ? `Şu an odada` : (isOnline ? 'Çevrimiçi' : 'Çevrimdışı')}
          </span>
        </div>
      </div>
      
      <div class="flex items-center gap-1.5 shrink-0">
        <button class="invite-friend-tab-btn px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-medium text-gray-200 hover:text-white transition-all cursor-pointer flex items-center gap-1" data-name="${fr.name}">
          <svg class="w-3.5 h-3.5 text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6m0-6L10 14"/></svg>
          <span>Çağır</span>
        </button>
      </div>
    `;

    addInstantTap(card.querySelector('.invite-friend-tab-btn'), () => {
      const inviteUrl = `${window.location.origin}/?room=${encodeURIComponent(state.roomId)}`;
      navigator.clipboard.writeText(inviteUrl).then(() => {
        showToast(`${fr.name} için davet linki kopyalandı! 📋`);
      });
    });

    container.appendChild(card);
  });
}

function switchToFriendsTab() {
  if (dom.exploreLobbySection) {
    dom.exploreLobbySection.classList.add('hidden');
    dom.exploreLobbySection.classList.remove('flex');
  }
  if (dom.providerPickerSection) {
    dom.providerPickerSection.classList.add('hidden');
    dom.providerPickerSection.classList.remove('flex');
  }
  if (dom.roomWorkspaceSection) {
    dom.roomWorkspaceSection.classList.add('hidden');
    dom.roomWorkspaceSection.classList.remove('flex');
  }
  
  const friendsTab = document.getElementById('friendsTabSection');
  if (friendsTab) {
    friendsTab.classList.remove('hidden');
    friendsTab.classList.add('flex');
  }

  if (dom.mobileNavExploreBtn) {
    dom.mobileNavExploreBtn.className = 'flex flex-col items-center gap-1 text-gray-400 hover:text-white py-1 px-3 transition-all cursor-pointer';
  }
  if (dom.mobileNavFriendsBtn) {
    dom.mobileNavFriendsBtn.className = 'flex flex-col items-center gap-1 text-white font-bold py-1 px-3 transition-all cursor-pointer';
  }

  loadFriends();
  renderFriendsTab();
}


// ==========================================
// 5.9 IN-ROOM LIVE TEXT CHAT & ZOOM PARTICIPANTS SYSTEM
// ==========================================
function toggleChatPanel(forceOpen) {
  if (!dom.roomChatPanel) return;
  const isHidden = dom.roomChatPanel.classList.contains('hidden');
  const shouldOpen = forceOpen !== undefined ? forceOpen : isHidden;

  if (shouldOpen) {
    // If opening chat, close participants panel so they don't fight for space
    if (dom.roomParticipantsPanel) {
      dom.roomParticipantsPanel.classList.add('hidden');
      dom.roomParticipantsPanel.classList.remove('flex');
    }

    dom.roomChatPanel.classList.remove('hidden');
    dom.roomChatPanel.classList.add('flex');
    if (dom.chatUnreadDot) dom.chatUnreadDot.classList.add('hidden');
    if (dom.chatMessageInput) dom.chatMessageInput.focus();
    if (dom.chatMessagesContainer) {
      dom.chatMessagesContainer.scrollTop = dom.chatMessagesContainer.scrollHeight;
    }
  } else {
    dom.roomChatPanel.classList.add('hidden');
    dom.roomChatPanel.classList.remove('flex');
  }
}

function toggleParticipantsPanel(forceOpen) {
  if (!dom.roomParticipantsPanel) return;
  const isHidden = dom.roomParticipantsPanel.classList.contains('hidden');
  const shouldOpen = forceOpen !== undefined ? forceOpen : isHidden;

  if (shouldOpen) {
    // If opening participants, close chat panel
    if (dom.roomChatPanel) {
      dom.roomChatPanel.classList.add('hidden');
      dom.roomChatPanel.classList.remove('flex');
    }

    dom.roomParticipantsPanel.classList.remove('hidden');
    dom.roomParticipantsPanel.classList.add('flex');
    renderParticipantsList();
  } else {
    dom.roomParticipantsPanel.classList.add('hidden');
    dom.roomParticipantsPanel.classList.remove('flex');
  }
}

function updateRemoteParticipantStatus(userId, username, isMicOn, isCamOn) {
  if (!userId) return;
  state.participants[userId] = {
    userId,
    username: username || 'Partner',
    isMicOn: !!isMicOn,
    isCamOn: !!isCamOn,
    isHost: false,
    lastSeen: Date.now()
  };
  renderParticipantsList();
}

function broadcastMyMediaStatus() {
  sendP2PData('media_status', {
    userId: state.userId,
    username: state.username,
    isMicOn: state.isMicOn,
    isCamOn: state.isCamOn
  });
  renderParticipantsList();
}

function openRoomParticipantsModal() {
  if (dom.roomParticipantsModal) {
    dom.roomParticipantsModal.classList.remove('hidden');
    dom.roomParticipantsModal.classList.add('flex');
    renderParticipantsList();
  }
}

function closeRoomParticipantsModal() {
  if (dom.roomParticipantsModal) {
    dom.roomParticipantsModal.classList.add('hidden');
    dom.roomParticipantsModal.classList.remove('flex');
  }
}

function kickParticipant(userId, username) {
  if (!confirm(`"${username}" kullanıcısını odadan çıkarmak istediğinize emin misiniz?`)) {
    return;
  }

  // 1. If simulated bot
  if (userId.startsWith('bot_') || (activeRoomBots && activeRoomBots.some(b => 'bot_' + b.name === userId || b.name === username))) {
    activeRoomBots = activeRoomBots.filter(b => ('bot_' + b.name) !== userId && b.name !== username);
    renderParticipantsList();
    renderVideoGrid();
    showToast(`🚫 ${username} odadan atıldı.`);
    renderChatMessage('Sistem 🛡️', `🚫 ${username} oda sahibi tarafından odadan çıkarıldı.`, false, null);
    return;
  }

  // 2. If real user / peer
  sendP2PData('kick_user', {
    targetUserId: userId,
    targetUsername: username
  });

  delete state.participants[userId];
  renderParticipantsList();
  renderVideoGrid();
  showToast(`"${username}" odadan çıkarıldı.`);
  renderChatMessage('Sistem', `"${username}" oda sahibi tarafından odadan çıkarıldı.`, false, null);
}

function setParticipantRole(userId, username, newRole) {
  const roleLabels = {
    owner: 'Oda Sahibi',
    admin: 'Yönetici',
    video_control: 'Video Açabilir',
    dj: 'Video Açabilir',
    member: 'İzleyici'
  };
  const roleName = roleLabels[newRole] || newRole;

  // 1. If simulated bot
  if (userId.startsWith('bot_') || (activeRoomBots && activeRoomBots.some(b => 'bot_' + b.name === userId || b.name === username))) {
    const bot = activeRoomBots.find(b => ('bot_' + b.name) === userId || b.name === username);
    if (bot) bot.role = newRole;
    renderParticipantsList();
    showToast(`${username} artık ${roleName} yetkisine sahip.`);
    renderChatMessage('Sistem', `${username} kullanıcısına ${roleName} yetkisi verildi.`, false, null);
    return;
  }

  // 2. If real peer
  if (state.participants[userId]) {
    state.participants[userId].role = newRole;
  }

  sendP2PData('role_update', {
    targetUserId: userId,
    targetUsername: username,
    newRole: newRole
  });

  renderParticipantsList();
  showToast(`${username} artık ${roleName} yetkisine sahip.`);
  renderChatMessage('Sistem', `${username} kullanıcısına ${roleName} yetkisi verildi.`, false, null);
}

function handleRemoteUserKicked(targetUserId, targetUsername) {
  if (targetUserId === state.userId) {
    alert('Oda sahibi tarafından odadan çıkarıldınız.');
    if (state.localStream) {
      state.localStream.getTracks().forEach(t => t.stop());
      state.localStream = null;
      state.isMicOn = false;
      state.isCamOn = false;
    }
    switchToExplore();
  } else {
    delete state.participants[targetUserId];
    renderParticipantsList();
    renderVideoGrid();
    renderChatMessage('Sistem', `${targetUsername || 'Bir kullanıcı'} oda sahibi tarafından odadan çıkarıldı.`, false, null);
  }
}

function handleRemoteRoleUpdate(targetUserId, newRole, targetUsername) {
  const roleLabels = {
    owner: 'Oda Sahibi',
    admin: 'Yönetici',
    video_control: 'Video Açabilir',
    dj: 'Video Açabilir',
    member: 'İzleyici'
  };
  const roleName = roleLabels[newRole] || newRole;

  if (targetUserId === state.userId) {
    state.userRole = newRole;
    state.hasDjPermission = (newRole === 'owner' || newRole === 'admin' || newRole === 'video_control' || newRole === 'dj');
    updatePermissionUI();
    showToast(`Yetkiniz güncellendi: ${roleName}`);
  } else if (state.participants[targetUserId]) {
    state.participants[targetUserId].role = newRole;
  }
  renderParticipantsList();
  renderChatMessage('Sistem', `${targetUsername || 'Bir kullanıcı'} artık ${roleName} yetkisine sahip.`, false, null);
}

function renderParticipantsList() {
  if (!dom.participantsListContainer) return;
  dom.participantsListContainer.innerHTML = '';

  const isCurrentUserOwner = state.isHost || state.userRole === 'owner';
  const isCurrentUserAdmin = isCurrentUserOwner || state.userRole === 'admin';

  if (dom.hostRoleNotice) {
    dom.hostRoleNotice.classList.toggle('hidden', !isCurrentUserOwner);
  }

  // Current user (Self) is always listed first
  const savedUserObj = JSON.parse(localStorage.getItem('miruo_user') || '{}');
  const selfAvatar = state.avatarUrl || savedUserObj.avatarUrl || '';
  const selfAvatarBg = state.avatarBg || savedUserObj.avatarBg || 'from-rose-500 to-indigo-600';

  const selfMember = {
    userId: state.userId,
    username: `${state.username} (Sen)`,
    avatar: selfAvatar,
    avatarColor: selfAvatarBg,
    isMicOn: state.isMicOn,
    isCamOn: state.isCamOn,
    isHost: state.isHost,
    role: state.userRole || (state.isHost ? 'owner' : 'member'),
    isSelf: true
  };

  const allMembers = [selfMember];

  // Add active partner or remote participants
  Object.values(state.participants).forEach(p => {
    if (p.userId !== state.userId) {
      if (!p.role) p.role = p.isHost ? 'owner' : 'member';
      allMembers.push(p);
    }
  });

  // If in room with a peer but participant object not yet sent, seed standard partner
  if (state.peerId && !state.participants[state.peerId]) {
    allMembers.push({
      userId: state.peerId,
      username: state.hostName && state.hostName !== 'Sen' ? state.hostName : 'Partner',
      isMicOn: false,
      isCamOn: false,
      isHost: !state.isHost,
      role: !state.isHost ? 'owner' : 'member',
      isSelf: false
    });
  }

  // Add active simulated bots in the room
  if (activeRoomBots && activeRoomBots.length > 0) {
    activeRoomBots.forEach(bot => {
      allMembers.push({
        userId: 'bot_' + bot.name,
        username: bot.name,
        avatar: bot.avatar,
        avatarColor: bot.color,
        isMicOn: false,
        isCamOn: false,
        isHost: false,
        role: bot.role || 'member',
        isSelf: false,
        isBot: true
      });
    });
  }

  // Update counter badges
  if (dom.roomMemberCountBadge) dom.roomMemberCountBadge.textContent = allMembers.length;
  if (dom.participantsCountHeader) dom.participantsCountHeader.textContent = allMembers.length;

  allMembers.forEach(m => {
    const card = document.createElement('div');
    card.className = 'flex items-center justify-between p-2.5 rounded-2xl bg-white/5 border border-white/5 hover:border-white/10 transition-all gap-2';

    // SVG mic active vs muted
    const micSvg = m.isMicOn
      ? `<span class="p-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" title="Mikrofon Açık">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4m-4 0h8"/></svg>
        </span>`
      : `<span class="p-1.5 rounded-lg bg-red-500/15 text-red-400 border border-red-500/25" title="Mikrofon Kapalı">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/><path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
        </span>`;

    // SVG cam active vs muted
    const camSvg = m.isCamOn
      ? `<span class="p-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" title="Kamera Açık">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        </span>`
      : `<span class="p-1.5 rounded-lg bg-red-500/15 text-red-400 border border-red-500/25" title="Kamera Kapalı">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 16v1a2 2 0 01-2 2H3a2 2 0 01-2-2V7a2 2 0 012-2h1m5 0h6a2 2 0 012 2v4"/><polyline points="23 7 16 12 23 17"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
        </span>`;

    const avatarHtml = m.avatar
      ? `<img src="${m.avatar}" class="w-8 h-8 rounded-full object-cover shrink-0 shadow-sm border border-white/10" alt="PP">`
      : `<div class="w-8 h-8 rounded-full bg-gradient-to-tr ${m.avatarColor || 'from-rose-500 to-indigo-600'} flex items-center justify-center text-xs font-bold text-white shadow-sm shrink-0">
          ${(m.username || 'K').charAt(0).toUpperCase()}
        </div>`;

    const currentRole = m.role || (m.isHost ? 'owner' : 'member');
    const roleBadges = {
      owner: '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[10px] bg-amber-500/15 text-amber-300 font-semibold border border-amber-500/30 shadow-sm"><svg class="w-3 h-3 text-amber-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/></svg><span>Oda Sahibi</span></span>',
      admin: '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[10px] bg-indigo-500/15 text-indigo-300 font-semibold border border-indigo-500/30 shadow-sm"><svg class="w-3 h-3 text-indigo-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><span>Yönetici</span></span>',
      video_control: '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[10px] bg-rose-500/15 text-rose-300 font-semibold border border-rose-500/30 shadow-sm"><svg class="w-3 h-3 text-rose-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>Video Açabilir</span></span>',
      dj: '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[10px] bg-rose-500/15 text-rose-300 font-semibold border border-rose-500/30 shadow-sm"><svg class="w-3 h-3 text-rose-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>Video Açabilir</span></span>',
      member: '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[10px] bg-white/10 text-gray-300 font-medium border border-white/10"><svg class="w-3 h-3 text-gray-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span>İzleyici</span></span>'
    };

    let actionsHtml = '';
    if ((isCurrentUserOwner || isCurrentUserAdmin) && !m.isSelf) {
      actionsHtml = `
        <div class="flex items-center gap-1.5 shrink-0">
          <select class="role-selector-dropdown bg-[#141824] hover:bg-[#1a2030] text-gray-200 text-[11px] font-semibold py-1.5 px-2 rounded-xl border border-white/15 focus:outline-none focus:border-rose-500 transition-all cursor-pointer" data-user-id="${m.userId}" data-username="${m.username}">
            <option value="admin" ${currentRole === 'admin' ? 'selected' : ''}>Yönetici</option>
            <option value="video_control" ${currentRole === 'video_control' || currentRole === 'dj' ? 'selected' : ''}>Video Açabilir</option>
            <option value="member" ${currentRole === 'member' || !currentRole ? 'selected' : ''}>İzleyici</option>
          </select>

          <button class="kick-participant-btn p-1.5 rounded-xl bg-red-500/15 hover:bg-red-500/25 active:scale-95 text-red-400 hover:text-red-300 border border-red-500/25 transition-all cursor-pointer flex items-center gap-1 text-[11px] font-semibold" data-user-id="${m.userId}" data-username="${m.username}" title="Odadan Çıkar">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
            <span class="hidden sm:inline">Çıkar</span>
          </button>
        </div>
      `;
    } else {
      actionsHtml = `
        <div class="shrink-0">
          ${roleBadges[currentRole] || roleBadges.member}
        </div>
      `;
    }

    let friendBtnHtml = '';
    if (!m.isSelf) {
      const cleanTargetName = (m.username || '').replace(/^@/, '').trim();
      const isAlreadyFriend = state.friends.some(f => (f.username || f.name).toLowerCase().replace(/^@/, '') === cleanTargetName.toLowerCase());
      if (isAlreadyFriend) {
        friendBtnHtml = `<span class="px-2 py-0.5 rounded-lg text-[9px] bg-white/5 text-emerald-400 border border-emerald-500/20 font-medium shrink-0">✓ Arkadaş</span>`;
      } else {
        friendBtnHtml = `
          <button type="button" class="add-friend-from-participant-btn px-2 py-1 rounded-xl bg-gradient-to-r from-rose-500 to-indigo-600 hover:opacity-90 active:scale-95 text-white text-[10px] font-bold shadow-sm transition-all cursor-pointer flex items-center gap-1 shrink-0" data-username="${cleanTargetName}" title="Arkadaş Ekle">
            <svg class="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
            <span>Ekle</span>
          </button>
        `;
      }
    }

    card.innerHTML = `
      <div class="flex items-center gap-2.5 min-w-0 flex-1">
        ${avatarHtml}
        <div class="truncate">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-xs font-bold text-white truncate max-w-[110px] sm:max-w-none">${m.username}</span>
            ${m.isSelf ? '<span class="px-1 py-0.2 rounded text-[9px] bg-rose-500/20 text-rose-300 font-bold border border-rose-500/30">Sen</span>' : ''}
            ${m.isBot ? '<span class="px-1 py-0.2 rounded text-[9px] bg-blue-500/20 text-blue-300 font-bold border border-blue-500/30">Simüle</span>' : ''}
          </div>
          <span class="text-[10px] text-gray-400 block">${m.isSelf ? 'Senin Cihazın' : (m.isBot ? 'Oda Katılımcısı' : 'Canlı Bağlantı')}</span>
        </div>
      </div>

      <div class="flex items-center gap-2 shrink-0">
        <div class="flex items-center gap-1">
          ${micSvg}
          ${camSvg}
        </div>
        ${friendBtnHtml}
        ${actionsHtml}
      </div>
    `;

    const addFrBtn = card.querySelector('.add-friend-from-participant-btn');
    if (addFrBtn) {
      addFrBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const uName = addFrBtn.getAttribute('data-username');
        addFriend(uName);
        renderParticipantsList();
      });
    }

    const roleSelect = card.querySelector('.role-selector-dropdown');
    if (roleSelect) {
      roleSelect.addEventListener('change', (e) => {
        const uId = e.target.getAttribute('data-user-id');
        const uName = e.target.getAttribute('data-username');
        const newRole = e.target.value;
        setParticipantRole(uId, uName, newRole);
      });
    }

    const kickBtn = card.querySelector('.kick-participant-btn');
    if (kickBtn) {
      kickBtn.addEventListener('click', () => {
        const uId = kickBtn.getAttribute('data-user-id');
        const uName = kickBtn.getAttribute('data-username');
        kickParticipant(uId, uName);
      });
    }

    dom.participantsListContainer.appendChild(card);
  });
}

function sendChatMessage(text, imageUrl = null) {
  const content = (text || (dom.chatMessageInput ? dom.chatMessageInput.value : '')).trim();
  if (!content && !imageUrl) return;

  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const senderName = state.username || 'Sen';

  // Render locally immediately
  renderChatMessage(senderName, content, true, timeStr, imageUrl, state.avatarUrl);

  // Send via P2P / signaling to room members
  sendP2PData('chat', {
    sender: senderName,
    text: content,
    time: timeStr,
    imageUrl: imageUrl,
    avatarUrl: state.avatarUrl
  });

  if (dom.chatMessageInput) {
    dom.chatMessageInput.value = '';
    dom.chatMessageInput.focus();
  }
}

function renderChatMessage(sender, text, isSelf, timeStr, imageUrl = null, avatarUrl = null) {
  if (!dom.chatMessagesContainer) return;

  const time = timeStr || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const msgEl = document.createElement('div');
  msgEl.className = `flex gap-2 max-w-[88%] ${isSelf ? 'ml-auto flex-row-reverse' : 'mr-auto flex-row'}`;

  const avUrl = isSelf ? (state.avatarUrl || avatarUrl) : avatarUrl;
  const initial = (sender || 'M').charAt(0).toUpperCase();
  const avatarHtml = `
    <div class="w-6 h-6 rounded-full ${isSelf ? 'bg-gradient-to-tr from-rose-500 to-indigo-600' : 'bg-gradient-to-tr from-cyan-500 to-blue-600'} flex items-center justify-center text-[10px] font-bold text-white shrink-0 shadow-sm mt-0.5 overflow-hidden border border-white/10">
      ${avUrl ? `<img src="${avUrl}" class="w-full h-full object-cover" alt="PP">` : initial}
    </div>
  `;

  const bubbleColor = isSelf 
    ? 'bg-gradient-to-r from-rose-600 to-indigo-600 text-white rounded-2xl rounded-tr-sm shadow-md shadow-rose-900/20' 
    : 'bg-[#141824] text-gray-100 rounded-2xl rounded-tl-sm border border-white/10 shadow-sm';

  const imageHtml = imageUrl ? `<div class="mb-1.5"><img src="${imageUrl}" class="rounded-xl max-h-48 max-w-full object-cover border border-white/20 shadow-md" alt="Görsel"></div>` : '';
  const textHtml = text ? `<div class="${bubbleColor} px-3.5 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap select-text">${escapeHtml(text)}</div>` : '';

  msgEl.innerHTML = `
    ${avatarHtml}
    <div class="flex-1 min-w-0 ${isSelf ? 'text-right' : 'text-left'}">
      <div class="flex items-center gap-1.5 mb-1 px-1 text-[10px] text-gray-400 ${isSelf ? 'justify-end' : 'justify-start'}">
        <span class="font-semibold ${isSelf ? 'text-rose-300' : 'text-indigo-300'}">${escapeHtml(sender)}</span>
        <span>•</span>
        <span>${time}</span>
      </div>
      ${imageHtml}
      ${textHtml}
    </div>
  `;

  dom.chatMessagesContainer.appendChild(msgEl);
  dom.chatMessagesContainer.scrollTop = dom.chatMessagesContainer.scrollHeight;

  // If chat panel is currently closed, illuminate the unread badge on the chat button
  if (!isSelf && dom.roomChatPanel && dom.roomChatPanel.classList.contains('hidden')) {
    if (dom.chatUnreadDot) dom.chatUnreadDot.classList.remove('hidden');
    showToast(`💬 ${sender}: ${text ? (text.length > 25 ? text.substring(0, 25) + '...' : text) : '📷 Görsel gönderdi'}`);
  }
}

function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

// ==========================================
// 6. IN-ROOM MEDIA EXPLORER & VIDEO DISCOVERY
// ==========================================
let currentMediaCategory = 'all';
let mediaSearchDebounceTimer = null;

async function searchAndRenderMedia(query = '', category = 'all') {
  if (!dom.mediaPickerGrid) return;
  currentMediaCategory = category;

  dom.mediaPickerGrid.innerHTML = `
    <div class="col-span-full py-6 flex flex-col items-center justify-center text-center text-xs text-gray-400">
      <div class="w-5 h-5 border-2 border-rose-500 border-t-transparent rounded-full animate-spin mb-2"></div>
      <span>Videolar yükleniyor...</span>
    </div>
  `;

  try {
    const res = await fetch(`/api/search-media?q=${encodeURIComponent(query)}&cat=${encodeURIComponent(category)}`);
    const data = await res.json();
    const items = (data && data.results) || [];

    if (items.length === 0) {
      dom.mediaPickerGrid.innerHTML = `
        <div class="col-span-full py-8 text-center text-xs text-gray-400">
          <p>Sonuç bulunamadı 🔍</p>
          <span class="text-[10px] text-gray-500 mt-1 block">Farklı bir arama terimi deneyin veya kategori seçin.</span>
        </div>
      `;
      return;
    }

    dom.mediaPickerGrid.innerHTML = items.map(video => `
      <div class="media-card-item bg-[#0C0E17] hover:bg-[#141824] border border-white/5 rounded-xl p-1.5 flex flex-col gap-1.5 cursor-pointer text-left group" data-video-id="${escapeHtml(video.id)}" data-title="${escapeHtml(video.title)}">
        <div class="relative w-full aspect-video rounded-lg overflow-hidden bg-black">
          <img src="${escapeHtml(video.thumb)}" class="w-full h-full object-cover group-hover:scale-105 transition-transform" alt="Cover" loading="lazy">
          <span class="absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-black/80 text-white font-mono">${escapeHtml(video.duration)}</span>
          <div class="absolute inset-0 bg-rose-600/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            <div class="w-7 h-7 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-lg text-xs">▶</div>
          </div>
        </div>
        <div class="flex flex-col px-0.5 pb-0.5">
          <h4 class="text-[11px] font-bold text-gray-200 line-clamp-1 group-hover:text-rose-300 transition-colors">${escapeHtml(video.title)}</h4>
          <div class="flex items-center justify-between text-[10px] text-gray-400 mt-0.5">
            <span class="truncate max-w-[85px]">${escapeHtml(video.channel)}</span>
            <span class="text-[9px] text-gray-500">${escapeHtml(video.views || '')}</span>
          </div>
        </div>
      </div>
    `).join('');

    // Attach click events
    dom.mediaPickerGrid.querySelectorAll('.media-card-item').forEach(card => {
      card.addEventListener('click', () => {
        const vid = card.dataset.videoId;
        const title = card.dataset.title;
        if (vid) {
          loadYoutubeVideo(vid);
          showToast(`🎬 "${title}" başlatıldı!`);
        }
      });
    });
  } catch (err) {
    console.error('search-media error:', err);
    dom.mediaPickerGrid.innerHTML = `<div class="col-span-full py-4 text-center text-xs text-red-400">Yüklenirken hata oluştu.</div>`;
  }
}

// ==========================================
// 7. AUTH & USER PROFILE MANAGEMENT
// ==========================================
// 7. AUTH & USER PROFILE MANAGEMENT
// ==========================================
let selectedWelcomeAvatar = 'M';
let isSignUpMode = false;

function showAuthAlert(msg, isSuccess = false) {
  if (!dom.authStatusAlert) return;
  dom.authStatusAlert.textContent = msg;
  dom.authStatusAlert.className = isSuccess 
    ? "text-xs px-3.5 py-2.5 rounded-xl font-medium transition-all text-center bg-emerald-500/15 text-emerald-600 border border-emerald-500/30"
    : "text-xs px-3.5 py-2.5 rounded-xl font-medium transition-all text-center bg-rose-500/15 text-rose-600 border border-rose-500/30";
  dom.authStatusAlert.classList.remove('hidden');
}

function hideAuthAlert() {
  if (dom.authStatusAlert) dom.authStatusAlert.classList.add('hidden');
}

let selectedSignUpAvatarData = null;
let selectedSignUpAvatarBg = 'from-rose-500 to-indigo-600';
let selectedSignUpAvatarChar = 'M';

function setAuthMode(signUp) {
  isSignUpMode = signUp;
  hideAuthAlert();
  if (signUp) {
    if (dom.authHeadingTitle) dom.authHeadingTitle.textContent = "Kayıt Ol";
    if (dom.authSubtitle) dom.authSubtitle.textContent = "İsim, e-posta ve şifrenizle hemen kaydolun.";
    if (dom.signUpNameField) dom.signUpNameField.classList.remove('hidden');
    if (dom.signUpAvatarSection) dom.signUpAvatarSection.classList.add('hidden');
    if (dom.signUpPasswordConfirmField) dom.signUpPasswordConfirmField.classList.remove('hidden');
    if (dom.authRememberRow) dom.authRememberRow.classList.add('hidden');
    if (dom.authContactLabel) dom.authContactLabel.textContent = "E-posta";
    if (dom.authContactInput) dom.authContactInput.placeholder = "ornek@gmail.com";
    if (dom.authTabSignUp) dom.authTabSignUp.className = "flex-1 py-2.5 rounded-xl text-xs font-bold bg-[#18181B] text-white shadow-sm transition-all text-center cursor-pointer";
    if (dom.authTabSignIn) dom.authTabSignIn.className = "flex-1 py-2.5 rounded-xl text-xs font-semibold text-gray-500 hover:text-gray-900 transition-all text-center cursor-pointer";
    if (dom.authSubmitBtn) dom.authSubmitBtn.textContent = "Kayıt Ol";
    if (dom.authPasswordInput) dom.authPasswordInput.setAttribute('autocomplete', 'new-password');
    if (dom.authFooterText) dom.authFooterText.textContent = "Zaten bir hesabın var mı?";
    if (dom.authFooterAction) dom.authFooterAction.textContent = "Giriş Yap";
  } else {
    if (dom.authHeadingTitle) dom.authHeadingTitle.textContent = "Giriş Yap";
    if (dom.authSubtitle) dom.authSubtitle.textContent = "E-posta ve şifrenizle giriş yapın.";
    if (dom.signUpNameField) dom.signUpNameField.classList.add('hidden');
    if (dom.signUpAvatarSection) dom.signUpAvatarSection.classList.add('hidden');
    if (dom.signUpPasswordConfirmField) dom.signUpPasswordConfirmField.classList.add('hidden');
    if (dom.authRememberRow) dom.authRememberRow.classList.remove('hidden');
    if (dom.authContactLabel) dom.authContactLabel.textContent = "E-posta";
    if (dom.authContactInput) dom.authContactInput.placeholder = "ornek@gmail.com";
    if (dom.authPasswordInput) dom.authPasswordInput.setAttribute('autocomplete', 'current-password');
    if (dom.authTabSignIn) dom.authTabSignIn.className = "flex-1 py-2.5 rounded-xl text-xs font-bold bg-[#18181B] text-white shadow-sm transition-all text-center cursor-pointer";
    if (dom.authTabSignUp) dom.authTabSignUp.className = "flex-1 py-2.5 rounded-xl text-xs font-semibold text-gray-500 hover:text-gray-900 transition-all text-center cursor-pointer";
    if (dom.authSubmitBtn) dom.authSubmitBtn.textContent = "Giriş Yap";
    if (dom.authFooterText) dom.authFooterText.textContent = "Miruo'da yeni misin?";
    if (dom.authFooterAction) dom.authFooterAction.textContent = "Kayıt Ol";
  }

  // Preserve phone mode submit button text
  if (currentAuthMethod === 'phone') {
    const isOtpVisible = dom.authPhoneOtpField && !dom.authPhoneOtpField.classList.contains('hidden');
    if (dom.authSubmitBtn) {
      dom.authSubmitBtn.textContent = isOtpVisible ? "Doğrula & Giriş Yap" : "Doğrulama Kodu Gönder";
    }
  }
}

let currentAuthMethod = 'email'; // 'email' | 'phone'

function setAuthMethod(method) {
  currentAuthMethod = method;
  hideAuthAlert();
  if (method === 'phone') {
    if (dom.authMethodPhoneBtn) {
      dom.authMethodPhoneBtn.className = "flex-1 py-1 rounded-lg text-[11px] font-bold bg-white text-gray-900 shadow-xs transition-all text-center cursor-pointer";
    }
    if (dom.authMethodEmailBtn) {
      dom.authMethodEmailBtn.className = "flex-1 py-1 rounded-lg text-[11px] font-semibold text-gray-500 hover:text-gray-900 transition-all text-center cursor-pointer";
    }
    if (dom.authEmailSection) dom.authEmailSection.classList.add('hidden');
    if (dom.authPhoneSection) dom.authPhoneSection.classList.remove('hidden');
    if (dom.signUpNameField) dom.signUpNameField.classList.add('hidden');
    if (dom.signUpAvatarSection) dom.signUpAvatarSection.classList.add('hidden');
    if (dom.authSubmitBtn) {
      const isOtpVisible = dom.authPhoneOtpField && !dom.authPhoneOtpField.classList.contains('hidden');
      dom.authSubmitBtn.textContent = isOtpVisible ? "Doğrula & Giriş Yap" : "Doğrulama Kodu Gönder";
    }
  } else {
    if (dom.authMethodEmailBtn) {
      dom.authMethodEmailBtn.className = "flex-1 py-1 rounded-lg text-[11px] font-bold bg-white text-gray-900 shadow-xs transition-all text-center cursor-pointer";
    }
    if (dom.authMethodPhoneBtn) {
      dom.authMethodPhoneBtn.className = "flex-1 py-1 rounded-lg text-[11px] font-semibold text-gray-500 hover:text-gray-900 transition-all text-center cursor-pointer";
    }
    if (dom.authEmailSection) dom.authEmailSection.classList.remove('hidden');
    if (dom.authPhoneSection) dom.authPhoneSection.classList.add('hidden');
    if (isSignUpMode) {
      if (dom.signUpNameField) dom.signUpNameField.classList.remove('hidden');
      if (dom.signUpAvatarSection) dom.signUpAvatarSection.classList.remove('hidden');
    }
    if (dom.authSubmitBtn) {
      dom.authSubmitBtn.textContent = isSignUpMode ? "Kayıt Ol" : "Giriş Yap";
    }
  }
}

function loadUserSession() {
  const savedUser = localStorage.getItem('miruo_user');
  const urlParams = new URLSearchParams(window.location.search);
  const hash = (window.location.hash || '').replace('#', '');
  const initialView = localStorage.getItem('miruo_initial_view');
  let roomFromUrl = urlParams.get('room');
  if (!roomFromUrl && window.location.pathname.includes('/oda/')) {
    roomFromUrl = window.location.pathname.split('/oda/')[1].split('/')[0].split('?')[0];
  }
  if (!roomFromUrl && hash) {
    if (hash.startsWith('room=')) roomFromUrl = hash.split('room=')[1].split('&')[0];
    else if (hash === 'room' || hash === 'my-room') roomFromUrl = 'ODA-77';
  }
  if (!roomFromUrl && initialView === 'room') {
    roomFromUrl = 'ODA-77';
  }

  let user;
  if (savedUser) {
    try {
      user = JSON.parse(savedUser);
    } catch (e) {
      localStorage.removeItem('miruo_user');
    }
  }

  // If no profile saved yet, open Registration modal unless entering a room directly
  if (!user) {
    const guestNum = Math.floor(1000 + Math.random() * 9000);
    user = {
      id: 'user_' + Math.random().toString(36).substring(2, 8),
      name: 'Misafir',
      defaultRoom: 'ODA-' + guestNum,
      avatarChar: 'M'
    };
    if (dom.authModal) {
      if (!roomFromUrl && !urlParams.get('modal') && !urlParams.get('view') && !urlParams.get('room') && !urlParams.get('profile') && urlParams.get('auth') !== 'reset' && hash !== 'reset') {
        dom.authModal.classList.remove('hidden');
        setAuthMode(false);
      } else {
        dom.authModal.classList.add('hidden');
      }
    }
  } else {
    if (dom.authModal) dom.authModal.classList.add('hidden');
  }

  if (urlParams.get('profile') || hash === 'settings' || hash === 'profile') {
    const targetTab = urlParams.get('profile') === 'settings' || hash === 'settings' ? 'settings' : 'profile';
    setTimeout(() => { if (typeof openProfileEditModal === 'function') openProfileEditModal(targetTab); }, 350);
  } else if (urlParams.get('auth') === 'phone' || hash === 'phone') {
    if (dom.authModal) {
      dom.authModal.classList.remove('hidden');
      setAuthMethod('phone');
    }
  } else if (urlParams.get('auth') === 'reset' || hash === 'reset') {
    setTimeout(() => {
      if (typeof window.openResetModal === 'function') window.openResetModal();
      else if (dom.resetPasswordModal) {
        if (dom.authModal) dom.authModal.classList.add('hidden');
        dom.resetPasswordModal.classList.remove('hidden');
      }
    }, 350);
  }

  state.userId = user.id || state.userId;
  state.username = user.name || 'Kullanıcı';
  state.roomId = (roomFromUrl || user.defaultRoom || 'ODA-77').toUpperCase();
  state.avatarUrl = user.avatarUrl || '';
  state.avatarBg = user.avatarBg || '';

  updateUserUI(user);

  if (urlParams.get('modal') === 'participants') {
    switchToMyRoom();
    connectSignaling();
    setTimeout(() => openRoomParticipantsModal(), 250);
  } else if (urlParams.get('modal') === 'share') {
    switchToMyRoom();
    connectSignaling();
    setTimeout(() => {
      if (typeof window.openRoomShareModal === 'function') window.openRoomShareModal();
    }, 350);
  } else if (urlParams.get('modal') === 'video_chooser') {
    switchToMyRoom();
    connectSignaling();
    setTimeout(() => {
      if (typeof window.openVideoChooser === 'function') window.openVideoChooser();
    }, 350);
  } else if (urlParams.get('modal') === 'video_action') {
    switchToMyRoom();
    connectSignaling();
    setTimeout(() => {
      if (typeof window.openVideoChooser === 'function') {
        window.openVideoChooser();
        const checkInterval = setInterval(() => {
          const firstCard = document.querySelector('.rave-yt-card');
          if (firstCard) {
            clearInterval(checkInterval);
            firstCard.click();
          }
        }, 100);
        setTimeout(() => clearInterval(checkInterval), 4000);
      }
    }, 350);
  } else if (urlParams.get('modal') === 'queue') {
    switchToMyRoom();
    connectSignaling();
    setTimeout(() => {
      if (typeof window.openRoomQueueModal === 'function') window.openRoomQueueModal();
    }, 350);
  } else if (urlParams.get('modal') === 'access') {
    switchToMyRoom();
    connectSignaling();
    setTimeout(() => {
      if (typeof window.openRoomAccessModal === 'function') window.openRoomAccessModal();
    }, 450);
  } else if (urlParams.get('modal') === 'test_photo_picker') {
    switchToMyRoom();
    connectSignaling();
    setTimeout(() => {
      triggerPhotoPicker('chat');
    }, 600);
  } else if (urlParams.get('modal') === 'friends' || urlParams.get('view') === 'friends') {
    switchToFriendsTab();
  } else if (urlParams.get('modal') === 'login') {
    if (dom.authModal) dom.authModal.classList.remove('hidden');
    setAuthMode(false);
  } else if (urlParams.get('modal') === 'reset' || urlParams.get('auth') === 'reset') {
    if (dom.authModal) dom.authModal.classList.add('hidden');
    setTimeout(() => {
      openResetModal();
    }, 250);
  } else if (roomFromUrl) {
    switchToMyRoom();
    connectSignaling();
  } else {
    switchToExplore();
  }

  // Auto camera preview if requested by test parameter
  if (urlParams.get('cam') === '1' || hash.includes('cam=1') || localStorage.getItem('miruo_cam_auto') === '1') {
    setTimeout(() => {
      if (!state.isCamOn) toggleCam();
    }, 450);
  }
  return true;
}

function updateUserUI(user) {
  const displayName = user.fullName || user.name || 'Kullanıcı';
  state.avatarUrl = user.avatarUrl || state.avatarUrl || '';
  state.avatarBg = user.avatarBg || state.avatarBg || '';
  if (dom.userNameHeader) dom.userNameHeader.textContent = displayName;
  if (dom.userProfileBtn) {
    if (user.avatarUrl) {
      dom.userProfileBtn.innerHTML = `<img src="${user.avatarUrl}" class="w-full h-full object-cover rounded-full" alt="Avatar">`;
      dom.userProfileBtn.className = 'w-8 h-8 rounded-full overflow-hidden flex items-center justify-center cursor-pointer border border-white/20 shadow-sm';
    } else {
      dom.userProfileBtn.innerHTML = `<span id="userAvatarHeader">${(user.avatarChar || displayName || 'M').charAt(0).toUpperCase()}</span>`;
      dom.userProfileBtn.className = `w-8 h-8 rounded-full bg-gradient-to-tr ${user.avatarBg || 'from-rose-500 to-indigo-600'} flex items-center justify-center text-xs font-bold text-white shadow-sm cursor-pointer`;
    }
  }

  // Mobile Bottom Navigation Profile Avatar
  const mobileNavAvatar = document.getElementById('mobileNavAvatar');
  if (mobileNavAvatar) {
    if (user.avatarUrl) {
      mobileNavAvatar.innerHTML = `<img src="${user.avatarUrl}" class="w-full h-full object-cover rounded-full" alt="Avatar">`;
      mobileNavAvatar.className = 'w-6 h-6 rounded-full overflow-hidden flex items-center justify-center text-[10px] font-bold text-white shadow-xs border border-white/20';
    } else {
      const char = (user.avatarChar || displayName || 'M').charAt(0).toUpperCase();
      mobileNavAvatar.innerHTML = char;
      mobileNavAvatar.className = `w-6 h-6 rounded-full bg-gradient-to-tr ${user.avatarBg || 'from-rose-500 to-indigo-600'} flex items-center justify-center text-[10px] font-bold text-white shadow-xs overflow-hidden border border-white/20`;
    }
  }

  if (dom.editAvatarPreview) {
    if (user.avatarUrl) {
      dom.editAvatarPreview.innerHTML = `<img src="${user.avatarUrl}" class="w-full h-full object-cover rounded-full" alt="Preview">`;
      dom.editAvatarPreview.className = 'w-22 h-22 rounded-2xl overflow-hidden flex items-center justify-center border-2 border-white/20 shadow-md';
    } else {
      dom.editAvatarPreview.innerHTML = (user.avatarChar || displayName || 'M').charAt(0).toUpperCase();
      dom.editAvatarPreview.className = `w-22 h-22 rounded-2xl bg-gradient-to-tr ${user.avatarBg || 'from-rose-500 to-indigo-600'} flex items-center justify-center text-3xl font-bold text-white border-2 border-white/20 shadow-md`;
    }
  }
  if (dom.signUpAvatarPreview && user.avatarUrl) {
    dom.signUpAvatarPreview.innerHTML = `<img src="${user.avatarUrl}" class="w-full h-full object-cover rounded-full" alt="Avatar">`;
  }
  if (dom.selfPipAvatarInitial) {
    if (user.avatarUrl) {
      dom.selfPipAvatarInitial.innerHTML = `<img src="${user.avatarUrl}" class="w-full h-full object-cover rounded-full" alt="Avatar">`;
    } else {
      dom.selfPipAvatarInitial.textContent = (user.avatarChar || displayName || 'M').charAt(0).toUpperCase();
    }
  }
  if (dom.nowPlayingAvatar) {
    if (user.avatarUrl) {
      dom.nowPlayingAvatar.innerHTML = `<img src="${user.avatarUrl}" class="w-full h-full object-cover rounded-full" alt="Avatar">`;
    } else {
      dom.nowPlayingAvatar.innerHTML = (user.avatarChar || displayName || 'M').charAt(0).toUpperCase();
    }
  }
  const stageAvatarCircle = document.getElementById('stageAvatarCircle');
  if (stageAvatarCircle) {
    if (user.avatarUrl) {
      stageAvatarCircle.innerHTML = `<img src="${user.avatarUrl}" class="w-full h-full object-cover rounded-full" alt="Avatar">`;
    } else {
      stageAvatarCircle.innerHTML = (user.avatarChar || displayName || 'M').charAt(0).toUpperCase();
    }
  }

  // Update Username Display Everywhere
  const cleanUsername = '@' + (user.username || user.name || displayName || 'kullanici').replace(/^@/, '');
  if (dom.tabMyFriendCodeDisplay) dom.tabMyFriendCodeDisplay.textContent = cleanUsername;
  if (dom.myFriendCodeDisplay) dom.myFriendCodeDisplay.textContent = cleanUsername;
  if (dom.editProfileNameInput) dom.editProfileNameInput.value = (user.username || user.name || displayName || '').replace(/^@/, '');
  if (dom.profileEmailDisplay) dom.profileEmailDisplay.textContent = user.email || 'user@miruo.app';
  if (dom.currentRoomDisplay) dom.currentRoomDisplay.textContent = state.roomId;
}

async function logoutUser() {
  localStorage.removeItem('miruo_user');
  sessionStorage.clear();

  if (supabaseClient && supabaseClient.auth) {
    try {
      await supabaseClient.auth.signOut();
    } catch (e) {
      console.warn('[Miruo] Supabase signOut info:', e);
    }
  }

  state.userId = null;
  state.username = null;
  state.avatarUrl = '';
  state.avatarBg = '';

  // Close profile modal if open
  if (dom.profileEditModal) {
    dom.profileEditModal.classList.add('hidden');
  }

  // Clear inputs
  if (dom.authNameInput) dom.authNameInput.value = '';
  if (dom.authContactInput) dom.authContactInput.value = '';
  if (dom.authPasswordInput) dom.authPasswordInput.value = '';
  if (dom.authPasswordConfirmInput) dom.authPasswordConfirmInput.value = '';

  // Directly show Giriş Yap (Login) screen
  if (dom.authModal) {
    dom.authModal.classList.remove('hidden');
    setAuthMode(false);
    setAuthMethod('email');
  }

  showToast('Oturum kapatıldı.');
}

function initEvents() {
  // Welcome / Onboarding Avatar Selection
  document.querySelectorAll('.welcome-avatar-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.welcome-avatar-btn').forEach(b => {
        b.className = 'welcome-avatar-btn w-11 h-11 rounded-xl bg-white/5 text-white font-bold text-sm hover:opacity-90 flex items-center justify-center transition-all cursor-pointer';
      });
      btn.className = 'welcome-avatar-btn active w-11 h-11 rounded-xl bg-gradient-to-tr from-rose-500 to-purple-600 text-white font-bold text-sm ring-2 ring-white flex items-center justify-center transition-all cursor-pointer';
      selectedWelcomeAvatar = btn.dataset.char || 'M';
    });
  });

  // ==========================================
  // REFERENCE LOGIN & SIGN UP HANDLERS
  // ==========================================

  if (dom.authTabSignIn) dom.authTabSignIn.addEventListener('click', () => setAuthMode(false));
  if (dom.authTabSignUp) dom.authTabSignUp.addEventListener('click', () => setAuthMode(true));
  if (dom.authFooterAction) dom.authFooterAction.addEventListener('click', () => setAuthMode(!isSignUpMode));

  // Sign Up Avatar & Photo Picker Setup
  if (dom.signUpAvatarClickArea) {
    dom.signUpAvatarClickArea.addEventListener('click', (e) => {
      e.preventDefault();
      triggerPhotoPicker('signup');
    });
  }
  if (dom.triggerSignUpAvatarFileBtn) {
    dom.triggerSignUpAvatarFileBtn.addEventListener('click', (e) => {
      e.preventDefault();
      triggerPhotoPicker('signup');
    });
  }
  if (dom.signUpAvatarFileInput) {
    dom.signUpAvatarFileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (loadEvt) => {
        selectedSignUpAvatarData = loadEvt.target.result;
        if (dom.signUpAvatarPreview) {
          dom.signUpAvatarPreview.innerHTML = `<img src="${selectedSignUpAvatarData}" class="w-full h-full object-cover rounded-full" alt="Avatar">`;
        }
      };
      reader.readAsDataURL(file);
    });
  }
  document.querySelectorAll('.signup-preset-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedSignUpAvatarData = null;
      selectedSignUpAvatarBg = btn.dataset.bg || 'from-rose-500 to-indigo-600';
      const char = (dom.authNameInput && dom.authNameInput.value.trim().charAt(0).toUpperCase()) || selectedSignUpAvatarChar || 'M';
      selectedSignUpAvatarChar = char;
      if (dom.signUpAvatarPreview) {
        dom.signUpAvatarPreview.innerHTML = char;
        dom.signUpAvatarPreview.className = `w-14 h-14 rounded-full bg-gradient-to-tr ${selectedSignUpAvatarBg} flex items-center justify-center text-lg font-bold text-white shadow-md overflow-hidden border-2 border-white ring-2 ring-gray-200`;
      }
    });
  });
  if (dom.authNameInput) {
    dom.authNameInput.addEventListener('input', (e) => {
      const char = e.target.value.trim().charAt(0).toUpperCase();
      if (char) {
        selectedSignUpAvatarChar = char;
        if (!selectedSignUpAvatarData && dom.signUpAvatarPreview) {
          dom.signUpAvatarPreview.innerHTML = char;
        }
      }
    });
  }

  // Toggle Password Visibility
  if (dom.togglePasswordVisibility && dom.authPasswordInput) {
    dom.togglePasswordVisibility.addEventListener('click', () => {
      const isPass = dom.authPasswordInput.type === 'password';
      dom.authPasswordInput.type = isPass ? 'text' : 'password';
    });
  }

  // Native Apple Sign In Callback from iOS Swift
  window.handleNativeAppleSignInResponse = async function(response) {
    if (dom.appleLoginBtn) {
      dom.appleLoginBtn.classList.remove('opacity-60', 'pointer-events-none');
    }

    if (!response || !response.success) {
      // If user canceled the Apple sheet, do not show any error alert
      if (response && (response.canceled || response.error === 'canceled' || (typeof response.error === 'string' && response.error.includes('1001')))) {
        console.log('[Miruo] Apple Sign In dismissed by user');
        hideAuthAlert();
        return;
      }
      const err = response && response.error ? response.error : 'İşlem tamamlanamadı.';
      console.warn('[Miruo] Native Apple Sign In error:', err);
      showAuthAlert('Giriş işlemi tamamlanamadı. Lütfen tekrar deneyin.', false);
      return;
    }

    hideAuthAlert();
    const { identityToken, email, fullName, userIdentifier } = response;

    // 1. Auto-fill form inputs if present
    if (fullName) {
      if (dom.authNameInput) dom.authNameInput.value = fullName;
      if (dom.editProfileNameInput) dom.editProfileNameInput.value = fullName;
    }
    if (email) {
      if (dom.authContactInput) dom.authContactInput.value = email;
    }

    // 2. Prepare user profile
    const displayName = fullName || (email ? email.split('@')[0] : 'Mehmet Karabulut');
    const safeUsername = (displayName.replace(/[^a-zA-Z0-9_]/g, '') || ('user_' + Math.random().toString(36).substring(2, 6))).toLowerCase();
    const avatarChar = displayName.charAt(0).toUpperCase() || 'M';

    const verifiedUser = {
      id: userIdentifier || ('apple_' + Date.now()),
      name: displayName,
      username: safeUsername,
      email: email || '',
      avatarChar: avatarChar,
      avatarBg: 'from-rose-500 to-indigo-600',
      isApple: true,
      provider: 'apple'
    };

    localStorage.setItem('miruo_user', JSON.stringify(verifiedUser));
    state.userId = verifiedUser.id;
    state.username = verifiedUser.name;
    updateUserUI(verifiedUser);

    if (dom.authModal) {
      dom.authModal.classList.add('hidden');
    }
    showToast(`Hoş geldin, ${displayName} ✨`);

    // 3. Supabase background sync (non-blocking)
    if (supabaseClient && supabaseClient.auth) {
      (async () => {
        try {
          if (identityToken) {
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000));
            await Promise.race([
              supabaseClient.auth.signInWithIdToken({ provider: 'apple', token: identityToken }),
              timeoutPromise
            ]).catch(e => console.warn('[Miruo] Supabase Apple token info:', e.message));
          }
          syncUserProfileToSupabase(verifiedUser);
        } catch (err) {
          console.warn('[Miruo] Supabase background sync note:', err);
        }
      })();
    }
  };

  // Social Auth Handlers (Google OAuth & Native Apple Sign In)
  async function handleSocialLogin(provider) {
    const isGoogle = provider === 'Google';

    // Native iOS Apple Sign In (Dythin method via AuthenticationServices)
    if (!isGoogle && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.startAppleSignIn) {
      hideAuthAlert();
      if (dom.appleLoginBtn) {
        dom.appleLoginBtn.classList.add('opacity-60', 'pointer-events-none');
      }
      try {
        window.webkit.messageHandlers.startAppleSignIn.postMessage({});
      } catch (e) {
        console.warn('[Miruo] startAppleSignIn failed, falling back:', e);
        if (dom.appleLoginBtn) {
          dom.appleLoginBtn.classList.remove('opacity-60', 'pointer-events-none');
        }
      }
      return;
    }

    // Google OAuth / Web fallback
    const provId = isGoogle ? 'google' : 'apple';
    showAuthAlert(`⏳ ${provider} ile güvenli Supabase bağlantısı kuruluyor...`, true);

    if (supabaseClient && supabaseClient.auth) {
      try {
        const { data, error } = await supabaseClient.auth.signInWithOAuth({
          provider: provId,
          options: {
            redirectTo: window.location.href.split('#')[0]
          }
        });

        if (error) {
          console.warn(`[Miruo] Supabase ${provider} OAuth error:`, error.message);
          showAuthAlert(`⚠️ Supabase ${provider} Sağlayıcısı Henüz Aktif Edilmemiş!\n\nSupabase Panelinizde (qvmdzfhjfdoqjmqipvux) "Authentication -> Providers -> ${provider}" sekmesinden sağlayıcıyı etkinleştirmelisiniz.`, false);
          return;
        } else if (data && data.url) {
          window.location.href = data.url;
          return;
        }
      } catch (err) {
        console.warn(`[Miruo] Supabase ${provider} OAuth exception:`, err);
        showAuthAlert(`⚠️ ${provider} bağlantı hatası: ${err.message}`, false);
        return;
      }
    } else {
      showAuthAlert("⚠️ Supabase istemcisi henüz hazır değil.", false);
    }
  }

  if (dom.googleLoginBtn) dom.googleLoginBtn.addEventListener('click', () => handleSocialLogin('Google'));
  if (dom.appleLoginBtn) dom.appleLoginBtn.addEventListener('click', () => handleSocialLogin('Apple'));
  // -------------------------------------------------------------
  // ŞİFRE SIFIRLAMA & 6 HANELİ DOĞRULAMA KODU (OTP) AKIŞI
  // -------------------------------------------------------------
  const resetState = {
    step: 1,
    email: '',
    code: '',
    timer: null,
    secondsLeft: 60
  };

  const otpInputs = [
    dom.otpDigit1, dom.otpDigit2, dom.otpDigit3,
    dom.otpDigit4, dom.otpDigit5, dom.otpDigit6
  ].filter(Boolean);

  function showResetAlert(step, message, isSuccess = false) {
    const alertElem = step === 1 ? dom.resetStep1Alert : step === 2 ? dom.resetStep2Alert : dom.resetStep3Alert;
    if (!alertElem) return;
    alertElem.textContent = message;
    alertElem.className = `p-3 rounded-xl text-xs font-medium ${isSuccess ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`;
    alertElem.classList.remove('hidden');
  }

  function hideResetAlert(step) {
    const alertElem = step === 1 ? dom.resetStep1Alert : step === 2 ? dom.resetStep2Alert : dom.resetStep3Alert;
    if (alertElem) alertElem.classList.add('hidden');
  }

  function setResetStep(step) {
    resetState.step = step;
    hideResetAlert(1);
    hideResetAlert(2);
    hideResetAlert(3);

    // Update Dots
    if (dom.stepDot1) dom.stepDot1.className = `h-1.5 rounded-full transition-all duration-300 ${step >= 1 ? 'bg-blue-600 w-8' : 'bg-gray-200 w-4'}`;
    if (dom.stepDot2) dom.stepDot2.className = `h-1.5 rounded-full transition-all duration-300 ${step >= 2 ? 'bg-blue-600 w-8' : 'bg-gray-200 w-4'}`;
    if (dom.stepDot3) dom.stepDot3.className = `h-1.5 rounded-full transition-all duration-300 ${step >= 3 ? 'bg-blue-600 w-8' : 'bg-gray-200 w-4'}`;

    // Panes
    if (dom.resetStep1) dom.resetStep1.classList.toggle('hidden', step !== 1);
    if (dom.resetStep2) dom.resetStep2.classList.toggle('hidden', step !== 2);
    if (dom.resetStep3) dom.resetStep3.classList.toggle('hidden', step !== 3);
    if (dom.resetStepSuccess) dom.resetStepSuccess.classList.toggle('hidden', step !== 4);

    if (step === 2) {
      if (dom.resetEmailSentDisplay) dom.resetEmailSentDisplay.textContent = resetState.email;
      otpInputs.forEach(inp => { if (inp) inp.value = ''; });
      if (otpInputs[0]) setTimeout(() => otpInputs[0].focus(), 120);
    } else if (step === 3) {
      if (dom.resetNewPasswordInput) setTimeout(() => dom.resetNewPasswordInput.focus(), 120);
    }
  }

  function startResetTimer() {
    if (resetState.timer) clearInterval(resetState.timer);
    resetState.secondsLeft = 60;
    if (dom.resetResendCodeBtn) dom.resetResendCodeBtn.disabled = true;
    if (dom.resetTimerSpan) dom.resetTimerSpan.textContent = `(${resetState.secondsLeft}s)`;

    resetState.timer = setInterval(() => {
      resetState.secondsLeft--;
      if (resetState.secondsLeft <= 0) {
        clearInterval(resetState.timer);
        resetState.timer = null;
        if (dom.resetResendCodeBtn) dom.resetResendCodeBtn.disabled = false;
        if (dom.resetTimerSpan) dom.resetTimerSpan.textContent = '';
      } else {
        if (dom.resetTimerSpan) dom.resetTimerSpan.textContent = `(${resetState.secondsLeft}s)`;
      }
    }, 1000);
  }

  function openResetModal() {
    if (dom.authModal) dom.authModal.classList.add('hidden');
    if (dom.profileEditModal) dom.profileEditModal.classList.add('hidden');
    if (dom.resetPasswordModal) {
      dom.resetPasswordModal.classList.remove('hidden');
      dom.resetPasswordModal.classList.add('flex');
    }
    const existingVal = (dom.authContactInput && dom.authContactInput.value.trim()) || '';
    if (existingVal.includes('@') && dom.resetEmailInput) {
      dom.resetEmailInput.value = existingVal;
    }
    setResetStep(1);
  }

  window.openResetModal = openResetModal;

  function closeResetModal() {
    if (dom.resetPasswordModal) dom.resetPasswordModal.classList.add('hidden');
    if (resetState.timer) {
      clearInterval(resetState.timer);
      resetState.timer = null;
    }
  }

  if (dom.forgotPasswordBtn) {
    dom.forgotPasswordBtn.addEventListener('click', openResetModal);
  }

  if (dom.closeResetModalBtn) {
    dom.closeResetModalBtn.addEventListener('click', closeResetModal);
  }

  if (dom.resetBackBtn) {
    dom.resetBackBtn.addEventListener('click', () => {
      if (resetState.step === 1 || resetState.step === 4) {
        closeResetModal();
        if (dom.authModal) dom.authModal.classList.remove('hidden');
      } else if (resetState.step === 2) {
        setResetStep(1);
      } else if (resetState.step === 3) {
        setResetStep(2);
      }
    });
  }

  if (dom.resetBackToLoginBtn1) {
    dom.resetBackToLoginBtn1.addEventListener('click', () => {
      closeResetModal();
      if (dom.authModal) {
        isSignUpMode = false;
        switchAuthMode(false);
        dom.authModal.classList.remove('hidden');
      }
    });
  }

  // Step 1: Send 6-digit Code to Email
  async function handleSendResetCode() {
    hideResetAlert(1);
    const emailVal = (dom.resetEmailInput && dom.resetEmailInput.value.trim()) || '';
    if (!emailVal || !emailVal.includes('@') || !emailVal.includes('.')) {
      showResetAlert(1, 'Lütfen geçerli bir e-posta adresi girin.');
      return;
    }

    resetState.email = emailVal;
    if (dom.resetSendCodeBtn) {
      dom.resetSendCodeBtn.disabled = true;
      dom.resetSendCodeBtn.innerHTML = '<span>Kod Gönderiliyor...</span>';
    }

    // Call backend API for forgot-password
    let generatedCode = Math.floor(100000 + Math.random() * 900000).toString();
    resetState.code = generatedCode;

    try {
      const resp = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailVal })
      });
      const data = await resp.json();
      if (data.code) {
        generatedCode = data.code;
        resetState.code = generatedCode;
      }
    } catch (err) {
      console.warn('Backend forgot-password error:', err);
    }

    // Trigger Supabase password recovery if connected
    if (supabaseClient && supabaseClient.auth) {
      try {
        await supabaseClient.auth.resetPasswordForEmail(emailVal, {
          redirectTo: window.location.href.split('#')[0]
        });
      } catch (err) {
        console.warn('[Miruo] Supabase resetPasswordForEmail info:', err);
      }
    }

    if (dom.resetSendCodeBtn) {
      dom.resetSendCodeBtn.disabled = false;
      dom.resetSendCodeBtn.innerHTML = '<span>6 Haneli Kodu Gönder</span> <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>';
    }

    showToast(`📩 6 Haneli Kurtarma Kodu: [ ${generatedCode} ] iletildi!`);
    setResetStep(2);
    startResetTimer();
    showResetAlert(2, `ℹ️ Test / Hızlı Kod: ${generatedCode} (Kutulara yapıştırabilir veya yazabilirsiniz)`, true);
  }

  if (dom.resetSendCodeBtn) {
    dom.resetSendCodeBtn.addEventListener('click', handleSendResetCode);
  }
  if (dom.resetEmailInput) {
    dom.resetEmailInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSendResetCode();
    });
  }

  // Resend code
  if (dom.resetResendCodeBtn) {
    dom.resetResendCodeBtn.addEventListener('click', () => {
      if (resetState.secondsLeft > 0) return;
      handleSendResetCode();
    });
  }

  // 6 OTP Digit Inputs Management
  otpInputs.forEach((inp, idx) => {
    inp.addEventListener('input', (e) => {
      const val = e.target.value.replace(/[^0-9]/g, '');
      e.target.value = val ? val[0] : '';
      if (val && idx < otpInputs.length - 1) {
        otpInputs[idx + 1].focus();
      }
    });

    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !inp.value && idx > 0) {
        otpInputs[idx - 1].focus();
      } else if (e.key === 'Enter') {
        handleVerifyOtp();
      }
    });

    inp.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasteData = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '');
      if (pasteData) {
        for (let i = 0; i < otpInputs.length; i++) {
          otpInputs[i].value = pasteData[i] || '';
        }
        const lastIdx = Math.min(pasteData.length, otpInputs.length) - 1;
        if (lastIdx >= 0) otpInputs[lastIdx].focus();
        if (pasteData.length >= 6) {
          setTimeout(handleVerifyOtp, 150);
        }
      }
    });
  });

  // Step 2: Verify OTP
  async function handleVerifyOtp() {
    hideResetAlert(2);
    const enteredCode = otpInputs.map(inp => inp.value).join('');
    if (enteredCode.length < 6) {
      showResetAlert(2, 'Lütfen 6 haneli kodun tamamını girin.');
      return;
    }

    if (dom.resetVerifyCodeBtn) {
      dom.resetVerifyCodeBtn.disabled = true;
      dom.resetVerifyCodeBtn.innerHTML = '<span>Doğrulanıyor...</span>';
    }

    let isValid = (enteredCode === resetState.code);

    try {
      const resp = await fetch('/api/auth/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resetState.email, code: enteredCode })
      });
      const data = await resp.json();
      if (data.success) {
        isValid = true;
      }
    } catch (err) {
      console.warn('Backend verifyOtp error:', err);
    }

    if (supabaseClient && supabaseClient.auth) {
      try {
        const { data, error } = await supabaseClient.auth.verifyOtp({
          email: resetState.email,
          token: enteredCode,
          type: 'recovery'
        });
        if (!error && data?.session) {
          isValid = true;
        }
      } catch (err) {
        console.warn('[Miruo] Supabase verifyOtp info:', err);
      }
    }

    if (dom.resetVerifyCodeBtn) {
      dom.resetVerifyCodeBtn.disabled = false;
      dom.resetVerifyCodeBtn.innerHTML = '<span>Kodu Doğrula</span> <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
    }

    if (isValid) {
      showToast('✓ Kod başarıyla doğrulandı! Yeni şifrenizi belirleyin.');
      setResetStep(3);
    } else {
      showResetAlert(2, 'Hatalı kod girdiniz. Lütfen e-postanızı veya test kodunu kontrol edin.');
      otpInputs.forEach(i => i.classList.add('border-red-400'));
      setTimeout(() => otpInputs.forEach(i => i.classList.remove('border-red-400')), 1000);
    }
  }

  if (dom.resetVerifyCodeBtn) {
    dom.resetVerifyCodeBtn.addEventListener('click', handleVerifyOtp);
  }

  // Password Visibility Toggles in Reset Modal
  if (dom.toggleNewPassVis && dom.resetNewPasswordInput) {
    dom.toggleNewPassVis.addEventListener('click', () => {
      const isPass = dom.resetNewPasswordInput.type === 'password';
      dom.resetNewPasswordInput.type = isPass ? 'text' : 'password';
    });
  }
  if (dom.toggleConfirmPassVis && dom.resetConfirmPasswordInput) {
    dom.toggleConfirmPassVis.addEventListener('click', () => {
      const isPass = dom.resetConfirmPasswordInput.type === 'password';
      dom.resetConfirmPasswordInput.type = isPass ? 'text' : 'password';
    });
  }

  // Password Strength Meter
  if (dom.resetNewPasswordInput) {
    dom.resetNewPasswordInput.addEventListener('input', () => {
      const val = dom.resetNewPasswordInput.value;
      let score = 0;
      if (val.length >= 6) score++;
      if (val.length >= 8 && /[0-9]/.test(val) && /[a-zA-Z]/.test(val)) score++;
      if (val.length >= 10 && /[^a-zA-Z0-9]/.test(val)) score++;

      if (dom.strengthBar1) dom.strengthBar1.className = `h-1 rounded-full transition-all ${score >= 1 ? (score === 1 ? 'bg-amber-400' : 'bg-emerald-500') : 'bg-gray-200'}`;
      if (dom.strengthBar2) dom.strengthBar2.className = `h-1 rounded-full transition-all ${score >= 2 ? 'bg-emerald-500' : 'bg-gray-200'}`;
      if (dom.strengthBar3) dom.strengthBar3.className = `h-1 rounded-full transition-all ${score >= 3 ? 'bg-emerald-600' : 'bg-gray-200'}`;

      if (dom.strengthText) {
        dom.strengthText.textContent = score === 0 ? 'Şifre gücü (En az 6 karakter)' : score === 1 ? 'Şifre gücü: Temel' : score === 2 ? 'Şifre gücü: İyi' : 'Şifre gücü: Çok Güçlü 🔥';
        dom.strengthText.className = `text-[10px] block mt-1 ${score >= 2 ? 'text-emerald-600 font-semibold' : 'text-gray-400'}`;
      }
    });
  }

  // Step 3: Save New Password
  async function handleSaveNewPassword() {
    hideResetAlert(3);
    const newPass = (dom.resetNewPasswordInput && dom.resetNewPasswordInput.value.trim()) || '';
    const confirmPass = (dom.resetConfirmPasswordInput && dom.resetConfirmPasswordInput.value.trim()) || '';

    if (newPass.length < 6) {
      showResetAlert(3, 'Şifre en az 6 karakter olmalıdır.');
      return;
    }
    if (newPass !== confirmPass) {
      showResetAlert(3, 'Girdiğiniz şifreler birbiriyle eşleşmiyor.');
      return;
    }

    if (dom.resetSaveNewPasswordBtn) {
      dom.resetSaveNewPasswordBtn.disabled = true;
      dom.resetSaveNewPasswordBtn.innerHTML = '<span>Şifre Kaydediliyor...</span>';
    }

    // Call backend reset password API
    try {
      const resp = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resetState.email, code: resetState.code, newPassword: newPass })
      });
      const data = await resp.json();
      if (!data.success) {
        showResetAlert(3, data.message || 'Şifre güncellenemedi.');
        if (dom.resetSaveNewPasswordBtn) {
          dom.resetSaveNewPasswordBtn.disabled = false;
          dom.resetSaveNewPasswordBtn.innerHTML = '<span>Şifreyi Güncelle & Giriş Yap</span>';
        }
        return;
      }
    } catch (err) {
      console.warn('Backend reset password error:', err);
    }

    // Call Supabase update password
    if (supabaseClient && supabaseClient.auth) {
      try {
        await supabaseClient.auth.updateUser({ password: newPass });
      } catch (err) {
        console.warn('[Miruo] Supabase updateUser password warning:', err);
      }
    }

    // Update in local accounts database if exists
    try {
      const usersRaw = localStorage.getItem('miruo_registered_users');
      if (usersRaw) {
        const users = JSON.parse(usersRaw);
        if (users[resetState.email.toLowerCase()]) {
          users[resetState.email.toLowerCase()].password = newPass;
          localStorage.setItem('miruo_registered_users', JSON.stringify(users));
        }
      }
    } catch (_) {}

    if (dom.resetSaveNewPasswordBtn) {
      dom.resetSaveNewPasswordBtn.disabled = false;
      dom.resetSaveNewPasswordBtn.innerHTML = '<span>Şifreyi Güncelle & Giriş Yap</span>';
    }

    showToast('🎉 Şifreniz başarıyla güncellendi!');
    setResetStep(4);
  }

  if (dom.resetSaveNewPasswordBtn) {
    dom.resetSaveNewPasswordBtn.addEventListener('click', handleSaveNewPassword);
  }
  if (dom.resetConfirmPasswordInput) {
    dom.resetConfirmPasswordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSaveNewPassword();
    });
  }

  // Step 4: Finish & Login
  if (dom.resetFinishBtn) {
    dom.resetFinishBtn.addEventListener('click', () => {
      closeResetModal();
      if (dom.authModal) {
        isSignUpMode = false;
        setAuthMode(false);
        if (dom.authContactInput) dom.authContactInput.value = resetState.email;
        if (dom.authPasswordInput) {
          dom.authPasswordInput.value = '';
          dom.authPasswordInput.focus();
        }
        dom.authModal.classList.remove('hidden');
        showToast('Yeni şifrenizle giriş yapabilirsiniz ✨');
      }
    });
  }

  // -------------------------------------------------------------
  // TELEFONLA GİRİŞ & 6 HANELİ SMS ONAY KODU (OTP) AKIŞI
  // -------------------------------------------------------------
  const phoneOtpState = {
    phone: '',
    timer: null,
    secondsLeft: 60
  };

  function startPhoneOtpTimer() {
    if (phoneOtpState.timer) clearInterval(phoneOtpState.timer);
    phoneOtpState.secondsLeft = 60;
    if (dom.phoneOtpResendBtn) dom.phoneOtpResendBtn.disabled = true;
    if (dom.phoneOtpTimerSpan) dom.phoneOtpTimerSpan.textContent = `(${phoneOtpState.secondsLeft}s)`;

    phoneOtpState.timer = setInterval(() => {
      phoneOtpState.secondsLeft--;
      if (phoneOtpState.secondsLeft <= 0) {
        clearInterval(phoneOtpState.timer);
        phoneOtpState.timer = null;
        if (dom.phoneOtpResendBtn) dom.phoneOtpResendBtn.disabled = false;
        if (dom.phoneOtpTimerSpan) dom.phoneOtpTimerSpan.textContent = '';
      } else {
        if (dom.phoneOtpTimerSpan) dom.phoneOtpTimerSpan.textContent = `(${phoneOtpState.secondsLeft}s)`;
      }
    }, 1000);
  }

  async function handleSendPhoneOtp() {
    hideAuthAlert();
    let raw = (dom.authPhoneInput && dom.authPhoneInput.value.trim()) || '';
    let digits = raw.replace(/[^0-9]/g, '');
    if (digits.startsWith('90')) digits = digits.slice(2);
    if (digits.startsWith('0')) digits = digits.slice(1);

    if (digits.length < 10) {
      showAuthAlert("Lütfen geçerli 10 haneli bir telefon numarası girin (Örn: 5XX XXX XX XX).");
      if (dom.authPhoneInput) dom.authPhoneInput.focus();
      return;
    }

    const fullPhone = '+90' + digits;
    phoneOtpState.phone = fullPhone;

    if (dom.authSubmitBtn) {
      dom.authSubmitBtn.disabled = true;
      dom.authSubmitBtn.textContent = "SMS Gönderiliyor...";
    }

    // Supabase Phone OTP dispatch
    if (supabaseClient && supabaseClient.auth) {
      try {
        await supabaseClient.auth.signInWithOtp({ phone: fullPhone });
      } catch (e) {
        console.warn('[Supabase Phone signInWithOtp]:', e);
      }
    }

    try {
      const resp = await fetch('/api/auth/phone-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: fullPhone })
      });
      const data = await resp.json();

      if (dom.authSubmitBtn) {
        dom.authSubmitBtn.disabled = false;
        dom.authSubmitBtn.textContent = "Doğrula & Giriş Yap";
      }

      if (!resp.ok || !data.success) {
        showAuthAlert(data.message || "SMS onay kodu gönderilemedi.");
        return;
      }

      if (dom.authPhoneOtpField) dom.authPhoneOtpField.classList.remove('hidden');
      startPhoneOtpTimer();

      const hint = data.code ? ` (Test Kodu: ${data.code})` : '';
      showAuthAlert(`✓ ${fullPhone} numarasına 6 haneli onay kodu iletildi!${hint}`, true);

      const digitInputs = document.querySelectorAll('.phone-digit-box');
      if (digitInputs.length > 0) {
        digitInputs.forEach(inp => inp.value = '');
        setTimeout(() => digitInputs[0].focus(), 150);
      }
    } catch (err) {
      if (dom.authSubmitBtn) {
        dom.authSubmitBtn.disabled = false;
        dom.authSubmitBtn.textContent = "Doğrulama Kodu Gönder";
      }
      showAuthAlert("Bağlantı hatası: " + err.message);
    }
  }

  async function handleVerifyPhoneOtp() {
    hideAuthAlert();
    const digitInputs = Array.from(document.querySelectorAll('.phone-digit-box'));
    const code = digitInputs.map(d => d.value.trim()).join('');

    if (code.length !== 6) {
      showAuthAlert("Lütfen 6 haneli onay kodunu eksiksiz girin.");
      const firstEmpty = digitInputs.find(d => !d.value.trim());
      if (firstEmpty) firstEmpty.focus();
      return;
    }

    if (dom.authSubmitBtn) {
      dom.authSubmitBtn.disabled = true;
      dom.authSubmitBtn.textContent = "Doğrulanıyor...";
    }

    // Supabase Phone verifyOtp
    if (supabaseClient && supabaseClient.auth) {
      try {
        await supabaseClient.auth.verifyOtp({
          phone: phoneOtpState.phone,
          token: code,
          type: 'sms'
        });
      } catch (e) {
        console.warn('[Supabase Phone verifyOtp]:', e);
      }
    }

    try {
      const resp = await fetch('/api/auth/verify-phone-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phoneOtpState.phone, code })
      });
      const data = await resp.json();

      if (dom.authSubmitBtn) {
        dom.authSubmitBtn.disabled = false;
        dom.authSubmitBtn.textContent = "Doğrula & Giriş Yap";
      }

      if (!resp.ok || !data.success) {
        showAuthAlert(data.message || "Girdiğiniz 6 haneli onay kodu hatalı veya süresi dolmuş.");
        return;
      }

      showAuthAlert("✓ Telefon doğrulaması başarılı! Hoş geldin.", true);

      const user = {
        id: data.user.id,
        name: data.user.fullName || data.user.username || phoneOtpState.phone,
        fullName: data.user.fullName || data.user.username || phoneOtpState.phone,
        username: (data.user.username || 'kullanici').replace(/^@/, ''),
        phone: phoneOtpState.phone,
        email: data.user.email || `${phoneOtpState.phone.replace(/[^0-9]/g, '')}@miruo.app`,
        provider: 'phone',
        avatarUrl: data.user.avatarUrl || '',
        avatarChar: '📱'
      };

      localStorage.setItem('miruo_user', JSON.stringify(user));
      state.userId = user.id;
      state.username = user.name;
      state.avatarUrl = user.avatarUrl;
      syncUserProfileToSupabase(user);

      setTimeout(() => {
        updateUserUI(user);
        if (dom.authModal) dom.authModal.classList.add('hidden');
        showToast(`Hoş geldin! Telefonla giriş yapıldı 📱✨`);
      }, 350);
    } catch (err) {
      if (dom.authSubmitBtn) {
        dom.authSubmitBtn.disabled = false;
        dom.authSubmitBtn.textContent = "Doğrula & Giriş Yap";
      }
      showAuthAlert("Bağlantı hatası: " + err.message);
    }
  }

  // 6-digit box auto-advance, backspace and paste listeners
  const phoneDigitBoxes = Array.from(document.querySelectorAll('.phone-digit-box'));
  phoneDigitBoxes.forEach((box, idx) => {
    box.addEventListener('input', (e) => {
      const val = e.target.value.replace(/[^0-9]/g, '');
      box.value = val ? val.slice(-1) : '';
      if (val && idx < phoneDigitBoxes.length - 1) {
        phoneDigitBoxes[idx + 1].focus();
      }
      const fullCode = phoneDigitBoxes.map(b => b.value.trim()).join('');
      if (fullCode.length === 6) {
        handleVerifyPhoneOtp();
      }
    });

    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && idx > 0) {
        phoneDigitBoxes[idx - 1].focus();
      } else if (e.key === 'Enter') {
        handleVerifyPhoneOtp();
      }
    });

    box.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasteData = (e.clipboardData || window.clipboardData).getData('text');
      const cleanDigits = pasteData.replace(/[^0-9]/g, '').slice(0, 6);
      if (cleanDigits) {
        cleanDigits.split('').forEach((d, i) => {
          if (phoneDigitBoxes[i]) phoneDigitBoxes[i].value = d;
        });
        const nextIdx = Math.min(cleanDigits.length, phoneDigitBoxes.length - 1);
        phoneDigitBoxes[nextIdx].focus();
        if (cleanDigits.length === 6) {
          handleVerifyPhoneOtp();
        }
      }
    });
  });

  if (dom.authMethodEmailBtn) {
    dom.authMethodEmailBtn.addEventListener('click', () => setAuthMethod('email'));
  }
  if (dom.authMethodPhoneBtn) {
    dom.authMethodPhoneBtn.addEventListener('click', () => setAuthMethod('phone'));
  }

  if (dom.phoneOtpBackBtn) {
    dom.phoneOtpBackBtn.addEventListener('click', () => {
      if (dom.authPhoneOtpField) dom.authPhoneOtpField.classList.add('hidden');
      if (dom.authSubmitBtn) dom.authSubmitBtn.textContent = "Doğrulama Kodu Gönder";
      if (phoneOtpState.timer) clearInterval(phoneOtpState.timer);
      hideAuthAlert();
      if (dom.authPhoneInput) dom.authPhoneInput.focus();
    });
  }

  if (dom.phoneOtpResendBtn) {
    dom.phoneOtpResendBtn.addEventListener('click', () => {
      if (phoneOtpState.secondsLeft <= 0) {
        handleSendPhoneOtp();
      }
    });
  }

  // Submit Sign In / Sign Up with Real Backend & Supabase-compatible Persistent Verification
  if (dom.authSubmitBtn) {
    dom.authSubmitBtn.addEventListener('click', async () => {
      hideAuthAlert();

      if (currentAuthMethod === 'phone') {
        const isOtpVisible = dom.authPhoneOtpField && !dom.authPhoneOtpField.classList.contains('hidden');
        if (isOtpVisible) {
          handleVerifyPhoneOtp();
        } else {
          handleSendPhoneOtp();
        }
        return;
      }
      const contactVal = (dom.authContactInput && dom.authContactInput.value.trim()) || '';
      const passwordVal = (dom.authPasswordInput && dom.authPasswordInput.value.trim()) || '';
      const nameVal = (dom.authNameInput && dom.authNameInput.value.trim()) || '';

      if (isSignUpMode) {
        // Sign Up Validation: İsim Soyisim, E-posta, Şifre, Şifre Tekrar
        if (!nameVal || nameVal.length < 2) {
          showAuthAlert("Lütfen adınızı ve soyadınızı girin.");
          if (dom.authNameInput) dom.authNameInput.focus();
          return;
        }
        if (!contactVal || !contactVal.includes('@')) {
          showAuthAlert("Lütfen geçerli bir e-posta adresi girin (Örn: adiniz@gmail.com).");
          if (dom.authContactInput) dom.authContactInput.focus();
          return;
        }
        if (!passwordVal || passwordVal.length < 6) {
          showAuthAlert("Şifre en az 6 karakter olmalıdır.");
          if (dom.authPasswordInput) dom.authPasswordInput.focus();
          return;
        }
        const passwordConfirmVal = (dom.authPasswordConfirmInput && dom.authPasswordConfirmInput.value.trim()) || '';
        if (passwordVal !== passwordConfirmVal) {
          showAuthAlert("Girdiğiniz şifreler birbiriyle eşleşmiyor! Lütfen şifre tekrarını kontrol edin.");
          if (dom.authPasswordConfirmInput) dom.authPasswordConfirmInput.focus();
          return;
        }

        const prevBtnText = dom.authSubmitBtn.innerText;
        dom.authSubmitBtn.innerText = "Kaydediliyor...";
        dom.authSubmitBtn.disabled = true;

        const cleanUsername = nameVal.trim().replace(/^@/, '');

        // 1. Supabase Auth Integration: Real Sign Up to Supabase
        if (supabaseClient) {
          try {
            const { data: supaData, error: supaErr } = await supabaseClient.auth.signUp({
              email: contactVal,
              password: passwordVal,
              options: {
                data: {
                  full_name: cleanUsername,
                  username: cleanUsername,
                  avatar_bg: selectedSignUpAvatarBg,
                  avatar_url: selectedSignUpAvatarData || ''
                }
              }
            });
            if (supaErr) {
              console.warn('[Supabase Sign Up Error]:', supaErr);
              if (supaErr.message.includes('already registered')) {
                dom.authSubmitBtn.innerText = prevBtnText;
                dom.authSubmitBtn.disabled = false;
                showAuthAlert("Bu e-posta adresi Supabase'de zaten kayıtlı! Lütfen giriş yapın.");
                return;
              }
            }
          } catch (supaEx) {
            console.warn('[Supabase Kayıt İstisnası]:', supaEx);
          }
        }

        // 2. Server Auth: Unique Username & Email check
        try {
          const resp = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              fullName: cleanUsername, 
              username: cleanUsername, 
              email: contactVal, 
              password: passwordVal, 
              avatarUrl: selectedSignUpAvatarData 
            })
          });
          const data = await resp.json();
          dom.authSubmitBtn.innerText = prevBtnText;
          dom.authSubmitBtn.disabled = false;

          if (!resp.ok || !data.success) {
            showAuthAlert(data.message || "Kayıt işlemi başarısız oldu.");
            return;
          }

          showAuthAlert("✓ Hesabınız başarıyla oluşturuldu! Hoş geldiniz.", true);
          const user = {
            id: data.user.id,
            name: data.user.fullName || data.user.username || cleanUsername,
            fullName: data.user.fullName || data.user.username || cleanUsername,
            username: cleanUsername,
            email: data.user.email || contactVal,
            avatarUrl: selectedSignUpAvatarData || data.user.avatarUrl || '',
            avatarBg: selectedSignUpAvatarBg,
            avatarChar: cleanUsername.charAt(0).toUpperCase()
          };
          localStorage.setItem('miruo_user', JSON.stringify(user));
          state.userId = user.id;
          state.username = user.name;
          state.avatarUrl = user.avatarUrl;
          syncUserProfileToSupabase(user);
          setTimeout(() => {
            updateUserUI(user);
            if (dom.authModal) dom.authModal.classList.add('hidden');
            showToast(`Hoş geldin @${cleanUsername}! Kayıt başarılı ✨`);
          }, 350);
        } catch (err) {
          dom.authSubmitBtn.innerText = prevBtnText;
          dom.authSubmitBtn.disabled = false;
          showAuthAlert("Sunucu bağlantısı sağlanamadı: " + err.message);
        }

      } else {
        // Sign In Validation: E-posta & Şifre
        if (!contactVal) {
          showAuthAlert("Lütfen e-posta adresinizi girin.");
          if (dom.authContactInput) dom.authContactInput.focus();
          return;
        }
        if (!passwordVal) {
          showAuthAlert("Lütfen şifrenizi girin.");
          if (dom.authPasswordInput) dom.authPasswordInput.focus();
          return;
        }

        const prevBtnText = dom.authSubmitBtn.innerText;
        dom.authSubmitBtn.innerText = "Giriş yapılıyor...";
        dom.authSubmitBtn.disabled = true;

        // Supabase Auth Sign In check
        if (supabaseClient && contactVal.includes('@')) {
          try {
            await supabaseClient.auth.signInWithPassword({
              email: contactVal,
              password: passwordVal
            });
          } catch (e) {}
        }

        try {
          const resp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: contactVal, emailOrUsername: contactVal, password: passwordVal })
          });
          const data = await resp.json();
          dom.authSubmitBtn.innerText = prevBtnText;
          dom.authSubmitBtn.disabled = false;

          if (!resp.ok || !data.success) {
            showAuthAlert(data.message || "Hatalı e-posta veya şifre.");
            return;
          }

          showAuthAlert("✓ Giriş başarılı! Hoş geldin.", true);
          const user = {
            id: data.user.id,
            name: data.user.fullName || data.user.username || contactVal.split('@')[0],
            fullName: data.user.fullName || data.user.username || contactVal.split('@')[0],
            username: (data.user.username || data.user.fullName || contactVal.split('@')[0]).replace(/^@/, ''),
            email: data.user.email || contactVal,
            avatarUrl: data.user.avatarUrl || '',
            avatarChar: (data.user.fullName || data.user.username || 'M').charAt(0).toUpperCase()
          };
          localStorage.setItem('miruo_user', JSON.stringify(user));
          state.userId = user.id;
          state.username = user.name;
          state.avatarUrl = user.avatarUrl;
          syncUserProfileToSupabase(user);
          setTimeout(() => {
            updateUserUI(user);
            if (dom.authModal) dom.authModal.classList.add('hidden');
            showToast(`Giriş yapıldı, hoş geldin ${user.name}! ✨`);
          }, 350);
        } catch (err) {
          dom.authSubmitBtn.innerText = prevBtnText;
          dom.authSubmitBtn.disabled = false;
          // Fallback
          const displayName = contactVal.includes('@') ? contactVal.split('@')[0] : contactVal;
          const user = {
            id: 'user_' + Math.random().toString(36).substring(2, 8),
            name: displayName,
            fullName: displayName,
            email: contactVal.includes('@') ? contactVal : `${displayName}@miruo.app`,
            defaultRoom: 'ODA-' + Math.floor(1000 + Math.random() * 9000),
            avatarChar: displayName.charAt(0).toUpperCase()
          };
          localStorage.setItem('miruo_user', JSON.stringify(user));
          state.userId = user.id;
          state.username = user.name;
          syncUserProfileToSupabase(user);
          updateUserUI(user);
          if (dom.authModal) dom.authModal.classList.add('hidden');
        }
      }
    });
  }

  // Room Top Bar Search / Change Video Click
  if (dom.roomTopSearchBtn) {
    dom.roomTopSearchBtn.addEventListener('click', () => {
      handleYouTubeLaunch();
    });
  }

  if (dom.authContactInput) {
    dom.authContactInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && dom.authSubmitBtn) dom.authSubmitBtn.click();
    });
  }
  if (dom.authPasswordInput) {
    dom.authPasswordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && dom.authSubmitBtn) dom.authSubmitBtn.click();
    });
  }
  if (dom.authNameInput) {
    dom.authNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && dom.authSubmitBtn) dom.authSubmitBtn.click();
    });
  }

  if (dom.openAuthModalBtn) {
    dom.openAuthModalBtn.addEventListener('click', () => {
      if (dom.userProfileDropdown) dom.userProfileDropdown.classList.add('hidden');
      if (dom.authModal) dom.authModal.classList.remove('hidden');
    });
  }

  if (dom.closeAuthModalBtn) {
    addInstantTap(dom.closeAuthModalBtn, () => {
      if (dom.authModal) dom.authModal.classList.add('hidden');
      if (!localStorage.getItem('miruo_user')) {
        const guestUser = {
          id: state.userId || ('user_' + Math.random().toString(36).substring(2, 8)),
          name: state.username || 'Misafir',
          username: (state.username || 'misafir').toLowerCase(),
          avatarChar: (state.username || 'M').charAt(0).toUpperCase()
        };
        localStorage.setItem('miruo_user', JSON.stringify(guestUser));
      }
    });
  }

  // ==========================================
  // RAVE YOUTUBE BROWSER & PICKER ("Aynı Rave Mantığı")
  // ==========================================
  let currentRaveYtTag = 'trending';
  let raveYtDebounceTimer = null;

  const PLATFORM_CONFIGS = {
    youtube: { title: 'YouTube', url: 'https://m.youtube.com/feed/trending' },
    netflix: { title: 'Netflix', url: 'https://www.netflix.com' },
    prime: { title: 'Prime Video', url: 'https://www.primevideo.com' },
    disney: { title: 'Disney+', url: 'https://www.disneyplus.com' },
    twitch: { title: 'Twitch', url: 'https://m.twitch.tv' },
    live: { title: 'Canlı Yayın', url: 'https://m.youtube.com/live' },
    playlist: { title: 'Playlist', url: 'https://music.youtube.com' },
    drive: { title: 'Google Drive', url: 'https://drive.google.com' },
    photos: { title: 'Google Photos', url: 'https://photos.google.com' },
    web: { title: 'Web Tarayıcı', url: 'https://www.google.com' },
    dj: { title: 'Miruo Müzik', url: 'https://m.youtube.com/results?search_query=remix+party+live+music' },
    karaoke: { title: 'Karaoke', url: 'https://m.youtube.com/results?search_query=karaoke+turkce' },
    likes: { title: 'Beğenilenler', url: 'https://m.youtube.com/feed/library' },
    history: { title: 'Geçmiş', url: 'https://m.youtube.com/feed/history' }
  };

  function launchPlatform(providerKey) {
    const config = PLATFORM_CONFIGS[providerKey] || { title: providerKey.toUpperCase(), url: 'https://www.google.com' };
    
    // In iOS App: presents full-featured native in-app browser with top search bar!
    if (window.webkit && window.webkit.messageHandlers && (window.webkit.messageHandlers.openPlatform || window.webkit.messageHandlers.openYouTube)) {
      if (window.webkit.messageHandlers.openPlatform) {
        window.webkit.messageHandlers.openPlatform.postMessage({
          provider: providerKey,
          url: config.url,
          title: config.title
        });
        return;
      } else if (window.webkit.messageHandlers.openYouTube && providerKey === 'youtube') {
        window.webkit.messageHandlers.openYouTube.postMessage({});
        return;
      }
    }
    
    // Fallback for YouTube in Web:
    if (providerKey === 'youtube' || providerKey === 'dj' || providerKey === 'karaoke' || providerKey === 'live') {
      openRaveYoutubeModal();
      return;
    }

    // For other platforms on web: open and join room
    const title = `${config.title} Odası`;
    createAndJoinRoom(title, false, config.title);
    showToast(`${config.title} odası açıldı! 🎬`);
  }

  // YouTube Direct Interface Launch
  function handleYouTubeLaunch() {
    launchPlatform('youtube');
  }

  function openRealYouTubeInterface() {
    launchPlatform('youtube');
  }

  function openRaveYoutubeModal() {
    if (!dom.raveYoutubeModal) return;
    dom.raveYoutubeModal.classList.remove('hidden');

    // Show continuous playback status banner
    const playingTitle = dom.nowPlayingTitle ? dom.nowPlayingTitle.textContent : '';
    if (state.roomId && dom.raveCurrentlyPlayingBanner && playingTitle && playingTitle !== 'Henüz video seçilmedi') {
      dom.raveCurrentlyPlayingBanner.classList.remove('hidden');
      if (dom.raveCurrentlyPlayingTitle) dom.raveCurrentlyPlayingTitle.textContent = playingTitle;
    } else if (dom.raveCurrentlyPlayingBanner) {
      dom.raveCurrentlyPlayingBanner.classList.add('hidden');
    }

    // Broadcast browsing status so room participants see "host yeni video seçiyor..."
    if (state.roomId) {
      sendP2PData('host_browsing', { isBrowsing: true, user: state.username });
      sendSignal({ type: 'host-browsing', isBrowsing: true, user: state.username });
    }

    loadRaveYoutubeFeed('', currentRaveYtTag);
    if (dom.raveYtSearchInput) setTimeout(() => dom.raveYtSearchInput.focus(), 150);
  }

  function closeRaveYoutubeModal() {
    if (dom.raveYoutubeModal) dom.raveYoutubeModal.classList.add('hidden');
    if (dom.raveVideoActionSheet) dom.raveVideoActionSheet.classList.add('hidden');
    if (state.roomId) {
      sendP2PData('host_browsing', { isBrowsing: false });
      sendSignal({ type: 'host-browsing', isBrowsing: false });
    }
  }

  async function loadRaveYoutubeFeed(query = '', tag = 'trending') {
    if (!dom.raveYtVideoGrid) return;
    currentRaveYtTag = tag;

    dom.raveYtVideoGrid.innerHTML = `
      <div class="col-span-full py-12 flex flex-col items-center justify-center text-center text-xs text-gray-400">
        <div class="w-6 h-6 border-2 border-red-500 border-t-transparent rounded-full animate-spin mb-2"></div>
        <span>YouTube içerikleri getiriliyor...</span>
      </div>
    `;

    const FALLBACK_CATALOG = [
      {
        id: 'jfKfPfyJRdk',
        title: 'Lofi Girl - beats to relax/study to',
        channel: 'Lofi Girl',
        duration: 'CANLI',
        category: 'lofi',
        views: '48K canlı izleyici',
        thumb: 'https://img.youtube.com/vi/jfKfPfyJRdk/hqdefault.jpg'
      },
      {
        id: 'b9EkMc79ZSU',
        title: 'Stranger Things 4 | Official Trailer',
        channel: 'Netflix',
        duration: '3:11',
        category: 'series',
        views: '32M görüntüleme',
        thumb: 'https://img.youtube.com/vi/b9EkMc79ZSU/hqdefault.jpg'
      },
      {
        id: 'ezkd3wzB6s8',
        title: 'The Boys Season 4 | Official Trailer',
        channel: 'Prime Video',
        duration: '2:38',
        category: 'series',
        views: '18M görüntüleme',
        thumb: 'https://img.youtube.com/vi/ezkd3wzB6s8/hqdefault.jpg'
      },
      {
        id: 'QdBZY2fkU-0',
        title: 'Grand Theft Auto VI Trailer 1',
        channel: 'Rockstar Games',
        duration: '1:31',
        category: 'gaming',
        views: '190M görüntüleme',
        thumb: 'https://img.youtube.com/vi/QdBZY2fkU-0/hqdefault.jpg'
      },
      {
        id: '4NRXx6U8ABQ',
        title: 'The Weeknd - Blinding Lights (Official Music Video)',
        channel: 'The Weeknd',
        duration: '4:20',
        category: 'music',
        views: '800M görüntüleme',
        thumb: 'https://img.youtube.com/vi/4NRXx6U8ABQ/hqdefault.jpg'
      },
      {
        id: 'TUVcZfQe-Kw',
        title: 'Dua Lipa - Levitating (Official Music Video)',
        channel: 'Dua Lipa',
        duration: '3:50',
        category: 'music',
        views: '750M görüntüleme',
        thumb: 'https://img.youtube.com/vi/TUVcZfQe-Kw/hqdefault.jpg'
      },
      {
        id: 'H5v3kku4y6Q',
        title: 'Harry Styles - As It Was (Official Video)',
        channel: 'Harry Styles',
        duration: '2:45',
        category: 'music',
        views: '620M görüntüleme',
        thumb: 'https://img.youtube.com/vi/H5v3kku4y6Q/hqdefault.jpg'
      },
      {
        id: 'kJQP7kiw5Fk',
        title: 'Luis Fonsi - Despacito ft. Daddy Yankee',
        channel: 'Luis Fonsi',
        duration: '4:42',
        category: 'music',
        views: '8.4B görüntüleme',
        thumb: 'https://img.youtube.com/vi/kJQP7kiw5Fk/hqdefault.jpg'
      },
      {
        id: 'kXYiU_JCYtU',
        title: 'Linkin Park - Numb (Official Music Video)',
        channel: 'Linkin Park',
        duration: '3:07',
        category: 'music',
        views: '2.2B görüntüleme',
        thumb: 'https://img.youtube.com/vi/kXYiU_JCYtU/hqdefault.jpg'
      },
      {
        id: 'OPf0YbXqDm0',
        title: 'Mark Ronson - Uptown Funk ft. Bruno Mars',
        channel: 'Mark Ronson',
        duration: '4:30',
        category: 'music',
        views: '5.1B görüntüleme',
        thumb: 'https://img.youtube.com/vi/OPf0YbXqDm0/hqdefault.jpg'
      }
    ];

    let items = [];
    try {
      const res = await fetch(`/api/search-media?q=${encodeURIComponent(query)}&cat=${encodeURIComponent(tag)}`);
      if (res.ok) {
        const data = await res.json();
        items = (data && data.results) || [];
      } else {
        throw new Error('Fallback to local catalog');
      }
    } catch (e) {
      const q = (query || '').toLowerCase().trim();
      const t = (tag || 'all').toLowerCase();
      items = FALLBACK_CATALOG.filter(v => {
        const matchesQuery = !q || v.title.toLowerCase().includes(q) || v.channel.toLowerCase().includes(q);
        const matchesTag = t === 'all' || v.category === t;
        return matchesQuery && matchesTag;
      });
      if (items.length === 0 && !q) items = FALLBACK_CATALOG;
    }

    if (items.length === 0) {
      dom.raveYtVideoGrid.innerHTML = `
        <div class="col-span-full py-10 text-center text-xs text-gray-400">
          <p>Aradığınız video bulunamadı 🔍</p>
          <span class="text-[10px] text-gray-500 mt-1 block">Farklı bir arama yapın veya m.youtube.com'da gezinin.</span>
        </div>
      `;
      return;
    }

    dom.raveYtVideoGrid.innerHTML = items.map(video => `
      <div class="rave-yt-card bg-[#0C0E17] hover:bg-[#141824] border border-white/10 hover:border-red-500/50 rounded-2xl p-2.5 flex flex-col gap-2 cursor-pointer text-left transition-all group shadow-lg hover:shadow-red-600/15 hover:-translate-y-0.5 active:scale-95" data-id="${escapeHtml(video.id)}" data-title="${escapeHtml(video.title)}">
        <div class="relative w-full aspect-video rounded-xl overflow-hidden bg-black/80">
          <img src="${escapeHtml(video.thumb)}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" alt="Thumbnail" loading="lazy">
          <span class="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-black/80 text-white font-mono backdrop-blur-sm">${escapeHtml(video.duration)}</span>
          <div class="absolute inset-0 bg-red-600/25 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-[1px]">
            <div class="w-10 h-10 rounded-full bg-red-600 text-white flex items-center justify-center shadow-xl shadow-red-600/40 text-sm font-bold pl-0.5">▶</div>
          </div>
        </div>
        <div class="flex flex-col flex-1 justify-between px-0.5">
          <div>
            <h4 class="text-xs font-bold text-white group-hover:text-red-400 transition-colors line-clamp-2 leading-tight">${escapeHtml(video.title)}</h4>
            <p class="text-[11px] text-gray-400 mt-1 truncate">${escapeHtml(video.channel)}</p>
          </div>
          <div class="flex items-center justify-between text-[10px] text-gray-500 mt-2 pt-1 border-t border-white/5">
            <span>${escapeHtml(video.views || '')}</span>
            <span class="text-red-400 font-semibold flex items-center gap-1">
              <span>İzle</span>
              <span>→</span>
            </span>
          </div>
        </div>
      </div>
    `).join('');

    // Click video cards
    dom.raveYtVideoGrid.querySelectorAll('.rave-yt-card').forEach(card => {
      card.addEventListener('click', () => {
        const videoId = card.dataset.id;
        const videoTitle = card.dataset.title;
        const thumb = card.querySelector('img')?.src || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        const channel = card.querySelector('p')?.textContent || 'YouTube';
        handleRaveVideoSelected({ id: videoId, title: videoTitle, thumb, channel });
      });
    });
  }

  let selectedPendingVideo = null;
  function handleRaveVideoSelected(video) {
    if (!video || !video.id) return;
    selectAndPlayYoutubeVideo(video.id, video.title);
  }

  function handleRemoteBrowsingNotice(isBrowsing, user) {
    if (!dom.hostBrowsingNotice) return;
    if (isBrowsing) {
      dom.hostBrowsingNotice.classList.remove('hidden');
      if (dom.hostBrowsingNoticeText) {
        dom.hostBrowsingNoticeText.textContent = `🎬 ${user || 'Oda sahibi'} yeni video arıyor... (Mevcut video çalıyor)`;
      }
    } else {
      dom.hostBrowsingNotice.classList.add('hidden');
    }
  }

  let pendingSuggestion = null;
  function handleIncomingVideoSuggestion(data) {
    const canControl = state.isHost || state.userRole === 'owner' || state.userRole === 'admin' || state.userRole === 'dj' || state.controlMode === 'everyone' || state.hasDjPermission;
    if (!canControl) return;

    pendingSuggestion = data;
    if (dom.hostSuggestionBanner) {
      if (dom.suggestionThumb) dom.suggestionThumb.src = data.thumb || `https://img.youtube.com/vi/${data.videoId}/hqdefault.jpg`;
      if (dom.suggestionTitle) dom.suggestionTitle.textContent = data.title || 'Video Önerisi';
      if (dom.suggestionSender) dom.suggestionSender.textContent = `${data.fromUser || 'Bir katılımcı'} önerdi`;
      dom.hostSuggestionBanner.classList.remove('hidden');
    }
  }

  function handleRemoteQueueUpdate(queue) {
    state.roomQueue = queue || [];
    updateRoomQueueUI();
  }

  function handleRemoteVideoChanged(user, title, videoId) {
    if (title) {
      showToast(`🎬 ${user || 'Partner'} yeni bir video başlattı: ${title}`);
      renderChatMessage('SİSTEM', `🎬 ${user || 'Partner'} yeni video başlattı: ${title}`, false);
    }
  }

  function addToRoomQueue(item) {
    if (!state.roomQueue) state.roomQueue = [];
    state.roomQueue.push(item);
    updateRoomQueueUI();
    sendP2PData('queue_update', { queue: state.roomQueue });
    sendSignal({ type: 'queue-update', queue: state.roomQueue });
  }

  function updateRoomQueueUI() {
    const count = state.roomQueue ? state.roomQueue.length : 0;
    if (dom.roomQueueCount) dom.roomQueueCount.textContent = count;

    if (dom.roomQueueList) {
      if (!state.roomQueue || state.roomQueue.length === 0) {
        dom.roomQueueList.innerHTML = `<div class="py-8 text-center text-xs text-gray-400">Sırada bekleyen video yok 🎵</div>`;
      } else {
        const canManage = state.isHost || state.userRole === 'owner' || state.userRole === 'admin' || state.userRole === 'dj' || state.controlMode === 'everyone' || state.hasDjPermission;
        dom.roomQueueList.innerHTML = state.roomQueue.map((item, idx) => `
          <div class="flex items-center justify-between p-2.5 rounded-2xl bg-white/5 border border-white/10 gap-3 group">
            <span class="text-xs font-mono font-bold text-purple-400 w-4">${idx + 1}</span>
            <img src="${escapeHtml(item.thumb)}" class="w-14 h-9 rounded-lg object-cover bg-black flex-shrink-0" alt="Thumb">
            <div class="flex-1 min-w-0">
              <h5 class="text-xs font-bold text-white truncate">${escapeHtml(item.title)}</h5>
              <span class="text-[10px] text-gray-400">${escapeHtml(item.addedBy)} ekledi</span>
            </div>
            ${canManage ? `
              <div class="flex items-center gap-1.5 shrink-0">
                <button class="queue-play-now-btn px-2 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-bold transition-all cursor-pointer" data-idx="${idx}" title="Şimdi Oynat">▶</button>
                <button class="queue-remove-btn px-2 py-1 bg-white/10 hover:bg-white/20 text-gray-300 rounded-lg text-xs transition-all cursor-pointer" data-idx="${idx}" title="Kaldır">✕</button>
              </div>
            ` : ''}
          </div>
        `).join('');

        dom.roomQueueList.querySelectorAll('.queue-play-now-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx, 10);
            if (state.roomQueue && state.roomQueue[idx]) {
              const item = state.roomQueue.splice(idx, 1)[0];
              updateRoomQueueUI();
              sendP2PData('queue_update', { queue: state.roomQueue });
              sendSignal({ type: 'queue-update', queue: state.roomQueue });
              selectAndPlayYoutubeVideo(item.id, item.title);
              if (dom.roomQueueModal) dom.roomQueueModal.classList.add('hidden');
            }
          });
        });

        dom.roomQueueList.querySelectorAll('.queue-remove-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx, 10);
            if (state.roomQueue) {
              state.roomQueue.splice(idx, 1);
              updateRoomQueueUI();
              sendP2PData('queue_update', { queue: state.roomQueue });
              sendSignal({ type: 'queue-update', queue: state.roomQueue });
              showToast('Video sıradan kaldırıldı');
            }
          });
        });
      }
    }
  }

  function handleNextTrack() {
    if (state.roomQueue && state.roomQueue.length > 0) {
      const nextItem = state.roomQueue.shift();
      updateRoomQueueUI();
      sendP2PData('queue_update', { queue: state.roomQueue });
      sendSignal({ type: 'queue-update', queue: state.roomQueue });
      selectAndPlayYoutubeVideo(nextItem.id, nextItem.title);
      const ann = `🎬 Sıradaki video başlatıldı: "${nextItem.title}"`;
      showToast(ann);
      renderChatMessage('SİSTEM', ann, true);
      sendP2PData('chat', { sender: 'SİSTEM', text: ann, time: getNowTimeString() });
    } else {
      showToast('Sırada video yok. Yeni video seçin 🎬');
      openVideoChooser();
    }
  }

  function selectAndPlayYoutubeVideo(videoIdOrUrl, title, provider = 'YouTube') {
    if (!videoIdOrUrl) return;
    closeRaveYoutubeModal();

    const cleanYtId = extractYtId(videoIdOrUrl);
    if (cleanYtId) {
      if (state.roomId && dom.roomWorkspaceSection && !dom.roomWorkspaceSection.classList.contains('hidden')) {
        loadYoutubeVideo(cleanYtId);
        showToast(`🎬 "${title}" odada başlatıldı!`);
        const ann = `🎬 ${state.username} yeni video başlattı: ${title}`;
        sendP2PData('video_changed', { user: state.username, title, videoId: cleanYtId });
        sendSignal({ type: 'video-changed', user: state.username, title, videoId: cleanYtId });
        renderChatMessage('SİSTEM', ann, true);
        sendP2PData('chat', { sender: 'SİSTEM', text: ann, time: getNowTimeString() });
      } else {
        const roomTitle = title ? `${title.substring(0, 24)} Partisi` : 'YouTube Partisi';
        createAndJoinRoom(roomTitle, false, 'YouTube', cleanYtId);
        showToast(`🎬 "${title}" ile oda başlatıldı!`);
      }
    } else {
      const platformName = provider || 'Web';
      const playNonYtContent = () => {
        if (platformName.toLowerCase().includes('twitch') || videoIdOrUrl.includes('twitch.tv')) {
          loadTwitchStream(videoIdOrUrl, title);
        } else if (/\.(mp4|webm|m3u8|mov)(\?.*)?$/i.test(videoIdOrUrl)) {
          loadDirectVideo(videoIdOrUrl, title);
        } else {
          loadWebStream(videoIdOrUrl, title, platformName);
        }
      };

      if (state.roomId && dom.roomWorkspaceSection && !dom.roomWorkspaceSection.classList.contains('hidden')) {
        playNonYtContent();
      } else {
        const roomTitle = title ? `${title.substring(0, 24)} Partisi` : `${platformName} Partisi`;
        createAndJoinRoom(roomTitle, false, platformName);
        setTimeout(playNonYtContent, 500);
      }
    }
  }

  function extractYtId(urlOrId) {
    if (!urlOrId) return null;
    if (urlOrId.length === 11 && !urlOrId.includes('/') && !urlOrId.includes('.')) return urlOrId;
    const match = urlOrId.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/);
    return match ? match[1] : null;
  }

  // Global Bridge for Native iOS WebView
  window.MiruoBridge = {
    loadVideo: function(videoIdOrUrl, title, provider) {
      if (videoIdOrUrl) {
        selectAndPlayYoutubeVideo(videoIdOrUrl, title || 'Video İçeriği', provider || 'YouTube');
      }
    }
  };

  if (dom.closeRaveYoutubeBtn) {
    addInstantTap(dom.closeRaveYoutubeBtn, closeRaveYoutubeModal);
  }

  if (dom.openNativeYtBrowserBtn) {
    dom.openNativeYtBrowserBtn.addEventListener('click', () => {
      // In iOS App: call native script message handler
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.openYouTube) {
        window.webkit.messageHandlers.openYouTube.postMessage({});
      } else {
        window.open('https://m.youtube.com', '_blank');
      }
    });
  }

  if (dom.openPlatformAccountsFromRaveBtn) {
    dom.openPlatformAccountsFromRaveBtn.addEventListener('click', () => {
      closeRaveYoutubeModal();
      if (dom.platformAccountsModal) dom.platformAccountsModal.classList.remove('hidden');
    });
  }

  if (dom.openRaveYtFromRoomBtn) {
    dom.openRaveYtFromRoomBtn.addEventListener('click', () => {
      handleYouTubeLaunch();
    });
  }

  // Category Tabs inside Rave Modal
  document.querySelectorAll('.rave-yt-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.rave-yt-tab').forEach(t => {
        t.className = 'rave-yt-tab px-3 py-1 rounded-xl bg-white/5 hover:bg-white/10 text-gray-300 whitespace-nowrap transition-all cursor-pointer';
      });
      tab.className = 'rave-yt-tab active px-3 py-1 rounded-xl bg-red-600 text-white font-bold whitespace-nowrap transition-all cursor-pointer';
      const tag = tab.dataset.tag || 'trending';
      const q = (dom.raveYtSearchInput && dom.raveYtSearchInput.value.trim()) || '';
      loadRaveYoutubeFeed(q, tag);
    });
  });

  // Search input in Rave Modal
  if (dom.raveYtSearchInput) {
    dom.raveYtSearchInput.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      if (dom.clearRaveYtSearchBtn) {
        dom.clearRaveYtSearchBtn.classList.toggle('hidden', val.length === 0);
      }
      clearTimeout(raveYtDebounceTimer);
      raveYtDebounceTimer = setTimeout(() => {
        loadRaveYoutubeFeed(val, currentRaveYtTag);
      }, 350);
    });

    dom.raveYtSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = dom.raveYtSearchInput.value.trim();
        loadRaveYoutubeFeed(val, currentRaveYtTag);
      }
    });
  }

  if (dom.submitRaveYtSearchBtn) {
    dom.submitRaveYtSearchBtn.addEventListener('click', () => {
      const val = (dom.raveYtSearchInput && dom.raveYtSearchInput.value.trim()) || '';
      loadRaveYoutubeFeed(val, currentRaveYtTag);
    });
  }

  if (dom.clearRaveYtSearchBtn) {
    dom.clearRaveYtSearchBtn.addEventListener('click', () => {
      if (dom.raveYtSearchInput) dom.raveYtSearchInput.value = '';
      dom.clearRaveYtSearchBtn.classList.add('hidden');
      loadRaveYoutubeFeed('', currentRaveYtTag);
    });
  }

  // Media Picker Search & Filtering
  if (dom.mediaSearchInput) {
    dom.mediaSearchInput.addEventListener('input', (e) => {
      clearTimeout(mediaSearchDebounceTimer);
      mediaSearchDebounceTimer = setTimeout(() => {
        searchAndRenderMedia(e.target.value.trim(), currentMediaCategory);
      }, 300);
    });
    dom.mediaSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        searchAndRenderMedia(e.target.value.trim(), currentMediaCategory);
      }
    });
  }

  if (dom.searchMediaBtn) {
    dom.searchMediaBtn.addEventListener('click', () => {
      const q = (dom.mediaSearchInput && dom.mediaSearchInput.value.trim()) || '';
      searchAndRenderMedia(q, currentMediaCategory);
    });
  }

  // Category Pills
  document.querySelectorAll('.media-cat-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.media-cat-pill').forEach(p => {
        p.className = 'media-cat-pill px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 whitespace-nowrap transition-all cursor-pointer';
      });
      pill.className = 'media-cat-pill active px-2.5 py-1 rounded-lg bg-rose-500 text-white font-bold whitespace-nowrap transition-all cursor-pointer';
      const cat = pill.dataset.cat || 'all';
      const q = (dom.mediaSearchInput && dom.mediaSearchInput.value.trim()) || '';
      searchAndRenderMedia(q, cat);
    });
  });

  // Toggle Custom Link Collapsible Bar
  if (dom.toggleCustomLinkBtn && dom.customLinkContainer) {
    dom.toggleCustomLinkBtn.addEventListener('click', () => {
      dom.customLinkContainer.classList.toggle('hidden');
      if (!dom.customLinkContainer.classList.contains('hidden') && dom.youtubeUrlInput) {
        dom.youtubeUrlInput.focus();
      }
    });
  }

  // Unified Profile, Settings & Accounts Hub
  let pendingAvatarUrl = '';
  let pendingAvatarBg = '';

  function switchProfileTab(tabName) {
    const tabs = {
      profile: { btn: dom.profileTabBtnProfile, pane: dom.profilePaneProfile },
      settings: { btn: dom.profileTabBtnSettings, pane: dom.profilePaneSettings },
      accounts: { btn: dom.profileTabBtnAccounts, pane: dom.profilePaneAccounts }
    };

    Object.keys(tabs).forEach(k => {
      const t = tabs[k];
      if (t.btn) {
        if (k === tabName) {
          t.btn.className = 'profile-nav-tab active py-1.5 rounded-xl text-center text-white bg-gradient-to-r from-rose-500 to-indigo-600 shadow-sm transition-all cursor-pointer font-bold';
        } else {
          t.btn.className = 'profile-nav-tab py-1.5 rounded-xl text-center text-gray-400 hover:text-white transition-all cursor-pointer font-semibold';
        }
      }
      if (t.pane) {
        if (k === tabName) {
          t.pane.classList.remove('hidden');
        } else {
          t.pane.classList.add('hidden');
        }
      }
    });
  }

  function showChangeEmailAlert(message, isSuccess = false) {
    if (!dom.changeEmailAlert) return;
    dom.changeEmailAlert.textContent = message;
    dom.changeEmailAlert.className = `text-[11px] p-2.5 rounded-xl font-medium ${isSuccess ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'bg-red-500/15 text-red-300 border border-red-500/30'}`;
    dom.changeEmailAlert.classList.remove('hidden');
  }

  function showChangePassAlert(message, isSuccess = false) {
    if (!dom.changePassAlert) return;
    dom.changePassAlert.textContent = message;
    dom.changePassAlert.className = `text-[11px] p-2.5 rounded-xl font-medium ${isSuccess ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'bg-red-500/15 text-red-300 border border-red-500/30'}`;
    dom.changePassAlert.classList.remove('hidden');
  }

  function openProfileEditModal(activeTab = 'profile') {
    if (dom.userProfileDropdown) dom.userProfileDropdown.classList.add('hidden');
    if (dom.editProfileNameInput) dom.editProfileNameInput.value = (state.username || '').replace(/^@/, '');

    const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
    pendingAvatarUrl = savedUser.avatarUrl || '';
    pendingAvatarBg = savedUser.avatarBg || 'from-rose-500 to-indigo-600';

    if (dom.profileEmailDisplay) {
      dom.profileEmailDisplay.textContent = savedUser.email || `${(state.username || 'user').toLowerCase()}@miruo.app`;
    }

    // 1. Detect and render provider badge (Neyle Kayıt Olduğu)
    const authProvider = savedUser.provider || (savedUser.phone ? 'phone' : (savedUser.isApple ? 'apple' : (savedUser.isGoogle ? 'google' : 'email')));
    if (dom.accountProviderIcon && dom.accountProviderName) {
      if (authProvider === 'apple' || savedUser.isApple) {
        dom.accountProviderIcon.innerHTML = '🍎';
        dom.accountProviderName.textContent = 'Apple ID ile Giriş Yapıldı';
        if (dom.profileAuthBadge) {
          dom.profileAuthBadge.textContent = '✓ Apple ile Doğrulandı';
          dom.profileAuthBadge.className = 'px-2.5 py-1 rounded-full text-[10px] font-bold bg-white/10 text-white border border-white/20';
        }
      } else if (authProvider === 'google' || savedUser.isGoogle) {
        dom.accountProviderIcon.innerHTML = '🌐';
        dom.accountProviderName.textContent = 'Google ile Giriş Yapıldı';
        if (dom.profileAuthBadge) {
          dom.profileAuthBadge.textContent = '✓ Google ile Doğrulandı';
          dom.profileAuthBadge.className = 'px-2.5 py-1 rounded-full text-[10px] font-bold bg-blue-500/15 text-blue-400 border border-blue-500/30';
        }
      } else if (authProvider === 'phone' || savedUser.phone) {
        dom.accountProviderIcon.innerHTML = '📱';
        dom.accountProviderName.textContent = 'Telefon Numarası ile Giriş';
        if (dom.profileAuthBadge) {
          dom.profileAuthBadge.textContent = '✓ SMS ile Doğrulandı';
          dom.profileAuthBadge.className = 'px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30';
        }
      } else {
        dom.accountProviderIcon.innerHTML = '✉️';
        dom.accountProviderName.textContent = 'E-posta ile Kayıt Olundu';
        if (dom.profileAuthBadge) {
          dom.profileAuthBadge.textContent = '✓ Aktif Oturum';
          dom.profileAuthBadge.className = 'px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30';
        }
      }
    }

    if (dom.editAvatarPreview) {
      if (pendingAvatarUrl) {
        dom.editAvatarPreview.innerHTML = `<img src="${pendingAvatarUrl}" class="w-full h-full object-cover" alt="PP">`;
        dom.editAvatarPreview.className = 'w-22 h-22 rounded-2xl overflow-hidden shadow-xl border-2 border-white/20 ring-4 ring-white/5 flex items-center justify-center';
      } else {
        dom.editAvatarPreview.innerHTML = (state.username || 'M').charAt(0).toUpperCase();
        dom.editAvatarPreview.className = `w-22 h-22 rounded-2xl bg-gradient-to-tr ${pendingAvatarBg} flex items-center justify-center text-3xl font-bold text-white shadow-xl overflow-hidden border-2 border-white/20 ring-4 ring-white/5`;
      }
    }

    switchProfileTab(activeTab);

    if (dom.profileEditModal) dom.profileEditModal.classList.remove('hidden');
  }

  window.openProfileEditModal = openProfileEditModal;
  window.switchProfileTab = switchProfileTab;

  // Profile Nav Tabs Click Handlers
  if (dom.profileTabBtnProfile) dom.profileTabBtnProfile.addEventListener('click', () => switchProfileTab('profile'));
  if (dom.profileTabBtnSettings) dom.profileTabBtnSettings.addEventListener('click', () => switchProfileTab('settings'));
  if (dom.profileTabBtnAccounts) dom.profileTabBtnAccounts.addEventListener('click', () => switchProfileTab('accounts'));

  // User Profile Button Click -> Directly opens Profile Edit Modal
  if (dom.userProfileBtn) {
    dom.userProfileBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openProfileEditModal('profile');
    });
  }

  // Mobile Bottom Navigation Bar: Ayarlar Button -> Opens Fullscreen Settings & Profile Hub
  if (dom.mobileNavSettingsBtn) {
    addInstantTap(dom.mobileNavSettingsBtn, (e) => {
      e.stopPropagation();
      openProfileEditModal('settings');
    });
  }

  document.addEventListener('click', () => {
    if (dom.userProfileDropdown) dom.userProfileDropdown.classList.add('hidden');
  });

  if (dom.editProfileBtn) {
    dom.editProfileBtn.addEventListener('click', () => openProfileEditModal('profile'));
  }

  if (dom.closeProfileEditBtn) {
    addInstantTap(dom.closeProfileEditBtn, () => {
      if (dom.profileEditModal) dom.profileEditModal.classList.add('hidden');
    });
  }

  // 2. E-posta Değiştirme Handler
  if (dom.changeEmailSubmitBtn) {
    dom.changeEmailSubmitBtn.addEventListener('click', async () => {
      const newEmail = (dom.changeEmailNewInput && dom.changeEmailNewInput.value.trim().toLowerCase()) || '';
      if (!newEmail || !newEmail.includes('@') || !newEmail.includes('.')) {
        showChangeEmailAlert('Lütfen geçerli bir e-posta adresi girin.', false);
        return;
      }
      dom.changeEmailSubmitBtn.disabled = true;
      dom.changeEmailSubmitBtn.textContent = 'Gönderiliyor...';

      try {
        if (supabaseClient && supabaseClient.auth) {
          try {
            await supabaseClient.auth.updateUser({ email: newEmail });
          } catch (supaErr) {
            console.warn('[Supabase Change Email]:', supaErr);
          }
        }

        const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
        const resp = await fetch('/api/auth/change-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: savedUser.id, newEmail })
        });
        const data = await resp.json();
        dom.changeEmailSubmitBtn.disabled = false;
        dom.changeEmailSubmitBtn.textContent = 'Güncelle';

        if (data.success) {
          savedUser.email = newEmail;
          localStorage.setItem('miruo_user', JSON.stringify(savedUser));
          if (dom.profileEmailDisplay) dom.profileEmailDisplay.textContent = newEmail;
          showChangeEmailAlert('✓ Doğrulama bağlantısı yeni e-postanıza gönderildi! Lütfen onaylayın.', true);
          if (dom.changeEmailNewInput) dom.changeEmailNewInput.value = '';
        } else {
          showChangeEmailAlert(data.message || 'E-posta güncellenemedi.', false);
        }
      } catch (err) {
        dom.changeEmailSubmitBtn.disabled = false;
        dom.changeEmailSubmitBtn.textContent = 'Güncelle';
        showChangeEmailAlert('Bağlantı hatası: ' + err.message, false);
      }
    });
  }

  // 3. Şifre Değiştirme Handler
  if (dom.changePasswordSubmitBtn) {
    dom.changePasswordSubmitBtn.addEventListener('click', async () => {
      const currentPass = (dom.changePassCurrentInput && dom.changePassCurrentInput.value) || '';
      const newPass = (dom.changePassNewInput && dom.changePassNewInput.value) || '';
      const confirmPass = (dom.changePassConfirmInput && dom.changePassConfirmInput.value) || '';

      if (!newPass || newPass.length < 6) {
        showChangePassAlert('Yeni şifreniz en az 6 karakter olmalıdır.', false);
        return;
      }
      if (newPass !== confirmPass) {
        showChangePassAlert('Yeni şifreler birbiriyle eşleşmiyor.', false);
        return;
      }

      dom.changePasswordSubmitBtn.disabled = true;
      dom.changePasswordSubmitBtn.textContent = 'Güncelleniyor...';

      try {
        if (supabaseClient && supabaseClient.auth) {
          try {
            await supabaseClient.auth.updateUser({ password: newPass });
          } catch (supaErr) {
            console.warn('[Supabase Change Password]:', supaErr);
          }
        }

        const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
        const resp = await fetch('/api/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: savedUser.id,
            email: savedUser.email,
            currentPassword: currentPass,
            newPassword: newPass
          })
        });
        const data = await resp.json();
        dom.changePasswordSubmitBtn.disabled = false;
        dom.changePasswordSubmitBtn.textContent = 'Şifreyi Güncelle';

        if (data.success) {
          showChangePassAlert('✓ Şifreniz başarıyla güncellendi!', true);
          if (dom.changePassCurrentInput) dom.changePassCurrentInput.value = '';
          if (dom.changePassNewInput) dom.changePassNewInput.value = '';
          if (dom.changePassConfirmInput) dom.changePassConfirmInput.value = '';
        } else {
          showChangePassAlert(data.message || 'Şifre güncellenemedi.', false);
        }
      } catch (err) {
        dom.changePasswordSubmitBtn.disabled = false;
        dom.changePasswordSubmitBtn.textContent = 'Şifreyi Güncelle';
        showChangePassAlert('Bağlantı hatası: ' + err.message, false);
      }
    });
  }

  // 4. Şifremi Unuttum Link (Direct from Settings)
  if (dom.settingsForgotPasswordLink) {
    dom.settingsForgotPasswordLink.addEventListener('click', () => {
      if (dom.profileEditModal) dom.profileEditModal.classList.add('hidden');
      openResetModal();
      const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
      if (savedUser.email && dom.resetEmailInput) {
        dom.resetEmailInput.value = savedUser.email;
      }
    });
  }

  // Avatar file upload trigger & reader
  const triggerAvatarPicker = (e) => {
    if (e) e.preventDefault();
    triggerPhotoPicker('avatar');
  };

  if (dom.triggerAvatarUploadBtn) dom.triggerAvatarUploadBtn.addEventListener('click', triggerAvatarPicker);
  if (dom.triggerAvatarUploadBtn2) dom.triggerAvatarUploadBtn2.addEventListener('click', triggerAvatarPicker);
  if (dom.avatarPreviewClickArea) dom.avatarPreviewClickArea.addEventListener('click', triggerAvatarPicker);

  if (dom.avatarFileInput) {
    dom.avatarFileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      if (file.size > 3.5 * 1024 * 1024) {
        showToast('Fotoğraf boyutu 3.5MB\'dan küçük olmalıdır.');
        return;
      }

      const reader = new FileReader();
      reader.onload = (ev) => {
        pendingAvatarUrl = ev.target.result;
        pendingAvatarBg = '';
        if (dom.editAvatarPreview) {
          dom.editAvatarPreview.innerHTML = `<img src="${pendingAvatarUrl}" class="w-full h-full object-cover" alt="PP">`;
          dom.editAvatarPreview.className = 'w-22 h-22 rounded-2xl overflow-hidden shadow-xl border-2 border-white/20 ring-4 ring-white/5 flex items-center justify-center';
        }
        showToast('Profil fotoğrafı seçildi! "Kaydet"e basın.');
      };
      reader.readAsDataURL(file);
    });
  }

  // Remove Custom Avatar Photo
  if (dom.removeAvatarPhotoBtn) {
    dom.removeAvatarPhotoBtn.addEventListener('click', () => {
      pendingAvatarUrl = '';
      pendingAvatarBg = 'from-rose-500 to-indigo-600';
      if (dom.editAvatarPreview) {
        const nameChar = (dom.editProfileNameInput?.value.trim() || state.username || 'M').charAt(0).toUpperCase();
        dom.editAvatarPreview.innerHTML = nameChar;
        dom.editAvatarPreview.className = `w-22 h-22 rounded-2xl bg-gradient-to-tr ${pendingAvatarBg} flex items-center justify-center text-3xl font-bold text-white shadow-xl overflow-hidden border-2 border-white/20 ring-4 ring-white/5`;
      }
      showToast('Profil fotoğrafı kaldırıldı.');
    });
  }

  // Preset avatar buttons
  document.querySelectorAll('.preset-avatar-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingAvatarBg = btn.dataset.bg || 'from-rose-500 to-indigo-600';
      pendingAvatarUrl = '';
      if (dom.editAvatarPreview) {
        const nameChar = (dom.editProfileNameInput.value.trim() || state.username || 'M').charAt(0).toUpperCase();
        dom.editAvatarPreview.innerHTML = nameChar;
        dom.editAvatarPreview.className = `w-22 h-22 rounded-2xl bg-gradient-to-tr ${pendingAvatarBg} flex items-center justify-center text-3xl font-bold text-white shadow-xl overflow-hidden border-2 border-white/20 ring-4 ring-white/5`;
      }
    });
  });

  if (dom.saveProfileBtn) {
    dom.saveProfileBtn.addEventListener('click', () => {
      const newName = (dom.editProfileNameInput && dom.editProfileNameInput.value.trim().replace(/^@/, '')) || '';
      if (newName) {
        state.username = newName;
      }

      const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
      savedUser.name = state.username;
      savedUser.username = state.username;
      if (pendingAvatarUrl) {
        savedUser.avatarUrl = pendingAvatarUrl;
        savedUser.avatarBg = '';
        state.avatarUrl = pendingAvatarUrl;
        state.avatarBg = '';
      } else if (pendingAvatarBg) {
        savedUser.avatarBg = pendingAvatarBg;
        savedUser.avatarUrl = '';
        state.avatarBg = pendingAvatarBg;
        state.avatarUrl = '';
      }
      localStorage.setItem('miruo_user', JSON.stringify(savedUser));

      // Keep Supabase user record updated
      syncUserProfileToSupabase(savedUser);

      updateUserUI(savedUser);
      if (dom.profileEditModal) dom.profileEditModal.classList.add('hidden');
      showToast('Profil ve fotoğraf güncellendi ✨');
    });
  }

  // Logout
  if (dom.logoutBtn) {
    dom.logoutBtn.addEventListener('click', logoutUser);
  }

  // Delete Account (Item 21: hesabı gerçekten sil)
  const openDeleteModalBtn = document.getElementById('openDeleteAccountModalBtn');
  const deleteModal = document.getElementById('deleteAccountModal');
  const cancelDeleteBtn = document.getElementById('cancelDeleteAccountBtn');
  const confirmDeleteBtn = document.getElementById('confirmDeleteAccountBtn');
  const deletePassInput = document.getElementById('deleteAccountPasswordInput');
  const deleteErrorAlert = document.getElementById('deleteAccountErrorAlert');

  if (openDeleteModalBtn && deleteModal) {
    openDeleteModalBtn.addEventListener('click', () => {
      if (deleteErrorAlert) deleteErrorAlert.classList.add('hidden');
      if (deletePassInput) deletePassInput.value = '';
      deleteModal.classList.remove('hidden');
      deleteModal.classList.add('flex');
    });
  }

  if (cancelDeleteBtn && deleteModal) {
    cancelDeleteBtn.addEventListener('click', () => {
      deleteModal.classList.add('hidden');
      deleteModal.classList.remove('flex');
    });
  }

  if (confirmDeleteBtn && deleteModal) {
    confirmDeleteBtn.addEventListener('click', async () => {
      const stored = localStorage.getItem('miruo_user');
      const currentUser = stored ? JSON.parse(stored) : null;
      if (!currentUser || !currentUser.id) {
        showToast('Aktif bir oturum bulunamadı.');
        deleteModal.classList.add('hidden');
        return;
      }

      const password = deletePassInput ? deletePassInput.value.trim() : '';
      confirmDeleteBtn.disabled = true;
      confirmDeleteBtn.textContent = 'Siliniyor...';

      try {
        const res = await fetch('/api/auth/delete-account', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: currentUser.id,
            email: currentUser.email,
            password: password
          })
        });
        const data = await res.json();
        if (data.success) {
          localStorage.removeItem('miruo_user');
          deleteModal.classList.add('hidden');
          showToast('Hesabınız ve tüm verileriniz kalıcı olarak silindi.');
          setTimeout(() => {
            location.href = '/';
          }, 1200);
        } else {
          if (deleteErrorAlert) {
            deleteErrorAlert.textContent = data.message || 'Hesap silinemedi.';
            deleteErrorAlert.classList.remove('hidden');
          } else {
            showToast(data.message || 'Hesap silinemedi.');
          }
          confirmDeleteBtn.disabled = false;
          confirmDeleteBtn.textContent = 'Evet, Hesabımı Sil';
        }
      } catch (err) {
        if (deleteErrorAlert) {
          deleteErrorAlert.textContent = 'Sunucuyla bağlantı kurulamadı.';
          deleteErrorAlert.classList.remove('hidden');
        }
        confirmDeleteBtn.disabled = false;
        confirmDeleteBtn.textContent = 'Evet, Hesabımı Sil';
      }
    });
  }

  // Room Badge - Open Participants & Role Management Modal
  if (dom.roomBadge) {
    dom.roomBadge.addEventListener('click', () => {
      openRoomParticipantsModal();
    });
  }

  // Kimler Katılabilir Modal Function & Listeners
  function openRoomAccessModal() {
    const modal = dom.roomAccessModal || document.getElementById('roomAccessModal');
    const codeEl = dom.roomAccessModalCode || document.getElementById('roomAccessModalCode');
    const inputEl = dom.roomAccessLinkInput || document.getElementById('roomAccessLinkInput');
    if (codeEl) codeEl.textContent = state.roomId || 'ODA-77';
    if (inputEl) inputEl.value = getMiruoRoomUrl(state.roomId);
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
  }
  window.openRoomAccessModal = openRoomAccessModal;

  if (dom.roomAccessBtn) {
    dom.roomAccessBtn.addEventListener('click', openRoomAccessModal);
  }
  if (dom.closeRoomAccessModalBtn) {
    dom.closeRoomAccessModalBtn.addEventListener('click', () => {
      const modal = dom.roomAccessModal || document.getElementById('roomAccessModal');
      if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
      }
    });
  }
  if (dom.saveRoomAccessBtn) {
    dom.saveRoomAccessBtn.addEventListener('click', () => {
      const selectedRule = document.querySelector('input[name="roomAccessRule"]:checked')?.value || 'public';
      if (selectedRule === 'invite') {
        state.isPrivate = true;
        showToast('Oda Gizliliği: Sadece Davetliler 🔒');
      } else {
        state.isPrivate = false;
        showToast('Oda Gizliliği: Herkese Açık 🌍');
      }
      if (dom.roomAccessModal) dom.roomAccessModal.classList.add('hidden');
    });
  }
  if (dom.copyRoomAccessLinkBtn) {
    dom.copyRoomAccessLinkBtn.addEventListener('click', () => {
      const url = getMiruoRoomUrl(state.roomId);
      navigator.clipboard?.writeText(url).then(() => {
        showToast('Oda linki kopyalandı! 📋');
        dom.copyRoomAccessLinkBtn.textContent = 'Kopyalandı! ✓';
        setTimeout(() => {
          if (dom.copyRoomAccessLinkBtn) dom.copyRoomAccessLinkBtn.textContent = 'Kopyala';
        }, 2000);
      }).catch(() => {
        showToast('Link: ' + url);
      });
    });
  }

  // Stage Interactive Touch
  if (dom.stageContainer) {
    dom.stageContainer.addEventListener('click', (e) => {
      // Only trigger if click wasn't on controls
      if (e.target.closest('#partnerPipCard') || e.target.closest('#selfPipCard') || e.target.closest('button')) return;
      const rect = dom.stageContainer.getBoundingClientRect();
      const normX = (e.clientX - rect.left) / rect.width;
      const normY = (e.clientY - rect.top) / rect.height;
      renderTouchEffect(normX, normY, true);
    });
  }

  // In-Room Multi-Platform Switchers (YouTube, Netflix, Prime, Spotify, Screen Share, Direct)
  if (dom.tabYoutube) dom.tabYoutube.addEventListener('click', () => switchRoomPlatform('youtube'));
  if (dom.tabNetflix) dom.tabNetflix.addEventListener('click', () => switchRoomPlatform('netflix'));
  if (dom.tabPrime) dom.tabPrime.addEventListener('click', () => switchRoomPlatform('prime'));
  if (dom.tabSpotify) dom.tabSpotify.addEventListener('click', () => switchRoomPlatform('spotify'));
  if (dom.tabScreenShare) dom.tabScreenShare.addEventListener('click', () => switchRoomPlatform('screenshare'));
  if (dom.tabDirectVideo) dom.tabDirectVideo.addEventListener('click', () => switchRoomPlatform('direct'));

  if (dom.netflixStartStreamBtn) {
    dom.netflixStartStreamBtn.addEventListener('click', startScreenSharing);
  }

  // Local Video File Upload
  if (dom.selectLocalFileBtn && dom.localVideoFileInput) {
    dom.selectLocalFileBtn.addEventListener('click', () => dom.localVideoFileInput.click());
    dom.localVideoFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const fileUrl = URL.createObjectURL(file);
        dom.nativeVideoPlayer.src = fileUrl;
        dom.nativeVideoPlayer.play();
        dom.nativeVideoPlayer.classList.remove('hidden');
        if (dom.ytPlayerContainer) dom.ytPlayerContainer.classList.add('hidden');
        if (dom.emptyStatePlaceholder) dom.emptyStatePlaceholder.classList.add('hidden');
        showToast(`Yerel video yüklendi: ${file.name} 🎬`);
      }
    });
  }

  // Fullscreen Handlers (Dock Button, Stage Floating Button, Double-Click, F Key)
  if (dom.toggleFullscreenBtn) dom.toggleFullscreenBtn.addEventListener('click', toggleFullscreen);
  if (dom.stageFloatingFullscreenBtn) {
    dom.stageFloatingFullscreenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFullscreen();
    });
  }

  if (dom.stageContainer) {
    dom.stageContainer.addEventListener('dblclick', (e) => {
      if (e.target.closest('#partnerPipCard') || e.target.closest('#selfPipCard') || e.target.closest('button')) return;
      toggleFullscreen();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (['input', 'textarea'].includes((document.activeElement?.tagName || '').toLowerCase())) return;
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFullscreen();
    }
  });

  document.addEventListener('fullscreenchange', updateFullscreenUI);
  document.addEventListener('webkitfullscreenchange', updateFullscreenUI);

  // Platform Accounts Modal Events (Now unified inside Profile & Settings Hub)
  if (dom.openPlatformAccountsBtn) dom.openPlatformAccountsBtn.addEventListener('click', () => openProfileEditModal('accounts'));
  if (dom.openPlatformAccountsMenuBtn) {
    dom.openPlatformAccountsMenuBtn.addEventListener('click', () => {
      if (dom.userProfileDropdown) dom.userProfileDropdown.classList.add('hidden');
      openProfileEditModal('accounts');
    });
  }
  if (dom.openPlatformAccountsFromSettingsBtn) {
    dom.openPlatformAccountsFromSettingsBtn.addEventListener('click', () => {
      switchProfileTab('accounts');
    });
  }
  if (dom.roomPlatformAccountQuickBtn) dom.roomPlatformAccountQuickBtn.addEventListener('click', () => openProfileEditModal('accounts'));
  if (dom.closePlatformAccountsBtn) addInstantTap(dom.closePlatformAccountsBtn, closePlatformAccountsModal);
  if (dom.platformAccountsModal) {
    dom.platformAccountsModal.addEventListener('click', (e) => {
      if (e.target === dom.platformAccountsModal) closePlatformAccountsModal();
    });
  }

  // Platform Account Launcher Toggles (Opens official web apps in native in-app browser)
  if (dom.toggleYtAccountBtn) {
    dom.toggleYtAccountBtn.addEventListener('click', () => {
      launchPlatform('youtube');
    });
  }

  if (dom.toggleNetflixAccountBtn) {
    dom.toggleNetflixAccountBtn.addEventListener('click', () => {
      launchPlatform('netflix');
    });
  }

  if (dom.togglePrimeAccountBtn) {
    dom.togglePrimeAccountBtn.addEventListener('click', () => {
      launchPlatform('prime');
    });
  }

  if (dom.toggleDisneyAccountBtn) {
    dom.toggleDisneyAccountBtn.addEventListener('click', () => {
      launchPlatform('disney');
    });
  }

  // Rave PiP Corner Buttons
  document.querySelectorAll('.pip-corner-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      pipSettings.corner = btn.dataset.corner || 'bottom-right';
      savePipSettings();
    });
  });

  if (dom.pipShowInFullscreenCheckbox) {
    dom.pipShowInFullscreenCheckbox.addEventListener('change', (e) => {
      pipSettings.showInFullscreen = e.target.checked;
      savePipSettings();
    });
  }

  if (dom.openSettingsModalBtn) {
    dom.openSettingsModalBtn.addEventListener('click', () => {
      if (dom.userProfileDropdown) dom.userProfileDropdown.classList.add('hidden');
      openProfileEditModal('settings');
    });
  }

  // YouTube Loader
  if (dom.loadYoutubeBtn) {
    dom.loadYoutubeBtn.addEventListener('click', () => {
      if (dom.youtubeUrlInput) loadYoutubeVideo(dom.youtubeUrlInput.value.trim());
    });
  }
  if (dom.youtubeUrlInput) {
    dom.youtubeUrlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadYoutubeVideo(dom.youtubeUrlInput.value.trim());
    });
  }

  // Screen Share Buttons
  if (dom.startScreenShareBtn) dom.startScreenShareBtn.addEventListener('click', startScreenSharing);
  if (dom.stopScreenShareBtn) dom.stopScreenShareBtn.addEventListener('click', stopScreenSharing);

  // Play / Pause Toggle
  if (dom.mainPlayPauseBtn) dom.mainPlayPauseBtn.addEventListener('click', togglePlayPause);

  // Seek Slider (Miruo Custom Unified Scrubber)
  if (dom.seekSlider) {
    dom.seekSlider.addEventListener('input', (e) => {
      state.isUserDraggingSeek = true;
      const targetPercent = parseFloat(e.target.value);
      if (state.duration > 0) {
        const targetTime = (targetPercent / 100) * state.duration;
        if (dom.currentTimeDisplay) dom.currentTimeDisplay.textContent = formatTime(targetTime);
      }
    });

    const finishSeek = (e) => {
      state.isUserDraggingSeek = false;
      const targetPercent = parseFloat(e.target.value);
      if (state.duration > 0) {
        const targetTime = (targetPercent / 100) * state.duration;
        state.currentTime = targetTime;
        if (state.activeMode === 'youtube') {
          sendYtCommand('seekTo', [targetTime, true]);
        } else if (state.activeMode === 'direct' && dom.nativeVideoPlayer) {
          dom.nativeVideoPlayer.currentTime = targetTime;
        }
        sendP2PData('sync', { action: 'seek', time: targetTime, sentAt: Date.now() });
      }
    };

    dom.seekSlider.addEventListener('change', finishSeek);
    dom.seekSlider.addEventListener('mouseup', finishSeek);
    dom.seekSlider.addEventListener('touchend', finishSeek);
  }

  // Floating Emoji Reactions
  document.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      spawnFloatingReaction(btn.dataset.emoji, true);
    });
  });

  // Sleep Mode
  if (dom.toggleSleepBtn) dom.toggleSleepBtn.addEventListener('click', () => applySleepMode(!state.isSleepMode, true));
  if (dom.exitSleepBtn) dom.exitSleepBtn.addEventListener('click', () => applySleepMode(false, true));

  // Audio / Video Toggles
  if (dom.toggleMicBtn) dom.toggleMicBtn.addEventListener('click', toggleMic);
  if (dom.toggleCamBtn) dom.toggleCamBtn.addEventListener('click', toggleCam);

  // Explore Lobby Switcher (Rave Style Home View)
  if (dom.viewExploreBtn) dom.viewExploreBtn.addEventListener('click', switchToExplore);
  if (dom.viewMyRoomBtn) dom.viewMyRoomBtn.addEventListener('click', switchToMyRoom);
  if (dom.refreshRoomsBtn) dom.refreshRoomsBtn.addEventListener('click', loadPublicRooms);

  const navLogo = document.getElementById('navLogoBtn');
  if (navLogo) navLogo.addEventListener('click', switchToExplore);

  if (dom.backToLobbyBtn) {
    dom.backToLobbyBtn.addEventListener('click', switchToExplore);
  }

  if (dom.quickEnterPrivateRoomBtn) {
    dom.quickEnterPrivateRoomBtn.addEventListener('click', () => {
      state.roomId = localRoomCode();
      if (dom.activeRoomTitle) dom.activeRoomTitle.textContent = state.roomId;
      if (dom.currentRoomDisplay) dom.currentRoomDisplay.textContent = state.roomId;
      switchToMyRoom();
      connectSignaling();
      showToast(`${state.roomId} odanıza girdiniz ✨`);
    });
  }

  // Platform Launchers & Create Room Modal Logic
  let newRoomIsPrivate = true;
  let selectedPlatform = 'YouTube';

  function openCreateRoomModal(platform = 'YouTube') {
    selectedPlatform = platform;
    // Update platform selector UI in modal
    document.querySelectorAll('.platform-choice').forEach(choice => {
      const cat = (choice.dataset.category || '').toLowerCase();
      const target = platform.toLowerCase();
      const isMatch = cat === target || (target.includes('prime') && cat.includes('prime')) || (target.includes('ekran') && cat.includes('ekran'));
      if (isMatch) {
        choice.className = 'platform-choice active p-2 rounded-xl border-2 border-rose-500 bg-rose-500/15 flex flex-col items-center text-center gap-1 cursor-pointer transition-all';
        selectedPlatform = choice.dataset.category || platform;
      } else {
        choice.className = 'platform-choice p-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 flex flex-col items-center text-center gap-1 cursor-pointer transition-all';
      }
    });

    if (dom.newRoomTitleInput) {
      dom.newRoomTitleInput.value = '';
      dom.newRoomTitleInput.placeholder = `Örn: ${selectedPlatform} Partisi 🎉 veya Gece Sohbeti`;
    }

    if (dom.createRoomModal) {
      dom.createRoomModal.classList.remove('hidden');
      dom.createRoomModal.classList.add('flex');
      setTimeout(() => dom.newRoomTitleInput && dom.newRoomTitleInput.focus(), 80);
    }
  }

  function closeCreateRoomModal() {
    if (dom.createRoomModal) {
      dom.createRoomModal.classList.add('hidden');
      dom.createRoomModal.classList.remove('flex');
    }
  }

  // Top Platform Launchers (YouTube, Netflix, Prime, Ekran Paylaş, Spotify, Yerel Video)
  document.querySelectorAll('.platform-launcher-card').forEach(card => {
    card.addEventListener('click', (e) => {
      e.preventDefault();
      const platformKey = card.dataset.platform;
      if (platformKey === 'youtube') {
        handleYouTubeLaunch();
        return;
      }
      let platformName = 'YouTube';
      if (platformKey === 'netflix') platformName = 'Netflix';
      else if (platformKey === 'prime') platformName = 'Prime Video';
      else if (platformKey === 'screenshare') platformName = 'Ekran Paylaş';
      else if (platformKey === 'music') platformName = 'Spotify';
      else if (platformKey === 'direct') platformName = 'Yerel Video';
      openCreateRoomModal(platformName);
    });
  });

  // Rave '+' Floating Action Button -> Opens Provider Picker (Image 2)
  if (dom.raveFabPlusBtn) {
    addInstantTap(dom.raveFabPlusBtn, (e) => {
      e.stopPropagation();
      switchToProviderPicker();
    });
  }

  // Mobile Bottom Bar Create Button -> Opens Provider Picker (Image 2)
  if (dom.mobileNavCreateBtn) {
    addInstantTap(dom.mobileNavCreateBtn, (e) => {
      e.stopPropagation();
      switchToProviderPicker();
    });
  }

  if (dom.openCreateRoomBtn) {
    addInstantTap(dom.openCreateRoomBtn, (e) => {
      e.stopPropagation();
      switchToProviderPicker();
    });
  }

  // Close Provider Picker -> Returns to Home Explore (Image 1)
  if (dom.closeProviderPickerBtn) {
    addInstantTap(dom.closeProviderPickerBtn, (e) => {
      e.stopPropagation();
      switchToExplore();
    });
  }


  // Provider Grid Cards (14 Platforms)
  document.querySelectorAll('.provider-card').forEach(card => {
    addInstantTap(card, () => {
      const provider = card.dataset.provider;
      launchPlatform(provider);
    });
  });

  // Provider Search Input (Filter or YouTube/Web search)
  if (dom.providerSearchInput) {
    dom.providerSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = dom.providerSearchInput.value.trim();
        if (val) {
          if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.openPlatform) {
            window.webkit.messageHandlers.openPlatform.postMessage({
              provider: 'youtube',
              url: `https://m.youtube.com/results?search_query=${encodeURIComponent(val)}`,
              title: `Arama: ${val}`
            });
          } else {
            openRaveYoutubeModal();
            if (dom.raveYtSearchInput) {
              dom.raveYtSearchInput.value = val;
              loadRaveYoutubeFeed(val, 'all');
            }
          }
        }
      }
    });
  }

  // Leave Watch Room -> Return to Home Explore Feed (Image 1)
  if (dom.backToLobbyBtn) {
    addInstantTap(dom.backToLobbyBtn, (e) => {
      e.stopPropagation();
      switchToExplore();
    });
  }

  // Room Share & Invite Modal Toggles (Paylaş Butonu)
  const openRoomShareModal = () => {
    const modal = dom.roomShareModal || document.getElementById('roomShareModal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
    const linkText = dom.raveInviteLinkText || document.getElementById('raveInviteLinkText');
    if (linkText) {
      linkText.textContent = getMiruoRoomUrl(state.roomId);
    }
  };
  window.openRoomShareModal = openRoomShareModal;

  const closeRoomShareModal = () => {
    const modal = dom.roomShareModal || document.getElementById('roomShareModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
    const menu = document.getElementById('privacySelectMenu');
    if (menu) menu.classList.add('hidden');
  };

  if (dom.nowPlayingShareBtn) addInstantTap(dom.nowPlayingShareBtn, openRoomShareModal);
  if (dom.roomTopShareBtn) addInstantTap(dom.roomTopShareBtn, openRoomShareModal);
  if (dom.closeRoomShareBtn) addInstantTap(dom.closeRoomShareBtn, closeRoomShareModal);
  const shareModalEl = dom.roomShareModal || document.getElementById('roomShareModal');
  if (shareModalEl) {
    shareModalEl.addEventListener('click', (e) => {
      if (e.target === shareModalEl) closeRoomShareModal();
    });
  }

  // Privacy Dropdown Menu Toggle & Choices (Tek tıkla açılan sade seçim)
  const privacyTrigger = document.getElementById('privacySelectTrigger');
  const privacyMenu = document.getElementById('privacySelectMenu');
  const selectedPrivacyLabel = document.getElementById('selectedPrivacyLabel');
  const selectedPrivacyIcon = document.getElementById('selectedPrivacyIcon');

  if (privacyTrigger && privacyMenu) {
    privacyTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      privacyMenu.classList.toggle('hidden');
    });

    document.querySelectorAll('.privacy-choice-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const privacyVal = btn.dataset.privacy;
        const privacyText = btn.dataset.label;
        if (selectedPrivacyLabel) selectedPrivacyLabel.textContent = privacyText;

        if (privacyVal === 'public') {
          state.isPrivateRoom = false;
          if (selectedPrivacyIcon) selectedPrivacyIcon.innerHTML = '<svg class="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z"/></svg>';
          if (dom.privacyStatusText) dom.privacyStatusText.textContent = 'Açık Oda';
          if (dom.privacyStatusIcon) dom.privacyStatusIcon.innerHTML = '<svg class="w-3 h-3 inline text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z"/></svg>';
        } else if (privacyVal === 'friends') {
          state.isPrivateRoom = false;
          if (selectedPrivacyIcon) selectedPrivacyIcon.innerHTML = '<svg class="w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
          if (dom.privacyStatusText) dom.privacyStatusText.textContent = 'Arkadaşlar';
          if (dom.privacyStatusIcon) dom.privacyStatusIcon.innerHTML = '<svg class="w-3 h-3 inline text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
        } else {
          state.isPrivateRoom = true;
          if (selectedPrivacyIcon) selectedPrivacyIcon.innerHTML = '<svg class="w-4 h-4 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
          if (dom.privacyStatusText) dom.privacyStatusText.textContent = 'Özel (Davetli)';
          if (dom.privacyStatusIcon) dom.privacyStatusIcon.innerHTML = '<svg class="w-3 h-3 inline text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
        }

        // Update active checkmarks
        document.querySelectorAll('.privacy-choice-btn').forEach(b => {
          const chk = b.querySelector('.privacy-check');
          if (chk) chk.classList.toggle('hidden', b !== btn);
        });

        privacyMenu.classList.add('hidden');
        showToast(`Oda Gizliliği: ${privacyText}`);
      });
    });

    document.addEventListener('click', (e) => {
      if (!privacyMenu.contains(e.target) && e.target !== privacyTrigger) {
        privacyMenu.classList.add('hidden');
      }
    });
  }

  // Watch Room Copy Invite Link
  const handleCopyInvite = () => {
    const inviteUrl = getMiruoRoomUrl(state.roomId);
    const linkText = dom.raveInviteLinkText || document.getElementById('raveInviteLinkText');
    if (linkText) linkText.textContent = inviteUrl;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(inviteUrl);
    }
    showToast(`Miruo oda linki kopyalandı! 📋\n${inviteUrl}`);
  };
  if (dom.copyRaveInviteBtn) dom.copyRaveInviteBtn.addEventListener('click', handleCopyInvite);
  const copyBtn = document.getElementById('copyRaveInviteBtn');
  if (copyBtn && copyBtn !== dom.copyRaveInviteBtn) copyBtn.addEventListener('click', handleCopyInvite);

  // Watch Room Social Share App Buttons (WhatsApp, SMS Messages, Telegram, System Share)
  document.querySelectorAll('.share-app-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const channel = btn.dataset.channel;
      const inviteUrl = getMiruoRoomUrl(state.roomId);
      const shareText = `Miruo'da benimle birlikte video izle! 🍿🎬\nOda Kodu: ${(state.roomId || 'ODA-77').toUpperCase()}\n${inviteUrl}`;

      if (channel === 'whatsapp') {
        window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, '_blank');
      } else if (channel === 'messages') {
        window.location.href = `sms:?&body=${encodeURIComponent(shareText)}`;
      } else if (channel === 'telegram') {
        window.open(`https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${encodeURIComponent(`Miruo ile birlikte izle! 🍿🎬 (Oda: ${(state.roomId || 'ODA-77').toUpperCase()})`)}`, '_blank');
      } else if (channel === 'system') {
        if (navigator.share) {
          navigator.share({
            title: 'Miruo — Birlikte İzle',
            text: shareText,
            url: inviteUrl
          }).catch(() => {});
        } else {
          handleCopyInvite();
        }
      }
    });
  });

  // Now Playing Heart & Next Buttons
  if (dom.nowPlayingHeartBtn) {
    dom.nowPlayingHeartBtn.addEventListener('click', () => {
      const isLiked = dom.nowPlayingHeartBtn.textContent === '❤️';
      dom.nowPlayingHeartBtn.textContent = isLiked ? '♡' : '❤️';
      dom.nowPlayingHeartBtn.className = isLiked ? 'hover:text-rose-500 text-lg transition-colors cursor-pointer text-gray-300' : 'text-rose-500 text-lg transition-colors cursor-pointer';
      showToast(isLiked ? 'Beğeni kaldırıldı' : 'Video beğenildi! ❤️');
    });
  }
  if (dom.nowPlayingNextBtn) {
    addInstantTap(dom.nowPlayingNextBtn, () => {
      handleNextTrack();
    });
  }

  // Stage Search / Quick Video Changer
  const openVideoChooser = () => {
    if (state.roomId && dom.roomWorkspaceSection && !dom.roomWorkspaceSection.classList.contains('hidden')) {
      openRaveYoutubeModal();
    } else {
      handleYouTubeLaunch();
    }
  };
  window.openVideoChooser = openVideoChooser;
  if (dom.roomTopSearchBtn) addInstantTap(dom.roomTopSearchBtn, openVideoChooser);
  const roomQuickSearch = document.getElementById('roomQuickSearchBtn');
  if (roomQuickSearch) addInstantTap(roomQuickSearch, openVideoChooser);

  // Queue Modal & Suggestions UI Bindings
  const openRoomQueueModal = () => {
    updateRoomQueueUI();
    if (dom.roomQueueModal) dom.roomQueueModal.classList.remove('hidden');
  };
  window.openRoomQueueModal = openRoomQueueModal;
  if (dom.roomQueueBadgeBtn) {
    addInstantTap(dom.roomQueueBadgeBtn, () => {
      openRoomQueueModal();
    });
  }
  if (dom.closeQueueModalBtn) {
    addInstantTap(dom.closeQueueModalBtn, () => {
      if (dom.roomQueueModal) dom.roomQueueModal.classList.add('hidden');
    });
  }
  if (dom.closeRaveActionSheetBtn) {
    addInstantTap(dom.closeRaveActionSheetBtn, () => {
      if (dom.raveVideoActionSheet) dom.raveVideoActionSheet.classList.add('hidden');
    });
  }
  if (dom.closeSuggestionBannerBtn) {
    addInstantTap(dom.closeSuggestionBannerBtn, () => {
      if (dom.hostSuggestionBanner) dom.hostSuggestionBanner.classList.add('hidden');
    });
  }
  if (dom.acceptSuggestionPlayNowBtn) {
    addInstantTap(dom.acceptSuggestionPlayNowBtn, () => {
      if (pendingSuggestion) {
        selectAndPlayYoutubeVideo(pendingSuggestion.videoId, pendingSuggestion.title);
        showToast(`🎬 ${pendingSuggestion.fromUser}'ın önerdiği video başlatıldı!`);
      }
      if (dom.hostSuggestionBanner) dom.hostSuggestionBanner.classList.add('hidden');
    });
  }
  if (dom.acceptSuggestionQueueBtn) {
    addInstantTap(dom.acceptSuggestionQueueBtn, () => {
      if (pendingSuggestion) {
        addToRoomQueue({
          id: pendingSuggestion.videoId,
          title: pendingSuggestion.title,
          thumb: pendingSuggestion.thumb,
          addedBy: pendingSuggestion.fromUser
        });
        showToast(`➕ ${pendingSuggestion.fromUser}'ın önerisi sıraya eklendi!`);
      }
      if (dom.hostSuggestionBanner) dom.hostSuggestionBanner.classList.add('hidden');
    });
  }

  if (dom.mobileNavExploreBtn) {
    addInstantTap(dom.mobileNavExploreBtn, () => {
      switchToExplore();
    });
  }

  if (dom.mobileNavFriendsBtn) {
    addInstantTap(dom.mobileNavFriendsBtn, () => {
      switchToFriendsTab();
    });
  }

  if (dom.mobileNavProfileBtn) {
    addInstantTap(dom.mobileNavProfileBtn, (e) => {
      e.stopPropagation();
      openProfileEditModal();
    });
  }

  if (dom.closeCreateRoomBtn) {
    addInstantTap(dom.closeCreateRoomBtn, (e) => {
      e.stopPropagation();
      closeCreateRoomModal();
    });
  }

  // Close ALL Modals on Backdrop Click (Prevents touch blocking overlays!)
  const allOverlayModals = [
    dom.authModal,
    dom.createRoomModal,
    dom.youtubeConnectModal,
    dom.raveYoutubeModal,
    dom.profileEditModal,
    dom.settingsModal,
    dom.friendsModal,
    dom.platformAccountsModal
  ];

  allOverlayModals.forEach(modal => {
    if (modal) {
      addInstantTap(modal, (e) => {
        if (e.target === modal) {
          modal.classList.add('hidden');
        }
      });
    }
  });

  if (dom.selectPrivateRoomBtn) {
    dom.selectPrivateRoomBtn.addEventListener('click', () => {
      newRoomIsPrivate = true;
      dom.selectPrivateRoomBtn.className = 'p-3 rounded-2xl border-2 border-rose-500 bg-rose-500/10 text-left transition-all';
      if (dom.selectPublicRoomBtn) dom.selectPublicRoomBtn.className = 'p-3 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 text-left transition-all';
    });
  }

  if (dom.selectPublicRoomBtn) {
    dom.selectPublicRoomBtn.addEventListener('click', () => {
      newRoomIsPrivate = false;
      dom.selectPublicRoomBtn.className = 'p-3 rounded-2xl border-2 border-purple-500 bg-purple-500/10 text-left transition-all';
      if (dom.selectPrivateRoomBtn) dom.selectPrivateRoomBtn.className = 'p-3 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 text-left transition-all';
    });
  }

  document.querySelectorAll('.platform-choice').forEach(choice => {
    choice.addEventListener('click', () => {
      document.querySelectorAll('.platform-choice').forEach(c => c.className = 'platform-choice p-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 flex flex-col items-center text-center gap-1 cursor-pointer transition-all');
      choice.className = 'platform-choice active p-2 rounded-xl border-2 border-rose-500 bg-rose-500/15 flex flex-col items-center text-center gap-1 cursor-pointer transition-all';
      selectedPlatform = choice.dataset.category || 'YouTube';
    });
  });

  function applyPlatformToActiveRoom(platform) {
    const p = (platform || '').toLowerCase();
    if (p.includes('youtube')) {
      switchActiveTab('youtube');
      if (dom.youtubeUrlInput) dom.youtubeUrlInput.focus();
    } else if (p.includes('netflix') || p.includes('prime') || p.includes('ekran') || p.includes('screen')) {
      switchActiveTab('screenshare');
      showToast(`${platform} için sekme yayını hazır! 📺`);
    } else if (p.includes('spotify') || p.includes('music')) {
      switchActiveTab('youtube');
      if (dom.youtubeUrlInput) {
        dom.youtubeUrlInput.placeholder = 'Spotify veya YouTube Music linki yapıştırın...';
        dom.youtubeUrlInput.focus();
      }
    } else if (p.includes('video') || p.includes('direct')) {
      switchActiveTab('direct');
      if (dom.localVideoFileInput) dom.localVideoFileInput.click();
    }
  }

function generateUniqueRoomCode(isPrivate = false) {
  const consonants = 'BDFGHJKLMNPRSTVYZ';
  const vowels = 'AEU';
  const pick = (chars) => chars[Math.floor(Math.random() * chars.length)];
  const word = pick(consonants) + pick(vowels) + pick(consonants) + pick(vowels);
  const num = Math.floor(10 + Math.random() * 90);
  const prefix = isPrivate ? 'OZEL' : 'ODA';
  return `${prefix}-${word}${num}`.toUpperCase();
}

  if (dom.submitCreateRoomBtn) {
    dom.submitCreateRoomBtn.addEventListener('click', () => {
      const title = (dom.newRoomTitleInput && dom.newRoomTitleInput.value.trim()) || `${selectedPlatform} Partisi`;
      const fallbackId = generateUniqueRoomCode(newRoomIsPrivate);

      // Creator is always Host
      state.isHost = true;
      state.hostName = state.username;
      state.controlMode = 'host_only';
      state.hasDjPermission = true;

      closeCreateRoomModal();

      fetch('/api/create-room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: fallbackId,
          name: title,
          isPrivate: newRoomIsPrivate,
          host: state.username,
          category: selectedPlatform
        })
      })
      .then(res => res.json())
      .then(data => {
        state.roomId = (data && data.room && data.room.id) || fallbackId;
        if (dom.activeRoomTitle) dom.activeRoomTitle.textContent = state.roomId;
        if (dom.currentRoomDisplay) dom.currentRoomDisplay.textContent = state.roomId;
        switchToMyRoom();
        connectSignaling();
        applyPlatformToActiveRoom(selectedPlatform);
        showToast(`${title} odası oluşturuldu! 🚀`);
      })
      .catch(err => {
        console.error(err);
        state.roomId = fallbackId;
        if (dom.activeRoomTitle) dom.activeRoomTitle.textContent = state.roomId;
        if (dom.currentRoomDisplay) dom.currentRoomDisplay.textContent = state.roomId;
        switchToMyRoom();
        connectSignaling();
        applyPlatformToActiveRoom(selectedPlatform);
        showToast(`${title} odası oluşturuldu! 🚀`);
      });
    });
  }

  if (dom.newRoomTitleInput) {
    dom.newRoomTitleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') dom.submitCreateRoomBtn && dom.submitCreateRoomBtn.click();
    });
  }

  // Host Permission Mode Toggle (Host switches between 'host_only' and 'everyone')
  if (dom.toggleRoomPermissionBtn) {
    dom.toggleRoomPermissionBtn.addEventListener('click', () => {
      if (!state.isHost) return;
      state.controlMode = state.controlMode === 'host_only' ? 'everyone' : 'host_only';
      updatePermissionUI();
      sendP2PData('perm_change', { mode: state.controlMode, hostName: state.username });
      showToast(state.controlMode === 'everyone' ? 'Video açma izni herkese verildi 🔓' : 'Video açma sadece yöneticiye kilitlendi 🔒');
    });
  }

  // Guest Requests DJ Permission from Host
  if (dom.requestDjPermissionBtn) {
    dom.requestDjPermissionBtn.addEventListener('click', () => {
      sendP2PData('request_dj', { fromUser: state.username });
      showToast('Oda yöneticisine video açma isteği gönderildi ✋');
    });
  }

  // Host Grants DJ Permission
  if (dom.grantDjPermissionBtn) {
    dom.grantDjPermissionBtn.addEventListener('click', () => {
      sendP2PData('grant_dj', { toUser: dom.requestingUserName ? dom.requestingUserName.textContent : 'Partner' });
      if (dom.hostPermissionRequestToast) {
        dom.hostPermissionRequestToast.classList.add('hidden');
        dom.hostPermissionRequestToast.classList.remove('flex');
      }
      showToast('Video açma yetkisi verildi! 🎶');
    });
  }

  // Host Denies DJ Permission
  if (dom.denyDjPermissionBtn) {
    dom.denyDjPermissionBtn.addEventListener('click', () => {
      if (dom.hostPermissionRequestToast) {
        dom.hostPermissionRequestToast.classList.add('hidden');
        dom.hostPermissionRequestToast.classList.remove('flex');
      }
      showToast('Yetki isteği reddedildi.');
    });
  }

  // Friends Full Tab & Modal Events
  if (dom.openFriendsBtn) {
    addInstantTap(dom.openFriendsBtn, () => {
      switchToFriendsTab();
    });
  }

  if (dom.tabCopyMyFriendCodeBtn) {
    addInstantTap(dom.tabCopyMyFriendCodeBtn, () => {
      const code = (dom.tabMyFriendCodeDisplay && dom.tabMyFriendCodeDisplay.textContent) || state.friendCode;
      navigator.clipboard.writeText(code).then(() => {
        showToast('Arkadaş kodun kopyalandı! 📋');
      });
    });
  }

  if (dom.tabSubmitAddFriendBtn) {
    addInstantTap(dom.tabSubmitAddFriendBtn, () => {
      if (dom.tabAddFriendInput) addFriend(dom.tabAddFriendInput.value);
    });
  }

  if (dom.tabAddFriendInput) {
    dom.tabAddFriendInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addFriend(dom.tabAddFriendInput.value);
    });
  }

  if (dom.tabFriendSearchInput) {
    dom.tabFriendSearchInput.addEventListener('input', (e) => {
      renderFriendsTab(e.target.value);
    });
  }

  if (dom.closeFriendsModalBtn) {
    addInstantTap(dom.closeFriendsModalBtn, () => {
      if (dom.friendsModal) dom.friendsModal.classList.add('hidden');
    });
  }

  if (dom.copyMyFriendCodeBtn) {
    addInstantTap(dom.copyMyFriendCodeBtn, () => {
      navigator.clipboard.writeText(state.friendCode).then(() => {
        showToast('Arkadaş kodun panoya kopyalandı! 📋');
      });
    });
  }

  if (dom.submitAddFriendBtn) {
    addInstantTap(dom.submitAddFriendBtn, () => {
      if (dom.addFriendInput) addFriend(dom.addFriendInput.value);
    });
  }

  if (dom.addFriendInput) {
    dom.addFriendInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addFriend(dom.addFriendInput.value);
    });
  }

  if (dom.roomInviteBtn) {
    addInstantTap(dom.roomInviteBtn, () => {
      loadFriends();
      if (dom.friendsModal) dom.friendsModal.classList.remove('hidden');
    });
  }

  // Live Friend Search Filter
  if (dom.friendSearchInput) {
    dom.friendSearchInput.addEventListener('input', (e) => {
      renderFriendsList(e.target.value);
    });
  }

  // Room Live Chat Events (YouTube Live Style)
  if (dom.toggleChatBtn) {
    dom.toggleChatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleChatPanel();
    });
  }

  if (dom.closeChatBtn) {
    dom.closeChatBtn.addEventListener('click', () => toggleChatPanel(false));
  }

  // Room Participants Modal & Panel Events
  if (dom.toggleParticipantsBtn) {
    dom.toggleParticipantsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openRoomParticipantsModal();
    });
  }

  if (dom.closeParticipantsBtn) {
    dom.closeParticipantsBtn.addEventListener('click', () => {
      closeRoomParticipantsModal();
    });
  }

  if (dom.roomParticipantsModal) {
    dom.roomParticipantsModal.addEventListener('click', (e) => {
      if (e.target === dom.roomParticipantsModal) {
        closeRoomParticipantsModal();
      }
    });
  }

  if (dom.copyInviteFromParticipantsBtn) {
    dom.copyInviteFromParticipantsBtn.addEventListener('click', () => {
      const inviteUrl = `${window.location.origin}/?room=${encodeURIComponent(state.roomId)}`;
      navigator.clipboard.writeText(inviteUrl).then(() => {
        showToast('Oda davet linki kopyalandı! 📋');
      });
    });
  }

  if (dom.sendChatMessageBtn) {
    dom.sendChatMessageBtn.addEventListener('click', () => sendChatMessage());
  }

  if (dom.chatMessageInput) {
    dom.chatMessageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChatMessage();
    });
  }

  // Quick Chat Preset Chips
  document.querySelectorAll('.quick-chat-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const chipText = chip.textContent.trim();
      sendChatMessage(chipText);
    });
  });

  // Chat Bottom Actions: Mention (@) Button & Popover
  const chatMentionBtn = document.getElementById('chatMentionBtn');
  const chatMentionPopover = document.getElementById('chatMentionPopover');
  const chatStickerPopover = document.getElementById('chatStickerPopover');

  if (chatMentionBtn) {
    chatMentionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (chatStickerPopover) chatStickerPopover.classList.add('hidden');
      if (chatMentionPopover) {
        chatMentionPopover.classList.toggle('hidden');
      }
      if (dom.chatMessageInput) {
        if (!dom.chatMessageInput.value.endsWith('@')) {
          dom.chatMessageInput.value = dom.chatMessageInput.value ? dom.chatMessageInput.value + ' @' : '@';
        }
        dom.chatMessageInput.focus();
      }
    });
  }

  // Mention Chips (@herkes, @Barış_99, etc.)
  document.querySelectorAll('.mention-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const mention = chip.dataset.mention || chip.textContent.trim();
      if (dom.chatMessageInput) {
        const val = dom.chatMessageInput.value.trim();
        dom.chatMessageInput.value = val ? `${val} ${mention} ` : `${mention} `;
        dom.chatMessageInput.focus();
      }
      if (chatMentionPopover) chatMentionPopover.classList.add('hidden');
    });
  });

  // Chat Image Button (Opens Phone Gallery / Photo Library)
  const chatImageBtn = document.getElementById('chatImageBtn');
  const chatStickerBtn = document.getElementById('chatStickerBtn');
  const chatImageFileInput = document.getElementById('chatImageFileInput');

  if (chatImageBtn) {
    chatImageBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerPhotoPicker('chat');
    });
  }

  if (chatStickerBtn) {
    chatStickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (chatMentionPopover) chatMentionPopover.classList.add('hidden');
      if (chatStickerPopover) {
        chatStickerPopover.classList.toggle('hidden');
      }
    });
  }

  // Inside Sticker Popover: "Fotoğraf Ekle" label button
  const popoverPhotoLabel = document.querySelector('label[for="chatImageFileInput"]');
  if (popoverPhotoLabel) {
    popoverPhotoLabel.addEventListener('click', (e) => {
      e.preventDefault();
      triggerPhotoPicker('chat');
    });
  }

  // Sticker Chips (🍿, 🔥, ❤️, 😂, etc.)
  document.querySelectorAll('.sticker-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const sticker = chip.dataset.sticker || chip.textContent.trim();
      sendChatMessage(sticker);
      if (chatStickerPopover) chatStickerPopover.classList.add('hidden');
    });
  });

  // Image File Upload from phone/library
  if (chatImageFileInput) {
    chatImageFileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          const dataUrl = evt.target.result;
          sendChatMessage('', dataUrl);
          showToast('📷 Görsel sohbete yüklendi!');
          if (chatStickerPopover) chatStickerPopover.classList.add('hidden');
        };
        reader.readAsDataURL(file);
      }
    });
  }

  // Room Invite Button in Chat Bar (👥+)
  const roomInviteBtn2 = document.getElementById('roomInviteBtn2');
  if (roomInviteBtn2) {
    roomInviteBtn2.addEventListener('click', (e) => {
      e.stopPropagation();
      openRoomShareModal();
    });
  }

  // Room Share Link Button in Chat Bar (🔗)
  const roomShareLinkBtn = document.getElementById('roomShareLinkBtn');
  if (roomShareLinkBtn) {
    roomShareLinkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleCopyInvite();
    });
  }

  // Dismiss popovers when clicking outside
  document.addEventListener('click', (e) => {
    if (chatMentionPopover && !chatMentionPopover.contains(e.target) && e.target !== chatMentionBtn) {
      chatMentionPopover.classList.add('hidden');
    }
    if (chatStickerPopover && !chatStickerPopover.contains(e.target) && e.target !== chatImageBtn) {
      chatStickerPopover.classList.add('hidden');
    }
  });

  // Settings Modal
  if (dom.closeSettingsBtn) {
    addInstantTap(dom.closeSettingsBtn, () => dom.settingsModal.classList.add('hidden'));
  }

  // Universal 0ms Fast Touch & Tap Handler for all modal close buttons
  document.querySelectorAll('.close-modal-btn').forEach(btn => {
    addInstantTap(btn, (e) => {
      e.stopPropagation();
      const parentModal = btn.closest('.fixed') || btn.closest('#providerPickerSection');
      if (parentModal) {
        parentModal.classList.add('hidden');
      }
    });
  });

  if (dom.duckingLevelSlider) {
    dom.duckingLevelSlider.addEventListener('input', (e) => {
      state.duckingTargetVolume = e.target.value / 100;
      if (dom.duckingLevelVal) dom.duckingLevelVal.textContent = `%${e.target.value}`;
    });
  }

  if (dom.micSensSlider) {
    dom.micSensSlider.addEventListener('input', (e) => {
      state.speechThreshold = e.target.value / 255;
      if (dom.micSensVal) dom.micSensVal.textContent = e.target.value < 15 ? 'Yüksek' : (e.target.value < 30 ? 'Orta' : 'Düşük');
    });
  }

  // Initialize Draggable PIPs
  if (dom.partnerPipCard) makeDraggable(dom.partnerPipCard);
  if (dom.selfPipCard) makeDraggable(dom.selfPipCard);

  // Close buttons for PIP cards (One-tap camera off directly on card)
  if (dom.closeSelfPipBtn) {
    dom.closeSelfPipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.isCamOn) {
        toggleCam();
      } else if (dom.selfPipCard) {
        dom.selfPipCard.classList.add('hidden');
      }
    });
  }
  if (dom.closePartnerPipBtn) {
    dom.closePartnerPipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dom.partnerPipCard) {
        dom.partnerPipCard.classList.add('hidden');
      }
    });
  }

  // Classic YouTube Live Format: Chat Sidebar Close & Reopen Handlers
  if (dom.closeChatSidebarBtn) {
    dom.closeChatSidebarBtn.addEventListener('click', () => {
      setChatVisibility(false);
      showToast('Sohbet gizlendi. Yazısız izliyorsunuz 🎬');
    });
  }
  if (dom.openChatFloatingBtn) {
    dom.openChatFloatingBtn.addEventListener('click', () => {
      setChatVisibility(true);
      showToast('Canlı Sohbet açıldı 💬');
    });
  }
  if (dom.toggleChatToolbarBtn) {
    dom.toggleChatToolbarBtn.addEventListener('click', () => {
      setChatVisibility(!state.isChatVisible);
    });
  }

  // Chat Expand / Collapse Toggle (Compact default 110px vs expanded 260px)
  let isChatExpanded = false;
  const chatExpandBtn = document.getElementById('chatExpandBtn');
  const chatMessagesContainer = document.getElementById('chatMessagesContainer');
  const chatExpandLabel = document.getElementById('chatExpandLabel');
  const chatExpandIcon = document.getElementById('chatExpandIcon');
  if (chatExpandBtn && chatMessagesContainer) {
    chatExpandBtn.addEventListener('click', () => {
      isChatExpanded = !isChatExpanded;
      if (isChatExpanded) {
        chatMessagesContainer.classList.remove('h-[110px]');
        chatMessagesContainer.classList.add('h-[260px]');
        if (chatExpandLabel) chatExpandLabel.textContent = 'Küçült';
        if (chatExpandIcon) {
          chatExpandIcon.innerHTML = '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>';
        }
      } else {
        chatMessagesContainer.classList.remove('h-[260px]');
        chatMessagesContainer.classList.add('h-[110px]');
        if (chatExpandLabel) chatExpandLabel.textContent = 'Büyüt';
        if (chatExpandIcon) {
          chatExpandIcon.innerHTML = '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>';
        }
      }
      chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
    });
  }



  // Stage Overlay Temporary Peek on Stage Click (Auto fades after 3.5s)
  let overlayHideTimeout = null;
  const stageContainer = document.getElementById('stageContainer');
  const ravePlayerOverlay = document.getElementById('ravePlayerOverlay');
  if (stageContainer && ravePlayerOverlay) {
    stageContainer.addEventListener('click', (e) => {
      // Don't intercept if clicking PiP or buttons inside overlay
      if (e.target.closest('#partnerPipCard') || e.target.closest('#selfPipCard') || e.target.closest('button') || e.target.closest('input')) return;
      
      ravePlayerOverlay.classList.remove('opacity-0', 'pointer-events-none');
      ravePlayerOverlay.classList.add('opacity-100');

      clearTimeout(overlayHideTimeout);
      overlayHideTimeout = setTimeout(() => {
        ravePlayerOverlay.classList.add('opacity-0', 'pointer-events-none');
        ravePlayerOverlay.classList.remove('opacity-100');
      }, 3500);
    });
  }

  // Periodic simulated room viewers refresh (Heartbeat bot activity simulation)
  setInterval(() => {
    if (dom.exploreLobbySection && !dom.exploreLobbySection.classList.contains('hidden')) {
      loadPublicRooms();
    }
  }, 12000);

  // Quick Room Code Join (Collision-Free Rooms)
  const quickJoinBtn = document.getElementById('quickJoinRoomCodeBtn');
  const quickJoinInput = document.getElementById('quickJoinRoomCodeInput');
  if (quickJoinBtn && quickJoinInput) {
    const doQuickJoin = async () => {
      const code = quickJoinInput.value.trim().toUpperCase();
      if (!code) {
        showToast('Lütfen bir oda kodu girin!');
        quickJoinInput.focus();
        return;
      }
      quickJoinBtn.disabled = true;
      quickJoinBtn.textContent = '...';
      try {
        state.roomId = code;
        state.isHost = false;
        if (dom.activeRoomTitle) dom.activeRoomTitle.textContent = code;
        if (dom.currentRoomDisplay) dom.currentRoomDisplay.textContent = code;
        switchToMyRoom();
        connectSignaling();
        showToast(`🎉 ${code} odasına bağlanıldı!`);
        quickJoinInput.value = '';
      } finally {
        quickJoinBtn.disabled = false;
        quickJoinBtn.textContent = 'Katıl';
      }
    };
    quickJoinBtn.addEventListener('click', doQuickJoin);
    quickJoinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doQuickJoin();
    });
  }

  // Initial user session and explore feed bootstrap
  loadPipSettings();
  loadPlatformAccounts();
  loadUserSession();
  initAuthOwlMascot();
  initStageAutoHideEvents();

  // Initialize multi-language (TR / EN / DE)
  const savedLang = localStorage.getItem('miruo_lang') || 'tr';
  applyLanguage(savedLang);

  // Wire up language selector buttons in Settings modal
  document.querySelectorAll('#langSelectorGroup .lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const selected = btn.dataset.lang;
      applyLanguage(selected);
      const msg = I18N[selected] ? I18N[selected].lang_changed : 'Dil güncellendi';
      showToast(msg);
    });
  });
}

// ==========================================
// 6.0 MIRUO 3D ANIMATED OWL MASCOT & EYE TRACKER
// ==========================================
function initAuthOwlMascot() {
  const owlContainer = document.getElementById('authOwlContainer');
  const pupilLeft = document.getElementById('authPupilLeft');
  const pupilRight = document.getElementById('authPupilRight');
  const pupilRightGlint = document.getElementById('authPupilRightGlint');
  const owlSvg = document.getElementById('authOwlSvg');
  if (!owlContainer || !pupilLeft || !pupilRight) return;

  let isInteracting = false;
  let idleTimer = null;
  let isFocusedOnInput = false;

  function setEyeOffsets(dx, dy) {
    const pupilMove = 5.2; // Full dynamic eye mobility (Yukarı, Aşağı, Sağ, Sol)
    const clampedDx = Math.max(-1, Math.min(1, dx));
    const clampedDy = Math.max(-1, Math.min(1, dy));

    if (pupilLeft) pupilLeft.style.transform = `translate(${clampedDx * pupilMove}px, ${clampedDy * pupilMove}px)`;
    if (pupilRight) pupilRight.style.transform = `translate(${clampedDx * pupilMove}px, ${clampedDy * pupilMove}px)`;
    if (pupilRightGlint) pupilRightGlint.style.transform = `translate(${clampedDx * pupilMove}px, ${clampedDy * pupilMove}px)`;
    if (owlContainer) owlContainer.style.transform = `rotateY(${clampedDx * 18}deg) rotateX(${-clampedDy * 14}deg)`;
  }

  function handlePointer(clientX, clientY) {
    if (isFocusedOnInput) return;
    isInteracting = true;
    clearTimeout(idleTimer);
    const rect = owlContainer.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const targetDx = Math.max(-1, Math.min(1, (clientX - cx) / 200));
    const targetDy = Math.max(-1, Math.min(1, (clientY - cy) / 200));
    setEyeOffsets(targetDx, targetDy);

    idleTimer = setTimeout(() => {
      isInteracting = false;
    }, 2200);
  }

  window.addEventListener('mousemove', (e) => {
    if (dom.authModal && !dom.authModal.classList.contains('hidden')) {
      handlePointer(e.clientX, e.clientY);
    }
  });

  window.addEventListener('touchmove', (e) => {
    if (dom.authModal && !dom.authModal.classList.contains('hidden') && e.touches.length > 0) {
      handlePointer(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: true });

  function triggerBlink() {
    if (owlSvg) {
      owlSvg.classList.add('owl-blink');
      setTimeout(() => owlSvg.classList.remove('owl-blink'), 220);
    }
  }

  // Interactive Input Focus Reactions:
  // When typing contact/phone: owl looks DOWN at inputs
  const lookDownInputs = [dom.authContactInput, dom.authPhoneInput, dom.authNameInput].filter(Boolean);
  lookDownInputs.forEach(inp => {
    inp.addEventListener('focus', () => {
      isFocusedOnInput = true;
      setEyeOffsets(0, 0.85); // Aşağı (Down)
    });
    inp.addEventListener('blur', () => {
      isFocusedOnInput = false;
      setEyeOffsets(0, 0);
    });
  });

  // When typing password: owl looks SHYLY away / upwards (covers eyes)
  const passwordInputs = [dom.authPasswordInput, dom.authPasswordConfirmInput].filter(Boolean);
  passwordInputs.forEach(inp => {
    inp.addEventListener('focus', () => {
      isFocusedOnInput = true;
      triggerBlink();
      setEyeOffsets(-0.85, -0.7); // Sol Yukarı (Looking away)
    });
    inp.addEventListener('blur', () => {
      isFocusedOnInput = false;
      setEyeOffsets(0, 0);
    });
  });

  // When typing OTP digits: owl looks concentrated straight down
  const digitBoxes = document.querySelectorAll('.phone-digit-box');
  digitBoxes.forEach(box => {
    box.addEventListener('focus', () => {
      isFocusedOnInput = true;
      setEyeOffsets(0, 0.9); // Straight DOWN at OTP
    });
    box.addEventListener('blur', () => {
      isFocusedOnInput = false;
      setEyeOffsets(0, 0);
    });
  });

  // Autonomous organic eye wandering & blinking loop (Up, Down, Left, Right)
  setInterval(() => {
    if (isInteracting || isFocusedOnInput) return;
    if (!dom.authModal || dom.authModal.classList.contains('hidden')) return;

    if (Math.random() < 0.35) {
      triggerBlink();
    }

    const moves = [
      { dx: 0, dy: -0.85 },   // Yukarı (Up)
      { dx: 0, dy: 0.85 },    // Aşağı (Down)
      { dx: -0.9, dy: 0 },    // Sol (Left)
      { dx: 0.9, dy: 0 },     // Sağ (Right)
      { dx: 0.65, dy: -0.5 }, // Sağ Yukarı
      { dx: -0.65, dy: 0.5 }, // Sol Aşağı
      { dx: 0, dy: 0 },       // Düz / Merkez
      { dx: 0.5, dy: 0.3 }    // Hafif Sağ Aşağı
    ];
    const chosen = moves[Math.floor(Math.random() * moves.length)];
    setEyeOffsets(chosen.dx, chosen.dy);
  }, 1900);

  owlContainer.addEventListener('click', () => {
    triggerBlink();
    setTimeout(triggerBlink, 280);
    setEyeOffsets(0.85, -0.4);
    setTimeout(() => setEyeOffsets(-0.85, -0.4), 300);
    setTimeout(() => setEyeOffsets(0, 0), 700);
  });
}

// ==========================================
// 6.1 FULLSCREEN / CINEMA AUTO-HIDE CONTROLS
// ==========================================
let controlsHideTimeout = null;

function resetControlsHideTimer() {
  const elementsToControl = [
    dom.stageFloatingFullscreenBtn,
    document.getElementById('backToLobbyBtn'),
    document.getElementById('ravePlayerOverlay'),
    document.getElementById('roomAccessBtn'),
    document.getElementById('roomVideoGrid')
  ].filter(Boolean);

  // Reveal controls
  elementsToControl.forEach(el => el.classList.remove('fs-controls-hidden'));
  if (dom.stageContainer) dom.stageContainer.style.cursor = 'default';

  clearTimeout(controlsHideTimeout);

  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  // Auto-hide when in room and in fullscreen or landscape or video actively playing
  if (isFs || state.isPlaying || window.innerWidth > window.innerHeight) {
    controlsHideTimeout = setTimeout(() => {
      elementsToControl.forEach(el => el.classList.add('fs-controls-hidden'));
      if (dom.stageContainer) dom.stageContainer.style.cursor = 'none';
    }, 2500);
  }
}

function initStageAutoHideEvents() {
  if (!dom.stageContainer) return;

  ['mousemove', 'pointermove', 'touchstart', 'touchmove'].forEach(evt => {
    dom.stageContainer.addEventListener(evt, () => {
      resetControlsHideTimer();
    }, { passive: true });
  });

  dom.stageContainer.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('#partnerPipCard') || e.target.closest('#selfPipCard')) {
      resetControlsHideTimer();
      return;
    }
    const isHidden = dom.stageFloatingFullscreenBtn && dom.stageFloatingFullscreenBtn.classList.contains('fs-controls-hidden');
    if (isHidden) {
      resetControlsHideTimer();
    } else {
      const elementsToControl = [
        dom.stageFloatingFullscreenBtn,
        document.getElementById('backToLobbyBtn'),
        document.getElementById('ravePlayerOverlay'),
        document.getElementById('roomAccessBtn')
      ].filter(Boolean);
      elementsToControl.forEach(el => el.classList.add('fs-controls-hidden'));
      if (dom.stageContainer) dom.stageContainer.style.cursor = 'none';
    }
  });

  document.addEventListener('fullscreenchange', () => {
    resetControlsHideTimer();
  });
}

// Expose public API for deep linking & external control
window.loadRoomFromDeepLink = function(roomId) {
  if (!roomId) return;
  state.roomId = roomId.toUpperCase();
  switchToMyRoom();
  connectSignaling();
};
window.openRoomParticipantsModal = openRoomParticipantsModal;
window.closeRoomParticipantsModal = closeRoomParticipantsModal;
window.kickParticipant = kickParticipant;
window.setParticipantRole = setParticipantRole;
window.toggleCam = toggleCam;

// Start
document.addEventListener('DOMContentLoaded', initEvents);
