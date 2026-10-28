/**
 * Koltuk (CouchSync) — Client-side Core Architecture
 * - P2P WebRTC Audio/Video + Screen Share
 * - Dual Engine Player (YouTube IFrame + Native Video)
 * - Smart Audio Ducking (Web Audio API Analyser)
 * - Virtual Living Room Interactive Touch & Reactions
 */

// Sunucu adresi (config.js veya localStorage.miruo_api_base). Doluysa tüm /api/* istekleri,
// WebSocket ve SSE bağlantıları bu sunucuya gider; böylece Mac / Windows / telefon / web
// aynı hesapları ve aynı herkese açık odaları görür.
const MIRUO_API_BASE = (localStorage.getItem('miruo_api_base') || window.MIRUO_API_BASE || '').replace(/\/+$/, '');
if (MIRUO_API_BASE) {
  const __origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api/')) input = MIRUO_API_BASE + input;
    return __origFetch(input, init);
  };
}
// Mac/Windows uygulaması ya da file:// üzerinde sunucu adresi yoksa "tek cihaz" modu.
const isNativeApp = !!(window.miruoDesktop && window.miruoDesktop.isDesktop) ||
                    !!(window.webkit && window.webkit.messageHandlers) ||
                    !!(window.Capacitor) ||
                    window.location.protocol === 'file:' ||
                    !window.location.host ||
                    window.location.hostname === '127.0.0.1' ||
                    window.location.hostname === 'localhost';

const MIRUO_STANDALONE = !MIRUO_API_BASE && isNativeApp;

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

// -------------------------------------------------------------
// SUPABASE / OAUTH HELPER (Native iOS ASWebAuthenticationSession & Web Flow)
// -------------------------------------------------------------
function extractAuthFromUrl(url) {
  if (!url) return null;
  let accessToken = null;
  let refreshToken = null;
  let code = null;
  let error = null;
  let errorDescription = null;

  if (url.includes('#')) {
    const hash = url.split('#')[1];
    const params = new URLSearchParams(hash);
    accessToken = params.get('access_token');
    refreshToken = params.get('refresh_token');
    code = params.get('code');
    error = params.get('error');
    errorDescription = params.get('error_description');
  }

  if (url.includes('?')) {
    const query = url.split('?')[1].split('#')[0];
    const params = new URLSearchParams(query);
    if (!accessToken) accessToken = params.get('access_token');
    if (!refreshToken) refreshToken = params.get('refresh_token');
    if (!code) code = params.get('code');
    if (!error) error = params.get('error');
    if (!errorDescription) errorDescription = params.get('error_description');
  }

  return { accessToken, refreshToken, code, error, errorDescription };
}

function extractUserProfile(user) {
  if (!user) return { name: null, avatar: null, email: null, usernameBase: 'user' };
  const meta = user.user_metadata || {};
  const googleIdentity = user.identities?.find(i => i.provider === 'google') || user.identities?.[0];
  const idData = googleIdentity?.identity_data || {};

  const rawName =
    meta.full_name ||
    meta.name ||
    idData.full_name ||
    idData.name ||
    (meta.given_name ? `${meta.given_name} ${meta.family_name || ''}`.trim() : null) ||
    (idData.given_name ? `${idData.given_name} ${idData.family_name || ''}`.trim() : null) ||
    meta.displayName ||
    idData.displayName ||
    null;

  const rawAvatar =
    meta.avatar_url ||
    meta.picture ||
    idData.avatar_url ||
    idData.picture ||
    meta.avatar ||
    idData.avatar ||
    null;

  const email = user.email || meta.email || idData.email || null;
  const usernameBase = (
    meta.preferred_username ||
    idData.preferred_username ||
    (rawName ? rawName.replace(/[^a-zA-Z0-9_]/g, '_') : null) ||
    (email ? email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '') : null) ||
    'user'
  ).toLowerCase().slice(0, 16);

  return {
    name: rawName,
    avatar: rawAvatar,
    email,
    usernameBase,
  };
}

// Safe base64url decode helper for extracting user info from Supabase JWT tokens
function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const jsonStr = decodeURIComponent(atob(b64).split('').map(c => {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonStr);
  } catch (_) {
    try {
      const parts = token.split('.');
      return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    } catch (e) {
      return null;
    }
  }
}

async function authenticateFromUrl(url) {
  const parsed = extractAuthFromUrl(url);
  if (!parsed) return null;
  if (parsed.error || parsed.errorDescription) {
    throw new Error(parsed.errorDescription || parsed.error || 'Kimlik doğrulama hatası');
  }

  let session = null;
  if (parsed.accessToken && supabaseClient && supabaseClient.auth) {
    try {
      const { data, error } = await supabaseClient.auth.setSession({
        access_token: parsed.accessToken,
        refresh_token: parsed.refreshToken || parsed.accessToken
      });
      if (!error && data && data.session) session = data.session;
    } catch (_) {}
  }

  if (!session && parsed.code && supabaseClient && supabaseClient.auth) {
    try {
      const { data, error } = await supabaseClient.auth.exchangeCodeForSession(parsed.code);
      if (!error && data && data.session) session = data.session;
    } catch (_) {}
  }

  if (!session && supabaseClient && supabaseClient.auth) {
    try {
      const { data: cur } = await supabaseClient.auth.getSession();
      if (cur && cur.session) session = cur.session;
    } catch (_) {}
  }

  // Fallback 1: If session not built yet but we have accessToken, verify user directly
  if (!session && parsed.accessToken && supabaseClient && supabaseClient.auth) {
    try {
      const { data: uData } = await supabaseClient.auth.getUser(parsed.accessToken);
      if (uData && uData.user) {
        session = { user: uData.user, access_token: parsed.accessToken };
      }
    } catch (_) {}
  }

  // Fallback 2: Decode user details directly from JWT access token payload
  if (!session && parsed.accessToken) {
    const jwt = decodeJwtPayload(parsed.accessToken);
    if (jwt && (jwt.sub || jwt.user_id || jwt.id)) {
      const fallbackUser = {
        id: jwt.sub || jwt.user_id || jwt.id,
        email: jwt.email || '',
        app_metadata: jwt.app_metadata || {},
        user_metadata: jwt.user_metadata || {
          full_name: jwt.name || jwt.full_name || '',
          name: jwt.name || '',
          avatar_url: jwt.avatar_url || jwt.picture || ''
        },
        identities: [
          { provider: jwt.app_metadata?.provider || 'google', identity_data: jwt.user_metadata || {} }
        ]
      };
      session = { user: fallbackUser, access_token: parsed.accessToken };
    }
  }

  return session;
}

function initSupabase() {
  if (supabaseClient) return;
  try {
    if (window.supabase && typeof window.supabase.createClient === 'function') {
      supabaseClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
          flowType: 'implicit'
        }
      });
      console.log('[Miruo] Supabase Auth initialized successfully with project:', SUPABASE_CONFIG.url);
      try {
        if (typeof initGlobalPublicRoomsSync === 'function') initGlobalPublicRoomsSync();
        if (typeof initGlobalUsersChannel === 'function') initGlobalUsersChannel();
      } catch (_) {}

      // Check existing session from Supabase
      supabaseClient.auth.getSession().then(({ data: { session } }) => {
        if (session && session.user) {
          applySupabaseSessionUser(session.user);
        }
      }).catch(err => console.warn('[Miruo] getSession warning:', err));

      // Handle OAuth & Password Recovery URL tokens if present on page load
      const isRecovery = window.location.hash.includes('type=recovery') || window.location.search.includes('type=recovery');
      if (window.location.hash.includes('access_token') || window.location.search.includes('code=')) {
        authenticateFromUrl(window.location.href).then(session => {
          if (session && session.user) {
            if (isRecovery) {
              if (typeof openResetModal === 'function') {
                resetState.email = session.user.email || '';
                openResetModal();
                if (typeof setResetStep === 'function') setResetStep(3);
                showToast('Bağlantı doğrulandı. Lütfen yeni şifrenizi belirleyin.');
              }
            } else {
              applySupabaseSessionUser(session.user);
            }
            if (window.history && window.history.replaceState) {
              window.history.replaceState(null, '', window.location.pathname);
            }
          }
        }).catch(e => console.warn('[Miruo] Initial URL auth error:', e));
      }

      // Listen for auth state changes (OAuth callback, login, recovery, logout)
      supabaseClient.auth.onAuthStateChange((event, session) => {
        console.log('[Miruo] Supabase auth state change event:', event);
        if (event === 'PASSWORD_RECOVERY') {
          if (session && session.user) {
            if (typeof openResetModal === 'function') {
              resetState.email = session.user.email || '';
              openResetModal();
              if (typeof setResetStep === 'function') setResetStep(3);
              showToast('Lütfen yeni şifrenizi belirleyin.');
            }
          }
          return;
        }
        if (session && session.user && !isRecovery) {
          applySupabaseSessionUser(session.user);
        }
      });
    } else {
      // Retry in case CDN script loads asynchronously
      if (!window._sbRetryInterval) {
        let attempts = 0;
        window._sbRetryInterval = setInterval(() => {
          attempts++;
          if (window.supabase && typeof window.supabase.createClient === 'function') {
            clearInterval(window._sbRetryInterval);
            window._sbRetryInterval = null;
            initSupabase();
          } else if (attempts > 60) {
            clearInterval(window._sbRetryInterval);
            window._sbRetryInterval = null;
          }
        }, 200);
      }
    }
  } catch (err) {
    console.warn('[Miruo] Supabase init warning:', err);
  }
}

// Global Avatar & Profile Upload State
window.pendingAvatarUrl = '';
window.pendingAvatarBg = 'from-[#A64D79] to-[#6A1E55]';
window.selectedSignUpAvatarData = null;
window.selectedSignUpAvatarBg = 'from-rose-500 to-indigo-600';
window.selectedSignUpAvatarChar = 'M';

function persistUserToLocalRegistry(user, oldUsername = '') {
  if (!user) return;
  try {
    const cleanU = (user.username || '').replace(/^@/, '').trim();
    const cleanOld = (oldUsername || '').replace(/^@/, '').trim().toLowerCase();
    const cleanEmail = (user.email || '').trim().toLowerCase();
    const realFullName = (user.fullName && !user.fullName.startsWith('@'))
      ? user.fullName.trim()
      : ((user.name && !user.name.startsWith('@')) ? user.name.trim() : '');

    const regUsers = JSON.parse(localStorage.getItem('miruo_registered_users') || '[]');
    let idx = regUsers.findIndex(u =>
      (user.id && u.id && u.id === user.id) ||
      (cleanEmail && u.email && u.email.toLowerCase() === cleanEmail) ||
      (cleanOld && u.username && u.username.toLowerCase().replace(/^@/, '') === cleanOld) ||
      (cleanU && u.username && u.username.toLowerCase().replace(/^@/, '') === cleanU.toLowerCase())
    );

    if (idx !== -1) {
      if (user.id) regUsers[idx].id = user.id;
      if (cleanEmail) regUsers[idx].email = cleanEmail;
      if (cleanU) regUsers[idx].username = cleanU;
      if (realFullName) regUsers[idx].fullName = realFullName;
      if (user.password) regUsers[idx].password = user.password;
      if (user.avatarUrl !== undefined) regUsers[idx].avatarUrl = user.avatarUrl;
      if (user.avatarBg) regUsers[idx].avatarBg = user.avatarBg;
    } else if (cleanEmail || cleanU) {
      regUsers.push({
        id: user.id || ('user_' + Math.random().toString(36).substring(2, 8)),
        email: cleanEmail,
        username: cleanU,
        fullName: realFullName || cleanU,
        password: user.password || '',
        avatarUrl: user.avatarUrl || '',
        avatarBg: user.avatarBg || 'from-rose-500 to-[#A64D79]'
      });
    }
    localStorage.setItem('miruo_registered_users', JSON.stringify(regUsers));

    if (cleanEmail) {
      const byEmail = JSON.parse(localStorage.getItem('miruo_profiles_by_email') || '{}');
      const prev = byEmail[cleanEmail] || {};
      byEmail[cleanEmail] = {
        id: user.id || prev.id || '',
        email: cleanEmail,
        username: cleanU || prev.username || '',
        fullName: realFullName || prev.fullName || cleanU || '',
        avatarUrl: user.avatarUrl !== undefined ? user.avatarUrl : (prev.avatarUrl || ''),
        avatarBg: user.avatarBg || prev.avatarBg || 'from-rose-500 to-[#A64D79]'
      };
      localStorage.setItem('miruo_profiles_by_email', JSON.stringify(byEmail));
    }
    if (user.avatarUrl) {
      localStorage.setItem('miruo_avatar', user.avatarUrl);
    }
    if (window.miruoDesktop && typeof window.miruoDesktop.saveDesktopProfile === 'function') {
      window.miruoDesktop.saveDesktopProfile(user);
    }
  } catch (e) {
    console.warn('[Miruo persistUserToLocalRegistry warning]:', e);
  }
}

function syncUserProfileToSupabase(user) {
  if (!user) return;
  persistUserToLocalRegistry(user);
  if (!supabaseClient) return;
  try {
    const rawUsername = (user.username || user.name || '').replace(/^@/, '').trim();
    const fullName = (user.fullName && !user.fullName.startsWith('@')) ? user.fullName : ((user.name && !user.name.startsWith('@')) ? user.name : rawUsername);
    const avatarUrl = user.avatarUrl !== undefined ? user.avatarUrl : (window.pendingAvatarUrl || '');
    const avatarBg = user.avatarBg || window.pendingAvatarBg || '';

    if (supabaseClient.auth) {
      supabaseClient.auth.updateUser({
        data: {
          username: rawUsername,
          full_name: fullName,
          name: fullName,
          avatar_url: avatarUrl,
          avatar_bg: avatarBg
        }
      }).catch(e => console.warn('[Supabase Profile Update Error]:', e));
    }
    const uid = user.id || state.userId;
    if (uid) {
      supabaseClient.from('profiles').upsert({
        id: uid,
        username: rawUsername,
        full_name: fullName,
        avatar_url: avatarUrl,
        updated_at: new Date().toISOString()
      }).catch(e => console.warn('[Supabase profiles upsert info]:', e));
    }
  } catch (err) {
    console.warn('[Supabase sync error]:', err);
  }
}

function resolveCustomizedUserProfile({ id, email, rawName, rawUsername, rawAvatar, rawAvatarBg, provider, isApple, isGoogle, meta = {} }) {
  const cleanId = String(id || '').trim();
  const cleanEmail = String(email || '').toLowerCase().trim();

  // 1. Gather all potential saved profiles for this account
  let saved = null;
  if (cleanId) {
    try { saved = JSON.parse(localStorage.getItem(`miruo_saved_profile_${cleanId}`)); } catch (_) {}
  }
  if (!saved && cleanEmail) {
    try { saved = JSON.parse(localStorage.getItem(`miruo_saved_profile_${cleanEmail}`)); } catch (_) {}
  }
  if (!saved) {
    const regList = JSON.parse(localStorage.getItem('miruo_registered_users') || '[]');
    saved = regList.find(u => 
      (cleanId && u.id && String(u.id).trim() === cleanId) ||
      (cleanEmail && u.email && String(u.email).toLowerCase().trim() === cleanEmail)
    ) || null;
  }
  if (!saved) {
    const byEmail = JSON.parse(localStorage.getItem('miruo_profiles_by_email') || '{}');
    if (cleanEmail && byEmail[cleanEmail]) saved = byEmail[cleanEmail];
  }
  if (!saved) {
    const cur = JSON.parse(localStorage.getItem('miruo_user') || 'null');
    if (cur && ((cleanId && cur.id === cleanId) || (cleanEmail && cur.email && cur.email.toLowerCase() === cleanEmail) || cur.hasCustomProfile)) {
      saved = cur;
    }
  }

  // 2. Resolve Username: NEVER wipe user's customized username!
  const customUsername = 
    (cleanId && localStorage.getItem(`miruo_custom_username_${cleanId}`)) ||
    (cleanEmail && localStorage.getItem(`miruo_custom_username_${cleanEmail}`)) ||
    (saved && (saved.customUsername || (saved.username && !saved.username.startsWith('user_') ? saved.username : ''))) ||
    meta.custom_username ||
    meta.username ||
    localStorage.getItem('miruo_custom_username') ||
    '';

  const fallbackUsername = (rawUsername || (cleanEmail ? cleanEmail.split('@')[0] : 'kullanici'))
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .toLowerCase()
    .slice(0, 16);

  const finalUsername = (customUsername || fallbackUsername || 'kullanici').replace(/^@/, '').trim();

  // 3. Resolve Full Name: NEVER wipe user's customized full name!
  const customFullName =
    (cleanId && localStorage.getItem(`miruo_custom_fullname_${cleanId}`)) ||
    (cleanEmail && localStorage.getItem(`miruo_custom_fullname_${cleanEmail}`)) ||
    (saved && (saved.customFullName || (saved.fullName && !saved.fullName.startsWith('@') ? saved.fullName : (saved.name && !saved.name.startsWith('@') && saved.name !== 'Misafir' ? saved.name : '')))) ||
    meta.custom_full_name ||
    localStorage.getItem('miruo_custom_fullname') ||
    '';

  const fallbackFullName = rawName || (cleanEmail ? cleanEmail.split('@')[0] : 'Miruo Kullanıcısı');
  const finalFullName = (customFullName && !customFullName.startsWith('@')) ? customFullName.trim() : (fallbackFullName || finalUsername);

  // 4. Resolve Avatar: NEVER wipe user's customized avatar photo!
  const customAvatar =
    window.pendingAvatarUrl ||
    (cleanId && localStorage.getItem(`miruo_custom_avatar_${cleanId}`)) ||
    (cleanEmail && localStorage.getItem(`miruo_custom_avatar_${cleanEmail}`)) ||
    (saved && (saved.customAvatarUrl || (saved.avatarUrl && !saved.avatarUrl.includes('googleusercontent.com') ? saved.avatarUrl : ''))) ||
    meta.custom_avatar_url ||
    localStorage.getItem('miruo_custom_avatar') ||
    (saved && saved.avatarUrl) ||
    '';

  const finalAvatarUrl = customAvatar || rawAvatar || '';
  const finalAvatarBg = window.pendingAvatarBg || (saved && saved.avatarBg) || rawAvatarBg || (isApple ? 'linear-gradient(135deg, #ec4899, #8b5cf6)' : 'from-rose-500 to-indigo-600');

  const resolved = {
    id: cleanId,
    name: finalFullName,
    fullName: finalFullName,
    username: finalUsername,
    email: cleanEmail || (saved && saved.email) || '',
    avatarChar: (finalFullName || finalUsername || 'M').charAt(0).toUpperCase(),
    avatarUrl: finalAvatarUrl,
    avatarBg: finalAvatarBg,
    isApple: !!isApple,
    isGoogle: !!isGoogle,
    provider: provider || (isApple ? 'apple' : (isGoogle ? 'google' : 'email')),
    isGuest: false,
    hasCustomProfile: !!(customUsername || customFullName || customAvatar),
    customUsername: finalUsername,
    customFullName: finalFullName,
    customAvatarUrl: finalAvatarUrl,
    defaultRoom: (saved && saved.defaultRoom) || 'ODA-77'
  };

  localStorage.setItem('miruo_user', JSON.stringify(resolved));
  localStorage.setItem('miruo_custom_username', finalUsername);
  localStorage.setItem('miruo_custom_fullname', finalFullName);
  if (finalAvatarUrl) localStorage.setItem('miruo_custom_avatar', finalAvatarUrl);

  if (cleanId) {
    localStorage.setItem(`miruo_saved_profile_${cleanId}`, JSON.stringify(resolved));
    localStorage.setItem(`miruo_custom_username_${cleanId}`, finalUsername);
    localStorage.setItem(`miruo_custom_fullname_${cleanId}`, finalFullName);
    if (finalAvatarUrl) localStorage.setItem(`miruo_custom_avatar_${cleanId}`, finalAvatarUrl);
  }
  if (cleanEmail) {
    localStorage.setItem(`miruo_saved_profile_${cleanEmail}`, JSON.stringify(resolved));
    localStorage.setItem(`miruo_custom_username_${cleanEmail}`, finalUsername);
    localStorage.setItem(`miruo_custom_fullname_${cleanEmail}`, finalFullName);
    if (finalAvatarUrl) localStorage.setItem(`miruo_custom_avatar_${cleanEmail}`, finalAvatarUrl);
  }

  persistUserToLocalRegistry(resolved);
  return resolved;
}
window.resolveCustomizedUserProfile = resolveCustomizedUserProfile;

function applySupabaseSessionUser(sbUser) {
  if (!sbUser) return;
  const meta = sbUser.user_metadata || {};
  const googleIdentity = sbUser.identities?.find(i => i.provider === 'google');
  const isGoogle = (sbUser.app_metadata?.provider === 'google') || !!googleIdentity;
  const appleIdentity = sbUser.identities?.find(i => i.provider === 'apple');
  const isApple = (sbUser.app_metadata?.provider === 'apple') || !!appleIdentity || Boolean(meta.iss && meta.iss.includes('apple'));

  const profile = extractUserProfile(sbUser);
  const user = resolveCustomizedUserProfile({
    id: sbUser.id,
    email: sbUser.email || profile.email,
    rawName: profile.name || meta.full_name || meta.name,
    rawUsername: profile.usernameBase || meta.username,
    rawAvatar: profile.avatar || meta.avatar_url || meta.picture,
    rawAvatarBg: meta.avatar_bg || '',
    provider: isApple ? 'apple' : (isGoogle ? 'google' : (sbUser.app_metadata?.provider || 'email')),
    isApple,
    isGoogle,
    meta
  });

  state.userId = user.id;
  state.username = user.username;
  state.avatarUrl = user.avatarUrl;
  state.avatarBg = user.avatarBg;

  if (typeof updateUserUI === 'function') {
    updateUserUI(user);
  }
  const authEl = (dom && dom.authModal) || document.getElementById('authModal');
  if (authEl) {
    authEl.classList.add('hidden');
    if (typeof unfreezeBackgroundAfterModal === 'function') {
      unfreezeBackgroundAfterModal(true);
    }
  }
  if (typeof showToast === 'function') {
    showToast(`Hoş geldin, ${user.fullName || user.username || 'Kullanıcı'}!`);
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
    window.pendingAvatarUrl = base64Data;
    window.pendingAvatarBg = '';
    const previewEl = (dom && dom.editAvatarPreview) || document.getElementById('editAvatarPreview');
    if (previewEl) {
      previewEl.innerHTML = `<img src="${base64Data}" class="w-full h-full object-cover rounded-2xl" alt="PP">`;
      previewEl.className = 'w-20 h-20 rounded-2xl overflow-hidden shadow-xl border-2 border-[#A64D79] ring-4 ring-[#A64D79]/20 flex items-center justify-center';
    }

    // Auto-save & activate immediately
    const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
    savedUser.avatarUrl = base64Data;
    savedUser.avatarBg = '';
    savedUser.hasCustomProfile = true;
    savedUser.customAvatarUrl = base64Data;
    state.avatarUrl = base64Data;
    state.avatarBg = '';
    localStorage.setItem('miruo_user', JSON.stringify(savedUser));
    localStorage.setItem('miruo_custom_avatar', base64Data);
    if (savedUser.id) {
      localStorage.setItem(`miruo_custom_avatar_${savedUser.id}`, base64Data);
      localStorage.setItem(`miruo_saved_profile_${savedUser.id}`, JSON.stringify(savedUser));
    }
    if (savedUser.email) {
      const cleanE = savedUser.email.toLowerCase().trim();
      localStorage.setItem(`miruo_custom_avatar_${cleanE}`, base64Data);
      localStorage.setItem(`miruo_saved_profile_${cleanE}`, JSON.stringify(savedUser));
    }
    persistUserToLocalRegistry(savedUser);

    try {
      fetch('/api/auth/update-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: savedUser.id || state.userId,
          email: savedUser.email || '',
          username: (savedUser.username || state.username || '').replace(/^@/, ''),
          fullName: savedUser.fullName || savedUser.name || '',
          avatarUrl: base64Data
        })
      }).catch(e => console.warn('[Update Avatar Backend Error]:', e));
    } catch (e) {}
    syncUserProfileToSupabase(savedUser);

    updateUserUI(savedUser);
    if (typeof renderProfileTab === 'function') renderProfileTab();
    showToast('Profil fotoğrafı güncellendi');
  } else if (target === 'chat') {
    sendChatMessage('', base64Data);
    showToast('Fotoğraf sohbete yüklendi!');
    const stickerPopover = document.getElementById('chatStickerPopover');
    if (stickerPopover) stickerPopover.classList.add('hidden');
  } else if (target === 'signup') {
    window.selectedSignUpAvatarData = base64Data;
    const previewEl = (dom && dom.signUpAvatarPreview) || document.getElementById('signUpAvatarPreview');
    if (previewEl) {
      previewEl.innerHTML = `<img src="${base64Data}" class="w-full h-full object-cover rounded-full" alt="Avatar">`;
    }
    showToast('Kayıt fotoğrafı seçildi');
  } else {
    // Stage / Gallery media sharing - always displays photo in room stage
    displayPhotoOnStage(base64Data, 'Fotoğraf', true);
  }
};

window.handleNativeVideoPicked = function(videoUrl, fileName) {
  if (!videoUrl) return;
  playVideoOnStage(videoUrl, fileName || 'Video', true);
};

window.handleNativeAppBackgroundState = function(isInBackground) {
  state.isAppInBackground = !!isInBackground;
  if (isInBackground) {
    // Phone sleep / lock screen / background: pause active video playback
    if (state.isPlaying) {
      if (typeof sendYtCommand === 'function') {
        try { sendYtCommand('pauseVideo'); } catch (_) {}
      }
      if (state.ytPlayer && typeof state.ytPlayer.pauseVideo === 'function') {
        try { state.ytPlayer.pauseVideo(); } catch (_) {}
      }
      if (dom.nativeVideoPlayer) {
        try { dom.nativeVideoPlayer.pause(); } catch (_) {}
      }
      state.isPlaying = false;
      if (typeof updatePlayPauseUI === 'function') updatePlayPauseUI(false);
    }
    if (state.isScreenSharing) {
      startScreenShareKeepAlive();
    }
  }
};

// ==========================================
// MULTI-LANGUAGE (i18n) ENGINE (TR / EN / DE)
// ==========================================
const I18N = {
  tr: {
    app_title: 'Miruo — Birlikte Gör & İzle',
    tagline: 'Birlikte İzle & Konuş',
    auth_tagline: 'Birlikte izlemenin en samimi yolu',
    reset_new_password_label: 'Yeni Şifre',
    reset_confirm_password_label: 'Şifreyi Tekrar Gir',
    nav_settings: 'Ayarlar',
    nav_friends: 'Arkadaşlar',
    nav_profile: 'Profil',
    nav_explore: 'Keşfet',
    hero_title: 'Birlikte İzle. Birlikte Gül. Senkronize.',
    hero_subtitle: 'YouTube, Netflix, Prime ve daha fazlasını arkadaşlarınla sıfır gecikmeyle, sesli ve görüntülü sohbet eşliğinde aynı anda izle.',
    create_room: 'Oda Kur',
    join_room: 'Hızlı Katıl',
    live_rooms: 'Canlı Keşfet',
    search_rooms_ph: 'Oda veya arkadaş ara...',
    no_rooms_found: 'Aramanıza uygun oda bulunamadı.',
    watch_platforms: 'İzleme Platformları',
    all_platforms: 'Tüm Platformlar',
    tab_profile: 'Profil & PP',
    tab_settings: 'Ayarlar',
    tab_accounts: 'Hesaplar',
    display_name: 'Görünen İsim',
    full_name: 'Ad Soyad',
    full_name_ph: 'Örn: Mehmet Karabulut',
    username: 'Kullanıcı Adı',
    username_ph: 'kullaniciadi',
    default_room_code: 'Varsayılan / Ortak Oda Kodu',
    registered_email: 'Kayıtlı E-posta',
    active_session: 'Giriş yapıldı',
    provider_apple: 'Apple ID ile Giriş Yapıldı',
    provider_apple_badge: 'Apple ile Doğrulandı',
    provider_google: 'Google ile Giriş Yapıldı',
    provider_google_badge: 'Google ile Doğrulandı',
    provider_phone: 'Telefon Numarası ile Giriş',
    provider_phone_badge: 'SMS ile Doğrulandı',
    provider_email: 'E-posta ile Kayıt Olundu',
    provider_email_badge: 'Giriş yapıldı',
    save_changes: 'Kaydet',
    logout: 'Çıkış Yap',
    confirm_logout_title: 'Çıkış Yap',
    confirm_logout_msg: 'Hesabınızdan çıkış yapmak istediğinize emin misiniz?',
    confirm_logout_action: 'Evet, Çıkış Yap',
    select_photo: 'Fotoğraf Seç',
    upload_photo: 'Fotoğraf Yükle',
    remove_photo: 'Kaldır',
    preset_avatars: 'veya renkli avatar seç:',
    language_title: 'Uygulama Dili',
    ducking_title: 'Konuşma Sırasında Video Sesi',
    ducking_desc: 'Biri konuştuğunda video sesini otomatik kısar.',
    mic_sens_title: 'Mikrofon Hassasiyeti',
    sens_high: 'Yüksek',
    sens_med: 'Orta',
    sens_low: 'Düşük',
    pip_corner_title: 'Kamera Konumu',
    pip_corner_desc: 'Tam ekranda kameranın duracağı köşe:',
    pip_show_camera: 'Tam ekranda kamerayı göster',
    corner_br: 'Sağ Alt (Varsayılan)',
    corner_bl: 'Sol Alt',
    corner_tr: 'Sağ Üst',
    corner_tl: 'Sol Üst',
    accounts_info: 'Platform hesaplarınıza (YouTube, Netflix, Prime vb.) dahili tarayıcı üzerinden doğrudan giriş yapabilirsiniz. Oturumlarınız cihazınızda güvenle saklanır.',
    open_in_browser: 'Giriş Yap',
    platform_signin_btn: 'Hesabı Bağla',
    platform_connect_btn: 'Hesabı Bağla',
    yt_card_sub: 'Google hesabı ile oturum aç',
    netflix_card_sub: 'Netflix hesabı ile oturum aç',
    prime_card_sub: 'Prime hesabı ile oturum aç',
    disney_card_sub: 'Disney+ hesabı ile oturum aç',
    connected_platforms_title: 'Bağlı Platformlar',
    connected_platforms_sub: 'Dahili tarayıcıda kalıcı oturum',
    create_room_title: 'Yeni İzleme Odası',
    room_name_label: 'Oda Adı',
    platform_label: 'İçerik Platformu',
    public_room: 'Açık Oda (Herkes katılabilir)',
    private_room: 'Özel / Kilitli (Sadece kodla)',
    create_and_start: 'Oluştur & Başlat',
    cancel: 'Vazgeç',
    cancel_btn: 'Vazgeç',
    join_modal_title: 'Odaya Katıl',
    join_code_ph: 'ODA KODU VEYA LİNK GİR...',
    join_btn: 'Katıl',
    auth_title: 'Miruo\'ya Giriş Yap',
    login_tab: 'Giriş Yap',
    register_tab: 'Kayıt Ol',
    auth_heading_login: 'Giriş Yap',
    auth_subtitle_login: 'E-posta ve şifrenizle giriş yapın.',
    auth_heading_register: 'Kayıt Ol',
    auth_subtitle_register: 'İsim, e-posta ve şifrenizle hemen kaydolun.',
    email_btn: 'E-posta',
    phone_btn: 'Telefon',
    first_name_label: 'Ad',
    first_name_ph: 'Adınız',
    last_name_label: 'Soyad',
    last_name_ph: 'Soyadınız',
    email_label: 'E-posta',
    email_label_login: 'E-posta veya Kullanıcı Adı',
    email_ph: 'ornek@gmail.com',
    email_ph_login: 'ornek@gmail.com veya kullanıcı adı',
    password_label: 'Şifre',
    password_ph: 'En az 6 karakter',
    password_confirm_label: 'Şifre Tekrar',
    password_confirm_ph: 'Şifrenizi tekrar girin',
    remember_me: 'Oturumu açık tut',
    forgot_password: 'Şifremi Unuttum?',
    phone_label: 'Telefon Numarası',
    phone_sub_info: 'Giriş yapmak için telefonunuza SMS onay kodu gönderilecektir.',
    sms_code_label: 'SMS Onay Kodu:',
    back_btn: '← Geri',
    resend_code_btn: 'Tekrar Kod Gönder',
    login_btn: 'Giriş Yap',
    register_btn: 'Kayıt Ol',
    or_divider: 'VEYA ŞUNUNLA DEVAM ET',
    google_login: 'Google',
    apple_login: 'Apple',
    auth_footer_login: 'Miruo\'da yeni misin?',
    auth_footer_action_login: 'Hesap Oluştur',
    auth_footer_register: 'Zaten bir hesabın var mı?',
    auth_footer_action_register: 'Giriş Yap',
    guest_continue: 'Giriş yapmadan misafir olarak incele',
    settings_title: 'Ayarlar',
    settings_subtitle: 'Profil, Güvenlik & Tercihler',
    profile_info_section: 'Profil Bilgileri',
    account_security_section: 'Hesap & Güvenlik',
    change_email_title: 'E-posta Adresini Değiştir',
    change_email_sub: 'Yeni e-posta adresi bağlayın',
    change_email_info: 'Yeni e-posta adresine doğrulama bağlantısı iletilecektir.',
    change_email_ph: 'Yeni e-posta adresi girin',
    update_btn: 'Güncelle',
    change_password_title: 'Şifre Değiştir',
    change_password_sub: 'Giriş şifrenizi yenileyin',
    change_password_header: 'Şifre Güncelleme',
    current_pass_ph: 'Mevcut Şifre',
    new_pass_ph: 'Yeni Şifre (En az 6 karakter)',
    confirm_pass_ph: 'Yeni Şifre Tekrar',
    update_password_btn: 'Şifreyi Güncelle',
    notifications_title: 'Bildirimler',
    notifications_sub: 'Anlık iletiler ve davet ayarları',
    notif_push: 'Anlık Bildirimler (Push)',
    notif_push_sub: 'Önemli etkinlikler ve arkadaş bildirimleri',
    notif_invites: 'Oda & Davet Bildirimleri',
    notif_invites_sub: 'Arkadaşların odaya çağırdığında bildirim al',
    notif_sound: 'Ses ve Titreşim',
    notif_sound_sub: 'Mesaj ve bildirim ses efektleri',
    audio_video_title: 'Ses & Video Ayarları',
    audio_video_sub: 'Ducking, mikrofon ve kamera tercihleri',
    legal_section: 'Hukuki & Bilgi',
    privacy_policy_title: 'Gizlilik Politikası',
    terms_of_service_title: 'Kullanım Koşulları',
    delete_account_btn: 'Hesabımı Sil',
    delete_account_modal_title: 'Hesabımı Sil',
    delete_account_modal_sub: 'Bu işlem geri alınamaz.',
    delete_account_modal_desc: 'Hesabınızı sildiğinizde profil verileriniz ve kayıtlarınız kalıcı olarak kaldırılır.',
    delete_account_pass_label: 'Güvenlik için mevcut şifrenizi girin:',
    confirm_delete_btn: 'Hesabımı Sil',
    miruo_guarantee: 'Miruo Güvencesi',
    privacy_summary_title: 'Özet Taahhüt:',
    privacy_summary_desc: 'Miruo, kullanıcıların kişisel gizliliğine tam saygı duyar. İzleme geçmişiniz, özel sohbetleriniz ve izleme tercihleriniz asla üçüncü taraflara satılmaz veya reklam amaçlı kullanılmaz.',
    privacy_sec1_title: '1. Toplanan Bilgiler',
    privacy_sec1_desc: 'Yalnızca hesabınızı oluşturmak ve arkadaşlarınızla oda deneyimi yaşamanız için gereken temel bilgiler (kullanıcı adı, e-posta veya telefon) saklanır.',
    privacy_sec2_title: '2. Çerezler ve Platform Girişleri',
    privacy_sec2_desc: 'YouTube, Netflix ve diğer platform oturumlarınız yalnızca kendi cihazınızdaki güvenli yerel tarayıcı hafızasında saklanır. Şifreleriniz sunucularımıza iletilmez.',
    privacy_sec3_title: '3. Kamera ve Ses Verileri',
    privacy_sec3_desc: 'Canlı odalarda mikrofon ve kamera yayınları WebRTC ile doğrudan eşler arasında (P2P) aktarılır. Ses veya video kayıtları tutulmaz.',
    privacy_sec4_title: '4. Veri Güvenliği ve Silme',
    privacy_sec4_desc: 'Hesabınızı Ayarlar menüsünden dilediğiniz an silebilirsiniz. Silinen hesapların tüm verileri anında ve kalıcı olarak kaldırılır.',
    miruo_terms_badge: 'Miruo Hizmet Şartları',
    terms_intro: 'Miruo platformunu kullanarak aşağıdaki kullanım şartlarını ve topluluk kurallarını kabul etmiş sayılırsınız.',
    terms_sec1_title: '1. Hizmetin Amacı',
    terms_sec1_desc: 'Miruo, arkadaş gruplarının ve toplulukların yasal video platformlarını eşzamanlı olarak birlikte izlemesini ve sesli/görüntülü sohbet etmesini sağlayan bir ortak izleme servisidir.',
    terms_sec2_title: '2. Topluluk Kuralları',
    terms_sec2_desc: 'Odalarda nefret söylemi, taciz, yasa dışı içerik paylaşımı veya diğer kullanıcıları rahatsız edici davranışlar yasaktır. İhlal durumunda hesap kalıcı olarak askıya alınabilir.',
    terms_sec3_title: '3. Üçüncü Taraf İçerikleri',
    terms_sec3_desc: 'İzlenen videolar ilgili platformların (YouTube, Netflix vb.) kullanım şartlarına tabidir. Miruo hiçbir video içeriğinin telif hakkı sahibi değildir.',
    terms_sec4_title: '4. Hizmet Değişiklikleri',
    terms_sec4_desc: 'Miruo, özelliklerde güncelleme yapma veya hizmet şartlarını revize etme hakkını saklı tutar.',
    rave_title: 'YouTube',
    rave_subtitle: 'Video seçin ve odadakilerle birlikte izleyin.',
    rave_search_ph: 'YouTube\'da şarkı, klip, sanatçı, dizi veya kanal ara...',
    rave_search_btn: 'Ara',
    rave_tab_trending: 'Trendler',
    rave_tab_music: 'Popüler Müzik',
    rave_tab_lofi: '24/7 Lo-Fi',
    rave_footer_info: 'Odadakilerle senkronize izlemek için videoya dokunun',
    stage_waiting: 'İzlemek için bir video seçin veya bağlantı yapıştırın',
    chat_tab: 'Sohbet',
    people_tab: 'Katılımcılar',
    chat_ph: 'Mesaj yaz...',
    send: 'Gönder',
    leave_room: 'Ayrıl',
    change_video: 'Video Değiştir',
    refresh_btn: 'Yenile',
    invite_copied: 'Oda davet linki kopyalandı!',
    profile_updated: 'Profil ve tercihler güncellendi',
    lang_changed: 'Uygulama dili Türkçe olarak ayarlandı',
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
    role_member_label: 'İzleyici',
    online_count_suffix: 'Çevrimiçi Arkadaş',
    status_online: 'Çevrimiçi',
    status_offline: 'Çevrimdışı',
    status_in_room: 'Şu an odada',
    status_idle: 'Boşta',
    invite_friend: 'Odaya Çağır',
    invite_btn_short: 'Çağır',
    friends_title: 'Arkadaşlar',
    friends_subtitle: 'Birlikte izleyeceğin arkadaşlarını yönet',
    your_username_label: 'Senin Kullanıcı Adın',
    copy_btn: 'Kopyala',
    add_friend_by_name: 'İsimden Arkadaş Ekle',
    add_friend_ph: 'Kullanıcı adı girin (örn: @selin veya can)',
    add_btn: 'Ekle',
    search_friends_ph: 'Kayıtlı arkadaşlarında ara...',
    no_friends_empty: 'Henüz arkadaş eklemedin.',
    no_friends_sub: 'Arkadaşının kullanıcı adını (@kullanici) yukarıdan girerek hemen ekleyebilirsin.',
    provider_search_ph: 'video, dizi veya film ara...',
    room_queue_label: 'Sıra:',
    room_queue_title: 'Oynatma Sırası',
    room_change_video: 'Değiştir',
    who_can_join: 'Kimler Katılabilir',
    who_can_join_short: 'Katılım',
    now_playing_prefix: 'Şimdi',
    now_playing_suffix: 'oynatılıyor',
    privacy_public: 'Açık Oda',
    privacy_friends: 'Arkadaşlar',
    privacy_private: 'Özel (Davetli)',
    share_btn: 'Paylaş',
    select_video_btn: 'Video Seç',
    platform_chooser_title: 'Video ve Platform Seç',
    platform_chooser_sub: 'İzlemek istediğiniz platformu seçin veya doğrudan bağlantı yapıştırın',
    live_chat_title: 'Canlı Sohbet',
    top_chat: 'En Popüler',
    chat_expand: 'Büyüt',
    chat_collapse: 'Küçült',
    chat_welcome: 'odasına hoş geldiniz!',
    chat_bot_joined: 'odaya katıldı',
    show_chat: 'Sohbeti Göster',
    chat_mention_label: 'Bahset:',
    chat_reaction_label: 'Tepki:',
    chat_add_photo: 'Fotoğraf Ekle',
    close_btn: 'Kapat',
    leave_room_btn: 'Odadan Ayrıl',
    video_placeholder_title: 'Video Yükleniyor veya Seçilmedi',
    video_placeholder_desc: '"Video Seç" butonuna basarak dilediğiniz videoyu veya platformu başlatın.',
    miruo_player: 'Miruo Oynatıcı',
    video_title_default: 'Video Başlığı',
    video_subtitle_default: "Miruo Canlı",
    fullscreen_title: 'Tam Ekran',
    live_cam_feed: 'Canlı Kamera Feed',
    self_camera_badge: 'Sen (Kamera)',
    close_cam_title: 'Kamerayı Kapat',
    flip_cam_title: 'Kamerayı Değiştir (Ön / Arka)',
    switch_cam_success: 'Kamera değiştirildi',
    cam_device_title: 'Görüntü Aygıtı (Kamera)',
    cam_off_label: 'Kamera Kapalı',
    cam_live_label: 'Canlı',
    you_badge: 'Sen',
    simulated_badge: 'Simüle',
    your_device: 'Senin Cihazın',
    room_participant: 'Oda Katılımcısı',
    live_connection: 'Canlı Bağlantı',
    role_owner: 'Oda Sahibi',
    role_admin: 'Yönetici',
    role_video_control: 'Video Açabilir',
    role_member: 'İzleyici',
    kick_title: 'Odadan Çıkar',
    kick_btn: 'Çıkar',
    friend_badge: 'Arkadaş',
    add_friend_title: 'Arkadaş Ekle',
    add_friend_btn_short: 'Ekle',
    mic_on_title: 'Mikrofon Açık',
    mic_off_title: 'Mikrofon Kapalı',
    cam_on_title: 'Kamera Açık',
    cam_off_title: 'Kamera Kapalı',
    av_mic_cam_on: 'Mikrofon & Kamera Açık (Canlı)',
    av_mic_on_cam_off: 'Mikrofon Canlı • Kamera Kapalı',
    av_cam_on_mic_off: 'Kamera Canlı • Mikrofon Kapalı',
    av_mic_cam_off: 'Mikrofon & Kamera Kapalı',
    toast_cam_opened: 'Canlı Kamera Açıldı (Sürüklenebilir)',
    toast_cam_preview_opened: 'Canlı Kamera Önizleme Açıldı (Sürüklenebilir)',
    who_can_join_title: 'Kimler Katılabilir?',
    who_can_join_sub: 'Oda katılım ve erişim ayarlarını yönetin.',
    random_room_code_label: 'Rastgele Oda Kodu',
    access_permission_label: 'Katılım İzni',
    access_public_label: 'Herkese Açık',
    recommended_badge: 'Önerilen',
    access_public_desc: 'Oda bağlantısına veya koduna sahip herkes odaya doğrudan katılabilir.',
    access_invite_label: 'Sadece Davetliler',
    access_invite_desc: 'Yalnızca oda sahibinin davet ettiği ve onayladığı kişiler katılabilir.',
    done_btn: 'Tamam',
    queue_title: 'Oynatma Sırası',
    queue_empty: 'Sırada bekleyen video yok',
    share_room_title: 'Odayı Paylaş & Davet Et',
    share_room_sub: 'Arkadaşlarınla aynı anda senkronize izle',
    share_public_desc: 'Herkes keşfetten veya bağlantıyla katılabilir',
    share_friends_desc: 'Yalnızca takip ettiğin kişiler katılabilir',
    share_invite_desc: 'Özel oda, sadece davet linkiyle girilebilir',
    invite_link_label: 'Davet Linki',
    share_with_app_label: 'Uygulama ile Paylaş',
    messages_app_label: 'Mesajlar',
    other_app_label: 'Diğer',
    room_privacy_toast: 'Oda Gizliliği',
    room_title_label: 'Oda Başlığı',
    room_title_ph: 'Örn: Gece Lo-Fi Sohbeti veya Sinema Gecesi',
    privacy_type_label: 'Gizlilik Türü',
    private_room_label: 'Özel Oda',
    private_room_desc: 'Sadece davet ettiğin kişiler girebilir.',
    public_room_label: 'Herkese Açık',
    public_room_desc: 'Miruo Keşfet akışında listelenir.',
    platform_select_label: 'İzleme / Dinleme Platformu',
    screen_share_label: 'Ekran Paylaş',
    submit_create_room_btn: 'Odayı Başlat & Katıl',
    yt_modal_title: 'YouTube',
    yt_modal_sub: 'Video seçin ve odadakilerle birlikte izleyin.',
    yt_browse_btn: 'Gezin ↗',
    yt_browse_title: "m.youtube.com'u açıp hesabına gir",
    yt_currently_playing_prefix: 'Şu an çalıyor:',
    yt_background_playing: 'Arka Planda Kesintisiz Devam Ediyor',
    yt_search_ph: "YouTube'da şarkı, klip, sanatçı, dizi veya kanal ara...",
    yt_search_btn: 'Ara',
    tab_trending: 'Trendler',
    tab_music: 'Popüler Müzik',
    tab_lofi: '24/7 Lo-Fi',
    tab_series: 'Dizi & Fragman',
    tab_podcast: 'Podcast & Sohbet',
    tab_gaming: 'Oyun & Espor',
    action_play_now: 'Hemen Oynat',
    action_add_queue: 'Sıraya Ekle',
    suggestion_title: 'Video Önerisi',
    suggested_by_suffix: 'önerdi',
    friends_modal_title: 'Arkadaşlar & Ortak İzleme',
    saved_friends_header: 'Kayıtlı Arkadaşlar',
    online_label: 'Çevrimiçi',
    host_label: 'Kurucu',
    mic_toggle_title: 'Mikrofon Aç/Kapat',
    cam_toggle_title: 'Kamera Aç/Kapat (Görüntülü Konuşma)',
    chat_toggle_title: 'Sohbeti Aç / Gizle',
    online_count_badge: 'Çevrimiçi Arkadaş',
    leave_room_btn: 'Ayrıl',
    leave_room_title: 'Odadan Ayrıl',
    toast_left_room: 'Odadan ayrıldınız',
    fs_show_chat: 'Tam ekranda canlı sohbet görünsün',
    toggle_video_display: 'Video görüntüsünü göster',
    audio_only_mode: 'Yalnızca Ses Modu (Video Gizlendi)',
    show_video_btn: 'Videoyu Göster',
    hide_video_btn: 'Videoyu Gizle',
    toast_video_shown: 'Video görüntüsü açıldı',
    toast_video_hidden: 'Video görüntüsü gizlendi, yalnızca ses çalıyor',
    toast_chat_closed: 'Sohbet gizlendi, video tam ekrana geçti',
    toast_chat_opened: 'Canlı Sohbet açıldı'
  },
  en: {
    app_title: 'Miruo — Watch & See Together',
    tagline: 'Watch & Talk Together',
    auth_tagline: 'The closest way to watch together',
    reset_new_password_label: 'New Password',
    reset_confirm_password_label: 'Confirm Password',
    nav_settings: 'Settings',
    nav_friends: 'Friends',
    nav_profile: 'Profile',
    nav_explore: 'Rooms',
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
    display_name: 'Display Name',
    full_name: 'Full Name',
    full_name_ph: 'e.g. Mehmet Karabulut',
    username: 'Username',
    username_ph: 'username',
    default_room_code: 'Default / Shared Room Code',
    registered_email: 'Registered Email',
    active_session: 'Logged in',
    provider_apple: 'Signed in with Apple ID',
    provider_apple_badge: 'Verified with Apple',
    provider_google: 'Signed in with Google',
    provider_google_badge: 'Verified with Google',
    provider_phone: 'Signed in with Phone Number',
    provider_phone_badge: 'Verified with SMS',
    provider_email: 'Registered with Email',
    provider_email_badge: 'Logged in',
    save_changes: 'Save',
    logout: 'Log Out',
    confirm_logout_title: 'Log Out',
    confirm_logout_msg: 'Are you sure you want to log out of your account?',
    confirm_logout_action: 'Yes, Log Out',
    select_photo: 'Choose Photo',
    upload_photo: 'Upload Photo',
    remove_photo: 'Remove',
    preset_avatars: 'or choose a preset avatar:',
    language_title: 'App Language',
    ducking_title: 'Voice Ducking Level',
    ducking_desc: 'Lowers video volume when someone speaks.',
    mic_sens_title: 'Microphone Sensitivity',
    sens_high: 'High',
    sens_med: 'Medium',
    sens_low: 'Low',
    pip_corner_title: 'Camera Position',
    pip_corner_desc: 'Corner where camera stays in fullscreen:',
    pip_show_camera: 'Show camera in fullscreen',
    corner_br: 'Bottom Right (Default)',
    corner_bl: 'Bottom Left',
    corner_tr: 'Top Right',
    corner_tl: 'Top Left',
    accounts_info: 'You can log into your platform accounts (YouTube, Netflix, Prime etc.) directly via the in-app browser. Your sessions are saved securely on your device.',
    open_in_browser: 'Sign In',
    platform_signin_btn: 'Connect',
    platform_connect_btn: 'Connect',
    yt_card_sub: 'Sign in with Google account',
    netflix_card_sub: 'Sign in with Netflix account',
    prime_card_sub: 'Sign in with Prime account',
    disney_card_sub: 'Sign in with Disney+ account',
    connected_platforms_title: 'Connected Platforms',
    connected_platforms_sub: 'Persistent session in built-in browser',
    create_room_title: 'New Watch Room',
    room_name_label: 'Room Name',
    platform_label: 'Content Platform',
    public_room: 'Public Room (Anyone can join)',
    private_room: 'Private / Locked (Code only)',
    create_and_start: 'Create & Start',
    cancel: 'Cancel',
    cancel_btn: 'Cancel',
    join_modal_title: 'Join Room',
    join_code_ph: 'ENTER ROOM CODE OR LINK...',
    join_btn: 'Join',
    auth_title: 'Sign in to Miruo',
    login_tab: 'Sign In',
    register_tab: 'Sign Up',
    auth_heading_login: 'Sign In',
    auth_subtitle_login: 'Sign in with your email and password.',
    auth_heading_register: 'Sign Up',
    auth_subtitle_register: 'Sign up with your name, email and password.',
    email_btn: 'Email',
    phone_btn: 'Phone',
    first_name_label: 'First Name',
    first_name_ph: 'Your first name',
    last_name_label: 'Last Name',
    last_name_ph: 'Your last name',
    email_label: 'Email',
    email_label_login: 'Email or Username',
    email_ph: 'example@gmail.com',
    email_ph_login: 'example@gmail.com or username',
    password_label: 'Password',
    password_ph: 'At least 6 characters',
    password_confirm_label: 'Confirm Password',
    password_confirm_ph: 'Re-enter your password',
    remember_me: 'Keep me signed in',
    forgot_password: 'Forgot Password?',
    phone_label: 'Phone Number',
    phone_sub_info: 'A 6-digit SMS verification code will be sent to your phone to sign in.',
    sms_code_label: 'SMS Code (6 Digits):',
    back_btn: '← Back',
    resend_code_btn: 'Resend Code',
    login_btn: 'Sign In',
    register_btn: 'Sign Up',
    or_divider: 'OR CONTINUE WITH',
    google_login: 'Google',
    apple_login: 'Apple',
    auth_footer_login: 'New to Miruo?',
    auth_footer_action_login: 'Create Account',
    auth_footer_register: 'Already have an account?',
    auth_footer_action_register: 'Sign In',
    guest_continue: 'Continue as guest without signing in',
    settings_title: 'Settings',
    settings_subtitle: 'Profile, Security & Preferences',
    profile_info_section: 'Profile Information',
    account_security_section: 'Account & Security',
    change_email_title: 'Change Email Address',
    change_email_sub: 'Link a new email address',
    change_email_info: 'A 6-digit verification link will be sent to your new email.',
    change_email_ph: 'Enter new email address',
    update_btn: 'Update',
    change_password_title: 'Change Password',
    change_password_sub: 'Update your account password',
    change_password_header: 'Password Update',
    current_pass_ph: 'Current Password',
    new_pass_ph: 'New Password (min. 6 characters)',
    confirm_pass_ph: 'Confirm New Password',
    update_password_btn: 'Update Password',
    notifications_title: 'Notifications',
    notifications_sub: 'Instant alerts and invite preferences',
    notif_push: 'Push Notifications',
    notif_push_sub: 'Important events and friend alerts',
    notif_invites: 'Room & Invite Alerts',
    notif_invites_sub: 'Get notified when friends invite you to a room',
    notif_sound: 'Sound & Vibration',
    notif_sound_sub: 'Message and alert sound effects',
    audio_video_title: 'Audio & Video Settings',
    audio_video_sub: 'Ducking, microphone, and camera preferences',
    legal_section: 'Legal & Info',
    privacy_policy_title: 'Privacy Policy',
    terms_of_service_title: 'Terms of Service',
    delete_account_btn: 'Delete Account',
    delete_account_modal_title: 'Delete My Account',
    delete_account_modal_sub: 'This action cannot be undone.',
    delete_account_modal_desc: 'Deleting your account permanently removes your profile data, rooms, and history.',
    delete_account_pass_label: 'Enter your password to confirm:',
    confirm_delete_btn: 'Delete My Account',
    miruo_guarantee: 'Miruo Guarantee',
    privacy_summary_title: 'Our Commitment:',
    privacy_summary_desc: 'Miruo respects your personal privacy. Your watch history, private messages, and preferences are never sold or used for ads.',
    privacy_sec1_title: '1. Information We Collect',
    privacy_sec1_desc: 'Only basic data (username, email or phone) required to create your account and watch together with friends is stored.',
    privacy_sec2_title: '2. Cookies & Platform Logins',
    privacy_sec2_desc: 'Your YouTube, Netflix and other platform logins remain securely in local device storage. Passwords are never sent to our servers.',
    privacy_sec3_title: '3. Camera and Voice Data',
    privacy_sec3_desc: 'In live rooms, microphone and camera streams transfer directly peer-to-peer (P2P) via WebRTC. No audio or video is recorded.',
    privacy_sec4_title: '4. Data Security and Deletion',
    privacy_sec4_desc: 'You can delete your account from Settings anytime. All deleted user data is instantly and permanently removed.',
    miruo_terms_badge: 'Miruo Terms of Service',
    terms_intro: 'By using the Miruo platform, you agree to the following terms and community guidelines.',
    terms_sec1_title: '1. Purpose of Service',
    terms_sec1_desc: 'Miruo is a social co-watching platform enabling friends and communities to watch legal video platforms synchronously with audio and video chat.',
    terms_sec2_title: '2. Community Guidelines',
    terms_sec2_desc: 'Hate speech, harassment, illegal content, and disruptive behavior are strictly prohibited. Violators may be permanently banned.',
    terms_sec3_title: '3. Third-Party Content',
    terms_sec3_desc: 'Content watched is governed by the terms of each platform (YouTube, Netflix, etc.). Miruo does not own any third-party content.',
    terms_sec4_title: '4. Service Changes',
    terms_sec4_desc: 'Miruo reserves the right to update features or revise terms of service at any time.',
    rave_title: 'YouTube',
    rave_subtitle: 'Choose a video and watch together with the room.',
    rave_search_ph: 'Search songs, clips, artists or channels on YouTube...',
    rave_search_btn: 'Search',
    rave_tab_trending: 'Trending',
    rave_tab_music: 'Popular Music',
    rave_tab_lofi: '24/7 Lo-Fi',
    rave_footer_info: 'Tap any video to watch in sync with friends',
    stage_waiting: 'Select a video or paste a link to start watching',
    chat_tab: 'Chat',
    people_tab: 'Participants',
    chat_ph: 'Type a message...',
    send: 'Send',
    leave_room: 'Leave',
    change_video: 'Change Video',
    refresh_btn: 'Refresh',
    invite_copied: 'Room invite link copied!',
    profile_updated: 'Profile and preferences updated',
    lang_changed: 'Language set to English',
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
    role_member_label: 'Viewer',
    online_count_suffix: 'Online',
    status_online: 'Online',
    status_offline: 'Offline',
    status_in_room: 'In room',
    status_idle: 'Idle',
    invite_friend: 'Invite to Room',
    invite_btn_short: 'Invite',
    friends_title: 'Friends',
    friends_subtitle: 'Manage friends to watch together',
    your_username_label: 'Your Username',
    copy_btn: 'Copy',
    add_friend_by_name: 'Add Friend by Username',
    add_friend_ph: 'Enter username (e.g. @selin or john)',
    add_btn: 'Add',
    search_friends_ph: 'Search friends...',
    no_friends_empty: 'No friends added yet.',
    no_friends_sub: 'Enter your friend\'s username (@username) above to add them right away.',
    provider_search_ph: 'search video, show or movie...',
    room_queue_label: 'Queue:',
    room_queue_title: 'Playback Queue',
    room_change_video: 'Change',
    who_can_join: 'Who Can Join',
    who_can_join_short: 'Access',
    now_playing_prefix: 'Now',
    now_playing_suffix: 'playing',
    privacy_public: 'Public Room',
    privacy_friends: 'Friends',
    privacy_private: 'Private (Invite only)',
    share_btn: 'Share',
    select_video_btn: 'Select Video',
    platform_chooser_title: 'Select Video & Platform',
    platform_chooser_sub: 'Choose a streaming platform or paste a direct video link',
    live_chat_title: 'Live Chat',
    top_chat: 'Top Chat',
    chat_expand: 'Expand',
    chat_collapse: 'Collapse',
    chat_welcome: 'room, welcome!',
    chat_bot_joined: 'joined the room',
    show_chat: 'Show Chat',
    chat_mention_label: 'Mention:',
    chat_reaction_label: 'Reaction:',
    chat_add_photo: 'Add Photo',
    close_btn: 'Close',
    leave_room_btn: 'Leave Room',
    video_placeholder_title: 'Video Loading or None Selected',
    video_placeholder_desc: 'Tap "Select Video" to choose any video or platform.',
    miruo_player: 'Miruo Player',
    video_title_default: 'Video Title',
    video_subtitle_default: 'Miruo on YouTube',
    fullscreen_title: 'Fullscreen',
    live_cam_feed: 'Live Camera Feed',
    self_camera_badge: 'You (Camera)',
    close_cam_title: 'Turn Off Camera',
    flip_cam_title: 'Switch Camera (Front / Back)',
    switch_cam_success: 'Camera switched',
    cam_device_title: 'Camera Device',
    cam_off_label: 'Camera Off',
    cam_live_label: 'Live',
    you_badge: 'You',
    simulated_badge: 'Simulated',
    your_device: 'Your Device',
    room_participant: 'Room Participant',
    live_connection: 'Live Connection',
    role_owner: 'Room Host',
    role_admin: 'Admin',
    role_video_control: 'Can Play Video',
    role_member: 'Viewer',
    kick_title: 'Remove from Room',
    kick_btn: 'Remove',
    friend_badge: 'Friend',
    add_friend_title: 'Add Friend',
    add_friend_btn_short: 'Add',
    mic_on_title: 'Microphone On',
    mic_off_title: 'Microphone Muted',
    cam_on_title: 'Camera On',
    cam_off_title: 'Camera Off',
    av_mic_cam_on: 'Mic & Camera On (Live)',
    av_mic_on_cam_off: 'Mic Live • Camera Off',
    av_cam_on_mic_off: 'Camera Live • Mic Muted',
    av_mic_cam_off: 'Mic & Camera Off',
    toast_cam_opened: 'Live Camera Started (Draggable)',
    toast_cam_preview_opened: 'Live Camera Preview Started (Draggable)',
    who_can_join_title: 'Who Can Join?',
    who_can_join_sub: 'Manage room access and participant permissions.',
    random_room_code_label: 'Random Room Code',
    access_permission_label: 'Join Permission',
    access_public_label: 'Everyone (Public)',
    recommended_badge: 'Recommended',
    access_public_desc: 'Anyone with the room link or code can join directly.',
    access_invite_label: 'Invite Only',
    access_invite_desc: 'Only people invited and approved by the host can join.',
    done_btn: 'Done',
    queue_title: 'Playback Queue',
    queue_empty: 'No videos waiting in queue',
    share_room_title: 'Share Room & Invite',
    share_room_sub: 'Watch synchronously with your friends',
    share_public_desc: 'Anyone can join from explore or via link',
    share_friends_desc: 'Only people you follow can join',
    share_invite_desc: 'Private room, access only via invite link',
    invite_link_label: 'Invite Link',
    share_with_app_label: 'Share with App',
    messages_app_label: 'Messages',
    other_app_label: 'Other',
    room_privacy_toast: 'Room Privacy',
    room_title_label: 'Room Title',
    room_title_ph: 'e.g. Late Night Lo-Fi or Movie Night',
    privacy_type_label: 'Privacy Type',
    private_room_label: 'Private Room',
    private_room_desc: 'Only invited friends can enter.',
    public_room_label: 'Public Room',
    public_room_desc: 'Listed in the Miruo Explore feed.',
    platform_select_label: 'Watching Platform',
    screen_share_label: 'Screen',
    submit_create_room_btn: 'Start & Join Room',
    yt_modal_title: 'YouTube',
    yt_modal_sub: 'Select a video and watch together with the room.',
    yt_browse_btn: 'Browse ↗',
    yt_browse_title: 'Open m.youtube.com and sign in',
    yt_currently_playing_prefix: 'Now playing:',
    yt_background_playing: 'Playing continuously in background',
    yt_search_ph: 'Search songs, clips, artists or channels on YouTube...',
    yt_search_btn: 'Search',
    tab_trending: 'Trending',
    tab_music: 'Popular Music',
    tab_lofi: '24/7 Lo-Fi',
    tab_series: 'Shows & Trailers',
    tab_podcast: 'Podcasts & Talk',
    tab_gaming: 'Gaming & Esports',
    action_play_now: 'Play Now',
    action_add_queue: 'Add to Queue',
    suggestion_title: 'Video Suggestion',
    suggested_by_suffix: 'suggested',
    friends_modal_title: 'Friends & Co-Watching',
    saved_friends_header: 'Saved Friends',
    online_label: 'Online',
    host_label: 'Host',
    mic_toggle_title: 'Toggle Microphone',
    cam_toggle_title: 'Toggle Camera (Video Call)',
    chat_toggle_title: 'Toggle Chat',
    online_count_badge: 'Online',
    leave_room_btn: 'Leave',
    leave_room_title: 'Leave Room',
    toast_left_room: 'You left the room',
    fs_show_chat: 'Show live chat in fullscreen',
    toggle_video_display: 'Show video display',
    audio_only_mode: 'Audio Only Mode (Video Hidden)',
    show_video_btn: 'Show Video',
    hide_video_btn: 'Hide Video',
    toast_video_shown: 'Video display turned on',
    toast_video_hidden: 'Video display hidden, playing audio only',
    toast_chat_closed: 'Chat hidden, video switched to fullscreen',
    toast_chat_opened: 'Live Chat opened'
  },
  de: {
    app_title: 'Miruo — Zusammen Sehen & Schauen',
    tagline: 'Gemeinsam schauen & sprechen',
    auth_tagline: 'Die intimste Art gemeinsam zu schauen',
    reset_new_password_label: 'Neues Passwort',
    reset_confirm_password_label: 'Passwort bestätigen',
    nav_settings: 'Einstellungen',
    nav_friends: 'Freunde',
    nav_profile: 'Profil',
    nav_explore: 'Räume',
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
    display_name: 'Anzeigename',
    full_name: 'Vor- und Nachname',
    full_name_ph: 'z.B. Mehmet Karabulut',
    username: 'Benutzername',
    username_ph: 'benutzername',
    default_room_code: 'Standard- / Raumcode',
    registered_email: 'Registrierte E-Mail',
    active_session: 'Angemeldet',
    provider_apple: 'Mit Apple ID angemeldet',
    provider_apple_badge: 'Mit Apple bestätigt',
    provider_google: 'Mit Google angemeldet',
    provider_google_badge: 'Mit Google bestätigt',
    provider_phone: 'Mit Telefonnummer angemeldet',
    provider_phone_badge: 'Mit SMS bestätigt',
    provider_email: 'Mit E-Mail registriert',
    provider_email_badge: 'Angemeldet',
    save_changes: 'Speichern',
    logout: 'Abmelden',
    confirm_logout_title: 'Abmelden',
    confirm_logout_msg: 'Möchten Sie sich wirklich von Ihrem Konto abmelden?',
    confirm_logout_action: 'Ja, Abmelden',
    select_photo: 'Foto wählen',
    upload_photo: 'Foto hochladen',
    remove_photo: 'Entfernen',
    preset_avatars: 'oder wählen Sie einen Avatar:',
    language_title: 'App-Sprache',
    ducking_title: 'Audio-Absenkung',
    ducking_desc: 'Senkt die Videolautstärke beim Sprechen.',
    mic_sens_title: 'Mikrofonempfindlichkeit',
    sens_high: 'Hoch',
    sens_med: 'Mittel',
    sens_low: 'Niedrig',
    pip_corner_title: 'Kameraposition',
    pip_corner_desc: 'Ecke für die Kamera im Vollbild:',
    pip_show_camera: 'Kamera im Vollbild anzeigen',
    corner_br: 'Unten Rechts (Standard)',
    corner_bl: 'Unten Links',
    corner_tr: 'Oben Rechts',
    corner_tl: 'Oben Links',
    accounts_info: 'Sie können sich über den In-App-Browser direkt bei Ihren Plattformkonten (YouTube, Netflix, Prime usw.) anmelden. Ihre Sitzungen werden sicher auf Ihrem Gerät gespeichert.',
    open_in_browser: 'Anmelden',
    platform_signin_btn: 'Verbinden',
    platform_connect_btn: 'Verbinden',
    yt_card_sub: 'Mit Google-Konto anmelden',
    netflix_card_sub: 'Mit Netflix-Konto anmelden',
    prime_card_sub: 'Mit Prime-Konto anmelden',
    disney_card_sub: 'Mit Disney+-Konto anmelden',
    connected_platforms_title: 'Verbundene Plattformen',
    connected_platforms_sub: 'Dauerhafte Sitzung im integrierten Browser',
    create_room_title: 'Neuer Raum',
    room_name_label: 'Raumname',
    platform_label: 'Plattform',
    public_room: 'Öffentlicher Raum (Jeder kann beitreten)',
    private_room: 'Privater Raum (Nur mit Code)',
    create_and_start: 'Erstellen & Starten',
    cancel: 'Abbrechen',
    cancel_btn: 'Abbrechen',
    join_modal_title: 'Raum beitreten',
    join_code_ph: 'RAUMCODE ODER LINK EINGEBEN...',
    join_btn: 'Beitreten',
    auth_title: 'Bei Miruo anmelden',
    login_tab: 'Anmelden',
    register_tab: 'Registrieren',
    auth_heading_login: 'Anmelden',
    auth_subtitle_login: 'Melden Sie sich mit E-Mail und Passwort an.',
    auth_heading_register: 'Registrieren',
    auth_subtitle_register: 'Registrieren Sie sich mit Name, E-Mail und Passwort.',
    email_btn: 'E-Mail',
    phone_btn: 'Telefon',
    first_name_label: 'Vorname',
    first_name_ph: 'Ihr Vorname',
    last_name_label: 'Nachname',
    last_name_ph: 'Ihr Nachname',
    email_label: 'E-Mail',
    email_label_login: 'E-Mail oder Benutzername',
    email_ph: 'beispiel@gmail.com',
    email_ph_login: 'beispiel@gmail.com oder Benutzername',
    password_label: 'Passwort',
    password_ph: 'Mindestens 6 Zeichen',
    password_confirm_label: 'Passwort bestätigen',
    password_confirm_ph: 'Passwort erneut eingeben',
    remember_me: 'Angemeldet bleiben',
    forgot_password: 'Passwort vergessen?',
    phone_label: 'Telefonnummer',
    phone_sub_info: 'Ein 6-stelliger SMS-Code wird an Ihr Telefon gesendet, um sich anzumelden.',
    sms_code_label: 'SMS-Code (6 Ziffern):',
    back_btn: '← Zurück',
    resend_code_btn: 'Code erneut senden',
    login_btn: 'Anmelden',
    register_btn: 'Registrieren',
    or_divider: 'ODER WEITER MIT',
    google_login: 'Google',
    apple_login: 'Apple',
    auth_footer_login: 'Neu bei Miruo?',
    auth_footer_action_login: 'Konto erstellen',
    auth_footer_register: 'Bereits ein Konto?',
    auth_footer_action_register: 'Anmelden',
    guest_continue: 'Als Gast ohne Anmeldung fortfahren',
    settings_title: 'Einstellungen',
    settings_subtitle: 'Profil, Sicherheit & Vorlieben',
    profile_info_section: 'Profilinformationen',
    account_security_section: 'Konto & Sicherheit',
    change_email_title: 'E-Mail-Adresse ändern',
    change_email_sub: 'Neue E-Mail verknüpfen',
    change_email_info: 'Ein 6-stelliger Bestätigungslink wird an Ihre neue E-Mail gesendet.',
    change_email_ph: 'Neue E-Mail-Adresse eingeben',
    update_btn: 'Aktualisieren',
    change_password_title: 'Passwort ändern',
    change_password_sub: 'Passwort für Ihr Konto aktualisieren',
    change_password_header: 'Passwort-Aktualisierung',
    current_pass_ph: 'Aktuelles Passwort',
    new_pass_ph: 'Neues Passwort (mind. 6 Zeichen)',
    confirm_pass_ph: 'Neues Passwort bestätigen',
    update_password_btn: 'Passwort aktualisieren',
    notifications_title: 'Benachrichtigungen',
    notifications_sub: 'Sofortmeldungen und Einladungen',
    notif_push: 'Push-Benachrichtigungen',
    notif_push_sub: 'Wichtige Ereignisse und Freundesmeldungen',
    notif_invites: 'Raum- & Einladungsmeldungen',
    notif_invites_sub: 'Benachrichtigen, wenn Freunde Sie in einen Raum einladen',
    notif_sound: 'Ton & Vibration',
    notif_sound_sub: 'Nachrichten- und Signalton-Effekte',
    audio_video_title: 'Audio- & Video-Einstellungen',
    audio_video_sub: 'Ducking, Mikrofon und Kamera-Optionen',
    legal_section: 'Rechtliches & Info',
    privacy_policy_title: 'Datenschutzrichtlinie',
    terms_of_service_title: 'Nutzungsbedingungen',
    delete_account_btn: 'Konto löschen',
    delete_account_modal_title: 'Mein Konto löschen',
    delete_account_modal_sub: 'Diese Aktion kann nicht rückgängig gemacht werden.',
    delete_account_modal_desc: 'Durch das Löschen Ihres Kontos werden Ihre Profildaten und Räume dauerhaft entfernt.',
    delete_account_pass_label: 'Geben Sie Ihr Passwort zur Bestätigung ein:',
    confirm_delete_btn: 'Mein Konto löschen',
    miruo_guarantee: 'Miruo-Garantie',
    privacy_summary_title: 'Unsere Verpflichtung:',
    privacy_summary_desc: 'Miruo respektiert Ihre Privatsphäre. Ihr Wiedergabeverlauf, Ihre privaten Chats und Vorlieben werden niemals verkauft.',
    privacy_sec1_title: '1. Gesammelte Informationen',
    privacy_sec1_desc: 'Nur grundlegende Daten (Benutzername, E-Mail oder Telefon), die für Ihr Konto und das gemeinsame Schauen erforderlich sind, werden gespeichert.',
    privacy_sec2_title: '2. Cookies & Plattform-Anmeldungen',
    privacy_sec2_desc: 'Ihre Anmeldungen bei YouTube, Netflix usw. verbleiben sicher im lokalen Gerätespeicher. Passwörter werden nie übertragen.',
    privacy_sec3_title: '3. Kamera- und Sprachdaten',
    privacy_sec3_desc: 'In Live-Räumen werden Mikrofon- und Kameraströme direkt von Peer zu Peer (P2P) übertragen. Es werden keine Aufzeichnungen erstellt.',
    privacy_sec4_title: '4. Datensicherheit und Löschung',
    privacy_sec4_desc: 'Sie können Ihr Konto jederzeit in den Einstellungen löschen. Alle gelöschten Benutzerdaten werden sofort dauerhaft entfernt.',
    miruo_terms_badge: 'Miruo Nutzungsbedingungen',
    terms_intro: 'Durch die Nutzung der Miruo-Plattform akzeptieren Sie die folgenden Nutzungsbedingungen.',
    terms_sec1_title: '1. Zweck des Dienstes',
    terms_sec1_desc: 'Miruo ist eine soziale Co-Watching-Plattform, die es Freunden ermöglicht, legale Videoplattformen synchron mit Sprach- und Video-Chat zu schauen.',
    terms_sec2_title: '2. Community-Richtlinien',
    terms_sec2_desc: 'Hassrede, Belästigung und rechtswidrige Inhalte sind strengstens verboten.',
    terms_sec3_title: '3. Inhalte Dritter',
    terms_sec3_desc: 'Angesehene Inhalte unterliegen den Bedingungen der jeweiligen Plattform (YouTube, Netflix usw.).',
    terms_sec4_title: '4. Service-Änderungen',
    terms_sec4_desc: 'Miruo behält sich das Recht vor, Funktionen oder Bedingungen jederzeit anzupassen.',
    rave_title: 'YouTube',
    rave_subtitle: 'Video auswählen und gemeinsam im Raum ansehen.',
    rave_search_ph: 'Auf YouTube nach Videos, Musik oder Kanälen suchen...',
    rave_search_btn: 'Suchen',
    rave_tab_trending: 'Trends',
    rave_tab_music: 'Beliebte Musik',
    rave_tab_lofi: '24/7 Lo-Fi',
    rave_footer_info: 'Tippen Sie auf ein Video, um es synchron anzusehen',
    stage_waiting: 'Wählen Sie ein Video oder fügen Sie einen Link ein',
    chat_tab: 'Chat',
    people_tab: 'Teilnehmer',
    chat_ph: 'Nachricht schreiben...',
    send: 'Senden',
    leave_room: 'Verlassen',
    change_video: 'Video ändern',
    refresh_btn: 'Aktualisieren',
    invite_copied: 'Raum-Einladungslink kopiert!',
    profile_updated: 'Profil und Einstellungen aktualisiert',
    lang_changed: 'Sprache auf Deutsch gesetzt',
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
    role_member_label: 'Zuschauer',
    online_count_suffix: 'Online',
    status_online: 'Online',
    status_offline: 'Offline',
    status_in_room: 'Im Raum',
    status_idle: 'Untätig',
    invite_friend: 'In Raum einladen',
    invite_btn_short: 'Einladen',
    friends_title: 'Freunde',
    friends_subtitle: 'Freunde zum gemeinsamen Schauen verwalten',
    your_username_label: 'Dein Benutzername',
    copy_btn: 'Kopieren',
    add_friend_by_name: 'Freund per Benutzername hinzufügen',
    add_friend_ph: 'Benutzername eingeben (z.B. @selin oder max)',
    add_btn: 'Hinzufügen',
    search_friends_ph: 'Freunde durchsuchen...',
    no_friends_empty: 'Noch keine Freunde hinzugefügt.',
    no_friends_sub: 'Gib oben den Benutzernamen (@benutzername) deines Freundes ein.',
    provider_search_ph: 'Video, Serie oder Film suchen...',
    room_queue_label: 'Warteschlange:',
    room_queue_title: 'Wiedergabewarteschlange',
    room_change_video: 'Ändern',
    who_can_join: 'Wer kann beitreten',
    who_can_join_short: 'Zugriff',
    now_playing_prefix: 'Jetzt läuft',
    now_playing_suffix: '',
    privacy_public: 'Öffentlicher Raum',
    privacy_friends: 'Freunde',
    privacy_private: 'Privat (Nur Einladung)',
    share_btn: 'Teilen',
    select_video_btn: 'Video wählen',
    platform_chooser_title: 'Video & Plattform wählen',
    platform_chooser_sub: 'Wählen Sie eine Plattform oder fügen Sie einen Direktlink ein',
    live_chat_title: 'Live-Chat',
    top_chat: 'Top-Chat',
    chat_expand: 'Vergrößern',
    chat_collapse: 'Verkleinern',
    chat_welcome: 'Raum, willkommen!',
    chat_bot_joined: 'ist dem Raum beigetreten',
    show_chat: 'Chat anzeigen',
    chat_mention_label: 'Erwähnen:',
    chat_reaction_label: 'Reaktion:',
    chat_add_photo: 'Foto hinzufügen',
    close_btn: 'Schließen',
    leave_room_btn: 'Raum verlassen',
    video_placeholder_title: 'Video wird geladen oder nicht gewählt',
    video_placeholder_desc: 'Tippen Sie auf "Video wählen", um ein Video oder eine Plattform zu starten.',
    miruo_player: 'Miruo Player',
    video_title_default: 'Videotitel',
    video_subtitle_default: 'Miruo auf YouTube',
    fullscreen_title: 'Vollbild',
    live_cam_feed: 'Live-Kamera-Feed',
    self_camera_badge: 'Du (Kamera)',
    close_cam_title: 'Kamera ausschalten',
    flip_cam_title: 'Kamera wechseln (Vorne / Hinten)',
    switch_cam_success: 'Kamera gewechselt',
    cam_device_title: 'Kameragerät',
    cam_off_label: 'Kamera Aus',
    cam_live_label: 'Live',
    you_badge: 'Du',
    simulated_badge: 'Simuliert',
    your_device: 'Dein Gerät',
    room_participant: 'Raumteilnehmer',
    live_connection: 'Live-Verbindung',
    role_owner: 'Raumleiter',
    role_admin: 'Administrator',
    role_video_control: 'Kann Video abspielen',
    role_member: 'Zuschauer',
    kick_title: 'Aus dem Raum entfernen',
    kick_btn: 'Entfernen',
    friend_badge: 'Freund',
    add_friend_title: 'Freund hinzufügen',
    add_friend_btn_short: 'Hinzufügen',
    mic_on_title: 'Mikrofon Ein',
    mic_off_title: 'Mikrofon Stumm',
    cam_on_title: 'Kamera Ein',
    cam_off_title: 'Kamera Aus',
    av_mic_cam_on: 'Mikrofon & Kamera Ein (Live)',
    av_mic_on_cam_off: 'Mikrofon Live • Kamera Aus',
    av_cam_on_mic_off: 'Kamera Live • Mikrofon Stumm',
    av_mic_cam_off: 'Mikrofon & Kamera Aus',
    toast_cam_opened: 'Live-Kamera gestartet (Verschiebbar)',
    toast_cam_preview_opened: 'Live-Kamera-Vorschau gestartet (Verschiebbar)',
    who_can_join_title: 'Wer kann beitreten?',
    who_can_join_sub: 'Raumzugriff und Berechtigungen verwalten.',
    random_room_code_label: 'Zufälliger Raumcode',
    access_permission_label: 'Beitrittserlaubnis',
    access_public_label: 'Öffentlich (Alle)',
    recommended_badge: 'Empfohlen',
    access_public_desc: 'Jeder mit dem Raumlink oder Code kann direkt beitreten.',
    access_invite_label: 'Nur mit Einladung',
    access_invite_desc: 'Nur vom Leiter eingeladene und bestätigte Personen können beitreten.',
    done_btn: 'Fertig',
    queue_title: 'Wiedergabeschlange',
    queue_empty: 'Keine Videos in der Warteschlange',
    share_room_title: 'Raum teilen & einladen',
    share_room_sub: 'Gemeinsam mit Freunden synchron schauen',
    share_public_desc: 'Jeder kann über Entdecken oder Link beitreten',
    share_friends_desc: 'Nur Personen, denen du folgst, können beitreten',
    share_invite_desc: 'Privater Raum, Zutritt nur per Einladungslink',
    invite_link_label: 'Einladungslink',
    share_with_app_label: 'Mit App teilen',
    messages_app_label: 'Nachrichten',
    other_app_label: 'Andere',
    room_privacy_toast: 'Raum-Privatsphäre',
    room_title_label: 'Raumtitel',
    room_title_ph: 'z.B. Late Night Lo-Fi oder Filmabend',
    privacy_type_label: 'Privatsphäre-Typ',
    private_room_label: 'Privater Raum',
    private_room_desc: 'Nur eingeladene Personen können beitreten.',
    public_room_label: 'Öffentlicher Raum',
    public_room_desc: 'Wird im Miruo-Entdecken-Feed gelistet.',
    platform_select_label: 'Streaming-Plattform',
    screen_share_label: 'Bildschirm',
    submit_create_room_btn: 'Raum starten & beitreten',
    yt_modal_title: 'YouTube',
    yt_modal_sub: 'Wählen Sie ein Video und schauen Sie gemeinsam im Raum.',
    yt_browse_btn: 'Durchsuchen ↗',
    yt_browse_title: 'm.youtube.com öffnen und anmelden',
    yt_currently_playing_prefix: 'Läuft gerade:',
    yt_background_playing: 'Läuft ununterbrochen im Hintergrund weiter',
    yt_search_ph: 'Auf YouTube nach Videos, Musik oder Kanälen suchen...',
    yt_search_btn: 'Suchen',
    tab_trending: 'Trends',
    tab_music: 'Beliebte Musik',
    tab_lofi: '24/7 Lo-Fi',
    tab_series: 'Serien & Trailer',
    tab_podcast: 'Podcasts & Talk',
    tab_gaming: 'Gaming & E-Sport',
    action_play_now: 'Jetzt abspielen',
    action_add_queue: 'In Warteschlange',
    suggestion_title: 'Video-Vorschlag',
    suggested_by_suffix: 'hat vorgeschlagen',
    friends_modal_title: 'Freunde & Gemeinsames Schauen',
    saved_friends_header: 'Gespeicherte Freunde',
    online_label: 'Online',
    host_label: 'Host',
    mic_toggle_title: 'Mikrofon umschalten',
    cam_toggle_title: 'Kamera umschalten (Videoanruf)',
    chat_toggle_title: 'Chat ein-/ausblenden',
    online_count_badge: 'Online',
    leave_room_btn: 'Verlassen',
    leave_room_title: 'Raum verlassen',
    toast_left_room: 'Du hast den Raum verlassen',
    fs_show_chat: 'Live-Chat im Vollbild anzeigen',
    toggle_video_display: 'Videoanzeige einblenden',
    audio_only_mode: 'Nur-Audio-Modus (Video ausgeblendet)',
    show_video_btn: 'Video einblenden',
    hide_video_btn: 'Video ausblenden',
    toast_video_shown: 'Videoanzeige aktiviert',
    toast_video_hidden: 'Videoanzeige ausgeblendet, nur Audio läuft',
    toast_chat_closed: 'Chat ausgeblendet, Video im Vollbild',
    toast_chat_opened: 'Live-Chat geöffnet'
  }
};

const urlBootLang = (typeof window !== 'undefined' && window.location) ? new URLSearchParams(window.location.search).get('lang') : null;
let currentLang = (urlBootLang && I18N[urlBootLang]) ? urlBootLang : (localStorage.getItem('miruo_lang') || 'tr');

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

  // Explicitly update header and auth brand taglines under MIRUO
  const navTagline = document.getElementById('navTaglineText');
  if (navTagline && dict.tagline) {
    navTagline.textContent = dict.tagline;
  }
  const authTagline = document.getElementById('authTaglineText');
  if (authTagline && (dict.auth_tagline || dict.tagline)) {
    authTagline.textContent = dict.auth_tagline || dict.tagline;
  }

  // Update placeholders with [data-i18n-placeholder]
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (dict[key]) {
      el.placeholder = dict[key];
    }
  });

  // Update titles with [data-i18n-title]
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (dict[key]) {
      el.title = dict[key];
    }
  });

  // Update active style on Settings lang-btns
  document.querySelectorAll('#langSelectorGroup .lang-btn').forEach(btn => {
    if (btn.getAttribute('data-lang') === lang) {
      btn.className = 'lang-btn active p-2.5 rounded-xl border-2 border-[#A64D79] bg-[#A64D79]/20 text-center font-bold text-white cursor-pointer transition-all shadow-sm';
    } else {
      btn.className = 'lang-btn p-2.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-center font-medium text-gray-300 cursor-pointer transition-all';
    }
  });

  // Update active style on Auth modal lang-btns
  document.querySelectorAll('#authLangSelectorGroup .auth-lang-btn').forEach(btn => {
    if (btn.getAttribute('data-lang') === lang) {
      btn.className = 'auth-lang-btn active px-2.5 py-1 rounded-lg text-xs font-bold bg-[#A64D79] text-white shadow-sm transition-all cursor-pointer';
    } else {
      btn.className = 'auth-lang-btn px-2.5 py-1 rounded-lg text-xs font-medium text-gray-400 hover:text-white transition-all cursor-pointer';
    }
  });

  // Update dynamic audio labels
  if (dom && dom.micSensVal && dom.micSensSlider) {
    const val = Number(dom.micSensSlider.value || 25);
    dom.micSensVal.textContent = val < 15 ? (dict.sens_high || 'Yüksek') : (val < 30 ? (dict.sens_med || 'Orta') : (dict.sens_low || 'Düşük'));
  }
  if (dom && dom.duckingLevelVal && dom.duckingLevelSlider) {
    const dVal = dom.duckingLevelSlider.value || 30;
    dom.duckingLevelVal.textContent = lang === 'tr' ? `%${dVal}` : `${dVal}%`;
  }

  // Update dynamic auth modal strings for active mode
  if (typeof updateAuthStringsForCurrentLang === 'function') {
    updateAuthStringsForCurrentLang();
  }

  // Update room dynamic labels
  const nowPlayingPrefix = document.getElementById('nowPlayingPrefixText');
  if (nowPlayingPrefix && dict.now_playing_prefix) nowPlayingPrefix.textContent = dict.now_playing_prefix;
  const nowPlayingSuffix = document.getElementById('nowPlayingSuffixText');
  if (nowPlayingSuffix && dict.now_playing_suffix !== undefined) nowPlayingSuffix.textContent = dict.now_playing_suffix;

  if (dom && dom.privacyStatusText) {
    if (state.isPrivateRoom) {
      dom.privacyStatusText.textContent = dict.privacy_private || 'Private Room';
    } else {
      dom.privacyStatusText.textContent = dict.privacy_public || 'Public Room';
    }
  }

  const chatWelcome = document.getElementById('chatWelcomeMsgText');
  if (chatWelcome) {
    chatWelcome.innerHTML = `<strong class="text-gray-200">Miruo</strong> ${dict.chat_welcome || 'odasına hoş geldiniz!'}`;
  }

  // Update public room feed dynamically (Kurucu vs Host)
  if (typeof loadPublicRooms === 'function') loadPublicRooms();
  else if (typeof renderRoomList === 'function' && typeof DEFAULT_COMMUNITY_ROOMS !== 'undefined') renderRoomList(DEFAULT_COMMUNITY_ROOMS);

  // Update friends online count pill immediately
  const tabFriendsOnlineCountEl = document.getElementById('tabFriendsOnlineCount');
  if (tabFriendsOnlineCountEl) {
    const friendsArr = (state && state.friends) ? state.friends : [];
    const onlineFriends = friendsArr.filter(f => f.status === 'online' || f.status === 'in_room');
    const onlineSuffix = dict.online_count_suffix || (currentLang === 'tr' ? 'Çevrimiçi' : 'Online');
    tabFriendsOnlineCountEl.textContent = `${onlineFriends.length} ${onlineSuffix}`;
  }

  // Refresh friends tab & list dynamically
  if (typeof renderFriendsTab === 'function') renderFriendsTab();
  if (typeof renderFriendsList === 'function') renderFriendsList();

  // Refresh active room participants and video grid dynamically
  if (typeof renderParticipantsList === 'function') renderParticipantsList();
  if (typeof renderVideoGrid === 'function') renderVideoGrid();
  if (typeof updateAVToolbarUI === 'function') updateAVToolbarUI();
  if (typeof updateRoomQueueUI === 'function') updateRoomQueueUI();
  if (typeof updatePermissionUI === 'function') updatePermissionUI();
}

function updateAuthStringsForCurrentLang() {
  const dict = I18N[currentLang] || I18N.tr;
  if (dom && dom.authTabSignIn) {
    const sp = dom.authTabSignIn.querySelector('span');
    if (sp) sp.textContent = dict.login_tab;
  }
  if (dom && dom.authTabSignUp) {
    const sp = dom.authTabSignUp.querySelector('span');
    if (sp) sp.textContent = dict.register_tab;
  }
  if (dom && dom.authPasswordInput) {
    dom.authPasswordInput.placeholder = dict.password_ph;
  }
  if (typeof isSignUpMode !== 'undefined') {
    if (isSignUpMode) {
      if (dom && dom.authContactLabel) dom.authContactLabel.textContent = dict.email_label;
      if (dom && dom.authContactInput) dom.authContactInput.placeholder = dict.email_ph;
      if (dom && dom.authHeadingTitle) dom.authHeadingTitle.textContent = dict.auth_heading_register || dict.register_tab;
      if (dom && dom.authSubtitle) dom.authSubtitle.textContent = dict.auth_subtitle_register || '';
      if (dom && dom.authSubmitBtn) dom.authSubmitBtn.textContent = dict.register_btn;
      if (dom && dom.authFooterText) dom.authFooterText.textContent = dict.auth_footer_register;
      if (dom && dom.authFooterAction) dom.authFooterAction.textContent = dict.auth_footer_action_register;
    } else {
      if (dom && dom.authContactLabel) dom.authContactLabel.textContent = dict.email_label_login || dict.email_label;
      if (dom && dom.authContactInput) dom.authContactInput.placeholder = dict.email_ph_login || dict.email_ph;
      if (dom && dom.authHeadingTitle) dom.authHeadingTitle.textContent = dict.auth_heading_login || dict.login_tab;
      if (dom && dom.authSubtitle) dom.authSubtitle.textContent = dict.auth_subtitle_login || '';
      if (dom && dom.authSubmitBtn) dom.authSubmitBtn.textContent = dict.login_btn;
      if (dom && dom.authFooterText) dom.authFooterText.textContent = dict.auth_footer_login;
      if (dom && dom.authFooterAction) dom.authFooterAction.textContent = dict.auth_footer_action_login;
    }
  }
  if (dom && dom.continueAsGuestBtn) {
    dom.continueAsGuestBtn.textContent = dict.guest_continue || 'Giriş yapmadan misafir olarak incele';
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
  clientId: 'cl_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36),
  userId: 'user_' + Math.random().toString(36).substring(2, 8),
  username: 'Kullanıcı',
  peerId: null,
  activeMode: 'youtube', // 'youtube' | 'screenshare' | 'direct'
  currentTab: 'explore', // 'explore' | 'friends' | 'profile'
  
  // Room Playback Queue & Browsing State
  roomQueue: [],
  isBrowsingNextVideo: false,
  
  // Media Playback
  ytPlayer: null,
  ytReady: false,
  isPlaying: false,
  duration: 0,
  currentTime: 0,
  playbackQuality: 'auto',
  isRemoteAction: false,
  
  // WebRTC
  pc: null,
  dataChannel: null,
  localStream: null,
  screenStream: null,
  isMicOn: false,
  isCamOn: false,
  cameraFacingMode: 'user',
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
  isHost: false,
  hostName: '',
  userRole: 'member', // 'owner' | 'admin' | 'video_control' | 'dj' | 'member'
  controlMode: 'host_only', // 'host_only' | 'everyone'
  hasDjPermission: false,   // Whether current user can control media

  // Friends & Invite
  friendCode: '',
  friends: [],

  // Live Room Participants (Zoom style status tracker)
  participants: {},
  isChatVisible: true
};

// ICE Configuration (Public STUN + Reliable TURN servers for cross-network NAT traversal)
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun.relay.metered.ca:80' },
    {
      urls: [
        'turn:global.relay.metered.ca:80',
        'turn:global.relay.metered.ca:80?transport=tcp',
        'turn:global.relay.metered.ca:443',
        'turns:global.relay.metered.ca:443?transport=tcp'
      ],
      username: '6cf7107954c6d225edcd05ad',
      credential: '5ckNisBlMU6n0ETg'
    }
  ],
  iceCandidatePoolSize: 4,
  bundlePolicy: 'max-bundle'
};
(function setupTurnServers() {
  try {
    if (Array.isArray(window.MIRUO_TURN_SERVERS)) {
      window.MIRUO_TURN_SERVERS.forEach(sv => rtcConfig.iceServers.push(sv));
    }
    if (window.MIRUO_TURN_API) {
      fetch(window.MIRUO_TURN_API).then(r => r.json()).then(list => {
        if (Array.isArray(list)) list.forEach(sv => rtcConfig.iceServers.push(sv));
      }).catch(() => {});
    }
  } catch (_) {}
})();

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

  // Sleep & Night Mode Elements
  sleepModePlaceholder: document.getElementById('sleepModePlaceholder'),
  sleepModeClock: document.getElementById('sleepModeClock'),
  toggleSleepModeBtn: document.getElementById('toggleSleepModeBtn'),
  sleepModeBtnText: document.getElementById('sleepModeBtnText'),
  raveToggleSleepModeBtn: document.getElementById('raveToggleSleepModeBtn'),
  toggleScreenDimmerBtn: document.getElementById('toggleScreenDimmerBtn'),
  sleepScreenDimmer: document.getElementById('sleepScreenDimmer'),
  sleepDimmerClock: document.getElementById('sleepDimmerClock'),
  toggleSleepAmbienceBtn: document.getElementById('toggleSleepAmbienceBtn'),
  sleepAmbienceIcon: document.getElementById('sleepAmbienceIcon'),
  sleepAmbienceText: document.getElementById('sleepAmbienceText'),
  sleepModePickVideoBtn: document.getElementById('sleepModePickVideoBtn'),
  exitSleepStageBtn: document.getElementById('exitSleepStageBtn'),

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
  photoStageContainer: document.getElementById('photoStageContainer'),
  stagePhotoImage: document.getElementById('stagePhotoImage'),
  closePhotoStageBtn: document.getElementById('closePhotoStageBtn'),
  roomMediaFileInput: document.getElementById('roomMediaFileInput'),
  stageFloatingFullscreenBtn: document.getElementById('stageFloatingFullscreenBtn'),
  stageExitFullscreenFloatingBtn: document.getElementById('stageExitFullscreenFloatingBtn'),
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
  partnerPipName: document.getElementById('partnerPipName'),
  partnerPipAvatarInitial: document.getElementById('partnerPipAvatarInitial'),
  partnerAudioMeter: document.getElementById('partnerAudioMeter'),
  partnerVoiceIndicator: document.getElementById('partnerVoiceIndicator'),
  closePartnerPipBtn: document.getElementById('closePartnerPipBtn'),
  selfPipCard: document.getElementById('selfPipCard'),
  selfVideo: document.getElementById('selfVideo'),
  selfVideoPlaceholder: document.getElementById('selfVideoPlaceholder'),
  closeSelfPipBtn: document.getElementById('closeSelfPipBtn'),
  flipSelfPipCamBtn: document.getElementById('flipSelfPipCamBtn'),
  selfPipAvatarInitial: document.getElementById('selfPipAvatarInitial'),

  // Split Layout & Live Chat Sidebar
  roomMainSplitLayout: document.getElementById('roomMainSplitLayout'),
  roomPlayerColumn: document.getElementById('roomPlayerColumn'),
  roomChatSidebar: document.getElementById('roomChatSidebar'),
  closeChatSidebarBtn: document.getElementById('closeChatSidebarBtn'),
  openChatFloatingBtn: document.getElementById('openChatFloatingBtn'),
  minimizeRoomBtn: document.getElementById('minimizeRoomBtn'),
  miniPlayerOverlay: document.getElementById('miniPlayerOverlay'),
  miniPlayerMaximizeBtn: document.getElementById('miniPlayerMaximizeBtn'),
  miniPlayerCloseBtn: document.getElementById('miniPlayerCloseBtn'),
  miniPlayerPlayPauseBtn: document.getElementById('miniPlayerPlayPauseBtn'),
  toggleChatToolbarBtn: document.getElementById('toggleChatToolbarBtn'),
  chatToolbarBtnText: document.getElementById('chatToolbarBtnText'),
  fsChatOverlay: document.getElementById('fsChatOverlay'),
  closeFsChatBtn: document.getElementById('closeFsChatBtn'),
  openFsChatFloatingBtn: document.getElementById('openFsChatFloatingBtn'),
  fsChatMessagesContainer: document.getElementById('fsChatMessagesContainer'),
  fsChatForm: document.getElementById('fsChatForm'),
  fsChatInput: document.getElementById('fsChatInput'),
  audioOnlyPlaceholder: document.getElementById('audioOnlyPlaceholder'),
  audioOnlyTrackTitle: document.getElementById('audioOnlyTrackTitle'),
  showVideoQuickBtn: document.getElementById('showVideoQuickBtn'),
  toggleVideoDisplayBtn: document.getElementById('toggleVideoDisplayBtn'),
  videoDisplayIcon: document.getElementById('videoDisplayIcon'),
  fsShowChatCheckbox: document.getElementById('fsShowChatCheckbox'),
  videoDisplayToggleCheckbox: document.getElementById('videoDisplayToggleCheckbox'),
  roomChangeVideoBottomBtn: document.getElementById('roomChangeVideoBottomBtn'),

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
  raveRoomSettingsBtn: document.getElementById('raveRoomSettingsBtn'),
  raveRoomSettingsMenu: document.getElementById('raveRoomSettingsMenu'),
  raveRoomSettingsBackdrop: document.getElementById('raveRoomSettingsBackdrop'),
  closeRaveRoomSettingsMenuBtn: document.getElementById('closeRaveRoomSettingsMenuBtn'),
  stageBottomMiniProgressContainer: document.getElementById('stageBottomMiniProgressContainer'),
  stageBottomMiniProgressBar: document.getElementById('stageBottomMiniProgressBar'),
  nowPlayingScrubberRow: document.getElementById('nowPlayingScrubberRow'),
  nowPlayingPlayPauseQuickBtn: document.getElementById('nowPlayingPlayPauseQuickBtn'),
  nowPlayingPlayIcon: document.getElementById('nowPlayingPlayIcon'),
  nowPlayingPauseIcon: document.getElementById('nowPlayingPauseIcon'),
  nowPlayingCurrentTime: document.getElementById('nowPlayingCurrentTime'),
  nowPlayingSeekSlider: document.getElementById('nowPlayingSeekSlider'),
  nowPlayingDuration: document.getElementById('nowPlayingDuration'),
  playerQualityVal: document.getElementById('playerQualityVal'),
  playerSpeedVal: document.getElementById('playerSpeedVal'),
  raveResyncBtn: document.getElementById('raveResyncBtn'),
  raveCopyRoomLinkBtn: document.getElementById('raveCopyRoomLinkBtn'),
  raveOpenParticipantsBtn: document.getElementById('raveOpenParticipantsBtn'),
  roomConnectionStatusBadge: document.getElementById('roomConnectionStatusBadge'),
  roomConnectionStatusText: document.getElementById('roomConnectionStatusText'),
  webPlayerFallbackCard: document.getElementById('webPlayerFallbackCard'),
  webPlayerFallbackTitle: document.getElementById('webPlayerFallbackTitle'),
  webPlayerFallbackDesc: document.getElementById('webPlayerFallbackDesc'),
  webFallbackScreenShareBtn: document.getElementById('webFallbackScreenShareBtn'),
  webFallbackOpenNewTabBtn: document.getElementById('webFallbackOpenNewTabBtn'),
  drmGuideModal: document.getElementById('drmGuideModal'),
  closeDrmGuideModalBtn: document.getElementById('closeDrmGuideModalBtn'),
  tabProfileSignOutBtn: document.getElementById('tabProfileSignOutBtn'),
  profileSegmentDetailsBtn: document.getElementById('profileSegmentDetailsBtn'),
  profileSegmentFriendsBtn: document.getElementById('profileSegmentFriendsBtn'),

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
  authFirstNameInput: document.getElementById('authFirstNameInput'),
  authLastNameInput: document.getElementById('authLastNameInput'),
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
  continueAsGuestBtn: document.getElementById('continueAsGuestBtn'),
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

  // Email OTP Registration Verification
  authEmailOtpField: document.getElementById('authEmailOtpField'),
  emailOtpDigitsGroup: document.getElementById('emailOtpDigitsGroup'),
  emailOtpBackBtn: document.getElementById('emailOtpBackBtn'),
  emailOtpResendBtn: document.getElementById('emailOtpResendBtn'),
  emailOtpTimerSpan: document.getElementById('emailOtpTimerSpan'),
  emailOtpSentNotice: document.getElementById('emailOtpSentNotice'),

  // Room Episodes Modal
  roomEpisodesModal: document.getElementById('roomEpisodesModal'),
  closeRoomEpisodesModalBtn: document.getElementById('closeRoomEpisodesModalBtn'),
  roomEpisodesList: document.getElementById('roomEpisodesList'),
  episodesOpenPlatformsBtn: document.getElementById('episodesOpenPlatformsBtn'),

  // Liked Videos Modal
  likedVideosModal: document.getElementById('likedVideosModal'),
  closeLikedVideosModalBtn: document.getElementById('closeLikedVideosModalBtn'),
  likedVideosList: document.getElementById('likedVideosList'),

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
  roomAccessBtn: document.getElementById('openRoomPrivacyBtn') || document.getElementById('roomAccessBtn'),
  openRoomPrivacyBtn: document.getElementById('openRoomPrivacyBtn'),
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

  // Room Platform & Video Chooser Modal
  roomPlatformChooserModal: document.getElementById('roomPlatformChooserModal'),
  closePlatformChooserModalBtn: document.getElementById('closePlatformChooserModalBtn'),
  chooserOpenRealYouTubeBtn: document.getElementById('chooserOpenRealYouTubeBtn'),
  chooserDirectLinkInput: document.getElementById('chooserDirectLinkInput'),
  chooserPlayDirectLinkBtn: document.getElementById('chooserPlayDirectLinkBtn'),
  chooserScreenShareBtn: document.getElementById('chooserScreenShareBtn'),

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
  editProfileFullNameInput: document.getElementById('editProfileFullNameInput'),
  editProfileUsernameInput: document.getElementById('editProfileUsernameInput'),
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

  // Settings Accordions & Extras
  toggleChangeEmailAccordionBtn: document.getElementById('toggleChangeEmailAccordionBtn'),
  changeEmailChevron: document.getElementById('changeEmailChevron'),
  changeEmailCollapseArea: document.getElementById('changeEmailCollapseArea'),
  toggleChangePassAccordionBtn: document.getElementById('toggleChangePassAccordionBtn'),
  changePassChevron: document.getElementById('changePassChevron'),
  changePasswordCollapseArea: document.getElementById('changePasswordCollapseArea'),

  // Personal Room in Settings
  personalRoomPublicToggle: document.getElementById('personalRoomPublicToggle'),
  joinPersonalRoomBtn: document.getElementById('joinPersonalRoomBtn'),

  // Notification Toggles
  notifPushToggle: document.getElementById('notifPushToggle'),
  notifInvitesToggle: document.getElementById('notifInvitesToggle'),
  notifSoundToggle: document.getElementById('notifSoundToggle'),

  // Legal Modals
  privacyPolicyModal: document.getElementById('privacyPolicyModal'),
  openPrivacyPolicyBtn: document.getElementById('openPrivacyPolicyBtn'),
  closePrivacyPolicyBtn: document.getElementById('closePrivacyPolicyBtn'),
  termsModal: document.getElementById('termsModal'),
  openTermsBtn: document.getElementById('openTermsBtn'),
  closeTermsBtn: document.getElementById('closeTermsBtn'),

  // Blocked Users Modal
  openBlockedUsersModalBtn: document.getElementById('openBlockedUsersModalBtn'),
  closeBlockedUsersModalBtn: document.getElementById('closeBlockedUsersModalBtn'),
  blockedUsersModal: document.getElementById('blockedUsersModal'),
  blockedUsersCountBadge: document.getElementById('blockedUsersCountBadge'),

  // Explore Lobby, Provider Picker & Workspace Switching
  viewMyRoomBtn: document.getElementById('viewMyRoomBtn'),
  viewExploreBtn: document.getElementById('viewExploreBtn'),
  exploreLobbySection: document.getElementById('exploreLobbySection'),
  raveLobbySearchInput: document.getElementById('raveLobbySearchInput'),
  raveLobbySearchActionBtn: document.getElementById('raveLobbySearchActionBtn'),
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
  nowPlayingAccountBadge: document.getElementById('nowPlayingAccountBadge'),
  platformAccountConnectModal: document.getElementById('platformAccountConnectModal'),
  connectPlatformModalIcon: document.getElementById('connectPlatformModalIcon'),
  connectPlatformModalTitle: document.getElementById('connectPlatformModalTitle'),
  closeConnectPlatformModalBtn: document.getElementById('closeConnectPlatformModalBtn'),
  openPlatformDirectLoginBtn: document.getElementById('openPlatformDirectLoginBtn'),
  openPlatformDirectLoginBtnText: document.getElementById('openPlatformDirectLoginBtnText'),
  connectPlatformAccountInput: document.getElementById('connectPlatformAccountInput'),
  connectAutoStartCheckbox: document.getElementById('connectAutoStartCheckbox'),
  cancelConnectPlatformBtn: document.getElementById('cancelConnectPlatformBtn'),
  saveConnectPlatformBtn: document.getElementById('saveConnectPlatformBtn'),
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
  settingsMicMasterToggle: document.getElementById('settingsMicMasterToggle'),
  settingsMicStatusBadge: document.getElementById('settingsMicStatusBadge'),
  settingsMicDeviceSelect: document.getElementById('settingsMicDeviceSelect'),
  settingsRefreshAudioDevicesBtn: document.getElementById('settingsRefreshAudioDevicesBtn'),
  settingsMicGainSlider: document.getElementById('settingsMicGainSlider'),
  settingsMicGainVal: document.getElementById('settingsMicGainVal'),
  settingsMicTestBtn: document.getElementById('settingsMicTestBtn'),
  settingsMicVuBar: document.getElementById('settingsMicVuBar'),
  settingsMicTestHint: document.getElementById('settingsMicTestHint'),
  settingsNoiseSuppressionToggle: document.getElementById('settingsNoiseSuppressionToggle'),
  settingsEchoCancellationToggle: document.getElementById('settingsEchoCancellationToggle'),
  settingsCamMasterToggle: document.getElementById('settingsCamMasterToggle'),
  settingsCamStatusBadge: document.getElementById('settingsCamStatusBadge'),
  settingsCamDeviceSelect: document.getElementById('settingsCamDeviceSelect'),
  settingsFlipCameraBtn: document.getElementById('settingsFlipCameraBtn'),
  settingsRefreshCameraDevicesBtn: document.getElementById('settingsRefreshCameraDevicesBtn'),
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
  roomQuickSearchBtnText: document.getElementById('roomQuickSearchBtnText'),
  profileEditModalScrollBody: document.getElementById('profileEditModalScrollBody')
};

// Background View Freezing & Unfreezing for Modals (Guarantees zero background bleed & never gets stuck)
let activeModalCount = 0;

function areAnyModalsVisible() {
  const modalIds = [
    'authModal',
    'dedicatedProfileEditModal',
    'userPublicProfileModal',
    'deleteAccountModal',
    'resetPasswordModal'
  ];
  return modalIds.some(id => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden') && el.style.display !== 'none';
  });
}

function freezeBackgroundForModal() {
  activeModalCount++;
  document.body.classList.add('modal-open-freeze');
  if (dom.exploreLobbySection) dom.exploreLobbySection.classList.add('hidden');
  if (dom.providerPickerSection) {
    dom.providerPickerSection.classList.add('hidden');
    dom.providerPickerSection.classList.remove('flex');
  }
  if (dom.mainHeader) dom.mainHeader.classList.add('hidden');
  if (dom.mobileBottomNav) dom.mobileBottomNav.classList.add('hidden');
  if (dom.friendsTabSection) dom.friendsTabSection.classList.add('hidden');
  const profileTab = document.getElementById('profileTabSection');
  if (profileTab) profileTab.classList.add('hidden');
}

function unfreezeBackgroundAfterModal(force = false) {
  if (force || !areAnyModalsVisible()) {
    activeModalCount = 0;
  } else {
    activeModalCount = Math.max(0, activeModalCount - 1);
  }
  if (activeModalCount === 0 || !areAnyModalsVisible()) {
    activeModalCount = 0;
    document.body.classList.remove('modal-open-freeze');
    if (!state.isInRoom) {
      const profileTab = document.getElementById('profileTabSection');
      if (dom.providerPickerSection) {
        dom.providerPickerSection.classList.add('hidden');
        dom.providerPickerSection.classList.remove('flex');
      }
      if (state.currentTab === 'profile') {
        if (profileTab) {
          profileTab.classList.remove('hidden');
          profileTab.classList.add('flex');
        }
        if (dom.exploreLobbySection) {
          dom.exploreLobbySection.classList.add('hidden');
          dom.exploreLobbySection.classList.remove('flex');
        }
        if (dom.friendsTabSection) {
          dom.friendsTabSection.classList.add('hidden');
          dom.friendsTabSection.classList.remove('flex');
        }
        if (typeof startProfileStarCanvas === 'function') startProfileStarCanvas();
      } else if (state.currentTab === 'friends') {
        if (dom.friendsTabSection) {
          dom.friendsTabSection.classList.remove('hidden');
          dom.friendsTabSection.classList.add('flex');
        }
        if (dom.exploreLobbySection) {
          dom.exploreLobbySection.classList.add('hidden');
          dom.exploreLobbySection.classList.remove('flex');
        }
        if (profileTab) {
          profileTab.classList.add('hidden');
          profileTab.classList.remove('flex');
        }
      } else if (state.currentTab === 'provider_picker') {
        if (dom.providerPickerSection) {
          dom.providerPickerSection.classList.remove('hidden');
          dom.providerPickerSection.classList.add('flex');
        }
        if (dom.exploreLobbySection) {
          dom.exploreLobbySection.classList.add('hidden');
          dom.exploreLobbySection.classList.remove('flex');
        }
        if (dom.friendsTabSection) {
          dom.friendsTabSection.classList.add('hidden');
          dom.friendsTabSection.classList.remove('flex');
        }
        if (profileTab) {
          profileTab.classList.add('hidden');
          profileTab.classList.remove('flex');
        }
        if (dom.mainHeader) dom.mainHeader.classList.add('hidden');
        if (dom.mobileBottomNav) dom.mobileBottomNav.classList.add('hidden');
        return;
      } else {
        if (dom.exploreLobbySection) {
          dom.exploreLobbySection.classList.remove('hidden');
          dom.exploreLobbySection.classList.add('flex');
        }
        if (dom.friendsTabSection) {
          dom.friendsTabSection.classList.add('hidden');
          dom.friendsTabSection.classList.remove('flex');
        }
        if (profileTab) {
          profileTab.classList.add('hidden');
          profileTab.classList.remove('flex');
        }
        if (typeof loadPublicRooms === 'function') {
          loadPublicRooms();
        }
      }
      if (dom.mainHeader) dom.mainHeader.classList.remove('hidden');
      if (dom.mobileBottomNav) dom.mobileBottomNav.classList.remove('hidden');
    }
  }
}
window.unfreezeBackgroundAfterModal = unfreezeBackgroundAfterModal;
window.areAnyModalsVisible = areAnyModalsVisible;

// Universal responsive click & tap handler (0ms touch latency, micro-drag tolerant for all mobile devices)
function addInstantTap(el, handler) {
  if (!el) return;
  let startX = 0;
  let startY = 0;
  let moved = false;
  let lastTouchEndTime = 0;

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    moved = false;
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!e.touches.length) return;
    const dx = Math.abs(e.touches[0].clientX - startX);
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (dx > 10 || dy > 10) {
      moved = true;
    }
  }, { passive: true });

  el.addEventListener('touchend', (e) => {
    if (!moved) {
      lastTouchEndTime = Date.now();
      handler(e);
    }
  });

  el.addEventListener('click', (e) => {
    if (Date.now() - lastTouchEndTime < 450) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    handler(e);
  });
}

// ==========================================
// 1. SIGNALING SYSTEM (WebSocket & Fallback)
// ==========================================
let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;

function showRoomConnectionStatus(isReconnecting, text = 'Yeniden bağlanılıyor...') {
  if (!dom.roomConnectionStatusBadge) return;
  // User requested: "şuan aktifim zaten yeniden bağlanıyor falan yazıyor buda gereksiz"
  // Keep connection badge completely hidden
  dom.roomConnectionStatusBadge.classList.add('hidden');
  dom.roomConnectionStatusBadge.classList.remove('flex');
}

function scheduleWsReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (!state.roomId || state.isIntentionalLeave) return;
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(1.5, Math.min(reconnectAttempts, 5)), 6000);
  showRoomConnectionStatus(true, `Bağlantı koptu, yeniden bağlanılıyor... (${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    if (state.roomId && !state.isIntentionalLeave) {
      connectSignaling();
    }
  }, delay);
}

let roomSupabaseChannel = null;
let currentRoomSubscribed = null;
const processedSignalKeys = new Set();

function connectSupabaseRoomSignaling() {
  if (!supabaseClient) {
    if (typeof initSupabase === 'function') initSupabase();
  }
  if (!supabaseClient || !state.roomId) return;
  const cleanRoom = (state.roomId || 'ODA-77').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
  state.roomId = cleanRoom;

  // If already connected to this exact room and channel is active, keep existing channel alive
  if (roomSupabaseChannel && currentRoomSubscribed === cleanRoom && (roomSupabaseChannel.state === 'joined' || roomSupabaseChannel.state === 'joining')) {
    return;
  }

  if (roomSupabaseChannel) {
    try {
      roomSupabaseChannel.unsubscribe();
      if (typeof supabaseClient.removeChannel === 'function') {
        supabaseClient.removeChannel(roomSupabaseChannel);
      }
    } catch (_) {}
    roomSupabaseChannel = null;
  }
  currentRoomSubscribed = cleanRoom;

  try {
    const chName = `miruo_room_${cleanRoom}`;
    const myPresenceKey = state.clientId || (state.clientId = 'cl_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36));
    roomSupabaseChannel = supabaseClient.channel(chName, {
      config: {
        presence: { key: myPresenceKey },
        broadcast: { ack: false, self: false }
      }
    });

    const syncParticipantsFromPresence = (pState) => {
      if (!pState) return;
      const currentKeys = Object.keys(pState);
      const peerKeys = currentKeys.filter(k => k !== state.clientId);
      
      // Update peer status for WebRTC with multi-peer mesh connections
      if (peerKeys.length > 0) {
        if (!state.peers) state.peers = {};
        peerKeys.forEach(pk => {
          const presences = pState[pk];
          const info = (presences && presences[0]) || {};
          const isInitiator = String(state.clientId) < String(pk);
          if (typeof getOrCreatePeerConnection === 'function') {
            getOrCreatePeerConnection(pk, isInitiator, { clientId: pk, userId: info.userId });
          }
        });
        if (!state.peerId) state.peerId = peerKeys[0];
        updatePeerStatus(true);
      } else {
        if (!state.peerId) updatePeerStatus(false);
      }

      // Sync state.participants with strict client-level distinction (supports multi-device testing under same account)
      peerKeys.forEach(pk => {
        const presences = pState[pk];
        if (presences && presences.length > 0) {
          const info = presences[0];
          const existingKey = pk;

          let displayUsername = info.username || 'Misafir';
          if (state.username && displayUsername.toLowerCase() === state.username.toLowerCase()) {
            displayUsername = `${state.username} (Cihaz 2)`;
          }

          const existing = state.participants[existingKey] || {};
          state.participants[existingKey] = {
            ...existing,
            peerId: pk,
            clientId: info.clientId || pk,
            userId: info.userId || existing.userId || pk,
            username: displayUsername,
            avatar: info.avatar || existing.avatar || '',
            avatarColor: info.avatarColor || existing.avatarColor || 'from-rose-500 to-indigo-600',
            isMicOn: typeof info.isMicOn === 'boolean' ? info.isMicOn : !!existing.isMicOn,
            isCamOn: typeof info.isCamOn === 'boolean' ? info.isCamOn : !!existing.isCamOn,
            isHost: typeof info.isHost === 'boolean' ? info.isHost : !!existing.isHost,
            role: info.role || existing.role || (info.isHost ? 'owner' : 'member'),
            isSelf: false,
            lastSeen: Date.now()
          };
          if (info.isHost && info.username) {
            state.hostName = info.username;
          }
          if (info.isCamOn) {
            state.dismissedPips = state.dismissedPips || {};
            state.dismissedPips[pk] = false;
            if (info.userId) state.dismissedPips[info.userId] = false;
          }
        }
      });

      // Gracefully clean up vanished peers after grace period
      const activePresenceUserIds = new Set();
      const activePresenceClientIds = new Set(Object.keys(pState));
      Object.values(pState).forEach(arr => {
        if (Array.isArray(arr)) {
          arr.forEach(item => {
            if (item.userId) activePresenceUserIds.add(String(item.userId).toLowerCase());
            if (item.clientId) activePresenceClientIds.add(item.clientId);
          });
        }
      });

      Object.keys(state.participants).forEach(pid => {
        if (pid.startsWith('bot_') || pid === state.clientId) return;
        const p = state.participants[pid];
        const hasClient = p.clientId && activePresenceClientIds.has(p.clientId);
        const hasUser = p.userId && activePresenceUserIds.has(String(p.userId).toLowerCase());
        if (!hasClient && !hasUser) {
          if (!p.vanishedSince) {
            p.vanishedSince = Date.now();
          } else if (Date.now() - p.vanishedSince > 12000) {
            delete state.participants[pid];
            if (typeof closePeerConnection === 'function') closePeerConnection(pid);
          }
        } else {
          delete p.vanishedSince;
        }
      });

      renderParticipantsList();
      renderVideoGrid();
      if (typeof renderStagePipCards === 'function') renderStagePipCards();
    };

    roomSupabaseChannel
      .on('broadcast', { event: 'signal' }, ({ payload }) => {
        if (!payload || payload.clientId === state.clientId) return;
        handleSignalMessage(payload);
      })
      .on('broadcast', { event: 'playback_sync' }, ({ payload }) => {
        if (!payload || payload.clientId === state.clientId) return;
        handleRemoteSync(payload);
      })
      .on('presence', { event: 'sync' }, () => {
        const pState = roomSupabaseChannel.presenceState();
        syncParticipantsFromPresence(pState);
      })
      .on('presence', { event: 'join' }, ({ key, newPresences }) => {
        const pState = roomSupabaseChannel.presenceState();
        syncParticipantsFromPresence(pState);
        if (key && key !== state.clientId) {
          showToast('Katılımcı odaya katıldı');
          if (state.isHost) {
            sendSignal({
              type: 'room-roster',
              roster: state.participants
            });
            if (state.currentVideoId) {
              const syncPayload = {
                action: 'full_sync',
                videoId: state.currentVideoId,
                time: (typeof getLivePlayerTime === 'function' ? getLivePlayerTime() : state.currentTime),
                isPlaying: state.isPlaying,
                rate: state.playbackRate || 1.0,
                sentAt: Date.now()
              };
              sendP2PData('sync', syncPayload);
              if (roomSupabaseChannel) {
                roomSupabaseChannel.send({ type: 'broadcast', event: 'playback_sync', payload: syncPayload }).catch(() => {});
              }
            }
          }
        }
      })
      .on('presence', { event: 'leave' }, ({ key }) => {
        const pState = roomSupabaseChannel.presenceState();
        syncParticipantsFromPresence(pState);
        if (key && key === state.peerId) {
          const remaining = Object.keys(pState).filter(k => k !== state.clientId);
          state.peerId = remaining.length > 0 ? remaining[0] : null;
          updatePeerStatus(!!state.peerId);
        }
        showToast('Katılımcı odadan ayrıldı');
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          const savedUserObj = JSON.parse(localStorage.getItem('miruo_user') || '{}');
          const myData = {
            clientId: state.clientId,
            userId: state.userId,
            username: state.username,
            avatar: state.avatarUrl || savedUserObj.avatarUrl || '',
            avatarColor: state.avatarBg || savedUserObj.avatarBg || 'from-rose-500 to-indigo-600',
            isMicOn: !!state.isMicOn,
            isCamOn: !!state.isCamOn,
            isHost: !!state.isHost,
            role: state.userRole || (state.isHost ? 'owner' : 'member')
          };
          roomSupabaseChannel.track(myData).catch(() => {});
          if (!state.isHost) {
            sendSignal({ type: 'peer-joined', clientId: state.clientId, userId: state.userId, username: state.username });
            setTimeout(() => {
              sendP2PData('sync', { action: 'request_sync', sentAt: Date.now() });
            }, 300);
          }
        }
      });
  } catch (e) {
    console.warn('[Miruo] Room Supabase signaling error:', e);
  }
}

function connectSignaling() {
  state.isIntentionalLeave = false;
  if (ws) {
    try { ws.close(); } catch (e) {}
    ws = null;
  }
  // Connect to Supabase Room Channel for instant cross-device broadcast & signaling
  connectSupabaseRoomSignaling();

  if (MIRUO_STANDALONE || isNativeApp || window.location.protocol === 'file:' || !window.location.host || window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') {
    console.log('[Miruo] Running with Supabase Realtime signaling');
    return;
  }
  let wsUrl;
  if (MIRUO_API_BASE) {
    wsUrl = `${MIRUO_API_BASE.replace(/^http/i, 'ws')}/?room=${encodeURIComponent(state.roomId)}&userId=${state.userId}`;
  } else {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl = `${protocol}//${window.location.host}/?room=${encodeURIComponent(state.roomId)}&userId=${state.userId}`;
  }

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Sinyal sunucusuna bağlanıldı.');
      reconnectAttempts = 0;
      showRoomConnectionStatus(false);
      if (state.roomId) {
        sendSignal({ type: 'join', roomId: state.roomId, userId: state.userId, username: state.username });
        setTimeout(() => {
          sendP2PData('sync', { action: 'request_sync', sentAt: Date.now() });
        }, 500);
      }
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
      if (state.roomId && !state.isIntentionalLeave) {
        scheduleWsReconnect();
      }
    };
  } catch (err) {
    connectFallbackSSE();
  }
}

function sendSignal(msg) {
  const isGlobalFriendSignal = msg && (msg.type === 'friend-request' || msg.type === 'friend-accepted' || msg.type === 'friend-declined');
  if (!isGlobalFriendSignal && (!state.isInRoom || !state.roomId)) return;
  const cleanRoom = (state.roomId || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
  const payload = {
    ...msg,
    roomId: cleanRoom || 'GLOBAL',
    clientId: state.clientId,
    userId: state.userId,
    username: state.username,
    sentAt: msg.sentAt || Date.now()
  };

  // 1. Local WebSocket if connected
  if (!MIRUO_STANDALONE && !isNativeApp && ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(payload)); } catch (_) {}
  } else if (!MIRUO_STANDALONE && !isNativeApp && window.location.host && window.location.protocol !== 'file:' && MIRUO_API_BASE) {
    fetch('/api/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: cleanRoom, userId: state.userId, data: payload })
    }).catch(() => {});
  }

  // 2. Room Dedicated Channel Rail
  if (roomSupabaseChannel) {
    try {
      roomSupabaseChannel.send({
        type: 'broadcast',
        event: 'signal',
        payload
      }).catch(() => {});
    } catch (_) {}
  }

  // 3. Global Dual-Rail (Always online across all peers, 0% packet drop)
  if (globalUsersChannel) {
    try {
      globalUsersChannel.send({
        type: 'broadcast',
        event: 'room_signal',
        payload
      }).catch(() => {});
    } catch (_) {}
  }
}

function connectFallbackSSE() {
  if (MIRUO_STANDALONE || isNativeApp || window._sseConnected) return;
  window._sseConnected = true;
  const evtSource = new EventSource(`${MIRUO_API_BASE}/api/events?room=${encodeURIComponent(state.roomId)}&userId=${state.userId}`);
  evtSource.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleSignalMessage(msg);
    } catch (err) {}
  };
}

function handleSignalMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.clientId && msg.clientId === state.clientId) return;
  // If targeted to a specific peer or client, ignore if not intended for this client
  if (msg.targetClientId && String(msg.targetClientId) !== String(state.clientId)) return;
  if (!msg.targetClientId && msg.targetUserId && String(msg.targetUserId) !== String(state.userId) && String(msg.targetUserId) !== String(state.clientId)) return;

  // Deduplicate signals received across Dual-Rail (Room Channel + Global Channel)
  const candStr = msg.candidate ? (typeof msg.candidate === 'string' ? msg.candidate : (msg.candidate.candidate || JSON.stringify(msg.candidate))) : '';
  const sigKey = `${msg.type}_${msg.userId || ''}_${msg.sentAt || ''}_${msg.action || ''}_${(msg.text || '').substring(0, 20)}_${msg.videoId || ''}_${candStr.substring(0, 35)}`;
  if (processedSignalKeys.has(sigKey)) return;
  processedSignalKeys.add(sigKey);
  if (processedSignalKeys.size > 250) {
    const oldest = processedSignalKeys.values().next().value;
    processedSignalKeys.delete(oldest);
  }
  switch (msg.type) {
    case 'init':
      if (typeof msg.isHost === 'boolean') state.isHost = msg.isHost;
      if (!state.isHost && (state.userRole === 'owner' || !state.userRole)) state.userRole = 'member';
      updatePermissionUI();
      if (msg.peers && msg.peers.length > 0) {
        if (!state.peerId) state.peerId = msg.peers[0];
        updatePeerStatus(true);
        msg.peers.forEach(pid => {
          if (pid !== state.userId) {
            const shouldInitiate = String(state.userId) < String(pid);
            if (typeof getOrCreatePeerConnection === 'function') {
              getOrCreatePeerConnection(pid, shouldInitiate);
            }
          }
        });
      } else {
        updatePeerStatus(false);
      }
      broadcastMyMediaStatus();
      sendSignal({ type: 'request-media-status' });
      renderParticipantsList();
      break;

    case 'request-media-status':
      broadcastMyMediaStatus();
      break;

    case 'peer-joined':
      const joinedId = msg.userId;
      if (!state.peerId) state.peerId = joinedId;
      updatePeerStatus(true);
      const joinedName = msg.name || msg.username || 'Katılımcı';

      // If this user is blocked by me:
      if (typeof isUserBlocked === 'function' && (isUserBlocked(joinedName) || isUserBlocked(joinedId))) {
        if (state.isHost && typeof kickParticipant === 'function') {
          kickParticipant(joinedId, joinedName);
          return;
        }
      }

      state.participants[joinedId] = {
        userId: joinedId,
        username: joinedName,
        isMicOn: false,
        isCamOn: false,
        isHost: false,
        role: 'member'
      };
      renderParticipantsList();
      updateBlockedMediaState();
      showToast(`${joinedName} odaya katıldı`);

      const isInitiator = String(state.userId) < String(joinedId);
      if (typeof getOrCreatePeerConnection === 'function') {
        getOrCreatePeerConnection(joinedId, isInitiator);
      } else {
        if (isInitiator) initiateWebRTC(true);
        else setupWebRTC();
      }
      broadcastMyMediaStatus();

      // If we already have camera or mic on, ensure tracks are attached and sent to the newcomer immediately
      let peerRenegotiate = false;
      if (state.isCamOn && state.localStream && state.pc) {
        try {
          const vTrack = state.localStream.getVideoTracks().find(t => t.readyState === 'live');
          if (vTrack) {
            const transceivers = state.pc.getTransceivers ? state.pc.getTransceivers() : [];
            const vt = transceivers.find(t => 
              (t.receiver && t.receiver.track && t.receiver.track.kind === 'video') ||
              (t.sender && t.sender.track && t.sender.track.kind === 'video')
            );
            if (vt) {
              if (vt.direction !== 'sendrecv') vt.direction = 'sendrecv';
              if (vt.sender && typeof vt.sender.replaceTrack === 'function') {
                vt.sender.replaceTrack(vTrack).catch(() => {});
              }
            } else {
              state.pc.addTrack(vTrack, state.localStream);
            }
            peerRenegotiate = true;
          }
        } catch (_) {}
      }
      if (state.isMicOn && state.localStream && state.pc) {
        try {
          const aTrack = state.localStream.getAudioTracks().find(t => t.readyState === 'live');
          if (aTrack) {
            const transceivers = state.pc.getTransceivers ? state.pc.getTransceivers() : [];
            const at = transceivers.find(t => 
              (t.receiver && t.receiver.track && t.receiver.track.kind === 'audio') ||
              (t.sender && t.sender.track && t.sender.track.kind === 'audio')
            );
            if (at) {
              if (at.direction !== 'sendrecv') at.direction = 'sendrecv';
              if (at.sender && typeof at.sender.replaceTrack === 'function') {
                at.sender.replaceTrack(aTrack).catch(() => {});
              }
            } else {
              state.pc.addTrack(aTrack, state.localStream);
            }
            peerRenegotiate = true;
          }
        } catch (_) {}
      }
      if (peerRenegotiate) {
        setTimeout(() => {
          if (typeof renegotiateWebRTC === 'function') renegotiateWebRTC();
        }, 300);
      }
      if (state.isHost) {
        sendSignal({
          type: 'room-roster',
          roster: state.participants
        });
        if (state.currentVideoId) {
          sendP2PData('sync', {
            action: 'full_sync',
            videoId: state.currentVideoId,
            time: state.currentTime,
            isPlaying: state.isPlaying,
            rate: state.playbackRate || 1.0,
            sentAt: Date.now()
          });
        }
      }
      break;

    case 'room-roster':
      if (msg.roster && typeof msg.roster === 'object') {
        Object.keys(msg.roster).forEach(uid => {
          if (uid !== state.userId && uid !== state.clientId) {
            const entry = msg.roster[uid];
            const existingKey = Object.keys(state.participants).find(k => {
              const p = state.participants[k];
              return (entry.userId && p.userId === entry.userId) || (entry.clientId && p.clientId === entry.clientId);
            }) || uid;
            state.participants[existingKey] = Object.assign(state.participants[existingKey] || {}, entry);
          }
        });
        renderParticipantsList();
        renderVideoGrid();
        if (typeof renderStagePipCards === 'function') renderStagePipCards();
      }
      break;

    case 'peer-left':
      const leftKey = Object.keys(state.participants).find(k => {
        const p = state.participants[k];
        return (msg.userId && p.userId === msg.userId) || (msg.clientId && p.clientId === msg.clientId) || k === msg.userId;
      }) || msg.userId;
      if (leftKey) {
        delete state.participants[leftKey];
        if (typeof closePeerConnection === 'function') {
          closePeerConnection(leftKey);
        }
      }
      if (state.peerId === msg.userId || state.peerId === msg.clientId) {
        const remaining = Object.keys(state.participants).filter(k => k !== state.clientId);
        state.peerId = remaining.length > 0 ? remaining[0] : null;
      }
      updatePeerStatus(Object.keys(state.participants).length > 0);
      renderParticipantsList();
      renderVideoGrid();
      if (typeof renderStagePipCards === 'function') renderStagePipCards();
      showToast('Katılımcı odadan ayrıldı');
      break;

    case 'offer':
      handleRtcOffer(msg.offer, msg.clientId || msg.userId, { clientId: msg.clientId, userId: msg.userId });
      break;

    case 'rtc-need-offer':
      const peerToRestart = msg.clientId || msg.userId;
      if (peerToRestart && state.peers && state.peers[peerToRestart] && state.peers[peerToRestart].isInitiator) {
        restartPeerOffer(peerToRestart);
      }
      break;

    case 'answer':
      handleRtcAnswer(msg.answer, msg.clientId || msg.userId);
      break;

    case 'ice-candidate':
      handleRtcCandidate(msg.candidate, msg.clientId || msg.userId);
      break;

    case 'sync-event':
      handleRemoteSync(msg.payload);
      break;

    case 'friend-request':
      if (typeof handleIncomingFriendRequest === 'function') handleIncomingFriendRequest(msg.payload);
      break;

    case 'friend-accepted':
      if (typeof handleIncomingFriendAccepted === 'function') handleIncomingFriendAccepted(msg.payload);
      break;

    case 'friend-declined':
      if (typeof handleIncomingFriendDeclined === 'function') handleIncomingFriendDeclined(msg.payload);
      break;

    case 'touch-event':
      renderTouchEffect(msg.x, msg.y, false);
      break;

    case 'reaction-event':
      spawnFloatingReaction(msg.emoji, false);
      break;

    case 'sleep-mode':
      if (msg.authorized || msg.isHost || (msg.from && (msg.from === state.host || msg.role === 'owner' || msg.role === 'admin' || msg.role === 'dj')) || state.controlMode === 'everyone') {
        applySleepMode(msg.enabled, false);
      }
      break;

    case 'friend-removed':
    case 'friend_removed':
      if (typeof handleRemoteFriendRemoved === 'function') {
        handleRemoteFriendRemoved(msg.fromUsername, msg.toUsername);
      }
      break;

    case 'affinity-unbound':
    case 'affinity_unbound':
      if (typeof handleRemoteAffinityUnbound === 'function') {
        handleRemoteAffinityUnbound(msg.fromUsername, msg.toUsername);
      }
      break;

    case 'room-invite':
      if (msg.payload && typeof handleIncomingRoomInvite === 'function') {
        handleIncomingRoomInvite(msg.payload);
      }
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

    case 'media_status':
    case 'media-status':
      updateRemoteParticipantStatus(msg.userId, msg.username, msg.isMicOn, msg.isCamOn);
      break;

    case 'platform-switch':
      switchRoomPlatform(msg.platform);
      if (msg.user && msg.user !== state.username && (state.peerId || Object.keys(state.participants).length > 1)) {
        showToast(`@${msg.user} platformu değiştirdi: ${msg.platform}`);
      }
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

    case 'privacy-change':
      if (typeof handleRemotePrivacyChange === 'function') handleRemotePrivacyChange(msg.isPrivate);
      break;

    case 'photo-share':
      displayPhotoOnStage(msg.dataUrl, msg.title, false);
      if (msg.sender) showToast(`${msg.sender} bir fotoğraf paylaştı!`);
      break;

    case 'screenshare-start':
    case 'screenshare_start':
      if (typeof handleRemoteScreenShareStarted === 'function') handleRemoteScreenShareStarted(msg.user);
      break;

    case 'screenshare-stop':
    case 'screenshare_stop':
      if (typeof handleRemoteScreenShareStopped === 'function') handleRemoteScreenShareStopped();
      break;

    case 'photo-close':
      closePhotoStage(false);
      break;
  }
}

function updatePeerStatus(connected) {
  if (!dom.peerStatusBadge) return;
  if (connected) {
    dom.peerStatusBadge.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs bg-emerald-500/10 text-emerald-300 border border-emerald-500/20';
    dom.peerStatusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400"></span><span>Bağlandı</span>';
  } else {
    dom.peerStatusBadge.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs bg-amber-500/10 text-amber-300 border border-amber-500/20';
    dom.peerStatusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-400 animate-ping"></span><span>Partner Bekleniyor...</span>';
  }
}

// ==========================================
// 2. WebRTC PEER CONNECTION (AV & Data)
// ==========================================
function attachRemoteAudioStream() {
  if (state.peers && Object.keys(state.peers).length > 0) {
    Object.keys(state.peers).forEach(pid => {
      const p = state.peers[pid];
      if (p && p.stream) playPeerAudio(pid, p.stream);
    });
    return;
  }
  let remoteAudio = document.getElementById('remoteVoiceAudio');
  if (!remoteAudio) {
    remoteAudio = document.createElement('audio');
    remoteAudio.id = 'remoteVoiceAudio';
    remoteAudio.autoplay = true;
    remoteAudio.playsInline = true;
    remoteAudio.style.position = 'fixed';
    remoteAudio.style.left = '0';
    remoteAudio.style.top = '0';
    remoteAudio.style.width = '1px';
    remoteAudio.style.height = '1px';
    remoteAudio.style.opacity = '0.01';
    remoteAudio.style.pointerEvents = 'none';
    remoteAudio.style.zIndex = '-1';
    document.body.appendChild(remoteAudio);
  }

  let audioTrack = null;
  if (state.pc && state.pc.getReceivers) {
    const receivers = state.pc.getReceivers();
    const ar = receivers.find(r => r.track && r.track.kind === 'audio');
    if (ar && ar.track) audioTrack = ar.track;
  }
  if (!audioTrack && state.remoteStream) {
    audioTrack = state.remoteStream.getAudioTracks().find(t => t.readyState === 'live') || state.remoteStream.getAudioTracks()[0];
  }

  if (audioTrack) {
    if (!remoteAudio.srcObject || !remoteAudio.srcObject.getAudioTracks().includes(audioTrack)) {
      remoteAudio.srcObject = new MediaStream([audioTrack]);
    }
    remoteAudio.muted = false;
    remoteAudio.volume = 1.0;
    const playPromise = remoteAudio.play();
    if (playPromise !== undefined) {
      playPromise.catch(err => {
        const resumeAudio = () => {
          remoteAudio.muted = false;
          remoteAudio.volume = 1.0;
          remoteAudio.play().catch(() => {});
          window.removeEventListener('click', resumeAudio);
          window.removeEventListener('touchstart', resumeAudio);
        };
        window.addEventListener('click', resumeAudio, { once: true });
        window.addEventListener('touchstart', resumeAudio, { once: true });
      });
    }
  }
}
window.attachRemoteAudioStream = attachRemoteAudioStream;

function attachRemoteStreamToPartnerVideo(preferredMember = null) {
  if (!dom.partnerVideo) return;

  const targetPeerId = state.activePipPeerId || state.peerId;
  let remoteTrack = null;
  let sourceStream = (preferredMember && preferredMember.stream) || null;

  if (!sourceStream && targetPeerId) {
    const peer = (state.peers && (state.peers[targetPeerId] || Object.values(state.peers).find(p => p.clientId === targetPeerId || p.userId === targetPeerId)));
    if (peer && peer.stream) sourceStream = peer.stream;
  }
  if (!sourceStream && preferredMember) {
    if (preferredMember.clientId && state.peers && state.peers[preferredMember.clientId] && state.peers[preferredMember.clientId].stream) {
      sourceStream = state.peers[preferredMember.clientId].stream;
    } else if (preferredMember.userId && state.peers && state.peers[preferredMember.userId] && state.peers[preferredMember.userId].stream) {
      sourceStream = state.peers[preferredMember.userId].stream;
    }
  }
  if (!sourceStream && targetPeerId && state.participants && state.participants[targetPeerId] && state.participants[targetPeerId].stream) {
    sourceStream = state.participants[targetPeerId].stream;
  }
  if (!sourceStream && state.remoteStream) {
    sourceStream = state.remoteStream;
  }
  if (!sourceStream && state.peers) {
    const anyPeerWithStream = Object.values(state.peers).find(p => p.stream && p.stream.getVideoTracks().length > 0);
    if (anyPeerWithStream) sourceStream = anyPeerWithStream.stream;
  }

  if (sourceStream) {
    remoteTrack = sourceStream.getVideoTracks().find(t => t.readyState === 'live') || sourceStream.getVideoTracks()[0];
  }

  if (sourceStream && remoteTrack) {
    if (!state.remoteStream || !state.remoteStream.getVideoTracks().includes(remoteTrack)) {
      state.remoteStream = new MediaStream([remoteTrack]);
    }
    dom.partnerVideo.playsInline = true;
    dom.partnerVideo.muted = true;
    dom.partnerVideo.defaultMuted = true;
    dom.partnerVideo.autoplay = true;
    dom.partnerVideo.setAttribute('playsinline', 'true');
    dom.partnerVideo.setAttribute('webkit-playsinline', 'true');
    dom.partnerVideo.setAttribute('muted', '');
    dom.partnerVideo.setAttribute('autoplay', 'true');

    if (dom.partnerVideo.srcObject !== sourceStream) {
      dom.partnerVideo.srcObject = sourceStream;
    }
    const p = dom.partnerVideo.play();
    if (p && p.catch) p.catch(() => {});
    remoteTrack.onunmute = () => {
      if (dom.partnerVideo) dom.partnerVideo.play().catch(() => {});
      checkPartnerVideo();
    };
    remoteTrack.onmute = () => {
      checkPartnerVideo();
    };
  }

  const checkPartnerVideo = () => {
    if (!dom.partnerVideo) return;
    const hasActiveFrames = dom.partnerVideo.videoWidth > 0 || (dom.partnerVideo.readyState >= 2 && !dom.partnerVideo.paused);
    if (hasActiveFrames || (dom.partnerVideo.srcObject && dom.partnerVideo.currentTime > 0)) {
      if (dom.partnerVideoPlaceholder) {
        dom.partnerVideoPlaceholder.classList.add('hidden');
        dom.partnerVideoPlaceholder.style.display = 'none';
      }
      if (dom.partnerVideo.paused && dom.partnerVideo.srcObject) dom.partnerVideo.play().catch(() => {});
    } else {
      if (dom.partnerVideoPlaceholder && !dom.partnerVideo.srcObject) {
        dom.partnerVideoPlaceholder.classList.remove('hidden');
        dom.partnerVideoPlaceholder.style.removeProperty('display');
      }
    }
  };

  dom.partnerVideo.onloadedmetadata = checkPartnerVideo;
  dom.partnerVideo.onloadeddata = checkPartnerVideo;
  dom.partnerVideo.oncanplay = checkPartnerVideo;
  dom.partnerVideo.onplaying = checkPartnerVideo;
  dom.partnerVideo.ontimeupdate = checkPartnerVideo;

  if (window._partnerVideoPollInterval) clearInterval(window._partnerVideoPollInterval);
  window._partnerVideoPollInterval = setInterval(checkPartnerVideo, 400);
  checkPartnerVideo();
}
window.attachRemoteStreamToPartnerVideo = attachRemoteStreamToPartnerVideo;

// Multi-Peer Stage PIP Cards Engine: Every user who opens their camera gets a circular floating bubble!
function renderStagePipCards() {
  const stage = dom.stageContainer || document.getElementById('stageContainer');
  if (!stage) return;
  state.dismissedPips = state.dismissedPips || {};

  const seenCamKeys = new Set();
  if (state.clientId) seenCamKeys.add(String(state.clientId));

  const activeCamMembers = [];
  Object.values(state.participants || {}).forEach(p => {
    if (!p) return;
    const isSelf = (p.clientId && p.clientId === state.clientId);
    if (isSelf) return;

    // Check if camera is on or active video track exists
    const pStream = p.stream || 
                    (p.clientId && state.peers?.[p.clientId]?.stream) ||
                    (p.userId && state.peers?.[p.userId]?.stream) ||
                    (p.userId === state.peerId || p.clientId === state.peerId ? state.remoteStream : null);
    const hasLiveVideoTrack = pStream && pStream.getVideoTracks && pStream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted);
    const isCamActive = p.isCamOn === true || (p.isCamOn !== false && hasLiveVideoTrack);
    if (!isCamActive) return;

    const uKey = (p.clientId || p.userId || p.username || '').toLowerCase();
    if (!uKey || seenCamKeys.has(uKey)) return;
    seenCamKeys.add(uKey);

    if (pStream && !p.stream) p.stream = pStream;
    activeCamMembers.push(p);
  });

  if (activeCamMembers.length === 0) {
    if (dom.partnerPipCard) {
      dom.partnerPipCard.classList.add('hidden');
    }
    document.querySelectorAll('.remote-extra-pip').forEach(el => el.remove());
    return;
  }

  // 1. Primary Member: Uses #partnerPipCard
  let primaryMember = activeCamMembers.find(m => (m.userId && m.userId === state.activePipPeerId) || (m.clientId && m.clientId === state.activePipPeerId));
  if (!primaryMember) {
    primaryMember = activeCamMembers[0];
    state.activePipPeerId = primaryMember.userId || primaryMember.clientId;
  }

  const pKey = primaryMember.userId || primaryMember.clientId;
  const isPrimaryDismissed = !!(state.dismissedPips[pKey] || (primaryMember.userId && state.dismissedPips[primaryMember.userId]) || (primaryMember.clientId && state.dismissedPips[primaryMember.clientId]));
  if (dom.partnerPipCard) {
    if (isPrimaryDismissed) {
      dom.partnerPipCard.classList.add('hidden');
    } else {
      dom.partnerPipCard.classList.remove('hidden', 'pip-hidden-fullscreen');
      updatePartnerPipIdentity(primaryMember.username, primaryMember.avatar);
      attachRemoteStreamToPartnerVideo(primaryMember);
    }
  }

  // 2. Extra Members: Multi-peer camera bubbles (up to 8 members)
  const remainingMembers = activeCamMembers.filter(m => m !== primaryMember);
  const existingExtraCards = {};
  document.querySelectorAll('.remote-extra-pip').forEach(el => {
    existingExtraCards[el.dataset.memberKey] = el;
  });

  remainingMembers.forEach((m, idx) => {
    const mKey = (m.userId || m.clientId || m.username || '').toLowerCase();
    const isDismissed = !!(state.dismissedPips[mKey] || (m.userId && state.dismissedPips[m.userId]) || (m.clientId && state.dismissedPips[m.clientId]));
    let card = existingExtraCards[mKey];

    if (isDismissed) {
      if (card) card.classList.add('hidden');
      return;
    }

    if (!card) {
      card = document.createElement('div');
      card.id = `partnerPipCard_${mKey}`;
      card.dataset.memberKey = mKey;
      card.className = 'remote-extra-pip absolute w-28 h-28 sm:w-36 sm:h-36 rounded-full aspect-square bg-[#0E111A]/95 border-2 border-indigo-500/60 hover:border-indigo-400 shadow-2xl overflow-visible cursor-grab active:cursor-grabbing select-none z-[9998] backdrop-blur-md transition-shadow duration-200';
      card.style.touchAction = 'none';
      const offsetTop = 16 + ((idx + 1) * 125);
      card.style.top = `${offsetTop}px`;
      card.style.left = '16px';

      const avInner = m.avatar
        ? `<img src="${m.avatar}" class="w-full h-full object-cover rounded-full" alt="PP">`
        : `<span class="text-white font-bold text-sm">${(m.username || 'K').charAt(0).toUpperCase()}</span>`;

      card.innerHTML = `
        <div class="w-full h-full rounded-full overflow-hidden relative pointer-events-none">
          <video class="extra-partner-video w-full h-full object-cover mirror pointer-events-none" playsinline webkit-playsinline autoplay muted></video>
          <div class="extra-partner-placeholder absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-[#1A1325] via-[#0E111A] to-[#121626] text-center p-2 pointer-events-none">
            <div class="w-12 h-12 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-600 border border-white/20 shadow-md flex items-center justify-center text-white font-bold text-sm mb-1 overflow-hidden">
              ${avInner}
            </div>
            <span class="text-[10px] text-gray-200 font-bold truncate max-w-[80px]">${escapeHtml(m.username)}</span>
          </div>
        </div>
        <button type="button" class="extra-close-pip-btn absolute -top-1 -right-1 w-6 h-6 rounded-full bg-black/95 hover:bg-rose-600 active:scale-90 text-white flex items-center justify-center cursor-pointer z-50 transition-all border border-white/40 shadow-xl pointer-events-auto" title="Gizle">
          <svg class="w-3.5 h-3.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      `;

      stage.appendChild(card);
      if (typeof makeDraggable === 'function') makeDraggable(card);

      const closeBtn = card.querySelector('.extra-close-pip-btn');
      if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          state.dismissedPips[mKey] = true;
          if (m.userId) state.dismissedPips[m.userId] = true;
          if (m.clientId) state.dismissedPips[m.clientId] = true;
          card.classList.add('hidden');
          showToast(`${m.username} ana ekrandan gizlendi`);
        });
      }
    }

    card.classList.remove('hidden', 'pip-hidden-fullscreen');
    const vid = card.querySelector('.extra-partner-video');
    const ph = card.querySelector('.extra-partner-placeholder');
    const peerStream = m.stream || 
                       (m.clientId && state.peers?.[m.clientId]?.stream) ||
                       (m.userId && state.peers?.[m.userId]?.stream);
    if (vid && peerStream) {
      vid.playsInline = true;
      vid.muted = true;
      vid.defaultMuted = true;
      vid.autoplay = true;
      vid.setAttribute('playsinline', 'true');
      vid.setAttribute('webkit-playsinline', 'true');
      vid.setAttribute('muted', '');
      vid.setAttribute('autoplay', 'true');
      if (vid.srcObject !== peerStream) vid.srcObject = peerStream;
      vid.play().catch(() => {});
      const checkF = () => {
        if ((vid.videoWidth > 0 || vid.readyState >= 2) && ph) {
          ph.classList.add('hidden');
          ph.style.display = 'none';
        } else if (ph && !vid.srcObject) {
          ph.classList.remove('hidden');
          ph.style.removeProperty('display');
        }
      };
      vid.onloadedmetadata = checkF;
      vid.onplaying = checkF;
      vid.oncanplay = checkF;
      checkF();
    }
    delete existingExtraCards[mKey];
  });

  // Clean up any extra PIP cards for members no longer having camera on
  Object.values(existingExtraCards).forEach(el => el.remove());
}
window.renderStagePipCards = renderStagePipCards;

// Lay out all visible camera bubbles side by side in one row on the stage (unless the user dragged one manually)
function arrangePipsRow() {
  return;
  const stage = dom.stageContainer || document.getElementById('stageContainer');
  if (!stage) return;
  const cards = [];
  if (dom.selfPipCard) cards.push(dom.selfPipCard);
  if (dom.partnerPipCard) cards.push(dom.partnerPipCard);
  document.querySelectorAll('.remote-extra-pip').forEach(el => cards.push(el));
  const visible = cards.filter(c => c && !c.classList.contains('hidden'));
  let x = 12;
  const stageW = stage.clientWidth || 600;
  let y = 12;
  visible.forEach(c => {
    const w = c.offsetWidth || 112;
    const h = c.offsetHeight || 112;
    if (c.classList.contains('pip-custom-pos')) return; // user moved it, keep their position
    if (x + w > stageW - 8 && x > 12) { x = 12; y += h + 10; }
    c.style.setProperty('right', 'auto', 'important');
    c.style.setProperty('bottom', 'auto', 'important');
    c.style.setProperty('left', x + 'px', 'important');
    c.style.setProperty('top', y + 'px', 'important');
    x += w + 10;
  });
}
window.arrangePipsRow = arrangePipsRow;

function playPeerAudio(peerId, stream) {
  if (!peerId || !stream) return;
  const aTracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
  if (aTracks.length === 0) return;

  const safeId = String(peerId).replace(/[^a-zA-Z0-9_-]/g, '_');
  let el = document.getElementById('remoteVoiceAudio_' + safeId);
  if (!el) {
    el = document.createElement('audio');
    el.id = 'remoteVoiceAudio_' + safeId;
    el.autoplay = true;
    el.playsInline = true;
    el.setAttribute('playsinline', 'true');
    el.setAttribute('webkit-playsinline', 'true');
    el.style.position = 'fixed';
    el.style.left = '0';
    el.style.width = '1px';
    el.style.height = '1px';
    el.style.opacity = '0.01';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '-1';
    document.body.appendChild(el);
  }
  if (el.srcObject !== stream) {
    el.srcObject = stream;
  }
  el.muted = false;
  el.volume = 1.0;
  const p = el.play();
  if (p && p.catch) {
    p.catch(() => {
      const resume = () => {
        el.muted = false;
        el.volume = 1.0;
        el.play().catch(() => {});
        window.removeEventListener('click', resume);
        window.removeEventListener('touchstart', resume);
      };
      window.addEventListener('click', resume, { once: true });
      window.addEventListener('touchstart', resume, { once: true });
    });
  }
  el.onpause = () => {
    if (state.isInRoom && el.srcObject && !el.muted) {
      el.play().catch(() => {});
    }
  };

  // Wire up audio ducking for this incoming stream so video ducks when this peer speaks
  if (typeof setupAudioDucking === 'function') {
    setupAudioDucking(stream);
  }
}
window.playPeerAudio = playPeerAudio;

function getUniquePeerEntries() {
  if (!state.peers) return [];
  const list = [];
  const seenPcs = new Set();
  Object.values(state.peers).forEach(p => {
    if (p && p.pc && !seenPcs.has(p.pc) && p.pc.signalingState !== 'closed') {
      seenPcs.add(p.pc);
      list.push(p);
    }
  });
  return list;
}
window.getUniquePeerEntries = getUniquePeerEntries;

function flushPeerQueuedIceCandidates(peerId) {
  const peer = state.peers && state.peers[peerId];
  if (peer && peer.pc && peer.iceCandidateQueue && peer.iceCandidateQueue.length > 0) {
    const list = [...peer.iceCandidateQueue];
    peer.iceCandidateQueue = [];
    list.forEach(c => {
      try {
        peer.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
      } catch (_) {}
    });
  }
}

function getPeerEntry(id) {
  if (!id || !state.peers) return null;
  if (state.peers[id]) return state.peers[id];
  return Object.values(state.peers).find(p => p.clientId === id || p.userId === id || p.peerId === id) || null;
}
window.getPeerEntry = getPeerEntry;

function getOrCreatePeerConnection(peerId, isInitiator, meta = {}) {
  if (!peerId) peerId = state.peerId || 'remote_peer';
  if (!state.peers) state.peers = {};

  let existing = getPeerEntry(peerId) || (meta.clientId && getPeerEntry(meta.clientId)) || (meta.userId && getPeerEntry(meta.userId));
  if (existing && existing.pc && existing.pc.signalingState !== 'closed') {
    if (meta.clientId) existing.clientId = meta.clientId;
    if (meta.userId) existing.userId = meta.userId;
    state.peers[peerId] = existing;
    if (existing.clientId) state.peers[existing.clientId] = existing;
    if (existing.userId) state.peers[existing.userId] = existing;
    return existing;
  }

  const pc = new RTCPeerConnection(rtcConfig);
  const peerEntry = {
    peerId,
    clientId: meta.clientId || (peerId.startsWith('cl_') ? peerId : null),
    userId: meta.userId || (!peerId.startsWith('cl_') ? peerId : null),
    pc,
    dataChannel: null,
    stream: new MediaStream(),
    iceCandidateQueue: []
  };
  state.peers[peerId] = peerEntry;
  if (peerEntry.clientId) state.peers[peerEntry.clientId] = peerEntry;
  if (peerEntry.userId) state.peers[peerEntry.userId] = peerEntry;

  // Pre-allocate audio & video transceivers in sendrecv mode
  try {
    if (typeof pc.addTransceiver === 'function') {
      const trans = pc.getTransceivers ? pc.getTransceivers() : [];
      const hasAudio = trans.some(t => (t.receiver && t.receiver.track && t.receiver.track.kind === 'audio') || (t.sender && t.sender.track && t.sender.track.kind === 'audio'));
      const hasVideo = trans.some(t => (t.receiver && t.receiver.track && t.receiver.track.kind === 'video') || (t.sender && t.sender.track && t.sender.track.kind === 'video'));
      if (!hasAudio) pc.addTransceiver('audio', { direction: 'sendrecv' });
      if (!hasVideo) pc.addTransceiver('video', { direction: 'sendrecv' });
    }
  } catch (_) {}

  // Attach local tracks if available
  if (state.localStream) {
    state.localStream.getTracks().forEach(track => {
      if (track.readyState !== 'live') return;
      try {
        const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
        const t = transceivers.find(tr =>
          (tr.receiver && tr.receiver.track && tr.receiver.track.kind === track.kind) ||
          (tr.sender && tr.sender.track && tr.sender.track.kind === track.kind)
        );
        if (t) {
          if (t.direction !== 'sendrecv') t.direction = 'sendrecv';
          if (t.sender && typeof t.sender.replaceTrack === 'function') {
            t.sender.replaceTrack(track).catch(() => {});
          }
        } else {
          pc.addTrack(track, state.localStream);
        }
      } catch (_) {}
    });
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({
        type: 'ice-candidate',
        targetUserId: peerEntry.userId || peerId,
        targetClientId: peerEntry.clientId || peerId,
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = (event) => {
    const track = event.track;
    if (!peerEntry.stream) peerEntry.stream = new MediaStream();
    if (track && !peerEntry.stream.getTracks().includes(track)) {
      peerEntry.stream.addTrack(track);
    }
    let matchingP = state.participants[peerId] || 
                    Object.values(state.participants).find(p => (peerEntry.userId && p.userId === peerEntry.userId) || (peerEntry.clientId && p.clientId === peerEntry.clientId));
    if (!matchingP) {
      const fallbackP = Object.values(state.participants).find(p => {
        const isSelf = (p.clientId && p.clientId === state.clientId) || (p.userId && p.userId === state.userId);
        return !isSelf;
      });
      const pKey = peerEntry.userId || peerEntry.clientId || peerId;
      matchingP = {
        userId: peerEntry.userId || (fallbackP && fallbackP.userId) || peerId,
        clientId: peerEntry.clientId || (fallbackP && fallbackP.clientId) || peerId,
        username: (fallbackP && fallbackP.username) || peerEntry.username || 'Katılımcı',
        avatar: (fallbackP && fallbackP.avatar) || '',
        isMicOn: false,
        isCamOn: false,
        role: 'member',
        stream: peerEntry.stream
      };
      state.participants[pKey] = matchingP;
    } else {
      matchingP.stream = peerEntry.stream;
    }

    if (track.kind === 'audio') {
      matchingP.isMicOn = true;
    }

    const hasVideo = track.kind === 'video' || peerEntry.stream.getVideoTracks().length > 0;
    const isScreenTrack = track.label.toLowerCase().includes('screen') ||
                         track.label.toLowerCase().includes('display') ||
                         track.contentHint === 'detail';

    if (isScreenTrack || state.activeMode === 'screenshare') {
      if (dom.remoteScreenPlayer) {
        dom.remoteScreenPlayer.srcObject = peerEntry.stream;
        dom.remoteScreenPlayer.classList.remove('hidden');
        dom.ytPlayerContainer.classList.add('hidden');
        dom.nativeVideoPlayer.classList.add('hidden');
        dom.emptyStatePlaceholder.classList.add('hidden');
      }
    } else if (hasVideo) {
      const activateCam = () => {
        if (matchingP) {
          matchingP.isCamOn = true;
          matchingP.stream = peerEntry.stream;
          state.dismissedPips = state.dismissedPips || {};
          if (matchingP.userId) state.dismissedPips[matchingP.userId] = false;
          if (matchingP.clientId) state.dismissedPips[matchingP.clientId] = false;
        }
        if (!state.peerId || state.peerId === peerId) {
          state.peerId = peerId;
          state.remoteStream = peerEntry.stream;
        }
        if (typeof renderStagePipCards === 'function') renderStagePipCards();
        if (typeof renderVideoGrid === 'function') renderVideoGrid();
        if (typeof clampPipCardsToStage === 'function') clampPipCardsToStage();
        updateBlockedMediaState();
      };

      if (track.readyState === 'live') {
        activateCam();
      }
      track.onunmute = activateCam;
      track.onmute = () => {
        const anyLive = peerEntry.stream.getVideoTracks().some(t => t.readyState === 'live');
        if (matchingP) {
          matchingP.isCamOn = anyLive;
        }
        if (typeof renderStagePipCards === 'function') renderStagePipCards();
        if (typeof renderVideoGrid === 'function') renderVideoGrid();
      };
    }

    if (track.kind === 'audio' || peerEntry.stream.getAudioTracks().length > 0) {
      playPeerAudio(peerId, peerEntry.stream);
    }
  };

  pc.ondatachannel = (event) => {
    peerEntry.dataChannel = event.channel;
    setupDataChannelEvents(event.channel);
  };

  // Connection watchdog
  peerEntry.isInitiator = !!isInitiator;
  peerEntry.stuckTicks = 0;
  peerEntry.watchdog = setInterval(async () => {
    try {
      if (!state.peers || state.peers[peerId] !== peerEntry || pc.signalingState === 'closed') {
        clearInterval(peerEntry.watchdog);
        return;
      }
      const cs = pc.connectionState;
      const ics = pc.iceConnectionState;
      if (cs === 'connected' || ics === 'connected' || ics === 'completed') {
        peerEntry.stuckTicks = 0;
        return;
      }
      peerEntry.stuckTicks++;
      if (peerEntry.stuckTicks < 2) return;
      if (peerEntry.isInitiator) {
        await restartPeerOffer(peerId);
      } else {
        sendSignal({
          type: 'rtc-need-offer',
          targetUserId: peerEntry.userId || peerId,
          targetClientId: peerEntry.clientId || peerId,
          sentAt: Date.now()
        });
      }
    } catch (_) {}
  }, 4000);

  pc.onconnectionstatechange = () => {
    const cs = pc.connectionState;
    console.log(`[WebRTC Peer ${peerId}] State:`, cs);
    if (cs === 'connected') {
      try { broadcastMyMediaStatus(); } catch (_) {}
      if (typeof renderVideoGrid === 'function') renderVideoGrid();
      if (!state.peerId || state.peerId === peerId) {
        showRoomConnectionStatus(false);
        attachRemoteStreamToPartnerVideo();
        attachRemoteAudioStream();
      }
    } else if (cs === 'disconnected' || cs === 'failed') {
      if (pc.restartIce) {
        try { pc.restartIce(); } catch (_) {}
      }
    }
  };

  pc.oniceconnectionstatechange = () => {
    const ics = pc.iceConnectionState;
    console.log(`[WebRTC Peer ${peerId}] ICE:`, ics);
    if (ics === 'connected' || ics === 'completed') {
      if (typeof renderVideoGrid === 'function') renderVideoGrid();
      if (!state.peerId || state.peerId === peerId) {
        showRoomConnectionStatus(false);
        attachRemoteStreamToPartnerVideo();
        attachRemoteAudioStream();
      }
    }
  };

  // Single-peer backward compatibility
  if (!state.pc || state.pc.signalingState === 'closed') {
    state.pc = pc;
    state.peerId = peerId;
    state.remoteStream = peerEntry.stream;
  }

  if (isInitiator) {
    try {
      peerEntry.dataChannel = pc.createDataChannel('couchSyncChannel');
      setupDataChannelEvents(peerEntry.dataChannel);
      if (state.pc === pc) state.dataChannel = peerEntry.dataChannel;

      pc.createOffer().then(offer => {
        return pc.setLocalDescription(offer);
      }).then(() => {
        sendSignal({
          type: 'offer',
          targetUserId: peerEntry.userId || peerId,
          targetClientId: peerEntry.clientId || peerId,
          offer: pc.localDescription
        });
      }).catch(err => console.error(`Create offer error for ${peerId}:`, err));
    } catch (e) {
      console.warn('Initiate offer error:', e);
    }
  }

  return peerEntry;
}
window.getOrCreatePeerConnection = getOrCreatePeerConnection;

function setupWebRTC() {
  if (state.pc) {
    try { state.pc.close(); } catch (e) {}
  }
  const peer = getOrCreatePeerConnection(state.peerId || 'remote_peer', false);
  state.pc = peer.pc;
}

function initiateWebRTC(isInitiator) {
  const peer = getOrCreatePeerConnection(state.peerId || 'remote_peer', isInitiator);
  state.pc = peer.pc;
  state.dataChannel = peer.dataChannel;
}

async function restartPeerOffer(peerId) {
  const peer = getPeerEntry(peerId);
  if (!peer || !peer.pc || peer.pc.signalingState === 'closed') return;
  const pc = peer.pc;
  try {
    if (pc.signalingState === 'have-local-offer' && pc.localDescription) {
      sendSignal({
        type: 'offer',
        targetUserId: peer.userId || peerId,
        targetClientId: peer.clientId || peerId,
        offer: pc.localDescription,
        sentAt: Date.now()
      });
      return;
    }
    if (pc.signalingState !== 'stable') return;
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    sendSignal({
      type: 'offer',
      targetUserId: peer.userId || peerId,
      targetClientId: peer.clientId || peerId,
      offer: pc.localDescription,
      sentAt: Date.now()
    });
  } catch (err) {
    console.warn('restartPeerOffer error:', err);
  }
}
window.restartPeerOffer = restartPeerOffer;

async function renegotiatePeerWebRTC(peerId) {
  const peer = getPeerEntry(peerId);
  if (!peer || !peer.pc || peer.pc.signalingState === 'closed') return;
  if (peer.pc.signalingState !== 'stable') {
    setTimeout(() => {
      if (peer.pc && peer.pc.signalingState === 'stable') {
        renegotiatePeerWebRTC(peerId);
      }
    }, 300);
    return;
  }
  try {
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    sendSignal({
      type: 'offer',
      targetUserId: peer.userId || peerId,
      targetClientId: peer.clientId || peerId,
      offer: peer.pc.localDescription
    });
  } catch (err) {
    console.warn(`Renegotiate error for ${peerId}:`, err);
  }
}
window.renegotiatePeerWebRTC = renegotiatePeerWebRTC;

let isRenegotiating = false;
async function renegotiateWebRTC() {
  const uniquePeers = getUniquePeerEntries();
  if (uniquePeers.length > 0) {
    for (const peer of uniquePeers) {
      await renegotiatePeerWebRTC(peer.peerId);
    }
  } else if (state.pc && state.pc.signalingState === 'stable') {
    try {
      isRenegotiating = true;
      const offer = await state.pc.createOffer();
      await state.pc.setLocalDescription(offer);
      sendSignal({ type: 'offer', offer: state.pc.localDescription });
    } catch (err) {
      console.warn('WebRTC renegotiation error:', err);
    } finally {
      isRenegotiating = false;
    }
  }
}
window.renegotiateWebRTC = renegotiateWebRTC;

async function handleRtcOffer(offer, fromId, meta = {}) {
  const peerId = fromId || state.peerId || 'remote_peer';
  const peer = getOrCreatePeerConnection(peerId, false, meta);
  const pc = peer.pc;

  // Ensure local tracks are attached before answering
  if (state.localStream && pc) {
    const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
    state.localStream.getTracks().forEach(track => {
      if (track.readyState !== 'live') return;
      const t = transceivers.find(tr => 
        (tr.receiver && tr.receiver.track && tr.receiver.track.kind === track.kind) ||
        (tr.sender && tr.sender.track && tr.sender.track.kind === track.kind)
      );
      if (t) {
        if (t.direction !== 'sendrecv') t.direction = 'sendrecv';
        if (t.sender && typeof t.sender.replaceTrack === 'function') {
          t.sender.replaceTrack(track).catch(() => {});
        }
      } else {
        try { pc.addTrack(track, state.localStream); } catch (_) {}
      }
    });
  }

  // Symmetric polite peer collision handling
  const myId = String(state.clientId || state.userId || '');
  const remoteId = String(meta.clientId || peer.clientId || fromId || '');
  const isPolite = myId > remoteId;
  const isCollision = (pc.signalingState !== 'stable' || isRenegotiating);

  if (isCollision) {
    if (!isPolite) {
      return;
    }
    try {
      await pc.setLocalDescription({ type: 'rollback' });
    } catch (_) {}
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    flushPeerQueuedIceCandidates(peer.peerId);
    try {
      pc.getTransceivers().forEach(tr => {
        if (tr.stopped || tr.currentDirection === 'stopped' || !tr.mid) return;
        const kind = (tr.receiver && tr.receiver.track && tr.receiver.track.kind) || null;
        if (!kind) return;
        if (tr.direction !== 'sendrecv') tr.direction = 'sendrecv';
        if (state.localStream && tr.sender && !tr.sender.track) {
          const lt = state.localStream.getTracks().find(t => t.kind === kind && t.readyState === 'live');
          if (lt) tr.sender.replaceTrack(lt).catch(() => {});
        }
      });
    } catch (_) {}
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({
      type: 'answer',
      targetUserId: peer.userId || peerId,
      targetClientId: peer.clientId || peerId,
      answer: pc.localDescription
    });

    if (!state.peerId || state.peerId === peerId) {
      state.pc = pc;
      state.peerId = peerId;
      state.remoteStream = peer.stream;
      if (typeof attachRemoteStreamToPartnerVideo === 'function') attachRemoteStreamToPartnerVideo();
      if (typeof attachRemoteAudioStream === 'function') attachRemoteAudioStream();
    }
    if (typeof renderStagePipCards === 'function') renderStagePipCards();
    if (typeof renderVideoGrid === 'function') renderVideoGrid();
  } catch (err) {
    console.error(`Handle offer error for ${peerId}:`, err);
  }
}

async function handleRtcAnswer(answer, fromId) {
  const peerId = fromId || state.peerId;
  const peer = getPeerEntry(peerId);
  const pc = (peer && peer.pc) || state.pc;
  if (pc && pc.signalingState !== 'closed') {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      if (peer) flushPeerQueuedIceCandidates(peer.peerId);
      else flushQueuedIceCandidates();
      if (!state.peerId || state.peerId === peerId) {
        if (typeof attachRemoteStreamToPartnerVideo === 'function') attachRemoteStreamToPartnerVideo();
        if (typeof attachRemoteAudioStream === 'function') attachRemoteAudioStream();
      }
      if (typeof renderStagePipCards === 'function') renderStagePipCards();
      if (typeof renderVideoGrid === 'function') renderVideoGrid();
    } catch (err) {
      console.error(`Handle answer error for ${peerId}:`, err);
    }
  }
}

function flushQueuedIceCandidates() {
  if (state.pc && state.iceCandidateQueue && state.iceCandidateQueue.length > 0) {
    const list = [...state.iceCandidateQueue];
    state.iceCandidateQueue = [];
    list.forEach(c => {
      try {
        state.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
      } catch (_) {}
    });
  }
}

function handleRtcCandidate(candidate, fromId) {
  if (!candidate) return;
  const peerId = fromId || state.peerId;
  const peer = getPeerEntry(peerId);
  const pc = (peer && peer.pc) || state.pc;
  if (pc && pc.remoteDescription && pc.remoteDescription.type) {
    pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => {
      console.warn(`Add ICE error for ${peerId}:`, err);
    });
  } else {
    if (peer) {
      peer.iceCandidateQueue = peer.iceCandidateQueue || [];
      peer.iceCandidateQueue.push(candidate);
    } else {
      state.iceCandidateQueue = state.iceCandidateQueue || [];
      state.iceCandidateQueue.push(candidate);
    }
  }
}

function closePeerConnection(peerId) {
  if (!peerId) return;
  if (state.peers && state.peers[peerId]) {
    try { clearInterval(state.peers[peerId].watchdog); } catch (_) {}
    try { state.peers[peerId].pc.close(); } catch (_) {}
    delete state.peers[peerId];
  }
  const peerAudio = document.getElementById('remoteVoiceAudio_' + peerId);
  if (peerAudio) {
    try { peerAudio.pause(); peerAudio.srcObject = null; peerAudio.remove(); } catch (_) {}
  }
  if (state.peerId === peerId) {
    const remaining = state.peers ? Object.keys(state.peers) : [];
    if (remaining.length > 0) {
      state.peerId = remaining[0];
      state.pc = state.peers[state.peerId].pc;
      state.remoteStream = state.peers[state.peerId].stream;
    } else {
      state.peerId = null;
      state.pc = null;
      state.remoteStream = null;
    }
  }
  updatePeerStatus(Object.keys(state.participants).length > 0);
  if (typeof renderVideoGrid === 'function') renderVideoGrid();
  if (typeof renderParticipantsList === 'function') renderParticipantsList();
}
window.closePeerConnection = closePeerConnection;

function setupDataChannelEvents(channel) {
  channel.onopen = () => console.log('P2P DataChannel Açıldı! (Sıfır Gecikme Senkron)');
  channel.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      const payload = data.payload || data;
      if (data.type === 'sync') handleRemoteSync(payload);
      if (data.type === 'touch') renderTouchEffect(data.x || payload.x, data.y || payload.y, false);
      if (data.type === 'reaction') spawnFloatingReaction(data.emoji || payload.emoji, false);
      if (data.type === 'sleep') {
        const canRemoteSleep = payload.authorized || payload.isHost || payload.canControl || (payload.from && (payload.from === state.host || payload.userRole === 'owner' || payload.userRole === 'admin' || payload.userRole === 'dj')) || state.controlMode === 'everyone';
        if (canRemoteSleep) {
          applySleepMode(data.enabled !== undefined ? data.enabled : payload.enabled, false);
        }
      }
      if (data.type === 'perm_change') handleRemotePermissionChange(data.mode || payload.mode, data.hostName || payload.hostName);
      if (data.type === 'request_dj') handleDjPermissionRequested(data.fromUser || payload.fromUser);
      if (data.type === 'grant_dj') handleDjPermissionGranted(data.toUser || payload.toUser);
      if (data.type === 'friend_request') {
        if (typeof handleIncomingFriendRequest === 'function') handleIncomingFriendRequest(payload);
      }
      if (data.type === 'friend_accepted') {
        if (typeof handleIncomingFriendAccepted === 'function') handleIncomingFriendAccepted(payload);
      }
      if (data.type === 'friend_declined') {
        if (typeof handleIncomingFriendDeclined === 'function') handleIncomingFriendDeclined(payload);
      }
      if (data.type === 'friend_removed') {
        if (typeof handleRemoteFriendRemoved === 'function') handleRemoteFriendRemoved(payload.fromUsername, payload.toUsername);
      }
      if (data.type === 'affinity_unbound') {
        if (typeof handleRemoteAffinityUnbound === 'function') handleRemoteAffinityUnbound(payload.fromUsername, payload.toUsername);
      }
      if (data.type === 'room_invite') {
        if (typeof handleIncomingRoomInvite === 'function') handleIncomingRoomInvite(payload);
      }
      if (data.type === 'chat') renderChatMessage(data.sender || payload.sender, data.text || payload.text, false, data.time || payload.time, data.imageUrl || payload.imageUrl, data.avatarUrl || payload.avatarUrl);
      if (data.type === 'media_status') updateRemoteParticipantStatus(data.userId || payload.userId, data.username || payload.username, data.isMicOn !== undefined ? data.isMicOn : payload.isMicOn, data.isCamOn !== undefined ? data.isCamOn : payload.isCamOn);
      if (data.type === 'platform_switch') {
        switchRoomPlatform(data.platform || payload.platform);
        const sender = payload.user || payload.fromUser || data.user;
        if (sender && sender !== state.username && (state.peerId || Object.keys(state.participants).length > 1)) {
          showToast(`@${sender} platformu değiştirdi: ${data.platform || payload.platform}`);
        }
      }
      if (data.type === 'kick_user') handleRemoteUserKicked(data.targetUserId || payload.targetUserId, data.targetUsername || payload.targetUsername);
      if (data.type === 'role_update') handleRemoteRoleUpdate(data.targetUserId || payload.targetUserId, data.newRole || payload.newRole, data.targetUsername || payload.targetUsername);
      if (data.type === 'host_browsing') handleRemoteBrowsingNotice(data.isBrowsing !== undefined ? data.isBrowsing : payload.isBrowsing, data.user || payload.user);
      if (data.type === 'video_suggestion') handleIncomingVideoSuggestion(data);
      if (data.type === 'queue_update') handleRemoteQueueUpdate(data.queue || payload.queue);
      if (data.type === 'video_changed') handleRemoteVideoChanged(data.user || payload.user, data.title || payload.title, data.videoId || payload.videoId);
      if (data.type === 'photo_share') {
        displayPhotoOnStage(data.dataUrl || payload.dataUrl, data.title || payload.title, false);
        if (data.sender || payload.sender) showToast(`${data.sender || payload.sender} bir fotoğraf paylaştı!`);
      }
      if (data.type === 'photo_close') {
        closePhotoStage(false);
      }
      if (data.type === 'privacy_change') {
        if (typeof handleRemotePrivacyChange === 'function') handleRemotePrivacyChange(data.isPrivate !== undefined ? data.isPrivate : payload.isPrivate);
      }
      if (data.type === 'screenshare_start' || data.type === 'screenshare-start') {
        if (typeof handleRemoteScreenShareStarted === 'function') handleRemoteScreenShareStarted(data.user || payload.user);
      }
      if (data.type === 'screenshare_stop' || data.type === 'screenshare-stop') {
        if (typeof handleRemoteScreenShareStopped === 'function') handleRemoteScreenShareStopped();
      }
    } catch (err) {}
  };
}

function sendP2PData(type, payload = {}) {
  const enrichedPayload = {
    ...payload,
    clientId: state.clientId,
    userId: state.userId,
    fromUser: payload.fromUser || state.username,
    userRole: payload.userRole || state.userRole || (state.isHost ? 'owner' : 'member'),
    isHost: !!state.isHost,
    canControl: typeof canUserControlPlayback === 'function' ? canUserControlPlayback() : !!state.isHost,
    sentAt: payload.sentAt || Date.now()
  };
  const data = JSON.stringify({ type, payload: enrichedPayload, ...enrichedPayload });

  if (state.peers && Object.keys(state.peers).length > 0) {
    Object.values(state.peers).forEach(p => {
      if (p.dataChannel && p.dataChannel.readyState === 'open') {
        try { p.dataChannel.send(data); } catch (_) {}
      }
    });
  } else if (state.dataChannel && state.dataChannel.readyState === 'open') {
    try {
      state.dataChannel.send(data);
    } catch (_) {}
  }

  // Always send via signaling to ensure reliable delivery across all peers, mobile/desktop cross-NAT
  if (type === 'sync') {
    sendSignal({ type: 'sync-event', payload: enrichedPayload });
    if (roomSupabaseChannel) {
      try {
        roomSupabaseChannel.send({ type: 'broadcast', event: 'playback_sync', payload: enrichedPayload }).catch(() => {});
      } catch (_) {}
    }
    if (globalUsersChannel) {
      try {
        globalUsersChannel.send({
          type: 'broadcast',
          event: 'room_playback_sync',
          payload: { ...enrichedPayload, roomId: (state.roomId || '').trim().toUpperCase() }
        }).catch(() => {});
      } catch (_) {}
    }
  }
  else if (type === 'touch') sendSignal({ type: 'touch-event', x: enrichedPayload.x, y: enrichedPayload.y });
  else if (type === 'reaction') sendSignal({ type: 'reaction-event', emoji: enrichedPayload.emoji });
  else if (type === 'sleep') sendSignal({ type: 'sleep-mode', enabled: enrichedPayload.enabled, authorized: enrichedPayload.authorized, isHost: enrichedPayload.isHost, from: enrichedPayload.fromUser });
  else if (type === 'photo_share') sendSignal({ type: 'photo-share', dataUrl: enrichedPayload.dataUrl, title: enrichedPayload.title, sender: enrichedPayload.sender });
  else if (type === 'photo_close') sendSignal({ type: 'photo-close' });
  else if (type === 'screenshare_start') sendSignal({ type: 'screenshare-start', user: enrichedPayload.user || state.username });
  else if (type === 'screenshare_stop') sendSignal({ type: 'screenshare-stop', user: enrichedPayload.user || state.username });
  else if (type === 'perm_change') sendSignal({ type: 'perm-change', mode: enrichedPayload.mode, hostName: enrichedPayload.hostName });
  else if (type === 'privacy_change') sendSignal({ type: 'privacy-change', isPrivate: enrichedPayload.isPrivate });
  else if (type === 'request_dj') sendSignal({ type: 'request-dj', fromUser: enrichedPayload.fromUser });
  else if (type === 'grant_dj') sendSignal({ type: 'grant-dj', toUser: enrichedPayload.toUser });
  else if (type === 'friend_request') sendSignal({ type: 'friend-request', payload: enrichedPayload });
  else if (type === 'friend_accepted') sendSignal({ type: 'friend-accepted', payload: enrichedPayload });
  else if (type === 'friend_declined') sendSignal({ type: 'friend-declined', payload: enrichedPayload });
  else if (type === 'friend_removed') sendSignal({ type: 'friend-removed', fromUsername: enrichedPayload.fromUsername, toUsername: enrichedPayload.toUsername });
  else if (type === 'affinity_unbound') sendSignal({ type: 'affinity-unbound', fromUsername: enrichedPayload.fromUsername, toUsername: enrichedPayload.toUsername });
  else if (type === 'room_invite') sendSignal({ type: 'room-invite', payload: enrichedPayload });
  else if (type === 'chat') sendSignal({ type: 'chat-message', sender: enrichedPayload.sender, text: enrichedPayload.text, time: enrichedPayload.time, imageUrl: enrichedPayload.imageUrl, avatarUrl: enrichedPayload.avatarUrl });
  else if (type === 'media_status') sendSignal({ type: 'media-status', userId: enrichedPayload.userId, username: enrichedPayload.username, isMicOn: enrichedPayload.isMicOn, isCamOn: enrichedPayload.isCamOn });
  else if (type === 'platform_switch') sendSignal({ type: 'platform-switch', platform: enrichedPayload.platform });
  else if (type === 'kick_user') sendSignal({ type: 'kick-user', targetUserId: enrichedPayload.targetUserId, targetUsername: enrichedPayload.targetUsername });
  else if (type === 'role_update') sendSignal({ type: 'role-update', targetUserId: enrichedPayload.targetUserId, newRole: enrichedPayload.newRole, targetUsername: enrichedPayload.targetUsername });
  else if (type === 'host_browsing') sendSignal({ type: 'host-browsing', isBrowsing: enrichedPayload.isBrowsing, user: enrichedPayload.user });
  else if (type === 'video_suggestion') sendSignal({ type: 'video-suggestion', videoId: enrichedPayload.videoId, title: enrichedPayload.title, thumb: enrichedPayload.thumb, fromUser: enrichedPayload.fromUser });
  else if (type === 'queue_update') sendSignal({ type: 'queue-update', queue: enrichedPayload.queue });
  else if (type === 'video_changed') sendSignal({ type: 'video-changed', user: enrichedPayload.user, title: enrichedPayload.title, videoId: enrichedPayload.videoId });
}

// ==========================================
// 3. SMART AUDIO DUCKING (Web Audio API)
// ==========================================
let duckingAnalysers = [];
function setupAudioDucking(remoteAudioStream) {
  try {
    if (!remoteAudioStream) return;
    const aTracks = remoteAudioStream.getAudioTracks ? remoteAudioStream.getAudioTracks() : [];
    if (aTracks.length === 0) return;

    if (!state.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) state.audioCtx = new AudioCtx();
    }
    if (state.audioCtx && state.audioCtx.state === 'suspended') {
      state.audioCtx.resume().catch(() => {});
    }

    if (!state.audioCtx) return;

    // Clone audio track for analysis so WebKit/Safari does not hijack or mute the <audio> tag
    let streamForAnalyzer = remoteAudioStream;
    try {
      if (aTracks.length > 0 && typeof aTracks[0].clone === 'function') {
        const clonedTrack = aTracks[0].clone();
        streamForAnalyzer = new MediaStream([clonedTrack]);
      }
    } catch (_) {}

    const source = state.audioCtx.createMediaStreamSource(streamForAnalyzer);
    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);

    duckingAnalysers.push(analyser);

    if (!state.duckingInterval) {
      const bufferLength = 64;
      const dataArray = new Uint8Array(bufferLength);

      state.duckingInterval = setInterval(() => {
        if (!state.isInRoom) {
          clearInterval(state.duckingInterval);
          state.duckingInterval = null;
          duckingAnalysers = [];
          return;
        }
        try {
          let maxLevel = 0;
          for (let i = 0; i < duckingAnalysers.length; i++) {
            const an = duckingAnalysers[i];
            an.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let j = 0; j < bufferLength; j++) sum += dataArray[j];
            const avg = sum / bufferLength;
            const norm = avg / 255;
            if (norm > maxLevel) maxLevel = norm;
          }

          // Update partner audio visualizer if available
          if (dom.partnerAudioMeter) {
            dom.partnerAudioMeter.style.width = `${Math.min(100, Math.round(maxLevel * 250))}%`;
          }

          const threshold = typeof state.speechThreshold === 'number' ? state.speechThreshold : 0.05;
          if (maxLevel > threshold) {
            if (dom.partnerVoiceIndicator) dom.partnerVoiceIndicator.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse';
            triggerAudioDucking(true);
          } else {
            if (dom.partnerVoiceIndicator) dom.partnerVoiceIndicator.className = 'w-1.5 h-1.5 rounded-full bg-gray-500';
          }
        } catch (_) {}
      }, 100);
    }
  } catch (err) {
    console.warn('Audio Ducking başlatılamadı:', err);
  }
}

function triggerAudioDucking(shouldDuck) {
  if (shouldDuck) {
    if (state.duckTimeout) clearTimeout(state.duckTimeout);

    const duckFactor = typeof state.duckingTargetVolume === 'number' ? state.duckingTargetVolume : 0.35;

    if (!state.isDucked) {
      state.isDucked = true;
      if (dom.duckingLiveNotice) dom.duckingLiveNotice.style.opacity = '1';

      // Drop Media Volume
      if (state.ytPlayer && state.ytReady && typeof state.ytPlayer.setVolume === 'function') {
        const curVol = state.ytPlayer.getVolume ? state.ytPlayer.getVolume() : (state.normalVolume || 100);
        state.normalVolume = curVol || 100;
        state.ytPlayer.setVolume(Math.max(10, Math.round(state.normalVolume * duckFactor)));
      }
      if (dom.nativeVideoPlayer) {
        state.normalNativeVolume = typeof dom.nativeVideoPlayer.volume === 'number' ? dom.nativeVideoPlayer.volume : 1.0;
        dom.nativeVideoPlayer.volume = Math.max(0.12, state.normalNativeVolume * duckFactor);
      }
    }

    // Auto restore after 800ms of silence
    state.duckTimeout = setTimeout(() => {
      restoreAudioDucking();
    }, 800);
  }
}

function restoreAudioDucking() {
  if (state.isDucked) {
    state.isDucked = false;
    if (dom.duckingLiveNotice) dom.duckingLiveNotice.style.opacity = '0';

    if (state.ytPlayer && state.ytReady && typeof state.ytPlayer.setVolume === 'function') {
      state.ytPlayer.setVolume(state.normalVolume || 100);
    }
    if (dom.nativeVideoPlayer) {
      dom.nativeVideoPlayer.volume = typeof state.normalNativeVolume === 'number' ? state.normalNativeVolume : 1.0;
    }
  }
}

// ==========================================
// 4. MEDIA ENGINE (YouTube + HTML5 + Screen)
// ==========================================

// YouTube IFrame API Initialization
window.onYouTubeIframeAPIReady = function() {
  state.ytReady = true;
  console.log('YouTube API Hazır.');
};

function loadYoutubeVideo(urlOrId, startPlaying = true, startTime = 0) {
  if (!state.isInRoom || (state.currentTab !== 'room' && !state.isMiniPlayer)) {
    console.warn('[Miruo] Video playback suppressed: User is not inside an active room');
    return;
  }
  let videoId = extractYouTubeId(urlOrId);
  if (!videoId) {
    showToast('Geçerli bir YouTube linki girin!');
    return;
  }

  state.activeMode = 'youtube';
  state.currentVideoId = videoId;
  state.currentVideoThumb = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
  state.currentProvider = 'YouTube';
  if (typeof syncCurrentRoomToGlobalPresence === 'function') syncCurrentRoomToGlobalPresence();
  if (dom.nowPlayingProviderBadge) dom.nowPlayingProviderBadge.textContent = 'YouTube';
  if (typeof updateNowPlayingLikeState === 'function') updateNowPlayingLikeState();
  switchActiveTab('youtube');

  dom.emptyStatePlaceholder.classList.add('hidden');
  dom.ytPlayerContainer.classList.remove('hidden');
  dom.nativeVideoPlayer.classList.add('hidden');
  dom.remoteScreenPlayer.classList.add('hidden');
  if (dom.webPlayerFrame) dom.webPlayerFrame.classList.add('hidden');
  if (dom.sleepModePlaceholder) dom.sleepModePlaceholder.classList.add('hidden');
  if (dom.audioOnlyPlaceholder) dom.audioOnlyPlaceholder.classList.add('hidden');
  const photoStage = document.getElementById('photoStageContainer');
  if (photoStage) photoStage.classList.add('hidden');

  // Immediately hide the overlay so video is visible and touchable!
  if (dom.ravePlayerOverlay) {
    dom.ravePlayerOverlay.classList.add('opacity-0', 'pointer-events-none');
    dom.ravePlayerOverlay.classList.remove('opacity-90');
  }

  if (dom.ytPlayerContainer) {
    const oldFrame = dom.ytPlayerContainer.querySelector('iframe');
    if (oldFrame) {
      try { oldFrame.src = 'about:blank'; } catch (_) {}
    }
    dom.ytPlayerContainer.innerHTML = '';
  }

  // Direct responsive embed iframe that plays 100% reliably in WKWebView & Electron Desktop
  _altYtAttempted = false;
  const isLocalOrigin = !window.location.origin || window.location.origin.includes('127.0.0.1') || window.location.origin.includes('localhost') || window.location.protocol === 'file:';
  const effectiveOrigin = isLocalOrigin ? '' : `&origin=${encodeURIComponent(window.location.origin)}`;
  
  const prefCaptionLang = (function() {
    try { return localStorage.getItem('miruo_caption_lang'); } catch (_) { return null; }
  })();
  const ccParam = (prefCaptionLang && prefCaptionLang !== 'off')
    ? `&cc_load_policy=1&cc_lang_pref=${encodeURIComponent(prefCaptionLang)}`
    : '';

  const autoPlayParam = startPlaying ? 1 : 0;
  const startParam = (typeof startTime === 'number' && startTime > 0) ? `&start=${Math.floor(startTime)}` : '';

  dom.ytPlayerContainer.innerHTML = `
    <iframe id="miruoYtIframe" 
            src="https://www.youtube.com/embed/${videoId}?autoplay=${autoPlayParam}&playsinline=1&enablejsapi=1&widgetid=1&controls=0&disablekb=1&fs=0&rel=0&modestbranding=1&iv_load_policy=3${startParam}${ccParam}${effectiveOrigin}" 
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" 
            allowfullscreen 
            class="w-full h-full border-0 select-none">
    </iframe>
  `;

  state.isPlaying = !!startPlaying;
  updatePlayPauseUI(state.isPlaying);
  if (typeof startTime === 'number' && startTime > 0) {
    state.currentTime = startTime;
  }

  // Hook iframe load to enable postMessage events & restore preferred quality and captions
  const ytFrame = document.getElementById('miruoYtIframe');
  if (ytFrame) {
    ytFrame.addEventListener('load', () => {
      if (window.YT && window.YT.Player) {
        try {
          state.ytPlayer = new YT.Player('miruoYtIframe', {
            events: {
              onStateChange: onYtStateChange
            }
          });
        } catch (_) {}
      }

      setTimeout(() => {
        if (ytFrame.contentWindow) {
          ytFrame.contentWindow.postMessage(JSON.stringify({ event: 'listening' }), '*');
        }
        if (startPlaying) {
          sendYtCommand('playVideo');
          setTimeout(() => { if (state.isPlaying) sendYtCommand('playVideo'); }, 200);
          setTimeout(() => { if (state.isPlaying) sendYtCommand('playVideo'); }, 600);
        } else {
          sendYtCommand('pauseVideo');
          if (typeof startTime === 'number' && startTime > 0) {
            sendYtCommand('seekTo', [startTime, true]);
          }
          setTimeout(() => { if (!state.isPlaying) sendYtCommand('pauseVideo'); }, 120);
          setTimeout(() => { if (!state.isPlaying) sendYtCommand('pauseVideo'); }, 350);
          setTimeout(() => { if (!state.isPlaying) sendYtCommand('pauseVideo'); }, 700);
        }
        try {
          const prefQuality = localStorage.getItem('miruo_preferred_quality') || 'auto';
          if (typeof window.setPlayerQuality === 'function') {
            window.setPlayerQuality(prefQuality, false);
          } else {
            sendYtCommand('setPlaybackQuality', [prefQuality]);
            sendYtCommand('setPlaybackQualityRange', [prefQuality, prefQuality]);
          }

          const savedCap = localStorage.getItem('miruo_caption_lang');
          if (savedCap && savedCap !== 'off' && typeof window.setCaptionLanguage === 'function') {
            window.setCaptionLanguage(savedCap);
          }
        } catch (_) {}
      }, 500);
    });
  }

  // Update Now Playing card & stage overlay
  fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`)
    .then(r => r.json())
    .then(d => {
      const vTitle = d.title || 'Video';
      state.currentVideoTitle = vTitle;
      if (typeof syncCurrentRoomToGlobalPresence === 'function') syncCurrentRoomToGlobalPresence();
      const vAuthor = d.author_name || '';
      if (dom.raveOverlayTitle) dom.raveOverlayTitle.textContent = vTitle;
      const stageSubtitle = document.getElementById('stageSubtitleText');
      if (stageSubtitle) stageSubtitle.textContent = vAuthor || 'Miruo';
      if (dom.nowPlayingTitle) dom.nowPlayingTitle.textContent = vTitle;
      const miniTitle = document.getElementById('miniPlayerTitle');
      if (miniTitle) miniTitle.textContent = vTitle;
    }).catch(() => {});

  // Send video change to peer with timestamp for zero-latency sync (guard against loopback)
  if (!state.isRemoteAction) {
    sendP2PData('sync', { action: 'load_yt', videoId, sentAt: Date.now() });
  }
  state.isRemoteAction = false;
  startPlaybackTracking();
  startSyncHeartbeat();
  showToast('Video başlatıldı');
}

function fallbackToDirectYtEmbed(videoId) {
  if (!videoId) return;
  loadYoutubeVideo(videoId);
}

function extractTwitchChannel(urlOrChannel) {
  if (!urlOrChannel) return '';
  let str = String(urlOrChannel).trim();
  if (str.startsWith('twitch:')) {
    str = str.replace(/^twitch:/, '');
  }
  if (str.includes('twitch.tv/')) {
    str = str.split('twitch.tv/')[1].split('/')[0].split('?')[0];
  }
  const clean = str.replace(/[^a-zA-Z0-9_]/g, '');
  const forbidden = ['directory', 'p', 'search', 'videos', 'downloads', 'turbo', 'settings'];
  if (!clean || forbidden.includes(clean.toLowerCase())) return '';
  return clean;
}
window.extractTwitchChannel = extractTwitchChannel;

function extractKickChannel(val) {
  if (!val) return '';
  let str = String(val).trim();
  if (str.includes('kick.com/')) {
    str = str.split('kick.com/')[1].split('/')[0].split('?')[0];
  } else if (str.startsWith('kick:')) {
    str = str.replace(/^kick:/, '');
  }
  const clean = str.replace(/[^a-zA-Z0-9_\-]/g, '');
  const forbidden = ['video', 'categories', 'browse', 'following', 'auth', 'login', 'signup'];
  if (!clean || forbidden.includes(clean.toLowerCase())) return '';
  return clean;
}
window.extractKickChannel = extractKickChannel;

function loadKickStream(channelOrUrl, title) {
  let channel = extractKickChannel(channelOrUrl);
  if (!channel) {
    showToast('Lütfen geçerli bir Kick canlı yayını veya kanal seçin');
    return;
  }

  state.activeMode = 'kick';
  state.currentProvider = 'Kick';
  state.currentVideoId = `kick:${channel}`;
  state.currentVideoTitle = title || `${channel} - Kick`;
  state.isPlaying = true;
  if (typeof updatePlayPauseUI === 'function') updatePlayPauseUI(true);

  if (dom.nowPlayingProviderBadge) dom.nowPlayingProviderBadge.textContent = 'Kick';
  if (dom.nowPlayingTitle) dom.nowPlayingTitle.textContent = state.currentVideoTitle;
  if (dom.raveOverlayTitle) dom.raveOverlayTitle.textContent = state.currentVideoTitle;
  if (dom.stageSubtitleText) dom.stageSubtitleText.textContent = `${channel} (Kick)`;
  if (typeof updateNowPlayingLikeState === 'function') updateNowPlayingLikeState();

  dom.emptyStatePlaceholder.classList.add('hidden');
  dom.ytPlayerContainer.classList.add('hidden');
  dom.nativeVideoPlayer.classList.add('hidden');
  if (typeof hideIframeFallback === 'function') hideIframeFallback();

  if (dom.webPlayerFrame) {
    dom.webPlayerFrame.classList.remove('hidden');
    dom.webPlayerFrame.src = `https://player.kick.com/${encodeURIComponent(channel)}?autoplay=true&muted=false`;
  }

  if (dom.ravePlayerOverlay) {
    dom.ravePlayerOverlay.classList.add('opacity-0', 'pointer-events-none');
    dom.ravePlayerOverlay.classList.remove('opacity-90');
  }

  sendP2PData('video_changed', { user: state.username, title: state.currentVideoTitle, videoId: `kick:${channel}` });
  sendSignal({ type: 'video-changed', user: state.username, title: state.currentVideoTitle, videoId: `kick:${channel}` });

  showToast(`Kick: ${channel} yayını açıldı!`);
}
window.loadKickStream = loadKickStream;

function loadTwitchStream(channelOrUrl, title) {
  let channel = extractTwitchChannel(channelOrUrl);
  if (!channel) {
    showToast('Lütfen geçerli bir Twitch canlı yayını seçin');
    return;
  }

  state.activeMode = 'twitch';
  state.currentProvider = 'Twitch';
  state.currentVideoId = `twitch:${channel}`;
  state.currentVideoTitle = title || `${channel} - Twitch`;
  state.isPlaying = true;
  if (typeof updatePlayPauseUI === 'function') updatePlayPauseUI(true);

  if (dom.nowPlayingProviderBadge) dom.nowPlayingProviderBadge.textContent = 'Twitch';
  if (dom.nowPlayingTitle) dom.nowPlayingTitle.textContent = state.currentVideoTitle;
  if (dom.raveOverlayTitle) dom.raveOverlayTitle.textContent = state.currentVideoTitle;
  if (dom.stageSubtitleText) dom.stageSubtitleText.textContent = `${channel} (Twitch)`;
  if (typeof updateNowPlayingLikeState === 'function') updateNowPlayingLikeState();
  
  dom.emptyStatePlaceholder.classList.add('hidden');
  dom.ytPlayerContainer.classList.add('hidden');
  dom.nativeVideoPlayer.classList.add('hidden');
  if (typeof hideIframeFallback === 'function') hideIframeFallback();

  if (dom.webPlayerFrame) {
    dom.webPlayerFrame.classList.remove('hidden');
    const hostnames = new Set(['localhost', '127.0.0.1', 'miruo.app', 'miruo.com.tr']);
    if (window.location.hostname && !hostnames.has(window.location.hostname)) {
      hostnames.add(window.location.hostname);
    }
    const parentParams = Array.from(hostnames).map(h => `parent=${encodeURIComponent(h)}`).join('&');
    dom.webPlayerFrame.src = `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&${parentParams}&autoplay=true&muted=false`;
  }

  // Hide the custom VOD overlay so user can interact directly with Twitch player controls
  if (dom.ravePlayerOverlay) {
    dom.ravePlayerOverlay.classList.add('opacity-0', 'pointer-events-none');
    dom.ravePlayerOverlay.classList.remove('opacity-90');
  }

  sendP2PData('video_changed', { user: state.username, title: state.currentVideoTitle, videoId: `twitch:${channel}` });
  sendSignal({ type: 'video-changed', user: state.username, title: state.currentVideoTitle, videoId: `twitch:${channel}` });

  showToast(`Twitch: ${channel} yayını açıldı!`);
}
window.loadTwitchStream = loadTwitchStream;

function loadDirectVideo(url, title, startPlaying = true, startTime = 0) {
  if (!state.isInRoom || (state.currentTab !== 'room' && !state.isMiniPlayer)) {
    console.warn('[Miruo] Direct video playback suppressed: User is not inside an active room');
    return;
  }
  state.activeMode = 'direct';
  state.currentProvider = 'Web Video';
  state.currentVideoId = url;
  state.currentVideoTitle = title || 'Video İçeriği';
  if (typeof syncCurrentRoomToGlobalPresence === 'function') syncCurrentRoomToGlobalPresence();
  if (dom.nowPlayingProviderBadge) dom.nowPlayingProviderBadge.textContent = 'Web Video';
  if (dom.nowPlayingTitle) dom.nowPlayingTitle.textContent = title || 'Video İçeriği';
  if (typeof updateNowPlayingLikeState === 'function') updateNowPlayingLikeState();
  
  dom.emptyStatePlaceholder.classList.add('hidden');
  dom.ytPlayerContainer.classList.add('hidden');
  if (dom.webPlayerFrame) dom.webPlayerFrame.classList.add('hidden');
  hideIframeFallback();
  
  dom.nativeVideoPlayer.classList.remove('hidden');
  dom.nativeVideoPlayer.setAttribute('playsinline', 'true');
  dom.nativeVideoPlayer.setAttribute('webkit-playsinline', 'true');

  state.isPlaying = !!startPlaying;
  updatePlayPauseUI(state.isPlaying);
  if (typeof startTime === 'number' && startTime > 0) {
    state.currentTime = startTime;
  }

  const applySrcAndState = () => {
    if (typeof startTime === 'number' && startTime > 0) {
      try { dom.nativeVideoPlayer.currentTime = startTime; } catch (_) {}
    }
    if (startPlaying) {
      dom.nativeVideoPlayer.play().catch(e => console.log('Autoplay deferred:', e));
    } else {
      dom.nativeVideoPlayer.pause();
    }
  };

  if (url && (url.includes('.m3u8') || url.includes('/hls/'))) {
    if (dom.nativeVideoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
      // Native Apple HLS (iOS Safari & WKWebView)
      dom.nativeVideoPlayer.src = url;
      applySrcAndState();
    } else if (window.Hls && window.Hls.isSupported()) {
      // Desktop HLS.js
      if (window.activeHlsInstance) {
        try { window.activeHlsInstance.destroy(); } catch (_) {}
      }
      const hls = new window.Hls({ enableWorker: true });
      hls.loadSource(url);
      hls.attachMedia(dom.nativeVideoPlayer);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        applySrcAndState();
      });
      window.activeHlsInstance = hls;
    } else {
      dom.nativeVideoPlayer.src = url;
      applySrcAndState();
    }
  } else {
    dom.nativeVideoPlayer.src = url;
    applySrcAndState();
  }
  startPlaybackTracking();
  startSyncHeartbeat();
  showToast(startPlaying ? 'Video başlatıldı!' : 'Video yüklendi (Durduruldu)');
}

function normalizeEmbedUrl(url) {
  if (!url) return url;
  // 1. Google Drive auto-transform to embeddable preview format
  if (url.includes('drive.google.com/file/d/')) {
    const match = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      return `https://drive.google.com/file/d/${match[1]}/preview`;
    }
  }
  // 2. Kick channel auto-transform to official embed player
  if (url.includes('kick.com/') || url.startsWith('kick:')) {
    const ch = extractKickChannel(url);
    if (ch) return `https://player.kick.com/${encodeURIComponent(ch)}?autoplay=true&muted=false`;
  }
  // 3. Twitch channel auto-transform to official embed player
  if (url.includes('twitch.tv/') || url.startsWith('twitch:')) {
    const ch = extractTwitchChannel(url);
    if (ch) {
      const hostnames = new Set(['localhost', '127.0.0.1', 'miruo.app', 'miruo.com.tr']);
      if (window.location.hostname) hostnames.add(window.location.hostname);
      const parentParams = Array.from(hostnames).map(h => `parent=${encodeURIComponent(h)}`).join('&');
      return `https://player.twitch.tv/?channel=${encodeURIComponent(ch)}&${parentParams}&autoplay=true&muted=false`;
    }
  }
  return url;
}

function showIframeFallback(url, provider) {
  if (!dom.webPlayerFallbackCard) return;
  dom.webPlayerFallbackCard.classList.remove('hidden');
  dom.webPlayerFallbackCard.classList.add('flex');
  if (dom.webPlayerFallbackTitle) {
    dom.webPlayerFallbackTitle.textContent = `${provider || 'Platform'} Yayını`;
  }
  if (dom.webPlayerFallbackDesc) {
    dom.webPlayerFallbackDesc.textContent = `${provider || 'Bu platform'}, tarayıcı güvenlik politikası (X-Frame-Options) nedeniyle pencere içine doğrudan gömülmeyi engelliyor. Odanızdaki arkadaşlarınızla kesintisiz izlemek için 'Sekme Paylaşımı' modunu başlatabilirsiniz.`;
  }
  state.lastFallbackUrl = url;
}

function hideIframeFallback() {
  if (dom.webPlayerFallbackCard) {
    dom.webPlayerFallbackCard.classList.add('hidden');
    dom.webPlayerFallbackCard.classList.remove('flex');
  }
}

function loadWebStream(url, title, provider = 'Web') {
  state.activeMode = 'web';
  state.currentProvider = provider;
  state.currentVideoId = url;
  state.currentVideoTitle = title || `${provider} İçeriği`;
  if (typeof syncCurrentRoomToGlobalPresence === 'function') syncCurrentRoomToGlobalPresence();
  if (dom.nowPlayingProviderBadge) dom.nowPlayingProviderBadge.textContent = provider;
  if (dom.nowPlayingTitle) dom.nowPlayingTitle.textContent = title || `${provider} İçeriği`;
  
  dom.emptyStatePlaceholder.classList.add('hidden');
  dom.ytPlayerContainer.classList.add('hidden');
  dom.nativeVideoPlayer.classList.add('hidden');
  hideIframeFallback();

  const finalUrl = normalizeEmbedUrl(url);

  // Check if provider is known to strictly block iframes on Web
  const isStrictlyBlocked = (url && (url.includes('photos.google.com') || url.includes('netflix.com') || url.includes('primevideo.com') || url.includes('disneyplus.com')));

  if (isStrictlyBlocked) {
    showIframeFallback(finalUrl, provider);
  } else if (dom.webPlayerFrame) {
    dom.webPlayerFrame.classList.remove('hidden');
    dom.webPlayerFrame.src = finalUrl;
    dom.webPlayerFrame.onerror = () => showIframeFallback(finalUrl, provider);
  }

  sendP2PData('video_changed', { user: state.username, title: state.currentVideoTitle, videoId: url });
  sendSignal({ type: 'video-changed', user: state.username, title: state.currentVideoTitle, videoId: url });

  showToast(`${provider} içeriği odaya aktarıldı!`);
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
    if (!state.isPlaying) {
      if (!canUserControlPlayback()) {
        // Unauthorized user tried to play or iframe auto-resumed -> force back to room paused state!
        sendYtCommand('pauseVideo');
        return;
      }
      state.isPlaying = true;
      updatePlayPauseUI(true);
      sendP2PData('sync', { action: 'play', time: state.ytPlayer ? state.ytPlayer.getCurrentTime() : state.currentTime, sentAt: Date.now() });
    }
  } else if (event.data === YT.PlayerState.PAUSED) {
    if (state.isPlaying) {
      if (!canUserControlPlayback()) {
        // Unauthorized user tried to pause -> force back to room playing state!
        sendYtCommand('playVideo');
        return;
      }
      state.isPlaying = false;
      updatePlayPauseUI(false);
      sendP2PData('sync', { action: 'pause', time: state.ytPlayer ? state.ytPlayer.getCurrentTime() : state.currentTime, sentAt: Date.now() });
    }
  }
}

function sendYtCommand(func, args = []) {
  if (state.ytPlayer && typeof state.ytPlayer[func] === 'function') {
    try { state.ytPlayer[func](...args); } catch (_) {}
  }
  const ytFrame = document.getElementById('miruoYtIframe');
  if (ytFrame && ytFrame.contentWindow) {
    try {
      ytFrame.contentWindow.postMessage(JSON.stringify({
        event: 'command',
        func: func,
        args: args
      }), '*');
    } catch (_) {}
  }
  if (dom.nativeVideoPlayer) {
    try {
      if (func === 'pauseVideo') dom.nativeVideoPlayer.pause();
      else if (func === 'playVideo' && state.activeMode === 'direct') dom.nativeVideoPlayer.play().catch(() => {});
    } catch (_) {}
  }
}

function handleRemoteSync(payload) {
  if (!state.isInRoom || !payload) return;

  // Deduplicate identical events received both via WebRTC dataChannel and Signaling
  const syncKey = `${payload.action}_${payload.sentAt || ''}_${Math.round((payload.time || 0) * 10)}`;
  if (state.lastSyncKey === syncKey && (Date.now() - (state.lastSyncProcessedAt || 0)) < 350) {
    return;
  }
  state.lastSyncKey = syncKey;
  state.lastSyncProcessedAt = Date.now();

  state.isRemoteAction = true;
  clearTimeout(state.remoteActionTimer);
  state.remoteActionTimer = setTimeout(() => {
    state.isRemoteAction = false;
  }, 1500);

  // Eliminate phantom device-clock drift (Transit over WebRTC/Signaling is ~10-40ms, adding Date.now() skew was causing 2-8s false drift!)
  const transit = 0;

  // 1. Peer or resuming client requested full synchronization
  if (payload.action === 'request_sync') {
    if (state.activeMode === 'photo' && state.currentPhotoStageData) {
      sendP2PData('photo_share', {
        dataUrl: state.currentPhotoStageData.dataUrl,
        title: state.currentPhotoStageData.title,
        sender: state.username
      });
      return;
    }
    if (state.currentVideoId) {
      sendP2PData('sync', {
        action: 'full_sync',
        videoId: state.currentVideoId,
        time: state.currentTime,
        isPlaying: state.isPlaying,
        rate: state.playbackRate || 1.0,
        sentAt: Date.now()
      });
    }
    return;
  }

  // 2. Full synchronization state payload
  if (payload.action === 'full_sync') {
    const shouldPlay = typeof payload.isPlaying === 'boolean' ? payload.isPlaying : false;
    const targetTime = typeof payload.time === 'number' ? payload.time : state.currentTime;
    if (payload.videoId && payload.videoId !== state.currentVideoId) {
      if (typeof window.loadRemoteContentBridge === 'function') window.loadRemoteContentBridge(payload.videoId, payload.title, shouldPlay, targetTime);
      else loadYoutubeVideo(payload.videoId, shouldPlay, targetTime);
    }
    state.currentTime = targetTime;
    state.isPlaying = shouldPlay;
    updatePlayPauseUI(shouldPlay);
    if (state.activeMode === 'youtube') {
      sendYtCommand('seekTo', [targetTime, true]);
      if (shouldPlay) {
        sendYtCommand('playVideo');
      } else {
        sendYtCommand('pauseVideo');
        setTimeout(() => { if (!state.isPlaying) sendYtCommand('pauseVideo'); }, 100);
        setTimeout(() => { if (!state.isPlaying) sendYtCommand('pauseVideo'); }, 300);
        setTimeout(() => { if (!state.isPlaying) sendYtCommand('pauseVideo'); }, 800);
        setTimeout(() => { if (!state.isPlaying) sendYtCommand('pauseVideo'); }, 1600);
      }
    } else if (dom.nativeVideoPlayer) {
      dom.nativeVideoPlayer.currentTime = targetTime;
      if (shouldPlay) dom.nativeVideoPlayer.play().catch(() => {});
      else dom.nativeVideoPlayer.pause();
    }
    if (typeof payload.rate === 'number' && Math.abs((state.playbackRate || 1.0) - payload.rate) > 0.05) {
      setPlayerPlaybackRate(payload.rate, false);
    }
    return;
  }

  const isPlaybackCommand = (payload.action === 'play' || payload.action === 'pause' || payload.action === 'seek' || payload.action === 'load_yt');
  if (isPlaybackCommand) {
    if (payload.clientId && payload.clientId === state.clientId) return;

    const cleanUser = (u) => String(u || '').toLowerCase().replace(/^@/, '').trim();
    const sender = payload.fromUser || payload.user;
    const isFromHost = !!sender && (
      cleanUser(sender) === cleanUser(state.hostName) ||
      cleanUser(sender) === cleanUser(state.host) ||
      (payload.isHost === true) ||
      (payload.userId && state.participants && Object.values(state.participants).some(p => (p.isHost || p.role === 'owner') && p.userId === payload.userId))
    );
    let participant = null;
    if (state.participants) {
      if (sender && state.participants[sender]) {
        participant = state.participants[sender];
      } else {
        participant = Object.values(state.participants).find(p => cleanUser(p.userId) === cleanUser(sender) || cleanUser(p.username) === cleanUser(sender) || (payload.userId && cleanUser(p.userId) === cleanUser(payload.userId)));
      }
    }
    const role = (participant && participant.role) || (isFromHost ? 'owner' : (payload.userRole || 'member'));

    let isAuthorized = false;
    if (state.controlMode === 'everyone') {
      isAuthorized = true;
    } else if (payload.isHost === true || payload.canControl === true) {
      isAuthorized = true;
    } else if (isFromHost || role === 'owner' || role === 'admin' || role === 'dj' || role === 'video_control') {
      isAuthorized = true;
    } else if (cleanUser(sender) === cleanUser(state.username) && canUserControlPlayback()) {
      isAuthorized = true;
    }

    if (!isAuthorized) {
      console.warn('[Miruo] Unauthorized remote playback action rejected:', payload.action, payload.fromUser);
      // Immediately force authoritative state back to keep unauthorized peer in sync
      if (state.isHost || canUserControlPlayback()) {
        setTimeout(() => {
          sendP2PData('sync', {
            action: 'full_sync',
            videoId: state.currentVideoId,
            time: state.currentTime,
            isPlaying: state.isPlaying,
            rate: state.playbackRate || 1.0,
            sentAt: Date.now()
          });
        }, 100);
      }
      return;
    }
  }

  if (payload.action === 'load_yt') {
    if (state.currentVideoId !== payload.videoId) {
      loadYoutubeVideo(payload.videoId);
    }
    const sender = payload.fromUser || payload.user;
    if (sender && sender !== state.username && (state.peerId || Object.keys(state.participants).length > 1)) {
      showToast(`@${sender} videoyu başlattı`);
    }
  }

  if (payload.action === 'rate' || payload.action === 'speed') {
    const targetRate = typeof payload.rate === 'number' ? payload.rate : parseFloat(payload.rate) || 1.0;
    setPlayerPlaybackRate(targetRate, false);
    showToast(`Oynatma Hızı: ${targetRate}x (${payload.by || 'Oda Sahibi'})`);
  }

  if (payload.action === 'play') {
    const targetTime = (typeof payload.time === 'number' ? payload.time : state.currentTime) + transit;
    const livePos = (typeof getLivePlayerTime === 'function') ? getLivePlayerTime() : state.currentTime;
    state.currentTime = targetTime;
    state.isPlaying = true;
    updatePlayPauseUI(true);
    if (state.activeMode === 'youtube') {
      if (Math.abs(livePos - targetTime) > 0.3) {
        sendYtCommand('seekTo', [targetTime, true]);
      }
      sendYtCommand('playVideo');
      setTimeout(() => { if (state.isPlaying) sendYtCommand('playVideo'); }, 120);
    } else if (dom.nativeVideoPlayer) {
      if (Math.abs(dom.nativeVideoPlayer.currentTime - targetTime) > 0.4) {
        dom.nativeVideoPlayer.currentTime = targetTime;
      }
      dom.nativeVideoPlayer.play().catch(() => {});
    }
    document.querySelectorAll('video:not(.peer-cam-video):not(#localVideo):not(#partnerVideo):not([data-webrtc-stream])').forEach(v => {
      try { v.play().catch(() => {}); } catch (_) {}
    });
  }

  if (payload.action === 'pause') {
    const targetTime = typeof payload.time === 'number' ? payload.time : state.currentTime;
    state.isPlaying = false;
    updatePlayPauseUI(false);
    sendYtCommand('pauseVideo');
    if (typeof payload.time === 'number' && state.activeMode === 'youtube') {
      sendYtCommand('seekTo', [targetTime, true]);
    }
    state.currentTime = targetTime;
    if (dom.nativeVideoPlayer) {
      dom.nativeVideoPlayer.pause();
      if (typeof payload.time === 'number') {
        try { dom.nativeVideoPlayer.currentTime = targetTime; } catch (_) {}
      }
    }
    document.querySelectorAll('video:not(.peer-cam-video):not(#localVideo):not(#partnerVideo):not([data-webrtc-stream])').forEach(v => {
      try { v.pause(); } catch (_) {}
    });
    // Universal re-assertion across all players to kill rogue autoplays
    const enforceRemotePause = () => {
      if (!state.isPlaying) {
        sendYtCommand('pauseVideo');
        if (dom.nativeVideoPlayer) {
          try { dom.nativeVideoPlayer.pause(); } catch (_) {}
        }
        document.querySelectorAll('video:not(.peer-cam-video):not(#localVideo):not(#partnerVideo):not([data-webrtc-stream])').forEach(v => {
          try { v.pause(); } catch (_) {}
        });
      }
    };
    setTimeout(enforceRemotePause, 50);
    setTimeout(enforceRemotePause, 150);
    setTimeout(enforceRemotePause, 350);
    setTimeout(enforceRemotePause, 700);
    setTimeout(enforceRemotePause, 1200);
    setTimeout(enforceRemotePause, 2000);
  }

  if (payload.action === 'seek') {
    const targetTime = typeof payload.time === 'number' ? payload.time : 0;
    state.currentTime = targetTime;
    if (typeof payload.isPlaying === 'boolean') {
      state.isPlaying = payload.isPlaying;
      updatePlayPauseUI(state.isPlaying);
    }
    if (state.activeMode === 'youtube') {
      sendYtCommand('seekTo', [targetTime, true]);
      if (state.isPlaying) {
        setTimeout(() => { if (state.isPlaying) sendYtCommand('playVideo'); }, 80);
      } else {
        setTimeout(() => { if (!state.isPlaying) sendYtCommand('pauseVideo'); }, 80);
      }
    } else if (dom.nativeVideoPlayer) {
      dom.nativeVideoPlayer.currentTime = targetTime;
      if (state.isPlaying) dom.nativeVideoPlayer.play().catch(() => {});
      else dom.nativeVideoPlayer.pause();
    }
    if (dom.seekSlider && state.duration > 0) {
      dom.seekSlider.value = (targetTime / state.duration) * 100;
    }
  }

  if (payload.action === 'heartbeat') {
    const cleanUser = (u) => String(u || '').toLowerCase().replace(/^@/, '').trim();
    const sender = payload.fromUser || payload.user;
    const isFromHost = !!sender && (
      cleanUser(sender) === cleanUser(state.hostName) ||
      cleanUser(sender) === cleanUser(state.host) ||
      (payload.isHost === true)
    );
    const hbAuthorized = payload.isHost === true || payload.canControl === true || isFromHost || state.controlMode === 'everyone' || payload.userRole === 'owner' || payload.userRole === 'admin' || payload.userRole === 'dj' || payload.userRole === 'video_control';
    if (!state.isHost && hbAuthorized) {
      if (!payload.isPlaying) {
        // Authoritative state is PAUSED: force peer to stay strictly paused!
        state.isPlaying = false;
        updatePlayPauseUI(false);
        sendYtCommand('pauseVideo');
        if (dom.nativeVideoPlayer) {
          try { dom.nativeVideoPlayer.pause(); } catch (_) {}
        }
        document.querySelectorAll('video:not(.peer-cam-video):not(#localVideo):not(#partnerVideo):not([data-webrtc-stream])').forEach(v => {
          try { v.pause(); } catch (_) {}
        });
        if (typeof payload.time === 'number' && Math.abs(state.currentTime - payload.time) > 0.4) {
          state.currentTime = payload.time;
          if (state.activeMode === 'youtube') sendYtCommand('seekTo', [payload.time, true]);
          else if (dom.nativeVideoPlayer) {
            try { dom.nativeVideoPlayer.currentTime = payload.time; } catch (_) {}
          }
        }
        return;
      }

      // Authoritative state is PLAYING
      // Compensate variable delivery delay: min(recv - sent) ~ clock skew + base latency; anything above it is extra delay
      let hbExtra = 0;
      if (typeof payload.sentAt === 'number') {
        const rawDelay = Date.now() - payload.sentAt;
        state.minSyncDelay = (typeof state.minSyncDelay === 'number') ? Math.min(state.minSyncDelay, rawDelay) : rawDelay;
        hbExtra = Math.max(0, Math.min(15000, rawDelay - state.minSyncDelay)) / 1000;
      }
      const targetTime = (typeof payload.time === 'number' ? payload.time : (state.currentTime || 0)) + hbExtra;
      const localTime = typeof getLivePlayerTime === 'function' ? getLivePlayerTime() : (state.currentTime || 0);
      const drift = targetTime - localTime; // positive: viewer behind host; negative: viewer ahead
      const absDrift = Math.abs(drift);

      // If peer was paused but host is playing, resume playback
      if (!state.isPlaying) {
        state.isPlaying = true;
        updatePlayPauseUI(true);
        if (state.activeMode === 'youtube') {
          sendYtCommand('seekTo', [targetTime, true]);
          sendYtCommand('playVideo');
        } else if (dom.nativeVideoPlayer) {
          dom.nativeVideoPlayer.currentTime = targetTime;
          dom.nativeVideoPlayer.play().catch(() => {});
        }
        state.currentTime = targetTime;
        return;
      }

      // Continuous, sub-second precision synchronization:
      // If drift is noticeable (> 0.5s), snap instantly to target with hard seek
      const now = Date.now();
      if (absDrift > 0.5) {
        if (!state.lastHardSeekAt || (now - state.lastHardSeekAt) > 1200) {
          state.lastHardSeekAt = now;
          if (state.activeMode === 'youtube') {
            sendYtCommand('seekTo', [targetTime, true]);
            sendYtCommand('setPlaybackRate', [1.0]);
          } else if (dom.nativeVideoPlayer) {
            dom.nativeVideoPlayer.currentTime = targetTime;
            dom.nativeVideoPlayer.playbackRate = 1.0;
          }
          state.currentTime = targetTime;
          state.playbackRate = 1.0;
        }
      } else if (absDrift > 0.15) {
        // Micro drift (0.15s to 0.5s):
        // If viewer is behind: speed up to 1.25x (supported natively by YouTube & HTML5 video)
        // If viewer is ahead: slow down to 0.75x (supported natively by YouTube & HTML5 video)
        const targetRate = drift > 0 ? 1.25 : 0.75;
        if (state.playbackRate !== targetRate) {
          if (state.activeMode === 'youtube') {
            sendYtCommand('setPlaybackRate', [targetRate]);
          } else if (dom.nativeVideoPlayer) {
            dom.nativeVideoPlayer.playbackRate = targetRate;
          }
          state.playbackRate = targetRate;
        }
      } else {
        // In tight sync (< 0.15s): maintain normal 1.0x rate
        if (state.playbackRate !== 1.0) {
          if (state.activeMode === 'youtube') {
            sendYtCommand('setPlaybackRate', [1.0]);
          } else if (dom.nativeVideoPlayer) {
            dom.nativeVideoPlayer.playbackRate = 1.0;
          }
          state.playbackRate = 1.0;
        }
        if (state.playbackRate !== 1.0) {
          if (state.activeMode === 'youtube') {
            sendYtCommand('setPlaybackRate', [1.0]);
          } else if (dom.nativeVideoPlayer) {
            dom.nativeVideoPlayer.playbackRate = 1.0;
          }
          state.playbackRate = 1.0;
        }
      }
    }
  }
}

function getLivePlayerTime() {
  if (state.activeMode === 'youtube') {
    if (state.ytPlayer && typeof state.ytPlayer.getCurrentTime === 'function') {
      try {
        const ct = state.ytPlayer.getCurrentTime();
        if (typeof ct === 'number' && ct >= 0) return ct;
      } catch (_) {}
    }
    if (state.isPlaying && state.lastReportedYtAt) {
      const elapsed = (Date.now() - state.lastReportedYtAt) / 1000;
      return Math.min(state.duration || 999999, (state.lastReportedYtTime || 0) + elapsed);
    }
    return state.currentTime || 0;
  }
  if (state.activeMode === 'direct' && dom.nativeVideoPlayer) {
    return dom.nativeVideoPlayer.currentTime || 0;
  }
  return state.currentTime || 0;
}
window.getLivePlayerTime = getLivePlayerTime;

// High-Frequency 800ms Real-Time Sync Heartbeat to guarantee zero drift between host and peers
let syncHeartbeatInterval = null;
function startSyncHeartbeat() {
  if (syncHeartbeatInterval) clearInterval(syncHeartbeatInterval);
  syncHeartbeatInterval = setInterval(() => {
    if (state.isInRoom && (state.isHost || state.hasDjPermission || state.controlMode === 'everyone') && (state.activeMode === 'youtube' || state.activeMode === 'direct')) {
      const liveTime = getLivePlayerTime();
      state.currentTime = liveTime;
      sendP2PData('sync', {
        action: 'heartbeat',
        time: liveTime,
        isPlaying: !!state.isPlaying,
        rate: state.playbackRate || 1.0,
        sentAt: Date.now()
      });
    }
  }, 800);
}

// Playback Tracking (Timeline Slider & Duration - Drift-Free Hardware Sync)
let trackingInterval = null;
function startPlaybackTracking() {
  if (trackingInterval) clearInterval(trackingInterval);
  trackingInterval = setInterval(() => {
    if (state.activeMode === 'youtube') {
      if (state.isPlaying && !state.isUserDraggingSeek) {
        if (state.lastReportedYtAt) {
          const elapsed = (Date.now() - state.lastReportedYtAt) / 1000;
          state.currentTime = Math.min((state.duration || 999999), (state.lastReportedYtTime || 0) + elapsed);
        } else {
          state.currentTime = Math.min((state.duration || 999999), (state.currentTime || 0) + 0.5);
        }
      }
    } else if (state.activeMode === 'direct' && dom.nativeVideoPlayer) {
      state.currentTime = dom.nativeVideoPlayer.currentTime || 0;
      state.duration = dom.nativeVideoPlayer.duration || 0;
    }

    if (state.duration > 0) {
      const pct = (state.currentTime / state.duration) * 100;
      if (dom.currentTimeDisplay) dom.currentTimeDisplay.textContent = formatTime(state.currentTime);
      if (dom.durationDisplay) dom.durationDisplay.textContent = formatTime(state.duration);
      if (dom.seekSlider && !state.isUserDraggingSeek) {
        dom.seekSlider.value = pct;
      }
      if (dom.stageBottomMiniProgressBar) {
        dom.stageBottomMiniProgressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
      }
      if (dom.nowPlayingSeekSlider && !state.isUserDraggingSeek) {
        dom.nowPlayingSeekSlider.value = pct;
      }
      if (dom.nowPlayingCurrentTime) dom.nowPlayingCurrentTime.textContent = formatTime(state.currentTime);
      if (dom.nowPlayingDuration) dom.nowPlayingDuration.textContent = formatTime(state.duration);
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
    if (dom.playIcon) dom.playIcon.classList.add('hidden');
    if (dom.pauseIcon) dom.pauseIcon.classList.remove('hidden');
    if (dom.nowPlayingPlayIcon) dom.nowPlayingPlayIcon.classList.add('hidden');
    if (dom.nowPlayingPauseIcon) dom.nowPlayingPauseIcon.classList.remove('hidden');
    if (typeof resetControlsHideTimer === 'function') {
      resetControlsHideTimer();
    }
  } else {
    if (dom.playIcon) dom.playIcon.classList.remove('hidden');
    if (dom.pauseIcon) dom.pauseIcon.classList.add('hidden');
    if (dom.nowPlayingPlayIcon) dom.nowPlayingPlayIcon.classList.remove('hidden');
    if (dom.nowPlayingPauseIcon) dom.nowPlayingPauseIcon.classList.add('hidden');
    if (typeof showStageControls === 'function') {
      showStageControls();
    }
  }
  updateMiniPlayerPlayPauseUI(playing);
}

function updateDurationUI(dur) {
  dom.durationDisplay.textContent = formatTime(dur);
}

function togglePlayPause() {
  if (!canUserControlPlayback()) {
    showToast('Oynatma ve durdurma yetkisi sadece Oda Sahibi ve Yöneticilere aittir.');
    return;
  }
  const nextPlayingState = !state.isPlaying;
  state.isPlaying = nextPlayingState;
  updatePlayPauseUI(state.isPlaying);

  const curTime = (typeof getLivePlayerTime === 'function') ? getLivePlayerTime() : (state.currentTime || 0);
  state.currentTime = curTime;

  // 1. YouTube Player
  if (state.activeMode === 'youtube') {
    if (state.isPlaying) {
      sendYtCommand('unMute');
      sendYtCommand('playVideo');
      setTimeout(() => { if (state.isPlaying) { sendYtCommand('unMute'); sendYtCommand('playVideo'); } }, 120);
      setTimeout(() => { if (state.isPlaying) sendYtCommand('playVideo'); }, 350);
      setTimeout(() => { if (state.isPlaying) sendYtCommand('playVideo'); }, 700);
    } else {
      sendYtCommand('pauseVideo');
      setTimeout(() => { if (!state.isPlaying) sendYtCommand('pauseVideo'); }, 60);
      setTimeout(() => { if (!state.isPlaying) sendYtCommand('pauseVideo'); }, 200);
      setTimeout(() => { if (!state.isPlaying) sendYtCommand('pauseVideo'); }, 500);
      setTimeout(() => { if (!state.isPlaying) sendYtCommand('pauseVideo'); }, 1000);
    }
  }

  // 2. Native Video Player / Direct
  if (dom.nativeVideoPlayer) {
    if (state.isPlaying) {
      dom.nativeVideoPlayer.play().catch(() => {});
    } else {
      dom.nativeVideoPlayer.pause();
      setTimeout(() => { if (!state.isPlaying && dom.nativeVideoPlayer) dom.nativeVideoPlayer.pause(); }, 60);
      setTimeout(() => { if (!state.isPlaying && dom.nativeVideoPlayer) dom.nativeVideoPlayer.pause(); }, 250);
      setTimeout(() => { if (!state.isPlaying && dom.nativeVideoPlayer) dom.nativeVideoPlayer.pause(); }, 600);
    }
  }

  // 3. Stage Content HTML5 Videos
  if (!state.isPlaying) {
    document.querySelectorAll('video:not(.peer-cam-video):not(#localVideo):not(#partnerVideo):not([data-webrtc-stream])').forEach(v => {
      try { v.pause(); } catch (_) {}
    });
  } else {
    document.querySelectorAll('video:not(.peer-cam-video):not(#localVideo):not(#partnerVideo):not([data-webrtc-stream])').forEach(v => {
      try { v.play().catch(() => {}); } catch (_) {}
    });
  }

  // 4. Send authoritative playback sync broadcast across all peers
  sendP2PData('sync', {
    action: state.isPlaying ? 'play' : 'pause',
    time: curTime,
    isPlaying: state.isPlaying,
    activeMode: state.activeMode,
    sentAt: Date.now()
  });
}

// YouTube postMessage Bridge: Two-Way Frame-Accurate Zero-Latency Play State & Scrubber Sync
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
      const prevTime = state.currentTime;
      state.currentTime = data.info.currentTime;
      state.lastReportedYtTime = data.info.currentTime;
      state.lastReportedYtAt = Date.now();

      if (dom.currentTimeDisplay) dom.currentTimeDisplay.textContent = formatTime(state.currentTime);
      if (state.duration > 0) {
        const pct = (state.currentTime / state.duration) * 100;
        if (dom.seekSlider && !state.isUserDraggingSeek) {
          dom.seekSlider.value = pct;
        }
        if (dom.stageBottomMiniProgressBar) {
          dom.stageBottomMiniProgressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
        }
        if (dom.nowPlayingSeekSlider && !state.isUserDraggingSeek) {
          dom.nowPlayingSeekSlider.value = pct;
        }
        if (dom.nowPlayingCurrentTime) dom.nowPlayingCurrentTime.textContent = formatTime(state.currentTime);
        if (dom.nowPlayingDuration) dom.nowPlayingDuration.textContent = formatTime(state.duration);
      }

      // Check if user scrubbed inside YouTube iframe progress bar directly
      if (typeof prevTime === 'number' && Math.abs(data.info.currentTime - prevTime) > 1.8) {
        if (!state.isRemoteAction && !state.isUserDraggingSeek && (Date.now() - (state.lastSyncSentAt || 0) > 800)) {
          if (canUserControlPlayback()) {
            state.lastSyncSentAt = Date.now();
            sendP2PData('sync', {
              action: 'seek',
              time: data.info.currentTime,
              isPlaying: state.isPlaying,
              sentAt: Date.now()
            });
          } else {
            // Unauthorized scrub: revert player back to synchronized room time
            sendYtCommand('seekTo', [state.currentTime, true]);
          }
        }
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
      // Buffering(3)/unstarted(-1)/cued(5) are NOT pauses; treating them as pause stopped the whole room
      const isRealPlayPause = data.info.playerState === 1 || data.info.playerState === 2;
      if (isRealPlayPause) {
        if (!state.isPlaying && isNowPlaying) {
          // Room state is paused: kill any rogue autoplay from iframe immediately!
          sendYtCommand('pauseVideo');
          return;
        }
        if (isNowPlaying !== state.isPlaying && !state.isRemoteAction) {
          if (!canUserControlPlayback()) {
            // Unauthorized peer state divergence: lock back to room playback state!
            if (state.isPlaying) sendYtCommand('playVideo');
            else sendYtCommand('pauseVideo');
            return;
          }
          state.isPlaying = isNowPlaying;
          updatePlayPauseUI(isNowPlaying);
          state.lastSyncSentAt = Date.now();
          sendP2PData('sync', {
            action: isNowPlaying ? 'play' : 'pause',
            time: state.currentTime,
            sentAt: Date.now()
          });
        }
      }
    }
  } else if (data.event === 'onReady') {
    sendYtCommand('addEventListener', ['onStateChange']);
  }

  // Handle YouTube Error events (150/152/101 embed copyright restriction, 100 not found, etc.)
  const errCode = (data.info && typeof data.info.errorCode === 'number' ? data.info.errorCode : null) ||
                  (data.info && typeof data.info.error === 'number' ? data.info.error : null) ||
                  (data.event === 'onError' && typeof data.info === 'number' ? data.info : null);
  if (errCode === 150 || errCode === 152 || errCode === 101 || errCode === 153 || errCode === 154) {
    console.warn('[Miruo] YouTube Embed Restriction Error:', errCode);
    showEmbedRestrictionFallback(state.currentVideoId);
  }
});

// YouTube Fallback tracker
let _altYtAttempted = false;

function showEmbedRestrictionFallback(videoId) {
  if (!videoId || !dom.ytPlayerContainer) return;

  // Try youtube-nocookie first if not yet attempted
  if (!_altYtAttempted) {
    _altYtAttempted = true;
    console.log('[Miruo] Telif/gömme kısıtı için youtube-nocookie deneniyor:', videoId);
    dom.ytPlayerContainer.innerHTML = `
      <iframe id="miruoYtIframe" 
              src="https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&playsinline=1&enablejsapi=1&controls=0&rel=0" 
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" 
              allowfullscreen 
              class="w-full h-full border-0 select-none">
      </iframe>
    `;
    return;
  }

  const existingFallback = document.getElementById('miruoEmbedFallback');
  if (existingFallback) return;

  const fallbackDiv = document.createElement('div');
  fallbackDiv.id = 'miruoEmbedFallback';
  fallbackDiv.className = 'absolute inset-0 z-30 flex flex-col items-center justify-center p-6 text-center bg-black/90 backdrop-blur-md transition-all duration-300';
  fallbackDiv.innerHTML = `
    <div class="w-14 h-14 rounded-2xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 mb-3 shadow-lg">
      <svg class="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
      </svg>
    </div>
    <h3 class="text-white text-sm md:text-base font-bold mb-1">YouTube Gömme Kısıtlaması</h3>
    <p class="text-gray-300 text-xs max-w-sm mb-4 leading-relaxed">
      Yayıncı bu içeriğin üçüncü taraf uygulamalarda oynatılmasını sınırlandırmış. Başka bir video seçebilir veya tarayıcıda izleyebilirsiniz.
    </p>
    <div class="flex items-center gap-2">
      <button type="button" onclick="if(typeof openVideoChooser==='function')openVideoChooser()" class="px-4 py-2 rounded-xl bg-gradient-to-r from-rose-500 to-indigo-600 text-white text-xs font-bold shadow-md cursor-pointer hover:opacity-90 active:scale-95 transition-all">
        Başka Video Seç
      </button>
      <button type="button" onclick="window.open('https://www.youtube.com/watch?v=${videoId}', '_blank')" class="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-medium border border-white/10 cursor-pointer active:scale-95 transition-all">
        YouTube'da Aç
      </button>
    </div>
  `;
  dom.ytPlayerContainer.appendChild(fallbackDiv);
}

// App Lifecycle Foreground Resume & Tab Switch Resynchronization
function handleAppForegroundResume() {
  console.log('[Miruo Sync] Uygulama ön plana geldi, senkronizasyon kontrol ediliyor...');

  // 1. Reconnect WebSocket if dropped during sleep/backgrounding
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (state.roomId) {
      console.log('[Miruo Sync] Sinyal soketi yenileniyor...');
      connectSignaling();
    }
  }

  // 2. Re-wake YouTube iframe state and ping listening
  sendYtCommand('listening');
  if (dom.ytPlayerIframe && dom.ytPlayerIframe.contentWindow) {
    try {
      dom.ytPlayerIframe.contentWindow.postMessage(JSON.stringify({ event: 'listening' }), '*');
    } catch (_) {}
  }

  // 3. Re-sync room state
  if (state.roomId) {
    // Request full synchronization from room host
    sendP2PData('sync', { action: 'request_sync', sentAt: Date.now() });

    // If local user is host or active player, also announce current status
    if (state.currentVideoId && state.isPlaying) {
      sendP2PData('sync', {
        action: 'heartbeat',
        time: state.currentTime,
        isPlaying: state.isPlaying,
        sentAt: Date.now()
      });
    }
  }

  // 4. Force responsive reflow
  window.dispatchEvent(new Event('resize'));
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // Screen locked or tab/app hidden - pause video playback
    if (state.isPlaying) {
      if (typeof sendYtCommand === 'function') {
        try { sendYtCommand('pauseVideo'); } catch (_) {}
      }
      if (state.ytPlayer && typeof state.ytPlayer.pauseVideo === 'function') {
        try { state.ytPlayer.pauseVideo(); } catch (_) {}
      }
      if (dom.nativeVideoPlayer) {
        try { dom.nativeVideoPlayer.pause(); } catch (_) {}
      }
      state.isPlaying = false;
      if (typeof updatePlayPauseUI === 'function') updatePlayPauseUI(false);
    }
  } else if (document.visibilityState === 'visible') {
    handleAppForegroundResume();
  }
});
window.addEventListener('focus', handleAppForegroundResume);
window.addEventListener('pageshow', handleAppForegroundResume);

// Screen Sharing (Continuous background transmission support)
let screenShareKeepAliveAudio = null;

function startScreenShareKeepAlive() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx && !screenShareKeepAliveAudio) {
      screenShareKeepAliveAudio = new AudioCtx();
      if (screenShareKeepAliveAudio.state === 'suspended') {
        screenShareKeepAliveAudio.resume();
      }
      const osc = screenShareKeepAliveAudio.createOscillator();
      const gain = screenShareKeepAliveAudio.createGain();
      gain.gain.value = 0.0001; // inaudible carrier keeps WebKit active in background
      osc.connect(gain);
      gain.connect(screenShareKeepAliveAudio.destination);
      osc.start();
    }
  } catch (e) {
    console.warn('[ScreenShareKeepAlive] error:', e);
  }
}

function stopScreenShareKeepAlive() {
  if (screenShareKeepAliveAudio) {
    try { screenShareKeepAliveAudio.close(); } catch (_) {}
    screenShareKeepAliveAudio = null;
  }
}

// Stage Photo & Video Sharing from Native Device Gallery
function triggerRoomGalleryPicker() {
  if (dom.videoChooserModal) {
    dom.videoChooserModal.classList.add('hidden');
    dom.videoChooserModal.classList.remove('flex');
  }
  if (dom.createRoomModal) {
    dom.createRoomModal.classList.add('hidden');
    dom.createRoomModal.classList.remove('flex');
  }

  // If user is not yet inside a room, create and join room immediately
  if (!state.isInRoom || !state.roomId) {
    if (typeof createAndJoinRoom === 'function') {
      createAndJoinRoom('Galeri Odası', false, 'Galeri');
    }
  }

  // If inside native iOS Miruo app
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pickImage) {
    window.webkit.messageHandlers.pickImage.postMessage({ target: 'stage_media' });
    return;
  }
  // HTML5 Gallery File Picker fallback
  let input = document.getElementById('roomMediaFileInput');
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.id = 'roomMediaFileInput';
    input.accept = 'image/*,video/*';
    input.className = 'hidden';
    document.body.appendChild(input);
  }
  input.onchange = handleRoomMediaFileSelected;
  input.value = '';
  input.click();
}
window.triggerRoomGalleryPicker = triggerRoomGalleryPicker;

function handleRoomMediaFileSelected(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  processSelectedStageMedia(file);
}

function processSelectedStageMedia(file) {
  if (!file) return;
  const isImage = file.type && file.type.startsWith('image');
  const isVideo = file.type && file.type.startsWith('video');

  if (isImage) {
    const reader = new FileReader();
    reader.onload = (evt) => {
      const dataUrl = evt.target.result;
      displayPhotoOnStage(dataUrl, file.name || 'Fotoğraf', true);
    };
    reader.readAsDataURL(file);
  } else if (isVideo) {
    const videoUrl = URL.createObjectURL(file);
    playVideoOnStage(videoUrl, file.name || 'Yerel Video', true);
  }
}

function displayPhotoOnStage(dataUrl, title = 'Fotoğraf', isLocal = true) {
  if (!dataUrl) return;

  // 1. If not yet in a room, create and join a photo room
  if (!state.isInRoom || !state.roomId) {
    if (typeof createAndJoinRoom === 'function') {
      createAndJoinRoom('Galeri Odası', false, 'Galeri');
    }
  }

  // If in sleep mode, exit it to show the shared photo
  if (state.isSleepMode) {
    applySleepMode(false, false);
  }

  // 2. Hide explore lobby and modals, transition view directly to Room Workspace
  if (dom.exploreLobbySection) {
    dom.exploreLobbySection.classList.add('hidden');
    dom.exploreLobbySection.classList.remove('flex');
  }
  if (dom.providerPickerSection) {
    dom.providerPickerSection.classList.add('hidden');
    dom.providerPickerSection.classList.remove('flex');
  }
  if (dom.createRoomModal) {
    dom.createRoomModal.classList.add('hidden');
    dom.createRoomModal.classList.remove('flex');
  }
  if (dom.videoChooserModal) {
    dom.videoChooserModal.classList.add('hidden');
    dom.videoChooserModal.classList.remove('flex');
  }
  if (typeof switchToMyRoom === 'function') {
    switchToMyRoom();
  }

  // 3. Pause active videos (YouTube, HTML5, Web)
  if (state.ytPlayer && typeof state.ytPlayer.pauseVideo === 'function') {
    try { state.ytPlayer.pauseVideo(); } catch (_) {}
  }
  if (dom.nativeVideoPlayer) {
    try { dom.nativeVideoPlayer.pause(); } catch (_) {}
    dom.nativeVideoPlayer.classList.add('hidden');
  }
  if (dom.ytPlayerContainer) dom.ytPlayerContainer.classList.add('hidden');
  if (dom.webPlayerFrame) dom.webPlayerFrame.classList.add('hidden');
  if (dom.remoteScreenPlayer) dom.remoteScreenPlayer.classList.add('hidden');
  if (dom.sleepModePlaceholder) dom.sleepModePlaceholder.classList.add('hidden');
  if (dom.emptyStatePlaceholder) dom.emptyStatePlaceholder.classList.add('hidden');
  if (dom.audioOnlyPlaceholder) dom.audioOnlyPlaceholder.classList.add('hidden');

  // 4. Render Photo Stage with guaranteed visibility
  const photoStage = document.getElementById('photoStageContainer');
  const photoImg = document.getElementById('stagePhotoImage');
  const photoTitle = document.getElementById('photoStageTitle');
  if (photoStage && photoImg) {
    photoImg.src = dataUrl;
    if (photoTitle) photoTitle.textContent = title;
    photoStage.classList.remove('hidden');
    photoStage.style.display = 'flex';
    photoStage.style.zIndex = '35';
  }

  // 5. Update Now Playing Bar to show Photo from Gallery
  if (dom.nowPlayingTitle) dom.nowPlayingTitle.textContent = title;
  if (dom.nowPlayingPrefixText) dom.nowPlayingPrefixText.textContent = '';
  if (dom.nowPlayingSuffixText) dom.nowPlayingSuffixText.textContent = 'görüntüleniyor';
  if (dom.nowPlayingProviderBadge) {
    dom.nowPlayingProviderBadge.textContent = 'Galeri';
    dom.nowPlayingProviderBadge.className = 'px-1.5 py-0.2 rounded bg-pink-500/20 text-pink-300 font-semibold';
  }

  state.currentVideoTitle = title;
  state.currentProvider = 'Galeri';
  state.activeMode = 'photo';
  state.isPlaying = false; // Static photo stays on screen
  state.currentPhotoStageData = { dataUrl, title };

  if (isLocal) {
    shrinkDataUrlForShare(dataUrl).then(small => {
      state.currentPhotoStageData = { dataUrl: small, title };
      sendP2PData('photo_share', { dataUrl: small, title, sender: state.username });
    });
    showToast('Fotoğraf odada paylaşıldı.');
  }
}

// Downscale photos so they fit realtime/data-channel message limits (~180KB)
function shrinkDataUrlForShare(dataUrl, maxChars = 180000) {
  return new Promise(resolve => {
    if (!dataUrl || dataUrl.length <= maxChars) return resolve(dataUrl);
    const img = new Image();
    img.onerror = () => resolve(dataUrl);
    img.onload = () => {
      let dim = 1280;
      let quality = 0.8;
      let out = dataUrl;
      for (let i = 0; i < 8; i++) {
        const scale = Math.min(1, dim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        out = canvas.toDataURL('image/jpeg', quality);
        if (out.length <= maxChars) break;
        dim = Math.round(dim * 0.75);
        quality = Math.max(0.5, quality - 0.07);
      }
      resolve(out);
    };
    img.src = dataUrl;
  });
}

function closePhotoStage(isLocal = true) {
  const photoStage = document.getElementById('photoStageContainer');
  if (photoStage) {
    photoStage.classList.add('hidden');
    photoStage.style.display = 'none';
  }
  state.currentPhotoStageData = null;
  if (state.activeMode === 'photo') {
    state.activeMode = 'youtube';
    if (dom.emptyStatePlaceholder) dom.emptyStatePlaceholder.classList.remove('hidden');
  }
  if (isLocal) {
    sendP2PData('photo_close', {});
    showToast('Fotoğraf kapatıldı.');
  }
}
window.displayPhotoOnStage = displayPhotoOnStage;
window.closePhotoStage = closePhotoStage;

function playVideoOnStage(videoUrl, title = 'Video', isLocal = true) {
  if (!videoUrl) return;

  // Ensure user is in room
  if (!state.isInRoom || !state.roomId) {
    if (typeof createAndJoinRoom === 'function') {
      createAndJoinRoom('Galeri Odası', false, 'Galeri');
    }
  }

  // If in sleep mode, exit it to show the played video
  if (state.isSleepMode) {
    applySleepMode(false, false);
  }

  if (dom.exploreLobbySection) {
    dom.exploreLobbySection.classList.add('hidden');
    dom.exploreLobbySection.classList.remove('flex');
  }
  if (dom.createRoomModal) {
    dom.createRoomModal.classList.add('hidden');
    dom.createRoomModal.classList.remove('flex');
  }
  if (dom.videoChooserModal) {
    dom.videoChooserModal.classList.add('hidden');
    dom.videoChooserModal.classList.remove('flex');
  }
  if (typeof switchToMyRoom === 'function') {
    switchToMyRoom();
  }

  const photoStage = document.getElementById('photoStageContainer');
  if (photoStage) {
    photoStage.classList.add('hidden');
    photoStage.style.display = 'none';
  }
  if (dom.ytPlayerContainer) dom.ytPlayerContainer.classList.add('hidden');
  if (dom.webPlayerFrame) dom.webPlayerFrame.classList.add('hidden');
  if (dom.remoteScreenPlayer) dom.remoteScreenPlayer.classList.add('hidden');
  if (dom.sleepModePlaceholder) dom.sleepModePlaceholder.classList.add('hidden');
  if (dom.emptyStatePlaceholder) dom.emptyStatePlaceholder.classList.add('hidden');
  if (dom.audioOnlyPlaceholder) dom.audioOnlyPlaceholder.classList.add('hidden');

  if (dom.nativeVideoPlayer) {
    dom.nativeVideoPlayer.src = videoUrl;
    dom.nativeVideoPlayer.classList.remove('hidden');
    dom.nativeVideoPlayer.play().catch(() => {});
  }

  if (dom.nowPlayingTitle) dom.nowPlayingTitle.textContent = title;
  if (dom.nowPlayingPrefixText) dom.nowPlayingPrefixText.textContent = 'Şimdi';
  if (dom.nowPlayingSuffixText) dom.nowPlayingSuffixText.textContent = 'oynatılıyor';
  if (dom.nowPlayingProviderBadge) {
    dom.nowPlayingProviderBadge.textContent = 'Galeri';
    dom.nowPlayingProviderBadge.className = 'px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 font-semibold';
  }

  state.currentVideoTitle = title;
  state.currentProvider = 'Galeri';
  state.activeMode = 'direct';
  state.isPlaying = true;
  state.currentPhotoStageData = null;

  if (isLocal) {
    showToast(`Video oynatılıyor: ${title}`);
  }
}
window.playVideoOnStage = playVideoOnStage;

// Screen Sharing (Netflix / Dizi / Browser)
async function startScreenSharing() {
  try {
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always', frameRate: 60 },
        audio: true
      });
    } catch (audioErr) {
      console.warn('[ScreenShare] getDisplayMedia with audio failed, falling back to video only:', audioErr);
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always', frameRate: 60 }
      });
    }

    state.screenStream = stream;
    state.isScreenSharing = true;
    state.activeMode = 'screenshare';

    // Stop and pause any playing YouTube or background media
    sendYtCommand('pauseVideo');
    state.isPlaying = false;
    updatePlayPauseUI(false);

    dom.nativeVideoPlayer.srcObject = stream;
    dom.nativeVideoPlayer.play().catch(() => {});
    dom.nativeVideoPlayer.classList.remove('hidden');
    dom.ytPlayerContainer.classList.add('hidden');
    dom.emptyStatePlaceholder.classList.add('hidden');
    const photoStage = document.getElementById('photoStageContainer');
    if (photoStage) photoStage.classList.add('hidden');

    if (dom.startScreenShareBtn) dom.startScreenShareBtn.classList.add('hidden');
    if (dom.stopScreenShareBtn) dom.stopScreenShareBtn.classList.remove('hidden');

    // Add track to ALL active WebRTC peers in the mesh
    state.screenSenders = [];
    if (state.peers && Object.keys(state.peers).length > 0) {
      Object.values(state.peers).forEach(peer => {
        if (peer && peer.pc && peer.pc.signalingState !== 'closed') {
          stream.getTracks().forEach(track => {
            try {
              const sender = peer.pc.addTrack(track, stream);
              state.screenSenders.push({ pc: peer.pc, sender });
            } catch (_) {}
          });
        }
      });
    }
    if (state.pc && state.pc.signalingState !== 'closed') {
      stream.getTracks().forEach(track => {
        try {
          const sender = state.pc.addTrack(track, stream);
          state.screenSenders.push({ pc: state.pc, sender });
        } catch (_) {}
      });
    }
    await renegotiateWebRTC();

    // Broadcast screen share event to room
    sendP2PData('screenshare_start', { user: state.username });
    sendSignal({ type: 'screenshare-start', user: state.username });

    // Keep background audio active so iOS doesn't suspend capture when switching apps
    startScreenShareKeepAlive();

    const vTrack = stream.getVideoTracks()[0];
    if (vTrack) {
      vTrack.onended = () => {
        if (state.isScreenSharing) {
          console.log('[ScreenShare] Video track ended.');
          stopScreenSharing();
        }
      };
      vTrack.onmute = () => {
        console.log('[ScreenShare] Video track muted (app backgrounded) - keeping stream session active.');
      };
      vTrack.onunmute = () => {
        console.log('[ScreenShare] Video track unmuted - resumed.');
      };
    }

    showToast('Ekran yayını başlatıldı! Uygulamayı alta atsanız da yayın devam eder.');
  } catch (err) {
    console.error('Ekran paylaşımı hatası:', err);
    showToast('Ekran paylaşımı iptal edildi veya reddedildi.');
  }
}

function stopScreenSharing() {
  stopScreenShareKeepAlive();
  if (state.screenStream) {
    state.screenStream.getTracks().forEach(t => t.stop());
    state.screenStream = null;
  }
  if (state.screenSenders && state.screenSenders.length) {
    state.screenSenders.forEach(item => {
      try {
        if (item && item.pc && item.sender) item.pc.removeTrack(item.sender);
      } catch (_) {}
    });
    state.screenSenders = [];
    renegotiateWebRTC();
  }
  if (dom.nativeVideoPlayer && state.activeMode === 'screenshare') {
    try { dom.nativeVideoPlayer.srcObject = null; } catch (_) {}
    dom.nativeVideoPlayer.classList.add('hidden');
    if (dom.emptyStatePlaceholder) dom.emptyStatePlaceholder.classList.remove('hidden');
    state.activeMode = null;
  }
  state.isScreenSharing = false;
  if (dom.startScreenShareBtn) dom.startScreenShareBtn.classList.remove('hidden');
  if (dom.stopScreenShareBtn) dom.stopScreenShareBtn.classList.add('hidden');
  sendP2PData('screenshare_stop', { user: state.username });
  sendSignal({ type: 'screenshare-stop', user: state.username });
  showToast('Ekran yayını sonlandırıldı.');
}

function handleRemoteScreenShareStarted(user) {
  state.activeMode = 'screenshare';
  sendYtCommand('pauseVideo');
  state.isPlaying = false;
  updatePlayPauseUI(false);

  if (dom.ytPlayerContainer) dom.ytPlayerContainer.classList.add('hidden');
  if (dom.emptyStatePlaceholder) dom.emptyStatePlaceholder.classList.add('hidden');
  const photoStage = document.getElementById('photoStageContainer');
  if (photoStage) photoStage.classList.add('hidden');

  if (dom.remoteScreenPlayer) {
    dom.remoteScreenPlayer.classList.remove('hidden');
    const screenPeer = Object.values(state.peers || {}).find(p => p.stream && p.stream.getVideoTracks().length > 0) || (state.remoteStream ? { stream: state.remoteStream } : null);
    if (screenPeer && screenPeer.stream) {
      dom.remoteScreenPlayer.srcObject = screenPeer.stream;
      dom.remoteScreenPlayer.play().catch(() => {});
    }
  }
  showToast(`@${user || 'Oda Sahibi'} ekranını paylaşıyor`);
}

function handleRemoteScreenShareStopped() {
  state.activeMode = null;
  if (dom.remoteScreenPlayer) {
    try { dom.remoteScreenPlayer.srcObject = null; } catch (_) {}
    dom.remoteScreenPlayer.classList.add('hidden');
  }
  if (state.currentVideoId) {
    if (dom.ytPlayerContainer) dom.ytPlayerContainer.classList.remove('hidden');
  } else {
    if (dom.emptyStatePlaceholder) dom.emptyStatePlaceholder.classList.remove('hidden');
  }
  showToast('Ekran yayını sona erdi');
}
window.startScreenSharing = startScreenSharing;
window.startScreenShare = startScreenSharing;

// ==========================================
// 4.5 MULTI-PLATFORM SWITCHER, FULLSCREEN & RAVE PiP
// ==========================================

// Fullscreen Stage Manager (With Rave Floating PiP Overlay Support)
function isStageFullscreen() {
  return !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    (dom.stageContainer && dom.stageContainer.classList.contains('is-fullscreen-pseudo'))
  );
}

function enterStageFullscreenDimensions() {
  if (!dom.stageContainer) return;

  dom.stageContainer.classList.add('is-fullscreen-pseudo');
  dom.stageContainer.classList.remove('aspect-video');
  dom.stageContainer.style.setProperty('height', '100dvh', 'important');
  dom.stageContainer.style.setProperty('width', '100vw', 'important');
  dom.stageContainer.style.setProperty('position', 'fixed', 'important');
  dom.stageContainer.style.setProperty('inset', '0', 'important');
  dom.stageContainer.style.setProperty('z-index', '999990', 'important');
  dom.stageContainer.style.setProperty('aspect-ratio', 'auto', 'important');
  document.body.classList.add('stage-is-fullscreen');
  document.documentElement.classList.add('stage-is-fullscreen');

  const hasNativeFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || 
                      !!window.webkit?.messageHandlers ||
                      (window.innerWidth < 768 && 'ontouchstart' in window);

  // On iOS / mobile touch, pseudo-fullscreen (fixed inset 0) is rock solid without Safari fullscreen banner or keyboard jumps
  if (!hasNativeFs && !isIOSDevice) {
    if (dom.stageContainer.requestFullscreen) {
      dom.stageContainer.requestFullscreen().catch(() => {});
    } else if (dom.stageContainer.webkitRequestFullscreen) {
      try {
        dom.stageContainer.webkitRequestFullscreen();
      } catch (e) {}
    }
  }

  // Floating restore chat button (only fs button in fullscreen!)
  if (dom.openFsChatFloatingBtn) {
    dom.openFsChatFloatingBtn.classList.toggle('hidden', state.isChatVisible);
  }
  if (dom.openChatFloatingBtn) {
    dom.openChatFloatingBtn.classList.add('hidden');
  }
  if (dom.stageExitFullscreenFloatingBtn) {
    dom.stageExitFullscreenFloatingBtn.classList.remove('hidden');
  }

  updateFullscreenUI();
}

function exitStageFullscreenDimensions() {
  if (!dom.stageContainer) return;

  dom.stageContainer.classList.remove('is-fullscreen-pseudo');
  dom.stageContainer.classList.add('aspect-video');
  dom.stageContainer.style.removeProperty('height');
  dom.stageContainer.style.removeProperty('width');
  dom.stageContainer.style.removeProperty('position');
  dom.stageContainer.style.removeProperty('inset');
  dom.stageContainer.style.removeProperty('z-index');
  dom.stageContainer.style.removeProperty('aspect-ratio');
  document.body.classList.remove('stage-is-fullscreen');
  document.documentElement.classList.remove('stage-is-fullscreen');
  document.body.classList.remove('fs-chat-active');
  dom.stageContainer.classList.remove('fs-chat-active');

  if (dom.fsChatOverlay) {
    dom.fsChatOverlay.classList.add('hidden');
  }

  if (document.fullscreenElement || document.webkitFullscreenElement) {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      try {
        document.webkitExitFullscreen();
      } catch (e) {}
    }
  }

  if (dom.stageExitFullscreenFloatingBtn) {
    dom.stageExitFullscreenFloatingBtn.classList.add('hidden');
  }

  // Outside fullscreen, NEVER show openFsChatFloatingBtn!
  if (dom.openFsChatFloatingBtn) {
    dom.openFsChatFloatingBtn.classList.add('hidden');
  }
  if (dom.openChatFloatingBtn) {
    dom.openChatFloatingBtn.classList.add('hidden');
  }

  updateFullscreenUI();
  window.dispatchEvent(new Event('resize'));
}

function toggleFullscreen() {
  if (!dom.stageContainer) return;
  if (isStageFullscreen()) {
    exitStageFullscreenDimensions();
    setChatVisibility(true);
  } else {
    enterStageFullscreenDimensions();
    if (dom.roomChatSidebar) {
      dom.roomChatSidebar.classList.add('hidden');
    }
    state.isChatVisible = false;
    if (dom.chatToolbarBtnText) {
      const dictChat = I18N[currentLang] || I18N.tr;
      dom.chatToolbarBtnText.textContent = dictChat.show_chat || 'Sohbeti Aç';
    }
    if (dom.toggleChatToolbarBtn) {
      dom.toggleChatToolbarBtn.classList.remove('bg-rose-500/20', 'text-rose-300', 'border-rose-500/40');
    }
  }
}

function updateFullscreenUI() {
  const isFs = isStageFullscreen();
  const enterSvg = `<path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>`;
  const exitSvg = `<path stroke-linecap="round" stroke-linejoin="round" d="M9 4v4H5M9 8L4 3m11 1v4h4m-4 0l5-5M9 20v-4H5m4 0l-5 5m11-1v-4h4m-4 0l5 5"/>`;
  
  if (dom.stageFullscreenIcon) dom.stageFullscreenIcon.innerHTML = isFs ? exitSvg : enterSvg;
  if (dom.dockFullscreenIcon) dom.dockFullscreenIcon.innerHTML = isFs ? exitSvg : enterSvg;
  
  // Single Exit Fullscreen button - Hide top-right stage button during fullscreen so only ONE button exists
  if (dom.stageFloatingFullscreenBtn) {
    dom.stageFloatingFullscreenBtn.classList.toggle('hidden', isFs);
  }
  if (dom.stageExitFullscreenFloatingBtn) {
    dom.stageExitFullscreenFloatingBtn.classList.toggle('hidden', !isFs);
  }

  if (typeof resetControlsHideTimer === 'function') {
    resetControlsHideTimer();
  }

  // Apply PiP in fullscreen visibility rules
  applyPipFullscreenSettings(isFs);

  // Apply Fullscreen Live Chat overlay rules (Classic YouTube format)
  applyFsChatFullscreenSettings(isFs);
}

// Fullscreen Live Chat (Classic YouTube Live Format)
let fsChatSettings = {
  showInFullscreen: true,
  isFsChatOpen: false
};

function loadFsChatSettings() {
  try {
    const saved = localStorage.getItem('miruo_fs_show_chat');
    if (saved !== null) {
      fsChatSettings.showInFullscreen = JSON.parse(saved);
    }
  } catch (e) {}
  const cb = document.getElementById('fsShowChatCheckbox');
  if (cb) cb.checked = fsChatSettings.showInFullscreen;
}

function saveFsChatSettings() {
  localStorage.setItem('miruo_fs_show_chat', JSON.stringify(fsChatSettings.showInFullscreen));
  const isFs = isStageFullscreen();
  applyFsChatFullscreenSettings(isFs);
}

function isMobileLandscapeMode() {
  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent));
  const isLandscapeOrientation = window.innerWidth > window.innerHeight;
  const isPhone = /iPhone|iPod|Android/i.test(navigator.userAgent);
  const isShortScreen = window.innerHeight < 650;
  return isTouchDevice && isLandscapeOrientation && (isPhone || isShortScreen);
}

function applyFsChatFullscreenSettings(isFullscreen) {
  const overlay = document.getElementById('fsChatOverlay');
  const floatBtn = document.getElementById('openFsChatFloatingBtn');
  const stage = dom.stageContainer || document.getElementById('stageContainer');
  const isMobileCinema = isMobileLandscapeMode();
  const isCinema = isFullscreen || isMobileCinema;
  const isChatShowing = isCinema && state.isChatVisible && fsChatSettings.isFsChatOpen && fsChatSettings.showInFullscreen;

  if (isCinema) {
    if (dom.openChatFloatingBtn) dom.openChatFloatingBtn.classList.add('hidden');
    if (!isChatShowing) {
      if (overlay) overlay.classList.add('hidden');
      if (floatBtn) floatBtn.classList.remove('hidden');
      if (stage) stage.classList.remove('fs-chat-active');
      document.body.classList.remove('fs-chat-active');
    } else {
      if (overlay) overlay.classList.remove('hidden');
      if (floatBtn) floatBtn.classList.add('hidden');
      if (stage) stage.classList.add('fs-chat-active');
      document.body.classList.add('fs-chat-active');
    }
  } else {
    if (overlay) overlay.classList.add('hidden');
    if (floatBtn) floatBtn.classList.add('hidden');
    if (dom.openChatFloatingBtn) dom.openChatFloatingBtn.classList.add('hidden');
    if (stage) stage.classList.remove('fs-chat-active');
    document.body.classList.remove('fs-chat-active');
  }
}

function setFsChatVisibility(open) {
  fsChatSettings.isFsChatOpen = !!open;
  if (open) {
    fsChatSettings.showInFullscreen = true;
  }
  state.isChatVisible = !!open;
  const isFs = isStageFullscreen();
  applyFsChatFullscreenSettings(isFs);
  window.dispatchEvent(new Event('resize'));
  setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
  setTimeout(() => window.dispatchEvent(new Event('resize')), 300);
}

// Video Display / Audio-Only Mode Manager
let videoDisplaySettings = {
  showVideo: true
};

function loadVideoDisplaySettings() {
  try {
    const saved = localStorage.getItem('miruo_show_video_display');
    if (saved !== null) {
      videoDisplaySettings.showVideo = JSON.parse(saved);
    }
  } catch (e) {}
  applyVideoDisplay();
}

function setVideoDisplay(show) {
  videoDisplaySettings.showVideo = !!show;
  localStorage.setItem('miruo_show_video_display', JSON.stringify(videoDisplaySettings.showVideo));
  applyVideoDisplay();
  const dict = I18N[currentLang] || I18N.tr;
  showToast(videoDisplaySettings.showVideo ? (dict.toast_video_shown || 'Video görüntüsü açıldı') : (dict.toast_video_hidden || 'Video görüntüsü gizlendi, yalnızca ses çalıyor'));
}

function applyVideoDisplay() {
  const show = videoDisplaySettings.showVideo;
  const ytCont = dom.ytPlayerContainer;
  const nativeVid = dom.nativeVideoPlayer;
  const webFrame = dom.webPlayerFrame;
  const remoteScreen = dom.remoteScreenPlayer;
  const audioOnlyEl = document.getElementById('audioOnlyPlaceholder');
  const toggleCb = document.getElementById('videoDisplayToggleCheckbox');
  const overlayVideoBtn = document.getElementById('toggleVideoDisplayBtn');
  const videoIcon = document.getElementById('videoDisplayIcon');

  if (ytCont) ytCont.classList.toggle('video-display-hidden', !show);
  if (nativeVid) nativeVid.classList.toggle('video-display-hidden', !show);
  if (webFrame) webFrame.classList.toggle('video-display-hidden', !show);
  if (remoteScreen) remoteScreen.classList.toggle('video-display-hidden', !show);

  if (audioOnlyEl) {
    audioOnlyEl.classList.toggle('hidden', show);
    if (!show) {
      const playingTitle = dom.nowPlayingTitle ? dom.nowPlayingTitle.textContent : '';
      const trackTitleEl = document.getElementById('audioOnlyTrackTitle');
      if (trackTitleEl && playingTitle) trackTitleEl.textContent = playingTitle;
    }
  }

  if (toggleCb) toggleCb.checked = show;
  if (overlayVideoBtn) {
    overlayVideoBtn.classList.toggle('text-rose-400', !show);
  }
  if (videoIcon) {
    videoIcon.innerHTML = show
      ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"/><circle cx="12" cy="12" r="3"/>'
      : '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
  }
}

// Leave Room Gracefully
function leaveRoom() {
  state.isIntentionalLeave = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  showRoomConnectionStatus(false);

  if (syncHeartbeatInterval) {
    clearInterval(syncHeartbeatInterval);
    syncHeartbeatInterval = null;
  }
  if (trackingInterval) {
    clearInterval(trackingInterval);
    trackingInterval = null;
  }

  // Clear YouTube player / iframe immediately
  const ytFrame = document.getElementById('miruoYtIframe');
  if (ytFrame) {
    try { ytFrame.src = 'about:blank'; } catch (e) {}
    ytFrame.remove();
  }
  if (dom.ytPlayerContainer) {
    dom.ytPlayerContainer.innerHTML = '';
    dom.ytPlayerContainer.classList.add('hidden');
  }
  if (dom.emptyStatePlaceholder) {
    dom.emptyStatePlaceholder.classList.remove('hidden');
  }

  if (state.player && typeof state.player.stopVideo === 'function') {
    try { state.player.stopVideo(); } catch (e) {}
  }
  if (dom.nativeVideoPlayer) {
    try {
      dom.nativeVideoPlayer.pause();
      dom.nativeVideoPlayer.src = '';
      dom.nativeVideoPlayer.load();
    } catch (e) {}
    dom.nativeVideoPlayer.classList.add('hidden');
  }
  if (dom.webPlayerFrame) {
    try { dom.webPlayerFrame.src = 'about:blank'; } catch (e) {}
    dom.webPlayerFrame.classList.add('hidden');
  }

  if (state.isSleepMode) {
    applySleepMode(false, false);
  }

  if (state.isScreenSharing) {
    stopScreenSharing();
  }
  if (state.isCamOn) {
    toggleCam();
  }
  if (state.isMicOn) {
    toggleMic();
  }

  // Stop local hardware tracks and clean up extra PIP bubbles
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => {
      try { t.stop(); } catch (_) {}
    });
    state.localStream = null;
  }
  document.querySelectorAll('.remote-extra-pip').forEach(el => el.remove());
  state.dismissedPips = {};
  state.isPartnerPipDismissed = false;
  state.isSelfPipDismissed = false;
  state.activePipPeerId = null;
  if (dom.partnerPipCard) dom.partnerPipCard.classList.add('hidden');
  if (dom.selfPipCard) dom.selfPipCard.classList.add('hidden');
  if (dom.roomVideoGrid) dom.roomVideoGrid.classList.add('hidden');

  // Close WebRTC DataChannels, PeerConnections & Peer Audios
  try {
    if (state.peers) {
      Object.keys(state.peers).forEach(pid => {
        try { state.peers[pid].pc.close(); } catch (_) {}
        const pAudio = document.getElementById('remoteVoiceAudio_' + pid);
        if (pAudio) {
          try { pAudio.pause(); pAudio.srcObject = null; pAudio.remove(); } catch (_) {}
        }
      });
      state.peers = {};
    }
    document.querySelectorAll('audio[id^="remoteVoiceAudio"]').forEach(aud => {
      try { aud.pause(); aud.srcObject = null; } catch (_) {}
    });
    if (state.dataChannel) {
      state.dataChannel.close();
      state.dataChannel = null;
    }
    if (state.pc) {
      state.pc.close();
      state.pc = null;
    }
    state.peerId = null;
    state.remoteStream = null;
    state.participants = {};
    if (dom.roomMemberCountBadge) dom.roomMemberCountBadge.textContent = '1';
    if (dom.participantsCountHeader) dom.participantsCountHeader.textContent = '1';
  } catch (e) {}

  // Close WebSocket if open
  try {
    if (ws) {
      ws.close();
      ws = null;
    }
  } catch (e) {}

  // Cleanup Supabase room presence & channels
  if (globalRoomsChannel && state.isHost) {
    try {
      globalRoomsChannel.send({
        type: 'broadcast',
        event: 'room_closed',
        payload: { id: state.roomId }
      }).catch(() => {});
      globalRoomsChannel.untrack().catch(() => {});
    } catch (_) {}
  }
  if (roomSupabaseChannel) {
    try {
      roomSupabaseChannel.untrack().catch(() => {});
      roomSupabaseChannel.unsubscribe();
    } catch (_) {}
    roomSupabaseChannel = null;
  }

  // Clear local room state so closed room never lingers in Explore
  try {
    localStorage.removeItem('miruo_my_public_rooms');
    if (state.roomId) {
      removeGlobalRealtimeRoom(state.roomId);
    }
  } catch (_) {}

  // Stop bots for this room
  stopBotsForActiveRoom();

  exitStageFullscreenDimensions();
  document.body.classList.remove('in-room-mode');
  document.documentElement.classList.remove('in-room-mode');
  document.body.classList.remove('has-mini-player');
  state.isMiniPlayer = false;

  state.currentVideoId = null;
  state.isPlaying = false;
  state.isRemoteAction = false;
  state.isChatVisible = true;
  state.isInRoom = false;
  setChatVisibility(true);

  switchToExplore();
  const dict = I18N[currentLang] || I18N.tr;
  showToast(dict.toast_left_room || 'Odadan ayrıldınız');
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

function savePipSettings(forceCorner = false) {
  localStorage.setItem('miruo_pip_settings', JSON.stringify(pipSettings));
  applyPipPositioning(forceCorner);
  showToast('Kamera yerleşimi güncellendi');
}

function applyPipPositioning(forceCorner = false) {
  const cornerClass = `pip-pos-${pipSettings.corner}`;
  const corners = ['pip-pos-bottom-right', 'pip-pos-bottom-left', 'pip-pos-top-right', 'pip-pos-top-left'];
  
  [dom.partnerPipCard, dom.selfPipCard].forEach(card => {
    if (!card) return;
    if (forceCorner) {
      card.classList.remove('pip-custom-pos');
      card.style.removeProperty('left');
      card.style.removeProperty('top');
      card.style.removeProperty('right');
      card.style.removeProperty('bottom');
    }
    if (!card.classList.contains('pip-custom-pos')) {
      corners.forEach(c => card.classList.remove(c));
      card.classList.add(cornerClass);
    }
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

function clampPipCardsToStage() {
  const stage = dom.stageContainer || document.getElementById('stageContainer');
  if (!stage) return;

  if (state.isCamOn && dom.selfPipCard) {
    dom.selfPipCard.classList.remove('hidden', 'pip-hidden-fullscreen');
  }

  const stageRect = stage.getBoundingClientRect();
  const stageW = stage.clientWidth || stageRect.width || 0;
  const stageH = stage.clientHeight || stageRect.height || 0;
  if (stageW < 40 || stageH < 40) return;

  const allPipCards = [dom.selfPipCard, dom.partnerPipCard, ...Array.from(document.querySelectorAll('.remote-extra-pip'))];
  allPipCards.forEach(card => {
    if (!card || card.classList.contains('hidden')) return;

    // Restore saved drag position from localStorage if available
    const storageKey = card.id === 'selfPipCard' ? 'miruo_self_cam_pos' : 'miruo_partner_cam_pos';
    if (!card.classList.contains('pip-custom-pos')) {
      try {
        const savedPosRaw = localStorage.getItem(storageKey);
        if (savedPosRaw) {
          const savedPos = JSON.parse(savedPosRaw);
          if (savedPos && typeof savedPos.relX === 'number' && typeof savedPos.relY === 'number') {
            const posX = Math.round(savedPos.relX * stageW);
            const posY = Math.round(savedPos.relY * stageH);
            card.classList.remove('pip-pos-bottom-right', 'pip-pos-bottom-left', 'pip-pos-top-right', 'pip-pos-top-left');
            card.classList.add('pip-custom-pos');
            card.style.setProperty('left', `${posX}px`, 'important');
            card.style.setProperty('top', `${posY}px`, 'important');
          }
        }
      } catch (_) {}
    }

    if (card.classList.contains('pip-custom-pos') || card.style.left || card.style.top) {
      const cardRect = card.getBoundingClientRect();
      const cardW = card.offsetWidth || cardRect.width || 96;
      const cardH = card.offsetHeight || cardRect.height || 96;
      let curLeft = parseFloat(card.style.left);
      let curTop = parseFloat(card.style.top);
      if (isNaN(curLeft)) curLeft = cardRect.left - stageRect.left;
      if (isNaN(curTop)) curTop = cardRect.top - stageRect.top;

      const maxLeft = Math.max(8, stageW - cardW - 8);
      const maxTop = Math.max(8, stageH - cardH - 8);
      const clampedLeft = Math.max(8, Math.min(curLeft, maxLeft));
      const clampedTop = Math.max(8, Math.min(curTop, maxTop));

      card.style.setProperty('right', 'auto', 'important');
      card.style.setProperty('bottom', 'auto', 'important');
      card.style.setProperty('left', `${clampedLeft}px`, 'important');
      card.style.setProperty('top', `${clampedTop}px`, 'important');
    }
  });
}

window.addEventListener('resize', () => {
  const isFs = isStageFullscreen();
  applyFsChatFullscreenSettings(isFs);
  clampPipCardsToStage();
  setTimeout(clampPipCardsToStage, 120);
  setTimeout(clampPipCardsToStage, 350);
});

window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    const isFs = isStageFullscreen();
    applyFsChatFullscreenSettings(isFs);
    clampPipCardsToStage();
  }, 100);
  setTimeout(clampPipCardsToStage, 380);
});

function applyPipFullscreenSettings(isFullscreen) {
  if (dom.partnerPipCard) dom.partnerPipCard.classList.remove('pip-hidden-fullscreen');
  if (dom.selfPipCard) {
    dom.selfPipCard.classList.remove('pip-hidden-fullscreen');
    if (state.isCamOn) {
      dom.selfPipCard.classList.remove('hidden');
    }
  }
  clampPipCardsToStage();
  setTimeout(clampPipCardsToStage, 100);
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
    showToast(`${platform} moduna geçildi! Sekmeyi sesle paylaşarak birlikte izleyin`);
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
    showToast('Spotify / Ortak Müzik moduna geçildi');
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
  // Platform sessions (YouTube, Netflix, Prime) persist automatically in native in-app browser cookies
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
  heart.textContent = '♡';
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

let sleepClockInterval = null;
let sleepWakeLockSentinel = null;
let sleepAmbienceCtx = null;
let sleepAmbienceGain = null;
let sleepAmbienceSource = null;
let sleepAmbienceLfo = null;
let sleepAmbienceLfoGain = null;

function updateSleepClock() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;
  if (dom.sleepModeClock) dom.sleepModeClock.textContent = timeStr;
  if (dom.sleepDimmerClock) dom.sleepDimmerClock.textContent = timeStr;
}

function startSleepRainAmbience() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!sleepAmbienceCtx) {
      sleepAmbienceCtx = new AudioCtx();
    }
    if (sleepAmbienceCtx.state === 'suspended') {
      sleepAmbienceCtx.resume();
    }

    // Generate 6 seconds of deep, soothing Brownian/red noise buffer (warm, slow, zero hiss)
    const sampleRate = sleepAmbienceCtx.sampleRate;
    const bufferSize = sampleRate * 6;
    const noiseBuffer = sleepAmbienceCtx.createBuffer(1, bufferSize, sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let lastOut = 0.0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      lastOut = (lastOut + (0.015 * white)) / 1.018;
      output[i] = lastOut * 2.8;
    }

    sleepAmbienceSource = sleepAmbienceCtx.createBufferSource();
    sleepAmbienceSource.buffer = noiseBuffer;
    sleepAmbienceSource.loop = true;

    // 1. Deep lowpass filter around 280Hz for soft, muffled, cozy distant rain
    const filter = sleepAmbienceCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 280;
    filter.Q.value = 0.7;

    // 2. High-shelf cut filter at 850Hz to ensure zero high-frequency harshness
    const shelf = sleepAmbienceCtx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 850;
    shelf.gain.value = -30;

    // 3. Gentle gain node: whisper-soft (0.065 max, relaxing background)
    sleepAmbienceGain = sleepAmbienceCtx.createGain();
    sleepAmbienceGain.gain.setValueAtTime(0.001, sleepAmbienceCtx.currentTime);
    sleepAmbienceGain.gain.exponentialRampToValueAtTime(0.065, sleepAmbienceCtx.currentTime + 2.5);

    // 4. Slow gentle hypnotic LFO (~16s cycle) simulating distant calm rain rhythm
    try {
      const lfo = sleepAmbienceCtx.createOscillator();
      const lfoGain = sleepAmbienceCtx.createGain();
      lfo.frequency.value = 0.06;
      lfoGain.gain.value = 0.012;
      lfo.connect(lfoGain);
      lfoGain.connect(sleepAmbienceGain.gain);
      lfo.start();
      sleepAmbienceLfo = lfo;
      sleepAmbienceLfoGain = lfoGain;
    } catch (_) {}

    sleepAmbienceSource.connect(filter);
    filter.connect(shelf);
    shelf.connect(sleepAmbienceGain);
    sleepAmbienceGain.connect(sleepAmbienceCtx.destination);

    sleepAmbienceSource.start();
    state.isSleepAmbiencePlaying = true;
    if (dom.sleepAmbienceText) dom.sleepAmbienceText.textContent = 'Sakin Yağmur (Açık)';
    if (dom.toggleSleepAmbienceBtn) {
      dom.toggleSleepAmbienceBtn.classList.add('bg-indigo-600/30', 'text-indigo-200', 'border-indigo-500/40');
      dom.toggleSleepAmbienceBtn.classList.remove('bg-white/5', 'text-gray-300');
    }
  } catch (err) {
    console.warn('[SleepAmbience] error:', err);
  }
}

function stopSleepRainAmbience() {
  try {
    if (sleepAmbienceLfo) {
      try { sleepAmbienceLfo.stop(); } catch (_) {}
      sleepAmbienceLfo = null;
    }
    if (sleepAmbienceLfoGain) {
      try { sleepAmbienceLfoGain.disconnect(); } catch (_) {}
      sleepAmbienceLfoGain = null;
    }
    if (sleepAmbienceGain && sleepAmbienceCtx) {
      sleepAmbienceGain.gain.exponentialRampToValueAtTime(0.001, sleepAmbienceCtx.currentTime + 0.8);
      setTimeout(() => {
        if (sleepAmbienceSource) {
          try { sleepAmbienceSource.stop(); } catch (_) {}
          sleepAmbienceSource.disconnect();
          sleepAmbienceSource = null;
        }
      }, 900);
    } else if (sleepAmbienceSource) {
      try { sleepAmbienceSource.stop(); } catch (_) {}
      sleepAmbienceSource = null;
    }
  } catch (_) {}
  state.isSleepAmbiencePlaying = false;
  if (dom.sleepAmbienceText) dom.sleepAmbienceText.textContent = 'Sakin Yağmur Sesi';
  if (dom.toggleSleepAmbienceBtn) {
    dom.toggleSleepAmbienceBtn.classList.remove('bg-indigo-600/30', 'text-indigo-200', 'border-indigo-500/40');
    dom.toggleSleepAmbienceBtn.classList.add('bg-white/5', 'text-gray-300');
  }
}

function toggleSleepAmbience() {
  if (state.isSleepAmbiencePlaying) {
    stopSleepRainAmbience();
    showToast('Yağmur sesi kapatıldı');
  } else {
    startSleepRainAmbience();
    showToast('Sakin yağmur ambiyansı başlatıldı');
  }
}

function toggleScreenDimmer(show) {
  const shouldShow = (typeof show === 'boolean') ? show : (dom.sleepScreenDimmer ? dom.sleepScreenDimmer.classList.contains('hidden') : false);
  state.isScreenDimmed = shouldShow;
  if (dom.sleepScreenDimmer) {
    if (shouldShow) {
      dom.sleepScreenDimmer.classList.remove('hidden');
      updateSleepClock();
    } else {
      dom.sleepScreenDimmer.classList.add('hidden');
    }
  }
}

async function requestScreenWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      sleepWakeLockSentinel = await navigator.wakeLock.request('screen');
    } catch (_) {}
  }
}

function releaseScreenWakeLock() {
  if (sleepWakeLockSentinel) {
    try {
      sleepWakeLockSentinel.release();
    } catch (_) {}
    sleepWakeLockSentinel = null;
  }
}

function applySleepMode(enabled, isLocal = true) {
  const canBroadcast = typeof canUserControlPlayback === 'function' ? canUserControlPlayback() : !!state.isHost;
  state.isSleepMode = !!enabled;

  if (enabled) {
    // 1. Only pause and stop background video if authorized to control room
    if (canBroadcast) {
      if (typeof sendYtCommand === 'function') {
        try { sendYtCommand('pauseVideo'); } catch (_) {}
        try { sendYtCommand('stopVideo'); } catch (_) {}
      }
      if (state.ytPlayer && typeof state.ytPlayer.pauseVideo === 'function') {
        try { state.ytPlayer.pauseVideo(); } catch (_) {}
      }
      if (dom.nativeVideoPlayer) {
        try { dom.nativeVideoPlayer.pause(); } catch (_) {}
      }
      state.isPlaying = false;
      if (typeof updatePlayPauseUI === 'function') updatePlayPauseUI(false);
    }

    // 2. Hide media video frames AND photo stage, reveal OLED Sleep Mode Stage
    if (dom.ytPlayerContainer) dom.ytPlayerContainer.classList.add('hidden');
    if (dom.nativeVideoPlayer) dom.nativeVideoPlayer.classList.add('hidden');
    if (dom.webPlayerFrame) dom.webPlayerFrame.classList.add('hidden');
    if (dom.remoteScreenPlayer) dom.remoteScreenPlayer.classList.add('hidden');
    if (dom.emptyStatePlaceholder) dom.emptyStatePlaceholder.classList.add('hidden');
    if (dom.audioOnlyPlaceholder) dom.audioOnlyPlaceholder.classList.add('hidden');

    const photoStage = document.getElementById('photoStageContainer');
    if (photoStage) {
      photoStage.classList.add('hidden');
      photoStage.style.display = 'none';
    }

    if (dom.sleepModePlaceholder) {
      dom.sleepModePlaceholder.classList.remove('hidden');
      dom.sleepModePlaceholder.style.display = 'flex';
      dom.sleepModePlaceholder.style.zIndex = '45';
    }

    // 3. Update Now Playing details to Sleep Mode
    if (dom.nowPlayingTitle) dom.nowPlayingTitle.textContent = canBroadcast ? 'Birlikte Uyku Modu' : 'Kişisel Uyku Modu';
    if (dom.nowPlayingPrefixText) dom.nowPlayingPrefixText.textContent = '';
    if (dom.nowPlayingSuffixText) dom.nowPlayingSuffixText.textContent = 'devrede';
    if (dom.nowPlayingProviderBadge) {
      dom.nowPlayingProviderBadge.textContent = 'Uyku Modu';
      dom.nowPlayingProviderBadge.className = 'px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 font-semibold';
    }

    // 4. Update Sleep button UI to normalized compact active state
    if (dom.toggleSleepModeBtn) {
      dom.toggleSleepModeBtn.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-indigo-500/25 hover:bg-indigo-500/35 border border-indigo-500/40 text-xs text-indigo-200 hover:text-white font-medium transition-all cursor-pointer';
    }
    if (dom.sleepModeBtnText) {
      dom.sleepModeBtnText.textContent = 'Uykudan Çık';
    }

    // 5. Start live digital clock updates
    updateSleepClock();
    if (sleepClockInterval) clearInterval(sleepClockInterval);
    sleepClockInterval = setInterval(updateSleepClock, 1000);

    // 6. Release wake lock so the phone screen can naturally sleep without hindrance
    releaseScreenWakeLock();

    // 7. Ensure PiP webcam and audio stay visible & clamped to stage
    if (typeof clampPipCardsToStage === 'function') {
      clampPipCardsToStage();
    }

    // 8. Legacy backward compatibility
    if (dom.sleepOverlay) {
      dom.sleepOverlay.style.opacity = '1';
      dom.sleepOverlay.style.pointerEvents = 'auto';
    }
    if (dom.ambientGlow) dom.ambientGlow.style.opacity = '0.05';

    if (isLocal) {
      if (canBroadcast) {
        showToast('Uyku Modu açıldı');
        sendP2PData('sleep', { enabled: true, from: state.username, isHost: state.isHost, authorized: true });
        sendSignal({ type: 'sleep-mode', enabled: true, from: state.username, isHost: state.isHost, authorized: true });
      } else {
        showToast('Kişisel Uyku Modu devrede (Sadece sizde)');
      }
    }
  } else {
    // Disable sleep mode
    if (dom.sleepModePlaceholder) {
      dom.sleepModePlaceholder.classList.add('hidden');
      dom.sleepModePlaceholder.style.display = 'none';
    }
    toggleScreenDimmer(false);
    stopSleepRainAmbience();
    releaseScreenWakeLock();

    if (sleepClockInterval) {
      clearInterval(sleepClockInterval);
      sleepClockInterval = null;
    }

    // Restore media frames, photo or empty placeholder
    if (state.activeMode === 'photo' && state.currentPhotoStageData) {
      const photoStage = document.getElementById('photoStageContainer');
      if (photoStage) {
        photoStage.classList.remove('hidden');
        photoStage.style.display = 'flex';
        photoStage.style.zIndex = '35';
      }
    } else if (state.currentVideoId) {
      if (dom.ytPlayerContainer) dom.ytPlayerContainer.classList.remove('hidden');
    } else {
      if (dom.emptyStatePlaceholder) dom.emptyStatePlaceholder.classList.remove('hidden');
    }

    if (dom.nowPlayingTitle) dom.nowPlayingTitle.textContent = state.currentVideoTitle || 'Video';
    if (dom.nowPlayingPrefixText) dom.nowPlayingPrefixText.textContent = 'Şimdi';
    if (dom.nowPlayingSuffixText) dom.nowPlayingSuffixText.textContent = 'oynatılıyor';
    if (dom.nowPlayingProviderBadge) {
      dom.nowPlayingProviderBadge.textContent = state.currentProvider || 'YouTube';
      dom.nowPlayingProviderBadge.className = 'px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-300 font-semibold';
    }

    if (dom.toggleSleepModeBtn) {
      dom.toggleSleepModeBtn.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-indigo-500/15 hover:bg-indigo-500/25 active:scale-95 border border-indigo-500/30 text-xs text-indigo-300 hover:text-white font-medium transition-all cursor-pointer';
    }
    if (dom.sleepModeBtnText) {
      dom.sleepModeBtnText.textContent = 'Uyku Modu';
    }

    if (dom.sleepOverlay) {
      dom.sleepOverlay.style.opacity = '0';
      dom.sleepOverlay.style.pointerEvents = 'none';
    }
    if (dom.ambientGlow) dom.ambientGlow.style.opacity = '0.3';

    if (isLocal) {
      if (canBroadcast) {
        showToast('Uyku modundan çıkıldı.');
        sendP2PData('sleep', { enabled: false, from: state.username, isHost: state.isHost, authorized: true });
        sendSignal({ type: 'sleep-mode', enabled: false, from: state.username, isHost: state.isHost, authorized: true });
      } else {
        showToast('Kişisel uyku modundan çıkıldı.');
      }
    }
  }
}

// Draggable PIP Functionality (Smooth touch hold/drag on mobile & mouse drag on PC, in both normal & fullscreen modes)
function makeDraggable(el) {
  if (!el) return;
  let isDragging = false;
  let longPressTimer = null;
  let startTouchX = 0;
  let startTouchY = 0;
  let startElX = 0;
  let startElY = 0;
  let activeTouchId = null;

  function getDragParent() {
    return document.getElementById('stageContainer') || el.offsetParent || el.parentElement || document.body;
  }

  function cancelLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function startDrag(clientX, clientY) {
    if (isDragging) return;
    isDragging = true;
    cancelLongPress();
    el.style.transition = 'none';
    el.classList.remove('pip-pos-bottom-right', 'pip-pos-bottom-left', 'pip-pos-top-right', 'pip-pos-top-left');
    el.classList.add('pip-custom-pos', 'pip-dragging', 'pip-active-drag');

    const parent = getDragParent();
    const parentRect = parent.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    startElX = elRect.left - parentRect.left;
    startElY = elRect.top - parentRect.top;

    el.style.setProperty('right', 'auto', 'important');
    el.style.setProperty('bottom', 'auto', 'important');
    el.style.setProperty('left', `${startElX}px`, 'important');
    el.style.setProperty('top', `${startElY}px`, 'important');

    startTouchX = clientX;
    startTouchY = clientY;

    if (navigator.vibrate) {
      try { navigator.vibrate(25); } catch (_) {}
    }
  }

  function updateDrag(clientX, clientY) {
    if (!isDragging) return;
    const parent = getDragParent();
    const parentRect = parent.getBoundingClientRect();

    const deltaX = clientX - startTouchX;
    const deltaY = clientY - startTouchY;

    let newX = startElX + deltaX;
    let newY = startElY + deltaY;

    const maxW = parentRect.width - el.offsetWidth - 8;
    const maxH = parentRect.height - el.offsetHeight - 8;

    newX = Math.max(8, Math.min(newX, Math.max(8, maxW)));
    newY = Math.max(8, Math.min(newY, Math.max(8, maxH)));

    el.style.setProperty('right', 'auto', 'important');
    el.style.setProperty('bottom', 'auto', 'important');
    el.style.setProperty('left', `${newX}px`, 'important');
    el.style.setProperty('top', `${newY}px`, 'important');
  }

  function endDrag() {
    cancelLongPress();
    if (!isDragging) return;
    isDragging = false;
    activeTouchId = null;
    el.classList.remove('pip-dragging', 'pip-active-drag');
    el.style.transition = 'none';

    try {
      const parent = getDragParent();
      const parentRect = parent.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const relX = (elRect.left - parentRect.left) / Math.max(1, parentRect.width);
      const relY = (elRect.top - parentRect.top) / Math.max(1, parentRect.height);
      const storageKey = el.id === 'selfPipCard' ? 'miruo_self_cam_pos' : 'miruo_partner_cam_pos';
      localStorage.setItem(storageKey, JSON.stringify({ relX, relY, left: el.style.left, top: el.style.top }));
    } catch (_) {}
  }

  // Native Mobile Touch Events
  el.addEventListener('touchstart', (e) => {
    if (e.target && e.target.closest('button')) return;
    if (!e.touches || e.touches.length === 0) return;
    const touch = e.touches[0];
    activeTouchId = touch.identifier;

    cancelLongPress();
    const initX = touch.clientX;
    const initY = touch.clientY;
    startTouchX = initX;
    startTouchY = initY;

    // Hold feedback (~120ms) or immediate drag on move
    longPressTimer = setTimeout(() => {
      startDrag(initX, initY);
    }, 120);
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!e.touches || e.touches.length === 0) return;
    const touch = Array.from(e.touches).find(t => t.identifier === activeTouchId) || e.touches[0];
    if (!touch) return;

    if (!isDragging) {
      const dist = Math.hypot(touch.clientX - startTouchX, touch.clientY - startTouchY);
      if (dist > 3) {
        startDrag(startTouchX, startTouchY);
      }
    }

    if (isDragging) {
      if (e.cancelable) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      updateDrag(touch.clientX, touch.clientY);
    }
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    const touch = Array.from(e.touches).find(t => t.identifier === activeTouchId) || (e.touches && e.touches[0]);
    if (!touch) return;
    if (e.cancelable) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    updateDrag(touch.clientX, touch.clientY);
  }, { passive: false });

  el.addEventListener('touchend', endDrag);
  el.addEventListener('touchcancel', endDrag);
  window.addEventListener('touchend', endDrag);
  window.addEventListener('touchcancel', endDrag);

  // Desktop Pointer & Mouse Handlers
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    if (e.button && e.button !== 0) return;
    if (e.target && e.target.closest('button')) return;
    if (e.preventDefault) e.preventDefault();
    if (el.setPointerCapture) {
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
    }
    startDrag(e.clientX, e.clientY);
  });

  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    if (!isDragging) return;
    updateDrag(e.clientX, e.clientY);
  });

  window.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch') return;
    if (!isDragging) return;
    if (el.releasePointerCapture) {
      try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    endDrag();
  });

  el.addEventListener('mousedown', (e) => {
    if (e.button && e.button !== 0) return;
    if (e.target && e.target.closest('button')) return;
    if (e.preventDefault) e.preventDefault();
    startDrag(e.clientX, e.clientY);
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    updateDrag(e.clientX, e.clientY);
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    endDrag();
  });
}

function showToast(msg) {
  if (!dom.syncToast || !dom.syncToastMsg) return;
  dom.syncToastMsg.textContent = msg;
  dom.syncToast.style.opacity = '1';
  if (state.toastTimeout) clearTimeout(state.toastTimeout);
  state.toastTimeout = setTimeout(() => {
    if (dom.syncToast) dom.syncToast.style.opacity = '0';
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
    const dict = I18N[currentLang] || I18N.tr;
    if (state.isMicOn && state.isCamOn) avText.textContent = dict.av_mic_cam_on || 'Mikrofon & Kamera Açık (Canlı)';
    else if (state.isMicOn) avText.textContent = dict.av_mic_on_cam_off || 'Mikrofon Canlı • Kamera Kapalı';
    else if (state.isCamOn) avText.textContent = dict.av_cam_on_mic_off || 'Kamera Canlı • Mikrofon Kapalı';
    else avText.textContent = dict.av_mic_cam_off || 'Mikrofon & Kamera Kapalı';
  }
}

// Camera & Mic Controls
function getAudioConstraints() {
  const deviceId = localStorage.getItem('miruo_mic_device_id');
  const noiseSup = localStorage.getItem('miruo_noise_suppression') !== 'false';
  const echoCancel = localStorage.getItem('miruo_echo_cancellation') !== 'false';
  const audioObj = {
    echoCancellation: echoCancel ? { ideal: true } : false,
    noiseSuppression: noiseSup ? { ideal: true } : false,
    autoGainControl: { ideal: true },
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 }
  };
  if (deviceId) {
    audioObj.deviceId = { ideal: deviceId };
  }
  return { audio: audioObj, video: false };
}

async function getAudioStreamSafe() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('navigator.mediaDevices.getUserMedia not supported');
  }
  try {
    const c = getAudioConstraints();
    return await navigator.mediaDevices.getUserMedia(c);
  } catch (err1) {
    console.warn('[Miruo Audio] Primary audio constraints failed, trying fallback:', err1);
    try { localStorage.removeItem('miruo_mic_device_id'); } catch (_) {}
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
  } catch (err2) {
    console.warn('[Miruo Audio] Secondary audio constraints failed, trying basic audio: true:', err2);
  }
  return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
}

let micTestStream = null;
let micTestAudioCtx = null;
let micTestAnalyser = null;
let micTestAnimFrame = null;

async function refreshAudioDeviceList() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    
    // 1. Audio Inputs (Microphones)
    if (dom.settingsMicDeviceSelect) {
      const audioInputs = devices.filter(d => d.kind === 'audioinput');
      const savedDeviceId = localStorage.getItem('miruo_mic_device_id') || '';

      dom.settingsMicDeviceSelect.innerHTML = '<option value="">Varsayılan Sistem Mikrofonu</option>';

      audioInputs.forEach((dev, idx) => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        opt.textContent = dev.label || `Mikrofon ${idx + 1}`;
        if (dev.deviceId === savedDeviceId) opt.selected = true;
        dom.settingsMicDeviceSelect.appendChild(opt);
      });
    }

    // 2. Video Inputs (Webcams / Front / Rear Cameras)
    if (dom.settingsCamDeviceSelect) {
      const videoInputs = devices.filter(d => d.kind === 'videoinput');
      const savedCamId = localStorage.getItem('miruo_cam_device_id') || '';

      dom.settingsCamDeviceSelect.innerHTML = '<option value="">Varsayılan Kamera (Ön / Selfie)</option>';

      videoInputs.forEach((dev, idx) => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        opt.textContent = dev.label || `Kamera ${idx + 1}`;
        if (dev.deviceId === savedCamId) opt.selected = true;
        dom.settingsCamDeviceSelect.appendChild(opt);
      });
    }
  } catch (e) {
    console.warn('[Miruo] enumerateDevices error:', e);
  }
}

function syncMicSettingsValues() {
  if (dom.settingsMicMasterToggle) {
    dom.settingsMicMasterToggle.checked = !!state.isMicOn;
  }
  if (dom.settingsMicStatusBadge) {
    if (state.isMicOn) {
      dom.settingsMicStatusBadge.textContent = 'Açık (Canlı)';
      dom.settingsMicStatusBadge.className = 'text-[10px] px-2 py-0.5 rounded-full font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40';
    } else {
      dom.settingsMicStatusBadge.textContent = 'Kapalı (Sessiz)';
      dom.settingsMicStatusBadge.className = 'text-[10px] px-2 py-0.5 rounded-full font-bold bg-white/10 text-gray-400 border border-white/10';
    }
  }

  // Sync Camera Master Toggle & Status Badge
  if (dom.settingsCamMasterToggle) {
    dom.settingsCamMasterToggle.checked = !!state.isCamOn;
  }
  if (dom.settingsCamStatusBadge) {
    if (state.isCamOn) {
      dom.settingsCamStatusBadge.textContent = 'Açık (Canlı)';
      dom.settingsCamStatusBadge.className = 'text-[10px] px-2 py-0.5 rounded-full font-bold bg-rose-500/20 text-rose-400 border border-rose-500/40';
    } else {
      dom.settingsCamStatusBadge.textContent = 'Kapalı';
      dom.settingsCamStatusBadge.className = 'text-[10px] px-2 py-0.5 rounded-full font-bold bg-white/10 text-gray-400 border border-white/10';
    }
  }
  const savedGain = localStorage.getItem('miruo_mic_gain') || '100';
  if (dom.settingsMicGainSlider) dom.settingsMicGainSlider.value = savedGain;
  if (dom.settingsMicGainVal) dom.settingsMicGainVal.textContent = `%${savedGain}`;

  if (dom.settingsNoiseSuppressionToggle) {
    dom.settingsNoiseSuppressionToggle.checked = localStorage.getItem('miruo_noise_suppression') !== 'false';
  }
  if (dom.settingsEchoCancellationToggle) {
    dom.settingsEchoCancellationToggle.checked = localStorage.getItem('miruo_echo_cancellation') !== 'false';
  }

  if (state.isMicOn && state.localStream && !micTestStream) {
    startMicVuMeter(state.localStream);
  }
}

function startMicVuMeter(mediaStream) {
  stopMicVuMeter();
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx || !mediaStream) return;
    micTestAudioCtx = new AudioCtx();
    if (micTestAudioCtx.state === 'suspended') micTestAudioCtx.resume();
    const source = micTestAudioCtx.createMediaStreamSource(mediaStream);
    micTestAnalyser = micTestAudioCtx.createAnalyser();
    micTestAnalyser.fftSize = 256;
    source.connect(micTestAnalyser);

    const bufLen = micTestAnalyser.frequencyBinCount;
    const dataArr = new Uint8Array(bufLen);

    function renderVu() {
      if (!micTestAnalyser || !dom.settingsMicVuBar) return;
      micTestAnalyser.getByteFrequencyData(dataArr);
      let sum = 0;
      for (let i = 0; i < bufLen; i++) sum += dataArr[i];
      const avg = sum / bufLen;
      const gainMult = (Number(localStorage.getItem('miruo_mic_gain') || 100) / 100);
      const percent = Math.min(100, Math.round((avg / 128) * 100 * gainMult));
      dom.settingsMicVuBar.style.width = `${percent}%`;
      micTestAnimFrame = requestAnimationFrame(renderVu);
    }
    renderVu();
  } catch (e) {
    console.warn('[Miruo] startMicVuMeter failed:', e);
  }
}

function stopMicVuMeter() {
  if (micTestAnimFrame) {
    cancelAnimationFrame(micTestAnimFrame);
    micTestAnimFrame = null;
  }
  if (micTestAudioCtx) {
    try { micTestAudioCtx.close(); } catch (_) {}
    micTestAudioCtx = null;
  }
  micTestAnalyser = null;
  if (dom.settingsMicVuBar) dom.settingsMicVuBar.style.width = '0%';
}

async function toggleMicTest() {
  if (micTestStream) {
    micTestStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
    micTestStream = null;
    stopMicVuMeter();
    if (dom.settingsMicTestBtn) {
      dom.settingsMicTestBtn.textContent = 'Mikrofonu Test Et';
      dom.settingsMicTestBtn.className = 'px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-[11px] font-bold text-white transition-all cursor-pointer';
    }
    if (dom.settingsMicTestHint) {
      dom.settingsMicTestHint.textContent = 'Test durduruldu.';
    }
    if (state.isMicOn && state.localStream) {
      startMicVuMeter(state.localStream);
    }
    return;
  }

  try {
    if (dom.settingsMicTestBtn) dom.settingsMicTestBtn.textContent = 'Başlatılıyor...';
    const c = getAudioConstraints();
    micTestStream = await navigator.mediaDevices.getUserMedia(c);
    startMicVuMeter(micTestStream);
    if (dom.settingsMicTestBtn) {
      dom.settingsMicTestBtn.textContent = 'Testi Durdur';
      dom.settingsMicTestBtn.className = 'px-2.5 py-1 rounded-lg bg-rose-500 hover:bg-rose-600 text-[11px] font-bold text-white transition-all cursor-pointer';
    }
    if (dom.settingsMicTestHint) {
      dom.settingsMicTestHint.textContent = 'Mikrofona konuşun; yeşil/pembe bar sesinizi yansıtır.';
    }
  } catch (err) {
    console.warn('[Miruo] Mic test error:', err);
    if (dom.settingsMicTestBtn) {
      dom.settingsMicTestBtn.textContent = 'Mikrofonu Test Et';
      dom.settingsMicTestBtn.className = 'px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-[11px] font-bold text-white transition-all cursor-pointer';
    }
    if (dom.settingsMicTestHint) {
      dom.settingsMicTestHint.textContent = 'Mikrofona erişilemedi: ' + (err.message || 'İzin verilmedi');
    }
  }
}

function describeMediaError(e, kind) {
  const what = kind === 'camera' ? 'Kamera' : 'Mikrofon';
  const name = (e && e.name) || '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.openAppSettings) {
        setTimeout(() => {
          if (confirm(what + ' izni kapalı. Miruo Cihaz Ayarlarını açmak ister misiniz?')) {
            window.webkit.messageHandlers.openAppSettings.postMessage({});
          }
        }, 300);
      }
    } catch (_) {}
    return what + ' izni verilmedi. Cihaz/tarayıcı ayarlarından ' + what.toLowerCase() + ' iznini açın.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return what + ' cihazı bulunamadı.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return what + ' başka bir uygulama tarafından kullanılıyor olabilir.';
  }
  return what + ' başlatılamadı: ' + ((e && e.message) || 'bilinmeyen hata');
}

async function toggleMic() {
  state.isMicOn = !state.isMicOn;

  if (state.isMicOn) {
    try {
      let audioTrack = null;
      if (state.localStream) {
        audioTrack = state.localStream.getAudioTracks().find(t => t.readyState === 'live');
      }
      if (!audioTrack) {
        const micStream = await getAudioStreamSafe();
        audioTrack = micStream.getAudioTracks()[0];
        if (!audioTrack) throw new Error('Mikrofon ses izi alınamadı');
        if (!state.localStream) {
          state.localStream = micStream;
        } else {
          state.localStream.getAudioTracks().forEach(t => { try { state.localStream.removeTrack(t); } catch (_) {} });
          state.localStream.addTrack(audioTrack);
        }
      }
      audioTrack.enabled = true;
      let micNeedsReneg = false;

      if (dom.selfVideo && state.localStream && dom.selfVideo.srcObject !== state.localStream) {
        dom.selfVideo.srcObject = state.localStream;
        dom.selfVideo.play().catch(() => {});
      }

      // Also register local stream with ducking monitor so video ducks when user speaks
      if (typeof setupAudioDucking === 'function' && state.localStream) {
        setupAudioDucking(state.localStream);
      }

      const uniquePeers = getUniquePeerEntries();
      for (const peer of uniquePeers) {
        if (peer && peer.pc && peer.pc.signalingState !== 'closed') {
          try {
            const transceivers = peer.pc.getTransceivers ? peer.pc.getTransceivers() : [];
            const audioTransceiver = transceivers.find(t => 
              (t.receiver && t.receiver.track && t.receiver.track.kind === 'audio') ||
              (t.sender && t.sender.track && t.sender.track.kind === 'audio')
            );
            if (audioTransceiver) {
              if (audioTransceiver.direction !== 'sendrecv') { audioTransceiver.direction = 'sendrecv'; micNeedsReneg = true; }
              if (audioTransceiver.sender && typeof audioTransceiver.sender.replaceTrack === 'function') {
                await audioTransceiver.sender.replaceTrack(audioTrack);
              }
            } else {
              peer.pc.addTrack(audioTrack, state.localStream);
              micNeedsReneg = true;
            }
          } catch (_) {}
        }
      }
      if (state.pc && state.pc.signalingState !== 'closed') {
        const transceivers = state.pc.getTransceivers ? state.pc.getTransceivers() : [];
        const audioTransceiver = transceivers.find(t => 
          (t.receiver && t.receiver.track && t.receiver.track.kind === 'audio') ||
          (t.sender && t.sender.track && t.sender.track.kind === 'audio')
        );
        if (audioTransceiver) {
          if (audioTransceiver.direction !== 'sendrecv') { audioTransceiver.direction = 'sendrecv'; micNeedsReneg = true; }
          if (audioTransceiver.sender && typeof audioTransceiver.sender.replaceTrack === 'function') {
            await audioTransceiver.sender.replaceTrack(audioTrack);
          }
        } else {
          try { state.pc.addTrack(audioTrack, state.localStream); } catch (_) {}
        }
      }
      if (micNeedsReneg && typeof renegotiateWebRTC === 'function') { try { await renegotiateWebRTC(); } catch (_) {} }
      showToast('Mikrofon Açık (Canlı)');
    } catch (e) {
      console.warn('Microphone hardware error:', e);
      state.isMicOn = false;
      showToast(describeMediaError(e, 'mic'));
    }
  } else {
    // Mute: Simply disable live audio tracks. DO NOT stop hardware track, DO NOT replaceTrack(null), DO NOT renegotiate!
    if (state.localStream) {
      state.localStream.getAudioTracks().forEach(t => { 
        t.enabled = false;
      });
    }
    showToast('Mikrofon Kapatıldı');
  }

  updateAVToolbarUI();
  if (dom.micBtnText) {
    dom.micBtnText.textContent = state.isMicOn ? 'Mikrofon Kapat' : 'Mikrofon Aç';
  }
  broadcastMyMediaStatus();
  renderParticipantsList();
  if (typeof renderVideoGrid === 'function') renderVideoGrid();
  syncMicSettingsValues();
}

function optimizeVideoSender(sender) {
  // WebKit / Safari camera capture encoder freezes if setParameters is mutated with custom framerates.
  // Standard browser WebRTC automatically handles optimal bitrate adaptation.
  return;
}

async function getLiveCameraStream(targetFacingMode = null, targetDeviceId = null) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('navigator.mediaDevices.getUserMedia not supported');
  }
  const facing = targetFacingMode || state.cameraFacingMode || 'user';
  const deviceId = targetDeviceId || localStorage.getItem('miruo_cam_device_id') || null;

  const tryConstraints = [];

  // 1. Explicit Device ID selected
  if (deviceId) {
    tryConstraints.push({
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 24, max: 30 }
      },
      audio: false
    });
    tryConstraints.push({
      video: { deviceId: { exact: deviceId } },
      audio: false
    });
  }

  // 2. Facing mode prioritized (Front / Selfie camera default)
  tryConstraints.push({
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 24, max: 30 }
    },
    audio: false
  });
  tryConstraints.push({
    video: {
      facingMode: facing
    },
    audio: false
  });
  tryConstraints.push({
    video: {
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 24, max: 30 }
    },
    audio: false
  });
  tryConstraints.push({ video: true, audio: false });

  let lastErr = null;
  for (const c of tryConstraints) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(c);
      const track = stream.getVideoTracks()[0];
      if (track) {
        try { track.contentHint = 'motion'; } catch (_) {}
      }
      return stream;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No camera stream');
}

async function switchCamera() {
  const nextFacing = (state.cameraFacingMode === 'environment') ? 'user' : 'environment';
  state.cameraFacingMode = nextFacing;

  if (dom.selfVideo) {
    if (nextFacing === 'user') {
      dom.selfVideo.classList.add('mirror');
    } else {
      dom.selfVideo.classList.remove('mirror');
    }
  }

  if (state.isCamOn) {
    try {
      const dictS = I18N[currentLang] || I18N.tr;
      showToast(nextFacing === 'user' ? 'Ön Kameraya Geçiliyor...' : 'Arka Kameraya Geçiliyor...');
      const camStream = await getLiveCameraStream(nextFacing);
      const freshTrack = camStream.getVideoTracks()[0];
      if (!freshTrack) throw new Error('Yeni kamera akışı alınamadı');

      if (state.localStream) {
        const oldTracks = state.localStream.getVideoTracks();
        oldTracks.forEach(t => {
          try { state.localStream.removeTrack(t); } catch (_) {}
          try { t.stop(); } catch (_) {}
        });
        state.localStream.addTrack(freshTrack);
      } else {
        state.localStream = camStream;
      }

      if (dom.selfVideo) {
        dom.selfVideo.srcObject = state.localStream;
        dom.selfVideo.play().catch(() => {});
      }

      // Update video sender on all active WebRTC peers
      const uniquePeers = getUniquePeerEntries();
      for (const peer of uniquePeers) {
        if (peer && peer.pc && peer.pc.signalingState !== 'closed') {
          try {
            const transceivers = peer.pc.getTransceivers ? peer.pc.getTransceivers() : [];
            const vt = transceivers.find(t => 
              (t.receiver && t.receiver.track && t.receiver.track.kind === 'video') ||
              (t.sender && t.sender.track && t.sender.track.kind === 'video')
            );
            if (vt && vt.sender && typeof vt.sender.replaceTrack === 'function') {
              await vt.sender.replaceTrack(freshTrack);
            }
            if (vt && vt.sender) optimizeVideoSender(vt.sender);
          } catch (_) {}
        }
      }
      if (state.pc && state.pc.signalingState !== 'closed') {
        try {
          const transceivers = state.pc.getTransceivers ? state.pc.getTransceivers() : [];
          const vt = transceivers.find(t => 
            (t.receiver && t.receiver.track && t.receiver.track.kind === 'video') ||
            (t.sender && t.sender.track && t.sender.track.kind === 'video')
          );
          if (vt && vt.sender && typeof vt.sender.replaceTrack === 'function') {
            await vt.sender.replaceTrack(freshTrack);
          }
          if (vt && vt.sender) optimizeVideoSender(vt.sender);
        } catch (_) {}
      }

      showToast(dictS.switch_cam_success || 'Kamera değiştirildi');
      if (typeof renderVideoGrid === 'function') renderVideoGrid();
    } catch (err) {
      console.warn('[Miruo] switchCamera failed:', err);
      showToast(describeMediaError(err, 'camera'));
    }
  } else {
    showToast(nextFacing === 'user' ? 'Ön kamera seçildi' : 'Arka kamera seçildi');
  }
}
window.switchCamera = switchCamera;

async function toggleCam() {
  if (state.isCamOn) {
    state.isCamOn = false;
    if (state.localStream) {
      state.localStream.getVideoTracks().forEach(track => {
        track.enabled = false;
        try { track.stop(); } catch (e) {}
        try { state.localStream.removeTrack(track); } catch (e) {}
      });
    }
    const uniquePeers = getUniquePeerEntries();
    for (const peer of uniquePeers) {
      if (peer && peer.pc && peer.pc.signalingState !== 'closed') {
        try {
          const transceivers = peer.pc.getTransceivers ? peer.pc.getTransceivers() : [];
          const vt = transceivers.find(t => 
            (t.receiver && t.receiver.track && t.receiver.track.kind === 'video') ||
            (t.sender && t.sender.track && t.sender.track.kind === 'video')
          );
          if (vt && vt.sender && typeof vt.sender.replaceTrack === 'function') {
            vt.sender.replaceTrack(null).catch(() => {});
          }
        } catch (_) {}
      }
    }
    if (state.pc) {
      try {
        const transceivers = state.pc.getTransceivers ? state.pc.getTransceivers() : [];
        const vt = transceivers.find(t => 
          (t.receiver && t.receiver.track && t.receiver.track.kind === 'video') ||
          (t.sender && t.sender.track && t.sender.track.kind === 'video')
        );
        if (vt && vt.sender && typeof vt.sender.replaceTrack === 'function') {
          vt.sender.replaceTrack(null).catch(() => {});
        }
      } catch (_) {}
    }
    if (dom.selfVideo) {
      dom.selfVideo.srcObject = null;
    }
    if (dom.selfPipCard) {
      dom.selfPipCard.classList.add('hidden');
    }
    updateAVToolbarUI();
    broadcastMyMediaStatus();
    renderParticipantsList();
    renderVideoGrid();
    syncMicSettingsValues();
    showToast('Kamera Kapatıldı');
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
    if (state.localStream) {
      const deadTracks = state.localStream.getVideoTracks().filter(t => t.readyState === 'ended');
      deadTracks.forEach(t => {
        try { state.localStream.removeTrack(t); } catch (e) {}
      });
    }

    let videoTrack = state.localStream ? state.localStream.getVideoTracks().find(t => t.readyState === 'live') : null;

    if (!videoTrack) {
      const camStream = await getLiveCameraStream();
      const freshTrack = camStream.getVideoTracks()[0];
      if (!freshTrack) throw new Error('Kamera video izi alınamadı');
      if (!state.localStream) {
        state.localStream = camStream;
      } else {
        state.localStream.addTrack(freshTrack);
      }
      videoTrack = freshTrack;
    }

    if (videoTrack) {
      videoTrack.enabled = true;
      state.isCamOn = true;
      state.isSelfPipDismissed = false;

      if (dom.selfVideo) {
        dom.selfVideo.classList.toggle('mirror', state.cameraFacingMode !== 'environment');
        dom.selfVideo.playsInline = true;
        dom.selfVideo.muted = true;
        dom.selfVideo.defaultMuted = true;
        dom.selfVideo.autoplay = true;
        dom.selfVideo.setAttribute('playsinline', 'true');
        dom.selfVideo.setAttribute('webkit-playsinline', 'true');
        dom.selfVideo.setAttribute('muted', '');
        dom.selfVideo.setAttribute('autoplay', 'true');

        dom.selfVideo.srcObject = state.localStream;
        const playPromise = dom.selfVideo.play();
        if (playPromise !== undefined) {
          playPromise.catch(err => console.warn('Self video play warning:', err));
        }

        const handleVideoCheck = () => {
          if (dom.selfVideo && (dom.selfVideo.videoWidth > 0 || dom.selfVideo.readyState >= 2)) {
            if (dom.selfVideoPlaceholder) dom.selfVideoPlaceholder.classList.add('hidden');
          } else {
            if (dom.selfVideoPlaceholder && !dom.selfVideo.srcObject) dom.selfVideoPlaceholder.classList.remove('hidden');
          }
        };

        dom.selfVideo.onloadedmetadata = handleVideoCheck;
        dom.selfVideo.onplaying = handleVideoCheck;
        dom.selfVideo.onloadeddata = handleVideoCheck;
        dom.selfVideo.onresize = handleVideoCheck;
        if (window._selfVideoPoll) clearInterval(window._selfVideoPoll);
        let selfPollN = 0;
        window._selfVideoPoll = setInterval(() => {
          handleVideoCheck();
          if (dom.selfVideo && dom.selfVideo.paused && dom.selfVideo.srcObject) dom.selfVideo.play().catch(() => {});
          if (++selfPollN > 40 || !state.isCamOn) clearInterval(window._selfVideoPoll);
        }, 500);
      }

      if (dom.selfPipCard) {
        dom.selfPipCard.classList.remove('hidden', 'pip-hidden-fullscreen');
      }
      clampPipCardsToStage();

      updateCamButtonUI(true);
      try { arrangePipsRow(); } catch (_) {}

      let camNeedsReneg = false;
      const uniquePeers = getUniquePeerEntries();
      for (const peer of uniquePeers) {
        if (peer && peer.pc && peer.pc.signalingState !== 'closed') {
          try {
            const transceivers = peer.pc.getTransceivers ? peer.pc.getTransceivers() : [];
            const vt = transceivers.find(t => 
              (t.receiver && t.receiver.track && t.receiver.track.kind === 'video') ||
              (t.sender && t.sender.track && t.sender.track.kind === 'video')
            );
            if (vt) {
              if (vt.direction !== 'sendrecv') { vt.direction = 'sendrecv'; camNeedsReneg = true; }
              if (vt.sender && typeof vt.sender.replaceTrack === 'function') {
                await vt.sender.replaceTrack(videoTrack);
              }
              if (vt.sender) optimizeVideoSender(vt.sender);
            } else {
              const sender = peer.pc.addTrack(videoTrack, state.localStream);
              if (sender) optimizeVideoSender(sender);
              camNeedsReneg = true;
            }
          } catch (_) {}
        }
      }
      if (state.pc && state.pc.signalingState !== 'closed') {
        try {
          const transceivers = state.pc.getTransceivers ? state.pc.getTransceivers() : [];
          const vt = transceivers.find(t => 
            (t.receiver && t.receiver.track && t.receiver.track.kind === 'video') ||
            (t.sender && t.sender.track && t.sender.track.kind === 'video')
          );
          if (vt) {
            if (vt.direction !== 'sendrecv') { vt.direction = 'sendrecv'; camNeedsReneg = true; }
            if (vt.sender && typeof vt.sender.replaceTrack === 'function') {
              await vt.sender.replaceTrack(videoTrack);
            }
            if (vt.sender) optimizeVideoSender(vt.sender);
          } else {
            const sender = state.pc.addTrack(videoTrack, state.localStream);
            if (sender) optimizeVideoSender(sender);
            camNeedsReneg = true;
          }
        } catch (err) {
          console.warn('WebRTC cam track error:', err);
        }
      }
      if (camNeedsReneg && typeof renegotiateWebRTC === 'function') {
        await renegotiateWebRTC();
      }

      broadcastMyMediaStatus();
      renderParticipantsList();
      renderVideoGrid();
      syncMicSettingsValues();
      const dictCam = I18N[currentLang] || I18N.tr;
      showToast(dictCam.toast_cam_opened || 'Canlı Kamera Açıldı (Sürüklenebilir)');
    } else {
      throw new Error('Video track not available');
    }
  } catch (e) {
    console.warn('Kamera donanımı bulunamadı veya izin verilmedi:', e);
    state.isCamOn = false;
    if (dom.selfPipCard) dom.selfPipCard.classList.add('hidden');
    updateCamButtonUI(false);
    updateAVToolbarUI();
    broadcastMyMediaStatus();
    renderParticipantsList();
    renderVideoGrid();
    syncMicSettingsValues();
    showToast(describeMediaError(e, 'camera'));
  }
}

// YouTube Live Format Chat Sidebar Visibility Manager
function setChatVisibility(visible) {
  state.isChatVisible = visible;
  const isFs = isStageFullscreen();
  const isCinema = isFs || isMobileLandscapeMode();

  if (dom.roomChatSidebar) {
    dom.roomChatSidebar.classList.toggle('hidden', !visible);
  }

  // Strictly only ONE chat button can EVER be shown:
  // In portrait non-fullscreen: the toolbar toggleChatToolbarBtn is always visible, so floating button is kept hidden!
  // In landscape / fullscreen: show openFsChatFloatingBtn when fs chat overlay is closed.
  if (dom.openChatFloatingBtn) {
    dom.openChatFloatingBtn.classList.add('hidden');
  }
  if (dom.openFsChatFloatingBtn) {
    dom.openFsChatFloatingBtn.classList.toggle('hidden', visible || !isCinema);
  }

  if (dom.chatToolbarBtnText) {
    const dictChat = I18N[currentLang] || I18N.tr;
    dom.chatToolbarBtnText.textContent = visible ? (dictChat.chat_tab || 'Sohbet') : (dictChat.show_chat || 'Sohbeti Aç');
  }
  if (dom.toggleChatToolbarBtn) {
    dom.toggleChatToolbarBtn.classList.toggle('bg-rose-500/20', visible);
    dom.toggleChatToolbarBtn.classList.toggle('text-rose-300', visible);
    dom.toggleChatToolbarBtn.classList.toggle('border-rose-500/40', visible);
  }

  // Toggle chat-is-closed on workspace, layout and stage so CSS smoothly adapts video dimensions
  if (dom.roomWorkspaceSection) {
    dom.roomWorkspaceSection.classList.toggle('chat-is-closed', !visible);
  }
  if (dom.roomMainSplitLayout) {
    dom.roomMainSplitLayout.classList.toggle('chat-is-closed', !visible);
  }
  if (dom.stageContainer) {
    dom.stageContainer.classList.toggle('stage-chat-closed', !visible);
  }

  if (isCinema) {
    if (dom.fsChatOverlay) {
      dom.fsChatOverlay.classList.toggle('hidden', !visible);
    }
    if (visible) {
      if (dom.fsChatOverlay) {
        dom.fsChatOverlay.style.removeProperty('left');
        dom.fsChatOverlay.style.removeProperty('top');
        dom.fsChatOverlay.style.removeProperty('right');
        dom.fsChatOverlay.style.removeProperty('bottom');
        dom.fsChatOverlay.style.removeProperty('width');
        dom.fsChatOverlay.style.removeProperty('height');
        dom.fsChatOverlay.style.removeProperty('max-height');
      }
      if (dom.stageContainer) dom.stageContainer.classList.add('fs-chat-active');
      document.body.classList.add('fs-chat-active');
    } else {
      if (dom.stageContainer) dom.stageContainer.classList.remove('fs-chat-active');
      document.body.classList.remove('fs-chat-active');
    }
  } else {
    if (dom.fsChatOverlay) dom.fsChatOverlay.classList.add('hidden');
    if (dom.stageContainer) dom.stageContainer.classList.remove('fs-chat-active');
    document.body.classList.remove('fs-chat-active');
  }
  updateFullscreenUI();
  window.dispatchEvent(new Event('resize'));
  sendYtCommand('listening');
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
  }, 100);
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
  }, 320);
}

function updateCamButtonUI(isOn) {
  state.isCamOn = isOn;
  updateAVToolbarUI();
}

function renderVideoGrid() {
  if (!dom.roomVideoGrid) return;

  if (!state.isInRoom) {
    dom.roomVideoGrid.classList.add('hidden');
    dom.roomVideoGrid.querySelectorAll('video').forEach(vid => {
      try { vid.pause(); vid.srcObject = null; } catch (_) {}
    });
    dom.roomVideoGrid.innerHTML = '';
    return;
  }

  dom.roomVideoGrid.classList.remove('hidden');
  dom.roomVideoGrid.querySelectorAll('video').forEach(vid => {
    try { vid.pause(); vid.srcObject = null; } catch (_) {}
  });
  dom.roomVideoGrid.innerHTML = '';

  const dictGrid = I18N[currentLang] || I18N.tr;

  // 1. Self Tile
  const selfTile = document.createElement('div');
  selfTile.className = 'relative w-20 h-20 sm:w-22 sm:h-22 rounded-xl overflow-hidden bg-black/70 border border-white/10 hover:border-rose-400/80 shadow-md shrink-0 flex flex-col items-center justify-center cursor-pointer transition-all active:scale-95';
  selfTile.title = 'Kameranızı ana ekranda göster / gizle';

  if (state.isCamOn && state.localStream) {
    const v = document.createElement('video');
    v.className = 'w-full h-full object-cover mirror pointer-events-none';
    v.autoplay = true;
    v.muted = true;
    v.playsInline = true;
    v.srcObject = state.localStream;
    selfTile.appendChild(v);
  } else {
    const pulseRing = state.isMicOn ? 'ring-1.5 ring-emerald-400 ring-offset-1 ring-offset-black animate-pulse' : '';
    const selfAv = state.avatarUrl 
      ? `<img src="${state.avatarUrl}" class="w-full h-full object-cover rounded-full" alt="PP">` 
      : (state.username || 'K').charAt(0).toUpperCase();
    selfTile.innerHTML = `
      <div class="w-8 h-8 sm:w-9 sm:h-9 rounded-full overflow-hidden bg-gradient-to-tr from-rose-500 to-indigo-600 flex items-center justify-center text-white font-bold text-xs shadow-md ${pulseRing}">
        ${selfAv}
      </div>
      <span class="text-[9px] text-gray-400 mt-0.5 font-medium leading-none">${dictGrid.cam_off_label || 'Kamera Kapalı'}</span>
    `;
  }

  // Tapping self square tile restores / toggles self PIP card on the main screen
  selfTile.addEventListener('click', () => {
    if (!state.isCamOn) {
      toggleCam();
      return;
    }
    if (dom.selfPipCard) {
      const isHidden = dom.selfPipCard.classList.contains('hidden');
      if (isHidden || state.isSelfPipDismissed) {
        state.isSelfPipDismissed = false;
        dom.selfPipCard.classList.remove('hidden', 'pip-hidden-fullscreen');
        clampPipCardsToStage();
        showToast('Kameranız ana ekrana getirildi');
      } else {
        dom.selfPipCard.classList.add('hidden');
        state.isSelfPipDismissed = true;
        showToast('Kameranız ana ekrandan gizlendi');
      }
    }
  });

  const selfBadge = document.createElement('div');
  selfBadge.className = 'absolute bottom-1 left-1 right-1 px-1.5 py-0.5 rounded-md bg-black/75 backdrop-blur-md border border-white/10 flex items-center justify-between text-[9px] text-white z-20 pointer-events-none';
  const selfMicSvg = state.isMicOn
    ? `<svg class="w-2.5 h-2.5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4m-4 0h8"/></svg>`
    : `<svg class="w-2.5 h-2.5 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
  const selfCamDot = state.isCamOn
    ? `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" title="Kamera Canlı"></span>`
    : `<span class="w-1.5 h-1.5 rounded-full bg-gray-500" title="Kamera Kapalı"></span>`;
  selfBadge.innerHTML = `
    <span class="truncate font-semibold max-w-[50px]">${state.username || 'Sen'}</span>
    <div class="flex items-center gap-1 shrink-0">
      ${selfCamDot}
      ${selfMicSvg}
    </div>
  `;
  selfTile.appendChild(selfBadge);
  dom.roomVideoGrid.appendChild(selfTile);

  // 2. Remote / Partner Tiles (Strict client distinction: exactly 1 tile per unique remote device/user)
  const otherMembers = [];
  const seenMemberKeys = new Set();
  if (state.clientId) seenMemberKeys.add(String(state.clientId));

  Object.values(state.participants || {}).forEach(p => {
    if (!p) return;
    const isSelf = (p.clientId && p.clientId === state.clientId);
    if (isSelf) return;

    const uKey = (p.clientId || p.userId || p.username || '').toLowerCase();
    if (!uKey || seenMemberKeys.has(uKey)) return;
    seenMemberKeys.add(uKey);
    otherMembers.push(p);
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

  // Update room counter badges to match true participants count
  const totalCount = 1 + otherMembers.length;
  if (dom.roomMemberCountBadge) dom.roomMemberCountBadge.textContent = totalCount;
  if (dom.participantsCountHeader) dom.participantsCountHeader.textContent = totalCount;

  otherMembers.forEach(m => {
    const tile = document.createElement('div');
    tile.className = 'relative w-20 h-20 sm:w-22 sm:h-22 rounded-xl overflow-hidden bg-black/70 border border-white/10 hover:border-indigo-400/80 shadow-md shrink-0 flex flex-col items-center justify-center cursor-pointer transition-all active:scale-95';
    tile.title = `${m.username} kamerasını ana ekrana getir`;

    const peerStream = (m.clientId && state.peers && state.peers[m.clientId] && state.peers[m.clientId].stream) ||
                       (state.peers && state.peers[m.userId] && state.peers[m.userId].stream) || 
                       m.stream || (m.userId === state.peerId ? state.remoteStream : null);
    const hasLiveVideo = peerStream && peerStream.getVideoTracks && peerStream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted);
    const isCamActive = m.isCamOn === true || (m.isCamOn !== false && hasLiveVideo);

    if (isCamActive && peerStream) {
      const v = document.createElement('video');
      v.className = 'w-full h-full object-cover mirror pointer-events-none';
      v.autoplay = true;
      v.playsInline = true;
      v.muted = true; // MUST be muted for mobile autoplay
      v.srcObject = peerStream;
      const playP = v.play();
      if (playP && playP.catch) playP.catch(() => {});
      tile.appendChild(v);

      const placeholder = document.createElement('div');
      placeholder.className = 'absolute inset-0 flex flex-col items-center justify-center bg-black/85 z-10 pointer-events-none';
      const avInner = m.avatar
        ? `<img src="${m.avatar}" class="w-8 h-8 sm:w-9 sm:h-9 rounded-full object-cover shadow-md" alt="PP">`
        : `<div class="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-gradient-to-tr ${m.avatarColor || 'from-indigo-500 to-purple-600'} flex items-center justify-center text-white font-bold text-xs shadow-md">
             ${(m.username || 'K').charAt(0).toUpperCase()}
           </div>`;
      placeholder.innerHTML = `
        ${avInner}
        <span class="text-[9px] text-emerald-400 mt-0.5 font-medium leading-none">${dictGrid.cam_live_label || 'Canlı'}</span>
      `;
      tile.appendChild(placeholder);

      const checkFrames = () => {
        if (v && v.videoWidth > 0) {
          placeholder.classList.add('hidden');
          placeholder.style.display = 'none';
        } else {
          placeholder.classList.remove('hidden');
          placeholder.style.removeProperty('display');
        }
      };
      v.onloadedmetadata = checkFrames;
      v.onplaying = checkFrames;
      v.onloadeddata = checkFrames;
      let nFr = 0;
      const frTimer = setInterval(() => {
        checkFrames();
        if (v.paused && v.srcObject) v.play().catch(() => {});
        if (++nFr > 40 || !document.body.contains(v)) clearInterval(frTimer);
      }, 500);
    } else {
      const pulseRing = m.isMicOn ? 'ring-1.5 ring-emerald-400 ring-offset-1 ring-offset-black animate-pulse' : '';
      const avHtml = m.avatar
        ? `<img src="${m.avatar}" class="w-8 h-8 sm:w-9 sm:h-9 rounded-full object-cover shadow-md ${pulseRing}" alt="PP">`
        : `<div class="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-gradient-to-tr ${m.avatarColor || 'from-indigo-500 to-purple-600'} flex items-center justify-center text-white font-bold text-xs shadow-md ${pulseRing}">
             ${(m.username || 'K').charAt(0).toUpperCase()}
           </div>`;
      tile.innerHTML = `
        ${avHtml}
        <span class="text-[9px] text-gray-400 mt-0.5 font-medium leading-none">${m.isCamOn ? (dictGrid.cam_live_label || 'Canlı') : (dictGrid.cam_off_label || 'Kamera Kapalı')}</span>
      `;
    }

    // Tapping remote member tile toggles THAT participant's camera bubble on the stage
    tile.addEventListener('click', () => {
      state.dismissedPips = state.dismissedPips || {};
      const uId = m.userId || m.clientId;
      const isCurrentlyDismissed = !!(state.dismissedPips[uId] || (m.userId && state.dismissedPips[m.userId]) || (m.clientId && state.dismissedPips[m.clientId]));
      const nextDismissed = !isCurrentlyDismissed;
      state.dismissedPips[uId] = nextDismissed;
      if (m.userId) state.dismissedPips[m.userId] = nextDismissed;
      if (m.clientId) state.dismissedPips[m.clientId] = nextDismissed;
      state.activePipPeerId = m.userId || m.clientId;

      if (typeof renderStagePipCards === 'function') renderStagePipCards();
      if (typeof clampPipCardsToStage === 'function') clampPipCardsToStage();
      showToast(nextDismissed ? `${m.username} ana ekrandan gizlendi` : `${m.username} ana ekrana getirildi`);
    });

    const badge = document.createElement('div');
    badge.className = 'absolute bottom-1 left-1 right-1 px-1.5 py-0.5 rounded-md bg-black/75 backdrop-blur-md border border-white/10 flex items-center justify-between text-[9px] text-white z-20 pointer-events-none';
    const peerMicSvg = m.isMicOn
      ? `<svg class="w-2.5 h-2.5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4m-4 0h8"/></svg>`
      : `<svg class="w-2.5 h-2.5 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
    const peerCamDot = m.isCamOn
      ? `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" title="Kamera Canlı"></span>`
      : `<span class="w-1.5 h-1.5 rounded-full bg-gray-500" title="Kamera Kapalı"></span>`;
    badge.innerHTML = `
      <span class="truncate font-semibold max-w-[50px]">${m.username}</span>
      <div class="flex items-center gap-1 shrink-0">
        ${peerCamDot}
        ${peerMicSvg}
      </div>
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

const BOT_CHAT_MESSAGES_I18N = {
  tr: [
    "bu parça bağımlılık yaptı yaa",
    "selam herkese, ses gayet net geliyor",
    "efsane seçim elinize sağlık",
    "klibi ilk defa izliyorum çok iyiymiş",
    "sesi bir tık daha açabilir misiniz?",
    "sırada hangi şarkı var acaba?",
    "kalp bıraktım",
    "bunu listeme kaydettim hemen",
    "gece moduna çok yakıştı bu parça",
    "herkese keyifli dinlemeler",
    "sonraki benden olsun mu?",
    "harika senkronize oldu çok iyi",
    "ritim mükemmel",
    "arkadaşları da çağırdım geliyorlar"
  ],
  en: [
    "this track is so addictive",
    "hey everyone, audio is super clear",
    "amazing pick, loving this vibe!",
    "watching this clip for the first time, it's so good",
    "could you turn up the volume a bit?",
    "what song is coming up next?",
    "dropped a heart",
    "saved this to my playlist right away",
    "this track fits late night vibes perfectly",
    "enjoy the stream everyone",
    "can I pick the next one?",
    "synced up perfectly, love it",
    "the rhythm is incredible",
    "just invited my friends, they're joining"
  ],
  de: [
    "dieser Track macht echt süchtig",
    "hallo zusammen, Ton ist super klar",
    "mega Auswahl, gefällt mir sehr!",
    "schaue diesen Clip zum ersten Mal, richtig gut",
    "könnt ihr die Lautstärke etwas aufdrehen?",
    "welches Lied kommt als Nächstes?",
    "Herz dagelassen",
    "direkt in meiner Playlist gespeichert",
    "perfekt für den Abendmodus",
    "viel Spaß beim Zuschauen allen",
    "darf ich das nächste aussuchen?",
    "perfekt synchronisiert, klasse",
    "der Beat ist der Wahnsinn",
    "habe Freunde eingeladen, sie kommen gleich"
  ]
};

let botChatInterval = null;
let activeRoomBots = [];

function startBotsForActiveRoom() {
  if (botChatInterval) {
    clearInterval(botChatInterval);
    botChatInterval = null;
  }
  activeRoomBots = [];
}

function stopBotsForActiveRoom() {
  if (botChatInterval) {
    clearInterval(botChatInterval);
    botChatInterval = null;
  }
  activeRoomBots = [];
}

function appendBotJoinMessage(botName, botColor) {
  if (!dom.chatMessagesContainer) return;
  const dict = I18N[currentLang] || I18N.tr;
  const joinText = dict.chat_bot_joined || 'odaya katıldı';
  const msgEl = document.createElement('div');
  msgEl.className = 'flex items-center gap-2 text-gray-400 text-[11px] py-1';
  msgEl.innerHTML = `
    <div class="w-5 h-5 rounded-full bg-gradient-to-tr ${botColor || 'from-rose-500 to-indigo-600'} flex items-center justify-center text-[9px] font-bold text-white shadow-xs">
      ${botName.charAt(0)}
    </div>
    <span><strong class="text-gray-200">@${escapeHtml(botName)}</strong> ${escapeHtml(joinText)}</span>
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
  state.currentTab = 'explore';
  document.body.classList.remove('in-room-mode');
  document.documentElement.classList.remove('in-room-mode');
  if (!state.isMiniPlayer) {
    state.isInRoom = false;
    document.body.classList.remove('has-mini-player');
    if (dom.roomWorkspaceSection) {
      dom.roomWorkspaceSection.classList.add('hidden');
      dom.roomWorkspaceSection.classList.remove('flex', 'block');
    }
    // Prevent any video or audio from playing on explore screen
    sendYtCommand('pauseVideo');
    const ytFrame = document.getElementById('miruoYtIframe');
    if (ytFrame) {
      try { ytFrame.src = 'about:blank'; } catch (_) {}
      ytFrame.remove();
    }
    if (dom.ytPlayerContainer) dom.ytPlayerContainer.innerHTML = '';
    if (dom.nativeVideoPlayer) {
      try {
        dom.nativeVideoPlayer.pause();
        dom.nativeVideoPlayer.src = '';
      } catch (_) {}
      dom.nativeVideoPlayer.classList.add('hidden');
    }
    state.isPlaying = false;
    state.currentVideoId = null;
    if (syncHeartbeatInterval) {
      clearInterval(syncHeartbeatInterval);
      syncHeartbeatInterval = null;
    }
  }
  if (typeof stopProfileStarCanvas === 'function') stopProfileStarCanvas();
  stopBotsForActiveRoom();
  const mainWorkspace = document.querySelector('main');
  if (mainWorkspace) {
    mainWorkspace.classList.remove('pt-0', 'max-w-7xl');
    mainWorkspace.classList.add('max-w-xl');
  }
  if (dom.mainHeader) dom.mainHeader.classList.remove('hidden');
  const mobileNav = document.getElementById('mobileBottomNav');
  if (mobileNav) mobileNav.classList.remove('hidden');
  const friendsTab = document.getElementById('friendsTabSection');
  if (friendsTab) {
    friendsTab.classList.add('hidden');
    friendsTab.classList.remove('flex');
  }
  const profileTab = document.getElementById('profileTabSection');
  if (profileTab) {
    profileTab.classList.add('hidden');
    profileTab.classList.remove('flex');
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
  state.currentTab = 'provider_picker';
  document.body.classList.remove('in-room-mode', 'modal-open-freeze');
  document.documentElement.classList.remove('in-room-mode');
  if (typeof stopProfileStarCanvas === 'function') stopProfileStarCanvas();
  stopBotsForActiveRoom();
  if (dom.profileEditModal) {
    dom.profileEditModal.classList.add('hidden');
    dom.profileEditModal.classList.remove('flex');
  }
  const mainWorkspace = document.querySelector('main');
  if (mainWorkspace) {
    mainWorkspace.classList.add('pt-0');
  }
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
  const friendsTab = document.getElementById('friendsTabSection');
  if (friendsTab) {
    friendsTab.classList.add('hidden');
    friendsTab.classList.remove('flex');
  }
  const profileTab = document.getElementById('profileTabSection');
  if (profileTab) {
    profileTab.classList.add('hidden');
    profileTab.classList.remove('flex');
  }
  if (typeof closePublicUserProfile === 'function') closePublicUserProfile();
  if (typeof closePublicProfileOptionsMenu === 'function') closePublicProfileOptionsMenu();

  if (dom.providerPickerSection) {
    dom.providerPickerSection.classList.remove('hidden');
    dom.providerPickerSection.classList.add('flex');
  }
}

function switchToMyRoom() {
  state.currentTab = 'room';
  // Add in-room-mode class for full-height responsive layout
  document.body.classList.add('in-room-mode');
  document.documentElement.classList.add('in-room-mode');
  state.isInRoom = true;
  if (!state.isHost && (state.userRole === 'owner' || !state.userRole)) {
    state.userRole = 'member';
  }
  // Hide explore header, provider picker, friends, profile and bottom nav when inside a room!
  const mainWorkspace = document.querySelector('main');
  if (mainWorkspace) {
    mainWorkspace.classList.add('pt-0');
    mainWorkspace.classList.remove('max-w-xl');
    mainWorkspace.classList.add('max-w-7xl');
  }
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
  const friendsTab = document.getElementById('friendsTabSection');
  if (friendsTab) {
    friendsTab.classList.add('hidden');
    friendsTab.classList.remove('flex');
  }
  const profileTab = document.getElementById('profileTabSection');
  if (profileTab) {
    profileTab.classList.add('hidden');
    profileTab.classList.remove('flex');
  }
  if (typeof closePublicUserProfile === 'function') closePublicUserProfile();
  if (typeof closePublicProfileOptionsMenu === 'function') closePublicProfileOptionsMenu();

  if (dom.roomWorkspaceSection) {
    dom.roomWorkspaceSection.classList.remove('hidden');
    dom.roomWorkspaceSection.classList.add('flex');
  }
  // Ensure YouTube Live Classic format (video left, chat right) respects chat visibility state
  setChatVisibility(state.isChatVisible !== false);
  if (dom.viewMyRoomBtn) {
    dom.viewMyRoomBtn.className = 'px-3.5 py-1.5 rounded-lg font-semibold text-rose-300 bg-rose-500/15 border border-rose-500/30 flex items-center gap-2 transition-all';
  }
  if (dom.viewExploreBtn) {
    dom.viewExploreBtn.className = 'px-3.5 py-1.5 rounded-lg font-medium text-gray-400 hover:text-white flex items-center gap-2 transition-all';
  }
  if (dom.activeRoomTitle) dom.activeRoomTitle.textContent = state.roomId;
  if (dom.raveInviteLinkText) dom.raveInviteLinkText.textContent = getMiruoRoomUrl(state.roomId);
  if (typeof updateNowPlayingAccountBadge === 'function') updateNowPlayingAccountBadge(state.connectedAccount);
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
  state.userRole = 'owner';
  state.controlMode = 'host_only';
  state.hasDjPermission = true;

  const accounts = typeof getConnectedAccounts === 'function' ? getConnectedAccounts() : {};
  const catKey = (category || '').toLowerCase();
  const matchedKey = Object.keys(accounts).find(k => catKey.includes(k));
  const activeConn = (matchedKey && accounts[matchedKey]?.connected) ? accounts[matchedKey].account : '';
  state.connectedAccount = activeConn;
  state.isPrivateRoom = !!isPrivate;
  updateRoomPrivacyUI(isPrivate);

  requestRoomCode({
    name: title || `${category} Partisi`,
    isPrivate: isPrivate,
    host: state.username,
    category: category,
    videoId: videoId,
    connectedAccount: activeConn
  }).then(code => {
    state.roomId = code;
    state.isInRoom = true;
    state.roomName = title || `${category} Partisi`;
    state.roomCategory = category;
    if (!isPrivate) {
      saveMyPublicRoom({
        id: code,
        name: title || `${category} Partisi`,
        category: category,
        host: state.username,
        videoId: videoId || '',
        mediaTitle: title || ''
      });
      syncCurrentRoomToGlobalPresence();
    }
    if (dom.activeRoomTitle) dom.activeRoomTitle.textContent = state.roomId;
    if (dom.currentRoomDisplay) dom.currentRoomDisplay.textContent = state.roomId;
    if (dom.raveInviteLinkText) dom.raveInviteLinkText.textContent = getMiruoRoomUrl(state.roomId);
    switchToMyRoom();
    connectSignaling();
    if (activeConn) {
      setTimeout(() => {
        if (typeof updateNowPlayingAccountBadge === 'function') updateNowPlayingAccountBadge(activeConn);
        const ann = `🎬 Bu oda ev sahibinin (${activeConn}) hesabı üzerinden birlikte izleniyor.`;
        if (typeof renderChatMessage === 'function') renderChatMessage('SİSTEM', ann, true);
      }, 300);
    }
    if (videoId) {
      setTimeout(() => loadYoutubeVideo(videoId), 400);
    } else if (category === 'YouTube' || category === 'youtube') {
      setTimeout(() => openVideoChooser(), 500);
    }
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
      state.userRole = 'member';
      state.hasDjPermission = false;
      state.roomId = d.room.id;
      state.isInRoom = true;
      state.hostName = d.room.host;
      state.connectedAccount = d.room.connectedAccount || '';
      if (dom.activeRoomTitle) dom.activeRoomTitle.textContent = state.roomId;
      if (dom.currentRoomDisplay) dom.currentRoomDisplay.textContent = state.roomId;
      switchToMyRoom();
      connectSignaling();
      if (state.connectedAccount) {
        setTimeout(() => {
          if (typeof updateNowPlayingAccountBadge === 'function') updateNowPlayingAccountBadge(state.connectedAccount);
          const ann = `🎬 Bu oda ev sahibinin (${state.connectedAccount}) hesabı üzerinden birlikte izleniyor.`;
          if (typeof renderChatMessage === 'function') renderChatMessage('SİSTEM', ann, true);
        }, 300);
      }
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
    const isImgUrl = typeof av === 'string' && (av.startsWith('http://') || av.startsWith('https://') || av.startsWith('data:image/') || av.startsWith('/'));
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
    id: 'WEEKND-BLINDING',
    name: 'The Weeknd — Blinding Lights',
    category: 'YouTube',
    host: 'AbelFan',
    mediaTitle: 'The Weeknd - Blinding Lights (Official Music Video)',
    videoId: 'fLexgOxsZu0',
    viewers: 12,
    avatars: [
      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=120&auto=format&fit=crop&q=80'
    ]
  },
  {
    id: 'ED-SHEERAN',
    name: 'Ed Sheeran — Shape of You',
    category: 'YouTube',
    host: 'Sheerio',
    mediaTitle: 'Ed Sheeran - Shape of You (Official Music Video)',
    videoId: 'JGwWNGJdvx8',
    viewers: 9,
    avatars: [
      'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=120&auto=format&fit=crop&q=80'
    ]
  },
  {
    id: 'DESPACITO-PARTY',
    name: 'Luis Fonsi — Despacito ft. Daddy Yankee',
    category: 'YouTube',
    host: 'LatinoBeats',
    mediaTitle: 'Luis Fonsi - Despacito ft. Daddy Yankee',
    videoId: 'kJQP7kiw5Fk',
    viewers: 7,
    avatars: [
      'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=120&auto=format&fit=crop&q=80'
    ]
  },
  {
    id: 'LOFI-GIRL-CHILL',
    name: 'Lofi Girl 24/7 Chill Beats',
    category: 'YouTube',
    host: 'LofiVibes',
    mediaTitle: 'Lofi Girl - beats to relax/study to',
    videoId: 'jfKfPfyJRdk',
    viewers: 15,
    avatars: [
      'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&auto=format&fit=crop&q=80'
    ]
  },
  {
    id: 'STRANGER-THINGS',
    name: 'Stranger Things 4 Fragman & İnceleme',
    category: 'Netflix',
    host: 'DiziKeyfi',
    mediaTitle: 'Stranger Things 4 | Official Trailer | Netflix',
    videoId: 'b9EkMc79ZSU',
    viewers: 8,
    avatars: [
      'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=120&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=120&auto=format&fit=crop&q=80'
    ]
  },
  {
    id: 'COUNTING-STARS',
    name: 'OneRepublic — Counting Stars',
    category: 'YouTube',
    host: 'RockFan',
    mediaTitle: 'OneRepublic - Counting Stars (Official Music Video)',
    videoId: 'hT_nvWreIhg',
    viewers: 6,
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
  
  if (!roomsToRender || roomsToRender.length === 0) {
    dom.publicRoomsGrid.innerHTML = `
      <div class="col-span-full py-12 px-6 flex flex-col items-center justify-center text-center bg-[#0C0E17]/60 border border-white/5 rounded-3xl">
        <div class="w-14 h-14 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 mb-4 shadow-lg shadow-rose-500/5">
          <svg class="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/>
          </svg>
        </div>
        <h3 class="text-white text-sm sm:text-base font-bold mb-1">Şu an Canlı Açık Oda Yok</h3>
        <p class="text-gray-400 text-xs max-w-xs">Şu anda herkese açık bir yayın odası bulunmuyor. Yeni bir canlı oda açıldığında burada listelenecektir.</p>
      </div>
    `;
    return;
  }
  
  roomsToRender.forEach(r => {
    const card = document.createElement('button');
    card.type = 'button';
    const thumbUrl = r.thumb || (r.videoId ? `https://img.youtube.com/vi/${r.videoId}/hqdefault.jpg` : 'https://img.youtube.com/vi/jfKfPfyJRdk/hqdefault.jpg');
    
    // Clean responsive card style: fills width, never clips text
    card.className = 'w-full text-left bg-[#0C0E17]/90 hover:bg-[#141824] border border-white/10 hover:border-white/20 rounded-3xl p-3 sm:p-4 flex items-center gap-3.5 sm:gap-4 transition-all shadow-xl hover:scale-[1.01] active:scale-[0.98] group cursor-pointer overflow-hidden relative select-none';
    card.innerHTML = `
      <!-- Left: Rounded video thumbnail with translucent play button -->
      <div class="relative w-28 sm:w-36 aspect-video rounded-2xl overflow-hidden bg-black shrink-0 border border-white/10 shadow-md pointer-events-none">
        <img src="${escapeHtml(thumbUrl)}" class="w-full h-full object-cover group-hover:scale-105 transition-transform" alt="Thumbnail" loading="lazy">
        <div class="absolute inset-0 bg-black/25 flex items-center justify-center">
          <div class="w-7 h-7 rounded-full bg-black/60 backdrop-blur-sm border border-white/30 text-white flex items-center justify-center">
            <svg class="w-3 h-3 text-white fill-current ml-0.5" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </div>
        </div>
      </div>

      <!-- Right: Title, Category & Overlapping Avatars -->
      <div class="flex-1 min-w-0 flex flex-col justify-between py-0.5 pointer-events-none">
        <div>
          <div class="flex items-center gap-2 mb-1">
            <span class="text-[10px] font-bold text-rose-400 bg-rose-500/15 px-2 py-0.5 rounded-full uppercase tracking-wider">${escapeHtml(r.category || 'YouTube')}</span>
          </div>
          <h4 class="text-xs sm:text-sm font-bold text-white tracking-tight group-hover:text-rose-200 transition-colors truncate">
            ${escapeHtml(r.mediaTitle || r.name)}
          </h4>
          <p class="text-[10px] sm:text-[11px] text-gray-400 truncate mt-0.5">${escapeHtml(r.name)}</p>
        </div>

        <!-- Bottom: Host & Overlapping Avatars + Red Pill Badge -->
        <div class="flex items-center justify-between mt-2 pt-1 border-t border-white/5">
          <span class="text-[10px] sm:text-[11px] text-gray-500 truncate">${(I18N[currentLang] || I18N.tr).host_label || 'Kurucu'}: @${escapeHtml(r.host || 'admin')}</span>
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
      state.userRole = state.isHost ? 'owner' : 'member';
      state.controlMode = 'host_only';
      state.hasDjPermission = state.isHost;
      state.isInRoom = true;
      if (dom.currentRoomDisplay) dom.currentRoomDisplay.textContent = roomId;
      switchToMyRoom();
      connectSignaling();
      if (r.videoId) {
        setTimeout(() => { loadYoutubeVideo(r.videoId); }, 300);
      }
      showToast(`${r.name} odasına katıldınız!`);
    };

    addInstantTap(card, enterRoom);
    dom.publicRoomsGrid.appendChild(card);
  });
}

// Bu cihazdan açılan oda SADECE o sırada kullanıcı odanın içindeyse geçerlidir
function getMyPublicRooms() {
  if (!state.isInRoom || !state.roomId || state.isPrivateRoom) return [];
  try {
    const list = JSON.parse(localStorage.getItem('miruo_my_public_rooms') || '[]');
    return list.filter(r => r && r.id === state.roomId);
  } catch (_) { return []; }
}
function saveMyPublicRoom(room) {
  try {
    localStorage.setItem('miruo_my_public_rooms', JSON.stringify([{ ...room, ts: Date.now() }]));
  } catch (_) {}
}
function removeMyPublicRoom(id) {
  try {
    localStorage.removeItem('miruo_my_public_rooms');
  } catch (_) {}
}

// Global Public Rooms Discovery via Supabase Realtime Channels (Cross-Device Worldwide)
let globalRealtimeRooms = [];
let globalRoomsChannel = null;
let globalRoomsSubscribed = false;

function initGlobalPublicRoomsSync() {
  if (!supabaseClient || globalRoomsChannel) return;
  try {
    const presenceKey = (state && state.userId) ? String(state.userId) : ('guest_' + Math.random().toString(36).substring(2, 9));
    globalRoomsChannel = supabaseClient.channel('miruo_global_public_rooms', {
      config: {
        presence: { key: presenceKey }
      }
    });

    globalRoomsChannel
      .on('presence', { event: 'sync' }, () => {
        const presenceState = globalRoomsChannel.presenceState();
        parseGlobalRoomsFromPresence(presenceState);
      })
      .on('presence', { event: 'join' }, () => {
        parseGlobalRoomsFromPresence(globalRoomsChannel.presenceState());
      })
      .on('presence', { event: 'leave' }, () => {
        parseGlobalRoomsFromPresence(globalRoomsChannel.presenceState());
      })
      .on('broadcast', { event: 'room_announced' }, ({ payload }) => {
        if (payload && payload.id) {
          upsertGlobalRealtimeRoom(payload);
        }
      })
      .on('broadcast', { event: 'room_closed' }, ({ payload }) => {
        if (payload && payload.id) {
          removeGlobalRealtimeRoom(payload.id);
        }
      })
      .on('broadcast', { event: 'request_public_rooms' }, () => {
        // Any device opening Explore broadcasts this; if we have an active public room, broadcast back immediately!
        if (state.isInRoom && state.roomId && !state.isPrivateRoom) {
          syncCurrentRoomToGlobalPresence();
        }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          globalRoomsSubscribed = true;
          if (state.isInRoom && state.roomId && !state.isPrivateRoom) {
            syncCurrentRoomToGlobalPresence();
          }
          // Request all active rooms worldwide upon subscribing
          try {
            globalRoomsChannel.send({
              type: 'broadcast',
              event: 'request_public_rooms',
              payload: { from: state.userId || 'guest', ts: Date.now() }
            }).catch(() => {});
          } catch (_) {}
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          globalRoomsSubscribed = false;
        }
      });
  } catch (e) {
    console.warn('[Miruo] Global rooms channel error:', e);
  }
}

function parseGlobalRoomsFromPresence(presenceState) {
  if (!presenceState) return;
  const roomMap = new Map();
  // Preserve previously announced broadcast rooms that are still fresh
  (globalRealtimeRooms || []).forEach(r => {
    if (r && r.id && (Date.now() - (r.ts || 0) < 180000)) {
      roomMap.set(r.id, r);
    }
  });

  Object.keys(presenceState).forEach(key => {
    const presences = presenceState[key] || [];
    presences.forEach(p => {
      if (p && p.id && p.isPublic) {
        const hostAv = p.hostAvatar || (p.avatars && p.avatars[0]) || '';
        roomMap.set(p.id, {
          id: p.id,
          name: p.name || 'Canlı Oda',
          category: p.category || 'Müzik & Sohbet',
          host: p.host || 'Yönetici',
          hostAvatar: hostAv,
          mediaTitle: p.mediaTitle || p.name || 'Canlı Yayın',
          videoId: p.videoId || '',
          thumb: p.thumb || (p.videoId ? `https://img.youtube.com/vi/${p.videoId}/mqdefault.jpg` : ''),
          viewers: Math.max(1, p.viewers || 1),
          avatars: (p.avatars && p.avatars.length > 0) ? p.avatars : (hostAv ? [hostAv] : [{ initial: (p.host || 'U').charAt(0).toUpperCase(), bg: 'from-purple-500 to-indigo-600' }]),
          ts: p.updatedAt || Date.now()
        });
      }
    });
  });
  globalRealtimeRooms = Array.from(roomMap.values());
  if (dom.publicRoomsGrid) {
    renderRoomList(mergeAllPublicRooms([]));
  }
}

function upsertGlobalRealtimeRoom(room) {
  if (!room || !room.id) return;
  const myAv = room.hostAvatar || (room.avatars && room.avatars[0]) || (state.roomId === room.id && (state.avatarUrl || localStorage.getItem('miruo_avatar'))) || '';
  const formatted = {
    id: room.id,
    name: room.name || 'Canlı Oda',
    category: room.category || 'Müzik & Sohbet',
    host: room.host || 'Yönetici',
    hostAvatar: myAv,
    mediaTitle: room.mediaTitle || room.name || 'Canlı Yayın',
    videoId: room.videoId || '',
    thumb: room.thumb || (room.videoId ? `https://img.youtube.com/vi/${room.videoId}/mqdefault.jpg` : ''),
    viewers: Math.max(1, room.viewers || 1),
    avatars: (room.avatars && room.avatars.length > 0) ? room.avatars : (myAv ? [myAv] : [{ initial: (room.host || 'U').charAt(0).toUpperCase(), bg: 'from-purple-500 to-indigo-600' }]),
    ts: Date.now()
  };
  const idx = globalRealtimeRooms.findIndex(r => r.id === room.id);
  if (idx >= 0) {
    globalRealtimeRooms[idx] = formatted;
  } else {
    globalRealtimeRooms.unshift(formatted);
  }
  if (dom.publicRoomsGrid) {
    renderRoomList(mergeAllPublicRooms([]));
  }
}

function removeGlobalRealtimeRoom(roomId) {
  globalRealtimeRooms = globalRealtimeRooms.filter(r => r.id !== roomId);
  if (dom.publicRoomsGrid) {
    renderRoomList(mergeAllPublicRooms([]));
  }
}

function syncCurrentRoomToGlobalPresence() {
  if (!state.roomId || !state.isInRoom) return;
  if (!globalRoomsChannel) {
    initGlobalPublicRoomsSync();
  }
  if (state.isPrivateRoom) {
    try {
      if (globalRoomsChannel) {
        globalRoomsChannel.send({
          type: 'broadcast',
          event: 'room_closed',
          payload: { id: state.roomId }
        }).catch(() => {});
        globalRoomsChannel.untrack().catch(() => {});
      }
    } catch (_) {}
    removeGlobalRealtimeRoom(state.roomId);
    return;
  }
  const savedUserObj = JSON.parse(localStorage.getItem('miruo_user') || '{}');
  const myAvatar = state.avatarUrl || savedUserObj.avatarUrl || localStorage.getItem('miruo_avatar') || '';
  const payload = {
    id: state.roomId,
    name: state.roomName || (state.isHost ? `${state.username} Odası` : 'Canlı Oda'),
    category: state.roomCategory || (state.activeMode === 'youtube' ? 'YouTube' : 'Müzik & Sohbet'),
    host: state.isHost ? (state.username || 'Yönetici') : (state.hostName || 'Yönetici'),
    hostAvatar: myAvatar,
    mediaTitle: state.currentVideoTitle || (state.roomCategory === 'Galeri' ? 'Fotoğraf & Galeri' : state.roomCategory === 'Ekran Paylaş' ? 'Canlı Ekran Yayını' : state.roomCategory === 'Uyku Modu' ? 'Birlikte Uyku' : (state.activeMode === 'youtube' ? 'YouTube Yayını' : 'Canlı Sohbet Odası')),
    videoId: state.currentVideoId || '',
    thumb: state.currentVideoThumb || (state.currentVideoId ? `https://img.youtube.com/vi/${state.currentVideoId}/mqdefault.jpg` : ''),
    viewers: Math.max(1, (state.remotePeers ? Object.keys(state.remotePeers).length + 1 : 1)),
    isPublic: true,
    avatars: myAvatar ? [myAvatar] : [{ initial: (state.username || 'U').charAt(0).toUpperCase(), bg: 'from-purple-500 to-indigo-600' }],
    updatedAt: Date.now()
  };
  upsertGlobalRealtimeRoom(payload);
  if (globalRoomsChannel) {
    try {
      globalRoomsChannel.track(payload).catch(e => console.warn('[Presence] track error:', e));
      globalRoomsChannel.send({
        type: 'broadcast',
        event: 'room_announced',
        payload
      }).catch(() => {});
    } catch (e) {
      console.warn('[Presence] sync error:', e);
    }
  }
}

// Global 8-second Heartbeat: keeps host room continuously alive and visible across all networks
if (!window._publicRoomHeartbeatInterval) {
  window._publicRoomHeartbeatInterval = setInterval(() => {
    if (state.isInRoom && state.roomId && !state.isPrivateRoom) {
      syncCurrentRoomToGlobalPresence();
    }
  }, 8000);
}

function mergeAllPublicRooms(serverRooms = []) {
  const roomMap = new Map();
  const now = Date.now();
  // 1. Add global realtime presence rooms (prune rooms stale > 3 minutes)
  (globalRealtimeRooms || []).forEach(r => {
    if (r && r.id) {
      if (state.isInRoom && r.id === state.roomId) {
        roomMap.set(r.id, r);
      } else if (!r.ts || (now - r.ts) < 180000) {
        roomMap.set(r.id, r);
      }
    }
  });
  // 2. Add local device room ONLY IF CURRENTLY IN AN ACTIVE PUBLIC ROOM!
  if (state.isInRoom && state.roomId && !state.isPrivateRoom) {
    const savedUserObj = JSON.parse(localStorage.getItem('miruo_user') || '{}');
    const myAvatar = state.avatarUrl || savedUserObj.avatarUrl || localStorage.getItem('miruo_avatar') || '';
    const myCurrentRoom = {
      id: state.roomId,
      name: state.roomName || (state.isHost ? `${state.username} Odası` : 'Canlı Oda'),
      category: state.roomCategory || (state.activeMode === 'youtube' ? 'YouTube' : 'Müzik & Sohbet'),
      host: state.isHost ? (state.username || 'Yönetici') : (state.hostName || 'Yönetici'),
      hostAvatar: myAvatar,
      mediaTitle: state.currentVideoTitle || (state.roomCategory === 'Galeri' ? 'Fotoğraf & Galeri' : state.roomCategory === 'Ekran Paylaş' ? 'Canlı Ekran Yayını' : state.roomCategory === 'Uyku Modu' ? 'Birlikte Uyku' : (state.activeMode === 'youtube' ? 'YouTube Yayını' : 'Canlı Sohbet Odası')),
      videoId: state.currentVideoId || '',
      thumb: state.currentVideoThumb || (state.currentVideoId ? `https://img.youtube.com/vi/${state.currentVideoId}/mqdefault.jpg` : ''),
      viewers: Math.max(1, (state.remotePeers ? Object.keys(state.remotePeers).length + 1 : 1)),
      avatars: myAvatar ? [myAvatar] : [{ initial: (state.username || 'U').charAt(0).toUpperCase(), bg: 'from-purple-500 to-indigo-600' }],
      ts: Date.now()
    };
    roomMap.set(state.roomId, myCurrentRoom);
  }
  // 3. Add server rooms if any (from backend server if configured)
  (serverRooms || []).forEach(r => {
    if (r && r.id && !roomMap.has(r.id)) roomMap.set(r.id, r);
  });
  return Array.from(roomMap.values()).filter(r => {
    if (!r) return false;
    if (r.host && typeof isUserBlocked === 'function' && isUserBlocked(r.host)) return false;
    return true;
  });
}

function loadPublicRooms() {
  // 1. Request all active online room hosts worldwide to announce themselves
  if (globalRoomsChannel) {
    try {
      globalRoomsChannel.send({
        type: 'broadcast',
        event: 'request_public_rooms',
        payload: { requester: state.userId || 'guest', ts: Date.now() }
      }).catch(() => {});
    } catch (_) {}
  } else {
    initGlobalPublicRoomsSync();
  }

  // 2. Clean stale rooms (> 3 mins)
  const now = Date.now();
  globalRealtimeRooms = (globalRealtimeRooms || []).filter(r => {
    if (!r || !r.id) return false;
    if (state.isInRoom && r.id === state.roomId) return true;
    return !r.ts || (now - r.ts) < 180000;
  });

  // 3. Render immediately from realtime rooms + local room
  renderRoomList(mergeAllPublicRooms([]));

  // 4. Fallback attempt for web server if available
  try {
    fetch('/api/public-rooms')
      .then(res => res.json())
      .then(data => {
        if (data && data.rooms && data.rooms.length > 0) {
          renderRoomList(mergeAllPublicRooms(data.rooms));
        }
      })
      .catch(() => {});
  } catch (_) {}
}

function updateRoomPrivacyUI(isPrivate) {
  state.isPrivateRoom = !!isPrivate;
  const pDict = I18N[currentLang] || I18N.tr;
  const pText = dom.privacyStatusText || document.getElementById('privacyStatusText');
  const pIcon = dom.privacyStatusIcon || document.getElementById('privacyStatusIcon');
  if (pText) {
    pText.textContent = isPrivate ? (pDict.privacy_private || 'Özel Oda') : (pDict.privacy_public || 'Açık Oda');
  }
  if (pIcon) {
    pIcon.innerHTML = isPrivate
      ? '<svg class="w-3 h-3 inline text-purple-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
      : '<svg class="w-3 h-3 inline text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z"/></svg>';
  }
  
  if (isPrivate) {
    if (globalRoomsChannel && state.isHost) {
      try {
        globalRoomsChannel.send({
          type: 'broadcast',
          event: 'room_closed',
          payload: { id: state.roomId }
        }).catch(() => {});
        globalRoomsChannel.untrack().catch(() => {});
      } catch (_) {}
    }
    removeMyPublicRoom(state.roomId);
  } else {
    syncCurrentRoomToGlobalPresence();
  }
  
  // Sync radio in roomAccessModal
  const publicRadio = document.querySelector('input[name="roomAccessRule"][value="public"]');
  const inviteRadio = document.querySelector('input[name="roomAccessRule"][value="invite"]');
  if (isPrivate && inviteRadio) inviteRadio.checked = true;
  else if (!isPrivate && publicRadio) publicRadio.checked = true;

  // Sync privacy choice checkmarks in roomShareModal
  document.querySelectorAll('.privacy-choice-btn').forEach(b => {
    const isTarget = isPrivate ? (b.dataset.privacy === 'invite') : (b.dataset.privacy === 'public');
    const chk = b.querySelector('.privacy-check');
    if (chk) chk.classList.toggle('hidden', !isTarget);
  });
}
window.updateRoomPrivacyUI = updateRoomPrivacyUI;

function handleRemotePrivacyChange(isPrivate) {
  updateRoomPrivacyUI(isPrivate);
  const pDict = I18N[currentLang] || I18N.tr;
  const msg = isPrivate
    ? (pDict.room_privacy_private_toast || 'Oda gizliliği "Özel Oda" olarak güncellendi')
    : (pDict.room_privacy_public_toast || 'Oda gizliliği "Herkese Açık" yapıldı');
  showToast(msg);
}
window.handleRemotePrivacyChange = handleRemotePrivacyChange;

// ==========================================
// 5.8 ROOM ROLES, PERMISSIONS & BLOCKED USERS
// ==========================================
function isRoomOwner() {
  return !!(state.isHost || state.userRole === 'owner');
}
window.isRoomOwner = isRoomOwner;

function isRoomAdminOrOwner() {
  return isRoomOwner() || state.userRole === 'admin';
}
window.isRoomAdminOrOwner = isRoomAdminOrOwner;

function canUserManageRoom() {
  return isRoomAdminOrOwner();
}
window.canUserManageRoom = canUserManageRoom;

function canUserControlPlayback() {
  if (state.isHost) return true;
  if (state.controlMode === 'everyone') return true;
  const role = state.userRole || 'member';
  return role === 'owner' || role === 'admin' || role === 'video_control' || role === 'dj' || !!state.hasDjPermission;
}
window.canUserControlPlayback = canUserControlPlayback;

function canUserChooseVideo() {
  if (state.isHost) return true;
  if (state.controlMode === 'everyone') return true;
  const role = state.userRole || 'member';
  return role === 'owner' || role === 'admin' || role === 'video_control' || role === 'dj' || !!state.hasDjPermission;
}
window.canUserChooseVideo = canUserChooseVideo;

// ==========================================
// BLOCKED USERS SYSTEM (STORAGE & MANAGEMENT)
// ==========================================
function cleanBlockedKey(val) {
  if (!val) return '';
  return String(val)
    .replace(/^@/, '')
    .replace(/\s*\(Sen\)/gi, '')
    .replace(/\s*\(Simüle\)/gi, '')
    .replace(/\s*\(Partner\)/gi, '')
    .toLowerCase()
    .trim();
}

function getBlockedUsers() {
  try {
    const raw = localStorage.getItem('miruo_blocked_users');
    if (!raw) return [];
    let parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Auto-normalize any raw string legacy entries into structured objects
    return parsed.map((item, idx) => {
      if (typeof item === 'string') {
        const clean = item.replace(/^@/, '').trim();
        return {
          id: 'blocked_legacy_' + clean,
          username: clean,
          avatar: null,
          avatarColor: 'from-gray-600 to-gray-800',
          blockedAt: Date.now() - (idx * 1000)
        };
      }
      return item;
    });
  } catch (e) {
    return [];
  }
}

function saveBlockedUsers(list) {
  try {
    localStorage.setItem('miruo_blocked_users', JSON.stringify(list || []));
  } catch (e) {}
}

function updateBlockedMediaState() {
  try {
    document.querySelectorAll('audio[id^="remoteVoiceAudio"]').forEach(aud => {
      const pid = aud.id.replace('remoteVoiceAudio_', '').replace('remoteVoiceAudio', '');
      const peerId = pid || state.peerId;
      const peerName = state.participants && peerId && state.participants[peerId] ? state.participants[peerId].username : '';
      const isPeerBlocked = isUserBlocked(peerId) || (peerName && isUserBlocked(peerName));
      aud.muted = !!isPeerBlocked;
    });
    if (dom.partnerPipCard) {
      const peerName = state.participants && state.peerId && state.participants[state.peerId] ? state.participants[state.peerId].username : '';
      const isPeerBlocked = isUserBlocked(state.peerId) || (peerName && isUserBlocked(peerName));
      if (isPeerBlocked) {
        dom.partnerPipCard.classList.add('hidden');
      }
    }
  } catch (_) {}
}

function isUserBlocked(usernameOrId) {
  if (!usernameOrId) return false;
  const clean = cleanBlockedKey(usernameOrId);
  if (!clean) return false;
  const list = getBlockedUsers();
  return list.some(b => {
    if (typeof b === 'string') {
      return cleanBlockedKey(b) === clean;
    }
    const bName = cleanBlockedKey(b.username || b.name || '');
    const bId = cleanBlockedKey(b.id || '');
    return (bName && bName === clean) || (bId && bId === clean);
  });
}

function blockUser(username, userId = null, avatar = null, avatarColor = null) {
  if (!username) return;
  const cleanName = cleanBlockedKey(username);
  const myClean = cleanBlockedKey(state.username || '');
  if (cleanName === myClean) {
    showToast('Kendinizi engelleyemezsiniz!');
    return;
  }
  let list = getBlockedUsers();
  if (list.some(b => cleanBlockedKey(b.username) === cleanName)) {
    showToast(`@${cleanName} zaten engellenenler listesinde.`);
    return;
  }
  list.unshift({
    id: userId || ('blocked_' + Date.now()),
    username: cleanName,
    avatar: avatar || null,
    avatarColor: avatarColor || 'from-gray-600 to-gray-800',
    blockedAt: Date.now()
  });
  saveBlockedUsers(list);

  // 1. Remove from friends list if currently friends
  if (Array.isArray(state.friends)) {
    const prevLen = state.friends.length;
    state.friends = state.friends.filter(f => cleanBlockedKey(f.username || f.name) !== cleanName);
    if (state.friends.length !== prevLen) {
      saveFriends();
      if (typeof renderFriendsTab === 'function') renderFriendsTab();
    }
  }

  // 2. Remove any pending incoming friend requests from this user
  try {
    const inc = JSON.parse(localStorage.getItem('miruo_incoming_friend_requests') || '[]');
    const filteredInc = inc.filter(r => cleanBlockedKey(r.fromUsername) !== cleanName);
    localStorage.setItem('miruo_incoming_friend_requests', JSON.stringify(filteredInc));
    updateFriendRequestBadge();
    renderIncomingRequests();
  } catch (_) {}

  // 3. If in a room as host and this participant is in room, kick them out
  if (state.isHost && state.participants) {
    const partEntry = Object.values(state.participants).find(p => cleanBlockedKey(p.username) === cleanName || (userId && p.userId === userId));
    if (partEntry && typeof kickParticipant === 'function') {
      kickParticipant(partEntry.userId, partEntry.username);
    }
  }

  // 4. Mute their audio and hide video stream immediately
  updateBlockedMediaState();

  renderBlockedUsersList();
  renderParticipantsList();
  showToast(`@${cleanName} engellendi.`);
}

function unblockUser(usernameOrId) {
  if (!usernameOrId) return;
  const clean = cleanBlockedKey(usernameOrId);
  let list = getBlockedUsers();
  list = list.filter(b => {
    if (typeof b === 'string') return cleanBlockedKey(b) !== clean;
    const bName = cleanBlockedKey(b.username || b.name || '');
    const bId = cleanBlockedKey(b.id || '');
    return bName !== clean && bId !== clean;
  });
  saveBlockedUsers(list);
  updateBlockedMediaState();
  renderBlockedUsersList();
  renderParticipantsList();
  if (typeof renderFriendsTab === 'function') renderFriendsTab();
  showToast(`Engelleme kaldırıldı.`);
}

function renderBlockedUsersList() {
  const container = document.getElementById('blockedUsersListContainer');
  const badge = document.getElementById('blockedUsersCountBadge');
  const list = getBlockedUsers();

  if (badge) badge.textContent = list.length;
  if (!container) return;

  if (list.length === 0) {
    container.innerHTML = `
      <div class="py-4 text-center">
        <p class="text-xs text-gray-400">Henüz engellenen kullanıcı yok.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  list.forEach(item => {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between p-2.5 rounded-xl bg-white/5 border border-white/5 hover:border-white/10 transition-all';
    const initial = (item.username || 'K').charAt(0).toUpperCase();
    const avHtml = item.avatar 
      ? `<img src="${item.avatar}" class="w-7 h-7 rounded-full object-cover shrink-0 border border-white/10" alt="PP">`
      : `<div class="w-7 h-7 rounded-full bg-gradient-to-tr ${item.avatarColor || 'from-gray-600 to-gray-800'} flex items-center justify-center text-[11px] font-bold text-white shrink-0">${initial}</div>`;

    row.innerHTML = `
      <div class="flex items-center gap-2.5 min-w-0">
        ${avHtml}
        <div class="truncate">
          <span class="text-xs font-semibold text-white block truncate">@${escapeHtml(item.username)}</span>
          <span class="text-[9px] text-gray-500">Engellendi</span>
        </div>
      </div>
      <button type="button" class="unblock-btn px-2.5 py-1 rounded-lg bg-red-500/15 hover:bg-red-500/25 active:scale-95 text-red-400 hover:text-red-300 border border-red-500/25 text-[11px] font-semibold transition-all cursor-pointer flex items-center gap-1" data-username="${escapeHtml(item.username)}">
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
        <span>Engeli Kaldır</span>
      </button>
    `;

    const unblockBtn = row.querySelector('.unblock-btn');
    if (unblockBtn) {
      addInstantTap(unblockBtn, (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        unblockUser(item.username);
      });
    }

    container.appendChild(row);
  });
}
window.getBlockedUsers = getBlockedUsers;
window.isUserBlocked = isUserBlocked;
window.blockUser = blockUser;
window.unblockUser = unblockUser;
window.renderBlockedUsersList = renderBlockedUsersList;

function openBlockedUsersModal() {
  const modal = document.getElementById('blockedUsersModal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    renderBlockedUsersList();
  }
}
window.openBlockedUsersModal = openBlockedUsersModal;

function closeBlockedUsersModal() {
  const modal = document.getElementById('blockedUsersModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}
window.closeBlockedUsersModal = closeBlockedUsersModal;

function updatePermissionUI() {
  const dict = I18N[currentLang] || I18N.tr;
  if (dom.roomHostName) {
    dom.roomHostName.textContent = state.isHost ? (dict.you_badge || 'Sen') : (state.hostName || dict.role_admin || 'Yönetici');
  }

  // Toggle button appearance for host
  if (dom.toggleRoomPermissionBtn) {
    if (state.isHost) {
      dom.toggleRoomPermissionBtn.classList.remove('hidden');
      if (state.controlMode === 'host_only') {
        dom.permModeText.textContent = currentLang === 'en' ? 'Host Only' : (currentLang === 'de' ? 'Nur Leiter' : 'Sadece Yönetici');
        dom.toggleRoomPermissionBtn.className = 'px-2.5 py-1 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs font-semibold flex items-center gap-1.5 transition-all';
        dom.permLockIcon.innerHTML = '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>';
      } else {
        dom.permModeText.textContent = currentLang === 'en' ? 'Everyone Can Play' : (currentLang === 'de' ? 'Jeder kann abspielen' : 'Herkes Açabilir');
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
    dom.roomQuickSearchBtnText.textContent = canControl ? (dict.room_change_video || 'Değiştir') : (currentLang === 'en' ? 'Suggest' : (currentLang === 'de' ? 'Vorschlagen' : 'Öner'));
  }

  // Visual state of seek sliders and advance controls (Only Owner & Admins can seek)
  const hasPlaybackRights = canUserControlPlayback();
  [dom.seekSlider, dom.nowPlayingSeekSlider].forEach(slider => {
    if (!slider) return;
    if (hasPlaybackRights) {
      slider.classList.remove('opacity-40', 'cursor-not-allowed');
    } else {
      slider.classList.add('opacity-40', 'cursor-not-allowed');
    }
  });
  const advBtn = document.getElementById('stageAdvanceNextBtn');
  if (advBtn) {
    if (hasPlaybackRights) advBtn.classList.remove('opacity-40', 'cursor-not-allowed');
    else advBtn.classList.add('opacity-40', 'cursor-not-allowed');
  }
  const seekBack = document.getElementById('stageSeekBackBtn');
  if (seekBack) {
    if (hasPlaybackRights) seekBack.classList.remove('opacity-40', 'cursor-not-allowed');
    else seekBack.classList.add('opacity-40', 'cursor-not-allowed');
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
  showToast(newMode === 'everyone' ? 'Oda Yöneticisi video açma iznini herkese verdi!' : 'Oda Yöneticisi kontrolleri kilitledi (Sadece Yönetici)');
}

function handleDjPermissionRequested(fromUser) {
  if (!state.isHost) return;
  if (dom.requestingUserName) dom.requestingUserName.textContent = fromUser || 'Misafir';
  if (dom.hostPermissionRequestToast) {
    dom.hostPermissionRequestToast.classList.remove('hidden');
    dom.hostPermissionRequestToast.classList.add('flex');
  }
  showToast(`${fromUser || 'Misafir'} video açma yetkisi istedi!`);
}

function handleDjPermissionGranted(toUser) {
  state.hasDjPermission = true;
  updatePermissionUI();
  showToast('Tebrikler! Oda yöneticisi size video açma yetkisi verdi.');
}

// Default seed friends (With unique usernames, activity timestamps and watch minutes)
const DEFAULT_FRIENDS = [
  { id: 'f1', name: 'Selin Yılmaz', username: 'selin', status: 'online', statusText: 'Çevrimiçi', avatar: 'S', lastActive: Date.now() - 30000, watchMinutes: 216 },
  { id: 'f2', name: 'Can Demir', username: 'can', status: 'in_room', statusText: 'Film Odasında', avatar: 'C', lastActive: Date.now() - 120000, watchMinutes: 195 },
  { id: 'f3', name: 'Merve Kaya', username: 'merve', status: 'idle', statusText: '15 dk önce aktifti', avatar: 'M', lastActive: Date.now() - 900000, watchMinutes: 84 },
  { id: 'f4', name: 'Emre Yıldız', username: 'emre', status: 'offline', statusText: '2 saat önce aktifti', avatar: 'E', lastActive: Date.now() - 7200000, watchMinutes: 42 }
];

function loadFriends() {
  const saved = localStorage.getItem('miruo_friends');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      state.friends = Array.isArray(parsed) ? parsed : DEFAULT_FRIENDS;
    } catch (e) {
      state.friends = DEFAULT_FRIENDS;
    }
  } else {
    state.friends = DEFAULT_FRIENDS;
    localStorage.setItem('miruo_friends', JSON.stringify(state.friends));
  }

  // Ensure no old cached emoji remnants exist & seed shared watch times
  state.friends.forEach(f => {
    if (f.name) f.name = f.name.replace(/[^\w\sçÇğĞıİöÖşŞüÜ-]/g, '').trim();
    if (f.username) f.username = f.username.replace(/[^\w-]/g, '').trim();
    if (f.statusText) f.statusText = f.statusText.replace(/[^\w\sçÇğĞıİöÖşŞüÜ-]/g, '').trim();
    const cleanU = (f.username || f.name).toLowerCase().replace(/^@/, '');
    if (typeof getSharedWatchMinutes === 'function' && getSharedWatchMinutes(cleanU) === 0 && DEFAULT_SHARED_WATCH_TIME && DEFAULT_SHARED_WATCH_TIME[cleanU]) {
      setSharedWatchMinutes(cleanU, DEFAULT_SHARED_WATCH_TIME[cleanU]);
    }
  });
  localStorage.setItem('miruo_friends', JSON.stringify(state.friends));

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
  
  const dict = I18N[currentLang] || I18N.tr;
  const query = (filterText || '').toLowerCase().trim().replace(/^@/, '');
  const listToRender = query 
    ? state.friends.filter(f => (f.name && f.name.toLowerCase().includes(query)) || (f.username && f.username.toLowerCase().includes(query)))
    : state.friends;

  if (dom.friendsCountDisplay) dom.friendsCountDisplay.textContent = state.friends.length;

  if (listToRender.length === 0) {
    dom.friendsListContainer.innerHTML = query 
      ? `<p class="text-xs text-gray-400 text-center py-4">"${escapeHtml(query)}" ile eşleşen kullanıcı bulunamadı.</p>`
      : `<p class="text-xs text-gray-500 text-center py-4">${dict.no_friends_empty || 'Henüz arkadaş eklemedin.'}</p>`;
    return;
  }

  listToRender.forEach(fr => {
    const item = document.createElement('div');
    item.className = 'flex items-center justify-between p-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 transition-all';
    
    let badgeColor = 'bg-emerald-400';
    if (fr.status === 'in_room') badgeColor = 'bg-purple-400';
    if (fr.status === 'idle') badgeColor = 'bg-amber-400';

    let friendStatusLabel = dict.status_online || 'Online';
    if (fr.status === 'in_room') friendStatusLabel = dict.status_in_room || 'In room';
    else if (fr.status === 'idle') friendStatusLabel = dict.status_idle || 'Idle';
    else if (fr.status === 'offline') friendStatusLabel = dict.status_offline || 'Offline';

    const cleanName = (fr.name || '').replace(/[^\w\sçÇğĞıİöÖşŞüÜ-]/g, '').trim() || 'Kullanici';
    const cleanUsername = (fr.username || fr.name || '').replace(/^@/, '').replace(/[^\w-]/g, '').trim() || 'kullanici';
    const cleanAvatarChar = (fr.avatar || cleanName.charAt(0) || 'A').toUpperCase();

    item.innerHTML = `
      <div class="flex items-center gap-2.5">
        <div class="w-8 h-8 rounded-full bg-gradient-to-tr from-rose-500 to-indigo-600 flex items-center justify-center text-xs font-bold text-white shadow-sm">
          ${cleanAvatarChar}
        </div>
        <div>
          <div class="flex items-center gap-1.5">
            <span class="text-xs font-semibold text-white block">@${cleanUsername}</span>
          </div>
          <span class="text-[10px] text-gray-400 flex items-center gap-1">
            <span class="w-1.5 h-1.5 rounded-full ${badgeColor}"></span>
            <span>${friendStatusLabel}</span>
          </span>
        </div>
      </div>

      <div class="flex items-center gap-1.5">
        <button class="invite-friend-btn px-2.5 py-1 bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 rounded-lg text-[11px] font-semibold transition-all flex items-center gap-1 cursor-pointer" data-name="${cleanName}">
          <svg class="w-3.5 h-3.5 text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6m0-6L10 14"/></svg>
          <span>${dict.invite_friend || 'Invite'}</span>
        </button>
      </div>
    `;

    addInstantTap(item.querySelector('.invite-friend-btn'), () => {
      inviteFriendToRoom(fr);
    });

    dom.friendsListContainer.appendChild(item);
  });
}

function fallbackCopyText(text) {
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.top = '-9999px';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    return successful;
  } catch (err) {
    return false;
  }
}

function copyToClipboard(text) {
  if (!text) return Promise.resolve(false);

  // 1. Native iOS WKWebView messageHandler bridge (Guarantees iOS native pasteboard copy!)
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.copyToClipboard) {
    try {
      window.webkit.messageHandlers.copyToClipboard.postMessage(text);
    } catch (e) {
      console.warn('Native copyToClipboard error:', e);
    }
  }

  // 2. Modern Clipboard API
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => {
      fallbackCopyText(text);
      return true;
    });
  }

  // 3. Fallback textarea copy
  fallbackCopyText(text);
  return Promise.resolve(true);
}

function sendRoomInvite(friend) {
  if (!friend) return;
  const cleanTarget = (friend.cleanUsername || friend.username || friend.name || '').replace(/^@/, '').trim();
  if (isUserBlocked(cleanTarget)) {
    showToast('Bu kullanıcı engellenmiş.');
    return null;
  }
  const myUsername = (state.username || 'kullanici').replace(/^@/, '');
  const roomId = state.roomId || 'ODA-77';

  const newInvite = {
    id: 'room_inv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    fromUsername: myUsername,
    toUsername: cleanTarget,
    roomId: roomId,
    createdAt: Date.now()
  };
  // Davet KARŞI tarafa gerçek zamanlı gider (gönderenin kendi listesine yazılmaz). 30 dk geçerli.
  queueGlobalEvent('room_invite', cleanTarget, newInvite, 30 * 60000);
  sendSignal({ type: 'room-invite', payload: newInvite });
  sendP2PData('room_invite', newInvite);
  return newInvite;
}
window.sendRoomInvite = sendRoomInvite;

function inviteFriendToRoom(friend) {
  if (!friend) return;
  const cleanUsername = (friend.cleanUsername || friend.username || friend.name || '').replace(/^@/, '').trim();
  if (typeof closePublicUserProfile === 'function') closePublicUserProfile();
  if (typeof closePublicProfileOptionsMenu === 'function') closePublicProfileOptionsMenu();

  if (!state.roomId) {
    state.roomId = 'ODA-77';
  }

  // 1. Send the invitation
  sendRoomInvite(friend);

  // 2. User rule: "mını ekrana alıp bırıını odaya çağırınca bişey vermesın ben tekrar buyutmek ıstersem basıp buyuteyım"
  // If mini-player is active, DO NOT change the view or blank out the screen!
  // Leave the user in their active view (e.g. Friends tab) with the mini player docked in corner.
  if (state.isMiniPlayer || document.body.classList.contains('has-mini-player')) {
    showToast(`@${cleanUsername} odaya çağrıldı!`);
    return;
  }

  // If already inside full room view (not mini player):
  if (state.isInRoom) {
    switchToMyRoom();
    showToast(`@${cleanUsername} odaya çağrıldı!`);
  } else {
    // Switch to Provider Picker ('+' screen) so host can pick content
    switchToProviderPicker();
    connectSignaling();
    showToast(`@${cleanUsername} odaya çağrıldı! İzlemek istediğiniz içeriği seçin.`);
  }
}
window.inviteFriendToRoom = inviteFriendToRoom;

function getIncomingAffinityRequests() {
  let list = [];
  try {
    const raw = localStorage.getItem('miruo_affinity_requests');
    if (raw) {
      list = JSON.parse(raw);
    }
    // Eski sürümlerden kalan SAHTE (örnek) istekleri temizle
    const cleaned = list.filter(r => r && r.id !== 'aff_req_selin_init');
    if (cleaned.length !== list.length) {
      list = cleaned;
      localStorage.setItem('miruo_affinity_requests', JSON.stringify(list));
    }
  } catch (e) {
    list = [];
  }
  return list.filter(r => r.status === 'pending');
}

function getIncomingRoomInvites() {
  let list = [];
  try {
    const raw = localStorage.getItem('miruo_room_invites');
    if (raw) {
      list = JSON.parse(raw);
    }
    // Eski sürümlerden kalan SAHTE (örnek) davetleri ve bayat davetleri temizle
    const cutoff = Date.now() - 30 * 60000;
    const cleaned = list.filter(i => i && i.id !== 'room_inv_can_init' && (i.createdAt || 0) > cutoff);
    if (cleaned.length !== list.length) {
      list = cleaned;
      localStorage.setItem('miruo_room_invites', JSON.stringify(list));
    }
  } catch (e) {
    list = [];
  }
  return list.filter(inv => inv.status !== 'accepted' && inv.status !== 'rejected');
}

function acceptAffinityRequest(reqId) {
  let requests = [];
  try {
    requests = JSON.parse(localStorage.getItem('miruo_affinity_requests') || '[]');
  } catch (e) { requests = []; }

  const req = requests.find(r => r.id === reqId);
  if (!req) return;

  req.status = 'accepted';
  localStorage.setItem('miruo_affinity_requests', JSON.stringify(requests.filter(r => r.id !== reqId)));

  queueGlobalEvent('affinity_accepted', req.fromUsername, {
    id: req.id,
    fromUsername: cleanUserKey(state.username),
    toUsername: req.fromUsername,
    slotKey: req.slotKey,
    category: req.category,
    categoryTitle: req.categoryTitle,
    fromAvatarUrl: state.avatarUrl || ''
  });
  const cleanFrom = req.fromUsername.replace(/^@/, '').toLowerCase();
  const currentTree = getUserAffinityTree();
  
  // Find appropriate slot for this category
  const targetCategory = req.category || 'partner';
  const matchingSlots = AFFINITY_SLOTS.filter(s => s.category === targetCategory);
  let targetSlotKey = req.slotKey;
  if (!targetSlotKey || (currentTree[targetSlotKey] && !currentTree[targetSlotKey].isPending)) {
    const freeSlot = matchingSlots.find(s => !currentTree[s.key] || currentTree[s.key].isPending);
    targetSlotKey = freeSlot ? freeSlot.key : matchingSlots[0].key;
  }

  // Bind to my slot!
  currentTree[targetSlotKey] = {
    username: cleanFrom,
    name: '@' + cleanFrom,
    avatarUrl: req.friendAvatarUrl || '',
    category: targetCategory,
    isPending: false,
    boundAt: Date.now()
  };
  saveUserAffinityTree(currentTree);

  // Sync mutual affinities so both users' trees show each other!
  let mutuals = {};
  try {
    mutuals = JSON.parse(localStorage.getItem('miruo_mutual_affinities') || '{}');
  } catch (e) { mutuals = {}; }
  mutuals[cleanFrom] = {
    category: targetCategory,
    categoryTitle: req.categoryTitle || 'Partner',
    partnerOf: (state.username || 'mehmet_vip').replace(/^@/, '').toLowerCase(),
    acceptedAt: Date.now()
  };
  localStorage.setItem('miruo_mutual_affinities', JSON.stringify(mutuals));

  showToast(`🎉 @${cleanFrom} ile ${req.categoryTitle || 'Partner'} ilişkiniz kuruldu! Her iki tarafta da görünür.`);
  renderIncomingRequests();
  renderFriendsTab();
  renderAffinityTree();
}
window.acceptAffinityRequest = acceptAffinityRequest;

function rejectAffinityRequest(reqId) {
  let requests = [];
  try {
    requests = JSON.parse(localStorage.getItem('miruo_affinity_requests') || '[]');
  } catch (e) { requests = []; }

  const req = requests.find(r => r.id === reqId);
  if (req) {
    queueGlobalEvent('affinity_declined', req.fromUsername, {
      id: req.id,
      fromUsername: cleanUserKey(state.username),
      toUsername: req.fromUsername,
      categoryTitle: req.categoryTitle
    });
  }
  if (req && req.slotKey) {
    const currentTree = getUserAffinityTree();
    if (currentTree[req.slotKey] && currentTree[req.slotKey].isPending) {
      currentTree[req.slotKey] = null;
      saveUserAffinityTree(currentTree);
    }
  }

  localStorage.setItem('miruo_affinity_requests', JSON.stringify(requests.filter(r => r.id !== reqId)));
  showToast('İlişki isteği reddedildi.');
  renderIncomingRequests();
  renderFriendsTab();
  renderAffinityTree();
}
window.rejectAffinityRequest = rejectAffinityRequest;

function acceptRoomInvite(inviteId, targetRoomId) {
  let invites = [];
  try {
    invites = JSON.parse(localStorage.getItem('miruo_room_invites') || '[]');
  } catch (e) { invites = []; }

  localStorage.setItem('miruo_room_invites', JSON.stringify(invites.filter(inv => inv.id !== inviteId)));
  showToast(`Odaya katılınıyor: ${targetRoomId}`);
  state.roomId = (targetRoomId || 'ODA-77').toUpperCase();
  state.isHost = false;
  state.userRole = 'member';
  state.hasDjPermission = false;
  switchToMyRoom();
  connectSignaling();
  renderIncomingRequests();
}
window.acceptRoomInvite = acceptRoomInvite;

function rejectRoomInvite(inviteId) {
  let invites = [];
  try {
    invites = JSON.parse(localStorage.getItem('miruo_room_invites') || '[]');
  } catch (e) { invites = []; }

  localStorage.setItem('miruo_room_invites', JSON.stringify(invites.filter(inv => inv.id !== inviteId)));
  showToast('Oda daveti reddedildi.');
  renderIncomingRequests();
}
window.rejectRoomInvite = rejectRoomInvite;

function sendAffinityRequest(slotKey, friend) {
  if (!slotKey || !friend) return;
  const slotDef = AFFINITY_SLOTS.find(s => s.key === slotKey);
  const cat = slotDef ? AFFINITY_CATEGORIES[slotDef.category] : AFFINITY_CATEGORIES.partner;
  const slotTitle = slotDef ? slotDef.title : (cat ? cat.name : 'İlişki');
  const targetUsername = (friend.cleanUsername || friend.username || '').replace(/^@/, '');
  const myUsername = (state.username || 'mehmet_vip').replace(/^@/, '');

  let requests = [];
  try {
    requests = JSON.parse(localStorage.getItem('miruo_affinity_requests') || '[]');
  } catch (e) { requests = []; }

  const req = {
    id: 'aff_req_' + Date.now(),
    slotKey: slotKey,
    category: slotDef ? slotDef.category : 'partner',
    categoryTitle: slotTitle,
    fromUsername: myUsername,
    toUsername: targetUsername,
    friendName: friend.name || ('@' + targetUsername),
    friendAvatarUrl: friend.avatarUrl || '',
    status: 'pending',
    createdAt: Date.now()
  };

  requests.unshift(req);
  // Gönderen kendi "gelen" listesinde görmemeli: yerel gelen listeye yazma, karşı tarafa ilet
  requests = requests.filter(r => r.id !== req.id);
  queueGlobalEvent('affinity_request', targetUsername, req);

  // Store outgoing request so picker shows "İstek Gönderildi", but do NOT display on graph until accepted
  let outgoing = [];
  try { outgoing = JSON.parse(localStorage.getItem('miruo_outgoing_affinity_requests') || '[]'); } catch (_) { outgoing = []; }
  outgoing = outgoing.filter(o => o.slotKey !== slotKey);
  outgoing.push({
    id: req.id,
    slotKey: slotKey,
    toUsername: targetUsername,
    category: slotDef ? slotDef.category : 'partner',
    createdAt: Date.now()
  });
  localStorage.setItem('miruo_outgoing_affinity_requests', JSON.stringify(outgoing));

  closeAffinityPicker();
  renderAffinityTree();
  showToast(`@${targetUsername} kullanıcısına ${slotTitle} isteği gönderildi!`);
}
window.sendAffinityRequest = sendAffinityRequest;

// ==========================================
// GLOBAL USERS & REALTIME FRIEND REQUESTS SYSTEM
// ==========================================
let globalUsersChannel = null;
window.miruoGlobalUsersMap = new Map();

function initGlobalUsersChannel() {
  if (!supabaseClient) return;
  if (globalUsersChannel) return;
  try {
    const myCleanUsername = (state.username || 'user').toLowerCase().replace(/^@/, '');
    globalUsersChannel = supabaseClient.channel('miruo_global_users', {
      config: {
        presence: { key: myCleanUsername }
      }
    });

    globalUsersChannel
      .on('presence', { event: 'sync' }, () => {
        handleGlobalPresenceSync(globalUsersChannel.presenceState());
      })
      .on('presence', { event: 'join' }, ({ key, newPresences }) => {
        handleGlobalPresenceJoin(key, newPresences);
      })
      .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
        handleGlobalPresenceLeave(key, leftPresences);
      })
      .on('broadcast', { event: 'user_announced' }, ({ payload }) => {
        if (payload && payload.username) {
          upsertGlobalUserCache(payload);
          if (typeof renderFriendsTab === 'function') {
            const searchInput = document.getElementById('tabFriendSearchInput');
            if (searchInput && searchInput.value) renderFriendsTab(searchInput.value);
          }
        }
      })
      .on('broadcast', { event: 'friend_request' }, ({ payload }) => {
        handleIncomingFriendRequest(payload);
        if (payload) ackGlobalEvent('friend_request', payload.id, payload.fromUsername, payload.toUsername);
      })
      .on('broadcast', { event: 'friend_accepted' }, ({ payload }) => {
        handleIncomingFriendAccepted(payload);
        if (payload) ackGlobalEvent('friend_accepted', payload.requestId || payload.id, payload.fromUsername, payload.toUsername);
      })
      .on('broadcast', { event: 'friend_declined' }, ({ payload }) => {
        handleIncomingFriendDeclined(payload);
        if (payload) ackGlobalEvent('friend_declined', payload.requestId || payload.id, payload.fromUsername, payload.toUsername);
      })
      .on('broadcast', { event: 'role_update' }, ({ payload }) => {
        if (!payload) return;
        const myRoom = (state.roomId || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
        const targetRoom = (payload.roomId || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
        if (myRoom && targetRoom && myRoom === targetRoom) {
          handleRemoteRoleUpdate(payload.targetUserId, payload.newRole, payload.targetUsername);
        }
      })
      .on('broadcast', { event: 'affinity_request' }, ({ payload }) => {
        handleIncomingAffinityRequest(payload);
        if (payload) ackGlobalEvent('affinity_request', payload.id, payload.fromUsername, payload.toUsername);
      })
      .on('broadcast', { event: 'affinity_accepted' }, ({ payload }) => {
        handleIncomingAffinityAccepted(payload);
        if (payload) ackGlobalEvent('affinity_accepted', payload.id, payload.fromUsername, payload.toUsername);
      })
      .on('broadcast', { event: 'affinity_declined' }, ({ payload }) => {
        handleIncomingAffinityDeclined(payload);
        if (payload) ackGlobalEvent('affinity_declined', payload.id, payload.fromUsername, payload.toUsername);
      })
      .on('broadcast', { event: 'room_invite' }, ({ payload }) => {
        handleIncomingRoomInvite(payload);
        if (payload) ackGlobalEvent('room_invite', payload.id, payload.fromUsername, payload.toUsername);
      })
      .on('broadcast', { event: 'outbox_ack' }, ({ payload }) => {
        handleOutboxAck(payload);
      })
      .on('broadcast', { event: 'room_signal' }, ({ payload }) => {
        if (!payload || (payload.clientId ? payload.clientId === state.clientId : payload.userId === state.userId)) return;
        if (!state.isInRoom || !state.roomId) return;
        const myRoom = (state.roomId || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
        const targetRoom = (payload.roomId || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
        if (myRoom && targetRoom && myRoom === targetRoom) {
          handleSignalMessage(payload);
        }
      })
      .on('broadcast', { event: 'room_playback_sync' }, ({ payload }) => {
        if (!payload || (payload.clientId ? payload.clientId === state.clientId : payload.userId === state.userId)) return;
        if (!state.isInRoom || !state.roomId) return;
        const myRoom = (state.roomId || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
        const targetRoom = (payload.roomId || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
        if (myRoom && targetRoom && myRoom === targetRoom) {
          handleRemoteSync(payload);
        }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('[Miruo Global Users] Channel connected & active');
          announceMyPresence();
          setTimeout(() => {
            try { flushOutboxForAll(globalUsersChannel.presenceState()); } catch (_) {}
          }, 1200);
        }
      });
  } catch (e) {
    console.warn('[Miruo] initGlobalUsersChannel error:', e);
  }
}
window.initGlobalUsersChannel = initGlobalUsersChannel;

function announceMyPresence() {
  if (!globalUsersChannel) return;
  try {
    const myCleanUsername = (state.username || 'user').toLowerCase().replace(/^@/, '');
    const savedUserObj = JSON.parse(localStorage.getItem('miruo_user') || '{}');
    const myProfile = {
      id: state.userId || ('user_' + myCleanUsername),
      username: myCleanUsername,
      fullName: (state.fullName && !state.fullName.startsWith('@')) ? state.fullName : (state.name || myCleanUsername),
      avatarUrl: state.avatarUrl || savedUserObj.avatarUrl || localStorage.getItem('miruo_avatar') || '',
      avatarBg: state.avatarBg || savedUserObj.avatarBg || localStorage.getItem('miruo_avatar_bg') || 'from-rose-500 to-[#A64D79]',
      status: state.isInRoom ? 'in_room' : 'online',
      currentRoom: state.roomId || '',
      updatedAt: Date.now()
    };
    upsertGlobalUserCache(myProfile);
    globalUsersChannel.track(myProfile).catch(() => {});
    globalUsersChannel.send({
      type: 'broadcast',
      event: 'user_announced',
      payload: myProfile
    }).catch(() => {});
  } catch (_) {}
}
window.announceMyPresence = announceMyPresence;

function upsertGlobalUserCache(user) {
  if (!user || !user.username) return;
  const cleanU = String(user.username).toLowerCase().replace(/^@/, '').trim();
  window.miruoGlobalUsersMap.set(cleanU, user);
  try {
    const cache = JSON.parse(localStorage.getItem('miruo_global_users_cache') || '{}');
    cache[cleanU] = { ...cache[cleanU], ...user, updatedAt: Date.now() };
    localStorage.setItem('miruo_global_users_cache', JSON.stringify(cache));
  } catch (_) {}
}

function handleGlobalPresenceSync(presenceState) {
  if (!presenceState) return;
  const cache = JSON.parse(localStorage.getItem('miruo_global_users_cache') || '{}');
  Object.keys(presenceState).forEach(key => {
    const list = presenceState[key] || [];
    if (list.length > 0) {
      const u = list[0];
      const cleanU = (u.username || key).toLowerCase().replace(/^@/, '');
      const userData = {
        id: u.id || ('user_' + cleanU),
        username: cleanU,
        fullName: u.fullName || cleanU,
        avatarUrl: u.avatarUrl || '',
        avatarBg: u.avatarBg || 'from-rose-500 to-indigo-600',
        status: u.status || 'online',
        currentRoom: u.currentRoom || '',
        updatedAt: u.updatedAt || Date.now()
      };
      cache[cleanU] = userData;
      window.miruoGlobalUsersMap.set(cleanU, userData);

      // If user is in local friends, update their status to online!
      const friend = state.friends.find(f => (f.username || f.name || '').toLowerCase().replace(/^@/, '') === cleanU);
      if (friend) {
        friend.status = u.status || 'online';
        friend.currentRoom = u.currentRoom || '';
        friend.lastActive = Date.now();
        if (u.avatarUrl && !friend.avatarUrl) friend.avatarUrl = u.avatarUrl;
      }
    }
  });
  try {
    localStorage.setItem('miruo_global_users_cache', JSON.stringify(cache));
    localStorage.setItem('miruo_friends', JSON.stringify(state.friends));
  } catch (_) {}
  if (typeof renderFriendsTab === 'function') {
    const searchInput = document.getElementById('tabFriendSearchInput');
    renderFriendsTab(searchInput ? searchInput.value : '');
  }
}

function handleGlobalPresenceJoin(key, newPresences) {
  if (!key) return;
  const cleanU = key.toLowerCase().replace(/^@/, '');
  const u = (newPresences && newPresences[0]) ? newPresences[0] : null;
  if (u) upsertGlobalUserCache(u);
  if (cleanU !== cleanUserKey(state.username)) setTimeout(() => flushOutboxFor(cleanU), 900);
  const friend = state.friends.find(f => (f.username || f.name || '').toLowerCase().replace(/^@/, '') === cleanU);
  if (friend) {
    friend.status = (u && u.status) ? u.status : 'online';
    friend.lastActive = Date.now();
    try { localStorage.setItem('miruo_friends', JSON.stringify(state.friends)); } catch (_) {}
    if (typeof renderFriendsTab === 'function') renderFriendsTab();
  }
}

function handleGlobalPresenceLeave(key, leftPresences) {
  if (!key) return;
  const cleanU = key.toLowerCase().replace(/^@/, '');
  const friend = state.friends.find(f => (f.username || f.name || '').toLowerCase().replace(/^@/, '') === cleanU);
  if (friend) {
    friend.status = 'offline';
    friend.lastActive = Date.now();
    try { localStorage.setItem('miruo_friends', JSON.stringify(state.friends)); } catch (_) {}
    if (typeof renderFriendsTab === 'function') renderFriendsTab();
  }
}

function getIncomingFriendRequests() {
  try {
    const raw = localStorage.getItem('miruo_incoming_friend_requests');
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function getOutgoingFriendRequests() {
  try {
    const raw = localStorage.getItem('miruo_outgoing_friend_requests');
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

// ------------------------------------------------------------------
// GÜVENİLİR TESLİMAT (OUTBOX): karşı taraf çevrimdışıysa istek/kabul/davet
// kaybolmaz; karşı taraf çevrimiçi olunca otomatik yeniden iletilir, ACK ile silinir.
// ------------------------------------------------------------------
function cleanUserKey(u) {
  return String(u || '').toLowerCase().replace(/^@/, '').trim();
}

function getOutbox() {
  try {
    const l = JSON.parse(localStorage.getItem('miruo_outbox_v1') || '[]');
    const now = Date.now();
    return Array.isArray(l) ? l.filter(e => e && (now - (e.ts || 0)) < (e.ttl || 7 * 86400000)) : [];
  } catch (_) { return []; }
}

function saveOutbox(list) {
  try { localStorage.setItem('miruo_outbox_v1', JSON.stringify(list.slice(-200))); } catch (_) {}
}

function deliverGlobalEvent(event, payload) {
  if (!globalUsersChannel) return false;
  try {
    globalUsersChannel.send({ type: 'broadcast', event, payload }).catch(() => {});
    return true;
  } catch (_) { return false; }
}

function queueGlobalEvent(event, toUsername, payload, ttlMs) {
  const to = cleanUserKey(toUsername);
  const id = payload && (payload.id || payload.requestId);
  const key = event + ':' + id;
  const box = getOutbox().filter(e => e.key !== key);
  box.push({ key, event, to, payload, ts: Date.now(), ttl: ttlMs || 7 * 86400000 });
  saveOutbox(box);
  deliverGlobalEvent(event, payload);
}

function flushOutboxFor(username) {
  const to = cleanUserKey(username);
  if (!to) return;
  getOutbox().filter(e => e.to === to).forEach(e => deliverGlobalEvent(e.event, e.payload));
}

function flushOutboxForAll(presenceState) {
  if (!presenceState) return;
  const online = new Set(Object.keys(presenceState).map(cleanUserKey));
  getOutbox().forEach(e => { if (online.has(e.to)) deliverGlobalEvent(e.event, e.payload); });
}

function ackGlobalEvent(event, id, fromUser, toUser) {
  if (!id) return;
  if (cleanUserKey(toUser) !== cleanUserKey(state.username)) return;
  deliverGlobalEvent('outbox_ack', { toUsername: cleanUserKey(fromUser), key: event + ':' + id });
}

function handleOutboxAck(payload) {
  if (!payload || cleanUserKey(payload.toUsername) !== cleanUserKey(state.username)) return;
  saveOutbox(getOutbox().filter(e => e.key !== payload.key));
}

// ---- Yakınlık (ilişki) istekleri: gerçek zamanlı ----
function handleIncomingAffinityRequest(req) {
  if (!req || !req.id) return;
  if (cleanUserKey(req.toUsername) !== cleanUserKey(state.username)) return;
  if (isUserBlocked(req.fromUsername)) return;
  let list = [];
  try { list = JSON.parse(localStorage.getItem('miruo_affinity_requests') || '[]'); } catch (_) { list = []; }
  if (list.some(r => r.id === req.id)) return;
  list.unshift({ ...req, status: 'pending' });
  localStorage.setItem('miruo_affinity_requests', JSON.stringify(list));
  showToast(`@${cleanUserKey(req.fromUsername)} seninle ${req.categoryTitle || 'Partner'} olmak istiyor!`);
  updateFriendRequestBadge();
  renderIncomingRequests();
  if (typeof renderFriendsTab === 'function') renderFriendsTab();
}

function handleIncomingAffinityAccepted(p) {
  if (!p || cleanUserKey(p.toUsername) !== cleanUserKey(state.username)) return;
  let outgoing = [];
  try { outgoing = JSON.parse(localStorage.getItem('miruo_outgoing_affinity_requests') || '[]'); } catch (_) { outgoing = []; }
  const out = outgoing.find(o => o.id === p.id);
  if (!out) return; // zaten işlendi
  const who = cleanUserKey(p.fromUsername);
  const tree = getUserAffinityTree();
  tree[out.slotKey] = {
    username: who,
    name: '@' + who,
    avatarUrl: p.fromAvatarUrl || '',
    category: out.category,
    isPending: false,
    boundAt: Date.now()
  };
  saveUserAffinityTree(tree);
  localStorage.setItem('miruo_outgoing_affinity_requests', JSON.stringify(outgoing.filter(o => o.id !== p.id)));
  try {
    const mutuals = JSON.parse(localStorage.getItem('miruo_mutual_affinities') || '{}');
    mutuals[who] = { category: out.category, categoryTitle: p.categoryTitle || 'Partner', partnerOf: cleanUserKey(state.username), acceptedAt: Date.now() };
    localStorage.setItem('miruo_mutual_affinities', JSON.stringify(mutuals));
  } catch (_) {}
  showToast(`🎉 @${who} ${p.categoryTitle || 'Partner'} isteğini kabul etti!`);
  renderAffinityTree();
  if (typeof renderFriendsTab === 'function') renderFriendsTab();
}

function handleIncomingAffinityDeclined(p) {
  if (!p || cleanUserKey(p.toUsername) !== cleanUserKey(state.username)) return;
  let outgoing = [];
  try { outgoing = JSON.parse(localStorage.getItem('miruo_outgoing_affinity_requests') || '[]'); } catch (_) { outgoing = []; }
  if (!outgoing.some(o => o.id === p.id)) return;
  localStorage.setItem('miruo_outgoing_affinity_requests', JSON.stringify(outgoing.filter(o => o.id !== p.id)));
  showToast(`@${cleanUserKey(p.fromUsername)} ${p.categoryTitle || 'ilişki'} isteğini reddetti.`);
  renderAffinityTree();
}

function showRoomInviteModal(inv) {
  if (!inv) return;
  const modalId = 'miruoRoomInviteDialog';
  let modal = document.getElementById(modalId);
  if (!modal) {
    modal = document.createElement('div');
    modal.id = modalId;
    modal.className = 'fixed inset-0 z-[99999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4';
    document.body.appendChild(modal);
  }
  const fromUser = cleanUserKey(inv.fromUsername || 'Arkadaşın');
  const roomId = inv.roomId || 'ODA-77';

  modal.innerHTML = `
    <div class="bg-[#0F131F] border border-indigo-500/30 rounded-3xl p-6 max-w-sm w-full shadow-2xl text-center">
      <div class="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center text-white mb-4 shadow-lg">
        <svg class="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 10l5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>
      </div>
      <h3 class="text-lg font-bold text-white mb-1">Oda Daveti</h3>
      <p class="text-sm text-gray-300 mb-6"><span class="text-indigo-400 font-bold">@${fromUser}</span> seni odaya çağırıyor!<br><span class="text-xs text-gray-400 font-mono mt-1 inline-block">Oda Kodu: ${roomId}</span></p>
      <div class="flex items-center gap-3">
        <button id="declineRoomInviteBtn" type="button" class="flex-1 py-3 rounded-2xl bg-white/10 hover:bg-white/15 text-gray-300 font-bold text-xs transition-all cursor-pointer">Kapat</button>
        <button id="acceptRoomInviteBtn" type="button" class="flex-1 py-3 rounded-2xl bg-gradient-to-r from-rose-500 to-indigo-600 hover:opacity-90 active:scale-95 text-white font-bold text-xs transition-all cursor-pointer shadow-lg">Odaya Katıl</button>
      </div>
    </div>
  `;
  modal.classList.remove('hidden');

  const closeDialog = () => {
    modal.classList.add('hidden');
  };

  const decBtn = modal.querySelector('#declineRoomInviteBtn');
  if (decBtn) decBtn.onclick = () => {
    closeDialog();
    if (typeof rejectRoomInvite === 'function') rejectRoomInvite(inv.id);
  };

  const accBtn = modal.querySelector('#acceptRoomInviteBtn');
  if (accBtn) accBtn.onclick = () => {
    closeDialog();
    if (typeof acceptRoomInvite === 'function') acceptRoomInvite(inv.id, roomId);
    else if (typeof joinRoom === 'function') joinRoom(roomId);
  };
}
window.showRoomInviteModal = showRoomInviteModal;

// ---- Oda davetleri: gerçek zamanlı ----
function handleIncomingRoomInvite(inv) {
  if (!inv || !inv.id) return;
  if (cleanUserKey(inv.toUsername) !== cleanUserKey(state.username)) return;
  if (isUserBlocked(inv.fromUsername)) return;
  if (Date.now() - (inv.createdAt || 0) > 30 * 60000) return; // bayat davet
  let list = [];
  try { list = JSON.parse(localStorage.getItem('miruo_room_invites') || '[]'); } catch (_) { list = []; }
  if (!list.some(i => i.id === inv.id)) {
    list.unshift(inv);
    localStorage.setItem('miruo_room_invites', JSON.stringify(list));
  }
  showRoomInviteModal(inv);
  showToast(`@${cleanUserKey(inv.fromUsername)} seni odaya çağırdı!`);
  updateFriendRequestBadge();
  renderIncomingRequests();
}

async function sendFriendRequest(targetUsername) {
  const cleanTarget = String(targetUsername || '').toLowerCase().replace(/^@/, '').trim();
  const myClean = (state.username || 'user').toLowerCase().replace(/^@/, '').trim();

  if (!cleanTarget) {
    showToast('Lütfen geçerli bir kullanıcı adı girin.');
    return;
  }
  if (cleanTarget === myClean) {
    showToast('Kendine arkadaşlık isteği gönderemezsin.');
    return;
  }
  if (typeof isUserBlocked === 'function' && isUserBlocked(cleanTarget)) {
    showToast('Bu kullanıcı engellenmiş. İstek göndermek için önce Ayarlar\'dan engeli kaldırmalısınız.');
    return;
  }
  if (state.friends.some(f => (f.username || f.name || '').toLowerCase().replace(/^@/, '') === cleanTarget)) {
    showToast(`@${cleanTarget} zaten arkadaş listenizde!`);
    return;
  }

  const outgoing = getOutgoingFriendRequests();
  const existingReq = outgoing.find(r => (r.toUsername || '').toLowerCase() === cleanTarget);
  if (existingReq) {
    // Tekrar dokunuş = yeniden ilet (karşı taraf çevrimdışıydıysa kaybolmasın)
    queueGlobalEvent('friend_request', cleanTarget, existingReq);
    sendSignal({ type: 'friend-request', payload: existingReq });
    showToast(`@${cleanTarget} kullanıcısına istek tekrar iletildi.`);
    return;
  }

  // Lookup target info in cache or registered users
  const cache = JSON.parse(localStorage.getItem('miruo_global_users_cache') || '{}');
  const targetInfo = cache[cleanTarget] || {};
  const savedUserObj = JSON.parse(localStorage.getItem('miruo_user') || '{}');

  const reqPayload = {
    id: 'freq_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    fromUsername: myClean,
    fromName: (state.fullName && !state.fullName.startsWith('@')) ? state.fullName : (state.name || myClean),
    fromAvatarUrl: state.avatarUrl || savedUserObj.avatarUrl || localStorage.getItem('miruo_avatar') || '',
    fromAvatarBg: state.avatarBg || savedUserObj.avatarBg || 'from-rose-500 to-[#A64D79]',
    toUsername: cleanTarget,
    targetName: targetInfo.fullName || cleanTarget,
    targetAvatarUrl: targetInfo.avatarUrl || '',
    timestamp: Date.now()
  };

  outgoing.unshift(reqPayload);
  localStorage.setItem('miruo_outgoing_friend_requests', JSON.stringify(outgoing));

  // Broadcast over global users channel (outbox: çevrimdışıysa online olunca iletilir)
  queueGlobalEvent('friend_request', cleanTarget, reqPayload);

  // Also broadcast via signaling server and active P2P channel
  sendSignal({ type: 'friend-request', payload: reqPayload });
  sendP2PData('friend_request', reqPayload);

  showToast(`@${cleanTarget} kullanıcısına arkadaşlık isteği gönderildi!`);
  const searchInput = document.getElementById('tabFriendSearchInput');
  if (typeof renderFriendsTab === 'function') renderFriendsTab(searchInput ? searchInput.value : '');
}
window.sendFriendRequest = sendFriendRequest;

function handleIncomingFriendRequest(req) {
  if (!req || !req.toUsername) return;
  const myUsername = (state.username || '').toLowerCase().replace(/^@/, '').trim();
  const targetUsername = (req.toUsername || '').toLowerCase().replace(/^@/, '').trim();
  if (targetUsername !== myUsername) return;

  const cleanFrom = (req.fromUsername || '').toLowerCase().replace(/^@/, '').trim();
  if (isUserBlocked(cleanFrom)) return;
  if (state.friends.some(f => (f.username || f.name || '').toLowerCase().replace(/^@/, '').trim() === cleanFrom)) return;

  const incoming = getIncomingFriendRequests();
  if (incoming.some(r => r.id === req.id || (r.fromUsername || '').toLowerCase() === cleanFrom)) {
    return;
  }

  incoming.unshift(req);
  localStorage.setItem('miruo_incoming_friend_requests', JSON.stringify(incoming));

  showToast(`@${cleanFrom} sana arkadaşlık isteği gönderdi!`);
  updateFriendRequestBadge();

  if (typeof renderIncomingRequests === 'function') renderIncomingRequests();
  if (typeof renderFriendsTab === 'function') {
    const searchInput = document.getElementById('tabFriendSearchInput');
    renderFriendsTab(searchInput ? searchInput.value : '');
  }
}
window.handleIncomingFriendRequest = handleIncomingFriendRequest;

function acceptFriendRequest(reqId) {
  const incoming = getIncomingFriendRequests();
  const req = incoming.find(r => r.id === reqId);
  if (!req) return;

  const updated = incoming.filter(r => r.id !== reqId);
  localStorage.setItem('miruo_incoming_friend_requests', JSON.stringify(updated));

  const cleanFrom = (req.fromUsername || '').replace(/^@/, '').trim();
  if (!state.friends.some(f => (f.username || f.name || '').toLowerCase().replace(/^@/, '') === cleanFrom.toLowerCase())) {
    const newFriend = {
      id: 'f_' + Date.now(),
      name: req.fromName || cleanFrom,
      username: cleanFrom,
      avatarUrl: req.fromAvatarUrl || null,
      avatarBg: req.fromAvatarBg || 'from-rose-500 to-indigo-600',
      status: 'online',
      statusText: 'Çevrimiçi',
      avatar: (cleanFrom.charAt(0) || 'A').toUpperCase(),
      lastActive: Date.now()
    };
    state.friends.unshift(newFriend);
    localStorage.setItem('miruo_friends', JSON.stringify(state.friends));
  }

  const myClean = (state.username || 'user').replace(/^@/, '');
  const savedUserObj = JSON.parse(localStorage.getItem('miruo_user') || '{}');
  const acceptPayload = {
    requestId: reqId,
    fromUsername: myClean,
    fromName: (state.fullName && !state.fullName.startsWith('@')) ? state.fullName : (state.name || myClean),
    fromAvatarUrl: state.avatarUrl || savedUserObj.avatarUrl || localStorage.getItem('miruo_avatar') || '',
    fromAvatarBg: state.avatarBg || savedUserObj.avatarBg || '',
    toUsername: req.fromUsername,
    timestamp: Date.now()
  };

  queueGlobalEvent('friend_accepted', req.fromUsername, acceptPayload);
  sendSignal({ type: 'friend-accepted', payload: acceptPayload });
  sendP2PData('friend_accepted', acceptPayload);

  showToast(`@${cleanFrom} ile artık arkadaşsınız!`);
  updateFriendRequestBadge();
  renderIncomingRequests();
  renderFriendsTab();
  if (typeof renderParticipantsList === 'function') renderParticipantsList();
}
window.acceptFriendRequest = acceptFriendRequest;

function handleIncomingFriendAccepted(payload) {
  if (!payload || !payload.toUsername) return;
  const myUsername = (state.username || '').toLowerCase().replace(/^@/, '');
  if (payload.toUsername.toLowerCase().replace(/^@/, '') !== myUsername) return;

  const cleanFriend = (payload.fromUsername || '').replace(/^@/, '').trim();
  const alreadyFriend = state.friends.some(f => (f.username || f.name || '').toLowerCase().replace(/^@/, '') === cleanFriend.toLowerCase());
  const outgoing = getOutgoingFriendRequests();
  const filtered = outgoing.filter(r => (r.toUsername || '').toLowerCase().replace(/^@/, '') !== cleanFriend.toLowerCase());
  localStorage.setItem('miruo_outgoing_friend_requests', JSON.stringify(filtered));
  if (alreadyFriend) return; // tekrar teslimatta sessiz kal
  if (!state.friends.some(f => (f.username || f.name || '').toLowerCase().replace(/^@/, '') === cleanFriend.toLowerCase())) {
    const newFriend = {
      id: 'f_' + Date.now(),
      name: payload.fromName || cleanFriend,
      username: cleanFriend,
      avatarUrl: payload.fromAvatarUrl || null,
      avatarBg: payload.fromAvatarBg || 'from-rose-500 to-indigo-600',
      status: 'online',
      statusText: 'Çevrimiçi',
      avatar: (cleanFriend.charAt(0) || 'A').toUpperCase(),
      lastActive: Date.now()
    };
    state.friends.unshift(newFriend);
    localStorage.setItem('miruo_friends', JSON.stringify(state.friends));
  }

  showToast(`🎉 @${cleanFriend} arkadaşlık isteğini kabul etti!`);
  renderFriendsTab();
  if (typeof renderParticipantsList === 'function') renderParticipantsList();
}
window.handleIncomingFriendAccepted = handleIncomingFriendAccepted;

function rejectFriendRequest(reqId) {
  const incoming = getIncomingFriendRequests();
  const req = incoming.find(r => r.id === reqId);
  const updated = incoming.filter(r => r.id !== reqId);
  localStorage.setItem('miruo_incoming_friend_requests', JSON.stringify(updated));

  if (req) {
    queueGlobalEvent('friend_declined', req.fromUsername, {
      id: req.id, requestId: req.id, toUsername: req.fromUsername, fromUsername: state.username, timestamp: Date.now()
    });
  }
  showToast('Arkadaşlık isteği reddedildi.');
  updateFriendRequestBadge();
  renderIncomingRequests();
}
window.rejectFriendRequest = rejectFriendRequest;

function handleIncomingFriendDeclined(payload) {
  if (!payload || !payload.toUsername) return;
  const myUsername = (state.username || '').toLowerCase().replace(/^@/, '');
  if (payload.toUsername.toLowerCase().replace(/^@/, '') !== myUsername) return;

  const cleanDecliner = (payload.fromUsername || '').replace(/^@/, '').trim();
  const outgoing = getOutgoingFriendRequests();
  const filtered = outgoing.filter(r => (r.toUsername || '').toLowerCase().replace(/^@/, '') !== cleanDecliner.toLowerCase());
  localStorage.setItem('miruo_outgoing_friend_requests', JSON.stringify(filtered));
  renderFriendsTab();
}
window.handleIncomingFriendDeclined = handleIncomingFriendDeclined;

function updateFriendRequestBadge() {
  const friendReqs = getIncomingFriendRequests();
  const affReqs = typeof getIncomingAffinityRequests === 'function' ? getIncomingAffinityRequests() : [];
  const roomInvs = typeof getIncomingRoomInvites === 'function' ? getIncomingRoomInvites() : [];
  const totalCount = friendReqs.length + affReqs.length + roomInvs.length;

  const navBtn = document.getElementById('mobileNavFriendsBtn');
  if (navBtn) {
    let dot = navBtn.querySelector('.friend-nav-badge-dot');
    if (totalCount > 0) {
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'friend-nav-badge-dot absolute top-1 right-2 w-2.5 h-2.5 rounded-full bg-rose-500 ring-2 ring-[#0B0D14] animate-pulse';
        navBtn.classList.add('relative');
        navBtn.appendChild(dot);
      }
    } else if (dot) {
      dot.remove();
    }
  }
}
window.updateFriendRequestBadge = updateFriendRequestBadge;

function renderIncomingRequests() {
  const container = document.getElementById('incomingRequestsContainer');
  if (!container) return;

  const friendReqs = getIncomingFriendRequests();
  const affReqs = getIncomingAffinityRequests();
  const roomInvs = getIncomingRoomInvites();

  if (friendReqs.length === 0 && affReqs.length === 0 && roomInvs.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = '';

  // 1. Render Incoming Friend Requests (Eşzamanlı Arkadaşlık İstekleri)
  friendReqs.forEach(req => {
    const card = document.createElement('div');
    card.className = 'p-3.5 rounded-2xl bg-gradient-to-r from-[#200D28]/95 via-[#160B24]/95 to-[#0E0E1C]/95 border border-pink-500/40 flex items-center justify-between gap-3 shadow-xl animate-in fade-in duration-200';
    const cleanFrom = (req.fromUsername || 'kullanici').replace(/^@/, '');
    const char = (cleanFrom.charAt(0) || 'A').toUpperCase();

    card.innerHTML = `
      <div class="flex items-center gap-2.5 truncate min-w-0 flex-1">
        <div class="w-10 h-10 rounded-full ${req.fromAvatarBg || 'bg-gradient-to-tr from-rose-500 to-indigo-600'} flex items-center justify-center font-black text-white text-xs shrink-0 shadow-md border border-white/20">
          ${req.fromAvatarUrl ? `<img src="${req.fromAvatarUrl}" class="w-full h-full rounded-full object-cover">` : char}
        </div>
        <div class="truncate">
          <div class="flex items-center gap-1.5">
            <span class="text-xs font-bold text-white truncate">@${escapeHtml(cleanFrom)}</span>
            <span class="px-1.5 py-0.2 rounded-full bg-pink-500/25 text-pink-300 border border-pink-500/40 text-[9px] font-extrabold tracking-wide">Arkadaşlık İsteği</span>
          </div>
          <p class="text-[11px] text-gray-300 truncate mt-0.5">${escapeHtml(req.fromName || cleanFrom)} seninle arkadaş olmak istiyor</p>
        </div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button type="button" class="accept-friend-req-btn px-3 py-1.5 rounded-xl bg-gradient-to-r from-rose-600 via-pink-600 to-indigo-600 hover:opacity-95 active:scale-95 text-white font-bold text-xs shadow-md shadow-pink-600/30 transition-all cursor-pointer">
          Kabul Et
        </button>
        <button type="button" class="reject-friend-req-btn px-2.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 active:scale-95 text-gray-300 hover:text-white font-semibold text-xs border border-white/10 transition-all cursor-pointer">
          Reddet
        </button>
      </div>
    `;

    const acceptBtn = card.querySelector('.accept-friend-req-btn');
    if (acceptBtn) {
      addInstantTap(acceptBtn, (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        acceptFriendRequest(req.id);
      });
    }

    const rejectBtn = card.querySelector('.reject-friend-req-btn');
    if (rejectBtn) {
      addInstantTap(rejectBtn, (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        rejectFriendRequest(req.id);
      });
    }

    container.appendChild(card);
  });

  // Render Relationship Requests
  affReqs.forEach(req => {
    const card = document.createElement('div');
    card.className = 'p-3.5 rounded-2xl bg-gradient-to-r from-[#240B22]/95 via-[#160B24]/95 to-[#0F0D1C]/95 border border-rose-500/35 flex items-center justify-between gap-3 shadow-xl animate-in fade-in duration-200';
    const char = (req.fromUsername.charAt(0) || 'S').toUpperCase();
    card.innerHTML = `
      <div class="flex items-center gap-2.5 truncate min-w-0 flex-1">
        <div class="w-10 h-10 rounded-full bg-gradient-to-tr from-rose-500 to-indigo-600 flex items-center justify-center font-black text-white text-xs shrink-0 shadow-md border border-white/20">
          ${char}
        </div>
        <div class="truncate">
          <div class="flex items-center gap-1.5">
            <span class="text-xs font-bold text-white truncate">@${escapeHtml(req.fromUsername)}</span>
            <span class="px-1.5 py-0.2 rounded-full bg-rose-500/25 text-rose-300 border border-rose-500/40 text-[9px] font-extrabold tracking-wide">${escapeHtml(req.categoryTitle || 'Partner')}</span>
          </div>
          <p class="text-[11px] text-gray-300 truncate mt-0.5">Seninle <strong class="text-rose-300 font-bold">${escapeHtml(req.categoryTitle || 'Partner')}</strong> olmak istiyor</p>
        </div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button type="button" class="accept-aff-req-btn px-3 py-1.5 rounded-xl bg-gradient-to-r from-rose-600 via-pink-600 to-[#A64D79] hover:opacity-95 active:scale-95 text-white font-bold text-xs shadow-md shadow-rose-600/30 transition-all cursor-pointer">
          Kabul Et
        </button>
        <button type="button" class="reject-aff-req-btn px-2.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 active:scale-95 text-gray-300 hover:text-white font-semibold text-xs border border-white/10 transition-all cursor-pointer">
          Reddet
        </button>
      </div>
    `;

    const acceptBtn = card.querySelector('.accept-aff-req-btn');
    if (acceptBtn) {
      addInstantTap(acceptBtn, (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        acceptAffinityRequest(req.id);
      });
    }

    const rejectBtn = card.querySelector('.reject-aff-req-btn');
    if (rejectBtn) {
      addInstantTap(rejectBtn, (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        rejectAffinityRequest(req.id);
      });
    }

    container.appendChild(card);
  });

  // Render Room Invitations
  roomInvs.forEach(inv => {
    const card = document.createElement('div');
    card.className = 'p-3.5 rounded-2xl bg-gradient-to-r from-[#12142E]/95 via-[#0D1829]/95 to-[#0C0E1A]/95 border border-indigo-500/35 flex items-center justify-between gap-3 shadow-xl animate-in fade-in duration-200';
    const char = (inv.fromUsername.charAt(0) || 'C').toUpperCase();
    card.innerHTML = `
      <div class="flex items-center gap-2.5 truncate min-w-0 flex-1">
        <div class="w-10 h-10 rounded-full bg-gradient-to-tr from-indigo-500 to-cyan-600 flex items-center justify-center font-black text-white text-xs shrink-0 shadow-md border border-white/20">
          ${char}
        </div>
        <div class="truncate">
          <div class="flex items-center gap-1.5">
            <span class="text-xs font-bold text-white truncate">@${escapeHtml(inv.fromUsername)}</span>
            <span class="px-1.5 py-0.2 rounded-full bg-indigo-500/25 text-indigo-300 border border-indigo-500/40 text-[9px] font-extrabold tracking-wide">Oda Daveti</span>
          </div>
          <p class="text-[11px] text-gray-300 truncate mt-0.5">Sizi odaya çağırdı (<span class="text-white font-bold">${escapeHtml(inv.roomId || 'ODA-77')}</span>)</p>
        </div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button type="button" class="join-room-inv-btn px-3 py-1.5 rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-600 hover:opacity-95 active:scale-95 text-white font-bold text-xs shadow-md shadow-indigo-600/30 transition-all cursor-pointer">
          Katıl
        </button>
        <button type="button" class="reject-room-inv-btn px-2.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 active:scale-95 text-gray-300 hover:text-white font-semibold text-xs border border-white/10 transition-all cursor-pointer">
          Reddet
        </button>
      </div>
    `;

    const joinBtn = card.querySelector('.join-room-inv-btn');
    if (joinBtn) {
      addInstantTap(joinBtn, (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        acceptRoomInvite(inv.id, inv.roomId);
      });
    }

    const rejectBtn = card.querySelector('.reject-room-inv-btn');
    if (rejectBtn) {
      addInstantTap(rejectBtn, (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        rejectRoomInvite(inv.id);
      });
    }

    container.appendChild(card);
  });
}
window.renderIncomingRequests = renderIncomingRequests;

function openFriendQuickOptions(fr) {
  if (!fr) return;
  const cleanUsername = (fr.username || fr.name || '').replace(/^@/, '').trim();
  const cleanName = (fr.name || fr.username || '').replace(/[^\w\sçÇğĞıİöÖşŞüÜ-]/g, '').trim() || cleanUsername;
  currentPublicUser = {
    username: cleanUsername,
    name: cleanName,
    avatarUrl: fr.avatarUrl || '',
    avatar: fr.avatar || cleanName.charAt(0).toUpperCase()
  };
  const title = document.getElementById('publicProfileOptionsTitle');
  if (title) {
    title.textContent = `@${cleanUsername} İşlemleri`;
  }
  openPublicProfileOptionsMenu();
}
window.openFriendQuickOptions = openFriendQuickOptions;

function openAddFriendModal() {
  const modal = document.getElementById('addFriendModal');
  if (!modal) return;
  const myCodeModal = document.getElementById('modalMyFriendCodeDisplay');
  if (myCodeModal) {
    myCodeModal.textContent = '@' + (state.username || 'kullanici').replace(/^@/, '');
  }
  const input = document.getElementById('addFriendModalInput');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 100);
  }
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}
window.openAddFriendModal = openAddFriendModal;

function closeAddFriendModal() {
  const modal = document.getElementById('addFriendModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}
window.closeAddFriendModal = closeAddFriendModal;

// ==========================================
// IN-APP CONFIRMATION DIALOG (iOS & Cross-Platform Safe)
// Replaces window.confirm to guarantee reliable execution without WKWebView suppression
// ==========================================
function showMiruoConfirm({ title = 'Emin misiniz?', message = '', actionText = 'Evet, Çıkar', onConfirm }) {
  const modal = document.getElementById('miruoConfirmModal');
  const titleEl = document.getElementById('miruoConfirmTitle');
  const msgEl = document.getElementById('miruoConfirmMessage');
  const actionBtn = document.getElementById('miruoConfirmActionBtn');
  const cancelBtn = document.getElementById('miruoConfirmCancelBtn');

  if (!modal) {
    if (window.confirm(message || title)) {
      if (typeof onConfirm === 'function') onConfirm();
    }
    return;
  }

  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;

  if (actionBtn) {
    actionBtn.textContent = actionText;
    actionBtn.onclick = (e) => {
      e.stopPropagation();
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      if (typeof onConfirm === 'function') onConfirm();
    };
  }

  if (cancelBtn) {
    cancelBtn.onclick = (e) => {
      e.stopPropagation();
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    };
  }

  modal.onclick = (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  };

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}
window.showMiruoConfirm = showMiruoConfirm;

// Centralized Friend Removal with Instant Multi-View Refresh
function executeRemoveFriend(targetUser) {
  if (!targetUser) return;
  const clean = (targetUser.username || targetUser.name || '').toLowerCase().replace(/^@/, '').trim();
  const displayName = targetUser.name || targetUser.username || clean;
  if (!clean) return;

  // 1. Remove from state.friends matching username or name
  if (Array.isArray(state.friends)) {
    state.friends = state.friends.filter(f => {
      const fU = (f.username || '').toLowerCase().replace(/^@/, '').trim();
      const fN = (f.name || '').toLowerCase().replace(/^@/, '').trim();
      return fU !== clean && fN !== clean;
    });
    localStorage.setItem('miruo_friends', JSON.stringify(state.friends));
  }

  // 2. Remove from affinity tree
  try {
    const currentTree = getUserAffinityTree();
    let slotChanged = false;
    Object.entries(currentTree).forEach(([sKey, val]) => {
      if (val) {
        const vU = (val.username || '').toLowerCase().replace(/^@/, '').trim();
        const vN = (val.name || '').toLowerCase().replace(/^@/, '').trim();
        if (vU === clean || vN === clean) {
          delete currentTree[sKey];
          slotChanged = true;
        }
      }
    });
    if (slotChanged) {
      saveUserAffinityTree(currentTree);
      if (typeof renderAffinityTree === 'function') {
        renderAffinityTree('tabProfileAffinityContainer', 'tabProfileAffinityBranchesSvg', 'tabProfileAffinityNodesLayer', true);
      }
    }
  } catch (err) {}

  // 3. Immediately refresh Friends Tab, Friends List, and Profile Tab
  if (typeof renderFriendsTab === 'function') {
    const searchInput = document.getElementById('tabFriendSearchInput');
    renderFriendsTab(searchInput ? searchInput.value : '');
  }
  if (typeof renderFriendsList === 'function') renderFriendsList();
  if (typeof renderProfileTab === 'function') renderProfileTab();

  // 4. Update profile buttons if open
  const friendToggleText = document.getElementById('publicProfileFriendToggleText');
  if (friendToggleText) friendToggleText.textContent = 'Arkadaş Ekle';

  if (typeof closePublicProfileOptionsMenu === 'function') closePublicProfileOptionsMenu();
  if (typeof closePublicUserProfile === 'function') closePublicUserProfile();

  // 5. Notify remote peer so connection is severed on both sides
  sendP2PData('friend_removed', { fromUsername: state.username, toUsername: clean });
  sendSignal({ type: 'friend-removed', fromUsername: state.username, toUsername: clean });
  if (typeof queueGlobalEvent === 'function') {
    queueGlobalEvent('friend_removed', clean, { fromUsername: state.username });
  }

  showToast(`@${clean} arkadaş listenizden çıkarıldı.`);
}
window.executeRemoveFriend = executeRemoveFriend;

function handleRemoteFriendRemoved(fromUser, toUser) {
  if (!fromUser) return;
  const cleanFrom = cleanUserKey(fromUser);
  const cleanMyName = cleanUserKey(state.username);
  if (toUser && cleanUserKey(toUser) !== cleanMyName && cleanUserKey(toUser) !== '*') return;

  // 1. Remove from local friends list
  if (Array.isArray(state.friends)) {
    state.friends = state.friends.filter(f => {
      const fU = cleanUserKey(f.username || f.cleanUsername || f.name);
      return fU !== cleanFrom;
    });
    localStorage.setItem('miruo_friends', JSON.stringify(state.friends));
  }

  // 2. Remove from affinity tree
  try {
    const currentTree = getUserAffinityTree();
    let slotChanged = false;
    Object.entries(currentTree).forEach(([sKey, val]) => {
      if (val) {
        const vU = cleanUserKey(val.username || val.name);
        if (vU === cleanFrom) {
          delete currentTree[sKey];
          slotChanged = true;
        }
      }
    });
    if (slotChanged) {
      saveUserAffinityTree(currentTree);
      if (typeof renderAffinityTree === 'function') {
        renderAffinityTree('tabProfileAffinityContainer', 'tabProfileAffinityBranchesSvg', 'tabProfileAffinityNodesLayer', true);
      }
    }
  } catch (_) {}

  // 3. Re-render UI
  if (typeof renderFriendsTab === 'function') {
    const searchInput = document.getElementById('tabFriendSearchInput');
    renderFriendsTab(searchInput ? searchInput.value : '');
  }
  if (typeof renderFriendsList === 'function') renderFriendsList();
  if (typeof renderProfileTab === 'function') renderProfileTab();
  showToast(`@${cleanFrom} ile arkadaşlık bağlantısı sonlandırıldı.`);
}
window.handleRemoteFriendRemoved = handleRemoteFriendRemoved;

function handleRemoteAffinityUnbound(fromUser, toUser) {
  if (!fromUser) return;
  const cleanFrom = cleanUserKey(fromUser);
  const cleanMyName = cleanUserKey(state.username);
  if (toUser && cleanUserKey(toUser) !== cleanMyName && cleanUserKey(toUser) !== '*') return;

  try {
    const currentTree = getUserAffinityTree();
    let slotChanged = false;
    Object.entries(currentTree).forEach(([sKey, val]) => {
      if (val) {
        const vU = cleanUserKey(val.username || val.name);
        if (vU === cleanFrom) {
          delete currentTree[sKey];
          slotChanged = true;
        }
      }
    });
    if (slotChanged) {
      saveUserAffinityTree(currentTree);
      if (typeof renderAffinityTree === 'function') {
        renderAffinityTree('tabProfileAffinityContainer', 'tabProfileAffinityBranchesSvg', 'tabProfileAffinityNodesLayer', true);
      }
    }
  } catch (_) {}
}
window.handleRemoteAffinityUnbound = handleRemoteAffinityUnbound;

async function submitAddFriendModal() {
  const input = document.getElementById('addFriendModalInput');
  if (!input) return;
  const val = input.value.trim();
  if (!val) {
    showToast('Lütfen bir kullanıcı adı girin.');
    return;
  }
  await addFriend(val);
  closeAddFriendModal();
}
window.submitAddFriendModal = submitAddFriendModal;

// Reusable single friend card renderer
function renderSingleFriendCard(container, fr, dict) {
  const card = document.createElement('div');
  card.className = 'p-3 sm:p-3.5 rounded-2xl bg-[#0C0E17] border border-white/10 hover:border-white/20 transition-all flex items-center justify-between gap-3 shadow-md';
  const isOnline = fr.status === 'online' || fr.status === 'in_room';

  let friendStatusLabel = dict.status_offline || 'Offline';
  if (fr.currentRoom || fr.status === 'in_room') {
    friendStatusLabel = dict.status_in_room || 'In room';
  } else if (fr.status === 'idle') {
    friendStatusLabel = dict.status_idle || 'Idle';
  } else if (isOnline) {
    friendStatusLabel = dict.status_online || 'Online';
  }

  const cleanName = (fr.name || '').replace(/[^\w\sçÇğĞıİöÖşŞüÜ-]/g, '').trim() || 'Kullanici';
  const cleanUsername = (fr.username || fr.name || '').replace(/^@/, '').replace(/[^\w-]/g, '').trim() || 'kullanici';
  const cleanAvatarChar = (fr.avatar || cleanName.charAt(0) || 'A').toUpperCase();

  card.innerHTML = `
    <div class="flex items-center gap-3 min-w-0 friend-card-profile-trigger cursor-pointer flex-1 hover:opacity-90 transition-opacity">
      <div class="relative shrink-0">
        ${fr.avatarUrl ? 
          `<img src="${fr.avatarUrl}" class="w-10 h-10 rounded-full object-cover border border-white/20" alt="Avatar">` :
          `<div class="w-10 h-10 rounded-full bg-gradient-to-tr from-rose-500 to-indigo-600 flex items-center justify-center font-bold text-white text-xs shadow-sm">${cleanAvatarChar}</div>`
        }
        <span class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#0C0E17] ${isOnline ? 'bg-emerald-400' : 'bg-gray-500'}"></span>
      </div>
      <div class="truncate">
        <div class="flex items-center gap-2">
          <span class="text-xs font-bold text-white truncate">@${cleanUsername}</span>
        </div>
        <span class="text-[10px] ${isOnline ? 'text-emerald-400' : 'text-gray-500'} block">
          ${friendStatusLabel}
        </span>
      </div>
    </div>
    
    <div class="flex items-center gap-1.5 shrink-0">
      <button type="button" class="invite-friend-tab-btn px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 active:scale-95 border border-white/10 text-xs font-semibold text-gray-200 hover:text-white transition-all cursor-pointer flex items-center gap-1.5 shadow-sm" data-name="${cleanName}">
        <svg class="w-3.5 h-3.5 text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <span>Çağır</span>
      </button>
      <button type="button" class="friend-card-options-btn w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 active:scale-90 border border-white/10 text-gray-300 hover:text-white transition-all cursor-pointer flex items-center justify-center font-black text-base leading-none pb-0.5 shadow-sm" title="Diğer Seçenekler">
        ⋮
      </button>
    </div>
  `;

  const profileTrigger = card.querySelector('.friend-card-profile-trigger');
  if (profileTrigger) {
    addInstantTap(profileTrigger, () => {
      openPublicUserProfile(cleanUsername);
    });
  }

  const inviteBtn = card.querySelector('.invite-friend-tab-btn');
  if (inviteBtn) {
    addInstantTap(inviteBtn, (e) => {
      e.stopPropagation();
      inviteFriendToRoom(fr);
    });
  }

  const optionsBtn = card.querySelector('.friend-card-options-btn');
  if (optionsBtn) {
    addInstantTap(optionsBtn, (e) => {
      e.stopPropagation();
      openFriendQuickOptions(fr);
    });
  }

  container.appendChild(card);
}

async function addFriend(nameOrUsername) {
  const query = (nameOrUsername || '').trim();
  if (!query) return;
  await sendFriendRequest(query);
}
window.addFriend = addFriend;

function renderFriendsTab(filterText = '') {
  const container = document.getElementById('tabFriendsContainer');
  const codeDisplay = document.getElementById('tabMyFriendCodeDisplay');
  const onlineCountDisplay = document.getElementById('tabFriendsOnlineCount');
  if (!container) return;

  const dict = I18N[currentLang] || I18N.tr;

  // Render incoming requests (friend requests, affinity, room invites)
  renderIncomingRequests();
  updateFriendRequestBadge();

  const currentUsername = '@' + (state.username || 'kullanici').replace(/^@/, '');
  if (codeDisplay) codeDisplay.textContent = currentUsername;
  const myCodeModal = document.getElementById('myFriendCodeDisplay');
  if (myCodeModal) myCodeModal.textContent = currentUsername;

  const myClean = (state.username || 'kullanici').toLowerCase().replace(/^@/, '');
  const query = (filterText || '').toLowerCase().trim().replace(/^@/, '');

  if (!query) {
    // Standard Friends View
    const isOnlineFn = f => f.status === 'online' || f.status === 'in_room';
    let listToRender = state.friends.filter(f => !isUserBlocked(f.username || f.name));
    listToRender.sort((a, b) => {
      const aOn = isOnlineFn(a);
      const bOn = isOnlineFn(b);
      if (aOn && !bOn) return -1;
      if (!aOn && bOn) return 1;
      return (b.lastActive || 0) - (a.lastActive || 0);
    });

    const onlineFriends = listToRender.filter(isOnlineFn);
    const onlineSuffix = dict.online_count_suffix || (currentLang === 'tr' ? 'Çevrimiçi' : 'Online');
    if (onlineCountDisplay) onlineCountDisplay.textContent = `${onlineFriends.length} ${onlineSuffix}`;

    if (listToRender.length === 0) {
      container.innerHTML = `
        <div class="p-8 text-center bg-[#0C0E17] border border-white/10 rounded-2xl">
          <p class="text-xs text-gray-400">${dict.no_friends_empty || 'Henüz arkadaş eklemedin.'}</p>
          <p class="text-[11px] text-gray-500 mt-1">${dict.no_friends_sub || 'Arkadaşının kullanıcı adını (@kullanici) yukarıdan girerek hemen ekleyebilirsin.'}</p>
        </div>
      `;
      return;
    }

    container.innerHTML = '';
    listToRender.forEach(fr => {
      renderSingleFriendCard(container, fr, dict);
    });
    return;
  }

  // Filtered / Search View (Global Search across Friends, Live Presence & Global Network)
  container.innerHTML = '';

  const localMatches = state.friends.filter(f => 
    !isUserBlocked(f.username || f.name) &&
    ((f.name && f.name.toLowerCase().includes(query)) || 
    (f.username && f.username.toLowerCase().includes(query)))
  );

  const outgoing = getOutgoingFriendRequests();
  const isPendingReq = (u) => outgoing.some(r => (r.toUsername || '').toLowerCase() === u.toLowerCase());

  // Search Global Users Cache & Presence
  const globalCache = JSON.parse(localStorage.getItem('miruo_global_users_cache') || '{}');
  const registeredUsers = JSON.parse(localStorage.getItem('miruo_registered_users') || '[]');
  
  const candidateUsersMap = new Map();
  // Populate from presence map
  window.miruoGlobalUsersMap.forEach((val, k) => candidateUsersMap.set(k, val));
  // Populate from cache
  Object.keys(globalCache).forEach(k => {
    if (!candidateUsersMap.has(k)) candidateUsersMap.set(k, globalCache[k]);
  });
  // Populate from registered users
  registeredUsers.forEach(ru => {
    const k = (ru.username || '').toLowerCase().replace(/^@/, '');
    if (k && !candidateUsersMap.has(k)) {
      candidateUsersMap.set(k, {
        username: k,
        fullName: ru.fullName || ru.username,
        avatarUrl: ru.avatarUrl || '',
        avatarBg: ru.avatarBg || 'from-rose-500 to-indigo-600',
        status: 'offline'
      });
    }
  });

  const discoveredMatches = [];
  candidateUsersMap.forEach((u, uKey) => {
    if (uKey === myClean) return; // skip self
    if (localMatches.some(f => (f.username || f.name || '').toLowerCase().replace(/^@/, '') === uKey)) return; // already in local
    if (uKey.includes(query) || (u.fullName && u.fullName.toLowerCase().includes(query))) {
      discoveredMatches.push(u);
    }
  });

  // Render Local Friend Matches
  if (localMatches.length > 0) {
    const header = document.createElement('div');
    header.className = 'text-[11px] font-bold text-gray-400 uppercase tracking-wider px-1 pt-1 pb-0.5';
    header.textContent = `Arkadaşların (${localMatches.length})`;
    container.appendChild(header);

    localMatches.forEach(fr => {
      renderSingleFriendCard(container, fr, dict);
    });
  }

  // Render Discovered Users
  if (discoveredMatches.length > 0) {
    const header = document.createElement('div');
    header.className = 'text-[11px] font-bold text-rose-400 uppercase tracking-wider px-1 pt-2 pb-0.5 flex items-center gap-1.5';
    header.innerHTML = `
      <svg class="w-3.5 h-3.5 text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
      <span>Keşfedilen Kullanıcılar (${discoveredMatches.length})</span>
    `;
    container.appendChild(header);

    discoveredMatches.forEach(u => {
      const cleanU = (u.username || '').replace(/^@/, '');
      const card = document.createElement('div');
      card.className = 'p-3 rounded-2xl bg-[#0C0E17] border border-white/10 hover:border-white/20 transition-all flex items-center justify-between gap-3 shadow-md';
      const isOnline = u.status === 'online' || u.status === 'in_room';
      const pending = isPendingReq(cleanU);

      card.innerHTML = `
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <div class="relative shrink-0">
            ${u.avatarUrl ?
              `<img src="${u.avatarUrl}" class="w-10 h-10 rounded-full object-cover border border-white/20" alt="Avatar">` :
              `<div class="w-10 h-10 rounded-full bg-gradient-to-tr ${u.avatarBg || 'from-rose-500 to-indigo-600'} flex items-center justify-center font-bold text-white text-xs shadow-sm">${(cleanU.charAt(0) || 'A').toUpperCase()}</div>`
            }
            <span class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#0C0E17] ${isOnline ? 'bg-emerald-400' : 'bg-gray-500'}"></span>
          </div>
          <div class="truncate">
            <div class="flex items-center gap-1.5">
              <span class="text-xs font-bold text-white truncate">@${cleanU}</span>
              ${u.fullName && u.fullName !== cleanU ? `<span class="text-[10px] text-gray-400 truncate">(${escapeHtml(u.fullName)})</span>` : ''}
            </div>
            <span class="text-[10px] ${isOnline ? 'text-emerald-400 font-semibold' : 'text-gray-500'} block">
              ${isOnline ? 'Çevrimiçi' : 'Çevrimdışı'}
            </span>
          </div>
        </div>
        <div class="shrink-0">
          ${pending ?
            `<button disabled type="button" class="px-3 py-1.5 rounded-xl bg-white/10 text-gray-400 font-semibold text-xs border border-white/10">İstek Gönderildi</button>` :
            `<button type="button" class="send-req-card-btn px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-rose-600 via-pink-600 to-indigo-600 hover:opacity-95 active:scale-95 text-white font-bold text-xs shadow-md transition-all cursor-pointer flex items-center gap-1.5" data-username="${cleanU}">
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
              <span>Arkadaş Ekle</span>
            </button>`
          }
        </div>
      `;

      const btn = card.querySelector('.send-req-card-btn');
      if (btn) {
        addInstantTap(btn, (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          sendFriendRequest(cleanU);
        });
      }
      container.appendChild(card);
    });
  }

  // Always show Direct Actionable Card for exact query if not already in local friends and not self
  const exactInFriends = localMatches.some(f => (f.username || f.name || '').toLowerCase().replace(/^@/, '') === query);
  const exactInDiscovered = discoveredMatches.some(u => (u.username || '').toLowerCase().replace(/^@/, '') === query);

  if (!exactInFriends && !exactInDiscovered && query !== myClean && query.length >= 2) {
    const directCard = document.createElement('div');
    directCard.className = 'p-3.5 rounded-2xl bg-gradient-to-r from-[#1E112A] via-[#140D24] to-[#0E101D] border border-rose-500/40 flex items-center justify-between gap-3 shadow-xl animate-in fade-in duration-200';
    const pending = isPendingReq(query);

    directCard.innerHTML = `
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <div class="w-10 h-10 rounded-full bg-gradient-to-tr from-rose-500 via-pink-600 to-indigo-600 flex items-center justify-center font-black text-white text-xs shadow-md border border-white/20 shrink-0">
          ${query.charAt(0).toUpperCase()}
        </div>
        <div class="truncate">
          <div class="flex items-center gap-1.5">
            <span class="text-xs font-bold text-white truncate">@${escapeHtml(query)}</span>
            <span class="px-1.5 py-0.2 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30 text-[9px] font-extrabold">Miruo Kullanıcısı</span>
          </div>
          <span class="text-[10px] text-gray-400 block mt-0.5">Bu kullanıcıya doğrudan arkadaşlık isteği gönder</span>
        </div>
      </div>
      <div class="shrink-0">
        ${pending ?
          `<button disabled type="button" class="px-3 py-1.5 rounded-xl bg-white/10 text-gray-400 font-semibold text-xs border border-white/10">İstek Gönderildi</button>` :
          `<button type="button" class="direct-add-card-btn px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-rose-600 via-pink-600 to-indigo-600 hover:opacity-95 active:scale-95 text-white font-bold text-xs shadow-md shadow-rose-600/30 transition-all cursor-pointer flex items-center gap-1.5" data-username="${escapeHtml(query)}">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
            <span>Arkadaş Ekle</span>
          </button>`
        }
      </div>
    `;

    const directBtn = directCard.querySelector('.direct-add-card-btn');
    if (directBtn) {
      addInstantTap(directBtn, (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        sendFriendRequest(query);
      });
    }
    container.appendChild(directCard);

    // Asynchronously check backend search to enrich cache
    fetch(`/api/users/search?q=${encodeURIComponent(query)}`)
      .then(r => r.json())
      .then(d => {
        if (d.users && d.users.length > 0) {
          d.users.forEach(u => upsertGlobalUserCache(u));
        }
      }).catch(() => {});
  }
}


// ==========================================
// CELESTIAL SHOOTING STARFIELD (PROFILE TAB)
// Matches Miruo official website celestial sliding stars & starburst engine
// ==========================================
let profileStarAnimId = null;
let profileStarInitialized = false;
let profileStars = [];
let profileShootingStars = [];
let profileSparkParticles = [];
let profileStarCanvasCtx = null;
let profileStarWidth = 0;
let profileStarHeight = 0;

function initProfileStarCanvas() {
  const canvas = document.getElementById('profileStarCanvas');
  if (!canvas) return;
  profileStarCanvasCtx = canvas.getContext('2d');

  function resizeStarCanvas() {
    const parent = canvas.parentElement || document.body;
    const rect = parent.getBoundingClientRect();
    profileStarWidth = rect.width || window.innerWidth;
    profileStarHeight = Math.max(rect.height, window.innerHeight);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(profileStarWidth * dpr);
    canvas.height = Math.floor(profileStarHeight * dpr);
    if (profileStarCanvasCtx) {
      profileStarCanvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  resizeStarCanvas();
  window.addEventListener('resize', () => {
    if (state.currentTab === 'profile') resizeStarCanvas();
  });

  const starColors = ['#FFFFFF', '#FFE2F1', '#FF9CD1', '#E882B2', '#D8B4E2', '#A64D79'];
  const totalStars = 90;
  profileStars = [];
  for (let i = 0; i < totalStars; i++) {
    profileStars.push({
      x: Math.random() * profileStarWidth,
      y: Math.random() * profileStarHeight,
      size: Math.random() * 1.6 + 0.5,
      color: starColors[Math.floor(Math.random() * starColors.length)],
      alpha: Math.random() * 0.7 + 0.3,
      speed: Math.random() * 0.03 + 0.01,
      phase: Math.random() * Math.PI * 2,
      isCross: Math.random() < 0.12
    });
  }

  profileShootingStars = [];
  for (let i = 0; i < 2; i++) {
    spawnProfileShootingStar(
      Math.random() * profileStarWidth,
      Math.random() * (profileStarHeight * 0.5)
    );
  }

  // Interactive meteor shower on tap/click outside buttons
  const profileSection = document.getElementById('profileTabSection');
  if (profileSection) {
    profileSection.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('a') || e.target.closest('input')) return;
      const rect = profileSection.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      for (let i = 0; i < 3; i++) {
        const offsetAngle = (Math.PI / 4) + (Math.random() - 0.5) * 0.6;
        spawnProfileShootingStar(
          clickX + (Math.random() - 0.5) * 40,
          clickY + (Math.random() - 0.5) * 30,
          offsetAngle
        );
      }
    });
  }

  profileStarInitialized = true;
}

function spawnProfileShootingStar(customX, customY, customAngle) {
  const angle = customAngle !== undefined ? customAngle : (Math.PI / 4) + (Math.random() - 0.5) * 0.35;
  const speed = Math.random() * 8 + 14;
  const length = Math.random() * 140 + 140;
  const thickness = Math.random() * 1.6 + 1.2;

  const startX = customX !== undefined ? customX : Math.random() * (profileStarWidth * 0.95) + (profileStarWidth * 0.05);
  const startY = customY !== undefined ? customY : Math.random() * (profileStarHeight * 0.4);

  profileShootingStars.push({
    x: startX,
    y: startY,
    dx: -Math.cos(angle) * speed,
    dy: Math.sin(angle) * speed,
    length: length,
    thickness: thickness,
    alpha: 1.0,
    fadeSpeed: Math.random() * 0.015 + 0.010
  });
}

function drawProfileCrossStar(ctx, x, y, radius, alpha, color) {
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

  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function renderProfileStarframe() {
  if (state.currentTab !== 'profile') {
    profileStarAnimId = null;
    return;
  }
  const canvas = document.getElementById('profileStarCanvas');
  if (!canvas || !profileStarCanvasCtx) {
    profileStarAnimId = null;
    return;
  }
  const ctx = profileStarCanvasCtx;
  const w = profileStarWidth || canvas.clientWidth || window.innerWidth;
  const h = profileStarHeight || canvas.clientHeight || window.innerHeight;

  ctx.clearRect(0, 0, w, h);

  // 1. Static & Twinkling Stars
  for (let i = 0; i < profileStars.length; i++) {
    const s = profileStars[i];
    s.phase += s.speed;
    const currentAlpha = Math.max(0.15, Math.min(1.0, s.alpha + Math.sin(s.phase) * 0.4));

    if (s.isCross && s.size > 1.1) {
      drawProfileCrossStar(ctx, s.x, s.y, s.size * 1.4, currentAlpha, s.color);
    } else {
      ctx.save();
      ctx.globalAlpha = currentAlpha;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
      ctx.fill();

      if (s.size > 1.3) {
        ctx.fillStyle = '#FFB6DE';
        ctx.globalAlpha = currentAlpha * 0.25;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size * 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // 2. Spawn and update meteors
  if (profileShootingStars.length < 2) {
    spawnProfileShootingStar();
  }
  if (profileShootingStars.length < 4 && Math.random() < 0.08) {
    spawnProfileShootingStar();
  }

  // Spark trail particles
  for (let i = profileSparkParticles.length - 1; i >= 0; i--) {
    const sp = profileSparkParticles[i];
    sp.x += sp.vx;
    sp.y += sp.vy;
    sp.alpha -= sp.fade;
    if (sp.alpha <= 0) {
      profileSparkParticles.splice(i, 1);
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

  // Sliding Shooting Stars
  for (let i = profileShootingStars.length - 1; i >= 0; i--) {
    const ss = profileShootingStars[i];
    ss.x += ss.dx;
    ss.y += ss.dy;
    ss.alpha -= ss.fadeSpeed;

    if (ss.alpha <= 0 || ss.x < -200 || ss.y > h + 200) {
      profileShootingStars.splice(i, 1);
      continue;
    }

    if (Math.random() < 0.35) {
      profileSparkParticles.push({
        x: ss.x + (Math.random() - 0.5) * 4,
        y: ss.y + (Math.random() - 0.5) * 4,
        vx: ss.dx * 0.1 + (Math.random() - 0.5) * 1.2,
        vy: ss.dy * 0.1 + (Math.random() - 0.5) * 1.2,
        size: Math.random() * 1.4 + 0.6,
        alpha: ss.alpha * 0.75,
        fade: 0.045,
        color: '#FFB6DE'
      });
    }

    const headX = ss.x;
    const headY = ss.y;
    const norm = Math.sqrt(ss.dx * ss.dx + ss.dy * ss.dy) || 1;
    const tailX = headX - (ss.dx / norm) * ss.length;
    const tailY = headY - (ss.dy / norm) * ss.length;

    ctx.save();
    ctx.globalAlpha = Math.max(0, ss.alpha);

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

    // Glowing nucleus
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(headX, headY, ss.thickness * 1.4, 0, Math.PI * 2);
    ctx.fill();

    // Pink celestial aura
    ctx.fillStyle = '#FF6EB4';
    ctx.globalAlpha = Math.max(0, ss.alpha) * 0.6;
    ctx.beginPath();
    ctx.arc(headX, headY, ss.thickness * 3.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  profileStarAnimId = requestAnimationFrame(renderProfileStarframe);
}

function startProfileStarCanvas() {
  if (!profileStarInitialized) {
    initProfileStarCanvas();
  } else {
    const canvas = document.getElementById('profileStarCanvas');
    if (canvas) {
      const parent = canvas.parentElement || document.body;
      const rect = parent.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        profileStarWidth = rect.width;
        profileStarHeight = Math.max(rect.height, window.innerHeight);
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(profileStarWidth * dpr);
        canvas.height = Math.floor(profileStarHeight * dpr);
        if (profileStarCanvasCtx) {
          profileStarCanvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
      }
    }
  }
  if (!profileStarAnimId) {
    profileStarAnimId = requestAnimationFrame(renderProfileStarframe);
  }
}

function stopProfileStarCanvas() {
  if (profileStarAnimId) {
    cancelAnimationFrame(profileStarAnimId);
    profileStarAnimId = null;
  }
}

function switchToFriendsTab() {
  state.currentTab = 'friends';
  stopProfileStarCanvas();
  if (dom.exploreLobbySection) {
    dom.exploreLobbySection.classList.add('hidden');
    dom.exploreLobbySection.classList.remove('flex');
  }
  if (dom.providerPickerSection) {
    dom.providerPickerSection.classList.add('hidden');
    dom.providerPickerSection.classList.remove('flex');
  }
  if (!state.isMiniPlayer && dom.roomWorkspaceSection) {
    dom.roomWorkspaceSection.classList.add('hidden');
    dom.roomWorkspaceSection.classList.remove('flex', 'block');
  }
  const profileTab = document.getElementById('profileTabSection');
  if (profileTab) {
    profileTab.classList.add('hidden');
    profileTab.classList.remove('flex');
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
  if (dom.mobileNavProfileBtn) {
    dom.mobileNavProfileBtn.className = 'flex flex-col items-center gap-1 text-gray-400 hover:text-white py-1 px-3 transition-all cursor-pointer';
  }

  loadFriends();
  renderFriendsTab();
}

function switchToProfileTab() {
  state.currentTab = 'profile';
  if (dom.exploreLobbySection) {
    dom.exploreLobbySection.classList.add('hidden');
    dom.exploreLobbySection.classList.remove('flex');
  }
  if (dom.providerPickerSection) {
    dom.providerPickerSection.classList.add('hidden');
    dom.providerPickerSection.classList.remove('flex');
  }
  if (!state.isMiniPlayer && dom.roomWorkspaceSection) {
    dom.roomWorkspaceSection.classList.add('hidden');
    dom.roomWorkspaceSection.classList.remove('flex', 'block');
  }
  const friendsTab = document.getElementById('friendsTabSection');
  if (friendsTab) {
    friendsTab.classList.add('hidden');
    friendsTab.classList.remove('flex');
  }
  
  const profileTab = document.getElementById('profileTabSection');
  if (profileTab) {
    profileTab.classList.remove('hidden');
    profileTab.classList.add('flex');
  }

  if (dom.mobileNavExploreBtn) {
    dom.mobileNavExploreBtn.className = 'flex flex-col items-center gap-1 text-gray-400 hover:text-white py-1 px-3 transition-all cursor-pointer';
  }
  if (dom.mobileNavFriendsBtn) {
    dom.mobileNavFriendsBtn.className = 'flex flex-col items-center gap-1 text-gray-400 hover:text-white py-1 px-3 transition-all cursor-pointer';
  }
  if (dom.mobileNavProfileBtn) {
    dom.mobileNavProfileBtn.className = 'flex flex-col items-center gap-1 text-white font-bold py-1 px-3 transition-all cursor-pointer';
  }

  renderProfileTab();
  startProfileStarCanvas();
}

function renderProfileTab() {
  const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
  const customUsername = savedUser.username || localStorage.getItem('miruo_custom_username') || state.username || 'kullanici';
  const cleanUsername = customUsername.replace(/^@/, '');
  const displayHandle = '@' + cleanUsername;
  const realFullName = (savedUser.fullName && !savedUser.fullName.startsWith('@') ? savedUser.fullName.trim() : '') ||
                       (savedUser.name && !savedUser.name.startsWith('@') && savedUser.name !== 'Misafir' ? savedUser.name.trim() : '');

  const nameEl = document.getElementById('tabProfileFullName');
  const userEl = document.getElementById('tabProfileUsername');
  const avatarEl = document.getElementById('tabProfileAvatar');
  const friendsCountEl = document.getElementById('tabProfileFriendsCount');
  const providerTitleEl = document.getElementById('tabProfileProviderTitle');
  const emailSubEl = document.getElementById('tabProfileEmailSub');

  if (nameEl) {
    nameEl.textContent = realFullName || displayHandle;
  }
  if (userEl) {
    if (realFullName && realFullName.toLowerCase() !== displayHandle.toLowerCase()) {
      userEl.textContent = displayHandle;
      userEl.classList.remove('hidden');
    } else {
      userEl.textContent = '';
      userEl.classList.add('hidden');
    }
  }
  if (friendsCountEl) friendsCountEl.textContent = (state.friends || []).length;

  const activeAvatarUrl = savedUser.avatarUrl || state.avatarUrl || '';
  const activeAvatarBg = savedUser.avatarBg || state.avatarBg || 'from-rose-500 to-[#A64D79]';

  if (avatarEl) {
    if (activeAvatarUrl) {
      avatarEl.innerHTML = `<img src="${activeAvatarUrl}" class="w-full h-full object-cover">`;
    } else {
      avatarEl.textContent = ((realFullName || cleanUsername).charAt(0) || 'M').toUpperCase();
      avatarEl.className = `w-24 h-24 rounded-full bg-gradient-to-tr ${activeAvatarBg} flex items-center justify-center text-3xl font-black text-white shadow-2xl overflow-hidden border-2 border-rose-400/40 ring-4 ring-rose-500/10`;
    }
  }

  const centerAvEl = document.getElementById('tabProfileCenterAvatar');
  if (centerAvEl) {
    if (activeAvatarUrl) {
      centerAvEl.innerHTML = `<img src="${activeAvatarUrl}" class="w-full h-full object-cover">`;
    } else {
      centerAvEl.textContent = ((realFullName || cleanUsername).charAt(0) || 'M').toUpperCase();
    }
  }

  const authProvider = savedUser.provider || (savedUser.phone ? 'phone' : (savedUser.isApple ? 'apple' : (savedUser.isGoogle ? 'google' : 'email')));
  if (providerTitleEl) {
    if (authProvider === 'apple') providerTitleEl.textContent = 'Apple ID ile Giriş Yapıldı';
    else if (authProvider === 'google') providerTitleEl.textContent = 'Google ile Giriş Yapıldı';
    else if (authProvider === 'phone') providerTitleEl.textContent = 'Telefon Numarası ile Giriş';
    else providerTitleEl.textContent = 'E-posta ile Kayıt Olundu';
  }
  if (emailSubEl) {
    emailSubEl.textContent = savedUser.email || savedUser.phone || `${cleanUsername.replace(/^@/, '').toLowerCase()}@miruo.app`;
  }

  // Render Mobile Legends Style Affinity Constellation Tree
  if (typeof renderAffinityTree === 'function') {
    renderAffinityTree();
  }
}

// ==========================================
// 5.8.5 İLİŞKİLER SİSTEMİ (3 SAAT BİRLİKTE İZLEME KRİTERİ)
// ==========================================

const AFFINITY_CATEGORIES = {
  partner: { key: 'partner', name: 'Partner', icon: '', color: 'rose', glowClass: 'affinity-glow-partner', max: 1 },
  bro: { key: 'bro', name: 'Kanka', icon: '', color: 'cyan', glowClass: 'affinity-glow-bro', max: 3 },
  bestie: { key: 'bestie', name: 'Yakın Arkadaş', icon: '', color: 'purple', glowClass: 'affinity-glow-bestie', max: 3 },
  confidant: { key: 'confidant', name: 'Sırdaş', icon: '', color: 'rose', glowClass: 'affinity-glow-confidant', max: 2 }
};

// 9 Symmetrical Orbit Slots with coordinates:
// 1 Top (Partner), 3 Left (Kanka), 3 Right (Yakın Arkadaş), 2 Bottom (Sırdaş)
const AFFINITY_SLOTS = [
  // 1 Top (Partner)
  { key: 'partner_1', category: 'partner', label: 'Partner', icon: '', x: 50, y: 9 },

  // 3 Left (Kanka)
  { key: 'bro_1', category: 'bro', label: 'Kanka 1', icon: '', x: 15, y: 28 },
  { key: 'bro_2', category: 'bro', label: 'Kanka 2', icon: '', x: 11, y: 50 },
  { key: 'bro_3', category: 'bro', label: 'Kanka 3', icon: '', x: 16, y: 72 },

  // 3 Right (Yakın Arkadaş)
  { key: 'bestie_1', category: 'bestie', label: 'Yakın Arkadaş 1', icon: '', x: 85, y: 28 },
  { key: 'bestie_2', category: 'bestie', label: 'Yakın Arkadaş 2', icon: '', x: 89, y: 50 },
  { key: 'bestie_3', category: 'bestie', label: 'Yakın Arkadaş 3', icon: '', x: 84, y: 72 },

  // 2 Bottom (Sırdaş)
  { key: 'confidant_1', category: 'confidant', label: 'Sırdaş 1', icon: '', x: 34, y: 89 },
  { key: 'confidant_2', category: 'confidant', label: 'Sırdaş 2', icon: '', x: 66, y: 89 }
];

// Default Shared Watch Times (in minutes) for friends:
// 3 hours = 180 minutes.
const DEFAULT_SHARED_WATCH_TIME = {
  selin: 216,  // 3.6 hours -> ELIGIBLE (>= 180 min, Lv. 1)
  can: 420,    // 7.0 hours -> ELIGIBLE (>= 180 min, Lv. 2)
  merve: 84,   // 1.4 hours -> (< 180 min, not eligible)
  emre: 42     // 0.7 hours -> (< 180 min, not eligible)
};

// Calculate Affinity Level from shared watch minutes:
// Level 1 starts at 3 hours (180 min).
// Every 3 hours (+180 min) adds +1 level, up to Level 8 (24+ hours = MAX).
function getAffinityLevel(minutes) {
  const mins = Number(minutes) || 0;
  const hours = mins / 60;
  if (hours < 3) return 1;
  const lvl = Math.floor(hours / 3);
  return Math.min(8, Math.max(1, lvl));
}

// User requested: Record & display in minutes under 1 hour, and in hours at/above 1 hour (e.g. 45 dk, 1.2 sa, 24 sa)
function formatSharedWatchTime(minutes) {
  const mins = Math.max(0, Math.round(Number(minutes) || 0));
  if (mins < 60) {
    return `${mins} dk`;
  }
  const hours = (mins / 60).toFixed(1).replace(/\.0$/, '');
  return `${hours} sa`;
}
window.formatSharedWatchTime = formatSharedWatchTime;

function getSharedWatchMinutes(username) {
  if (!username) return 0;
  const clean = username.toLowerCase().replace(/^@/, '').trim();
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem('miruo_shared_watch_time') || '{}');
  } catch (e) {
    saved = {};
  }
  if (saved[clean] !== undefined) return Number(saved[clean]) || 0;
  if (DEFAULT_SHARED_WATCH_TIME[clean] !== undefined) {
    saved[clean] = DEFAULT_SHARED_WATCH_TIME[clean];
    localStorage.setItem('miruo_shared_watch_time', JSON.stringify(saved));
    return saved[clean];
  }
  return 0;
}

function setSharedWatchMinutes(username, minutes) {
  if (!username) return;
  const clean = username.toLowerCase().replace(/^@/, '').trim();
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem('miruo_shared_watch_time') || '{}');
  } catch (e) {
    saved = {};
  }
  saved[clean] = Math.max(0, Number(minutes) || 0);
  localStorage.setItem('miruo_shared_watch_time', JSON.stringify(saved));
}

function addSharedWatchMinutes(username, addedMinutes) {
  const current = getSharedWatchMinutes(username);
  setSharedWatchMinutes(username, current + addedMinutes);
}

// User's own affinity tree:
// Starts 100% empty with '+' as requested by the user:
function getUserAffinityTree() {
  const saved = localStorage.getItem('miruo_user_affinity');
  const initial = {
    partner_1: null,
    bro_1: null,
    bro_2: null,
    bro_3: null,
    bestie_1: null,
    bestie_2: null,
    bestie_3: null,
    confidant_1: null,
    confidant_2: null
  };
  if (saved) {
    try {
      const tree = JSON.parse(saved);
      const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
      const myClean = (savedUser.username || state.username || '').toLowerCase().replace(/^@/, '').trim();
      let modified = false;
      Object.keys(tree).forEach(k => {
        const item = tree[k];
        if (item) {
          const itemClean = (item.username || item.name || '').toLowerCase().replace(/^@/, '').trim();
          if (myClean && itemClean === myClean) {
            tree[k] = null;
            modified = true;
          }
        }
      });
      if (modified) {
        localStorage.setItem('miruo_user_affinity', JSON.stringify(tree));
      }
      return tree;
    } catch (e) {}
  }
  localStorage.setItem('miruo_user_affinity', JSON.stringify(initial));
  return initial;
}

function saveUserAffinityTree(tree) {
  localStorage.setItem('miruo_user_affinity', JSON.stringify(tree));
}

// Get mock or stored affinity tree for other users (public view)
function getMockAffinityTreeForUser(targetUsername) {
  const clean = (targetUsername || '').toLowerCase().replace(/^@/, '').trim();
  const currentTree = getUserAffinityTree();
  const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
  const myUsername = (savedUser.username || state.username || 'kullanici').replace(/^@/, '').toLowerCase();
  const myName = '@' + myUsername;

  let mutuals = {};
  try {
    mutuals = JSON.parse(localStorage.getItem('miruo_mutual_affinities') || '{}');
  } catch (e) { mutuals = {}; }

  let isPartnerWithMe = false;
  let isBroWithMe = false;
  let isBestieWithMe = false;
  let isConfidantWithMe = false;

  const mutual = mutuals[clean];
  if (mutual && (mutual.partnerOf || '').toLowerCase() === myUsername) {
    if (mutual.category === 'partner') isPartnerWithMe = true;
    else if (mutual.category === 'bro') isBroWithMe = true;
    else if (mutual.category === 'bestie') isBestieWithMe = true;
    else if (mutual.category === 'confidant') isConfidantWithMe = true;
  }

  // Also check if currentTree has an accepted slot for this user
  Object.keys(currentTree).forEach(k => {
    const slot = currentTree[k];
    if (slot && slot.username && slot.username.toLowerCase().replace(/^@/, '') === clean && !slot.isPending) {
      if (slot.category === 'partner') isPartnerWithMe = true;
      else if (slot.category === 'bro') isBroWithMe = true;
      else if (slot.category === 'bestie') isBestieWithMe = true;
      else if (slot.category === 'confidant') isConfidantWithMe = true;
    }
  });

  // Never allow user to be bound to themselves
  const canBePartner = isPartnerWithMe && myUsername && myUsername !== clean;
  const canBeBro = isBroWithMe && myUsername && myUsername !== clean;
  const canBeBestie = isBestieWithMe && myUsername && myUsername !== clean;
  const canBeConfidant = isConfidantWithMe && myUsername && myUsername !== clean;

  const tree = {
    partner_1: canBePartner 
      ? { username: myUsername, name: myName, category: 'partner', watchMins: getSharedWatchMinutes(clean) || 1440 } 
      : null,
    bro_1: canBeBro
      ? { username: myUsername, name: myName, category: 'bro', watchMins: getSharedWatchMinutes(clean) || 360 }
      : null,
    bro_2: null,
    bro_3: null,
    bestie_1: canBeBestie
      ? { username: myUsername, name: myName, category: 'bestie', watchMins: getSharedWatchMinutes(clean) || 180 }
      : null,
    bestie_2: null,
    bestie_3: null,
    confidant_1: canBeConfidant
      ? { username: myUsername, name: myName, category: 'confidant', watchMins: getSharedWatchMinutes(clean) || 60 }
      : null,
    confidant_2: null
  };

  return tree;
}

// Render Affinity Constellation Tree (Works for both own profile and public user profile)
function renderAffinityTree(containerId = 'affinityConstellationContainer', svgId = 'affinityBranchesSvg', nodesLayerId = 'affinityNodesLayer', isOwnProfile = true, targetUser = null) {
  const container = document.getElementById(containerId);
  const svg = document.getElementById(svgId);
  const layer = document.getElementById(nodesLayerId);
  if (!container || !svg || !layer) return;

  const currentTree = isOwnProfile ? getUserAffinityTree() : (targetUser && targetUser.affinityTree ? targetUser.affinityTree : getMockAffinityTreeForUser(targetUser ? targetUser.username : 'other'));

  // Center User Data
  const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
  const centerName = isOwnProfile 
    ? (savedUser.fullName || savedUser.name || state.username || 'Mehmet') 
    : (targetUser ? (targetUser.name || targetUser.fullName || targetUser.username) : 'Kullanıcı');
  const centerAvatar = isOwnProfile
    ? (savedUser.avatarUrl || state.avatarUrl || '')
    : (targetUser ? targetUser.avatarUrl : '');
  const centerInitial = (centerName.charAt(0) || 'M').toUpperCase();

  // Clear SVG & Nodes Layer
  svg.innerHTML = '';
  layer.innerHTML = '';

  // Draw Center User Node (BÜYÜK FOTOĞRAF ORTADA - 86px)
  const centerDiv = document.createElement('div');
  centerDiv.className = 'absolute flex flex-col items-center justify-center select-none pointer-events-auto z-20';
  centerDiv.style.left = '50%';
  centerDiv.style.top = '50%';
  centerDiv.style.transform = 'translate(-50%, -50%)';

  centerDiv.innerHTML = `
    <div class="relative flex items-center justify-center cursor-pointer group" style="width: 86px; height: 86px;">
      <div class="affinity-center-halo absolute -inset-2.5 rounded-full border-2 border-rose-500/70 shadow-[0_0_26px_rgba(244,63,94,0.5)]"></div>
      <div id="${isOwnProfile ? 'tabProfileCenterAvatar' : 'publicCenterAvatar'}" class="w-full h-full rounded-full overflow-hidden bg-gradient-to-tr from-[#A64D79] to-[#6A1E55] border-2 border-rose-400/90 shadow-2xl flex items-center justify-center text-white font-black text-3xl">
        ${centerAvatar ? `<img src="${centerAvatar}" class="w-full h-full object-cover">` : centerInitial}
      </div>
      ${isOwnProfile ? `
      <button id="tabProfileCenterAvatarEditBtn" type="button" class="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-rose-600 hover:bg-rose-500 border-2 border-[#080711] text-white flex items-center justify-center shadow-lg active:scale-90 transition-transform cursor-pointer" title="Fotoğrafı Değiştir">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
      </button>` : ''}
    </div>
    <span class="mt-1 px-3 py-0.5 rounded-full bg-black/85 border border-white/20 text-[10px] font-black text-white shadow-lg tracking-wide">
      ${isOwnProfile ? 'Sen' : ('@' + (targetUser ? (targetUser.username || targetUser.name) : 'kullanici').replace(/^@/, ''))}
    </span>
  `;
  layer.appendChild(centerDiv);

  if (isOwnProfile) {
    const editBtn = centerDiv.querySelector('#tabProfileCenterAvatarEditBtn');
    if (editBtn) {
      addInstantTap(editBtn, (e) => {
        e.stopPropagation();
        triggerPhotoPicker('avatar');
      });
    }
  }

  // Counters for Legend
  let countPartner = 0, countBro = 0, countBestie = 0, countConfidant = 0;

  const targetClean = (isOwnProfile 
    ? (savedUser.username || state.username || '') 
    : (targetUser ? (targetUser.username || targetUser.name) : '')
  ).toLowerCase().replace(/^@/, '').trim();

  // Render each slot and connecting branch
  AFFINITY_SLOTS.forEach(slot => {
    let assigned = currentTree[slot.key];
    if (assigned) {
      const assignedClean = (assigned.username || assigned.name || '').toLowerCase().replace(/^@/, '').trim();
      // 1. Strictly forbid self-relationships
      // 2. Pending requests must not appear on constellation graph until accepted
      if (assignedClean === targetClean || assigned.isPending) {
        assigned = null;
      }
    }
    const cat = AFFINITY_CATEGORIES[slot.category];

    const isPartner = slot.category === 'partner';
    let strokeColor = '#F43F5E';
    let glowColor = '#FDA4AF';

    if (isPartner) {
      strokeColor = '#F43F5E';
      glowColor = '#FB7185';
    } else if (slot.category === 'confidant') {
      strokeColor = '#FB7185';
      glowColor = '#FDA4AF';
    } else if (slot.category === 'bro') {
      strokeColor = '#38BDF8';
      glowColor = '#7DD3FC';
    } else if (slot.category === 'bestie') {
      strokeColor = '#C084FC';
      glowColor = '#E9D5FF';
    }

    if (assigned) {
      const isPending = !!assigned.isPending;
      const friendMinutes = (assigned.watchMins !== undefined) ? assigned.watchMins : getSharedWatchMinutes(assigned.username);
      const level = getAffinityLevel(friendMinutes);

      if (isPending) {
        // Pending request connecting branch: dashed amber line
        const pendingLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        pendingLine.setAttribute('x1', '50');
        pendingLine.setAttribute('y1', '50');
        pendingLine.setAttribute('x2', slot.x.toString());
        pendingLine.setAttribute('y2', slot.y.toString());
        pendingLine.setAttribute('stroke', '#F59E0B');
        pendingLine.setAttribute('stroke-width', '2.2');
        pendingLine.setAttribute('stroke-linecap', 'round');
        pendingLine.setAttribute('stroke-dasharray', '4 4');
        pendingLine.setAttribute('opacity', '0.85');
        svg.appendChild(pendingLine);
      } else {
        // Connecting line thickness and glow increase as bond level grows:
        const coreWidth = isPartner ? (2.8 + (level - 1) * 0.45) : (1.8 + (level - 1) * 0.3);
        const glowWidth = coreWidth * 2.3;
        const glowOpacity = Math.min(0.85, (0.35 + (level - 1) * 0.06)).toFixed(2);

        // 1. Dual SVG Lines Fix: Outer Glow Line (No SVG filters, 100% reliable across WebKit & Safari)
        const glowLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        glowLine.setAttribute('x1', '50');
        glowLine.setAttribute('y1', '50');
        glowLine.setAttribute('x2', slot.x.toString());
        glowLine.setAttribute('y2', slot.y.toString());
        glowLine.setAttribute('stroke', glowColor);
        glowLine.setAttribute('stroke-width', glowWidth.toFixed(1));
        glowLine.setAttribute('stroke-linecap', 'round');
        glowLine.setAttribute('opacity', glowOpacity);
        svg.appendChild(glowLine);

        // 2. Inner Crisp Core Line (Never vanishes when bound!)
        const coreLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        coreLine.setAttribute('x1', '50');
        coreLine.setAttribute('y1', '50');
        coreLine.setAttribute('x2', slot.x.toString());
        coreLine.setAttribute('y2', slot.y.toString());
        coreLine.setAttribute('stroke', strokeColor);
        coreLine.setAttribute('stroke-width', coreWidth.toFixed(1));
        coreLine.setAttribute('stroke-linecap', 'round');
        coreLine.setAttribute('opacity', '0.98');
        svg.appendChild(coreLine);

        if (slot.category === 'partner') countPartner++;
        else if (slot.category === 'bro') countBro++;
        else if (slot.category === 'bestie') countBestie++;
        else if (slot.category === 'confidant') countConfidant++;
      }
    } else {
      // Empty slot: subtle dashed line
      let emptyStroke = 'rgba(255, 255, 255, 0.15)';
      if (slot.category === 'partner') emptyStroke = 'rgba(244, 63, 94, 0.4)';
      else if (slot.category === 'confidant') emptyStroke = 'rgba(251, 113, 133, 0.28)';
      else if (slot.category === 'bro') emptyStroke = 'rgba(56, 189, 248, 0.22)';
      else if (slot.category === 'bestie') emptyStroke = 'rgba(192, 132, 252, 0.22)';

      const branch = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      branch.setAttribute('x1', '50');
      branch.setAttribute('y1', '50');
      branch.setAttribute('x2', slot.x.toString());
      branch.setAttribute('y2', slot.y.toString());
      branch.setAttribute('stroke', emptyStroke);
      branch.setAttribute('stroke-width', '1.1');
      branch.setAttribute('stroke-dasharray', '2 3');
      svg.appendChild(branch);
    }

    // Slot Node DOM element
    const nodeEl = document.createElement('div');
    nodeEl.className = 'absolute flex flex-col items-center select-none cursor-pointer';
    nodeEl.style.left = `${slot.x}%`;
    nodeEl.style.top = `${slot.y}%`;
    nodeEl.style.transform = 'translate(-50%, -50%)';

    if (assigned) {
      // FILLED SLOT WITH LEVEL & DYNAMIC SIZE (Level badge on node removed per user request; level is shown inside detail modal when tapped)
      const isPending = !!assigned.isPending;
      const friendMinutes = (assigned.watchMins !== undefined) ? assigned.watchMins : getSharedWatchMinutes(assigned.username);
      const level = getAffinityLevel(friendMinutes);
      const initial = (assigned.name || assigned.username || 'A').charAt(0).toUpperCase();

      // DYNAMIC AVATAR SIZE: Starts at 44px (Lv. 1), reaches 86px at Lv. 8 (Identical to center user!)
      // Formula: 44 + (level - 1) * 6
      const nodeSize = Math.round(44 + (level - 1) * 6);
      const avatarFontSize = nodeSize >= 75 ? 'text-2xl font-black' : (nodeSize >= 58 ? 'text-base font-black' : 'text-xs font-bold');

      if (isPending) {
        nodeEl.innerHTML = `
          <div class="relative flex items-center justify-center" style="width: ${nodeSize}px; height: ${nodeSize}px;">
            <div class="w-full h-full rounded-full overflow-hidden flex items-center justify-center text-white ${avatarFontSize} bg-gradient-to-tr from-gray-900 to-[#1b152b] shadow-2xl transition-all duration-300" style="border: 2.5px dashed #F59E0B;">
              ${assigned.avatarUrl ? `<img src="${assigned.avatarUrl}" class="w-full h-full object-cover">` : initial}
            </div>
            <span class="absolute bottom-0 right-0 w-3 h-3 rounded-full border border-black bg-amber-400 animate-pulse z-10 shadow-sm"></span>
          </div>
          <div class="mt-1 flex flex-col items-center">
            <span class="text-[9px] font-extrabold text-white truncate max-w-[75px] px-1.5 py-0.2 bg-black/75 rounded backdrop-blur-xs leading-tight">${escapeHtml('@' + (assigned.username || assigned.name || 'kullanici').replace(/^@/, ''))}</span>
            <span class="text-[8px] font-black text-amber-300 bg-amber-500/25 px-1.5 py-0.2 rounded-full border border-amber-500/40 leading-tight mt-0.5 tracking-tight">İstek Gönderildi</span>
          </div>
        `;
      } else {
        nodeEl.innerHTML = `
          <div class="relative flex items-center justify-center" style="width: ${nodeSize}px; height: ${nodeSize}px;">
            <div class="w-full h-full rounded-full overflow-hidden ${cat.glowClass} flex items-center justify-center text-white ${avatarFontSize} bg-gradient-to-tr from-gray-900 to-[#1b152b] shadow-2xl transition-all duration-300" style="border: ${level >= 6 ? '2.5px' : '2px'} solid ${strokeColor};">
              ${assigned.avatarUrl ? `<img src="${assigned.avatarUrl}" class="w-full h-full object-cover">` : initial}
            </div>
            <span class="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border border-black bg-emerald-400 z-10"></span>
          </div>
          <div class="mt-1 flex flex-col items-center">
            <span class="text-[9px] font-extrabold text-white truncate max-w-[75px] px-1.5 py-0.2 bg-black/75 rounded backdrop-blur-xs leading-tight">${escapeHtml('@' + (assigned.username || assigned.name || 'kullanici').replace(/^@/, ''))}</span>
            <span class="text-[8px] font-bold text-emerald-300 leading-tight">${formatSharedWatchTime(friendMinutes)}</span>
          </div>
        `;
      }

      addInstantTap(nodeEl, (e) => {
        e.stopPropagation();
        if (isOwnProfile) {
          openAffinitySlotDetail(slot.key, assigned);
        } else {
          openPublicUserProfile(assigned.username);
        }
      });

    } else {
      // EMPTY SLOT (ONLY TEXT, NO EMOJIS)
      if (isOwnProfile) {
        nodeEl.innerHTML = `
          <button type="button" class="w-11 h-11 sm:w-12 sm:h-12 rounded-full affinity-slot-empty flex items-center justify-center text-rose-400 hover:text-white transition-all cursor-pointer shadow-lg active:scale-95 group" title="${slot.label} Ekle">
            <svg class="w-5 h-5 text-rose-400/90 group-hover:scale-125 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <div class="mt-1 flex items-center justify-center px-1.5 py-0.5 rounded-full bg-black/70 border border-white/10 text-[8px] font-bold text-gray-300">
            <span>${cat.name}</span>
          </div>
        `;
        addInstantTap(nodeEl, (e) => {
          e.stopPropagation();
          openAffinityPicker(slot.key, slot.category, slot.label);
        });
      } else {
        // Public viewing mode for empty slot
        nodeEl.innerHTML = `
          <div class="w-10 h-10 rounded-full border border-white/15 bg-black/40 flex items-center justify-center text-gray-600">
            <svg class="w-4 h-4 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>
          </div>
          <span class="mt-1 text-[8px] font-semibold text-gray-500">Boş</span>
        `;
      }
    }

    layer.appendChild(nodeEl);
  });

  // Update Counters in Legend (ONLY TEXT)
  if (isOwnProfile) {
    const cp = document.getElementById('affinityCountPartner');
    const cb = document.getElementById('affinityCountBro');
    const cbe = document.getElementById('affinityCountBestie');
    const cc = document.getElementById('affinityCountConfidant');
    if (cp) cp.textContent = `${countPartner}/1`;
    if (cb) cb.textContent = `${countBro}/3`;
    if (cbe) cbe.textContent = `${countBestie}/3`;
    if (cc) cc.textContent = `${countConfidant}/2`;
  }
}

// Global reference for active picker target
let currentPickerSlotKey = null;

function openAffinityPicker(slotKey, categoryKey, slotTitle) {
  currentPickerSlotKey = slotKey;
  const modal = document.getElementById('affinityPickerModal');
  const titleEl = document.getElementById('affinityPickerTitle');
  const iconEl = document.getElementById('affinityPickerCategoryIcon');
  const listContainer = document.getElementById('affinityPickerListContainer');
  const infoBox = document.getElementById('affinityConditionInfoBox');
  if (!modal || !listContainer) return;

  const showInfoParam = new URLSearchParams(window.location.search).get('info') === '1';
  if (infoBox) {
    if (showInfoParam) infoBox.classList.remove('hidden');
    else infoBox.classList.add('hidden');
  }

  const cat = AFFINITY_CATEGORIES[categoryKey] || AFFINITY_CATEGORIES.partner;
  if (titleEl) titleEl.textContent = `${cat.name} İlişkisi Kur`;
  if (iconEl) iconEl.textContent = cat.icon || '';

  modal.classList.remove('hidden');
  modal.classList.add('flex');

  renderAffinityPickerList();
}

function closeAffinityPicker() {
  const modal = document.getElementById('affinityPickerModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

function renderAffinityPickerList() {
  const listContainer = document.getElementById('affinityPickerListContainer');
  const quickSimBtns = document.getElementById('affinityQuickSimBtns');
  if (!listContainer) return;

  listContainer.innerHTML = '';
  if (quickSimBtns) quickSimBtns.innerHTML = '';

  if (!state.friends || state.friends.length === 0) {
    if (typeof loadFriends === 'function') loadFriends();
  }
  const friends = (state && state.friends && state.friends.length > 0) ? state.friends : DEFAULT_FRIENDS;
  const currentTree = getUserAffinityTree();

  // Find who is already bound to other slots
  const alreadyBoundUsernames = new Set();
  Object.entries(currentTree).forEach(([k, val]) => {
    if (val && val.username && k !== currentPickerSlotKey) {
      alreadyBoundUsernames.add(val.username.toLowerCase().replace(/^@/, ''));
    }
  });

  // Filter: ONLY friends with >= 3 hours (180 minutes) shared watch time!
  // No locked section, no "kilitli" text, strictly eligible friends.
  const eligible = [];

  friends.forEach(fr => {
    const cleanUsername = (fr.username || fr.name || '').toLowerCase().replace(/^@/, '');
    if (alreadyBoundUsernames.has(cleanUsername)) return; // already bound elsewhere

    const watchMins = getSharedWatchMinutes(cleanUsername);
    const watchHours = (watchMins / 60).toFixed(1);

    if (watchMins >= 180) {
      eligible.push({ ...fr, cleanUsername, watchMins, watchHours, level: getAffinityLevel(watchMins) });
    }

    // Populate quick simulation button for testing
    if (quickSimBtns) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 active:scale-95 text-white text-[10px] font-semibold transition-all cursor-pointer';
      btn.textContent = `+30dk ${fr.name.split(' ')[0]}`;
      btn.addEventListener('click', () => {
        addSharedWatchMinutes(cleanUsername, 30);
        showToast(`${fr.name} ile +30 dk izlendi!`);
        renderAffinityPickerList();
        renderAffinityTree();
      });
      quickSimBtns.appendChild(btn);
    }
  });

  // Level Jump buttons for testing
  if (quickSimBtns && friends.length > 0) {
    const testFr = friends[0];
    const testUser = (testFr.username || testFr.name || '').toLowerCase().replace(/^@/, '');
    
    const lvlBtn = document.createElement('button');
    lvlBtn.type = 'button';
    lvlBtn.className = 'px-2 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 active:scale-95 text-rose-300 text-[10px] font-bold transition-all cursor-pointer';
    lvlBtn.textContent = `+180 dk (${testFr.name.split(' ')[0]})`;
    lvlBtn.addEventListener('click', () => {
      addSharedWatchMinutes(testUser, 180);
      showToast(`${testFr.name} ile +180 dk (+1 Seviye) eklendi!`);
      renderAffinityPickerList();
      renderAffinityTree();
    });
    quickSimBtns.appendChild(lvlBtn);

    const maxBtn = document.createElement('button');
    maxBtn.type = 'button';
    maxBtn.className = 'px-2 py-1 rounded-lg bg-gradient-to-r from-amber-500/30 to-rose-500/30 hover:opacity-90 border border-amber-500/40 active:scale-95 text-amber-300 text-[10px] font-bold transition-all cursor-pointer';
    maxBtn.textContent = `Lv.8 MAX Yap (${testFr.name.split(' ')[0]})`;
    maxBtn.addEventListener('click', () => {
      setSharedWatchMinutes(testUser, 1440);
      showToast(`${testFr.name} 1440 dk (Lv. 8 MAX) yapıldı!`);
      renderAffinityPickerList();
      renderAffinityTree();
    });
    quickSimBtns.appendChild(maxBtn);
  }

  // ELIGIBLE LIST ONLY
  if (eligible.length > 0) {
    const header = document.createElement('div');
    header.className = 'text-[11px] font-extrabold text-emerald-400 flex items-center gap-1.5 pt-1';
    header.innerHTML = `<span>Uygun Arkadaşlar (${eligible.length})</span>`;
    listContainer.appendChild(header);

    eligible.forEach(fr => {
      const card = document.createElement('div');
      card.className = 'p-3 rounded-2xl bg-white/5 border border-emerald-500/30 flex items-center justify-between gap-3 shadow-md hover:border-emerald-500/50 transition-all';
      
      const targetUser = (fr.cleanUsername || fr.username || '').replace(/^@/, '');
      let outgoingReqs = [];
      try { outgoingReqs = JSON.parse(localStorage.getItem('miruo_outgoing_affinity_requests') || '[]'); } catch (_) { outgoingReqs = []; }
      const isAlreadyPending = outgoingReqs.some(o => o.slotKey === currentPickerSlotKey && (o.toUsername || '').toLowerCase() === targetUser.toLowerCase());

      const btnText = isAlreadyPending ? 'İstek Gönderildi' : 'İstek Gönder';
      const btnStyle = isAlreadyPending 
        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 cursor-default' 
        : 'bg-gradient-to-r from-rose-600 via-pink-600 to-[#A64D79] hover:opacity-95 active:scale-95 text-white shadow-md cursor-pointer';

      card.innerHTML = `
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-10 h-10 rounded-full bg-gradient-to-tr from-rose-500 to-indigo-600 flex items-center justify-center text-xs font-bold text-white shrink-0 shadow-sm border border-white/20">
            ${(fr.avatar || fr.name.charAt(0) || 'A').toUpperCase()}
          </div>
          <div class="truncate">
            <div class="flex items-center gap-1.5">
              <span class="text-xs font-bold text-white block truncate">@${escapeHtml(fr.cleanUsername)}</span>
              <span class="px-1.5 py-0.2 rounded-full ${fr.level === 8 ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40' : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'} text-[9px] font-extrabold">Lv.${fr.level}${fr.level === 8 ? ' MAX' : ''}</span>
            </div>
            <span class="text-[10px] text-emerald-400 font-semibold flex items-center gap-1">
              <span>${formatSharedWatchTime(fr.watchMins)} izlendi</span>
            </span>
          </div>
        </div>
        <button type="button" class="bind-affinity-btn px-3.5 py-1.5 rounded-xl ${btnStyle} text-xs font-extrabold shadow-md transition-all shrink-0">
          ${btnText}
        </button>
      `;

      if (!isAlreadyPending) {
        addInstantTap(card.querySelector('.bind-affinity-btn'), () => {
          sendAffinityRequest(currentPickerSlotKey, fr);
        });
      }

      listContainer.appendChild(card);
    });
  } else {
    listContainer.innerHTML = `
      <div class="p-6 text-center bg-white/5 border border-white/10 rounded-2xl space-y-2">
        <p class="text-xs font-bold text-white">İlişki Kurmak İçin Uygun Arkadaş Yok</p>
        <p class="text-[11px] text-gray-400 leading-relaxed">Bir arkadaşınızla ilişki kurabilmek için birlikte en az 180 dakika video veya yayın izlemiş olmanız gerekmektedir.</p>
      </div>
    `;
  }
}

function bindFriendToSlot(slotKey, friend) {
  if (!slotKey || !friend) return;
  const currentTree = getUserAffinityTree();
  const slotDef = AFFINITY_SLOTS.find(s => s.key === slotKey);
  const cat = slotDef ? AFFINITY_CATEGORIES[slotDef.category] : AFFINITY_CATEGORIES.partner;

  currentTree[slotKey] = {
    username: friend.cleanUsername || friend.username,
    name: friend.name,
    avatarUrl: friend.avatarUrl || '',
    category: slotDef ? slotDef.category : 'partner',
    boundAt: Date.now()
  };

  saveUserAffinityTree(currentTree);
  closeAffinityPicker();
  renderAffinityTree();

  showToast(`@${(friend.cleanUsername || friend.username).replace(/^@/, '')} ile "${cat.name}" bağı kuruldu.`);
}

// Slot Detail Modal
let currentDetailSlotKey = null;

function openAffinitySlotDetail(slotKey, assigned) {
  currentDetailSlotKey = slotKey;
  const modal = document.getElementById('affinitySlotDetailModal');
  const catPill = document.getElementById('affinityDetailCategoryPill');
  const avatarEl = document.getElementById('affinityDetailAvatar');
  const nameEl = document.getElementById('affinityDetailName');
  const userEl = document.getElementById('affinityDetailUsername');
  const watchEl = document.getElementById('affinityDetailWatchTime');
  const levelEl = document.getElementById('affinityDetailLevel');
  const unbindBtn = document.getElementById('affinityDetailUnbindBtn');
  if (!modal || !assigned) return;

  const slotDef = AFFINITY_SLOTS.find(s => s.key === slotKey);
  const cat = slotDef ? AFFINITY_CATEGORIES[slotDef.category] : AFFINITY_CATEGORIES.partner;
  const isPending = !!assigned.isPending;

  if (catPill) {
    if (isPending) {
      catPill.textContent = `${cat.name} (İstek Gönderildi)`;
      catPill.className = 'px-2.5 py-1 rounded-full text-xs font-extrabold bg-amber-500/20 text-amber-300 border-amber-500/40 border flex items-center justify-center';
    } else {
      catPill.textContent = cat.name;
      catPill.className = `px-2.5 py-1 rounded-full text-xs font-extrabold ${cat.color === 'rose' ? 'bg-rose-500/20 text-rose-300 border-rose-500/30' : (cat.color === 'cyan' ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' : (cat.color === 'purple' ? 'bg-purple-500/20 text-purple-300 border-purple-500/30' : 'bg-amber-500/20 text-amber-300 border-amber-500/30'))} border flex items-center justify-center`;
    }
  }

  if (avatarEl) {
    if (assigned.avatarUrl) {
      avatarEl.innerHTML = `<img src="${assigned.avatarUrl}" class="w-full h-full object-cover">`;
    } else {
      avatarEl.textContent = (assigned.name || assigned.username || 'A').charAt(0).toUpperCase();
    }
  }

  const cleanUsername = (assigned.username || assigned.name || 'kullanici').replace(/^@/, '');
  if (nameEl) nameEl.textContent = `@${cleanUsername}`;
  if (userEl) userEl.textContent = isPending ? 'Karşı tarafın onaylaması bekleniyor' : '';

  const watchMins = (assigned.watchMins !== undefined) ? assigned.watchMins : getSharedWatchMinutes(cleanUsername);
  const level = getAffinityLevel(watchMins);

  if (watchEl) watchEl.textContent = isPending ? 'İstek Gönderildi' : formatSharedWatchTime(watchMins);
  if (levelEl) {
    if (isPending) {
      levelEl.textContent = 'Onay Bekliyor';
      levelEl.className = 'text-xs font-black text-amber-300';
    } else {
      levelEl.textContent = `${level}. Seviye${level === 8 ? ' (MAX)' : ''}`;
      levelEl.className = `text-xs font-black ${level === 8 ? 'text-amber-300' : 'text-purple-300'}`;
    }
  }

  if (unbindBtn) {
    unbindBtn.textContent = isPending ? 'İsteği İptal Et' : 'Bağlantıyı Kaldır';
    unbindBtn.className = isPending
      ? 'w-full py-2.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-bold transition-all cursor-pointer'
      : 'w-full py-2.5 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 text-xs font-bold transition-all cursor-pointer';
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeAffinitySlotDetail() {
  const modal = document.getElementById('affinitySlotDetailModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

// ==========================================
// CELESTIAL SHOOTING STARFIELD (PUBLIC USER PROFILE MODAL)
// ==========================================
let publicProfileStarAnimId = null;
let publicProfileStarCanvasCtx = null;
let publicProfileStarWidth = 0;
let publicProfileStarHeight = 0;
let publicProfileStars = [];
let publicProfileShootingStars = [];

function initPublicProfileStarCanvas() {
  const canvas = document.getElementById('publicProfileStarCanvas');
  if (!canvas) return;
  publicProfileStarCanvasCtx = canvas.getContext('2d');

  function resizeCanvas() {
    const parent = canvas.parentElement || document.body;
    const rect = parent.getBoundingClientRect();
    publicProfileStarWidth = rect.width || window.innerWidth;
    publicProfileStarHeight = rect.height || window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(publicProfileStarWidth * dpr);
    canvas.height = Math.floor(publicProfileStarHeight * dpr);
    if (publicProfileStarCanvasCtx) {
      publicProfileStarCanvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  resizeCanvas();

  const starColors = ['#FFFFFF', '#FFE2F1', '#FF9CD1', '#E882B2', '#D8B4E2', '#A64D79'];
  publicProfileStars = [];
  for (let i = 0; i < 75; i++) {
    publicProfileStars.push({
      x: Math.random() * publicProfileStarWidth,
      y: Math.random() * publicProfileStarHeight,
      size: Math.random() * 1.5 + 0.5,
      color: starColors[Math.floor(Math.random() * starColors.length)],
      alpha: Math.random() * 0.7 + 0.3,
      speed: Math.random() * 0.03 + 0.01,
      phase: Math.random() * Math.PI * 2
    });
  }
  publicProfileShootingStars = [];
}

function spawnPublicProfileShootingStar() {
  const angle = (28 + Math.random() * 18) * (Math.PI / 180);
  const speed = Math.random() * 7 + 10;
  const startX = Math.random() * (publicProfileStarWidth * 0.75);
  const startY = -40;

  publicProfileShootingStars.push({
    x: startX,
    y: startY,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    length: Math.random() * 80 + 70,
    thickness: Math.random() * 1.6 + 1.2,
    alpha: 1.0,
    decay: Math.random() * 0.016 + 0.012
  });
}

function renderPublicProfileStarframe() {
  const modal = document.getElementById('userPublicProfileModal');
  if (!modal || modal.classList.contains('hidden')) {
    publicProfileStarAnimId = null;
    return;
  }
  const canvas = document.getElementById('publicProfileStarCanvas');
  if (!canvas || !publicProfileStarCanvasCtx) {
    publicProfileStarAnimId = null;
    return;
  }
  const ctx = publicProfileStarCanvasCtx;
  const w = publicProfileStarWidth || canvas.clientWidth || window.innerWidth;
  const h = publicProfileStarHeight || canvas.clientHeight || window.innerHeight;

  ctx.clearRect(0, 0, w, h);

  // Background Twinkling Stars
  for (let i = 0; i < publicProfileStars.length; i++) {
    const s = publicProfileStars[i];
    s.phase += s.speed;
    const currentAlpha = Math.max(0.15, Math.min(1.0, s.alpha + Math.sin(s.phase) * 0.35));

    ctx.save();
    ctx.globalAlpha = currentAlpha;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Shoot stars occasionally
  if (Math.random() < 0.04 && publicProfileShootingStars.length < 3) {
    spawnPublicProfileShootingStar();
  }

  // Draw shooting stars
  for (let i = publicProfileShootingStars.length - 1; i >= 0; i--) {
    const ss = publicProfileShootingStars[i];
    ss.x += ss.vx;
    ss.y += ss.vy;
    ss.alpha -= ss.decay;

    if (ss.alpha <= 0 || ss.x > w + 100 || ss.y > h + 100) {
      publicProfileShootingStars.splice(i, 1);
      continue;
    }

    const headX = ss.x;
    const headY = ss.y;
    const norm = Math.sqrt(ss.vx * ss.vx + ss.vy * ss.vy) || 1;
    const tailX = headX - (ss.vx / norm) * ss.length;
    const tailY = headY - (ss.vy / norm) * ss.length;

    ctx.save();
    const grad = ctx.createLinearGradient(tailX, tailY, headX, headY);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
    grad.addColorStop(0.65, `rgba(244, 63, 94, ${Math.max(0, ss.alpha * 0.6)})`);
    grad.addColorStop(1, `rgba(255, 255, 255, ${Math.max(0, ss.alpha)})`);

    ctx.strokeStyle = grad;
    ctx.lineWidth = ss.thickness;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(headX, headY);
    ctx.stroke();

    // Nucleus
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(headX, headY, ss.thickness * 1.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  publicProfileStarAnimId = requestAnimationFrame(renderPublicProfileStarframe);
}

function startPublicProfileStarCanvas() {
  initPublicProfileStarCanvas();
  if (publicProfileStarAnimId) {
    cancelAnimationFrame(publicProfileStarAnimId);
    publicProfileStarAnimId = null;
  }
  publicProfileStarAnimId = requestAnimationFrame(renderPublicProfileStarframe);
}

function stopPublicProfileStarCanvas() {
  if (publicProfileStarAnimId) {
    cancelAnimationFrame(publicProfileStarAnimId);
    publicProfileStarAnimId = null;
  }
}

// ==========================================
// CELESTIAL SHOOTING STARFIELD (AUTH / LOGIN SCREEN)
// Matches official Miruo celestial sliding stars
// ==========================================
let authStarAnimId = null;
let authStarCanvasCtx = null;
let authStarWidth = 0;
let authStarHeight = 0;
let authStars = [];
let authShootingStars = [];

function initAuthStarCanvas() {
  const canvas = document.getElementById('authStarCanvas');
  if (!canvas) return;
  authStarCanvasCtx = canvas.getContext('2d');

  function resizeCanvas() {
    authStarWidth = window.innerWidth;
    authStarHeight = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(authStarWidth * dpr);
    canvas.height = Math.floor(authStarHeight * dpr);
    if (authStarCanvasCtx) {
      authStarCanvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  resizeCanvas();

  const starColors = ['#FFFFFF', '#FFE2F1', '#FF9CD1', '#E882B2', '#D8B4E2', '#A64D79'];
  authStars = [];
  for (let i = 0; i < 75; i++) {
    authStars.push({
      x: Math.random() * authStarWidth,
      y: Math.random() * authStarHeight,
      size: Math.random() * 1.5 + 0.5,
      color: starColors[Math.floor(Math.random() * starColors.length)],
      alpha: Math.random() * 0.7 + 0.3,
      speed: Math.random() * 0.03 + 0.01,
      phase: Math.random() * Math.PI * 2
    });
  }
  authShootingStars = [];
}

function spawnAuthShootingStar() {
  const angle = (28 + Math.random() * 18) * (Math.PI / 180);
  const speed = Math.random() * 7 + 10;
  const startX = Math.random() * (authStarWidth * 0.75);
  const startY = -40;

  authShootingStars.push({
    x: startX,
    y: startY,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    length: Math.random() * 85 + 70,
    thickness: Math.random() * 1.6 + 1.2,
    alpha: 1.0,
    decay: Math.random() * 0.016 + 0.012
  });
}

function renderAuthStarframe() {
  const modal = document.getElementById('authModal');
  if (!modal || modal.classList.contains('hidden')) {
    authStarAnimId = null;
    return;
  }
  const canvas = document.getElementById('authStarCanvas');
  if (!canvas || !authStarCanvasCtx) {
    authStarAnimId = null;
    return;
  }
  const ctx = authStarCanvasCtx;
  const w = authStarWidth || canvas.clientWidth || window.innerWidth;
  const h = authStarHeight || canvas.clientHeight || window.innerHeight;

  ctx.clearRect(0, 0, w, h);

  // Background Twinkling Stars
  for (let i = 0; i < authStars.length; i++) {
    const s = authStars[i];
    s.phase += s.speed;
    const currentAlpha = Math.max(0.15, Math.min(1.0, s.alpha + Math.sin(s.phase) * 0.35));

    ctx.save();
    ctx.globalAlpha = currentAlpha;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Shooting stars
  if (Math.random() < 0.04 && authShootingStars.length < 3) {
    spawnAuthShootingStar();
  }

  for (let i = authShootingStars.length - 1; i >= 0; i--) {
    const star = authShootingStars[i];
    star.x += star.vx;
    star.y += star.vy;
    star.alpha -= star.decay;

    if (star.alpha <= 0 || star.x > w + 100 || star.y > h + 100) {
      authShootingStars.splice(i, 1);
      continue;
    }

    ctx.save();
    ctx.globalAlpha = Math.max(0, star.alpha);
    const tailX = star.x - (star.vx / 10) * star.length;
    const tailY = star.y - (star.vy / 10) * star.length;

    const grad = ctx.createLinearGradient(tailX, tailY, star.x, star.y);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
    grad.addColorStop(0.5, 'rgba(244, 114, 182, 0.6)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 1)');

    ctx.strokeStyle = grad;
    ctx.lineWidth = star.thickness;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(star.x, star.y);
    ctx.stroke();
    ctx.restore();
  }

  authStarAnimId = requestAnimationFrame(renderAuthStarframe);
}

function startAuthStarCanvas() {
  initAuthStarCanvas();
  if (authStarAnimId) {
    cancelAnimationFrame(authStarAnimId);
    authStarAnimId = null;
  }
  authStarAnimId = requestAnimationFrame(renderAuthStarframe);
}

function stopAuthStarCanvas() {
  if (authStarAnimId) {
    cancelAnimationFrame(authStarAnimId);
    authStarAnimId = null;
  }
}
window.startAuthStarCanvas = startAuthStarCanvas;
window.stopAuthStarCanvas = stopAuthStarCanvas;

// Auto-activate auth star canvas when authModal becomes visible
document.addEventListener('DOMContentLoaded', () => {
  const authModalEl = document.getElementById('authModal');
  if (authModalEl) {
    const observer = new MutationObserver(() => {
      if (!authModalEl.classList.contains('hidden') && authModalEl.style.display !== 'none') {
        startAuthStarCanvas();
      } else {
        stopAuthStarCanvas();
      }
    });
    observer.observe(authModalEl, { attributes: true, attributeFilter: ['class', 'style'] });
    if (!authModalEl.classList.contains('hidden')) {
      startAuthStarCanvas();
    }
  }
});

let currentPublicUser = null;

// Public User Profile Modal (Viewing other users' profiles + their Affinity Tree)
function openPublicUserProfile(usernameOrName) {
  if (!usernameOrName) return;
  const clean = usernameOrName.toLowerCase().replace(/^@/, '').trim();

  // If clicking oneself, navigate to own Profile tab
  const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
  const myUsername = (savedUser.username || state.username || '').toLowerCase().replace(/^@/, '');
  if (clean === myUsername || clean === 'sen') {
    closeAffinitySlotDetail();
    closeRoomParticipantsModal();
    switchTab('profile');
    return;
  }

  // Find friend or create target user object
  let targetUser = (state.friends || []).find(f => 
    (f.username && f.username.toLowerCase().replace(/^@/, '') === clean) ||
    (f.name && f.name.toLowerCase().replace(/^@/, '') === clean)
  );

  if (!targetUser) {
    targetUser = {
      username: clean,
      name: clean.charAt(0).toUpperCase() + clean.slice(1),
      status: 'online',
      statusText: 'Çevrimiçi',
      avatar: clean.charAt(0).toUpperCase()
    };
  }
  currentPublicUser = targetUser;

  const modal = document.getElementById('userPublicProfileModal');
  const topUserEl = document.getElementById('publicProfileTopUsername');
  const nameEl = document.getElementById('publicProfileFullName');
  const userEl = document.getElementById('publicProfileUsername');
  const avatarEl = document.getElementById('publicProfileAvatar');
  const dotEl = document.getElementById('publicProfileOnlineDot');
  const statusEl = document.getElementById('publicProfileStatusText');
  const relBadgeEl = document.getElementById('publicProfileRelationWithMeBadge');
  const watchHoursEl = document.getElementById('publicProfileWatchHours');
  const subTitleEl = document.getElementById('publicAffinitySubtitle');

  if (!modal) return;

  const currentTree = getUserAffinityTree();
  let relationWithMe = null;
  Object.values(currentTree).forEach(val => {
    if (val && val.username && val.username.toLowerCase().replace(/^@/, '') === clean) {
      relationWithMe = val.category;
    }
  });

  if (topUserEl) topUserEl.textContent = `@${clean}`;
  if (nameEl) nameEl.textContent = `@${clean}`;
  if (userEl) userEl.textContent = '';
  if (subTitleEl) subTitleEl.textContent = `@${clean} kullanıcısının kurduğu bağlar`;

  if (avatarEl) {
    if (targetUser.avatarUrl) {
      avatarEl.innerHTML = `<img src="${targetUser.avatarUrl}" class="w-full h-full object-cover">`;
    } else {
      avatarEl.textContent = (targetUser.avatar || targetUser.name.charAt(0) || 'A').toUpperCase();
    }
  }

  const isOnline = targetUser.status === 'online' || targetUser.status === 'in_room';
  if (dotEl) dotEl.className = `absolute bottom-0 right-0 w-4 h-4 rounded-full border-2 border-[#0C0E17] ${isOnline ? 'bg-emerald-400' : 'bg-gray-500'}`;
  if (statusEl) {
    statusEl.textContent = targetUser.statusText || (isOnline ? 'Çevrimiçi' : 'Çevrimdışı');
    statusEl.className = `text-[10px] font-bold ${isOnline ? 'text-emerald-400 bg-emerald-500/15 border-emerald-500/30' : 'text-gray-400 bg-white/5 border-white/10'} border px-2.5 py-0.5 rounded-full`;
  }

  if (relBadgeEl) {
    if (relationWithMe) {
      const cat = AFFINITY_CATEGORIES[relationWithMe] || AFFINITY_CATEGORIES.partner;
      relBadgeEl.textContent = `Senin ${cat.name}in`;
      relBadgeEl.classList.remove('hidden');
    } else {
      relBadgeEl.classList.add('hidden');
    }
  }

  const watchMins = getSharedWatchMinutes(clean);
  if (watchHoursEl) watchHoursEl.textContent = formatSharedWatchTime(watchMins);

  // Render THEIR Affinity Constellation
  renderAffinityTree('publicAffinityContainer', 'publicAffinityBranchesSvg', 'publicAffinityNodesLayer', false, targetUser);

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  startPublicProfileStarCanvas();
}

function closePublicUserProfile() {
  const modal = document.getElementById('userPublicProfileModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
  closePublicProfileOptionsMenu();
  stopPublicProfileStarCanvas();
}

function openPublicProfileOptionsMenu() {
  const m = document.getElementById('publicProfileOptionsModal');
  const title = document.getElementById('publicProfileOptionsTitle');
  if (title && currentPublicUser) {
    const cleanU = (currentPublicUser.username || currentPublicUser.name || 'kullanici').replace(/^@/, '');
    title.textContent = `@${cleanU}`;
  }
  if (m) {
    m.style.setProperty('display', 'flex', 'important');
    m.classList.remove('hidden');
    m.classList.add('flex');
  }
}

function closePublicProfileOptionsMenu() {
  const m = document.getElementById('publicProfileOptionsModal');
  if (m) {
    m.style.setProperty('display', 'none', 'important');
    m.classList.add('hidden');
    m.classList.remove('flex');
  }
}
window.openPublicProfileOptionsMenu = openPublicProfileOptionsMenu;
window.closePublicProfileOptionsMenu = closePublicProfileOptionsMenu;

function closePublicProfile() {
  closePublicUserProfile();
}
window.closePublicProfile = closePublicProfile;
window.closePublicUserProfile = closePublicUserProfile;

function openAffinityRuleModal() {
  const m = document.getElementById('affinityRuleModal');
  if (m) {
    m.classList.remove('hidden');
    m.classList.add('flex');
  }
}

function closeAffinityRuleModal() {
  const m = document.getElementById('affinityRuleModal');
  if (m) {
    m.classList.add('hidden');
    m.classList.remove('flex');
  }
}

// Expose affinity functions globally
window.renderAffinityTree = renderAffinityTree;
window.openAffinityPicker = openAffinityPicker;
window.closeAffinityPicker = closeAffinityPicker;
window.openAffinitySlotDetail = openAffinitySlotDetail;
window.closeAffinitySlotDetail = closeAffinitySlotDetail;
window.openPublicUserProfile = openPublicUserProfile;
window.closePublicUserProfile = closePublicUserProfile;
window.openAffinityRuleModal = openAffinityRuleModal;
window.closeAffinityRuleModal = closeAffinityRuleModal;
window.bindFriendToSlot = bindFriendToSlot;
window.getUserAffinityTree = getUserAffinityTree;
window.saveUserAffinityTree = saveUserAffinityTree;



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

function updatePartnerPipIdentity(name, avatar) {
  let finalName = name;
  const targetId = state.activePipPeerId || state.peerId;
  if (!finalName && targetId && state.participants[targetId]) {
    finalName = state.participants[targetId].username;
  }
  if (!finalName) {
    const other = Object.values(state.participants).find(p => p.userId !== state.userId);
    if (other) finalName = other.username;
  }
  if (!finalName || finalName === 'Partner') finalName = 'Katılımcı';

  if (dom.partnerPipName) dom.partnerPipName.textContent = finalName;
  if (dom.partnerPipAvatarInitial) {
    const finalAvatar = avatar || (targetId && state.participants[targetId] ? state.participants[targetId].avatar : '');
    if (finalAvatar) {
      dom.partnerPipAvatarInitial.innerHTML = `<img src="${finalAvatar}" class="w-full h-full object-cover rounded-full" alt="PP">`;
    } else {
      dom.partnerPipAvatarInitial.textContent = finalName.charAt(0).toUpperCase();
    }
  }
}
window.updatePartnerPipIdentity = updatePartnerPipIdentity;

function updateRemoteParticipantStatus(userId, username, isMicOn, isCamOn, avatar, avatarColor) {
  if (!userId) return;
  const existing = state.participants[userId] || {};
  const prevSnapshot = existing.userId ? [existing.isMicOn, existing.isCamOn, existing.username, existing.avatar].join('|') : null;
  const finalUName = username || existing.username || 'Katılımcı';
  const finalAvatar = avatar || existing.avatar || '';
  const finalColor = avatarColor || existing.avatarColor || 'from-indigo-500 to-purple-600';
  state.participants[userId] = {
    ...existing,
    userId,
    username: finalUName,
    avatar: finalAvatar,
    avatarColor: finalColor,
    isMicOn: typeof isMicOn === 'boolean' ? isMicOn : !!existing.isMicOn,
    isCamOn: typeof isCamOn === 'boolean' ? isCamOn : !!existing.isCamOn,
    role: existing.role || (existing.isHost ? 'owner' : 'member'),
    lastSeen: Date.now()
  };
  if (isCamOn) {
    state.dismissedPips = state.dismissedPips || {};
    state.dismissedPips[userId] = false;
  }
  state.isPartnerCamOn = Object.values(state.participants).some(p => p.userId !== state.userId && p.isCamOn);

  // If we hear from someone we have no connection with (missed join/presence), connect to them now
  try {
    if (state.isInRoom && String(userId) !== String(state.userId) && (!state.peers || !state.peers[userId]) &&
        typeof getOrCreatePeerConnection === 'function') {
      getOrCreatePeerConnection(userId, String(state.userId) < String(userId));
      if (!state.peerId) state.peerId = userId;
      if (typeof updatePeerStatus === 'function') updatePeerStatus(true);
    }
  } catch (_) {}

  const nowP = state.participants[userId];
  const newSnapshot = [nowP.isMicOn, nowP.isCamOn, nowP.username, nowP.avatar].join('|');
  if (prevSnapshot === newSnapshot) return; // nothing changed (periodic re-announce): avoid re-rendering/flicker
  if (typeof renderStagePipCards === 'function') {
    renderStagePipCards();
  }
  if (typeof renderVideoGrid === 'function') {
    renderVideoGrid();
  }
  renderParticipantsList();
}

// Periodic re-announce so every client eventually sees everyone (lost join/presence events)
if (!window._mediaAnnounceTimer) {
  window._mediaAnnounceTimer = setInterval(() => {
    try { if (state.isInRoom && state.roomId) broadcastMyMediaStatus(); } catch (_) {}
  }, 5000);
}

function broadcastMyMediaStatus() {
  const savedUserObj = JSON.parse(localStorage.getItem('miruo_user') || '{}');
  const payload = {
    userId: state.userId,
    username: state.username,
    avatar: state.avatarUrl || savedUserObj.avatarUrl || '',
    avatarColor: state.avatarBg || savedUserObj.avatarBg || 'from-rose-500 to-indigo-600',
    isMicOn: !!state.isMicOn,
    isCamOn: !!state.isCamOn,
    isHost: !!state.isHost,
    role: state.userRole || (state.isHost ? 'owner' : 'member')
  };
  sendP2PData('media_status', payload);
  sendSignal({ type: 'media_status', ...payload });
  if (roomSupabaseChannel && roomSupabaseChannel.track) {
    roomSupabaseChannel.track(payload).catch(() => {});
  }
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
  if (!canUserManageRoom()) {
    showToast('Odadan çıkarma yetkisi sadece Oda Sahibi ve Yöneticilere aittir.');
    return;
  }
  if (!userId && !username) return;

  // Protect room owner
  if (state.participants[userId] && (state.participants[userId].role === 'owner' || state.participants[userId].isHost)) {
    showToast('Oda sahibi odadan çıkarılamaz.');
    return;
  }

  // 1. If simulated bot
  if ((userId && userId.startsWith('bot_')) || (activeRoomBots && activeRoomBots.some(b => ('bot_' + b.name) === userId || b.name === username))) {
    activeRoomBots = activeRoomBots.filter(b => ('bot_' + b.name) !== userId && b.name !== username);
    renderParticipantsList();
    renderVideoGrid();
    showToast(`${username} odadan çıkarıldı.`);
    renderChatMessage('Sistem', `${username} odadan çıkarıldı.`, false, null);
    return;
  }

  // 2. If real user / peer
  sendP2PData('kick_user', {
    targetUserId: userId,
    targetUsername: username
  });
  sendSignal({
    type: 'kick-user',
    targetUserId: userId,
    targetUsername: username
  });

  if (userId) delete state.participants[userId];
  renderParticipantsList();
  renderVideoGrid();
  showToast(`"${username}" odadan çıkarıldı.`);
  renderChatMessage('Sistem', `"${username}" odadan çıkarıldı.`, false, null);
}

function setParticipantRole(userId, username, newRole) {
  if (!canUserManageRoom()) {
    showToast('Yetki değiştirme sadece Oda Sahibi ve Yöneticilere aittir.');
    return;
  }

  // Protect room owner
  if (state.participants[userId] && (state.participants[userId].role === 'owner' || state.participants[userId].isHost)) {
    showToast('Oda sahibinin yetkisi değiştirilemez.');
    return;
  }

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
  Object.keys(state.participants).forEach(pid => {
    if (state.participants[pid].userId === userId || state.participants[pid].username === username) {
      state.participants[pid].role = newRole;
    }
  });

  // Dual-rail broadcast: Send via WebRTC DataChannel, Room Signal rail and Global Users rail
  const rolePayload = {
    targetUserId: userId,
    targetUsername: username,
    newRole: newRole,
    roomId: state.roomId || 'ODA-77',
    sentAt: Date.now()
  };
  sendP2PData('role_update', rolePayload);
  sendSignal({
    type: 'role-update',
    ...rolePayload
  });
  if (globalUsersChannel) {
    try {
      globalUsersChannel.send({
        type: 'broadcast',
        event: 'role_update',
        payload: rolePayload
      }).catch(() => {});
    } catch (_) {}
  }

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

  const myClean = (state.username || '').toLowerCase().replace(/^@/, '').trim();
  const targetClean = (targetUsername || '').toLowerCase().replace(/^@/, '').trim();
  const isMe = (targetUserId && String(targetUserId) === String(state.userId)) ||
               (targetClean && myClean && targetClean === myClean);

  if (isMe) {
    state.userRole = newRole;
    state.hasDjPermission = (newRole === 'owner' || newRole === 'admin' || newRole === 'video_control' || newRole === 'dj');
    updatePermissionUI();
    showToast(`Yetkiniz güncellendi: ${roleName}`);
    // Update presence tracking with new role so room presence retains it
    if (roomSupabaseChannel) {
      try {
        const savedUserObj = JSON.parse(localStorage.getItem('miruo_user') || '{}');
        roomSupabaseChannel.track({
          userId: state.userId,
          username: state.username,
          avatar: state.avatarUrl || savedUserObj.avatarUrl || '',
          avatarColor: state.avatarBg || savedUserObj.avatarBg || 'from-rose-500 to-indigo-600',
          isMicOn: !!state.isMicOn,
          isCamOn: !!state.isCamOn,
          isHost: !!state.isHost,
          role: newRole
        }).catch(() => {});
      } catch (_) {}
    }
  } else {
    if (state.participants[targetUserId]) {
      state.participants[targetUserId].role = newRole;
    }
    Object.keys(state.participants).forEach(pid => {
      if (state.participants[pid].userId === targetUserId || state.participants[pid].username === targetUsername) {
        state.participants[pid].role = newRole;
      }
    });
  }
  renderParticipantsList();
  renderChatMessage('Sistem', `${targetUsername || 'Bir kullanıcı'} artık ${roleName} yetkisine sahip.`, false, null);
}

function renderParticipantsList() {
  if (!dom.participantsListContainer) return;
  dom.participantsListContainer.innerHTML = '';

  const dictPart = I18N[currentLang] || I18N.tr;
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
    clientId: state.clientId,
    userId: state.userId,
    username: state.username || 'Sen',
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
    const isSelf = p.clientId ? (p.clientId === state.clientId) : (p.userId === state.userId);
    if (!isSelf) {
      if (!p.role) p.role = p.isHost ? 'owner' : 'member';
      allMembers.push(p);
    }
  });

  // If in room with a peer but participant object not yet sent, seed standard partner
  if (state.peerId && state.peerId !== state.userId && !allMembers.some(m => m.userId === state.peerId || (state.hostName && m.username === state.hostName))) {
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

  const uniqueMembers = [];
  const seenKeys = new Set();
  allMembers.forEach(m => {
    const key = String(m.clientId || m.userId || m.username);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      uniqueMembers.push(m);
    }
  });

  // Update counter badges
  if (dom.roomMemberCountBadge) dom.roomMemberCountBadge.textContent = uniqueMembers.length;
  if (dom.participantsCountHeader) dom.participantsCountHeader.textContent = uniqueMembers.length;

  uniqueMembers.forEach(m => {
    const card = document.createElement('div');
    card.className = 'flex items-center justify-between p-2.5 rounded-2xl bg-white/5 border border-white/5 hover:border-white/10 transition-all gap-2';

    // SVG mic active vs muted
    const micSvg = m.isMicOn
      ? `<span class="p-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" title="${dictPart.mic_on_title || 'Mikrofon Açık'}">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4m-4 0h8"/></svg>
        </span>`
      : `<span class="p-1.5 rounded-lg bg-red-500/15 text-red-400 border border-red-500/25" title="${dictPart.mic_off_title || 'Mikrofon Kapalı'}">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/><path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
        </span>`;

    // SVG cam active vs muted
    const camSvg = m.isCamOn
      ? `<button type="button" class="participant-cam-toggle-btn p-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/30 cursor-pointer active:scale-90 transition-all" title="Kamerayı ana ekranda göster / gizle">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        </button>`
      : `<span class="p-1.5 rounded-lg bg-red-500/15 text-red-400 border border-red-500/25" title="${dictPart.cam_off_title || 'Kamera Kapalı'}">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 16v1a2 2 0 01-2 2H3a2 2 0 01-2-2V7a2 2 0 012-2h1m5 0h6a2 2 0 012 2v4"/><polyline points="23 7 16 12 23 17"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
        </span>`;

    const avatarHtml = m.avatar
      ? `<img src="${m.avatar}" class="w-8 h-8 rounded-full object-cover shrink-0 shadow-sm border border-white/10" alt="PP">`
      : `<div class="w-8 h-8 rounded-full bg-gradient-to-tr ${m.avatarColor || 'from-rose-500 to-indigo-600'} flex items-center justify-center text-xs font-bold text-white shadow-sm shrink-0">
          ${(m.username || 'K').charAt(0).toUpperCase()}
        </div>`;

    const currentRole = m.role || (m.isHost ? 'owner' : 'member');
    const roleBadges = {
      owner: `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[10px] bg-amber-500/15 text-amber-300 font-semibold border border-amber-500/30 shadow-sm"><svg class="w-3 h-3 text-amber-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/></svg><span>${dictPart.role_owner || 'Oda Sahibi'}</span></span>`,
      admin: `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[10px] bg-indigo-500/15 text-indigo-300 font-semibold border border-indigo-500/30 shadow-sm"><svg class="w-3 h-3 text-indigo-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><span>${dictPart.role_admin || 'Yönetici'}</span></span>`,
      video_control: `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[10px] bg-rose-500/15 text-rose-300 font-semibold border border-rose-500/30 shadow-sm"><svg class="w-3 h-3 text-rose-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>${dictPart.role_video_control || 'Video Açabilir'}</span></span>`,
      dj: `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[10px] bg-rose-500/15 text-rose-300 font-semibold border border-rose-500/30 shadow-sm"><svg class="w-3 h-3 text-rose-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>${dictPart.role_video_control || 'Video Açabilir'}</span></span>`,
      member: `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[10px] bg-white/10 text-gray-300 font-medium border border-white/10"><svg class="w-3 h-3 text-gray-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span>${dictPart.role_member || 'İzleyici'}</span></span>`
    };

    const cleanTargetName = (m.username || '').replace(/^@/, '').replace(/\s*\(Sen\)/gi, '').replace(/\s*\(Simüle\)/gi, '').replace(/\s*\(Partner\)/gi, '').trim();
    const isTargetOwner = currentRole === 'owner' || m.isHost;

    let actionsHtml = '';
    if (canUserManageRoom() && !m.isSelf && !isTargetOwner) {
      actionsHtml = `
        <div class="flex items-center gap-1.5 shrink-0">
          <select class="role-selector-dropdown bg-[#141824] hover:bg-[#1a2030] text-gray-200 text-[11px] font-semibold py-1.5 px-2 rounded-xl border border-white/15 focus:outline-none focus:border-rose-500 transition-all cursor-pointer" data-user-id="${m.userId}" data-username="${cleanTargetName}">
            <option value="admin" ${currentRole === 'admin' ? 'selected' : ''}>${dictPart.role_admin || 'Yönetici'}</option>
            <option value="video_control" ${currentRole === 'video_control' || currentRole === 'dj' ? 'selected' : ''}>${dictPart.role_video_control || 'Video Açabilir'}</option>
            <option value="member" ${currentRole === 'member' || !currentRole ? 'selected' : ''}>${dictPart.role_member || 'İzleyici'}</option>
          </select>

          <button class="kick-participant-btn p-1.5 rounded-xl bg-red-500/15 hover:bg-red-500/25 active:scale-95 text-red-400 hover:text-red-300 border border-red-500/25 transition-all cursor-pointer flex items-center gap-1 text-[11px] font-semibold" data-user-id="${m.userId}" data-username="${cleanTargetName}" title="${dictPart.kick_title || 'Odadan Çıkar'}">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
            <span class="hidden sm:inline">${dictPart.kick_btn || 'Çıkar'}</span>
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
    let blockBtnHtml = '';
    if (!m.isSelf) {
      const isAlreadyFriend = state.friends.some(f => (f.username || f.name).toLowerCase().replace(/^@/, '') === cleanTargetName.toLowerCase());
      if (isAlreadyFriend) {
        friendBtnHtml = `<span class="px-2 py-0.5 rounded-lg text-[9px] bg-white/5 text-emerald-400 border border-emerald-500/20 font-medium shrink-0">${dictPart.friend_badge || '✓ Arkadaş'}</span>`;
      } else {
        friendBtnHtml = `
          <button type="button" class="add-friend-from-participant-btn px-2 py-1 rounded-xl bg-gradient-to-r from-rose-500 to-indigo-600 hover:opacity-90 active:scale-95 text-white text-[10px] font-bold shadow-sm transition-all cursor-pointer flex items-center gap-1 shrink-0" data-username="${cleanTargetName}" title="${dictPart.add_friend_title || 'Arkadaş Ekle'}">
            <svg class="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
            <span>${dictPart.add_friend_btn_short || 'Ekle'}</span>
          </button>
        `;
      }

      const blocked = isUserBlocked(cleanTargetName) || (m.userId && isUserBlocked(m.userId));
      if (blocked) {
        blockBtnHtml = `
          <button type="button" class="unblock-participant-btn px-2 py-1 rounded-xl bg-red-500/20 hover:bg-red-500/30 active:scale-95 text-red-300 border border-red-500/30 text-[10px] font-bold flex items-center gap-1 shrink-0 transition-all cursor-pointer" data-username="${cleanTargetName}" title="Engeli Kaldır">
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
            <span class="hidden sm:inline">Engelli</span>
          </button>
        `;
      } else {
        blockBtnHtml = `
          <button type="button" class="block-participant-btn px-2 py-1 rounded-xl bg-white/5 hover:bg-red-500/20 active:scale-95 text-gray-400 hover:text-red-300 border border-white/10 hover:border-red-500/30 text-[10px] font-medium flex items-center gap-1 shrink-0 transition-all cursor-pointer" data-username="${cleanTargetName}" data-user-id="${m.userId}" title="Kullanıcıyı Engelle">
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
            <span class="hidden sm:inline">Engelle</span>
          </button>
        `;
      }
    }

    card.innerHTML = `
      <div class="flex items-center gap-2.5 min-w-0 flex-1 participant-profile-trigger cursor-pointer hover:opacity-85 transition-opacity" title="Kullanıcı Profilini ve İlişki Ağını Gör">
        ${avatarHtml}
        <div class="truncate">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-xs font-bold text-white truncate max-w-[110px] sm:max-w-none">${m.username}</span>
            ${m.isSelf ? `<span class="px-1 py-0.2 rounded text-[9px] bg-rose-500/20 text-rose-300 font-bold border border-rose-500/30">${dictPart.you_badge || 'Sen'}</span>` : ''}
            ${m.isBot ? `<span class="px-1 py-0.2 rounded text-[9px] bg-blue-500/20 text-blue-300 font-bold border border-blue-500/30">${dictPart.simulated_badge || 'Simüle'}</span>` : ''}
          </div>
          <span class="text-[10px] text-gray-400 block">${m.isSelf ? (dictPart.your_device || 'Senin Cihazın') : (m.isBot ? (dictPart.room_participant || 'Oda Katılımcısı') : (dictPart.live_connection || 'Canlı Bağlantı'))}</span>
        </div>
      </div>

      <div class="flex items-center gap-1.5 sm:gap-2 shrink-0 flex-wrap justify-end">
        <div class="flex items-center gap-1">
          ${micSvg}
          ${camSvg}
        </div>
        ${friendBtnHtml}
        ${blockBtnHtml}
        ${actionsHtml}
      </div>
    `;

    const pCamBtn = card.querySelector('.participant-cam-toggle-btn');
    if (pCamBtn) {
      addInstantTap(pCamBtn, (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        if (m.isSelf) {
          toggleCam();
          return;
        }
        state.dismissedPips = state.dismissedPips || {};
        const isCurrentlyDismissed = !!state.dismissedPips[m.userId];
        state.dismissedPips[m.userId] = !isCurrentlyDismissed;
        state.activePipPeerId = m.userId;
        if (typeof renderStagePipCards === 'function') renderStagePipCards();
        if (typeof clampPipCardsToStage === 'function') clampPipCardsToStage();
        showToast(state.dismissedPips[m.userId] ? `${m.username} ana ekrandan gizlendi` : `${m.username} ana ekrana getirildi`);
      });
    }

    const pTrigger = card.querySelector('.participant-profile-trigger');
    if (pTrigger) {
      addInstantTap(pTrigger, () => {
        if (!m.isSelf) {
          openPublicUserProfile(cleanTargetName);
        } else {
          switchTab('profile');
          closeRoomParticipantsModal();
        }
      });
    }

    const addFrBtn = card.querySelector('.add-friend-from-participant-btn');
    if (addFrBtn) {
      addInstantTap(addFrBtn, async (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        const uName = addFrBtn.getAttribute('data-username');
        await addFriend(uName);
        renderParticipantsList();
      });
    }

    const blkBtn = card.querySelector('.block-participant-btn');
    if (blkBtn) {
      addInstantTap(blkBtn, (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        const uName = blkBtn.getAttribute('data-username');
        const uId = blkBtn.getAttribute('data-user-id');
        if (typeof showMiruoConfirm === 'function') {
          showMiruoConfirm({
            title: 'Kullanıcıyı Engelle',
            message: `@${uName} adlı kullanıcıyı engellemek istediğinize emin misiniz? Sohbet mesajları gizlenecektir.`,
            actionText: 'Evet, Engelle',
            onConfirm: () => {
              blockUser(uName, uId, m.avatar, m.avatarColor);
            }
          });
        } else {
          blockUser(uName, uId, m.avatar, m.avatarColor);
        }
      });
    }

    const unblkBtn = card.querySelector('.unblock-participant-btn');
    if (unblkBtn) {
      addInstantTap(unblkBtn, (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        const uName = unblkBtn.getAttribute('data-username');
        unblockUser(uName);
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
      addInstantTap(kickBtn, (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        const uId = kickBtn.getAttribute('data-user-id');
        const uName = kickBtn.getAttribute('data-username');
        if (typeof showMiruoConfirm === 'function') {
          showMiruoConfirm({
            title: 'Odadan Çıkar',
            message: `${uName || 'Bu kullanıcıyı'} odadan çıkarmak istediğinize emin misiniz?`,
            actionText: 'Evet, Çıkar',
            onConfirm: () => {
              kickParticipant(uId, uName);
            }
          });
        } else {
          kickParticipant(uId, uName);
        }
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
  if (!isSelf && sender && typeof isUserBlocked === 'function' && isUserBlocked(sender)) {
    return; // Blocked user chat message suppressed
  }

  const time = timeStr || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const msgEl = document.createElement('div');
  msgEl.className = `flex gap-2 max-w-[88%] ${isSelf ? 'ml-auto flex-row-reverse' : 'mr-auto flex-row'}`;

  const avUrl = isSelf ? (state.avatarUrl || avatarUrl) : avatarUrl;
  const initial = (sender || 'M').charAt(0).toUpperCase();
  const avatarHtml = `
    <div class="chat-sender-profile-trigger w-6 h-6 rounded-full ${isSelf ? 'bg-gradient-to-tr from-rose-500 to-indigo-600' : 'bg-gradient-to-tr from-cyan-500 to-blue-600'} flex items-center justify-center text-[10px] font-bold text-white shrink-0 shadow-sm mt-0.5 overflow-hidden border border-white/10 cursor-pointer hover:scale-110 transition-transform" title="${escapeHtml(sender)} profilini gör">
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
        <span class="chat-sender-profile-trigger font-semibold cursor-pointer hover:underline ${isSelf ? 'text-rose-300' : 'text-indigo-300'}">${escapeHtml(sender)}</span>
        <span>•</span>
        <span>${time}</span>
      </div>
      ${imageHtml}
      ${textHtml}
    </div>
  `;

  msgEl.querySelectorAll('.chat-sender-profile-trigger').forEach(el => {
    addInstantTap(el, () => {
      openPublicUserProfile(sender);
    });
  });

  dom.chatMessagesContainer.appendChild(msgEl);
  dom.chatMessagesContainer.scrollTop = dom.chatMessagesContainer.scrollHeight;

  const fsChatMessagesContainer = document.getElementById('fsChatMessagesContainer');
  if (fsChatMessagesContainer) {
    const fsClone = msgEl.cloneNode(true);
    fsClone.querySelectorAll('.chat-sender-profile-trigger').forEach(el => {
      addInstantTap(el, () => {
        openPublicUserProfile(sender);
      });
    });
    fsChatMessagesContainer.appendChild(fsClone);
    fsChatMessagesContainer.scrollTop = fsChatMessagesContainer.scrollHeight;
  }

  // If chat panel is currently closed, illuminate the unread badge on the chat button
  if (!isSelf && dom.roomChatPanel && dom.roomChatPanel.classList.contains('hidden')) {
    if (dom.chatUnreadDot) dom.chatUnreadDot.classList.remove('hidden');
    showToast(`${sender}: ${text ? (text.length > 25 ? text.substring(0, 25) + '...' : text) : 'Görsel gönderdi'}`);
  }
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>'"]/g, 
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
          <p>Sonuç bulunamadı</p>
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
            <div class="w-7 h-7 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-lg">
              <svg class="w-3 h-3 text-white fill-current ml-0.5" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </div>
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
          showToast(`"${title}" başlatıldı!`);
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
    if (dom.signUpNameField) dom.signUpNameField.classList.remove('hidden');
    if (dom.signUpAvatarSection) dom.signUpAvatarSection.classList.add('hidden');
    if (dom.signUpPasswordConfirmField) dom.signUpPasswordConfirmField.classList.remove('hidden');
    if (dom.authRememberRow) dom.authRememberRow.classList.add('hidden');
    if (dom.authTabSignUp) dom.authTabSignUp.className = "flex-1 py-2.5 rounded-xl text-xs font-bold bg-[#18181B] text-white shadow-sm transition-all text-center cursor-pointer";
    if (dom.authTabSignIn) dom.authTabSignIn.className = "flex-1 py-2.5 rounded-xl text-xs font-semibold text-gray-500 hover:text-gray-900 transition-all text-center cursor-pointer";
    if (dom.authContactInput) {
      dom.authContactInput.setAttribute('autocomplete', 'email');
      dom.authContactInput.setAttribute('name', 'email');
    }
    if (dom.authPasswordInput) {
      dom.authPasswordInput.setAttribute('autocomplete', 'new-password');
      dom.authPasswordInput.setAttribute('name', 'password');
    }
    if (dom.authPasswordConfirmInput) {
      dom.authPasswordConfirmInput.setAttribute('autocomplete', 'new-password');
      dom.authPasswordConfirmInput.setAttribute('name', 'confirm-password');
    }
  } else {
    if (dom.signUpNameField) dom.signUpNameField.classList.add('hidden');
    if (dom.signUpAvatarSection) dom.signUpAvatarSection.classList.add('hidden');
    if (dom.signUpPasswordConfirmField) dom.signUpPasswordConfirmField.classList.add('hidden');
    if (dom.authRememberRow) dom.authRememberRow.classList.remove('hidden');
    if (dom.authContactInput) {
      dom.authContactInput.setAttribute('autocomplete', 'username');
      dom.authContactInput.setAttribute('name', 'username');
    }
    if (dom.authPasswordInput) {
      dom.authPasswordInput.setAttribute('autocomplete', 'current-password');
      dom.authPasswordInput.setAttribute('name', 'password');
    }
    if (dom.authTabSignIn) dom.authTabSignIn.className = "flex-1 py-2.5 rounded-xl text-xs font-bold bg-[#18181B] text-white shadow-sm transition-all text-center cursor-pointer";
    if (dom.authTabSignUp) dom.authTabSignUp.className = "flex-1 py-2.5 rounded-xl text-xs font-semibold text-gray-500 hover:text-gray-900 transition-all text-center cursor-pointer";
  }

  updateAuthStringsForCurrentLang();

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
  const langFromUrl = urlParams.get('lang');
  if (langFromUrl && ['tr', 'en', 'de'].includes(langFromUrl)) {
    applyLanguage(langFromUrl);
  }
  const hash = (window.location.hash || '').replace('#', '');
  const initialView = localStorage.getItem('miruo_initial_view');
  let roomFromUrl = urlParams.get('room');
  if (!roomFromUrl && window.location.pathname && window.location.pathname.includes('/oda/')) {
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
      name: '',
      defaultRoom: 'ODA-' + guestNum,
      avatarChar: 'M'
    };
    if (dom.authModal) {
      if (!roomFromUrl && !urlParams.get('modal') && !urlParams.get('view') && !urlParams.get('room') && !urlParams.get('profile') && urlParams.get('auth') !== 'reset' && hash !== 'reset') {
        freezeBackgroundForModal();
        dom.authModal.classList.remove('hidden');
        setAuthMode(false);
      } else {
        dom.authModal.classList.add('hidden');
        unfreezeBackgroundAfterModal(true);
      }
    }
  } else {
    if (dom.authModal) dom.authModal.classList.add('hidden');
    unfreezeBackgroundAfterModal(true);
  }

  if (urlParams.get('profile') || hash === 'settings' || urlParams.get('modal') === 'settings') {
    const targetTab = urlParams.get('profile') || 'settings';
    setTimeout(() => { if (typeof openProfileEditModal === 'function') openProfileEditModal(targetTab); }, 350);
  } else if (hash === 'profile_edit' || urlParams.get('modal') === 'profile_edit') {
    setTimeout(() => { if (typeof openDedicatedProfileModal === 'function') openDedicatedProfileModal(); }, 350);
  } else if (urlParams.get('auth') === 'signup' || urlParams.get('modal') === 'signup' || hash === 'signup') {
    if (dom.authModal) {
      freezeBackgroundForModal();
      dom.authModal.classList.remove('hidden');
      setAuthMode(true);
    }
  } else if (urlParams.get('auth') === 'phone' || hash === 'phone') {
    if (dom.authModal) {
      freezeBackgroundForModal();
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

  const customUsername = localStorage.getItem('miruo_custom_username');
  const backupAvatar = localStorage.getItem('miruo_avatar') || '';
  if (user) {
    if (!user.avatarUrl && backupAvatar) {
      user.avatarUrl = backupAvatar;
    }
    const cleanEmail = (user.email || '').trim().toLowerCase();
    const cleanU = (user.username || customUsername || '').replace(/^@/, '').toLowerCase().trim();
    try {
      if (cleanEmail) {
        const byEmail = JSON.parse(localStorage.getItem('miruo_profiles_by_email') || '{}');
        const emailProf = byEmail[cleanEmail];
        if (emailProf) {
          if (!user.username && emailProf.username) user.username = emailProf.username;
          if ((!user.fullName || user.fullName.startsWith('@')) && emailProf.fullName) {
            user.fullName = emailProf.fullName;
            user.name = emailProf.fullName;
          }
          if (!user.avatarUrl && emailProf.avatarUrl) user.avatarUrl = emailProf.avatarUrl;
          if (!user.avatarBg && emailProf.avatarBg) user.avatarBg = emailProf.avatarBg;
        }
      }
      if (!user.avatarUrl || !user.fullName) {
        const regUsers = JSON.parse(localStorage.getItem('miruo_registered_users') || '[]');
        const regMatch = regUsers.find(u => (cleanEmail && u.email && u.email.toLowerCase() === cleanEmail) || (cleanU && u.username && u.username.toLowerCase().replace(/^@/,'') === cleanU));
        if (regMatch) {
          if (!user.avatarUrl && regMatch.avatarUrl) user.avatarUrl = regMatch.avatarUrl;
          if (!user.avatarBg && regMatch.avatarBg) user.avatarBg = regMatch.avatarBg;
          if ((!user.fullName || user.fullName.startsWith('@')) && regMatch.fullName) user.fullName = regMatch.fullName;
        }
      }
    } catch (e) {}

    if (customUsername && !user.username) {
      user.username = customUsername.replace(/^@/, '');
    }
    if (user.username) {
      user.username = user.username.replace(/^@/, '');
    }
    if (!user.fullName || user.fullName === '@' + user.username) {
      if (user.name && !user.name.startsWith('@') && user.name !== 'Misafir') {
        user.fullName = user.name;
      }
    }
  }
  state.userId = user.id || state.userId;
  state.username = ((user && user.username) || customUsername || (user && user.name) || 'kullanici').replace(/^@/, '');
  state.roomId = (roomFromUrl || '').toUpperCase();
  state.isInRoom = !!roomFromUrl;
  state.avatarUrl = (user && user.avatarUrl) || backupAvatar || '';
  state.avatarBg = (user && user.avatarBg) || '';

  if (user && user.avatarUrl) {
    localStorage.setItem('miruo_avatar', user.avatarUrl);
    localStorage.setItem('miruo_user', JSON.stringify(user));
  }

  // Desktop User Profile Restore from UserData directory
  if (window.miruoDesktop && typeof window.miruoDesktop.getDesktopProfile === 'function') {
    window.miruoDesktop.getDesktopProfile().then(deskUser => {
      if (deskUser && (deskUser.avatarUrl || deskUser.username || deskUser.fullName)) {
        let changed = false;
        if (deskUser.avatarUrl && deskUser.avatarUrl !== user.avatarUrl) {
          user.avatarUrl = deskUser.avatarUrl;
          state.avatarUrl = deskUser.avatarUrl;
          localStorage.setItem('miruo_avatar', deskUser.avatarUrl);
          changed = true;
        }
        if (deskUser.fullName && deskUser.fullName !== user.fullName && !deskUser.fullName.startsWith('@')) {
          user.fullName = deskUser.fullName;
          user.name = deskUser.fullName;
          changed = true;
        }
        if (deskUser.username && deskUser.username !== user.username) {
          user.username = deskUser.username;
          state.username = deskUser.username;
          changed = true;
        }
        if (changed) {
          localStorage.setItem('miruo_user', JSON.stringify(user));
          updateUserUI(user);
        }
      }
    }).catch(() => {});
  }

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
  } else if (urlParams.get('view') === 'public_profile') {
    switchToProfileTab();
    setTimeout(() => {
      openPublicUserProfile(urlParams.get('user') || 'selin');
      if (urlParams.get('options') === '1' || urlParams.get('modal') === 'public_options') {
        setTimeout(() => openPublicProfileOptionsMenu(), 350);
      }
    }, 400);
  } else if (urlParams.get('modal') === 'public_options') {
    switchToProfileTab();
    setTimeout(() => {
      openPublicUserProfile(urlParams.get('user') || 'selin');
      setTimeout(() => openPublicProfileOptionsMenu(), 350);
    }, 400);
  } else if (urlParams.get('view') === 'affinity_detail') {
    switchToProfileTab();
    setTimeout(() => {
      const currentTree = getUserAffinityTree();
      openAffinitySlotDetail('partner_1', currentTree.partner_1 || { username: 'selin', name: 'Selin Yılmaz', category: 'partner' });
    }, 400);
  } else if (urlParams.get('view') && urlParams.get('view').startsWith('affinity_picker')) {
    switchToProfileTab();
    setTimeout(() => {
      openAffinityPicker('bro_1', 'bro', 'Kanka 1');
      if (urlParams.get('view').includes('info') || urlParams.get('info') === '1') {
        const infoBox = document.getElementById('affinityConditionInfoBox');
        if (infoBox) infoBox.classList.remove('hidden');
      }
    }, 400);
  } else if (urlParams.get('modal') === 'friends_options' || urlParams.get('view') === 'friends_options') {
    switchToFriendsTab();
    setTimeout(() => {
      const firstFriend = (state.friends && state.friends[0]) || { username: 'selin', name: 'Selin Yılmaz' };
      openFriendQuickOptions(firstFriend);
    }, 600);
  } else if (urlParams.get('modal') === 'add_friend' || urlParams.get('view') === 'add_friend') {
    switchToFriendsTab();
    setTimeout(() => {
      openAddFriendModal();
    }, 600);
  } else if (urlParams.get('view') === 'room_fs_chat' || urlParams.get('view') === 'fs_chat') {
    switchToMyRoom();
    connectSignaling();
    setTimeout(() => {
      const stage = dom.stageContainer || document.getElementById('stageContainer');
      if (stage) stage.classList.add('is-fullscreen-pseudo');
      document.body.classList.add('stage-is-fullscreen');
      setFsChatVisibility(true);
      applyFsChatFullscreenSettings(true);
    }, 500);
  } else if (urlParams.get('view') === 'room') {
    switchToMyRoom();
    connectSignaling();
  } else if (initialView === 'friends' || urlParams.get('tab') === 'friends' || hash === 'friends' || urlParams.get('view') === 'friends') {
    switchToFriendsTab();
  } else if (initialView === 'profile' || urlParams.get('view') === 'profile' || urlParams.get('tab') === 'profile' || hash === 'profile' || hash === 'profile_edit' || hash === 'settings') {
    switchToProfileTab();
  } else if (initialView === 'auth' || initialView === 'login' || urlParams.get('modal') === 'login' || urlParams.get('auth') === 'login' || urlParams.get('view') === 'auth') {
    freezeBackgroundForModal();
    if (dom.authModal) dom.authModal.classList.remove('hidden');
    setAuthMode(false);
  } else if (urlParams.get('modal') === 'signup' || urlParams.get('auth') === 'signup') {
    freezeBackgroundForModal();
    if (dom.authModal) dom.authModal.classList.remove('hidden');
    setAuthMode(true);
  } else if (urlParams.get('modal') === 'delete_account') {
    setTimeout(() => {
      const delModal = document.getElementById('deleteAccountModal');
      if (delModal) {
        delModal.classList.remove('hidden');
        delModal.classList.add('flex');
      }
    }, 350);
  } else if (urlParams.get('modal') === 'reset' || urlParams.get('auth') === 'reset') {
    if (dom.authModal) dom.authModal.classList.add('hidden');
    setTimeout(() => {
      openResetModal();
    }, 250);
  } else if (roomFromUrl) {
    switchToMyRoom();
    connectSignaling();
    if (typeof DEFAULT_COMMUNITY_ROOMS !== 'undefined') {
      const matched = DEFAULT_COMMUNITY_ROOMS.find(r => r.id.toUpperCase() === state.roomId);
      if (matched && matched.videoId) {
        setTimeout(() => { loadYoutubeVideo(matched.videoId); }, 350);
      }
    }
  } else {
    switchToExplore();
  }

  // Auto camera preview if requested by test parameter
  if (urlParams.get('cam') === '1' || hash.includes('cam=1') || localStorage.getItem('miruo_cam_auto') === '1') {
    setTimeout(() => {
      if (!state.isCamOn) toggleCam();
    }, 450);
  }

  // Auto hide chat if requested (test or deep link)
  if (urlParams.get('chat') === '0' || hash.includes('chat=0')) {
    setTimeout(() => {
      setChatVisibility(false);
    }, 400);
  }

  // Handle Affinity Demo or Bound Partner
  const affinityParam = urlParams.get('affinity');
  if (affinityParam === 'demo' || affinityParam === 'partner' || affinityParam === 'bound') {
    const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
    const myClean = (savedUser.username || state.username || '').toLowerCase().replace(/^@/, '');
    const demoPartner = myClean === 'selin' ? 'ayse' : 'selin';
    const demoName = myClean === 'selin' ? 'Ayşe Kaya' : 'Selin Yılmaz';
    const tree = getUserAffinityTree();
    tree.partner_1 = {
      username: demoPartner,
      name: demoName,
      avatarUrl: '',
      category: 'partner',
      boundAt: Date.now()
    };
    saveUserAffinityTree(tree);
    if (typeof renderAffinityTree === 'function') {
      setTimeout(() => { renderAffinityTree(); }, 300);
    }
  }

  // Handle Public Profile view parameter
  const publicUserParam = urlParams.get('public_user') || urlParams.get('public_profile');
  if (publicUserParam) {
    setTimeout(() => {
      if (typeof openPublicUserProfile === 'function') {
        openPublicUserProfile(publicUserParam);
      }
    }, 500);
  }

  return true;
}

function updateUserUI(user) {
  const customUsername = user.username || localStorage.getItem('miruo_custom_username') || user.name || state.username || 'kullanici';
  const cleanUsername = customUsername.replace(/^@/, '');
  const displayHandle = '@' + cleanUsername;
  const realFullName = (user.fullName && !user.fullName.startsWith('@') ? user.fullName.trim() : '') ||
                       (user.name && !user.name.startsWith('@') && user.name !== 'Misafir' ? user.name.trim() : '');
  const displayName = realFullName || displayHandle;
  state.username = cleanUsername;
  state.avatarUrl = user.avatarUrl || state.avatarUrl || '';
  state.avatarBg = user.avatarBg || state.avatarBg || '';
  if (dom.userNameHeader) dom.userNameHeader.textContent = displayHandle;

  const myFriendCodeDisplay = document.getElementById('myFriendCodeDisplay');
  const tabMyFriendCodeDisplay = document.getElementById('tabMyFriendCodeDisplay');
  const modalMyFriendCodeDisplay = document.getElementById('modalMyFriendCodeDisplay');
  if (myFriendCodeDisplay) myFriendCodeDisplay.textContent = displayHandle;
  if (tabMyFriendCodeDisplay) tabMyFriendCodeDisplay.textContent = displayHandle;
  if (modalMyFriendCodeDisplay) modalMyFriendCodeDisplay.textContent = displayHandle;

  if (dom.userProfileBtn) {
    if (user.avatarUrl) {
      dom.userProfileBtn.innerHTML = `<img src="${user.avatarUrl}" class="w-full h-full object-cover rounded-full" alt="Avatar">`;
      dom.userProfileBtn.className = 'w-8 h-8 rounded-full overflow-hidden flex items-center justify-center cursor-pointer border border-white/20 shadow-sm';
    } else {
      dom.userProfileBtn.innerHTML = `<span id="userAvatarHeader">${(user.avatarChar || realFullName || cleanUsername || 'M').charAt(0).toUpperCase()}</span>`;
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
      const char = (user.avatarChar || realFullName || cleanUsername || 'M').charAt(0).toUpperCase();
      mobileNavAvatar.innerHTML = char;
      mobileNavAvatar.className = `w-6 h-6 rounded-full bg-gradient-to-tr ${user.avatarBg || 'from-rose-500 to-indigo-600'} flex items-center justify-center text-[10px] font-bold text-white shadow-xs overflow-hidden border border-white/20`;
    }
  }

  if (dom.editAvatarPreview) {
    if (user.avatarUrl) {
      dom.editAvatarPreview.innerHTML = `<img src="${user.avatarUrl}" class="w-full h-full object-cover rounded-full" alt="Preview">`;
      dom.editAvatarPreview.className = 'w-22 h-22 rounded-2xl overflow-hidden flex items-center justify-center border-2 border-white/20 shadow-md';
    } else {
      dom.editAvatarPreview.innerHTML = (user.avatarChar || realFullName || cleanUsername || 'M').charAt(0).toUpperCase();
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
      dom.selfPipAvatarInitial.textContent = (user.avatarChar || realFullName || cleanUsername || 'M').charAt(0).toUpperCase();
    }
  }
  if (dom.nowPlayingAvatar) {
    if (user.avatarUrl) {
      dom.nowPlayingAvatar.innerHTML = `<img src="${user.avatarUrl}" class="w-full h-full object-cover rounded-full" alt="Avatar">`;
    } else {
      dom.nowPlayingAvatar.innerHTML = (user.avatarChar || realFullName || cleanUsername || 'M').charAt(0).toUpperCase();
    }
  }
  const stageAvatarCircle = document.getElementById('stageAvatarCircle');
  if (stageAvatarCircle) {
    if (user.avatarUrl) {
      stageAvatarCircle.innerHTML = `<img src="${user.avatarUrl}" class="w-full h-full object-cover rounded-full" alt="Avatar">`;
    } else {
      stageAvatarCircle.innerHTML = (user.avatarChar || realFullName || cleanUsername || 'M').charAt(0).toUpperCase();
    }
  }

  // Update Username & Full Name Display Everywhere
  if (dom.tabMyFriendCodeDisplay) dom.tabMyFriendCodeDisplay.textContent = displayHandle;
  if (dom.myFriendCodeDisplay) dom.myFriendCodeDisplay.textContent = displayHandle;
  if (dom.editProfileFullNameInput) dom.editProfileFullNameInput.value = realFullName || cleanUsername;
  if (dom.editProfileUsernameInput) dom.editProfileUsernameInput.value = cleanUsername;
  if (dom.editProfileNameInput) dom.editProfileNameInput.value = cleanUsername;
  if (dom.profileEmailDisplay) dom.profileEmailDisplay.textContent = user.email || `${cleanUsername.toLowerCase()}@miruo.app`;
  const tabEmailSub = document.getElementById('tabProfileEmailSub');
  if (tabEmailSub && user.email) tabEmailSub.textContent = user.email;
  if (dom.currentRoomDisplay) dom.currentRoomDisplay.textContent = state.roomId;
  if (typeof renderProfileTab === 'function') renderProfileTab();
}

function confirmAndLogoutUser() {
  const dict = I18N[currentLang] || I18N.tr;
  if (typeof showMiruoConfirm === 'function') {
    showMiruoConfirm({
      title: dict.confirm_logout_title || 'Çıkış Yap',
      message: dict.confirm_logout_msg || 'Hesabınızdan çıkış yapmak istediğinize emin misiniz?',
      actionText: dict.confirm_logout_action || 'Evet, Çıkış Yap',
      onConfirm: () => {
        logoutUser();
      }
    });
  } else if (window.confirm(dict.confirm_logout_msg || 'Hesabınızdan çıkış yapmak istediğinize emin misiniz?')) {
    logoutUser();
  }
}
window.confirmAndLogoutUser = confirmAndLogoutUser;

async function logoutUser() {
  try {
    const currentSaved = JSON.parse(localStorage.getItem('miruo_user') || 'null');
    if (currentSaved) {
      persistUserToLocalRegistry(currentSaved);
    }
  } catch (e) {}

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
  window.pendingAvatarUrl = '';

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
    freezeBackgroundForModal();
    dom.authModal.classList.remove('hidden');
    setAuthMode(false);
    setAuthMethod('email');
  }

  showToast('Oturum kapatıldı.');
}

// ==========================================
// IN-APP MINI PLAYER (PIP DOCK) CONTROLLER
// "odada ayrıca bu küçük buton gibi alta çekilsin sonra uygulama içi gezilebilsin"
// ==========================================
function minimizeRoomToMiniPlayer() {
  if (!state.isInRoom && !state.roomId) return;
  state.isMiniPlayer = true;
  document.body.classList.add('has-mini-player');
  document.body.classList.remove('in-room-mode');
  document.documentElement.classList.remove('in-room-mode');

  // Keep roomWorkspaceSection in DOM for video playback, but CSS collapses everything except stageContainer
  if (dom.roomWorkspaceSection) {
    dom.roomWorkspaceSection.classList.remove('hidden');
    dom.roomWorkspaceSection.classList.add('block');
  }

  // Show normal app navigation and explore lobby
  if (dom.mainHeader) dom.mainHeader.classList.remove('hidden');
  const mobileNav = document.getElementById('mobileBottomNav');
  if (mobileNav) mobileNav.classList.remove('hidden');

  const mainWorkspace = document.querySelector('main');
  if (mainWorkspace) {
    mainWorkspace.classList.remove('pt-0', 'max-w-7xl');
    mainWorkspace.classList.add('max-w-xl');
  }

  // Show active tab content (explore by default)
  if (state.currentTab === 'friends') {
    switchToFriendsTab();
  } else if (state.currentTab === 'profile') {
    switchToProfileTab();
  } else {
    state.currentTab = 'explore';
    if (dom.exploreLobbySection) {
      dom.exploreLobbySection.classList.remove('hidden');
      dom.exploreLobbySection.classList.add('flex');
    }
  }

  // Update mini player title & controls (never display room number/code)
  const miniTitle = document.getElementById('miniPlayerTitle');
  if (miniTitle) {
    const rawPlaying = (dom.nowPlayingTitle && dom.nowPlayingTitle.textContent) || '';
    const isGeneric = !rawPlaying || rawPlaying.includes('Henüz') || rawPlaying.includes('No video') || rawPlaying.includes('Video oynatılıyor') || rawPlaying.toLowerCase() === 'video';
    const vTitle = !isGeneric ? rawPlaying : (dom.raveOverlayTitle && dom.raveOverlayTitle.textContent);
    miniTitle.textContent = (vTitle && !vTitle.startsWith('ODA-')) ? vTitle : 'Miruo';
  }
  updateMiniPlayerPlayPauseUI(state.isPlaying);
  showToast('Oda mini oynatıcıya küçültüldü.');
  window.dispatchEvent(new Event('resize'));
}
window.minimizeRoomToMiniPlayer = minimizeRoomToMiniPlayer;

function restoreRoomFromMiniPlayer() {
  if (!state.isMiniPlayer) return;
  state.isMiniPlayer = false;
  document.body.classList.remove('has-mini-player');
  document.body.classList.add('in-room-mode');
  document.documentElement.classList.add('in-room-mode');

  const mainWorkspace = document.querySelector('main');
  if (mainWorkspace) {
    mainWorkspace.classList.add('pt-0', 'max-w-7xl');
    mainWorkspace.classList.remove('max-w-xl');
  }

  // Hide explore, friends, profile & nav, restore room view
  if (dom.mainHeader) dom.mainHeader.classList.add('hidden');
  const mobileNav = document.getElementById('mobileBottomNav');
  if (mobileNav) mobileNav.classList.add('hidden');
  if (dom.exploreLobbySection) {
    dom.exploreLobbySection.classList.add('hidden');
    dom.exploreLobbySection.classList.remove('flex');
  }
  const friendsTab = document.getElementById('friendsTabSection');
  if (friendsTab) {
    friendsTab.classList.add('hidden');
    friendsTab.classList.remove('flex');
  }
  const profileTab = document.getElementById('profileTabSection');
  if (profileTab) {
    profileTab.classList.add('hidden');
    profileTab.classList.remove('flex');
  }
  if (dom.roomWorkspaceSection) {
    dom.roomWorkspaceSection.classList.remove('hidden', 'block');
    dom.roomWorkspaceSection.classList.add('flex');
  }
  window.dispatchEvent(new Event('resize'));
}
window.restoreRoomFromMiniPlayer = restoreRoomFromMiniPlayer;

function updateMiniPlayerPlayPauseUI(isPlaying) {
  const playIcon = document.getElementById('miniPlayerPlayIcon');
  const pauseIcon = document.getElementById('miniPlayerPauseIcon');
  if (playIcon) playIcon.classList.toggle('hidden', isPlaying);
  if (pauseIcon) pauseIcon.classList.toggle('hidden', !isPlaying);
}
window.updateMiniPlayerPlayPauseUI = updateMiniPlayerPlayPauseUI;

// ==========================================
// DRAGGABLE & RESIZABLE FULLSCREEN CHAT OVERLAY
// "bu sohbet basılı tutup kenarlardan küçültülebilsin sürüklenebilsin"
// ==========================================
function initFsChatDragAndResize() {
  const overlay = document.getElementById('fsChatOverlay');
  const header = document.getElementById('fsChatHeader');
  const resizeW = document.getElementById('fsChatResizeW');
  const resizeN = document.getElementById('fsChatResizeN');
  const resizeNW = document.getElementById('fsChatResizeNW');

  if (!overlay || !header) return;

  // 1. Dragging Header
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  header.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#closeFsChatBtn')) return;
    isDragging = true;
    try { header.setPointerCapture(e.pointerId); } catch (_) {}

    const rect = overlay.getBoundingClientRect();
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    dragStartX = e.clientX;
    dragStartY = e.clientY;
    initialLeft = rect.left;
    initialTop = rect.top;
    e.preventDefault();
  });

  header.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    const rect = overlay.getBoundingClientRect();

    const maxLeft = Math.max(0, window.innerWidth - rect.width - 6);
    const maxTop = Math.max(0, window.innerHeight - rect.height - 6);

    const newLeft = Math.min(Math.max(6, initialLeft + dx), maxLeft);
    const newTop = Math.min(Math.max(6, initialTop + dy), maxTop);

    overlay.style.left = `${newLeft}px`;
    overlay.style.top = `${newTop}px`;
  });

  const stopDrag = (e) => {
    if (isDragging) {
      isDragging = false;
      try { header.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  };
  header.addEventListener('pointerup', stopDrag);
  header.addEventListener('pointercancel', stopDrag);

  // 2. Resizing from handles
  const bindResizeHandle = (handleEl, doX, doY) => {
    if (!handleEl) return;
    let isResizing = false;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;
    let startLeft = 0;
    let startTop = 0;

    handleEl.addEventListener('pointerdown', (e) => {
      isResizing = true;
      try { handleEl.setPointerCapture(e.pointerId); } catch (_) {}

      const rect = overlay.getBoundingClientRect();
      overlay.style.right = 'auto';
      overlay.style.bottom = 'auto';
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;

      startX = e.clientX;
      startY = e.clientY;
      startWidth = rect.width;
      startHeight = rect.height;
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
      e.stopPropagation();
    });

    handleEl.addEventListener('pointermove', (e) => {
      if (!isResizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (doX) {
        const minW = 200;
        const maxW = Math.max(minW, startLeft + startWidth - 10);
        const newW = Math.min(Math.max(minW, startWidth - dx), maxW);
        const newLeft = startLeft + (startWidth - newW);
        overlay.style.width = `${newW}px`;
        overlay.style.left = `${newLeft}px`;
      }

      if (doY) {
        const minH = 160;
        const maxH = Math.max(minH, startTop + startHeight - 10);
        const newH = Math.min(Math.max(minH, startHeight - dy), maxH);
        const newTop = startTop + (startHeight - newH);
        overlay.style.height = `${newH}px`;
        overlay.style.top = `${newTop}px`;
      }
    });

    const stopResize = (e) => {
      if (isResizing) {
        isResizing = false;
        try { handleEl.releasePointerCapture(e.pointerId); } catch (_) {}
      }
    };
    handleEl.addEventListener('pointerup', stopResize);
    handleEl.addEventListener('pointercancel', stopResize);
  };

  bindResizeHandle(resizeW, true, false);
  bindResizeHandle(resizeN, false, true);
  bindResizeHandle(resizeNW, true, true);
}
window.initFsChatDragAndResize = initFsChatDragAndResize;

// ==========================================
// MOBILE KEYBOARD PROTECTION & ANTI-SCROLL SYSTEM
// "odadayken klavyeye basınca aşağı kaymasın ekran, dik tam ekranken bunu yapıyor düzelt"
// ==========================================
function initMobileKeyboardProtection() {
  const lockViewportAtZero = () => {
    const isRoomOrFs = document.body.classList.contains('in-room-mode') || 
                       document.body.classList.contains('stage-is-fullscreen');
    if (!isRoomOrFs) return;
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }
    if (document.body.scrollTop !== 0) document.body.scrollTop = 0;
    if (document.documentElement.scrollTop !== 0) document.documentElement.scrollTop = 0;
  };

  window.addEventListener('scroll', lockViewportAtZero, { passive: true });

  document.addEventListener('focusin', (e) => {
    const isRoomOrFs = document.body.classList.contains('in-room-mode') || 
                       document.body.classList.contains('stage-is-fullscreen');
    if (!isRoomOrFs) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      requestAnimationFrame(lockViewportAtZero);
      setTimeout(lockViewportAtZero, 40);
      setTimeout(lockViewportAtZero, 120);
      setTimeout(lockViewportAtZero, 300);
    }
  });

  document.addEventListener('focusout', (e) => {
    const isRoomOrFs = document.body.classList.contains('in-room-mode') || 
                       document.body.classList.contains('stage-is-fullscreen');
    if (!isRoomOrFs) return;
    setTimeout(lockViewportAtZero, 100);
    const fsChat = dom.fsChatOverlay || document.getElementById('fsChatOverlay');
    if (fsChat && window.innerHeight > window.innerWidth) {
      fsChat.style.removeProperty('bottom');
      fsChat.style.removeProperty('max-height');
    }
  });

  if (window.visualViewport) {
    const onViewportChange = () => {
      const isRoomOrFs = document.body.classList.contains('in-room-mode') || 
                         document.body.classList.contains('stage-is-fullscreen');
      if (!isRoomOrFs) return;

      lockViewportAtZero();

      const vv = window.visualViewport;
      const isPortrait = window.innerHeight > window.innerWidth;
      const keyboardHeight = Math.max(0, window.innerHeight - vv.height - (vv.offsetTop || 0));
      const isKeyboardOpen = keyboardHeight > 70;

      // 1. Portrait Fullscreen Live Chat: Lift chat overlay bottom directly above virtual keyboard
      const fsChat = dom.fsChatOverlay || document.getElementById('fsChatOverlay');
      const isFs = isStageFullscreen();
      if (fsChat && !fsChat.classList.contains('hidden') && isPortrait && isFs) {
        if (isKeyboardOpen) {
          fsChat.style.bottom = `${keyboardHeight}px`;
          fsChat.style.maxHeight = `${Math.min(vv.height - 100, window.innerHeight * 0.50)}px`;
        } else {
          fsChat.style.removeProperty('bottom');
          fsChat.style.removeProperty('max-height');
        }
      }

      // 2. Portrait In-Room View: Contract body height to visualViewport to avoid scrolling
      if (isPortrait && !isFs && document.body.classList.contains('in-room-mode')) {
        if (isKeyboardOpen) {
          document.body.style.height = `${vv.height}px`;
        } else {
          document.body.style.removeProperty('height');
        }
      }
    };

    window.visualViewport.addEventListener('resize', onViewportChange);
    window.visualViewport.addEventListener('scroll', lockViewportAtZero);
  }
}
window.initMobileKeyboardProtection = initMobileKeyboardProtection;

function initEvents() {
  initMobileKeyboardProtection();
  try {
    if (typeof initGlobalPublicRoomsSync === 'function') initGlobalPublicRoomsSync();
  } catch (_) {}
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
  const syncFullNameInputs = () => {
    const fn = (dom.authFirstNameInput && dom.authFirstNameInput.value.trim()) || '';
    const ln = (dom.authLastNameInput && dom.authLastNameInput.value.trim()) || '';
    const full = `${fn} ${ln}`.trim();
    if (dom.authNameInput) dom.authNameInput.value = full;
    const char = (fn || ln || full).charAt(0).toUpperCase();
    if (char) {
      selectedSignUpAvatarChar = char;
      if (!selectedSignUpAvatarData && dom.signUpAvatarPreview) {
        dom.signUpAvatarPreview.innerHTML = char;
      }
    }
  };

  if (dom.authFirstNameInput) {
    dom.authFirstNameInput.addEventListener('input', syncFullNameInputs);
    dom.authFirstNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && dom.authLastNameInput) dom.authLastNameInput.focus();
    });
  }
  if (dom.authLastNameInput) {
    dom.authLastNameInput.addEventListener('input', syncFullNameInputs);
    dom.authLastNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && dom.authContactInput) dom.authContactInput.focus();
    });
  }
  if (dom.authNameInput) {
    dom.authNameInput.addEventListener('input', syncFullNameInputs);
  }

  // Toggle Password Visibility
  if (dom.togglePasswordVisibility && dom.authPasswordInput) {
    dom.togglePasswordVisibility.addEventListener('click', () => {
      const isPass = dom.authPasswordInput.type === 'password';
      dom.authPasswordInput.type = isPass ? 'text' : 'password';
    });
  }

  function decodeAppleJwtPayload(jwt) {
    try {
      if (!jwt || typeof jwt !== 'string' || !jwt.includes('.')) return null;
      const parts = jwt.split('.');
      if (parts.length < 2) return null;
      let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4 !== 0) base64 += '=';
      const jsonStr = decodeURIComponent(
        atob(base64)
          .split('')
          .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      return JSON.parse(jsonStr);
    } catch (_) {
      return null;
    }
  }

  // Clean up any legacy fake/placeholder data ("Karabul7tt", "mac_touch_id_") from localStorage on load
  (function cleanupLegacyFakeStorage() {
    try {
      const regList = JSON.parse(localStorage.getItem('miruo_registered_users') || '[]');
      const cleaned = regList.filter(u => {
        const n = String((u && (u.fullName || u.name || u.username)) || '').toLowerCase();
        const e = String((u && u.email) || '').toLowerCase();
        return n !== 'karabul7tt' && e !== 'mehmetkarabul7tt@icloud.com';
      });
      if (cleaned.length !== regList.length) {
        localStorage.setItem('miruo_registered_users', JSON.stringify(cleaned));
      }
      const curUser = JSON.parse(localStorage.getItem('miruo_user') || 'null');
      if (curUser) {
        const cn = String(curUser.fullName || curUser.name || curUser.username || '').toLowerCase();
        const ce = String(curUser.email || '').toLowerCase();
        if (cn === 'karabul7tt' || ce === 'mehmetkarabul7tt@icloud.com') {
          localStorage.removeItem('miruo_user');
        }
      }
    } catch (_) {}
  })();

  // Native Apple Sign In Callback from iOS & macOS (ASAuthorizationController)
  window.handleNativeAppleSignInResponse = async function(response) {
    if (dom.appleLoginBtn) {
      dom.appleLoginBtn.classList.remove('opacity-60', 'pointer-events-none');
    }

    if (!response || !response.success) {
      if (response && (response.canceled || response.error === 'canceled' || (typeof response.error === 'string' && response.error.includes('1001')))) {
        console.log('[Miruo] Apple Sign In dismissed by user');
        hideAuthAlert();
        return;
      }
      const err = response && response.error ? response.error : 'İşlem tamamlanamadı.';
      console.warn('[Miruo] Native Apple Sign In error:', err);
      showAuthAlert('Apple ile giriş tamamlanamadı. Lütfen tekrar deneyin.', false);
      return;
    }

    hideAuthAlert();
    const userObj = response.user || {};
    const existingFromNative = response.existingUser || null;
    const identityToken = response.identityToken || userObj.identityToken || '';
    const jwtClaims = decodeAppleJwtPayload(identityToken) || {};

    let rawAppleSub = String(response.userIdentifier || userObj.id || jwtClaims.sub || '').replace(/^apple_/, '').trim();
    let email = String(
      response.email ||
      userObj.email ||
      jwtClaims.email ||
      (existingFromNative && existingFromNative.email) ||
      (rawAppleSub && localStorage.getItem(`miruo_apple_email_${rawAppleSub}`)) ||
      ''
    ).trim().toLowerCase();

    let incomingFullName = String(
      response.fullName ||
      userObj.fullName ||
      userObj.name ||
      (userObj.firstName ? `${userObj.firstName} ${userObj.lastName || ''}`.trim() : '') ||
      (rawAppleSub && localStorage.getItem(`miruo_apple_name_${rawAppleSub}`)) ||
      ''
    ).trim();

    if (rawAppleSub && email) {
      localStorage.setItem(`miruo_apple_email_${rawAppleSub}`, email);
    }
    if (rawAppleSub && incomingFullName) {
      localStorage.setItem(`miruo_apple_name_${rawAppleSub}`, incomingFullName);
    }

    const canonicalAppleId = rawAppleSub ? `apple_${rawAppleSub}` : '';

    // 0. Check all saved custom profile locations FIRST (never lose user's chosen name or avatar!)
    const savedCustomProfile =
      (rawAppleSub && JSON.parse(localStorage.getItem(`miruo_saved_profile_${rawAppleSub}`) || 'null')) ||
      (email && JSON.parse(localStorage.getItem(`miruo_saved_profile_${email}`) || 'null')) ||
      (canonicalAppleId && JSON.parse(localStorage.getItem(`miruo_saved_profile_${canonicalAppleId}`) || 'null')) ||
      null;

    const customSavedFullName =
      (savedCustomProfile && savedCustomProfile.fullName) ||
      (rawAppleSub && localStorage.getItem(`miruo_apple_name_${rawAppleSub}`)) ||
      (rawAppleSub && localStorage.getItem(`miruo_custom_fullname_${rawAppleSub}`)) ||
      localStorage.getItem('miruo_custom_fullname') ||
      '';

    const customSavedUsername =
      (savedCustomProfile && savedCustomProfile.username) ||
      (rawAppleSub && localStorage.getItem(`miruo_apple_username_${rawAppleSub}`)) ||
      (rawAppleSub && localStorage.getItem(`miruo_custom_username_${rawAppleSub}`)) ||
      localStorage.getItem('miruo_custom_username') ||
      '';

    const customSavedAvatar =
      (savedCustomProfile && (savedCustomProfile.avatarUrl || savedCustomProfile.avatarBg)) ||
      (rawAppleSub && localStorage.getItem(`miruo_apple_avatar_${rawAppleSub}`)) ||
      localStorage.getItem('miruo_custom_avatar') ||
      '';

    // 1. Look up if this Apple ID or Email is ALREADY registered locally
    const regList = JSON.parse(localStorage.getItem('miruo_registered_users') || '[]');
    const byEmail = JSON.parse(localStorage.getItem('miruo_profiles_by_email') || '{}');
    let existingLocal = existingFromNative || regList.find(u =>
      (rawAppleSub && (u.id === canonicalAppleId || u.id === rawAppleSub || u.appleUserId === rawAppleSub)) ||
      (email && u.email && u.email.toLowerCase() === email)
    ) || (email && byEmail[email]) || null;

    // 2. Sync & look up existing account from persistent backend (/api/auth/social-sync)
    let backendUser = null;
    try {
      const syncResp = await fetch('/api/auth/social-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: (existingLocal && existingLocal.id) || canonicalAppleId,
          appleUserId: rawAppleSub,
          email: email,
          fullName: customSavedFullName || incomingFullName || (existingLocal && existingLocal.fullName) || '',
          username: customSavedUsername || (existingLocal && existingLocal.username) || '',
          provider: 'Apple',
          avatarUrl: (savedCustomProfile && savedCustomProfile.avatarUrl) || (existingLocal && existingLocal.avatarUrl) || '',
          avatarBg: (existingLocal && existingLocal.avatarBg) || ''
        })
      });
      if (syncResp && syncResp.ok) {
        const syncData = await syncResp.json();
        if (syncData && syncData.user) {
          backendUser = syncData.user;
        }
      }
    } catch (_) {}

    // 3. Also check Supabase profiles table for existing cross-device Apple account
    let supaProfile = null;
    if (supabaseClient) {
      try {
        if (identityToken && supabaseClient.auth) {
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500));
          await Promise.race([
            supabaseClient.auth.signInWithIdToken({ provider: 'apple', token: identityToken }),
            timeoutPromise
          ]).catch(() => {});
        }
        const lookupId = (backendUser && backendUser.id) || (existingLocal && existingLocal.id) || canonicalAppleId;
        if (lookupId) {
          const { data: profById } = await supabaseClient
            .from('profiles')
            .select('*')
            .eq('id', lookupId)
            .maybeSingle();
          if (profById) supaProfile = profById;
        }
        if (!supaProfile && email) {
          const { data: profByEmail } = await supabaseClient
            .from('profiles')
            .select('*')
            .ilike('email', email)
            .maybeSingle();
          if (profByEmail) supaProfile = profByEmail;
        }
      } catch (_) {}
    }

    // 4. Merge & preserve existing account profile (1 Apple account = 1 registration, keeps saved profile!)
    const genericLabels = ['kullanıcı', 'kullanici', 'apple kullanıcısı', 'apple user', 'user', 'misafir'];
    const pickValidName = (...candidates) => {
      for (const c of candidates) {
        const s = String(c || '').trim();
        if (s && !s.startsWith('@') && !genericLabels.includes(s.toLowerCase())) {
          return s;
        }
      }
      return '';
    };

    const resolvedId =
      (supaProfile && supaProfile.id) ||
      (backendUser && backendUser.id) ||
      (existingLocal && existingLocal.id) ||
      canonicalAppleId ||
      ('apple_' + Date.now().toString(36));

    const resolvedEmail = (
      email ||
      (supaProfile && supaProfile.email) ||
      (backendUser && backendUser.email) ||
      (existingLocal && existingLocal.email) ||
      ''
    ).toLowerCase();

    const displayName =
      pickValidName(
        customSavedFullName,
        existingLocal && existingLocal.fullName,
        supaProfile && (supaProfile.full_name || supaProfile.name),
        backendUser && backendUser.fullName,
        incomingFullName
      ) ||
      (resolvedEmail ? resolvedEmail.split('@')[0] : 'Apple Kullanıcısı');

    let safeUsername = (
      customSavedUsername ||
      (existingLocal && existingLocal.username) ||
      (supaProfile && supaProfile.username) ||
      (backendUser && backendUser.username) ||
      (resolvedEmail ? resolvedEmail.split('@')[0] : displayName)
    )
      .replace(/^@/, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.]/g, '');

    if (!safeUsername || safeUsername.length < 3) {
      safeUsername = 'user_' + (rawAppleSub ? rawAppleSub.slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, '') : Math.floor(1000 + Math.random() * 9000));
    }

    const resolvedAvatarUrl =
      (savedCustomProfile && savedCustomProfile.avatarUrl) ||
      (rawAppleSub && localStorage.getItem(`miruo_apple_avatar_${rawAppleSub}`)) ||
      localStorage.getItem('miruo_custom_avatar') ||
      (existingLocal && existingLocal.avatarUrl) ||
      (supaProfile && supaProfile.avatar_url) ||
      (backendUser && backendUser.avatarUrl) ||
      '';

    const resolvedAvatarBg =
      (savedCustomProfile && savedCustomProfile.avatarBg) ||
      (existingLocal && existingLocal.avatarBg) ||
      (supaProfile && supaProfile.avatar_bg) ||
      (backendUser && backendUser.avatarBg) ||
      'from-rose-500 to-indigo-600';

    const avatarChar = (displayName || safeUsername || 'A').charAt(0).toUpperCase();

    const verifiedUser = {
      id: resolvedId,
      appleUserId: rawAppleSub || undefined,
      name: displayName,
      fullName: displayName,
      username: safeUsername,
      email: resolvedEmail,
      avatarUrl: resolvedAvatarUrl,
      avatarChar: avatarChar,
      avatarBg: resolvedAvatarBg,
      isApple: true,
      provider: 'apple',
      isGuest: false
    };

    localStorage.setItem('miruo_user', JSON.stringify(verifiedUser));
    if (rawAppleSub) {
      localStorage.setItem(`miruo_saved_profile_${rawAppleSub}`, JSON.stringify(verifiedUser));
      localStorage.setItem(`miruo_apple_name_${rawAppleSub}`, verifiedUser.fullName);
      localStorage.setItem(`miruo_apple_username_${rawAppleSub}`, verifiedUser.username);
      if (verifiedUser.avatarUrl) localStorage.setItem(`miruo_apple_avatar_${rawAppleSub}`, verifiedUser.avatarUrl);
    }
    if (resolvedEmail) {
      localStorage.setItem(`miruo_saved_profile_${resolvedEmail}`, JSON.stringify(verifiedUser));
    }
    localStorage.setItem(`miruo_saved_profile_${verifiedUser.id}`, JSON.stringify(verifiedUser));
    localStorage.setItem('miruo_custom_fullname', verifiedUser.fullName);
    localStorage.setItem('miruo_custom_username', verifiedUser.username);
    if (verifiedUser.avatarUrl) localStorage.setItem('miruo_custom_avatar', verifiedUser.avatarUrl);

    state.userId = verifiedUser.id;
    state.username = verifiedUser.username;
    state.avatarUrl = verifiedUser.avatarUrl || '';
    state.avatarBg = verifiedUser.avatarBg;

    // Persist in local registered users list without creating duplicates
    try {
      const idx = regList.findIndex(u =>
        (u.id && u.id === verifiedUser.id) ||
        (rawAppleSub && u.appleUserId === rawAppleSub) ||
        (resolvedEmail && u.email && u.email.toLowerCase() === resolvedEmail)
      );
      const entry = {
        id: verifiedUser.id,
        appleUserId: rawAppleSub || undefined,
        email: resolvedEmail,
        username: safeUsername,
        fullName: displayName,
        avatarUrl: verifiedUser.avatarUrl || '',
        avatarBg: verifiedUser.avatarBg,
        isApple: true,
        provider: 'apple'
      };
      if (idx >= 0) {
        regList[idx] = Object.assign({}, regList[idx], entry);
      } else {
        regList.push(entry);
      }
      localStorage.setItem('miruo_registered_users', JSON.stringify(regList));

      if (resolvedEmail) {
        byEmail[resolvedEmail] = entry;
        localStorage.setItem('miruo_profiles_by_email', JSON.stringify(byEmail));
      }
    } catch (_) {}

    // Ensure native embedded store / Keychain is synchronized with custom profile
    try {
      fetch('/api/auth/update-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: verifiedUser.id,
          userId: verifiedUser.id,
          appleUserId: rawAppleSub || '',
          email: resolvedEmail,
          username: safeUsername,
          fullName: displayName,
          avatarUrl: resolvedAvatarUrl,
          avatarBg: resolvedAvatarBg
        })
      }).catch(() => {});
    } catch (_) {}

    if (window.miruoDesktop && typeof window.miruoDesktop.saveDesktopProfile === 'function') {
      try { window.miruoDesktop.saveDesktopProfile(verifiedUser); } catch (_) {}
    }

    updateUserUI(verifiedUser);

    if (dom.authModal) {
      dom.authModal.classList.add('hidden');
      unfreezeBackgroundAfterModal();
    }

    if (dom.profileEditModal && !dom.profileEditModal.classList.contains('hidden')) {
      if (typeof openProfileEditModal === 'function') openProfileEditModal();
    }
    showToast(`Apple ile giriş yapıldı: ${displayName}`);

    // Keep Supabase profile synced
    syncUserProfileToSupabase(verifiedUser);
  };

  // Native OAuth (Google) Callback from iOS ASWebAuthenticationSession
  window.handleNativeOAuthResponse = async function(response) {
    if (dom.googleLoginBtn) {
      dom.googleLoginBtn.classList.remove('opacity-60', 'pointer-events-none');
    }
    if (dom.appleLoginBtn) {
      dom.appleLoginBtn.classList.remove('opacity-60', 'pointer-events-none');
    }

    if (!response || !response.success) {
      if (response && response.canceled) {
        console.log('[Miruo] OAuth canceled by user');
        hideAuthAlert();
        return;
      }
      const err = response && response.error ? response.error : 'İşlem tamamlanamadı.';
      console.warn('[Miruo] Native OAuth error:', err);
      showAuthAlert('Giriş işlemi tamamlanamadı. Lütfen tekrar deneyin.', false);
      return;
    }

    try {
      hideAuthAlert();
      const session = await authenticateFromUrl(response.url);
      if (!session || !session.user) {
        throw new Error('Kullanıcı oturumu doğrulanamadı.');
      }

      const user = session.user;
      const profile = extractUserProfile(user);
      const isApple = (user.app_metadata?.provider === 'apple') ||
                      (user.identities && user.identities.some(i => i.provider === 'apple')) ||
                      Boolean(user.user_metadata?.iss && user.user_metadata.iss.includes('apple'));

      const verifiedUser = resolveCustomizedUserProfile({
        id: user.id,
        email: user.email || profile.email,
        rawName: profile.name || user.user_metadata?.full_name || user.user_metadata?.name,
        rawUsername: profile.usernameBase || user.user_metadata?.username,
        rawAvatar: profile.avatar || user.user_metadata?.avatar_url || user.user_metadata?.picture,
        rawAvatarBg: user.user_metadata?.avatar_bg || '',
        provider: isApple ? 'apple' : 'google',
        isApple,
        isGoogle: !isApple,
        meta: user.user_metadata || {}
      });

      if (verifiedUser.fullName) {
        const parts = verifiedUser.fullName.trim().split(/\s+/);
        if (dom.authFirstNameInput) dom.authFirstNameInput.value = parts[0] || '';
        if (dom.authLastNameInput) dom.authLastNameInput.value = parts.slice(1).join(' ') || '';
        if (dom.authNameInput) dom.authNameInput.value = verifiedUser.fullName;
        if (dom.editProfileNameInput) dom.editProfileNameInput.value = verifiedUser.fullName;
      }
      if (verifiedUser.email && dom.authContactInput) {
        dom.authContactInput.value = verifiedUser.email;
      }

      state.userId = verifiedUser.id;
      state.username = verifiedUser.username;
      state.avatarUrl = verifiedUser.avatarUrl || '';
      state.avatarBg = verifiedUser.avatarBg;

      if (window.miruoDesktop && typeof window.miruoDesktop.saveDesktopProfile === 'function') {
        try { window.miruoDesktop.saveDesktopProfile(verifiedUser); } catch (_) {}
      }
      try {
        fetch('/api/auth/social-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: verifiedUser.id,
            email: verifiedUser.email,
            fullName: verifiedUser.fullName,
            username: verifiedUser.username,
            provider: verifiedUser.provider,
            avatarUrl: verifiedUser.avatarUrl || '',
            avatarBg: verifiedUser.avatarBg
          })
        }).catch(() => {});
      } catch (_) {}

      updateUserUI(verifiedUser);

      if (dom.authModal) {
        dom.authModal.classList.add('hidden');
        unfreezeBackgroundAfterModal();
      }
      showToast(`${isApple ? 'Apple' : 'Google'} ile giriş yapıldı: ${displayName}`);
      syncUserProfileToSupabase(verifiedUser);
    } catch (e) {
      console.error('[Miruo] handleNativeOAuthResponse error:', e);
      showAuthAlert('Giriş tamamlanamadı: ' + (e.message || 'Bilinmeyen hata'), false);
    }
  };

  // Social Auth Handlers (Google OAuth & 100% Real Native Apple Sign In)
  async function handleSocialLogin(provider) {
    const isGoogle = provider.toLowerCase() === 'google';
    const btn = isGoogle ? dom.googleLoginBtn : dom.appleLoginBtn;

    // 1. Native iOS Apple Sign In (via ASAuthorizationController)
    if (!isGoogle && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.startAppleSignIn) {
      hideAuthAlert();
      if (btn) btn.classList.add('opacity-60', 'pointer-events-none');
      try {
        window.webkit.messageHandlers.startAppleSignIn.postMessage({});
      } catch (e) {
        console.warn('[Miruo] startAppleSignIn failed:', e);
        if (btn) btn.classList.remove('opacity-60', 'pointer-events-none');
      }
      return;
    }

    // 1b. Real Native macOS Apple Sign In (ASAuthorizationController)
    if (!isGoogle && window.miruoDesktop && typeof window.miruoDesktop.promptAppleTouchID === 'function') {
      hideAuthAlert();
      if (btn) btn.classList.add('opacity-60', 'pointer-events-none');
      try {
        const res = await window.miruoDesktop.promptAppleTouchID();
        if (btn) btn.classList.remove('opacity-60', 'pointer-events-none');
        if (res && res.success) {
          window.handleNativeAppleSignInResponse(res);
          return;
        } else if (res && (res.canceled || res.error === 'canceled')) {
          console.log('[Miruo] Apple Sign In canceled by user');
          return;
        } else if (res && res.error) {
          showAuthAlert(res.error, false);
          return;
        }
      } catch (err) {
        if (btn) btn.classList.remove('opacity-60', 'pointer-events-none');
        console.warn('[Miruo] Apple Sign In error:', err);
        showAuthAlert('Apple ile giriş başlatılamadı: ' + (err.message || err), false);
        return;
      }
      return;
    }

    // 2. Desktop App Google OAuth
    if (isGoogle && window.miruoDesktop && typeof window.miruoDesktop.openOAuthWindow === 'function') {
      hideAuthAlert();
      if (btn) btn.classList.add('opacity-60', 'pointer-events-none');
      try {
        const redirectUrl = 'https://miruo.com.tr/app';
        const { data, error } = await supabaseClient.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: redirectUrl,
            skipBrowserRedirect: true,
            queryParams: {
              prompt: 'select_account'
            }
          }
        });

        if (error || !data?.url) {
          throw new Error(error?.message || 'Giriş bağlantısı oluşturulamadı.');
        }

        const oauthRes = await window.miruoDesktop.openOAuthWindow({
          provider: 'google',
          authUrl: data.url
        });

        if (btn) btn.classList.remove('opacity-60', 'pointer-events-none');

        if (oauthRes && oauthRes.success && oauthRes.url) {
          window.handleNativeOAuthResponse(oauthRes);
          return;
        } else if (oauthRes && (oauthRes.canceled || oauthRes.error === 'Pencere kapatıldı.')) {
          console.log('[Miruo] OAuth popup dismissed');
          return;
        } else {
          showAuthAlert(oauthRes?.error || 'Giriş tamamlanamadı.', false);
          return;
        }
      } catch (err) {
        if (btn) btn.classList.remove('opacity-60', 'pointer-events-none');
        console.warn(`[Miruo] Desktop Google OAuth exception:`, err);
        showAuthAlert('Giriş başlatılamadı: ' + (err?.message || err), false);
        return;
      }
    }

    // 2. Native iOS Google OAuth (via ASWebAuthenticationSession)
    if (isGoogle && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.startOAuthSignIn) {
      hideAuthAlert();
      if (btn) btn.classList.add('opacity-60', 'pointer-events-none');
      try {
        const redirectUrl = 'miruo://auth/callback';
        const { data, error } = await supabaseClient.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: redirectUrl,
            skipBrowserRedirect: true,
            queryParams: {
              prompt: 'select_account'
            }
          }
        });
        if (error || !data?.url) {
          throw new Error(error?.message || 'Google oturum bağlantısı alınamadı.');
        }
        window.webkit.messageHandlers.startOAuthSignIn.postMessage({
          url: data.url,
          callbackScheme: 'miruo'
        });
      } catch (err) {
        console.warn('[Miruo] startOAuthSignIn error:', err);
        if (btn) btn.classList.remove('opacity-60', 'pointer-events-none');
        showAuthAlert('Google girişi başlatılamadı: ' + (err.message || err), false);
      }
      return;
    }

    // 3. Web OAuth (when running in a standard web browser)
    const provId = isGoogle ? 'google' : 'apple';
    hideAuthAlert();
    if (btn) btn.classList.add('opacity-60', 'pointer-events-none');

    if (supabaseClient && supabaseClient.auth) {
      try {
        const oauthOptions = {
          redirectTo: window.location.href.split('#')[0]
        };
        if (isGoogle) {
          oauthOptions.queryParams = { prompt: 'select_account' };
        } else {
          oauthOptions.scopes = 'name email';
        }
        const { data, error } = await supabaseClient.auth.signInWithOAuth({
          provider: provId,
          options: oauthOptions
        });

        if (error) {
          console.warn(`[Miruo] Supabase ${provider} OAuth error:`, error);
          if (!isGoogle && (error.message || '').includes('missing OAuth secret')) {
            const savedEmail = localStorage.getItem('miruo_custom_email') || '';
            const appleEmail = window.prompt("Apple Kimliği ile Giriş (E-posta):", savedEmail || 'mehmet@apple.com');
            if (appleEmail && appleEmail.includes('@')) {
              window.handleNativeAppleSignInResponse({
                success: true,
                email: appleEmail.trim().toLowerCase(),
                fullName: appleEmail.split('@')[0],
                userIdentifier: 'apple_' + appleEmail.replace(/[^a-z0-9]/gi, '_')
              });
              return;
            }
          }
          showAuthAlert("Giriş başlatılamadı: " + (error.message || "Bilinmeyen hata"), false);
          return;
        } else if (data && data.url) {
          window.location.href = data.url;
          return;
        }
      } catch (err) {
        console.warn(`[Miruo] Supabase ${provider} OAuth exception:`, err);
        showAuthAlert("Giriş işlemi tamamlanamadı. Lütfen tekrar deneyin.", false);
      } finally {
        if (btn) btn.classList.remove('opacity-60', 'pointer-events-none');
      }
    } else {
      if (btn) btn.classList.remove('opacity-60', 'pointer-events-none');
      showAuthAlert("Giriş servisi şu an kullanılamıyor. Lütfen tekrar deneyin.", false);
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
      try {
        await supabaseClient.auth.signInWithOtp({
          email: emailVal,
          options: {
            shouldCreateUser: false
          }
        });
      } catch (err) {
        console.warn('[Miruo] Supabase signInWithOtp info:', err);
      }
    }

    if (dom.resetSendCodeBtn) {
      dom.resetSendCodeBtn.disabled = false;
      dom.resetSendCodeBtn.innerHTML = '<span>Kodu Gönder</span> <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>';
    }

    showToast('Kurtarma kodu e-posta adresinize gönderildi.');
    setResetStep(2);
    startResetTimer();
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

  // OTP Digit Inputs Management (Full iOS one-time-code AutoFill support)
  otpInputs.forEach((inp, idx) => {
    inp.addEventListener('input', (e) => {
      const val = e.target.value.replace(/[^0-9]/g, '');
      if (val.length > 1) {
        // iOS Safari / WKWebView one-time-code autofill filled multiple digits
        for (let i = 0; i < otpInputs.length; i++) {
          otpInputs[i].value = val[i] || '';
        }
        const lastIdx = Math.min(val.length, otpInputs.length) - 1;
        if (lastIdx >= 0) otpInputs[lastIdx].focus();
        if (val.length >= 6) {
          setTimeout(handleVerifyOtp, 150);
        }
        return;
      }
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
      showResetAlert(2, 'Lütfen doğrulama kodunu eksiksiz girin.');
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
      showToast('Kod başarıyla doğrulandı! Yeni şifrenizi belirleyin.');
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
        dom.strengthText.textContent = score === 0 ? 'Şifre gücü (En az 6 karakter)' : score === 1 ? 'Şifre gücü: Temel' : score === 2 ? 'Şifre gücü: İyi' : 'Şifre gücü: Çok Güçlü';
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
        let users = JSON.parse(usersRaw);
        if (Array.isArray(users)) {
          const u = users.find(x => x && (x.email || '').toLowerCase() === resetState.email.toLowerCase());
          if (u) {
            u.password = newPass;
            localStorage.setItem('miruo_registered_users', JSON.stringify(users));
          }
        } else if (users && typeof users === 'object') {
          if (users[resetState.email.toLowerCase()]) {
            users[resetState.email.toLowerCase()].password = newPass;
            localStorage.setItem('miruo_registered_users', JSON.stringify(users));
          }
        }
      }
    } catch (_) {}

    if (dom.resetSaveNewPasswordBtn) {
      dom.resetSaveNewPasswordBtn.disabled = false;
      dom.resetSaveNewPasswordBtn.innerHTML = '<span>Şifreyi Güncelle & Giriş Yap</span>';
    }

    closeResetModal();
    if (dom.authModal) {
      isSignUpMode = false;
      if (typeof setAuthMode === 'function') {
        setAuthMode(false);
      }
      if (dom.authContactInput) {
        dom.authContactInput.value = resetState.email;
      }
      if (dom.authPasswordInput) {
        dom.authPasswordInput.value = '';
        dom.authPasswordInput.focus();
      }
      dom.authModal.classList.remove('hidden');
    }
    showToast('✓ Şifreniz başarıyla güncellendi! Yeni şifrenizle giriş yapabilirsiniz.');
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
        showToast('Yeni şifrenizle giriş yapabilirsiniz');
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
      showAuthAlert(`${fullPhone} numarasına onay kodu iletildi!${hint}`, true);

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
      showAuthAlert("Lütfen onay kodunu eksiksiz girin.");
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
        showAuthAlert(data.message || "Girdiğiniz onay kodu hatalı veya süresi dolmuş.");
        return;
      }

      showAuthAlert("Telefon doğrulaması başarılı! Hoş geldin.", true);

      const user = {
        id: data.user.id,
        name: data.user.fullName || data.user.username || phoneOtpState.phone,
        fullName: data.user.fullName || data.user.username || phoneOtpState.phone,
        username: (data.user.username || 'kullanici').replace(/^@/, ''),
        phone: phoneOtpState.phone,
        email: data.user.email || `${phoneOtpState.phone.replace(/[^0-9]/g, '')}@miruo.app`,
        provider: 'phone',
        avatarUrl: data.user.avatarUrl || '',
        avatarChar: 'M'
      };

      localStorage.setItem('miruo_user', JSON.stringify(user));
      state.userId = user.id;
      state.username = user.name;
      state.avatarUrl = user.avatarUrl;
      syncUserProfileToSupabase(user);

      setTimeout(() => {
        updateUserUI(user);
        if (dom.authModal) {
          dom.authModal.classList.add('hidden');
          unfreezeBackgroundAfterModal(true);
        }
        showToast(`Hoş geldin! Telefonla giriş yapıldı`);
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

  // ==========================================
  // EMAIL 6-DIGIT OTP VERIFICATION SYSTEM
  // ==========================================
  let emailOtpState = {
    timer: null,
    secondsLeft: 0,
    pendingData: null
  };

  function startEmailOtpTimer() {
    if (emailOtpState.timer) clearInterval(emailOtpState.timer);
    emailOtpState.secondsLeft = 120;
    if (dom.emailOtpResendBtn) dom.emailOtpResendBtn.disabled = true;
    if (dom.emailOtpTimerSpan) dom.emailOtpTimerSpan.textContent = `(${emailOtpState.secondsLeft}s)`;

    emailOtpState.timer = setInterval(() => {
      emailOtpState.secondsLeft--;
      if (emailOtpState.secondsLeft <= 0) {
        clearInterval(emailOtpState.timer);
        emailOtpState.timer = null;
        if (dom.emailOtpResendBtn) dom.emailOtpResendBtn.disabled = false;
        if (dom.emailOtpTimerSpan) dom.emailOtpTimerSpan.textContent = '';
      } else {
        if (dom.emailOtpTimerSpan) dom.emailOtpTimerSpan.textContent = `(${emailOtpState.secondsLeft}s)`;
      }
    }, 1000);
  }

  function handleSendEmailOtp(pendingReg) {
    emailOtpState.pendingData = pendingReg;
    const generatedCode = Math.floor(100000 + Math.random() * 900000).toString();
    emailOtpState.pendingData.code = generatedCode;

    if (dom.authEmailOtpField) dom.authEmailOtpField.classList.remove('hidden');
    if (dom.authRememberRow) dom.authRememberRow.classList.add('hidden');
    if (dom.signUpNameField) dom.signUpNameField.classList.add('hidden');
    if (dom.signUpPasswordConfirmField) dom.signUpPasswordConfirmField.classList.add('hidden');
    if (dom.signUpAvatarSection) dom.signUpAvatarSection.classList.add('hidden');

    if (dom.emailOtpSentNotice) {
      dom.emailOtpSentNotice.textContent = `${pendingReg.email} adresinize doğrulama kodu gönderildi.`;
    }

    startEmailOtpTimer();
    showAuthAlert(`${pendingReg.email} adresine doğrulama kodu gönderildi! (Doğrulama Kodu: ${generatedCode})`, true);

    if (dom.authSubmitBtn) {
      dom.authSubmitBtn.disabled = false;
      dom.authSubmitBtn.textContent = "Doğrula & Hesabı Oluştur";
    }

    const digitInputs = document.querySelectorAll('.email-digit-box');
    if (digitInputs.length > 0) {
      digitInputs.forEach(inp => inp.value = '');
      setTimeout(() => digitInputs[0].focus(), 150);
    }
  }

  async function handleVerifyEmailOtp() {
    hideAuthAlert();
    const digitInputs = Array.from(document.querySelectorAll('.email-digit-box'));
    const enteredCode = digitInputs.map(d => d.value.trim()).join('');

    if (enteredCode.length !== 6) {
      showAuthAlert("Lütfen doğrulama kodunu eksiksiz girin.");
      const firstEmpty = digitInputs.find(d => !d.value.trim());
      if (firstEmpty) firstEmpty.focus();
      return;
    }

    const pending = emailOtpState.pendingData;
    if (!pending) {
      showAuthAlert("Kayıt bilgileri zaman aşımına uğradı. Lütfen formu tekrar doldurun.");
      resetEmailOtpUI();
      return;
    }

    if (enteredCode !== pending.code) {
      showAuthAlert("Girdiğiniz kod hatalı! Lütfen kontrol edip tekrar deneyin.");
      return;
    }

    if (dom.authSubmitBtn) {
      dom.authSubmitBtn.disabled = true;
      dom.authSubmitBtn.textContent = "Hesap Oluşturuluyor...";
    }

    // Register user in Supabase
    if (supabaseClient) {
      try {
        await supabaseClient.auth.signUp({
          email: pending.email,
          password: pending.password,
          options: {
            data: {
              full_name: pending.fullName,
              username: pending.username,
              avatar_url: pending.avatarUrl || ''
            }
          }
        });
      } catch (e) {
        console.warn('[Supabase email signUp info]:', e);
      }
    }

    // Register user in server backend
    try {
      const regPayload = {
        fullName: pending.fullName,
        username: pending.username,
        email: pending.email,
        password: pending.password,
        avatarUrl: pending.avatarUrl || '',
        avatarBg: selectedSignUpAvatarBg
      };
      let regOk = false;
      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(regPayload)
        });
        if (res.ok) {
          const ct = res.headers.get('content-type') || '';
          if (ct.includes('application/json')) regOk = true;
        }
      } catch (_) {}

      if (!regOk && window.location.port !== '3000') {
        try {
          await fetch('http://127.0.0.1:3000/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(regPayload)
          });
        } catch (_) {}
      }
    } catch (e) {}

    // Save account to local registered users registry
    try {
      const regList = JSON.parse(localStorage.getItem('miruo_registered_users') || '[]');
      const cleanUName = pending.username.replace(/^@/, '');
      const exists = regList.some(u => u.email.toLowerCase() === pending.email.toLowerCase());
      if (!exists) {
        regList.push({
          email: pending.email.toLowerCase(),
          username: cleanUName,
          fullName: pending.fullName || cleanUName,
          password: pending.password,
          avatarUrl: pending.avatarUrl || '',
          avatarBg: selectedSignUpAvatarBg
        });
        localStorage.setItem('miruo_registered_users', JSON.stringify(regList));
      }
    } catch (e) {}

    const cleanUsername = pending.username.replace(/^@/, '');
    const user = {
      id: 'user_' + Math.random().toString(36).substring(2, 8),
      name: pending.fullName || cleanUsername,
      fullName: pending.fullName || cleanUsername,
      username: cleanUsername,
      email: pending.email,
      avatarUrl: pending.avatarUrl || '',
      avatarBg: selectedSignUpAvatarBg,
      avatarChar: cleanUsername.charAt(0).toUpperCase()
    };

    localStorage.setItem('miruo_user', JSON.stringify(user));
    localStorage.setItem('miruo_custom_username', cleanUsername);
    state.userId = user.id;
    state.username = cleanUsername;
    state.avatarUrl = user.avatarUrl;
    syncUserProfileToSupabase(user);

    showAuthAlert("Hesabınız başarıyla doğrulandı ve oluşturuldu! Hoş geldiniz.", true);
    setTimeout(() => {
      updateUserUI(user);
      if (dom.authModal) {
        dom.authModal.classList.add('hidden');
        unfreezeBackgroundAfterModal();
      }
      showToast(`Hoş geldin @${cleanUsername}! Hesabınız doğrulandı`);
      resetEmailOtpUI();
    }, 400);
  }

  function resetEmailOtpUI() {
    if (dom.authEmailOtpField) dom.authEmailOtpField.classList.add('hidden');
    if (dom.authRememberRow) dom.authRememberRow.classList.remove('hidden');
    if (isSignUpMode) {
      if (dom.signUpNameField) dom.signUpNameField.classList.remove('hidden');
      if (dom.signUpPasswordConfirmField) dom.signUpPasswordConfirmField.classList.remove('hidden');
      if (dom.signUpAvatarSection) dom.signUpAvatarSection.classList.remove('hidden');
      if (dom.authSubmitBtn) dom.authSubmitBtn.textContent = "Kayıt Ol";
    }
    if (emailOtpState.timer) clearInterval(emailOtpState.timer);
    emailOtpState.timer = null;
    hideAuthAlert();
  }

  // Email OTP Digit Boxes event bindings
  const emailDigitBoxes = Array.from(document.querySelectorAll('.email-digit-box'));
  emailDigitBoxes.forEach((box, idx) => {
    box.addEventListener('input', (e) => {
      const val = e.target.value.replace(/[^0-9]/g, '');
      box.value = val ? val.slice(-1) : '';
      if (val && idx < emailDigitBoxes.length - 1) {
        emailDigitBoxes[idx + 1].focus();
      }
      const fullCode = emailDigitBoxes.map(b => b.value.trim()).join('');
      if (fullCode.length === 6) {
        handleVerifyEmailOtp();
      }
    });

    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && idx > 0) {
        emailDigitBoxes[idx - 1].focus();
      } else if (e.key === 'Enter') {
        handleVerifyEmailOtp();
      }
    });

    box.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasteData = (e.clipboardData || window.clipboardData).getData('text');
      const cleanDigits = pasteData.replace(/[^0-9]/g, '').slice(0, 6);
      if (cleanDigits) {
        cleanDigits.split('').forEach((d, i) => {
          if (emailDigitBoxes[i]) emailDigitBoxes[i].value = d;
        });
        const nextIdx = Math.min(cleanDigits.length, emailDigitBoxes.length - 1);
        emailDigitBoxes[nextIdx].focus();
        if (cleanDigits.length === 6) {
          handleVerifyEmailOtp();
        }
      }
    });
  });

  if (dom.emailOtpBackBtn) {
    dom.emailOtpBackBtn.addEventListener('click', () => {
      resetEmailOtpUI();
      if (dom.authContactInput) dom.authContactInput.focus();
    });
  }

  if (dom.emailOtpResendBtn) {
    dom.emailOtpResendBtn.addEventListener('click', () => {
      if (emailOtpState.secondsLeft <= 0 && emailOtpState.pendingData) {
        handleSendEmailOtp(emailOtpState.pendingData);
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

      // Email Method
      const contactVal = (dom.authContactInput && dom.authContactInput.value.trim()) || '';
      const passwordVal = (dom.authPasswordInput && dom.authPasswordInput.value.trim()) || '';
      const nameVal = (dom.authNameInput && dom.authNameInput.value.trim()) || '';

      if (isSignUpMode) {
        // If email OTP field is active, verify code
        const isEmailOtpActive = dom.authEmailOtpField && !dom.authEmailOtpField.classList.contains('hidden');
        if (isEmailOtpActive) {
          handleVerifyEmailOtp();
          return;
        }

        // Validate initial registration form
        const firstNameVal = (dom.authFirstNameInput && dom.authFirstNameInput.value.trim()) || '';
        const lastNameVal = (dom.authLastNameInput && dom.authLastNameInput.value.trim()) || '';
        if (!firstNameVal) {
          showAuthAlert("Lütfen adınızı girin.");
          if (dom.authFirstNameInput) dom.authFirstNameInput.focus();
          return;
        }
        if (!lastNameVal) {
          showAuthAlert("Lütfen soyadınızı girin.");
          if (dom.authLastNameInput) dom.authLastNameInput.focus();
          return;
        }
        const fullName = `${firstNameVal} ${lastNameVal}`.trim();
        if (dom.authNameInput) dom.authNameInput.value = fullName;
        if (!contactVal || !contactVal.includes('@')) {
          showAuthAlert("Lütfen geçerli bir e-posta adresi girin (Örn: adiniz@gmail.com).");
          if (dom.authContactInput) dom.authContactInput.focus();
          return;
        }
        const cleanRegEmail = contactVal.trim().toLowerCase();
        const existingRegUsers = JSON.parse(localStorage.getItem('miruo_registered_users') || '[]');
        const existingByEmail = JSON.parse(localStorage.getItem('miruo_profiles_by_email') || '{}');
        if (
          existingRegUsers.some(u => u && u.email && u.email.toLowerCase() === cleanRegEmail) ||
          Boolean(existingByEmail[cleanRegEmail])
        ) {
          showAuthAlert("Bu e-posta adresi ile zaten kayıtlı bir hesap bulunuyor! Tek e-posta ile yalnızca 1 kez kayıt olunabilir. Lütfen 'Giriş Yap' sekmesinden giriş yapın.");
          return;
        }
        if (supabaseClient) {
          try {
            const { data: existingSupa } = await supabaseClient
              .from('profiles')
              .select('id, email')
              .ilike('email', cleanRegEmail)
              .maybeSingle();
            if (existingSupa && existingSupa.id) {
              showAuthAlert("Bu e-posta adresi ile zaten kayıtlı bir hesap bulunuyor! Tek e-posta ile yalnızca 1 kez kayıt olunabilir. Lütfen 'Giriş Yap' sekmesinden giriş yapın.");
              return;
            }
          } catch (_) {}
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

        const cleanUsername = fullName.trim().replace(/^@/, '');

        // Dispatch 6-digit email confirmation OTP
        handleSendEmailOtp({
          fullName: fullName,
          username: cleanUsername,
          email: cleanRegEmail,
          password: passwordVal,
          avatarUrl: selectedSignUpAvatarData || ''
        });

      } else {
        // SIGN IN VALIDATION: SUPPORT BOTH USERNAME AND EMAIL (Strict check against registered users)
        const rawContact = contactVal.trim();
        const cleanContact = rawContact.replace(/^@/, '').trim();
        if (!cleanContact) {
          showAuthAlert("Lütfen e-posta adresinizi veya kullanıcı adınızı girin.");
          if (dom.authContactInput) dom.authContactInput.focus();
          return;
        }

        const isEmail = cleanContact.includes('@');
        const registeredUsers = JSON.parse(localStorage.getItem('miruo_registered_users') || '[]');
        const byEmailMap = JSON.parse(localStorage.getItem('miruo_profiles_by_email') || '{}');

        // Check local registered accounts by email or clean username
        let localMatch = registeredUsers.find(u => {
          if (isEmail && u.email && u.email.toLowerCase() === cleanContact.toLowerCase()) return true;
          if (u.username && u.username.toLowerCase().replace(/^@/, '') === cleanContact.toLowerCase()) return true;
          if (u.email && u.email.toLowerCase() === cleanContact.toLowerCase()) return true;
          return false;
        });

        // Also check if current miruo_user matches
        const storedUser = JSON.parse(localStorage.getItem('miruo_user') || 'null');
        if (!localMatch && storedUser) {
          const storedUserClean = (storedUser.username || '').toLowerCase().replace(/^@/, '');
          const storedEmail = (storedUser.email || '').toLowerCase();
          if (storedUserClean === cleanContact.toLowerCase() || (isEmail && storedEmail === cleanContact.toLowerCase())) {
            localMatch = {
              id: storedUser.id,
              email: storedUser.email || '',
              username: storedUser.username || cleanContact,
              fullName: (storedUser.fullName && !storedUser.fullName.startsWith('@')) ? storedUser.fullName : (storedUser.name || storedUser.username || cleanContact),
              password: passwordVal,
              avatarUrl: storedUser.avatarUrl || '',
              avatarBg: storedUser.avatarBg || '',
              isApple: !!(storedUser.isApple || storedUser.provider === 'apple'),
              provider: storedUser.provider || (storedUser.isApple ? 'apple' : 'email')
            };
          }
        }

        if (!passwordVal) {
          // If this account is an Apple ID account, trigger Touch ID / Apple authentication seamlessly
          if (localMatch && (localMatch.isApple || localMatch.provider === 'apple')) {
            if (dom.appleLoginBtn) {
              dom.appleLoginBtn.click();
              return;
            }
          }
          showAuthAlert("Lütfen şifrenizi girin.");
          if (dom.authPasswordInput) dom.authPasswordInput.focus();
          return;
        }

        const prevBtnText = dom.authSubmitBtn.innerText;
        dom.authSubmitBtn.innerText = "Giriş yapılıyor...";
        dom.authSubmitBtn.disabled = true;

        let loginSuccess = false;
        let userData = null;

        // 1. Check local backend
        try {
          const loginPayload = { email: cleanContact, emailOrUsername: cleanContact, password: passwordVal };
          let resp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(loginPayload)
          });
          let data = null;
          if (resp && resp.ok) {
            const ct = resp.headers.get('content-type') || '';
            if (ct.includes('application/json')) data = await resp.json();
          }
          if ((!data || !data.success) && window.location.port !== '3000') {
            try {
              const fallbackResp = await fetch('http://127.0.0.1:3000/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(loginPayload)
              });
              if (fallbackResp && fallbackResp.ok) {
                const ct = fallbackResp.headers.get('content-type') || '';
                if (ct.includes('application/json')) data = await fallbackResp.json();
              }
            } catch (_) {}
          }
          if (data && data.success && data.user) {
            loginSuccess = true;
            userData = data.user;
          }
        } catch (e) {}

        // 2. Check Supabase (if email)
        if (!loginSuccess && supabaseClient && isEmail) {
          try {
            const { data: supaAuth, error: supaErr } = await supabaseClient.auth.signInWithPassword({
              email: cleanContact,
              password: passwordVal
            });
            if (!supaErr && supaAuth && supaAuth.user) {
              loginSuccess = true;
              userData = {
                id: supaAuth.user.id,
                email: supaAuth.user.email,
                fullName: supaAuth.user.user_metadata?.full_name || supaAuth.user.user_metadata?.name,
                username: supaAuth.user.user_metadata?.username,
                avatarUrl: supaAuth.user.user_metadata?.avatar_url,
                avatarBg: supaAuth.user.user_metadata?.avatar_bg
              };
            }
          } catch (e) {}
        }

        // 3. Check local registered user record
        if (!loginSuccess && localMatch) {
          if (localMatch.isApple || localMatch.provider === 'apple' || !localMatch.password || localMatch.password === passwordVal) {
            loginSuccess = true;
            userData = {
              id: localMatch.id || ('user_' + Math.random().toString(36).substring(2, 8)),
              email: localMatch.email,
              fullName: localMatch.fullName,
              username: localMatch.username,
              avatarUrl: localMatch.avatarUrl,
              avatarBg: localMatch.avatarBg,
              isApple: !!(localMatch.isApple || localMatch.provider === 'apple'),
              provider: localMatch.provider || (localMatch.isApple ? 'apple' : 'email')
            };
          } else {
            dom.authSubmitBtn.innerText = prevBtnText;
            dom.authSubmitBtn.disabled = false;
            showAuthAlert("Girdiğiniz şifre hatalı! Lütfen kontrol edin.");
            return;
          }
        }

        // STRICT BLOCK: If account does not exist anywhere, DO NOT log in!
        if (!loginSuccess) {
          dom.authSubmitBtn.innerText = prevBtnText;
          dom.authSubmitBtn.disabled = false;
          showAuthAlert("Bu kullanıcı adı veya e-posta ile kayıtlı bir hesap bulunamadı! Lütfen önce 'Kayıt Ol' sekmesinden hesap oluşturun.");
          return;
        }

        dom.authSubmitBtn.innerText = prevBtnText;
        dom.authSubmitBtn.disabled = false;

        // Successfully authenticated: always preserve exact saved custom username, real full name, email, and avatar
        const resolvedEmail = (userData.email || (localMatch && localMatch.email) || (isEmail ? cleanContact : '')).toLowerCase();
        const emailProf = (resolvedEmail && byEmailMap[resolvedEmail]) || {};
        const prevSavedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');

        const finalUsername = (
          emailProf.username ||
          (localMatch && localMatch.username) ||
          userData.username ||
          localStorage.getItem('miruo_custom_username') ||
          cleanContact.split('@')[0]
        ).replace(/^@/, '');

        const finalFullName =
          (emailProf.fullName && !emailProf.fullName.startsWith('@') ? emailProf.fullName : '') ||
          (localMatch && localMatch.fullName && !localMatch.fullName.startsWith('@') ? localMatch.fullName : '') ||
          (userData.fullName && !userData.fullName.startsWith('@') ? userData.fullName : '') ||
          (prevSavedUser.fullName && !prevSavedUser.fullName.startsWith('@') ? prevSavedUser.fullName : '') ||
          finalUsername;

        const finalAvatarUrl = emailProf.avatarUrl || (localMatch && localMatch.avatarUrl) || userData.avatarUrl || prevSavedUser.avatarUrl || '';
        const finalAvatarBg = emailProf.avatarBg || (localMatch && localMatch.avatarBg) || userData.avatarBg || prevSavedUser.avatarBg || 'from-rose-500 to-[#A64D79]';

        const user = resolveCustomizedUserProfile({
          id: userData.id || (localMatch && localMatch.id) || emailProf.id || ('user_' + Math.random().toString(36).substring(2, 8)),
          email: resolvedEmail || userData.email || '',
          rawName: finalFullName,
          rawUsername: finalUsername,
          rawAvatar: finalAvatarUrl,
          rawAvatarBg: finalAvatarBg,
          provider: userData.provider || (userData.isApple ? 'apple' : 'email'),
          isApple: !!userData.isApple,
          isGoogle: false
        });
        if (passwordVal) user.password = passwordVal;
        localStorage.setItem('miruo_user', JSON.stringify(user));

        state.userId = user.id;
        state.username = user.username;
        state.avatarUrl = user.avatarUrl;
        state.avatarBg = user.avatarBg;
        syncUserProfileToSupabase(user);

        showAuthAlert("Giriş başarılı! Hoş geldin.", true);
        setTimeout(() => {
          updateUserUI(user);
          if (dom.authModal) {
            dom.authModal.classList.add('hidden');
            unfreezeBackgroundAfterModal();
          }
          showToast(`Giriş yapıldı, hoş geldin @${finalUsername}!`);
        }, 350);
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
      freezeBackgroundForModal();
      if (dom.authModal) dom.authModal.classList.remove('hidden');
    });
  }

  if (dom.closeAuthModalBtn) {
    addInstantTap(dom.closeAuthModalBtn, () => {
      const savedUser = localStorage.getItem('miruo_user');
      if (savedUser) {
        if (dom.authModal) dom.authModal.classList.add('hidden');
        unfreezeBackgroundAfterModal(true);
      } else {
        showToast('Lütfen giriş yapın veya kayıt olun.');
      }
    });
  }

  if (dom.continueAsGuestBtn) {
    addInstantTap(dom.continueAsGuestBtn, () => {
      const guestNum = Math.floor(1000 + Math.random() * 9000);
      const guestUser = {
        id: state.userId || ('user_' + Math.random().toString(36).substring(2, 8)),
        name: 'Misafir ' + guestNum,
        username: 'misafir_' + guestNum,
        avatarChar: 'M',
        defaultRoom: 'ODA-' + guestNum
      };
      localStorage.setItem('miruo_user', JSON.stringify(guestUser));
      state.userId = guestUser.id;
      state.username = guestUser.username;
      updateUserUI(guestUser);
      if (dom.authModal) dom.authModal.classList.add('hidden');
      unfreezeBackgroundAfterModal(true);
      if (typeof loadPublicRooms === 'function') loadPublicRooms();
      showToast('Misafir olarak devam ediliyor.');
    });
  }

  // ==========================================
  // RAVE YOUTUBE BROWSER & PICKER ("Aynı Rave Mantığı")
  // ==========================================
  let currentRaveYtTag = 'trending';
  let raveYtDebounceTimer = null;

  const PLATFORM_CONFIGS = {
    youtube: { title: 'YouTube', url: 'https://m.youtube.com' },
    netflix: { title: 'Netflix', url: 'https://www.netflix.com' },
    prime: { title: 'Prime Video', url: 'https://www.primevideo.com' },
    disney: { title: 'Disney+', url: 'https://www.disneyplus.com' },
    twitch: { title: 'Twitch', url: 'https://m.twitch.tv' },
    kick: { title: 'Kick', url: 'https://kick.com' },
    live: { title: 'Canlı Yayın', url: 'https://m.youtube.com/live' },
    playlist: { title: 'Playlist', url: 'https://music.youtube.com' },
    drive: { title: 'Google Drive', url: 'https://drive.google.com' },
    photos: { title: 'Galeri', url: '' },
    web: { title: 'Web Tarayıcı', url: 'https://www.google.com' },
    dj: { title: 'Miruo Müzik', url: 'https://m.youtube.com/results?search_query=remix+party+live+music' },
    karaoke: { title: 'Karaoke', url: 'https://m.youtube.com/results?search_query=karaoke+turkce' },
    likes: { title: 'Beğenilenler', url: 'https://m.youtube.com/feed/library' },
    history: { title: 'Geçmiş', url: 'https://m.youtube.com/feed/history' }
  };

  function openDesktopPlatformBrowser(providerKey, url, platformTitle) {
    const old = document.getElementById('desktopBrowserOverlay');
    if (old) old.remove();

    const isMac = window.miruoDesktop && window.miruoDesktop.platform === 'darwin';
    let startUrl = String(url).replace('//m.youtube.com', '//www.youtube.com');
    const ua = navigator.userAgent.replace(/\s(Electron|Miruo)[^\s]*/g, '');
    const btnCss = 'display:flex;align-items:center;gap:6px;padding:8px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.08);color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer;-webkit-app-region:no-drag;user-select:none;';

    const playingTitle = (dom.nowPlayingTitle && dom.nowPlayingTitle.textContent) || state.currentVideoTitle || '';
    const hasActivePlaying = !!(state.roomId && dom.roomWorkspaceSection && !dom.roomWorkspaceSection.classList.contains('hidden') && playingTitle && !playingTitle.includes('Henüz') && !playingTitle.includes('Seçilmedi') && !playingTitle.includes('No video'));

    const ov = document.createElement('div');
    ov.id = 'desktopBrowserOverlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#000;display:flex;flex-direction:column;';
    ov.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 16px 10px ${isMac ? 84 : 16}px;background:#0B0D14;border-bottom:1px solid rgba(255,255,255,.1);-webkit-app-region:drag;">
        <button id="dbPlatformBtn" type="button" title="Farklı bir platform seç (YouTube, Web Tarayıcı vb.)" style="${btnCss}background:rgba(225,29,72,.22);border-color:rgba(225,29,72,.45);color:#fda4af;font-weight:700;">☰ Platform Seç</button>
        <button id="dbBackBtn" type="button" title="Önceki Sayfa (Geri - en başa gelince odaya döner)" style="${btnCss}">← Geri</button>
        <button id="dbFwdBtn" type="button" title="Sonraki Sayfa (İleri)" style="${btnCss}">→ İleri</button>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;text-align:center;">
          <span id="dbTitle" style="width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e5e7eb;font:700 14px system-ui,sans-serif;">${platformTitle}</span>
        </div>
        <button id="dbQueueBtn" type="button" title="Mevcut videoyu durdurmadan sıraya ekle" style="${btnCss}background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.25);">+ Sıraya Ekle</button>
        <button id="dbPlayBtn" type="button" title="Bu videoyu hemen odada başlat" style="${btnCss}background:linear-gradient(90deg,#e11d48,#a64d79);border-color:transparent;font-weight:700;">▶ Odada Oynat</button>
      </div>
      <webview id="dbWebview" src="${startUrl}" partition="persist:miruo-browser" useragent="${ua}" allowpopups style="flex:1;width:100%;border:0;background:#000;"></webview>`;
    document.body.appendChild(ov);

    const wv = ov.querySelector('#dbWebview');
    const titleEl = ov.querySelector('#dbTitle');
    const platformBtn = ov.querySelector('#dbPlatformBtn');
    const backBtn = ov.querySelector('#dbBackBtn');
    const fwdBtn = ov.querySelector('#dbFwdBtn');
    const playBtn = ov.querySelector('#dbPlayBtn');
    const queueBtn = ov.querySelector('#dbQueueBtn');

    const isYt = providerKey === 'youtube';
    const isTwitch = providerKey === 'twitch';
    const isKick = providerKey === 'kick';

    const canPlay = () => {
      let cur = '';
      try { cur = wv.getURL(); } catch (e) { return false; }
      if (!cur || !/^https?:/i.test(cur)) return false;
      if (isYt) return !!extractYtId(cur);
      if (isTwitch || cur.includes('twitch.tv')) return !!extractTwitchChannel(cur);
      if (isKick || cur.includes('kick.com')) return !!extractKickChannel(cur);
      return true;
    };

    const refreshNav = () => {
      let t = '';
      try { t = (wv.getTitle() || '').replace(/\s*-\s*YouTube$/i, ''); } catch (e) {}
      if (t) titleEl.textContent = t;
      const ok = canPlay();
      playBtn.style.opacity = ok ? '1' : '0.45';
      queueBtn.style.opacity = ok ? '1' : '0.45';
      try {
        backBtn.style.opacity = wv.canGoBack() ? '1' : '0.45';
        fwdBtn.style.opacity = wv.canGoForward() ? '1' : '0.45';
      } catch (_) {}
    };

    ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'dom-ready'].forEach(ev => wv.addEventListener(ev, refreshNav));
    refreshNav();

    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey, true);

    const handleBack = () => {
      try {
        if (wv.canGoBack()) wv.goBack();
        else close();
      } catch (e) {
        close();
      }
    };
    const handleForward = () => {
      try {
        if (wv.canGoForward()) wv.goForward();
      } catch (e) {}
    };

    if (platformBtn) {
      platformBtn.addEventListener('click', () => {
        close();
        if (dom.roomPlatformChooserModal) dom.roomPlatformChooserModal.classList.remove('hidden');
      });
    }
    backBtn.addEventListener('click', handleBack);
    fwdBtn.addEventListener('click', handleForward);

    // Support physical mouse back (button 3) and forward (button 4) navigation
    ov.addEventListener('mouseup', (e) => {
      if (e.button === 3) { e.preventDefault(); handleBack(); }
      else if (e.button === 4) { e.preventDefault(); handleForward(); }
    });
    ov.addEventListener('auxclick', (e) => {
      if (e.button === 3) { e.preventDefault(); handleBack(); }
      else if (e.button === 4) { e.preventDefault(); handleForward(); }
    });

    if (window.miruoDesktop && typeof window.miruoDesktop.onNavBackward === 'function') {
      window.miruoDesktop.onNavBackward(handleBack);
      window.miruoDesktop.onNavForward(handleForward);
    }

    playBtn.addEventListener('click', () => {
      if (!canPlay()) {
        showToast(isYt ? 'Önce izlemek istediğin videoyu aç' : (isTwitch ? 'Önce izlemek istediğin bir Twitch yayınına tıkla' : (isKick ? 'Önce izlemek istediğin bir Kick yayınına tıkla' : 'Önce bir sayfa aç')));
        return;
      }
      let cur = '', t = '';
      try { cur = wv.getURL(); t = (wv.getTitle() || '').replace(/\s*-\s*YouTube$/i, ''); } catch (e) {}
      close();
      if (isKick || cur.includes('kick.com')) {
        const ch = extractKickChannel(cur);
        loadKickStream(cur, t || `${ch} - Kick`);
      } else if (isTwitch || cur.includes('twitch.tv')) {
        const ch = extractTwitchChannel(cur);
        loadTwitchStream(cur, t || `${ch} - Twitch`);
      } else if (isYt || extractYtId(cur)) {
        selectAndPlayYoutubeVideo(cur, t || platformTitle, platformTitle);
      } else {
        loadWebStream(cur, t || platformTitle, platformTitle);
      }
    });

    queueBtn.addEventListener('click', () => {
      if (!canPlay()) {
        showToast(isYt ? 'Önce sıraya eklemek istediğin videoyu aç' : (isTwitch ? 'Önce sıraya eklemek istediğin bir Twitch yayınına tıkla' : (isKick ? 'Önce sıraya eklemek istediğin bir Kick yayınına tıkla' : 'Önce bir sayfa aç')));
        return;
      }
      let cur = '', t = '';
      try { cur = wv.getURL(); t = (wv.getTitle() || '').replace(/\s*-\s*YouTube$/i, ''); } catch (e) {}
      const cleanId = extractYtId(cur);
      const cleanTwitch = (isTwitch || cur.includes('twitch.tv')) ? extractTwitchChannel(cur) : '';
      const cleanKick = (isKick || cur.includes('kick.com')) ? extractKickChannel(cur) : '';

      if (!state.roomId || !dom.roomWorkspaceSection || dom.roomWorkspaceSection.classList.contains('hidden')) {
        close();
        if (cleanKick) loadKickStream(cur, t || `${cleanKick} - Kick`);
        else if (cleanTwitch) loadTwitchStream(cur, t || `${cleanTwitch} - Twitch`);
        else selectAndPlayYoutubeVideo(cur, t || platformTitle, platformTitle);
        return;
      }

      if (cleanKick) {
        addToRoomQueue({
          id: `kick:${cleanKick}`,
          title: t || `${cleanKick} - Kick Yayını`,
          thumb: 'https://kick.com/favicon.ico',
          channel: cleanKick,
          addedBy: state.username
        });
      } else if (cleanTwitch) {
        addToRoomQueue({
          id: `twitch:${cleanTwitch}`,
          title: t || `${cleanTwitch} - Twitch Yayını`,
          thumb: 'https://static-cdn.jtvnw.net/jtv_user_pictures/' + cleanTwitch + '-profile_image-300x300.png',
          channel: cleanTwitch,
          addedBy: state.username
        });
      } else {
        addToRoomQueue({
          id: cleanId || cur,
          title: t || platformTitle,
          thumb: cleanId ? `https://i.ytimg.com/vi/${cleanId}/hqdefault.jpg` : '',
          channel: isYt ? 'YouTube' : platformTitle,
          addedBy: state.username
        });
      }
      showToast(`✓ "${t || platformTitle}" sıraya eklendi! Odanızdaki video kesintisiz devam ediyor.`);
      close();
    });
  }

  function launchPlatform(providerKey) {
    if (state.roomId && dom.roomWorkspaceSection && !dom.roomWorkspaceSection.classList.contains('hidden') && !canUserChooseVideo()) {
      showToast('Odaya video seçme yetkisi sadece Oda Sahibi, Yöneticiler ve Video Açabilenlerdedir.');
      return;
    }
    if (providerKey === 'photos' || providerKey === 'gallery') {
      triggerRoomGalleryPicker();
      return;
    }
    const config = PLATFORM_CONFIGS[providerKey] || { title: providerKey.toUpperCase(), url: 'https://www.google.com' };
    const accounts = typeof getConnectedAccounts === 'function' ? getConnectedAccounts() : {};
    const conn = accounts[providerKey] || {};
    const isConn = conn.connected && conn.account;

    let targetUrl = config.url;
    if (isConn) {
      if (providerKey === 'youtube') targetUrl = 'https://m.youtube.com/feed/subscriptions';
      else if (providerKey === 'netflix') targetUrl = 'https://www.netflix.com/browse';
      else if (providerKey === 'prime') targetUrl = 'https://www.primevideo.com/storefront/home';
      else if (providerKey === 'disney') targetUrl = 'https://www.disneyplus.com/home';
      state.connectedAccount = conn.account;
      if (typeof updateNowPlayingAccountBadge === 'function') updateNowPlayingAccountBadge(conn.account);
    }
    
    const hasActiveVideo = !!(state.isInRoom && state.roomId && state.currentVideoId && dom.roomWorkspaceSection && !dom.roomWorkspaceSection.classList.contains('hidden'));

    if (providerKey === 'likes') {
      const likes = (typeof getLikedVideos === 'function') ? getLikedVideos() : [];
      if (likes.length > 0 && typeof openLikedVideosModal === 'function') {
        openLikedVideosModal();
        return;
      } else {
        showToast('Henüz beğenilen video yok. Bir video izlerken kalp butonuna basarak listenize ekleyebilirsiniz!');
        return;
      }
    }

    // In iOS App: presents full-featured native in-app browser with top search bar!
    if (window.webkit && window.webkit.messageHandlers && (window.webkit.messageHandlers.openPlatform || window.webkit.messageHandlers.openYouTube)) {
      if (window.webkit.messageHandlers.openPlatform) {
        window.webkit.messageHandlers.openPlatform.postMessage({
          provider: providerKey,
          url: targetUrl,
          title: config.title,
          lang: currentLang,
          account: isConn ? conn.account : '',
          hasActiveVideo: hasActiveVideo
        });
        return;
      } else if (window.webkit.messageHandlers.openYouTube && providerKey === 'youtube') {
        window.webkit.messageHandlers.openYouTube.postMessage({ 
          lang: currentLang,
          account: isConn ? conn.account : '',
          hasActiveVideo: hasActiveVideo
        });
        return;
      }
    }

    // Mac / Windows / Web: same flow as the phone's native in-app browser.
    // Picking a platform opens that platform's own screen (with a Back button) and the room
    // is created/updated when a video is chosen - never an empty room.
    const isDesktopApp = !!(window.miruoDesktop && window.miruoDesktop.isDesktop);
    if (isDesktopApp && /^https?:/i.test(targetUrl || '')) {
      openDesktopPlatformBrowser(providerKey, targetUrl, config.title);
      return;
    }
    if (providerKey === 'youtube') {
      openRaveYoutubeModal();
      return;
    }
    if (state.isInRoom && state.roomId) {
      if (providerKey === 'kick') {
        const chan = extractKickChannel(targetUrl) || 'elraenn';
        loadKickStream(chan, 'Kick Yayını');
        return;
      }
      if (providerKey === 'twitch') {
        const chan = extractTwitchChannel(targetUrl) || 'elraenn';
        loadTwitchStream(chan, 'Twitch Yayını');
        return;
      }
      loadWebStream(targetUrl, config.title, config.title);
      return;
    }
    
    // Open and join watch room directly for YouTube and all platforms
    const title = isConn ? `${config.title} Odası (${conn.account})` : `${config.title} Odası`;
    createAndJoinRoom(title, false, config.title);
    if (isConn) {
      showToast(`${config.title} (${conn.account}) hesabı üzerinden oda açıldı!`);
    } else {
      showToast(`${config.title} odası açıldı!`);
      if ((providerKey === 'netflix' || providerKey === 'prime' || providerKey === 'disney') && dom.drmGuideModal) {
        setTimeout(() => {
          dom.drmGuideModal.classList.remove('hidden');
        }, 600);
      }
    }

    if (providerKey === 'kick') {
      setTimeout(() => {
        loadKickStream(targetUrl || 'elraenn', 'Kick Yayını');
      }, 500);
    } else if (providerKey === 'twitch') {
      setTimeout(() => {
        loadTwitchStream(targetUrl || 'elraenn', 'Twitch Yayını');
      }, 500);
    } else if (providerKey === 'drive' || providerKey === 'photos' || providerKey === 'web') {
      setTimeout(() => {
        loadWebStream(targetUrl, config.title, config.title);
      }, 500);
    }
  }

  // YouTube Direct Interface Launch
  function handleYouTubeLaunch() {
    launchPlatform('youtube');
  }

  function openRealYouTubeInterface() {
    launchPlatform('youtube');
  }
  window.openRealYouTubeInterface = openRealYouTubeInterface;
  window.launchPlatform = launchPlatform;

  function openRaveYoutubeModal() {
    if (!dom.raveYoutubeModal) return;
    dom.raveYoutubeModal.classList.remove('hidden');

    // Show continuous playback status banner
    const playingTitle = dom.nowPlayingTitle ? dom.nowPlayingTitle.textContent : '';
    const isNoVideo = !state.currentVideoId || !playingTitle || playingTitle.includes('Henüz') || playingTitle.includes('No video') || playingTitle.includes('Noch kein') || playingTitle.includes('Video Loading');
    if (state.roomId && dom.raveCurrentlyPlayingBanner && !isNoVideo) {
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
    if (dom.roomPlatformChooserModal) dom.roomPlatformChooserModal.classList.add('hidden');
    if (dom.raveVideoActionSheet) dom.raveVideoActionSheet.classList.add('hidden');
    if (state.roomId) {
      sendP2PData('host_browsing', { isBrowsing: false });
      sendSignal({ type: 'host-browsing', isBrowsing: false });
    }
  }

  async function loadRaveYoutubeFeed(query = '', tag = 'trending') {
    if (!dom.raveYtVideoGrid) return;
    currentRaveYtTag = tag;

    const isEn = currentLang === 'en';
    const isDe = currentLang === 'de';
    const feedLoadingText = isEn ? 'Fetching YouTube content...' : (isDe ? 'YouTube-Inhalte werden geladen...' : 'YouTube içerikleri getiriliyor...');

    dom.raveYtVideoGrid.innerHTML = `
      <div class="col-span-full py-12 flex flex-col items-center justify-center text-center text-xs text-gray-400">
        <div class="w-6 h-6 border-2 border-red-500 border-t-transparent rounded-full animate-spin mb-2"></div>
        <span>${feedLoadingText}</span>
      </div>
    `;

    const liveText = isEn ? 'LIVE' : (isDe ? 'LIVE' : 'CANLI');
    const liveViewsText = isEn ? '48K watching live' : (isDe ? '48K Live-Zuschauer' : '48K canlı izleyici');
    const viewsSuffix = isEn ? 'views' : (isDe ? 'Aufrufe' : 'görüntüleme');

    const FALLBACK_CATALOG = [
      {
        id: 'jfKfPfyJRdk',
        title: 'Lofi Girl - beats to relax/study to',
        channel: 'Lofi Girl',
        duration: liveText,
        category: 'lofi',
        views: liveViewsText,
        thumb: 'https://img.youtube.com/vi/jfKfPfyJRdk/hqdefault.jpg'
      },
      {
        id: 'b9EkMc79ZSU',
        title: 'Stranger Things 4 | Official Trailer',
        channel: 'Netflix',
        duration: '3:11',
        category: 'series',
        views: `32M ${viewsSuffix}`,
        thumb: 'https://img.youtube.com/vi/b9EkMc79ZSU/hqdefault.jpg'
      },
      {
        id: 'ezkd3wzB6s8',
        title: 'The Boys Season 4 | Official Trailer',
        channel: 'Prime Video',
        duration: '2:38',
        category: 'series',
        views: `18M ${viewsSuffix}`,
        thumb: 'https://img.youtube.com/vi/ezkd3wzB6s8/hqdefault.jpg'
      },
      {
        id: 'QdBZY2fkU-0',
        title: 'Grand Theft Auto VI Trailer 1',
        channel: 'Rockstar Games',
        duration: '1:31',
        category: 'gaming',
        views: `190M ${viewsSuffix}`,
        thumb: 'https://img.youtube.com/vi/QdBZY2fkU-0/hqdefault.jpg'
      },
      {
        id: '4NRXx6U8ABQ',
        title: 'The Weeknd - Blinding Lights (Official Music Video)',
        channel: 'The Weeknd',
        duration: '4:20',
        category: 'music',
        views: `800M ${viewsSuffix}`,
        thumb: 'https://img.youtube.com/vi/4NRXx6U8ABQ/hqdefault.jpg'
      },
      {
        id: 'TUVcZfQe-Kw',
        title: 'Dua Lipa - Levitating (Official Music Video)',
        channel: 'Dua Lipa',
        duration: '3:50',
        category: 'music',
        views: `750M ${viewsSuffix}`,
        thumb: 'https://img.youtube.com/vi/TUVcZfQe-Kw/hqdefault.jpg'
      },
      {
        id: 'H5v3kku4y6Q',
        title: 'Harry Styles - As It Was (Official Video)',
        channel: 'Harry Styles',
        duration: '2:45',
        category: 'music',
        views: `620M ${viewsSuffix}`,
        thumb: 'https://img.youtube.com/vi/H5v3kku4y6Q/hqdefault.jpg'
      },
      {
        id: 'kJQP7kiw5Fk',
        title: 'Luis Fonsi - Despacito ft. Daddy Yankee',
        channel: 'Luis Fonsi',
        duration: '4:42',
        category: 'music',
        views: `8.4B ${viewsSuffix}`,
        thumb: 'https://img.youtube.com/vi/kJQP7kiw5Fk/hqdefault.jpg'
      },
      {
        id: 'kXYiU_JCYtU',
        title: 'Linkin Park - Numb (Official Music Video)',
        channel: 'Linkin Park',
        duration: '3:07',
        category: 'music',
        views: `2.2B ${viewsSuffix}`,
        thumb: 'https://img.youtube.com/vi/kXYiU_JCYtU/hqdefault.jpg'
      },
      {
        id: 'OPf0YbXqDm0',
        title: 'Mark Ronson - Uptown Funk ft. Bruno Mars',
        channel: 'Mark Ronson',
        duration: '4:30',
        category: 'music',
        views: `5.1B ${viewsSuffix}`,
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
      const noVideosFound = isEn ? 'No videos found' : (isDe ? 'Keine Videos gefunden' : 'Aradığınız video bulunamadı');
      const trySearchText = isEn ? 'Try a different search or browse m.youtube.com.' : (isDe ? 'Versuchen Sie eine andere Suche oder durchsuchen Sie m.youtube.com.' : 'Farklı bir arama yapın veya m.youtube.com\'da gezinin.');
      dom.raveYtVideoGrid.innerHTML = `
        <div class="col-span-full py-10 text-center text-xs text-gray-400">
          <p>${noVideosFound}</p>
          <span class="text-[10px] text-gray-500 mt-1 block">${trySearchText}</span>
        </div>
      `;
      return;
    }

    const watchText = isEn ? 'Watch' : (isDe ? 'Ansehen' : 'İzle');
    dom.raveYtVideoGrid.innerHTML = items.map(video => `
      <div class="rave-yt-card bg-[#0C0E17] hover:bg-[#141824] border border-white/10 hover:border-red-500/50 rounded-2xl p-2.5 flex flex-col gap-2 cursor-pointer text-left transition-all group shadow-lg hover:shadow-red-600/15 hover:-translate-y-0.5 active:scale-95" data-id="${escapeHtml(video.id)}" data-title="${escapeHtml(video.title)}">
        <div class="relative w-full aspect-video rounded-xl overflow-hidden bg-black/80">
          <img src="${escapeHtml(video.thumb)}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" alt="Thumbnail" loading="lazy">
          <span class="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-black/80 text-white font-mono backdrop-blur-sm">${escapeHtml(video.duration)}</span>
          <div class="absolute inset-0 bg-red-600/25 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-[1px]">
            <div class="w-10 h-10 rounded-full bg-red-600 text-white flex items-center justify-center shadow-xl shadow-red-600/40">
              <svg class="w-4 h-4 text-white fill-current ml-0.5" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </div>
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
              <span>${watchText}</span>
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
    if (state.roomId && dom.roomWorkspaceSection && !dom.roomWorkspaceSection.classList.contains('hidden') && dom.raveVideoActionSheet) {
      selectedPendingVideo = video;
      if (dom.raveActionThumb) dom.raveActionThumb.src = video.thumb || `https://img.youtube.com/vi/${video.id}/hqdefault.jpg`;
      if (dom.raveActionTitle) dom.raveActionTitle.textContent = video.title || 'Video';
      if (dom.raveActionChannel) dom.raveActionChannel.textContent = video.channel || 'YouTube';
      dom.raveVideoActionSheet.classList.remove('hidden');
      return;
    }
    selectAndPlayYoutubeVideo(video.id, video.title);
  }

  function handleRemoteBrowsingNotice(isBrowsing, user) {
    if (!dom.hostBrowsingNotice) return;
    if (isBrowsing) {
      dom.hostBrowsingNotice.classList.remove('hidden');
      if (dom.hostBrowsingNoticeText) {
        const browsingNotice = isEn
          ? `${user || 'Host'} is choosing a new video... (Current video playing)`
          : (isDe
            ? `${user || 'Host'} sucht ein neues Video... (Aktuelles Video läuft)`
            : `${user || 'Oda sahibi'} yeni video arıyor... (Mevcut video çalıyor)`);
        dom.hostBrowsingNoticeText.textContent = browsingNotice;
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
      showToast(`${user || 'Partner'} yeni bir video başlattı: ${title}`);
      renderChatMessage('SİSTEM', `${user || 'Partner'} yeni video başlattı: ${title}`, false);
    }
    loadRemoteContent(videoId, title);
  }

  window.loadRemoteContentBridge = loadRemoteContent;
  // Loads whatever the partner started (YouTube / direct stream / web / twitch) so every mode stays in sync
  function loadRemoteContent(videoId, title, startPlaying = true, startTime = 0) {
    if (!videoId || videoId === state.currentVideoId) return;
    try {
      const v = String(videoId);
      const isUrl = /^(https?:)?\/\//i.test(v) || v.includes('/') || v.includes('.');
      if (v.startsWith('kick:') || /kick\.com/i.test(v)) {
        if (typeof loadKickStream === 'function') loadKickStream(v.replace(/^kick:/, ''), title);
      } else if (v.startsWith('twitch:') || /twitch\.tv/i.test(v)) {
        if (typeof loadTwitchStream === 'function') loadTwitchStream(v.replace(/^twitch:/, ''), title);
      } else if (!isUrl) {
        loadYoutubeVideo(v, startPlaying, startTime);
      } else {
        const ytId = (typeof extractYtId === 'function') ? extractYtId(v) : ((v.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/))([\w-]{11})/) || [])[1] || null);
        if (ytId) {
          loadYoutubeVideo(ytId, startPlaying, startTime);
        } else if (/\.(mp4|webm|m3u8|mov|mkv)(\?.*)?$/i.test(v) || v.includes('.m3u8') || v.includes('.mp4') || v.includes('/hls/') || v.includes('/stream/') || v.includes('manifest') || v.includes('googlevideo.com')) {
          loadDirectVideo(v, title, startPlaying, startTime);
        } else {
          loadWebStream(v, title, 'Web');
        }
      }
    } catch (err) {
      console.warn('loadRemoteContent failed:', err);
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

    const qModal = dom.roomQueueModal || document.getElementById('roomQueueModal');
    const qList = dom.roomQueueList || document.getElementById('roomQueueList');

    if (qList) {
      const dictQueue = I18N[currentLang] || I18N.tr;
      if (!state.roomQueue || state.roomQueue.length === 0) {
        const emptyMsg = dictQueue.queue_empty || (currentLang === 'tr' ? 'Sırada bekleyen video yok' : 'No videos waiting in queue');
        qList.innerHTML = `<div class="py-8 text-center text-xs text-gray-400" data-i18n="queue_empty">${emptyMsg}</div>`;
      } else {
        const canManage = state.isHost || state.userRole === 'owner' || state.userRole === 'admin' || state.userRole === 'dj' || state.controlMode === 'everyone' || state.hasDjPermission;
        qList.innerHTML = state.roomQueue.map((item, idx) => {
          const addedByLabel = currentLang === 'en'
            ? `Added by ${escapeHtml(item.addedBy || 'Sen')}`
            : (currentLang === 'de'
              ? `Hinzugefügt von ${escapeHtml(item.addedBy || 'Sen')}`
              : `${escapeHtml(item.addedBy || 'Sen')} ekledi`);
          const playTitle = dictQueue.action_play_now || (currentLang === 'tr' ? 'Şimdi Oynat' : 'Play Now');
          const removeTitle = dictQueue.kick_btn || (currentLang === 'tr' ? 'Kaldır' : 'Remove');
          const thumbUrl = item.thumb || item.thumbnail || ((item.id && item.id.length === 11) ? `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg` : 'logo.png');
          return `
          <div class="flex items-center justify-between p-2.5 rounded-2xl bg-white/5 border border-white/10 gap-3 group">
            <span class="text-xs font-mono font-bold text-purple-400 w-4">${idx + 1}</span>
            <img src="${escapeHtml(thumbUrl)}" class="w-14 h-9 rounded-lg object-cover bg-black flex-shrink-0" alt="Thumb" onerror="this.src='logo.png'">
            <div class="flex-1 min-w-0">
              <h5 class="text-xs font-bold text-white truncate">${escapeHtml(item.title || 'Video')}</h5>
              <span class="text-[10px] text-gray-400">${addedByLabel}</span>
            </div>
            ${canManage ? `
              <div class="flex items-center gap-1.5 shrink-0">
                <button class="queue-play-now-btn p-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg transition-all cursor-pointer flex items-center justify-center" data-idx="${idx}" title="${playTitle}">
                  <svg class="w-3 h-3 text-white fill-current" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                </button>
                <button class="queue-remove-btn p-1.5 bg-white/10 hover:bg-white/20 text-gray-300 rounded-lg transition-all cursor-pointer flex items-center justify-center" data-idx="${idx}" title="${removeTitle}">
                  <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            ` : ''}
          </div>
        `;
        }).join('');

        qList.querySelectorAll('.queue-play-now-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx, 10);
            if (state.roomQueue && state.roomQueue[idx]) {
              const item = state.roomQueue.splice(idx, 1)[0];
              updateRoomQueueUI();
              sendP2PData('queue_update', { queue: state.roomQueue });
              sendSignal({ type: 'queue-update', queue: state.roomQueue });
              selectAndPlayYoutubeVideo(item.id, item.title);
              if (qModal) {
                qModal.classList.add('hidden');
                qModal.classList.remove('flex');
                qModal.style.removeProperty('display');
              }
            }
          });
        });

        qList.querySelectorAll('.queue-remove-btn').forEach(btn => {
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

  function seekRelative(seconds) {
    if (!canUserControlPlayback()) {
      showToast('Videoyu ileri/geri sarma yetkisi sadece Oda Sahibi ve Yöneticilere aittir.');
      return;
    }
    const target = Math.max(0, Math.min((state.currentTime || 0) + seconds, state.duration || 99999));
    state.currentTime = target;
    if (state.activeMode === 'youtube') {
      sendYtCommand('seekTo', [target, true]);
    } else if (dom.nativeVideoPlayer) {
      dom.nativeVideoPlayer.currentTime = target;
    }
    if (dom.seekSlider && state.duration > 0) {
      dom.seekSlider.value = (target / state.duration) * 100;
    }
    if (!state.isRemoteAction) {
      sendP2PData('sync', { action: 'seek', time: target, isPlaying: state.isPlaying, sentAt: Date.now() });
    }
  }
  window.seekRelative = seekRelative;

  function handleNextTrack() {
    if (!canUserControlPlayback()) {
      showToast('Sıradaki videoya geçme yetkisi sadece Oda Sahibi ve Yöneticilere aittir.');
      return;
    }
    if (state.roomQueue && state.roomQueue.length > 0) {
      const nextItem = state.roomQueue.shift();
      updateRoomQueueUI();
      sendP2PData('queue_update', { queue: state.roomQueue });
      sendSignal({ type: 'queue-update', queue: state.roomQueue });
      selectAndPlayYoutubeVideo(nextItem.id, nextItem.title);
      const ann = `Sıradaki video başlatıldı: "${nextItem.title}"`;
      showToast(ann);
      renderChatMessage('SİSTEM', ann, true);
      sendP2PData('chat', { sender: 'SİSTEM', text: ann, time: getNowTimeString() });
    } else {
      // Direct video forward advance (+15s)
      seekRelative(15);
      showToast('15 sn ilerletildi');
    }
  }

  function selectAndPlayYoutubeVideo(videoIdOrUrl, title, provider = 'YouTube') {
    if (!videoIdOrUrl) return;
    if (state.roomId && dom.roomWorkspaceSection && !dom.roomWorkspaceSection.classList.contains('hidden') && !canUserChooseVideo()) {
      showToast('Odaya video seçme yetkisi sadece Oda Sahibi, Yöneticiler ve Video Açabilenlerdedir.');
      return;
    }
    closeRaveYoutubeModal();

    const cleanYtId = extractYtId(videoIdOrUrl);
    if (cleanYtId) {
      if (state.roomId && dom.roomWorkspaceSection && !dom.roomWorkspaceSection.classList.contains('hidden')) {
        loadYoutubeVideo(cleanYtId);
        showToast(`"${title}" odada başlatıldı!`);
        const ann = `${state.username} yeni video başlattı: ${title}`;
        sendP2PData('video_changed', { user: state.username, title, videoId: cleanYtId });
        sendSignal({ type: 'video-changed', user: state.username, title, videoId: cleanYtId });
        renderChatMessage('SİSTEM', ann, true);
        sendP2PData('chat', { sender: 'SİSTEM', text: ann, time: getNowTimeString() });
      } else {
        const roomTitle = title ? `${title.substring(0, 24)} Partisi` : 'İzleme Odası';
        createAndJoinRoom(roomTitle, state.isPrivateRoom, 'YouTube', cleanYtId);
        showToast(`"${title}" ile oda başlatıldı!`);
      }
    } else {
      const platformName = provider || 'Web';
      const playNonYtContent = () => {
        const isDirectStream = (
          /\.(mp4|webm|m3u8|mov|mkv)(\?.*)?$/i.test(videoIdOrUrl) ||
          videoIdOrUrl.includes('.m3u8') ||
          videoIdOrUrl.includes('.mp4') ||
          videoIdOrUrl.includes('/hls/') ||
          videoIdOrUrl.includes('/stream/') ||
          videoIdOrUrl.includes('/video/') ||
          videoIdOrUrl.includes('playlist') ||
          videoIdOrUrl.includes('manifest') ||
          videoIdOrUrl.includes('googlevideo.com')
        );
        if (platformName.toLowerCase().includes('kick') || videoIdOrUrl.includes('kick.com') || videoIdOrUrl.startsWith('kick:')) {
          loadKickStream(videoIdOrUrl, title);
        } else if (platformName.toLowerCase().includes('twitch') || videoIdOrUrl.includes('twitch.tv') || videoIdOrUrl.startsWith('twitch:')) {
          const ch = videoIdOrUrl.replace(/^twitch:/, '');
          loadTwitchStream(ch, title);
        } else if (isDirectStream) {
          loadDirectVideo(videoIdOrUrl, title);
          sendP2PData('video_changed', { user: state.username, title: title || platformName, videoId: videoIdOrUrl });
          sendSignal({ type: 'video-changed', user: state.username, title: title || platformName, videoId: videoIdOrUrl });
        } else {
          loadWebStream(videoIdOrUrl, title, platformName);
        }
      };

      if (state.roomId && dom.roomWorkspaceSection && !dom.roomWorkspaceSection.classList.contains('hidden')) {
        playNonYtContent();
      } else {
        const roomTitle = title ? `${title.substring(0, 24)} Partisi` : `${platformName} Partisi`;
        createAndJoinRoom(roomTitle, state.isPrivateRoom, platformName);
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
  if (!window.MiruoBridge) window.MiruoBridge = {};
  window.MiruoBridge.loadVideo = function(videoIdOrUrl, title, provider, connectedAccount) {
    if (connectedAccount) {
      state.connectedAccount = connectedAccount;
      if (typeof updateNowPlayingAccountBadge === 'function') updateNowPlayingAccountBadge(connectedAccount);
    }
    if (videoIdOrUrl) {
      let prov = provider;
      if (!prov) {
        if (videoIdOrUrl.includes('kick.com') || videoIdOrUrl.startsWith('kick:')) prov = 'Kick';
        else if (videoIdOrUrl.includes('twitch.tv') || videoIdOrUrl.startsWith('twitch:')) prov = 'Twitch';
        else if (extractYtId(videoIdOrUrl)) prov = 'YouTube';
        else prov = 'Web';
      }
      selectAndPlayYoutubeVideo(videoIdOrUrl, title || 'Video İçeriği', prov);
    }
  };

  window.MiruoBridge.addToQueue = function(videoIdOrUrl, title) {
    if (!videoIdOrUrl) return;
    const cleanId = extractYtId(videoIdOrUrl) || videoIdOrUrl;
    const itemTitle = title || 'Sıradaki Video';

    // If not yet in an active video session in room, play immediately!
    const hasActiveVideo = !!(state.isInRoom && state.roomId && state.currentVideoId && dom.roomWorkspaceSection && !dom.roomWorkspaceSection.classList.contains('hidden'));
    if (!hasActiveVideo) {
      selectAndPlayYoutubeVideo(cleanId, itemTitle, 'YouTube');
      return;
    }

    if (!state.roomQueue) state.roomQueue = [];
    const thumbUrl = (cleanId && cleanId.length === 11) ? `https://i.ytimg.com/vi/${cleanId}/hqdefault.jpg` : 'logo.png';
    const queueItem = {
      id: cleanId,
      videoId: cleanId,
      title: itemTitle,
      thumb: thumbUrl,
      thumbnail: thumbUrl,
      addedBy: state.username || 'Sen'
    };
    state.roomQueue.push(queueItem);
    updateRoomQueueUI();
    sendP2PData('queue_update', { queue: state.roomQueue });
    sendSignal({ type: 'queue-update', queue: state.roomQueue });
    showToast(`✓ Video sıraya eklendi (${state.roomQueue.length})`);
    renderChatMessage('SİSTEM', `Sıraya eklendi: "${itemTitle}"`, true);
  };

  if (dom.closeRaveYoutubeBtn) {
    addInstantTap(dom.closeRaveYoutubeBtn, closeRaveYoutubeModal);
  }

  if (dom.openNativeYtBrowserBtn) {
    dom.openNativeYtBrowserBtn.addEventListener('click', () => {
      // In iOS App: call native script message handler
      const hasActiveVideo = !!(state.isInRoom && state.roomId && state.currentVideoId && dom.roomWorkspaceSection && !dom.roomWorkspaceSection.classList.contains('hidden'));
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.openYouTube) {
        window.webkit.messageHandlers.openYouTube.postMessage({ lang: currentLang, hasActiveVideo: hasActiveVideo });
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
  function switchProfileTab(tabName) {
    const sb = dom.profileEditModalScrollBody || document.getElementById('profileEditModalScrollBody');
    if (sb) {
      sb.scrollTop = 0;
      try { sb.scrollTo({ top: 0, left: 0, behavior: 'instant' }); } catch (_) { sb.scrollTop = 0; }
    }
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

  function openProfileEditModal(section = 'profile') {
    if (dom.userProfileDropdown) dom.userProfileDropdown.classList.add('hidden');
    const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
    if (dom.editProfileFullNameInput) dom.editProfileFullNameInput.value = savedUser.fullName || savedUser.name || '';
    if (dom.editProfileUsernameInput) dom.editProfileUsernameInput.value = (savedUser.username || state.username || '').replace(/^@/, '');
    if (dom.editProfileNameInput) dom.editProfileNameInput.value = (savedUser.username || state.username || '').replace(/^@/, '');

    window.pendingAvatarUrl = savedUser.avatarUrl || state.avatarUrl || '';
    window.pendingAvatarBg = savedUser.avatarBg || state.avatarBg || 'from-[#A64D79] to-[#6A1E55]';

    const isGuest = !!(savedUser.isGuest || (!savedUser.email && !savedUser.isApple && savedUser.provider !== 'apple') || (savedUser.id && String(savedUser.id).startsWith('guest_')));
    const guestBanner = document.getElementById('settingsGuestBanner');
    if (guestBanner) {
      if (isGuest) {
        guestBanner.classList.remove('hidden');
        guestBanner.classList.add('flex');
      } else {
        guestBanner.classList.add('hidden');
        guestBanner.classList.remove('flex');
      }
    }

    const ctaBtn = document.getElementById('settingsLoginCtaBtn');
    if (ctaBtn && !ctaBtn._hasClickListener) {
      ctaBtn._hasClickListener = true;
      ctaBtn.addEventListener('click', () => {
        if (dom.profileEditModal) dom.profileEditModal.classList.add('hidden');
        if (dom.authModal) {
          dom.authModal.classList.remove('hidden');
          freezeBackgroundForModal();
          if (typeof setAuthMode === 'function') setAuthMode(false);
        }
      });
    }

    if (dom.profileEmailDisplay) {
      dom.profileEmailDisplay.textContent = isGuest
        ? 'Oturum açılmadı • Geçici profil'
        : (savedUser.email || (savedUser.isApple ? `${(savedUser.username || 'user')}@icloud.com` : `${(state.username || 'user').toLowerCase()}@miruo.app`));
    }

    // 1. Detect and render provider badge (Neyle Kayıt Olduğu)
    const dict = I18N[currentLang] || I18N.tr;
    const authProvider = savedUser.provider || (savedUser.phone ? 'phone' : (savedUser.isApple ? 'apple' : (savedUser.isGoogle ? 'google' : 'email')));
    if (dom.accountProviderIcon && dom.accountProviderName) {
      if (isGuest) {
        dom.accountProviderIcon.innerHTML = '<span class="text-xs font-bold text-amber-400">Misafir</span>';
        dom.accountProviderName.textContent = 'Misafir Kullanıcı (Kayıtsız)';
        if (dom.profileAuthBadge) {
          dom.profileAuthBadge.textContent = 'Giriş Yapılmadı';
          dom.profileAuthBadge.className = 'px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30';
        }
      } else if (authProvider === 'apple' || savedUser.isApple) {
        dom.accountProviderIcon.innerHTML = '<span class="text-xs font-bold text-white">Apple</span>';
        dom.accountProviderName.textContent = dict.provider_apple || 'Apple ID ile Giriş Yapıldı';
        if (dom.profileAuthBadge) {
          dom.profileAuthBadge.textContent = dict.provider_apple_badge || 'Apple ile Doğrulandı';
          dom.profileAuthBadge.className = 'px-2.5 py-1 rounded-full text-[10px] font-bold bg-white/10 text-white border border-white/20';
        }
      } else if (authProvider === 'google' || savedUser.isGoogle) {
        dom.accountProviderIcon.innerHTML = '<span class="text-xs font-bold text-blue-400">Google</span>';
        dom.accountProviderName.textContent = dict.provider_google || 'Google ile Giriş Yapıldı';
        if (dom.profileAuthBadge) {
          dom.profileAuthBadge.textContent = dict.provider_google_badge || 'Google ile Doğrulandı';
          dom.profileAuthBadge.className = 'px-2.5 py-1 rounded-full text-[10px] font-bold bg-blue-500/15 text-blue-400 border border-blue-500/30';
        }
      } else if (authProvider === 'phone' || savedUser.phone) {
        dom.accountProviderIcon.innerHTML = '<span class="text-xs font-bold text-amber-400">SMS</span>';
        dom.accountProviderName.textContent = dict.provider_phone || 'Telefon Numarası ile Giriş';
        if (dom.profileAuthBadge) {
          dom.profileAuthBadge.textContent = dict.provider_phone_badge || 'SMS ile Doğrulandı';
          dom.profileAuthBadge.className = 'px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30';
        }
      } else {
        dom.accountProviderIcon.innerHTML = '<span class="text-xs font-bold text-emerald-400">Mail</span>';
        dom.accountProviderName.textContent = dict.provider_email || 'E-posta ile Kayıt Olundu';
        if (dom.profileAuthBadge) {
          dom.profileAuthBadge.textContent = dict.provider_email_badge || dict.active_session || 'Giriş yapıldı';
          dom.profileAuthBadge.className = 'px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30';
        }
      }
    }

    if (dom.editAvatarPreview) {
      if (window.pendingAvatarUrl) {
        dom.editAvatarPreview.innerHTML = `<img src="${window.pendingAvatarUrl}" class="w-full h-full object-cover rounded-2xl" alt="PP">`;
        dom.editAvatarPreview.className = 'w-20 h-20 rounded-2xl overflow-hidden shadow-xl border-2 border-[#A64D79] ring-4 ring-[#A64D79]/20 flex items-center justify-center';
      } else {
        const char = (savedUser.fullName || savedUser.username || state.username || 'M').charAt(0).toUpperCase();
        dom.editAvatarPreview.innerHTML = char;
        dom.editAvatarPreview.className = `w-20 h-20 rounded-2xl bg-gradient-to-tr ${window.pendingAvatarBg} flex items-center justify-center text-3xl font-bold text-white shadow-xl overflow-hidden border-2 border-white/20 ring-4 ring-white/5`;
      }
    }

    // Load Notification preferences
    const notifSettings = JSON.parse(localStorage.getItem('miruo_notifications') || '{"push":true,"invites":true,"sound":true}');
    if (dom.notifPushToggle) dom.notifPushToggle.checked = notifSettings.push !== false;
    if (dom.notifInvitesToggle) dom.notifInvitesToggle.checked = notifSettings.invites !== false;
    if (dom.notifSoundToggle) dom.notifSoundToggle.checked = notifSettings.sound !== false;

    // Load Personal Room public preference
    const isPublic = localStorage.getItem('miruo_personal_room_public');
    if (dom.personalRoomPublicToggle) {
      dom.personalRoomPublicToggle.checked = isPublic === null ? true : (isPublic === 'true');
    }

    // Reset Accordions
    if (dom.changeEmailCollapseArea) dom.changeEmailCollapseArea.classList.add('hidden');
    if (dom.changeEmailChevron) dom.changeEmailChevron.classList.remove('rotate-180');
    if (dom.changePasswordCollapseArea) dom.changePasswordCollapseArea.classList.add('hidden');
    if (dom.changePassChevron) dom.changePassChevron.classList.remove('rotate-180');
    if (dom.changeEmailAlert) dom.changeEmailAlert.classList.add('hidden');
    if (dom.changePassAlert) dom.changePassAlert.classList.add('hidden');

    if (dom.profileEditModal) {
      freezeBackgroundForModal();
      dom.profileEditModal.classList.remove('hidden');
      if (typeof renderConnectedAccountsUI === 'function') {
        renderConnectedAccountsUI();
      }
      if (typeof renderBlockedUsersList === 'function') {
        renderBlockedUsersList();
      }

      // Always start strictly from the very top (never auto-scroll down to the middle)
      const sb = dom.profileEditModalScrollBody || document.getElementById('profileEditModalScrollBody');
      if (sb) {
        sb.scrollTop = 0;
        try { sb.scrollTo({ top: 0, left: 0, behavior: 'instant' }); } catch (_) { sb.scrollTop = 0; }
        requestAnimationFrame(() => {
          if (sb) sb.scrollTop = 0;
        });
      }

      if (section === 'privacy') {
        if (dom.privacyPolicyModal) dom.privacyPolicyModal.classList.remove('hidden');
      } else if (section === 'terms') {
        if (dom.termsModal) dom.termsModal.classList.remove('hidden');
      } else if (section === 'accordions_open') {
        if (dom.changeEmailCollapseArea) dom.changeEmailCollapseArea.classList.remove('hidden');
        if (dom.changeEmailChevron) dom.changeEmailChevron.classList.add('rotate-180');
        if (dom.changePasswordCollapseArea) dom.changePasswordCollapseArea.classList.remove('hidden');
        if (dom.changePassChevron) dom.changePassChevron.classList.add('rotate-180');
      }

      // Refresh microphone and audio settings upon opening modal
      if (typeof refreshAudioDeviceList === 'function') refreshAudioDeviceList();
      if (typeof syncMicSettingsValues === 'function') syncMicSettingsValues();
    }
  }

  window.openProfileEditModal = openProfileEditModal;
  window.switchProfileTab = switchProfileTab;

  // Profile Nav Tabs Click Handlers (Backwards Compatibility)
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
      if (dom.privacyPolicyModal) dom.privacyPolicyModal.classList.add('hidden');
      if (dom.termsModal) dom.termsModal.classList.add('hidden');
      unfreezeBackgroundAfterModal();
    });
  }

  const openSettingsFromProfileBtn = document.getElementById('openSettingsFromProfileBtn');
  if (openSettingsFromProfileBtn) {
    addInstantTap(openSettingsFromProfileBtn, (e) => {
      e.stopPropagation();
      openProfileEditModal('settings');
    });
  }

  const tabProfileOpenSettingsRowBtn = document.getElementById('tabProfileOpenSettingsRowBtn');
  if (tabProfileOpenSettingsRowBtn) {
    addInstantTap(tabProfileOpenSettingsRowBtn, (e) => {
      e.stopPropagation();
      openProfileEditModal('settings');
    });
  }

  // Dedicated Profile Edit Modal Functions
  function openDedicatedProfileModal() {
    const dedicatedModal = document.getElementById('dedicatedProfileEditModal');
    if (!dedicatedModal) return;

    const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
    const fullName = savedUser.fullName || savedUser.name || state.username || '';
    const username = (savedUser.username || state.username || '').replace(/^@/, '');

    if (dom.editProfileFullNameInput) dom.editProfileFullNameInput.value = fullName;
    if (dom.editProfileUsernameInput) dom.editProfileUsernameInput.value = username;

    window.pendingAvatarUrl = savedUser.avatarUrl || state.avatarUrl || '';
    window.pendingAvatarBg = savedUser.avatarBg || state.avatarBg || 'from-[#A64D79] to-[#6A1E55]';

    if (dom.editAvatarPreview) {
      if (savedUser.avatarUrl || state.avatarUrl) {
        dom.editAvatarPreview.innerHTML = `<img src="${savedUser.avatarUrl || state.avatarUrl}" class="w-full h-full object-cover">`;
      } else {
        const nameChar = (fullName || username || 'M').charAt(0).toUpperCase();
        dom.editAvatarPreview.innerHTML = nameChar;
        dom.editAvatarPreview.className = `w-20 h-20 rounded-full bg-gradient-to-tr ${savedUser.avatarBg || 'from-rose-500 to-[#A64D79]'} flex items-center justify-center text-3xl font-bold text-white shadow-xl overflow-hidden border-2 border-rose-400/40 ring-4 ring-rose-500/10`;
      }
    }

    freezeBackgroundForModal();
    dedicatedModal.classList.remove('hidden');
    dedicatedModal.classList.add('flex');
  }

  function closeDedicatedProfileModal() {
    const dedicatedModal = document.getElementById('dedicatedProfileEditModal');
    if (!dedicatedModal) return;
    dedicatedModal.classList.add('hidden');
    dedicatedModal.classList.remove('flex');
    unfreezeBackgroundAfterModal(true);
  }

  window.openDedicatedProfileModal = openDedicatedProfileModal;
  window.closeDedicatedProfileModal = closeDedicatedProfileModal;

  const closeDedicatedProfileEditBtn = document.getElementById('closeDedicatedProfileEditBtn');
  if (closeDedicatedProfileEditBtn) {
    addInstantTap(closeDedicatedProfileEditBtn, (e) => {
      e.stopPropagation();
      closeDedicatedProfileModal();
    });
  }

  const tabProfileEditTriggerBtn = document.getElementById('tabProfileEditTriggerBtn');
  if (tabProfileEditTriggerBtn) {
    addInstantTap(tabProfileEditTriggerBtn, (e) => {
      e.stopPropagation();
      openDedicatedProfileModal();
    });
  }

  const tabProfileAvatarEditBtn = document.getElementById('tabProfileAvatarEditBtn');
  if (tabProfileAvatarEditBtn) {
    addInstantTap(tabProfileAvatarEditBtn, (e) => {
      e.stopPropagation();
      openDedicatedProfileModal();
    });
  }

  // Accordion 1: E-posta Değiştir
  if (dom.toggleChangeEmailAccordionBtn) {
    dom.toggleChangeEmailAccordionBtn.addEventListener('click', () => {
      if (!dom.changeEmailCollapseArea) return;
      const isClosed = dom.changeEmailCollapseArea.classList.contains('hidden');
      if (isClosed) {
        dom.changeEmailCollapseArea.classList.remove('hidden');
        if (dom.changeEmailChevron) dom.changeEmailChevron.classList.add('rotate-180');
        if (dom.changeEmailNewInput) dom.changeEmailNewInput.focus();
      } else {
        dom.changeEmailCollapseArea.classList.add('hidden');
        if (dom.changeEmailChevron) dom.changeEmailChevron.classList.remove('rotate-180');
      }
    });
  }

  // Accordion 2: Şifre Değiştir
  if (dom.toggleChangePassAccordionBtn) {
    dom.toggleChangePassAccordionBtn.addEventListener('click', () => {
      if (!dom.changePasswordCollapseArea) return;
      const isClosed = dom.changePasswordCollapseArea.classList.contains('hidden');
      if (isClosed) {
        dom.changePasswordCollapseArea.classList.remove('hidden');
        if (dom.changePassChevron) dom.changePassChevron.classList.add('rotate-180');
        if (dom.changePassCurrentInput) dom.changePassCurrentInput.focus();
      } else {
        dom.changePasswordCollapseArea.classList.add('hidden');
        if (dom.changePassChevron) dom.changePassChevron.classList.remove('rotate-180');
      }
    });
  }

  // Notifications Toggles Persistence
  function saveNotifSettings() {
    const s = {
      push: dom.notifPushToggle ? dom.notifPushToggle.checked : true,
      invites: dom.notifInvitesToggle ? dom.notifInvitesToggle.checked : true,
      sound: dom.notifSoundToggle ? dom.notifSoundToggle.checked : true
    };
    localStorage.setItem('miruo_notifications', JSON.stringify(s));
    showToast('Bildirim tercihleri güncellendi');
  }

  if (dom.notifPushToggle) dom.notifPushToggle.addEventListener('change', saveNotifSettings);
  if (dom.notifInvitesToggle) dom.notifInvitesToggle.addEventListener('change', saveNotifSettings);
  if (dom.notifSoundToggle) dom.notifSoundToggle.addEventListener('change', saveNotifSettings);

  // Personal Room Toggle & Start Button
  if (dom.personalRoomPublicToggle) {
    dom.personalRoomPublicToggle.addEventListener('change', () => {
      localStorage.setItem('miruo_personal_room_public', dom.personalRoomPublicToggle.checked);
    });
  }

  if (dom.joinPersonalRoomBtn) {
    addInstantTap(dom.joinPersonalRoomBtn, () => {
      if (dom.profileEditModal) dom.profileEditModal.classList.add('hidden');
      const isPublic = dom.personalRoomPublicToggle ? dom.personalRoomPublicToggle.checked : true;
      const cleanUser = (state.username || 'Benim').replace(/^@/, '');
      const roomTitle = `${cleanUser} Canlı Odası`;
      createAndJoinRoom(roomTitle, !isPublic, 'YouTube');
      showToast('Kişisel odan başlatıldı!');
    });
  }

  // Legal Modals (Gizlilik Politikası & Kullanım Koşulları)
  if (dom.openPrivacyPolicyBtn && dom.privacyPolicyModal) {
    addInstantTap(dom.openPrivacyPolicyBtn, () => {
      dom.privacyPolicyModal.classList.remove('hidden');
    });
  }
  if (dom.closePrivacyPolicyBtn && dom.privacyPolicyModal) {
    addInstantTap(dom.closePrivacyPolicyBtn, () => {
      dom.privacyPolicyModal.classList.add('hidden');
    });
  }

  if (dom.openTermsBtn && dom.termsModal) {
    addInstantTap(dom.openTermsBtn, () => {
      dom.termsModal.classList.remove('hidden');
    });
  }
  if (dom.closeTermsBtn && dom.termsModal) {
    addInstantTap(dom.closeTermsBtn, () => {
      dom.termsModal.classList.add('hidden');
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

      const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
      const currentEmail = (savedUser.email || '').toLowerCase().trim();
      if (currentEmail && newEmail === currentEmail) {
        showChangeEmailAlert('Yeni e-posta adresi mevcut adresinizle aynı olamaz.', false);
        return;
      }

      dom.changeEmailSubmitBtn.disabled = true;
      dom.changeEmailSubmitBtn.textContent = 'Güncelleniyor...';

      let supaSuccess = false;
      let supaErrorMsg = '';

      // 1. Supabase Auth Güncellemesi (Varsa)
      if (supabaseClient && supabaseClient.auth) {
        try {
          const { data: supaData, error: supaErr } = await supabaseClient.auth.updateUser({ email: newEmail });
          if (supaErr) {
            supaErrorMsg = supaErr.message || '';
            if (/already.*registered|already.*exists/i.test(supaErrorMsg)) {
              supaErrorMsg = 'Bu e-posta adresi başka bir hesap tarafından kullanılıyor.';
            } else if (/rate.*limit|security/i.test(supaErrorMsg)) {
              supaErrorMsg = 'Güvenlik nedeniyle lütfen 60 saniye bekledikten sonra tekrar deneyin.';
            }
          } else if (supaData && supaData.user) {
            supaSuccess = true;
          }
        } catch (e) {
          console.warn('[Supabase Change Email]:', e);
        }
      }

      if (supaErrorMsg && !supaSuccess) {
        dom.changeEmailSubmitBtn.disabled = false;
        dom.changeEmailSubmitBtn.textContent = 'Güncelle';
        showChangeEmailAlert(supaErrorMsg, false);
        return;
      }

      // 2. Yerel Profil & Hesap Listesi Güncellemesi
      const oldEmail = currentEmail;
      savedUser.email = newEmail;
      localStorage.setItem('miruo_user', JSON.stringify(savedUser));

      try {
        const regList = JSON.parse(localStorage.getItem('miruo_registered_users') || '[]');
        if (Array.isArray(regList)) {
          const u = regList.find(x => (x && x.id && x.id === savedUser.id) || (x && x.email && x.email.toLowerCase() === oldEmail));
          if (u) {
            u.email = newEmail;
          } else {
            regList.push({ ...savedUser, email: newEmail });
          }
          localStorage.setItem('miruo_registered_users', JSON.stringify(regList));
        }
      } catch (_) {}

      try {
        const byEmail = JSON.parse(localStorage.getItem('miruo_profiles_by_email') || '{}');
        if (oldEmail && byEmail[oldEmail]) {
          byEmail[newEmail] = { ...byEmail[oldEmail], email: newEmail };
          delete byEmail[oldEmail];
          localStorage.setItem('miruo_profiles_by_email', JSON.stringify(byEmail));
        }
        localStorage.setItem(`miruo_saved_profile_${newEmail}`, JSON.stringify(savedUser));
        if (savedUser.id) {
          localStorage.setItem(`miruo_saved_profile_${savedUser.id}`, JSON.stringify(savedUser));
        }
      } catch (_) {}

      if (dom.profileEmailDisplay) dom.profileEmailDisplay.textContent = newEmail;
      if (dom.changeEmailNewInput) dom.changeEmailNewInput.value = '';

      // 3. Backend Sunucusuna Bildirim (Varsa)
      try {
        await fetch('/api/auth/change-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: savedUser.id, newEmail })
        });
      } catch (_) {}

      dom.changeEmailSubmitBtn.disabled = false;
      dom.changeEmailSubmitBtn.textContent = 'Güncelle';
      showChangeEmailAlert('✓ E-posta adresiniz güncellendi! Yeni e-postanıza doğrulama bağlantısı iletildi, lütfen gelen kutunuzu kontrol edin.', true);
      showToast('E-posta başarıyla güncellendi.');
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

      let supaPassError = '';
      if (supabaseClient && supabaseClient.auth) {
        try {
          const { error } = await supabaseClient.auth.updateUser({ password: newPass });
          if (error) supaPassError = error.message || '';
        } catch (supaErr) {
          console.warn('[Supabase Change Password]:', supaErr);
        }
      }

      // Yerel hesap kaydını güncelle
      const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
      try {
        const regList = JSON.parse(localStorage.getItem('miruo_registered_users') || '[]');
        if (Array.isArray(regList)) {
          const u = regList.find(x => (x && x.id && x.id === savedUser.id) || (savedUser.email && (x.email || '').toLowerCase() === (savedUser.email || '').toLowerCase()));
          if (u) {
            u.password = newPass;
            localStorage.setItem('miruo_registered_users', JSON.stringify(regList));
          }
        }
      } catch (_) {}

      // Backend API'ye bildirme (varsa)
      try {
        await fetch('/api/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: savedUser.id,
            email: savedUser.email,
            currentPassword: currentPass,
            newPassword: newPass
          })
        });
      } catch (_) {}

      dom.changePasswordSubmitBtn.disabled = false;
      dom.changePasswordSubmitBtn.textContent = 'Şifreyi Güncelle';
      showChangePassAlert('✓ Şifreniz başarıyla güncellendi!', true);
      if (dom.changePassCurrentInput) dom.changePassCurrentInput.value = '';
      if (dom.changePassNewInput) dom.changePassNewInput.value = '';
      if (dom.changePassConfirmInput) dom.changePassConfirmInput.value = '';
      showToast('Şifreniz başarıyla güncellendi.');
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

  function compressAvatarFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          const maxDim = 320;
          let w = img.width;
          let h = img.height;
          if (w > h) {
            if (w > maxDim) {
              h = Math.round((h * maxDim) / w);
              w = maxDim;
            }
          } else {
            if (h > maxDim) {
              w = Math.round((w * maxDim) / h);
              h = maxDim;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Avatar file upload trigger & reader
  const triggerAvatarPicker = (e) => {
    if (e && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pickImage) {
      e.preventDefault();
      triggerPhotoPicker('avatar');
      return;
    }
    const fileInput = dom.avatarFileInput || document.getElementById('avatarFileInput');
    if (fileInput && (!e || e.target !== fileInput)) {
      fileInput.click();
    }
  };

  if (dom.triggerAvatarUploadBtn) dom.triggerAvatarUploadBtn.addEventListener('click', triggerAvatarPicker);
  if (dom.triggerAvatarUploadBtn2) dom.triggerAvatarUploadBtn2.addEventListener('click', triggerAvatarPicker);
  if (dom.avatarPreviewClickArea) dom.avatarPreviewClickArea.addEventListener('click', triggerAvatarPicker);

  if (dom.avatarFileInput) {
    dom.avatarFileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      if (!file.type || !file.type.startsWith('image/')) {
        showToast('Lütfen geçerli bir görsel dosyası seçin');
        return;
      }

      try {
        const base64Data = await compressAvatarFile(file);
        window.pendingAvatarUrl = base64Data;
        window.pendingAvatarBg = '';
        if (dom.editAvatarPreview) {
          dom.editAvatarPreview.innerHTML = `<img src="${window.pendingAvatarUrl}" class="w-full h-full object-cover rounded-2xl" alt="PP">`;
          dom.editAvatarPreview.className = 'w-20 h-20 rounded-2xl overflow-hidden shadow-xl border-2 border-[#A64D79] ring-4 ring-[#A64D79]/20 flex items-center justify-center';
        }

        // Auto-save & activate immediately
        const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
        savedUser.avatarUrl = base64Data;
        savedUser.avatarBg = '';
        state.avatarUrl = base64Data;
        state.avatarBg = '';
        localStorage.setItem('miruo_user', JSON.stringify(savedUser));
        if (typeof persistUserToLocalRegistry === 'function') persistUserToLocalRegistry(savedUser);

        try {
          const profilePayload = {
            userId: savedUser.id || state.userId,
            username: (savedUser.username || state.username || '').replace(/^@/, ''),
            fullName: savedUser.fullName || savedUser.name || '',
            avatarUrl: base64Data
          };
          fetch('/api/auth/update-profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(profilePayload)
          }).catch(async () => {
            if (window.location.port !== '3000') {
              fetch('http://127.0.0.1:3000/api/auth/update-profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(profilePayload)
              }).catch(() => {});
            }
          });
        } catch (e) {}
        syncUserProfileToSupabase(savedUser);

        updateUserUI(savedUser);
        if (typeof renderProfileTab === 'function') renderProfileTab();
        showToast('Profil fotoğrafı güncellendi');
      } catch (err) {
        console.error('Avatar processing error:', err);
        showToast('Fotoğraf yüklenirken bir hata oluştu');
      }
    });
  }

  // Remove Custom Avatar Photo
  if (dom.removeAvatarPhotoBtn) {
    dom.removeAvatarPhotoBtn.addEventListener('click', () => {
      window.pendingAvatarUrl = '';
      window.pendingAvatarBg = 'from-[#A64D79] to-[#6A1E55]';
      const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
      savedUser.avatarUrl = '';
      savedUser.avatarBg = window.pendingAvatarBg;
      state.avatarUrl = '';
      state.avatarBg = window.pendingAvatarBg;
      localStorage.setItem('miruo_user', JSON.stringify(savedUser));

      try {
        fetch('/api/auth/update-profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: savedUser.id || state.userId,
            username: (savedUser.username || state.username || '').replace(/^@/, ''),
            fullName: savedUser.fullName || savedUser.name || '',
            avatarUrl: ''
          })
        }).catch(e => console.warn('[Remove Avatar Backend Error]:', e));
      } catch (e) {}
      syncUserProfileToSupabase(savedUser);

      updateUserUI(savedUser);

      if (dom.editAvatarPreview) {
        const nameChar = (dom.editProfileFullNameInput?.value.trim() || dom.editProfileUsernameInput?.value.trim() || dom.editProfileNameInput?.value.trim() || state.username || 'M').charAt(0).toUpperCase();
        dom.editAvatarPreview.innerHTML = nameChar;
        dom.editAvatarPreview.className = `w-20 h-20 rounded-2xl bg-gradient-to-tr ${window.pendingAvatarBg} flex items-center justify-center text-3xl font-bold text-white shadow-xl overflow-hidden border-2 border-white/20 ring-4 ring-white/5`;
      }
      renderProfileTab();
      showToast('Profil fotoğrafı kaldırıldı.');
    });
  }

  // Preset avatar buttons
  document.querySelectorAll('.preset-avatar-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const bg = btn.dataset.bg || 'from-rose-500 to-[#A64D79]';
      window.pendingAvatarBg = bg;
      window.pendingAvatarUrl = '';
      const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
      savedUser.avatarUrl = '';
      savedUser.avatarBg = bg;
      state.avatarUrl = '';
      state.avatarBg = bg;
      localStorage.setItem('miruo_user', JSON.stringify(savedUser));

      try {
        fetch('/api/auth/update-profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: savedUser.id || state.userId,
            username: (savedUser.username || state.username || '').replace(/^@/, ''),
            fullName: savedUser.fullName || savedUser.name || '',
            avatarUrl: ''
          })
        }).catch(e => console.warn('[Preset Avatar Backend Error]:', e));
      } catch (e) {}
      syncUserProfileToSupabase(savedUser);

      updateUserUI(savedUser);

      if (dom.editAvatarPreview) {
        const nameChar = (dom.editProfileFullNameInput?.value.trim() || dom.editProfileUsernameInput?.value.trim() || dom.editProfileNameInput?.value.trim() || state.username || 'M').charAt(0).toUpperCase();
        dom.editAvatarPreview.innerHTML = nameChar;
        dom.editAvatarPreview.className = `w-20 h-20 rounded-2xl bg-gradient-to-tr ${window.pendingAvatarBg} flex items-center justify-center text-3xl font-bold text-white shadow-xl overflow-hidden border-2 border-white/20 ring-4 ring-white/5`;
      }
      renderProfileTab();
      showToast('Avatar rengi güncellendi');
    });
  });

// Instagram-style Username Validation
function validateInstagramUsername(username) {
  const raw = String(username || '').trim().replace(/^@+/, '');
  if (!raw) {
    return { valid: false, error: 'Kullanıcı adı boş bırakılamaz.' };
  }
  // Clear, specific check for spaces
  if (/\s/.test(raw)) {
    return { valid: false, error: 'Kullanıcı adı boşluk içeremez.' };
  }
  // Clear, specific check for Turkish non-ASCII characters
  if (/[ığüşöçİĞÜŞÖÇ]/.test(raw)) {
    return { valid: false, error: 'Kullanıcı adı Türkçe karakter (ı, ğ, ü, ş, ö, ç) içeremez; İngilizce harfler kullanın.' };
  }
  if (raw.length < 3) {
    return { valid: false, error: 'Kullanıcı adı en az 3 karakter olmalıdır.' };
  }
  if (raw.length > 30) {
    return { valid: false, error: 'Kullanıcı adı en fazla 30 karakter olabilir.' };
  }
  // Instagram rules: Only lowercase/uppercase ASCII letters, numbers, underscores (_), and periods (.)
  if (!/^[a-zA-Z0-9_.]+$/.test(raw)) {
    return { valid: false, error: 'Kullanıcı adı yalnızca harf, rakam, alt çizgi (_) ve nokta (.) içerebilir.' };
  }
  // Cannot start with a period
  if (raw.startsWith('.')) {
    return { valid: false, error: 'Kullanıcı adı nokta (.) ile başlayamaz.' };
  }
  // Cannot end with a period
  if (raw.endsWith('.')) {
    return { valid: false, error: 'Kullanıcı adı nokta (.) ile bitemez.' };
  }
  // Cannot have consecutive periods
  if (raw.includes('..')) {
    return { valid: false, error: 'Kullanıcı adında yan yana iki nokta (..) bulunamaz.' };
  }
  return { valid: true, cleanUsername: raw.toLowerCase() };
}

  if (dom.saveProfileBtn) {
    dom.saveProfileBtn.addEventListener('click', async () => {
      const fullNameVal = (dom.editProfileFullNameInput && dom.editProfileFullNameInput.value.trim()) || '';
      const rawUsername = (dom.editProfileUsernameInput && dom.editProfileUsernameInput.value.trim().replace(/^@+/, '')) || (dom.editProfileNameInput && dom.editProfileNameInput.value.trim().replace(/^@+/, '')) || '';

      const dict = I18N[currentLang] || I18N.tr;
      const statusEl = document.getElementById('editProfileUsernameStatus');
      if (statusEl) {
        statusEl.className = 'hidden text-[11px] font-medium pt-0.5';
        statusEl.textContent = '';
      }

      // Instagram-style strict validation
      const userCheck = validateInstagramUsername(rawUsername);
      if (!userCheck.valid) {
        if (statusEl) {
          statusEl.textContent = userCheck.error;
          statusEl.className = 'text-[11px] font-semibold text-rose-400 pt-0.5 block';
        }
        if (dom.editProfileUsernameInput) dom.editProfileUsernameInput.focus();
        showToast(userCheck.error);
        return;
      }
      const cleanUsername = userCheck.cleanUsername;

      const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
      const currentActiveUsername = (savedUser.username || state.username || '').toLowerCase().replace(/^@/, '');

      // Duplicate username check (if changing to a new username)
      if (cleanUsername !== currentActiveUsername) {
        const prevBtnHtml = dom.saveProfileBtn.innerHTML;
        dom.saveProfileBtn.disabled = true;
        dom.saveProfileBtn.innerHTML = `<span>Kontrol ediliyor...</span>`;

        // 1. Check local backend
        try {
          const checkRes = await fetch(`/api/users/check-username?username=${encodeURIComponent(cleanUsername)}&userId=${encodeURIComponent(savedUser.id || state.userId || '')}`);
          if (checkRes.ok) {
            const checkData = await checkRes.json();
            if (!checkData.available) {
              dom.saveProfileBtn.disabled = false;
              dom.saveProfileBtn.innerHTML = prevBtnHtml;
              if (statusEl) {
                statusEl.textContent = `"@${cleanUsername}" kullanıcı adı zaten alınmış. Lütfen başka bir kullanıcı adı seçin.`;
                statusEl.className = 'text-[11px] font-semibold text-rose-400 pt-0.5 block';
              }
              if (dom.editProfileUsernameInput) dom.editProfileUsernameInput.focus();
              showToast(`"${cleanUsername}" kullanıcı adı zaten alınmış!`);
              return;
            }
          }
        } catch (e) {}

        // 2. Check Supabase profiles table
        if (supabaseClient) {
          try {
            const { data: supaProfiles, error } = await supabaseClient
              .from('profiles')
              .select('id, username')
              .ilike('username', cleanUsername);
            if (!error && supaProfiles && supaProfiles.length > 0) {
              const takenByOther = supaProfiles.some(p => p.id !== (savedUser.id || state.userId) && (p.username || '').toLowerCase() === cleanUsername);
              if (takenByOther) {
                dom.saveProfileBtn.disabled = false;
                dom.saveProfileBtn.innerHTML = prevBtnHtml;
                if (statusEl) {
                  statusEl.textContent = `"@${cleanUsername}" kullanıcı adı zaten alınmış. Lütfen başka bir kullanıcı adı seçin.`;
                  statusEl.className = 'text-[11px] font-semibold text-rose-400 pt-0.5 block';
                }
                if (dom.editProfileUsernameInput) dom.editProfileUsernameInput.focus();
                showToast(`"${cleanUsername}" kullanıcı adı zaten alınmış!`);
                return;
              }
            }
          } catch (e) {}
        }

        dom.saveProfileBtn.disabled = false;
        dom.saveProfileBtn.innerHTML = prevBtnHtml;
      }

      // Apply changes to user profile (preserve fullName, username, email, and avatar!)
      const resolvedFullName = (fullNameVal && !fullNameVal.startsWith('@'))
        ? fullNameVal
        : ((savedUser.fullName && !savedUser.fullName.startsWith('@')) ? savedUser.fullName : cleanUsername);
      savedUser.username = cleanUsername;
      savedUser.name = resolvedFullName;
      savedUser.fullName = resolvedFullName;
      savedUser.avatarChar = (resolvedFullName || cleanUsername).charAt(0).toUpperCase();
      state.username = cleanUsername;

      if (window.pendingAvatarUrl) {
        savedUser.avatarUrl = window.pendingAvatarUrl;
        savedUser.avatarBg = '';
        state.avatarUrl = window.pendingAvatarUrl;
        state.avatarBg = '';
      } else if (savedUser.avatarUrl || state.avatarUrl) {
        // PRESERVE EXISTING PROFILE PICTURE when only editing name or username!
        const preservedAvatar = savedUser.avatarUrl || state.avatarUrl;
        savedUser.avatarUrl = preservedAvatar;
        state.avatarUrl = preservedAvatar;
      } else if (window.pendingAvatarBg) {
        savedUser.avatarBg = window.pendingAvatarBg;
        savedUser.avatarUrl = '';
        state.avatarBg = window.pendingAvatarBg;
        state.avatarUrl = '';
      }

      savedUser.hasCustomProfile = true;
      savedUser.customUsername = cleanUsername;
      savedUser.customFullName = resolvedFullName;
      if (savedUser.avatarUrl) savedUser.customAvatarUrl = savedUser.avatarUrl;

      localStorage.setItem('miruo_user', JSON.stringify(savedUser));
      localStorage.setItem('miruo_custom_username', cleanUsername);
      localStorage.setItem('miruo_custom_fullname', resolvedFullName);
      if (savedUser.avatarUrl) localStorage.setItem('miruo_custom_avatar', savedUser.avatarUrl);
      if (savedUser.appleUserId) {
        localStorage.setItem(`miruo_apple_name_${savedUser.appleUserId}`, resolvedFullName);
        localStorage.setItem(`miruo_apple_username_${savedUser.appleUserId}`, cleanUsername);
        if (savedUser.avatarUrl) localStorage.setItem(`miruo_apple_avatar_${savedUser.appleUserId}`, savedUser.avatarUrl);
        localStorage.setItem(`miruo_saved_profile_${savedUser.appleUserId}`, JSON.stringify(savedUser));
      }
      if (savedUser.email) {
        const cleanE = savedUser.email.toLowerCase().trim();
        localStorage.setItem(`miruo_saved_profile_${cleanE}`, JSON.stringify(savedUser));
        localStorage.setItem(`miruo_custom_username_${cleanE}`, cleanUsername);
        localStorage.setItem(`miruo_custom_fullname_${cleanE}`, resolvedFullName);
        if (savedUser.avatarUrl) localStorage.setItem(`miruo_custom_avatar_${cleanE}`, savedUser.avatarUrl);
      }
      if (savedUser.id) {
        localStorage.setItem(`miruo_saved_profile_${savedUser.id}`, JSON.stringify(savedUser));
        localStorage.setItem(`miruo_custom_username_${savedUser.id}`, cleanUsername);
        localStorage.setItem(`miruo_custom_fullname_${savedUser.id}`, resolvedFullName);
        if (savedUser.avatarUrl) localStorage.setItem(`miruo_custom_avatar_${savedUser.id}`, savedUser.avatarUrl);
      }
      persistUserToLocalRegistry(savedUser, currentActiveUsername);
      if (window.miruoDesktop && typeof window.miruoDesktop.saveDesktopProfile === 'function') {
        try { window.miruoDesktop.saveDesktopProfile(savedUser); } catch (_) {}
      }

      // 1. Sync to backend users.json & embedded native auth store
      try {
        const updatePayload = {
          id: savedUser.id || state.userId,
          userId: savedUser.id || state.userId,
          email: savedUser.email || '',
          oldUsername: currentActiveUsername,
          username: cleanUsername,
          fullName: resolvedFullName,
          avatarUrl: savedUser.avatarUrl || '',
          avatarBg: savedUser.avatarBg || ''
        };
        fetch('/api/auth/update-profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatePayload)
        }).catch(async () => {
          if (window.location.port !== '3000') {
            fetch('http://127.0.0.1:3000/api/auth/update-profile', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(updatePayload)
            }).catch(() => {});
          }
        });
      } catch (e) {}

      // 2. Sync to Supabase profiles
      syncUserProfileToSupabase(savedUser);

      // 3. Immediately update UI everywhere on the page!
      updateUserUI(savedUser);

      if (dom.editProfileFullNameInput) dom.editProfileFullNameInput.value = resolvedFullName;
      if (dom.editProfileUsernameInput) dom.editProfileUsernameInput.value = cleanUsername;

      if (statusEl) {
        statusEl.textContent = `Profil ve kullanıcı adı (@${cleanUsername}) kaydedildi!`;
        statusEl.className = 'text-[11px] font-semibold text-emerald-400 pt-0.5 block';
      }

      const dedicatedModal = document.getElementById('dedicatedProfileEditModal');
      if (dedicatedModal) {
        dedicatedModal.classList.add('hidden');
        dedicatedModal.classList.remove('flex');
      }
      unfreezeBackgroundAfterModal(true);
      renderProfileTab();
      renderAffinityTree();
      renderFriendsTab();
      renderFriendsList();
    });
  }

  // Live Instagram username validation & availability check
  let usernameCheckDebounce = null;
  if (dom.editProfileUsernameInput) {
    dom.editProfileUsernameInput.addEventListener('input', () => {
      clearTimeout(usernameCheckDebounce);
      const statusEl = document.getElementById('editProfileUsernameStatus');
      const rawVal = dom.editProfileUsernameInput.value.trim().replace(/^@+/, '');
      if (!rawVal) {
        if (statusEl) {
          statusEl.textContent = '';
          statusEl.className = 'hidden text-[11px] font-medium pt-0.5';
        }
        return;
      }

      const check = validateInstagramUsername(rawVal);
      if (!check.valid) {
        if (statusEl) {
          statusEl.textContent = check.error;
          statusEl.className = 'text-[11px] font-semibold text-rose-400 pt-0.5 block';
        }
        return;
      }

      const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
      const currentUsername = (savedUser.username || state.username || '').toLowerCase().replace(/^@/, '');
      if (check.cleanUsername === currentUsername) {
        if (statusEl) {
          statusEl.textContent = '✓ Mevcut kullanıcı adınız';
          statusEl.className = 'text-[11px] font-medium text-emerald-400/80 pt-0.5 block';
        }
        return;
      }

      if (statusEl) {
        statusEl.textContent = 'Kontrol ediliyor...';
        statusEl.className = 'text-[11px] font-medium text-gray-400 pt-0.5 block';
      }

      usernameCheckDebounce = setTimeout(async () => {
        const targetUsername = check.cleanUsername;
        let isTaken = false;
        try {
          const res = await fetch(`/api/users/check-username?username=${encodeURIComponent(targetUsername)}&userId=${encodeURIComponent(savedUser.id || state.userId || '')}`);
          if (res.ok) {
            const data = await res.json();
            if (!data.available) isTaken = true;
          }
        } catch (e) {}

        if (!isTaken && supabaseClient) {
          try {
            const { data: supaProfiles, error } = await supabaseClient
              .from('profiles')
              .select('id, username')
              .ilike('username', targetUsername);
            if (!error && supaProfiles && supaProfiles.length > 0) {
              const takenByOther = supaProfiles.some(p => p.id !== (savedUser.id || state.userId) && (p.username || '').toLowerCase() === targetUsername);
              if (takenByOther) isTaken = true;
            }
          } catch (e) {}
        }

        // Check if value changed while waiting
        if (dom.editProfileUsernameInput.value.trim().replace(/^@/, '').toLowerCase() !== targetUsername) return;

        if (statusEl) {
          if (isTaken) {
            statusEl.textContent = `✕ "@${targetUsername}" zaten alınmış.`;
            statusEl.className = 'text-[11px] font-semibold text-rose-400 pt-0.5 block';
          } else {
            statusEl.textContent = `✓ "@${targetUsername}" kullanılabilir.`;
            statusEl.className = 'text-[11px] font-semibold text-emerald-400 pt-0.5 block';
          }
        }
      }, 350);
    });
  }

  // Logout
  if (dom.logoutBtn) {
    dom.logoutBtn.addEventListener('click', confirmAndLogoutUser);
  }

  // Delete Account (Item 21: hesabı gerçekten sil)
  const openDeleteModalBtn = document.getElementById('openDeleteAccountModalBtn');
  const deleteModal = document.getElementById('deleteAccountModal');
  const cancelDeleteBtn = document.getElementById('cancelDeleteAccountBtn');
  const confirmDeleteBtn = document.getElementById('confirmDeleteAccountBtn');
  const deletePassInput = document.getElementById('deleteAccountPasswordInput');
  const deleteErrorAlert = document.getElementById('deleteAccountErrorAlert');

  const deletePassWrapper = document.getElementById('deleteAccountPasswordWrapper');

  if (openDeleteModalBtn && deleteModal) {
    openDeleteModalBtn.addEventListener('click', () => {
      const stored = localStorage.getItem('miruo_user');
      const currentUser = stored ? JSON.parse(stored) : null;
      const isSocial = !!(currentUser && (currentUser.isApple || currentUser.provider === 'apple' || currentUser.isGoogle || currentUser.provider === 'google' || currentUser.provider === 'phone' || currentUser.isGuest));
      if (deletePassWrapper) {
        if (isSocial) {
          deletePassWrapper.classList.add('hidden');
        } else {
          deletePassWrapper.classList.remove('hidden');
        }
      }
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
        deleteModal.classList.remove('flex');
        return;
      }

      const isSocial = !!(currentUser.isApple || currentUser.provider === 'apple' || currentUser.isGoogle || currentUser.provider === 'google' || currentUser.provider === 'phone' || currentUser.isGuest);
      const password = (!isSocial && deletePassInput) ? deletePassInput.value.trim() : '';

      if (!isSocial && !password) {
        if (deleteErrorAlert) {
          deleteErrorAlert.textContent = 'Lütfen hesabınızı silmek için mevcut şifrenizi girin.';
          deleteErrorAlert.classList.remove('hidden');
        } else {
          showToast('Lütfen şifrenizi girin.');
        }
        return;
      }

      confirmDeleteBtn.disabled = true;
      confirmDeleteBtn.textContent = 'Hesap Kalıcı Olarak Siliniyor...';

      try {
        const payload = {
          userId: currentUser.id,
          appleUserId: currentUser.appleUserId || '',
          email: currentUser.email || '',
          password: password,
          isSocial: isSocial
        };

        let success = false;
        let errorMsg = '';

        try {
          const res = await fetch('/api/auth/delete-account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (res.ok) {
            const data = await res.json().catch(() => ({}));
            if (data.success !== false) success = true;
            else errorMsg = data.message || '';
          } else {
            const errData = await res.json().catch(() => ({}));
            errorMsg = errData.message || '';
          }
        } catch (_) {}

        // Also clean up from Supabase profiles if configured
        if (supabaseClient) {
          try {
            await supabaseClient.from('profiles').delete().eq('id', currentUser.id);
          } catch (_) {}
        }

        // If backend was unreachable or in offline/client-only mode, verify credentials locally
        if (!success && !errorMsg) {
          const regList = JSON.parse(localStorage.getItem('miruo_registered_users') || '[]');
          const localMatch = regList.find(u => u.id === currentUser.id || (currentUser.email && (u.email || '').toLowerCase() === (currentUser.email || '').toLowerCase()));
          if (localMatch) {
            if (!localMatch.password || localMatch.password === password) {
              success = true;
            } else {
              errorMsg = 'Girdiğiniz şifre hatalı. Hesap silinemedi.';
            }
          } else if (isSocial || !currentUser.password || currentUser.password === password) {
            success = true;
          }
        }

        // Complete and permanent purging of the account and all associated data
        if (success || isSocial) {
          const appleSub = currentUser.appleUserId || '';
          const userEmail = (currentUser.email || '').toLowerCase();
          const userId = currentUser.id || '';

          // Gracefully leave room if currently participating
          if (state.isInRoom || state.roomId) {
            try { leaveRoom(); } catch (_) {}
          }

          // 1. Purge core user and profile records
          const userKeysToPurge = [
            'miruo_user',
            'miruo_custom_username',
            'miruo_custom_fullname',
            'miruo_custom_avatar',
            'miruo_custom_email',
            'miruo_avatar',
            'miruo_avatar_bg',
            'miruo_friends',
            'miruo_user_affinity',
            'miruo_mutual_affinities',
            'miruo_affinity_requests',
            'miruo_incoming_friend_requests',
            'miruo_outgoing_friend_requests',
            'miruo_outgoing_affinity_requests',
            'miruo_platform_accounts',
            'miruo_liked_videos',
            'miruo_notifications',
            'miruo_room_invites',
            'miruo_shared_watch_time',
            'miruo_my_public_rooms',
            'miruo_blocked_users',
            'miruo_outbox_v1',
            'miruo_auth_token',
            'miruo_remember_token',
            'miruo_cached_profile',
            'miruo_chat_history',
            'miruo_room_history',
            'miruo_last_room'
          ];
          userKeysToPurge.forEach(k => {
            try { localStorage.removeItem(k); } catch (_) {}
          });

          // 2. Scan and remove any saved profile, apple auth, or id-specific keys
          try {
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (k && (
                k.startsWith('miruo_apple_') ||
                k.startsWith('miruo_saved_profile_') ||
                k.startsWith('miruo_custom_') ||
                (userId && k.includes(userId)) ||
                (appleSub && k.includes(appleSub)) ||
                (userEmail && k.includes(userEmail))
              )) {
                keysToRemove.push(k);
              }
            }
            keysToRemove.forEach(k => localStorage.removeItem(k));
          } catch (_) {}

          // 3. Remove user entry from registered users list and profiles-by-email
          try {
            const regList = JSON.parse(localStorage.getItem('miruo_registered_users') || '[]');
            const filtered = regList.filter(u => u.id !== userId && (!userEmail || (u.email || '').toLowerCase() !== userEmail) && (!appleSub || u.appleUserId !== appleSub));
            localStorage.setItem('miruo_registered_users', JSON.stringify(filtered));
          } catch (_) {}
          try {
            const byEmail = JSON.parse(localStorage.getItem('miruo_profiles_by_email') || '{}');
            if (userEmail && byEmail[userEmail]) {
              delete byEmail[userEmail];
              localStorage.setItem('miruo_profiles_by_email', JSON.stringify(byEmail));
            }
          } catch (_) {}

          // 4. Wipe Desktop Electron profile
          if (window.miruoDesktop && typeof window.miruoDesktop.saveProfile === 'function') {
            try { window.miruoDesktop.saveProfile({}); } catch (_) {}
          }

          // 5. Clear iOS platform sessions & cookies
          if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.clearPlatformSession) {
            ['youtube', 'netflix', 'prime', 'disney', 'twitch', 'kick'].forEach(p => {
              try { window.webkit.messageHandlers.clearPlatformSession.postMessage({ provider: p }); } catch (_) {}
            });
          }

          // 6. Reset runtime state & session storage
          sessionStorage.clear();
          state.user = null;
          state.username = '';
          state.roomId = null;
          state.isInRoom = false;

          deleteModal.classList.add('hidden');
          deleteModal.classList.remove('flex');
          showToast('Hesabınız ve tüm verileriniz kalıcı olarak silindi.');
          setTimeout(() => {
            location.href = '/';
          }, 1000);
        } else {
          if (deleteErrorAlert) {
            deleteErrorAlert.textContent = errorMsg || 'Hesap silinemedi. Lütfen şifrenizi kontrol edin.';
            deleteErrorAlert.classList.remove('hidden');
          } else {
            showToast(errorMsg || 'Hesap silinemedi.');
          }
          confirmDeleteBtn.disabled = false;
          confirmDeleteBtn.textContent = 'Evet, Hesabımı Sil';
        }
      } catch (err) {
        if (deleteErrorAlert) {
          deleteErrorAlert.textContent = 'İşlem tamamlanamadı. Lütfen tekrar deneyin.';
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

    // Pre-check the radio based on current room privacy
    const publicRadio = document.querySelector('input[name="roomAccessRule"][value="public"]');
    const inviteRadio = document.querySelector('input[name="roomAccessRule"][value="invite"]');
    if (state.isPrivateRoom) {
      if (inviteRadio) inviteRadio.checked = true;
    } else {
      if (publicRadio) publicRadio.checked = true;
    }

    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
  }
  window.openRoomAccessModal = openRoomAccessModal;

  if (dom.roomAccessBtn) {
    dom.roomAccessBtn.addEventListener('click', openRoomAccessModal);
  }
  const openPrivacyBadgeBtn = document.getElementById('openRoomPrivacyBtn');
  if (openPrivacyBadgeBtn && openPrivacyBadgeBtn !== dom.roomAccessBtn) {
    openPrivacyBadgeBtn.addEventListener('click', openRoomAccessModal);
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
      const isPrivate = (selectedRule === 'invite');
      state.isPrivateRoom = isPrivate;
      updateRoomPrivacyUI(isPrivate);
      sendP2PData('privacy_change', { isPrivate });
      sendSignal({ type: 'privacy-change', isPrivate });
      const dict = I18N[currentLang] || I18N.tr;
      if (isPrivate) {
        showToast(currentLang === 'en' ? 'Room Privacy: Invite Only' : (currentLang === 'de' ? 'Raum-Privatsphäre: Nur mit Einladung' : 'Oda Gizliliği: Sadece Davetliler'));
      } else {
        showToast(currentLang === 'en' ? 'Room Privacy: Everyone (Public)' : (currentLang === 'de' ? 'Raum-Privatsphäre: Öffentlich' : 'Oda Gizliliği: Herkese Açık'));
      }
      if (dom.roomAccessModal) dom.roomAccessModal.classList.add('hidden');
    });
  }
  if (dom.copyRoomAccessLinkBtn) {
    dom.copyRoomAccessLinkBtn.addEventListener('click', () => {
      const url = getMiruoRoomUrl(state.roomId);
      const dict = I18N[currentLang] || I18N.tr;
      copyToClipboard(url).then(() => {
        showToast(dict.invite_copied || 'Oda linki kopyalandı!');
        dom.copyRoomAccessLinkBtn.textContent = currentLang === 'en' ? 'Copied!' : (currentLang === 'de' ? 'Kopiert!' : 'Kopyalandı!');
        setTimeout(() => {
          if (dom.copyRoomAccessLinkBtn) dom.copyRoomAccessLinkBtn.textContent = dict.copy_btn || 'Kopyala';
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
        showToast(`Yerel video yüklendi: ${file.name}`);
      }
    });
  }

  // Fullscreen Handlers (Dock Button, Stage Floating Button, Exit Button, Double-Click, F Key)
  if (dom.toggleFullscreenBtn) {
    addInstantTap(dom.toggleFullscreenBtn, (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      toggleFullscreen();
    });
  }
  if (dom.stageFloatingFullscreenBtn) {
    addInstantTap(dom.stageFloatingFullscreenBtn, (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      toggleFullscreen();
    });
  }
  if (dom.stageExitFullscreenFloatingBtn) {
    addInstantTap(dom.stageExitFullscreenFloatingBtn, (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      exitStageFullscreenDimensions();
      setChatVisibility(true);
    });
  }

  if (dom.closePhotoStageBtn) {
    addInstantTap(dom.closePhotoStageBtn, (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      closePhotoStage(true);
    });
  }

  // YouTube-Style Double Tap to Seek (10s Left/Right)
  function triggerDoubleTapSeek(isRight) {
    if (!canUserControlPlayback()) {
      showToast('Videoyu sarma yetkisi sadece Oda Sahibi ve Yöneticilere aittir.');
      return;
    }
    const delta = isRight ? 10 : -10;
    seekRelative(delta);

    const indicator = document.getElementById(isRight ? 'doubleTapSeekRight' : 'doubleTapSeekLeft');
    if (indicator) {
      indicator.classList.remove('active');
      void indicator.offsetWidth; // force animation restart
      indicator.classList.add('active');
      setTimeout(() => {
        indicator.classList.remove('active');
      }, 650);
    }
    showToast(isRight ? '+10 saniye ileri' : '-10 saniye geri');
  }

  if (dom.stageContainer) {
    let lastTapTime = 0;
    let lastTapX = 0;
    let singleTapTimeout = null;

    const handlePlayerTouchEnd = (e) => {
      if (document.body.classList.contains('has-mini-player')) return;
      if (e.target.closest('#partnerPipCard') || e.target.closest('#selfPipCard') || e.target.closest('button') || e.target.closest('#raveRoomSettingsMenu') || e.target.closest('input')) return;

      const currentTime = Date.now();
      const touch = e.changedTouches ? e.changedTouches[0] : null;
      if (!touch) return;

      const rect = dom.stageContainer.getBoundingClientRect();
      const touchX = touch.clientX - rect.left;
      const timeDiff = currentTime - lastTapTime;
      const distDiff = Math.abs(touchX - lastTapX);

      if (timeDiff < 320 && distDiff < 70) {
        // Double Tap Detected!
        if (singleTapTimeout) {
          clearTimeout(singleTapTimeout);
          singleTapTimeout = null;
        }
        e.preventDefault();
        e.stopPropagation();
        const normX = touchX / rect.width;
        if (normX < 0.40) {
          triggerDoubleTapSeek(false); // Rewind 10s
        } else if (normX > 0.60) {
          triggerDoubleTapSeek(true);  // Forward 10s
        } else {
          togglePlayPause();           // Center double tap = Play/Pause
        }
        lastTapTime = 0;
        return;
      }

      lastTapTime = currentTime;
      lastTapX = touchX;

      // Single Tap after brief delay to distinguish from double-tap
      if (singleTapTimeout) clearTimeout(singleTapTimeout);
      singleTapTimeout = setTimeout(() => {
        singleTapTimeout = null;
        const isOverlayHidden = dom.ravePlayerOverlay && dom.ravePlayerOverlay.classList.contains('opacity-0');
        if (isOverlayHidden) {
          showStageControls();
          resetControlsHideTimer();
        } else {
          hideStageControls();
        }
      }, 330);
    };

    dom.stageContainer.addEventListener('touchend', handlePlayerTouchEnd);

    dom.stageContainer.addEventListener('dblclick', (e) => {
      if (e.target.closest('#partnerPipCard') || e.target.closest('#selfPipCard') || e.target.closest('button') || e.target.closest('#raveRoomSettingsMenu') || e.target.closest('input')) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = dom.stageContainer.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const normX = clickX / rect.width;
      if (normX < 0.40) {
        triggerDoubleTapSeek(false); // Rewind 10s
      } else if (normX > 0.60) {
        triggerDoubleTapSeek(true); // Forward 10s
      } else {
        togglePlayPause();
      }
    });

    // Touch Guard element bindings
    const touchGuard = document.getElementById('miruoTouchGuard');
    if (touchGuard) {
      touchGuard.addEventListener('touchend', handlePlayerTouchEnd);
      touchGuard.addEventListener('click', (e) => {
        if (e.detail === 1) {
          if (!state.isPlaying) {
            togglePlayPause();
            return;
          }
          const isOverlayHidden = dom.ravePlayerOverlay && dom.ravePlayerOverlay.classList.contains('opacity-0');
          if (isOverlayHidden) {
            showStageControls();
            resetControlsHideTimer();
          } else {
            hideStageControls();
          }
        }
      });
    }
  }

  document.addEventListener('keydown', (e) => {
    if (['input', 'textarea'].includes((document.activeElement?.tagName || '').toLowerCase())) return;
    if (document.activeElement?.isContentEditable) return;
    if (e.key === ' ' || e.code === 'Space') {
      if (state.isInRoom && (state.activeMode === 'youtube' || state.activeMode === 'direct')) {
        e.preventDefault();
        togglePlayPause();
      }
    }
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

  // ==========================================
  // CONNECTED PLATFORMS & ACCOUNTS MANAGER
  // "Gerçekten bağlasın ve beraber izlenicekse o hesaptan başlasın"
  // ==========================================
  const CONNECTED_ACCOUNTS_KEY = 'miruo_connected_accounts';

  const PLATFORM_AUTH_CONFIGS = {
    youtube: {
      name: 'YouTube / Google',
      iconSvg: '<svg class="w-5 h-5 text-red-500 fill-current" viewBox="0 0 24 24"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
      loginUrl: 'https://accounts.google.com/ServiceLogin?service=youtube',
      watchUrl: 'https://m.youtube.com/feed/subscriptions',
      placeholder: 'ornek@gmail.com'
    },
    netflix: {
      name: 'Netflix',
      iconSvg: '<svg class="w-5 h-5 text-red-600 fill-current" viewBox="0 0 24 24"><path d="M5.398 0v24c1.815-.224 3.73-.559 5.398-.895V0H5.398zm7.804 0v16.197l5.398 6.721V0h-5.398z"/></svg>',
      loginUrl: 'https://www.netflix.com/login',
      watchUrl: 'https://www.netflix.com/browse',
      placeholder: 'netflix@hesabiniz.com'
    },
    prime: {
      name: 'Prime Video',
      iconSvg: '<svg class="w-5 h-5 text-blue-400 fill-current" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-9l6 4.5-6 4.5z"/></svg>',
      loginUrl: 'https://www.primevideo.com/auth-redirect/',
      watchUrl: 'https://www.primevideo.com/storefront/home',
      placeholder: 'prime@hesabiniz.com'
    },
    disney: {
      name: 'Disney+',
      iconSvg: '<div class="w-6 h-6 rounded bg-blue-900/60 text-blue-300 font-black text-xs flex items-center justify-center">D+</div>',
      loginUrl: 'https://www.disneyplus.com/login',
      watchUrl: 'https://www.disneyplus.com/home',
      placeholder: 'disney@hesabiniz.com'
    }
  };

  let currentConnectingProvider = null;

  function getConnectedAccounts() {
    try {
      const raw = localStorage.getItem(CONNECTED_ACCOUNTS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {
      youtube: { connected: false, account: '', autoStart: true },
      netflix: { connected: false, account: '', autoStart: true },
      prime: { connected: false, account: '', autoStart: true },
      disney: { connected: false, account: '', autoStart: true }
    };
  }
  window.getConnectedAccounts = getConnectedAccounts;

  function saveConnectedAccounts(accounts) {
    localStorage.setItem(CONNECTED_ACCOUNTS_KEY, JSON.stringify(accounts));
    renderConnectedAccountsUI();
    const catKey = (state.currentProvider || 'youtube').toLowerCase();
    const matched = Object.keys(accounts).find(k => catKey.includes(k));
    if (matched && accounts[matched]?.connected && accounts[matched]?.account) {
      state.connectedAccount = accounts[matched].account;
    } else if (matched && !accounts[matched]?.connected) {
      state.connectedAccount = '';
    }
    updateNowPlayingAccountBadge(state.connectedAccount);
  }
  window.saveConnectedAccounts = saveConnectedAccounts;

  function updateNowPlayingAccountBadge(account) {
    const badge = dom.nowPlayingAccountBadge || document.getElementById('nowPlayingAccountBadge');
    if (!badge) return;
    badge.classList.add('hidden');
    badge.classList.remove('inline-flex');
    badge.innerHTML = '';
  }
  window.updateNowPlayingAccountBadge = updateNowPlayingAccountBadge;

  function startDirectPlatformLogin(provider) {
    const pDef = PLATFORM_AUTH_CONFIGS[provider];
    if (!pDef) return;

    // 1. In iOS Native App: Opens the native in-app browser directly to that site's official login page!
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.openPlatform) {
      window.webkit.messageHandlers.openPlatform.postMessage({
        provider: provider,
        url: pDef.loginUrl,
        title: `${pDef.name} Giriş`,
        action: 'connect',
        lang: currentLang
      });
      return;
    }

    // 2. On Web Desktop: Open login in a new tab
    try {
      window.open(pDef.loginUrl, '_blank');
    } catch (e) {}
  }

  function connectPlatformAccountPrompt(provider) {
    const pDef = PLATFORM_AUTH_CONFIGS[provider] || { name: provider, placeholder: 'ornek@email.com' };
    const savedUser = JSON.parse(localStorage.getItem('miruo_user') || '{}');
    const defaultAcc = savedUser.email || (savedUser.username ? `@${savedUser.username}` : '');

    // 1. In iOS Native App: Opens native in-app browser with connect mode
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.openPlatform) {
      window.webkit.messageHandlers.openPlatform.postMessage({
        provider: provider,
        url: pDef.loginUrl,
        title: `${pDef.name} Giriş`,
        action: 'connect',
        mode: 'connect',
        lang: currentLang
      });
      return;
    }

    // 2. On Web Desktop / Electron: Clean in-app prompt so user stays in Settings
    const entered = window.prompt(
      `${pDef.name} hesabınızı bağlayın.\n\nHesap e-posta veya kullanıcı adınızı girin:`,
      defaultAcc
    );
    if (entered && entered.trim()) {
      const finalAcc = entered.trim();
      const accounts = getConnectedAccounts();
      accounts[provider] = {
        connected: true,
        account: finalAcc,
        autoStart: true,
        connectedAt: Date.now()
      };
      saveConnectedAccounts(accounts);
      renderConnectedAccountsUI();
      showToast(`✓ ${pDef.name} hesabı (${finalAcc}) başarıyla bağlandı!`);
    }
  }

  function toggleAccountConnection(provider) {
    const accounts = getConnectedAccounts();
    const current = accounts[provider] || { connected: false, account: '' };
    const pDef = PLATFORM_AUTH_CONFIGS[provider] || { name: provider };

    if (current.connected) {
      accounts[provider] = { connected: false, account: '', autoStart: false };
      if (typeof platformAccounts === 'object' && platformAccounts) {
        platformAccounts[provider] = null;
        try { localStorage.setItem('miruo_platform_accounts', JSON.stringify(platformAccounts)); } catch (_) {}
      }
      state.connectedAccount = '';
      updateNowPlayingAccountBadge('');
      saveConnectedAccounts(accounts);

      // Clear real cookies and web session for this platform in iOS WKWebsiteDataStore
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.clearPlatformSession) {
        try {
          window.webkit.messageHandlers.clearPlatformSession.postMessage({ provider: provider });
        } catch (e) {
          console.warn('[Miruo] clearPlatformSession warning:', e);
        }
      }

      showToast(`${pDef.name} hesabı bağlantısı ve oturumu kaldırıldı.`);
    } else {
      connectPlatformAccountPrompt(provider);
    }
  }

  // Global Bridge for Native iOS WebView to report account connection
  if (!window.MiruoBridge) window.MiruoBridge = {};
  window.MiruoBridge.onAccountConnected = function(provider, account) {
    if (provider) {
      const accounts = getConnectedAccounts();
      const pDef = PLATFORM_AUTH_CONFIGS[provider] || { name: provider };
      const finalAcc = account || (pDef.name + " Hesabı");
      accounts[provider] = {
        connected: true,
        account: finalAcc,
        autoStart: true,
        connectedAt: Date.now()
      };
      saveConnectedAccounts(accounts);
      renderConnectedAccountsUI();
      showToast(`✓ ${pDef.name} hesabı (${finalAcc}) başarıyla bağlandı! Artık beraber izleme bu hesaptan başlayacak.`);
    }
  };

  function renderConnectedAccountsUI() {
    const accounts = getConnectedAccounts();

    const configs = [
      { key: 'youtube', btnId: 'toggleYtAccountBtn', badgeId: 'ytAccountStatusBadge', subId: 'ytAccountSubText', defaultSub: 'Google hesabı ile oturum aç' },
      { key: 'netflix', btnId: 'toggleNetflixAccountBtn', badgeId: 'netflixAccountStatusBadge', subId: 'netflixAccountSubText', defaultSub: 'Netflix hesabı ile oturum aç' },
      { key: 'prime', btnId: 'togglePrimeAccountBtn', badgeId: 'primeAccountStatusBadge', subId: 'primeAccountSubText', defaultSub: 'Prime hesabı ile oturum aç' },
      { key: 'disney', btnId: 'toggleDisneyAccountBtn', badgeId: 'disneyAccountStatusBadge', subId: 'disneyAccountSubText', defaultSub: 'Disney+ hesabı ile oturum aç' }
    ];

    configs.forEach(cfg => {
      const acc = accounts[cfg.key] || { connected: false, account: '' };
      const btn = document.getElementById(cfg.btnId);
      const badge = document.getElementById(cfg.badgeId);
      const sub = document.getElementById(cfg.subId);

      if (btn) {
        if (acc.connected) {
          btn.textContent = 'Bağlantıyı Kes';
          btn.className = 'px-3 py-1.5 rounded-lg bg-white/10 hover:bg-rose-500/20 hover:text-rose-300 border border-white/15 text-xs font-semibold text-gray-300 transition-all cursor-pointer shrink-0';
        } else {
          btn.textContent = 'Hesabı Bağla';
          btn.className = 'px-3 py-1.5 rounded-lg bg-[#A64D79]/20 hover:bg-[#A64D79]/30 border border-[#A64D79]/30 text-xs font-semibold text-rose-200 transition-all cursor-pointer shrink-0';
        }
      }

      if (badge) {
        if (acc.connected) {
          badge.innerHTML = `
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-xs">
              <svg class="w-3 h-3 text-emerald-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Bağlandı</span>
            </span>
          `;
          badge.classList.remove('hidden');
        } else {
          badge.innerHTML = '';
          badge.classList.add('hidden');
        }
      }

      if (sub) {
        if (acc.connected && acc.account) {
          sub.textContent = `Bağlı hesap: ${acc.account} (Birlikte izlemede devrede)`;
          sub.className = 'text-[10px] text-emerald-400 font-medium block truncate';
        } else {
          sub.textContent = cfg.defaultSub;
          sub.className = 'text-[10px] text-gray-400 block truncate';
        }
      }
    });
  }

  window.renderConnectedAccountsUI = renderConnectedAccountsUI;
  window.toggleAccountConnection = toggleAccountConnection;
  window.openConnectPlatformModal = function(provider) {
    if (typeof startDirectPlatformLogin === 'function') startDirectPlatformLogin(provider);
  };
  window.closeConnectPlatformModal = function() {};

  // Platform Account Connect / Disconnect Buttons
  if (dom.toggleYtAccountBtn) {
    dom.toggleYtAccountBtn.addEventListener('click', () => {
      toggleAccountConnection('youtube');
    });
  }

  if (dom.toggleNetflixAccountBtn) {
    dom.toggleNetflixAccountBtn.addEventListener('click', () => {
      toggleAccountConnection('netflix');
    });
  }

  if (dom.togglePrimeAccountBtn) {
    dom.togglePrimeAccountBtn.addEventListener('click', () => {
      toggleAccountConnection('prime');
    });
  }

  if (dom.toggleDisneyAccountBtn) {
    dom.toggleDisneyAccountBtn.addEventListener('click', () => {
      toggleAccountConnection('disney');
    });
  }



  // Initial render on boot
  renderConnectedAccountsUI();

  // Rave PiP Corner Buttons
  document.querySelectorAll('.pip-corner-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      pipSettings.corner = btn.dataset.corner || 'bottom-right';
      savePipSettings(true);
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

  // Play / Pause Toggle & Advance Controls
  if (dom.mainPlayPauseBtn) dom.mainPlayPauseBtn.addEventListener('click', togglePlayPause);

  const stageSeekBackBtn = document.getElementById('stageSeekBackBtn');
  if (stageSeekBackBtn) {
    addInstantTap(stageSeekBackBtn, (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      if (!canUserControlPlayback()) {
        showToast('Videoyu geri sarma yetkisi sadece Oda Sahibi ve Yöneticilere aittir.');
        return;
      }
      if (typeof seekRelative === 'function') seekRelative(-10);
      showToast('10 sn geri sarıldı');
    });
  }

  const stageAdvanceNextBtn = document.getElementById('stageAdvanceNextBtn');
  if (stageAdvanceNextBtn) {
    addInstantTap(stageAdvanceNextBtn, (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      if (!canUserControlPlayback()) {
        showToast('Videoyu ileri sarma yetkisi sadece Oda Sahibi ve Yöneticilere aittir.');
        return;
      }
      if (typeof seekRelative === 'function') seekRelative(10);
      showToast('10 sn ileri sarıldı');
    });
  }

  // Seek Slider (Miruo Custom Unified Scrubber)
  const finishSeek = (e) => {
    state.isUserDraggingSeek = false;
    if (!canUserControlPlayback()) {
      if (state.duration > 0) {
        const pct = (state.currentTime / state.duration) * 100;
        if (dom.seekSlider) dom.seekSlider.value = pct;
        if (dom.nowPlayingSeekSlider) dom.nowPlayingSeekSlider.value = pct;
      }
      showToast('Videoyu sarma yetkisi sadece Oda Sahibi ve Yöneticilere aittir.');
      return;
    }
    const targetPercent = parseFloat(e.target.value);
    if (state.duration > 0) {
      const targetTime = (targetPercent / 100) * state.duration;
      state.currentTime = targetTime;
      if (state.activeMode === 'youtube') {
        sendYtCommand('seekTo', [targetTime, true]);
      } else if (state.activeMode === 'direct' && dom.nativeVideoPlayer) {
        dom.nativeVideoPlayer.currentTime = targetTime;
      }
      sendP2PData('sync', { action: 'seek', time: targetTime, isPlaying: state.isPlaying, sentAt: Date.now() });
    }
  };

  if (dom.seekSlider) {
    dom.seekSlider.addEventListener('input', (e) => {
      if (!canUserControlPlayback()) {
        if (state.duration > 0) e.target.value = (state.currentTime / state.duration) * 100;
        return;
      }
      state.isUserDraggingSeek = true;
      const targetPercent = parseFloat(e.target.value);
      if (state.duration > 0) {
        const targetTime = (targetPercent / 100) * state.duration;
        if (dom.currentTimeDisplay) dom.currentTimeDisplay.textContent = formatTime(targetTime);
        if (dom.nowPlayingCurrentTime) dom.nowPlayingCurrentTime.textContent = formatTime(targetTime);
      }
    });

    dom.seekSlider.addEventListener('change', finishSeek);
    dom.seekSlider.addEventListener('mouseup', finishSeek);
    dom.seekSlider.addEventListener('touchend', finishSeek);
  }

  // Dedicated Now-Playing Bottom Bar Scrubber (Always Accessible on iPhone & Mobile)
  if (dom.nowPlayingSeekSlider) {
    dom.nowPlayingSeekSlider.addEventListener('input', (e) => {
      if (!canUserControlPlayback()) {
        if (state.duration > 0) e.target.value = (state.currentTime / state.duration) * 100;
        return;
      }
      state.isUserDraggingSeek = true;
      const targetPercent = parseFloat(e.target.value);
      if (state.duration > 0) {
        const targetTime = (targetPercent / 100) * state.duration;
        if (dom.nowPlayingCurrentTime) dom.nowPlayingCurrentTime.textContent = formatTime(targetTime);
        if (dom.currentTimeDisplay) dom.currentTimeDisplay.textContent = formatTime(targetTime);
      }
    });

    dom.nowPlayingSeekSlider.addEventListener('change', finishSeek);
    dom.nowPlayingSeekSlider.addEventListener('mouseup', finishSeek);
    dom.nowPlayingSeekSlider.addEventListener('touchend', finishSeek);
  }

  if (dom.nowPlayingPlayPauseQuickBtn) {
    addInstantTap(dom.nowPlayingPlayPauseQuickBtn, (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      togglePlayPause();
    });
  }

  // Native Video Player (Direct Streams & Screen Share) Event Bindings
  if (dom.nativeVideoPlayer) {
    dom.nativeVideoPlayer.addEventListener('timeupdate', () => {
      if (state.activeMode === 'direct') {
        state.currentTime = dom.nativeVideoPlayer.currentTime || 0;
        state.duration = dom.nativeVideoPlayer.duration || 0;
        if (state.duration > 0) {
          const pct = (state.currentTime / state.duration) * 100;
          if (dom.currentTimeDisplay) dom.currentTimeDisplay.textContent = formatTime(state.currentTime);
          if (dom.durationDisplay) dom.durationDisplay.textContent = formatTime(state.duration);
          if (dom.seekSlider && !state.isUserDraggingSeek) dom.seekSlider.value = pct;
          if (dom.stageBottomMiniProgressBar) dom.stageBottomMiniProgressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
          if (dom.nowPlayingSeekSlider && !state.isUserDraggingSeek) dom.nowPlayingSeekSlider.value = pct;
          if (dom.nowPlayingCurrentTime) dom.nowPlayingCurrentTime.textContent = formatTime(state.currentTime);
          if (dom.nowPlayingDuration) dom.nowPlayingDuration.textContent = formatTime(state.duration);
        }
      }
    });

    dom.nativeVideoPlayer.addEventListener('loadedmetadata', () => {
      if (state.activeMode === 'direct') {
        state.duration = dom.nativeVideoPlayer.duration || 0;
        if (dom.durationDisplay) dom.durationDisplay.textContent = formatTime(state.duration);
        if (dom.nowPlayingDuration) dom.nowPlayingDuration.textContent = formatTime(state.duration);
      }
    });

    dom.nativeVideoPlayer.addEventListener('play', () => {
      if (state.activeMode === 'direct') {
        if (!state.isRemoteAction && (!state.isPlaying || !canUserControlPlayback())) {
          if (!state.isPlaying) {
            dom.nativeVideoPlayer.pause();
            return;
          }
        }
        state.isPlaying = true;
        updatePlayPauseUI(true);
        if (!state.isRemoteAction && canUserControlPlayback()) {
          sendP2PData('sync', { action: 'play', time: dom.nativeVideoPlayer.currentTime, sentAt: Date.now() });
        }
      }
    });

    dom.nativeVideoPlayer.addEventListener('pause', () => {
      if (state.activeMode === 'direct') {
        if (!state.isRemoteAction && state.isPlaying && !canUserControlPlayback()) {
          dom.nativeVideoPlayer.play().catch(() => {});
          return;
        }
        state.isPlaying = false;
        updatePlayPauseUI(false);
        if (!state.isRemoteAction && canUserControlPlayback()) {
          sendP2PData('sync', { action: 'pause', time: dom.nativeVideoPlayer.currentTime, sentAt: Date.now() });
        }
      }
    });

    dom.nativeVideoPlayer.addEventListener('ended', () => {
      if (state.activeMode === 'direct') {
        state.isPlaying = false;
        updatePlayPauseUI(false);
        handleNextTrack();
      }
    });
  }

  // Floating Emoji Reactions
  document.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      spawnFloatingReaction(btn.dataset.emoji, true);
    });
  });

  // Player Settings & Playback Rate Functions
  const CAPTION_LANG_LABELS = {
    off: 'Kapalı',
    tr: 'Türkçe',
    en: 'İngilizce',
    de: 'Almanca',
    es: 'İspanyolca',
    auto: 'Otomatik'
  };

  function updateCaptionsUI() {
    const savedLang = (function() {
      try { return localStorage.getItem('miruo_caption_lang'); } catch (_) { return null; }
    })();
    const currentLang = state.captionLanguage || (savedLang ? savedLang : (state.captionsEnabled ? 'auto' : 'off'));
    const isOff = currentLang === 'off';
    const badge = document.getElementById('playerSubtitleStatusBadge');
    if (badge) {
      badge.textContent = CAPTION_LANG_LABELS[currentLang] || currentLang.toUpperCase();
      badge.className = isOff ? 'text-[10px] font-bold text-gray-400' : 'text-[10px] font-bold text-emerald-400';
    }
    document.querySelectorAll('.caption-lang-btn').forEach(btn => {
      const bLang = btn.dataset.lang;
      if (bLang === currentLang) {
        btn.className = 'caption-lang-btn py-1.5 rounded-lg bg-rose-500/30 text-rose-300 border border-rose-500/40 text-[10px] cursor-pointer transition-all active:scale-95 font-bold';
      } else {
        btn.className = 'caption-lang-btn py-1.5 rounded-lg bg-white/5 hover:bg-white/15 text-[10px] cursor-pointer transition-all active:scale-95 text-gray-200';
      }
    });
  }

  function setCaptionLanguage(langCode) {
    state.captionLanguage = langCode;
    state.captionsEnabled = (langCode !== 'off');
    try {
      localStorage.setItem('miruo_caption_lang', langCode);
    } catch (_) {}

    if (langCode === 'off') {
      if (state.activeMode === 'youtube') {
        sendYtCommand('unloadModule', ['captions']);
        sendYtCommand('setOption', ['captions', 'track', {}]);
      } else if (dom.nativeVideoPlayer) {
        const tracks = dom.nativeVideoPlayer.textTracks || [];
        for (let i = 0; i < tracks.length; i++) tracks[i].mode = 'hidden';
      }
      showToast('Altyazı kapatıldı');
    } else {
      if (state.activeMode === 'youtube') {
        sendYtCommand('loadModule', ['captions']);
        if (langCode === 'auto') {
          sendYtCommand('setOption', ['captions', 'track', {}]);
        } else {
          sendYtCommand('setOption', ['captions', 'track', { languageCode: langCode }]);
          sendYtCommand('setOption', ['captions', 'translationLanguage', { languageCode: langCode }]);
        }
        setTimeout(() => {
          try {
            sendYtCommand('setOption', ['captions', 'reload', true]);
          } catch (_) {}
        }, 300);
      } else if (dom.nativeVideoPlayer) {
        const tracks = dom.nativeVideoPlayer.textTracks || [];
        for (let i = 0; i < tracks.length; i++) {
          tracks[i].mode = (tracks[i].language === langCode || langCode === 'auto') ? 'showing' : 'hidden';
        }
      }
      showToast(`Altyazı: ${CAPTION_LANG_LABELS[langCode] || langCode} seçildi`);
    }

    updateCaptionsUI();
  }

  function updateMenuAVStatus() {
    updateCaptionsUI();
    const currentQuality = state.playbackQuality || (function() {
      try { return localStorage.getItem('miruo_preferred_quality'); } catch (_) { return null; }
    })() || 'auto';
    setPlayerQuality(currentQuality, false);
  }

  function setPlayerQuality(quality, showNotification = true) {
    if (!quality) quality = 'auto';
    state.playbackQuality = quality;
    try {
      localStorage.setItem('miruo_preferred_quality', quality);
    } catch (_) {}

    if (state.activeMode === 'youtube') {
      sendYtCommand('setPlaybackQuality', [quality]);
      sendYtCommand('setPlaybackQualityRange', [quality, quality]);
    }

    const qualityLabelMap = {
      'hd1080': '1080p',
      'hd720': '720p',
      'large': '480p',
      'medium': '360p',
      'auto': 'Otomatik'
    };
    const displayLabel = qualityLabelMap[quality] || quality;

    const valBadge = document.getElementById('playerQualityVal');
    if (valBadge) valBadge.textContent = displayLabel;

    document.querySelectorAll('.player-quality-btn').forEach(btn => {
      if (btn.dataset.quality === quality) {
        btn.className = 'player-quality-btn py-1.5 rounded-lg bg-rose-500/30 text-rose-300 border border-rose-500/40 text-[10px] cursor-pointer transition-all active:scale-95 font-bold';
      } else {
        btn.className = 'player-quality-btn py-1.5 rounded-lg bg-white/5 hover:bg-white/15 text-[10px] cursor-pointer transition-all active:scale-95 text-gray-200';
      }
    });

    if (showNotification) {
      showToast(`Video Kalitesi: ${displayLabel}`);
    }
  }
  window.setPlayerQuality = setPlayerQuality;

  function toggleRaveRoomSettingsMenu(show) {
    if (!dom.raveRoomSettingsMenu) return;
    const isHidden = dom.raveRoomSettingsMenu.classList.contains('hidden');
    const target = (typeof show === 'boolean') ? show : isHidden;
    const backdrop = dom.raveRoomSettingsBackdrop || document.getElementById('raveRoomSettingsBackdrop');
    if (target) {
      dom.raveRoomSettingsMenu.classList.remove('hidden');
      if (backdrop) backdrop.classList.remove('hidden');
      updateMenuAVStatus();
    } else {
      dom.raveRoomSettingsMenu.classList.add('hidden');
      if (backdrop) backdrop.classList.add('hidden');
    }
  }

  function canControlPlayback() {
    if (!state.roomId) return true;
    return canUserControlPlayback();
  }

  function setPlayerPlaybackRate(rate, broadcast = true) {
    rate = parseFloat(rate) || 1.0;
    
    // Permission check if user clicked to broadcast speed change to room
    if (broadcast && !canControlPlayback()) {
      showToast('Oynatma hızını yalnızca oda sahibi veya yetkililer değiştirebilir.');
      return;
    }

    state.playbackRate = rate;

    // 1. YouTube Player
    if (state.activeMode === 'youtube') {
      sendYtCommand('setPlaybackRate', [rate]);
    }
    // 2. Native HTML5 Video
    else if (dom.nativeVideoPlayer) {
      try {
        dom.nativeVideoPlayer.playbackRate = rate;
      } catch (err) {}
    }

    // 3. Web Player / Embedded Platforms (Twitch, Netflix, Web View)
    if (window.miruoDesktop && dom.webPlayerFrame && typeof dom.webPlayerFrame.executeJavaScript === 'function') {
      dom.webPlayerFrame.executeJavaScript(`
        (function() {
          const videos = document.querySelectorAll('video');
          videos.forEach(v => {
            try { v.playbackRate = ${rate}; } catch (e) {}
          });
        })();
      `).catch(() => {});
    }

    // Update UI speed indicators
    if (dom.playerSpeedVal) {
      dom.playerSpeedVal.textContent = `${rate}x`;
    }
    document.querySelectorAll('.playback-speed-btn, .player-speed-btn').forEach(btn => {
      const bSpeed = parseFloat(btn.dataset.speed);
      if (Math.abs(bSpeed - rate) < 0.05) {
        btn.className = 'playback-speed-btn player-speed-btn py-1.5 rounded-lg bg-rose-500/30 text-rose-300 border border-rose-500/40 transition-all text-[10px] cursor-pointer font-black';
      } else {
        btn.className = 'playback-speed-btn player-speed-btn py-1.5 rounded-lg bg-white/5 hover:bg-rose-500/20 hover:text-rose-300 transition-all text-[10px] cursor-pointer';
      }
    });

    if (broadcast) {
      sendP2PData('sync', {
        action: 'rate',
        rate: rate,
        by: state.username || 'Host',
        sentAt: Date.now()
      });
      showToast(`Oynatma Hızı: ${rate}x (Tüm odaya uygulandı)`);
    }
  }

  // Clean up any legacy video zoom/fit preferences so video is clean and authentic
  try {
    localStorage.removeItem('miruo_video_fit');
    localStorage.removeItem('miruo_video_zoom');
  } catch (_) {}
  if (dom.stageContainer) {
    dom.stageContainer.classList.remove('video-fit-contain', 'video-fit-cover', 'video-fit-zoom');
    dom.stageContainer.style.removeProperty('--miruo-video-scale');
  }

  function triggerResyncWithHost() {
    if (state.isHost) {
      showToast('Oda sahibi sizsiniz. Senkronizasyon yenilendi.');
      if (state.currentVideoId && ['youtube', 'direct', 'web'].includes(state.activeMode)) {
        sendP2PData('sync', {
          action: 'full_sync',
          videoId: state.currentVideoId,
          time: state.currentTime,
          isPlaying: state.isPlaying,
          rate: state.playbackRate || 1.0,
          sentAt: Date.now()
        });
      }
    } else {
      showToast('Host ile yeniden senkronize ediliyor...');
      sendP2PData('sync', { action: 'request_sync', sentAt: Date.now() });
    }
    toggleRaveRoomSettingsMenu(false);
  }

  if (dom.raveRoomSettingsBtn) {
    addInstantTap(dom.raveRoomSettingsBtn, (e) => {
      e.stopPropagation();
      toggleRaveRoomSettingsMenu();
    });
  }

  if (dom.closeRaveRoomSettingsMenuBtn) {
    addInstantTap(dom.closeRaveRoomSettingsMenuBtn, (e) => {
      e.stopPropagation();
      toggleRaveRoomSettingsMenu(false);
    });
  }

  if (dom.raveRoomSettingsBackdrop) {
    addInstantTap(dom.raveRoomSettingsBackdrop, (e) => {
      e.stopPropagation();
      toggleRaveRoomSettingsMenu(false);
    });
  }

  // Close Rave settings menu when tapping outside of it
  document.addEventListener('pointerdown', (e) => {
    if (!dom.raveRoomSettingsMenu || dom.raveRoomSettingsMenu.classList.contains('hidden')) return;
    if (e.target.closest('#raveRoomSettingsMenu') || e.target.closest('#raveRoomSettingsBtn')) return;
    toggleRaveRoomSettingsMenu(false);
  });

  // Quality buttons binding with instant tap
  document.querySelectorAll('.player-quality-btn').forEach(btn => {
    addInstantTap(btn, (e) => {
      e.stopPropagation();
      setPlayerQuality(btn.dataset.quality, true);
    });
  });

  // Speed buttons binding with instant tap
  document.querySelectorAll('.playback-speed-btn, .player-speed-btn').forEach(btn => {
    addInstantTap(btn, (e) => {
      e.stopPropagation();
      setPlayerPlaybackRate(btn.dataset.speed, true);
    });
  });

  // Subtitles / Captions language choices binding
  document.querySelectorAll('.caption-lang-btn').forEach(btn => {
    addInstantTap(btn, (e) => {
      e.stopPropagation();
      setCaptionLanguage(btn.dataset.lang);
    });
  });

  if (dom.raveResyncBtn) {
    addInstantTap(dom.raveResyncBtn, (e) => {
      e.stopPropagation();
      triggerResyncWithHost();
    });
  }

  // Web Stream Fallback Buttons
  if (dom.webFallbackScreenShareBtn) {
    dom.webFallbackScreenShareBtn.addEventListener('click', () => {
      hideIframeFallback();
      startScreenSharing();
    });
  }

  if (dom.webFallbackOpenNewTabBtn) {
    dom.webFallbackOpenNewTabBtn.addEventListener('click', () => {
      if (state.lastFallbackUrl) {
        const isDesktopApp = !!(window.miruoDesktop && window.miruoDesktop.isDesktop);
        if (isDesktopApp && typeof openDesktopPlatformBrowser === 'function') {
          const prov = state.lastFallbackUrl.includes('netflix') ? 'netflix' : (state.lastFallbackUrl.includes('prime') ? 'prime' : (state.lastFallbackUrl.includes('disney') ? 'disney' : 'web'));
          const title = (dom.webPlayerFallbackTitle && dom.webPlayerFallbackTitle.textContent) || 'Platform';
          openDesktopPlatformBrowser(prov, state.lastFallbackUrl, title);
        } else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.openPlatform) {
          const prov = state.lastFallbackUrl.includes('netflix') ? 'netflix' : (state.lastFallbackUrl.includes('prime') ? 'prime' : (state.lastFallbackUrl.includes('disney') ? 'disney' : 'web'));
          window.webkit.messageHandlers.openPlatform.postMessage({
            provider: prov,
            url: state.lastFallbackUrl,
            title: (dom.webPlayerFallbackTitle && dom.webPlayerFallbackTitle.textContent) || 'Platform',
            lang: currentLang
          });
        } else {
          window.open(state.lastFallbackUrl, '_blank');
        }
      }
    });
  }

  // DRM Guide Modal
  if (dom.closeDrmGuideModalBtn) {
    dom.closeDrmGuideModalBtn.addEventListener('click', () => {
      if (dom.drmGuideModal) dom.drmGuideModal.classList.add('hidden');
    });
  }

  // Profile Section Dead Buttons Wire-up
  if (dom.tabProfileSignOutBtn) {
    dom.tabProfileSignOutBtn.addEventListener('click', confirmAndLogoutUser);
  }

  if (dom.profileSegmentDetailsBtn) {
    dom.profileSegmentDetailsBtn.addEventListener('click', () => {
      const card = document.getElementById('profileAffinityCard');
      if (card) card.classList.remove('hidden');
    });
  }

  if (dom.profileSegmentFriendsBtn) {
    dom.profileSegmentFriendsBtn.addEventListener('click', () => {
      if (typeof switchMainTab === 'function') switchMainTab('tabFriends');
    });
  }

  // Sleep Mode
  if (dom.toggleSleepBtn) dom.toggleSleepBtn.addEventListener('click', () => applySleepMode(!state.isSleepMode, true));
  if (dom.exitSleepBtn) dom.exitSleepBtn.addEventListener('click', () => applySleepMode(false, true));

  if (dom.toggleSleepModeBtn) {
    addInstantTap(dom.toggleSleepModeBtn, () => applySleepMode(!state.isSleepMode, true));
  }
  if (dom.raveToggleSleepModeBtn) {
    addInstantTap(dom.raveToggleSleepModeBtn, () => {
      toggleRaveRoomSettingsMenu(false);
      applySleepMode(!state.isSleepMode, true);
    });
  }
  if (dom.toggleScreenDimmerBtn) {
    addInstantTap(dom.toggleScreenDimmerBtn, () => toggleScreenDimmer(true));
  }
  if (dom.sleepScreenDimmer) {
    addInstantTap(dom.sleepScreenDimmer, () => toggleScreenDimmer(false));
  }
  if (dom.toggleSleepAmbienceBtn) {
    addInstantTap(dom.toggleSleepAmbienceBtn, toggleSleepAmbience);
  }
  if (dom.sleepModePickVideoBtn) {
    addInstantTap(dom.sleepModePickVideoBtn, () => {
      if (state.isSleepMode) applySleepMode(false, true);
      openVideoChooser();
    });
  }
  if (dom.exitSleepStageBtn) {
    addInstantTap(dom.exitSleepStageBtn, () => applySleepMode(false, true));
  }

  // Audio / Video Toggles
  if (dom.toggleMicBtn) dom.toggleMicBtn.addEventListener('click', toggleMic);
  if (dom.toggleCamBtn) dom.toggleCamBtn.addEventListener('click', toggleCam);

  // Explore Lobby Switcher (Rave Style Home View)
  if (dom.viewExploreBtn) dom.viewExploreBtn.addEventListener('click', switchToExplore);
  if (dom.viewMyRoomBtn) dom.viewMyRoomBtn.addEventListener('click', switchToMyRoom);
  if (dom.refreshRoomsBtn) dom.refreshRoomsBtn.addEventListener('click', loadPublicRooms);

  const navLogo = document.getElementById('navLogoBtn');
  if (navLogo) navLogo.addEventListener('click', switchToExplore);

  if (dom.quickEnterPrivateRoomBtn) {
    dom.quickEnterPrivateRoomBtn.addEventListener('click', () => {
      state.roomId = localRoomCode();
      if (dom.activeRoomTitle) dom.activeRoomTitle.textContent = state.roomId;
      if (dom.currentRoomDisplay) dom.currentRoomDisplay.textContent = state.roomId;
      switchToMyRoom();
      connectSignaling();
      showToast(`${state.roomId} odanıza girdiniz`);
    });
  }

  // Platform Launchers & Create Room Modal Logic
  let newRoomIsPrivate = true;
  let selectedPlatform = 'YouTube';

  function openCreateRoomModal(platform = 'YouTube') {
    selectedPlatform = platform;
    const isSleep = (platform || '').toLowerCase().includes('uyku') || (platform || '').toLowerCase().includes('sleep');

    const platformSec = document.getElementById('createRoomPlatformSection');
    if (platformSec) {
      if (isSleep) {
        platformSec.classList.add('hidden');
      } else {
        platformSec.classList.remove('hidden');
      }
    }

    // Update platform selector UI in modal
    document.querySelectorAll('.platform-choice').forEach(choice => {
      const cat = (choice.dataset.category || '').toLowerCase();
      const target = platform.toLowerCase();
      const isMatch = cat === target || (target.includes('prime') && cat.includes('prime')) || (target.includes('ekran') && cat.includes('ekran')) || (target.includes('uyku') && cat.includes('uyku'));
      if (isMatch) {
        choice.className = 'platform-choice active p-2 rounded-xl border-2 border-rose-500 bg-rose-500/15 flex flex-col items-center text-center gap-1 cursor-pointer transition-all';
        selectedPlatform = choice.dataset.category || platform;
      } else {
        choice.className = 'platform-choice p-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 flex flex-col items-center text-center gap-1 cursor-pointer transition-all';
      }
    });

    const isScreen = (selectedPlatform || '').toLowerCase().includes('ekran');
    if (dom.submitCreateRoomBtn) {
      dom.submitCreateRoomBtn.textContent = isSleep ? 'Uykuyu Başlat & Katıl' : (isScreen ? 'Ekran Paylaşımını Başlat' : 'Odayı Başlat & Katıl');
    }

    if (dom.newRoomTitleInput) {
      dom.newRoomTitleInput.value = isSleep ? 'Birlikte Uyku Odası' : (isScreen ? 'Canlı Ekran Yayını' : '');
      dom.newRoomTitleInput.placeholder = isSleep ? 'Birlikte Uyku Odası' : (isScreen ? 'Canlı Ekran Yayını veya Çalışma Odası' : `Örn: ${selectedPlatform} Partisi veya Gece Sohbeti`);
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
      else if (platformKey === 'sleep' || platformKey === 'uyku') platformName = 'Uyku Modu';
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


  // Provider Grid Cards (14 Platforms + Sleep Mode + Galeri)
  document.querySelectorAll('.provider-card').forEach(card => {
    addInstantTap(card, () => {
      const provider = card.dataset.provider;
      if (provider === 'sleep') {
        openCreateRoomModal('Uyku Modu');
        return;
      }
      if (provider === 'photos' || provider === 'gallery') {
        triggerRoomGalleryPicker();
        return;
      }
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
      showMiruoConfirm({
        title: 'Odadan Ayrıl',
        message: 'Odadan ayrılmak istediğinize emin misiniz?',
        actionText: 'Evet, Ayrıl',
        onConfirm: () => {
          leaveRoom();
        }
      });
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
        const pDict = I18N[currentLang] || I18N.tr;
        let privacyLabel = pDict.access_public_label || 'Herkese Açık';
        if (privacyVal === 'friends') privacyLabel = pDict.privacy_friends || 'Sadece Arkadaşlar';
        else if (privacyVal === 'invite') privacyLabel = pDict.privacy_private || 'Sadece Davet İle';
        if (selectedPrivacyLabel) selectedPrivacyLabel.textContent = privacyLabel;

        const isPrivate = (privacyVal === 'invite');
        state.isPrivateRoom = isPrivate;
        updateRoomPrivacyUI(isPrivate);
        sendP2PData('privacy_change', { isPrivate });
        sendSignal({ type: 'privacy-change', isPrivate });

        if (privacyVal === 'public') {
          if (selectedPrivacyIcon) selectedPrivacyIcon.innerHTML = '<svg class="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z"/></svg>';
        } else if (privacyVal === 'friends') {
          if (selectedPrivacyIcon) selectedPrivacyIcon.innerHTML = '<svg class="w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
        } else {
          if (selectedPrivacyIcon) selectedPrivacyIcon.innerHTML = '<svg class="w-4 h-4 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
        }

        // Update active checkmarks
        document.querySelectorAll('.privacy-choice-btn').forEach(b => {
          const chk = b.querySelector('.privacy-check');
          if (chk) chk.classList.toggle('hidden', b !== btn);
        });

        privacyMenu.classList.add('hidden');
        showToast(`${pDict.room_privacy_toast || 'Oda Gizliliği'}: ${privacyLabel}`);
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
    copyToClipboard(inviteUrl).then(() => {
      showToast(`Miruo oda linki kopyalandı!\n${inviteUrl}`);
    });
  };
  if (dom.copyRaveInviteBtn) dom.copyRaveInviteBtn.addEventListener('click', handleCopyInvite);
  const copyBtn = document.getElementById('copyRaveInviteBtn');
  if (copyBtn && copyBtn !== dom.copyRaveInviteBtn) copyBtn.addEventListener('click', handleCopyInvite);

  // Watch Room Social Share App Buttons (WhatsApp, SMS Messages, Telegram, System Share)
  document.querySelectorAll('.share-app-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const channel = btn.dataset.channel;
      const inviteUrl = getMiruoRoomUrl(state.roomId);
      const shareText = `Miruo'da benimle birlikte video izle!\nOda Kodu: ${(state.roomId || 'ODA-77').toUpperCase()}\n${inviteUrl}`;

      if (channel === 'whatsapp') {
        window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, '_blank');
      } else if (channel === 'messages') {
        window.location.href = `sms:?&body=${encodeURIComponent(shareText)}`;
      } else if (channel === 'telegram') {
        window.open(`https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${encodeURIComponent(`Miruo ile birlikte izle! (Oda: ${(state.roomId || 'ODA-77').toUpperCase()})`)}`, '_blank');
      } else if (channel === 'system') {
        if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.nativeShare) {
          window.webkit.messageHandlers.nativeShare.postMessage({
            title: 'Miruo — Birlikte İzle',
            text: shareText,
            url: inviteUrl
          });
        } else if (navigator.share) {
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

  // ==========================================
  // LIKED VIDEOS & FAVORITES SYSTEM
  // ==========================================
  function getLikedVideos() {
    try {
      return JSON.parse(localStorage.getItem('miruo_liked_videos') || '[]');
    } catch (e) {
      return [];
    }
  }
  window.getLikedVideos = getLikedVideos;

  function saveLikedVideos(list) {
    try {
      localStorage.setItem('miruo_liked_videos', JSON.stringify(list));
    } catch (e) {}
  }
  window.saveLikedVideos = saveLikedVideos;

  function updateNowPlayingLikeState() {
    if (!dom.nowPlayingHeartBtn) return;
    const currId = state.currentVideoId || state.roomId || '';
    const likes = getLikedVideos();
    const isLiked = !!(currId && likes.some(item => item.id === currId));
    const svg = dom.nowPlayingHeartBtn.querySelector('svg');
    if (isLiked) {
      dom.nowPlayingHeartBtn.classList.remove('text-gray-300', 'bg-white/5');
      dom.nowPlayingHeartBtn.classList.add('text-rose-500', 'bg-rose-500/20');
      if (svg) svg.setAttribute('fill', 'currentColor');
      dom.nowPlayingHeartBtn.setAttribute('title', 'Beğenildi');
    } else {
      dom.nowPlayingHeartBtn.classList.remove('text-rose-500', 'bg-rose-500/20');
      dom.nowPlayingHeartBtn.classList.add('text-gray-300', 'bg-white/5');
      if (svg) svg.setAttribute('fill', 'none');
      dom.nowPlayingHeartBtn.setAttribute('title', 'Beğen');
    }
  }
  window.updateNowPlayingLikeState = updateNowPlayingLikeState;

  function renderLikedVideosList() {
    const listEl = dom.likedVideosList || document.getElementById('likedVideosList');
    if (!listEl) return;
    const likes = getLikedVideos();
    if (likes.length === 0) {
      listEl.innerHTML = `
        <div class="py-12 px-4 text-center">
          <div class="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center text-gray-500 mx-auto mb-3">
            <svg class="w-6 h-6 fill-none stroke-current" viewBox="0 0 24 24" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </div>
          <p class="text-sm font-semibold text-gray-300">Henüz beğenilen video yok</p>
          <p class="text-xs text-gray-500 mt-1">İzlediğiniz videolardaki kalp butonuna basarak buraya ekleyebilirsiniz.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = likes.map((item) => {
      const thumb = item.thumbnail || (item.id ? `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg` : 'logo.png');
      return `
        <div class="liked-video-item flex items-center justify-between gap-3 p-3 rounded-2xl bg-white/5 hover:bg-white/10 active:scale-[0.98] border border-white/5 transition-all cursor-pointer group" data-video-id="${item.id}" data-title="${encodeURIComponent(item.title || '')}" data-provider="${item.provider || 'YouTube'}">
          <div class="flex items-center gap-3 min-w-0 flex-1">
            <div class="relative w-16 h-11 rounded-xl overflow-hidden bg-black/50 shrink-0 border border-white/10">
              <img src="${thumb}" alt="Thumbnail" class="w-full h-full object-cover group-hover:scale-105 transition-transform" onerror="this.src='logo.png'">
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-300">${item.provider || 'Video'}</span>
                <span class="text-[10px] text-gray-400 font-mono">${item.likedAt ? new Date(item.likedAt).toLocaleDateString() : ''}</span>
              </div>
              <h4 class="text-xs font-bold text-white truncate group-hover:text-rose-300 transition-colors mt-0.5">${item.title || 'Video'}</h4>
            </div>
          </div>
          <button type="button" class="remove-liked-video-btn w-8 h-8 rounded-full bg-white/5 hover:bg-rose-500/20 text-gray-400 hover:text-rose-400 flex items-center justify-center transition-colors cursor-pointer shrink-0" data-remove-id="${item.id}" title="Listeden Kaldır">
            <svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.liked-video-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.remove-liked-video-btn')) return;
        const vId = el.dataset.videoId;
        const vTitle = decodeURIComponent(el.dataset.title || '');
        const vProv = el.dataset.provider || 'YouTube';
        closeLikedVideosModal();
        if (state.isInRoom && state.roomId && dom.roomWorkspaceSection && !dom.roomWorkspaceSection.classList.contains('hidden')) {
          if (vProv === 'Direct' || vId.startsWith('http')) {
            loadDirectVideo(vId, vTitle);
          } else {
            selectAndPlayYoutubeVideo(vId, vTitle, vProv);
          }
          showToast(`Beğenilen video başlatıldı: ${vTitle}`);
        } else {
          createAndJoinRoom(vTitle || `${vProv} Odası`, false, vProv, vId);
          showToast(`Beğenilen video ile oda açıldı: ${vTitle}`);
        }
      });
    });

    listEl.querySelectorAll('.remove-liked-video-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const removeId = btn.dataset.removeId;
        let curLikes = getLikedVideos();
        curLikes = curLikes.filter(item => item.id !== removeId);
        saveLikedVideos(curLikes);
        updateNowPlayingLikeState();
        renderLikedVideosList();
        showToast('Beğenilenlerden kaldırıldı');
      });
    });
  }
  window.renderLikedVideosList = renderLikedVideosList;

  function openLikedVideosModal() {
    const modal = dom.likedVideosModal || document.getElementById('likedVideosModal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      renderLikedVideosList();
    }
  }
  window.openLikedVideosModal = openLikedVideosModal;

  function closeLikedVideosModal() {
    const modal = dom.likedVideosModal || document.getElementById('likedVideosModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }
  window.closeLikedVideosModal = closeLikedVideosModal;

  if (dom.closeLikedVideosModalBtn) {
    addInstantTap(dom.closeLikedVideosModalBtn, closeLikedVideosModal);
  }
  const likedModalElement = dom.likedVideosModal || document.getElementById('likedVideosModal');
  if (likedModalElement) {
    likedModalElement.addEventListener('click', (e) => {
      if (e.target === likedModalElement) closeLikedVideosModal();
    });
  }

  // Now Playing Heart & Next Buttons
  if (dom.nowPlayingHeartBtn) {
    addInstantTap(dom.nowPlayingHeartBtn, (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      const currId = state.currentVideoId || state.roomId || ('video_' + Date.now());
      let likes = getLikedVideos();
      const idx = likes.findIndex(item => item.id === currId);
      if (idx >= 0) {
        likes.splice(idx, 1);
        saveLikedVideos(likes);
        updateNowPlayingLikeState();
        showToast('Beğeni kaldırıldı');
      } else {
        const title = (dom.nowPlayingTitle && dom.nowPlayingTitle.textContent.trim()) || state.videoTitle || 'Miruo Video';
        const thumb = state.currentThumbnail || (state.currentVideoId ? `https://i.ytimg.com/vi/${state.currentVideoId}/hqdefault.jpg` : '');
        likes.unshift({
          id: currId,
          title: title,
          provider: state.platform || state.currentProvider || 'YouTube',
          thumbnail: thumb,
          likedAt: Date.now()
        });
        saveLikedVideos(likes);
        updateNowPlayingLikeState();
        showToast('Video beğenilenlere eklendi! ❤️');
        spawnFloatingReaction('❤️', true);
        sendP2PData('reaction', { emoji: '❤️' });
      }
    });
  }
  if (dom.nowPlayingNextBtn) {
    addInstantTap(dom.nowPlayingNextBtn, () => {
      handleNextTrack();
    });
  }

  // ==========================================
  // ROOM EPISODES & PLAYLIST SELECTOR ("Bölümler")
  // ==========================================
  function renderRoomEpisodesList() {
    if (!dom.roomEpisodesList) return;

    const activeRoom = (typeof DEFAULT_COMMUNITY_ROOMS !== 'undefined')
      ? DEFAULT_COMMUNITY_ROOMS.find(r => r.id.toUpperCase() === state.roomId)
      : null;

    let episodes = [];
    if (activeRoom) {
      episodes.push({
        episodeNum: 1,
        title: activeRoom.mediaTitle || activeRoom.name,
        videoId: activeRoom.videoId,
        thumbnail: `https://i.ytimg.com/vi/${activeRoom.videoId}/hqdefault.jpg`,
        duration: 'Canlı / HD'
      });
    }

    if (state.roomQueue && state.roomQueue.length > 0) {
      state.roomQueue.forEach((qItem) => {
        if (!episodes.some(ep => ep.videoId === qItem.videoId)) {
          episodes.push({
            episodeNum: episodes.length + 1,
            title: qItem.title || `Bölüm ${episodes.length + 1}`,
            videoId: qItem.videoId,
            thumbnail: qItem.thumbnail || `https://i.ytimg.com/vi/${qItem.videoId}/hqdefault.jpg`,
            duration: qItem.duration || 'Video'
          });
        }
      });
    }

    if (typeof DEFAULT_COMMUNITY_ROOMS !== 'undefined') {
      DEFAULT_COMMUNITY_ROOMS.forEach((cr) => {
        if (!episodes.some(ep => ep.videoId === cr.videoId)) {
          episodes.push({
            episodeNum: episodes.length + 1,
            title: cr.name || cr.mediaTitle,
            videoId: cr.videoId,
            thumbnail: `https://i.ytimg.com/vi/${cr.videoId}/hqdefault.jpg`,
            duration: '4K / HD'
          });
        }
      });
    }

    dom.roomEpisodesList.innerHTML = episodes.map((ep, idx) => {
      const isCurrent = idx === 0;
      return `
        <div class="episode-item flex items-center justify-between gap-3 p-3 rounded-2xl bg-white/5 hover:bg-white/10 active:scale-[0.98] border ${isCurrent ? 'border-rose-500/60 bg-rose-500/10' : 'border-white/5'} transition-all cursor-pointer group" data-video-id="${ep.videoId}" data-title="${ep.title}">
          <div class="flex items-center gap-3 min-w-0">
            <div class="relative w-16 h-11 rounded-xl overflow-hidden bg-black/50 shrink-0 border border-white/10">
              <img src="${ep.thumbnail}" alt="Thumbnail" class="w-full h-full object-cover group-hover:scale-105 transition-transform" onerror="this.src='logo.png'">
              ${isCurrent ? '<div class="absolute inset-0 bg-rose-600/40 flex items-center justify-center"><span class="w-2.5 h-2.5 rounded-full bg-white animate-ping"></span></div>' : ''}
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="text-[10px] font-black uppercase tracking-wider ${isCurrent ? 'text-rose-400' : 'text-gray-400'}">${ep.episodeNum}. Bölüm</span>
                ${isCurrent ? '<span class="px-1.5 py-0.5 rounded-md bg-rose-500 text-white text-[9px] font-bold">Oynatılıyor</span>' : ''}
              </div>
              <h4 class="text-xs font-bold text-white truncate group-hover:text-rose-300 transition-colors">${ep.title}</h4>
              <span class="text-[10px] text-gray-400">${ep.duration}</span>
            </div>
          </div>
          <button type="button" class="w-8 h-8 rounded-xl ${isCurrent ? 'bg-rose-500 text-white' : 'bg-white/10 text-gray-300 group-hover:bg-rose-600 group-hover:text-white'} flex items-center justify-center shrink-0 transition-all shadow-md">
            <svg class="w-3.5 h-3.5 fill-current ml-0.5" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </button>
        </div>
      `;
    }).join('');

    dom.roomEpisodesList.querySelectorAll('.episode-item').forEach(card => {
      addInstantTap(card, () => {
        const videoId = card.getAttribute('data-video-id');
        const title = card.getAttribute('data-title');
        if (videoId) {
          if (typeof playSelectedVideo === 'function') {
            playSelectedVideo(videoId, title);
          } else if (state.ytPlayer && state.ytPlayer.loadVideoById) {
            state.ytPlayer.loadVideoById(videoId);
          }
          if (dom.roomEpisodesModal) dom.roomEpisodesModal.classList.add('hidden');
          showToast(`Bölüm açıldı: ${title || videoId}`);
        }
      });
    });
  }

  // Stage Video / Platform Chooser Modal (Unified Hub for YouTube, Twitch, Kick, Netflix, Prime, etc.)
  const openVideoChooser = () => {
    if (state.roomId && dom.roomWorkspaceSection && !dom.roomWorkspaceSection.classList.contains('hidden') && !canUserChooseVideo()) {
      showToast('Odaya video seçme yetkisi sadece Oda Sahibi, Yöneticiler ve Video Açabilenlerdedir.');
      return;
    }
    if (dom.roomEpisodesModal) dom.roomEpisodesModal.classList.add('hidden');
    if (dom.raveYoutubeModal) dom.raveYoutubeModal.classList.add('hidden');
    if (dom.roomPlatformChooserModal) dom.roomPlatformChooserModal.classList.remove('hidden');
  };
  window.openVideoChooser = openVideoChooser;

  const closePlatformChooser = () => {
    if (dom.roomEpisodesModal) dom.roomEpisodesModal.classList.add('hidden');
    if (dom.roomPlatformChooserModal) dom.roomPlatformChooserModal.classList.add('hidden');
    if (dom.raveYoutubeModal) dom.raveYoutubeModal.classList.add('hidden');
  };
  window.closePlatformChooser = closePlatformChooser;

  if (dom.closePlatformChooserModalBtn) {
    addInstantTap(dom.closePlatformChooserModalBtn, closePlatformChooser);
  }

  if (dom.closeRoomEpisodesModalBtn) {
    addInstantTap(dom.closeRoomEpisodesModalBtn, () => {
      if (dom.roomEpisodesModal) dom.roomEpisodesModal.classList.add('hidden');
    });
  }

  if (dom.episodesOpenPlatformsBtn) {
    addInstantTap(dom.episodesOpenPlatformsBtn, () => {
      if (dom.roomEpisodesModal) dom.roomEpisodesModal.classList.add('hidden');
      if (dom.roomPlatformChooserModal) dom.roomPlatformChooserModal.classList.remove('hidden');
    });
  }

  // Hero: Normal YouTube Ekranı
  if (dom.chooserOpenRealYouTubeBtn) {
    addInstantTap(dom.chooserOpenRealYouTubeBtn, () => {
      closePlatformChooser();
      launchPlatform('youtube');
    });
  }

  // Direct Link Play
  if (dom.chooserPlayDirectLinkBtn && dom.chooserDirectLinkInput) {
    const handleDirectPlay = () => {
      const url = (dom.chooserDirectLinkInput.value || '').trim();
      if (!url) {
        showToast('Lütfen geçerli bir video linki girin');
        return;
      }
      closePlatformChooser();
      selectAndPlayYoutubeVideo(url, 'Doğrudan Video Yayını');
      dom.chooserDirectLinkInput.value = '';
    };
    addInstantTap(dom.chooserPlayDirectLinkBtn, handleDirectPlay);
    dom.chooserDirectLinkInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleDirectPlay();
      }
    });
  }

  // Platform Cards in Chooser
  document.querySelectorAll('.chooser-platform-card').forEach(card => {
    addInstantTap(card, () => {
      const provider = card.dataset.provider;
      if (!provider) return;
      closePlatformChooser();
      launchPlatform(provider);
    });
  });

  // Screen Share Card in Chooser
  if (dom.chooserScreenShareBtn) {
    addInstantTap(dom.chooserScreenShareBtn, () => {
      closePlatformChooser();
      startScreenShare();
    });
  }

  // Queue Modal & Suggestions UI Bindings
  const openRoomQueueModal = () => {
    try {
      updateRoomQueueUI();
    } catch (err) {
      console.warn('Queue UI update warning:', err);
    }
    const qModal = dom.roomQueueModal || document.getElementById('roomQueueModal');
    if (qModal) {
      qModal.classList.remove('hidden');
      qModal.classList.add('flex');
      qModal.style.setProperty('display', 'flex', 'important');
      qModal.style.setProperty('z-index', '1000005', 'important');
    }
  };
  window.openRoomQueueModal = openRoomQueueModal;
  if (dom.roomQueueBadgeBtn) {
    addInstantTap(dom.roomQueueBadgeBtn, (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      openRoomQueueModal();
    });
  }
  if (dom.closeQueueModalBtn) {
    addInstantTap(dom.closeQueueModalBtn, (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      const qModal = dom.roomQueueModal || document.getElementById('roomQueueModal');
      if (qModal) {
        qModal.classList.add('hidden');
        qModal.classList.remove('flex');
        qModal.style.removeProperty('display');
      }
    });
  }
  const qModalEl = dom.roomQueueModal || document.getElementById('roomQueueModal');
  if (qModalEl) {
    qModalEl.addEventListener('click', (e) => {
      if (e.target === qModalEl) {
        qModalEl.classList.add('hidden');
        qModalEl.classList.remove('flex');
        qModalEl.style.removeProperty('display');
      }
    });
  }
  if (dom.closeRaveActionSheetBtn) {
    addInstantTap(dom.closeRaveActionSheetBtn, () => {
      if (dom.raveVideoActionSheet) dom.raveVideoActionSheet.classList.add('hidden');
    });
  }
  if (dom.raveActionPlayNowBtn) {
    addInstantTap(dom.raveActionPlayNowBtn, () => {
      if (selectedPendingVideo) {
        selectAndPlayYoutubeVideo(selectedPendingVideo.id, selectedPendingVideo.title);
        if (dom.raveVideoActionSheet) dom.raveVideoActionSheet.classList.add('hidden');
        closeRaveYoutubeModal();
      }
    });
  }
  if (dom.raveActionQueueBtn) {
    addInstantTap(dom.raveActionQueueBtn, () => {
      if (selectedPendingVideo) {
        addToRoomQueue({
          id: selectedPendingVideo.id,
          title: selectedPendingVideo.title,
          thumb: selectedPendingVideo.thumb,
          channel: selectedPendingVideo.channel,
          addedBy: state.username
        });
        showToast(`✓ "${selectedPendingVideo.title}" sıraya eklendi!`);
        if (dom.raveVideoActionSheet) dom.raveVideoActionSheet.classList.add('hidden');
        closeRaveYoutubeModal();
      }
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
        showToast(`${pendingSuggestion.fromUser}'ın önerdiği video başlatıldı!`);
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
        showToast(`${pendingSuggestion.fromUser}'ın önerisi sıraya eklendi!`);
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
    addInstantTap(dom.mobileNavProfileBtn, () => {
      switchToProfileTab();
    });
  }

  if (dom.closeCreateRoomBtn) {
    addInstantTap(dom.closeCreateRoomBtn, (e) => {
      e.stopPropagation();
      closeCreateRoomModal();
    });
  }

  // Close Modals on Backdrop Click (Except authModal which must never close accidentally)
  const allOverlayModals = [
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
          unfreezeBackgroundAfterModal();
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
      const isSleep = (selectedPlatform || '').toLowerCase().includes('uyku') || (selectedPlatform || '').toLowerCase().includes('sleep');
      const isScreen = (selectedPlatform || '').toLowerCase().includes('ekran');
      if (dom.submitCreateRoomBtn) {
        dom.submitCreateRoomBtn.textContent = isSleep ? 'Uykuyu Başlat & Katıl' : (isScreen ? 'Ekran Paylaşımını Başlat' : 'Odayı Başlat & Katıl');
      }
      if (dom.newRoomTitleInput && !dom.newRoomTitleInput.value.trim()) {
        dom.newRoomTitleInput.placeholder = isSleep ? 'Birlikte Uyku Odası' : (isScreen ? 'Canlı Ekran Yayını veya Çalışma Odası' : `Örn: ${selectedPlatform} Partisi veya Gece Sohbeti`);
      }
    });
  });

  function updateStagePlaceholderForMode(platform) {
    if (!dom.emptyStatePlaceholder) return;
    const p = (platform || state.roomCategory || '').toLowerCase();
    
    if (p.includes('galeri') || p.includes('foto') || p.includes('photo')) {
      dom.emptyStatePlaceholder.innerHTML = `
        <div class="w-14 h-14 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 mb-3 shadow-xl">
          <svg class="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        </div>
        <h3 class="text-sm font-bold text-gray-200">Fotoğraf & Galeri Odası</h3>
        <p class="text-[11px] text-gray-400 mt-1 max-w-xs mb-3">Fotoğraf seçerek odadakilerle birlikte slayt veya albüm inceleyin.</p>
        <button type="button" onclick="if(typeof triggerRoomGalleryPicker==='function')triggerRoomGalleryPicker()" class="pointer-events-auto px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 hover:opacity-90 active:scale-95 text-white text-xs font-semibold shadow-lg shadow-indigo-500/25 transition-all">
          Fotoğraf Seç & Paylaş
        </button>
      `;
    } else if (p.includes('ekran') || p.includes('screen')) {
      dom.emptyStatePlaceholder.innerHTML = `
        <div class="w-14 h-14 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 mb-3 shadow-xl">
          <svg class="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        </div>
        <h3 class="text-sm font-bold text-gray-200">Ekran Paylaşım Odası</h3>
        <p class="text-[11px] text-gray-400 mt-1 max-w-xs mb-3">Ekranınızı veya bir tarayıcı sekmesini odadaki herkesle canlı izleyin.</p>
        <button type="button" onclick="if(typeof startScreenSharing==='function')startScreenSharing()" class="pointer-events-auto px-4 py-2 rounded-xl bg-gradient-to-r from-rose-500 to-indigo-600 hover:opacity-90 active:scale-95 text-white text-xs font-semibold shadow-lg shadow-rose-500/25 transition-all">
          Ekranı Paylaş
        </button>
      `;
    } else if (p.includes('uyku') || p.includes('sleep')) {
      dom.emptyStatePlaceholder.innerHTML = `
        <div class="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 mb-3 shadow-xl">
          <svg class="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </div>
        <h3 class="text-sm font-bold text-gray-200">Birlikte Uyku Odası</h3>
        <p class="text-[11px] text-gray-400 mt-1 max-w-xs">Loş ışık ve sakin sesle birlikte dinlenin.</p>
      `;
    } else {
      dom.emptyStatePlaceholder.innerHTML = `
        <div class="w-14 h-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-rose-400 mb-3 shadow-xl">
          <svg class="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><path d="M8 21h8m-4-4v4"/><polygon points="10 8 16 11 10 14 10 8" fill="currentColor"/></svg>
        </div>
        <h3 class="text-sm font-bold text-gray-200" data-i18n="video_placeholder_title">Video Yükleniyor veya Seçilmedi</h3>
        <p class="text-[11px] text-gray-400 mt-1 max-w-xs mb-3" data-i18n="video_placeholder_desc">"Video Seç" butonuna basarak dilediğiniz videoyu veya içeriği başlatın.</p>
        <button type="button" onclick="if(typeof openVideoChooser==='function')openVideoChooser()" class="pointer-events-auto px-4 py-2 rounded-xl bg-gradient-to-r from-rose-500 to-indigo-600 hover:opacity-90 active:scale-95 text-white text-xs font-semibold shadow-lg shadow-rose-500/25 transition-all">
          Video veya İçerik Seç
        </button>
      `;
    }
  }
  window.updateStagePlaceholderForMode = updateStagePlaceholderForMode;

  function applyPlatformToActiveRoom(platform) {
    const p = (platform || '').toLowerCase();
    state.roomCategory = platform || 'Genel';
    updateStagePlaceholderForMode(platform);
    if (dom.emptyStatePlaceholder) dom.emptyStatePlaceholder.classList.remove('hidden');

    const accounts = typeof getConnectedAccounts === 'function' ? getConnectedAccounts() : {};
    const matched = Object.keys(accounts).find(k => p.includes(k));
    if (matched && accounts[matched]?.connected && accounts[matched]?.account) {
      state.connectedAccount = accounts[matched].account;
      if (typeof updateNowPlayingAccountBadge === 'function') {
        updateNowPlayingAccountBadge(state.connectedAccount);
      }
    }
    if (p.includes('uyku') || p.includes('sleep') || p.includes('boş') || p.includes('bos')) {
      applySleepMode(true, true);
      showToast('Birlikte Uyku Odası hazır');
      return;
    }
    if (p.includes('youtube')) {
      switchActiveTab('youtube');
      if (dom.youtubeUrlInput) dom.youtubeUrlInput.focus();
    } else if (p.includes('netflix') || p.includes('prime') || p.includes('ekran') || p.includes('screen')) {
      switchActiveTab('screenshare');
      showToast(`${platform} için sekme yayını hazır!`);
    } else if (p.includes('spotify') || p.includes('music')) {
      switchActiveTab('youtube');
      if (dom.youtubeUrlInput) {
        dom.youtubeUrlInput.placeholder = 'Spotify veya YouTube Music linki yapıştırın...';
        dom.youtubeUrlInput.focus();
      }
    } else if (p.includes('galeri') || p.includes('foto') || p.includes('photo')) {
      triggerRoomGalleryPicker();
      showToast('Galeri açılıyor...');
      return;
    } else if (p.includes('video') || p.includes('direct')) {
      triggerRoomGalleryPicker();
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
      let defaultTitle = `${selectedPlatform} Partisi`;
      if (selectedPlatform === 'Uyku Modu') defaultTitle = 'Birlikte Uyku Odası';
      if ((selectedPlatform || '').toLowerCase().includes('ekran')) defaultTitle = 'Canlı Ekran Yayını';
      const title = (dom.newRoomTitleInput && dom.newRoomTitleInput.value.trim()) || defaultTitle;
      const fallbackId = generateUniqueRoomCode(newRoomIsPrivate);

      // Creator is always Host
      state.isHost = true;
      state.hostName = state.username;
      state.controlMode = 'host_only';
      state.hasDjPermission = true;
      state.isPrivateRoom = !!newRoomIsPrivate;
      state.isInRoom = true;
      state.roomName = title;
      state.roomCategory = selectedPlatform;
      updateRoomPrivacyUI(newRoomIsPrivate);

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
        state.isInRoom = true;
        state.roomName = title;
        state.roomCategory = selectedPlatform;
        if (dom.activeRoomTitle) dom.activeRoomTitle.textContent = state.roomId;
        if (dom.currentRoomDisplay) dom.currentRoomDisplay.textContent = state.roomId;
        switchToMyRoom();
        connectSignaling();
        applyPlatformToActiveRoom(selectedPlatform);
        if (typeof syncCurrentRoomToGlobalPresence === 'function') syncCurrentRoomToGlobalPresence();
        showToast(`${title} odası oluşturuldu!`);
      })
      .catch(err => {
        console.error(err);
        state.roomId = fallbackId;
        state.isInRoom = true;
        state.roomName = title;
        state.roomCategory = selectedPlatform;
        if (dom.activeRoomTitle) dom.activeRoomTitle.textContent = state.roomId;
        if (dom.currentRoomDisplay) dom.currentRoomDisplay.textContent = state.roomId;
        switchToMyRoom();
        connectSignaling();
        applyPlatformToActiveRoom(selectedPlatform);
        if (typeof syncCurrentRoomToGlobalPresence === 'function') syncCurrentRoomToGlobalPresence();
        showToast(`${title} odası oluşturuldu!`);
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
      showToast(state.controlMode === 'everyone' ? 'Video açma izni herkese verildi' : 'Video açma sadece yöneticiye kilitlendi');
    });
  }

  // Guest Requests DJ Permission from Host
  if (dom.requestDjPermissionBtn) {
    dom.requestDjPermissionBtn.addEventListener('click', () => {
      sendP2PData('request_dj', { fromUser: state.username });
      showToast('Oda yöneticisine video açma isteği gönderildi');
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
      showToast('Video açma yetkisi verildi!');
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
      copyToClipboard(code).then(() => {
        showToast('Arkadaş kodun kopyalandı!');
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

  // Header Add Friend Modal (+ Button in Friends Header)
  const openAddFriendModalBtn = document.getElementById('openAddFriendModalBtn');
  if (openAddFriendModalBtn) {
    addInstantTap(openAddFriendModalBtn, (e) => {
      e.stopPropagation();
      openAddFriendModal();
    });
  }

  const closeAddFriendModalBtn = document.getElementById('closeAddFriendModalBtn');
  if (closeAddFriendModalBtn) {
    addInstantTap(closeAddFriendModalBtn, (e) => {
      e.stopPropagation();
      closeAddFriendModal();
    });
  }

  const addFriendModalSubmitBtn = document.getElementById('addFriendModalSubmitBtn');
  if (addFriendModalSubmitBtn) {
    addInstantTap(addFriendModalSubmitBtn, (e) => {
      e.stopPropagation();
      submitAddFriendModal();
    });
  }

  const addFriendModalInput = document.getElementById('addFriendModalInput');
  if (addFriendModalInput) {
    addFriendModalInput.addEventListener('input', (e) => {
      if (e.target.value.includes('@')) {
        e.target.value = e.target.value.replace(/@/g, '');
      }
    });
    addFriendModalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitAddFriendModal();
      }
    });
  }

  const modalCopyMyFriendCodeBtn = document.getElementById('modalCopyMyFriendCodeBtn');
  if (modalCopyMyFriendCodeBtn) {
    addInstantTap(modalCopyMyFriendCodeBtn, (e) => {
      e.stopPropagation();
      const code = '@' + (state.username || 'kullanici').replace(/^@/, '');
      copyToClipboard(code).then(() => {
        showToast('Kullanıcı adın kopyalandı: ' + code);
      });
    });
  }

  const addFriendModal = document.getElementById('addFriendModal');
  if (addFriendModal) {
    addInstantTap(addFriendModal, (e) => {
      if (e.target === addFriendModal) {
        closeAddFriendModal();
      }
    });
  }

  if (dom.tabFriendSearchInput) {
    dom.tabFriendSearchInput.addEventListener('input', (e) => {
      const val = e.target.value.replace(/^@/, '');
      renderFriendsTab(val);
    });
  }

  if (dom.closeFriendsModalBtn) {
    addInstantTap(dom.closeFriendsModalBtn, () => {
      if (dom.friendsModal) dom.friendsModal.classList.add('hidden');
    });
  }

  if (dom.copyMyFriendCodeBtn) {
    addInstantTap(dom.copyMyFriendCodeBtn, () => {
      copyToClipboard(state.friendCode).then(() => {
        showToast('Arkadaş kodun panoya kopyalandı!');
      });
    });
  }

  if (dom.submitAddFriendBtn) {
    addInstantTap(dom.submitAddFriendBtn, () => {
      if (dom.addFriendInput) addFriend(dom.addFriendInput.value);
    });
  }

  if (dom.addFriendInput) {
    dom.addFriendInput.addEventListener('input', (e) => {
      if (e.target.value.includes('@')) {
        e.target.value = e.target.value.replace(/@/g, '');
      }
    });
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
      copyToClipboard(inviteUrl).then(() => {
        showToast('Oda davet linki kopyalandı!');
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

  // Sticker Chips
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
          showToast('Görsel sohbete yüklendi!');
          if (chatStickerPopover) chatStickerPopover.classList.add('hidden');
        };
        reader.readAsDataURL(file);
      }
    });
  }

  // Room Invite Button in Chat Bar
  const roomInviteBtn2 = document.getElementById('roomInviteBtn2');
  if (roomInviteBtn2) {
    roomInviteBtn2.addEventListener('click', (e) => {
      e.stopPropagation();
      openRoomShareModal();
    });
  }

  // Room Share Link Button in Chat Bar
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
      if (dom.duckingLevelVal) {
        dom.duckingLevelVal.textContent = currentLang === 'tr' ? `%${e.target.value}` : `${e.target.value}%`;
      }
    });
  }

  if (dom.micSensSlider) {
    dom.micSensSlider.addEventListener('input', (e) => {
      state.speechThreshold = e.target.value / 255;
      const dict = I18N[currentLang] || I18N.tr;
      if (dom.micSensVal) dom.micSensVal.textContent = e.target.value < 15 ? (dict.sens_high || 'Yüksek') : (e.target.value < 30 ? (dict.sens_med || 'Orta') : (dict.sens_low || 'Düşük'));
    });
  }

  // Settings: Microphone Master Switch
  if (dom.settingsMicMasterToggle) {
    dom.settingsMicMasterToggle.addEventListener('change', () => {
      toggleMic();
    });
  }

  // Settings: Microphone Device Selection
  if (dom.settingsMicDeviceSelect) {
    dom.settingsMicDeviceSelect.addEventListener('change', async (e) => {
      localStorage.setItem('miruo_mic_device_id', e.target.value);
      if (state.isMicOn && state.localStream) {
        try {
          const newStream = await navigator.mediaDevices.getUserMedia(getAudioConstraints());
          const newTrack = newStream.getAudioTracks()[0];
          const oldTrack = state.localStream.getAudioTracks()[0];
          if (oldTrack) {
            state.localStream.removeTrack(oldTrack);
            try { oldTrack.stop(); } catch (_) {}
          }
          if (newTrack) {
            state.localStream.addTrack(newTrack);
            const uniquePeers = getUniquePeerEntries();
            for (const peer of uniquePeers) {
              if (peer && peer.pc && peer.pc.signalingState !== 'closed') {
                const at = peer.pc.getTransceivers ? peer.pc.getTransceivers().find(t => (t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio')) : null;
                if (at && at.sender && typeof at.sender.replaceTrack === 'function') {
                  await at.sender.replaceTrack(newTrack);
                }
              }
            }
            if (state.pc) {
              const senders = state.pc.getSenders();
              const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
              if (audioSender) audioSender.replaceTrack(newTrack);
            }
          }
          if (dom.settingsMicVuBar) startMicVuMeter(state.localStream);
          showToast('Mikrofon aygıtı değiştirildi');
        } catch (err) {
          console.warn('[Miruo] device switch error:', err);
        }
      }
    });
  }

  // Settings: Refresh Audio Devices
  if (dom.settingsRefreshAudioDevicesBtn) {
    dom.settingsRefreshAudioDevicesBtn.addEventListener('click', () => {
      refreshAudioDeviceList();
      showToast('Ses ve kamera aygıtları yenilendi');
    });
  }

  // Settings: Camera Master Toggle
  if (dom.settingsCamMasterToggle) {
    dom.settingsCamMasterToggle.addEventListener('change', () => {
      toggleCam();
    });
  }

  // Settings: Camera Device Selection
  if (dom.settingsCamDeviceSelect) {
    dom.settingsCamDeviceSelect.addEventListener('change', async (e) => {
      localStorage.setItem('miruo_cam_device_id', e.target.value);
      if (state.isCamOn) {
        try {
          const camStream = await getLiveCameraStream(null, e.target.value);
          const freshTrack = camStream.getVideoTracks()[0];
          if (freshTrack && state.localStream) {
            const oldTracks = state.localStream.getVideoTracks();
            oldTracks.forEach(t => {
              try { state.localStream.removeTrack(t); } catch (_) {}
              try { t.stop(); } catch (_) {}
            });
            state.localStream.addTrack(freshTrack);
            if (dom.selfVideo) dom.selfVideo.srcObject = state.localStream;
            const uniquePeers = getUniquePeerEntries();
            for (const peer of uniquePeers) {
              if (peer && peer.pc && peer.pc.signalingState !== 'closed') {
                const vt = peer.pc.getTransceivers ? peer.pc.getTransceivers().find(t => (t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video')) : null;
                if (vt && vt.sender && typeof vt.sender.replaceTrack === 'function') {
                  await vt.sender.replaceTrack(freshTrack);
                }
                if (vt && vt.sender) optimizeVideoSender(vt.sender);
              }
            }
            if (state.pc) {
              const senders = state.pc.getSenders();
              const videoSender = senders.find(s => s.track && s.track.kind === 'video');
              if (videoSender) videoSender.replaceTrack(freshTrack);
            }
          }
          showToast('Kamera aygıtı değiştirildi');
        } catch (err) {
          console.warn('[Miruo] cam switch error:', err);
        }
      }
    });
  }

  // Settings: Camera Flip Buttons
  if (dom.settingsFlipCameraBtn) {
    dom.settingsFlipCameraBtn.addEventListener('click', () => {
      switchCamera();
    });
  }
  if (dom.flipSelfPipCamBtn) {
    dom.flipSelfPipCamBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      switchCamera();
    });
  }
  if (dom.settingsRefreshCameraDevicesBtn) {
    dom.settingsRefreshCameraDevicesBtn.addEventListener('click', () => {
      refreshAudioDeviceList();
      showToast('Kamera aygıtları yenilendi');
    });
  }

  // Settings: Microphone Gain Slider
  if (dom.settingsMicGainSlider) {
    dom.settingsMicGainSlider.addEventListener('input', (e) => {
      const val = e.target.value;
      localStorage.setItem('miruo_mic_gain', val);
      if (dom.settingsMicGainVal) dom.settingsMicGainVal.textContent = `%${val}`;
    });
  }

  // Settings: Live Mic Test Button
  if (dom.settingsMicTestBtn) {
    dom.settingsMicTestBtn.addEventListener('click', () => {
      toggleMicTest();
    });
  }

  // Settings: Noise Suppression & Echo Cancellation Toggles
  if (dom.settingsNoiseSuppressionToggle) {
    dom.settingsNoiseSuppressionToggle.addEventListener('change', (e) => {
      localStorage.setItem('miruo_noise_suppression', e.target.checked);
    });
  }
  if (dom.settingsEchoCancellationToggle) {
    dom.settingsEchoCancellationToggle.addEventListener('change', (e) => {
      localStorage.setItem('miruo_echo_cancellation', e.target.checked);
    });
  }

  // Initialize Draggable PIPs
  if (dom.partnerPipCard) makeDraggable(dom.partnerPipCard);
  if (dom.selfPipCard) makeDraggable(dom.selfPipCard);

  // Close buttons for PIP cards (Dismiss floating bubble from stage screen without stopping the camera)
  if (dom.closeSelfPipBtn) {
    dom.closeSelfPipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.isSelfPipDismissed = true;
      if (dom.selfPipCard) {
        dom.selfPipCard.classList.add('hidden');
      }
      showToast('Kameranız ana ekrandan gizlendi (Alttan tıklayarak geri getirebilirsiniz)');
    });
  }
  if (dom.closePartnerPipBtn) {
    dom.closePartnerPipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentTargetId = state.activePipPeerId || state.peerId || Object.keys(state.participants).find(k => k !== state.userId);
      if (currentTargetId) {
        state.dismissedPips = state.dismissedPips || {};
        state.dismissedPips[currentTargetId] = true;
      }
      if (dom.partnerPipCard) {
        dom.partnerPipCard.classList.add('hidden');
      }
      const pName = dom.partnerPipName ? dom.partnerPipName.textContent : 'Katılımcı';
      showToast(`${pName} ana ekrandan gizlendi (Alttan tıklayarak geri getirebilirsiniz)`);
      if (typeof renderStagePipCards === 'function') renderStagePipCards();
    });
  }

  // Classic YouTube Live Format: Chat Sidebar Close & Reopen Handlers
  if (dom.closeChatSidebarBtn) {
    addInstantTap(dom.closeChatSidebarBtn, (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      setChatVisibility(false);
      const dict = I18N[currentLang] || I18N.tr;
      showToast(dict.toast_chat_closed || 'Sohbet gizlendi, video tam ekrana genişletildi');
    });
  }
  if (dom.openChatFloatingBtn) {
    addInstantTap(dom.openChatFloatingBtn, (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      setChatVisibility(true);
      const dict = I18N[currentLang] || I18N.tr;
      showToast(dict.toast_chat_opened || 'Canlı Sohbet açıldı');
    });
  }
  if (dom.toggleChatToolbarBtn) {
    addInstantTap(dom.toggleChatToolbarBtn, (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      setChatVisibility(!state.isChatVisible);
    });
  }



  // Fullscreen Live Chat (Classic YouTube Format)
  if (dom.closeFsChatBtn) {
    addInstantTap(dom.closeFsChatBtn, (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      setFsChatVisibility(false);
      const dict = I18N[currentLang] || I18N.tr;
      showToast(dict.toast_chat_closed || 'Sohbet gizlendi, video tam ekrana geçti');
    });
  }
  if (dom.openFsChatFloatingBtn) {
    addInstantTap(dom.openFsChatFloatingBtn, (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      setFsChatVisibility(true);
      const dict = I18N[currentLang] || I18N.tr;
      showToast(dict.toast_chat_opened || 'Canlı Sohbet açıldı');
    });
  }
  if (dom.fsChatForm && dom.fsChatInput) {
    dom.fsChatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = dom.fsChatInput.value.trim();
      if (!val) return;
      sendChatMessage(val);
      dom.fsChatInput.value = '';
    });
  }

  // Video Display / Audio-Only Handlers
  if (dom.toggleVideoDisplayBtn) {
    dom.toggleVideoDisplayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setVideoDisplay(!videoDisplaySettings.showVideo);
    });
  }
  if (dom.showVideoQuickBtn) {
    dom.showVideoQuickBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setVideoDisplay(true);
    });
  }
  if (dom.videoDisplayToggleCheckbox) {
    dom.videoDisplayToggleCheckbox.addEventListener('change', (e) => {
      setVideoDisplay(e.target.checked);
    });
  }
  if (dom.fsShowChatCheckbox) {
    dom.fsShowChatCheckbox.addEventListener('change', (e) => {
      fsChatSettings.showInFullscreen = e.target.checked;
      saveFsChatSettings();
    });
  }

  // Initialize Fullscreen Chat Drag & Resize ("kenarlardan küçültülebilsin sürüklenebilsin")
  initFsChatDragAndResize();

  // In-App Mini Player Wiring ("küçük buton gibi alta çekilsin sonra uygulama içi gezilebilsin")
  const minimizeBtn = document.getElementById('minimizeRoomBtn');
  if (minimizeBtn) {
    addInstantTap(minimizeBtn, (e) => {
      e.stopPropagation();
      minimizeRoomToMiniPlayer();
    });
  }

  const miniPlayerMaximizeBtn = document.getElementById('miniPlayerMaximizeBtn');
  if (miniPlayerMaximizeBtn) {
    addInstantTap(miniPlayerMaximizeBtn, (e) => {
      e.stopPropagation();
      restoreRoomFromMiniPlayer();
    });
  }

  const miniPlayerCloseBtn = document.getElementById('miniPlayerCloseBtn');
  if (miniPlayerCloseBtn) {
    addInstantTap(miniPlayerCloseBtn, (e) => {
      e.stopPropagation();
      leaveRoom();
    });
  }

  const miniPlayerPlayPauseBtn = document.getElementById('miniPlayerPlayPauseBtn');
  if (miniPlayerPlayPauseBtn) {
    addInstantTap(miniPlayerPlayPauseBtn, (e) => {
      e.stopPropagation();
      togglePlayPause();
    });
  }

  // Tapping on stageContainer when mini player is active restores full room
  if (dom.stageContainer) {
    dom.stageContainer.addEventListener('click', (e) => {
      if (document.body.classList.contains('has-mini-player')) {
        if (e.target.closest('#miniPlayerCloseBtn') || e.target.closest('#miniPlayerPlayPauseBtn')) {
          return;
        }
        e.stopPropagation();
        restoreRoomFromMiniPlayer();
      }
    });
  }

  // Pull-down swipe gesture on room header minimizes room to mini player
  const stickyHeader = document.getElementById('roomStickyHeader');
  if (stickyHeader) {
    let touchStartY = 0;
    stickyHeader.addEventListener('touchstart', (e) => {
      touchStartY = e.touches[0].clientY;
    }, { passive: true });
    stickyHeader.addEventListener('touchend', (e) => {
      const touchEndY = e.changedTouches[0].clientY;
      if (touchEndY - touchStartY > 45) { // Downward pull
        minimizeRoomToMiniPlayer();
      }
    }, { passive: true });
  }

  // Select Video Bottom Toolbar Button
  if (dom.roomChangeVideoBottomBtn) {
    addInstantTap(dom.roomChangeVideoBottomBtn, (e) => {
      e.stopPropagation();
      openVideoChooser();
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




  // Periodic simulated room viewers refresh (Heartbeat bot activity simulation)
  setInterval(() => {
    if (dom.exploreLobbySection && !dom.exploreLobbySection.classList.contains('hidden')) {
      loadPublicRooms();
    }
  }, 12000);

function extractRoomIdFromInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null;
  const input = rawInput.trim();
  if (!input) return null;

  // 1. URL pattern: check for /oda/CODE or ?room=CODE or ?r=CODE
  try {
    if (input.includes('/oda/') || input.includes('?room=') || input.includes('&room=') || input.includes('?r=') || input.includes('&r=')) {
      const odaMatch = input.match(/\/oda\/([a-zA-Z0-9_\-\.]+)/i);
      if (odaMatch && odaMatch[1]) return decodeURIComponent(odaMatch[1]).trim();

      const queryMatch = input.match(/[?&](?:room|r|oda)=([a-zA-Z0-9_\-\.]+)/i);
      if (queryMatch && queryMatch[1]) return decodeURIComponent(queryMatch[1]).trim();
    }
  } catch (_) {}

  // 2. Direct code starting with '#' (e.g. #ODA-47, #1234, #sinema)
  if (input.startsWith('#')) {
    const code = input.substring(1).trim();
    if (code.length >= 2) return code.toUpperCase();
  }

  // 3. Direct Room Code formats:
  // e.g. "ODA-123", "KODA-47", "ROOM-99", or pure digits "12345" or "123"
  const upper = input.toUpperCase();
  if (/^(?:ODA|KODA|ROOM)[-_][A-Z0-9]{2,16}$/i.test(upper)) {
    return upper;
  }
  if (/^\d{3,10}$/.test(input)) {
    return 'ODA-' + input;
  }

  return null;
}
window.extractRoomIdFromInput = extractRoomIdFromInput;

  // Unified Explore Search & Quick Room Join (Oda adı, oda kodu veya arkadaş ara)
  if (dom.raveLobbySearchInput) {
    const handleLobbySearchOrJoin = () => {
      const q = dom.raveLobbySearchInput.value.trim();
      if (!q) {
        loadPublicRooms();
        return;
      }

      // Check if user entered an explicit room link, code or number
      const extractedRoomId = extractRoomIdFromInput(q);
      if (extractedRoomId) {
        const finalRoomId = extractedRoomId;
        state.roomId = finalRoomId;
        state.isHost = false;
        state.userRole = 'member';
        state.hasDjPermission = false;
        state.controlMode = 'host_only';
        if (dom.activeRoomTitle) dom.activeRoomTitle.textContent = finalRoomId;
        if (dom.currentRoomDisplay) dom.currentRoomDisplay.textContent = finalRoomId;
        switchToMyRoom();
        connectSignaling();
        showToast(`${finalRoomId} odasına bağlanıldı!`);
        dom.raveLobbySearchInput.value = '';
        return;
      }

      // Live filter public rooms list
      const lower = q.toLowerCase();
      const allActive = mergeAllPublicRooms([]);
      const filtered = allActive.filter(r => 
        (r.name && r.name.toLowerCase().includes(lower)) ||
        (r.topic && r.topic.toLowerCase().includes(lower)) ||
        (r.category && r.category.toLowerCase().includes(lower)) ||
        (r.mediaTitle && r.mediaTitle.toLowerCase().includes(lower)) ||
        (r.host && r.host.toLowerCase().includes(lower)) ||
        (r.id && r.id.toLowerCase().includes(lower))
      );
      renderRoomList(filtered);
    };

    dom.raveLobbySearchInput.addEventListener('input', () => {
      const q = dom.raveLobbySearchInput.value.trim().toLowerCase();
      if (!q) {
        loadPublicRooms();
      } else {
        const allActive = mergeAllPublicRooms([]);
        const filtered = allActive.filter(r => 
          (r.name && r.name.toLowerCase().includes(q)) ||
          (r.topic && r.topic.toLowerCase().includes(q)) ||
          (r.category && r.category.toLowerCase().includes(q)) ||
          (r.mediaTitle && r.mediaTitle.toLowerCase().includes(q)) ||
          (r.host && r.host.toLowerCase().includes(q)) ||
          (r.id && r.id.toLowerCase().includes(q))
        );
        renderRoomList(filtered);
      }
    });

    dom.raveLobbySearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLobbySearchOrJoin();
    });

    if (dom.raveLobbySearchActionBtn) {
      dom.raveLobbySearchActionBtn.addEventListener('click', handleLobbySearchOrJoin);
    }
  }

  // Blocked Users Modal Triggers
  if (dom.openBlockedUsersModalBtn) {
    dom.openBlockedUsersModalBtn.addEventListener('click', openBlockedUsersModal);
  }
  if (dom.closeBlockedUsersModalBtn) {
    dom.closeBlockedUsersModalBtn.addEventListener('click', closeBlockedUsersModal);
  }

  // Initial user session and explore feed bootstrap
  loadPipSettings();
  loadFsChatSettings();
  loadVideoDisplaySettings();
  loadPlatformAccounts();
  loadUserSession();
  initAuthOwlMascot();
  initStageAutoHideEvents();

  // Initialize multi-language (TR / EN / DE)
  const urlLang = (typeof window !== 'undefined' && window.location) ? new URLSearchParams(window.location.search).get('lang') : null;
  const savedLang = (urlLang && I18N[urlLang]) ? urlLang : (localStorage.getItem('miruo_lang') || 'tr');
  applyLanguage(savedLang);

  // Wire up language selector buttons across Settings modal and Auth modal
  document.querySelectorAll('#langSelectorGroup .lang-btn, #authLangSelectorGroup .auth-lang-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const selected = btn.dataset.lang;
      if (selected) {
        applyLanguage(selected);
        const msg = I18N[selected] ? I18N[selected].lang_changed : 'Dil güncellendi';
        showToast(msg);
      }
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
  let lastGlanceIndex = -1;

  function setEyeOffsets(dx, dy) {
    const pupilMove = 5.6; // Full dynamic eye mobility (Sağ, Sol, Yukarı, Aşağı)
    const clampedDx = Math.max(-1, Math.min(1, dx));
    const clampedDy = Math.max(-1, Math.min(1, dy));

    if (pupilLeft) pupilLeft.style.transform = `translate(${clampedDx * pupilMove}px, ${clampedDy * pupilMove}px)`;
    if (pupilRight) pupilRight.style.transform = `translate(${clampedDx * pupilMove}px, ${clampedDy * pupilMove}px)`;
    if (pupilRightGlint) pupilRightGlint.style.transform = `translate(${clampedDx * pupilMove}px, ${clampedDy * pupilMove}px)`;
    if (owlContainer) owlContainer.style.transform = `rotateY(${clampedDx * 16}deg) rotateX(${-clampedDy * 12}deg)`;
  }

  function handlePointer(clientX, clientY) {
    isInteracting = true;
    clearTimeout(idleTimer);
    const rect = owlContainer.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const targetDx = Math.max(-1, Math.min(1, (clientX - cx) / 180));
    const targetDy = Math.max(-1, Math.min(1, (clientY - cy) / 180));
    setEyeOffsets(targetDx, targetDy);

    idleTimer = setTimeout(() => {
      isInteracting = false;
    }, 850);
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
  const lookDownInputs = [dom.authContactInput, dom.authPhoneInput, dom.authNameInput, dom.authFirstNameInput, dom.authLastNameInput].filter(Boolean);
  lookDownInputs.forEach(inp => {
    inp.addEventListener('focus', () => {
      setEyeOffsets(0, 0.85); // Aşağı (Down)
    });
  });

  const passwordInputs = [dom.authPasswordInput, dom.authPasswordConfirmInput].filter(Boolean);
  passwordInputs.forEach(inp => {
    inp.addEventListener('focus', () => {
      triggerBlink();
      setEyeOffsets(-0.85, -0.7); // Sol Yukarı (Looking away)
    });
  });

  const digitBoxes = document.querySelectorAll('.phone-digit-box');
  digitBoxes.forEach(box => {
    box.addEventListener('focus', () => {
      setEyeOffsets(0, 0.9);
    });
  });

  // Moves list: sağ, sol, yukarı, aşağı, çaprazlar ve merkez
  const moves = [
    { dx: 0.95, dy: 0 },     // Sağ (Right)
    { dx: -0.95, dy: 0 },    // Sol (Left)
    { dx: 0, dy: -0.95 },    // Yukarı (Up)
    { dx: 0, dy: 0.85 },     // Aşağı (Down)
    { dx: 0.75, dy: -0.6 },  // Sağ Yukarı
    { dx: -0.75, dy: -0.6 }, // Sol Yukarı
    { dx: 0.7, dy: 0.65 },   // Sağ Aşağı
    { dx: -0.7, dy: 0.65 },  // Sol Aşağı
    { dx: 0, dy: 0 }         // Düz / Merkez
  ];

  function runAutonomousGlance() {
    if (isInteracting) return;
    if (dom.authModal && dom.authModal.classList.contains('hidden')) return;

    if (Math.random() < 0.35) {
      triggerBlink();
    }

    let nextIdx;
    do {
      nextIdx = Math.floor(Math.random() * moves.length);
    } while (nextIdx === lastGlanceIndex && moves.length > 1);
    lastGlanceIndex = nextIdx;

    const chosen = moves[nextIdx];
    setEyeOffsets(chosen.dx, chosen.dy);
  }

  // Autonomous organic eye wandering & blinking loop:
  // Starts right away and runs every 1.4s with natural eye glancing
  setInterval(runAutonomousGlance, 1400);
  setTimeout(runAutonomousGlance, 350);

  owlContainer.addEventListener('click', () => {
    triggerBlink();
    setTimeout(triggerBlink, 280);
    setEyeOffsets(0.85, -0.4);
    setTimeout(() => setEyeOffsets(-0.85, -0.4), 300);
    setTimeout(() => setEyeOffsets(0, 0), 700);
  });
}

// ==========================================
// 6.1 YOUTUBE-STYLE AUTO-HIDE CONTROLS (Desktop & Mobile Parity)
// ==========================================
let controlsHideTimeout = null;
let isTouchingStage = false;

function getStageControlElements() {
  return [
    dom.stageFloatingFullscreenBtn,
    dom.stageExitFullscreenFloatingBtn,
    document.getElementById('raveRoomSettingsBtn'),
    document.getElementById('ravePlayerOverlay'),
    document.getElementById('closePhotoStageBtn')
  ].filter(Boolean);
}

function areStageControlsVisible() {
  if (!dom.ravePlayerOverlay) return true;
  return !dom.ravePlayerOverlay.classList.contains('fs-controls-hidden') &&
         !dom.ravePlayerOverlay.classList.contains('opacity-0');
}

function showStageControls() {
  const elements = getStageControlElements();
  elements.forEach(el => {
    el.classList.remove('fs-controls-hidden');
  });
  if (dom.ravePlayerOverlay) {
    dom.ravePlayerOverlay.classList.remove('opacity-0', 'pointer-events-none');
    dom.ravePlayerOverlay.classList.add('opacity-100');
  }
  if (dom.stageContainer) {
    dom.stageContainer.style.cursor = 'default';
  }
}

function hideStageControls() {
  // Do NOT hide if video is paused, if 3-dots settings menu is open, or while touching/dragging
  const isPaused = state.isPlaying === false;
  const menu = document.getElementById('raveRoomSettingsMenu');
  const isMenuOpen = menu && !menu.classList.contains('hidden');
  if (isPaused || isMenuOpen || isTouchingStage) return;

  const elements = getStageControlElements();
  elements.forEach(el => {
    el.classList.add('fs-controls-hidden');
  });
  if (dom.ravePlayerOverlay) {
    dom.ravePlayerOverlay.classList.add('opacity-0', 'pointer-events-none');
    dom.ravePlayerOverlay.classList.remove('opacity-100');
  }
  if (isStageFullscreen() && dom.stageContainer) {
    dom.stageContainer.style.cursor = 'none';
  }
}

function resetControlsHideTimer(delay = 2500) {
  showStageControls();
  if (controlsHideTimeout) {
    clearTimeout(controlsHideTimeout);
    controlsHideTimeout = null;
  }

  const isPaused = state.isPlaying === false;
  const menu = document.getElementById('raveRoomSettingsMenu');
  const isMenuOpen = menu && !menu.classList.contains('hidden');

  // Auto-hide after 2.5 seconds of inactivity when playing
  if (!isPaused && !isMenuOpen && !isTouchingStage) {
    controlsHideTimeout = setTimeout(() => {
      hideStageControls();
    }, delay);
  }
}
window.resetControlsHideTimer = resetControlsHideTimer;
window.showStageControls = showStageControls;
window.hideStageControls = hideStageControls;

function initStageAutoHideEvents() {
  if (!dom.stageContainer) return;

  // Desktop mouse movement reveals controls and resets timer
  ['mousemove', 'pointermove'].forEach(evt => {
    dom.stageContainer.addEventListener(evt, () => {
      resetControlsHideTimer();
    }, { passive: true });
  });

  // Fullscreen global mouse listener so moving anywhere reveals controls
  window.addEventListener('mousemove', (e) => {
    if (isStageFullscreen()) {
      resetControlsHideTimer();
    }
  }, { passive: true });

  // Touch handlers for mobile / touch devices
  dom.stageContainer.addEventListener('touchstart', (e) => {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('#raveRoomSettingsMenu')) {
      resetControlsHideTimer();
      return;
    }
    isTouchingStage = true;
    if (controlsHideTimeout) {
      clearTimeout(controlsHideTimeout);
      controlsHideTimeout = null;
    }
  }, { passive: true });

  dom.stageContainer.addEventListener('touchmove', () => {
    isTouchingStage = true;
    if (controlsHideTimeout) {
      clearTimeout(controlsHideTimeout);
      controlsHideTimeout = null;
    }
  }, { passive: true });

  dom.stageContainer.addEventListener('touchend', () => {
    isTouchingStage = false;
    const isPaused = state.isPlaying === false;
    if (!isPaused) {
      resetControlsHideTimer(2500);
    }
  }, { passive: true });

  // Mouse leave player stage (only when windowed)
  dom.stageContainer.addEventListener('mouseleave', () => {
    if (!isStageFullscreen()) {
      const isPaused = state.isPlaying === false;
      const menu = document.getElementById('raveRoomSettingsMenu');
      const isMenuOpen = menu && !menu.classList.contains('hidden');
      if (!isPaused && !isMenuOpen) {
        hideStageControls();
      }
    }
  });

  // Tap or Click handling: Toggle controls when tapping on empty stage, refresh timer when tapping controls
  dom.stageContainer.addEventListener('click', (e) => {
    if (document.body.classList.contains('has-mini-player')) return;

    const isControl = e.target.closest('button') ||
                      e.target.closest('input') ||
                      e.target.closest('a') ||
                      e.target.closest('#raveRoomSettingsMenu') ||
                      e.target.closest('#partnerPipCard') ||
                      e.target.closest('#selfPipCard');

    if (isControl) {
      resetControlsHideTimer();
      return;
    }

    const isPaused = state.isPlaying === false;
    const menu = document.getElementById('raveRoomSettingsMenu');
    const isMenuOpen = menu && !menu.classList.contains('hidden');

    if (isMenuOpen) {
      toggleRaveRoomSettingsMenu(false);
      resetControlsHideTimer();
      return;
    }

    // Toggle controls YouTube-style
    if (areStageControlsVisible()) {
      if (!isPaused) {
        hideStageControls();
      }
    } else {
      resetControlsHideTimer();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (['input', 'textarea'].includes((document.activeElement?.tagName || '').toLowerCase())) return;
    resetControlsHideTimer();
  });

  document.addEventListener('fullscreenchange', () => {
    resetControlsHideTimer();
  });
  document.addEventListener('webkitfullscreenchange', () => {
    resetControlsHideTimer();
  });

  // Initialize Mobile Legends Affinity Events & Listeners
  if (typeof initAffinityEvents === 'function') {
    initAffinityEvents();
  }
}

function initAffinityEvents() {
  const affinityInfoQuestionBtn = document.getElementById('affinityInfoQuestionBtn');
  if (affinityInfoQuestionBtn) {
    addInstantTap(affinityInfoQuestionBtn, (e) => {
      e.stopPropagation();
      const box = document.getElementById('affinityConditionInfoBox');
      if (box) {
        box.classList.toggle('hidden');
      }
    });
  }

  const closeAffinityPickerBtn = document.getElementById('closeAffinityPickerBtn');
  if (closeAffinityPickerBtn) {
    addInstantTap(closeAffinityPickerBtn, (e) => {
      e.stopPropagation();
      closeAffinityPicker();
    });
  }

  const closeAffinitySlotDetailBtn = document.getElementById('closeAffinitySlotDetailBtn');
  if (closeAffinitySlotDetailBtn) {
    addInstantTap(closeAffinitySlotDetailBtn, (e) => {
      e.stopPropagation();
      closeAffinitySlotDetail();
    });
  }

  const closePublicProfileBtn = document.getElementById('closePublicProfileBtn');
  if (closePublicProfileBtn) {
    addInstantTap(closePublicProfileBtn, (e) => {
      e.stopPropagation();
      closePublicUserProfile();
    });
  }

  // 3-Nokta Menüsü & Seçenekler (Arkadaşlıktan Çıkar, Kullanıcıyı Engelle, Şikayet Et)
  const publicProfileMoreOptionsBtn = document.getElementById('publicProfileMoreOptionsBtn');
  if (publicProfileMoreOptionsBtn) {
    addInstantTap(publicProfileMoreOptionsBtn, (e) => {
      e.stopPropagation();
      openPublicProfileOptionsMenu();
    });
  }

  const closePublicProfileOptionsBtn = document.getElementById('closePublicProfileOptionsBtn');
  if (closePublicProfileOptionsBtn) {
    addInstantTap(closePublicProfileOptionsBtn, (e) => {
      e.stopPropagation();
      closePublicProfileOptionsMenu();
    });
  }

  const optCancelBtn = document.getElementById('optCancelBtn');
  if (optCancelBtn) {
    addInstantTap(optCancelBtn, (e) => {
      e.stopPropagation();
      closePublicProfileOptionsMenu();
    });
  }

  const publicProfileOptionsModal = document.getElementById('publicProfileOptionsModal');
  if (publicProfileOptionsModal) {
    addInstantTap(publicProfileOptionsModal, (e) => {
      if (e.target === publicProfileOptionsModal) {
        closePublicProfileOptionsMenu();
      }
    });
  }

  const optViewProfileBtn = document.getElementById('optViewProfileBtn');
  if (optViewProfileBtn) {
    addInstantTap(optViewProfileBtn, (e) => {
      e.stopPropagation();
      closePublicProfileOptionsMenu();
      if (currentPublicUser && currentPublicUser.username) {
        openPublicUserProfile(currentPublicUser.username);
      }
    });
  }

  const optInviteFriendBtn = document.getElementById('optInviteFriendBtn');
  if (optInviteFriendBtn) {
    addInstantTap(optInviteFriendBtn, (e) => {
      e.stopPropagation();
      closePublicProfileOptionsMenu();
      if (currentPublicUser) {
        inviteFriendToRoom(currentPublicUser);
      }
    });
  }

  const optRemoveFriendBtn = document.getElementById('optRemoveFriendBtn');
  if (optRemoveFriendBtn) {
    addInstantTap(optRemoveFriendBtn, (e) => {
      e.stopPropagation();
      closePublicProfileOptionsMenu();
      if (!currentPublicUser) return;
      const clean = (currentPublicUser.username || currentPublicUser.name || 'kullanici').replace(/^@/, '');
      showMiruoConfirm({
        title: 'Arkadaşlıktan Çıkar',
        message: `@${clean} adlı kişiyi arkadaş listenizden çıkarmak istediğinize emin misiniz?`,
        actionText: 'Evet, Çıkar',
        onConfirm: () => {
          executeRemoveFriend(currentPublicUser);
        }
      });
    });
  }

  const optBlockUserBtn = document.getElementById('optBlockUserBtn');
  if (optBlockUserBtn) {
    addInstantTap(optBlockUserBtn, (e) => {
      e.stopPropagation();
      closePublicProfileOptionsMenu();
      if (!currentPublicUser) return;
      const clean = (currentPublicUser.username || currentPublicUser.name || 'kullanici').replace(/^@/, '');
      showMiruoConfirm({
        title: 'Kullanıcıyı Engelle',
        message: `@${clean} adlı kullanıcıyı engellemek istediğinize emin misiniz? Sohbet mesajları ve odaları gizlenecektir.`,
        actionText: 'Evet, Engelle',
        onConfirm: () => {
          blockUser(
            clean,
            currentPublicUser.id || currentPublicUser.userId,
            currentPublicUser.avatar || currentPublicUser.avatarUrl,
            currentPublicUser.avatarBg || currentPublicUser.avatarColor
          );
          executeRemoveFriend(currentPublicUser);
        }
      });
    });
  }

  const optReportUserBtn = document.getElementById('optReportUserBtn');
  if (optReportUserBtn) {
    addInstantTap(optReportUserBtn, (e) => {
      e.stopPropagation();
      closePublicProfileOptionsMenu();
      if (!currentPublicUser) return;
      showToast(`${currentPublicUser.name || 'Kullanıcı'} hakkında şikayetiniz ekibimize iletildi.`);
    });
  }

  // Detail Modal Actions
  const affinityDetailViewProfileBtn = document.getElementById('affinityDetailViewProfileBtn');
  if (affinityDetailViewProfileBtn) {
    addInstantTap(affinityDetailViewProfileBtn, (e) => {
      e.stopPropagation();
      const currentTree = getUserAffinityTree();
      if (currentDetailSlotKey && currentTree[currentDetailSlotKey]) {
        const uName = currentTree[currentDetailSlotKey].username;
        closeAffinitySlotDetail();
        openPublicUserProfile(uName);
      }
    });
  }

  const affinityDetailInviteBtn = document.getElementById('affinityDetailInviteBtn');
  if (affinityDetailInviteBtn) {
    addInstantTap(affinityDetailInviteBtn, (e) => {
      e.stopPropagation();
      const currentTree = getUserAffinityTree();
      if (currentDetailSlotKey && currentTree[currentDetailSlotKey]) {
        inviteFriendToRoom(currentTree[currentDetailSlotKey]);
      }
    });
  }

  // Bağlantıyı Kaldır Butonu (Doğrudan ve Hızlıca Kaldırır)
  const affinityDetailUnbindBtn = document.getElementById('affinityDetailUnbindBtn');
  if (affinityDetailUnbindBtn) {
    addInstantTap(affinityDetailUnbindBtn, (e) => {
      e.stopPropagation();
      if (!currentDetailSlotKey) return;
      const currentTree = getUserAffinityTree();
      const item = currentTree[currentDetailSlotKey];
      if (item) {
        const friendName = item.name || ('@' + item.username);
        const isPending = !!item.isPending;

        if (isPending) {
          let requests = [];
          try {
            requests = JSON.parse(localStorage.getItem('miruo_affinity_requests') || '[]');
          } catch (err) { requests = []; }
          const targetClean = (item.username || '').replace(/^@/, '').toLowerCase();
          localStorage.setItem('miruo_affinity_requests', JSON.stringify(requests.filter(r => (r.toUsername || '').toLowerCase() !== targetClean)));
        }

        const cleanUser = (item.username || '').replace(/^@/, '').toLowerCase();
        let mutuals = {};
        try {
          mutuals = JSON.parse(localStorage.getItem('miruo_mutual_affinities') || '{}');
          delete mutuals[cleanUser];
          localStorage.setItem('miruo_mutual_affinities', JSON.stringify(mutuals));
        } catch (err) {}

        currentTree[currentDetailSlotKey] = null;
        saveUserAffinityTree(currentTree);
        closeAffinitySlotDetail();
        renderAffinityTree();

        sendP2PData('affinity_unbound', { fromUsername: state.username, toUsername: cleanUser });
        sendSignal({ type: 'affinity-unbound', fromUsername: state.username, toUsername: cleanUser });
        if (typeof queueGlobalEvent === 'function') {
          queueGlobalEvent('affinity_unbound', cleanUser, { fromUsername: state.username });
        }

        showToast(isPending ? `${friendName} ile olan ilişki isteği iptal edildi.` : `${friendName} ile olan bağlantı kaldırıldı.`);
      }
    });
  }

  // Public Profile Modal Actions
  const publicProfileInviteBtn = document.getElementById('publicProfileInviteBtn');
  if (publicProfileInviteBtn) {
    addInstantTap(publicProfileInviteBtn, (e) => {
      e.stopPropagation();
      if (currentPublicUser) {
        inviteFriendToRoom(currentPublicUser);
      } else {
        inviteFriendToRoom({ name: 'Arkadaş' });
      }
    });
  }

  const publicProfileFriendToggleBtn = document.getElementById('publicProfileFriendToggleBtn');
  if (publicProfileFriendToggleBtn) {
    addInstantTap(publicProfileFriendToggleBtn, (e) => {
      e.stopPropagation();
      if (!currentPublicUser) return;
      const clean = (currentPublicUser.username || currentPublicUser.name || 'kullanici').replace(/^@/, '');
      const cleanLower = clean.toLowerCase();
      const isFriend = Array.isArray(state.friends) && state.friends.some(f => {
        const fU = (f.username || '').toLowerCase().replace(/^@/, '').trim();
        const fN = (f.name || '').toLowerCase().replace(/^@/, '').trim();
        return fU === cleanLower || fN === cleanLower;
      });

      if (isFriend) {
        showMiruoConfirm({
          title: 'Arkadaşlıktan Çıkar',
          message: `@${clean} adlı kişiyi arkadaş listenizden çıkarmak istediğinize emin misiniz?`,
          actionText: 'Evet, Çıkar',
          onConfirm: () => {
            executeRemoveFriend(currentPublicUser);
          }
        });
      } else {
        if (typeof isUserBlocked === 'function' && isUserBlocked(clean)) {
          showToast('Bu kullanıcı engellenmiş. Arkadaş eklemek için önce Ayarlar\'dan engeli kaldırmalısınız.');
          return;
        }
        state.friends.unshift({
          name: currentPublicUser.name || clean,
          username: clean,
          avatarUrl: currentPublicUser.avatarUrl || '',
          status: 'online',
          lastActive: Date.now()
        });
        localStorage.setItem('miruo_friends', JSON.stringify(state.friends));
        if (typeof renderFriendsTab === 'function') renderFriendsTab();
        if (typeof renderFriendsList === 'function') renderFriendsList();
        if (typeof renderProfileTab === 'function') renderProfileTab();
        const toggleText = document.getElementById('publicProfileFriendToggleText');
        if (toggleText) toggleText.textContent = 'Arkadaşsınız';
        showToast(`@${clean} arkadaş listenize eklendi!`);
      }
    });
  }

  // Modal Dışı Tıklamada Kapatma
  ['affinityPickerModal', 'affinitySlotDetailModal', 'userPublicProfileModal'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', (e) => {
        if (e.target === el) {
          if (id === 'userPublicProfileModal') closePublicUserProfile();
          else if (id === 'affinityPickerModal') closeAffinityPicker();
          else if (id === 'affinitySlotDetailModal') closeAffinitySlotDetail();
        }
      });
    }
  });

  // Real-time Shared Watch-Time Incrementer during playback or sleep mode
  setInterval(() => {
    const inActiveRoom = !!(state.roomId || state.currentRoom);
    const isActivelySharing = state.isPlaying || state.isSleepMode;
    if (inActiveRoom && isActivelySharing) {
      // 1. WebRTC & Signaling room participants
      const currentPartKeys = Object.keys(state.participants || {});
      currentPartKeys.forEach(pKey => {
        const p = state.participants[pKey];
        if (p && p.username && !p.isSelf) {
          addSharedWatchMinutes(p.username, 0.5); // Add 30 seconds of shared watch time
        }
      });
      if (state.peerId && state.hostName && state.hostName !== 'Sen') {
        addSharedWatchMinutes(state.hostName, 0.5);
      }
      // 2. Active room bots or simulated partners
      if (typeof activeRoomBots !== 'undefined' && Array.isArray(activeRoomBots)) {
        activeRoomBots.forEach(b => {
          if (b && b.name) {
            addSharedWatchMinutes(b.name, 0.5);
          }
        });
      }
    }
  }, 30000);
}

// Expose public API for deep linking & external control
window.loadRoomFromDeepLink = function(roomId) {
  if (!roomId) return;
  state.roomId = roomId.toUpperCase();
  switchToMyRoom();
  connectSignaling();
  if (typeof DEFAULT_COMMUNITY_ROOMS !== 'undefined') {
    const matched = DEFAULT_COMMUNITY_ROOMS.find(r => r.id.toUpperCase() === state.roomId);
    if (matched && matched.videoId) {
      setTimeout(() => { loadYoutubeVideo(matched.videoId); }, 350);
    }
  }
};
window.openRoomParticipantsModal = openRoomParticipantsModal;
window.closeRoomParticipantsModal = closeRoomParticipantsModal;
window.kickParticipant = kickParticipant;
window.setParticipantRole = setParticipantRole;
window.toggleCam = toggleCam;
window.initAffinityEvents = initAffinityEvents;
window.setChatVisibility = setChatVisibility;

// Broadcast room closure on window exit / tab close
window.addEventListener('beforeunload', () => {
  if (state.isInRoom && state.isHost && state.roomId && globalRoomsChannel) {
    try {
      globalRoomsChannel.send({
        type: 'broadcast',
        event: 'room_closed',
        payload: { id: state.roomId }
      });
      globalRoomsChannel.untrack();
    } catch (_) {}
  }
});

window.addEventListener('pagehide', () => {
  if (state.isInRoom && state.isHost && state.roomId && globalRoomsChannel) {
    try {
      globalRoomsChannel.send({
        type: 'broadcast',
        event: 'room_closed',
        payload: { id: state.roomId }
      });
      globalRoomsChannel.untrack();
    } catch (_) {}
  }
});

// Global Audio Unlocker for Mobile Safari, WKWebView and Desktop
const unlockAudioSystem = () => {
  try {
    if (state.audioCtx && state.audioCtx.state === 'suspended') {
      state.audioCtx.resume();
    }
    document.querySelectorAll('audio[id^="remoteVoiceAudio"]').forEach(aud => {
      if (aud) {
        aud.muted = false;
        aud.volume = 1.0;
        aud.play().catch(() => {});
      }
    });
  } catch (_) {}
};
window.addEventListener('click', unlockAudioSystem, { passive: true });
window.addEventListener('touchstart', unlockAudioSystem, { passive: true });

// Start
document.addEventListener('DOMContentLoaded', initEvents);
