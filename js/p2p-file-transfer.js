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

  // Config Constants (Ultra High-Speed 8-Channel Striping + 8MB Batch Streaming)
  const NUM_CHANNELS = 8; // 8 Parallel DataChannels for maximum throughput
  const CHUNK_SIZE = 128 * 1024 - 128; // 130,944 bytes (safe 128KB chunk for all WebRTC SCTP MTUs)
  const BATCH_SIZE = 8 * 1024 * 1024; // 8 MB disk write batching for peak sequential SSD I/O
  const BUFFER_HIGH_WATERMARK = 2 * 1024 * 1024; // 2 MB backpressure threshold per channel
  const BUFFER_LOW_WATERMARK = 512 * 1024;  // 512 KB resume threshold per channel
  const HEADER_SIZE = 8; // 8 bytes BigUint64 byteOffset (raw uncompressed binary framing)
  const REQUEST_TIMEOUT_SEC = 30; // 30 seconds timeout
  const RETRY_INTERVAL_MS = 1000;  // 1 second retry loop

  // Disk read pipeline: read big blocks (and prefetch the next one) instead of one IPC read per 64KB chunk
  const READ_BLOCK_SIZE = 4 * 1024 * 1024;

  // Parallel PeerConnections (IDM-style multiple independent connections). Each PeerConnection has its
  // own SCTP association = its own congestion/receive window, which helps on high-latency internet links.
  // Multiple DataChannels inside ONE PeerConnection share a single association and do NOT add throughput.
  const MAX_PARALLEL_CONNECTIONS = 4;
  const TOTAL_CHANNEL_BUDGET = 8;
  const STORAGE_KEY_PARALLEL = 'p2p_parallel_connections';
  const FILE_READY_TIMEOUT_MS = 5000;
  const FILE_END_STALL_TIMEOUT_MS = 30000;

  function getParallelConnectionSetting() {
    let n = 1;
    try {
      n = parseInt(localStorage.getItem(STORAGE_KEY_PARALLEL), 10) || 1;
    } catch (e) {}
    return Math.max(1, Math.min(MAX_PARALLEL_CONNECTIONS, n));
  }

  function setParallelConnectionSetting(n) {
    try {
      localStorage.setItem(STORAGE_KEY_PARALLEL, String(Math.max(1, Math.min(MAX_PARALLEL_CONNECTIONS, n))));
    } catch (e) {}
  }

  // Un-throttled macrotask yield. setTimeout() is clamped to >= 1s in background tabs, which used to cap
  // sending at ~1 MB/s whenever the sender switched to another tab. MessageChannel is not throttled.
  const yieldChannel = new MessageChannel();
  const yieldQueue = [];
  yieldChannel.port1.onmessage = () => {
    const fn = yieldQueue.shift();
    if (fn) fn();
  };
  function yieldToEventLoop(fn) {
    yieldQueue.push(fn);
    yieldChannel.port2.postMessage(0);
  }

  function getAllPeerConnections() {
    if (!activeSession) return [];
    if (Array.isArray(activeSession.pcs) && activeSession.pcs.length > 0) return activeSession.pcs.filter(Boolean);
    return activeSession.pc ? [activeSession.pc] : [];
  }

  // Local copy of app.js sanitizeUid (app.js keeps its own inside its closure, so it is NOT visible here).
  // Missing this caused a ReferenceError on every member leave, which killed the MQTT receive stream.
  function sanitizeUid(input) {
    if (!input || typeof input !== 'string') return '';
    const cleaned = input.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
    if (cleaned === '__PROTO__' || cleaned === 'CONSTRUCTOR' || cleaned === 'PROTOTYPE') return '';
    return cleaned;
  }

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

  // Selected Target & Files for Send Modal (Sender side)
  let sendTargetMember = null;
  let selectedFilesToSend = [];
  let autoStartOnNextFilePick = false;

  // Track card button states by UID so re-renders preserve state
  const cardButtonStates = new Map(); // uid -> { state, text }

  // 1-second Retry Loop & 30-second Timeout State
  let requestRetryTimer = null;
  let requestCountdownTimer = null;
  let timeoutResetTimer = null;
  let requestRemainingSec = REQUEST_TIMEOUT_SEC;
  let requestRetryCount = 0;

  // HTML sanitization helper
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

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
      singleFileView: document.getElementById('p2pSingleFileView'),
      batchFileView: document.getElementById('p2pBatchFileView'),
      batchSummaryText: document.getElementById('p2pBatchSummaryText'),
      batchFileList: document.getElementById('p2pBatchFileList'),
      btnClearAllBatch: document.getElementById('btnP2PClearAllBatch'),
      btnAddMoreFiles: document.getElementById('btnP2PAddMoreFiles'),
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
      receiveBatchPreview: document.getElementById('p2pReceiveBatchPreview'),
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

  function attachParallelConnSelect() {
    const select = document.getElementById('p2pParallelConnSelect');
    if (!select || select.dataset.bound) return;
    select.dataset.bound = '1';
    select.value = String(getParallelConnectionSetting());
    select.addEventListener('change', () => {
      setParallelConnectionSetting(parseInt(select.value, 10) || 1);
    });
  }

  function attachEventListeners() {
    attachParallelConnSelect();
    if (!dom.sendModal) return;

    // Send Modal: File selection via click on dropzone
    if (dom.dropzone && dom.fileInput) {
      dom.dropzone.addEventListener('click', async (e) => {
        if (e.target === dom.fileInput) return;
        if (window.electronAPI && typeof window.electronAPI.showOpenDialog === 'function') {
          try {
            const res = await window.electronAPI.showOpenDialog();
            if (!res.canceled && res.filePath) {
              handleFileSelected({
                name: res.fileName,
                size: res.fileSize,
                path: res.filePath,
                isNative: true
              }, false);
            }
            return;
          } catch (err) {
            console.error('[P2PFileTransfer] Electron showOpenDialog error:', err);
          }
        }
        autoStartOnNextFilePick = false;
        dom.fileInput.value = '';
        dom.fileInput.click();
      });

      dom.fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          const files = Array.from(e.target.files);
          const shouldAutoStart = autoStartOnNextFilePick;
          autoStartOnNextFilePick = false;
          handleFilesSelected(files, shouldAutoStart);
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
          const dropFiles = Array.from(e.dataTransfer.files);
          handleFilesSelected(dropFiles, false);
        }
      });
    }

    // Add more files to batch button
    if (dom.btnAddMoreFiles && dom.fileInput) {
      dom.btnAddMoreFiles.addEventListener('click', (e) => {
        e.stopPropagation();
        autoStartOnNextFilePick = false;
        dom.fileInput.value = '';
        dom.fileInput.click();
      });
    }

    // Clear all files button
    if (dom.btnClearAllBatch) {
      dom.btnClearAllBatch.addEventListener('click', (e) => {
        e.stopPropagation();
        if (activeSession && activeSession.role === 'sender' && !activeSession.isAccepted) {
          abortPendingRequest('ผู้ส่งเปลี่ยนไฟล์', false);
        }
        clearSelectedFiles();
      });
    }

    // Remove single file button
    if (dom.btnRemoveFile) {
      dom.btnRemoveFile.addEventListener('click', (e) => {
        e.stopPropagation();
        if (activeSession && activeSession.role === 'sender' && !activeSession.isAccepted) {
          abortPendingRequest('ผู้ส่งเปลี่ยนไฟล์', false);
        }
        clearSelectedFiles();
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
        if (!selectedFilesToSend || selectedFilesToSend.length === 0 || !sendTargetMember) return;
        if (activeSession && !activeSession.isComplete) return;
        initiateSendRequest(sendTargetMember, selectedFilesToSend);
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
  function handleFilesSelected(files, autoInitiate = false) {
    if (!files) return;
    const incomingList = Array.isArray(files) ? files : [files];
    if (incomingList.length === 0) return;

    // Deduplicate against already selected files by name, size, lastModified
    const existingKeys = new Set(selectedFilesToSend.map((f) => `${f.name}_${f.size}_${f.lastModified || 0}`));
    for (const f of incomingList) {
      const key = `${f.name}_${f.size}_${f.lastModified || 0}`;
      if (!existingKeys.has(key)) {
        selectedFilesToSend.push(f);
        existingKeys.add(key);
      }
    }

    renderSelectedFilesUI();

    if (autoInitiate && sendTargetMember && selectedFilesToSend.length > 0) {
      initiateSendRequest(sendTargetMember, selectedFilesToSend);
    }
  }

  function removeFileByIndex(index) {
    if (index >= 0 && index < selectedFilesToSend.length) {
      selectedFilesToSend.splice(index, 1);
      renderSelectedFilesUI();
    }
  }

  function renderSelectedFilesUI() {
    if (selectedFilesToSend.length === 0) {
      clearSelectedFiles();
      return;
    }

    if (dom.dropzone) dom.dropzone.classList.add('hidden');
    if (dom.filePreviewCard) dom.filePreviewCard.classList.remove('hidden');

    if (selectedFilesToSend.length === 1) {
      const file = selectedFilesToSend[0];
      if (dom.singleFileView) dom.singleFileView.classList.remove('hidden');
      if (dom.batchFileView) dom.batchFileView.classList.add('hidden');
      if (dom.btnRemoveFile) dom.btnRemoveFile.classList.remove('hidden');

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
    } else {
      // Multi-file batch mode
      if (dom.singleFileView) dom.singleFileView.classList.add('hidden');
      if (dom.batchFileView) dom.batchFileView.classList.remove('hidden');
      if (dom.btnRemoveFile) dom.btnRemoveFile.classList.add('hidden');

      const totalBytes = selectedFilesToSend.reduce((acc, f) => acc + (f.size || 0), 0);
      if (dom.batchSummaryText) {
        dom.batchSummaryText.textContent = `📁 เลือกแล้ว ${selectedFilesToSend.length} ไฟล์ (รวม ${formatBytes(totalBytes)})`;
      }

      if (dom.batchFileList) {
        dom.batchFileList.innerHTML = selectedFilesToSend.map((file, idx) => `
          <div class="p2p-batch-file-item">
            <div class="p2p-batch-file-left">
              <span>${getFileIcon(file.name)}</span>
              <span class="p2p-batch-file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
              <span class="p2p-batch-file-size mono">(${formatBytes(file.size)})</span>
            </div>
            <button type="button" class="p2p-btn-remove-batch-item" data-remove-index="${idx}" title="ลบไฟล์นี้">✕</button>
          </div>
        `).join('');

        dom.batchFileList.querySelectorAll('.p2p-btn-remove-batch-item').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.getAttribute('data-remove-index'), 10);
            removeFileByIndex(idx);
          });
        });
      }

      if (dom.btnConfirmSend) {
        dom.btnConfirmSend.disabled = false;
        dom.btnConfirmSend.textContent = `🚀 ส่งคำขอส่งไฟล์ (${selectedFilesToSend.length} ไฟล์)`;
      }
    }
  }

  function clearSelectedFiles() {
    selectedFilesToSend = [];
    if (dom.fileInput) dom.fileInput.value = '';
    if (dom.dropzone) dom.dropzone.classList.remove('hidden');
    if (dom.filePreviewCard) dom.filePreviewCard.classList.add('hidden');
    if (dom.singleFileView) dom.singleFileView.classList.remove('hidden');
    if (dom.batchFileView) dom.batchFileView.classList.add('hidden');
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
    attachParallelConnSelect();
    const parallelSelect = document.getElementById('p2pParallelConnSelect');
    if (parallelSelect) parallelSelect.value = String(getParallelConnectionSetting());

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
    clearSelectedFiles();

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

    // Trigger native OS file picker immediately on user click
    if (window.electronAPI && typeof window.electronAPI.showOpenDialog === 'function') {
      window.electronAPI.showOpenDialog().then((res) => {
        if (!res.canceled && res.filePath) {
          handleFilesSelected([{
            name: res.fileName,
            size: res.fileSize,
            path: res.filePath,
            isNative: true
          }], true);
        }
      }).catch((err) => {
        console.error('[P2PFileTransfer] Native file picker error:', err);
      });
    } else if (dom.fileInput) {
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
    clearSelectedFiles();
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
      clearSelectedFiles();
      sendTargetMember = null;
    } else {
      if (dom.sendFormState) dom.sendFormState.classList.remove('hidden');
      if (dom.sendWaitingState) dom.sendWaitingState.classList.add('hidden');
      if (dom.btnConfirmSend) {
        dom.btnConfirmSend.disabled = !selectedFilesToSend || selectedFilesToSend.length === 0;
        dom.btnConfirmSend.textContent = '🚀 ส่งคำขอส่งไฟล์';
      }
    }

    if (config.showToast) config.showToast('ยกเลิกคำขอส่งไฟล์เรียบร้อย');
  }

  function initiateSendRequest(targetMember, files) {
    ensureDOM();
    if (!targetMember || !targetMember.uid || !files) return;
    const filesList = Array.isArray(files) ? files.slice() : [files];
    if (filesList.length === 0) return;

    if (timeoutResetTimer) {
      clearTimeout(timeoutResetTimer);
      timeoutResetTimer = null;
    }

    const transferId = `p2p_ft_${Date.now()}_${Math.random().toString(36).substr(2, 7)}`;
    sendTargetMember = targetMember;
    selectedFilesToSend = filesList;

    const totalBytes = filesList.reduce((acc, f) => acc + (f.size || 0), 0);
    const firstFile = filesList[0];

    // Setup active session
    activeSession = {
      role: 'sender',
      transferId,
      targetUid: targetMember.uid,
      targetUsername: targetMember.username || targetMember.uid,
      targetAvatar: targetMember.avatar,
      filesList,
      currentFileIndex: 0,
      file: firstFile,
      completedFilesBytes: 0,
      pc: null,
      dc: null,
      channels: [],
      openChannelsCount: 0,
      pendingCandidates: [],
      transferredBytes: 0,
      totalBytes,
      startTime: 0,
      lastSpeedCheckTime: 0,
      lastSpeedCheckBytes: 0,
      currentSpeed: 0,
      statsInterval: null,
      isPaused: false,
      isCancelled: false,
      isComplete: false,
      isAccepted: false,
      isStreamingStarted: false
    };

    // 1. Immediately disable and lock button on the member card with live countdown
    updateCardButtonState(targetMember.uid, 'waiting', `รอตอบรับ (${REQUEST_TIMEOUT_SEC}s)`);

    // 2. Open/Update the waiting modal with file preview + live countdown
    if (dom.sendTargetAvatar) dom.sendTargetAvatar.src = targetMember.avatar || './assets/avatars/avatar-1.svg';
    if (dom.sendTargetName) dom.sendTargetName.textContent = targetMember.username || targetMember.uid;
    if (dom.sendTargetUid) dom.sendTargetUid.textContent = `UID: ${targetMember.uid}`;

    if (dom.dropzone) dom.dropzone.classList.add('hidden');
    if (dom.filePreviewCard) dom.filePreviewCard.classList.remove('hidden');

    if (filesList.length === 1) {
      if (dom.singleFileView) dom.singleFileView.classList.remove('hidden');
      if (dom.batchFileView) dom.batchFileView.classList.add('hidden');
      if (dom.fileIcon) dom.fileIcon.textContent = getFileIcon(firstFile.name);
      if (dom.fileName) dom.fileName.textContent = firstFile.name;
      if (dom.fileSize) dom.fileSize.textContent = formatBytes(firstFile.size);
    } else {
      if (dom.singleFileView) dom.singleFileView.classList.add('hidden');
      if (dom.batchFileView) dom.batchFileView.classList.remove('hidden');
      if (dom.batchSummaryText) {
        dom.batchSummaryText.textContent = `📁 กำลังส่ง ${filesList.length} ไฟล์ (รวม ${formatBytes(totalBytes)})`;
      }
    }

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
          isNativeElectron: Boolean(window.electronAPI && window.electronAPI.isElectron),
          fileCount: filesList.length,
          totalBytes,
          files: filesList.map((f) => ({
            name: f.name,
            size: f.size,
            type: f.type || 'application/octet-stream'
          })),
          file: {
            name: firstFile.name,
            size: firstFile.size,
            type: firstFile.type || 'application/octet-stream'
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

    const desc = filesList.length > 1
      ? `${filesList.length} ไฟล์ (${formatBytes(totalBytes)})`
      : `ไฟล์ "${firstFile.name}" (${formatBytes(firstFile.size)})`;

    if (config.showToast) {
      config.showToast(`📤 กำลังส่งคำขอ ${desc} ไปหา ${targetMember.username || targetMember.uid}...`);
    }
  }

  // --- Receiver Logic ---
  function handleIncomingRequest(data) {
    ensureDOM();
    if (!data || !data.transferId || !data.from) return;
    const file = data.file || (data.files && data.files[0]);
    if (!file) return;

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

    if (config.playNotificationSound) {
      try { config.playNotificationSound('file', data.from.uid); } catch (e) {}
    }

    if (dom.receiveSenderAvatar) dom.receiveSenderAvatar.src = data.from.avatar || './assets/avatars/avatar-1.svg';
    if (dom.receiveSenderName) dom.receiveSenderName.textContent = data.from.username || data.from.uid;
    if (dom.receiveSenderUid) dom.receiveSenderUid.textContent = `UID: ${data.from.uid}`;

    const filesList = Array.isArray(data.files) && data.files.length > 0 ? data.files : [file];
    const totalBytes = data.totalBytes || filesList.reduce((acc, f) => acc + (f.size || 0), 0);

    if (filesList.length > 1) {
      if (dom.receiveFileIcon) dom.receiveFileIcon.textContent = '📦';
      if (dom.receiveFileName) dom.receiveFileName.textContent = `${filesList.length} ไฟล์ (ขนาดรวม ${formatBytes(totalBytes)})`;
      if (dom.receiveFileSize) dom.receiveFileSize.textContent = `ส่งมาพร้อมกัน ${filesList.length} รายการ`;

      if (dom.receiveBatchPreview) {
        dom.receiveBatchPreview.classList.remove('hidden');
        dom.receiveBatchPreview.innerHTML = filesList.map((f) => `
          <div class="p2p-batch-file-item">
            <div class="p2p-batch-file-left">
              <span>${getFileIcon(f.name)}</span>
              <span class="p2p-batch-file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
              <span class="p2p-batch-file-size mono">(${formatBytes(f.size)})</span>
            </div>
          </div>
        `).join('');
      }

      if (dom.btnAcceptReceive) {
        dom.btnAcceptReceive.textContent = `💾 ยอมรับและเลือกโฟลเดอร์บันทึก (${filesList.length} ไฟล์)`;
      }
    } else {
      if (dom.receiveFileIcon) dom.receiveFileIcon.textContent = getFileIcon(file.name);
      if (dom.receiveFileName) dom.receiveFileName.textContent = file.name;
      if (dom.receiveFileSize) dom.receiveFileSize.textContent = formatBytes(file.size);

      if (dom.receiveBatchPreview) {
        dom.receiveBatchPreview.classList.add('hidden');
      }

      if (dom.btnAcceptReceive) {
        dom.btnAcceptReceive.textContent = '💾 ยอมรับและเลือกที่บันทึกไฟล์';
      }
    }

    if (dom.receiveHugeNotice) {
      if (totalBytes > 10 * 1024 * 1024 * 1024) {
        dom.receiveHugeNotice.classList.remove('hidden');
        dom.receiveHugeNotice.textContent = `💡 ไฟล์ขนาดใหญ่ (${formatBytes(totalBytes)}) ระบบจะเขียนลงฮาร์ดดิสก์ทันทีโดยไม่เปลือง RAM`;
      } else {
        dom.receiveHugeNotice.classList.add('hidden');
      }
    }

    if (dom.receiveModal) {
      dom.receiveModal.classList.remove('hidden');
      dom.receiveModal.style.setProperty('display', 'flex', 'important');
      dom.receiveModal.style.setProperty('z-index', '99999', 'important');
    }

    const toastDesc = filesList.length > 1
      ? `${filesList.length} ไฟล์ (${formatBytes(totalBytes)})`
      : `ไฟล์ "${file.name}"`;

    if (config.showToast) config.showToast(`📥 มีคำขอส่ง ${toastDesc} จาก ${data.from.username || data.from.uid}`);
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

    // --- High-Speed Desktop App Branch (Raw TCP Direct Streaming) ---
    if (window.electronAPI && window.electronAPI.isElectron && req.isNativeElectron) {
      let saveRes;
      try {
        saveRes = await window.electronAPI.showSaveDialog({
          suggestedName: req.file.name
        });
      } catch (dialogErr) {
        console.error('[P2PFileTransfer] Native save dialog error:', dialogErr);
      }

      if (!saveRes || saveRes.canceled || !saveRes.filePath) {
        preparingTransferId = null;
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

      let tcpServerInfo;
      try {
        tcpServerInfo = await window.electronAPI.startTcpReceiver(
          req.transferId,
          saveRes.filePath,
          req.file.size
        );
      } catch (tcpErr) {
        preparingTransferId = null;
        console.error('[P2PFileTransfer] Failed to start native TCP receiver:', tcpErr);
        if (config.showToast) config.showToast('⚠️ ไม่สามารถเปิดพอร์ตรับข้อมูลได้: ' + tcpErr.message);
        return;
      }

      activeSession = {
        role: 'receiver',
        transferId: req.transferId,
        targetUid: req.from.uid,
        targetUsername: req.from.username || req.from.uid,
        targetAvatar: req.from.avatar,
        file: req.file,
        isNativeTcp: true,
        savePath: saveRes.filePath,
        transferredBytes: 0,
        totalBytes: req.file.size,
        startTime: Date.now(),
        lastSpeedCheckTime: Date.now(),
        lastSpeedCheckBytes: 0,
        currentSpeed: 0,
        statsInterval: null,
        isPaused: false,
        isCancelled: false,
        isComplete: false
      };

      openWidget('receiver', req.file, {
        username: req.from.username,
        avatar: req.from.avatar
      });

      if (dom.statusText) {
        dom.statusText.textContent = '🚀 Native TCP Server พร้อมแล้ว กำลังรอผู้ส่งเริ่มสตรีมตรงระดับความเร็วฮาร์ดแวร์...';
      }

      const unbindProgress = window.electronAPI.onTcpProgress((data) => {
        if (activeSession && activeSession.transferId === data.transferId) {
          activeSession.transferredBytes = data.transferred;
          activeSession.currentSpeed = data.speed;
          updateProgressUI(data.transferred, data.total, true);
          if (dom.speedBadge) {
            dom.speedBadge.textContent = `🚀 ${formatBytes(data.speed)}/s (Native Turbo)`;
          }
          if (dom.etaBadge) {
            const remainingBytes = data.total - data.transferred;
            if (data.speed > 1024) {
              const remainingSec = remainingBytes / data.speed;
              dom.etaBadge.textContent = `⏳ เหลืออีก ${formatDuration(remainingSec)}`;
            } else {
              dom.etaBadge.textContent = '⏳ กำลังคำนวณ...';
            }
          }
        }
      });

      const unbindComplete = window.electronAPI.onTcpComplete((data) => {
        if (activeSession && activeSession.transferId === data.transferId) {
          handleTcpTransferComplete();
          if (activeSession && activeSession.tcpUnbinds) {
            activeSession.tcpUnbinds.forEach((fn) => fn());
            activeSession.tcpUnbinds = [];
          }
        }
      });

      const unbindError = window.electronAPI.onTcpError((data) => {
        if (activeSession && activeSession.transferId === data.transferId) {
          cancelTransfer('เกิดข้อผิดพลาดในการรับไฟล์ (Native TCP): ' + data.error);
          if (activeSession && activeSession.tcpUnbinds) {
            activeSession.tcpUnbinds.forEach((fn) => fn());
            activeSession.tcpUnbinds = [];
          }
        }
      });

      activeSession.tcpUnbinds = [unbindProgress, unbindComplete, unbindError];

      sendPacketToPeer(req.from.uid, {
        type: 'p2p_file_response',
        transferId: req.transferId,
        accepted: true,
        isNativeTcp: true,
        port: tcpServerInfo.port,
        localIps: tcpServerInfo.localIps,
        from: { uid: config.currentUser.uid, username: config.currentUser.username }
      });

      return;
    }

    let writableStream = null;
    let dirHandle = null;

    const filesList = Array.isArray(req.files) && req.files.length > 0 ? req.files : [req.file];
    const totalBytes = req.totalBytes || filesList.reduce((acc, f) => acc + (f.size || 0), 0);
    const firstFile = filesList[0];

    if (filesList.length > 1) {
      // Multiple files: prompt user to pick destination directory once
      if (window.showDirectoryPicker) {
        try {
          dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        } catch (err) {
          preparingTransferId = null;
          if (err.name === 'AbortError') {
            if (config.currentUser) {
              sendPacketToPeer(req.from.uid, {
                type: 'p2p_file_response',
                transferId: req.transferId,
                accepted: false,
                reason: 'ผู้รับยกเลิกการเลือกโฟลเดอร์บันทึกไฟล์',
                from: { uid: config.currentUser.uid, username: config.currentUser.username }
              });
            }
            if (config.showToast) config.showToast('ยกเลิกการเลือกโฟลเดอร์');
            return;
          }
          console.error('Directory picker error:', err);
        }
      }

      if (dirHandle) {
        try {
          const firstHandle = await dirHandle.getFileHandle(firstFile.name, { create: true });
          writableStream = await firstHandle.createWritable();
        } catch (e) {
          console.error('Error creating first file stream in directory:', e);
        }
      }
    } else {
      // Single file
      if (window.showSaveFilePicker) {
        try {
          const fileHandle = await window.showSaveFilePicker({
            suggestedName: firstFile.name
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
        if (firstFile.size > 1.5 * 1024 * 1024 * 1024) {
          preparingTransferId = null;
          alert(
            `เบราว์เซอร์นี้ไม่รองรับ File System Access API สำหรับไฟล์ขนาดใหญ่ (${formatBytes(firstFile.size)})\nกรุณาใช้ Google Chrome หรือ Microsoft Edge เพื่อรับไฟล์ขนาดใหญ่ระดับหลาย GB โดยไม่เกิดปัญหาหน่วยความจำ`
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
    }

    // Setup active session for receiver
    activeSession = {
      role: 'receiver',
      transferId: req.transferId,
      targetUid: req.from.uid,
      targetUsername: req.from.username || req.from.uid,
      targetAvatar: req.from.avatar,
      filesList,
      currentFileIndex: 0,
      file: firstFile,
      dirHandle,
      writableStream,
      completedFilesBytes: 0,
      currentFileTransferredBytes: 0,
      pc: null,
      dc: null,
      channels: [],
      pendingCandidates: [],
      receivedChunks: new Map(), // byteOffset -> Uint8Array
      nextWriteOffset: 0,
      bufferedBytesInBatch: 0,
      writeQueue: Promise.resolve(),
      fallbackChunks: (writableStream || dirHandle) ? null : [],
      transferredBytes: 0,
      totalBytes,
      startTime: 0,
      lastSpeedCheckTime: 0,
      lastSpeedCheckBytes: 0,
      currentSpeed: 0,
      statsInterval: null,
      isPaused: false,
      isCancelled: false,
      isComplete: false,
      hasStartedStats: false
    };
    preparingTransferId = null;

    // Prepare WebRTC PeerConnection on receiver BEFORE sending response so receiver is 100% ready for offer
    setupReceiverPeerConnection();

    // Open Floating Progress Widget
    openWidget('receiver', firstFile, req.from, filesList.length, totalBytes);

    // Reply accept to sender
    if (config.currentUser) {
      sendPacketToPeer(req.from.uid, {
        type: 'p2p_file_response',
        transferId: req.transferId,
        accepted: true,
        // Capabilities this receiver understands (older senders ignore this field)
        caps: { multiPc: true, maxPcs: MAX_PARALLEL_CONNECTIONS, fileReady: true, pipeline: true },
        from: { uid: config.currentUser.uid, username: config.currentUser.username }
      });
    }
  }

  // --- WebRTC PeerConnection Setup ---
  function setupReceiverPeerConnection(pcIndex = 0) {
    const pc = new RTCPeerConnection(config.rtcConfig);
    if (!Array.isArray(activeSession.pcs)) activeSession.pcs = [];
    activeSession.pcs[pcIndex] = pc;
    if (pcIndex === 0) activeSession.pc = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate && activeSession && !activeSession.isCancelled) {
        sendPacketToPeer(activeSession.targetUid, {
          type: 'p2p_file_signal',
          transferId: activeSession.transferId,
          pcIndex,
          signal: { type: 'candidate', candidate: event.candidate }
        });
      }
    };

    pc.ondatachannel = (event) => {
      const dc = event.channel;
      dc.binaryType = 'arraybuffer';
      if (!activeSession.channels) activeSession.channels = [];
      activeSession.channels.push(dc);
      // Control messages must go back on the sender's primary channel (connection 0, label p2p_file_0)
      if (pcIndex === 0 && dc.label === 'p2p_file_0') {
        activeSession.primaryDc = dc;
        activeSession.dc = dc;
      } else if (!activeSession.dc) {
        activeSession.dc = dc;
      }
      setupReceiverDataChannel(dc);
    };

    if (pcIndex === 0 && dom.statusText) dom.statusText.textContent = 'กำลังเจาะท่อ P2P (เชื่อมต่อตรง)...';
    return pc;
  }

  function setupReceiverDataChannel(dc) {
    dc.onopen = () => {
      if (!activeSession.hasStartedStats) {
        activeSession.hasStartedStats = true;
        if (dom.statusText) dom.statusText.textContent = 'เชื่อมต่อ P2P สำเร็จ กำลังเริ่มรับข้อมูลความเร็วสูง...';
        activeSession.startTime = Date.now();
        activeSession.lastSpeedCheckTime = Date.now();
        startStatsMonitor();
      }
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
          if (msg.header === 'file_start') {
            await handleReceiverFileStart(msg);
          } else if (msg.header === 'file_end') {
            await finishReceivingCurrentFile(msg);
          } else if (msg.header === 'batch_complete') {
            finishReceivingBatch();
          } else if (msg.header === 'file_cancel') {
            cancelTransfer(msg.reason || 'ผู้ส่งยกเลิกการส่งไฟล์', false);
          }
        } catch (e) {
          console.error('Error parsing control message:', e);
        }
      } else {
        const rawBuffer = event.data;
        if (!rawBuffer || rawBuffer.byteLength < HEADER_SIZE) return;

        // Header: [8 bytes BigUint64 byteOffset]
        // Payload: pure uncompressed binary slice from source file
        const view = new DataView(rawBuffer, 0, HEADER_SIZE);
        const offset = Number(view.getBigUint64(0, false));
        const payload = new Uint8Array(rawBuffer, HEADER_SIZE);

        handleIncomingChunk(offset, payload);
      }
    };
  }

  async function handleReceiverFileStart(msg) {
    if (!activeSession || activeSession.role !== 'receiver' || activeSession.isCancelled) return;

    activeSession.currentFileIndex = msg.fileIndex || 0;
    activeSession.file = {
      name: msg.name,
      size: msg.size,
      type: msg.type
    };

    // Per-file buffers are reset when the previous file completes (or at accept for the first file),
    // NOT here: a pipelined sender may already have delivered chunks of this file before file_start
    // arrived on the primary channel, and those must be kept.
    if (!activeSession.receivedChunks) activeSession.receivedChunks = new Map();
    if (typeof activeSession.nextWriteOffset !== 'number') activeSession.nextWriteOffset = 0;
    if (typeof activeSession.bufferedBytesInBatch !== 'number') activeSession.bufferedBytesInBatch = 0;
    if (!activeSession.writeQueue) activeSession.writeQueue = Promise.resolve();
    if (typeof activeSession.currentFileTransferredBytes !== 'number') activeSession.currentFileTransferredBytes = 0;
    activeSession.fallbackChunks = activeSession.dirHandle ? null : [];

    // Reuse the stream opened at accept time for the first file instead of opening a second one
    if (activeSession.dirHandle && !activeSession.writableStream) {
      try {
        const fileHandle = await activeSession.dirHandle.getFileHandle(msg.name, { create: true });
        activeSession.writableStream = await fileHandle.createWritable();
      } catch (err) {
        console.error('Error creating writable stream in directory:', err);
      }
    }

    const fileList = activeSession.filesList || [activeSession.file];
    const totalFiles = fileList.length;

    if (dom.widgetFileName) {
      dom.widgetFileName.textContent = totalFiles > 1
        ? `(${activeSession.currentFileIndex + 1}/${totalFiles}) ${msg.name}`
        : msg.name;
    }
    if (dom.widgetFileIcon) {
      dom.widgetFileIcon.textContent = getFileIcon(msg.name);
    }
    if (dom.statusText) {
      dom.statusText.textContent = totalFiles > 1
        ? `กำลังรับไฟล์ (${activeSession.currentFileIndex + 1}/${totalFiles}): ${msg.name}...`
        : `กำลังรับไฟล์: ${msg.name}...`;
    }

    // Flush any chunks of this file that arrived before file_start (pipelined sender)
    tryFlushBatch(false);

    // Tell sender we are ready for this file's data (used by senders without pipelining)
    const primaryDc = getPrimaryChannel();
    if (primaryDc && primaryDc.readyState === 'open') {
      try {
        primaryDc.send(JSON.stringify({ header: 'file_ready', fileIndex: activeSession.currentFileIndex }));
      } catch (e) {}
    }

    // file_end may already be waiting if every byte arrived before file_start was processed
    if (activeSession.pendingFileEnd && isCurrentFileFullyReceived()) {
      const endMsg = activeSession.pendingFileEnd;
      activeSession.pendingFileEnd = null;
      finishReceivingCurrentFile(endMsg);
    }
  }

  // The file_end marker travels on the primary channel and can overtake the last data chunks that are
  // still in flight on other channels/connections. Only close the file once every byte has arrived.
  function isCurrentFileFullyReceived() {
    if (!activeSession || !activeSession.file) return true;
    const expected = Number(activeSession.file.size) || 0;
    return (activeSession.currentFileTransferredBytes || 0) >= expected;
  }

  function armFileEndStallTimer() {
    if (!activeSession) return;
    if (activeSession.fileEndStallTimer) clearTimeout(activeSession.fileEndStallTimer);
    activeSession.fileEndStallTimer = setTimeout(() => {
      if (activeSession && activeSession.pendingFileEnd && !activeSession.isCancelled) {
        cancelTransfer('ข้อมูลไฟล์มาไม่ครบ (การเชื่อมต่อสะดุด) กรุณาส่งใหม่อีกครั้ง');
      }
    }, FILE_END_STALL_TIMEOUT_MS);
  }

  function handleIncomingChunk(offset, payload) {
    if (!activeSession || activeSession.isCancelled) return;

    activeSession.receivedChunks.set(offset, payload);
    activeSession.bufferedBytesInBatch += payload.byteLength;
    activeSession.currentFileTransferredBytes = (activeSession.currentFileTransferredBytes || 0) + payload.byteLength;

    const overallTransferred = (activeSession.completedFilesBytes || 0) + activeSession.currentFileTransferredBytes;
    activeSession.transferredBytes = overallTransferred;

    updateProgressUI(activeSession.transferredBytes, activeSession.totalBytes);

    tryFlushBatch(false);

    if (activeSession.pendingFileEnd) {
      if (isCurrentFileFullyReceived()) {
        const endMsg = activeSession.pendingFileEnd;
        activeSession.pendingFileEnd = null;
        if (activeSession.fileEndStallTimer) {
          clearTimeout(activeSession.fileEndStallTimer);
          activeSession.fileEndStallTimer = null;
        }
        finishReceivingCurrentFile(endMsg);
      } else {
        armFileEndStallTimer(); // still making progress -> extend the stall deadline
      }
    }
  }

  function tryFlushBatch(force = false) {
    if (!activeSession || activeSession.isCancelled) return;

    if (!activeSession.writableStream) {
      // In fallback mode (in-memory Blob)
      return;
    }

    while (true) {
      let contiguousBytes = 0;
      let checkOffset = activeSession.nextWriteOffset;
      const partsToFlush = [];

      while (activeSession.receivedChunks.has(checkOffset)) {
        const part = activeSession.receivedChunks.get(checkOffset);
        contiguousBytes += part.byteLength;
        partsToFlush.push(part);
        checkOffset += part.byteLength;
        if (!force && contiguousBytes >= BATCH_SIZE) {
          break;
        }
      }

      if (contiguousBytes === 0) break;
      if (!force && contiguousBytes < BATCH_SIZE) break;

      const batchBuffer = new Uint8Array(contiguousBytes);
      let writePos = 0;
      let removeOffset = activeSession.nextWriteOffset;
      for (let i = 0; i < partsToFlush.length; i++) {
        const part = partsToFlush[i];
        batchBuffer.set(part, writePos);
        writePos += part.byteLength;
        activeSession.receivedChunks.delete(removeOffset);
        removeOffset += part.byteLength;
      }

      activeSession.nextWriteOffset = checkOffset;
      activeSession.bufferedBytesInBatch -= contiguousBytes;

      // Pin the write to THIS file's stream. Reading activeSession.writableStream later would send a
      // queued batch into the next file's stream once the receiver has moved on (pipelined files).
      const targetStream = activeSession.writableStream;
      const session = activeSession;
      activeSession.writeQueue = activeSession.writeQueue
        .then(async () => {
          if (session.isCancelled) return;
          await targetStream.write(batchBuffer);
        })
        .catch((err) => {
          console.error('Error writing batch to disk:', err);
          if (activeSession && !activeSession.isCancelled) {
            cancelTransfer('เกิดข้อผิดพลาดในการเขียนไฟล์ลงฮาร์ดดิสก์: ' + err.message);
          }
        });

      if (!force) break;
    }
  }

  async function finishReceivingCurrentFile(msg) {
    if (!activeSession || activeSession.isCancelled) return;

    if (!isCurrentFileFullyReceived()) {
      activeSession.pendingFileEnd = msg;
      if (dom.statusText) dom.statusText.textContent = 'กำลังรอข้อมูลชิ้นสุดท้าย...';
      armFileEndStallTimer();
      return;
    }

    const session = activeSession;
    const fileIndex = session.currentFileIndex;
    const fileMeta = session.file;
    const fileList = session.filesList || [fileMeta];
    const isLastFile = fileIndex + 1 >= fileList.length;

    // 1. Force flush any remaining tail chunks into THIS file's write queue
    tryFlushBatch(true);

    // 2. Snapshot this file's state, then hand fresh per-file state to the next file BEFORE any slow
    //    disk work. Previously the next file_start could arrive while we were still closing (slow
    //    Chrome close/scan on big files + sender's 10s ack fallback) and closing would wipe the NEW
    //    file's stream (writableStream = null), so the next file was never written.
    const stream = session.writableStream;
    const writeQueue = session.writeQueue;
    const leftoverChunks = session.receivedChunks;
    const useFallbackDownload = !stream && Boolean(session.fallbackChunks);

    session.writableStream = null;
    session.receivedChunks = new Map();
    session.nextWriteOffset = 0;
    session.bufferedBytesInBatch = 0;
    session.writeQueue = Promise.resolve();
    session.currentFileTransferredBytes = 0;
    const listedFile = fileList[fileIndex];
    session.completedFilesBytes = (session.completedFilesBytes || 0) + Number((listedFile && listedFile.size) || fileMeta.size || 0);

    // 3. Tell the sender every byte arrived, so a pipelining sender can start the next file now
    const primaryDc = getPrimaryChannel();
    if (primaryDc && primaryDc.readyState === 'open') {
      try {
        primaryDc.send(JSON.stringify({ header: 'file_received', fileIndex }));
      } catch (e) {}
    }

    if (dom.statusText) {
      dom.statusText.textContent = isLastFile ? 'กำลังบันทึกและปิดไฟล์...' : `กำลังบันทึก ${fileMeta.name} และรับไฟล์ถัดไป...`;
    }

    // 4. Close files strictly in order (acks and the final completion follow disk order)
    session.closeChain = (session.closeChain || Promise.resolve()).then(async () => {
      try {
        await writeQueue;
      } catch (err) {
        console.error('Write queue settling error:', err);
      }
      if (session.isCancelled) return;

      // Commit and close the writable stream so Chrome moves .crswap to the target file
      if (stream) {
        try {
          await stream.close();
        } catch (e) {
          console.error('Error closing writable stream:', e);
          if (activeSession === session && !session.isCancelled) {
            cancelTransfer('ไม่สามารถบันทึกไฟล์ได้: ' + e.message);
          }
          return;
        }
      } else if (useFallbackDownload) {
        try {
          const sortedOffsets = Array.from(leftoverChunks.keys()).sort((a, b) => a - b);
          const allBuffers = sortedOffsets.map((off) => leftoverChunks.get(off));
          const blob = new Blob(allBuffers, { type: fileMeta.type || 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = fileMeta.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          leftoverChunks.clear();
        } catch (e) {
          console.error('Fallback blob error:', e);
        }
      }

      if (session.isCancelled) return;

      // 5. Acknowledge: this file is 100% on disk
      const ackDc = getPrimaryChannel();
      if (activeSession === session && ackDc && ackDc.readyState === 'open') {
        try {
          ackDc.send(JSON.stringify({ header: 'file_ack', fileIndex }));
        } catch (e) {}
      }

      // If this was the last file in the batch (or single file), finish receiver batch
      if (isLastFile && activeSession === session) {
        finishReceivingBatch();
      }
    });
    return session.closeChain;
  }

  function finishReceivingBatch() {
    if (!activeSession || activeSession.isComplete) return;
    activeSession.isComplete = true;
    stopStatsMonitor();

    updateProgressUI(activeSession.totalBytes, activeSession.totalBytes, true);

    const fileList = activeSession.filesList || [activeSession.file];
    const totalFiles = fileList.length;
    const title = '🎉 บันทึกไฟล์สำเร็จ 100%!';
    const sub = totalFiles > 1
      ? `รับครบทั้ง ${totalFiles} ไฟล์ (${formatBytes(activeSession.totalBytes)}) เรียบร้อยแล้ว`
      : `รับไฟล์ "${activeSession.file.name}" (${formatBytes(activeSession.totalBytes)}) เรียบร้อยแล้ว`;

    showCompletionUI(title, sub);

    if (config.showToast) {
      config.showToast(`✅ ${sub}`);
    }

    // Delay connection cleanup so ACK packet is delivered cleanly
    setTimeout(() => {
      cleanupConnections();
    }, 2000);
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

    const fileCount = activeSession.filesList ? activeSession.filesList.length : 1;
    openWidget('sender', activeSession.file, {
      username: activeSession.targetUsername,
      avatar: activeSession.targetAvatar
    }, fileCount, activeSession.totalBytes);

    // --- High-Speed Desktop App Branch (Raw TCP Direct Streaming) ---
    if (data.isNativeTcp && window.electronAPI && activeSession.file && activeSession.file.path) {
      activeSession.isNativeTcp = true;
      if (dom.statusText) dom.statusText.textContent = '🚀 กำลังเชื่อมต่อ Native TCP ท่อตรงระดับฮาร์ดแวร์...';

      const ips = Array.isArray(data.localIps) && data.localIps.length > 0 ? data.localIps : ['127.0.0.1'];
      const lanIp = ips.find((ip) => ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.'));
      const targetIp = lanIp || ips[0];

      const unbindProgress = window.electronAPI.onTcpProgress((tcpData) => {
        if (activeSession && activeSession.transferId === tcpData.transferId) {
          activeSession.transferredBytes = tcpData.transferred;
          activeSession.currentSpeed = tcpData.speed;
          updateProgressUI(tcpData.transferred, tcpData.total, true);
          if (dom.speedBadge) {
            dom.speedBadge.textContent = `🚀 ${formatBytes(tcpData.speed)}/s (Native Turbo)`;
          }
          if (dom.etaBadge) {
            const remainingBytes = tcpData.total - tcpData.transferred;
            if (tcpData.speed > 1024) {
              const remainingSec = remainingBytes / tcpData.speed;
              dom.etaBadge.textContent = `⏳ เหลืออีก ${formatDuration(remainingSec)}`;
            } else {
              dom.etaBadge.textContent = '⏳ กำลังคำนวณ...';
            }
          }
        }
      });

      const unbindComplete = window.electronAPI.onTcpComplete((tcpData) => {
        if (activeSession && activeSession.transferId === tcpData.transferId) {
          handleTcpTransferComplete();
          if (activeSession && activeSession.tcpUnbinds) {
            activeSession.tcpUnbinds.forEach((fn) => fn());
            activeSession.tcpUnbinds = [];
          }
        }
      });

      const unbindError = window.electronAPI.onTcpError((tcpData) => {
        if (activeSession && activeSession.transferId === tcpData.transferId) {
          cancelTransfer('เกิดข้อผิดพลาดในการส่งข้อมูล (Native TCP): ' + tcpData.error);
          if (activeSession && activeSession.tcpUnbinds) {
            activeSession.tcpUnbinds.forEach((fn) => fn());
            activeSession.tcpUnbinds = [];
          }
        }
      });

      activeSession.tcpUnbinds = [unbindProgress, unbindComplete, unbindError];

      window.electronAPI.startTcpSender(
        activeSession.transferId,
        targetIp,
        ips,
        data.port,
        activeSession.file.path,
        activeSession.file.size
      ).catch((err) => {
        cancelTransfer('ไม่สามารถเชื่อมต่อ Native TCP ไปยังผู้รับได้: ' + err.message);
      });

      return;
    }

    if (dom.statusText) dom.statusText.textContent = 'ผู้รับยอมรับแล้ว กำลังสร้างการเชื่อมต่อ P2P...';

    // Peer capabilities (older receivers send none -> single connection, no file_ready handshake)
    activeSession.peerCaps = (data.caps && typeof data.caps === 'object') ? data.caps : {};
    const numConnections = activeSession.peerCaps.multiPc
      ? Math.min(getParallelConnectionSetting(), Number(activeSession.peerCaps.maxPcs) || 1, MAX_PARALLEL_CONNECTIONS)
      : 1;
    const channelsPerPc = Math.max(2, Math.floor(TOTAL_CHANNEL_BUDGET / numConnections));
    activeSession.numConnections = numConnections;
    activeSession.pcs = [];
    activeSession.pendingCandidatesByPc = {};

    const pc = createSenderPeerConnection(0);
    activeSession.pc = pc; // primary connection (control messages + stats)

    activeSession.channels = [];
    activeSession.openChannelsCount = 0;
    activeSession.isStreamingStarted = false;

    const totalChannels = numConnections * channelsPerPc;

    function setupSenderDataChannel(dc, index) {
      dc.onopen = () => {
        if (!activeSession) return;
        activeSession.openChannelsCount++;
        if (dom.statusText && !activeSession.isStreamingStarted) {
          dom.statusText.textContent = `เชื่อมต่อ P2P ${numConnections} เส้น (${activeSession.openChannelsCount}/${totalChannels} ท่อ) สำเร็จ...`;
        }
        // Start as soon as the primary channel is open; other connections join the striping when they open
        if (index === 0 && !activeSession.isStreamingStarted) {
          activeSession.isStreamingStarted = true;
          activeSession.startTime = Date.now();
          activeSession.lastSpeedCheckTime = Date.now();
          startStatsMonitor();
          startStreamingFile();
        }
      };

      dc.onclose = () => {
        if (activeSession && !activeSession.isComplete && !activeSession.isCancelled) {
          cancelTransfer('การเชื่อมต่อหลุดกะทันหัน');
        }
      };

      dc.onerror = (err) => {
        console.error(`Sender DataChannel ${index} error:`, err);
      };

      dc.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.header === 'file_cancel') {
            cancelTransfer(msg.reason || 'ผู้รับได้ยกเลิกการรับไฟล์', false);
          } else if (msg.header === 'file_ack') {
            handleSenderFileAck(msg);
          } else if (msg.header === 'file_received') {
            handleSenderFileReceived(msg);
          } else if (msg.header === 'file_ready') {
            if (activeSession && typeof activeSession.onFileReady === 'function') {
              activeSession.onFileReady(msg.fileIndex || 0);
            }
          }
        } catch (e) {}
      };
    }

    for (let p = 0; p < numConnections; p++) {
      const conn = p === 0 ? pc : createSenderPeerConnection(p);
      for (let i = 0; i < channelsPerPc; i++) {
        // Primary connection keeps legacy labels (p2p_file_0..) so older receivers still recognise them
        const label = p === 0 ? `p2p_file_${i}` : `p2p_file_${p}_${i}`;
        const dc = conn.createDataChannel(label, { ordered: true });
        dc.binaryType = 'arraybuffer';
        dc.bufferedAmountLowThreshold = BUFFER_LOW_WATERMARK;
        setupSenderDataChannel(dc, activeSession.channels.length);
        activeSession.channels.push(dc);
      }
    }
    activeSession.dc = activeSession.channels[0]; // Primary channel (connection 0, channel 0)
    activeSession.primaryDc = activeSession.channels[0];

    for (let p = 0; p < numConnections; p++) {
      const conn = activeSession.pcs[p];
      try {
        const offer = await conn.createOffer();
        await conn.setLocalDescription(offer);
        if (!activeSession || activeSession.isCancelled) return;

        sendPacketToPeer(activeSession.targetUid, {
          type: 'p2p_file_signal',
          transferId: activeSession.transferId,
          pcIndex: p,
          signal: { type: 'offer', sdp: offer }
        });
      } catch (err) {
        console.error('Error creating offer:', err);
        if (p === 0) {
          cancelTransfer('ไม่สามารถสร้างข้อเสนอเชื่อมต่อ WebRTC ได้');
          return;
        }
      }
    }
  }

  function createSenderPeerConnection(pcIndex) {
    const conn = new RTCPeerConnection(config.rtcConfig);
    activeSession.pcs[pcIndex] = conn;
    conn.onicecandidate = (event) => {
      if (event.candidate && activeSession && !activeSession.isCancelled) {
        sendPacketToPeer(activeSession.targetUid, {
          type: 'p2p_file_signal',
          transferId: activeSession.transferId,
          pcIndex,
          signal: { type: 'candidate', candidate: event.candidate }
        });
      }
    };
    return conn;
  }

  function getPrimaryChannel() {
    if (!activeSession) return null;
    return activeSession.primaryDc || (activeSession.channels && activeSession.channels[0]) || activeSession.dc || null;
  }

  function getPendingCandidates(pcIndex) {
    if (!activeSession.pendingCandidatesByPc) activeSession.pendingCandidatesByPc = {};
    if (!activeSession.pendingCandidatesByPc[pcIndex]) {
      // Connection 0 keeps using the legacy queue so nothing queued before this change is lost
      activeSession.pendingCandidatesByPc[pcIndex] = pcIndex === 0 && Array.isArray(activeSession.pendingCandidates)
        ? activeSession.pendingCandidates
        : [];
    }
    return activeSession.pendingCandidatesByPc[pcIndex];
  }

  async function flushPendingCandidates(pc, pcIndex) {
    if (!activeSession || !pc || !pc.remoteDescription) return;
    const queue = getPendingCandidates(pcIndex);
    while (queue.length > 0) {
      const cand = queue.shift();
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (e) {}
    }
  }

  function getPeerConnectionForSignal(pcIndex, signalType) {
    if (!activeSession) return null;
    if (pcIndex === 0) return activeSession.pc;
    if (!Array.isArray(activeSession.pcs)) activeSession.pcs = [activeSession.pc];
    let pc = activeSession.pcs[pcIndex];
    // Receiver creates extra parallel connections lazily when the sender offers them
    if (!pc && activeSession.role === 'receiver' && signalType === 'offer') {
      pc = setupReceiverPeerConnection(pcIndex);
    }
    return pc || null;
  }

  async function handleSignalMessage(data) {
    if (!activeSession || activeSession.transferId !== data.transferId || !data.signal) return;

    const pcIndex = Math.max(0, Math.min(MAX_PARALLEL_CONNECTIONS - 1, parseInt(data.pcIndex, 10) || 0));
    const pc = getPeerConnectionForSignal(pcIndex, data.signal.type);
    if (!pc) {
      // Candidate for a connection whose offer hasn't arrived yet -> queue it
      if (data.signal.type === 'candidate' && data.signal.candidate && activeSession) {
        getPendingCandidates(pcIndex).push(data.signal.candidate);
      }
      return;
    }

    try {
      if (data.signal.type === 'offer') {
        if (pc.signalingState !== 'stable' || pc.remoteDescription) return; // Ignore duplicate offer from dual-channel
        await pc.setRemoteDescription(new RTCSessionDescription(data.signal.sdp));
        await flushPendingCandidates(pc, pcIndex);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        sendPacketToPeer(activeSession.targetUid, {
          type: 'p2p_file_signal',
          transferId: activeSession.transferId,
          pcIndex,
          signal: { type: 'answer', sdp: answer }
        });
      } else if (data.signal.type === 'answer') {
        if (pc.signalingState !== 'have-local-offer') return; // Ignore duplicate answer from dual-channel
        await pc.setRemoteDescription(new RTCSessionDescription(data.signal.sdp));
        await flushPendingCandidates(pc, pcIndex);
      } else if (data.signal.type === 'candidate' && data.signal.candidate) {
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(new RTCIceCandidate(data.signal.candidate)).catch(() => {});
        } else {
          getPendingCandidates(pcIndex).push(data.signal.candidate);
        }
      }
    } catch (err) {
      console.error('Signal handling error:', err);
    }
  }

  // --- High-Performance Multi-Channel Turbo File Streaming Engine ---
  function startStreamingFile() {
    if (!activeSession || activeSession.role !== 'sender') return;
    activeSession.currentFileIndex = 0;
    activeSession.completedFilesBytes = 0;
    streamCurrentBatchFile();
  }

  function streamCurrentBatchFile() {
    if (!activeSession || activeSession.role !== 'sender' || activeSession.isCancelled) return;

    const fileList = activeSession.filesList || [activeSession.file];
    const file = fileList[activeSession.currentFileIndex];
    if (!file) return;

    activeSession.file = file;
    const totalSize = file.size;
    let offset = 0;
    const totalFiles = fileList.length;

    if (dom.statusText) {
      dom.statusText.textContent = totalFiles > 1
        ? `กำลังส่ง (${activeSession.currentFileIndex + 1}/${totalFiles}): ${file.name}...`
        : `กำลังส่ง: ${file.name}...`;
    }
    if (dom.widgetFileName) {
      dom.widgetFileName.textContent = totalFiles > 1
        ? `(${activeSession.currentFileIndex + 1}/${totalFiles}) ${file.name}`
        : file.name;
    }
    if (dom.widgetFileIcon) {
      dom.widgetFileIcon.textContent = getFileIcon(file.name);
    }

    const primaryDc = getPrimaryChannel();
    if (primaryDc && primaryDc.readyState === 'open') {
      try {
        primaryDc.send(
          JSON.stringify({
            header: 'file_start',
            fileIndex: activeSession.currentFileIndex,
            name: file.name,
            size: totalSize,
            type: file.type,
            chunkSize: CHUNK_SIZE,
            numChannels: NUM_CHANNELS
          })
        );
      } catch (e) {}
    }

    // Dynamically calculate effective chunk size based on negotiated SCTP maxMessageSize
    const maxSctp = (activeSession.pc && activeSession.pc.sctp && activeSession.pc.sctp.maxMessageSize)
      ? activeSession.pc.sctp.maxMessageSize
      : 262144;
    // Strictly cap chunk size with safe headroom below maxMessageSize (safe 64KB chunk for all WebRTC SCTP stacks)
    const effectiveChunkSize = Math.max(16384, Math.min(65536, maxSctp) - 1024);

    // Packet Buffer Recycling Pool (16 reusable packet buffers to eliminate GC allocations)
    const PACKET_POOL_SIZE = 16;
    const maxPacketCapacity = Math.max(262144, effectiveChunkSize + HEADER_SIZE + 1024);
    // Reuse one pool for the whole batch (allocating 4 MB per file hurt batches of many small files)
    if (!activeSession.packetPool || activeSession.packetPool[0].byteLength < maxPacketCapacity) {
      activeSession.packetPool = Array.from({ length: PACKET_POOL_SIZE }, () => new Uint8Array(maxPacketCapacity));
    }
    const packetPool = activeSession.packetPool;
    let packetPoolIndex = 0;

    function waitForAllChannelsDrain(callback) {
      if (!activeSession) return callback();

      const openChannels = (activeSession.channels || [activeSession.dc]).filter(
        (ch) => ch && ch.readyState === 'open'
      );
      if (openChannels.length === 0) return callback();

      const isAllDrained = () => openChannels.every((ch) => ch.bufferedAmount === 0);

      if (isAllDrained()) return callback();

      let done = false;
      const onDrain = () => {
        if (done) return;
        done = true;
        if (activeSession && activeSession.channels) {
          activeSession.channels.forEach((ch) => {
            ch.onbufferedamountlow = null;
          });
        }
        clearInterval(pollInterval);
        callback();
      };

      openChannels.forEach((ch) => {
        try {
          ch.bufferedAmountLowThreshold = 0;
        } catch (e) {}
        ch.onbufferedamountlow = () => {
          if (isAllDrained()) onDrain();
        };
      });

      const pollInterval = setInterval(() => {
        if (!activeSession || isAllDrained()) {
          onDrain();
        }
      }, 50);
    }

    // Block read pipeline with one-block prefetch (double buffering)
    let blockBuf = null;
    let blockStart = 0;
    let prefetch = null; // { start, promise }
    const readBlock = (start) => file.slice(start, Math.min(start + READ_BLOCK_SIZE, totalSize)).arrayBuffer();
    async function getChunkView(chunkStart, chunkEnd) {
      if (!blockBuf || chunkStart < blockStart || chunkEnd > blockStart + blockBuf.byteLength) {
        const buf = prefetch && prefetch.start === chunkStart ? await prefetch.promise : await readBlock(chunkStart);
        blockBuf = new Uint8Array(buf);
        blockStart = chunkStart;
        const nextStart = blockStart + blockBuf.byteLength;
        prefetch = nextStart < totalSize ? { start: nextStart, promise: readBlock(nextStart) } : null;
        if (prefetch) prefetch.promise.catch(() => {}); // surfaced when awaited
      }
      return blockBuf.subarray(chunkStart - blockStart, chunkEnd - blockStart);
    }

    async function sendNextChunks() {
      if (!activeSession || activeSession.isCancelled || activeSession.isComplete) return;

      let chunksSinceYield = 0;
      while (offset < totalSize && !activeSession.isCancelled) {
        const openChannels = (activeSession.channels || [activeSession.dc]).filter(
          (ch) => ch && ch.readyState === 'open'
        );
        if (openChannels.length === 0) return;

        // Striping: select channel with lowest bufferedAmount
        let bestDc = openChannels[0];
        for (let i = 1; i < openChannels.length; i++) {
          if (openChannels[i].bufferedAmount < bestDc.bufferedAmount) {
            bestDc = openChannels[i];
          }
        }

        // Apply backpressure if the best available channel is congested
        if (bestDc.bufferedAmount > BUFFER_HIGH_WATERMARK) {
          try {
            bestDc.bufferedAmountLowThreshold = BUFFER_LOW_WATERMARK;
          } catch (e) {}
          bestDc.onbufferedamountlow = () => {
            bestDc.onbufferedamountlow = null;
            sendNextChunks();
          };
          return;
        }

        const chunkEnd = Math.min(offset + effectiveChunkSize, totalSize);

        let sliceBuf;
        try {
          sliceBuf = await getChunkView(offset, chunkEnd);
          if (!activeSession || activeSession.isCancelled) return;
        } catch (err) {
          console.error('Error reading slice from disk:', err);
          cancelTransfer('เกิดข้อผิดพลาดในการอ่านไฟล์: ' + err.message);
          return;
        }

        const payloadLen = sliceBuf.byteLength;
        const totalPacketLen = HEADER_SIZE + payloadLen;

        // Recycle packet buffer from pool to eliminate GC allocations
        const packet = packetPool[packetPoolIndex % PACKET_POOL_SIZE];
        packetPoolIndex++;

        // Header: [8 bytes BigUint64 uncompressed byteOffset]
        const view = new DataView(packet.buffer, packet.byteOffset, HEADER_SIZE);
        view.setBigUint64(0, BigInt(offset), false);
        packet.set(sliceBuf, HEADER_SIZE);

        try {
          bestDc.send(packet.subarray(0, totalPacketLen));
        } catch (sendErr) {
          console.error('DataChannel send error:', sendErr);
          cancelTransfer('เกิดข้อผิดพลาดในการส่งข้อมูลผ่าน DataChannel: ' + sendErr.message);
          return;
        }

        offset += sliceBuf.byteLength;
        const overall = (activeSession.completedFilesBytes || 0) + offset;
        activeSession.transferredBytes = overall;

        updateProgressUI(overall, activeSession.totalBytes);

        // Yield to event loop periodically to keep the UI responsive (un-throttled even in background tabs)
        if (++chunksSinceYield >= 16) {
          yieldToEventLoop(sendNextChunks);
          return;
        }
      }

      if (offset >= totalSize && !activeSession.isCancelled) {
        if (dom.statusText) {
          dom.statusText.textContent = totalFiles > 1
            ? `ส่งไฟล์ (${activeSession.currentFileIndex + 1}/${totalFiles}) ครบแล้ว กำลังรอผู้รับบันทึก...`
            : 'ส่งข้อมูลครบแล้ว กำลังรอผู้รับบันทึกไฟล์ลงดิสก์...';
        }

        if (isPipelined()) {
          // Pipelined receiver waits for every byte itself, so no need to stall until all channel
          // buffers drain: mark the end right away and start the next file on 'file_received'.
          try {
            const primary = getPrimaryChannel();
            if (primary && primary.readyState === 'open') {
              primary.send(JSON.stringify({ header: 'file_end', fileIndex: activeSession.currentFileIndex }));
            }
          } catch (e) {
            console.error('Error sending file_end:', e);
          }
          armSenderWaitTimeout();
          return;
        }

        waitForAllChannelsDrain(() => {
          if (!activeSession || activeSession.isCancelled || activeSession.isComplete) return;
          try {
            const primary = getPrimaryChannel();
            if (primary && primary.readyState === 'open') {
              primary.send(JSON.stringify({ header: 'file_end', fileIndex: activeSession.currentFileIndex }));
            }
          } catch (e) {
            console.error('Error sending file_end:', e);
          }
          waitForReceiverAck();
        });
      }
    }

    // Data chunks travel on many channels/connections while file_start travels on the primary channel only,
    // so chunks could overtake file_start. Pipelined receivers buffer such early chunks, so we stream at once.
    // Receivers with only 'fileReady' confirm before we stream (older receivers: start immediately).
    if (isPipelined()) {
      sendNextChunks();
    } else if (activeSession.peerCaps && activeSession.peerCaps.fileReady) {
      const fileIndex = activeSession.currentFileIndex;
      let started = false;
      const begin = () => {
        if (started) return;
        started = true;
        if (activeSession) {
          activeSession.onFileReady = null;
          if (activeSession.fileReadyTimer) {
            clearTimeout(activeSession.fileReadyTimer);
            activeSession.fileReadyTimer = null;
          }
        }
        sendNextChunks();
      };
      activeSession.onFileReady = (idx) => {
        if (idx === fileIndex) begin();
      };
      activeSession.fileReadyTimer = setTimeout(begin, FILE_READY_TIMEOUT_MS);
    } else {
      sendNextChunks();
    }
  }

  // --- Pipelined multi-file mode (receiver advertises caps.pipeline) ---
  // Old flow per file: drain all buffers -> file_end -> wait for disk close + ack -> file_start -> wait file_ready.
  // That is 2-3 round trips plus an empty pipe per file. Pipelined: next file starts as soon as the receiver
  // reports every byte arrived ('file_received'); disk closing happens in the background on the receiver.
  const SENDER_PIPELINE_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

  function isPipelined() {
    return Boolean(activeSession && activeSession.peerCaps && activeSession.peerCaps.pipeline);
  }

  function armSenderWaitTimeout() {
    if (!activeSession) return;
    if (activeSession.ackTimeout) clearTimeout(activeSession.ackTimeout);
    const session = activeSession;
    activeSession.ackTimeout = setTimeout(() => {
      if (activeSession === session && !session.isComplete && !session.isCancelled) {
        cancelTransfer('ผู้รับไม่ตอบสนองนานเกินไป การส่งไฟล์ถูกยกเลิก');
      }
    }, SENDER_PIPELINE_WAIT_TIMEOUT_MS);
  }

  function handleSenderFileReceived(msg) {
    if (!isPipelined() || activeSession.role !== 'sender' || activeSession.isCancelled || activeSession.isComplete) return;
    const fileIndex = Number(msg.fileIndex) || 0;
    if (fileIndex !== activeSession.currentFileIndex || activeSession.awaitingFinalAck) return;

    const fileList = activeSession.filesList || [activeSession.file];
    const currentFile = fileList[fileIndex];
    if (currentFile) {
      activeSession.completedFilesBytes = (activeSession.completedFilesBytes || 0) + currentFile.size;
    }

    if (fileIndex + 1 < fileList.length) {
      activeSession.currentFileIndex = fileIndex + 1;
      streamCurrentBatchFile();
    } else {
      // Last file: success is only reported once the receiver confirms it is on disk (file_ack)
      activeSession.awaitingFinalAck = true;
      if (dom.statusText) dom.statusText.textContent = 'ส่งข้อมูลครบแล้ว กำลังรอผู้รับบันทึกไฟล์ลงดิสก์...';
      armSenderWaitTimeout();
    }
  }

  function handleSenderFileAck(msg) {
    if (!activeSession || activeSession.role !== 'sender' || activeSession.isCancelled) return;

    if (isPipelined()) {
      // Acks for earlier files only confirm their disk close; the batch completes on the LAST file's ack
      const fileList = activeSession.filesList || [activeSession.file];
      const lastIndex = fileList.length - 1;
      if (!activeSession.awaitingFinalAck || (Number(msg.fileIndex) || 0) !== lastIndex) return;
      if (activeSession.ackTimeout) {
        clearTimeout(activeSession.ackTimeout);
        activeSession.ackTimeout = null;
      }
      const primaryDc = getPrimaryChannel();
      if (primaryDc && primaryDc.readyState === 'open') {
        try {
          primaryDc.send(JSON.stringify({ header: 'batch_complete' }));
        } catch (e) {}
      }
      finishSendingBatch();
      return;
    }

    if (activeSession.ackTimeout) {
      clearTimeout(activeSession.ackTimeout);
      activeSession.ackTimeout = null;
    }

    const fileList = activeSession.filesList || [activeSession.file];
    const currentFile = fileList[activeSession.currentFileIndex];
    if (currentFile) {
      activeSession.completedFilesBytes = (activeSession.completedFilesBytes || 0) + currentFile.size;
    }
    activeSession.currentFileIndex++;

    if (activeSession.currentFileIndex < fileList.length) {
      // Send next file in batch!
      streamCurrentBatchFile();
    } else {
      // All files sent!
      const primaryDc = getPrimaryChannel();
      if (primaryDc && primaryDc.readyState === 'open') {
        try {
          primaryDc.send(JSON.stringify({ header: 'batch_complete' }));
        } catch (e) {}
      }
      finishSendingBatch();
    }
  }

  function waitForReceiverAck() {
    if (!activeSession) return;
    if (activeSession.ackTimeout) clearTimeout(activeSession.ackTimeout);
    // Safety fallback: if receiver ACK doesn't arrive within 10s, finish anyway
    activeSession.ackTimeout = setTimeout(() => {
      if (activeSession && activeSession.role === 'sender' && !activeSession.isComplete) {
        console.log('Receiver ACK timeout fallback - completing sender transfer');
        const fileList = activeSession.filesList || [activeSession.file];
        if (activeSession.currentFileIndex + 1 >= fileList.length) {
          finishSendingBatch();
        } else {
          handleSenderFileAck({ header: 'file_ack' });
        }
      }
    }, 10000);
  }

  function finishSendingBatch() {
    if (!activeSession || activeSession.role !== 'sender' || activeSession.isComplete) return;
    activeSession.isComplete = true;
    if (activeSession.ackTimeout) {
      clearTimeout(activeSession.ackTimeout);
      activeSession.ackTimeout = null;
    }
    stopStatsMonitor();

    if (activeSession.targetUid) {
      updateCardButtonState(activeSession.targetUid, 'default');
    }

    updateProgressUI(activeSession.totalBytes, activeSession.totalBytes, true);

    const fileList = activeSession.filesList || [activeSession.file];
    const totalFiles = fileList.length;
    const title = '🎉 ส่งไฟล์สำเร็จ 100%!';
    const sub = totalFiles > 1
      ? `ส่งครบทั้ง ${totalFiles} ไฟล์ (${formatBytes(activeSession.totalBytes)}) ให้ ${activeSession.targetUsername} เรียบร้อยแล้ว`
      : `ส่งไฟล์ "${activeSession.file.name}" (${formatBytes(activeSession.totalBytes)}) ให้ ${activeSession.targetUsername} เรียบร้อยแล้ว`;

    showCompletionUI(title, sub);
    if (config.showToast) {
      config.showToast(`✅ ${sub}`);
    }

    // Delay connection cleanup so both sides close gracefully
    setTimeout(() => {
      cleanupConnections();
    }, 2000);
  }

  const finishSendingFile = finishSendingBatch;

  function handleTcpTransferComplete() {
    if (!activeSession || activeSession.isComplete) return;
    activeSession.isComplete = true;
    stopStatsMonitor();

    if (activeSession.targetUid) {
      updateCardButtonState(activeSession.targetUid, 'default');
    }

    updateProgressUI(activeSession.totalBytes, activeSession.totalBytes, true);

    if (activeSession.role === 'sender') {
      showCompletionUI(
        '🎉 ส่งไฟล์สำเร็จ 100%!',
        `ส่งไฟล์ "${activeSession.file.name}" (${formatBytes(activeSession.totalBytes)}) ให้ ${activeSession.targetUsername} เรียบร้อยแล้ว (Native Turbo)`
      );
      if (config.showToast) {
        config.showToast(
          `✅ ส่งไฟล์ "${activeSession.file.name}" (${formatBytes(activeSession.totalBytes)}) ให้ ${activeSession.targetUsername} สำเร็จ!`
        );
      }
    } else {
      showCompletionUI(
        '🎉 บันทึกไฟล์สำเร็จ 100%!',
        `รับไฟล์ "${activeSession.file.name}" (${formatBytes(activeSession.totalBytes)}) เรียบร้อยแล้ว (Native Turbo)`
      );
      if (config.showToast) {
        config.showToast(`✅ รับไฟล์ "${activeSession.file.name}" (${formatBytes(activeSession.totalBytes)}) สำเร็จเรียบร้อย!`);
      }
    }

    setTimeout(() => {
      cleanupConnections();
    }, 2000);
  }

  // --- Speedometer & ETA Calculator ---
  function startStatsMonitor() {
    stopStatsMonitor();
    activeSession.statsInterval = setInterval(() => {
      if (!activeSession || activeSession.isCancelled || activeSession.isComplete) return;

      const now = Date.now();
      const elapsedSec = (now - activeSession.lastSpeedCheckTime) / 1000;
      if (elapsedSec >= 0.8) {
        // Sender: transferredBytes counts bytes QUEUED into DataChannels (up to several MB ahead of the
        // network), which made the meter swing between 0 and burst speed. Count only bytes that left the queue.
        let measuredBytes = activeSession.transferredBytes || 0;
        if (activeSession.role === 'sender' && Array.isArray(activeSession.channels)) {
          const queued = activeSession.channels.reduce((sum, ch) => sum + ((ch && ch.bufferedAmount) || 0), 0);
          measuredBytes = Math.max(activeSession.lastSpeedCheckBytes || 0, measuredBytes - queued);
        }
        const bytesDelta = measuredBytes - (activeSession.lastSpeedCheckBytes || 0);
        const instantSpeed = Math.max(0, bytesDelta / elapsedSec);
        // Light smoothing so the badge doesn't jitter
        const currentSpeed = activeSession.currentSpeed ? activeSession.currentSpeed * 0.4 + instantSpeed * 0.6 : instantSpeed;

        activeSession.currentSpeed = currentSpeed;
        activeSession.lastSpeedCheckTime = now;
        activeSession.lastSpeedCheckBytes = measuredBytes;

        const openPcCount = getAllPeerConnections().filter((c) => c.connectionState === 'connected').length || 1;
        if (dom.speedBadge) {
          const diag = activeSession.connDiag ? ` · ${activeSession.connDiag}` : '';
          dom.speedBadge.textContent = `⚡ ${formatBytes(currentSpeed)}/s (${openPcCount} เส้น)${diag}`;
          dom.speedBadge.title = activeSession.connDiagDetail || '';
        }
        if (!activeSession.lastDiagAt || now - activeSession.lastDiagAt > 3000) {
          activeSession.lastDiagAt = now;
          updateConnectionDiagnostics();
        }

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

  // True for addresses only reachable inside a local network (RFC1918, CGNAT-free private ranges,
  // loopback, link-local, IPv6 ULA) and for mDNS-obfuscated '.local' names (resolvable on the LAN only).
  function isPrivateOrLinkLocalAddress(addr) {
    const a = String(addr || '').trim().toLowerCase();
    if (!a) return false;
    if (a.endsWith('.local')) return true;
    const v4 = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
      const o1 = Number(v4[1]);
      const o2 = Number(v4[2]);
      return o1 === 10 || o1 === 127 ||
        (o1 === 172 && o2 >= 16 && o2 <= 31) ||
        (o1 === 192 && o2 === 168) ||
        (o1 === 169 && o2 === 254);
    }
    if (a.includes(':')) {
      return a === '::1' || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb') ||
        a.startsWith('fc') || a.startsWith('fd');
    }
    return false;
  }

  // Reads the selected ICE candidate pair to show WHERE the bottleneck likely is:
  // LAN (host) vs. internet (srflx/prflx) vs. TURN relay, plus round-trip time.
  async function updateConnectionDiagnostics() {
    const session = activeSession;
    const pc = session && session.pc;
    if (!pc || typeof pc.getStats !== 'function') return;
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach((s) => {
        if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId) || pair;
      });
      if (!pair) {
        stats.forEach((s) => {
          if (!pair && s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
        });
      }
      if (!pair || activeSession !== session) return;
      const local = stats.get(pair.localCandidateId) || {};
      const remote = stats.get(pair.remoteCandidateId) || {};
      const types = [local.candidateType, remote.candidateType];
      // host→host alone does NOT mean LAN: public IPv6 addresses are host candidates too, so a direct
      // IPv6 path across the internet also looks like host→host. Decide by the remote address.
      const remoteAddr = remote.address || remote.ip || '';
      let route = 'อินเทอร์เน็ต';
      if (types.includes('relay')) route = 'ผ่าน TURN relay';
      else if (local.candidateType === 'host' && remote.candidateType === 'host') {
        route = isPrivateOrLinkLocalAddress(remoteAddr) ? 'วงแลน' : 'อินเทอร์เน็ต (ต่อตรง)';
      }
      const rttMs = typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null;
      session.connDiag = `${route}${rttMs !== null ? ` · RTT ${rttMs}ms` : ''}`;
      session.connDiagDetail = `เส้นทาง: ${local.candidateType || '?'} → ${remote.candidateType || '?'} (${local.protocol || pair.protocol || '?'})` +
        `${rttMs !== null ? ` | RTT ${rttMs}ms` : ''} | การเชื่อมต่อขนาน ${getAllPeerConnections().length} เส้น`;
    } catch (e) {}
  }

  function stopStatsMonitor() {
    if (activeSession && activeSession.statsInterval) {
      clearInterval(activeSession.statsInterval);
      activeSession.statsInterval = null;
    }
  }

  // --- Throttled UI Progress Updates ---
  let lastUiUpdateTime = 0;
  function updateProgressUI(transferred, total, force = false) {
    if (!dom.progressBar) return;
    const now = performance.now();
    if (!force && now - lastUiUpdateTime < 75) return; // Cap DOM update to ~13 FPS
    lastUiUpdateTime = now;

    const overallTransferred = (activeSession ? (activeSession.completedFilesBytes || 0) : 0) + (activeSession ? (activeSession.currentFileTransferred || activeSession.currentFileTransferredBytes || 0) : transferred);
    const overallTotal = (activeSession ? activeSession.totalBytes : total) || 1;
    const pct = Math.min(100, (overallTransferred / overallTotal) * 100);

    dom.progressBar.style.width = `${pct.toFixed(1)}%`;
    if (dom.progressPercent) dom.progressPercent.textContent = `${pct.toFixed(1)}%`;
    if (dom.bytesTransferred) dom.bytesTransferred.textContent = `${formatBytes(overallTransferred)} / ${formatBytes(overallTotal)}`;
  }

  function openWidget(role, file, peer, fileCount = 1, totalBytes = 0) {
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

    const effectiveTotal = totalBytes > 0 ? totalBytes : (file ? file.size : 0);

    if (dom.widgetPeerName) dom.widgetPeerName.textContent = peer.username || peer.uid || 'เพื่อน';
    if (dom.widgetFileIcon) dom.widgetFileIcon.textContent = fileCount > 1 ? '📦' : getFileIcon(file ? file.name : '');
    if (dom.widgetFileName) dom.widgetFileName.textContent = fileCount > 1 ? `(1/${fileCount}) ${file ? file.name : ''}` : (file ? file.name : '');
    if (dom.widgetFileSize) dom.widgetFileSize.textContent = fileCount > 1 ? `${formatBytes(effectiveTotal)} (${fileCount} ไฟล์)` : formatBytes(file ? file.size : 0);

    if (dom.progressBar) dom.progressBar.style.width = '0%';
    if (dom.progressPercent) dom.progressPercent.textContent = '0%';
    if (dom.bytesTransferred) dom.bytesTransferred.textContent = `0 B / ${formatBytes(effectiveTotal)}`;
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
    clearTransferTimers();

    if (activeSession.ackTimeout) {
      clearTimeout(activeSession.ackTimeout);
      activeSession.ackTimeout = null;
    }

    const targetUid = activeSession.targetUid;

    if (activeSession.isNativeTcp && window.electronAPI) {
      try {
        window.electronAPI.cancelTcpTransfer(activeSession.transferId);
      } catch (e) {}
      if (activeSession.tcpUnbinds) {
        activeSession.tcpUnbinds.forEach((fn) => fn());
        activeSession.tcpUnbinds = [];
      }
      if (notifyRemote && targetUid) {
        sendPacketToPeer(targetUid, {
          type: 'p2p_file_cancel_transfer',
          transferId: activeSession.transferId,
          reason
        });
      }
    }

    const primaryDc = getPrimaryChannel();
    if (notifyRemote && primaryDc && primaryDc.readyState === 'open') {
      try {
        primaryDc.send(JSON.stringify({ header: 'file_cancel', reason }));
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
    if (activeSession.ackTimeout) {
      clearTimeout(activeSession.ackTimeout);
      activeSession.ackTimeout = null;
    }
    if (activeSession.targetUid) {
      updateCardButtonState(activeSession.targetUid, 'default');
    }
    if (activeSession.isNativeTcp && window.electronAPI) {
      try {
        window.electronAPI.cancelTcpTransfer(activeSession.transferId);
      } catch (e) {}
      if (activeSession.tcpUnbinds) {
        activeSession.tcpUnbinds.forEach((fn) => fn());
        activeSession.tcpUnbinds = [];
      }
    }
    if (activeSession.channels) {
      activeSession.channels.forEach((ch) => {
        try { ch.close(); } catch (e) {}
      });
      activeSession.channels = [];
    }
    if (activeSession.dc) {
      try { activeSession.dc.close(); } catch (e) {}
      activeSession.dc = null;
    }
    clearTransferTimers();
    getAllPeerConnections().forEach((conn) => {
      try { conn.close(); } catch (e) {}
    });
    activeSession.pcs = [];
    activeSession.primaryDc = null;
    if (activeSession.pc) {
      try { activeSession.pc.close(); } catch (e) {}
      activeSession.pc = null;
    }
    stopStatsMonitor();
  }

  function clearTransferTimers() {
    if (!activeSession) return;
    if (activeSession.fileReadyTimer) {
      clearTimeout(activeSession.fileReadyTimer);
      activeSession.fileReadyTimer = null;
    }
    if (activeSession.fileEndStallTimer) {
      clearTimeout(activeSession.fileEndStallTimer);
      activeSession.fileEndStallTimer = null;
    }
    activeSession.onFileReady = null;
    activeSession.pendingFileEnd = null;
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

    cancelIfTargetMatches: function (targetUid, reason = 'คู่สนทนาออกจากห้อง การส่งไฟล์ถูกยกเลิกอัตโนมัติ') {
      const cleanTarget = sanitizeUid(targetUid);
      if (!cleanTarget) return;

      if (pendingIncomingRequest && pendingIncomingRequest.senderUid === cleanTarget) {
        if (dom.receiveModal) {
          dom.receiveModal.classList.add('hidden');
          dom.receiveModal.style.setProperty('display', 'none', 'important');
        }
        pendingIncomingRequest = null;
        if (config.showToast) {
          config.showToast(`ℹ️ ${reason}`, 4000);
        }
      }

      if (activeSession && activeSession.targetUid === cleanTarget && !activeSession.isCompleted && !activeSession.isCancelled) {
        cancelTransfer(reason, false);
      }
    },

    cancelActiveTransfer: function (reason = 'การส่งไฟล์ถูกยกเลิก') {
      if (activeSession && !activeSession.isCompleted && !activeSession.isCancelled) {
        cancelTransfer(reason, true);
      }
      abortPendingRequest(reason, true);
      if (dom.receiveModal) {
        dom.receiveModal.classList.add('hidden');
        dom.receiveModal.style.setProperty('display', 'none', 'important');
      }
      pendingIncomingRequest = null;
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
      if (data.type === 'p2p_file_cancel_transfer') {
        if (activeSession && activeSession.transferId === data.transferId) {
          cancelTransfer(data.reason || 'อีกฝ่ายยกเลิกการถ่ายโอน', false);
        }
        return true;
      }

      return false;
    }
  };
})();
