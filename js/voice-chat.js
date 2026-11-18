/*
 * LiveType Voice Chat Engine (Group Voice Room)
 * ------------------------------------------------------------
 * - WebRTC full-mesh audio between room members who joined voice
 * - Signaling: room broadcast (voice_join / voice_leave / voice_state)
 *              + unicast inbox (voice_offer / voice_answer / voice_candidate)
 * - Zero-history: audio flows peer-to-peer only, nothing is recorded or stored
 * - Features: open mic + mute toggle, speaking indicator, per-member volume 0-200%,
 *             browser noise suppression / echo cancellation / auto gain
 */
(function () {
  'use strict';

  const MAX_VOICE_MEMBERS = 8;
  const STORAGE_KEY_VOLUMES = 'livetype_voice_volumes_v1';
  const SPEAKING_THRESHOLD = 0.035; // RMS level (0..1) considered "speaking"
  const SPEAKING_HOLD_MS = 350; // keep ring lit briefly after speech stops (no flicker)
  const PEER_RETRY_MS = 9000; // re-offer if a link has not connected in this time
  const ANNOUNCE_INTERVAL_MS = 15000; // periodic voice_state so dropped QoS0 packets self-heal

  let ctx = null; // config from app.js
  let inVoice = false;
  let isJoining = false;
  let isMuted = false;
  let localStream = null;
  let audioCtx = null;
  let localAnalyser = null;
  let localSourceNode = null;
  let speakingLoopTimer = null;
  let announceTimer = null;

  // uid -> { username, muted, lastSeen }
  const voiceMembers = new Map();
  // uid -> { pc, isOfferer, pendingCandidates, audioEl, sourceNode, gainNode, analyser, retryTimer, connected }
  const peers = new Map();
  // uid -> speaking boolean (includes self)
  const speakingState = new Map();
  const speakingLastLoudAt = new Map();

  let memberVolumes = loadVolumes();

  let btnToggleVoice = null;
  let btnVoiceMute = null;

  // ---------- Helpers ----------
  function loadVolumes() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_VOLUMES);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch (e) {}
    return {};
  }

  function saveVolumes() {
    try {
      localStorage.setItem(STORAGE_KEY_VOLUMES, JSON.stringify(memberVolumes));
    } catch (e) {}
  }

  function myUid() {
    return ctx && ctx.getCurrentUser() ? ctx.getCurrentUser().uid : '';
  }

  function cleanUid(uid) {
    return ctx && uid ? ctx.sanitizeUid(String(uid)) : '';
  }

  function roomCode() {
    return ctx ? ctx.getActiveRoomCode() : null;
  }

  function isRoomMember(uid) {
    const members = ctx ? ctx.getRoomMembers() : null;
    return Boolean(members && members.has(uid));
  }

  function toast(msg) {
    if (ctx && ctx.showToast) ctx.showToast(msg);
  }

  function notifyChange() {
    updateToolbarButtons();
    if (ctx && typeof ctx.onStateChange === 'function') ctx.onStateChange();
  }

  function getAudioCtx() {
    if (!audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (AudioCtxClass) audioCtx = new AudioCtxClass();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function broadcastRoom(payload) {
    const code = roomCode();
    if (!ctx || !code) return;
    ctx.publishJson(ctx.topicRoom(code), payload);
  }

  function sendDirect(targetUid, payload) {
    if (!ctx) return;
    const me = ctx.getCurrentUser();
    if (!me) return;
    ctx.publishJson(ctx.topicInbox(targetUid), Object.assign({ fromUid: me.uid, targetUid, roomCode: roomCode() }, payload));
  }

  function buildStatePayload(type) {
    const me = ctx.getCurrentUser();
    return {
      type,
      uid: me.uid,
      username: me.username,
      muted: isMuted,
      inVoice
    };
  }

  // ---------- Toolbar UI ----------
  function updateToolbarButtons() {
    if (btnToggleVoice) {
      const icon = btnToggleVoice.querySelector('.voice-icon');
      const text = btnToggleVoice.querySelector('.voice-text');
      const others = Array.from(voiceMembers.keys()).filter((u) => u !== myUid()).length;
      btnToggleVoice.classList.toggle('in-voice', inVoice);
      btnToggleVoice.classList.toggle('has-voice', !inVoice && others > 0);
      btnToggleVoice.disabled = isJoining;
      if (inVoice) {
        if (icon) icon.textContent = '📞';
        if (text) text.textContent = 'ออกเสียง';
        btnToggleVoice.title = 'ออกจากห้องเสียง';
      } else {
        if (icon) icon.textContent = '🎧';
        if (text) text.textContent = others > 0 ? `คุยเสียง (${others})` : 'คุยเสียง';
        btnToggleVoice.title = others > 0 ? `มี ${others} คนอยู่ในห้องเสียง (คลิกเพื่อเข้าร่วม)` : 'เข้าห้องคุยด้วยเสียงกับเพื่อนในห้อง';
      }
    }
    if (btnVoiceMute) {
      btnVoiceMute.classList.toggle('hidden', !inVoice);
      btnVoiceMute.classList.toggle('is-muted', isMuted);
      const icon = btnVoiceMute.querySelector('.voice-icon');
      const text = btnVoiceMute.querySelector('.voice-text');
      if (icon) icon.textContent = isMuted ? '🔇' : '🎙️';
      if (text) text.textContent = isMuted ? 'ไมค์ปิด' : 'ไมค์เปิด';
      btnVoiceMute.title = isMuted ? 'เปิดไมค์' : 'ปิดไมค์';
    }
  }

  function bindDOM() {
    btnToggleVoice = document.getElementById('btnToggleVoice');
    btnVoiceMute = document.getElementById('btnVoiceMute');
    if (btnToggleVoice && !btnToggleVoice.dataset.voiceBound) {
      btnToggleVoice.dataset.voiceBound = '1';
      btnToggleVoice.addEventListener('click', () => {
        if (inVoice) leave();
        else join();
      });
    }
    if (btnVoiceMute && !btnVoiceMute.dataset.voiceBound) {
      btnVoiceMute.dataset.voiceBound = '1';
      btnVoiceMute.addEventListener('click', () => toggleMute());
    }
    updateToolbarButtons();
  }

  // ---------- Join / Leave ----------
  async function join() {
    if (inVoice || isJoining || !ctx) return;
    if (!roomCode()) {
      toast('⚠️ ต้องเข้าห้องก่อนจึงจะคุยเสียงได้');
      return;
    }
    const othersInVoice = Array.from(voiceMembers.keys()).filter((u) => u !== myUid()).length;
    if (othersInVoice >= MAX_VOICE_MEMBERS - 1) {
      toast(`⚠️ ห้องเสียงเต็มแล้ว (สูงสุด ${MAX_VOICE_MEMBERS} คน)`);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('❌ เบราว์เซอร์นี้ไม่รองรับการใช้ไมโครโฟน (ต้องเปิดผ่าน HTTPS หรือ localhost)');
      return;
    }

    isJoining = true;
    updateToolbarButtons();
    getAudioCtx(); // unlock audio on this user gesture

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      });
    } catch (err) {
      isJoining = false;
      updateToolbarButtons();
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
        toast('🎙️ ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน (กดอนุญาตที่แถบที่อยู่ของเบราว์เซอร์)');
      } else if (err && err.name === 'NotFoundError') {
        toast('🎙️ ไม่พบไมโครโฟนในเครื่องนี้');
      } else {
        toast('❌ เปิดไมโครโฟนไม่สำเร็จ');
      }
      return;
    }

    // Room may have been left while the permission prompt was open
    if (!roomCode()) {
      stopLocalStream();
      isJoining = false;
      updateToolbarButtons();
      return;
    }

    isJoining = false;
    inVoice = true;
    isMuted = false;
    const me = ctx.getCurrentUser();
    voiceMembers.set(me.uid, { username: me.username, muted: false, lastSeen: Date.now() });
    attachLocalAnalyser();
    startSpeakingLoop();
    startAnnounceLoop();

    broadcastRoom(buildStatePayload('voice_join'));
    // Connect to everyone already known to be in voice
    voiceMembers.forEach((m, uid) => {
      if (uid !== me.uid) ensurePeer(uid);
    });

    if (ctx.playNotificationSound) {
      try { ctx.playNotificationSound('voice_join'); } catch (e) {}
    }
    toast('🎧 เข้าห้องเสียงแล้ว ไมค์เปิดอยู่');
    notifyChange();
  }

  function leave(opts) {
    const silent = Boolean(opts && opts.silent);
    if (!inVoice && !isJoining) {
      return;
    }
    const wasInVoice = inVoice;
    inVoice = false;
    isJoining = false;
    isMuted = false;

    if (wasInVoice && ctx && ctx.getCurrentUser()) {
      const payload = { type: 'voice_leave', uid: myUid() };
      broadcastRoom(payload);
      setTimeout(() => broadcastRoom(payload), 40);
    }

    Array.from(peers.keys()).forEach((uid) => closePeer(uid));
    stopLocalStream();
    stopSpeakingLoop();
    stopAnnounceLoop();
    voiceMembers.delete(myUid());
    speakingState.clear();
    speakingLastLoudAt.clear();
    if (wasInVoice && !silent) toast('📞 ออกจากห้องเสียงแล้ว');
    notifyChange();
  }

  // Called by app.js when we leave/switch the text room: drop all voice knowledge of that room
  function resetForRoomExit() {
    leave({ silent: true });
    voiceMembers.clear();
    notifyChange();
  }

  function toggleMute(forceValue) {
    if (!inVoice || !localStream) return;
    isMuted = typeof forceValue === 'boolean' ? forceValue : !isMuted;
    localStream.getAudioTracks().forEach((t) => {
      t.enabled = !isMuted;
    });
    const me = voiceMembers.get(myUid());
    if (me) me.muted = isMuted;
    if (isMuted) setSpeaking(myUid(), false);
    broadcastRoom(buildStatePayload('voice_state'));
    notifyChange();
  }

  function stopLocalStream() {
    if (localSourceNode) {
      try { localSourceNode.disconnect(); } catch (e) {}
      localSourceNode = null;
    }
    localAnalyser = null;
    if (localStream) {
      localStream.getTracks().forEach((t) => {
        try { t.stop(); } catch (e) {}
      });
      localStream = null;
    }
  }

  function startAnnounceLoop() {
    stopAnnounceLoop();
    announceTimer = setInterval(() => {
      if (inVoice) broadcastRoom(buildStatePayload('voice_state'));
      pruneStaleVoiceMembers();
    }, ANNOUNCE_INTERVAL_MS);
  }

  function stopAnnounceLoop() {
    if (announceTimer) {
      clearInterval(announceTimer);
      announceTimer = null;
    }
  }

  function pruneStaleVoiceMembers() {
    let changed = false;
    voiceMembers.forEach((m, uid) => {
      if (uid === myUid()) return;
      if (!isRoomMember(uid)) {
        voiceMembers.delete(uid);
        closePeer(uid);
        changed = true;
      }
    });
    if (changed) notifyChange();
  }

  // Re-announce our voice presence (e.g. a newcomer just joined the text room)
  function announce() {
    if (inVoice) broadcastRoom(buildStatePayload('voice_state'));
  }

  // ---------- Peer Connections ----------
  function ensurePeer(uid) {
    if (!inVoice || !localStream || !uid || uid === myUid()) return;
    if (peers.has(uid)) return;
    // Deterministic offerer (smaller uid) avoids offer glare
    if (myUid() < uid) {
      createPeer(uid, true);
      makeOffer(uid);
    }
    // Otherwise wait for their offer; they will create it once they see us in voice
  }

  function createPeer(uid, isOfferer) {
    closePeer(uid);
    const pc = new RTCPeerConnection(ctx.rtcConfig);
    const peer = {
      pc,
      isOfferer,
      pendingCandidates: [],
      audioEl: null,
      sourceNode: null,
      gainNode: null,
      analyser: null,
      retryTimer: null,
      connected: false
    };
    peers.set(uid, peer);

    if (localStream) {
      localStream.getAudioTracks().forEach((track) => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendDirect(uid, { type: 'voice_candidate', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
      }
    };

    pc.ontrack = (e) => {
      const stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      attachRemoteAudio(uid, stream);
    };

    pc.onconnectionstatechange = () => {
      const p = peers.get(uid);
      if (!p || p.pc !== pc) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        p.connected = true;
        if (p.retryTimer) {
          clearTimeout(p.retryTimer);
          p.retryTimer = null;
        }
      } else if (st === 'failed') {
        p.connected = false;
        scheduleRetry(uid, 1500);
      } else if (st === 'disconnected') {
        p.connected = false;
        scheduleRetry(uid, 5000);
      }
    };

    scheduleRetry(uid, PEER_RETRY_MS);
    return peer;
  }

  function scheduleRetry(uid, delay) {
    const p = peers.get(uid);
    if (!p) return;
    if (p.retryTimer) clearTimeout(p.retryTimer);
    p.retryTimer = setTimeout(() => {
      const cur = peers.get(uid);
      if (!cur || cur.connected || !inVoice) return;
      if (!voiceMembers.has(uid)) {
        closePeer(uid);
        return;
      }
      closePeer(uid);
      if (myUid() < uid) {
        createPeer(uid, true);
        makeOffer(uid);
      } else {
        // Ask the offerer side to retry by re-announcing ourselves directly
        sendDirect(uid, { type: 'voice_reconnect' });
      }
    }, delay);
  }

  async function makeOffer(uid) {
    const p = peers.get(uid);
    if (!p) return;
    try {
      const offer = await p.pc.createOffer({ offerToReceiveAudio: true });
      await p.pc.setLocalDescription(offer);
      sendDirect(uid, { type: 'voice_offer', sdp: p.pc.localDescription.sdp });
    } catch (err) {
      console.warn('[Voice] createOffer failed', err);
    }
  }

  function closePeer(uid) {
    const p = peers.get(uid);
    if (!p) return;
    peers.delete(uid);
    if (p.retryTimer) clearTimeout(p.retryTimer);
    try { p.pc.ontrack = null; p.pc.onicecandidate = null; p.pc.onconnectionstatechange = null; } catch (e) {}
    try { p.pc.close(); } catch (e) {}
    if (p.sourceNode) {
      try { p.sourceNode.disconnect(); } catch (e) {}
    }
    if (p.gainNode) {
      try { p.gainNode.disconnect(); } catch (e) {}
    }
    if (p.audioEl) {
      try {
        p.audioEl.pause();
        p.audioEl.srcObject = null;
        p.audioEl.remove();
      } catch (e) {}
    }
    speakingState.delete(uid);
    speakingLastLoudAt.delete(uid);
  }

  async function flushCandidates(p) {
    const list = p.pendingCandidates.splice(0);
    for (const c of list) {
      try { await p.pc.addIceCandidate(c); } catch (e) {}
    }
  }

  // ---------- Audio Graph ----------
  function attachLocalAnalyser() {
    const ac = getAudioCtx();
    if (!ac || !localStream) return;
    try {
      localSourceNode = ac.createMediaStreamSource(localStream);
      localAnalyser = ac.createAnalyser();
      localAnalyser.fftSize = 512;
      localSourceNode.connect(localAnalyser); // analyse only — never routed to speakers (no self-echo)
    } catch (e) {
      localAnalyser = null;
    }
  }

  function attachRemoteAudio(uid, stream) {
    const p = peers.get(uid);
    if (!p) return;

    if (!p.audioEl) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.playsInline = true;
      el.setAttribute('data-voice-uid', uid);
      el.style.display = 'none';
      document.body.appendChild(el);
      p.audioEl = el;
    }
    p.audioEl.srcObject = stream;

    const ac = getAudioCtx();
    if (ac) {
      try {
        if (p.sourceNode) {
          try { p.sourceNode.disconnect(); } catch (e) {}
        }
        p.sourceNode = ac.createMediaStreamSource(stream);
        if (!p.gainNode) {
          p.gainNode = ac.createGain();
          p.gainNode.connect(ac.destination);
        }
        p.analyser = ac.createAnalyser();
        p.analyser.fftSize = 512;
        p.sourceNode.connect(p.gainNode);
        p.sourceNode.connect(p.analyser);
        // Chrome needs the remote stream attached to a media element for Web Audio to receive data;
        // keep the element muted so only the gain-boosted path is audible.
        p.audioEl.muted = true;
      } catch (e) {
        p.sourceNode = null;
        p.gainNode = null;
        p.analyser = null;
        p.audioEl.muted = false;
      }
    } else {
      p.audioEl.muted = false;
    }

    applyVolume(uid);
    const playPromise = p.audioEl.play();
    if (playPromise && playPromise.catch) playPromise.catch(() => {});
  }

  function applyVolume(uid) {
    const p = peers.get(uid);
    if (!p) return;
    const vol = getMemberVolume(uid);
    const factor = vol / 100;
    if (p.gainNode && audioCtx) {
      try {
        p.gainNode.gain.setValueAtTime(factor, audioCtx.currentTime || 0);
      } catch (e) {
        p.gainNode.gain.value = factor;
      }
    } else if (p.audioEl) {
      p.audioEl.volume = Math.min(1, factor);
    }
  }

  function getMemberVolume(uid) {
    const v = parseInt(memberVolumes[uid], 10);
    if (!isNaN(v) && v >= 0 && v <= 200) return v;
    return 100;
  }

  function setMemberVolume(uid, value) {
    const clean = cleanUid(uid);
    if (!clean) return;
    const v = Math.max(0, Math.min(200, parseInt(value, 10) || 0));
    if (v === 100) delete memberVolumes[clean];
    else memberVolumes[clean] = v;
    saveVolumes();
    applyVolume(clean);
  }

  // ---------- Speaking Indicator ----------
  const levelBuffer = new Float32Array(512);

  function readLevel(analyser) {
    if (!analyser) return 0;
    try {
      if (analyser.getFloatTimeDomainData) {
        analyser.getFloatTimeDomainData(levelBuffer);
        let sum = 0;
        for (let i = 0; i < levelBuffer.length; i++) sum += levelBuffer[i] * levelBuffer[i];
        return Math.sqrt(sum / levelBuffer.length);
      }
    } catch (e) {}
    return 0;
  }

  function setSpeaking(uid, speaking) {
    if (speakingState.get(uid) === speaking) return;
    speakingState.set(uid, speaking);
    applySpeakingClass(uid);
  }

  function applySpeakingClass(uid) {
    const card = document.getElementById(`live-card-${uid}`);
    if (card) card.classList.toggle('is-speaking', Boolean(speakingState.get(uid)));
  }

  function startSpeakingLoop() {
    stopSpeakingLoop();
    speakingLoopTimer = setInterval(() => {
      const now = Date.now();
      const evaluate = (uid, analyser, mutedFlag) => {
        const loud = !mutedFlag && readLevel(analyser) > SPEAKING_THRESHOLD;
        if (loud) speakingLastLoudAt.set(uid, now);
        const last = speakingLastLoudAt.get(uid) || 0;
        setSpeaking(uid, loud || now - last < SPEAKING_HOLD_MS);
      };
      if (inVoice) evaluate(myUid(), localAnalyser, isMuted);
      peers.forEach((p, uid) => {
        const m = voiceMembers.get(uid);
        evaluate(uid, p.analyser, Boolean(m && m.muted) || getMemberVolume(uid) === 0);
      });
    }, 100);
  }

  function stopSpeakingLoop() {
    if (speakingLoopTimer) {
      clearInterval(speakingLoopTimer);
      speakingLoopTimer = null;
    }
    document.querySelectorAll('.live-card.is-speaking').forEach((el) => el.classList.remove('is-speaking'));
  }

  // ---------- Signaling Handlers ----------
  // Room broadcasts: voice_join / voice_state / voice_leave
  function handleRoomMessage(data) {
    if (!data || !data.type || !String(data.type).startsWith('voice_')) return false;
    if (!ctx || !ctx.getCurrentUser()) return true;
    const uid = cleanUid(data.uid);
    if (!uid || uid === myUid()) return true;

    if (data.type === 'voice_leave' || (data.type === 'voice_state' && data.inVoice === false)) {
      const had = voiceMembers.has(uid);
      voiceMembers.delete(uid);
      closePeer(uid);
      if (had) notifyChange();
      return true;
    }

    if (data.type === 'voice_join' || data.type === 'voice_state') {
      const name = ctx.sanitizeUsername(data.username || uid, uid);
      const isNew = !voiceMembers.has(uid);
      voiceMembers.set(uid, { username: name, muted: Boolean(data.muted), lastSeen: Date.now() });

      if (inVoice) {
        if (data.type === 'voice_join') {
          // Let the newcomer know we are here (they may not have our state yet)
          broadcastRoom(buildStatePayload('voice_state'));
          if (isNew) {
            toast(`🎧 ${name} เข้าห้องเสียง`);
            if (ctx.playNotificationSound) {
              try { ctx.playNotificationSound('voice_join', uid); } catch (e) {}
            }
          }
        }
        ensurePeer(uid);
      }
      notifyChange();
      return true;
    }
    return true;
  }

  // Direct inbox signaling: voice_offer / voice_answer / voice_candidate / voice_reconnect
  function handleInboxMessage(data) {
    if (!data || !data.type || !String(data.type).startsWith('voice_')) return false;
    if (!ctx || !ctx.getCurrentUser()) return true;
    const fromUid = cleanUid(data.fromUid);
    const targetUid = cleanUid(data.targetUid);
    if (!fromUid || targetUid !== myUid()) return true;
    if (!inVoice || !roomCode() || data.roomCode !== roomCode() || !isRoomMember(fromUid)) return true;

    if (!voiceMembers.has(fromUid)) {
      const m = ctx.getRoomMembers().get(fromUid);
      voiceMembers.set(fromUid, { username: (m && m.username) || fromUid, muted: false, lastSeen: Date.now() });
      notifyChange();
    }

    if (data.type === 'voice_offer' && typeof data.sdp === 'string') {
      handleOffer(fromUid, data.sdp);
    } else if (data.type === 'voice_answer' && typeof data.sdp === 'string') {
      handleAnswer(fromUid, data.sdp);
    } else if (data.type === 'voice_candidate' && data.candidate) {
      handleCandidate(fromUid, data.candidate);
    } else if (data.type === 'voice_reconnect') {
      if (myUid() < fromUid) {
        closePeer(fromUid);
        createPeer(fromUid, true);
        makeOffer(fromUid);
      }
    }
    return true;
  }

  async function handleOffer(uid, sdp) {
    // A fresh offer always replaces any previous link with this peer
    const p = createPeer(uid, false);
    try {
      await p.pc.setRemoteDescription({ type: 'offer', sdp });
      await flushCandidates(p);
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      sendDirect(uid, { type: 'voice_answer', sdp: p.pc.localDescription.sdp });
    } catch (err) {
      console.warn('[Voice] handleOffer failed', err);
    }
  }

  async function handleAnswer(uid, sdp) {
    const p = peers.get(uid);
    if (!p || !p.isOfferer || p.pc.signalingState !== 'have-local-offer') return;
    try {
      await p.pc.setRemoteDescription({ type: 'answer', sdp });
      await flushCandidates(p);
    } catch (err) {
      console.warn('[Voice] handleAnswer failed', err);
    }
  }

  async function handleCandidate(uid, candidate) {
    const p = peers.get(uid);
    if (!p) return;
    if (!p.pc.remoteDescription) {
      p.pendingCandidates.push(candidate);
      return;
    }
    try {
      await p.pc.addIceCandidate(candidate);
    } catch (e) {}
  }

  // Called by app.js when a member leaves the text room
  function removeMember(uid) {
    const clean = cleanUid(uid);
    if (!clean) return;
    const had = voiceMembers.has(clean);
    voiceMembers.delete(clean);
    closePeer(clean);
    if (had) notifyChange();
  }

  // ---------- Public State for Card Rendering ----------
  function getMemberState(uid) {
    const clean = cleanUid(uid);
    const m = voiceMembers.get(clean);
    return {
      inVoice: Boolean(m),
      muted: Boolean(m && m.muted),
      speaking: Boolean(speakingState.get(clean)),
      volume: getMemberVolume(clean),
      selfInVoice: inVoice
    };
  }

  function init(config) {
    ctx = config;
    bindDOM();
  }

  function updateUser() {
    updateToolbarButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindDOM);
  } else {
    bindDOM();
  }

  window.VoiceChat = {
    init,
    updateUser,
    join,
    leave,
    toggleMute,
    announce,
    resetForRoomExit,
    removeMember,
    handleRoomMessage,
    handleInboxMessage,
    getMemberState,
    setMemberVolume,
    applySpeakingClass,
    isInVoice: () => inVoice
  };
})();
