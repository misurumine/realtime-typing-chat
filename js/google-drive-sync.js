/**
 * Google Login & Google Drive AppData Synchronization
 * Syncs user profile, interest tags, and friends list directly to the user's private Google Drive (appDataFolder).
 * Zero server required — 100% Client-Side.
 */

(function (window) {
  'use strict';

  const STORAGE_KEY_CLIENT_ID = 'livetype_google_client_id';
  const STORAGE_KEY_TOKEN = 'livetype_google_access_token';
  const STORAGE_KEY_FILE_ID = 'livetype_drive_file_id';
  const DATA_FILENAME = 'livetype_user_backup.json';

  // Default Client ID (Users can set their own Client ID or enter via UI)
  let activeClientId = localStorage.getItem(STORAGE_KEY_CLIENT_ID) || '';
  let tokenClient = null;
  let currentAccessToken = sessionStorage.getItem(STORAGE_KEY_TOKEN) || null;
  let appDataFileId = localStorage.getItem(STORAGE_KEY_FILE_ID) || null;

  // Sanitization helpers for XSS & injection prevention
  function sanitizeUsername(input) {
    if (!input || typeof input !== 'string') return 'User';
    return input.replace(/[\x00-\x1F\x7F<>"/\\&]/g, '').trim().slice(0, 24) || 'User';
  }

  function sanitizeAvatarUrl(url, fallback) {
    const defaultAvatar = fallback || './assets/avatars/avatar-1.svg';
    if (!url || typeof url !== 'string') return defaultAvatar;
    const trimmed = url.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(trimmed)) return trimmed;
    if (/^\.\/assets\/avatars\/avatar-\d+\.svg$/i.test(trimmed)) return trimmed;
    return defaultAvatar;
  }

  function getClientId() {
    return activeClientId || localStorage.getItem(STORAGE_KEY_CLIENT_ID) || '';
  }

  function setClientId(id) {
    activeClientId = String(id || '').trim();
    if (activeClientId) {
      localStorage.setItem(STORAGE_KEY_CLIENT_ID, activeClientId);
    } else {
      localStorage.removeItem(STORAGE_KEY_CLIENT_ID);
    }
    tokenClient = null; // Re-create client on next login
  }

  function hasValidClientId() {
    const id = getClientId();
    return Boolean(id && id.length > 10 && id.includes('.apps.googleusercontent.com'));
  }

  function getAccessToken() {
    return currentAccessToken;
  }

  function setAccessToken(token) {
    currentAccessToken = token;
    if (token) {
      sessionStorage.setItem(STORAGE_KEY_TOKEN, token);
    } else {
      sessionStorage.removeItem(STORAGE_KEY_TOKEN);
    }
  }

  // Request Access Token via Google Identity Services (GIS)
  function promptGoogleLogin() {
    return new Promise((resolve, reject) => {
      if (typeof window.google === 'undefined' || !window.google.accounts || !window.google.accounts.oauth2) {
        return reject(new Error('GIS_NOT_LOADED'));
      }

      const clientId = getClientId();
      if (!clientId) {
        return reject(new Error('NO_CLIENT_ID'));
      }

      try {
        tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
          callback: (response) => {
            if (response.error) {
              reject(new Error(response.error_description || response.error));
              return;
            }
            setAccessToken(response.access_token);
            resolve(response.access_token);
          },
          error_callback: (err) => {
            reject(err);
          }
        });

        tokenClient.requestAccessToken({ prompt: 'select_account' });
      } catch (err) {
        reject(err);
      }
    });
  }

  // 1. Fetch Google User Profile (Name, Email, Picture, Google Sub ID)
  async function fetchGoogleUserInfo(token) {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch user info: ${res.status}`);
    }
    return await res.json();
  }

  // 2. Search for livetype_user_backup.json in Google Drive appDataFolder
  async function findAppDataFile(token) {
    try {
      const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='${encodeURIComponent(DATA_FILENAME)}'+and+trashed=false&fields=files(id,name,modifiedTime)`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.files && data.files.length > 0) {
        appDataFileId = data.files[0].id;
        localStorage.setItem(STORAGE_KEY_FILE_ID, appDataFileId);
        return appDataFileId;
      }
    } catch (e) {
      console.warn('Error searching Google Drive appDataFolder:', e);
    }
    return null;
  }

  // 3. Download Backup from Google Drive appDataFolder
  async function downloadAppData(token, fileId) {
    try {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.warn('Error downloading from Google Drive appDataFolder:', e);
      return null;
    }
  }

  // 4. Upload/Save Backup to Google Drive appDataFolder
  async function saveAppData(token, payload) {
    if (!token) return false;
    const bodyStr = JSON.stringify(payload);

    try {
      let fileId = appDataFileId || (await findAppDataFile(token));

      if (fileId) {
        // Update existing file in appDataFolder
        const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: bodyStr
        });
        return res.ok;
      } else {
        // Create new file in appDataFolder using multipart upload
        const metadata = {
          name: DATA_FILENAME,
          parents: ['appDataFolder']
        };

        const boundary = '-------314159265358979323846';
        const delimiter = `\r\n--${boundary}\r\n`;
        const closeDelimiter = `\r\n--${boundary}--`;

        const multipartRequestBody =
          delimiter +
          'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify(metadata) +
          delimiter +
          'Content-Type: application/json\r\n\r\n' +
          bodyStr +
          closeDelimiter;

        const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
          },
          body: multipartRequestBody
        });

        if (res.ok) {
          const result = await res.json();
          appDataFileId = result.id;
          localStorage.setItem(STORAGE_KEY_FILE_ID, appDataFileId);
          return true;
        }
      }
    } catch (e) {
      console.warn('Error saving to Google Drive appDataFolder:', e);
    }
    return false;
  }

  // 5. Revoke / Sign Out
  function revokeToken() {
    const token = currentAccessToken;
    if (token && window.google && window.google.accounts && window.google.accounts.oauth2) {
      try {
        window.google.accounts.oauth2.revoke(token, () => {});
      } catch (e) {}
    }
    setAccessToken(null);
    appDataFileId = null;
    localStorage.removeItem(STORAGE_KEY_FILE_ID);
  }

  // Export to global LiveTypeDrive
  window.LiveTypeDrive = {
    getClientId,
    setClientId,
    hasValidClientId,
    getAccessToken,
    promptGoogleLogin,
    fetchGoogleUserInfo,
    findAppDataFile,
    downloadAppData,
    saveAppData,
    revokeToken,
    sanitizeUsername,
    sanitizeAvatarUrl
  };
})(window);
