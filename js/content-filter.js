/**
 * LiveType Content Safety & Moderation Engine
 * 1. Smart Profanity Filter (Thai & English with Obfuscation / Evasion resistance) -> masks with ****
 * 2. In-Browser Adult Content / NSFW Detector (Multi-space Skin Tone & Central Density Analyzer + Metadata) -> censors with warning artwork
 * 3. Persistence & Live Profile Settings Toggle
 */

(function (window) {
  'use strict';

  const STORAGE_KEY_CONTENT_FILTER = 'livetype_content_filter_v1';

  // In-memory cache for NSFW detection results to ensure 0ms latency on keystrokes
  const nsfwDetectionCache = new Map();

  // -------------------------------------------------------------
  // 1. Settings State Management
  // -------------------------------------------------------------
  const defaultSettings = {
    adultFilter: true,     // กรองและเซ็นเซอร์ภาพลามกอนาจาร / 18+
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

  // Regex patterns with evasion handling (supports spacing, dots, dashes, repeated letters)
  // e.g., ค.ว.ย, ค ว ย, ค-ว-ย, ควยยย, f.u.c.k, f*ck, sh*t
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

  /**
   * Filter profanities in text and replace with ****
   * Returns original text if profanity filter is disabled.
   */
  function filterProfanity(text) {
    if (!text || typeof text !== 'string') return '';
    // หากปิดระบบปิดคำหยาบ ให้ปล่อยไว้เหมือนเดิม
    if (!isProfanityFilterEnabled()) return text;

    let filtered = text;

    // Apply Thai patterns
    for (const pattern of thaiProfanityPatterns) {
      filtered = filtered.replace(pattern, (match) => {
        // If match had leading/trailing spaces or punctuation (from regex lookaround/capture)
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
  // 3. Adult Content & Nudity (NSFW) Detector
  // -------------------------------------------------------------

  // Fast metadata & keyword regex for image URLs, alt texts, or Klipy gif paths
  const adultKeywordsRegex = /(?:porn|xxx|hentai|nude|naked|erotic|boobs|penis|vagina|blowjob|dildo|sensual|cleavage|milf|nsfw|18\+|adult|naked_women|sex_video|sexxx)/i;

  /**
   * Fast In-Browser Computer Vision Skin Tone & Central Density Analyzer
   * Evaluates pixel skin color ratios across RGB + YCbCr + HSV color spaces.
   */
  function analyzeImagePixelsForNudity(imgElement) {
    try {
      const w = 80;
      const aspect = (imgElement.naturalHeight || imgElement.height || 80) / (imgElement.naturalWidth || imgElement.width || 80);
      const h = Math.max(16, Math.min(100, Math.round(w * aspect))) || 80;

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;

      ctx.drawImage(imgElement, 0, 0, w, h);
      const imgData = ctx.getImageData(0, 0, w, h).data;
      const totalPixels = w * h;

      let skinPixels = 0;
      let centerSkinPixels = 0;
      let totalCenterPixels = 0;

      // Track luminance values to calculate variance (distinguish real skin photo from solid peach graphic)
      let sumLum = 0;
      let sumLumSq = 0;

      const centerXMin = Math.floor(w * 0.2);
      const centerXMax = Math.floor(w * 0.8);
      const centerYMin = Math.floor(h * 0.2);
      const centerYMax = Math.floor(h * 0.8);

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = (y * w + x) * 4;
          const r = imgData[idx];
          const g = imgData[idx + 1];
          const b = imgData[idx + 2];
          const a = imgData[idx + 3];

          if (a < 120) continue; // Skip transparent pixels

          // Calculate Luminance
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          sumLum += lum;
          sumLumSq += lum * lum;

          const isCenter = x >= centerXMin && x <= centerXMax && y >= centerYMin && y <= centerYMax;
          if (isCenter) totalCenterPixels++;

          // 1. Normalized RGB Rule
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const isRgbSkin = r > 95 && g > 40 && b > 20 && max - min > 15 && Math.abs(r - g) > 15 && r > g && r > b;

          // 2. YCbCr Rule
          // Cr = (R - Y) * 0.713 + 128
          // Cb = (B - Y) * 0.564 + 128
          const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
          const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
          const isYCbCrSkin = cr >= 133 && cr <= 175 && cb >= 80 && cb <= 135;

          // 3. Simplified HSV Rule
          let isHsvSkin = false;
          if (max > 0) {
            const delta = max - min;
            let hue = 0;
            if (delta > 0) {
              if (max === r) hue = ((g - b) / delta) % 6;
              else if (max === g) hue = (b - r) / delta + 2;
              else hue = (r - g) / delta + 4;
              hue = Math.round(hue * 60);
              if (hue < 0) hue += 360;
            }
            const sat = delta / max;
            const val = max / 255;
            isHsvSkin = (hue >= 0 && hue <= 50) && sat >= 0.18 && sat <= 0.68 && val >= 0.35;
          }

          if (isRgbSkin && (isYCbCrSkin || isHsvSkin)) {
            skinPixels++;
            if (isCenter) centerSkinPixels++;
          }
        }
      }

      // Calculate variance
      const meanLum = sumLum / totalPixels;
      const variance = (sumLumSq / totalPixels) - (meanLum * meanLum);
      const stdDev = Math.sqrt(Math.max(0, variance));

      const skinRatio = skinPixels / totalPixels;
      const centerSkinRatio = totalCenterPixels > 0 ? (centerSkinPixels / totalCenterPixels) : skinRatio;

      // If standard deviation is very low (< 8), it's a solid/flat background graphic, not human anatomy
      if (stdDev < 8) return false;

      // Threshold criteria for Adult / NSFW detection:
      // High total skin percentage (>34%) + concentrated in central body region (>38%)
      // OR overwhelmingly high exposed skin (>46%)
      if ((skinRatio > 0.34 && centerSkinRatio > 0.38) || (skinRatio > 0.46)) {
        return true;
      }
      return false;
    } catch (e) {
      // In case of canvas cross-origin taint or error, fail safe to keyword check
      return false;
    }
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

    // Check fast cache
    const cacheKey = mediaSource.slice(0, 300);
    if (nsfwDetectionCache.has(cacheKey)) {
      if (callback) callback(nsfwDetectionCache.get(cacheKey));
      return;
    }

    // 1. Keyword check in URL/Data string
    if (adultKeywordsRegex.test(mediaSource)) {
      nsfwDetectionCache.set(cacheKey, true);
      if (callback) callback(true);
      return;
    }

    // 2. Video media data URL
    if (mediaSource.startsWith('data:video/')) {
      // Videos with adult keywords or metadata
      const isAdult = adultKeywordsRegex.test(mediaSource);
      nsfwDetectionCache.set(cacheKey, isAdult);
      if (callback) callback(isAdult);
      return;
    }

    // 3. Image analysis
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

    img.onload = () => {
      const isAdult = analyzeImagePixelsForNudity(img);
      finish(isAdult);
    };

    img.onerror = () => {
      // If image fails to load via canvas, rely on keyword
      finish(adultKeywordsRegex.test(mediaSource));
    };

    img.src = mediaSource;
  }

  // -------------------------------------------------------------
  // 4. Censored Sensitive Content Artwork & UI Component Builder
  // -------------------------------------------------------------

  // High-Quality SVG Warning Artwork for censored sensitive content
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

  /**
   * Creates a Censored Media Wrapper Element
   * Includes the warning placeholder artwork and an un-censor / re-censor button
   */
  function createCensoredMediaContainer(originalMediaSrc, isVideo = false) {
    const wrap = document.createElement('div');
    wrap.className = 'censored-media-container is-censored';

    // The censored warning artwork banner
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

    // The real media element (hidden while censored)
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
        // Reveal original image
        wrap.classList.remove('is-censored');
        wrap.classList.add('is-revealed');
        toggleBtn.querySelector('.btn-icon-reveal').textContent = '🚫';
        toggleBtn.querySelector('.btn-text-reveal').textContent = 'ซ่อนรูปภาพอีกครั้ง';
        toggleBtn.title = 'เซ็นเซอร์ภาพนี้อีกครั้ง';
      } else {
        // Re-censor image
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
    createCensoredMediaContainer
  };

})(window);
