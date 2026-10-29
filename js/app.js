(() => {
  /**
   * LiveType — 100% Serverless Realtime Live-Typing Chat (PWA)
   * Works on GitHub Pages, Cloudflare Pages, Vercel, Netlify, or Localhost
   * without renting or running any backend server!
   */

  // Storage Keys (Session persists until explicit Logout)
  const STORAGE_KEY_USER = 'livetype_user_session_v1';
  const STORAGE_KEY_FRIENDS = 'livetype_friends_list_v1';
  const STORAGE_KEY_THEME = 'livetype_custom_theme_v1';

  // Default Theme Palette
  const DEFAULT_THEME = {
    primary: '#6366f1',
    accent: '#ec4899',
    bg: '#070a12',
    card: '#111827',
    text: '#f8fafc',
    radius: 14
  };

  const PRESET_THEMES = {
    neon: { primary: '#6366f1', accent: '#ec4899', bg: '#070a12', card: '#111827', text: '#f8fafc', radius: 14 },
    emerald: { primary: '#10b981', accent: '#14b8a6', bg: '#061611', card: '#0f291e', text: '#ecfdf5', radius: 12 },
    sunset: { primary: '#f43f5e', accent: '#f59e0b', bg: '#18070b', card: '#2b0e15', text: '#fff1f2', radius: 16 },
    amoled: { primary: '#38bdf8', accent: '#a855f7', bg: '#000000', card: '#0a0a0a', text: '#f0f9ff', radius: 8 }
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

  function generateNewUid() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const part = (len) => {
      let s = '';
      for (let i = 0; i < len; i++) {
        s += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return s;
    };
    return `${part(4)}-${part(4)}`;
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
  const btnEditProfile = document.getElementById('btnEditProfile');
  const btnLogout = document.getElementById('btnLogout');
  const connectionStatus = document.getElementById('connectionStatus');
  const btnInstallPwa = document.getElementById('btnInstallPwa');

  const sidebarPanel = document.getElementById('sidebarPanel');
  const myUidDisplay = document.getElementById('myUidDisplay');
  const btnCopyUid = document.getElementById('btnCopyUid');
  const btnCreateRoom = document.getElementById('btnCreateRoom');
  const btnEmptyCreateRoom = document.getElementById('btnEmptyCreateRoom');
  const formJoinRoom = document.getElementById('formJoinRoom');
  const inputRoomCode = document.getElementById('inputRoomCode');
  const formAddFriend = document.getElementById('formAddFriend');
  const inputFriendUid = document.getElementById('inputFriendUid');
  const btnRefreshFriends = document.getElementById('btnRefreshFriends');
  const friendsListContainer = document.getElementById('friendsListContainer');

  const roomEmptyState = document.getElementById('roomEmptyState');
  const roomActiveView = document.getElementById('roomActiveView');
  const activeRoomCodeEl = document.getElementById('activeRoomCode');
  const btnCopyRoomCode = document.getElementById('btnCopyRoomCode');
  const btnCopyRoomLink = document.getElementById('btnCopyRoomLink');
  const roomMemberCount = document.getElementById('roomMemberCount');
  const btnLeaveRoom = document.getElementById('btnLeaveRoom');
  const btnMobileToggleSidebar = document.getElementById('btnMobileToggleSidebar');
  const btnBackToSidebar = document.getElementById('btnBackToSidebar');
  const liveCardsGrid = document.getElementById('liveCardsGrid');
  const liveTypingInput = document.getElementById('liveTypingInput');
  const btnClearEnter = document.getElementById('btnClearEnter');
  const charCounter = document.getElementById('charCounter');
  const inputLiveImage = document.getElementById('inputLiveImage');
  const inputImagePreviewBar = document.getElementById('inputImagePreviewBar');
  const inputPreviewThumb = document.getElementById('inputPreviewThumb');
  const btnRemoveInputImage = document.getElementById('btnRemoveInputImage');
  const btnToggleGifPicker = document.getElementById('btnToggleGifPicker');
  const gifPickerPopover = document.getElementById('gifPickerPopover');
  const inputGifSearch = document.getElementById('inputGifSearch');
  const btnCloseGifPicker = document.getElementById('btnCloseGifPicker');
  const gifResultsGrid = document.getElementById('gifResultsGrid');

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
  const colorPickerText = document.getElementById('colorPickerText');
  const rangeRadius = document.getElementById('rangeRadius');
  const hexPrimary = document.getElementById('hexPrimary');
  const hexAccent = document.getElementById('hexAccent');
  const hexBg = document.getElementById('hexBg');
  const hexCard = document.getElementById('hexCard');
  const hexText = document.getElementById('hexText');

  // --- Topic Builders ---
  const topicInbox = (uid) => `${TOPIC_PREFIX}/inbox/${uid}`;
  const topicPresence = (uid) => `${TOPIC_PREFIX}/presence/${uid}`;
  const topicRoom = (code) => `${TOPIC_PREFIX}/room/${code}`;
  const topicDirectory = () => `${TOPIC_PREFIX}/directory`;

  // --- LocalStorage Helpers ---
  function loadUserSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_USER);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.uid && parsed.username) {
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
            if (f && f.uid) {
              map.set(f.uid, {
                uid: f.uid,
                username: f.username || f.uid,
                avatar: f.avatar || PRESET_AVATARS[0],
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

  function saveFriendsList() {
    const arr = Array.from(friendsMap.values()).map((f) => ({
      uid: f.uid,
      username: f.username,
      avatar: f.avatar
    }));
    localStorage.setItem(STORAGE_KEY_FRIENDS, JSON.stringify(arr));
  }

  // --- Toast Notification ---
  function showToast(message) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    toastContainer.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3000);
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
      mqttClient.subscribe(topicInbox(currentUser.uid), { qos: 0 });

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
      let data;
      try {
        data = JSON.parse(messageBuffer.toString());
      } catch (e) {
        return;
      }
      if (!data) return;

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
      if (activeRoomCode && isRoomPublic && currentUser && data.fromUid !== currentUser.uid) {
        broadcastActiveRoomToDirectory();
      }
      return;
    }

    // 2. Received an active room announcement
    if (data.type === 'room_announce' && data.roomCode) {
      discoveredRooms.set(data.roomCode, {
        roomCode: data.roomCode,
        hostUid: data.hostUid,
        hostName: data.hostName || 'ไม่ระบุชื่อ',
        hostAvatar: data.hostAvatar || PRESET_AVATARS[0],
        memberCount: data.memberCount || 1,
        tags: Array.isArray(data.tags) ? data.tags : [],
        updatedAt: Date.now()
      });
      if (!activeRoomCode) {
        renderDiscoveredRooms();
      }
      return;
    }

    // 3. Room closed or switched to private
    if (data.type === 'room_closed' && data.roomCode) {
      if (discoveredRooms.has(data.roomCode)) {
        discoveredRooms.delete(data.roomCode);
        if (!activeRoomCode) {
          renderDiscoveredRooms();
        }
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
      return;
    }

    scoredRooms.forEach((room) => {
      const card = document.createElement('div');
      card.className = `discover-room-card ${room.matchCount > 0 ? 'high-match' : ''}`;

      const matchBadgeHtml =
        room.matchCount > 0
          ? `<span class="match-score-pill">🎯 ตรงกับคุณ ${room.matchCount} Tag (${room.score}%)</span>`
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

      card.innerHTML = `
        <div class="discover-room-info">
          <div class="discover-room-top">
            <img src="${room.hostAvatar || PRESET_AVATARS[0]}" alt="Host" class="avatar-xs" />
            <span class="discover-room-title">ห้องของ <span class="host-name-text"></span></span>
            <span class="mono" style="font-size:0.75rem; color:#a5b4fc;">#${room.roomCode}</span>
            <span class="member-count-badge" style="font-size:0.7rem; padding:2px 8px;">👥 ${room.memberCount} คน</span>
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
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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

    // 1. Someone pinged us to check if we are online -> reply directly to their inbox & presence
    if (data.type === 'ping_status' && data.from && data.from.uid) {
      publishJson(topicInbox(data.from.uid), {
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
    if (data.type === 'pong_status' && data.from && data.from.uid) {
      updateFriendRecord(data.from.uid, {
        username: data.from.username,
        avatar: data.from.avatar,
        online: true,
        inRoom: Boolean(data.from.inRoom),
        roomCode: data.from.roomCode || null,
        lastSeen: Date.now()
      });
      return;
    }

    // 3. Incoming 1-on-1 or Group Room Invitation
    if (data.type === 'room_invite' && data.from && data.roomCode) {
      pendingInviteRoomCode = data.roomCode;
      inviteAvatar.src = data.from.avatar || PRESET_AVATARS[0];
      inviteUsername.textContent = data.from.username || data.from.uid;
      inviteUid.textContent = `UID: ${data.from.uid}`;
      inviteRoomCode.textContent = data.roomCode;
      inviteModal.classList.remove('hidden');

      // Auto-add inviter to friends list if not already added
      if (!friendsMap.has(data.from.uid)) {
        friendsMap.set(data.from.uid, {
          uid: data.from.uid,
          username: data.from.username,
          avatar: data.from.avatar,
          online: true,
          inRoom: true,
          roomCode: data.roomCode,
          lastSeen: Date.now()
        });
        if (mqttClient && mqttClient.connected) {
          mqttClient.subscribe(topicPresence(data.from.uid), { qos: 0 });
        }
        saveFriendsList();
        renderFriendsList();
      }
    }
  }

  function handlePresenceMessage(data) {
    if (!data || !data.uid || !friendsMap.has(data.uid)) return;
    updateFriendRecord(data.uid, {
      username: data.username,
      avatar: data.avatar,
      online: Boolean(data.online),
      inRoom: Boolean(data.inRoom),
      roomCode: data.roomCode || null,
      lastSeen: Date.now()
    });
  }

  function updateFriendRecord(uid, fields) {
    const f = friendsMap.get(uid);
    if (!f) return;
    if (fields.username) f.username = fields.username;
    if (fields.avatar) f.avatar = fields.avatar;
    f.online = fields.online;
    f.inRoom = fields.inRoom;
    f.roomCode = fields.roomCode;
    f.lastSeen = fields.lastSeen || Date.now();
    saveFriendsList();
    renderFriendsList();
  }

  function handleRoomMessage(data) {
    if (!currentUser || !activeRoomCode) return;
    if (!data || !data.uid) return;

    // Ignore our own echo for typing/clear since we already update locally immediately
    if (data.uid === currentUser.uid) return;

    if (data.type === 'member_join') {
      const isNew = !roomMembers.has(data.uid);
      roomMembers.set(data.uid, {
        uid: data.uid,
        username: data.username || data.uid,
        avatar: data.avatar || PRESET_AVATARS[0],
        tags: Array.isArray(data.tags) ? data.tags : [],
        currentText: data.currentText || '',
        updatedAt: Date.now()
      });
      renderAllLiveCards();
      if (isNew) {
        showToast(`👋 ${data.username} เข้ามาในห้อง`);
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
      broadcastActiveRoomToDirectory();
      return;
    }

    if (data.type === 'member_sync') {
      const existed = roomMembers.has(data.uid);
      roomMembers.set(data.uid, {
        uid: data.uid,
        username: data.username || data.uid,
        avatar: data.avatar || PRESET_AVATARS[0],
        tags: Array.isArray(data.tags) ? data.tags : [],
        currentText: data.currentText || '',
        image: data.image || null,
        updatedAt: Date.now()
      });
      if (!existed) {
        renderAllLiveCards();
        broadcastActiveRoomToDirectory();
      } else {
        updateSingleCardContent(data.uid, data.currentText || '', data.image || null);
      }
      return;
    }

    if (data.type === 'member_leave') {
      if (roomMembers.has(data.uid)) {
        const leftUser = roomMembers.get(data.uid);
        roomMembers.delete(data.uid);
        renderAllLiveCards();
        showToast(`🚪 ${leftUser.username} ออกจากห้อง`);
      }
      return;
    }

    if (data.type === 'typing_update') {
      if (!roomMembers.has(data.uid)) {
        // Auto-register member if they typed before join packet arrived
        roomMembers.set(data.uid, {
          uid: data.uid,
          username: data.username || data.uid,
          avatar: data.avatar || PRESET_AVATARS[0],
          currentText: data.text || '',
          image: data.image || null,
          updatedAt: Date.now()
        });
        renderAllLiveCards();
      } else {
        const m = roomMembers.get(data.uid);
        m.currentText = data.text || '';
        m.image = data.image !== undefined ? data.image : m.image;
        m.updatedAt = Date.now();
        updateSingleCardContent(data.uid, m.currentText, m.image);
      }
      return;
    }

    if (data.type === 'typing_clear') {
      if (roomMembers.has(data.uid)) {
        const m = roomMembers.get(data.uid);
        m.currentText = '';
        m.image = null;
        m.updatedAt = Date.now();
        updateSingleCardContent(data.uid, '', null);
        flashClearCard(data.uid);
      }
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

  // Resize uploaded image from user's device into a compact Data URL (110x110) so it transmits fast over P2P/MQTT
  inputCustomAvatar.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const size = 110;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const minSide = Math.min(img.width, img.height);
        const sx = (img.width - minSide) / 2;
        const sy = (img.height - minSide) / 2;
        ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
        selectedAvatar = canvas.toDataURL('image/jpeg', 0.78);
        setupAvatarPreview.src = selectedAvatar;
        document.querySelectorAll('.preset-avatar-btn').forEach((b) => b.classList.remove('selected'));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

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
      const val = inputCustomTag.value.trim();
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
    inputUsername.focus();
  }

  function showWorkspaceView() {
    viewSetup.classList.remove('active');
    viewWorkspace.classList.add('active');
    userChip.classList.remove('hidden');

    headerAvatar.src = currentUser.avatar;
    headerUsername.textContent = currentUser.username;
    headerUid.textContent = currentUser.uid;
    myUidDisplay.textContent = currentUser.uid;

    renderMySidebarTags();
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
    const name = inputUsername.value.trim();
    if (!name) return;

    const uid = currentUser && currentUser.uid ? currentUser.uid : generateNewUid();
    currentUser = {
      uid,
      username: name,
      avatar: selectedAvatar,
      tags: Array.from(selectedTags)
    };
    saveUserSession(currentUser);

    // If already in a room, update our profile inside the room
    if (activeRoomCode && roomMembers.has(uid)) {
      const m = roomMembers.get(uid);
      m.username = name;
      m.avatar = selectedAvatar;
      m.tags = Array.from(selectedTags);
      renderAllLiveCards();
      broadcastActiveRoomToDirectory();
    }

    showWorkspaceView();
  });

  btnEditProfile.addEventListener('click', () => {
    showSetupView();
  });

  // --- Logout (Destroys UID and Session) ---
  btnLogout.addEventListener('click', () => {
    if (!confirm('ต้องการออกจากระบบใช่หรือไม่? (UID ปัจจุบันและรายชื่อเพื่อนในเครื่องจะถูกล้างใหม่ทั้งหมด)')) {
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
    clearUserSession();
    currentUser = null;
    friendsMap.clear();
    activeRoomCode = null;
    roomMembers.clear();
    updateRoomViewUI();
    showSetupView();
    showToast('ออกจากระบบและล้าง UID เรียบร้อยแล้ว');
  });

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

  // --- Copy UID ---
  btnCopyUid.addEventListener('click', () => {
    if (!currentUser) return;
    navigator.clipboard.writeText(currentUser.uid).then(() => {
      showToast(`คัดลอก UID (${currentUser.uid}) แล้ว!`);
    });
  });

  // --- Friends System ---
  function renderFriendsList() {
    friendsListContainer.innerHTML = '';
    if (friendsMap.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'friend-empty';
      empty.innerHTML = 'ยังไม่มีเพื่อนในรายชื่อ<br>นำ UID ของเพื่อนมาใส่ด้านบนเพื่อแอดกันได้เลย!';
      friendsListContainer.appendChild(empty);
      return;
    }

    friendsMap.forEach((friend) => {
      const item = document.createElement('div');
      item.className = 'friend-item';

      const statusText = friend.online
        ? friend.inRoom
          ? `🟢 กำลังอยู่ในห้อง (${friend.roomCode})`
          : '🟢 ออนไลน์'
        : '⚪ ออฟไลน์';

      item.innerHTML = `
        <div class="friend-left">
          <div class="friend-avatar-wrap">
            <img src="${friend.avatar || PRESET_AVATARS[0]}" alt="Avatar" class="avatar-sm" />
            <span class="status-dot ${friend.online ? 'online' : ''}"></span>
          </div>
          <div class="friend-info">
            <div class="friend-name"></div>
            <div class="friend-meta mono">${friend.uid} • ${statusText}</div>
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
        if (mqttClient && mqttClient.connected) {
          mqttClient.unsubscribe(topicPresence(friend.uid));
        }
        friendsMap.delete(friend.uid);
        saveFriendsList();
        renderFriendsList();
      });

      friendsListContainer.appendChild(item);
    });
  }

  formAddFriend.addEventListener('submit', (e) => {
    e.preventDefault();
    const targetUid = inputFriendUid.value.trim().toUpperCase();
    if (!targetUid) return;
    if (currentUser && targetUid === currentUser.uid) {
      showToast('ไม่สามารถแอด UID ของตัวเองได้');
      return;
    }

    if (!friendsMap.has(targetUid)) {
      friendsMap.set(targetUid, {
        uid: targetUid,
        username: `เพื่อน (${targetUid})`,
        avatar: PRESET_AVATARS[1],
        online: false,
        inRoom: false,
        roomCode: null,
        lastSeen: 0
      });
    }
    saveFriendsList();
    renderFriendsList();

    if (mqttClient && mqttClient.connected) {
      mqttClient.subscribe(topicPresence(targetUid), { qos: 0 });
      pingFriend(targetUid);
    }

    inputFriendUid.value = '';
    showToast(`เพิ่มเพื่อน ${targetUid} แล้ว กำลังเช็คสถานะออนไลน์...`);
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
    const clean = String(code || '').trim().toUpperCase();
    if (!clean) return;

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
      updatedAt: Date.now()
    });

    liveTypingInput.value = '';
    charCounter.textContent = '0 ตัวอักษร';

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
    charCounter.textContent = '0 ตัวอักษร';
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

  // --- Room UI & Live Cards Rendering ---
  function updateRoomViewUI() {
    if (!activeRoomCode) {
      roomEmptyState.classList.remove('hidden');
      roomActiveView.classList.add('hidden');
      requestDirectoryScan();
      renderDiscoveredRooms();
      return;
    }
    roomEmptyState.classList.add('hidden');
    roomActiveView.classList.remove('hidden');
    activeRoomCodeEl.textContent = activeRoomCode;
    roomMemberCount.textContent = `${roomMembers.size} คนในห้อง`;
    setTimeout(() => liveTypingInput.focus(), 80);
  }

  function renderAllLiveCards() {
    liveCardsGrid.innerHTML = '';
    roomMemberCount.textContent = `${roomMembers.size} คนในห้อง`;
    const myTagsLower = new Set(Array.from(selectedTags).map((t) => t.toLowerCase()));

    // Always place currentUser card first
    const sortedMembers = Array.from(roomMembers.values()).sort((a, b) => {
      if (currentUser && a.uid === currentUser.uid) return -1;
      if (currentUser && b.uid === currentUser.uid) return 1;
      return (a.username || '').localeCompare(b.username || '');
    });

    sortedMembers.forEach((member) => {
      const isSelf = currentUser && member.uid === currentUser.uid;
      const hasContent = Boolean((member.currentText && member.currentText.length > 0) || member.image);
      const memberTags = Array.isArray(member.tags) ? member.tags : [];
      const tagsHtml = memberTags
        .slice(0, 5)
        .map((t) => {
          const isMatch = !isSelf && myTagsLower.has(String(t).toLowerCase());
          return `<span class="tag-badge-mini ${isMatch ? 'matched' : ''}">${isMatch ? '✓ ' : ''}${escapeHtml(t)}</span>`;
        })
        .join('');

      const card = document.createElement('div');
      card.id = `live-card-${member.uid}`;
      card.className = `live-card ${isSelf ? 'is-self' : ''} ${hasContent ? 'actively-typing' : ''}`;

      card.innerHTML = `
        <div class="live-card-header">
          <div class="live-card-user">
            <img src="${member.avatar || PRESET_AVATARS[0]}" alt="Avatar" class="avatar-md" />
            <div>
              <div class="live-card-username">
                <span class="name-text"></span>
                ${isSelf ? '<span class="self-tag">คุณ</span>' : ''}
              </div>
              <div class="live-card-uid mono">${member.uid}</div>
              ${tagsHtml ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">${tagsHtml}</div>` : ''}
            </div>
          </div>
          <span class="typing-status-pill ${hasContent ? 'active' : ''}" id="status-pill-${member.uid}">
            ${hasContent ? '⚡ กำลังส่งสด...' : 'รอพิมพ์...'}
          </span>
        </div>
        <div class="live-card-body" id="card-body-${member.uid}"></div>
      `;

      card.querySelector('.name-text').textContent = member.username;
      liveCardsGrid.appendChild(card);
      updateSingleCardContent(member.uid, member.currentText, member.image);
    });
  }

  function updateSingleCardContent(uid, text, image) {
    const bodyEl = document.getElementById(`card-body-${uid}`);
    const cardEl = document.getElementById(`live-card-${uid}`);
    const pillEl = document.getElementById(`status-pill-${uid}`);
    if (!bodyEl || !cardEl || !pillEl) return;

    bodyEl.innerHTML = '';
    const hasText = Boolean(text && text.length > 0);
    const hasImage = Boolean(image);

    if (hasText || hasImage) {
      cardEl.classList.add('actively-typing');
      pillEl.classList.add('active');
      pillEl.textContent = '⚡ กำลังส่งสด...';

      if (hasImage) {
        const imgWrap = document.createElement('div');
        imgWrap.className = 'live-card-image-wrap';
        const imgEl = document.createElement('img');
        imgEl.src = image;
        imgEl.alt = 'Live image';
        imgEl.className = 'live-card-img';
        imgWrap.appendChild(imgEl);
        bodyEl.appendChild(imgWrap);
      }

      if (hasText) {
        const textSpan = document.createElement('span');
        textSpan.textContent = text;
        const cursorSpan = document.createElement('span');
        cursorSpan.className = 'live-cursor';
        bodyEl.appendChild(textSpan);
        bodyEl.appendChild(cursorSpan);
      } else if (!hasImage) {
        const cursorSpan = document.createElement('span');
        cursorSpan.className = 'live-cursor';
        bodyEl.appendChild(cursorSpan);
      }

      bodyEl.scrollTop = bodyEl.scrollHeight;
    } else {
      cardEl.classList.remove('actively-typing');
      pillEl.classList.remove('active');
      pillEl.textContent = 'รอพิมพ์...';

      const placeholder = document.createElement('span');
      placeholder.className = 'live-card-placeholder';
      placeholder.textContent = 'กำลังรอพิมพ์ข้อความหรือส่งรูป... (กด Enter เมื่อต้องการล้างทั้งหมด)';
      bodyEl.appendChild(placeholder);
    }
  }

  function flashClearCard(uid) {
    const cardEl = document.getElementById(`live-card-${uid}`);
    if (!cardEl) return;
    cardEl.classList.remove('flash-cleared');
    void cardEl.offsetWidth;
    cardEl.classList.add('flash-cleared');
  }

  // --- Realtime Live Input, Image & GIF Handling ---
  function showInputImagePreview(dataOrUrl) {
    inputPreviewThumb.src = dataOrUrl;
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
      updateSingleCardContent(currentUser.uid, myMem.currentText, currentImage);
    }

    publishJson(topicRoom(activeRoomCode), {
      type: 'typing_update',
      uid: currentUser.uid,
      username: currentUser.username,
      avatar: currentUser.avatar,
      text: liveTypingInput.value,
      image: currentImage
    });

    if (labelMsg) showToast(labelMsg);
  }

  function processImageFile(file) {
    if (!file) return;
    if (!activeRoomCode) {
      showToast('กรุณาสร้างหรือเข้าห้องแชทก่อนส่งรูปภาพ/GIF');
      inputLiveImage.value = '';
      return;
    }

    // Preserve animated GIFs directly if under 1.2MB
    if (file.type === 'image/gif') {
      if (file.size > 1250000) {
        showToast('⚠️ ไฟล์ GIF มีขนาดใหญ่เกิน 1.2MB กรุณาใช้ปุ่ม 👾 GIF หรือเลือกไฟล์ที่เล็กลง');
        inputLiveImage.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        setAndBroadcastLiveMedia(ev.target.result, '👾 ส่งภาพดุ๊กดิ๊ก GIF สดแล้ว! (กด Enter เพื่อล้าง)');
      };
      reader.readAsDataURL(file);
      return;
    }

    // Standard static image -> compress for instant transmission
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxDim = 800;
        let width = img.width;
        let height = img.height;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.72);
        setAndBroadcastLiveMedia(compressedDataUrl, '📷 ส่งรูปภาพสดให้ทุกคนในห้องแล้ว (กด Enter เพื่อล้าง)');
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
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

  // --- Built-in GIF & Sticker Search Powered by KLIPY.com ---
  const KLIPY_API_BASE = 'https://api.klipy.com/api/v1/pmpZyPifwSulBfELHCbpaOllUfgsjqt9yeImc2XWIcHSWjnAUBw9oueRf4kD5r25';
  let activeKlipyType = 'gifs'; // 'gifs' or 'stickers'
  let activeKlipyQuery = 'trending';
  let gifSearchTimer = null;

  function extractKlipyUrls(item) {
    const f = item && (item.file || item.files);
    if (!f) return null;

    // KLIPY v1 structure: file.{xs, sm, md, hd}.{gif, webp}
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

  async function fetchGifs(query) {
    gifResultsGrid.innerHTML = '<div class="gif-empty-status">⏳ กำลังดึงข้อมูลจาก KLIPY.com...</div>';
    const cleanQuery = (query || '').trim();
    activeKlipyQuery = cleanQuery || 'trending';

    // Direct URL support if user pastes a link
    if (/^https?:\/\/.+\.(gif|webp|png|jpg|jpeg)(\?.*)?$/i.test(cleanQuery)) {
      gifResultsGrid.innerHTML = '';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gif-item-btn';
      btn.style.gridColumn = '1 / -1';
      btn.style.height = '140px';
      const img = document.createElement('img');
      img.src = cleanQuery;
      btn.appendChild(img);
      btn.addEventListener('click', () => {
        setAndBroadcastLiveMedia(cleanQuery, '👾 ส่งลิงก์ GIF สดแล้ว! (กด Enter เพื่อล้าง)');
        gifPickerPopover.classList.add('hidden');
      });
      gifResultsGrid.appendChild(btn);
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

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'gif-item-btn';
        const img = document.createElement('img');
        img.src = urls.previewUrl;
        img.loading = 'lazy';
        img.alt = item.title || item.slug || 'KLIPY GIF';
        btn.appendChild(img);

        btn.addEventListener('click', () => {
          setAndBroadcastLiveMedia(
            urls.fullUrl,
            `👾 ส่ง ${activeKlipyType === 'stickers' ? 'Sticker' : 'GIF'} จาก KLIPY สดแล้ว! (กด Enter เพื่อล้าง)`
          );
          gifPickerPopover.classList.add('hidden');
          liveTypingInput.focus();
        });

        gifResultsGrid.appendChild(btn);
      });
    } catch (err) {
      gifResultsGrid.innerHTML =
        '<div class="gif-empty-status">ไม่สามารถเชื่อมต่อ KLIPY.com ได้ในขณะนี้ สามารถวางลิงก์ .gif ลงในช่องค้นหาด้านบนได้โดยตรง</div>';
    }
  }

  btnToggleGifPicker.addEventListener('click', () => {
    if (!activeRoomCode) {
      showToast('กรุณาสร้างหรือเข้าห้องแชทก่อนส่ง GIF');
      return;
    }
    const isHidden = gifPickerPopover.classList.contains('hidden');
    if (isHidden) {
      gifPickerPopover.classList.remove('hidden');
      inputGifSearch.focus();
      if (gifResultsGrid.children.length === 0) {
        fetchGifs('trending');
      }
    } else {
      gifPickerPopover.classList.add('hidden');
    }
  });

  btnCloseGifPicker.addEventListener('click', () => {
    gifPickerPopover.classList.add('hidden');
  });

  inputGifSearch.addEventListener('input', () => {
    if (gifSearchTimer) clearTimeout(gifSearchTimer);
    gifSearchTimer = setTimeout(() => {
      fetchGifs(inputGifSearch.value);
    }, 350);
  });

  document.querySelectorAll('.btn-gif-type').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-gif-type').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeKlipyType = btn.getAttribute('data-type') || 'gifs';
      fetchGifs(inputGifSearch.value || activeKlipyQuery);
    });
  });

  document.querySelectorAll('.btn-gif-cat').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-gif-cat').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const q = btn.getAttribute('data-query');
      inputGifSearch.value = q === 'trending' ? '' : q;
      fetchGifs(q);
    });
  });

  btnRemoveInputImage.addEventListener('click', () => {
    currentImage = null;
    hideInputImagePreview();
    if (currentUser && roomMembers.has(currentUser.uid)) {
      const myMem = roomMembers.get(currentUser.uid);
      myMem.image = null;
      updateSingleCardContent(currentUser.uid, myMem.currentText, null);
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
    const currentText = liveTypingInput.value;
    charCounter.textContent = `${currentText.length} ตัวอักษร`;

    if (roomMembers.has(currentUser.uid)) {
      const myMem = roomMembers.get(currentUser.uid);
      myMem.currentText = currentText;
      updateSingleCardContent(currentUser.uid, currentText, myMem.image);
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
    liveTypingInput.value = '';
    charCounter.textContent = '0 ตัวอักษร';
    hideInputImagePreview();

    if (roomMembers.has(currentUser.uid)) {
      const myMem = roomMembers.get(currentUser.uid);
      myMem.currentText = '';
      myMem.image = null;
      updateSingleCardContent(currentUser.uid, '', null);
      flashClearCard(currentUser.uid);
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
  function loadCustomTheme() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_THEME);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { ...DEFAULT_THEME };
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    root.style.setProperty('--primary', theme.primary);
    root.style.setProperty('--primary-hover', theme.primary);
    root.style.setProperty('--accent', theme.accent);
    root.style.setProperty('--bg-dark', theme.bg);
    root.style.setProperty('--bg-panel', hexToRgba(theme.card, 0.85));
    root.style.setProperty('--bg-card', hexToRgba(theme.card, 0.7));
    root.style.setProperty('--bg-card-self', hexToRgba(theme.primary, 0.16));
    root.style.setProperty('--text-main', theme.text);
    root.style.setProperty('--radius-lg', `${theme.radius + 4}px`);
    root.style.setProperty('--radius-md', `${theme.radius}px`);
    root.style.setProperty('--radius-sm', `${Math.max(4, theme.radius - 4)}px`);

    // Sync input controls
    if (colorPickerPrimary) {
      colorPickerPrimary.value = theme.primary;
      hexPrimary.textContent = theme.primary;
      colorPickerAccent.value = theme.accent;
      hexAccent.textContent = theme.accent;
      colorPickerBg.value = theme.bg;
      hexBg.textContent = theme.bg;
      colorPickerCard.value = theme.card;
      hexCard.textContent = theme.card;
      colorPickerText.value = theme.text;
      hexText.textContent = theme.text;
      rangeRadius.value = theme.radius;
    }

    localStorage.setItem(STORAGE_KEY_THEME, JSON.stringify(theme));
  }

  function hexToRgba(hex, alpha) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
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
    activeTheme = { ...DEFAULT_THEME };
    applyTheme(activeTheme);
    showToast('รีเซ็ตธีมกลับเป็นค่าเริ่มต้นแล้ว');
  });

  // Color picker events
  colorPickerPrimary.addEventListener('input', (e) => {
    activeTheme.primary = e.target.value;
    applyTheme(activeTheme);
  });
  colorPickerAccent.addEventListener('input', (e) => {
    activeTheme.accent = e.target.value;
    applyTheme(activeTheme);
  });
  colorPickerBg.addEventListener('input', (e) => {
    activeTheme.bg = e.target.value;
    applyTheme(activeTheme);
  });
  colorPickerCard.addEventListener('input', (e) => {
    activeTheme.card = e.target.value;
    applyTheme(activeTheme);
  });
  colorPickerText.addEventListener('input', (e) => {
    activeTheme.text = e.target.value;
    applyTheme(activeTheme);
  });
  rangeRadius.addEventListener('input', (e) => {
    activeTheme.radius = parseInt(e.target.value, 10);
    applyTheme(activeTheme);
  });

  // Preset theme buttons
  document.querySelectorAll('.btn-preset-theme').forEach((btn) => {
    btn.addEventListener('click', () => {
      const themeKey = btn.getAttribute('data-theme');
      if (PRESET_THEMES[themeKey]) {
        activeTheme = { ...PRESET_THEMES[themeKey] };
        applyTheme(activeTheme);
        showToast(`สลับไปใช้ธีม ${btn.textContent.trim()} แล้ว`);
      }
    });
  });
})();
