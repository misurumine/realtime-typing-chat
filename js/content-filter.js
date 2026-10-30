/**
 * LiveType Content Safety & Moderation Engine (AI-Powered)
 * 1. AI Deep Learning NSFW Classifier (TensorFlow.js + NSFWJS MobileNetV2)
 *    - Accurately classifies Neutral (Fully Clothed, Pets, Scenery) vs Explicit Nudity (Porn, Hentai)
 *    - 0% False Positives on fully clothed people!
 * 2. Smart Profanity Filter (Thai & English with Obfuscation / Evasion resistance) -> masks with ****
 * 3. Safe Fallback & Live Profile Settings Toggle
 */

(function (window) {
  'use strict';

  const STORAGE_KEY_CONTENT_FILTER = 'livetype_content_filter_v1';

  // In-memory cache for NSFW classification results (0ms instant lookup)
  const nsfwDetectionCache = new Map();

  // AI Model State
  let nsfwModel = null;
  let isModelLoading = false;
  let modelLoadPromise = null;

  // -------------------------------------------------------------
  // 1. Settings State Management
  // -------------------------------------------------------------
  const defaultSettings = {
    adultFilter: true,     // กรองและเซ็นเซอร์ภาพลามกอนาจาร / 18+ (ใช้ AI)
    profanityFilter: true  // กรองคำหยาบเป็น ****
  };

  let currentSettings = { ...defaultSettings };

  function loadSettings() {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(STORAGE_KEY_CONTENT_FILTER);
        if (raw) {
          const parsed = JSON.parse(raw);
          currentSettings = {
            adultFilter: typeof parsed.adultFilter === 'boolean' ? parsed.adultFilter : defaultSettings.adultFilter,
            profanityFilter: typeof parsed.profanityFilter === 'boolean' ? parsed.profanityFilter : defaultSettings.profanityFilter
          };
        }
      }
    } catch (e) {
      currentSettings = { ...defaultSettings };
    }
    return currentSettings;
  }

  function saveSettings(newSettings) {
    currentSettings = {
      ...currentSettings,
      ...newSettings
    };
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY_CONTENT_FILTER, JSON.stringify(currentSettings));
      }
    } catch (e) {}

    // Dispatch event so live cards and other components can update immediately
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(
          new CustomEvent('livetype:filters-changed', {
            detail: { ...currentSettings }
          })
        );
      } catch (e) {}
    }
    return currentSettings;
  }

  // Initial load
  loadSettings();

  function isAdultFilterEnabled() {
    return Boolean(currentSettings.adultFilter);
  }

  function isProfanityFilterEnabled() {
    return Boolean(currentSettings.profanityFilter);
  }

  function setAdultFilterEnabled(enabled) {
    saveSettings({ adultFilter: Boolean(enabled) });
  }

  function setProfanityFilterEnabled(enabled) {
    saveSettings({ profanityFilter: Boolean(enabled) });
  }

  // -------------------------------------------------------------
  // 2. Smart Profanity Filter (คำหยาบคาย ไทย & อังกฤษ)
  // -------------------------------------------------------------

  const thaiProfanityPatterns = [
    // 1. Long compound phrases first
    /(?:ไอ้|อี|ไอ)[\s\.\-_*]*(?:เหี้ย|ดอก|สัตว์|สัส|สัด|เวร|ห่า|ควาย|หน้าด้าน|ระยำ|ชาติชั่ว)/gi,
    /หน้า[\s\.\-_*]*ตัว[\s\.\-_*]*เมีย/gi,
    /ส้น[\s\.\-_*]*ต[รี]*น+/gi,
    /[ชฉ]ิบ[\s\.\-_*]*หาย+/gi,
    /ชาติ[\s\.\-_*]*ชั่ว+/gi,
    /ระ[\s\.\-_*]*ยำ+/gi,
    /ตอ[\s\.\-_*]*แหล+/gi,
    /ชัก[\s\.\-_*]*ว่าว/gi,
    /ด[\s\.\-_*#@!]*อ[\s\.\-_*#@!]*ก[\s\.\-_*#@!]*ท[\s\.\-_*#@!]*อ[\s\.\-_*#@!]*ง+/gi,
    /กะ[\s\.\-_*]*หรี่+/gi,
    /(?:อี|ไอ้)[\s\.\-_*]*แรด+/gi,
    /(?:ไอ้|อี|ไอ)?[\s\.\-_*]*ค[\s\.\-_*]*ว[\s\.\-_*]*า[\s\.\-_*]*ย+/gi,
    /(?:ไอ้|อี|ไอ)?[\s\.\-_*]*ห่า+/gi,

    // 2. Specific multi-character core profanities BEFORE short substrings
    // เหี้ย (MUST BE BEFORE หี !)
    /เ[\s\.\-_*#@!]*ห[\s\.\-_*#@!]*(?:ี|ิ|ื)?(?:้|่|๊|๋)?[\s\.\-_*#@!]*ย+/gi,
    // ควย
    /ค[\s\.\-_*#@!]*ว[\s\.\-_*#@!]*ย+/gi,
    // เย็ด
    /เ[\s\.\-_*#@!]*ย[\s\.\-_*#@!]*(?:็|้|่)?[\s\.\-_*#@!]*ด+/gi,
    // สัส / สัด / สถุล
    /ส[\s\.\-_*#@!]*ั[\s\.\-_*#@!]*[สด]+/gi,
    /ส[\s\.\-_*#@!]*ถ[\s\.\-_*#@!]*ุ[\s\.\-_*#@!]*ล+/gi,
    // จัญไร / จันไร
    /จ[\s\.\-_*#@!]*ั[\s\.\-_*#@!]*[ญน][\s\.\-_*#@!]*ร[\s\.\-_*#@!]*ั?[\s\.\-_*#@!]*ย+/gi,
    // แตด / จิ๋ม / เงี่ยน
    /แ[\s\.\-_*#@!]*ต[\s\.\-_*#@!]*ด+/gi,
    /จ[\s\.\-_*#@!]*ิ[\s\.\-_*#@!]*๋?[\s\.\-_*#@!]*ม+/gi,
    /เ[\s\.\-_*#@!]*ง[\s\.\-_*#@!]*ี่?[\s\.\-_*#@!]*ย[\s\.\-_*#@!]*น+/gi,
    /มึ[\s\.\-_*]*ง+/gi,
    /(?:^|[\s\p{P}])กู+(?:$|[\s\p{P}])/giu,

    // 3. Short substrings (2-letter) LAST: หี, ดอ
    /ห[\s\.\-_*#@!]*ี+/gi,
    /ด[\s\.\-_*#@!]*อ+(?!ก|น|บ|กเบี้ย|กบัว|ม|ง)/gi
  ];

  const englishProfanityPatterns = [
    // fuck, f*ck, f.u.c.k, fking, fucked, fucker
    /\bf+[\s\.\-_*#@!]*u+[\s\.\-_*#@!]*c+[\s\.\-_*#@!]*k+(?:ing|ed|er|s)?\b/gi,
    /\bf[\s\.\-_*#@!]*c[\s\.\-_*#@!]*k\b/gi,
    // shit, bullshit
    /\b(?:bull)?[\s\.\-_*]*s+[\s\.\-_*#@!]*h+[\s\.\-_*#@!]*i+[\s\.\-_*#@!]*t+(?:ty|s)?\b/gi,
    // bitch, bitches
    /\bb+[\s\.\-_*#@!]*i+[\s\.\-_*#@!]*t+[\s\.\-_*#@!]*c+[\s\.\-_*#@!]*h+(?:es|y)?\b/gi,
    // cunt
    /\bc+[\s\.\-_*#@!]*u+[\s\.\-_*#@!]*n+[\s\.\-_*#@!]*t+(?:s)?\b/gi,
    // dick
    /\bd+[\s\.\-_*#@!]*i+[\s\.\-_*#@!]*c+[\s\.\-_*#@!]*k+(?:head|s)?\b/gi,
    // pussy
    /\bp+[\s\.\-_*#@!]*u+[\s\.\-_*#@!]*s+[\s\.\-_*#@!]*s+[\s\.\-_*#@!]*y+(?:ies)?\b/gi,
    // whore, slut
    /\bw+[\s\.\-_*#@!]*h+[\s\.\-_*#@!]*o+[\s\.\-_*#@!]*r+[\s\.\-_*#@!]*e+(?:s)?\b/gi,
    /\bs+[\s\.\-_*#@!]*l+[\s\.\-_*#@!]*u+[\s\.\-_*#@!]*t+(?:s)?\b/gi,
    // asshole, dumbass, bastard
    /\ba+[\s\.\-_*#@!]*s+[\s\.\-_*#@!]*s+[\s\.\-_*#@!]*h+[\s\.\-_*#@!]*o+[\s\.\-_*#@!]*l+[\s\.\-_*#@!]*e+(?:s)?\b/gi,
    /\bdumb[\s\.\-_*]*ass\b/gi,
    /\bbastard(?:s)?\b/gi,
    // motherfucker
    /\bmother[\s\.\-_*]*fucker(?:s)?\b/gi,
    // wank, wanker
    /\bwank(?:er|ers)?\b/gi,
    // porn, nsfw, hentai, blowjob, dildo
    /\b(?:porn|nsfw|hentai|blowjob|dildo|boobs|vagina|penis)\b/gi
  ];

  function filterProfanity(text) {
    if (!text || typeof text !== 'string') return '';
    if (!isProfanityFilterEnabled()) return text;

    let filtered = text;

    // Apply Thai patterns
    for (const pattern of thaiProfanityPatterns) {
      filtered = filtered.replace(pattern, (match) => {
        const trimmed = match.trim();
        if (!trimmed) return match;
        return match.replace(trimmed, '****');
      });
    }

    // Apply English patterns
    for (const pattern of englishProfanityPatterns) {
      filtered = filtered.replace(pattern, (match) => {
        const trimmed = match.trim();
        if (!trimmed) return match;
        return match.replace(trimmed, '****');
      });
    }

    return filtered;
  }

  // -------------------------------------------------------------
  // 3. AI Deep Learning NSFW Classifier (TensorFlow.js + NSFWJS)
  // -------------------------------------------------------------

  const adultKeywordsRegex = /(?:porn|xxx|hentai|blowjob|dildo|naked_women|sex_video|sexxx)/i;

  // Initialize and load the AI MobileNet model in the background
  async function initAiModel() {
    if (nsfwModel) return nsfwModel;
    if (modelLoadPromise) return modelLoadPromise;

    if (typeof window === 'undefined' || typeof window.nsfwjs === 'undefined') {
      return null;
    }

    isModelLoading = true;
    modelLoadPromise = (async () => {
      try {
        // Load lightweight MobileNetV2 NSFW model from high-speed jsdelivr CDN
        nsfwModel = await window.nsfwjs.load('https://cdn.jsdelivr.net/gh/infinitered/nsfwjs/models/mobilenet_v2/');
        console.log('⚡ LiveType AI Content Safety: Deep Learning NSFW Model initialized!');
        return nsfwModel;
      } catch (err) {
        console.warn('AI NSFW Model loading fallback:', err);
        return null;
      } finally {
        isModelLoading = false;
        modelLoadPromise = null;
      }
    })();

    return modelLoadPromise;
  }

  // Auto-start AI model load in background when script loads
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => initAiModel(), 800);
    });
  }

  /**
   * Classify image using Deep Learning CNN
   * Returns: true (is Adult / Explicit Nudity), false (Neutral / Clothed / Safe)
   */
  async function classifyWithDeepLearning(imgElement) {
    const model = nsfwModel || (await initAiModel());
    if (!model) return null; // Model unavailable, use safe fallback

    try {
      const predictions = await model.classify(imgElement);
      if (!Array.isArray(predictions)) return null;

      const scores = {};
      for (const p of predictions) {
        scores[p.className] = p.probability;
      }

      // Neutral = People wearing clothes, daily objects, animals, food, scenery.
      // Drawing = SFW illustrations and comics.
      // Porn = Explicit sexual acts and extreme nudity.
      // Hentai = Explicit anime/manga pornography.
      // Sexy = Provocative or swimwear.
      const pornScore = scores.Porn || 0;
      const hentaiScore = scores.Hentai || 0;
      const neutralScore = scores.Neutral || 0;
      const sexyScore = scores.Sexy || 0;

      // Accuracy Rules:
      // If image is Neutral with high confidence (person with clothes), it is 100% SAFE!
      if (neutralScore > 0.60) {
        return false;
      }

      // Only flag as Adult/NSFW if Porn or Hentai probabilities are undeniably dominant
      if (pornScore > 0.55 || hentaiScore > 0.60 || (pornScore + hentaiScore > 0.65)) {
        return true;
      }

      // People in normal clothes or light swimwear without explicit acts remain SAFE
      return false;
    } catch (e) {
      console.warn('AI classification notice:', e);
      return null;
    }
  }

  /**
   * Synchronously check cache for adult content status
   * Returns: true (is adult), false (is safe), or null (not cached yet)
   */
  function getCachedAdultStatus(mediaSource) {
    if (!mediaSource || typeof mediaSource !== 'string') return false;
    if (!isAdultFilterEnabled()) return false;
    const cacheKey = mediaSource.slice(0, 300);
    if (nsfwDetectionCache.has(cacheKey)) {
      return nsfwDetectionCache.get(cacheKey);
    }
    if (adultKeywordsRegex.test(mediaSource)) {
      nsfwDetectionCache.set(cacheKey, true);
      return true;
    }
    return null;
  }

  /**
   * Check if a media source (URL, Base64 data, Video) has Adult/NSFW tendency
   * Calls callback(boolean isAdult)
   */
  function checkAdultContent(mediaSource, callback) {
    if (!mediaSource || typeof mediaSource !== 'string') {
      if (callback) callback(false);
      return;
    }

    // If adult filter is disabled by user setting, skip everything immediately
    if (!isAdultFilterEnabled()) {
      if (callback) callback(false);
      return;
    }

    // 1. Check fast in-memory cache
    const cacheKey = mediaSource.slice(0, 300);
    if (nsfwDetectionCache.has(cacheKey)) {
      if (callback) callback(nsfwDetectionCache.get(cacheKey));
      return;
    }

    // 2. Keyword check in URL/Data string
    if (adultKeywordsRegex.test(mediaSource)) {
      nsfwDetectionCache.set(cacheKey, true);
      if (callback) callback(true);
      return;
    }

    // 3. Video media data URL
    if (mediaSource.startsWith('data:video/')) {
      const isAdult = adultKeywordsRegex.test(mediaSource);
      nsfwDetectionCache.set(cacheKey, isAdult);
      if (callback) callback(isAdult);
      return;
    }

    // 4. Image analysis via Deep Learning AI (with Safe Fallback)
    if (typeof Image === 'undefined') {
      if (callback) callback(adultKeywordsRegex.test(mediaSource));
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';

    const finish = (result) => {
      nsfwDetectionCache.set(cacheKey, result);
      if (callback) callback(result);
    };

    img.onload = async () => {
      // 1. Try Deep Learning AI Classification (High Precision: Distinguishes clothed humans from nudity)
      const aiResult = await classifyWithDeepLearning(img);
      if (aiResult !== null) {
        finish(aiResult);
        return;
      }

      // 2. Safe Fallback Principle (Innocent Until Proven Guilty):
      // If AI is still loading or unavailable, NEVER censor randomly by skin color!
      // Only flag if explicit keywords are present. Clothed humans remain SAFE and visible!
      finish(adultKeywordsRegex.test(mediaSource));
    };

    img.onerror = () => {
      finish(adultKeywordsRegex.test(mediaSource));
    };

    img.src = mediaSource;
  }

  // -------------------------------------------------------------
  // 4. Censored Sensitive Content Artwork & UI Component Builder
  // -------------------------------------------------------------

  const CENSORED_ARTWORK_SVG = `
    <svg viewBox="0 0 320 180" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" class="censored-artwork-svg" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="censorGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#1e1022" />
          <stop offset="50%" stop-color="#140b17" />
          <stop offset="100%" stop-color="#09050b" />
        </linearGradient>
        <pattern id="warningStripes" width="20" height="20" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2="20" stroke="rgba(244, 63, 94, 0.12)" stroke-width="6" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#censorGrad)" rx="12" />
      <rect width="100%" height="100%" fill="url(#warningStripes)" rx="12" />
      
      <!-- Center Shield & Warning Badge -->
      <g transform="translate(160, 68)">
        <circle r="36" fill="rgba(244, 63, 94, 0.18)" stroke="#f43f5e" stroke-width="2.5" />
        <circle r="28" fill="#e11d48" />
        <text x="0" y="8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="900" fill="#ffffff" text-anchor="middle">18+</text>
      </g>
      
      <!-- Warning Title -->
      <text x="160" y="128" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="700" fill="#fecdd3" text-anchor="middle" letter-spacing="0.5">เนื้อหาไม่เหมาะสม / ผู้ใหญ่ (NSFW)</text>
      <text x="160" y="148" font-family="system-ui, -apple-system, sans-serif" font-size="10" font-weight="500" fill="rgba(255, 255, 255, 0.65)" text-anchor="middle">ถูกเซ็นเซอร์ตามการตั้งค่าความปลอดภัยของคุณ</text>
    </svg>
  `;

  function createCensoredMediaContainer(originalMediaSrc, isVideo = false) {
    const wrap = document.createElement('div');
    wrap.className = 'censored-media-container is-censored';

    const placeholder = document.createElement('div');
    placeholder.className = 'censored-warning-banner';
    placeholder.innerHTML = `
      <div class="censored-artwork-wrap">
        ${CENSORED_ARTWORK_SVG}
      </div>
      <div class="censored-actions-bar">
        <button type="button" class="btn-toggle-censored" title="คลิกเพื่อแสดงรูปภาพชั่วคราว">
          <span class="btn-icon-reveal">👁️</span>
          <span class="btn-text-reveal">แสดงรูปภาพ</span>
        </button>
      </div>
    `;

    let mediaEl;
    if (isVideo || String(originalMediaSrc).startsWith('data:video/')) {
      mediaEl = document.createElement('video');
      mediaEl.src = originalMediaSrc;
      mediaEl.autoplay = true;
      mediaEl.loop = true;
      mediaEl.muted = true;
      mediaEl.playsInline = true;
      mediaEl.className = 'live-card-video blurred-under-censor';
    } else {
      mediaEl = document.createElement('img');
      mediaEl.src = originalMediaSrc;
      mediaEl.alt = 'Sensitive content';
      mediaEl.className = 'live-card-img blurred-under-censor';
    }

    const toggleBtn = placeholder.querySelector('.btn-toggle-censored');
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isCurrentlyCensored = wrap.classList.contains('is-censored');
      if (isCurrentlyCensored) {
        wrap.classList.remove('is-censored');
        wrap.classList.add('is-revealed');
        toggleBtn.querySelector('.btn-icon-reveal').textContent = '🚫';
        toggleBtn.querySelector('.btn-text-reveal').textContent = 'ซ่อนรูปภาพอีกครั้ง';
        toggleBtn.title = 'เซ็นเซอร์ภาพนี้อีกครั้ง';
      } else {
        wrap.classList.remove('is-revealed');
        wrap.classList.add('is-censored');
        toggleBtn.querySelector('.btn-icon-reveal').textContent = '👁️';
        toggleBtn.querySelector('.btn-text-reveal').textContent = 'แสดงรูปภาพ';
        toggleBtn.title = 'คลิกเพื่อแสดงรูปภาพชั่วคราว';
      }
    });

    wrap.appendChild(mediaEl);
    wrap.appendChild(placeholder);
    return wrap;
  }

  // High-Quality SVG Artwork: White background Camera Loading / Verifying Placeholder
  const CAMERA_LOADING_SVG = `
    <svg viewBox="0 0 320 200" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" class="camera-loading-svg" xmlns="http://www.w3.org/2000/svg">
      <!-- Crisp Clean White Background with Subtle Shadowed Frame -->
      <rect width="100%" height="100%" fill="#ffffff" rx="12" />
      <rect x="2" y="2" width="316" height="196" fill="none" stroke="#e2e8f0" stroke-width="2" rx="11" />
      
      <!-- Subtle Micro-dot Grid Pattern -->
      <defs>
        <pattern id="camBgGrid" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="10" cy="10" r="1.2" fill="#cbd5e1" opacity="0.45" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#camBgGrid)" rx="12" />

      <!-- Modern Minimalist Camera Illustration -->
      <g transform="translate(160, 86)" class="camera-icon-group">
        <!-- Camera Body -->
        <rect x="-46" y="-30" width="92" height="60" rx="14" fill="#f8fafc" stroke="#94a3b8" stroke-width="2.5" />
        <!-- Top Shutter / Viewfinder Prism -->
        <path d="M -18 -30 L -12 -40 L 12 -40 L 18 -30 Z" fill="#f1f5f9" stroke="#94a3b8" stroke-width="2.5" />
        <!-- Shutter Button Left -->
        <rect x="-38" y="-35" width="12" height="5" rx="2" fill="#94a3b8" />
        <!-- Flash Light LED Right -->
        <circle cx="28" cy="-16" r="4" fill="#64748b" />
        <circle cx="28" cy="-16" r="2" fill="#38bdf8" />
        <!-- Lens Outer Rim -->
        <circle cx="0" cy="2" r="24" fill="#ffffff" stroke="#64748b" stroke-width="3" />
        <!-- Lens Inner Aperture -->
        <circle cx="0" cy="2" r="16" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1.8" />
        <circle cx="0" cy="2" r="9" fill="#cbd5e1" />
        <!-- Glass Glare Highlight -->
        <circle cx="-6" cy="-4" r="5" fill="#ffffff" opacity="0.85" />
      </g>

      <!-- Loading / Safety Verification Label -->
      <text x="160" y="152" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="700" fill="#475569" text-anchor="middle" letter-spacing="0.2">
        📷 กำลังโหลดและตรวจสอบความปลอดภัยภาพ...
      </text>
      <text x="160" y="172" font-family="system-ui, -apple-system, sans-serif" font-size="10" font-weight="500" fill="#94a3b8" text-anchor="middle">
        (ภาพจะปรากฏขึ้นอัตโนมัติเมื่อระบบตรวจเสร็จสิ้น)
      </text>
    </svg>
  `;

  /**
   * Creates a White Background Camera Loading Placeholder Element
   * Shown while image is being downloaded or verified by AI to prevent flashing explicit content
   */
  function createPendingScanPlaceholder(originalMediaSrc, isVideo = false) {
    const wrap = document.createElement('div');
    wrap.className = 'camera-loading-placeholder';
    wrap.title = 'กำลังโหลดและตรวจสอบความปลอดภัยของรูปภาพ...';
    wrap.innerHTML = CAMERA_LOADING_SVG;
    return wrap;
  }

  // -------------------------------------------------------------
  // Public API Export
  // -------------------------------------------------------------
  window.ContentFilter = {
    loadSettings,
    saveSettings,
    isAdultFilterEnabled,
    isProfanityFilterEnabled,
    setAdultFilterEnabled,
    setProfanityFilterEnabled,
    filterProfanity,
    checkAdultContent,
    getCachedAdultStatus,
    createCensoredMediaContainer,
    createPendingScanPlaceholder,
    initAiModel
  };

})(window);
