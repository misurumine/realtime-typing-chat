/**
 * P2P File Transfer Engine (WebRTC DataChannel + File System Access API)
 * Supports unlimited file sizes (e.g. 51GB+) by streaming chunks directly
 * between disk and DataChannel with Zero Server Storage & Low Memory Footprint.
 *
 * Features:
 * - Immediate Modal + 1-Click OS File Picker when clicking "📁 ส่งไฟล์"
 * - Dual-Channel Signaling (Personal Inbox + Room Broadcast) with full deduplication
 * - In-Button & In-Modal Live Countdown (30s -> 0s) while button is locked
 * - 1-Second Auto-Retry Loop (pings recipient every 1000ms to prevent packet loss)
 * - 30-Second Timeout: Auto-cancels with "ไม่มีการตอบสนอง" state & stops 1s loop
 * - Queued WebRTC ICE Candidates & Backpressure-controlled 64KB chunk streaming
 */

(function () {
  'use strict';

  // Config Constants
  const CHUNK_SIZE = 64 * 1024; // 64 KB per chunk (optimal for WebRTC DataChannel MTU)
  const BUFFER_HIGH_WATERMARK = 4 * 1024 * 1024; // 4 MB backpressure threshold
  const BUFFER_LOW_WATERMARK = 1 * 1024 * 1024;  // 1 MB resume threshold
  const REQUEST_TIMEOUT_SEC = 30; // 30 seconds timeout
  const RETRY_INTERVAL_MS = 1000;  // 1 second retry loop

  // State
  let config = {
    currentUser: null,
    topicInbox: null,
    publishJson: null,
    showToast: (msg) => console.log('[Toast]', msg),
    rtcConfig: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    }
  };

  // Active Transfer State
  let activeSession = null;

  // Pending Incoming Request (Receiver side)
  let pendingIncomingRequest = null;
  let preparingTransferId = null;

  // Selected Target & File for Send Modal (Sender side)
  let sendTargetMember = null;
  let selectedFileToSend = null;
  let autoStartOnNextFilePick = false;

  // Track card button states by UID so re-renders preserve state
  const cardButtonStates = new Map(); // uid -> { state, text }

  // 1-second Retry Loop & 30-second Timeout State
  let requestRetryTimer = null;
  let requestCountdownTimer = null;
  let timeoutResetTimer = null;
  let requestRemainingSec = REQUEST_TIMEOUT_SEC;
  let requestRetryCount = 0;

  // Formatting Helpers
  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const val = bytes / Math.pow(k, i);
    return `${val.toFixed(val >= 100 || i === 0 ? 0 : 2)} ${sizes[i]}`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const sec = Math.round(seconds);
    if (sec < 60) return `${sec} วินาที`;
    const mins = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (mins < 60) return `${mins} นาที ${remSec} วินาที`;
    const hours = Math.floor(mins / 60);
    const remMin = mins % 60;
    return `${hours} ชั่วโมง ${remMin} นาที`;
  }

  function getFileIcon(filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv'].includes(ext)) return '🎬';
    if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(ext)) return '🎵';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'iso'].includes(ext)) return '📦';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return '🖼️';
    if (['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt'].includes(ext)) return '📄';
    if (['exe', 'msi', 'apk', 'dmg', 'app'].includes(ext)) return '⚙️';
    return '📁';
  }

  function sendPacketToPeer(targetUid, payload) {
    if (!targetUid || !config.publishJson || !config.topicInbox) return;
    const enrichedPayload = {
      ...payload,
      targetUid,
      uid: config.currentUser ? config.currentUser.uid : undefined
    };
    config.publishJson(config.topicInbox(targetUid), enrichedPayload);
  }

  // --- UI Elements Initialization ---
  let dom = {};
  let isListenersAttached = false;

  function initDOM() {
    dom = {
      // Send Modal
      sendModal: document.getElementById('p2pSendModal'),
      sendTargetAvatar: document.getElementById('p2pSendTargetAvatar'),
      sendTargetName: document.getElementById('p2pSendTargetName'),
      sendTargetUid: document.getElementById('p2pSendTargetUid'),
      dropzone: document.getElementById('p2pSendDropzone'),
      fileInput: document.getElementById('p2pSendFileInput'),
      filePreviewCard: document.getElementById('p2pSendFilePreview'),
      fileIcon: document.getElementById('p2pFilePreviewIcon'),
      fileName: document.getElementById('p2pFilePreviewName'),
      fileSize: document.getElementById('p2pFilePreviewSize'),
      fileHugeBadge: document.getElementById('p2pFileHugeBadge'),
      btnRemoveFile: document.getElementById('btnP2PRemoveFile'),
      btnCancelSend: document.getElementById('btnP2PCancelSend'),
      btnConfirmSend: document.getElementById('btnP2PConfirmSend'),
      sendWaitingState: document.getElementById('p2pSendWaitingState'),
      sendFormState: document.getElementById('p2pSendFormState'),
      waitingTargetName: document.getElementById('p2pWaitingTargetName'),
      waitingCountdown: document.getElementById('p2pWaitingCountdown'),
      waitingStatusMsg: document.getElementById('p2pWaitingStatusMsg'),
      btnAbortWaiting: document.getElementById('btnP2PAbortWaiting'),

      // Receive Modal
      receiveModal: document.getElementById('p2pReceiveModal'),
      receiveSenderAvatar: document.getElementById('p2pReceiveSenderAvatar'),
      receiveSenderName: document.getElementById('p2pReceiveSenderName'),
      receiveSenderUid: document.getElementById('p2pReceiveSenderUid'),
      receiveFileIcon: document.getElementById('p2pReceiveFileIcon'),
      receiveFileName: document.getElementById('p2pReceiveFileName'),
      receiveFileSize: document.getElementById('p2pReceiveFileSize'),
      receiveHugeNotice: document.getElementById('p2pReceiveHugeNotice'),
      btnDeclineReceive: document.getElementById('btnP2PDeclineReceive'),
      btnAcceptReceive: document.getElementById('btnP2PAcceptReceive'),

      // Floating Progress Widget
      widget: document.getElementById('p2pTransferWidget'),
      widgetHeaderTitle: document.getElementById('p2pWidgetHeaderTitle'),
      widgetDirectionBadge: document.getElementById('p2pWidgetDirectionBadge'),
      widgetPeerName: document.getElementById('p2pWidgetPeerName'),
      widgetFileIcon: document.getElementById('p2pWidgetFileIcon'),
      widgetFileName: document.getElementById('p2pWidgetFileName'),
      widgetFileSize: document.getElementById('p2pWidgetFileSize'),
      progressBar: document.getElementById('p2pWidgetProgressBar'),
      progressPercent: document.getElementById('p2pWidgetProgressPercent'),
      bytesTransferred: document.getElementById('p2pWidgetBytesTransferred'),
      speedBadge: document.getElementById('p2pWidgetSpeed'),
      etaBadge: document.getElementById('p2pWidgetEta'),
      statusText: document.getElementById('p2pWidgetStatusText'),
      btnCancelTransfer: document.getElementById('btnP2PCancelTransfer'),
      btnMinimizeWidget: document.getElementById('btnP2PMinimizeWidget'),
      widgetBody: document.getElementById('p2pWidgetBody'),
      completionView: document.getElementById('p2pWidgetCompletionView'),
      completionTitle: document.getElementById('p2pCompletionTitle'),
      completionSub: document.getElementById('p2pCompletionSub'),
      btnCloseCompletion: document.getElementById('btnP2PCloseCompletion')
    };

    if (!isListenersAttached && dom.sendModal) {
      attachEventListeners();
      isListenersAttached = true;
    }
  }

  function ensureDOM() {
    if (!dom || !dom.sendModal) {
      initDOM();
    }
    return Boolean(dom && dom.sendModal);
  }

  function attachEventListeners() {
    if (!dom.sendModal) return;

    // Send Modal: File selection via click on dropzone
    if (dom.dropzone && dom.fileInput) {
      dom.dropzone.addEventListener('click', (e) => {
        if (e.target === dom.fileInput) return;
        autoStartOnNextFilePick = false;
        dom.fileInput.value = '';
        dom.fileInput.click();
      });

      dom.fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          const pickedFile = e.target.files[0];
          const shouldAutoStart = autoStartOnNextFilePick;
          autoStartOnNextFilePick = false;
          handleFileSelected(pickedFile, shouldAutoStart);
        }
      });

      // Drag and Drop
      ['dragenter', 'dragover'].forEach((eventName) => {
        dom.dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dom.dropzone.classList.add('drag-hover');
        });
      });

      ['dragleave', 'drop'].forEach((eventName) => {
        dom.dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dom.dropzone.classList.remove('drag-hover');
        });
      });

      dom.dropzone.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          autoStartOnNextFilePick = false;
          handleFileSelected(e.dataTransfer.files[0], false);
        }
      });
    }

    // Remove file button
    if (dom.btnRemoveFile) {
      dom.btnRemoveFile.addEventListener('click', (e) => {
        e.stopPropagation();
        if (activeSession && activeSession.role === 'sender' && !activeSession.isAccepted) {
          abortPendingRequest('ผู้ส่งเปลี่ยนไฟล์', false);
        }
        clearSelectedFile();
      });
    }

    // Close / Cancel Send Modal
    if (dom.btnCancelSend) {
      dom.btnCancelSend.addEventListener('click', () => {
        closeSendModal();
      });
    }

    // Backdrop click on sendModal (only close if not actively waiting, or confirm abort)
    if (dom.sendModal) {
      dom.sendModal.addEventListener('click', (e) => {
        if (e.target === dom.sendModal) {
          if (activeSession && activeSession.role === 'sender' && !activeSession.isAccepted) {
            return; // Prevent accidental backdrop click from aborting active 30s countdown
          }
          closeSendModal();
        }
      });
    }

    // Abort button during 30s waiting state
    if (dom.btnAbortWaiting) {
      dom.btnAbortWaiting.addEventListener('click', () => {
        abortPendingRequest('ผู้ส่งยกเลิกคำขอส่งไฟล์', true);
      });
    }

    // Confirm Send Request button
    if (dom.btnConfirmSend) {
      dom.btnConfirmSend.addEventListener('click', () => {
        if (!selectedFileToSend || !sendTargetMember) return;
        if (activeSession && !activeSession.isComplete) return;
        initiateSendRequest(sendTargetMember, selectedFileToSend);
      });
    }

    // Receive Modal: Decline
    if (dom.btnDeclineReceive) {
      dom.btnDeclineReceive.addEventListener('click', () => {
        if (!pendingIncomingRequest) return;
        rejectIncomingRequest(pendingIncomingRequest, 'ผู้รับปฏิเสธคำขอรับไฟล์');
      });
    }

    // Receive Modal: Accept & Choose Save Location
    if (dom.btnAcceptReceive) {
      dom.btnAcceptReceive.addEventListener('click', () => {
        if (!pendingIncomingRequest) return;
        acceptIncomingRequest(pendingIncomingRequest);
      });
    }

    // Floating Widget Controls
    if (dom.btnCancelTransfer) {
      dom.btnCancelTransfer.addEventListener('click', () => {
        if (confirm('คุณต้องการยกเลิกการถ่ายโอนไฟล์นี้หรือไม่?')) {
          cancelTransfer('ยกเลิกโดยผู้ใช้');
        }
      });
    }

    if (dom.btnMinimizeWidget && dom.widget) {
      dom.btnMinimizeWidget.addEventListener('click', () => {
        dom.widget.classList.toggle('minimized');
        dom.btnMinimizeWidget.textContent = dom.widget.classList.contains('minimized') ? '🗖' : '🗕';
      });
    }

    if (dom.btnCloseCompletion) {
      dom.btnCloseCompletion.addEventListener('click', () => {
        closeWidget();
      });
    }
  }

  // --- Card Button State Synchronization ---
  function applyButtonDomState(btn, state, text) {
    if (!btn) return;
    btn.classList.remove('is-waiting', 'is-timeout', 'is-transferring');
    if (state === 'waiting') {
      btn.classList.add('is-waiting');
      btn.disabled = true;
      btn.innerHTML = `<span class="countdown-pulse-dot"></span> ⏳ ${text || 'รอตอบรับ'}`;
    } else if (state === 'timeout') {
      btn.classList.add('is-timeout');
      btn.disabled = true;
      btn.innerHTML = `⚠️ ${text || 'ไม่มีการตอบสนอง'}`;
    } else if (state === 'transferring') {
      btn.classList.add('is-transferring');
      btn.disabled = true;
      btn.innerHTML = `📤 ${text || 'กำลังส่ง...'}`;
    } else {
      btn.disabled = false;
      btn.innerHTML = `<span class="file-btn-icon">📁</span> <span class="file-btn-label">ส่งไฟล์</span>`;
    }
  }

  function updateCardButtonState(uid, state, text) {
    if (!uid) return;
    if (!state || state === 'default') {
      cardButtonStates.delete(uid);
    } else {
      cardButtonStates.set(uid, { state, text });
    }
    const cardBtns = document.querySelectorAll(`.btn-card-send-file[data-uid="${uid}"]`);
    cardBtns.forEach((btn) => applyButtonDomState(btn, state, text));
  }

  function syncCardButton(uid) {
    if (!uid) return;
    const saved = cardButtonStates.get(uid);
    if (!saved) return;
    const cardBtns = document.querySelectorAll(`.btn-card-send-file[data-uid="${uid}"]`);
    cardBtns.forEach((btn) => applyButtonDomState(btn, saved.state, saved.text));
  }

  // --- Sender Logic ---
  function handleFileSelected(file, autoInitiate = false) {
    if (!file) return;
    selectedFileToSend = file;

    if (dom.dropzone) dom.dropzone.classList.add('hidden');
    if (dom.filePreviewCard) dom.filePreviewCard.classList.remove('hidden');

    if (dom.fileIcon) dom.fileIcon.textContent = getFileIcon(file.name);
    if (dom.fileName) dom.fileName.textContent = file.name;
    if (dom.fileSize) dom.fileSize.textContent = formatBytes(file.size);

    if (dom.fileHugeBadge) {
      if (file.size > 10 * 1024 * 1024 * 1024) {
        dom.fileHugeBadge.classList.remove('hidden');
        dom.fileHugeBadge.textContent = `⚡ สตรีมดิสก์ P2P รองรับไฟล์ขนาดใหญ่พิเศษ (${formatBytes(file.size)})`;
      } else {
        dom.fileHugeBadge.classList.add('hidden');
      }
    }

    if (dom.btnConfirmSend) {
      dom.btnConfirmSend.disabled = false;
      dom.btnConfirmSend.textContent = '🚀 ส่งคำขอส่งไฟล์';
    }

    if (autoInitiate && sendTargetMember) {
      initiateSendRequest(sendTargetMember, file);
    }
  }

  function clearSelectedFile() {
    selectedFileToSend = null;
    if (dom.fileInput) dom.fileInput.value = '';
    if (dom.dropzone) dom.dropzone.classList.remove('hidden');
    if (dom.filePreviewCard) dom.filePreviewCard.classList.add('hidden');
    if (dom.sendFormState) dom.sendFormState.classList.remove('hidden');
    if (dom.sendWaitingState) dom.sendWaitingState.classList.add('hidden');
    if (dom.btnConfirmSend) {
      dom.btnConfirmSend.disabled = true;
      dom.btnConfirmSend.textContent = '🚀 ส่งคำขอส่งไฟล์';
    }
  }

  /**
   * Called when user clicks "📁 ส่งไฟล์" on a member's card or friend list.
   * Immediately opens the Sender Modal AND opens the OS File Chooser!
   */
  function openSendModalForMember(member) {
    ensureDOM();

    if (!member || !member.uid) {
      console.warn('[P2PFileTransfer] Invalid member data:', member);
      return;
    }
    if (activeSession && !activeSession.isComplete) {
      if (config.showToast) config.showToast('⚠️ กำลังมีการส่งไฟล์หรือรอการตอบรับอยู่ กรุณารอหรือยกเลิกก่อน');
      return;
    }

    if (timeoutResetTimer) {
      clearTimeout(timeoutResetTimer);
      timeoutResetTimer = null;
    }

    sendTargetMember = member;
    clearSelectedFile();

    if (dom.sendTargetAvatar) dom.sendTargetAvatar.src = member.avatar || './assets/avatars/avatar-1.svg';
    if (dom.sendTargetName) dom.sendTargetName.textContent = member.username || member.uid;
    if (dom.sendTargetUid) dom.sendTargetUid.textContent = `UID: ${member.uid}`;

    if (dom.sendFormState) dom.sendFormState.classList.remove('hidden');
    if (dom.sendWaitingState) dom.sendWaitingState.classList.add('hidden');

    if (dom.sendModal) {
      dom.sendModal.classList.remove('hidden');
      dom.sendModal.style.setProperty('display', 'flex', 'important');
      dom.sendModal.style.setProperty('z-index', '99999', 'important');
    }

    // Trigger native OS file picker immediately on user click so selecting a file immediately starts the 30s request loop
    if (dom.fileInput) {
      autoStartOnNextFilePick = true;
      dom.fileInput.value = '';
      try {
        dom.fileInput.click();
      } catch (e) {
        autoStartOnNextFilePick = false;
      }
    }
  }

  function closeSendModal() {
    stopRequestRetryLoop();
    autoStartOnNextFilePick = false;
    if (activeSession && activeSession.role === 'sender' && !activeSession.isComplete && !activeSession.isAccepted) {
      abortPendingRequest('ผู้ส่งปิดหน้าต่างคำขอส่งไฟล์', false);
    }
    if (dom.sendModal) {
      dom.sendModal.classList.add('hidden');
      dom.sendModal.style.setProperty('display', 'none', 'important');
    }
    clearSelectedFile();
    sendTargetMember = null;
  }

  // --- 1-Second Retry Loop & 30-Second Countdown Implementation ---
  function stopRequestRetryLoop() {
    if (requestRetryTimer) {
      clearInterval(requestRetryTimer);
      requestRetryTimer = null;
    }
    if (requestCountdownTimer) {
      clearInterval(requestCountdownTimer);
      requestCountdownTimer = null;
    }
  }

  function updateCountdownUI(targetUid) {
    // 1. Update in-button countdown on the member card
    if (targetUid) {
      updateCardButtonState(targetUid, 'waiting', `รอตอบรับ (${requestRemainingSec}s)`);
    }

    // 2. Update confirm button inside the modal
    if (dom.btnConfirmSend) {
      dom.btnConfirmSend.disabled = true;
      dom.btnConfirmSend.textContent = `⏳ รอตอบรับ (${requestRemainingSec}s)...`;
    }

    // 3. Update countdown badge inside the waiting modal
    if (dom.waitingCountdown) {
      dom.waitingCountdown.textContent = `⏳ รอการตอบรับ: ${requestRemainingSec} วิ`;
      if (requestRemainingSec <= 5) {
        dom.waitingCountdown.style.color = '#ef4444';
        dom.waitingCountdown.style.borderColor = 'rgba(239, 68, 68, 0.6)';
        dom.waitingCountdown.style.background = 'rgba(239, 68, 68, 0.2)';
      } else {
        dom.waitingCountdown.style.color = '#fbbf24';
        dom.waitingCountdown.style.borderColor = 'rgba(245, 158, 11, 0.45)';
        dom.waitingCountdown.style.background = 'rgba(245, 158, 11, 0.16)';
      }
    }
  }

  function handleRequestTimeout() {
    stopRequestRetryLoop();

    const targetName = activeSession ? activeSession.targetUsername : (sendTargetMember ? sendTargetMember.username : 'ผู้รับ');
    const targetUid = activeSession ? activeSession.targetUid : (sendTargetMember ? sendTargetMember.uid : null);
    const transferId = activeSession ? activeSession.transferId : null;

    // Notify target that request cancelled due to 30s timeout
    if (targetUid && transferId) {
      sendPacketToPeer(targetUid, {
        type: 'p2p_file_cancel_request',
        transferId,
        reason: 'ไม่มีการตอบสนอง (หมดเวลา 30 วินาที)'
      });
    }

    activeSession = null;

    // 1. Update card button to show "ไม่มีการตอบสนอง" for 5 seconds, then revert to normal
    if (targetUid) {
      updateCardButtonState(targetUid, 'timeout', 'ไม่มีการตอบสนอง');
      if (timeoutResetTimer) clearTimeout(timeoutResetTimer);
      timeoutResetTimer = setTimeout(() => {
        updateCardButtonState(targetUid, 'default');
      }, 5000);
    }

    // 2. Show timeout message inside modal & unlock button so user sees "ไม่มีการตอบสนอง" clearly
    if (dom.waitingCountdown) {
      dom.waitingCountdown.textContent = '⚠️ ไม่มีการตอบสนอง (ครบ 30 วินาที)';
      dom.waitingCountdown.style.color = '#fca5a5';
      dom.waitingCountdown.style.borderColor = 'rgba(239, 68, 68, 0.65)';
      dom.waitingCountdown.style.background = 'rgba(239, 68, 68, 0.22)';
    }
    if (dom.waitingStatusMsg) {
      dom.waitingStatusMsg.textContent = `❌ ไม่มีการตอบสนองจาก "${targetName}" ยกเลิกคำขอส่งไฟล์และหยุดส่งสัญญาณซ้ำแล้ว`;
    }
    if (dom.btnConfirmSend) {
      dom.btnConfirmSend.disabled = false;
      dom.btnConfirmSend.textContent = '🔄 ส่งคำขอใหม่อีกครั้ง';
    }
    if (dom.btnAbortWaiting) {
      dom.btnAbortWaiting.textContent = 'ปิดหน้าต่าง';
    }

    // 3. Inform user via Toast
    if (config.showToast) {
      config.showToast(`⚠️ ไม่มีการตอบสนองจาก "${targetName}" (ครบ 30 วินาที) ยกเลิกคำขอส่งไฟล์แล้ว`, 6000);
    }
  }

  function abortPendingRequest(reason = 'ผู้ส่งยกเลิกคำขอส่งไฟล์', closeModal = true) {
    stopRequestRetryLoop();

    const targetUid = activeSession ? activeSession.targetUid : (sendTargetMember ? sendTargetMember.uid : null);

    if (activeSession && activeSession.role === 'sender') {
      if (activeSession.targetUid && activeSession.transferId) {
        sendPacketToPeer(activeSession.targetUid, {
          type: 'p2p_file_cancel_request',
          transferId: activeSession.transferId,
          reason
        });
      }
      activeSession = null;
    }

    if (targetUid) {
      updateCardButtonState(targetUid, 'default');
    }

    if (closeModal) {
      if (dom.sendModal) {
        dom.sendModal.classList.add('hidden');
        dom.sendModal.style.setProperty('display', 'none', 'important');
      }
      clearSelectedFile();
      sendTargetMember = null;
    } else {
      if (dom.sendFormState) dom.sendFormState.classList.remove('hidden');
      if (dom.sendWaitingState) dom.sendWaitingState.classList.add('hidden');
      if (dom.btnConfirmSend) {
        dom.btnConfirmSend.disabled = !selectedFileToSend;
        dom.btnConfirmSend.textContent = '🚀 ส่งคำขอส่งไฟล์';
      }
    }

    if (config.showToast) config.showToast('ยกเลิกคำขอส่งไฟล์เรียบร้อย');
  }

  function initiateSendRequest(targetMember, file) {
    ensureDOM();
    if (!targetMember || !targetMember.uid || !file) return;

    if (timeoutResetTimer) {
      clearTimeout(timeoutResetTimer);
      timeoutResetTimer = null;
    }

    const transferId = `p2p_ft_${Date.now()}_${Math.random().toString(36).substr(2, 7)}`;
    sendTargetMember = targetMember;
    selectedFileToSend = file;

    // Setup active session
    activeSession = {
      role: 'sender',
      transferId,
      targetUid: targetMember.uid,
      targetUsername: targetMember.username || targetMember.uid,
      targetAvatar: targetMember.avatar,
      file,
      pc: null,
      dc: null,
      pendingCandidates: [],
      transferredBytes: 0,
      totalBytes: file.size,
      startTime: 0,
      lastSpeedCheckTime: 0,
      lastSpeedCheckBytes: 0,
      currentSpeed: 0,
      statsInterval: null,
      isPaused: false,
      isCancelled: false,
      isComplete: false,
      isAccepted: false
    };

    // 1. Immediately disable and lock button on the member card with live countdown
    updateCardButtonState(targetMember.uid, 'waiting', `รอตอบรับ (${REQUEST_TIMEOUT_SEC}s)`);

    // 2. Open/Update the waiting modal with file preview + live countdown
    if (dom.sendTargetAvatar) dom.sendTargetAvatar.src = targetMember.avatar || './assets/avatars/avatar-1.svg';
    if (dom.sendTargetName) dom.sendTargetName.textContent = targetMember.username || targetMember.uid;
    if (dom.sendTargetUid) dom.sendTargetUid.textContent = `UID: ${targetMember.uid}`;

    if (dom.dropzone) dom.dropzone.classList.add('hidden');
    if (dom.filePreviewCard) dom.filePreviewCard.classList.remove('hidden');
    if (dom.fileIcon) dom.fileIcon.textContent = getFileIcon(file.name);
    if (dom.fileName) dom.fileName.textContent = file.name;
    if (dom.fileSize) dom.fileSize.textContent = formatBytes(file.size);

    if (dom.sendFormState) dom.sendFormState.classList.remove('hidden');
    if (dom.sendWaitingState) dom.sendWaitingState.classList.remove('hidden');
    if (dom.waitingTargetName) dom.waitingTargetName.textContent = targetMember.username || targetMember.uid;
    if (dom.btnAbortWaiting) dom.btnAbortWaiting.textContent = '✕ ยกเลิกคำขอ';

    if (dom.sendModal) {
      dom.sendModal.classList.remove('hidden');
      dom.sendModal.style.setProperty('display', 'flex', 'important');
      dom.sendModal.style.setProperty('z-index', '99999', 'important');
    }

    // 3. Setup countdown & 1-second auto-retry ping loop
    stopRequestRetryLoop();
    requestRemainingSec = REQUEST_TIMEOUT_SEC;
    requestRetryCount = 1;
    updateCountdownUI(targetMember.uid);

    function sendRequestPing() {
      if (!activeSession || activeSession.role !== 'sender' || activeSession.isCancelled || activeSession.isAccepted) {
        stopRequestRetryLoop();
        return;
      }

      if (config.currentUser) {
        sendPacketToPeer(targetMember.uid, {
          type: 'p2p_file_request',
          transferId,
          attempt: requestRetryCount,
          file: {
            name: file.name,
            size: file.size,
            type: file.type || 'application/octet-stream'
          },
          from: {
            uid: config.currentUser.uid,
            username: config.currentUser.username,
            avatar: config.currentUser.avatar
          }
        });
      }

      if (dom.waitingStatusMsg) {
        dom.waitingStatusMsg.textContent = `📡 ส่งคำขอซ้ำทุก 1 วินาที (ส่งแล้วครั้งที่ ${requestRetryCount})`;
      }
      requestRetryCount++;
    }

    // Send first packet immediately!
    sendRequestPing();

    // Loop packet every 1 second (anti-packet loss)
    requestRetryTimer = setInterval(sendRequestPing, RETRY_INTERVAL_MS);

    // Countdown timer every 1 second (30-second timeout)
    requestCountdownTimer = setInterval(() => {
      requestRemainingSec--;
      if (requestRemainingSec <= 0) {
        handleRequestTimeout();
      } else {
        updateCountdownUI(targetMember.uid);
      }
    }, 1000);

    if (config.showToast) {
      config.showToast(`📤 กำลังส่งคำขอไฟล์ "${file.name}" (${formatBytes(file.size)}) ไปหา ${targetMember.username || targetMember.uid}...`);
    }
  }

  // --- Receiver Logic ---
  function handleIncomingRequest(data) {
    ensureDOM();
    if (!data || !data.transferId || !data.file || !data.from) return;

    // Deduplication check: Ignore repeat 1s pings if this transferId is already shown, preparing save location, or active!
    if (
      (pendingIncomingRequest && pendingIncomingRequest.transferId === data.transferId) ||
      preparingTransferId === data.transferId ||
      (activeSession && activeSession.transferId === data.transferId)
    ) {
      return;
    }

    // If already busy with a DIFFERENT transfer, auto-decline with busy message
    if ((activeSession && !activeSession.isComplete) || preparingTransferId) {
      if (config.currentUser) {
        sendPacketToPeer(data.from.uid, {
          type: 'p2p_file_response',
          transferId: data.transferId,
          accepted: false,
          reason: 'ผู้รับกำลังถ่ายโอนไฟล์อื่นอยู่ กรุณาลองใหม่อีกครั้งภายหลัง',
          from: { uid: config.currentUser.uid, username: config.currentUser.username }
        });
      }
      return;
    }

    pendingIncomingRequest = data;

    if (dom.receiveSenderAvatar) dom.receiveSenderAvatar.src = data.from.avatar || './assets/avatars/avatar-1.svg';
    if (dom.receiveSenderName) dom.receiveSenderName.textContent = data.from.username || data.from.uid;
    if (dom.receiveSenderUid) dom.receiveSenderUid.textContent = `UID: ${data.from.uid}`;

    if (dom.receiveFileIcon) dom.receiveFileIcon.textContent = getFileIcon(data.file.name);
    if (dom.receiveFileName) dom.receiveFileName.textContent = data.file.name;
    if (dom.receiveFileSize) dom.receiveFileSize.textContent = formatBytes(data.file.size);

    if (dom.receiveHugeNotice) {
      if (data.file.size > 10 * 1024 * 1024 * 1024) {
        dom.receiveHugeNotice.classList.remove('hidden');
        dom.receiveHugeNotice.textContent = `💡 ไฟล์ขนาดใหญ่ (${formatBytes(data.file.size)}) ระบบจะเขียนลงฮาร์ดดิสก์ทันทีโดยไม่เปลือง RAM`;
      } else {
        dom.receiveHugeNotice.classList.add('hidden');
      }
    }

    if (dom.receiveModal) {
      dom.receiveModal.classList.remove('hidden');
      dom.receiveModal.style.setProperty('display', 'flex', 'important');
      dom.receiveModal.style.setProperty('z-index', '99999', 'important');
    }

    if (config.showToast) config.showToast(`📥 มีคำขอส่งไฟล์ "${data.file.name}" จาก ${data.from.username || data.from.uid}`);
  }

  function rejectIncomingRequest(req, reason = 'ผู้รับปฏิเสธคำขอ') {
    if (dom.receiveModal) {
      dom.receiveModal.classList.add('hidden');
      dom.receiveModal.style.setProperty('display', 'none', 'important');
    }
    pendingIncomingRequest = null;
    preparingTransferId = null;

    if (config.currentUser && req && req.from) {
      sendPacketToPeer(req.from.uid, {
        type: 'p2p_file_response',
        transferId: req.transferId,
        accepted: false,
        reason,
        from: { uid: config.currentUser.uid, username: config.currentUser.username }
      });
    }

    if (config.showToast) config.showToast('ปฏิเสธคำขอรับไฟล์เรียบร้อย');
  }

  async function acceptIncomingRequest(req) {
    if (dom.receiveModal) {
      dom.receiveModal.classList.add('hidden');
      dom.receiveModal.style.setProperty('display', 'none', 'important');
    }
    pendingIncomingRequest = null;
    preparingTransferId = req.transferId;

    // Immediately notify sender that receiver clicked Accept and is choosing save location (stops 1s retry & 30s timeout!)
    if (config.currentUser) {
      sendPacketToPeer(req.from.uid, {
        type: 'p2p_file_preparing',
        transferId: req.transferId,
        from: { uid: config.currentUser.uid, username: config.currentUser.username }
      });
    }

    let writableStream = null;

    // Check File System Access API support for streaming directly to disk
    if (window.showSaveFilePicker) {
      try {
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: req.file.name
        });
        writableStream = await fileHandle.createWritable();
      } catch (err) {
        preparingTransferId = null;
        if (err.name === 'AbortError') {
          if (config.currentUser) {
            sendPacketToPeer(req.from.uid, {
              type: 'p2p_file_response',
              transferId: req.transferId,
              accepted: false,
              reason: 'ผู้รับยกเลิกการเลือกที่บันทึกไฟล์',
              from: { uid: config.currentUser.uid, username: config.currentUser.username }
            });
          }
          if (config.showToast) config.showToast('ยกเลิกการบันทึกไฟล์');
          return;
        }
        console.error('Error opening save file stream:', err);
        if (config.showToast) config.showToast('⚠️ ไม่สามารถเปิดที่บันทึกไฟล์ได้: ' + err.message);
        return;
      }
    } else {
      if (req.file.size > 1.5 * 1024 * 1024 * 1024) {
        preparingTransferId = null;
        alert(
          `เบราว์เซอร์นี้ไม่รองรับ File System Access API สำหรับไฟล์ขนาดใหญ่ (${formatBytes(req.file.size)})\nกรุณาใช้ Google Chrome หรือ Microsoft Edge เพื่อรับไฟล์ขนาดใหญ่ระดับหลาย GB โดยไม่เกิดปัญหาหน่วยความจำ`
        );
        if (config.currentUser) {
          sendPacketToPeer(req.from.uid, {
            type: 'p2p_file_response',
            transferId: req.transferId,
            accepted: false,
            reason: 'เบราว์เซอร์ผู้รับไม่รองรับการเขียนไฟล์ขนาดใหญ่ลงดิสก์โดยตรง',
            from: { uid: config.currentUser.uid, username: config.currentUser.username }
          });
        }
        return;
      }
      if (config.showToast) config.showToast('⚠️ กำลังใช้โหมดสำรองในหน่วยความจำ (แนะนำ Chrome/Edge สำหรับไฟล์ใหญ่)');
    }

    // Setup active session for receiver
    activeSession = {
      role: 'receiver',
      transferId: req.transferId,
      targetUid: req.from.uid,
      targetUsername: req.from.username || req.from.uid,
      targetAvatar: req.from.avatar,
      file: req.file,
      pc: null,
      dc: null,
      pendingCandidates: [],
      writableStream,
      fallbackChunks: writableStream ? null : [],
      transferredBytes: 0,
      totalBytes: req.file.size,
      startTime: 0,
      lastSpeedCheckTime: 0,
      lastSpeedCheckBytes: 0,
      currentSpeed: 0,
      statsInterval: null,
      isPaused: false,
      isCancelled: false,
      isComplete: false
    };
    preparingTransferId = null;

    // Prepare WebRTC PeerConnection on receiver BEFORE sending response so receiver is 100% ready for offer
    setupReceiverPeerConnection();

    // Open Floating Progress Widget
    openWidget('receiver', req.file, req.from);

    // Reply accept to sender
    if (config.currentUser) {
      sendPacketToPeer(req.from.uid, {
        type: 'p2p_file_response',
        transferId: req.transferId,
        accepted: true,
        from: { uid: config.currentUser.uid, username: config.currentUser.username }
      });
    }
  }

  // --- WebRTC PeerConnection Setup ---
  function setupReceiverPeerConnection() {
    const pc = new RTCPeerConnection(config.rtcConfig);
    activeSession.pc = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate && activeSession && !activeSession.isCancelled) {
        sendPacketToPeer(activeSession.targetUid, {
          type: 'p2p_file_signal',
          transferId: activeSession.transferId,
          signal: { type: 'candidate', candidate: event.candidate }
        });
      }
    };

    pc.ondatachannel = (event) => {
      const dc = event.channel;
      activeSession.dc = dc;
      dc.binaryType = 'arraybuffer';
      setupReceiverDataChannel(dc);
    };

    if (dom.statusText) dom.statusText.textContent = 'กำลังเจาะท่อ P2P (เชื่อมต่อตรง)...';
  }

  function setupReceiverDataChannel(dc) {
    dc.onopen = () => {
      if (dom.statusText) dom.statusText.textContent = 'เชื่อมต่อ P2P สำเร็จ กำลังเริ่มรับข้อมูล...';
      activeSession.startTime = Date.now();
      activeSession.lastSpeedCheckTime = Date.now();
      startStatsMonitor();
    };

    dc.onclose = () => {
      if (activeSession && !activeSession.isComplete && !activeSession.isCancelled) {
        cancelTransfer('การเชื่อมต่อหลุดกะทันหัน');
      }
    };

    dc.onerror = (err) => {
      console.error('Receiver DataChannel error:', err);
    };

    dc.onmessage = async (event) => {
      if (!activeSession || activeSession.isCancelled) return;

      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.header === 'file_end') {
            await finishReceivingFile();
          } else if (msg.header === 'file_cancel') {
            cancelTransfer(msg.reason || 'ผู้ส่งยกเลิกการส่งไฟล์', false);
          }
        } catch (e) {
          console.error('Error parsing control message:', e);
        }
      } else {
        const chunk = event.data;
        try {
          if (activeSession.writableStream) {
            await activeSession.writableStream.write(chunk);
          } else if (activeSession.fallbackChunks) {
            activeSession.fallbackChunks.push(chunk);
          }
          activeSession.transferredBytes += chunk.byteLength;
          updateProgressUI(activeSession.transferredBytes, activeSession.totalBytes);
        } catch (err) {
          console.error('Error writing chunk to disk:', err);
          cancelTransfer('เกิดข้อผิดพลาดในการเขียนไฟล์ลงฮาร์ดดิสก์: ' + err.message);
        }
      }
    };
  }

  async function finishReceivingFile() {
    if (!activeSession) return;
    activeSession.isComplete = true;
    stopStatsMonitor();

    if (activeSession.writableStream) {
      try {
        await activeSession.writableStream.close();
        activeSession.writableStream = null;
      } catch (e) {
        console.error('Error closing writable stream:', e);
      }
    } else if (activeSession.fallbackChunks) {
      try {
        const blob = new Blob(activeSession.fallbackChunks, { type: activeSession.file.type || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = activeSession.file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        activeSession.fallbackChunks = null;
      } catch (e) {
        console.error('Fallback blob error:', e);
      }
    }

    showCompletionUI('🎉 บันทึกไฟล์สำเร็จ 100%!', `รับไฟล์ "${activeSession.file.name}" เรียบร้อยแล้ว`);
    if (config.showToast) config.showToast(`✅ รับไฟล์ "${activeSession.file.name}" สำเร็จเรียบร้อย!`);
    cleanupConnections();
  }

  // --- Sender WebRTC & Chunk Streaming Flow ---
  function handleReceiverPreparing(data) {
    if (!activeSession || activeSession.transferId !== data.transferId) return;
    // Receiver clicked Accept and is choosing where to save the file on disk -> stop 1s retry & 30s timeout!
    stopRequestRetryLoop();
    updateCardButtonState(activeSession.targetUid, 'waiting', 'ผู้รับกำลังเลือกที่เซฟไฟล์...');
    if (dom.waitingCountdown) {
      dom.waitingCountdown.textContent = '💾 ผู้รับกดรับแล้ว กำลังเลือกที่บันทึกไฟล์...';
    }
    if (dom.waitingStatusMsg) {
      dom.waitingStatusMsg.textContent = 'กำลังรอผู้รับเลือกโฟลเดอร์สำหรับบันทึกไฟล์ลงเครื่อง...';
    }
    if (dom.btnConfirmSend) {
      dom.btnConfirmSend.disabled = true;
      dom.btnConfirmSend.textContent = '💾 รอผู้รับเลือกที่เซฟ...';
    }
  }

  async function handleReceiverResponse(data) {
    if (!activeSession || activeSession.transferId !== data.transferId) return;

    // Immediately stop the 1-second retry loop & 30-second timeout
    stopRequestRetryLoop();

    if (!data.accepted) {
      updateCardButtonState(activeSession.targetUid, 'default');
      if (dom.sendModal) {
        dom.sendModal.classList.add('hidden');
        dom.sendModal.style.setProperty('display', 'none', 'important');
      }
      if (config.showToast) config.showToast(`❌ ${data.from?.username || 'ผู้รับ'} ปฏิเสธ: ${data.reason || 'ไม่ตอบรับ'}`);
      activeSession = null;
      return;
    }

    // Prevent duplicate response handling if dual-channel delivered twice
    if (activeSession.isAccepted) return;
    activeSession.isAccepted = true;

    updateCardButtonState(activeSession.targetUid, 'transferring', 'กำลังส่งไฟล์');

    if (dom.sendModal) {
      dom.sendModal.classList.add('hidden');
      dom.sendModal.style.setProperty('display', 'none', 'important');
    }

    openWidget('sender', activeSession.file, {
      username: activeSession.targetUsername,
      avatar: activeSession.targetAvatar
    });

    if (dom.statusText) dom.statusText.textContent = 'ผู้รับยอมรับแล้ว กำลังสร้างการเชื่อมต่อ P2P...';

    const pc = new RTCPeerConnection(config.rtcConfig);
    activeSession.pc = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate && activeSession && !activeSession.isCancelled) {
        sendPacketToPeer(activeSession.targetUid, {
          type: 'p2p_file_signal',
          transferId: activeSession.transferId,
          signal: { type: 'candidate', candidate: event.candidate }
        });
      }
    };

    const dc = pc.createDataChannel('p2p_file_channel', { ordered: true });
    activeSession.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_LOW_WATERMARK;

    dc.onopen = () => {
      if (dom.statusText) dom.statusText.textContent = 'เชื่อมต่อ P2P สำเร็จ กำลังเริ่มสตรีมไฟล์ตรง...';
      activeSession.startTime = Date.now();
      activeSession.lastSpeedCheckTime = Date.now();
      startStatsMonitor();
      startStreamingFile();
    };

    dc.onclose = () => {
      if (activeSession && !activeSession.isComplete && !activeSession.isCancelled) {
        cancelTransfer('การเชื่อมต่อหลุดกะทันหัน');
      }
    };

    dc.onerror = (err) => {
      console.error('Sender DataChannel error:', err);
    };

    dc.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.header === 'file_cancel') {
          cancelTransfer(msg.reason || 'ผู้รับได้ยกเลิกการรับไฟล์', false);
        }
      } catch (e) {}
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      sendPacketToPeer(activeSession.targetUid, {
        type: 'p2p_file_signal',
        transferId: activeSession.transferId,
        signal: { type: 'offer', sdp: offer }
      });
    } catch (err) {
      console.error('Error creating offer:', err);
      cancelTransfer('ไม่สามารถสร้างข้อเสนอเชื่อมต่อ WebRTC ได้');
    }
  }

  async function flushPendingCandidates() {
    if (!activeSession || !activeSession.pc || !activeSession.pc.remoteDescription) return;
    while (activeSession.pendingCandidates && activeSession.pendingCandidates.length > 0) {
      const cand = activeSession.pendingCandidates.shift();
      try {
        await activeSession.pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (e) {}
    }
  }

  async function handleSignalMessage(data) {
    if (!activeSession || activeSession.transferId !== data.transferId || !data.signal) return;

    const pc = activeSession.pc;
    if (!pc) return;

    try {
      if (data.signal.type === 'offer') {
        if (pc.signalingState !== 'stable') return; // Ignore duplicate offer from dual-channel
        await pc.setRemoteDescription(new RTCSessionDescription(data.signal.sdp));
        await flushPendingCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        sendPacketToPeer(activeSession.targetUid, {
          type: 'p2p_file_signal',
          transferId: activeSession.transferId,
          signal: { type: 'answer', sdp: answer }
        });
      } else if (data.signal.type === 'answer') {
        if (pc.signalingState !== 'have-local-offer') return; // Ignore duplicate answer from dual-channel
        await pc.setRemoteDescription(new RTCSessionDescription(data.signal.sdp));
        await flushPendingCandidates();
      } else if (data.signal.type === 'candidate' && data.signal.candidate) {
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(new RTCIceCandidate(data.signal.candidate)).catch(() => {});
        } else if (activeSession.pendingCandidates) {
          activeSession.pendingCandidates.push(data.signal.candidate);
        }
      }
    } catch (err) {
      console.error('Signal handling error:', err);
    }
  }

  // --- High-Performance File Streaming Engine with Backpressure ---
  function startStreamingFile() {
    if (!activeSession || activeSession.role !== 'sender') return;

    const file = activeSession.file;
    const totalSize = file.size;
    const dc = activeSession.dc;
    let offset = 0;

    dc.send(
      JSON.stringify({
        header: 'file_start',
        name: file.name,
        size: totalSize,
        type: file.type,
        chunkSize: CHUNK_SIZE
      })
    );

    async function sendNextChunks() {
      if (!activeSession || activeSession.isCancelled || activeSession.isComplete) return;

      while (offset < totalSize && !activeSession.isCancelled) {
        if (dc.bufferedAmount > BUFFER_HIGH_WATERMARK) {
          dc.onbufferedamountlow = () => {
            dc.onbufferedamountlow = null;
            sendNextChunks();
          };
          return;
        }

        const chunkEnd = Math.min(offset + CHUNK_SIZE, totalSize);
        const slice = file.slice(offset, chunkEnd);

        try {
          const arrayBuffer = await slice.arrayBuffer();
          if (!activeSession || activeSession.isCancelled) return;

          dc.send(arrayBuffer);
          offset += arrayBuffer.byteLength;
          activeSession.transferredBytes = offset;

          updateProgressUI(offset, totalSize);
        } catch (err) {
          console.error('Error reading slice from disk:', err);
          cancelTransfer('เกิดข้อผิดพลาดในการอ่านไฟล์: ' + err.message);
          return;
        }

        if (offset % (CHUNK_SIZE * 32) === 0) {
          setTimeout(sendNextChunks, 0);
          return;
        }
      }

      if (offset >= totalSize && !activeSession.isCancelled) {
        if (dc.bufferedAmount > 0) {
          dc.onbufferedamountlow = () => {
            dc.onbufferedamountlow = null;
            finishSendingFile();
          };
        } else {
          finishSendingFile();
        }
      }
    }

    sendNextChunks();
  }

  function finishSendingFile() {
    if (!activeSession || activeSession.role !== 'sender') return;
    activeSession.isComplete = true;
    stopStatsMonitor();

    if (activeSession.targetUid) {
      updateCardButtonState(activeSession.targetUid, 'default');
    }

    if (activeSession.dc && activeSession.dc.readyState === 'open') {
      try {
        activeSession.dc.send(JSON.stringify({ header: 'file_end' }));
      } catch (e) {}
    }

    showCompletionUI('🎉 ส่งไฟล์สำเร็จ 100%!', `ส่งไฟล์ "${activeSession.file.name}" ให้ ${activeSession.targetUsername} เรียบร้อยแล้ว`);
    if (config.showToast) config.showToast(`✅ ส่งไฟล์ "${activeSession.file.name}" ให้ ${activeSession.targetUsername} สำเร็จ!`);
    cleanupConnections();
  }

  // --- Speedometer & ETA Calculator ---
  function startStatsMonitor() {
    stopStatsMonitor();
    activeSession.statsInterval = setInterval(() => {
      if (!activeSession || activeSession.isCancelled || activeSession.isComplete) return;

      const now = Date.now();
      const elapsedSec = (now - activeSession.lastSpeedCheckTime) / 1000;
      if (elapsedSec >= 0.8) {
        const bytesDelta = activeSession.transferredBytes - activeSession.lastSpeedCheckBytes;
        const currentSpeed = bytesDelta / elapsedSec;

        activeSession.currentSpeed = currentSpeed;
        activeSession.lastSpeedCheckTime = now;
        activeSession.lastSpeedCheckBytes = activeSession.transferredBytes;

        if (dom.speedBadge) dom.speedBadge.textContent = `⚡ ${formatBytes(currentSpeed)}/s`;

        const remainingBytes = activeSession.totalBytes - activeSession.transferredBytes;
        if (dom.etaBadge) {
          if (currentSpeed > 1024) {
            const remainingSec = remainingBytes / currentSpeed;
            dom.etaBadge.textContent = `⏳ เหลืออีก ${formatDuration(remainingSec)}`;
          } else {
            dom.etaBadge.textContent = '⏳ กำลังคำนวณ...';
          }
        }
      }
    }, 800);
  }

  function stopStatsMonitor() {
    if (activeSession && activeSession.statsInterval) {
      clearInterval(activeSession.statsInterval);
      activeSession.statsInterval = null;
    }
  }

  // --- UI Progress Updates ---
  function updateProgressUI(transferred, total) {
    if (!dom.progressBar) return;
    const pct = total > 0 ? Math.min(100, (transferred / total) * 100) : 0;

    dom.progressBar.style.width = `${pct.toFixed(1)}%`;
    if (dom.progressPercent) dom.progressPercent.textContent = `${pct.toFixed(1)}%`;
    if (dom.bytesTransferred) dom.bytesTransferred.textContent = `${formatBytes(transferred)} / ${formatBytes(total)}`;
  }

  function openWidget(role, file, peer) {
    ensureDOM();
    if (dom.widget) {
      dom.widget.classList.remove('hidden', 'minimized');
      dom.widget.style.setProperty('display', 'block', 'important');
    }
    if (dom.widgetBody) dom.widgetBody.classList.remove('hidden');
    if (dom.completionView) dom.completionView.classList.add('hidden');

    const isSender = role === 'sender';
    if (dom.widgetHeaderTitle) dom.widgetHeaderTitle.textContent = isSender ? '📤 กำลังส่งไฟล์ (P2P Direct)' : '📥 กำลังรับไฟล์ (P2P Direct)';
    if (dom.widgetDirectionBadge) {
      dom.widgetDirectionBadge.textContent = isSender ? 'ส่งออก' : 'รับเข้า';
      dom.widgetDirectionBadge.className = `p2p-direction-badge ${isSender ? 'out' : 'in'}`;
    }

    if (dom.widgetPeerName) dom.widgetPeerName.textContent = peer.username || peer.uid || 'เพื่อน';
    if (dom.widgetFileIcon) dom.widgetFileIcon.textContent = getFileIcon(file.name);
    if (dom.widgetFileName) dom.widgetFileName.textContent = file.name;
    if (dom.widgetFileSize) dom.widgetFileSize.textContent = formatBytes(file.size);

    if (dom.progressBar) dom.progressBar.style.width = '0%';
    if (dom.progressPercent) dom.progressPercent.textContent = '0%';
    if (dom.bytesTransferred) dom.bytesTransferred.textContent = `0 B / ${formatBytes(file.size)}`;
    if (dom.speedBadge) dom.speedBadge.textContent = '⚡ 0 B/s';
    if (dom.etaBadge) dom.etaBadge.textContent = '⏳ กำลังเชื่อมต่อ...';
    if (dom.statusText) dom.statusText.textContent = 'กำลังเตรียมท่อส่ง...';
  }

  function showCompletionUI(title, subtitle) {
    if (dom.widgetBody) dom.widgetBody.classList.add('hidden');
    if (dom.completionView) dom.completionView.classList.remove('hidden');
    if (dom.completionTitle) dom.completionTitle.textContent = title;
    if (dom.completionSub) dom.completionSub.textContent = subtitle;
  }

  function closeWidget() {
    stopRequestRetryLoop();
    if (activeSession && activeSession.targetUid) {
      updateCardButtonState(activeSession.targetUid, 'default');
    }
    if (dom.widget) {
      dom.widget.classList.add('hidden');
      dom.widget.style.setProperty('display', 'none', 'important');
    }
    cleanupConnections();
    activeSession = null;
  }

  function cancelTransfer(reason = 'ยกเลิกการถ่ายโอน', notifyRemote = true) {
    stopRequestRetryLoop();
    preparingTransferId = null;
    if (!activeSession) return;
    activeSession.isCancelled = true;
    stopStatsMonitor();

    const targetUid = activeSession.targetUid;

    if (notifyRemote && activeSession.dc && activeSession.dc.readyState === 'open') {
      try {
        activeSession.dc.send(JSON.stringify({ header: 'file_cancel', reason }));
      } catch (e) {}
    }

    if (activeSession.writableStream) {
      try {
        activeSession.writableStream.abort(reason);
        activeSession.writableStream = null;
      } catch (e) {}
    }

    if (targetUid) {
      updateCardButtonState(targetUid, 'default');
    }

    if (config.showToast) config.showToast(`⚠️ ${reason}`);
    closeWidget();
  }

  function cleanupConnections() {
    stopRequestRetryLoop();
    if (!activeSession) return;
    if (activeSession.targetUid) {
      updateCardButtonState(activeSession.targetUid, 'default');
    }
    if (activeSession.dc) {
      try { activeSession.dc.close(); } catch (e) {}
      activeSession.dc = null;
    }
    if (activeSession.pc) {
      try { activeSession.pc.close(); } catch (e) {}
      activeSession.pc = null;
    }
    stopStatsMonitor();
  }

  // Auto initialize DOM as soon as page is interactive/ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDOM);
  } else {
    initDOM();
  }

  // --- Public API ---
  window.P2PFileTransfer = {
    init: function (settings) {
      config = { ...config, ...settings };
      initDOM();
    },

    updateUser: function (user) {
      config.currentUser = user;
    },

    openSendForMember: function (member) {
      openSendModalForMember(member);
    },

    syncCardButton: function (uid) {
      syncCardButton(uid);
    },

    handleInboxMessage: function (data) {
      if (!data || !data.type) return false;

      if (data.type === 'p2p_file_request') {
        handleIncomingRequest(data);
        return true;
      }
      if (data.type === 'p2p_file_preparing') {
        handleReceiverPreparing(data);
        return true;
      }
      if (data.type === 'p2p_file_response') {
        handleReceiverResponse(data);
        return true;
      }
      if (data.type === 'p2p_file_signal') {
        handleSignalMessage(data);
        return true;
      }
      if (data.type === 'p2p_file_cancel_request') {
        if (pendingIncomingRequest && pendingIncomingRequest.transferId === data.transferId) {
          if (dom.receiveModal) {
            dom.receiveModal.classList.add('hidden');
            dom.receiveModal.style.setProperty('display', 'none', 'important');
          }
          pendingIncomingRequest = null;
          if (config.showToast) {
            config.showToast(`ℹ️ ผู้ส่งยกเลิกคำขอ (${data.reason || 'ไม่มีการตอบสนอง'})`);
          }
        }
        return true;
      }

      return false;
    }
  };
})();
