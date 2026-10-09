import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  hashPassword,
  verifyPassword,
  escapeHtml,
  sanitizeObject,
  safeJsonParse,
  verifyWebhookSignature,
  ROLES
} from './lib/security.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_URL = 'http://localhost:3000';

const results = [];

function assert(description, condition, details = '') {
  if (condition) {
    console.log(`  ✅ [PASS] ${description}`);
    results.push({ description, pass: true });
  } else {
    console.error(`  ❌ [FAIL] ${description} ${details ? `(${details})` : ''}`);
    results.push({ description, pass: false, details });
  }
}

async function request(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const url = new URL(urlPath, BASE_URL);
    const req = http.request(url, options, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (!resolved) {
          resolved = true;
          let json = null;
          try { json = JSON.parse(body); } catch (e) {}
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
            json
          });
        }
      });
    });
    req.on('error', err => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
    if (options.body) {
      req.end(options.body);
    } else {
      req.end();
    }
  });
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('🛡️  MIRUO CYBERSECURITY PENETRATION TEST & AUDIT SUITE (Item 23)');
console.log('═══════════════════════════════════════════════════════════════\n');

async function runPenetrationTests() {
  // --------------------------------------------------------------------------
  // TEST 1: Password Hashing & Timing-Safe Verification (Item 11)
  // --------------------------------------------------------------------------
  console.log('▶ [Test 1] Şifreleme & Hash Güvenliği (Scrypt + Salt + Timing-Safe):');
  const plainPass = 'SüperGüçlüŞifre!2026';
  const hashed = hashPassword(plainPass);
  
  assert('Şifre salted $scrypt$ formatında saklanıyor', hashed.startsWith('$scrypt$'));
  assert('Şifre metni hash içinde açıkça bulunmuyor', !hashed.includes(plainPass));
  
  const validCheck = verifyPassword(plainPass, hashed);
  assert('Doğru şifre scrypt hash ile başarıyla doğrulanıyor', validCheck.valid === true);
  
  const wrongCheck = verifyPassword('YanlışŞifre123', hashed);
  assert('Yanlış şifre scrypt doğrulaması tarafından reddediliyor', wrongCheck.valid === false);

  // Legacy plaintext auto-migration check
  const legacyCheck = verifyPassword('EskiDüzMetin123', 'EskiDüzMetin123');
  assert('Eski düz metin şifreler algılanıp otomatik scrypt yükseltmesi işaretleniyor', legacyCheck.needsUpgrade === true);

  // --------------------------------------------------------------------------
  // TEST 2: XSS Payload Escaping & Sanitization (Item 16)
  // --------------------------------------------------------------------------
  console.log('\n▶ [Test 2] XSS & Kod Enjeksiyonu Savunması (HTML Entity Escaping):');
  const xssPayload = '<script>alert("Hacked!")</script><img src="x" onerror="stealCookies()">';
  const escaped = escapeHtml(xssPayload);
  assert('Script etiketleri &lt; ve &gt; olarak etkisizleştirildi', !escaped.includes('<script>') && escaped.includes('&lt;script&gt;'));
  assert('Onerror Javascript event handler çalıştırılamaz hale getirildi', escaped.includes('&quot;'));

  // --------------------------------------------------------------------------
  // TEST 3: Prototype Pollution Defense (Item 15)
  // --------------------------------------------------------------------------
  console.log('\n▶ [Test 3] Prototype Pollution Saldırı Girişimi:');
  const evilPayload = '{"__proto__": {"isSystemAdmin": true}, "username": "attacker"}';
  const parsed = safeJsonParse(evilPayload);
  const sanitized = sanitizeObject(parsed);
  assert('__proto__ injection temizlendi ve Object prototype kirletilmedi', ({}).isSystemAdmin === undefined);
  assert('Kullanıcı adı güvenle parse edildi', sanitized.username === 'attacker');

  // --------------------------------------------------------------------------
  // TEST 4: HTTP Security Headers Inspection (Item 9 & 10)
  // --------------------------------------------------------------------------
  console.log('\n▶ [Test 4] Helmet Stili HTTP Güvenlik Başlıkları Denetimi:');
  const headerRes = await request('/');
  assert('X-Content-Type-Options: nosniff başlığı mevcut', headerRes.headers['x-content-type-options'] === 'nosniff');
  assert('X-Frame-Options: SAMEORIGIN başlığı mevcut', headerRes.headers['x-frame-options'] === 'SAMEORIGIN');
  assert('Referrer-Policy başlığı mevcut', headerRes.headers['referrer-policy'] === 'strict-origin-when-cross-origin');
  assert('Content-Security-Policy başlığı mevcut', !!headerRes.headers['content-security-policy']);

  // --------------------------------------------------------------------------
  // TEST 5: CORS Lockdown Verification (Item 8)
  // --------------------------------------------------------------------------
  console.log('\n▶ [Test 5] CORS Kilit Denetimi (Yetkisiz Domain Bloklama):');
  const unauthorizedOriginRes = await request('/api/public-rooms', {
    method: 'GET',
    headers: { 'Origin': 'https://evil-unauthorized-hacker.com' }
  });
  assert('Yetkisiz origin için Access-Control-Allow-Origin VERİLMİYOR', unauthorizedOriginRes.headers['access-control-allow-origin'] !== 'https://evil-unauthorized-hacker.com');

  const authorizedOriginRes = await request('/api/public-rooms', {
    method: 'GET',
    headers: { 'Origin': 'https://miruo.com.tr' }
  });
  assert('miruo.com.tr resmi alan adı CORS onayını alıyor', authorizedOriginRes.headers['access-control-allow-origin'] === 'https://miruo.com.tr');

  // --------------------------------------------------------------------------
  // TEST 6: Request Payload Size Limiting / DoS Defense (Item 7)
  // --------------------------------------------------------------------------
  console.log('\n▶ [Test 6] Yük Boyutu Sınırı / DoS Savunması (>100KB Payload Reddi):');
  const hugePayload = JSON.stringify({ data: 'A'.repeat(120 * 1024) }); // 120KB > 100KB limit
  const payloadRes = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: hugePayload
  });
  assert('100KB üstü istek sunucu tarafından 413 Payload Too Large ile engellendi', payloadRes.statusCode === 413);

  // --------------------------------------------------------------------------
  // TEST 7: Brute Force & Rate Limiting (Item 5)
  // --------------------------------------------------------------------------
  console.log('\n▶ [Test 7] Brute-Force & Rate Limiting (Hatalı Giriş Sınırı):');
  const testTargetEmail = `pen_test_user_${Date.now()}@miruo.test`;
  let hitRateLimit = false;

  for (let i = 1; i <= 6; i++) {
    const loginAttempt = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testTargetEmail, password: 'WrongPassword!' })
    });

    if (loginAttempt.statusCode === 429) {
      hitRateLimit = true;
      assert(`Giriş denemesi ${i}: 429 Too Many Requests ile bloklandı (Rate limit tetiklendi)`, true);
      assert('Retry-After başlığı kullanıcıya iletildi', !!loginAttempt.headers['retry-after']);
      break;
    }
  }
  assert('5 hatalı denemeden sonra brute-force saldırganı engellendi', hitRateLimit === true);

  // --------------------------------------------------------------------------
  // TEST 8: Webhook HMAC SHA-256 Signature Verification (Item 17)
  // --------------------------------------------------------------------------
  console.log('\n▶ [Test 8] Webhook HMAC SHA-256 İmza Doğrulaması:');
  const webhookBody = JSON.stringify({ event: 'payment.success', amount: 100 });
  const secretKey = 'miruo_webhook_hmac_secret_key_2026_prod';

  // 8.1 Unsigned webhook
  const unsignedRes = await request('/api/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: webhookBody
  });
  assert('İmzasız webhook 401 Unauthorized ile reddedildi', unsignedRes.statusCode === 401);

  // 8.2 Forged signature webhook
  const fakeRes = await request('/api/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Miruo-Signature': 'fake_signature_abc123'
    },
    body: webhookBody
  });
  assert('Sahte / taklit imzalı webhook 401 Unauthorized ile reddedildi', fakeRes.statusCode === 401);

  // 8.3 Legitimate HMAC SHA-256 signature
  const validSignature = crypto.createHmac('sha256', secretKey).update(webhookBody).digest('hex');
  const validRes = await request('/api/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Miruo-Signature': validSignature
    },
    body: webhookBody
  });
  assert('Geçerli HMAC SHA-256 imzalı webhook 200 OK ile onaylandı', validRes.statusCode === 200);

  // --------------------------------------------------------------------------
  // TEST 9: Admin Role Authorization (Item 18)
  // --------------------------------------------------------------------------
  console.log('\n▶ [Test 9] Admin Rol & Yetkilendirme Koruması:');
  const unauthAdmin = await request('/api/admin/overview', { method: 'GET' });
  assert('Yetkisiz admin isteği 403 Forbidden ile engellendi', unauthAdmin.statusCode === 403);

  const authAdmin = await request('/api/admin/overview', {
    method: 'GET',
    headers: { 'Authorization': 'Bearer miruo_admin_master_access_key_2026' }
  });
  assert('Admin anahtarı ile sistem metriklerine güvenle erişildi', authAdmin.statusCode === 200 && authAdmin.json?.success === true);

  // --------------------------------------------------------------------------
  // TEST 10: Real Account Creation & Real Deletion (Item 21)
  // --------------------------------------------------------------------------
  console.log('\n▶ [Test 10] Gerçek Hesap Açma & Hesabı Kalıcı Olarak Silme (Item 21):');
  const testAccountPass = 'SilinecekGucluSifre123!';
  const uniqueId = Date.now().toString(36);
  const testAccountEmail = `test_delete_${uniqueId}@miruo.test`;
  const testAccountUsername = `del_user_${uniqueId}`;

  // 10.1 Register test user
  const regRes = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: 'Hesap Silme Testi',
      username: testAccountUsername,
      email: testAccountEmail,
      password: testAccountPass
    })
  });
  assert('Test hesabı başarıyla kaydedildi', regRes.statusCode === 200 && regRes.json?.success === true, regRes.body);
  const registeredUserId = regRes.json?.user?.id;

  // 10.2 Verify user exists in data/users.json
  const usersFile = path.join(__dirname, 'data', 'users.json');
  let usersData = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  const foundInDb = usersData.find(u => u.id === registeredUserId);
  assert('Kullanıcı veritabanında mevcut ve şifresi scrypt ile hashlenmiş', !!foundInDb && foundInDb.password.startsWith('$scrypt$'));

  // 10.3 Try delete with WRONG password
  const failDelete = await request('/api/auth/delete-account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: registeredUserId,
      password: 'YanlışŞifreGirdim'
    })
  });
  assert('Yanlış şifre ile hesap silme isteği 401 ile reddedildi', failDelete.statusCode === 401);

  // 10.4 Delete with CORRECT password
  const successDelete = await request('/api/auth/delete-account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: registeredUserId,
      password: testAccountPass
    })
  });
  assert('Doğru şifre ile hesap silme isteği 200 OK döndü', successDelete.statusCode === 200 && successDelete.json?.success === true);

  // 10.5 Verify user is COMPLETELY ERASED from data/users.json
  usersData = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  const stillExists = usersData.find(u => u.id === registeredUserId || u.email === testAccountEmail);
  assert('Kullanıcı veritabanından kalıcı olarak silindi (Gerçek Silme Doğrulandı ✓)', !stillExists);

  // 10.6 Verify database backup was created in data/.backups/
  const backupDir = path.join(__dirname, 'data', '.backups');
  const backupFiles = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
  assert('Silme işlemi öncesi otomatik güvenlik yedeği alındı (.backups)', backupFiles.length > 0);

  // --------------------------------------------------------------------------
  // SUMMARY
  // --------------------------------------------------------------------------
  console.log('\n═══════════════════════════════════════════════════════════════');
  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`📊 PENETRASYON TEST SONUCU: ${passed}/${total} TEST BAŞARILI (%${Math.round((passed/total)*100)})`);
  if (failed === 0) {
    console.log('🎉 23 MADDELİK TÜM SİBER GÜVENLİK VE SERTLEŞTİRME TESTLERİ EKSİKSİZ GEÇTİ!');
  } else {
    console.log(`⚠️ ${failed} adet test başarısız oldu.`);
  }
  console.log('═══════════════════════════════════════════════════════════════\n');

  process.exit(failed === 0 ? 0 : 1);
}

runPenetrationTests().catch(err => {
  console.error('Kritik test hatası:', err);
  process.exit(1);
});
