// Miruo sunucu ayarı (Mac / Windows / Web ortak).
//
// Hesapların cihazlar arası aynı olması, herkese açık odaların (Keşfet) görünmesi ve
// odadakilerin birbirini görmesi için server.mjs İNTERNETTE çalışıyor olmalıdır.
// Sunucuyu yayınladıktan sonra yalnızca aşağıdaki adresi doldurun, örn:
//   window.MIRUO_API_BASE = 'https://miruo-server.onrender.com';
// Boş bırakılırsa uygulama "tek cihaz" modunda çalışır (odalar yalnızca bu cihazda).
window.MIRUO_API_BASE = '';

// Miruo TURN & STUN relays (Cloudflare STUN + Google STUN + Metered Global TURN).
window.MIRUO_TURN_SERVERS = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
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
];
