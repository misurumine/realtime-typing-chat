(() => {
  /**
   * LiveType — 100% Serverless Realtime Live-Typing Chat (PWA)
   * Works on GitHub Pages, Cloudflare Pages, Vercel, Netlify, or Localhost
   * with Google Sign-In & Cloud Firestore P2P Architecture!
   */

  // Anti-Clickjacking Frame Buster: Ensure application is never embedded inside malicious iframes
  try {
    if (window.top !== window.self) {
      window.top.location = window.self.location;
    }
  } catch (e) {
    if (document.documentElement) {
      document.documentElement.style.display = 'none';
    }
  }

  // --- Anti-Macro & Spam Throttle (1s Cooldown on all user actions except typing) ---
  const ACTION_COOLDOWN_MS = 1000;
  const lastActionTimestamps = new Map();

  function canExecuteAction(actionKey, showWarning = true) {
    const now = Date.now();
    const lastTime = lastActionTimestamps.get(actionKey) || 0;
    if (now - lastTime < ACTION_COOLDOWN_MS) {
      if (showWarning) {
        showToast('⏳ กรุณารอสักครู่ (ป้องกันการกดรัว/สแปม)');
      }
      return false;
    }
    lastActionTimestamps.set(actionKey, now);
    return true;
  }

  // Global Click Throttle: automatically protect all buttons, chips, and modals against Macro spam
  window.addEventListener(
    'click',
    (e) => {
      // Allow live typing input clicks / focus
      if (e.target.closest('#liveTypingInput') || e.target.closest('input[type="text"]') || e.target.closest('textarea')) {
        return;
      }
      // Never block setup submission button or forms
      if (e.target.closest('#formSetup') || e.target.closest('#viewSetup')) {
        return;
      }
      // Never block or throttle emote clicking so user can spam emotes freely!
      if (e.target.closest('.btn-emote-item') || e.target.closest('#emotePickerGrid')) {
        return;
      }
      // Never block or throttle video player or stream controls
      if (e.target.closest('#floatingStreamWindow') || e.target.closest('#btnToggleScreenShare') || e.target.closest('.btn-stream-card-trigger')) {
        return;
      }
      const clickable = e.target.closest('button, .tag-chip, .btn-sidebar-pill, .btn-picker-tab, .discord-cat-tile, .btn-preset-theme');
      if (clickable) {
        // Exclude clear enter button from double suppression if user pressed Enter key
        const actionId = clickable.id || clickable.className || 'generic_btn';
        if (!canExecuteAction(`click_${actionId}`, false)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }
    },
    true
  );

  // Storage Keys (Session persists until explicit Logout)
  const STORAGE_KEY_USER = 'livetype_user_session_v1';
  const STORAGE_KEY_FRIENDS = 'livetype_friends_list_v1';
  const STORAGE_KEY_THEME = 'livetype_custom_theme_v1';
  const STORAGE_KEY_FAV_GIFS = 'livetype_favorite_gifs_v1';
  const STORAGE_KEY_CUSTOM_BG = 'livetype_custom_bg_v1';

  // IndexedDB Helper for Safe Storage of High-Resolution Background Wallpapers (Zero Quota Limits)
  const ASSET_DB_NAME = 'LiveType_LocalData';
  const ASSET_DB_STORE = 'app_assets';

  function openAssetDb() {
    return new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      try {
        const req = indexedDB.open(ASSET_DB_NAME, 1);
        req.onupgradeneeded = () => {
          try { req.result.createObjectStore(ASSET_DB_STORE); } catch (e) {}
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function saveCustomBgAsset(dataUrl) {
    try {
      const db = await openAssetDb();
      if (db) {
        const tx = db.transaction(ASSET_DB_STORE, 'readwrite');
        tx.objectStore(ASSET_DB_STORE).put(dataUrl, 'custom_bg');
      }
    } catch (e) {}
    try {
      localStorage.setItem(STORAGE_KEY_CUSTOM_BG, dataUrl);
    } catch (e) {}
  }

  async function loadCustomBgAsset() {
    try {
      const db = await openAssetDb();
      if (db) {
        return new Promise((resolve) => {
          const tx = db.transaction(ASSET_DB_STORE, 'readonly');
          const req = tx.objectStore(ASSET_DB_STORE).get('custom_bg');
          req.onsuccess = () => resolve(req.result || localStorage.getItem(STORAGE_KEY_CUSTOM_BG) || null);
          req.onerror = () => resolve(localStorage.getItem(STORAGE_KEY_CUSTOM_BG) || null);
        });
      }
    } catch (e) {}
    return localStorage.getItem(STORAGE_KEY_CUSTOM_BG) || null;
  }

  async function deleteCustomBgAsset() {
    try {
      const db = await openAssetDb();
      if (db) {
        const tx = db.transaction(ASSET_DB_STORE, 'readwrite');
        tx.objectStore(ASSET_DB_STORE).delete('custom_bg');
      }
    } catch (e) {}
    try {
      localStorage.removeItem(STORAGE_KEY_CUSTOM_BG);
    } catch (e) {}
  }

  // Preset Emotes for Floating Soap-Bubble Effect
  const BUBBLE_EMOTES = [
    '❤️', '💖', '🔥', '😂', '🤣', '😭',
    '🥺', '😍', '🥰', '😎', '🤩', '🥳',
    '😱', '🤯', '😡', '🤬', '👍', '👏',
    '🙏', '🙌', '👀', '💀', '👻', '👽',
    '🐱', '🐶', '🦊', '🐼', '🦄', '🐸',
    '🎉', '✨', '💯', '⚡', '🌈', '🫧'
  ];

  // Default Theme Palette (Full Website Customizer)
  const DEFAULT_THEME = {
    primary: '#6366f1',
    accent: '#ec4899',
    bg: '#070a12',
    card: '#111827',
    chatCard: '#0f172a',
    border: '#334155',
    text: '#f8fafc',
    mutedText: '#94a3b8',
    chatText: '#f8fafc',
    selfChatText: '#f8fafc',
    chatFontSize: 20,
    radius: 14,
    opacity: 88,
    brightness: 100,
    bgDim: 30,
    bgBlur: 0,
    hasCustomBg: false
  };

  const PRESET_THEMES = {
    neon: {
      primary: '#6366f1', accent: '#ec4899', bg: '#070a12', card: '#111827',
      chatCard: '#0f172a', border: '#334155', text: '#f8fafc', mutedText: '#94a3b8',
      chatText: '#f8fafc', selfChatText: '#e0e7ff', chatFontSize: 20, radius: 14, opacity: 88, brightness: 100
    },
    minimal: {
      primary: '#4f46e5', accent: '#e11d48', bg: '#e8edf4', card: '#f8fafc',
      chatCard: '#ffffff', border: '#cbd5e1', text: '#0f172a', mutedText: '#475569',
      chatText: '#0f172a', selfChatText: '#312e81', chatFontSize: 20, radius: 14, opacity: 94, brightness: 98
    },
    emerald: {
      primary: '#10b981', accent: '#14b8a6', bg: '#04120e', card: '#0b241b',
      chatCard: '#091e16', border: '#1e4635', text: '#ecfdf5', mutedText: '#86efac',
      chatText: '#ecfdf5', selfChatText: '#a7f3d0', chatFontSize: 20, radius: 12, opacity: 88, brightness: 100
    },
    sunset: {
      primary: '#f43f5e', accent: '#f59e0b', bg: '#16070b', card: '#280d14',
      chatCard: '#210a10', border: '#4c1d28', text: '#fff1f2', mutedText: '#fda4af',
      chatText: '#fff1f2', selfChatText: '#fde68a', chatFontSize: 20, radius: 16, opacity: 88, brightness: 100
    },
    amoled: {
      primary: '#38bdf8', accent: '#a855f7', bg: '#000000', card: '#0a0a0c',
      chatCard: '#050507', border: '#27272a', text: '#f0f9ff', mutedText: '#71717a',
      chatText: '#ffffff', selfChatText: '#7dd3fc', chatFontSize: 20, radius: 8, opacity: 96, brightness: 100
    },
    ocean: {
      primary: '#0ea5e9', accent: '#06b6d4', bg: '#04101c', card: '#0a2136',
      chatCard: '#07192b', border: '#1e3a5f', text: '#f0f9ff', mutedText: '#7dd3fc',
      chatText: '#e0f2fe', selfChatText: '#67e8f9', chatFontSize: 20, radius: 14, opacity: 88, brightness: 100
    },
    sakura: {
      primary: '#ec4899', accent: '#f472b6', bg: '#180814', card: '#2b1123',
      chatCard: '#230d1c', border: '#522142', text: '#fdf2f8', mutedText: '#f9a8d4',
      chatText: '#fce7f3', selfChatText: '#fbcfe8', chatFontSize: 20, radius: 18, opacity: 88, brightness: 100
    },
    gold: {
      primary: '#eab308', accent: '#f97316', bg: '#0f0c05', card: '#1c1709',
      chatCard: '#161207', border: '#423616', text: '#fefce8', mutedText: '#fde047',
      chatText: '#fef9c3', selfChatText: '#fde047', chatFontSize: 20, radius: 10, opacity: 90, brightness: 100
    }
  };

  // Topic prefix for public WebSocket relay (Ephemeral QoS 0, retain: false -> zero history stored)
  const TOPIC_PREFIX = 'livetype_zero_history_v1_9f8a7b';

  // Public Secure WebSocket Brokers (Automatic failover)
  const BROKER_URLS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];

  // Default Interest Filter Tags
  const PRESET_INTEREST_TAGS = [
    '🎮 เล่นเกม',
    '🎵 ฟังเพลง',
    '🎬 ดูหนัง/ซีรีส์',
    '🎌 อนิเมะ/มังงะ',
    '💻 เขียนโค้ด/ไอที',
    '🎨 วาดรูป/ศิลปะ',
    '🐱 ทาสแมว/สัตว์เลี้ยง',
    '🍜 สายกิน/คาเฟ่',
    '⚽ กีฬา/ฟิตเนส',
    '📚 อ่านหนังสือ',
    '✈️ ท่องเที่ยว',
    '🌙 คนนอนดึก',
    '💬 คุยเล่นเรื่อยเปื่อย',
    '❤️ หาเพื่อนคุย'
  ];

  // Built-in SVG Data URI Avatars
  const PRESET_AVATARS = [
    createSvgAvatar('🦊', '#f97316', '#ea580c'),
    createSvgAvatar('🐼', '#6366f1', '#4f46e5'),
    createSvgAvatar('🐱', '#ec4899', '#db2777'),
    createSvgAvatar('🐯', '#eab308', '#ca8a04'),
    createSvgAvatar('🐸', '#10b981', '#059669'),
    createSvgAvatar('🐙', '#8b5cf6', '#7c3aed'),
    createSvgAvatar('🦄', '#f43f5e', '#e11d48'),
    createSvgAvatar('🦉', '#06b6d4', '#0891b2'),
    createSvgAvatar('🐺', '#64748b', '#475569'),
    createSvgAvatar('🐲', '#14b8a6', '#0d9488'),
    createSvgAvatar('🤖', '#3b82f6', '#2563eb'),
    createSvgAvatar('👾', '#a855f7', '#9333ea')
  ];
  const PRESET_AVATARS_SET = new Set(PRESET_AVATARS);

  function createSvgAvatar(emoji, color1, color2) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${color1}"/>
          <stop offset="100%" stop-color="${color2}"/>
        </linearGradient>
      </defs>
      <rect width="120" height="120" rx="60" fill="url(#g)"/>
      <text x="50%" y="54%" dominant-baseline="central" text-anchor="middle" font-size="62">${emoji}</text>
    </svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  // =========================================================================
  // --- Security & Anti-Injection Defense Engine (XSS, Polyglot, Magic Bytes) ---
  // =========================================================================
  const MAX_IMAGE_DIMENSION = 8192; // Guard against Image Decompression Bomb / Pixel Flood

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeUid(input) {
    if (!input || typeof input !== 'string') return '';
    const cleaned = input.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
    if (cleaned === '__PROTO__' || cleaned === 'CONSTRUCTOR' || cleaned === 'PROTOTYPE') return '';
    return cleaned;
  }

  function sanitizeRoomCode(input) {
    if (!input || typeof input !== 'string') return '';
    const cleaned = input.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 16);
    if (cleaned === '__PROTO__' || cleaned === 'CONSTRUCTOR' || cleaned === 'PROTOTYPE') return '';
    return cleaned;
  }

  function sanitizeUsername(input, fallback = 'User') {
    if (!input || typeof input !== 'string') return fallback;
    const cleaned = input
      .replace(/[\x00-\x1F\x7F\u202A-\u202E\u2066-\u2069<>"'`/\\]/g, '')
      .trim()
      .slice(0, 24);
    return cleaned || fallback;
  }

  function sanitizeTag(input) {
    if (!input || typeof input !== 'string') return '';
    return input
      .replace(/[\x00-\x1F\x7F\u202A-\u202E\u2066-\u2069<>"'`\\]/g, '')
      .trim()
      .slice(0, 32);
  }

  function sanitizeAvatarUrl(url, fallback = PRESET_AVATARS[0]) {
    const defaultAvatar = fallback || PRESET_AVATARS[0];
    if (!url || typeof url !== 'string') return defaultAvatar;
    const trimmed = url.trim();
    // 1. Whitelisted built-in SVG emoji avatars
    if (PRESET_AVATARS_SET.has(trimmed)) return trimmed;
    // 2. Cap length at 550KB to prevent P2P memory/localStorage DoS
    if (trimmed.length > 550000) return defaultAvatar;
    // 3. Strict local preset asset path
    if (/^\.\/assets\/avatars\/avatar-\d+\.svg$/i.test(trimmed)) return trimmed;
    // 4. Strict Raster Base64 Data URI (JPEG, PNG, WEBP, GIF only — blocks arbitrary SVG script injection)
    if (/^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) {
      return trimmed;
    }
    // 5. Strict HTTPS URL (e.g. Google profile picture) without quotes, angle brackets, or whitespace
    if (/^https:\/\/[^\s"'<>\\`]+$/i.test(trimmed)) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === 'https:') return trimmed;
      } catch (e) {
        return defaultAvatar;
      }
    }
    return defaultAvatar;
  }

  function sanitizeChatMediaUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    // Cap length at ~3.5MB base64 to prevent P2P memory DoS
    if (trimmed.length > 3600000) return null;
    // 1. Strict Raster Image Base64 Data URI (JPEG, PNG, WEBP, GIF — NO SVG allowed!)
    if (/^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) {
      return trimmed;
    }
    // 2. Strict Transcoded WebM Video Base64 Data URI (from animated GIF compressor)
    if (/^data:video\/webm(?:;codecs=[a-z0-9,.]+)?;base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) {
      return trimmed;
    }
    // 3. Strict HTTPS external media URL (e.g. KLIPY GIFs/Stickers)
    if (/^https:\/\/[^\s"'<>\\`]+$/i.test(trimmed)) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === 'https:') return trimmed;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  async function validateImageMagicBytes(file) {
    if (!file || typeof file.slice !== 'function' || file.size < 12) {
      return { valid: false, detectedType: null };
    }
    try {
      const headerBuf = await file.slice(0, 12).arrayBuffer();
      const b = new Uint8Array(headerBuf);

      // JPEG: FF D8 FF
      if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
        return { valid: true, detectedType: 'image/jpeg' };
      }
      // PNG: 89 50 4E 47 0D 0A 1A 0A
      if (
        b[0] === 0x89 &&
        b[1] === 0x50 &&
        b[2] === 0x4e &&
        b[3] === 0x47 &&
        b[4] === 0x0d &&
        b[5] === 0x0a &&
        b[6] === 0x1a &&
        b[7] === 0x0a
      ) {
        return { valid: true, detectedType: 'image/png' };
      }
      // GIF: GIF87a or GIF89a (47 49 46 38 37/39 61)
      if (
        b[0] === 0x47 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x38 &&
        (b[4] === 0x37 || b[4] === 0x39) &&
        b[5] === 0x61
      ) {
        return { valid: true, detectedType: 'image/gif' };
      }
      // WebP: RIFF....WEBP
      if (
        b[0] === 0x52 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x46 &&
        b[8] === 0x57 &&
        b[9] === 0x45 &&
        b[10] === 0x42 &&
        b[11] === 0x50
      ) {
        return { valid: true, detectedType: 'image/webp' };
      }
    } catch (e) {
      return { valid: false, detectedType: null };
    }
    return { valid: false, detectedType: null };
  }

  async function scanFileForEmbeddedPayload(file) {
    try {
      // Scan head (512KB) and tail (128KB) for embedded HTML/JS/PHP/SVG polyglot payloads
      const MAX_SCAN = 512 * 1024;
      let headBuf;
      if (typeof file.arrayBuffer === 'function' && file.size <= MAX_SCAN) {
        headBuf = await file.arrayBuffer();
      } else if (file.slice) {
        headBuf = await file.slice(0, Math.min(file.size, MAX_SCAN)).arrayBuffer();
      } else {
        headBuf = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = reject;
          fr.readAsArrayBuffer(file.slice ? file.slice(0, Math.min(file.size, MAX_SCAN)) : file);
        });
      }

      let decoder;
      try {
        decoder = new TextDecoder('latin1');
      } catch (e) {
        try {
          decoder = new TextDecoder('iso-8859-1');
        } catch (e2) {
          decoder = new TextDecoder();
        }
      }
      let sample = decoder.decode(new Uint8Array(headBuf));

      if (file.size > MAX_SCAN && file.slice) {
        try {
          const tailBuf = await file.slice(Math.max(0, file.size - 131072), file.size).arrayBuffer();
          sample += '\n' + decoder.decode(new Uint8Array(tailBuf));
        } catch (e) {}
      }

      const patternRules = [
        {
          id: 'script_tag',
          name: 'แท็กสคริปต์ปฏิบัติการ (<script>)',
          severity: 'critical',
          regex: /<\s*script\b[^>]*>/i,
          desc: 'แท็ก JavaScript แท้จริงที่สามารถสั่งรันโค้ดบนเบราว์เซอร์ได้'
        },
        {
          id: 'javascript_protocol',
          name: 'โปรโตคอลสคริปต์ (javascript:)',
          severity: 'critical',
          regex: /javascript\s*:[^"'\s>]*/i,
          desc: 'URL Scheme ที่ใช้รันคำสั่ง JavaScript อัตโนมัติ'
        },
        {
          id: 'vbscript_protocol',
          name: 'โปรโตคอลสคริปต์ (vbscript:)',
          severity: 'critical',
          regex: /vbscript\s*:[^"'\s>]*/i,
          desc: 'VBScript execution scheme'
        },
        {
          id: 'event_handler',
          name: 'Event Handler ทำงานอัตโนมัติ (onload/onerror/onclick)',
          severity: 'critical',
          regex: /on(?:load|error|mouseover|click|focus|submit|reset)\s*=\s*["']?[^"'>\s]+/i,
          desc: 'แอตทริบิวต์ดักจับเหตุการณ์ที่รันโค้ดเมื่อโหลดหรือแสดงภาพ'
        },
        {
          id: 'iframe_tag',
          name: 'แท็กเฟรมซ้อน (<iframe)',
          severity: 'high',
          regex: /<\s*iframe\b[^>]*>/i,
          desc: 'แท็กฝังหน้าเว็บหรือเนื้อหาภายนอก'
        },
        {
          id: 'object_embed_tag',
          name: 'แท็กวัตถุภายนอก (<object> หรือ <embed>)',
          severity: 'high',
          regex: /<\s*(?:object|embed)\b[^>]*>/i,
          desc: 'แท็กฝัง Plugin หรือ Executable Binary'
        },
        {
          id: 'php_tag',
          name: 'โค้ดเซิร์ฟเวอร์ PHP (<?php)',
          severity: 'high',
          regex: /<\?php\b[\s\S]{0,100}/i,
          desc: 'สคริปต์ฝั่งเซิร์ฟเวอร์ PHP ที่ใช้ใน Polyglot Webshell'
        },
        {
          id: 'eval_call',
          name: 'ฟังก์ชันประมวลผลโค้ด (eval())',
          severity: 'critical',
          regex: /eval\s*\([^)]*\)/i,
          desc: 'คำสั่งรัน Dynamic Code Execution ใน JavaScript'
        },
        {
          id: 'cookie_theft',
          name: 'คำสั่งเข้าถึงคุกกี้ (document.cookie)',
          severity: 'critical',
          regex: /document\.cookie/i,
          desc: 'คำสั่งเข้าถึงข้อมูล Session/Cookie ของผู้ใช้'
        },
        {
          id: 'svg_tag',
          name: 'แท็กภาพเวกเตอร์ (<svg>) / C2PA Metadata',
          severity: 'warning',
          regex: /<\s*svg\b[^>]*>/i,
          desc: 'โค้ดภาพเวกเตอร์ XML หรือ Metadata แสดงสัญลักษณ์ดิจิทัล (เช่น C2PA ของ OpenAI / DALL-E)'
        }
      ];

      for (const rule of patternRules) {
        const match = sample.match(rule.regex);
        if (match) {
          const rawMatch = match[0];
          const matchIndex = match.index || 0;
          const snippetStart = Math.max(0, matchIndex - 20);
          const snippetEnd = Math.min(sample.length, matchIndex + rawMatch.length + 40);
          const snippet = sample.slice(snippetStart, snippetEnd).replace(/[\r\n\t]+/g, ' ').trim();

          const isC2PA = /c2pa|softwareAgent|ChatGPT|gpt-image|DALL-E/i.test(
            sample.slice(Math.max(0, matchIndex - 300), Math.min(sample.length, matchIndex + 300))
          );

          return {
            isClean: false,
            ruleId: rule.id,
            threatName: rule.name,
            severity: rule.severity,
            matchedSnippet: rawMatch.slice(0, 100),
            contextSnippet: snippet.slice(0, 140),
            description: rule.desc,
            isC2PA,
            advice: isC2PA
              ? 'รูปภาพนี้สร้างด้วย AI (เช่น ChatGPT/DALL-E) และมีข้อมูลสิทธิ์ Content Credentials (C2PA) ซึ่งฝังไอคอน <svg> ไว้ แม้ไม่ใช่ไวรัสจริงแต่มีโค้ดเวกเตอร์แฝงอยู่ คุณสามารถกดปุ่ม "ล้างโค้ดแฝงด้วย Canvas" เพื่อตัดข้อมูล Metadata ออกและใช้งานต่อได้อย่างปลอดภัย 100%'
              : (rule.severity === 'critical'
                ? `ตรวจพบคำสั่งปฏิบัติการ JavaScript หรือ Event Handler [${rawMatch.slice(0, 40)}] ที่อาจเป็นภัยคุกคาม XSS ระบบได้ทำการระงับไฟล์นี้ทันที`
                : `ตรวจพบแท็กมาร์กอัปแปลกปลอม [${rawMatch.slice(0, 40)}] แฝงอยู่ในไฟล์รูปภาพ แนะนำให้ล้างข้อมูลด้วย Canvas ก่อนใช้งาน`)
          };
        }
      }

      return { isClean: true };
    } catch (e) {
      console.warn('LiveType Image Security Scanner notice:', e);
      return { isClean: true };
    }
  }

  async function validateImageFileSecurity(file, { maxBytes = 25 * 1024 * 1024, allowGif = true } = {}) {
    if (!file || file.size <= 0) {
      return { ok: false, reason: '⚠️ ไม่พบข้อมูลในไฟล์รูปภาพ', threatDetails: null };
    }
    if (file.size > maxBytes) {
      return { ok: false, reason: '⚠️ ไฟล์รูปภาพมีขนาดใหญ่เกินกำหนด (สูงสุด 25MB)', threatDetails: null };
    }
    const magic = await validateImageMagicBytes(file);
    if (!magic.valid || !magic.detectedType) {
      return {
        ok: false,
        reason: '🛡️ ระบบความปลอดภัยบล็อกไฟล์นี้: อนุญาตเฉพาะไฟล์ภาพจริง (JPG, PNG, WEBP, GIF) เท่านั้น',
        threatDetails: null
      };
    }
    if (!allowGif && magic.detectedType === 'image/gif') {
      return {
        ok: false,
        reason: '⚠️ กรุณาเลือกไฟล์ภาพนิ่ง (JPG, PNG, WEBP) สำหรับส่วนนี้',
        threatDetails: null
      };
    }
    const scanResult = await scanFileForEmbeddedPayload(file);
    if (!scanResult.isClean) {
      const summaryMsg = `🛡️ บล็อกไฟล์รูปภาพ: ตรวจพบ [${scanResult.threatName}] โค้ดที่พบ: "${scanResult.matchedSnippet}"`;
      return {
        ok: false,
        reason: summaryMsg,
        threatDetails: scanResult,
        file
      };
    }
    return { ok: true, detectedType: magic.detectedType };
  }

  function generateNewUid() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const part = (len) => {
      let s = '';
      for (let i = 0; i < len; i++) {
        s += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return s;
    };
    return `${part(5)}-${part(5)}`;
  }

  function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  // Application State
  let currentUser = loadUserSession(); // { uid, username, avatar, tags } or null
  let selectedAvatar = currentUser ? currentUser.avatar : PRESET_AVATARS[0];
  let selectedTags = new Set(currentUser && Array.isArray(currentUser.tags) ? currentUser.tags : ['💬 คุยเล่นเรื่อยเปื่อย']);
  let friendsMap = loadFriendsList(); // Map<uid, { uid, username, avatar, tags, online, inRoom, roomCode, lastSeen }>
  let incomingFriendRequests = new Map(); // Map<uid, { uid, username, avatar, ts }>
  let sentFriendRequests = new Set(); // Set<uid>
  let activeRoomCode = null;
  let isRoomPublic = true; // Whether active room is discoverable via Tag Matchmaking
  let roomMembers = new Map(); // Map<uid, { uid, username, avatar, tags, currentText, image, updatedAt }>
  let discoveredRooms = new Map(); // Map<roomCode, { roomCode, hostName, hostAvatar, memberCount, tags, updatedAt }>
  let currentImage = null; // Base64 data URL for live image typing
  let pendingInviteRoomCode = null;
  let deferredInstallPrompt = null;
  let mqttClient = null;
  let brokerIndex = 0;
  let heartbeatTimer = null;

  // WebRTC Live Screen Streaming State
  let localScreenStream = null;
  let isScreenSharing = false;
  let activeStreamerUid = null;
  let activeStreamerUsername = null;
  let isWatching = false;
  let streamPeers = new Map(); // Map<viewerUid, RTCPeerConnection> for streamer
  let viewerPeerConnection = null; // RTCPeerConnection for viewer
  let pendingIceCandidates = [];
  let selectedResolution = '720p';
  let selectedFps = 60; // 60 FPS default for ultra-smooth streaming
  let selectedStreamMode = 'motion'; // 'motion' (Smooth/Gaming) or 'detail' (Sharp/Text)
  let streamStatsInterval = null;
  let lastStatsBytes = 0;
  let lastStatsFrames = 0;
  let lastStatsTimestamp = 0;

  const STORAGE_KEY_STREAM_VOLUME = 'livetype_stream_volume_v1';

  function loadStreamVolume() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_STREAM_VOLUME);
      if (saved !== null) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 200) {
          return parsed;
        }
      }
    } catch (e) {}
    return 100; // default 100%
  }

  let currentStreamVolume = loadStreamVolume();
  let previousNonZeroVolume = currentStreamVolume > 0 ? currentStreamVolume : 100;

  // Web Audio Context & Gain Node for 0-200% Audio Amplification
  let streamAudioCtx = null;
  let streamGainNode = null;
  let streamAudioSourceNode = null;

  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  };

  // DOM Elements
  const viewSetup = document.getElementById('viewSetup');
  const viewWorkspace = document.getElementById('viewWorkspace');
  const formSetup = document.getElementById('formSetup');
  const inputUsername = document.getElementById('inputUsername');
  const setupAvatarPreview = document.getElementById('setupAvatarPreview');
  const inputCustomAvatar = document.getElementById('inputCustomAvatar');
  const presetAvatarGrid = document.getElementById('presetAvatarGrid');
  const existingUidNotice = document.getElementById('existingUidNotice');
  const setupUidText = document.getElementById('setupUidText');
  const presetTagsContainer = document.getElementById('presetTagsContainer');
  const inputCustomTag = document.getElementById('inputCustomTag');
  const btnAddCustomTag = document.getElementById('btnAddCustomTag');
  const mySidebarTags = document.getElementById('mySidebarTags');
  const btnAutoMatchRoom = document.getElementById('btnAutoMatchRoom');
  const inputFilterRoomsTag = document.getElementById('inputFilterRoomsTag');
  const btnScanRooms = document.getElementById('btnScanRooms');
  const discoverRoomsList = document.getElementById('discoverRoomsList');
  const btnToggleRoomPublic = document.getElementById('btnToggleRoomPublic');

  const userChip = document.getElementById('userChip');
  const headerAvatar = document.getElementById('headerAvatar');
  const headerUsername = document.getElementById('headerUsername');
  const headerUid = document.getElementById('headerUid');
  const headerAuthBadge = document.getElementById('headerAuthBadge');
  const btnEditProfile = document.getElementById('btnEditProfile');
  const btnLogout = document.getElementById('btnLogout');
  const connectionStatus = document.getElementById('connectionStatus');
  const btnInstallPwa = document.getElementById('btnInstallPwa');

  const btnGoogleSignIn = document.getElementById('btnGoogleSignIn');
  const googleAuthSuccessBox = document.getElementById('googleAuthSuccessBox');
  const googleEmailLabel = document.getElementById('googleEmailLabel');
  const btnGoogleSignOut = document.getElementById('btnGoogleSignOut');

  const btnOpenGoogleDriveModal = document.getElementById('btnOpenGoogleDriveModal');
  const googleDriveModal = document.getElementById('googleDriveModal');
  const btnCloseGoogleDriveModal = document.getElementById('btnCloseGoogleDriveModal');
  const modalGoogleAccountBox = document.getElementById('modalGoogleAccountBox');
  const modalGoogleSignInBox = document.getElementById('modalGoogleSignInBox');
  const modalGoogleAvatar = document.getElementById('modalGoogleAvatar');
  const modalGoogleName = document.getElementById('modalGoogleName');
  const modalGoogleEmail = document.getElementById('modalGoogleEmail');
  const btnModalGoogleSignIn = document.getElementById('btnModalGoogleSignIn');
  const btnModalGoogleSignOut = document.getElementById('btnModalGoogleSignOut');
  const btnManualSyncDrive = document.getElementById('btnManualSyncDrive');
  const btnManualDownloadDrive = document.getElementById('btnManualDownloadDrive');
  const inputGoogleClientId = document.getElementById('inputGoogleClientId');
  const btnSaveGoogleClientId = document.getElementById('btnSaveGoogleClientId');
  const googleClientIdStatus = document.getElementById('googleClientIdStatus');

  const workspaceGrid = document.getElementById('workspaceGrid');
  const sidebarPanel = document.getElementById('sidebarPanel');
  const btnCollapseSidebar = document.getElementById('btnCollapseSidebar');
  const btnExpandSidebar = document.getElementById('btnExpandSidebar');
  const btnNavChat = document.getElementById('btnNavChat');
  const btnNavFriend = document.getElementById('btnNavFriend');
  const sidebarPaneChat = document.getElementById('sidebarPaneChat');
  const sidebarPaneFriend = document.getElementById('sidebarPaneFriend');
  const sidebarRoomsList = document.getElementById('sidebarRoomsList');
  const btnSidebarScanRooms = document.getElementById('btnSidebarScanRooms');
  const friendReqBadge = document.getElementById('friendReqBadge');
  const friendRequestsBox = document.getElementById('friendRequestsBox');
  const friendRequestsList = document.getElementById('friendRequestsList');
  const btnCopyHeaderUid = document.getElementById('btnCopyHeaderUid');
  const btnCreateRoom = document.getElementById('btnCreateRoom');
  const btnEmptyCreateRoom = document.getElementById('btnEmptyCreateRoom');
  const formJoinRoom = document.getElementById('formJoinRoom');
  const inputRoomCode = document.getElementById('inputRoomCode');
  const btnOpenQrScanner = document.getElementById('btnOpenQrScanner');
  const btnShowSidebarRoomQr = document.getElementById('btnShowSidebarRoomQr');
  const btnShowRoomQr = document.getElementById('btnShowRoomQr');
  const qrDisplayModal = document.getElementById('qrDisplayModal');
  const roomQrImage = document.getElementById('roomQrImage');
  const qrModalRoomCode = document.getElementById('qrModalRoomCode');
  const btnDownloadQr = document.getElementById('btnDownloadQr');
  const btnCloseQrModal = document.getElementById('btnCloseQrModal');
  const qrScannerModal = document.getElementById('qrScannerModal');
  const inputQrFile = document.getElementById('inputQrFile');
  const btnCloseScannerModal = document.getElementById('btnCloseScannerModal');
  const formAddFriend = document.getElementById('formAddFriend');
  const inputFriendUid = document.getElementById('inputFriendUid');
  const btnRefreshFriends = document.getElementById('btnRefreshFriends');
  const friendsListContainer = document.getElementById('friendsListContainer');

  const roomEmptyState = document.getElementById('roomEmptyState');
  const roomActiveView = document.getElementById('roomActiveView');
  const activeRoomCodeEl = document.getElementById('activeRoomCode');
  const btnCopyRoomCode = document.getElementById('btnCopyRoomCode');
  const btnCopyRoomLink = document.getElementById('btnCopyRoomLink');
  const btnToggleRoomLayout = document.getElementById('btnToggleRoomLayout');
  const roomLayoutIcon = document.getElementById('roomLayoutIcon');
  const roomLayoutLabel = document.getElementById('roomLayoutLabel');
  const roomMemberCount = document.getElementById('roomMemberCount');
  const btnLeaveRoom = document.getElementById('btnLeaveRoom');
  const btnMobileToggleSidebar = document.getElementById('btnMobileToggleSidebar');
  const btnBackToSidebar = document.getElementById('btnBackToSidebar');
  const btnToggleScreenShare = document.getElementById('btnToggleScreenShare');
  const floatingStreamWindow = document.getElementById('floatingStreamWindow');
  const streamDragHandle = document.getElementById('streamDragHandle');
  const floatingStreamerTitle = document.getElementById('floatingStreamerTitle');
  const btnMinimizeFloatingStream = document.getElementById('btnMinimizeFloatingStream');
  const btnFloatingFullscreen = document.getElementById('btnFloatingFullscreen');
  const btnCloseFloatingStream = document.getElementById('btnCloseFloatingStream');
  const streamResizeHandle = document.getElementById('streamResizeHandle');
  const streamContainer = document.getElementById('streamContainer');
  const liveStreamVideo = document.getElementById('liveStreamVideo');
  const streamPlaceholderOverlay = document.getElementById('streamPlaceholderOverlay');
  const streamPlaceholderTitle = document.getElementById('streamPlaceholderTitle');
  const streamPlaceholderSub = document.getElementById('streamPlaceholderSub');
  const btnToggleWatchStream = document.getElementById('btnToggleWatchStream');
  const streamerNameBadge = document.getElementById('streamerNameBadge');
  const streamStatusBadge = document.getElementById('streamStatusBadge');
  const selectStreamResolution = document.getElementById('selectStreamResolution');
  const selectStreamFps = document.getElementById('selectStreamFps');
  const selectStreamMode = document.getElementById('selectStreamMode');
  const btnStreamVolume = document.getElementById('btnStreamVolume');
  const rangeStreamVolume = document.getElementById('rangeStreamVolume');
  const streamVolumeText = document.getElementById('streamVolumeText');
  const btnStreamFullscreen = document.getElementById('btnStreamFullscreen');
  const btnStopWatchStream = document.getElementById('btnStopWatchStream');
  const liveCardsGrid = document.getElementById('liveCardsGrid');
  const liveTypingInput = document.getElementById('liveTypingInput');
  const btnClearEnter = document.getElementById('btnClearEnter');
  const charCounter = document.getElementById('charCounter');
  const inputLiveImage = document.getElementById('inputLiveImage');
  const inputImagePreviewBar = document.getElementById('inputImagePreviewBar');
  const inputPreviewThumb = document.getElementById('inputPreviewThumb');
  const btnRemoveInputImage = document.getElementById('btnRemoveInputImage');
  const btnToggleGifPicker = document.getElementById('btnToggleGifPicker');
  const btnToggleEmotePicker = document.getElementById('btnToggleEmotePicker');
  const gifPickerPopover = document.getElementById('gifPickerPopover');
  const gifSearchRow = document.getElementById('gifSearchRow');
  const btnBackToGifCategories = document.getElementById('btnBackToGifCategories');
  const inputGifSearch = document.getElementById('inputGifSearch');
  const btnCloseGifPicker = document.getElementById('btnCloseGifPicker');
  const gifResultsGrid = document.getElementById('gifResultsGrid');
  const emotePickerGrid = document.getElementById('emotePickerGrid');
  const gifPoweredByText = document.getElementById('gifPoweredByText');

  const inviteModal = document.getElementById('inviteModal');
  const inviteAvatar = document.getElementById('inviteAvatar');
  const inviteUsername = document.getElementById('inviteUsername');
  const inviteUid = document.getElementById('inviteUid');
  const inviteRoomCode = document.getElementById('inviteRoomCode');
  const btnAcceptInvite = document.getElementById('btnAcceptInvite');
  const btnDeclineInvite = document.getElementById('btnDeclineInvite');
  const toastContainer = document.getElementById('toastContainer');

  // Theme Customizer Elements
  const btnOpenTheme = document.getElementById('btnOpenTheme');
  const themeModal = document.getElementById('themeModal');
  const btnCloseTheme = document.getElementById('btnCloseTheme');
  const btnResetTheme = document.getElementById('btnResetTheme');
  const colorPickerPrimary = document.getElementById('colorPickerPrimary');
  const colorPickerAccent = document.getElementById('colorPickerAccent');
  const colorPickerBg = document.getElementById('colorPickerBg');
  const colorPickerCard = document.getElementById('colorPickerCard');
  const colorPickerChatCard = document.getElementById('colorPickerChatCard');
  const colorPickerBorder = document.getElementById('colorPickerBorder');
  const colorPickerText = document.getElementById('colorPickerText');
  const colorPickerMutedText = document.getElementById('colorPickerMutedText');
  const colorPickerChatText = document.getElementById('colorPickerChatText');
  const colorPickerSelfChatText = document.getElementById('colorPickerSelfChatText');
  const rangeChatFontSize = document.getElementById('rangeChatFontSize');
  const chatFontSizeValText = document.getElementById('chatFontSizeValText');
  const rangeRadius = document.getElementById('rangeRadius');
  const radiusValText = document.getElementById('radiusValText');
  const rangeOpacity = document.getElementById('rangeOpacity');
  const opacityValText = document.getElementById('opacityValText');
  const rangeBrightness = document.getElementById('rangeBrightness');
  const brightnessValText = document.getElementById('brightnessValText');
  const hexPrimary = document.getElementById('hexPrimary');
  const hexAccent = document.getElementById('hexAccent');
  const hexBg = document.getElementById('hexBg');
  const hexCard = document.getElementById('hexCard');
  const hexChatCard = document.getElementById('hexChatCard');
  const hexBorder = document.getElementById('hexBorder');
  const hexText = document.getElementById('hexText');
  const hexMutedText = document.getElementById('hexMutedText');
  const hexChatText = document.getElementById('hexChatText');
  const hexSelfChatText = document.getElementById('hexSelfChatText');

  // Custom Background Wallpaper & Cropper Elements
  const appCustomBg = document.getElementById('appCustomBg');
  const inputCustomBg = document.getElementById('inputCustomBg');
  const customBgThumb = document.getElementById('customBgThumb');
  const customBgThumbText = document.getElementById('customBgThumbText');
  const btnRemoveCustomBg = document.getElementById('btnRemoveCustomBg');
  const customBgControls = document.getElementById('customBgControls');
  const rangeBgDim = document.getElementById('rangeBgDim');
  const bgDimValText = document.getElementById('bgDimValText');
  const rangeBgBlur = document.getElementById('rangeBgBlur');
  const bgBlurValText = document.getElementById('bgBlurValText');

  const bgCropModal = document.getElementById('bgCropModal');
  const cropCanvasViewport = document.getElementById('cropCanvasViewport');
  const cropCanvas = document.getElementById('cropCanvas');
  const cropSizeInfo = document.getElementById('cropSizeInfo');
  const btnCancelCrop = document.getElementById('btnCancelCrop');
  const btnApplyCrop = document.getElementById('btnApplyCrop');

  // Avatar Profile Picture Cropper Elements
  const avatarCropModal = document.getElementById('avatarCropModal');
  const avatarCropCanvasViewport = document.getElementById('avatarCropCanvasViewport');
  const avatarCropCanvas = document.getElementById('avatarCropCanvas');
  const avatarCirclePreviewCanvas = document.getElementById('avatarCirclePreviewCanvas');
  const avatarCropSizeInfo = document.getElementById('avatarCropSizeInfo');
  const btnCancelAvatarCrop = document.getElementById('btnCancelAvatarCrop');
  const btnApplyAvatarCrop = document.getElementById('btnApplyAvatarCrop');

  // Security Threat Alert & Sanitizer Modal Elements
  const securityAlertModal = document.getElementById('securityAlertModal');
  const secAlertSummary = document.getElementById('secAlertSummary');
  const secAlertFileName = document.getElementById('secAlertFileName');
  const secAlertThreatType = document.getElementById('secAlertThreatType');
  const secAlertSnippetBox = document.getElementById('secAlertSnippetBox');
  const secAlertSnippetRow = document.getElementById('secAlertSnippetRow');
  const secAlertAdvice = document.getElementById('secAlertAdvice');
  const btnCancelSecurityAlert = document.getElementById('btnCancelSecurityAlert');
  const btnSanitizeAndProceed = document.getElementById('btnSanitizeAndProceed');

  // --- Topic Builders (Protected against MQTT wildcard / path injection) ---
  const topicInbox = (uid) => `${TOPIC_PREFIX}/inbox/${sanitizeUid(uid)}`;
  const topicPresence = (uid) => `${TOPIC_PREFIX}/presence/${sanitizeUid(uid)}`;
  const topicRoom = (code) => `${TOPIC_PREFIX}/room/${sanitizeRoomCode(code)}`;
  const topicDirectory = () => `${TOPIC_PREFIX}/directory`;

  // --- LocalStorage Helpers ---
  function loadUserSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_USER);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.uid && parsed.username) {
        const cleanRawUid = String(parsed.uid).replace(/[^A-Za-z0-9]/g, '');
        parsed.uid = cleanRawUid.length < 10 ? generateNewUid() : sanitizeUid(parsed.uid) || generateNewUid();
        parsed.username = sanitizeUsername(parsed.username);
        parsed.avatar = sanitizeAvatarUrl(parsed.avatar, PRESET_AVATARS[0]);
        if (Array.isArray(parsed.tags)) {
          parsed.tags = parsed.tags.slice(0, 8).map(sanitizeTag).filter(Boolean);
        }
        saveUserSession(parsed);
        return parsed;
      }
    } catch (e) {
      // Ignore
    }
    return null;
  }

  function saveUserSession(user) {
    localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));
  }

  function clearUserSession() {
    localStorage.removeItem(STORAGE_KEY_USER);
    localStorage.removeItem(STORAGE_KEY_FRIENDS);
  }

  function loadFriendsList() {
    const map = new Map();
    try {
      const raw = localStorage.getItem(STORAGE_KEY_FRIENDS);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          arr.forEach((f) => {
            const cleanUid = f && f.uid ? sanitizeUid(f.uid) : '';
            if (cleanUid) {
              map.set(cleanUid, {
                uid: cleanUid,
                username: sanitizeUsername(f.username || cleanUid, cleanUid),
                avatar: sanitizeAvatarUrl(f.avatar, PRESET_AVATARS[0]),
                online: false,
                inRoom: false,
                roomCode: null,
                lastSeen: 0
              });
            }
          });
        }
      }
    } catch (e) {
      // Ignore
    }
    return map;
  }

  async function syncGoogleDriveIfAuthenticated() {
    if (window.LiveTypeDrive && currentUser && currentUser.authProvider === 'google') {
      const token = window.LiveTypeDrive.getAccessToken();
      if (!token) return;
      try {
        await window.LiveTypeDrive.saveAppData(token, {
          username: currentUser.username,
          avatar: currentUser.avatar,
          tags: Array.isArray(currentUser.tags) ? currentUser.tags : Array.from(selectedTags),
          email: currentUser.email,
          friends: Array.from(friendsMap.values()).map((f) => ({
            uid: f.uid,
            username: f.username
          })),
          updatedAt: Date.now()
        });
      } catch (e) {
        console.warn('Background Google Drive AppData sync error:', e);
      }
    }
  }

  function saveFriendsList() {
    const arr = Array.from(friendsMap.values()).map((f) => ({
      uid: f.uid,
      username: f.username,
      avatar: f.avatar
    }));
    localStorage.setItem(STORAGE_KEY_FRIENDS, JSON.stringify(arr));
    syncGoogleDriveIfAuthenticated();
  }

  // --- Toast Notification ---
  function showToast(message, duration = 3000) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    toastContainer.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, duration);
  }

  // --- Serverless Realtime Network Engine (MQTT over WSS) ---
  function connectServerlessNetwork() {
    if (!currentUser) return;
    if (mqttClient) {
      try {
        mqttClient.end(true);
      } catch (e) {}
      mqttClient = null;
    }

    const brokerUrl = BROKER_URLS[brokerIndex % BROKER_URLS.length];
    const clientId = `lt_${currentUser.uid}_${Math.random().toString(36).slice(2, 7)}`;

    // Last Will and Testament: automatically notify friends & room if browser tab closes abruptly
    const willPayload = JSON.stringify({
      type: 'presence',
      uid: currentUser.uid,
      username: currentUser.username,
      avatar: currentUser.avatar,
      online: false,
      inRoom: false,
      roomCode: null,
      ts: Date.now()
    });

    mqttClient = window.mqtt.connect(brokerUrl, {
      clientId,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 2500,
      connectTimeout: 8000,
      will: {
        topic: topicPresence(currentUser.uid),
        payload: willPayload,
        qos: 0,
        retain: false
      }
    });

    mqttClient.on('connect', () => {
      connectionStatus.classList.remove('offline');
      connectionStatus.classList.add('online');
      connectionStatus.querySelector('.conn-label').textContent = 'Serverless Online';

      // 1. Subscribe to our personal inbox (for direct friend pings & room invitations)
      mqttClient.subscribe(topicInbox(currentUser.uid), { qos: 1 });

      // 2. Subscribe to public room directory for Tag Matchmaking
      mqttClient.subscribe(topicDirectory(), { qos: 0 });

      // 3. Subscribe to all friends' presence channels
      friendsMap.forEach((_, friendUid) => {
        mqttClient.subscribe(topicPresence(friendUid), { qos: 0 });
      });

      // 4. Re-subscribe to active room if currently in one
      if (activeRoomCode) {
        mqttClient.subscribe(topicRoom(activeRoomCode), { qos: 0 });
        broadcastRoomJoin();
        broadcastActiveRoomToDirectory();
      }

      // 5. Broadcast our online status, query public rooms & ping all friends
      broadcastMyPresence(true);
      requestDirectoryScan();
      pingAllFriends();
      checkUrlRoomInvite();
    });

    mqttClient.on('error', () => {
      brokerIndex = (brokerIndex + 1) % BROKER_URLS.length;
    });

    mqttClient.on('offline', () => {
      connectionStatus.classList.remove('online');
      connectionStatus.classList.add('offline');
      connectionStatus.querySelector('.conn-label').textContent = 'Reconnecting...';
    });

    mqttClient.on('message', (topic, messageBuffer) => {
      if (!messageBuffer || messageBuffer.length > 4 * 1024 * 1024) return; // Guard against oversized payload DoS
      let data;
      try {
        data = JSON.parse(messageBuffer.toString());
      } catch (e) {
        return;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;

      if (currentUser && topic === topicInbox(currentUser.uid)) {
        handleInboxMessage(data);
      } else if (topic === topicDirectory()) {
        handleDirectoryMessage(data);
      } else if (topic.startsWith(`${TOPIC_PREFIX}/presence/`)) {
        handlePresenceMessage(data);
      } else if (activeRoomCode && topic === topicRoom(activeRoomCode)) {
        handleRoomMessage(data);
      }
    });

    // Periodic heartbeat so friends & room radar know we're still online
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (mqttClient && mqttClient.connected && currentUser) {
        broadcastMyPresence(true);
        if (activeRoomCode && isRoomPublic) {
          broadcastActiveRoomToDirectory();
        }
      }
      // Mark friends offline if no heartbeat for 75s
      const now = Date.now();
      let changed = false;
      friendsMap.forEach((f) => {
        if (f.online && f.lastSeen && now - f.lastSeen > 75000) {
          f.online = false;
          f.inRoom = false;
          f.roomCode = null;
          changed = true;
        }
      });
      if (changed) renderFriendsList();

      // Clean up stale discovered rooms older than 65s
      let roomsChanged = false;
      discoveredRooms.forEach((r, code) => {
        if (now - r.updatedAt > 65000) {
          discoveredRooms.delete(code);
          roomsChanged = true;
        }
      });
      if (roomsChanged && !activeRoomCode) renderDiscoveredRooms();
    }, 22000);
  }

  function publishJson(topic, payload) {
    if (!mqttClient || !mqttClient.connected) return;
    // Always qos: 0 and retain: false -> zero data stored on broker!
    mqttClient.publish(topic, JSON.stringify(payload), { qos: 0, retain: false });
  }

  // Guaranteed P2P delivery with auto-retry for critical actions (Friend Requests, Room Invites)
  function publishReliable(topic, payload, ackId, maxRetries = 5, interval = 900) {
    let retries = 0;
    const send = () => {
      if (acknowledgedPackets.has(ackId)) return;
      publishJson(topic, { ...payload, ackId });
      retries++;
      if (retries < maxRetries && !acknowledgedPackets.has(ackId)) {
        setTimeout(send, interval);
      }
    };
    send();
  }

  const acknowledgedPackets = new Set();
  function markAckReceived(ackId) {
    if (ackId) acknowledgedPackets.add(ackId);
  }

  function broadcastMyPresence(isOnline) {
    if (!currentUser) return;
    publishJson(topicPresence(currentUser.uid), {
      type: 'presence',
      uid: currentUser.uid,
      username: currentUser.username,
      avatar: currentUser.avatar,
      tags: Array.from(selectedTags),
      online: Boolean(isOnline),
      inRoom: Boolean(isOnline && activeRoomCode),
      roomCode: isOnline ? activeRoomCode : null,
      ts: Date.now()
    });
  }

  // --- Room Directory & Tag Matchmaking Engine ---
  function getAggregatedRoomTags() {
    const tagSet = new Set(selectedTags);
    roomMembers.forEach((m) => {
      if (Array.isArray(m.tags)) {
        m.tags.forEach((t) => tagSet.add(t));
      }
    });
    return Array.from(tagSet);
  }

  function broadcastActiveRoomToDirectory() {
    if (!currentUser || !activeRoomCode || !isRoomPublic) return;
    publishJson(topicDirectory(), {
      type: 'room_announce',
      roomCode: activeRoomCode,
      hostUid: currentUser.uid,
      hostName: currentUser.username,
      hostAvatar: currentUser.avatar,
      memberCount: Math.max(1, roomMembers.size),
      tags: getAggregatedRoomTags(),
      ts: Date.now()
    });
  }

  function broadcastRoomClosedToDirectory(code) {
    if (!code) return;
    publishJson(topicDirectory(), {
      type: 'room_closed',
      roomCode: code
    });
  }

  function requestDirectoryScan() {
    if (!currentUser) return;
    publishJson(topicDirectory(), {
      type: 'room_query',
      fromUid: currentUser.uid
    });
  }

  function handleDirectoryMessage(data) {
    if (!data) return;

    // 1. Someone is scanning for active rooms -> if we are in a public room, announce our room & tags!
    if (data.type === 'room_query') {
      const fromUid = sanitizeUid(data.fromUid);
      if (activeRoomCode && isRoomPublic && currentUser && fromUid !== currentUser.uid) {
        broadcastActiveRoomToDirectory();
      }
      return;
    }

    // 2. Received an active room announcement
    if (data.type === 'room_announce' && data.roomCode) {
      const cleanCode = sanitizeRoomCode(data.roomCode);
      if (!cleanCode) return;
      discoveredRooms.set(cleanCode, {
        roomCode: cleanCode,
        hostUid: sanitizeUid(data.hostUid),
        hostName: sanitizeUsername(data.hostName || 'ไม่ระบุชื่อ', 'ไม่ระบุชื่อ'),
        hostAvatar: sanitizeAvatarUrl(data.hostAvatar, PRESET_AVATARS[0]),
        memberCount: Math.max(1, Math.min(999, parseInt(data.memberCount, 10) || 1)),
        tags: Array.isArray(data.tags) ? data.tags.slice(0, 8).map(sanitizeTag).filter(Boolean) : [],
        updatedAt: Date.now()
      });
      renderDiscoveredRooms();
      return;
    }

    // 3. Room closed or switched to private
    if (data.type === 'room_closed' && data.roomCode) {
      const cleanCode = sanitizeRoomCode(data.roomCode);
      if (cleanCode && discoveredRooms.has(cleanCode)) {
        discoveredRooms.delete(cleanCode);
        renderDiscoveredRooms();
      }
    }
  }

  function calculateTagMatch(roomTags) {
    if (!Array.isArray(roomTags) || roomTags.length === 0) {
      return { matchedTags: [], score: 0 };
    }
    const myTagsLower = new Map();
    selectedTags.forEach((t) => myTagsLower.set(t.toLowerCase(), t));

    const matchedTags = [];
    roomTags.forEach((rt) => {
      const clean = String(rt).trim();
      if (myTagsLower.has(clean.toLowerCase())) {
        matchedTags.push(clean);
      }
    });

    const totalMyTags = Math.max(1, selectedTags.size);
    const score = Math.round((matchedTags.length / totalMyTags) * 100);
    return { matchedTags, score };
  }

  function renderDiscoveredRooms() {
    if (!discoverRoomsList) return;
    discoverRoomsList.innerHTML = '';

    const filterKeyword = (inputFilterRoomsTag && inputFilterRoomsTag.value || '').trim().toLowerCase();
    const myTagsLower = new Set(Array.from(selectedTags).map((t) => t.toLowerCase()));

    const scoredRooms = Array.from(discoveredRooms.values())
      .filter((r) => {
        if (!filterKeyword) return true;
        const matchCode = r.roomCode.toLowerCase().includes(filterKeyword);
        const matchHost = (r.hostName || '').toLowerCase().includes(filterKeyword);
        const matchTag = (r.tags || []).some((t) => String(t).toLowerCase().includes(filterKeyword));
        return matchCode || matchHost || matchTag;
      })
      .map((r) => {
        const match = calculateTagMatch(r.tags);
        return { ...r, matchedTags: match.matchedTags, matchCount: match.matchedTags.length, score: match.score };
      })
      .sort((a, b) => {
        if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
        return b.updatedAt - a.updatedAt;
      });

    if (scoredRooms.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'friend-empty';
      empty.innerHTML =
        'ยังไม่มีห้องสาธารณะที่เปิดอยู่ตอนนี้ หรือไม่มีห้องที่ตรงกับคำค้นหา<br>กด <strong>"✨ สร้างห้องแชททันที"</strong> เพื่อเปิดห้องด้วย Tag ของคุณให้คนอื่นเข้ามาคุยได้เลย!';
      discoverRoomsList.appendChild(empty);
      renderSidebarChatRoomsList([]);
      return;
    }

    scoredRooms.forEach((room) => {
      const card = document.createElement('div');
      card.className = `discover-room-card ${room.matchCount > 0 ? 'high-match' : ''}`;

      const matchBadgeHtml =
        room.matchCount > 0
          ? `<span class="match-score-pill">🎯 ตรงกับคุณ ${Number(room.matchCount) || 0} Tag (${Number(room.score) || 0}%)</span>`
          : `<span class="typing-status-pill">ห้องทั่วไป</span>`;

      const tagsHtml =
        room.tags && room.tags.length > 0
          ? room.tags
              .map((t) => {
                const isMatch = myTagsLower.has(String(t).toLowerCase());
                return `<span class="tag-badge-mini ${isMatch ? 'matched' : ''}">${isMatch ? '✓ ' : ''}${escapeHtml(t)}</span>`;
              })
              .join('')
          : '<span class="tag-badge-mini">ไม่มี Tag</span>';

      const safeHostAvatar = escapeHtml(sanitizeAvatarUrl(room.hostAvatar, PRESET_AVATARS[0]));
      const safeRoomCode = escapeHtml(sanitizeRoomCode(room.roomCode));
      const safeMemberCount = Math.max(1, parseInt(room.memberCount, 10) || 1);

      card.innerHTML = `
        <div class="discover-room-info">
          <div class="discover-room-top">
            <img src="${safeHostAvatar}" alt="Host" class="avatar-xs" />
            <span class="discover-room-title">ห้องของ <span class="host-name-text"></span></span>
            <span class="mono" style="font-size:0.75rem; color:#a5b4fc;">#${safeRoomCode}</span>
            <span class="member-count-badge" style="font-size:0.7rem; padding:2px 8px;">👥 ${safeMemberCount} คน</span>
            ${matchBadgeHtml}
          </div>
          <div class="discover-room-tags">${tagsHtml}</div>
        </div>
        <button type="button" class="btn btn-primary btn-sm btn-join-discovered">เข้าร่วม</button>
      `;

      card.querySelector('.host-name-text').textContent = room.hostName;
      card.querySelector('.btn-join-discovered').addEventListener('click', () => {
        joinRoomByCode(room.roomCode);
      });

      discoverRoomsList.appendChild(card);
    });

    renderSidebarChatRoomsList(scoredRooms);
  }

  function renderSidebarChatRoomsList(scoredRooms) {
    if (!sidebarRoomsList) return;
    sidebarRoomsList.innerHTML = '';

    const list =
      scoredRooms ||
      Array.from(discoveredRooms.values())
        .map((r) => {
          const match = calculateTagMatch(r.tags);
          return { ...r, matchedTags: match.matchedTags, matchCount: match.matchedTags.length, score: match.score };
        })
        .sort((a, b) => b.matchCount - a.matchCount || b.updatedAt - a.updatedAt);

    if (list.length === 0) {
      sidebarRoomsList.innerHTML =
        '<div class="friend-empty">ยังไม่มีห้องสาธารณะที่เปิดอยู่<br>กด "+ สร้างห้องใหม่" ด้านบนเพื่อเปิดห้องได้เลย!</div>';
      return;
    }

    list.forEach((room) => {
      const isCurrent = activeRoomCode && room.roomCode === activeRoomCode;
      const item = document.createElement('div');
      item.className = 'friend-item';
      const safeHostAvatar = escapeHtml(sanitizeAvatarUrl(room.hostAvatar, PRESET_AVATARS[0]));
      const safeRoomCode = escapeHtml(sanitizeRoomCode(room.roomCode));
      const safeMemberCount = Math.max(1, parseInt(room.memberCount, 10) || 1);
      const safeMatchCount = Number(room.matchCount) || 0;

      item.innerHTML = `
        <div class="friend-left">
          <img src="${safeHostAvatar}" alt="Host" class="avatar-sm" />
          <div class="friend-info">
            <div class="friend-name"></div>
            <div class="friend-meta mono">#${safeRoomCode} • 👥 ${safeMemberCount} คน ${
        safeMatchCount > 0 ? `• 🎯 ตรง ${safeMatchCount} Tag` : ''
      }</div>
          </div>
        </div>
        <div class="friend-actions">
          <button type="button" class="btn ${isCurrent ? 'btn-secondary' : 'btn-primary'} btn-sm btn-side-join" ${
        isCurrent ? 'disabled' : ''
      }>
            ${isCurrent ? 'อยู่ในห้องนี้' : 'เข้าห้อง'}
          </button>
        </div>
      `;
      item.querySelector('.friend-name').textContent = `ห้องของ ${room.hostName}`;
      const joinBtn = item.querySelector('.btn-side-join');
      if (!isCurrent) {
        joinBtn.addEventListener('click', () => {
          joinRoomByCode(room.roomCode);
        });
      }
      sidebarRoomsList.appendChild(item);
    });
  }

  function pingFriend(friendUid) {
    if (!currentUser) return;
    publishJson(topicInbox(friendUid), {
      type: 'ping_status',
      from: {
        uid: currentUser.uid,
        username: currentUser.username,
        avatar: currentUser.avatar,
        inRoom: Boolean(activeRoomCode),
        roomCode: activeRoomCode
      }
    });
  }

  function pingAllFriends() {
    friendsMap.forEach((_, friendUid) => {
      pingFriend(friendUid);
    });
  }

  // --- Handle Incoming Serverless Packets ---
  function handleInboxMessage(data) {
    if (!currentUser) return;

    const senderUid = data.from && data.from.uid ? sanitizeUid(data.from.uid) : '';
    const senderName = data.from && data.from.username ? sanitizeUsername(data.from.username, senderUid || 'User') : senderUid || 'User';
    const senderAvatar = data.from && data.from.avatar ? sanitizeAvatarUrl(data.from.avatar, PRESET_AVATARS[0]) : PRESET_AVATARS[0];

    // Send ACK back if packet requested reliable delivery
    if (data.ackId && senderUid) {
      publishJson(topicInbox(senderUid), {
        type: 'ack',
        ackId: String(data.ackId).slice(0, 64)
      });
    }

    if (data.type === 'ack' && data.ackId) {
      markAckReceived(String(data.ackId).slice(0, 64));
      return;
    }

    // 1. Someone pinged us to check if we are online -> reply directly to their inbox & presence
    if (data.type === 'ping_status' && senderUid) {
      if (!friendsMap.has(senderUid)) {
        // Ping sender is not in our friends list -> notify them to mutual unfriend
        publishJson(topicInbox(senderUid), {
          type: 'friend_removed',
          from: {
            uid: currentUser.uid,
            username: currentUser.username
          }
        });
        return;
      }
      publishJson(topicInbox(senderUid), {
        type: 'pong_status',
        from: {
          uid: currentUser.uid,
          username: currentUser.username,
          avatar: currentUser.avatar,
          online: true,
          inRoom: Boolean(activeRoomCode),
          roomCode: activeRoomCode
        }
      });
      return;
    }

    // 2. Direct status response from a friend we pinged or added
    if (data.type === 'pong_status' && senderUid) {
      updateFriendRecord(senderUid, {
        username: senderName,
        avatar: senderAvatar,
        online: true,
        inRoom: Boolean(data.from.inRoom),
        roomCode: sanitizeRoomCode(data.from.roomCode) || null,
        lastSeen: Date.now()
      });
      return;
    }

    // 3. Incoming Friend Request (Must accept before becoming friends!)
    if (data.type === 'friend_request' && senderUid) {
      if (friendsMap.has(senderUid)) {
        // Already friends -> auto-confirm back
        publishJson(topicInbox(senderUid), {
          type: 'friend_accepted',
          from: {
            uid: currentUser.uid,
            username: currentUser.username,
            avatar: currentUser.avatar,
            inRoom: Boolean(activeRoomCode),
            roomCode: activeRoomCode
          }
        });
        return;
      }
      incomingFriendRequests.set(senderUid, {
        uid: senderUid,
        username: senderName,
        avatar: senderAvatar,
        ts: Date.now()
      });
      renderFriendRequestsUI();
      showToast(`👋 ${senderName} ส่งคำขอเป็นเพื่อนถึงคุณ! (กดดูที่เมนู Friend)`);
      return;
    }

    // 4. Friend Request Accepted by the other person
    if (data.type === 'friend_accepted' && senderUid) {
      sentFriendRequests.delete(senderUid);
      incomingFriendRequests.delete(senderUid);
      friendsMap.set(senderUid, {
        uid: senderUid,
        username: senderName,
        avatar: senderAvatar,
        online: true,
        inRoom: Boolean(data.from.inRoom),
        roomCode: sanitizeRoomCode(data.from.roomCode) || null,
        lastSeen: Date.now()
      });
      if (mqttClient && mqttClient.connected) {
        mqttClient.subscribe(topicPresence(senderUid), { qos: 0 });
      }
      saveFriendsList();
      renderFriendRequestsUI();
      renderFriendsList();
      if (activeRoomCode) renderAllLiveCards();
      showToast(`🎉 ${senderName} ตอบรับคำขอเป็นเพื่อนของคุณแล้ว!`);
      return;
    }

    // 4.1 Friend Removed by the other person -> Mutual unfriend on both sides
    if (data.type === 'friend_removed' && senderUid) {
      if (friendsMap.has(senderUid)) {
        removeFriend(senderUid, false);
        showToast(`ℹ️ ${senderName} ได้ยกเลิกความเป็นเพื่อนกับคุณ`);
      } else {
        sentFriendRequests.delete(senderUid);
        incomingFriendRequests.delete(senderUid);
        renderFriendRequestsUI();
      }
      return;
    }

    // 5. Incoming 1-on-1 or Group Room Invitation
    if (data.type === 'room_invite' && senderUid && data.roomCode) {
      const cleanInviteCode = sanitizeRoomCode(data.roomCode);
      if (!cleanInviteCode) return;
      pendingInviteRoomCode = cleanInviteCode;
      inviteAvatar.src = senderAvatar;
      inviteUsername.textContent = senderName;
      inviteUid.textContent = `UID: ${senderUid}`;
      inviteRoomCode.textContent = cleanInviteCode;
      inviteModal.classList.remove('hidden');
      return;
    }

    // 6. WebRTC Live Screen Stream Signaling
    if (data.type === 'stream_watch_request' && data.fromUid) {
      data.fromUid = sanitizeUid(data.fromUid);
      if (data.fromUid) handleViewerWatchRequest(data);
      return;
    }
    if (data.type === 'stream_signal_offer' && data.sdp) {
      handleStreamerOffer(data);
      return;
    }
    if (data.type === 'stream_signal_answer' && data.sdp) {
      handleViewerAnswer(data);
      return;
    }
    if (data.type === 'stream_signal_candidate' && data.candidate) {
      handleRemoteCandidate(data);
      return;
    }
    if (data.type === 'stream_quality_change' && data.fromUid) {
      data.fromUid = sanitizeUid(data.fromUid);
      if (data.fromUid) handleQualityChangeRequest(data);
      return;
    }
    if (data.type === 'stream_stop_watch' && data.fromUid) {
      data.fromUid = sanitizeUid(data.fromUid);
      if (data.fromUid) handleViewerStopWatch(data);
      return;
    }
  }

  function handlePresenceMessage(data) {
    const cleanUid = data && data.uid ? sanitizeUid(data.uid) : '';
    if (!cleanUid || !friendsMap.has(cleanUid)) return;
    updateFriendRecord(cleanUid, {
      username: data.username ? sanitizeUsername(data.username, cleanUid) : undefined,
      avatar: data.avatar ? sanitizeAvatarUrl(data.avatar, PRESET_AVATARS[0]) : undefined,
      online: Boolean(data.online),
      inRoom: Boolean(data.inRoom),
      roomCode: sanitizeRoomCode(data.roomCode) || null,
      lastSeen: Date.now()
    });
  }

  function updateFriendRecord(uid, fields) {
    const cleanUid = sanitizeUid(uid);
    const f = friendsMap.get(cleanUid);
    if (!f) return;
    if (fields.username) f.username = sanitizeUsername(fields.username, cleanUid);
    if (fields.avatar) f.avatar = sanitizeAvatarUrl(fields.avatar, PRESET_AVATARS[0]);
    f.online = Boolean(fields.online);
    f.inRoom = Boolean(fields.inRoom);
    f.roomCode = sanitizeRoomCode(fields.roomCode) || null;
    f.lastSeen = fields.lastSeen || Date.now();
    saveFriendsList();
    renderFriendsList();
  }

  function handleRoomMessage(data) {
    if (!currentUser || !activeRoomCode) return;
    if (!data) return;
    const cleanSenderUid = data.uid ? sanitizeUid(data.uid) : '';

    // Direct room-level friend request/accepted sync (instant fallback in case inbox packet drops)
    if (data.type === 'room_friend_request' && data.targetUid === currentUser.uid && data.from) {
      const fromUid = sanitizeUid(data.from.uid);
      if (fromUid && !friendsMap.has(fromUid) && !incomingFriendRequests.has(fromUid)) {
        const fromName = sanitizeUsername(data.from.username || fromUid, fromUid);
        incomingFriendRequests.set(fromUid, {
          uid: fromUid,
          username: fromName,
          avatar: sanitizeAvatarUrl(data.from.avatar, PRESET_AVATARS[0]),
          ts: Date.now()
        });
        renderFriendRequestsUI();
        renderAllLiveCards();
        showToast(`👋 ${fromName} ส่งคำขอเป็นเพื่อนถึงคุณ! (กดดูที่เมนู Friend หรือปุ่มบนการ์ด)`);
      }
      return;
    }

    if (data.type === 'room_friend_accepted' && data.targetUid === currentUser.uid && data.from) {
      const fromUid = sanitizeUid(data.from.uid);
      if (!fromUid) return;
      const fromName = sanitizeUsername(data.from.username || fromUid, fromUid);
      sentFriendRequests.delete(fromUid);
      incomingFriendRequests.delete(fromUid);
      friendsMap.set(fromUid, {
        uid: fromUid,
        username: fromName,
        avatar: sanitizeAvatarUrl(data.from.avatar, PRESET_AVATARS[0]),
        online: true,
        inRoom: Boolean(activeRoomCode),
        roomCode: activeRoomCode,
        lastSeen: Date.now()
      });
      saveFriendsList();
      renderFriendRequestsUI();
      renderFriendsList();
      renderAllLiveCards();
      showToast(`🎉 ${fromName} ตอบรับคำขอเป็นเพื่อนของคุณแล้ว!`);
      return;
    }

    // Direct room-level friend removal sync (instant fallback in room)
    if (data.type === 'room_friend_removed' && data.targetUid === currentUser.uid && data.from) {
      const removedUid = sanitizeUid(data.from.uid);
      if (!removedUid) return;
      const otherUsername = sanitizeUsername(data.from.username || removedUid, removedUid);
      if (friendsMap.has(removedUid)) {
        removeFriend(removedUid, false);
        showToast(`ℹ️ ${otherUsername} ได้ยกเลิกความเป็นเพื่อนกับคุณ`);
      } else {
        sentFriendRequests.delete(removedUid);
        incomingFriendRequests.delete(removedUid);
        renderFriendRequestsUI();
      }
      return;
    }

    // Live Screen Streaming Room Broadcasts
    if (data.type === 'stream_started' || data.type === 'stream_announce') {
      const cleanStreamerUid = sanitizeUid(data.streamerUid);
      if (currentUser && cleanStreamerUid && cleanStreamerUid !== currentUser.uid) {
        activeStreamerUid = cleanStreamerUid;
        activeStreamerUsername = sanitizeUsername(data.streamerUsername || 'เพื่อน', 'เพื่อน');

        if (streamerNameBadge) streamerNameBadge.textContent = `${activeStreamerUsername} (กำลังแชร์หน้าจอ)`;
        if (floatingStreamerTitle) floatingStreamerTitle.textContent = `${activeStreamerUsername} (กำลังไลฟ์สด)`;
        if (streamPlaceholderTitle) streamPlaceholderTitle.textContent = `${activeStreamerUsername} กำลังไลฟ์สดหน้าจอ`;
        if (streamPlaceholderSub) streamPlaceholderSub.textContent = 'คลิกที่วิดีโอ หรือกดปุ่มด้านล่างเพื่อเริ่มรับชม';
        if (btnToggleWatchStream) btnToggleWatchStream.textContent = '▶ ดูไลฟ์สด';
        if (btnStopWatchStream) btnStopWatchStream.textContent = '▶ ดูไลฟ์สด';

        if (!isWatching && streamPlaceholderOverlay) {
          streamPlaceholderOverlay.classList.remove('hidden');
        }

        // Do NOT force open floating window automatically if not watching — badge appears in card!
        updateScreenShareButtonState();
        reorderLiveCards();
        renderAllLiveCards();

        if (data.type === 'stream_started') {
          showToast(`📺 ${activeStreamerUsername} เริ่มต้นไลฟ์สดหน้าจอแล้ว! (คลิกปุ่มดูไลฟ์ที่การ์ดเพื่อรับชม)`);
        }
      }
      return;
    }

    if (data.type === 'stream_stopped') {
      const cleanStreamerUid = sanitizeUid(data.streamerUid);
      if (cleanStreamerUid && cleanStreamerUid === activeStreamerUid) {
        if (isWatching) {
          stopWatchingStream();
        }
        activeStreamerUid = null;
        activeStreamerUsername = null;
        if (floatingStreamWindow) floatingStreamWindow.classList.add('hidden');
        updateScreenShareButtonState();
        reorderLiveCards();
        renderAllLiveCards();

        showToast('ℹ️ การไลฟ์สดสิ้นสุดลงแล้ว');
      }
      return;
    }

    if (!cleanSenderUid) return;
    // Ignore our own echo for typing/clear since we already update locally immediately
    if (cleanSenderUid === currentUser.uid) return;

    if (data.type === 'member_join') {
      const isNew = !roomMembers.has(cleanSenderUid);
      const cleanName = sanitizeUsername(data.username || cleanSenderUid, cleanSenderUid);
      const cleanAvatar = sanitizeAvatarUrl(data.avatar, PRESET_AVATARS[0]);
      const cleanTags = Array.isArray(data.tags) ? data.tags.slice(0, 8).map(sanitizeTag).filter(Boolean) : [];
      const safeText = String(data.currentText || '').slice(0, 250);

      roomMembers.set(cleanSenderUid, {
        uid: cleanSenderUid,
        username: cleanName,
        avatar: cleanAvatar,
        tags: cleanTags,
        currentText: safeText,
        image: null,
        updatedAt: Date.now(),
        lastActiveAt: safeText ? Date.now() : 0,
        lastTypingAt: 0,
        lastEmoteAt: 0,
        lastEmote: null
      });
      renderAllLiveCards();
      if (isNew) {
        showToast(`👋 ${cleanName} เข้ามาในห้อง`);
      }

      // Reply with our own member state + current live text so the newcomer sees everyone immediately!
      const myMember = roomMembers.get(currentUser.uid);
      publishJson(topicRoom(activeRoomCode), {
        type: 'member_sync',
        uid: currentUser.uid,
        username: currentUser.username,
        avatar: currentUser.avatar,
        tags: Array.from(selectedTags),
        currentText: myMember ? myMember.currentText : liveTypingInput.value,
        image: myMember ? myMember.image : currentImage
      });

      // If we are currently streaming screen, announce to newcomer immediately!
      if (isScreenSharing && currentUser) {
        publishJson(topicRoom(activeRoomCode), {
          type: 'stream_announce',
          uid: currentUser.uid,
          streamerUid: currentUser.uid,
          streamerUsername: currentUser.username,
          streamerAvatar: currentUser.avatar
        });
      }

      broadcastActiveRoomToDirectory();
      return;
    }

    if (data.type === 'member_sync') {
      const existed = roomMembers.has(cleanSenderUid);
      const prev = roomMembers.get(cleanSenderUid);
      const cleanName = sanitizeUsername(data.username || cleanSenderUid, cleanSenderUid);
      const cleanAvatar = sanitizeAvatarUrl(data.avatar, PRESET_AVATARS[0]);
      const cleanTags = Array.isArray(data.tags) ? data.tags.slice(0, 8).map(sanitizeTag).filter(Boolean) : [];
      const safeText = String(data.currentText || '').slice(0, 250);
      const safeImage = data.image ? sanitizeChatMediaUrl(data.image) : null;
      const hasContent = Boolean(safeText.length > 0 || safeImage);

      roomMembers.set(cleanSenderUid, {
        uid: cleanSenderUid,
        username: cleanName,
        avatar: cleanAvatar,
        tags: cleanTags,
        currentText: safeText,
        image: safeImage,
        updatedAt: Date.now(),
        lastActiveAt: hasContent ? Date.now() : (prev ? prev.lastActiveAt : 0),
        lastTypingAt: prev ? prev.lastTypingAt : 0,
        lastEmoteAt: prev ? prev.lastEmoteAt : 0,
        lastEmote: prev ? prev.lastEmote : null
      });
      if (!existed) {
        renderAllLiveCards();
        broadcastActiveRoomToDirectory();
      } else {
        updateSingleCardContent(cleanSenderUid, safeText, safeImage);
        reorderLiveCards();
      }
      return;
    }

    if (data.type === 'member_leave') {
      if (roomMembers.has(cleanSenderUid)) {
        const leftUser = roomMembers.get(cleanSenderUid);
        roomMembers.delete(cleanSenderUid);
        renderAllLiveCards();
        showToast(`🚪 ${leftUser.username} ออกจากห้อง`);
      }
      if (cleanSenderUid === activeStreamerUid) {
        if (isWatching) stopWatchingStream();
        activeStreamerUid = null;
        activeStreamerUsername = null;
        if (floatingStreamWindow) floatingStreamWindow.classList.add('hidden');
        updateScreenShareButtonState();
        reorderLiveCards();
        showToast('ℹ️ ผู้ไลฟ์สดออกจากห้อง การไลฟ์สิ้นสุดลง');
      }
      return;
    }

    if (data.type === 'typing_update') {
      const safeText = String(data.text || '').slice(0, 250);
      const safeImage = data.image !== undefined ? (data.image ? sanitizeChatMediaUrl(data.image) : null) : undefined;
      if (!roomMembers.has(cleanSenderUid)) {
        const hasContent = Boolean(safeText.trim().length > 0 || safeImage);
        // Auto-register member if they typed before join packet arrived
        roomMembers.set(cleanSenderUid, {
          uid: cleanSenderUid,
          username: sanitizeUsername(data.username || cleanSenderUid, cleanSenderUid),
          avatar: sanitizeAvatarUrl(data.avatar, PRESET_AVATARS[0]),
          currentText: safeText,
          image: safeImage || null,
          updatedAt: Date.now(),
          lastActiveAt: hasContent ? Date.now() : 0,
          lastTypingAt: hasContent ? Date.now() : 0,
          lastEmoteAt: 0,
          lastEmote: null
        });
        renderAllLiveCards();
      } else {
        const m = roomMembers.get(cleanSenderUid);
        m.currentText = safeText;
        if (safeImage !== undefined) {
          m.image = safeImage;
        }
        const hasContent = Boolean(safeText.trim().length > 0 || m.image);
        m.updatedAt = Date.now();
        if (hasContent) {
          m.lastActiveAt = Date.now();
          m.lastTypingAt = Date.now();
        } else {
          m.lastActiveAt = 0;
        }
        updateSingleCardContent(cleanSenderUid, m.currentText, m.image);
        reorderLiveCards();
      }
      return;
    }

    if (data.type === 'typing_clear') {
      if (roomMembers.has(cleanSenderUid)) {
        const m = roomMembers.get(cleanSenderUid);
        m.currentText = '';
        m.image = null;
        m.lastActiveAt = 0;
        m.lastEmoteAt = 0;
        m.updatedAt = Date.now();
        updateSingleCardContent(cleanSenderUid, '', null);
        flashClearCard(cleanSenderUid);
        reorderLiveCards();
      }
      return;
    }

    if (data.type === 'emote_bubble' && data.emote) {
      const safeEmote = String(data.emote).replace(/[\x00-\x1F\x7F<>"'`]/g, '').trim().slice(0, 16);
      if (!safeEmote) return;
      if (roomMembers.has(cleanSenderUid)) {
        const m = roomMembers.get(cleanSenderUid);
        m.lastEmoteAt = Date.now();
        m.lastEmote = safeEmote;
        m.lastActiveAt = Date.now();
      }
      spawnEmoteBubbleOnCard(cleanSenderUid, safeEmote);
      reorderLiveCards();
      setTimeout(() => reorderLiveCards(), 20500);
      return;
    }
  }

  // --- Avatar Picker Setup ---
  function initAvatarPicker() {
    presetAvatarGrid.innerHTML = '';
    PRESET_AVATARS.forEach((dataUri) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-avatar-btn' + (dataUri === selectedAvatar ? ' selected' : '');
      const img = document.createElement('img');
      img.src = dataUri;
      img.alt = 'Preset Avatar';
      btn.appendChild(img);
      btn.addEventListener('click', () => {
        selectedAvatar = dataUri;
        setupAvatarPreview.src = selectedAvatar;
        document.querySelectorAll('.preset-avatar-btn').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
      presetAvatarGrid.appendChild(btn);
    });
    setupAvatarPreview.src = selectedAvatar;
  }

  // =========================================================================
  // --- Avatar Profile Picture Cropper Engine (Interactive 1:1 Aspect) ---
  // =========================================================================
  let avatarCropImg = null;
  let avatarBox = { x: 0, y: 0, w: 100, h: 100 };
  let avatarIsDragging = false;
  let avatarActiveHandle = null;
  let avatarDragStart = { x: 0, y: 0 };
  let avatarStartBox = { x: 0, y: 0, w: 0, h: 0 };

  if (inputCustomAvatar) {
    inputCustomAvatar.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const check = await validateImageFileSecurity(file, { allowGif: true });
      if (!check.ok) {
        showToast(check.reason, 6000);
        showSecurityAlertModal(file, check.threatDetails, (cleanImg) => {
          initAvatarCropper(cleanImg);
        });
        inputCustomAvatar.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          if (
            img.naturalWidth <= 0 ||
            img.naturalHeight <= 0 ||
            img.naturalWidth > MAX_IMAGE_DIMENSION ||
            img.naturalHeight > MAX_IMAGE_DIMENSION
          ) {
            showToast('🛡️ ขนาดพิกเซลของรูปภาพไม่ถูกต้องหรือใหญ่เกินกำหนด (สูงสุด 8192x8192 px)');
            inputCustomAvatar.value = '';
            return;
          }
          initAvatarCropper(img);
        };
        img.onerror = () => {
          showToast('⚠️ ไม่สามารถอ่านไฟล์รูปภาพนี้ได้');
          inputCustomAvatar.value = '';
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function initAvatarCropper(img) {
    avatarCropImg = img;
    if (avatarCropModal) avatarCropModal.classList.remove('hidden');

    requestAnimationFrame(() => {
      const viewport = avatarCropCanvasViewport;
      const maxW = viewport ? Math.max(220, Math.min(440, (viewport.clientWidth || 400) - 16)) : 400;
      const maxH = viewport ? Math.max(180, Math.min(300, (viewport.clientHeight || 280) - 16)) : 280;

      const natW = img.naturalWidth || 600;
      const natH = img.naturalHeight || 600;

      const scale = Math.min(maxW / natW, maxH / natH, 1);
      const cw = Math.max(140, Math.round(natW * scale));
      const ch = Math.max(140, Math.round(natH * scale));

      avatarCropCanvas.width = cw;
      avatarCropCanvas.height = ch;
      avatarCropCanvas.style.width = `${cw}px`;
      avatarCropCanvas.style.height = `${ch}px`;

      // 1:1 Square box centered
      const side = Math.max(40, Math.round(Math.min(cw, ch) * 0.85));
      avatarBox = {
        x: Math.round((cw - side) / 2),
        y: Math.round((ch - side) / 2),
        w: side,
        h: side
      };

      renderAvatarCropper();
    });
  }

  function renderAvatarCropper() {
    if (!avatarCropImg || !avatarCropCanvas) return;
    const ctx = avatarCropCanvas.getContext('2d');
    const cw = avatarCropCanvas.width;
    const ch = avatarCropCanvas.height;
    const b = avatarBox;

    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(avatarCropImg, 0, 0, cw, ch);

    // Darkened overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.64)';
    ctx.fillRect(0, 0, cw, ch);

    // Cutout preview
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.clip();
    ctx.drawImage(avatarCropImg, 0, 0, cw, ch);

    // Rule-of-thirds grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(b.x + b.w / 3, b.y);
    ctx.lineTo(b.x + b.w / 3, b.y + b.h);
    ctx.moveTo(b.x + (2 * b.w) / 3, b.y);
    ctx.lineTo(b.x + (2 * b.w) / 3, b.y + b.h);
    ctx.moveTo(b.x, b.y + b.h / 3);
    ctx.lineTo(b.x + b.w, b.y + b.h / 3);
    ctx.moveTo(b.x, b.y + (2 * b.h) / 3);
    ctx.lineTo(b.x + b.w, b.y + (2 * b.h) / 3);
    ctx.stroke();

    // Circular Avatar Mask Guide Ring
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.85)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.arc(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Solid border around box
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x, b.y, b.w, b.h);

    // 4 Corner Handles
    const drawDot = (hx, hy) => {
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(hx, hy, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    drawDot(b.x, b.y);
    drawDot(b.x + b.w, b.y);
    drawDot(b.x + b.w, b.y + b.h);
    drawDot(b.x, b.y + b.h);

    // Update dimensions display
    if (avatarCropSizeInfo) {
      const origSide = Math.round(b.w * (avatarCropImg.naturalWidth / cw));
      avatarCropSizeInfo.textContent = `${origSide} × ${origSide} px (1:1)`;
    }

    // Render live circular preview on canvas
    if (avatarCirclePreviewCanvas) {
      const pctx = avatarCirclePreviewCanvas.getContext('2d');
      const pw = avatarCirclePreviewCanvas.width;
      const ph = avatarCirclePreviewCanvas.height;
      pctx.clearRect(0, 0, pw, ph);

      const scaleX = avatarCropImg.naturalWidth / cw;
      const scaleY = avatarCropImg.naturalHeight / ch;

      const sx = Math.max(0, Math.round(b.x * scaleX));
      const sy = Math.max(0, Math.round(b.y * scaleY));
      const sSide = Math.min(avatarCropImg.naturalWidth - sx, avatarCropImg.naturalHeight - sy, Math.round(b.w * scaleX));

      if (sSide > 0) {
        pctx.drawImage(avatarCropImg, sx, sy, sSide, sSide, 0, 0, pw, ph);
      }
    }
  }

  function getAvatarCanvasPos(e) {
    const rect = avatarCropCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (avatarCropCanvas.width / rect.width),
      y: (clientY - rect.top) * (avatarCropCanvas.height / rect.height)
    };
  }

  function getAvatarHitHandle(mx, my) {
    const R = 20;
    const b = avatarBox;
    if (Math.hypot(mx - b.x, my - b.y) <= R) return 'nw';
    if (Math.hypot(mx - (b.x + b.w), my - b.y) <= R) return 'ne';
    if (Math.hypot(mx - (b.x + b.w), my - (b.y + b.h)) <= R) return 'se';
    if (Math.hypot(mx - b.x, my - (b.y + b.h)) <= R) return 'sw';
    if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return 'move';
    return null;
  }

  function onAvatarPointerDown(e) {
    if (!avatarCropImg || !avatarCropModal || avatarCropModal.classList.contains('hidden')) return;
    const pos = getAvatarCanvasPos(e);
    const hit = getAvatarHitHandle(pos.x, pos.y);
    if (!hit) return;
    avatarIsDragging = true;
    avatarActiveHandle = hit;
    avatarDragStart = { x: pos.x, y: pos.y };
    avatarStartBox = { ...avatarBox };
    if (e.cancelable && e.type.startsWith('touch')) {
      e.preventDefault();
    }
  }

  function onAvatarPointerMove(e) {
    if (!avatarCropImg || !avatarCropModal || avatarCropModal.classList.contains('hidden')) return;
    const pos = getAvatarCanvasPos(e);

    if (!avatarIsDragging) {
      const hit = getAvatarHitHandle(pos.x, pos.y);
      if (hit === 'nw' || hit === 'se') avatarCropCanvas.style.cursor = 'nwse-resize';
      else if (hit === 'ne' || hit === 'sw') avatarCropCanvas.style.cursor = 'nesw-resize';
      else if (hit === 'move') avatarCropCanvas.style.cursor = 'move';
      else avatarCropCanvas.style.cursor = 'crosshair';
      return;
    }

    if (e.cancelable && e.type.startsWith('touch')) {
      e.preventDefault();
    }

    const dx = pos.x - avatarDragStart.x;
    const dy = pos.y - avatarDragStart.y;
    const cw = avatarCropCanvas.width;
    const ch = avatarCropCanvas.height;
    const sb = avatarStartBox;
    const minS = 40;

    if (avatarActiveHandle === 'move') {
      const nx = Math.max(0, Math.min(cw - sb.w, sb.x + dx));
      const ny = Math.max(0, Math.min(ch - sb.h, sb.y + dy));
      avatarBox.x = nx;
      avatarBox.y = ny;
    } else {
      let nx = sb.x;
      let ny = sb.y;
      let side = sb.w;

      if (avatarActiveHandle === 'se') {
        const delta = Math.max(dx, dy);
        side = Math.max(minS, Math.min(cw - sb.x, ch - sb.y, sb.w + delta));
      } else if (avatarActiveHandle === 'sw') {
        const delta = Math.max(-dx, dy);
        side = Math.max(minS, Math.min(sb.x + sb.w, ch - sb.y, sb.w + delta));
        nx = sb.x + (sb.w - side);
      } else if (avatarActiveHandle === 'ne') {
        const delta = Math.max(dx, -dy);
        side = Math.max(minS, Math.min(cw - sb.x, sb.y + sb.h, sb.w + delta));
        ny = sb.y + (sb.h - side);
      } else if (avatarActiveHandle === 'nw') {
        const delta = Math.max(-dx, -dy);
        side = Math.max(minS, Math.min(sb.x + sb.w, sb.y + sb.h, sb.w + delta));
        nx = sb.x + (sb.w - side);
        ny = sb.y + (sb.h - side);
      }

      avatarBox = {
        x: Math.round(nx),
        y: Math.round(ny),
        w: Math.round(side),
        h: Math.round(side)
      };
    }

    renderAvatarCropper();
  }

  function onAvatarPointerUp() {
    avatarIsDragging = false;
    avatarActiveHandle = null;
  }

  if (avatarCropCanvas) {
    avatarCropCanvas.addEventListener('mousedown', onAvatarPointerDown);
    window.addEventListener('mousemove', onAvatarPointerMove);
    window.addEventListener('mouseup', onAvatarPointerUp);

    avatarCropCanvas.addEventListener('touchstart', onAvatarPointerDown, { passive: false });
    window.addEventListener('touchmove', onAvatarPointerMove, { passive: false });
    window.addEventListener('touchend', onAvatarPointerUp);
    window.addEventListener('touchcancel', onAvatarPointerUp);
  }

  if (btnCancelAvatarCrop) {
    btnCancelAvatarCrop.addEventListener('click', () => {
      if (avatarCropModal) avatarCropModal.classList.add('hidden');
      if (inputCustomAvatar) inputCustomAvatar.value = '';
    });
  }

  if (btnApplyAvatarCrop) {
    btnApplyAvatarCrop.addEventListener('click', () => {
      if (!avatarCropImg || !avatarCropCanvas) return;
      const cw = avatarCropCanvas.width;
      const ch = avatarCropCanvas.height;
      const scaleX = avatarCropImg.naturalWidth / cw;
      const scaleY = avatarCropImg.naturalHeight / ch;

      const sx = Math.max(0, Math.round(avatarBox.x * scaleX));
      const sy = Math.max(0, Math.round(avatarBox.y * scaleY));
      const sSide = Math.min(avatarCropImg.naturalWidth - sx, avatarCropImg.naturalHeight - sy, Math.round(avatarBox.w * scaleX));

      if (sSide <= 0) return;

      const exportCanvas = document.createElement('canvas');
      const outSize = 160; // 160x160 perfect crisp size for mobile/retina and fast P2P/MQTT
      exportCanvas.width = outSize;
      exportCanvas.height = outSize;
      const exportCtx = exportCanvas.getContext('2d');
      exportCtx.drawImage(avatarCropImg, sx, sy, sSide, sSide, 0, 0, outSize, outSize);

      const croppedAvatarUrl = exportCanvas.toDataURL('image/jpeg', 0.82);

      selectedAvatar = croppedAvatarUrl;
      if (setupAvatarPreview) setupAvatarPreview.src = selectedAvatar;
      document.querySelectorAll('.preset-avatar-btn').forEach((b) => b.classList.remove('selected'));

      // If user session exists, update user and sync across UI immediately
      if (currentUser) {
        currentUser.avatar = selectedAvatar;
        saveUserSession(currentUser);
        if (headerAvatar) headerAvatar.src = selectedAvatar;
        if (modalGoogleAvatar) modalGoogleAvatar.src = selectedAvatar;
        syncGoogleDriveIfAuthenticated();

        if (activeRoomCode && roomMembers.has(currentUser.uid)) {
          const m = roomMembers.get(currentUser.uid);
          if (m) {
            m.avatar = selectedAvatar;
            renderLiveCards();
          }
        }
        broadcastMyPresence(true);
      }

      if (avatarCropModal) avatarCropModal.classList.add('hidden');
      if (inputCustomAvatar) inputCustomAvatar.value = '';
      showToast('เปลี่ยนรูปโปรไฟล์เรียบร้อยแล้ว ✨');
    });
  }

  // --- Security Threat Alert & Canvas Sanitizer Dialog ---
  let activeSanitizingFile = null;
  let activeSanitizeCallback = null;

  function showSecurityAlertModal(file, threatDetails, onSanitizeClean) {
    if (!securityAlertModal) return;

    activeSanitizingFile = file;
    activeSanitizeCallback = onSanitizeClean || null;

    if (secAlertFileName) {
      const sizeKb = file && file.size ? ` (${(file.size / 1024).toFixed(1)} KB)` : '';
      secAlertFileName.textContent = (file ? file.name : 'image') + sizeKb;
    }

    if (threatDetails) {
      if (secAlertSummary) {
        secAlertSummary.textContent =
          threatDetails.severity === 'critical'
            ? '🚫 ตรวจพบคำสั่งสคริปต์ที่เป็นอันตรายต่อความปลอดภัยในไฟล์รูปภาพ ระบบบล็อกเพื่อป้องกันการโจมตี'
            : '⚠️ ตรวจพบแท็กโค้ดหรือ Metadata แปลกปลอมแฝงอยู่ในไฟล์รูปภาพ';
      }
      if (secAlertThreatType) {
        secAlertThreatType.textContent = threatDetails.threatName || 'สคริปต์แปลกปลอม';
        secAlertThreatType.className = `security-value threat-highlight ${threatDetails.severity || 'warning'}`;
      }
      if (secAlertSnippetBox) {
        secAlertSnippetBox.textContent = threatDetails.matchedSnippet || '(ไม่สามารถแสดงตัวอย่างได้)';
      }
      if (secAlertSnippetRow) {
        secAlertSnippetRow.style.display = threatDetails.matchedSnippet ? 'flex' : 'none';
      }
      if (secAlertAdvice) {
        secAlertAdvice.textContent = threatDetails.advice || threatDetails.description || '';
      }
    } else {
      if (secAlertSummary) secAlertSummary.textContent = 'ไฟล์นี้ไม่ผ่านการตรวจสอบความปลอดภัยของระบบ';
      if (secAlertThreatType) secAlertThreatType.textContent = 'ตรวจพบลักษณะต้องสงสัย';
      if (secAlertSnippetRow) secAlertSnippetRow.style.display = 'none';
      if (secAlertAdvice) secAlertAdvice.textContent = 'กรุณาเลือกไฟล์ภาพมาตรฐาน JPG, PNG หรือ WebP อื่นๆ';
    }

    if (btnSanitizeAndProceed) {
      if (onSanitizeClean && file && file.type !== 'image/gif') {
        btnSanitizeAndProceed.style.display = 'inline-flex';
      } else {
        btnSanitizeAndProceed.style.display = 'none';
      }
    }

    securityAlertModal.classList.remove('hidden');
  }

  function closeSecurityAlertModal() {
    if (securityAlertModal) securityAlertModal.classList.add('hidden');
    activeSanitizeCallback = null;
    activeSanitizingFile = null;
  }

  if (btnCancelSecurityAlert) {
    btnCancelSecurityAlert.addEventListener('click', closeSecurityAlertModal);
  }

  if (btnSanitizeAndProceed) {
    btnSanitizeAndProceed.addEventListener('click', () => {
      const file = activeSanitizingFile;
      const callback = activeSanitizeCallback;
      closeSecurityAlertModal();
      if (!file || !callback) return;

      showToast('⏳ กำลังล้างโค้ดแฝงและ Metadata ออกจากรูปภาพด้วย Canvas...', 3500);

      const objUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(objUrl);
        if (
          img.naturalWidth <= 0 ||
          img.naturalHeight <= 0 ||
          img.naturalWidth > MAX_IMAGE_DIMENSION ||
          img.naturalHeight > MAX_IMAGE_DIMENSION
        ) {
          showToast('🚫 ขนาดพิกเซลของรูปภาพไม่ถูกต้องหรือใหญ่เกินกำหนด');
          return;
        }

        // Render pure pixels onto an in-memory Canvas to strip 100% of EXIF, C2PA, XML, SVG, Polyglots
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        canvas.toBlob((blob) => {
          if (!blob) {
            showToast('🚫 ไม่สามารถประมวลผลล้างรูปภาพได้');
            return;
          }
          const cleanName = (file.name || 'image').replace(/\.[^.]+$/, '') + '_clean.png';
          const cleanFile = new File([blob], cleanName, { type: 'image/png' });

          const cleanObjUrl = URL.createObjectURL(cleanFile);
          const cleanImg = new Image();
          cleanImg.onload = () => {
            URL.revokeObjectURL(cleanObjUrl);
            showToast('✨ ล้างโค้ดแฝงและ Metadata เรียบร้อยแล้ว ปลอดภัย 100%');
            try {
              callback(cleanImg, cleanFile);
            } catch (err) {
              console.error('Sanitize callback error:', err);
            }
          };
          cleanImg.onerror = () => {
            URL.revokeObjectURL(cleanObjUrl);
            showToast('🚫 ไม่สามารถแสดงผลรูปภาพที่ล้างแล้วได้');
          };
          cleanImg.src = cleanObjUrl;
        }, 'image/png');
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        showToast('🚫 ไม่สามารถถอดรหัสรูปภาพนี้ได้');
      };
      img.src = objUrl;
    });
  }

  // --- Views Navigation & Interest Tags Picker ---
  function initInterestTagsPicker() {
    if (!presetTagsContainer) return;
    presetTagsContainer.innerHTML = '';

    // Combine default tags with any custom tags the user already added
    const allTags = new Set([...PRESET_INTEREST_TAGS, ...selectedTags]);

    allTags.forEach((tag) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip' + (selectedTags.has(tag) ? ' selected' : '');
      chip.textContent = tag;
      chip.addEventListener('click', () => {
        if (selectedTags.has(tag)) {
          selectedTags.delete(tag);
          chip.classList.remove('selected');
        } else {
          if (selectedTags.size >= 8) {
            showToast('เลือก Tag ความสนใจได้สูงสุด 8 รายการครับ');
            return;
          }
          selectedTags.add(tag);
          chip.classList.add('selected');
        }
      });
      presetTagsContainer.appendChild(chip);
    });
  }

  if (btnAddCustomTag && inputCustomTag) {
    btnAddCustomTag.addEventListener('click', () => {
      const val = sanitizeTag(inputCustomTag.value);
      if (!val) return;
      if (selectedTags.size >= 8) {
        showToast('เลือก Tag ความสนใจได้สูงสุด 8 รายการครับ');
        return;
      }
      const formatted = val.startsWith('#') ? val : `#${val}`;
      selectedTags.add(formatted);
      inputCustomTag.value = '';
      initInterestTagsPicker();
    });

    inputCustomTag.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        btnAddCustomTag.click();
      }
    });
  }

  function renderMySidebarTags() {
    if (!mySidebarTags) return;
    mySidebarTags.innerHTML = '';
    if (selectedTags.size === 0) {
      mySidebarTags.innerHTML = '<span class="tag-badge-mini">ยังไม่ได้เลือก Tag (กด ⚙️ เพื่อตั้งค่า)</span>';
      return;
    }
    selectedTags.forEach((t) => {
      const span = document.createElement('span');
      span.className = 'tag-badge-mini';
      span.textContent = t;
      mySidebarTags.appendChild(span);
    });
  }

  function updateAuthUIState() {
    if (!btnGoogleSignIn) return;
    const isGoogleAuth = Boolean(currentUser && currentUser.authProvider === 'google');
    if (isGoogleAuth) {
      btnGoogleSignIn.classList.add('hidden');
      if (googleAuthSuccessBox) {
        googleAuthSuccessBox.classList.remove('hidden');
        if (googleEmailLabel) {
          googleEmailLabel.textContent = currentUser.email || 'เชื่อมต่อกับ Google แล้ว';
        }
      }
      if (headerAuthBadge) headerAuthBadge.classList.remove('hidden');
    } else {
      btnGoogleSignIn.classList.remove('hidden');
      if (googleAuthSuccessBox) {
        googleAuthSuccessBox.classList.add('hidden');
      }
      if (headerAuthBadge) headerAuthBadge.classList.add('hidden');
    }
  }

  function showSetupView() {
    viewSetup.classList.add('active');
    viewWorkspace.classList.remove('active');
    userChip.classList.add('hidden');

    if (currentUser) {
      inputUsername.value = currentUser.username;
      selectedAvatar = currentUser.avatar || PRESET_AVATARS[0];
      selectedTags = new Set(Array.isArray(currentUser.tags) && currentUser.tags.length > 0 ? currentUser.tags : ['💬 คุยเล่นเรื่อยเปื่อย']);
      existingUidNotice.classList.remove('hidden');
      setupUidText.textContent = currentUser.uid;
    } else {
      inputUsername.value = '';
      selectedAvatar = PRESET_AVATARS[0];
      existingUidNotice.classList.add('hidden');
    }
    initAvatarPicker();
    initInterestTagsPicker();
    updateAuthUIState();
    inputUsername.focus();
  }

  function showWorkspaceView() {
    viewSetup.classList.remove('active');
    viewWorkspace.classList.add('active');
    userChip.classList.remove('hidden');

    headerAvatar.src = currentUser.avatar;
    headerUsername.textContent = currentUser.username;
    headerUid.textContent = `UID: ${currentUser.uid} 📋`;

    if (headerAuthBadge) {
      if (currentUser && currentUser.authProvider === 'google') {
        headerAuthBadge.classList.remove('hidden');
      } else {
        headerAuthBadge.classList.add('hidden');
      }
    }

    renderFriendsList();
    renderDiscoveredRooms();
    connectServerlessNetwork();
  }

  // Check if user opened a shared link like ?room=ABCDEF
  function checkUrlRoomInvite() {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam && !activeRoomCode) {
      window.history.replaceState({}, document.title, window.location.pathname);
      joinRoomByCode(roomParam);
    }
  }

  // --- Setup Form Submit ---
  formSetup.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = sanitizeUsername(inputUsername.value, '');
    if (!name) return;

    const safeAvatar = sanitizeAvatarUrl(selectedAvatar);
    const safeTags = Array.from(selectedTags).map(sanitizeTag).filter(Boolean).slice(0, 8);
    const isOldUid = currentUser && currentUser.uid && String(currentUser.uid).replace(/[^A-Za-z0-9]/g, '').length < 10;
    const uid = currentUser && currentUser.uid && !isOldUid ? sanitizeUid(currentUser.uid) || generateNewUid() : generateNewUid();
    currentUser = {
      uid,
      username: name,
      avatar: safeAvatar,
      tags: safeTags,
      authProvider: currentUser ? currentUser.authProvider : null,
      email: currentUser ? currentUser.email : null
    };
    saveUserSession(currentUser);
    syncGoogleDriveIfAuthenticated();

    // If already in a room, update our profile inside the room
    if (activeRoomCode && roomMembers.has(uid)) {
      const m = roomMembers.get(uid);
      m.username = name;
      m.avatar = safeAvatar;
      m.tags = safeTags;
      renderAllLiveCards();
      broadcastActiveRoomToDirectory();
    }

    showWorkspaceView();
  });

  btnEditProfile.addEventListener('click', () => {
    showSetupView();
  });

  // --- Logout (Destroys Session and signs out of Google Drive) ---
  btnLogout.addEventListener('click', () => {
    if (!confirm('ต้องการออกจากระบบใช่หรือไม่? (คุณสามารถเข้าสู่ระบบด้วย Google หรือสร้างโปรไฟล์ใหม่ได้ตลอดเวลา)')) {
      return;
    }
    if (activeRoomCode) {
      leaveCurrentRoomSilent();
    }
    broadcastMyPresence(false);
    if (mqttClient) {
      try {
        mqttClient.end(true);
      } catch (e) {}
      mqttClient = null;
    }

    if (window.LiveTypeDrive) {
      window.LiveTypeDrive.revokeToken();
    }

    clearUserSession();
    currentUser = null;
    friendsMap.clear();
    activeRoomCode = null;
    roomMembers.clear();
    updateRoomViewUI();
    showSetupView();
    updateAuthUIState();
    showToast('ออกจากระบบเรียบร้อยแล้ว');
  });

  // --- Google Sign-In & Google Drive AppData Cloud Sync Integration ---
  async function handleGoogleDriveLogin() {
    if (!window.LiveTypeDrive) {
      showToast('⚠️ ระบบเชื่อมต่อ Google Drive กำลังโหลด กรุณารอสักครู่');
      return;
    }

    if (!window.LiveTypeDrive.getClientId()) {
      openGoogleDriveModal();
      showToast('⚠️ กรุณาระบุ Google OAuth Client ID ก่อนเริ่มใช้งาน');
      return;
    }

    try {
      if (btnGoogleSignIn) {
        btnGoogleSignIn.disabled = true;
        btnGoogleSignIn.style.opacity = '0.6';
      }
      showToast('⏳ กำลังเปิดหน้าต่างลงชื่อเข้าใช้ Google...');

      const token = await window.LiveTypeDrive.promptGoogleLogin();
      if (!token) return;

      showToast('⏳ ดึงข้อมูลโปรไฟล์และซิงก์ Google Drive AppData...');
      const userInfo = await window.LiveTypeDrive.fetchGoogleUserInfo(token);

      const sanitizedName = window.LiveTypeDrive.sanitizeUsername(userInfo.name || 'Google User');
      const sanitizedAvatar = window.LiveTypeDrive.sanitizeAvatarUrl(userInfo.picture, PRESET_AVATARS[0]);

      // Check for backup on Google Drive appDataFolder
      let backupData = null;
      try {
        const fileId = await window.LiveTypeDrive.findAppDataFile(token);
        if (fileId) {
          backupData = await window.LiveTypeDrive.downloadAppData(token, fileId);
        }
      } catch (err) {
        console.warn('Could not read existing backup from Google Drive:', err);
      }

      if (backupData) {
        const isOldUid = currentUser && currentUser.uid && String(currentUser.uid).replace(/[^A-Za-z0-9]/g, '').length < 10;
        const restoredTags = Array.isArray(backupData.tags)
          ? backupData.tags.map(sanitizeTag).filter(Boolean).slice(0, 8)
          : [];
        currentUser = {
          uid: currentUser && currentUser.uid && !isOldUid ? sanitizeUid(currentUser.uid) || generateNewUid() : generateNewUid(),
          username: sanitizeUsername(backupData.username || sanitizedName),
          avatar: sanitizeAvatarUrl(backupData.avatar || sanitizedAvatar),
          tags: restoredTags.length > 0 ? restoredTags : Array.from(selectedTags),
          email: userInfo.email,
          authProvider: 'google'
        };

        if (Array.isArray(backupData.friends)) {
          backupData.friends.forEach((f) => {
            const fUid = f && sanitizeUid(f.uid);
            if (fUid) {
              const existing = friendsMap.get(fUid);
              friendsMap.set(fUid, {
                uid: fUid,
                username: sanitizeUsername(f.username, fUid),
                avatar: sanitizeAvatarUrl((existing && existing.avatar) || f.avatar),
                tags: [],
                online: false,
                inRoom: false,
                roomCode: null,
                lastSeen: Date.now()
              });
            }
          });
          saveFriendsList();
        }
      } else {
        const isOldUid = currentUser && currentUser.uid && String(currentUser.uid).replace(/[^A-Za-z0-9]/g, '').length < 10;
        currentUser = {
          uid: currentUser && currentUser.uid && !isOldUid ? currentUser.uid : generateNewUid(),
          username: currentUser ? currentUser.username : sanitizedName,
          avatar: currentUser ? currentUser.avatar : sanitizedAvatar,
          tags: Array.from(selectedTags),
          email: userInfo.email,
          authProvider: 'google'
        };

        // Save initial backup to Drive AppData
        await window.LiveTypeDrive.saveAppData(token, {
          username: currentUser.username,
          avatar: currentUser.avatar,
          tags: currentUser.tags,
          email: currentUser.email,
          friends: Array.from(friendsMap.values()).map(f => ({
            uid: f.uid,
            username: f.username
          })),
          updatedAt: Date.now()
        });
      }

      saveUserSession(currentUser);
      selectedAvatar = currentUser.avatar;
      selectedTags = new Set(currentUser.tags);
      inputUsername.value = currentUser.username;
      setupAvatarPreview.src = currentUser.avatar;

      updateAuthUIState();
      updateGoogleModalUI();
      renderFriendsList();
      showToast(`🛡️ เข้าสู่ระบบสำเร็จ: ${currentUser.username} (ซิงก์ข้อมูลกับ Google Drive แล้ว)`);
      showWorkspaceView();
    } catch (err) {
      console.error('Google Sign-In failed:', err);
      if (err.message === 'NO_CLIENT_ID') {
        openGoogleDriveModal();
        showToast('⚠️ กรุณาระบุ Google Client ID ก่อนลงชื่อเข้าใช้');
      } else if (err.message === 'GIS_NOT_LOADED') {
        showToast('⚠️ Google Identity Services กำลังโหลด กรุณาลองใหม่อีกครั้ง');
      } else if (err.message && (err.message.includes('popup_closed_by_user') || err.message.includes('access_denied'))) {
        showToast('ℹ️ ยกเลิกการลงชื่อเข้าใช้');
      } else {
        showToast('❌ ไม่สามารถลงชื่อเข้าใช้ Google ได้: ' + (err.message || 'เกิดข้อผิดพลาด'));
      }
    } finally {
      if (btnGoogleSignIn) {
        btnGoogleSignIn.disabled = false;
        btnGoogleSignIn.style.opacity = '1';
      }
    }
  }

  if (btnGoogleSignIn) {
    btnGoogleSignIn.addEventListener('click', handleGoogleDriveLogin);
  }

  if (btnModalGoogleSignIn) {
    btnModalGoogleSignIn.addEventListener('click', handleGoogleDriveLogin);
  }

  function handleGoogleSignOut() {
    if (confirm('ต้องการออกจากระบบบัญชี Google หรือไม่?')) {
      if (window.LiveTypeDrive) {
        window.LiveTypeDrive.revokeToken();
      }
      clearUserSession();
      currentUser = null;
      friendsMap.clear();
      updateAuthUIState();
      updateGoogleModalUI();
      showSetupView();
      showToast('ออกจากระบบบัญชี Google เรียบร้อยแล้ว');
    }
  }

  if (btnGoogleSignOut) {
    btnGoogleSignOut.addEventListener('click', handleGoogleSignOut);
  }

  if (btnModalGoogleSignOut) {
    btnModalGoogleSignOut.addEventListener('click', handleGoogleSignOut);
  }

  // --- Google Drive Modal Management ---
  function updateGoogleModalUI() {
    if (!googleDriveModal) return;
    const isGoogleAuth = Boolean(currentUser && currentUser.authProvider === 'google');
    if (isGoogleAuth) {
      if (modalGoogleSignInBox) modalGoogleSignInBox.classList.add('hidden');
      if (modalGoogleAccountBox) {
        modalGoogleAccountBox.classList.remove('hidden');
        if (modalGoogleName) modalGoogleName.textContent = currentUser.username || 'Google User';
        if (modalGoogleEmail) modalGoogleEmail.textContent = currentUser.email || '';
        if (modalGoogleAvatar) modalGoogleAvatar.src = currentUser.avatar || PRESET_AVATARS[0];
      }
    } else {
      if (modalGoogleSignInBox) modalGoogleSignInBox.classList.remove('hidden');
      if (modalGoogleAccountBox) modalGoogleAccountBox.classList.add('hidden');
    }

    if (inputGoogleClientId && window.LiveTypeDrive) {
      inputGoogleClientId.value = window.LiveTypeDrive.getClientId();
    }
  }

  function openGoogleDriveModal() {
    updateGoogleModalUI();
    if (googleDriveModal) googleDriveModal.classList.remove('hidden');
  }

  function closeGoogleDriveModal() {
    if (googleDriveModal) googleDriveModal.classList.add('hidden');
  }

  if (btnOpenGoogleDriveModal) {
    btnOpenGoogleDriveModal.addEventListener('click', openGoogleDriveModal);
  }

  if (btnCloseGoogleDriveModal) {
    btnCloseGoogleDriveModal.addEventListener('click', closeGoogleDriveModal);
  }

  if (btnSaveGoogleClientId && inputGoogleClientId) {
    btnSaveGoogleClientId.addEventListener('click', () => {
      const val = inputGoogleClientId.value.trim();
      if (window.LiveTypeDrive) {
        window.LiveTypeDrive.setClientId(val);
        updateGoogleModalUI();
        showToast('✅ บันทึก Google Client ID สำเร็จแล้ว!');
      }
    });
  }

  if (btnManualSyncDrive) {
    btnManualSyncDrive.addEventListener('click', async () => {
      if (!currentUser || currentUser.authProvider !== 'google') {
        showToast('⚠️ กรุณาลงชื่อเข้าใช้ Google ก่อนซิงก์');
        return;
      }
      const token = window.LiveTypeDrive ? window.LiveTypeDrive.getAccessToken() : null;
      if (!token) {
        showToast('⚠️ ไม่พบโทเคนการเข้าสู่ระบบ กรุณากดลงชื่อเข้าใช้อีกครั้ง');
        return;
      }
      showToast('⏳ กำลังซิงก์ข้อมูลขึ้น Google Drive AppData...');
      const ok = await window.LiveTypeDrive.saveAppData(token, {
        username: currentUser.username,
        avatar: currentUser.avatar,
        tags: Array.isArray(currentUser.tags) ? currentUser.tags : Array.from(selectedTags),
        email: currentUser.email,
        friends: Array.from(friendsMap.values()).map(f => ({
          uid: f.uid,
          username: f.username
        })),
        updatedAt: Date.now()
      });
      if (ok) {
        showToast('✅ บันทึกข้อมูลลง Google Drive appDataFolder เรียบร้อยแล้ว!');
      } else {
        showToast('❌ ไม่สามารถบันทึกข้อมูลลง Google Drive ได้');
      }
    });
  }

  if (btnManualDownloadDrive) {
    btnManualDownloadDrive.addEventListener('click', async () => {
      if (!currentUser || currentUser.authProvider !== 'google') {
        showToast('⚠️ กรุณาลงชื่อเข้าใช้ Google ก่อนดาวน์โหลด');
        return;
      }
      const token = window.LiveTypeDrive ? window.LiveTypeDrive.getAccessToken() : null;
      if (!token) {
        showToast('⚠️ ไม่พบโทเคนการเข้าสู่ระบบ กรุณากดลงชื่อเข้าใช้อีกครั้ง');
        return;
      }
      showToast('⏳ กำลังค้นหาไฟล์สำรองข้อมูลบน Google Drive...');
      const fileId = await window.LiveTypeDrive.findAppDataFile(token);
      if (!fileId) {
        showToast('ℹ️ ไม่พบไฟล์สำรองข้อมูล (livetype_user_backup.json) บน Google Drive');
        return;
      }
      const data = await window.LiveTypeDrive.downloadAppData(token, fileId);
      if (data) {
        if (data.username) currentUser.username = sanitizeUsername(data.username);
        if (data.avatar) currentUser.avatar = sanitizeAvatarUrl(data.avatar);
        if (Array.isArray(data.tags)) {
          const cleanTags = data.tags.map(sanitizeTag).filter(Boolean).slice(0, 8);
          currentUser.tags = cleanTags;
          selectedTags = new Set(cleanTags);
        }
        if (Array.isArray(data.friends)) {
          const oldFriends = new Map(friendsMap);
          friendsMap.clear();
          data.friends.forEach((f) => {
            const fUid = f && sanitizeUid(f.uid);
            if (fUid) {
              const existing = oldFriends.get(fUid);
              friendsMap.set(fUid, {
                uid: fUid,
                username: sanitizeUsername(f.username, fUid),
                avatar: sanitizeAvatarUrl((existing && existing.avatar) || f.avatar),
                tags: [],
                online: false,
                inRoom: false,
                roomCode: null,
                lastSeen: Date.now()
              });
            }
          });
          saveFriendsList();
        }
        saveUserSession(currentUser);
        renderFriendsList();
        updateHeaderUserChip();
        showToast('✅ กู้คืนข้อมูลและรายชื่อเพื่อนจาก Google Drive สำเร็จแล้ว!');
      } else {
        showToast('❌ ไม่สามารถดาวน์โหลดข้อมูลได้');
      }
    });
  }

  // Cleanly notify room & friends if tab is closed
  window.addEventListener('beforeunload', () => {
    if (activeRoomCode && currentUser) {
      publishJson(topicRoom(activeRoomCode), {
        type: 'member_leave',
        uid: currentUser.uid
      });
    }
    broadcastMyPresence(false);
  });

  // --- Copy UID (Click on Top-Right Profile Chip) ---
  if (btnCopyHeaderUid) {
    btnCopyHeaderUid.addEventListener('click', () => {
      if (!currentUser) return;
      navigator.clipboard.writeText(currentUser.uid).then(() => {
        showToast(`📋 คัดลอก UID (${currentUser.uid}) แล้ว!`);
      });
    });
  }

  // --- Sidebar Big Tabs (Chat / Friend) & Hide/Show Toggle ---
  function switchSidebarMainPane(paneName) {
    if (paneName === 'friend') {
      btnNavChat.classList.remove('active');
      btnNavFriend.classList.add('active');
      sidebarPaneChat.classList.remove('active');
      sidebarPaneFriend.classList.add('active');
    } else {
      btnNavChat.classList.add('active');
      btnNavFriend.classList.remove('active');
      sidebarPaneChat.classList.add('active');
      sidebarPaneFriend.classList.remove('active');
    }
  }

  if (btnNavChat) {
    btnNavChat.addEventListener('click', () => switchSidebarMainPane('chat'));
  }
  if (btnNavFriend) {
    btnNavFriend.addEventListener('click', () => switchSidebarMainPane('friend'));
  }

  if (btnCollapseSidebar && workspaceGrid) {
    btnCollapseSidebar.addEventListener('click', () => {
      if (window.innerWidth <= 860) {
        sidebarPanel.classList.remove('mobile-open');
      } else {
        workspaceGrid.classList.add('sidebar-collapsed');
      }
    });
  }

  if (btnExpandSidebar && workspaceGrid) {
    btnExpandSidebar.addEventListener('click', () => {
      workspaceGrid.classList.remove('sidebar-collapsed');
    });
  }

  if (btnSidebarScanRooms) {
    btnSidebarScanRooms.addEventListener('click', () => {
      requestDirectoryScan();
      renderDiscoveredRooms();
      showToast('📡 สแกนหาห้องแชทที่เปิดอยู่แล้ว');
    });
  }

  // --- Friend Request & Acceptance System ---
  function sendFriendRequestToUid(targetUid, targetUsername) {
    if (!currentUser) return;
    const cleanUid = sanitizeUid(targetUid);
    if (!cleanUid) {
      showToast('รูปแบบ UID ไม่ถูกต้อง');
      return;
    }
    if (cleanUid === currentUser.uid) {
      showToast('ไม่สามารถแอด UID ของตัวเองได้');
      return;
    }
    if (friendsMap.has(cleanUid)) {
      showToast('คนนี้อยู่ในรายชื่อเพื่อนของคุณอยู่แล้ว');
      return;
    }

    sentFriendRequests.add(cleanUid);
    const ackId = `freq_${currentUser.uid}_${cleanUid}_${Date.now()}`;
    const payload = {
      type: 'friend_request',
      from: {
        uid: currentUser.uid,
        username: currentUser.username,
        avatar: currentUser.avatar
      }
    };
    publishReliable(topicInbox(cleanUid), payload, ackId);

    // Also broadcast on active room channel if in room together for 100% instant sync!
    if (activeRoomCode) {
      publishJson(topicRoom(activeRoomCode), {
        type: 'room_friend_request',
        targetUid: cleanUid,
        from: payload.from
      });
      renderAllLiveCards();
    }
    showToast(`📩 ส่งคำขอเป็นเพื่อนไปยัง ${targetUsername || cleanUid} แล้ว รออีกฝ่ายกดรับนะครับ`);
  }

  function acceptIncomingFriendRequest(reqUid) {
    const req = incomingFriendRequests.get(reqUid);
    if (!req || !currentUser) return;

    incomingFriendRequests.delete(reqUid);
    sentFriendRequests.delete(reqUid);

    friendsMap.set(req.uid, {
      uid: req.uid,
      username: req.username,
      avatar: req.avatar,
      online: true,
      inRoom: false,
      roomCode: null,
      lastSeen: Date.now()
    });
    saveFriendsList();

    if (mqttClient && mqttClient.connected) {
      mqttClient.subscribe(topicPresence(req.uid), { qos: 0 });
      pingFriend(req.uid);
    }

    const ackId = `facc_${currentUser.uid}_${req.uid}_${Date.now()}`;
    const payload = {
      type: 'friend_accepted',
      from: {
        uid: currentUser.uid,
        username: currentUser.username,
        avatar: currentUser.avatar,
        inRoom: Boolean(activeRoomCode),
        roomCode: activeRoomCode
      }
    };
    publishReliable(topicInbox(req.uid), payload, ackId);

    // Also broadcast in room if currently inside the same room
    if (activeRoomCode) {
      publishJson(topicRoom(activeRoomCode), {
        type: 'room_friend_accepted',
        targetUid: req.uid,
        from: payload.from
      });
    }

    renderFriendRequestsUI();
    renderFriendsList();
    if (activeRoomCode) renderAllLiveCards();
    showToast(`🤝 รับ ${req.username} เป็นเพื่อนเรียบร้อยแล้ว!`);
  }

  function declineIncomingFriendRequest(reqUid) {
    incomingFriendRequests.delete(reqUid);
    renderFriendRequestsUI();
    showToast('ปฏิเสธคำขอเป็นเพื่อนแล้ว');
  }

  // --- Remove Friend (Mutual Unfriend) ---
  function removeFriend(targetUid, sendNotification = true) {
    if (!currentUser) return;
    const cleanUid = String(targetUid || '').trim().toUpperCase();
    if (!cleanUid) return;

    const existingFriend = friendsMap.get(cleanUid);
    const friendName = existingFriend ? (existingFriend.username || existingFriend.uid) : cleanUid;

    // 1. Unsubscribe from presence topic
    if (mqttClient && mqttClient.connected) {
      mqttClient.unsubscribe(topicPresence(cleanUid));
    }

    // 2. Remove from friendsMap & request caches
    friendsMap.delete(cleanUid);
    sentFriendRequests.delete(cleanUid);
    incomingFriendRequests.delete(cleanUid);
    saveFriendsList();

    // 3. Re-render UI
    renderFriendsList();
    renderFriendRequestsUI();
    if (activeRoomCode) renderAllLiveCards();

    // 4. Notify the other person reliably so they remove friendship too
    if (sendNotification) {
      const ackId = `frem_${currentUser.uid}_${cleanUid}_${Date.now()}`;
      const payload = {
        type: 'friend_removed',
        from: {
          uid: currentUser.uid,
          username: currentUser.username
        }
      };

      // Send to their personal inbox
      publishReliable(topicInbox(cleanUid), payload, ackId);

      // Also broadcast in room if currently in the same room
      if (activeRoomCode) {
        publishJson(topicRoom(activeRoomCode), {
          type: 'room_friend_removed',
          targetUid: cleanUid,
          from: payload.from
        });
      }

      showToast(`🗑️ ยกเลิกความเป็นเพื่อนกับ "${friendName}" เรียบร้อยแล้ว`);
    }
  }

  function renderFriendRequestsUI() {
    if (!friendRequestsBox || !friendRequestsList || !friendReqBadge) return;
    const count = incomingFriendRequests.size;
    if (count === 0) {
      friendRequestsBox.classList.add('hidden');
      friendReqBadge.classList.add('hidden');
      friendRequestsList.innerHTML = '';
      return;
    }

    friendRequestsBox.classList.remove('hidden');
    friendReqBadge.classList.remove('hidden');
    friendReqBadge.textContent = String(count);
    friendRequestsList.innerHTML = '';

    incomingFriendRequests.forEach((req) => {
      const safeAvatar = escapeHtml(sanitizeAvatarUrl(req.avatar));
      const safeUid = escapeHtml(sanitizeUid(req.uid));
      const row = document.createElement('div');
      row.className = 'friend-item';
      row.innerHTML = `
        <div class="friend-left">
          <img src="${safeAvatar}" alt="Avatar" class="avatar-sm" />
          <div class="friend-info">
            <div class="friend-name"></div>
            <div class="friend-meta mono">${safeUid}</div>
          </div>
        </div>
        <div class="friend-actions">
          <button type="button" class="btn btn-primary btn-sm btn-accept-freq">✓ รับแอด</button>
          <button type="button" class="btn-icon btn-decline-freq" title="ปฏิเสธ">✕</button>
        </div>
      `;
      row.querySelector('.friend-name').textContent = req.username;
      row.querySelector('.btn-accept-freq').addEventListener('click', () => {
        acceptIncomingFriendRequest(req.uid);
      });
      row.querySelector('.btn-decline-freq').addEventListener('click', () => {
        declineIncomingFriendRequest(req.uid);
      });
      friendRequestsList.appendChild(row);
    });
  }

  // --- Friends System ---
  function renderFriendsList() {
    friendsListContainer.innerHTML = '';
    if (friendsMap.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'friend-empty';
      empty.innerHTML = 'ยังไม่มีเพื่อนในรายชื่อ<br>ส่งคำขอด้วย UID ด้านบน หรือกดปุ่มสีเขียว <strong>"Add friend"</strong> ในห้องแชทได้เลย!';
      friendsListContainer.appendChild(empty);
      return;
    }

    friendsMap.forEach((friend) => {
      const item = document.createElement('div');
      item.className = 'friend-item';

      const safeRoomCode = escapeHtml(sanitizeRoomCode(friend.roomCode));
      const safeAvatar = escapeHtml(sanitizeAvatarUrl(friend.avatar));
      const safeUid = escapeHtml(sanitizeUid(friend.uid));

      const statusText = friend.online
        ? friend.inRoom && safeRoomCode
          ? `🟢 กำลังอยู่ในห้อง (${safeRoomCode})`
          : '🟢 ออนไลน์'
        : '⚪ ออฟไลน์';

      item.innerHTML = `
        <div class="friend-left">
          <div class="friend-avatar-wrap">
            <img src="${safeAvatar}" alt="Avatar" class="avatar-sm" />
            <span class="status-dot ${friend.online ? 'online' : ''}"></span>
          </div>
          <div class="friend-info">
            <div class="friend-name"></div>
            <div class="friend-meta mono">${safeUid} • ${statusText}</div>
          </div>
        </div>
        <div class="friend-actions">
          <button class="btn btn-primary btn-sm btn-chat-friend">
            ${activeRoomCode ? '➕ เชิญเข้าห้อง' : '💬 ชวนคุย'}
          </button>
          <button class="btn-icon btn-remove-friend" title="ลบเพื่อน">✕</button>
        </div>
      `;

      item.querySelector('.friend-name').textContent = friend.username || friend.uid;

      item.querySelector('.btn-chat-friend').addEventListener('click', () => {
        inviteFriendToChat(friend.uid);
      });

      item.querySelector('.btn-remove-friend').addEventListener('click', () => {
        const friendName = friend.username || friend.uid;
        if (!confirm(`คุณต้องการลบ "${friendName}" ออกจากรายชื่อเพื่อนหรือไม่?\n(ความเป็นเพื่อนจะถูกยกเลิกทั้งสองฝ่าย)`)) {
          return;
        }
        removeFriend(friend.uid, true);
      });

      friendsListContainer.appendChild(item);
    });
  }

  formAddFriend.addEventListener('submit', (e) => {
    e.preventDefault();
    const targetUid = inputFriendUid.value.trim().toUpperCase();
    if (!targetUid) return;
    sendFriendRequestToUid(targetUid, targetUid);
    inputFriendUid.value = '';
  });

  btnRefreshFriends.addEventListener('click', () => {
    pingAllFriends();
    showToast('ส่งสัญญาณเช็คสถานะเพื่อนแล้ว');
  });

  function inviteFriendToChat(targetUid) {
    if (!currentUser) return;
    if (!activeRoomCode) {
      joinRoomByCode(generateRoomCode());
    }
    publishJson(topicInbox(targetUid), {
      type: 'room_invite',
      roomCode: activeRoomCode,
      from: {
        uid: currentUser.uid,
        username: currentUser.username,
        avatar: currentUser.avatar
      }
    });
    sidebarPanel.classList.remove('mobile-open');
    showToast(`ส่งคำเชิญเข้าห้อง ${activeRoomCode} ให้เพื่อนแล้ว!`);
  }

  // --- Room Create / Join / Leave (Serverless Pub/Sub) ---
  function broadcastRoomJoin() {
    if (!currentUser || !activeRoomCode) return;
    const myMember = roomMembers.get(currentUser.uid);
    publishJson(topicRoom(activeRoomCode), {
      type: 'member_join',
      uid: currentUser.uid,
      username: currentUser.username,
      avatar: currentUser.avatar,
      tags: Array.from(selectedTags),
      currentText: myMember ? myMember.currentText : ''
    });
  }

  function leaveCurrentRoomSilent() {
    if (!activeRoomCode || !currentUser) return;
    const oldCode = activeRoomCode;
    cleanupStreamState();
    publishJson(topicRoom(oldCode), {
      type: 'member_leave',
      uid: currentUser.uid
    });
    if (roomMembers.size <= 1) {
      broadcastRoomClosedToDirectory(oldCode);
      discoveredRooms.delete(oldCode);
    }
    if (mqttClient && mqttClient.connected) {
      mqttClient.unsubscribe(topicRoom(oldCode));
    }
    activeRoomCode = null;
    roomMembers.clear();
  }

  function joinRoomByCode(code) {
    if (!currentUser) return;
    const clean = sanitizeRoomCode(code);
    if (!clean) {
      showToast('รหัสห้องไม่ถูกต้อง (ใช้ตัวอักษร A-Z หรือตัวเลข 3-12 หลัก)');
      return;
    }

    if (activeRoomCode && activeRoomCode !== clean) {
      leaveCurrentRoomSilent();
    }

    activeRoomCode = clean;
    roomMembers.clear();
    currentImage = null;
    hideInputImagePreview();

    roomMembers.set(currentUser.uid, {
      uid: currentUser.uid,
      username: currentUser.username,
      avatar: currentUser.avatar,
      tags: Array.from(selectedTags),
      currentText: '',
      image: null,
      updatedAt: Date.now(),
      lastActiveAt: 0,
      lastTypingAt: 0,
      lastEmoteAt: 0,
      lastEmote: null
    });

    liveTypingInput.value = '';
    charCounter.textContent = `0 / 250 ตัวอักษร`;

    if (mqttClient && mqttClient.connected) {
      mqttClient.subscribe(topicRoom(activeRoomCode), { qos: 0 }, () => {
        broadcastRoomJoin();
        broadcastActiveRoomToDirectory();
      });
    }

    broadcastMyPresence(true);
    renderAllLiveCards();
    updateRoomViewUI();
    renderFriendsList();
    inputRoomCode.value = '';
    sidebarPanel.classList.remove('mobile-open');
    showToast(`เข้าสู่ห้อง ${activeRoomCode} แล้ว`);
  }

  function createNewRoom() {
    joinRoomByCode(generateRoomCode());
  }

  btnCreateRoom.addEventListener('click', createNewRoom);
  btnEmptyCreateRoom.addEventListener('click', createNewRoom);

  if (btnScanRooms) {
    btnScanRooms.addEventListener('click', () => {
      requestDirectoryScan();
      renderDiscoveredRooms();
      showToast('📡 กำลังสแกนหาห้องที่มี Tag ตรงกับคุณ...');
    });
  }

  if (inputFilterRoomsTag) {
    inputFilterRoomsTag.addEventListener('input', () => {
      renderDiscoveredRooms();
    });
  }

  if (btnAutoMatchRoom) {
    btnAutoMatchRoom.addEventListener('click', () => {
      const scored = Array.from(discoveredRooms.values())
        .map((r) => ({ ...r, ...calculateTagMatch(r.tags) }))
        .sort((a, b) => b.matchedTags.length - a.matchedTags.length);

      if (scored.length > 0 && scored[0].matchedTags.length > 0) {
        const best = scored[0];
        joinRoomByCode(best.roomCode);
        showToast(`🎯 จับคู่เข้าห้อง #${best.roomCode} (ตรงกัน ${best.matchedTags.length} Tag)!`);
      } else if (scored.length > 0) {
        joinRoomByCode(scored[0].roomCode);
        showToast(`เข้าร่วมห้อง #${scored[0].roomCode}`);
      } else {
        createNewRoom();
        showToast('✨ ยังไม่มีห้องที่เปิดอยู่ ระบบสร้างห้องสาธารณะตาม Tag ของคุณให้แล้ว รอเพื่อนที่มี Tag ตรงกันเข้ามาได้เลย!');
      }
    });
  }

  if (btnToggleRoomPublic) {
    btnToggleRoomPublic.addEventListener('click', () => {
      isRoomPublic = !isRoomPublic;
      if (isRoomPublic) {
        btnToggleRoomPublic.classList.add('public');
        btnToggleRoomPublic.textContent = '🌐 ห้องสาธารณะ (ค้นหาเจอด้วย Tag)';
        broadcastActiveRoomToDirectory();
        showToast('เปิดห้องเป็นสาธารณะแล้ว คนที่มี Tag ตรงกับคุณจะค้นหาห้องนี้เจอ');
      } else {
        btnToggleRoomPublic.classList.remove('public');
        btnToggleRoomPublic.textContent = '🔒 ห้องส่วนตัว (เข้าได้เฉพาะรหัส/คำเชิญ)';
        broadcastRoomClosedToDirectory(activeRoomCode);
        showToast('เปลี่ยนเป็นห้องส่วนตัวแล้ว จะไม่แสดงในหน้าค้นหา Tag');
      }
    });
  }

  formJoinRoom.addEventListener('submit', (e) => {
    e.preventDefault();
    joinRoomByCode(inputRoomCode.value);
  });

  btnLeaveRoom.addEventListener('click', () => {
    leaveCurrentRoomSilent();
    liveTypingInput.value = '';
    charCounter.textContent = `0 / 250 ตัวอักษร`;
    broadcastMyPresence(true);
    updateRoomViewUI();
    renderFriendsList();
    showToast('ออกจากห้องสนทนาแล้ว (ไม่มีการเก็บประวัติใดๆ)');
  });

  btnCopyRoomCode.addEventListener('click', () => {
    if (!activeRoomCode) return;
    navigator.clipboard.writeText(activeRoomCode).then(() => {
      showToast(`คัดลอกรหัสห้อง ${activeRoomCode} แล้ว`);
    });
  });

  btnCopyRoomLink.addEventListener('click', () => {
    if (!activeRoomCode) return;
    const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(activeRoomCode)}`;
    navigator.clipboard.writeText(url).then(() => {
      showToast('คัดลอกลิงก์เชิญเข้าห้องแล้ว ส่งให้เพื่อนได้เลย!');
    });
  });

  btnMobileToggleSidebar.addEventListener('click', () => {
    sidebarPanel.classList.add('mobile-open');
  });

  btnBackToSidebar.addEventListener('click', () => {
    sidebarPanel.classList.toggle('mobile-open');
  });

  // --- Room Layout Controls (2 Columns Grid vs 1 Column Single) ---
  function applyRoomLayout(isSingle) {
    if (!liveCardsGrid) return;
    if (isSingle) {
      liveCardsGrid.classList.add('layout-single-col');
      if (roomLayoutIcon) roomLayoutIcon.textContent = '☰';
      if (roomLayoutLabel) roomLayoutLabel.textContent = '1 คอลัมน์';
      if (btnToggleRoomLayout) btnToggleRoomLayout.title = 'สลับเป็นมุมมอง 2 คอลัมน์คู่';
    } else {
      liveCardsGrid.classList.remove('layout-single-col');
      if (roomLayoutIcon) roomLayoutIcon.textContent = '⊞';
      if (roomLayoutLabel) roomLayoutLabel.textContent = '2 คอลัมน์';
      if (btnToggleRoomLayout) btnToggleRoomLayout.title = 'สลับเป็นมุมมอง 1 คอลัมน์เดี่ยว';
    }
  }

  function initRoomLayoutPreference() {
    try {
      const saved = localStorage.getItem('livetype_room_layout');
      // Default to 2 columns ('double') on desktop
      const isSingle = saved === 'single';
      applyRoomLayout(isSingle);
    } catch (e) {
      applyRoomLayout(false);
    }
  }

  if (btnToggleRoomLayout) {
    btnToggleRoomLayout.addEventListener('click', () => {
      const isCurrentlySingle = liveCardsGrid ? liveCardsGrid.classList.contains('layout-single-col') : false;
      const nextIsSingle = !isCurrentlySingle;
      applyRoomLayout(nextIsSingle);
      try {
        localStorage.setItem('livetype_room_layout', nextIsSingle ? 'single' : 'double');
      } catch (e) {}
      showToast(nextIsSingle ? 'สลับเป็นมุมมอง 1 คอลัมน์เดี่ยวแล้ว' : 'สลับเป็นมุมมอง 2 คอลัมน์คู่แล้ว');
    });
  }

  // --- Room UI & Live Cards Rendering ---
  function updateRoomViewUI() {
    if (!activeRoomCode) {
      roomEmptyState.classList.remove('hidden');
      roomActiveView.classList.add('hidden');
      if (btnShowSidebarRoomQr) btnShowSidebarRoomQr.classList.add('hidden');
      requestDirectoryScan();
      renderDiscoveredRooms();
      return;
    }
    roomEmptyState.classList.add('hidden');
    roomActiveView.classList.remove('hidden');
    if (btnShowSidebarRoomQr) btnShowSidebarRoomQr.classList.remove('hidden');
    activeRoomCodeEl.textContent = activeRoomCode;
    roomMemberCount.textContent = `${roomMembers.size} คนในห้อง`;
    setTimeout(() => liveTypingInput.focus(), 80);
  }

  // --- QR Code Generation & Scanner Engine ---
  let html5QrScanner = null;

  function openRoomQrModal() {
    if (!activeRoomCode) {
      showToast('กรุณาสร้างหรือเข้าห้องสนทนาก่อนแสดง QR Code');
      return;
    }
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(activeRoomCode)}`;
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=8&data=${encodeURIComponent(shareUrl)}`;
    roomQrImage.src = qrApiUrl;
    qrModalRoomCode.textContent = activeRoomCode;
    qrDisplayModal.classList.remove('hidden');
  }

  if (btnShowRoomQr) {
    btnShowRoomQr.addEventListener('click', openRoomQrModal);
  }
  if (btnShowSidebarRoomQr) {
    btnShowSidebarRoomQr.addEventListener('click', openRoomQrModal);
  }
  if (btnCloseQrModal) {
    btnCloseQrModal.addEventListener('click', () => {
      qrDisplayModal.classList.add('hidden');
    });
  }
  if (btnDownloadQr) {
    btnDownloadQr.addEventListener('click', async () => {
      if (!roomQrImage.src || !activeRoomCode) return;
      try {
        const res = await fetch(roomQrImage.src);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `LiveType-Room-${activeRoomCode}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast('💾 บันทึกรูป QR Code ลงเครื่องแล้ว');
      } catch (e) {
        window.open(roomQrImage.src, '_blank');
      }
    });
  }

  function extractRoomCodeFromScannedText(decodedText) {
    const raw = String(decodedText || '').trim();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      const roomParam = url.searchParams.get('room');
      if (roomParam) return roomParam.trim().toUpperCase();
    } catch (e) {
      // Not a full URL, treat as direct room code
    }
    if (/^[A-Z0-9-]{4,12}$/i.test(raw)) {
      return raw.toUpperCase();
    }
    return null;
  }

  async function stopQrCameraScanner() {
    if (html5QrScanner) {
      try {
        if (html5QrScanner.isScanning) {
          await html5QrScanner.stop();
        }
        html5QrScanner.clear();
      } catch (e) {}
      html5QrScanner = null;
    }
  }

  async function startQrCameraScanner() {
    if (!qrScannerModal) return;
    qrScannerModal.classList.remove('hidden');
    const readerEl = document.getElementById('qrReaderBox');
    if (readerEl) {
      readerEl.innerHTML = '<span style="color:var(--text-muted);font-size:0.85rem;">กำลังเปิดกล้องสแกน QR...</span>';
    }

    if (!window.Html5Qrcode) {
      if (readerEl) readerEl.innerHTML = '<span style="color:var(--text-muted);font-size:0.85rem;">กรุณาเลือกรูปภาพ QR Code จากปุ่มด้านล่าง</span>';
      return;
    }

    await stopQrCameraScanner();
    html5QrScanner = new window.Html5Qrcode('qrReaderBox');
    try {
      await html5QrScanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 200, height: 200 } },
        async (decodedText) => {
          const code = extractRoomCodeFromScannedText(decodedText);
          if (code) {
            await stopQrCameraScanner();
            qrScannerModal.classList.add('hidden');
            joinRoomByCode(code);
          }
        },
        () => {}
      );
    } catch (err) {
      if (readerEl) {
        readerEl.innerHTML =
          '<span style="color:var(--text-muted);font-size:0.82rem;padding:12px;text-align:center;">ไม่พบกล้องหรือไม่ได้อนุญาตสิทธิ์กล้อง<br>สามารถกดปุ่ม <strong>"🖼️ เลือกรูปภาพ QR Code จากในเครื่อง"</strong> ด้านล่างแทนได้เลยครับ</span>';
      }
    }
  }

  if (btnOpenQrScanner) {
    btnOpenQrScanner.addEventListener('click', startQrCameraScanner);
  }

  if (btnCloseScannerModal) {
    btnCloseScannerModal.addEventListener('click', async () => {
      await stopQrCameraScanner();
      qrScannerModal.classList.add('hidden');
    });
  }

  if (inputQrFile) {
    inputQrFile.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file || !window.Html5Qrcode) return;

      const secCheck = await validateImageFileSecurity(file, { allowGif: true });
      if (!secCheck.ok) {
        showToast(secCheck.reason, 6000);
        showSecurityAlertModal(file, secCheck.threatDetails, async (cleanImg, cleanFile) => {
          await stopQrCameraScanner();
          const fileScanner = new window.Html5Qrcode('qrReaderBox');
          try {
            const decodedText = await fileScanner.scanFile(cleanFile, true);
            const code = extractRoomCodeFromScannedText(decodedText);
            if (code) {
              qrScannerModal.classList.add('hidden');
              joinRoomByCode(code);
            } else {
              showToast('ไม่พบรหัสห้องใน QR Code นี้');
            }
          } catch (err) {
            showToast('ไม่สามารถอ่าน QR Code จากรูปภาพนี้ได้ กรุณาลองรูปอื่น');
          }
        });
        inputQrFile.value = '';
        return;
      }

      await stopQrCameraScanner();
      const fileScanner = new window.Html5Qrcode('qrReaderBox');
      try {
        const decodedText = await fileScanner.scanFile(file, true);
        const code = extractRoomCodeFromScannedText(decodedText);
        if (code) {
          qrScannerModal.classList.add('hidden');
          joinRoomByCode(code);
        } else {
          showToast('ไม่พบรหัสห้องใน QR Code นี้');
        }
      } catch (err) {
        showToast('ไม่สามารถอ่าน QR Code จากรูปภาพนี้ได้ กรุณาลองรูปอื่น');
      } finally {
        inputQrFile.value = '';
      }
    });
  }

  const EMOTE_ACTIVE_DURATION_MS = 20000;

  function getMemberEngagementInfo(member) {
    if (!member) {
      return {
        tier: 3,
        isStreamer: false,
        hasContent: false,
        hasText: false,
        hasImage: false,
        hasRecentEmote: false,
        lastActive: 0
      };
    }

    const isStreamer = Boolean(activeStreamerUid && member.uid === activeStreamerUid);
    const hasText = Boolean(member.currentText && member.currentText.trim().length > 0);
    const hasImage = Boolean(member.image);
    const hasContent = hasText || hasImage;
    const now = Date.now();
    const hasRecentEmote = Boolean(member.lastEmoteAt && (now - member.lastEmoteAt) < EMOTE_ACTIVE_DURATION_MS);

    let tier = 3; // Tier 3: Non-Active
    if (isStreamer) {
      tier = 1; // Tier 1: Streamer (Top)
    } else if (hasContent || hasRecentEmote) {
      tier = 2; // Tier 2: Active Engagement (Typing, Emote, GIF/Image)
    }

    const lastActive = member.lastActiveAt || member.updatedAt || 0;
    return {
      tier,
      isStreamer,
      hasContent,
      hasText,
      hasImage,
      hasRecentEmote,
      lastActive
    };
  }

  function sortRoomMembers(members) {
    return members.slice().sort((a, b) => {
      const infoA = getMemberEngagementInfo(a);
      const infoB = getMemberEngagementInfo(b);

      // 1. Tier 1 (Streamer) > Tier 2 (Active) > Tier 3 (Non-Active)
      if (infoA.tier !== infoB.tier) {
        return infoA.tier - infoB.tier;
      }

      // 2. Within Tier 2 (Active Engagement): most recent activity first
      if (infoA.tier === 2) {
        if (infoB.lastActive !== infoA.lastActive) {
          return infoB.lastActive - infoA.lastActive;
        }
      }

      // 3. Within Tier 3 (Non-Active): prioritize current user, then alphabetical
      const isSelfA = currentUser && a.uid === currentUser.uid;
      const isSelfB = currentUser && b.uid === currentUser.uid;
      if (isSelfA && !isSelfB) return -1;
      if (!isSelfA && isSelfB) return 1;

      if (infoB.lastActive !== infoA.lastActive) {
        return infoB.lastActive - infoA.lastActive;
      }

      return (a.username || '').localeCompare(b.username || '');
    });
  }

  function reorderLiveCards() {
    if (!liveCardsGrid) return;
    const members = Array.from(roomMembers.values());
    const sorted = sortRoomMembers(members);

    sorted.forEach((member, index) => {
      const cardEl = document.getElementById(`live-card-${member.uid}`);
      if (!cardEl) return;

      // Update CSS order (0 = top, 1, 2, ...)
      cardEl.style.order = index;

      const info = getMemberEngagementInfo(member);
      cardEl.classList.toggle('is-streamer', info.isStreamer);
      cardEl.classList.toggle('is-active-engagement', info.tier === 2);
      cardEl.classList.toggle('is-idle', info.tier === 3);

      const pillEl = document.getElementById(`status-pill-${member.uid}`);
      if (pillEl) {
        if (info.isStreamer) {
          pillEl.className = 'typing-status-pill streamer-badge';
          pillEl.innerHTML = '<span class="pulse-dot red"></span> 🔴 กำลังไลฟ์สด';
        } else if (info.hasContent) {
          pillEl.className = 'typing-status-pill active';
          pillEl.innerHTML = '<span class="pulse-dot"></span> ' + (info.hasImage && !info.hasText ? '🖼️ ส่งรูป/GIF สด' : '⚡ กำลังส่งสด...');
        } else if (info.hasRecentEmote) {
          pillEl.className = 'typing-status-pill active emote-active';
          pillEl.textContent = `🫧 ส่งอีโมจิ ${member.lastEmote || ''}`;
        } else {
          pillEl.className = 'typing-status-pill idle';
          pillEl.textContent = '💤 Non-Active';
        }
      }
    });
  }

  function renderAllLiveCards() {
    liveCardsGrid.innerHTML = '';
    roomMemberCount.textContent = `${roomMembers.size} คนในห้อง`;
    const myTagsLower = new Set(Array.from(selectedTags).map((t) => t.toLowerCase()));

    // Sort members by engagement: Streamer (#1) -> Active (#2: typing/emote/gif) -> Non-Active (#3)
    const sortedMembers = sortRoomMembers(Array.from(roomMembers.values()));

    sortedMembers.forEach((member, index) => {
      const isSelf = currentUser && member.uid === currentUser.uid;
      const isAlreadyFriend = friendsMap.has(member.uid);
      const isPendingSent = sentFriendRequests.has(member.uid);
      const hasIncomingReq = incomingFriendRequests.has(member.uid);
      const info = getMemberEngagementInfo(member);
      const hasContent = info.hasContent;
      const memberTags = Array.isArray(member.tags) ? member.tags : [];
      const tagsHtml = memberTags
        .slice(0, 5)
        .map((t) => {
          const isMatch = !isSelf && myTagsLower.has(String(t).toLowerCase());
          return `<span class="tag-badge-mini ${isMatch ? 'matched' : ''}">${isMatch ? '✓ ' : ''}${escapeHtml(t)}</span>`;
        })
        .join('');

      let friendActionHtml = '';
      if (!isSelf) {
        if (isAlreadyFriend) {
          friendActionHtml = `<button type="button" class="btn-card-add-friend is-friend" data-action="remove" title="คลิกเพื่อยกเลิกความเป็นเพื่อน"><span class="friend-label-normal">✓ เพื่อน</span><span class="friend-label-hover">✕ ลบเพื่อน</span></button>`;
        } else if (hasIncomingReq) {
          friendActionHtml = `<button type="button" class="btn-card-add-friend" data-action="accept">✓ รับแอดเพื่อน</button>`;
        } else if (isPendingSent) {
          friendActionHtml = `<button type="button" class="btn-card-add-friend pending" disabled>⏳ รอตอบรับ...</button>`;
        } else {
          friendActionHtml = `<button type="button" class="btn-card-add-friend" data-action="request">Add friend</button>`;
        }
      }

      const safeMemberUid = escapeHtml(sanitizeUid(member.uid));
      const safeMemberAvatar = escapeHtml(sanitizeAvatarUrl(member.avatar));

      let statusPillHtml = '';
      if (info.isStreamer) {
        statusPillHtml = `<span class="typing-status-pill streamer-badge" id="status-pill-${safeMemberUid}"><span class="pulse-dot red"></span> 🔴 กำลังไลฟ์สด</span>`;
      } else if (hasContent) {
        statusPillHtml = `<span class="typing-status-pill active" id="status-pill-${safeMemberUid}"><span class="pulse-dot"></span> ${member.image && !member.currentText ? '🖼️ ส่งรูป/GIF สด' : '⚡ กำลังส่งสด...'}</span>`;
      } else if (info.hasRecentEmote) {
        statusPillHtml = `<span class="typing-status-pill active emote-active" id="status-pill-${safeMemberUid}">🫧 ส่งอีโมจิ ${escapeHtml(member.lastEmote || '')}</span>`;
      } else {
        statusPillHtml = `<span class="typing-status-pill idle" id="status-pill-${safeMemberUid}">💤 Non-Active</span>`;
      }

      // Stream Icon Badge next to profile if member is streaming
      let streamBadgeHtml = '';
      if (info.isStreamer) {
        if (isSelf) {
          streamBadgeHtml = `<button type="button" class="btn-card-stream-badge btn-stream-card-trigger" title="คุณกำลังไลฟ์สด (คลิกเพื่อเปิดหน้าต่างไลฟ์)"><span class="live-dot-pulse"></span> 🖥️ ไลฟ์ของคุณ</button>`;
        } else if (isWatching) {
          streamBadgeHtml = `<button type="button" class="btn-card-stream-badge watching btn-stream-card-trigger" title="กำลังรับชมไลฟ์ (คลิกเพื่อเปิด/ปิดหน้าต่างไลฟ์)"><span class="live-dot-pulse"></span> 🖥️ ดูไลฟ์อยู่</button>`;
        } else {
          streamBadgeHtml = `<button type="button" class="btn-card-stream-badge btn-stream-card-trigger" title="คลิกเพื่อเริ่มรับชมไลฟ์สดของ ${escapeHtml(member.username)}"><span class="live-dot-pulse"></span> 🖥️ ดูไลฟ์สด</button>`;
        }
      }

      const card = document.createElement('div');
      card.id = `live-card-${safeMemberUid}`;
      card.style.order = index;
      card.className = `live-card ${isSelf ? 'is-self' : ''} ${info.isStreamer ? 'is-streamer' : ''} ${hasContent ? 'actively-typing' : ''} ${info.tier === 2 ? 'is-active-engagement' : ''} ${info.tier === 3 ? 'is-idle' : ''}`;

      card.innerHTML = `
        <!-- Left Side: User Profile Column -->
        <div class="live-card-profile-col">
          <div class="live-card-user-row">
            <div class="live-card-avatar-wrap">
              <img src="${safeMemberAvatar}" alt="Avatar" class="avatar-md" />
            </div>
            <div class="live-card-meta">
              <div class="live-card-username">
                <span class="name-text"></span>
                ${isSelf ? '<span class="self-tag">คุณ</span>' : ''}
              </div>
              <div class="live-card-uid mono">${safeMemberUid}</div>
            </div>
          </div>
          <div class="live-card-status-row">
            ${friendActionHtml}
            ${streamBadgeHtml}
            ${statusPillHtml}
          </div>
          ${tagsHtml ? `<div class="live-card-tags">${tagsHtml}</div>` : ''}
        </div>

        <!-- Right Side: Realtime Live Message / Media in the Same Row (Expands downward) -->
        <div class="live-card-body" id="card-body-${safeMemberUid}"></div>
      `;

      card.querySelector('.name-text').textContent = member.username;

      // Stream badge click handler
      const streamBtn = card.querySelector('.btn-stream-card-trigger');
      if (streamBtn) {
        streamBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (info.isStreamer) {
            if (isSelf) {
              if (floatingStreamWindow) floatingStreamWindow.classList.remove('hidden');
            } else {
              if (floatingStreamWindow) floatingStreamWindow.classList.remove('hidden');
              if (!isWatching) {
                toggleWatchStream();
              }
            }
          }
        });
      }

      const addFriendBtn = card.querySelector('.btn-card-add-friend');
      if (addFriendBtn && !addFriendBtn.disabled) {
        addFriendBtn.addEventListener('click', () => {
          const act = addFriendBtn.getAttribute('data-action');
          if (act === 'accept') {
            acceptIncomingFriendRequest(member.uid);
          } else if (act === 'remove') {
            const memberName = member.username || member.uid;
            if (confirm(`คุณต้องการลบ "${memberName}" ออกจากรายชื่อเพื่อนหรือไม่?\n(ความเป็นเพื่อนจะถูกยกเลิกทั้งสองฝ่าย)`)) {
              removeFriend(member.uid, true);
            }
          } else {
            sendFriendRequestToUid(member.uid, member.username);
          }
        });
      }

      liveCardsGrid.appendChild(card);
      updateSingleCardContent(member.uid, member.currentText, member.image);
    });
  }

  function updateSingleCardContent(uid, text, image) {
    const bodyEl = document.getElementById(`card-body-${uid}`);
    const cardEl = document.getElementById(`live-card-${uid}`);
    const pillEl = document.getElementById(`status-pill-${uid}`);
    if (!bodyEl || !cardEl || !pillEl) return;

    const safeImage = sanitizeChatMediaUrl(image);
    bodyEl.innerHTML = '';
    const hasText = Boolean(text && text.length > 0);
    const hasImage = Boolean(safeImage);
    const hasContent = hasText || hasImage;

    bodyEl.classList.toggle('has-image', hasImage);
    bodyEl.classList.toggle('has-text', hasText);
    bodyEl.classList.toggle('has-image-and-text', hasImage && hasText);

    const member = roomMembers.get(uid);
    const info = getMemberEngagementInfo(member || { uid, currentText: text, image: safeImage });

    cardEl.classList.toggle('is-streamer', info.isStreamer);
    cardEl.classList.toggle('actively-typing', hasContent);
    cardEl.classList.toggle('is-active-engagement', info.tier === 2);
    cardEl.classList.toggle('is-idle', info.tier === 3);

    if (hasContent) {
      if (hasImage) {
        const imgWrap = document.createElement('div');
        imgWrap.className = 'live-card-image-wrap';
        if (String(safeImage).startsWith('data:video/')) {
          const vidEl = document.createElement('video');
          vidEl.src = safeImage;
          vidEl.className = 'live-card-video';
          vidEl.autoplay = true;
          vidEl.loop = true;
          vidEl.muted = true;
          vidEl.playsInline = true;
          imgWrap.appendChild(vidEl);
        } else {
          const imgEl = document.createElement('img');
          imgEl.src = safeImage;
          imgEl.alt = 'Live image';
          imgEl.className = 'live-card-img';
          imgWrap.appendChild(imgEl);
        }
        bodyEl.appendChild(imgWrap);
      }

      if (hasText) {
        const textWrap = document.createElement('div');
        textWrap.className = 'live-card-text-wrap';
        const textSpan = document.createElement('span');
        textSpan.className = 'live-card-text';
        textSpan.textContent = text;
        const cursorSpan = document.createElement('span');
        cursorSpan.className = 'live-cursor';
        textWrap.appendChild(textSpan);
        textWrap.appendChild(cursorSpan);
        bodyEl.appendChild(textWrap);
      } else if (hasImage) {
        // If has image but no text yet: show live-cursor on the right if it's the current user (ready to type)
        if (currentUser && currentUser.uid === uid) {
          const textWrap = document.createElement('div');
          textWrap.className = 'live-card-text-wrap';
          const cursorSpan = document.createElement('span');
          cursorSpan.className = 'live-cursor';
          textWrap.appendChild(cursorSpan);
          bodyEl.appendChild(textWrap);
        }
      } else {
        const textWrap = document.createElement('div');
        textWrap.className = 'live-card-text-wrap';
        const cursorSpan = document.createElement('span');
        cursorSpan.className = 'live-cursor';
        textWrap.appendChild(cursorSpan);
        bodyEl.appendChild(textWrap);
      }

      bodyEl.scrollTop = bodyEl.scrollHeight;
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'live-card-placeholder';
      placeholder.textContent = 'ยังไม่มีข้อความ (Non-Active)... (กด Enter เมื่อต้องการล้างทั้งหมด)';
      bodyEl.appendChild(placeholder);
    }

    if (info.isStreamer) {
      pillEl.className = 'typing-status-pill streamer-badge';
      pillEl.innerHTML = '<span class="pulse-dot red"></span> 🔴 กำลังไลฟ์สด';
    } else if (hasContent) {
      pillEl.className = 'typing-status-pill active';
      pillEl.innerHTML = '<span class="pulse-dot"></span> ' + (hasImage && !hasText ? '🖼️ ส่งรูป/GIF สด' : '⚡ กำลังส่งสด...');
    } else if (info.hasRecentEmote) {
      pillEl.className = 'typing-status-pill active emote-active';
      pillEl.textContent = `🫧 ส่งอีโมจิ ${member ? member.lastEmote || '' : ''}`;
    } else {
      pillEl.className = 'typing-status-pill idle';
      pillEl.textContent = '💤 Non-Active';
    }
  }

  function flashClearCard(uid) {
    const cardEl = document.getElementById(`live-card-${uid}`);
    if (!cardEl) return;
    cardEl.classList.remove('flash-cleared');
    void cardEl.offsetWidth;
    cardEl.classList.add('flash-cleared');
  }

  // --- Floating Soap-Bubble Emote Effect ---
  function spawnEmoteBubbleOnCard(uid, emote) {
    const cardEl = document.getElementById(`live-card-${uid}`);
    if (!cardEl) return;
    const userWrap = cardEl.querySelector('.live-card-avatar-wrap') || cardEl.querySelector('.live-card-profile-col') || cardEl;

    const bubble = document.createElement('div');
    bubble.className = 'emote-bubble';
    bubble.textContent = emote;

    // Random horizontal sway (-28px to +28px) so multiple bubbles look like real soap bubbles
    const swayX = Math.round((Math.random() - 0.5) * 56);
    bubble.style.setProperty('--sway-x', `${swayX}px`);

    userWrap.appendChild(bubble);
    setTimeout(() => {
      bubble.remove();
    }, 2350);
  }

  function triggerSendEmoteBubble(emote) {
    if (!currentUser || !activeRoomCode) return;
    if (roomMembers.has(currentUser.uid)) {
      const myMem = roomMembers.get(currentUser.uid);
      myMem.lastEmoteAt = Date.now();
      myMem.lastEmote = emote;
      myMem.lastActiveAt = Date.now();
    }
    spawnEmoteBubbleOnCard(currentUser.uid, emote);
    reorderLiveCards();
    setTimeout(() => reorderLiveCards(), 20500);
    publishJson(topicRoom(activeRoomCode), {
      type: 'emote_bubble',
      uid: currentUser.uid,
      emote
    });
  }

  // --- Realtime Live Input, Auto-Downscaling Large Image/GIF & 250 Char Limit ---
  const MAX_CHAR_LIMIT = 250;

  function showInputImagePreview(dataOrUrl) {
    if (String(dataOrUrl).startsWith('data:video/')) {
      inputPreviewThumb.src = PRESET_AVATARS[11];
    } else {
      inputPreviewThumb.src = dataOrUrl;
    }
    inputImagePreviewBar.classList.remove('hidden');
  }

  function hideInputImagePreview() {
    inputPreviewThumb.src = '';
    inputImagePreviewBar.classList.add('hidden');
    inputLiveImage.value = '';
    currentImage = null;
  }

  function setAndBroadcastLiveMedia(mediaSource, labelMsg) {
    if (!activeRoomCode || !currentUser) return;
    currentImage = mediaSource;
    showInputImagePreview(currentImage);

    if (roomMembers.has(currentUser.uid)) {
      const myMem = roomMembers.get(currentUser.uid);
      myMem.image = currentImage;
      myMem.lastActiveAt = Date.now();
      updateSingleCardContent(currentUser.uid, myMem.currentText, currentImage);
      reorderLiveCards();
    }

    publishJson(topicRoom(activeRoomCode), {
      type: 'typing_update',
      uid: currentUser.uid,
      username: currentUser.username,
      avatar: currentUser.avatar,
      text: liveTypingInput.value.slice(0, MAX_CHAR_LIMIT),
      image: currentImage
    });

    if (labelMsg) showToast(labelMsg);
  }

  // Adaptive Image Compressor: accepts ANY huge image (e.g. 20MB+) and scales down until lightweight
  function compressStaticImageToDataUrl(img, targetMaxBytes = 140000) {
    let maxDim = 760;
    let quality = 0.72;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    for (let attempt = 0; attempt < 5; attempt++) {
      let width = img.width;
      let height = img.height;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.max(1, Math.round((height * maxDim) / width));
          width = maxDim;
        } else {
          width = Math.max(1, Math.round((width * maxDim) / height));
          height = maxDim;
        }
      }
      canvas.width = width;
      canvas.height = height;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      // Prefer WebP if browser supports encoding it, fallback to JPEG
      let dataUrl = canvas.toDataURL('image/webp', quality);
      if (!dataUrl.startsWith('data:image/webp')) {
        dataUrl = canvas.toDataURL('image/jpeg', quality);
      }

      if (dataUrl.length <= targetMaxBytes * 1.35) {
        return dataUrl;
      }

      maxDim = Math.round(maxDim * 0.72);
      quality = Math.max(0.38, quality - 0.14);
    }

    return canvas.toDataURL('image/jpeg', 0.4);
  }

  // Heavy Animated GIF Compressor using WebCodecs ImageDecoder + Canvas MediaRecorder (keeps animation!)
  async function compressLargeAnimatedGif(file) {
    // 1. If browser supports WebCodecs ImageDecoder + MediaRecorder -> transcode animated frames into lightweight looping WebM
    if ('ImageDecoder' in window && 'MediaRecorder' in window) {
      try {
        const buffer = await file.arrayBuffer();
        const decoder = new window.ImageDecoder({ data: buffer, type: 'image/gif' });
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack;
        const frameCount = Math.min(track.frameCount || 1, 55); // cap frames to keep size super light

        if (frameCount > 1) {
          const firstFrame = await decoder.decode({ frameIndex: 0 });
          const origW = firstFrame.image.displayWidth || 320;
          const origH = firstFrame.image.displayHeight || 320;
          firstFrame.image.close();

          const maxDim = 280;
          let targetW = origW;
          let targetH = origH;
          if (targetW > maxDim || targetH > maxDim) {
            if (targetW > targetH) {
              targetH = Math.max(2, Math.round((targetH * maxDim) / targetW));
              targetW = maxDim;
            } else {
              targetW = Math.max(2, Math.round((targetW * maxDim) / targetH));
              targetH = maxDim;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext('2d');

          const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
            ? 'video/webm;codecs=vp9'
            : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
            ? 'video/webm;codecs=vp8'
            : 'video/webm';

          const stream = canvas.captureStream(15);
          const recorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: 260000 // ~260 kbps -> very small file size
          });

          const chunks = [];
          recorder.ondataavailable = (ev) => {
            if (ev.data && ev.data.size > 0) chunks.push(ev.data);
          };

          const stoppedPromise = new Promise((resolve) => {
            recorder.onstop = resolve;
          });

          recorder.start();

          // Step through frames (skip every 2nd frame if very long GIF so it finishes fast)
          const step = frameCount > 30 ? 2 : 1;
          for (let i = 0; i < frameCount; i += step) {
            const res = await decoder.decode({ frameIndex: i });
            ctx.clearRect(0, 0, targetW, targetH);
            ctx.drawImage(res.image, 0, 0, targetW, targetH);
            const durationMs = Math.min(200, Math.max(40, (res.image.duration || 70000) / 1000)) * step;
            res.image.close();
            await new Promise((r) => setTimeout(r, durationMs));
          }

          recorder.stop();
          await stoppedPromise;
          decoder.close();

          const blob = new Blob(chunks, { type: 'video/webm' });
          if (blob.size > 0 && blob.size < 650000) {
            return await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.readAsDataURL(blob);
            });
          }
        }
      } catch (e) {
        // Fallback to static downscaled frame below if WebCodecs fails
      }
    }

    // 2. Fallback: load GIF into Image and compress resolution/quality via Canvas
    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(compressStaticImageToDataUrl(img, 120000));
      };
      img.onerror = (err) => {
        URL.revokeObjectURL(url);
        reject(err);
      };
      img.src = url;
    });
  }

  // Re-encodes static images <= 2MB through HTML5 Canvas to strip EXIF/GPS metadata,
  // steganography, and any appended polyglot payloads while keeping high visual quality.
  function sanitizeStaticImageViaCanvas(img, detectedMime) {
    const maxDim = 1920;
    let width = img.naturalWidth || img.width;
    let height = img.naturalHeight || img.height;
    if (width > maxDim || height > maxDim) {
      if (width > height) {
        height = Math.max(1, Math.round((height * maxDim) / width));
        width = maxDim;
      } else {
        width = Math.max(1, Math.round((width * maxDim) / height));
        height = maxDim;
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    if (detectedMime === 'image/png') {
      const pngUrl = canvas.toDataURL('image/png');
      if (pngUrl.length <= 2.4 * 1024 * 1024) {
        return pngUrl;
      }
    }
    let outUrl = canvas.toDataURL('image/webp', 0.92);
    if (!outUrl.startsWith('data:image/webp')) {
      outUrl = canvas.toDataURL('image/jpeg', 0.92);
    }
    return outUrl;
  }

  async function processImageFile(file) {
    if (!file) return;
    if (!activeRoomCode) {
      showToast('กรุณาสร้างหรือเข้าห้องแชทก่อนส่งรูปภาพ/GIF');
      inputLiveImage.value = '';
      return;
    }

    // 1. Validate Magic Bytes + Scan for Polyglot/Embedded Script Payloads
    const secCheck = await validateImageFileSecurity(file, { allowGif: true });
    if (!secCheck.ok) {
      showToast(secCheck.reason, 6000);
      showSecurityAlertModal(file, secCheck.threatDetails, (cleanImg) => {
        if (cleanImg.naturalWidth > MAX_IMAGE_DIMENSION || cleanImg.naturalHeight > MAX_IMAGE_DIMENSION) {
          showToast('🚫 ความละเอียดรูปภาพสูงเกินพิกัดความปลอดภัย (สูงสุด 8192x8192 px)');
          return;
        }
        const sanitizedDataUrl = sanitizeStaticImageViaCanvas(cleanImg, 'image/png');
        setAndBroadcastLiveMedia(
          sanitizedDataUrl,
          '📷 ส่งรูปภาพ (ล้างโค้ดแฝง/Metadata แล้ว) เรียบร้อย! (กด Enter เพื่อล้าง)'
        );
      });
      inputLiveImage.value = '';
      return;
    }

    const isGif = secCheck.detectedType === 'image/gif';
    const TWO_MB_BYTES = 2 * 1024 * 1024; // 2MB threshold

    // 2. If GIF is <= 2MB: verify dimensions against Decompression Bomb, then send
    if (isGif && file.size <= TWO_MB_BYTES) {
      const objUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(objUrl);
        if (img.naturalWidth > MAX_IMAGE_DIMENSION || img.naturalHeight > MAX_IMAGE_DIMENSION) {
          showToast('🚫 ความละเอียดไฟล์ GIF สูงเกินพิกัดความปลอดภัย');
          inputLiveImage.value = '';
          return;
        }
        const reader = new FileReader();
        reader.onload = (ev) => {
          setAndBroadcastLiveMedia(
            ev.target.result,
            '👾 ส่งไฟล์ GIF ความชัดต้นฉบับ 100% (ผ่านการตรวจความปลอดภัย) แล้ว! (กด Enter เพื่อล้าง)'
          );
        };
        reader.readAsDataURL(file);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        showToast('🚫 ไม่สามารถถอดรหัสไฟล์ GIF นี้ได้');
        inputLiveImage.value = '';
      };
      img.src = objUrl;
      return;
    }

    // 3. If file > 2MB and is GIF -> compress animated GIF via WebCodecs + Canvas
    if (isGif) {
      showToast('⏳ ไฟล์ GIF ใหญ่เกิน 2MB ระบบกำลังย่อขนาดและความชัดลงอัตโนมัติ...');
      try {
        const compressedMedia = await compressLargeAnimatedGif(file);
        setAndBroadcastLiveMedia(
          compressedMedia,
          '👾 ย่อขนาดไฟล์ GIF (>2MB) และส่งสดเรียบร้อยแล้ว! (กด Enter เพื่อล้าง)'
        );
      } catch (err) {
        showToast('ไม่สามารถประมวลผลไฟล์ GIF นี้ได้');
      }
      return;
    }

    // 4. Static picture (JPEG / PNG / WebP): Always decode and re-encode via HTML5 Canvas!
    // This strips 100% of EXIF/GPS metadata, steganography, and appended polyglot bytes.
    if (file.size > TWO_MB_BYTES) {
      showToast('⏳ รูปภาพมีขนาดเกิน 2MB กำลังย่อความละเอียดลงอัตโนมัติ...');
    }
    const objUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objUrl);
      if (img.naturalWidth > MAX_IMAGE_DIMENSION || img.naturalHeight > MAX_IMAGE_DIMENSION) {
        showToast('🚫 ความละเอียดรูปภาพสูงเกินพิกัดความปลอดภัย (สูงสุด 8192x8192 px)');
        inputLiveImage.value = '';
        return;
      }
      if (file.size <= TWO_MB_BYTES) {
        const sanitizedDataUrl = sanitizeStaticImageViaCanvas(img, secCheck.detectedType);
        setAndBroadcastLiveMedia(
          sanitizedDataUrl,
          '📷 ส่งรูปภาพความชัดสูง (ล้าง Metadata/โค้ดแฝงแล้ว) เรียบร้อย! (กด Enter เพื่อล้าง)'
        );
      } else {
        const compressedDataUrl = compressStaticImageToDataUrl(img, 350000);
        setAndBroadcastLiveMedia(
          compressedDataUrl,
          '📷 ย่อขนาดรูปภาพ (>2MB) และส่งสดให้ทุกคนในห้องแล้ว (กด Enter เพื่อล้าง)'
        );
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      showToast('ไม่สามารถอ่านไฟล์รูปภาพนี้ได้');
      inputLiveImage.value = '';
    };
    img.src = objUrl;
  }

  inputLiveImage.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    processImageFile(file);
  });

  // Support Ctrl+V / Paste image or GIF directly into textarea
  liveTypingInput.addEventListener('paste', (e) => {
    if (!activeRoomCode) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        e.preventDefault();
        const file = items[i].getAsFile();
        processImageFile(file);
        return;
      }
    }
  });

  // --- Discord-Style GIF / Sticker / Emote Picker Powered by KLIPY.com ---
  const KLIPY_API_BASE = 'https://api.klipy.com/api/v1/pmpZyPifwSulBfELHCbpaOllUfgsjqt9yeImc2XWIcHSWjnAUBw9oueRf4kD5r25';
  let activeKlipyType = 'gifs'; // 'gifs' or 'stickers'
  let activePickerTab = 'gifs'; // 'gifs', 'stickers', or 'emotes'
  let cachedKlipyCategories = {}; // cache per type
  let favoriteGifs = loadFavoriteGifs(); // Array<{ previewUrl, fullUrl, title }>
  let gifSearchTimer = null;

  function loadFavoriteGifs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_FAV_GIFS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed
            .map((g) => {
              if (!g || typeof g !== 'object') return null;
              const previewUrl = sanitizeChatMediaUrl(g.previewUrl);
              const fullUrl = sanitizeChatMediaUrl(g.fullUrl);
              if (!previewUrl || !fullUrl) return null;
              return {
                previewUrl,
                fullUrl,
                title: String(g.title || 'Favorite GIF').slice(0, 80)
              };
            })
            .filter(Boolean);
        }
      }
    } catch (e) {}
    return [];
  }

  function saveFavoriteGifs() {
    localStorage.setItem(STORAGE_KEY_FAV_GIFS, JSON.stringify(favoriteGifs));
  }

  function isGifFavorited(fullUrl) {
    return favoriteGifs.some((g) => g.fullUrl === fullUrl);
  }

  function toggleFavoriteGif(itemObj) {
    const idx = favoriteGifs.findIndex((g) => g.fullUrl === itemObj.fullUrl);
    if (idx !== -1) {
      favoriteGifs.splice(idx, 1);
      saveFavoriteGifs();
      showToast('ลบออกจากสิ่งที่ชอบแล้ว');
      return false;
    } else {
      favoriteGifs.unshift(itemObj);
      saveFavoriteGifs();
      showToast('⭐ เพิ่มลงในสิ่งที่ชอบแล้ว!');
      return true;
    }
  }

  function extractKlipyUrls(item) {
    const f = item && (item.file || item.files);
    if (!f) return null;

    const preview =
      (f.xs && f.xs.webp && f.xs.webp.url) ||
      (f.xs && f.xs.gif && f.xs.gif.url) ||
      (f.sm && f.sm.webp && f.sm.webp.url) ||
      (f.sm && f.sm.gif && f.sm.gif.url) ||
      (f.tinygif && f.tinygif.url) ||
      (f.gif && f.gif.url);

    const full =
      (f.sm && f.sm.gif && f.sm.gif.url) ||
      (f.md && f.md.gif && f.md.gif.url) ||
      (f.hd && f.hd.gif && f.hd.gif.url) ||
      (f.sm && f.sm.webp && f.sm.webp.url) ||
      (f.gif && f.gif.url);

    if (!preview && !full) return null;
    return { previewUrl: preview || full, fullUrl: full || preview };
  }

  // Render Discord-style 2-column Big Category Tiles ("สิ่งที่ชอบ", "GIFs ที่ได้รับความนิยม", + Klipy categories)
  async function renderDiscordCategoryTiles() {
    if (btnBackToGifCategories) btnBackToGifCategories.classList.add('hidden');
    gifResultsGrid.innerHTML = '<div class="gif-empty-status">⏳ กำลังโหลดหมวดหมู่จาก KLIPY.com...</div>';

    let categories = cachedKlipyCategories[activeKlipyType];
    if (!categories) {
      try {
        const res = await fetch(`${KLIPY_API_BASE}/${activeKlipyType}/categories?locale=en`);
        const json = await res.json();
        categories = (json && json.data && Array.isArray(json.data.categories) && json.data.categories) || [];
        cachedKlipyCategories[activeKlipyType] = categories;
      } catch (e) {
        categories = [];
      }
    }

    gifResultsGrid.innerHTML = '';

    // Tile 1: "สิ่งที่ชอบ" (Favorites)
    const favTile = document.createElement('button');
    favTile.type = 'button';
    favTile.className = 'discord-cat-tile fav-tile';
    favTile.innerHTML = `<span class="discord-cat-label">สิ่งที่ชอบ (${favoriteGifs.length})</span>`;
    favTile.addEventListener('click', () => {
      renderFavoriteGifsView();
    });
    gifResultsGrid.appendChild(favTile);

    // Tile 2: "GIFs ที่ได้รับความนิยม" (Trending)
    const trendingPreview =
      sanitizeChatMediaUrl(categories[0] && categories[0].preview_url) ||
      'https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/ec/f3/OXB1QWhn.gif';
    const trendTile = document.createElement('button');
    trendTile.type = 'button';
    trendTile.className = 'discord-cat-tile';
    trendTile.innerHTML = `
      <img src="${escapeHtml(trendingPreview)}" alt="Trending" loading="lazy" />
      <span class="discord-cat-label">📈 ${activeKlipyType === 'stickers' ? 'สติกเกอร์' : 'GIFs'} ที่ได้รับความนิยม</span>
    `;
    trendTile.addEventListener('click', () => {
      fetchGifs('trending', true);
    });
    gifResultsGrid.appendChild(trendTile);

    // Remaining Category Tiles from KLIPY
    categories.forEach((cat) => {
      const safePreview = cat && sanitizeChatMediaUrl(cat.preview_url);
      if (!safePreview) return;
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'discord-cat-tile';
      tile.innerHTML = `
        <img src="${escapeHtml(safePreview)}" alt="${escapeHtml(cat.category)}" loading="lazy" />
        <span class="discord-cat-label">${escapeHtml(cat.category)}</span>
      `;
      tile.addEventListener('click', () => {
        inputGifSearch.value = cat.query || cat.category;
        fetchGifs(cat.query || cat.category, true);
      });
      gifResultsGrid.appendChild(tile);
    });
  }

  function renderFavoriteGifsView() {
    if (btnBackToGifCategories) btnBackToGifCategories.classList.remove('hidden');
    gifResultsGrid.innerHTML = '';

    if (favoriteGifs.length === 0) {
      gifResultsGrid.innerHTML =
        '<div class="gif-empty-status">ยังไม่มีภาพใน "สิ่งที่ชอบ"<br>กดรูปดาว ⭐ มุมขวาบนของภาพ GIF ที่ชอบเพื่อบันทึกไว้ใช้ซ้ำได้เลย!</div>';
      return;
    }

    favoriteGifs.forEach((fav) => {
      appendGifResultCard(fav.previewUrl, fav.fullUrl, fav.title || 'Favorite GIF');
    });
  }

  function appendGifResultCard(previewUrl, fullUrl, title) {
    const safePreview = sanitizeChatMediaUrl(previewUrl);
    const safeFull = sanitizeChatMediaUrl(fullUrl);
    if (!safePreview || !safeFull) return;

    const wrap = document.createElement('div');
    wrap.className = 'gif-item-btn';

    const img = document.createElement('img');
    img.src = safePreview;
    img.loading = 'lazy';
    img.alt = title || 'KLIPY Media';
    wrap.appendChild(img);

    // Favorite Star Button
    const starBtn = document.createElement('button');
    starBtn.type = 'button';
    const isFav = isGifFavorited(safeFull);
    starBtn.className = `btn-fav-star ${isFav ? 'active' : ''}`;
    starBtn.textContent = '★';
    starBtn.title = 'บันทึกในสิ่งที่ชอบ';
    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nowFav = toggleFavoriteGif({ previewUrl: safePreview, fullUrl: safeFull, title });
      starBtn.classList.toggle('active', nowFav);
    });
    wrap.appendChild(starBtn);

    wrap.addEventListener('click', () => {
      setAndBroadcastLiveMedia(
        safeFull,
        `👾 ส่ง ${activeKlipyType === 'stickers' ? 'Sticker' : 'GIF'} จาก KLIPY สดแล้ว! (กด Enter เพื่อล้าง)`
      );
      gifPickerPopover.classList.add('hidden');
      liveTypingInput.focus();
    });

    gifResultsGrid.appendChild(wrap);
  }

  async function fetchGifs(query, showBackButton = true) {
    const cleanQuery = (query || '').trim();

    // If search input is cleared, show the big Discord Category Tiles!
    if (!cleanQuery && !showBackButton) {
      renderDiscordCategoryTiles();
      return;
    }

    if (btnBackToGifCategories) {
      btnBackToGifCategories.classList.remove('hidden');
    }

    gifResultsGrid.innerHTML = '<div class="gif-empty-status">⏳ กำลังดึงข้อมูลจาก KLIPY.com...</div>';

    // Direct URL support if user pastes a link
    if (/^https?:\/\/.+\.(gif|webp|png|jpg|jpeg)(\?.*)?$/i.test(cleanQuery)) {
      gifResultsGrid.innerHTML = '';
      appendGifResultCard(cleanQuery, cleanQuery, 'Direct URL');
      return;
    }

    const endpoint =
      !cleanQuery || cleanQuery === 'trending'
        ? `${KLIPY_API_BASE}/${activeKlipyType}/trending?page=1&per_page=24&locale=th`
        : `${KLIPY_API_BASE}/${activeKlipyType}/search?q=${encodeURIComponent(cleanQuery)}&page=1&per_page=24&locale=th`;

    try {
      const res = await fetch(endpoint);
      const json = await res.json();
      const items = (json && json.data && Array.isArray(json.data.data) && json.data.data) || [];

      if (items.length === 0) {
        gifResultsGrid.innerHTML = '<div class="gif-empty-status">ไม่พบภาพใน KLIPY ที่ค้นหา ลองคำอื่นดูนะครับ</div>';
        return;
      }

      gifResultsGrid.innerHTML = '';
      items.forEach((item) => {
        const urls = extractKlipyUrls(item);
        if (!urls) return;
        appendGifResultCard(urls.previewUrl, urls.fullUrl, item.title || item.slug || 'KLIPY GIF');
      });
    } catch (err) {
      gifResultsGrid.innerHTML =
        '<div class="gif-empty-status">ไม่สามารถเชื่อมต่อ KLIPY.com ได้ในขณะนี้ สามารถวางลิงก์ .gif ลงในช่องค้นหาด้านบนได้โดยตรง</div>';
    }
  }

  function initEmoteBubblePicker() {
    if (!emotePickerGrid) return;
    emotePickerGrid.innerHTML = '';
    BUBBLE_EMOTES.forEach((emote) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-emote-item';
      btn.textContent = emote;
      btn.title = `ส่งอีโมจิฟองสบู่ ${emote}`;
      btn.addEventListener('click', () => {
        triggerSendEmoteBubble(emote);
      });
      emotePickerGrid.appendChild(btn);
    });
  }
  initEmoteBubblePicker();

  function switchPickerTab(tabName) {
    activePickerTab = tabName;
    document.querySelectorAll('.btn-picker-tab').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-tab') === tabName);
    });

    if (tabName === 'emotes') {
      gifSearchRow.classList.add('hidden');
      gifResultsGrid.classList.add('hidden');
      emotePickerGrid.classList.remove('hidden');
      if (gifPoweredByText) gifPoweredByText.textContent = '🫧 กดที่อีโมจิเพื่อปล่อยลอยขึ้นจากโปรไฟล์ของคุณแบบฟองสบู่!';
    } else {
      activeKlipyType = tabName === 'stickers' ? 'stickers' : 'gifs';
      gifSearchRow.classList.remove('hidden');
      gifResultsGrid.classList.remove('hidden');
      emotePickerGrid.classList.add('hidden');
      if (gifPoweredByText) {
        gifPoweredByText.innerHTML = 'Powered by <a href="https://klipy.com" target="_blank" rel="noopener noreferrer">KLIPY.com</a>';
      }
      inputGifSearch.value = '';
      renderDiscordCategoryTiles();
    }
  }

  function openMediaPickerWithTab(tabName) {
    if (!activeRoomCode) {
      showToast('กรุณาสร้างหรือเข้าห้องแชทก่อนใช้งาน');
      return;
    }
    const isHidden = gifPickerPopover.classList.contains('hidden');
    if (isHidden || activePickerTab !== tabName) {
      gifPickerPopover.classList.remove('hidden');
      switchPickerTab(tabName);
      if (tabName !== 'emotes') {
        inputGifSearch.focus();
      }
    } else {
      gifPickerPopover.classList.add('hidden');
    }
  }

  btnToggleGifPicker.addEventListener('click', () => {
    openMediaPickerWithTab('gifs');
  });

  if (btnToggleEmotePicker) {
    btnToggleEmotePicker.addEventListener('click', () => {
      openMediaPickerWithTab('emotes');
    });
  }

  btnCloseGifPicker.addEventListener('click', () => {
    gifPickerPopover.classList.add('hidden');
  });

  if (btnBackToGifCategories) {
    btnBackToGifCategories.addEventListener('click', () => {
      inputGifSearch.value = '';
      renderDiscordCategoryTiles();
    });
  }

  inputGifSearch.addEventListener('input', () => {
    if (gifSearchTimer) clearTimeout(gifSearchTimer);
    const val = inputGifSearch.value.trim();
    if (!val) {
      renderDiscordCategoryTiles();
      return;
    }
    gifSearchTimer = setTimeout(() => {
      fetchGifs(val, true);
    }, 350);
  });

  document.querySelectorAll('.btn-picker-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab') || 'gifs';
      switchPickerTab(tab);
    });
  });

  btnRemoveInputImage.addEventListener('click', () => {
    currentImage = null;
    hideInputImagePreview();
    if (currentUser && roomMembers.has(currentUser.uid)) {
      const myMem = roomMembers.get(currentUser.uid);
      myMem.image = null;
      if (!myMem.currentText || myMem.currentText.trim().length === 0) {
        myMem.lastActiveAt = 0;
      }
      updateSingleCardContent(currentUser.uid, myMem.currentText, null);
      reorderLiveCards();
    }
    if (activeRoomCode) {
      publishJson(topicRoom(activeRoomCode), {
        type: 'typing_update',
        uid: currentUser.uid,
        username: currentUser.username,
        avatar: currentUser.avatar,
        text: liveTypingInput.value,
        image: null
      });
    }
  });

  function handleLiveInputChange() {
    if (!currentUser || !activeRoomCode) return;
    if (liveTypingInput.value.length > MAX_CHAR_LIMIT) {
      liveTypingInput.value = liveTypingInput.value.slice(0, MAX_CHAR_LIMIT);
    }
    const currentText = liveTypingInput.value;
    charCounter.textContent = `${currentText.length} / ${MAX_CHAR_LIMIT} ตัวอักษร`;
    charCounter.style.color = currentText.length >= MAX_CHAR_LIMIT ? 'var(--accent)' : 'var(--text-muted)';

    if (roomMembers.has(currentUser.uid)) {
      const myMem = roomMembers.get(currentUser.uid);
      myMem.currentText = currentText;
      if (currentText.trim().length > 0 || myMem.image) {
        myMem.lastActiveAt = Date.now();
        myMem.lastTypingAt = Date.now();
      } else {
        myMem.lastActiveAt = 0;
      }
      updateSingleCardContent(currentUser.uid, currentText, myMem.image);
      reorderLiveCards();
    }

    publishJson(topicRoom(activeRoomCode), {
      type: 'typing_update',
      uid: currentUser.uid,
      username: currentUser.username,
      avatar: currentUser.avatar,
      text: currentText,
      image: currentImage
    });
  }

  function triggerEnterClear() {
    if (!currentUser || !activeRoomCode) return;
    if (!canExecuteAction('enter_clear', false)) return;
    liveTypingInput.value = '';
    charCounter.textContent = `0 / 250 ตัวอักษร`;
    hideInputImagePreview();

    if (roomMembers.has(currentUser.uid)) {
      const myMem = roomMembers.get(currentUser.uid);
      myMem.currentText = '';
      myMem.image = null;
      myMem.lastActiveAt = 0;
      myMem.lastEmoteAt = 0;
      updateSingleCardContent(currentUser.uid, '', null);
      flashClearCard(currentUser.uid);
      reorderLiveCards();
    }

    publishJson(topicRoom(activeRoomCode), {
      type: 'typing_clear',
      uid: currentUser.uid
    });
    liveTypingInput.focus();
  }

  liveTypingInput.addEventListener('input', () => {
    if (liveTypingInput.value.includes('\n')) {
      triggerEnterClear();
      return;
    }
    handleLiveInputChange();
  });

  liveTypingInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      triggerEnterClear();
    }
  });

  btnClearEnter.addEventListener('click', () => {
    triggerEnterClear();
  });

  // --- Invitation Modal Buttons ---
  btnAcceptInvite.addEventListener('click', () => {
    inviteModal.classList.add('hidden');
    if (pendingInviteRoomCode) {
      joinRoomByCode(pendingInviteRoomCode);
      pendingInviteRoomCode = null;
    }
  });

  btnDeclineInvite.addEventListener('click', () => {
    inviteModal.classList.add('hidden');
    pendingInviteRoomCode = null;
  });

  // --- PWA Service Worker & Install Prompt ---
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    btnInstallPwa.classList.remove('hidden');
  });

  btnInstallPwa.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    btnInstallPwa.classList.add('hidden');
  });

  // --- Initial Boot ---
  if (currentUser) {
    showWorkspaceView();
  } else {
    showSetupView();
  }

  // --- Theme Customizer Engine ---
  let cachedBgDataUrl = null;

  function loadCustomTheme() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_THEME);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          ...DEFAULT_THEME,
          ...parsed,
          chatCard: parsed.chatCard || parsed.card || DEFAULT_THEME.chatCard,
          chatText: parsed.chatText || parsed.text || DEFAULT_THEME.chatText,
          selfChatText: parsed.selfChatText || parsed.chatText || parsed.text || DEFAULT_THEME.selfChatText,
          bgDim: parsed.bgDim !== undefined ? parsed.bgDim : DEFAULT_THEME.bgDim,
          bgBlur: parsed.bgBlur !== undefined ? parsed.bgBlur : DEFAULT_THEME.bgBlur,
          hasCustomBg: !!parsed.hasCustomBg
        };
      }
    } catch (e) {}
    return { ...DEFAULT_THEME };
  }

  function hexToRgbObj(hex) {
    let c = (hex || '#000000').replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16) || 0;
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255
    };
  }

  function hexToRgba(hex, alpha) {
    const { r, g, b } = hexToRgbObj(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function mixHex(hex1, hex2, weight = 0.5) {
    const c1 = hexToRgbObj(hex1);
    const c2 = hexToRgbObj(hex2);
    const r = Math.round(c1.r * (1 - weight) + c2.r * weight);
    const g = Math.round(c1.g * (1 - weight) + c2.g * weight);
    const b = Math.round(c1.b * (1 - weight) + c2.b * weight);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  }

  function isLightColor(hex) {
    const { r, g, b } = hexToRgbObj(hex);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6;
  }

  function setBgImageUI(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(dataUrl.trim())) {
      clearBgImageUI();
      return;
    }
    const safeBg = dataUrl.trim();
    if (appCustomBg) {
      appCustomBg.style.backgroundImage = `url("${safeBg}")`;
    }
    document.body.classList.add('has-custom-bg');
    if (customBgThumb) {
      customBgThumb.style.backgroundImage = `url("${safeBg}")`;
      customBgThumb.classList.add('has-image');
    }
    if (customBgThumbText) customBgThumbText.classList.add('hidden');
    if (btnRemoveCustomBg) btnRemoveCustomBg.classList.remove('hidden');
    if (customBgControls) customBgControls.classList.remove('hidden');
  }

  function clearBgImageUI() {
    if (appCustomBg) {
      appCustomBg.style.backgroundImage = '';
    }
    document.body.classList.remove('has-custom-bg');
    if (customBgThumb) {
      customBgThumb.style.backgroundImage = '';
      customBgThumb.classList.remove('has-image');
    }
    if (customBgThumbText) customBgThumbText.classList.remove('hidden');
    if (btnRemoveCustomBg) btnRemoveCustomBg.classList.add('hidden');
    if (customBgControls) customBgControls.classList.add('hidden');
  }

  function applyTheme(rawTheme) {
    const theme = { ...DEFAULT_THEME, ...rawTheme };
    const root = document.documentElement;
    const brightness = theme.brightness !== undefined ? theme.brightness : 100;
    const opacity = theme.opacity !== undefined ? theme.opacity : 88;
    const chatFontSize = theme.chatFontSize !== undefined ? theme.chatFontSize : 20;
    const alphaRatio = Math.max(0, Math.min(100, opacity)) / 100;
    const panelAlpha = alphaRatio;
    const cardAlpha = alphaRatio;
    const panelBlur = Math.round(16 * Math.min(1, alphaRatio * 1.5));
    const isLight = isLightColor(theme.bg);

    // Primary & Accent
    const primaryHover = isLight ? mixHex(theme.primary, '#000000', 0.15) : mixHex(theme.primary, '#ffffff', 0.15);
    const primaryText = isLight ? mixHex(theme.primary, '#000000', 0.2) : mixHex(theme.primary, '#ffffff', 0.38);

    root.style.setProperty('--primary', theme.primary);
    root.style.setProperty('--primary-hover', primaryHover);
    root.style.setProperty('--primary-glow', hexToRgba(theme.primary, 0.35));
    root.style.setProperty('--primary-soft', hexToRgba(theme.primary, 0.16));
    root.style.setProperty('--primary-border', hexToRgba(theme.primary, 0.45));
    root.style.setProperty('--primary-text', primaryText);

    root.style.setProperty('--accent', theme.accent);
    root.style.setProperty('--accent-glow', hexToRgba(theme.accent, 0.35));
    root.style.setProperty('--accent-soft', hexToRgba(theme.accent, 0.16));
    root.style.setProperty('--accent-border', hexToRgba(theme.accent, 0.45));

    // Backgrounds & Cards
    root.style.setProperty('--bg-dark', theme.bg);
    root.style.setProperty('--bg-topbar', hexToRgba(theme.card, panelAlpha));
    root.style.setProperty('--bg-panel', hexToRgba(theme.card, panelAlpha));
    root.style.setProperty('--bg-subpanel', hexToRgba(theme.chatCard, Math.max(0, cardAlpha * 0.75)));
    root.style.setProperty('--bg-card', hexToRgba(theme.chatCard, cardAlpha));
    root.style.setProperty('--bg-card-idle', hexToRgba(theme.chatCard, Math.max(0, cardAlpha * 0.5)));
    root.style.setProperty('--bg-card-self', hexToRgba(theme.primary, Math.max(0, (isLight ? 0.12 : 0.16) * (alphaRatio > 0 ? Math.max(0.4, alphaRatio) : 0))));
    root.style.setProperty('--bg-input', hexToRgba(theme.chatCard, cardAlpha));
    root.style.setProperty('--panel-blur', `${panelBlur}px`);

    // Subtle surfaces & borders
    root.style.setProperty('--surface-subtle', isLight ? 'rgba(15, 23, 42, 0.06)' : 'rgba(255, 255, 255, 0.06)');
    root.style.setProperty('--surface-hover', isLight ? 'rgba(15, 23, 42, 0.12)' : 'rgba(255, 255, 255, 0.12)');
    root.style.setProperty('--border-subtle', hexToRgba(theme.border, 0.48));
    root.style.setProperty('--border-active', hexToRgba(theme.primary, 0.6));

    // Typography & Chat Colors
    root.style.setProperty('--text-main', theme.text);
    root.style.setProperty('--text-muted', theme.mutedText);
    root.style.setProperty('--chat-text', theme.chatText);
    root.style.setProperty('--chat-text-self', theme.selfChatText);
    root.style.setProperty('--chat-font-size', `${chatFontSize}px`);

    // Corner Radius & Brightness
    root.style.setProperty('--radius-lg', `${theme.radius + 4}px`);
    root.style.setProperty('--radius-md', `${theme.radius}px`);
    root.style.setProperty('--radius-sm', `${Math.max(0, theme.radius - 4)}px`);
    root.style.setProperty('--ui-brightness', `${brightness}%`);

    // Custom Background overlay controls
    const bgDim = theme.bgDim !== undefined ? theme.bgDim : 30;
    const bgBlur = theme.bgBlur !== undefined ? theme.bgBlur : 0;
    root.style.setProperty('--bg-overlay-dim', (bgDim / 100).toString());
    root.style.setProperty('--bg-overlay-blur', `${bgBlur}px`);

    // Update browser theme-color meta tag
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', theme.bg);
    }

    // Sync input controls
    if (colorPickerPrimary) {
      colorPickerPrimary.value = theme.primary;
      if (hexPrimary) hexPrimary.textContent = theme.primary;
      colorPickerAccent.value = theme.accent;
      if (hexAccent) hexAccent.textContent = theme.accent;
      colorPickerBg.value = theme.bg;
      if (hexBg) hexBg.textContent = theme.bg;
      colorPickerCard.value = theme.card;
      if (hexCard) hexCard.textContent = theme.card;
      if (colorPickerChatCard) colorPickerChatCard.value = theme.chatCard;
      if (hexChatCard) hexChatCard.textContent = theme.chatCard;
      if (colorPickerBorder) colorPickerBorder.value = theme.border;
      if (hexBorder) hexBorder.textContent = theme.border;
      colorPickerText.value = theme.text;
      if (hexText) hexText.textContent = theme.text;
      if (colorPickerMutedText) colorPickerMutedText.value = theme.mutedText;
      if (hexMutedText) hexMutedText.textContent = theme.mutedText;
      if (colorPickerChatText) colorPickerChatText.value = theme.chatText;
      if (hexChatText) hexChatText.textContent = theme.chatText;
      if (colorPickerSelfChatText) colorPickerSelfChatText.value = theme.selfChatText;
      if (hexSelfChatText) hexSelfChatText.textContent = theme.selfChatText;

      if (rangeChatFontSize) rangeChatFontSize.value = chatFontSize;
      if (chatFontSizeValText) chatFontSizeValText.textContent = `${chatFontSize}px`;
      rangeRadius.value = theme.radius;
      if (radiusValText) radiusValText.textContent = `${theme.radius}px`;
      if (rangeOpacity) rangeOpacity.value = opacity;
      if (opacityValText) opacityValText.textContent = `${opacity}%`;
      if (rangeBrightness) rangeBrightness.value = brightness;
      if (brightnessValText) brightnessValText.textContent = `${brightness}%`;

      if (rangeBgDim) rangeBgDim.value = bgDim;
      if (bgDimValText) bgDimValText.textContent = `${bgDim}%`;
      if (rangeBgBlur) rangeBgBlur.value = bgBlur;
      if (bgBlurValText) bgBlurValText.textContent = `${bgBlur}px`;
    }

    // Apply or remove custom wallpaper
    if (theme.hasCustomBg) {
      if (cachedBgDataUrl) {
        setBgImageUI(cachedBgDataUrl);
      } else {
        loadCustomBgAsset().then((dataUrl) => {
          if (dataUrl && activeTheme.hasCustomBg) {
            cachedBgDataUrl = dataUrl;
            setBgImageUI(dataUrl);
          } else {
            clearBgImageUI();
          }
        });
      }
    } else {
      clearBgImageUI();
    }

    localStorage.setItem(STORAGE_KEY_THEME, JSON.stringify(theme));
  }

  let activeTheme = loadCustomTheme();
  applyTheme(activeTheme);

  btnOpenTheme.addEventListener('click', () => {
    themeModal.classList.remove('hidden');
  });

  btnCloseTheme.addEventListener('click', () => {
    themeModal.classList.add('hidden');
    showToast('บันทึกการตั้งค่าธีมสีเรียบร้อยแล้ว');
  });

  btnResetTheme.addEventListener('click', () => {
    const keepBg = activeTheme.hasCustomBg;
    const keepDim = activeTheme.bgDim;
    const keepBlur = activeTheme.bgBlur;
    activeTheme = {
      ...DEFAULT_THEME,
      hasCustomBg: keepBg,
      bgDim: keepDim !== undefined ? keepDim : DEFAULT_THEME.bgDim,
      bgBlur: keepBlur !== undefined ? keepBlur : DEFAULT_THEME.bgBlur
    };
    document.querySelectorAll('.btn-preset-theme').forEach(b => b.classList.remove('active'));
    applyTheme(activeTheme);
    showToast('รีเซ็ตธีมกลับเป็นค่าเริ่มต้นแล้ว');
  });

  // Color picker & slider events
  const bindThemeInput = (el, key, isInt = false) => {
    if (!el) return;
    el.addEventListener('input', (e) => {
      activeTheme[key] = isInt ? parseInt(e.target.value, 10) : e.target.value;
      applyTheme(activeTheme);
    });
  };

  bindThemeInput(colorPickerPrimary, 'primary');
  bindThemeInput(colorPickerAccent, 'accent');
  bindThemeInput(colorPickerBg, 'bg');
  bindThemeInput(colorPickerCard, 'card');
  bindThemeInput(colorPickerChatCard, 'chatCard');
  bindThemeInput(colorPickerBorder, 'border');
  bindThemeInput(colorPickerText, 'text');
  bindThemeInput(colorPickerMutedText, 'mutedText');
  bindThemeInput(colorPickerChatText, 'chatText');
  bindThemeInput(colorPickerSelfChatText, 'selfChatText');
  bindThemeInput(rangeChatFontSize, 'chatFontSize', true);
  bindThemeInput(rangeRadius, 'radius', true);
  bindThemeInput(rangeOpacity, 'opacity', true);
  bindThemeInput(rangeBrightness, 'brightness', true);
  bindThemeInput(rangeBgDim, 'bgDim', true);
  bindThemeInput(rangeBgBlur, 'bgBlur', true);

  if (btnRemoveCustomBg) {
    btnRemoveCustomBg.addEventListener('click', async () => {
      cachedBgDataUrl = null;
      await deleteCustomBgAsset();
      activeTheme.hasCustomBg = false;
      applyTheme(activeTheme);
      showToast('ลบภาพพื้นหลังแล้ว กลับไปใช้สีจากธีม');
    });
  }

  // Preset theme buttons
  document.querySelectorAll('.btn-preset-theme').forEach((btn) => {
    btn.addEventListener('click', () => {
      const themeKey = btn.getAttribute('data-theme');
      if (PRESET_THEMES[themeKey]) {
        document.querySelectorAll('.btn-preset-theme').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const keepBg = activeTheme.hasCustomBg;
        const keepDim = activeTheme.bgDim;
        const keepBlur = activeTheme.bgBlur;
        activeTheme = {
          ...PRESET_THEMES[themeKey],
          hasCustomBg: keepBg,
          bgDim: keepDim !== undefined ? keepDim : 30,
          bgBlur: keepBlur !== undefined ? keepBlur : 0
        };
        applyTheme(activeTheme);
        showToast(`สลับไปใช้ธีม ${btn.textContent.trim()} แล้ว`);
      }
    });
  });

  // =========================================================================
  // --- Background Wallpaper Cropper Engine (Touch & Mouse Interactive) ---
  // =========================================================================
  let cropperImage = null;
  let cropperBox = { x: 0, y: 0, w: 100, h: 100 };
  let cropperAspect = 16 / 9; // default 16:9 aspect ratio
  let cropperActiveHandle = null;
  let cropperIsDragging = false;
  let cropperDragStart = { x: 0, y: 0 };
  let cropperStartBox = { x: 0, y: 0, w: 0, h: 0 };

  if (inputCustomBg) {
    inputCustomBg.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const secCheck = await validateImageFileSecurity(file, { allowGif: true });
      if (!secCheck.ok) {
        showToast(secCheck.reason, 6000);
        showSecurityAlertModal(file, secCheck.threatDetails, (cleanImg) => {
          initBgCropper(cleanImg);
        });
        inputCustomBg.value = '';
        return;
      }

      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          if (img.naturalWidth > MAX_IMAGE_DIMENSION || img.naturalHeight > MAX_IMAGE_DIMENSION) {
            showToast('🚫 ความละเอียดภาพพื้นหลังสูงเกินพิกัดความปลอดภัย (สูงสุด 8192x8192 px)');
            inputCustomBg.value = '';
            return;
          }
          initBgCropper(img);
        };
        img.onerror = () => {
          showToast('🚫 ไม่สามารถถอดรหัสไฟล์รูปภาพนี้ได้');
          inputCustomBg.value = '';
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function initBgCropper(img) {
    cropperImage = img;
    bgCropModal.classList.remove('hidden');

    requestAnimationFrame(() => {
      const viewport = cropCanvasViewport;
      const maxW = viewport ? Math.max(260, Math.min(600, (viewport.clientWidth || 560) - 16)) : 540;
      const maxH = viewport ? Math.max(200, Math.min(360, (viewport.clientHeight || 340) - 16)) : 340;

      const natW = img.naturalWidth || 800;
      const natH = img.naturalHeight || 600;

      const scale = Math.min(maxW / natW, maxH / natH, 1);
      const cw = Math.max(160, Math.round(natW * scale));
      const ch = Math.max(120, Math.round(natH * scale));

      cropCanvas.width = cw;
      cropCanvas.height = ch;
      cropCanvas.style.width = `${cw}px`;
      cropCanvas.style.height = `${ch}px`;

      cropperAspect = 16 / 9;
      document.querySelectorAll('.btn-crop-aspect').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-aspect') === '16:9');
      });

      setAspectBox(cropperAspect);
      renderCropper();
    });
  }

  function setAspectBox(aspect) {
    const cw = cropCanvas.width;
    const ch = cropCanvas.height;
    if (!aspect) {
      cropperBox = {
        x: Math.round(cw * 0.05),
        y: Math.round(ch * 0.05),
        w: Math.round(cw * 0.9),
        h: Math.round(ch * 0.9)
      };
      return;
    }
    let w, h;
    if (cw / ch > aspect) {
      h = Math.round(ch * 0.88);
      w = Math.round(h * aspect);
    } else {
      w = Math.round(cw * 0.88);
      h = Math.round(w / aspect);
    }
    cropperBox = {
      x: Math.round((cw - w) / 2),
      y: Math.round((ch - h) / 2),
      w: Math.max(30, Math.min(cw, w)),
      h: Math.max(30, Math.min(ch, h))
    };
  }

  function renderCropper() {
    if (!cropperImage || !cropCanvas) return;
    const ctx = cropCanvas.getContext('2d');
    const cw = cropCanvas.width;
    const ch = cropCanvas.height;
    const b = cropperBox;

    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(cropperImage, 0, 0, cw, ch);

    // Darkened overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
    ctx.fillRect(0, 0, cw, ch);

    // Cutout preview
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.clip();
    ctx.drawImage(cropperImage, 0, 0, cw, ch);

    // Rule-of-thirds grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(b.x + b.w / 3, b.y);
    ctx.lineTo(b.x + b.w / 3, b.y + b.h);
    ctx.moveTo(b.x + (2 * b.w) / 3, b.y);
    ctx.lineTo(b.x + (2 * b.w) / 3, b.y + b.h);
    ctx.moveTo(b.x, b.y + b.h / 3);
    ctx.lineTo(b.x + b.w, b.y + b.h / 3);
    ctx.moveTo(b.x, b.y + (2 * b.h) / 3);
    ctx.lineTo(b.x + b.w, b.y + (2 * b.h) / 3);
    ctx.stroke();
    ctx.restore();

    // Box outline
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x, b.y, b.w, b.h);

    // Draw handles
    const drawDot = (hx, hy) => {
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(hx, hy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    // Corners
    drawDot(b.x, b.y);
    drawDot(b.x + b.w, b.y);
    drawDot(b.x + b.w, b.y + b.h);
    drawDot(b.x, b.y + b.h);

    // Edges
    drawDot(b.x + b.w / 2, b.y);
    drawDot(b.x + b.w / 2, b.y + b.h);
    drawDot(b.x, b.y + b.h / 2);
    drawDot(b.x + b.w, b.y + b.h / 2);

    // Update dimensions display
    if (cropSizeInfo) {
      const origW = Math.round(b.w * (cropperImage.naturalWidth / cw));
      const origH = Math.round(b.h * (cropperImage.naturalHeight / ch));
      cropSizeInfo.textContent = `ขนาด: ${origW} × ${origH} px`;
    }
  }

  function getCanvasPos(e) {
    const rect = cropCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (cropCanvas.width / rect.width),
      y: (clientY - rect.top) * (cropCanvas.height / rect.height)
    };
  }

  function getHitHandle(mx, my) {
    const R = 18;
    const b = cropperBox;
    if (Math.hypot(mx - b.x, my - b.y) <= R) return 'nw';
    if (Math.hypot(mx - (b.x + b.w), my - b.y) <= R) return 'ne';
    if (Math.hypot(mx - (b.x + b.w), my - (b.y + b.h)) <= R) return 'se';
    if (Math.hypot(mx - b.x, my - (b.y + b.h)) <= R) return 'sw';
    if (Math.hypot(mx - (b.x + b.w / 2), my - b.y) <= R) return 'n';
    if (Math.hypot(mx - (b.x + b.w / 2), my - (b.y + b.h)) <= R) return 's';
    if (Math.hypot(mx - b.x, my - (b.y + b.h / 2)) <= R) return 'w';
    if (Math.hypot(mx - (b.x + b.w), my - (b.y + b.h / 2)) <= R) return 'e';
    if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return 'move';
    return null;
  }

  function onCropPointerDown(e) {
    if (!cropperImage || bgCropModal.classList.contains('hidden')) return;
    const pos = getCanvasPos(e);
    const hit = getHitHandle(pos.x, pos.y);
    if (!hit) return;
    cropperIsDragging = true;
    cropperActiveHandle = hit;
    cropperDragStart = { x: pos.x, y: pos.y };
    cropperStartBox = { ...cropperBox };
    if (e.cancelable && e.type.startsWith('touch')) {
      e.preventDefault();
    }
  }

  function onCropPointerMove(e) {
    if (!cropperImage || bgCropModal.classList.contains('hidden')) return;
    const pos = getCanvasPos(e);

    if (!cropperIsDragging) {
      const hit = getHitHandle(pos.x, pos.y);
      if (hit === 'nw' || hit === 'se') cropCanvas.style.cursor = 'nwse-resize';
      else if (hit === 'ne' || hit === 'sw') cropCanvas.style.cursor = 'nesw-resize';
      else if (hit === 'n' || hit === 's') cropCanvas.style.cursor = 'ns-resize';
      else if (hit === 'w' || hit === 'e') cropCanvas.style.cursor = 'ew-resize';
      else if (hit === 'move') cropCanvas.style.cursor = 'move';
      else cropCanvas.style.cursor = 'crosshair';
      return;
    }

    if (e.cancelable && e.type.startsWith('touch')) {
      e.preventDefault();
    }

    const dx = pos.x - cropperDragStart.x;
    const dy = pos.y - cropperDragStart.y;
    const cw = cropCanvas.width;
    const ch = cropCanvas.height;
    const sb = cropperStartBox;
    const minS = 30;

    if (cropperActiveHandle === 'move') {
      const nx = Math.max(0, Math.min(cw - sb.w, sb.x + dx));
      const ny = Math.max(0, Math.min(ch - sb.h, sb.y + dy));
      cropperBox.x = nx;
      cropperBox.y = ny;
    } else {
      let nx = sb.x;
      let ny = sb.y;
      let nw = sb.w;
      let nh = sb.h;

      if (cropperActiveHandle === 'se') {
        nw = Math.max(minS, Math.min(cw - sb.x, sb.w + dx));
        nh = cropperAspect ? nw / cropperAspect : Math.max(minS, Math.min(ch - sb.y, sb.h + dy));
        if (cropperAspect && sb.y + nh > ch) {
          nh = ch - sb.y;
          nw = nh * cropperAspect;
        }
      } else if (cropperActiveHandle === 'sw') {
        nw = Math.max(minS, sb.w - dx);
        nh = cropperAspect ? nw / cropperAspect : Math.max(minS, Math.min(ch - sb.y, sb.h + dy));
        if (cropperAspect && sb.y + nh > ch) {
          nh = ch - sb.y;
          nw = nh * cropperAspect;
        }
        nx = sb.x + (sb.w - nw);
        if (nx < 0) {
          nx = 0;
          nw = sb.x + sb.w;
          if (cropperAspect) nh = nw / cropperAspect;
        }
      } else if (cropperActiveHandle === 'ne') {
        nw = Math.max(minS, Math.min(cw - sb.x, sb.w + dx));
        nh = cropperAspect ? nw / cropperAspect : Math.max(minS, sb.h - dy);
        ny = sb.y + (sb.h - nh);
        if (ny < 0) {
          ny = 0;
          nh = sb.y + sb.h;
          if (cropperAspect) nw = nh * cropperAspect;
        }
      } else if (cropperActiveHandle === 'nw') {
        nw = Math.max(minS, sb.w - dx);
        nh = cropperAspect ? nw / cropperAspect : Math.max(minS, sb.h - dy);
        nx = sb.x + (sb.w - nw);
        ny = sb.y + (sb.h - nh);
        if (nx < 0) {
          nx = 0;
          nw = sb.x + sb.w;
          if (cropperAspect) nh = nw / cropperAspect;
          ny = sb.y + (sb.h - nh);
        }
        if (ny < 0) {
          ny = 0;
          nh = sb.y + sb.h;
          if (cropperAspect) nw = nh * cropperAspect;
          nx = sb.x + (sb.w - nw);
        }
      } else if (cropperActiveHandle === 'e') {
        nw = Math.max(minS, Math.min(cw - sb.x, sb.w + dx));
        if (cropperAspect) nh = nw / cropperAspect;
      } else if (cropperActiveHandle === 'w') {
        nw = Math.max(minS, sb.w - dx);
        nx = sb.x + (sb.w - nw);
        if (nx < 0) { nx = 0; nw = sb.x + sb.w; }
        if (cropperAspect) nh = nw / cropperAspect;
      } else if (cropperActiveHandle === 's') {
        nh = Math.max(minS, Math.min(ch - sb.y, sb.h + dy));
        if (cropperAspect) nw = nh * cropperAspect;
      } else if (cropperActiveHandle === 'n') {
        nh = Math.max(minS, sb.h - dy);
        ny = sb.y + (sb.h - nh);
        if (ny < 0) { ny = 0; nh = sb.y + sb.h; }
        if (cropperAspect) nw = nh * cropperAspect;
      }

      cropperBox = {
        x: Math.round(nx),
        y: Math.round(ny),
        w: Math.round(nw),
        h: Math.round(nh)
      };
    }

    renderCropper();
  }

  function onCropPointerUp() {
    cropperIsDragging = false;
    cropperActiveHandle = null;
  }

  if (cropCanvas) {
    cropCanvas.addEventListener('mousedown', onCropPointerDown);
    window.addEventListener('mousemove', onCropPointerMove);
    window.addEventListener('mouseup', onCropPointerUp);

    cropCanvas.addEventListener('touchstart', onCropPointerDown, { passive: false });
    window.addEventListener('touchmove', onCropPointerMove, { passive: false });
    window.addEventListener('touchend', onCropPointerUp);
    window.addEventListener('touchcancel', onCropPointerUp);
  }

  // Aspect Ratio Preset buttons
  document.querySelectorAll('.btn-crop-aspect').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-crop-aspect').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const asp = btn.getAttribute('data-aspect');
      if (asp === '16:9') cropperAspect = 16 / 9;
      else if (asp === '9:16') cropperAspect = 9 / 16;
      else if (asp === '4:3') cropperAspect = 4 / 3;
      else if (asp === '1:1') cropperAspect = 1;
      else if (asp === 'free') cropperAspect = null;
      else if (asp === 'full') {
        cropperAspect = null;
        cropperBox = { x: 0, y: 0, w: cropCanvas.width, h: cropCanvas.height };
        renderCropper();
        return;
      }
      setAspectBox(cropperAspect);
      renderCropper();
    });
  });

  if (btnCancelCrop) {
    btnCancelCrop.addEventListener('click', () => {
      bgCropModal.classList.add('hidden');
      if (inputCustomBg) inputCustomBg.value = '';
    });
  }

  if (btnApplyCrop) {
    btnApplyCrop.addEventListener('click', async () => {
      if (!cropperImage || !cropCanvas) return;
      const cw = cropCanvas.width;
      const ch = cropCanvas.height;
      const natW = cropperImage.naturalWidth;
      const natH = cropperImage.naturalHeight;

      const scaleX = natW / cw;
      const scaleY = natH / ch;

      const sx = Math.max(0, Math.round(cropperBox.x * scaleX));
      const sy = Math.max(0, Math.round(cropperBox.y * scaleY));
      const sw = Math.min(natW - sx, Math.round(cropperBox.w * scaleX));
      const sh = Math.min(natH - sy, Math.round(cropperBox.h * scaleY));

      if (sw <= 0 || sh <= 0) return;

      // Constrain max dimensions to 1920x1080 for crispness and performance
      const maxDim = 1920;
      let outW = sw;
      let outH = sh;
      if (outW > maxDim || outH > maxDim) {
        if (outW > outH) {
          outH = Math.round((outH * maxDim) / outW);
          outW = maxDim;
        } else {
          outW = Math.round((outW * maxDim) / outH);
          outH = maxDim;
        }
      }

      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = outW;
      exportCanvas.height = outH;
      const exportCtx = exportCanvas.getContext('2d');
      exportCtx.drawImage(cropperImage, sx, sy, sw, sh, 0, 0, outW, outH);

      const croppedDataUrl = exportCanvas.toDataURL('image/jpeg', 0.85);

      cachedBgDataUrl = croppedDataUrl;
      await saveCustomBgAsset(croppedDataUrl);

      activeTheme.hasCustomBg = true;
      applyTheme(activeTheme);

      bgCropModal.classList.add('hidden');
      if (inputCustomBg) inputCustomBg.value = '';
      showToast('เปลี่ยนภาพพื้นหลังเว็บไซต์เรียบร้อยแล้ว 🖼️');
    });
  }

  // =========================================================================
  // --- WebRTC Realtime Screen Live Streaming Engine ---
  // =========================================================================

  // --- Live Stream Audio Volume & 0-200% Booster Engine ---
  function updateVolumeUI(volumePercent) {
    if (rangeStreamVolume) {
      rangeStreamVolume.value = volumePercent;
    }
    if (streamVolumeText) {
      streamVolumeText.textContent = `${volumePercent}%`;
      streamVolumeText.classList.toggle('boosted', volumePercent > 100);
      if (volumePercent > 100) {
        streamVolumeText.title = `บูสเสียงขยายพิเศษ: ${volumePercent}% (ปกติ 100%)`;
      } else {
        streamVolumeText.title = `ระดับเสียงปัจจุบัน: ${volumePercent}%`;
      }
    }
    if (btnStreamVolume) {
      if (volumePercent === 0) {
        btnStreamVolume.textContent = '🔇';
        btnStreamVolume.title = 'เปิดเสียง';
      } else if (volumePercent > 100) {
        btnStreamVolume.textContent = '🔊';
        btnStreamVolume.title = `เสียงบูสพิเศษ ${volumePercent}% (คลิกเพื่อปิดเสียง)`;
      } else if (volumePercent < 50) {
        btnStreamVolume.textContent = '🔉';
        btnStreamVolume.title = `ระดับเสียง ${volumePercent}% (คลิกเพื่อปิดเสียง)`;
      } else {
        btnStreamVolume.textContent = '🔊';
        btnStreamVolume.title = `ระดับเสียง ${volumePercent}% (คลิกเพื่อปิดเสียง)`;
      }
    }
  }

  function applyVolumeToGain(volumePercent) {
    const gainFactor = Math.max(0, Math.min(200, volumePercent)) / 100;
    if (streamGainNode && streamAudioCtx) {
      try {
        streamGainNode.gain.setValueAtTime(gainFactor, streamAudioCtx.currentTime || 0);
      } catch (e) {
        streamGainNode.gain.value = gainFactor;
      }
    }
    updateVolumeUI(volumePercent);
  }

  function setStreamVolume(percent, showToastNotice = false) {
    currentStreamVolume = Math.max(0, Math.min(200, percent));
    if (currentStreamVolume > 0) {
      previousNonZeroVolume = currentStreamVolume;
    }
    try {
      localStorage.setItem(STORAGE_KEY_STREAM_VOLUME, String(currentStreamVolume));
    } catch (e) {}

    if (streamAudioCtx && streamAudioCtx.state === 'suspended') {
      streamAudioCtx.resume().catch(() => {});
    }

    applyVolumeToGain(currentStreamVolume);

    if (showToastNotice) {
      if (currentStreamVolume === 0) {
        showToast('🔇 ปิดเสียงไลฟ์สดแล้ว');
      } else if (currentStreamVolume > 100) {
        showToast(`🚀 บูสระดับเสียงไลฟ์เป็น ${currentStreamVolume}% แล้ว (บันทึกแคชแล้ว)`);
      } else {
        showToast(`🔊 ระดับเสียงไลฟ์: ${currentStreamVolume}% (บันทึกแคชแล้ว)`);
      }
    }
  }

  function attachStreamAudio(stream) {
    if (!stream) return;
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    try {
      if (!streamAudioCtx) {
        const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
        if (AudioCtxClass) {
          streamAudioCtx = new AudioCtxClass();
        }
      }

      if (streamAudioCtx) {
        if (streamAudioCtx.state === 'suspended') {
          streamAudioCtx.resume().catch(() => {});
        }

        if (!streamGainNode) {
          streamGainNode = streamAudioCtx.createGain();
          streamGainNode.connect(streamAudioCtx.destination);
        }

        if (streamAudioSourceNode) {
          try { streamAudioSourceNode.disconnect(); } catch (e) {}
          streamAudioSourceNode = null;
        }

        const audioStream = new MediaStream(audioTracks);
        streamAudioSourceNode = streamAudioCtx.createMediaStreamSource(audioStream);
        streamAudioSourceNode.connect(streamGainNode);

        // Mute video element to prevent duplicate unboosted audio
        if (liveStreamVideo) {
          liveStreamVideo.muted = true;
        }

        // Apply cached volume immediately
        applyVolumeToGain(currentStreamVolume);
      }
    } catch (err) {
      console.warn('Web Audio gain node setup failed, falling back to video element volume:', err);
      if (liveStreamVideo) {
        liveStreamVideo.muted = currentStreamVolume === 0;
        liveStreamVideo.volume = Math.min(1, currentStreamVolume / 100);
      }
    }
  }

  function detachStreamAudio() {
    if (streamAudioSourceNode) {
      try { streamAudioSourceNode.disconnect(); } catch (e) {}
      streamAudioSourceNode = null;
    }
  }

  // Quality and Bitrate Estimator for Crisp & Smooth 60 FPS WebRTC
  function getBitrateBps(resolution, fps) {
    const targetFps = parseInt(fps, 10) || 60;
    if (resolution === '1080p') {
      return targetFps >= 60 ? 6000000 : 4000000; // 6 Mbps @ 60fps / 4 Mbps @ 30fps
    } else if (resolution === '720p') {
      return targetFps >= 60 ? 3500000 : 2200000; // 3.5 Mbps @ 60fps / 2.2 Mbps @ 30fps
    } else if (resolution === '480p') {
      return 1500000; // 1.5 Mbps
    } else if (resolution === '360p') {
      return 800000; // 800 kbps
    }
    // 'original'
    return targetFps >= 60 ? 6500000 : 4500000; // 6.5 Mbps @ 60fps / 4.5 Mbps @ 30fps
  }

  function getBitrateKbps(resolution, fps) {
    return Math.round(getBitrateBps(resolution, fps) / 1000);
  }

  // SDP Munging: Unlock WebRTC bandwidth ceiling for 1080p/720p 60fps streaming
  function setSDPBitrate(sdp, bitrateKbps = 5000) {
    if (!sdp) return sdp;
    const bitrateBps = bitrateKbps * 1000;
    let sdpCleaned = sdp.replace(/b=(AS|TIAS):[0-9]+\r\n/g, '');
    if (/m=video[^\r\n]*\r\n(?:[^\r\n]*\r\n)*?c=IN/.test(sdpCleaned)) {
      return sdpCleaned.replace(
        /(m=video[^\r\n]*\r\n(?:[^\r\n]*\r\n)*?c=IN[^\r\n]*\r\n)/,
        `$1b=AS:${bitrateKbps}\r\nb=TIAS:${bitrateBps}\r\n`
      );
    }
    return sdpCleaned.replace(
      /(m=video[^\r\n]*\r\n)/,
      `$1b=AS:${bitrateKbps}\r\nb=TIAS:${bitrateBps}\r\n`
    );
  }

  // Codec Preference: Prioritize H.264 (packetization-mode=1) & VP8 for stable 60 FPS
  function preferH264Codec(pc) {
    if (!pc || !pc.getTransceivers || !window.RTCRtpSender || !RTCRtpSender.getCapabilities) return;
    try {
      const videoCapabilities = RTCRtpSender.getCapabilities('video');
      if (!videoCapabilities || !videoCapabilities.codecs) return;

      // H.264 packetization-mode=1 allows large 1080p/720p 60fps frames without MTU fragmentation drop
      const h264Mode1 = videoCapabilities.codecs.filter(
        (c) => c.mimeType && c.mimeType.toLowerCase() === 'video/h264' &&
               c.sdpFmtpLine && c.sdpFmtpLine.includes('packetization-mode=1')
      );
      const vp8Codecs = videoCapabilities.codecs.filter(
        (c) => c.mimeType && c.mimeType.toLowerCase() === 'video/vp8'
      );
      const otherH264 = videoCapabilities.codecs.filter(
        (c) => c.mimeType && c.mimeType.toLowerCase() === 'video/h264' &&
               (!c.sdpFmtpLine || !c.sdpFmtpLine.includes('packetization-mode=1'))
      );
      const remainingCodecs = videoCapabilities.codecs.filter(
        (c) => c.mimeType && c.mimeType.toLowerCase() !== 'video/h264' && c.mimeType.toLowerCase() !== 'video/vp8'
      );

      const preferredCodecs = [...h264Mode1, ...vp8Codecs, ...otherH264, ...remainingCodecs];

      pc.getTransceivers().forEach((transceiver) => {
        if (
          (transceiver.sender && transceiver.sender.track && transceiver.sender.track.kind === 'video') ||
          (transceiver.receiver && transceiver.receiver.track && transceiver.receiver.track.kind === 'video')
        ) {
          try {
            transceiver.setCodecPreferences(preferredCodecs);
          } catch (e) {}
        }
      });
    } catch (err) {
      console.warn('Could not set codec preferences:', err);
    }
  }

  // WebRTC Real-time Inbound Video Stats Monitor (FPS, Mbps, Resolution)
  function stopStreamStatsMonitor() {
    if (streamStatsInterval) {
      clearInterval(streamStatsInterval);
      streamStatsInterval = null;
    }
    lastStatsBytes = 0;
    lastStatsFrames = 0;
    lastStatsTimestamp = 0;
  }

  function startStreamStatsMonitor() {
    stopStreamStatsMonitor();
    lastStatsBytes = 0;
    lastStatsFrames = 0;
    lastStatsTimestamp = performance.now();

    streamStatsInterval = setInterval(async () => {
      if (!isWatching || !viewerPeerConnection || !liveStreamVideo) {
        return;
      }
      try {
        const stats = await viewerPeerConnection.getStats();
        let inboundVideo = null;
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            inboundVideo = report;
          }
        });

        if (inboundVideo) {
          const now = performance.now();
          const bytes = inboundVideo.bytesReceived || 0;
          const frames = inboundVideo.framesDecoded || inboundVideo.framesReceived || 0;
          let bitrateMbps = 0;
          let currentFps = 0;

          if (lastStatsTimestamp && now > lastStatsTimestamp) {
            const timeDiffSec = (now - lastStatsTimestamp) / 1000;
            if (timeDiffSec > 0.4) {
              if (bytes >= lastStatsBytes) {
                const bitsDiff = (bytes - lastStatsBytes) * 8;
                bitrateMbps = (bitsDiff / timeDiffSec / 1000000).toFixed(1);
              }
              if (lastStatsFrames > 0 && frames >= lastStatsFrames) {
                currentFps = Math.round((frames - lastStatsFrames) / timeDiffSec);
              } else if (inboundVideo.framesPerSecond !== undefined) {
                currentFps = Math.round(inboundVideo.framesPerSecond);
              }
            }
          }

          if (currentFps === 0 && inboundVideo.framesPerSecond !== undefined) {
            currentFps = Math.round(inboundVideo.framesPerSecond);
          }

          lastStatsBytes = bytes;
          lastStatsFrames = frames;
          lastStatsTimestamp = now;

          const height = inboundVideo.frameHeight || liveStreamVideo.videoHeight || 720;

          if (streamStatusBadge) {
            const modeIcon = selectedStreamMode === 'motion' ? '🎮' : '📄';
            if (bitrateMbps > 0) {
              streamStatusBadge.textContent = `${height}p @ ${currentFps} FPS • ${bitrateMbps} Mbps ${modeIcon}`;
            } else {
              streamStatusBadge.textContent = `${height}p @ ${currentFps} FPS ${modeIcon}`;
            }
          }
        }
      } catch (e) {}
    }, 1000);
  }

  function updateQualityDisplay() {
    if (!streamStatusBadge) return;
    const resLabel = selectedResolution === 'original' ? 'Original' : selectedResolution;
    const modeIcon = selectedStreamMode === 'motion' ? '🎮 60FPS' : '📄 Sharp';
    const estBitrate = (getBitrateBps(selectedResolution, selectedFps) / 1000000).toFixed(1);
    if (isScreenSharing) {
      streamStatusBadge.textContent = `${resLabel} @ ${selectedFps} FPS • ~${estBitrate} Mbps (${modeIcon})`;
    } else if (!isWatching) {
      streamStatusBadge.textContent = `${resLabel} @ ${selectedFps} FPS • ${modeIcon}`;
    }
  }

  // Update Live Stream Button in the input action row (Icon + Text layout)
  function updateScreenShareButtonState(forcedState) {
    if (!btnToggleScreenShare) return;

    let iconSpan = btnToggleScreenShare.querySelector('.stream-icon');
    let textSpan = btnToggleScreenShare.querySelector('.stream-text');

    if (!iconSpan || !textSpan) {
      btnToggleScreenShare.innerHTML = `
        <span class="upload-icon stream-icon">🖥️</span>
        <span class="upload-text stream-text">ไลฟ์สด</span>
      `;
      iconSpan = btnToggleScreenShare.querySelector('.stream-icon');
      textSpan = btnToggleScreenShare.querySelector('.stream-text');
    }

    let state = forcedState;
    if (!state) {
      if (isScreenSharing) {
        state = 'streaming';
      } else if (activeStreamerUid && (!currentUser || activeStreamerUid !== currentUser.uid)) {
        state = isWatching ? 'watching' : 'has_streamer';
      } else {
        state = 'idle';
      }
    }

    btnToggleScreenShare.classList.remove('is-live', 'has-streamer', 'is-watching', 'btn-danger', 'btn-secondary');

    if (state === 'streaming') {
      iconSpan.textContent = '🔴';
      textSpan.textContent = 'หยุดไลฟ์';
      btnToggleScreenShare.title = 'กำลังไลฟ์สดหน้าจอ (คลิกเพื่อหยุด)';
      btnToggleScreenShare.classList.add('is-live');
      btnToggleScreenShare.disabled = false;
    } else if (state === 'watching') {
      iconSpan.textContent = '⏹️';
      textSpan.textContent = 'หยุดดู';
      btnToggleScreenShare.title = `กำลังดูไลฟ์สดของ ${activeStreamerUsername || 'เพื่อน'} (คลิกเพื่อหยุดดู)`;
      btnToggleScreenShare.classList.add('is-watching', 'has-streamer');
      btnToggleScreenShare.disabled = false;
    } else if (state === 'has_streamer') {
      iconSpan.textContent = '📺';
      textSpan.textContent = 'ดูไลฟ์';
      btnToggleScreenShare.title = `${activeStreamerUsername || 'เพื่อน'} กำลังไลฟ์สด (คลิกเพื่อเริ่มดู)`;
      btnToggleScreenShare.classList.add('has-streamer');
      btnToggleScreenShare.disabled = false;
    } else {
      // idle
      iconSpan.textContent = '🖥️';
      textSpan.textContent = 'ไลฟ์สด';
      btnToggleScreenShare.title = 'เริ่มไลฟ์สดแชร์หน้าจอให้เพื่อนในห้อง';
      btnToggleScreenShare.disabled = false;
    }
  }

  // 1. Streamer: Start Capturing Screen
  async function startScreenShare() {
    if (!currentUser || !activeRoomCode) {
      showToast('กรุณาเข้าห้องแชทก่อนเริ่มไลฟ์สด');
      return;
    }

    if (isScreenSharing) {
      stopScreenShare();
      return;
    }

    if (activeStreamerUid && activeStreamerUid !== currentUser.uid) {
      showToast(`⚠️ มีผู้ใช้งาน (${activeStreamerUsername || 'อื่น'}) กำลังไลฟ์สดอยู่ กรุณารอให้สิ้นสุดก่อน`);
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showToast('⚠️ เบราว์เซอร์ของคุณไม่รองรับการแชร์หน้าจอ (แนะนำใช้ Google Chrome / MS Edge บน PC)');
      return;
    }

    try {
      localScreenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'monitor',
          frameRate: { ideal: 60, min: 30, max: 60 },
          width: { ideal: 1920, max: 3840 },
          height: { ideal: 1080, max: 2160 }
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2
        },
        systemAudio: 'include',
        surfaceSwitching: 'include',
        selfBrowserSurface: 'exclude'
      });
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        showToast('ไม่สามารถเริ่มแชร์หน้าจอได้: ' + (err.message || 'เกิดข้อผิดพลาด'));
      }
      return;
    }

    isScreenSharing = true;
    activeStreamerUid = currentUser.uid;
    activeStreamerUsername = currentUser.username;

    // Apply high-framerate motion hints & lock ideal frameRate on active track
    const videoTrack = localScreenStream.getVideoTracks()[0];
    if (videoTrack) {
      if ('contentHint' in videoTrack) {
        videoTrack.contentHint = selectedStreamMode === 'detail' ? 'detail' : 'motion';
      }
      if (videoTrack.applyConstraints) {
        videoTrack.applyConstraints({ frameRate: { ideal: 60, max: 60 } }).catch(() => {});
      }
      videoTrack.onended = () => {
        stopScreenShare();
      };
    }

    // Play local preview (muted so streamer doesn't hear own echo)
    if (liveStreamVideo) {
      liveStreamVideo.srcObject = localScreenStream;
      liveStreamVideo.muted = true;
      liveStreamVideo.play().catch(() => {});
    }

    // Show floating stream window & hide placeholder
    if (floatingStreamWindow) floatingStreamWindow.classList.remove('hidden');
    if (streamPlaceholderOverlay) streamPlaceholderOverlay.classList.add('hidden');

    if (floatingStreamerTitle) floatingStreamerTitle.textContent = 'คุณ (กำลังแชร์หน้าจอ)';
    if (streamerNameBadge) streamerNameBadge.textContent = 'คุณ (กำลังแชร์หน้าจอ)';
    if (btnStopWatchStream) btnStopWatchStream.textContent = '🔴 หยุดไลฟ์';
    updateScreenShareButtonState();
    reorderLiveCards();

    updateQualityDisplay();

    // Broadcast stream start event to room members
    publishJson(topicRoom(activeRoomCode), {
      type: 'stream_started',
      uid: currentUser.uid,
      streamerUid: currentUser.uid,
      streamerUsername: currentUser.username,
      streamerAvatar: currentUser.avatar
    });

    showToast('🖥️ เริ่มต้นการไลฟ์สดหน้าจอแล้ว! (เพื่อนในห้องสามารถกดดูได้ทันที)');
  }

  // 2. Streamer: Stop Capturing Screen
  function stopScreenShare() {
    stopStreamStatsMonitor();
    if (!isScreenSharing && !localScreenStream) return;
    isScreenSharing = false;

    if (localScreenStream) {
      localScreenStream.getTracks().forEach((t) => {
        try { t.stop(); } catch (e) {}
      });
      localScreenStream = null;
    }

    // Close all viewer connections
    streamPeers.forEach((pc) => {
      try { pc.close(); } catch (e) {}
    });
    streamPeers.clear();

    if (liveStreamVideo) {
      liveStreamVideo.srcObject = null;
    }

    if (floatingStreamWindow) {
      floatingStreamWindow.classList.add('hidden');
    }

    const wasStreamer = activeStreamerUid === (currentUser && currentUser.uid);
    activeStreamerUid = null;
    activeStreamerUsername = null;
    updateScreenShareButtonState();
    reorderLiveCards();
    renderAllLiveCards();

    if (wasStreamer && activeRoomCode) {
      publishJson(topicRoom(activeRoomCode), {
        type: 'stream_stopped',
        uid: currentUser.uid,
        streamerUid: currentUser.uid
      });
      showToast('⏹ สิ้นสุดการไลฟ์สดหน้าจอแล้ว');
    }
  }

  // 3. Viewer: Toggle Watching Stream (Click to Watch / Click again to Stop Watching)
  function toggleWatchStream() {
    if (isScreenSharing) {
      if (confirm('คุณกำลังไลฟ์สดอยู่ ต้องการหยุดการไลฟ์สดหรือไม่?')) {
        stopScreenShare();
      }
      return;
    }

    if (!activeStreamerUid) {
      showToast('⚠️ ยังไม่มีใครกำลังไลฟ์สดในห้องนี้');
      return;
    }

    if (!isWatching) {
      // START WATCHING
      isWatching = true;
      if (floatingStreamWindow) floatingStreamWindow.classList.remove('hidden');
      if (floatingStreamerTitle) floatingStreamerTitle.textContent = `${activeStreamerUsername || 'เพื่อน'} (กำลังไลฟ์สด)`;
      if (streamPlaceholderOverlay) streamPlaceholderOverlay.classList.add('hidden');
      if (btnStopWatchStream) btnStopWatchStream.textContent = '⏹ หยุดดู';

      if (viewerPeerConnection) {
        try { viewerPeerConnection.close(); } catch (e) {}
      }

      pendingIceCandidates = [];
      viewerPeerConnection = new RTCPeerConnection(RTC_CONFIG);

      // Setup inbound transceivers with H.264 preference
      try {
        viewerPeerConnection.addTransceiver('video', { direction: 'recvonly' });
        viewerPeerConnection.addTransceiver('audio', { direction: 'recvonly' });
        preferH264Codec(viewerPeerConnection);
      } catch (e) {}

      viewerPeerConnection.ontrack = (event) => {
        const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
        if (liveStreamVideo) {
          liveStreamVideo.srcObject = stream;
          liveStreamVideo.play().catch(e => console.log('Autoplay handled:', e));
        }
        attachStreamAudio(stream);
      };

      viewerPeerConnection.onicecandidate = (event) => {
        if (event.candidate && activeStreamerUid && currentUser) {
          publishJson(topicInbox(activeStreamerUid), {
            type: 'stream_signal_candidate',
            fromUid: currentUser.uid,
            candidate: event.candidate
          });
        }
      };

      viewerPeerConnection.onconnectionstatechange = () => {
        if (viewerPeerConnection && (viewerPeerConnection.connectionState === 'disconnected' || viewerPeerConnection.connectionState === 'failed')) {
          showToast('⚠️ สัญญาณการรับชมสะดุด (คลิกที่วิดีโอเพื่อเชื่อมต่อใหม่)');
        }
      };

      // Request stream from streamer with desired resolution, FPS & mode
      publishJson(topicInbox(activeStreamerUid), {
        type: 'stream_watch_request',
        fromUid: currentUser.uid,
        username: currentUser.username,
        resolution: selectedResolution,
        fps: selectedFps,
        mode: selectedStreamMode
      });

      updateQualityDisplay();
      updateScreenShareButtonState();
      showToast('📺 เริ่มดูไลฟ์สดแล้ว (คลิกที่วิดีโออีกครั้งเพื่อหยุดดู)');
    } else {
      // STOP WATCHING
      stopWatchingStream();
      showToast('⏸️ หยุดดูไลฟ์สดแล้ว (คลิกที่วิดีโอเพื่อเปิดดูใหม่)');
    }
  }

  // 4. Viewer: Stop Watching Stream
  function stopWatchingStream() {
    stopStreamStatsMonitor();
    isWatching = false;
    detachStreamAudio();
    if (viewerPeerConnection) {
      try { viewerPeerConnection.close(); } catch (e) {}
      viewerPeerConnection = null;
    }
    pendingIceCandidates = [];

    if (liveStreamVideo) {
      liveStreamVideo.srcObject = null;
    }

    if (floatingStreamWindow) {
      floatingStreamWindow.classList.add('hidden');
    }

    if (streamPlaceholderOverlay) {
      if (streamPlaceholderTitle) streamPlaceholderTitle.textContent = '⏸️ หยุดดูไลฟ์สดแล้ว';
      if (streamPlaceholderSub) streamPlaceholderSub.textContent = 'คลิกที่วิดีโอ หรือกดปุ่มด้านล่างเพื่อกลับมารับชมต่อ';
      if (btnToggleWatchStream) btnToggleWatchStream.textContent = '▶ ดูไลฟ์ต่อ';
      streamPlaceholderOverlay.classList.remove('hidden');
    }

    if (btnStopWatchStream) {
      btnStopWatchStream.textContent = '▶ ดูไลฟ์สด';
    }

    updateScreenShareButtonState();
    reorderLiveCards();
    renderAllLiveCards();

    // Notify streamer to release encoding bandwidth
    if (activeStreamerUid && currentUser) {
      publishJson(topicInbox(activeStreamerUid), {
        type: 'stream_stop_watch',
        fromUid: currentUser.uid
      });
    }
  }

  // 5. Cleanup all stream state when switching or leaving rooms
  function cleanupStreamState() {
    stopStreamStatsMonitor();
    detachStreamAudio();
    if (isScreenSharing) {
      stopScreenShare();
    }
    if (isWatching) {
      stopWatchingStream();
    }
    activeStreamerUid = null;
    activeStreamerUsername = null;
    if (floatingStreamWindow) floatingStreamWindow.classList.add('hidden');
    updateScreenShareButtonState();
    reorderLiveCards();
  }

  // 6. WebRTC Sender Quality Downscaling, Framerate & Bitrate Control
  async function applyQualityConstraints(pc, resolution, fps, mode = selectedStreamMode) {
    if (!pc) return;
    try {
      const senders = pc.getSenders ? pc.getSenders() : [];
      const videoSender = senders.find((s) => s.track && s.track.kind === 'video');
      if (!videoSender) return;

      const params = videoSender.getParameters();
      if (!params || !params.encodings || params.encodings.length === 0) {
        return;
      }

      // 1. Bitrate Allocation (Smooth 60 FPS without bufferbloat)
      const targetBitrate = getBitrateBps(resolution, fps);
      params.encodings[0].maxBitrate = targetBitrate;
      params.encodings[0].minBitrate = 1200000; // Floor at 1.2 Mbps to prevent GCC dropping to 8 FPS
      params.encodings[0].networkPriority = 'high';

      // 2. Degradation Preference:
      // 'maintain-framerate' locks 60 FPS without dropping frames (for smooth video / gaming)
      // 'maintain-resolution' preserves sharp pixels (for text / documents)
      if (mode === 'detail') {
        params.degradationPreference = 'maintain-resolution';
      } else {
        params.degradationPreference = 'maintain-framerate';
      }

      // 3. Resolution Scaling
      let targetHeight = 0;
      if (resolution === '360p') targetHeight = 360;
      else if (resolution === '480p') targetHeight = 480;
      else if (resolution === '720p') targetHeight = 720;
      else if (resolution === '1080p') targetHeight = 1080;

      const trackSettings = videoSender.track ? videoSender.track.getSettings() : {};
      const origH = trackSettings.height || 1080;

      if (targetHeight > 0 && origH > targetHeight) {
        params.encodings[0].scaleResolutionDownBy = Math.max(1, origH / targetHeight);
      } else {
        params.encodings[0].scaleResolutionDownBy = 1;
      }

      // 4. Cap maxFramerate (15, 30, 60 FPS)
      const targetFps = parseInt(fps, 10) || 60;
      params.encodings[0].maxFramerate = targetFps;

      await videoSender.setParameters(params);
    } catch (err) {
      console.warn('Could not apply sender quality parameters:', err);
    }
  }

  // 7. Streamer handles incoming watch request from a viewer
  async function handleViewerWatchRequest(data) {
    if (!isScreenSharing || !localScreenStream || !data) return;
    const viewerUid = sanitizeUid(data.fromUid);
    if (!viewerUid) return;

    if (streamPeers.has(viewerUid)) {
      try { streamPeers.get(viewerUid).close(); } catch (e) {}
      streamPeers.delete(viewerUid);
    } else if (streamPeers.size >= 25) {
      // Cap maximum concurrent WebRTC peer connections to prevent DoS resource exhaustion
      return;
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    streamPeers.set(viewerUid, pc);

    localScreenStream.getTracks().forEach((track) => {
      pc.addTrack(track, localScreenStream);
    });

    preferH264Codec(pc);

    pc.onicecandidate = (event) => {
      if (event.candidate && currentUser) {
        publishJson(topicInbox(viewerUid), {
          type: 'stream_signal_candidate',
          fromUid: currentUser.uid,
          candidate: event.candidate
        });
      }
    };

    pc.onsignalingstatechange = () => {
      if (pc.signalingState === 'stable') {
        applyQualityConstraints(
          pc,
          data.resolution || selectedResolution,
          data.fps || selectedFps,
          data.mode || selectedStreamMode
        );
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        streamPeers.delete(viewerUid);
      }
    };

    try {
      const offer = await pc.createOffer();
      const modifiedSdp = setSDPBitrate(
        offer.sdp,
        getBitrateKbps(data.resolution || selectedResolution, data.fps || selectedFps)
      );
      await pc.setLocalDescription({ type: offer.type, sdp: modifiedSdp });

      // Apply quality parameters after local description is set so sender encodings are ready
      await applyQualityConstraints(
        pc,
        data.resolution || selectedResolution,
        data.fps || selectedFps,
        data.mode || selectedStreamMode
      );

      publishJson(topicInbox(viewerUid), {
        type: 'stream_signal_offer',
        fromUid: currentUser.uid,
        sdp: pc.localDescription
      });
    } catch (err) {
      console.warn('Error creating stream offer:', err);
    }
  }

  // 8. Viewer handles incoming SDP offer from streamer
  async function handleStreamerOffer(data) {
    if (!isWatching || !viewerPeerConnection || !data || !data.sdp) return;
    const streamerUid = sanitizeUid(data.fromUid);
    if (!streamerUid || (activeStreamerUid && streamerUid !== activeStreamerUid)) return;

    try {
      await viewerPeerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));

      // Flush queued candidates
      while (pendingIceCandidates.length > 0) {
        const candidate = pendingIceCandidates.shift();
        await viewerPeerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      }

      const answer = await viewerPeerConnection.createAnswer();
      const modifiedAnswerSdp = setSDPBitrate(
        answer.sdp,
        getBitrateKbps(selectedResolution, selectedFps)
      );
      await viewerPeerConnection.setLocalDescription({ type: answer.type, sdp: modifiedAnswerSdp });

      publishJson(topicInbox(streamerUid), {
        type: 'stream_signal_answer',
        fromUid: currentUser.uid,
        sdp: viewerPeerConnection.localDescription
      });

      startStreamStatsMonitor();
    } catch (err) {
      console.warn('Error handling streamer offer:', err);
    }
  }

  // 9. Streamer handles incoming SDP answer from viewer
  async function handleViewerAnswer(data) {
    if (!isScreenSharing || !data || !data.sdp) return;
    const viewerUid = sanitizeUid(data.fromUid);
    if (!viewerUid) return;
    const pc = streamPeers.get(viewerUid);
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      await applyQualityConstraints(
        pc,
        data.resolution || selectedResolution,
        data.fps || selectedFps,
        data.mode || selectedStreamMode
      );
    } catch (err) {
      console.warn('Error setting remote description from viewer:', err);
    }
  }

  // 10. Handle ICE candidate on either side
  async function handleRemoteCandidate(data) {
    if (!data) return;
    const senderUid = sanitizeUid(data.fromUid);
    if (!senderUid) return;
    if (isScreenSharing) {
      const pc = streamPeers.get(senderUid);
      if (pc && pc.remoteDescription && data.candidate) {
        pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
      }
    } else if (isWatching && viewerPeerConnection) {
      if (activeStreamerUid && senderUid !== activeStreamerUid) return;
      if (viewerPeerConnection.remoteDescription && data.candidate) {
        viewerPeerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
      } else if (data.candidate && pendingIceCandidates.length < 60) {
        pendingIceCandidates.push(data.candidate);
      }
    }
  }

  // 11. Streamer updates quality constraints on viewer request
  async function handleQualityChangeRequest(data) {
    if (!isScreenSharing || !data) return;
    const viewerUid = sanitizeUid(data.fromUid);
    if (!viewerUid) return;
    const pc = streamPeers.get(viewerUid);
    if (pc) {
      await applyQualityConstraints(pc, data.resolution, data.fps, data.mode);
    }
  }

  // 12. Streamer cleans up peer when viewer stops watching
  function handleViewerStopWatch(data) {
    if (!data) return;
    const viewerUid = sanitizeUid(data.fromUid);
    if (!viewerUid) return;
    const pc = streamPeers.get(viewerUid);
    if (pc) {
      try { pc.close(); } catch (e) {}
      streamPeers.delete(viewerUid);
    }
  }

  // Streamer helper to push updated quality to all viewers & update local videoTrack hint
  function updateStreamerAllQuality() {
    if (!isScreenSharing) return;
    if (localScreenStream) {
      const vTrack = localScreenStream.getVideoTracks()[0];
      if (vTrack && 'contentHint' in vTrack) {
        vTrack.contentHint = selectedStreamMode === 'detail' ? 'detail' : 'motion';
      }
    }
    streamPeers.forEach(async (pc) => {
      await applyQualityConstraints(pc, selectedResolution, selectedFps, selectedStreamMode);
    });
  }

  // Viewer helper to request quality change from active streamer
  function notifyStreamerQualityChange() {
    if (isWatching && activeStreamerUid && currentUser) {
      publishJson(topicInbox(activeStreamerUid), {
        type: 'stream_quality_change',
        fromUid: currentUser.uid,
        resolution: selectedResolution,
        fps: selectedFps,
        mode: selectedStreamMode
      });
    }
  }

  // 13. UI Event Listeners for Live Stream
  if (btnToggleScreenShare) {
    btnToggleScreenShare.addEventListener('click', () => {
      if (isScreenSharing) {
        stopScreenShare();
      } else if (activeStreamerUid && (!currentUser || activeStreamerUid !== currentUser.uid)) {
        if (floatingStreamWindow) floatingStreamWindow.classList.remove('hidden');
        toggleWatchStream();
      } else {
        startScreenShare();
      }
    });
  }

  // Clicking on the video player container toggles watching / stopping stream
  if (streamContainer) {
    streamContainer.addEventListener('click', (e) => {
      // Do not toggle when clicking HUD controls or volume slider directly
      if (e.target.closest('#streamHudControls') || e.target.closest('.stream-volume-wrap')) return;
      toggleWatchStream();
    });
  }

  if (btnToggleWatchStream) {
    btnToggleWatchStream.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatchStream();
    });
  }

  if (btnStopWatchStream) {
    btnStopWatchStream.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isScreenSharing) {
        stopScreenShare();
      } else {
        toggleWatchStream();
      }
    });
  }

  // Resolution Selector
  if (selectStreamResolution) {
    selectStreamResolution.addEventListener('change', (e) => {
      selectedResolution = e.target.value;
      updateQualityDisplay();
      if (isScreenSharing) {
        updateStreamerAllQuality();
      } else {
        notifyStreamerQualityChange();
      }
      showToast(`⚙️ ปรับความละเอียดเป็น ${selectedResolution} @ ${selectedFps} FPS แล้ว`);
    });
  }

  // FPS Selector
  if (selectStreamFps) {
    selectStreamFps.addEventListener('change', (e) => {
      selectedFps = parseInt(e.target.value, 10) || 60;
      updateQualityDisplay();
      if (isScreenSharing) {
        updateStreamerAllQuality();
      } else {
        notifyStreamerQualityChange();
      }
      showToast(`⚙️ ปรับ Frame Rate เป็น ${selectedFps} FPS แล้ว`);
    });
  }

  // Optimization Mode Selector (Smooth/Gaming vs Sharp/Text)
  if (selectStreamMode) {
    selectStreamMode.addEventListener('change', (e) => {
      selectedStreamMode = e.target.value;
      updateQualityDisplay();
      if (isScreenSharing) {
        updateStreamerAllQuality();
      } else {
        notifyStreamerQualityChange();
      }
      const modeLabel = selectedStreamMode === 'motion' ? '🎮 ลื่นไหล (Smooth 60 FPS)' : '📄 คมชัด (Sharp)';
      showToast(`⚙️ ปรับโหมดไลฟ์สตรีมเป็น ${modeLabel} แล้ว`);
    });
  }

  // Live video dimension change listener for badge feedback
  if (liveStreamVideo) {
    liveStreamVideo.addEventListener('resize', () => {
      const h = liveStreamVideo.videoHeight;
      if (h && streamStatusBadge) {
        streamStatusBadge.textContent = `${h}p @ ${selectedFps} FPS`;
      }
    });
  }

  // Audio Volume Slider (0% - 200%) & Mute Toggle
  if (rangeStreamVolume) {
    rangeStreamVolume.addEventListener('input', (e) => {
      e.stopPropagation();
      const val = parseInt(e.target.value, 10);
      setStreamVolume(val, false);
    });
    rangeStreamVolume.addEventListener('change', (e) => {
      e.stopPropagation();
      const val = parseInt(e.target.value, 10);
      setStreamVolume(val, true);
    });
    rangeStreamVolume.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  if (btnStreamVolume) {
    btnStreamVolume.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentStreamVolume > 0) {
        setStreamVolume(0, true);
      } else {
        setStreamVolume(previousNonZeroVolume || 100, true);
      }
    });
  }

  // Initialize cached volume on UI
  updateVolumeUI(currentStreamVolume);

  // Fullscreen Toggle
  if (btnStreamFullscreen) {
    btnStreamFullscreen.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!document.fullscreenElement) {
        if (streamContainer && streamContainer.requestFullscreen) {
          streamContainer.requestFullscreen().catch(() => {});
        }
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        }
      }
    });
  }

  // --- Floating Stream Window Drag, Minimize, & Resize Management ---
  let isFloatingDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartLeft = 0;
  let dragStartTop = 0;

  function initFloatingStreamControls() {
    if (!floatingStreamWindow || !streamDragHandle) return;

    // Draggable header via mouse & touch
    function onDragStart(e) {
      if (e.target.closest('.floating-header-actions') || e.target.closest('button') || e.target.closest('select') || e.target.closest('input')) return;
      isFloatingDragging = true;
      floatingStreamWindow.classList.add('is-dragging');

      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;

      dragStartX = clientX;
      dragStartY = clientY;

      const rect = floatingStreamWindow.getBoundingClientRect();
      dragStartLeft = rect.left;
      dragStartTop = rect.top;

      floatingStreamWindow.style.right = 'auto';
      floatingStreamWindow.style.bottom = 'auto';
      floatingStreamWindow.style.left = `${dragStartLeft}px`;
      floatingStreamWindow.style.top = `${dragStartTop}px`;

      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragEnd);
      document.addEventListener('touchmove', onDragMove, { passive: false });
      document.addEventListener('touchend', onDragEnd);
    }

    function onDragMove(e) {
      if (!isFloatingDragging) return;
      if (e.cancelable) e.preventDefault();

      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;

      const deltaX = clientX - dragStartX;
      const deltaY = clientY - dragStartY;

      let newLeft = dragStartLeft + deltaX;
      let newTop = dragStartTop + deltaY;

      const maxLeft = Math.max(10, window.innerWidth - floatingStreamWindow.offsetWidth - 10);
      const maxTop = Math.max(10, window.innerHeight - floatingStreamWindow.offsetHeight - 10);

      newLeft = Math.max(10, Math.min(newLeft, maxLeft));
      newTop = Math.max(10, Math.min(newTop, maxTop));

      floatingStreamWindow.style.left = `${newLeft}px`;
      floatingStreamWindow.style.top = `${newTop}px`;
    }

    function onDragEnd() {
      if (!isFloatingDragging) return;
      isFloatingDragging = false;
      floatingStreamWindow.classList.remove('is-dragging');
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', onDragEnd);
      document.removeEventListener('touchmove', onDragMove);
      document.removeEventListener('touchend', onDragEnd);
    }

    streamDragHandle.addEventListener('mousedown', onDragStart);
    streamDragHandle.addEventListener('touchstart', onDragStart, { passive: true });

    // Minimize / Expand Toggle
    if (btnMinimizeFloatingStream) {
      btnMinimizeFloatingStream.addEventListener('click', (e) => {
        e.stopPropagation();
        const isMin = floatingStreamWindow.classList.toggle('is-minimized');
        btnMinimizeFloatingStream.textContent = isMin ? '🗖' : '🗕';
        btnMinimizeFloatingStream.title = isMin ? 'ขยายหน้าต่างไลฟ์' : 'ย่อหน้าต่างไลฟ์';
      });
    }

    // Fullscreen Toggle
    if (btnFloatingFullscreen) {
      btnFloatingFullscreen.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!document.fullscreenElement) {
          if (floatingStreamWindow.requestFullscreen) {
            floatingStreamWindow.requestFullscreen().catch(() => {});
          }
        } else {
          if (document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
          }
        }
      });
    }

    // Close button
    if (btnCloseFloatingStream) {
      btnCloseFloatingStream.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isScreenSharing) {
          if (confirm('คุณกำลังไลฟ์สดอยู่ ต้องการหยุดการไลฟ์สดหรือไม่?')) {
            stopScreenShare();
          }
        } else if (isWatching) {
          stopWatchingStream();
        } else {
          floatingStreamWindow.classList.add('hidden');
        }
      });
    }

    // Bottom-right corner resizer
    if (streamResizeHandle) {
      let isResizing = false;
      let resizeStartX = 0;
      let resizeStartY = 0;
      let startW = 0;
      let startH = 0;

      function onResizeStart(e) {
        e.stopPropagation();
        isResizing = true;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        resizeStartX = clientX;
        resizeStartY = clientY;
        startW = floatingStreamWindow.offsetWidth;
        startH = floatingStreamWindow.offsetHeight;

        document.addEventListener('mousemove', onResizeMove);
        document.addEventListener('mouseup', onResizeEnd);
        document.addEventListener('touchmove', onResizeMove, { passive: false });
        document.addEventListener('touchend', onResizeEnd);
      }

      function onResizeMove(e) {
        if (!isResizing) return;
        if (e.cancelable) e.preventDefault();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const newW = Math.max(280, Math.min(window.innerWidth - 20, startW + (clientX - resizeStartX)));
        const newH = Math.max(180, Math.min(window.innerHeight - 20, startH + (clientY - resizeStartY)));
        floatingStreamWindow.style.width = `${newW}px`;
        floatingStreamWindow.style.height = `${newH}px`;
      }

      function onResizeEnd() {
        isResizing = false;
        document.removeEventListener('mousemove', onResizeMove);
        document.removeEventListener('mouseup', onResizeEnd);
        document.removeEventListener('touchmove', onResizeMove);
        document.removeEventListener('touchend', onResizeEnd);
      }

      streamResizeHandle.addEventListener('mousedown', onResizeStart);
      streamResizeHandle.addEventListener('touchstart', onResizeStart, { passive: true });
    }
  }

  // Initialize Floating Stream, Google Auth UI & Room Layout
  initFloatingStreamControls();
  updateAuthUIState();
  initRoomLayoutPreference();
})();
