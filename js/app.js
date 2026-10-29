(() => {
  /**
   * LiveType — 100% Serverless Realtime Live-Typing Chat (PWA)
   * Works on GitHub Pages, Cloudflare Pages, Vercel, Netlify, or Localhost
   * without renting or running any backend server!
   */

  // Storage Keys (Session persists until explicit Logout)
  const STORAGE_KEY_USER = 'livetype_user_session_v1';
  const STORAGE_KEY_FRIENDS = 'livetype_friends_list_v1';

  // Topic prefix for public WebSocket relay (Ephemeral QoS 0, retain: false -> zero history stored)
  const TOPIC_PREFIX = 'livetype_zero_history_v1_9f8a7b';

  // Public Secure WebSocket Brokers (Automatic failover)
  const BROKER_URLS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
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
  let currentUser = loadUserSession(); // { uid, username, avatar } or null
  let selectedAvatar = currentUser ? currentUser.avatar : PRESET_AVATARS[0];
  let friendsMap = loadFriendsList(); // Map<uid, { uid, username, avatar, online, inRoom, roomCode, lastSeen }>
  let activeRoomCode = null;
  let roomMembers = new Map(); // Map<uid, { uid, username, avatar, currentText, updatedAt }>
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

  const inviteModal = document.getElementById('inviteModal');
  const inviteAvatar = document.getElementById('inviteAvatar');
  const inviteUsername = document.getElementById('inviteUsername');
  const inviteUid = document.getElementById('inviteUid');
  const inviteRoomCode = document.getElementById('inviteRoomCode');
  const btnAcceptInvite = document.getElementById('btnAcceptInvite');
  const btnDeclineInvite = document.getElementById('btnDeclineInvite');
  const toastContainer = document.getElementById('toastContainer');

  // --- Topic Builders ---
  const topicInbox = (uid) => `${TOPIC_PREFIX}/inbox/${uid}`;
  const topicPresence = (uid) => `${TOPIC_PREFIX}/presence/${uid}`;
  const topicRoom = (code) => `${TOPIC_PREFIX}/room/${code}`;

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

      // 2. Subscribe to all friends' presence channels
      friendsMap.forEach((_, friendUid) => {
        mqttClient.subscribe(topicPresence(friendUid), { qos: 0 });
      });

      // 3. Re-subscribe to active room if currently in one
      if (activeRoomCode) {
        mqttClient.subscribe(topicRoom(activeRoomCode), { qos: 0 });
        broadcastRoomJoin();
      }

      // 4. Broadcast our online status & ping all friends for their live status
      broadcastMyPresence(true);
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
      } else if (topic.startsWith(`${TOPIC_PREFIX}/presence/`)) {
        handlePresenceMessage(data);
      } else if (activeRoomCode && topic === topicRoom(activeRoomCode)) {
        handleRoomMessage(data);
      }
    });

    // Periodic heartbeat so friends know we're still online
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (mqttClient && mqttClient.connected && currentUser) {
        broadcastMyPresence(true);
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
    }, 25000);
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
      online: Boolean(isOnline),
      inRoom: Boolean(isOnline && activeRoomCode),
      roomCode: isOnline ? activeRoomCode : null,
      ts: Date.now()
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
        currentText: myMember ? myMember.currentText : liveTypingInput.value,
        image: myMember ? myMember.image : currentImage
      });
      return;
    }

    if (data.type === 'member_sync') {
      const existed = roomMembers.has(data.uid);
      roomMembers.set(data.uid, {
        uid: data.uid,
        username: data.username || data.uid,
        avatar: data.avatar || PRESET_AVATARS[0],
        currentText: data.currentText || '',
        image: data.image || null,
        updatedAt: Date.now()
      });
      if (!existed) {
        renderAllLiveCards();
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

  // --- Views Navigation ---
  function showSetupView() {
    viewSetup.classList.add('active');
    viewWorkspace.classList.remove('active');
    userChip.classList.add('hidden');

    if (currentUser) {
      inputUsername.value = currentUser.username;
      selectedAvatar = currentUser.avatar || PRESET_AVATARS[0];
      existingUidNotice.classList.remove('hidden');
      setupUidText.textContent = currentUser.uid;
    } else {
      inputUsername.value = '';
      selectedAvatar = PRESET_AVATARS[0];
      existingUidNotice.classList.add('hidden');
    }
    initAvatarPicker();
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

    renderFriendsList();
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
      avatar: selectedAvatar
    };
    saveUserSession(currentUser);

    // If already in a room, update our profile inside the room
    if (activeRoomCode && roomMembers.has(uid)) {
      const m = roomMembers.get(uid);
      m.username = name;
      m.avatar = selectedAvatar;
      renderAllLiveCards();
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
      currentText: myMember ? myMember.currentText : ''
    });
  }

  function leaveCurrentRoomSilent() {
    if (!activeRoomCode || !currentUser) return;
    publishJson(topicRoom(activeRoomCode), {
      type: 'member_leave',
      uid: currentUser.uid
    });
    if (mqttClient && mqttClient.connected) {
      mqttClient.unsubscribe(topicRoom(activeRoomCode));
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
      currentText: '',
      image: null,
      updatedAt: Date.now()
    });

    liveTypingInput.value = '';
    charCounter.textContent = '0 ตัวอักษร';

    if (mqttClient && mqttClient.connected) {
      mqttClient.subscribe(topicRoom(activeRoomCode), { qos: 0 }, () => {
        broadcastRoomJoin();
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

    // Always place currentUser card first
    const sortedMembers = Array.from(roomMembers.values()).sort((a, b) => {
      if (currentUser && a.uid === currentUser.uid) return -1;
      if (currentUser && b.uid === currentUser.uid) return 1;
      return (a.username || '').localeCompare(b.username || '');
    });

    sortedMembers.forEach((member) => {
      const isSelf = currentUser && member.uid === currentUser.uid;
      const hasContent = Boolean((member.currentText && member.currentText.length > 0) || member.image);

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

  // --- Realtime Live Input & Image Handling ---
  function showInputImagePreview(dataUrl) {
    inputPreviewThumb.src = dataUrl;
    inputImagePreviewBar.classList.remove('hidden');
  }

  function hideInputImagePreview() {
    inputPreviewThumb.src = '';
    inputImagePreviewBar.classList.add('hidden');
    inputLiveImage.value = '';
    currentImage = null;
  }

  // Handle Image Upload & Compression for Instant Zero-Lag P2P/MQTT Relay
  inputLiveImage.addEventListener('change', (e) => {
    if (!activeRoomCode) {
      showToast('กรุณาสร้างหรือเข้าห้องแชทก่อนส่งรูปภาพ');
      inputLiveImage.value = '';
      return;
    }
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        // Optimize & resize image so it sends instantly over public relay
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

        currentImage = canvas.toDataURL('image/jpeg', 0.72);
        showInputImagePreview(currentImage);

        // Update own card immediately
        if (currentUser && roomMembers.has(currentUser.uid)) {
          const myMem = roomMembers.get(currentUser.uid);
          myMem.image = currentImage;
          updateSingleCardContent(currentUser.uid, myMem.currentText, currentImage);
        }

        // Broadcast to everyone in room immediately
        publishJson(topicRoom(activeRoomCode), {
          type: 'typing_update',
          uid: currentUser.uid,
          username: currentUser.username,
          avatar: currentUser.avatar,
          text: liveTypingInput.value,
          image: currentImage
        });

        showToast('📷 ส่งรูปภาพสดให้ทุกคนในห้องแล้ว (กด Enter เพื่อล้าง)');
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
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
})();
