// ============================================================
// MeiraWatch - script.js (CLEAN SYNC ENGINE v2)
// Masalah lama: 5+ sync engine berjalan bersamaan → konflik
// Solusi: 1 sync engine utama, rate-only adjustment, no smooth seek
// ============================================================

const socket = io();
const peer = new Peer();
let myPeerId = null;

peer.on('open', (id) => { myPeerId = id; });

const video = document.getElementById('videoPlayer');
const screenPlayer = document.getElementById('screenPlayer');
const preloaderVideo = document.getElementById('preloaderVideo');
const chatBox = document.getElementById('chatBox');
const bufferingIndicator = document.getElementById('bufferingIndicator');

// --- SUARA NOTIFIKASI ---
const msgSound = new Audio('https://www.soundjay.com/buttons/sounds/button-16.mp3');
msgSound.volume = 0.7;
const notifSound = new Audio('https://www.soundjay.com/buttons/sounds/button-16.mp3');
notifSound.volume = 0.5;
const broadcastSound = new Audio('sfx/pop.mp3');
broadcastSound.volume = 0.7;
const cashSound = new Audio('sfx/cash-register.mp3');
cashSound.volume = 0.7;

// --- STATE GLOBAL ---
let currentRoom = '';
let currentBaseVideoUrl = '';
let currentRoomUsers = 0;
let currentUsername = '';
let isHost = false;
let hostId = null;
let hostName = 'Host';
let isBuffering = false;
let usernameLocked = false;
let isHostAction = true;

// ============================================================
// PROFANITY FILTER (Multi-language - Client-side)
// ============================================================

const profanityList = [
    // Indonesian
    'anjing','anjg','anj','bangsat','babi','kontol','memek','ngentot','jancok',
    'jancuk','goblok','tolol','bodoh','idiot','setan','iblis','kampret','bajingan',
    'monyet','keparat','brengsek','tai','taik','asu','celeng','cok','mampus',
    'ngentod','kentod','ngewe','bejad','berengsek','sialan','lonte','pelacur',
    'perek','bencong','banci','waria','jembel','jembut','pepek','tempik',
    // English
    'fuck','shit','damn','bitch','asshole','bastard','cunt','dick','pussy',
    'whore','slut','nigger','nigga','faggot','cock','twat','wanker','prick',
    'arse','bollocks','crap','piss','bastard','wank','jerk','douche','retard',
    // Other common offensive words
    'porn','sex','nude','naked','rape','kill','murder','suicide','die',
    'hate','stupid','ugly','fat','loser','idiot','moron','imbecile','fool'
];

function containsProfanity(text) {
    const lower = text.toLowerCase().replace(/[^a-z0-9]/g, '');
    return profanityList.some(word => {
        const clean = word.replace(/[^a-z0-9]/g, '');
        return lower.includes(clean);
    });
}

// ============================================================
// SYNC ENGINE - SATU ENGINE, SATU PENDEKATAN
// Prinsip:
//   - Host kirim heartbeat tiap 2 detik
//   - Client request sync tiap 3 detik
//   - Koreksi drift HANYA via playbackRate (±10% max)
//   - Seek langsung HANYA jika drift > 3 detik
//   - TIDAK ada smooth seek animasi (penyebab loading)
//   - TIDAK ada multiple engine berjalan bersamaan
// ============================================================

const SYNC = {
    HOST_HEARTBEAT_MS: 2000,       // seberapa sering host kirim posisi
    CLIENT_SYNC_MS: 3000,           // seberapa sering client request sync
    DEAD_ZONE: 0.15,                // drift < ini: tidak perlu adjust (detik)
    RATE_ZONE: 3.0,                 // drift < ini: koreksi via rate
    SEEK_ZONE: 3.0,                 // drift >= ini: seek langsung
    MAX_RATE: 1.08,                 // rate maksimal saat catch-up
    MIN_RATE: 0.92,                 // rate minimal saat slow-down
    RATE_STEP: 0.004,               // seberapa cepat rate berubah per frame
};

let syncEngine = {
    hostTime: 0,         // waktu video host (diestimasi)
    hostPlaying: false,
    latency: 0,
    avgLatency: 150,
    targetRate: 1.0,
    currentRate: 1.0,
    rateRafId: null,     // requestAnimationFrame ID untuk rate transition
    hostInterval: null,
    clientInterval: null,
    lastApplied: 0,
};

// --- Hitung hostTime yang telah berlalu sejak sync terakhir ---
function getEstimatedHostTime() {
    if (!syncEngine.hostPlaying) return syncEngine.hostTime;
    const elapsed = (Date.now() - syncEngine.lastApplied) / 1000;
    return syncEngine.hostTime + elapsed;
}

// --- Apply koreksi sync ke video ---
function applySync() {
    if (!video || !video.src || isBuffering) return;
    if (isHost) return; // Host tidak perlu sync ke diri sendiri

    const estimated = getEstimatedHostTime();
    if (estimated <= 0) return;

    const localTime = video.currentTime;
    const drift = estimated - localTime; // positif = client ketinggalan
    const absDrift = Math.abs(drift);

    // Level 1: Dalam batas toleransi → kembalikan rate ke 1.0 pelan-pelan
    if (absDrift < SYNC.DEAD_ZONE) {
        setTargetRate(1.0);
        return;
    }

    // Level 2: Drift sedang → koreksi via playback rate
    if (absDrift < SYNC.RATE_ZONE) {
        // Rate proporsional: drift 0.5s → rate 1.04x, drift 2s → rate 1.08x
        const correction = Math.min(absDrift / SYNC.RATE_ZONE, 1.0) * (SYNC.MAX_RATE - 1.0);
        const newRate = drift > 0
            ? 1.0 + correction
            : 1.0 - correction;
        setTargetRate(Math.max(SYNC.MIN_RATE, Math.min(SYNC.MAX_RATE, newRate)));
        return;
    }

    // Level 3: Drift besar → seek langsung (tidak ada animasi)
    video.currentTime = estimated;
    setTargetRate(1.0);
}

// --- Set target rate dan animasikan perpindahannya ---
function setTargetRate(target) {
    syncEngine.targetRate = target;
    if (!syncEngine.rateRafId) {
        animateRate();
    }
}

function animateRate() {
    syncEngine.rateRafId = null;
    if (!video) return;

    const current = video.playbackRate;
    const target = syncEngine.targetRate;
    const diff = target - current;

    if (Math.abs(diff) < 0.002) {
        video.playbackRate = target;
        return; // Selesai, tidak perlu RAF lagi
    }

    const step = Math.sign(diff) * Math.min(Math.abs(diff), SYNC.RATE_STEP);
    video.playbackRate = current + step;

    syncEngine.rateRafId = requestAnimationFrame(animateRate);
}

// --- Host: kirim posisi video secara berkala ---
function startHostHeartbeat() {
    if (syncEngine.hostInterval) clearInterval(syncEngine.hostInterval);
    syncEngine.hostInterval = setInterval(() => {
        if (!currentRoom || !video.src) return;
        socket.emit('host-heartbeat', {
            time: video.currentTime,
            isPlaying: !video.paused && !isBuffering,
            clientTime: Date.now()
        });
    }, SYNC.HOST_HEARTBEAT_MS);
}

// --- Client: request sync secara berkala ---
function startClientSync() {
    if (syncEngine.clientInterval) clearInterval(syncEngine.clientInterval);
    syncEngine.clientInterval = setInterval(() => {
        if (!currentRoom || !video.src || video.paused) return;
        socket.emit('client-sync-request', Date.now());
    }, SYNC.CLIENT_SYNC_MS);
}

// --- Hentikan semua sync interval ---
function stopSyncEngine() {
    if (syncEngine.hostInterval) { clearInterval(syncEngine.hostInterval); syncEngine.hostInterval = null; }
    if (syncEngine.clientInterval) { clearInterval(syncEngine.clientInterval); syncEngine.clientInterval = null; }
    if (syncEngine.rateRafId) { cancelAnimationFrame(syncEngine.rateRafId); syncEngine.rateRafId = null; }
    if (video) video.playbackRate = 1.0;
}

// --- Inisialisasi engine berdasarkan role ---
function initSyncEngine() {
    stopSyncEngine();
    if (isHost) {
        startHostHeartbeat();
    } else {
        startClientSync();
    }
}

// ============================================================
// SOCKET EVENTS - SERVER RESPONSES
// ============================================================

// Server menerima heartbeat host dan broadcast ke semua client
socket.on('sync-from-host', (data) => {
    if (isHost) return; // Host tidak perlu proses ini

    const now = Date.now();
    const rtt = now - data.clientTime;
    const oneWay = rtt / 2;

    // Estimasi posisi host saat ini (kompensasi network delay)
    syncEngine.hostTime = data.time + (oneWay / 1000);
    syncEngine.hostPlaying = data.isPlaying;
    syncEngine.latency = rtt;
    syncEngine.avgLatency = syncEngine.avgLatency * 0.8 + rtt * 0.2;
    syncEngine.lastApplied = now;

    // Terapkan play/pause
    if (data.isPlaying && video.paused && !isBuffering) {
        video.play().catch(() => {});
    } else if (!data.isPlaying && !video.paused) {
        video.pause();
    }

    // Terapkan koreksi posisi
    applySync();
});

// Server response ke client-sync-request
socket.on('sync-response', (data) => {
    if (isHost) return;

    const now = Date.now();
    const rtt = now - data.clientTime;
    const oneWay = rtt / 2;

    syncEngine.hostTime = data.time + (oneWay / 1000);
    syncEngine.hostPlaying = data.isPlaying;
    syncEngine.latency = rtt;
    syncEngine.avgLatency = syncEngine.avgLatency * 0.8 + rtt * 0.2;
    syncEngine.lastApplied = now;

    if (data.isPlaying && video.paused && !isBuffering) {
        video.play().catch(() => {});
    } else if (!data.isPlaying && !video.paused) {
        video.pause();
    }

    applySync();
});

// ============================================================
// ROLE & ROOM
// ============================================================

socket.on('role-assigned', (data) => {
    isHost = data.isHost;
    hostId = data.hostId;
    updateControlsVisibility();

    if (isHost) {
        showSystemMessage('👑 Anda adalah Host! Anda bisa mengontrol video.');
        socket.emit('get-username-lock-status');
    } else {
        showSystemMessage('👤 Anda adalah Viewer. Selamat menonton!');
    }

    // Restart engine dengan role baru
    if (video.src) initSyncEngine();
});

socket.on('host-info', (data) => {
    hostId = data.hostId;
    hostName = data.hostName;
    const hostLabel = document.getElementById('hostLabel');
    if (hostLabel) hostLabel.innerText = `👑 Host: ${hostName}`;
    if (!isHost) updateControlsVisibility();
});

function joinRoom() {
    const roomId = document.getElementById('roomIdInput').value.trim();
    if (!roomId) return alert('Masukkan ID Room terlebih dahulu!');

    const username = document.getElementById('usernameInputModal').value.trim()
        || document.getElementById('usernameInput').value || 'Guest';

    // Validate username for profanity
    if (containsProfanity(username)) {
        showUsernameProfanityWarning();
        return;
    }

    document.getElementById('usernameInput').value = username;
    currentUsername = username;
    currentRoom = roomId;
    document.getElementById('displayRoomId').innerText = roomId;

    socket.emit('join-room', { roomId: currentRoom, peerId: myPeerId, name: username });
    socket.emit('request-user-count', currentRoom);
    socket.emit('request-sync');

    document.getElementById('roomOverlay').style.display = 'none';
    document.getElementById('appContainer').style.display = 'flex';
    showSystemMessage(`Anda bergabung ke room ${roomId}`);
}

// ============================================================
// VIDEO EVENT LISTENERS (Host actions)
// ============================================================

video.addEventListener('play', () => {
    if (isHost && !isBuffering) {
        socket.emit('play', { time: video.currentTime, clientTime: Date.now() });
    }
    isHostAction = true;
});

video.addEventListener('pause', () => {
    if (isHost && !isBuffering) {
        socket.emit('pause', { time: video.currentTime, clientTime: Date.now() });
    }
    isHostAction = true;
});

video.addEventListener('seeked', () => {
    if (isHost && !isBuffering) {
        socket.emit('seek', { time: video.currentTime, clientTime: Date.now() });
        // Reset state setelah seek
        syncEngine.hostTime = video.currentTime;
        syncEngine.lastApplied = Date.now();
    }
    isHostAction = true;
});

// --- BUFFERING DETECTION ---
video.addEventListener('waiting', () => {
    if (!isBuffering) {
        isBuffering = true;
        bufferingIndicator.classList.add('active');
        // Saat buffering: kembalikan rate ke 1.0 supaya tidak stuck
        if (syncEngine.rateRafId) {
            cancelAnimationFrame(syncEngine.rateRafId);
            syncEngine.rateRafId = null;
        }
        video.playbackRate = 1.0;
        syncEngine.targetRate = 1.0;

        socket.emit('buffering-start', { time: video.currentTime });
    }
});

video.addEventListener('canplay', () => {
    if (isBuffering) {
        isBuffering = false;
        bufferingIndicator.classList.remove('active');
        socket.emit('buffering-end', { time: video.currentTime });

        // Resync setelah buffering selesai
        if (!isHost) {
            setTimeout(() => {
                socket.emit('client-sync-request', Date.now());
            }, 300);
        }
    }
});

// Inisialisasi engine saat video siap diputar
video.addEventListener('loadedmetadata', () => {
    if (currentRoom) initSyncEngine();
});

// ============================================================
// SOCKET LISTENERS - CONTROL EVENTS
// ============================================================

socket.on('play', (data) => {
    if (isBuffering) return;
    isHostAction = false;

    const rtt = Date.now() - (data.clientTime || Date.now());
    const compensated = data.time + (rtt / 2000);

    if (Math.abs(video.currentTime - compensated) > 0.3) {
        video.currentTime = compensated;
    }
    if (video.paused) video.play().catch(() => {});

    syncEngine.hostTime = compensated;
    syncEngine.hostPlaying = true;
    syncEngine.lastApplied = Date.now();
});

socket.on('pause', (data) => {
    if (isBuffering) return;
    isHostAction = false;

    if (Math.abs(video.currentTime - data.time) > 0.3) {
        video.currentTime = data.time;
    }
    if (!video.paused) video.pause();

    syncEngine.hostTime = data.time;
    syncEngine.hostPlaying = false;
    syncEngine.lastApplied = Date.now();
});

socket.on('seek', (data) => {
    if (isHostAction && isHost) return;
    isHostAction = false;

    video.currentTime = data.time;
    syncEngine.hostTime = data.time;
    syncEngine.lastApplied = Date.now();
});

socket.on('sync-state', (state) => {
    if (isBuffering) return;

    const rtt = Date.now() - (state.serverTime || Date.now());
    const elapsed = rtt / 2000;
    const targetTime = state.time + (state.isPlaying ? elapsed : 0);

    syncEngine.hostTime = targetTime;
    syncEngine.hostPlaying = state.isPlaying;
    syncEngine.lastApplied = Date.now();

    applySync();

    if (state.isPlaying && video.paused) video.play().catch(() => {});
    else if (!state.isPlaying && !video.paused) video.pause();
});

// --- AUTO SYNC JOIN ---
socket.on('auto-sync-join', (state) => {
    if (!state.url) return;
    video.src = state.url;
    currentBaseVideoUrl = state.url;
    video.onloadedmetadata = () => {
        const elapsed = (Date.now() - (state.lastUpdate || Date.now())) / 2000;
        const targetTime = state.time + (state.isPlaying ? elapsed : 0);
        video.currentTime = Math.max(0, targetTime);
        video.playbackRate = 1.0;
        if (state.isPlaying) video.play().catch(() => {});
        initSyncEngine();
    };
});

// --- VIDEO CHANGED ---
socket.on('video-changed', (data) => {
    screenPlayer.style.display = 'none';
    if (screenPlayer.srcObject) {
        screenPlayer.srcObject.getTracks().forEach(t => t.stop());
        screenPlayer.srcObject = null;
    }
    video.style.display = 'block';
    currentBaseVideoUrl = data.url;
    video.src = data.url;
    video.load();
    video.play().catch(() => {});
    isHostAction = false;

    // Reset sync state
    syncEngine.hostTime = 0;
    syncEngine.hostPlaying = true;
    syncEngine.lastApplied = Date.now();
});

// --- BUFFERING NOTIFICATION ---
socket.on('buffering-notification', (data) => {
    showBufferingNotification && showBufferingNotification(data.user, true);
});
socket.on('buffering-end', (data) => {
    showBufferingNotification && showBufferingNotification(data.user, false);
});

// ============================================================
// FORCE SYNC (Tombol sync untuk host)
// ============================================================

function forceSync() {
    if (isHost) {
        socket.emit('sync-request', video.currentTime);
        showSystemMessage('🔄 Force sync dikirim ke semua viewer');
    } else {
        showSystemMessage('⚠️ Hanya Host yang bisa melakukan force sync!');
    }
}

// ============================================================
// UI CONTROLS
// ============================================================

function updateControlsVisibility() {
    const uploadSection = document.querySelector('.upload-section');
    const streamSection = document.querySelector('.stream-section');
    const lockBtn = document.getElementById('lockUsernameBtn');
    const syncBtn = document.querySelector('.sync-btn');
    const screenShareBtn = document.querySelector('.stream-section button:last-child');
    const broadcastSection = document.querySelector('.broadcast-section');
    const participantsSection = document.querySelector('.participants-section');

    const show = (el) => el && (el.style.display = 'flex');
    const hide = (el) => el && (el.style.display = 'none');
    const showInline = (el) => el && (el.style.display = 'inline-block');

    if (isHost) {
        show(uploadSection); show(streamSection); show(broadcastSection);
        showInline(lockBtn); showInline(syncBtn); showInline(screenShareBtn);
        participantsSection && (participantsSection.style.display = 'block');
    } else {
        hide(uploadSection); hide(streamSection); hide(broadcastSection);
        hide(lockBtn); hide(syncBtn); hide(screenShareBtn);
        hide(participantsSection);
    }
}

// ============================================================
// VIDEO UPLOAD & STREAM
// ============================================================

async function uploadVideo() {
    if (!isHost) { showSystemMessage('⚠️ Hanya Host yang bisa mengupload video!'); return; }
    const fileInput = document.getElementById('fileInput');
    if (!fileInput.files[0]) return alert('Pilih file dulu!');
    const formData = new FormData();
    formData.append('videoFile', fileInput.files[0]);
    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success) {
        currentBaseVideoUrl = data.url;
        screenPlayer.style.display = 'none';
        video.style.display = 'block';
        video.src = data.url;
        video.load();
        video.play().catch(() => {});
        socket.emit('video-changed', { url: data.url, serverTime: Date.now() });
    } else {
        alert('Gagal unggah');
    }
}

function playStream() {
    if (!isHost) { showSystemMessage('⚠️ Hanya Host yang bisa memutar URL stream!'); return; }
    const url = document.getElementById('streamUrl').value;
    if (url) socket.emit('video-changed', { url, serverTime: Date.now() });
}

// ============================================================
// SCREEN SHARE
// ============================================================

let localScreenStream = null;

async function startScreenShare() {
    if (!isHost) { showSystemMessage('⚠️ Hanya Host yang bisa Share Screen!'); return; }
    try {
        localScreenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { width: 1280, height: 720, frameRate: 15 },
            audio: { echoCancellation: true, noiseSuppression: true }
        });
        video.style.display = 'none';
        screenPlayer.style.display = 'block';
        screenPlayer.srcObject = localScreenStream;
        socket.emit('request-peer-ids');
        localScreenStream.getVideoTracks()[0].onended = () => {
            socket.emit('video-changed', { url: currentBaseVideoUrl, serverTime: Date.now() });
        };
    } catch (err) {
        console.error('Gagal share screen:', err);
    }
}

socket.on('receive-peer-ids', (peerIds) => {
    peerIds.forEach(id => { if (id !== myPeerId) peer.call(id, localScreenStream); });
});

peer.on('call', (call) => {
    call.answer();
    call.on('stream', (remoteStream) => {
        video.pause();
        video.style.display = 'none';
        screenPlayer.style.display = 'block';
        screenPlayer.srcObject = remoteStream;
    });
});

// ============================================================
// PARTICIPANTS
// ============================================================

socket.on('user-list', (users) => {
    const listContainer = document.getElementById('participantsList');
    if (!listContainer) return;
    listContainer.innerHTML = '';
    users.forEach(user => {
        const item = document.createElement('div');
        item.className = 'participant-item';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'participant-name';
        nameSpan.textContent = user;
        if (user === hostName) {
            const badge = document.createElement('span');
            badge.className = 'host-badge';
            badge.textContent = '👑';
            nameSpan.appendChild(badge);
        }
        const actions = document.createElement('div');
        actions.className = 'participant-actions';
        if (isHost && user !== currentUsername) {
            const kickBtn = document.createElement('button');
            kickBtn.className = 'kick-btn';
            kickBtn.textContent = '🚫 Kick';
            kickBtn.onclick = () => {
                if (confirm(`Apakah Anda yakin ingin mengeluarkan ${user}?`))
                    socket.emit('kick-user-by-name', user);
            };
            actions.appendChild(kickBtn);
            if (user !== hostName) {
                const transferBtn = document.createElement('button');
                transferBtn.className = 'transfer-host-btn';
                transferBtn.textContent = '👑 Transfer';
                transferBtn.onclick = () => {
                    if (confirm(`Transfer status Host ke ${user}?`))
                        socket.emit('transfer-host-by-name', user);
                };
                actions.appendChild(transferBtn);
            }
        }
        item.appendChild(nameSpan);
        item.appendChild(actions);
        listContainer.appendChild(item);
    });
    const countEl = document.getElementById('participantCount');
    if (countEl) countEl.textContent = users.length;
});

// ============================================================
// CHAT
// ============================================================

const messageInput = document.getElementById('messageInput');
const typingIndicator = document.getElementById('typingIndicator');
const sendButton = document.getElementById('sendButton');
let typingTimer;
let activeReply = null;
let editingMessageId = null;
let isEditing = false;

messageInput.addEventListener('input', () => {
    const name = document.getElementById('usernameInput').value || 'Guest';
    socket.emit('typing', name);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => socket.emit('stop-typing'), 2000);
});

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
});

function handleSend() {
    if (isEditing && editingMessageId) editMessage();
    else sendMessage();
}

function sendMessage() {
    const name = document.getElementById('usernameInput').value || 'Guest';
    const msg = messageInput.value;
    if (!msg.trim()) return;

    // Validate message for profanity
    if (containsProfanity(msg)) {
        showProfanityWarning();
        return;
    }

    // Validate name for profanity
    if (containsProfanity(name)) {
        showChatNameProfanityWarning();
        return;
    }

    const messageData = { name, msg };
    if (activeReply) messageData.replyTo = activeReply;
    socket.emit('chat-message', messageData);
    socket.emit('stop-typing');
    clearTimeout(typingTimer);
    messageInput.value = '';
    cancelReply();
}

function editMessage() {
    const newText = messageInput.value;
    if (!newText.trim() || !editingMessageId) return;

    // Validate edited text for profanity
    if (containsProfanity(newText)) {
        showProfanityWarning();
        return;
    }

    socket.emit('edit-message', { messageId: editingMessageId, newText: newText.trim() });
    messageInput.value = '';
    editingMessageId = null;
    isEditing = false;
    messageInput.placeholder = 'Ketik pesan...';
    sendButton.innerText = 'Kirim';
    socket.emit('stop-typing');
    clearTimeout(typingTimer);
}

function handleEnter(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
}

function playNotificationSound() {
    msgSound.play().catch(() => notifSound.play().catch(() => {}));
}

socket.on('chat-message', (data) => {
    const myName = document.getElementById('usernameInput').value;
    const isMine = data.name === myName;
    if (!isMine) playNotificationSound();

    if (document.getElementById(`msg-${data.id}`)) return;

    const msgWrapper = document.createElement('div');
    msgWrapper.className = `msg-wrapper ${isMine ? 'mine' : 'others'}`;
    msgWrapper.dataset.messageId = data.id;

    const safeName = data.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeMsg = data.msg.replace(/'/g, "\\'").replace(/"/g, '&quot;');

    let quotedHTML = '';
    if (data.replyTo) {
        quotedHTML = `<div class="msg-quoted">
            <div class="msg-quoted-name">${data.replyTo.name}</div>
            <div class="msg-quoted-text">${data.replyTo.msg}</div>
        </div>`;
    }

    msgWrapper.innerHTML = `
        <div class="msg-bubble" id="msg-${data.id}">
            ${quotedHTML}
            <div class="msg-name">${data.name}</div>
            <div class="msg-content">${safeMsg}</div>
        </div>
        <div class="msg-actions">
            <button class="reply-btn" onclick="setReply('${safeName}', '${safeMsg}')">↩ Reply</button>
            ${isMine ? `<button class="edit-btn" onclick="startEdit('${data.id}', '${safeMsg}')">✏️ Edit</button>` : ''}
        </div>
    `;
    chatBox.appendChild(msgWrapper);
    chatBox.scrollTop = chatBox.scrollHeight;
});

socket.on('message-edited', (data) => {
    const msgBubble = document.getElementById(`msg-${data.id}`);
    if (!msgBubble) return;
    const contentDiv = msgBubble.querySelector('.msg-content');
    if (contentDiv) {
        const editLabel = data.editCount > 0 ? ` ✏️ edited (${data.editCount}x)` : ' ✏️ edited';
        contentDiv.innerHTML = `${data.msg} ${editLabel}`;
    }
    const replyBtn = msgBubble.closest('.msg-wrapper')?.querySelector('.reply-btn');
    if (replyBtn) {
        const safeMsg = data.msg.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        const name = msgBubble.querySelector('.msg-name').textContent;
        replyBtn.setAttribute('onclick', `setReply('${name}', '${safeMsg}')`);
    }
    msgBubble.style.border = '1px solid var(--border-soft)';
});

function startEdit(messageId, currentText) {
    if (isEditing) return;
    editingMessageId = messageId;
    isEditing = true;
    messageInput.value = currentText;
    messageInput.placeholder = 'Edit pesan... (Enter untuk simpan)';
    sendButton.innerText = 'Simpan';
    messageInput.focus();
    const msgBubble = document.getElementById(`msg-${messageId}`);
    if (msgBubble) msgBubble.style.border = '2px solid var(--accent)';
}

function setReply(name, msg) {
    activeReply = { name, msg };
    document.getElementById('replyPreviewName').innerText = `Membalas ${name}`;
    document.getElementById('replyPreviewText').innerText = msg;
    document.getElementById('replyPreview').style.display = 'flex';
    messageInput.focus();
}

function cancelReply() {
    activeReply = null;
    document.getElementById('replyPreview').style.display = 'none';
}

socket.on('typing', (name) => {
    typingIndicator.innerHTML = `${name} sedang mengetik<span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>`;
    typingIndicator.classList.add('active');
});
socket.on('stop-typing', () => typingIndicator.classList.remove('active'));
socket.on('user-count', (count) => {
    currentRoomUsers = count;
    document.getElementById('userCount').innerText = count;
});

// ============================================================
// REACTIONS
// ============================================================

function sendReaction(emoji) {
    socket.emit('reaction', emoji);
    showFloatingReaction(emoji);
}

function showFloatingReaction(emoji) {
    const videoWrapper = document.querySelector('.video-wrapper');
    if (!videoWrapper) return;
    const existing = videoWrapper.querySelectorAll('.floating-emoji');
    if (existing.length > 10) existing[0].remove();
    const el = document.createElement('div');
    el.className = 'floating-emoji';
    el.innerText = emoji;
    const startX = 20 + Math.random() * 60;
    el.style.left = `${startX}%`;
    const randomX = Math.floor(Math.random() * 100) - 50;
    el.style.setProperty('--end-x', `calc(-50% + ${randomX}px)`);
    const duration = 2.0 + Math.random() * 1.0;
    el.style.animationDuration = `${duration}s`;
    videoWrapper.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.remove(); }, duration * 1000 + 100);
}

socket.on('reaction', (emoji) => showFloatingReaction(emoji));

// ============================================================
// SYSTEM & ERROR MESSAGES
// ============================================================

socket.on('system-message', (msg) => showSystemMessage(msg));
socket.on('error-message', (msg) => {
    showSystemMessage(`⚠️ ${msg}`);
    alert(msg);
});
socket.on('kicked', (data) => {
    alert(data.message);
    document.getElementById('appContainer').style.display = 'none';
    document.getElementById('roomOverlay').style.display = 'flex';
    document.getElementById('roomIdInput').value = '';
});

function showSystemMessage(text) {
    const msgEl = document.createElement('div');
    msgEl.className = 'system-msg';
    msgEl.innerText = text;
    chatBox.appendChild(msgEl);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function showProfanityWarning() {
    const warn = document.getElementById('profanityWarn');
    if (warn) {
        warn.style.display = 'block';
        setTimeout(() => warn.style.display = 'none', 3000);
    }
    const msgInput = document.getElementById('messageInput');
    if (msgInput) {
        msgInput.style.borderColor = '#ef4444';
        setTimeout(() => msgInput.style.borderColor = '', 2000);
    }
}

function showUsernameProfanityWarning() {
    const warn = document.getElementById('usernameProfanityWarn');
    if (warn) {
        warn.style.display = 'block';
        setTimeout(() => warn.style.display = 'none', 3000);
    }
    const usernameInput = document.getElementById('usernameInputModal');
    if (usernameInput) {
        usernameInput.style.borderColor = '#f59e0b';
        setTimeout(() => usernameInput.style.borderColor = '', 2000);
    }
}

function showChatNameProfanityWarning() {
    const warn = document.getElementById('profanityWarn');
    if (warn) {
        warn.textContent = '⚠️ Nama mengandung kata tidak pantas';
        warn.style.display = 'block';
        setTimeout(() => {
            warn.textContent = '⚠️ Pesan mengandung kata tidak pantas';
            warn.style.display = 'none';
        }, 3000);
    }
    const usernameInput = document.getElementById('usernameInput');
    if (usernameInput) {
        usernameInput.style.borderColor = '#f59e0b';
        setTimeout(() => usernameInput.style.borderColor = '', 2000);
    }
}

// ============================================================
// USERNAME LOCK
// ============================================================

socket.on('username-lock-status', (isLocked) => {
    usernameLocked = isLocked;
    updateLockUI();
    updateUsernameInput();
});

function toggleUsernameLock() {
    if (!isHost) { showSystemMessage('⚠️ Hanya Host yang bisa mengunci/membuka nama!'); return; }
    socket.emit('toggle-username-lock', { lock: !usernameLocked });
}

function updateLockUI() {
    const lockBtn = document.getElementById('lockUsernameBtn');
    if (!lockBtn) return;
    lockBtn.innerText = usernameLocked ? '🔒 Kunci Nama (Terkunci)' : '🔓 Buka Kunci Nama';
    lockBtn.className = `lock-btn ${usernameLocked ? 'locked' : 'unlocked'}`;
    lockBtn.style.display = isHost ? 'inline-block' : 'none';
}

function updateUsernameInput() {
    const usernameInput = document.getElementById('usernameInput');
    const usernameInputModal = document.getElementById('usernameInputModal');
    usernameInput.disabled = usernameLocked;
    usernameInput.placeholder = usernameLocked ? '🔒 Nama terkunci oleh Host' : 'Nama...';
    if (usernameInputModal) {
        usernameInputModal.disabled = usernameLocked;
        usernameInputModal.placeholder = usernameLocked ? '🔒 Nama terkunci oleh Host' : 'Contoh: Raga, Meisya...';
    }
}

// ============================================================
// KICK & TRANSFER HOST
// ============================================================

function kickParticipant(socketId) {
    if (!isHost) { showSystemMessage('⚠️ Hanya Host yang bisa mengeluarkan peserta!'); return; }
    if (confirm('Apakah Anda yakin ingin mengeluarkan peserta ini?'))
        socket.emit('kick-user', socketId);
}

function transferHostTo(socketId) {
    if (!isHost) { showSystemMessage('⚠️ Hanya Host yang bisa mentransfer status Host!'); return; }
    if (confirm('Apakah Anda yakin ingin mentransfer status Host ke peserta ini?'))
        socket.emit('transfer-host', socketId);
}

// ============================================================
// BROADCAST
// ============================================================

function sendBroadcast() {
    if (!isHost) { showSystemMessage('⚠️ Hanya Host yang bisa mengirim broadcast!'); return; }
    const input = document.getElementById('broadcastInput');
    const message = input.value.trim();
    if (!message) { alert('Masukkan pesan broadcast terlebih dahulu!'); return; }
    socket.emit('broadcast-message', message);
    input.value = '';
}

socket.on('broadcast-message', (message) => showBroadcastNotification(message));

function showBroadcastNotification(message) {
    const notification = document.getElementById('broadcastNotification');
    const messageEl = document.getElementById('broadcastMessage');
    messageEl.textContent = message;
    notification.classList.add('active');
    broadcastSound.play().catch(() => {});
    setTimeout(() => closeBroadcast(), 5000);
}

function closeBroadcast() {
    document.getElementById('broadcastNotification').classList.remove('active');
}

// ============================================================
// SUPPORT MODAL
// ============================================================

let selectedMethod = null;
const paymentData = {
    dana: { number: '081585419615', name: 'Raga Kalas Ramadhan', instruction: 'Transfer via DANA ke nomor di atas. Konfirmasi setelah transfer.' },
    gopay: { number: '081585419615', name: 'Raga Kalas Ramadhan', instruction: 'Transfer via GoPay ke nomor di atas. Konfirmasi setelah transfer.' },
    shopeepay: { number: '081585419615', name: 'Raga Kalas Ramadhan', instruction: 'Transfer via ShopeePay ke nomor di atas. Konfirmasi setelah transfer.' },
    seabank: { number: '901245428657', name: 'Raga Kalas Ramadhan', instruction: 'Transfer via SeaBank ke nomor di atas. Konfirmasi setelah transfer.' }
};

function openSupportModal() {
    const modal = document.getElementById('supportModal');
    if (!modal) return;
    modal.style.display = 'flex';
    document.getElementById('paymentDetails').style.display = 'none';
    selectedMethod = null;
    document.querySelectorAll('.support-method').forEach(el => el.classList.remove('active'));
}

function closeSupportModal() {
    const modal = document.getElementById('supportModal');
    if (modal) modal.style.display = 'none';
}

function selectMethod(method) {
    selectedMethod = method;
    document.querySelectorAll('.support-method').forEach(el => {
        el.classList.toggle('active', el.dataset.method === method);
    });
    const details = paymentData[method];
    document.getElementById('paymentNumber').innerText = details.number;
    document.getElementById('paymentName').innerText = details.name;
    document.getElementById('paymentInstruction').innerText = details.instruction;
    document.getElementById('paymentDetails').style.display = 'block';
}

function copyPaymentNumber() {
    const number = document.getElementById('paymentNumber').innerText;
    navigator.clipboard.writeText(number).then(() => {
        const copyBtn = document.querySelector('.copy-btn');
        const originalText = copyBtn.innerText;
        copyBtn.innerText = '✅ Tersalin!';
        setTimeout(() => { copyBtn.innerText = originalText; }, 2000);
    }).catch(() => {
        const input = document.createElement('input');
        input.value = number;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        alert('Nomor telah disalin!');
    });
}

function confirmSupport() {
    const amount = document.getElementById('supportAmount').value;
    if (!amount || amount < 1000) { alert('Masukkan nominal minimal Rp 1.000'); return; }
    if (!selectedMethod) { alert('Pilih metode pembayaran terlebih dahulu!'); return; }
    const methodName = selectedMethod.charAt(0).toUpperCase() + selectedMethod.slice(1);
    const number = paymentData[selectedMethod].number;
    const formattedAmount = `Rp ${parseInt(amount).toLocaleString()}`;
    closeSupportModal();
    setTimeout(() => showSuccessModal(methodName, formattedAmount, number), 300);
}

function showSuccessModal(method, amount, number) {
    const modal = document.getElementById('successModal');
    if (!modal) return;
    document.getElementById('successMethod').innerText = method;
    document.getElementById('successAmount').innerText = amount;
    document.getElementById('successNumber').innerText = number;
    modal.style.display = 'flex';
    cashSound.play().catch(() => {});
}

function closeSuccessModal() {
    const modal = document.getElementById('successModal');
    if (modal) modal.style.display = 'none';
}

document.addEventListener('click', function(e) {
    const modal = document.getElementById('successModal');
    const content = document.querySelector('.success-modal-content');
    if (modal && modal.style.display === 'flex' && content && !content.contains(e.target))
        closeSuccessModal();
});

document.addEventListener('DOMContentLoaded', function() {
    const supportTrigger = document.getElementById('supportTrigger');
    if (supportTrigger) {
        supportTrigger.addEventListener('click', function(e) {
            e.stopPropagation();
            openSupportModal();
        });
    }
});

// ============================================================
// MOBILE FIXES
// ============================================================

document.addEventListener('DOMContentLoaded', function() {
    const chatInputArea = document.querySelector('.chat-input-area');
    const chatInputWrapper = document.querySelector('.chat-input-wrapper');
    if (chatInputArea) { chatInputArea.style.display = 'flex'; chatInputArea.style.visibility = 'visible'; }
    if (chatInputWrapper) { chatInputWrapper.style.display = 'block'; chatInputWrapper.style.visibility = 'visible'; }
    let vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
});

window.addEventListener('resize', function() {
    let vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
});

document.addEventListener('touchstart', function(e) {
    const msgWrapper = e.target.closest('.msg-wrapper');
    if (msgWrapper) {
        document.querySelectorAll('.msg-wrapper.active').forEach(el => {
            if (el !== msgWrapper) el.classList.remove('active');
        });
        msgWrapper.classList.toggle('active');
    } else {
        document.querySelectorAll('.msg-wrapper.active').forEach(el => el.classList.remove('active'));
    }
});

document.addEventListener('DOMContentLoaded', function() {
    const reactionBar = document.querySelector('.reaction-bar');
    if (!reactionBar) return;
    let isDown = false, startX = 0, scrollLeft = 0;
    reactionBar.addEventListener('mousedown', (e) => {
        isDown = true; reactionBar.classList.add('dragging');
        startX = e.pageX - reactionBar.offsetLeft; scrollLeft = reactionBar.scrollLeft;
        reactionBar.style.cursor = 'grabbing';
    });
    reactionBar.addEventListener('mouseleave', () => { isDown = false; reactionBar.classList.remove('dragging'); reactionBar.style.cursor = 'grab'; });
    reactionBar.addEventListener('mouseup', () => { isDown = false; reactionBar.classList.remove('dragging'); reactionBar.style.cursor = 'grab'; });
    reactionBar.addEventListener('mousemove', (e) => {
        if (!isDown) return; e.preventDefault();
        const x = e.pageX - reactionBar.offsetLeft;
        reactionBar.scrollLeft = scrollLeft - (x - startX) * 1.5;
    });
    reactionBar.addEventListener('wheel', (e) => { e.preventDefault(); reactionBar.scrollLeft += e.deltaY; }, { passive: false });
});

// ============================================================
// DISCONNECT CLEANUP
// ============================================================

socket.on('disconnect', () => stopSyncEngine());

console.log('✅ MeiraWatch siap digunakan! (Clean Sync Engine v2)');