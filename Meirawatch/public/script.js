// ============================================================
// MeiraWatch - script.js (OPTIMIZED SYNC ENGINE v5)
// FIX: Seek mundur menyebabkan stuttering dan desync
// ============================================================

// ============================================================
// GOOGLE DRIVE API CONFIGURATION
// ============================================================
const GOOGLE_API_KEY = 'AIzaSyB804z-sfNRZBWxBFZqHPxG6xCo7eEzd2Q';

function extractDriveFileId(url) {
    const m1 = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m1) return m1[1];
    const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m2) return m2[1];
    return null;
}

function playDriveVideoDirectly(driveShareUrl) {
    const fileId = extractDriveFileId(driveShareUrl);
    if (fileId) {
       const directStreamUrl = `https://www.googleapis.com/drive/v3/files/${driveId}?alt=media&acknowledgeAbuse=true&access_token=${userAccessToken}`;
        const video = document.getElementById('videoPlayer');
        video.src = directStreamUrl;
        socket.emit('video-changed', { url: directStreamUrl, serverTime: Date.now() });
    } else {
        alert("Link Google Drive tidak valid!");
    }
}

// ============================================================
// SOCKET & PEER INIT
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
const cameraSound = new Audio('sfx/camera2.mp3');
cameraSound.volume = 0.7;

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
let isPaused = false;

// --- VARIABEL YOUTUBE ---
let ytPlayer = null;
let isYouTube = false;
let ytReady = false;

// ==========================================
// GLOBALS & OAUTH SYSTEM
// ==========================================
let userAccessToken = null; // Menyimpan token akses Google penonton

// Load YouTube Iframe API
const ytScriptTag = document.createElement('script');
ytScriptTag.src = "https://www.youtube.com/iframe_api";
const firstScriptTag = document.getElementsByTagName('script')[0];
firstScriptTag.parentNode.insertBefore(ytScriptTag, firstScriptTag);

// Fungsi bawaan yang akan dipanggil Google saat API siap
function onYouTubeIframeAPIReady() {
    ytReady = true;
    console.log("✅ YouTube Iframe API Ready");
}

// ==========================================
// 1. FUNGSI EKSTRAKSI URL (DIPERKUAT)
// ==========================================
function extractYouTubeId(url) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

function extractDriveFileId(url) {
    // Menangkap ID dari link drive biasa (Host)
    const m1 = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m1) return m1[1];
    // Menangkap ID dari link parameter id=
    const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m2) return m2[1];
    // Menangkap ID jika URL sudah menjadi googleapis
    const m3 = url.match(/googleapis\.com\/drive\/v3\/files\/([a-zA-Z0-9_-]+)/);
    if (m3) return m3[1];
    
    return null;
}

// Fungsi untuk memecah data JWT dari Google
function parseJwt(token) {
    var base64Url = token.split('.')[1];
    var base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    var jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload);
}

function handleCredentialResponse(response) {
    // Ekstrak nama pengguna dari kredensial Google
    const userData = parseJwt(response.credential);
    const userName = userData.name;
    console.log("✅ Berhasil login sebagai: " + userName);

    const client = google.accounts.oauth2.initTokenClient({
        client_id: '842530028540-76odbiqlit31u8set4j5gfh681r3o3sj.apps.googleusercontent.com',
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        callback: (tokenResponse) => {
            if (tokenResponse && tokenResponse.access_token) {
                userAccessToken = tokenResponse.access_token;
                console.log("🔑 Access Token berhasil didapatkan!");

                // 1. UBAH TAMPILAN UI LOGIN MENJADI LENCANA SUKSES
                const loginContainer = document.querySelector('.google-login-container');
                if (loginContainer) {
                    loginContainer.innerHTML = `
                        <div style="background: rgba(59, 130, 246, 0.1); border: 1px solid #3b82f6; padding: 12px 16px; border-radius: 12px; color: #60a5fa; font-weight: bold; margin-bottom: 20px; display: flex; align-items: center; justify-content: center; gap: 8px;">
                            <span style="font-size: 18px;">✅</span>
                            <div style="text-align: left; line-height: 1.2;">
                                <div>Terhubung sebagai ${userName}</div>
                                <div style="font-size: 10px; font-weight: normal; color: #a1a1aa; margin-top: 2px;">Akses Premium Bebas Limit Aktif</div>
                            </div>
                        </div>
                    `;
                }

                // 2. OTOMATIS ISI INPUT NAMA DENGAN NAMA GOOGLE
                const nameInputModal = document.getElementById('usernameInputModal');
                if (nameInputModal && !nameInputModal.value) {
                    nameInputModal.value = userName;
                }
            }
        }
    });
    client.requestAccessToken();
}

// ============================================================
// CUSTOM POSTER CONFIGURATION
// ============================================================

const MOVIE_POSTER_URL = 'https://www.layar.id/wp-content/uploads/2025/10/PANGKU_Official-Poster_IG-Feed.jpg';

function loadMoviePoster() {
    const img = document.getElementById('moviePosterImg');
    const placeholder = document.getElementById('posterPlaceholder');
    if (MOVIE_POSTER_URL) {
        img.src = MOVIE_POSTER_URL;
        img.onload = function() {
            img.style.display = 'block';
            placeholder.style.display = 'none';
        };
        img.onerror = function() {
            img.style.display = 'none';
            placeholder.style.display = 'flex';
            console.warn('Poster gagal dimuat, menggunakan placeholder');
        };
    } else {
        img.style.display = 'none';
        placeholder.style.display = 'flex';
    }
}

document.addEventListener('DOMContentLoaded', function() {
    loadMoviePoster();
});

// ============================================================
// THEME TOGGLE - DISABLED
// ============================================================

localStorage.removeItem('theme');
document.documentElement.setAttribute('data-theme', 'dark');

// ============================================================
// MONITOR VISIBILITY HELPERS
// ============================================================

function hideMonitors() {
    document.querySelectorAll('#syncMonitorSimple, #syncMonitor, .sync-monitor, #speedSyncDebug, #bufferMonitor').forEach(el => {
        if (el) el.classList.add('hidden');
    });
}

function showMonitors() {
    document.querySelectorAll('#syncMonitorSimple, #syncMonitor, .sync-monitor, #speedSyncDebug, #bufferMonitor').forEach(el => {
        if (el) el.classList.remove('hidden');
    });
}

// ============================================================
// BIOSKOP SEAT SELECTION - PREMIUM
// ============================================================

const TICKET_PRICE = 35000;
const VIP_SEATS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'];

let selectedSeats = [];
let takenSeats = {};
let selectedPaymentMethod = null;
let paymentSuccess = false;

function goToSeatSelection() {
    const username = document.getElementById('usernameInputModal').value.trim();
    const roomId = document.getElementById('roomIdInput').value.trim();

    if (!username) {
        alert('Masukkan nama kamu dulu!');
        return;
    }
    if (containsProfanity(username)) {
        showUsernameProfanityWarning();
        return;
    }
    if (!roomId) {
        alert('Masukkan nomor studio!');
        return;
    }

    document.getElementById('usernameInput').value = username;
    currentUsername = username;
    currentRoom = roomId;
    document.getElementById('displayRoomId').innerText = roomId;

    document.getElementById('step1').classList.remove('active');
    document.getElementById('step2').classList.add('active');

    loadSeatData();
}

function goBackToStep1() {
    document.getElementById('step2').classList.remove('active');
    document.getElementById('step1').classList.add('active');
}

function goToPayment() {
    if (selectedSeats.length === 0) {
        alert('Pilih 1 kursi terlebih dahulu!');
        return;
    }
    if (selectedSeats.length > 1) {
        alert('Maksimal hanya bisa memilih 1 kursi!');
        return;
    }

    document.getElementById('step2').classList.remove('active');
    document.getElementById('step3').classList.add('active');

    const seat = selectedSeats[0];
    const total = TICKET_PRICE;
    const formattedTotal = `Rp ${total.toLocaleString()}`;

    document.getElementById('paymentSeat').textContent = seat;
    document.getElementById('paymentPrice').textContent = formattedTotal;
    document.getElementById('paymentTotalAmount').textContent = formattedTotal;
    document.getElementById('paymentTotal').textContent = formattedTotal;
}

function goBackToStep2() {
    document.getElementById('step3').classList.remove('active');
    document.getElementById('step2').classList.add('active');
}

function loadSeatData() {
    socket.emit('get-taken-seats', currentRoom);
}

socket.on('taken-seats', (data) => {
    takenSeats = data || {};
    renderSeatGrid();
});

socket.on('seats-updated', (seats) => {
    takenSeats = {};
    Object.keys(seats).forEach(seatId => {
        takenSeats[seatId] = true;
    });
    renderSeatGrid();
});

function renderSeatGrid() {
    const grid = document.getElementById('seatGrid');
    grid.innerHTML = '';
    selectedSeats = [];
    document.getElementById('selectedSeatCount').textContent = '0';
    document.getElementById('totalPrice').textContent = 'Rp 0';

    const rows = 8;
    const cols = 8;
    const totalSeats = rows * cols;

    for (let i = 0; i < totalSeats; i++) {
        const row = String.fromCharCode(65 + Math.floor(i / cols));
        const col = (i % cols) + 1;
        const seatId = `${row}${col}`;
        const isVip = VIP_SEATS.includes(seatId);

        const seat = document.createElement('div');
        seat.className = 'seat';
        if (isVip) seat.classList.add('vip');
        seat.dataset.seatId = seatId;
        seat.textContent = seatId;

        if (takenSeats[seatId]) {
            seat.classList.add('taken');
        } else {
            seat.addEventListener('click', () => toggleSeat(seatId));
        }

        grid.appendChild(seat);
    }
}

function toggleSeat(seatId) {
    const seat = document.querySelector(`.seat[data-seat-id="${seatId}"]`);
    if (!seat || seat.classList.contains('taken')) return;

    document.querySelectorAll('.seat.selected').forEach(el => el.classList.remove('selected'));
    selectedSeats = [];

    seat.classList.add('selected');
    selectedSeats.push(seatId);

    const count = selectedSeats.length;
    const total = count * TICKET_PRICE;
    const formattedTotal = `Rp ${total.toLocaleString()}`;

    document.getElementById('selectedSeatCount').textContent = count;
    document.getElementById('totalPrice').textContent = formattedTotal;
}

function selectPaymentMethod(method) {
    selectedPaymentMethod = method;
    document.querySelectorAll('.payment-method').forEach(el => {
        el.classList.toggle('active', el.dataset.method === method);
    });
    document.getElementById('payBtn').disabled = false;
}

function processPayment() {
    if (!selectedPaymentMethod) {
        alert('Pilih metode pembayaran terlebih dahulu!');
        return;
    }

    const btn = document.getElementById('payBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-text">⏳ Memproses...</span>';
    
    cameraSound.currentTime = 0;
    cameraSound.play().catch(err => console.log('SFX play error:', err));

    setTimeout(() => {
        paymentSuccess = true;
        showTicket();
    }, 1500);
}

function showTicket() {
    document.getElementById('step3').classList.remove('active');
    document.getElementById('step4').classList.add('active');

    const username = document.getElementById('usernameInputModal').value.trim();
    socket.emit('reserve-seats', {
        roomId: currentRoom,
        seats: selectedSeats,
        name: username
    });

    const seat = selectedSeats[0];
    const total = TICKET_PRICE;
    const ticketHTML = generateTicket(seat, currentRoom, username, total, selectedPaymentMethod);
    document.getElementById('digitalTicket').innerHTML = ticketHTML;
}

function generateTicket(seat, roomId, username, price, method) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('id-ID', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
    }).toUpperCase();
    const timeStr = now.toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit'
    });
    const row = seat.charAt(0);
    const seatNum = seat.substring(1);
    return `
    <div class="ticket-xxi">
        <div class="ticket-xxi-header">
            <div class="ticket-xxi-cinema">PLAZA SENAYAN</div>
            <div class="ticket-xxi-sub">MeiraWatch</div>
        </div>
        <div class="ticket-xxi-body">
            <div class="ticket-xxi-left">
                <div class="ticket-xxi-row"><div class="ticket-xxi-label">Date</div><div class="ticket-xxi-value">${dateStr}</div></div>
                <div class="ticket-xxi-row"><div class="ticket-xxi-label">Time</div><div class="ticket-xxi-value">${timeStr}</div></div>
                <div class="ticket-xxi-row"><div class="ticket-xxi-label">Row</div><div class="ticket-xxi-value">${row}</div></div>
                <div class="ticket-xxi-row"><div class="ticket-xxi-label">Seat</div><div class="ticket-xxi-value">${seatNum}</div></div>
                <div class="ticket-xxi-row"><div class="ticket-xxi-label">Theatre</div><div class="ticket-xxi-value">${roomId.toUpperCase()}</div></div>
            </div>
            <div class="ticket-xxi-right">
                <div class="ticket-xxi-movie-title">Pangku</div>
                <div class="ticket-xxi-movie-sub">Horror | 18+</div>
            </div>
        </div>
        <div class="ticket-xxi-bottom">
            <div class="ticket-xxi-price">
                <div class="ticket-xxi-label">Price</div>
                <div class="ticket-xxi-value">IDR ${price.toLocaleString()}</div>
            </div>
            <div class="ticket-xxi-barcode">||| ||| ||| ||| |||</div>
        </div>
        <div class="ticket-xxi-footer">TERIMA KASIH TELAH MEMILIH MEIRAWATCH</div>
    </div>
    `;
}

function enterRoom() {
    const username = document.getElementById('usernameInputModal').value.trim();
    
    socket.emit('join-room', { 
        roomId: currentRoom, 
        peerId: myPeerId, 
        name: username,
        seats: selectedSeats
    });
    socket.emit('request-user-count', currentRoom);
    socket.emit('request-sync');
    
    hideMonitors();

    const overlay = document.getElementById('roomOverlay');
    const appContainer = document.getElementById('appContainer');
    
    document.getElementById('step4').classList.remove('active');
    
    overlay.style.transition = 'none';
    overlay.style.opacity = '0';
    overlay.style.display = 'none';
    
    appContainer.style.display = 'flex';
    appContainer.style.opacity = '0';
    appContainer.style.transform = 'scale(0.98)';
    appContainer.style.transition = 'none';
    
    void appContainer.offsetWidth;
    
    appContainer.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    appContainer.style.opacity = '1';
    appContainer.style.transform = 'scale(1)';
    
    const seatList = selectedSeats.join(', ');
    const totalPrice = (selectedSeats.length * TICKET_PRICE).toLocaleString();
    
    setTimeout(() => {
        showSystemMessage(`🎫 Tiket untuk kursi ${seatList} - Total Rp ${totalPrice}`);
        showSystemMessage(`🎬 Selamat menonton di theater ${currentRoom}! 🍿`);
        showMonitors();
    }, 700);
}

// ============================================================
// PROFANITY FILTER
// ============================================================

const profanityList = [
    'anjing','anjg','anj','bangsat','babi','kontol','memek','ngentot','jancok',
    'jancuk','goblok','tolol','bodoh','idiot','kampret','bajingan',
    'keparat','brengsek','tai','taik','asu','celeng','cok','mampus',
    'ngentod','kentod','ngewe','bejad','berengsek','sialan','lonte','pelacur',
    'perek','bencong','banci','waria','jembel','jembut','pepek','tempik',
    'fuck','shit','damn','bitch','asshole','bastard','cunt','dick','pussy',
    'whore','slut','nigger','nigga','faggot','cock','twat','wanker','prick',
    'arse','bollocks','crap','piss','bastard','wank','jerk','douche','retard',
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
// SYNC ENGINE v5 - Production-Grade Watch Party Sync
// ============================================================

const SYNC = {
    HOST_HEARTBEAT_MS: 1000,
    DEAD_ZONE: 0.08,
    RATE_ZONE: 2.0,
    SEEK_ZONE: 2.0,
    MAX_RATE: 1.03,
    MIN_RATE: 0.97,
    SEEK_COOLDOWN_MS: 3000,
};

const syncEngine = {
    hostTime: 0,
    hostPlaying: false,
    hostReceivedAt: 0,

    active: false,
    rafId: null,
    hostInterval: null,
    lastAutoSeekAt: 0,
    pendingHardSeek: null,

    lastDrift: 0,
};

function getEstimatedHostTime() {
    if (!syncEngine.hostPlaying) return syncEngine.hostTime;
    const elapsedSec = (Date.now() - syncEngine.hostReceivedAt) / 1000;
    return syncEngine.hostTime + Math.min(elapsedSec, 2.0);
}

function isBuffered(t) {
    const buf = video.buffered;
    for (let i = 0; i < buf.length; i++) {
        if (t >= buf.start(i) && t <= buf.end(i) + 0.25) return true;
    }
    return false;
}

function syncLoop() {
    if (!syncEngine.active || isHost) return;

    if (syncEngine.pendingHardSeek !== null) {
        const target = getEstimatedHostTime();
        if (isBuffered(target)) {
            _viewerSeekFromRemote = true;
            video.currentTime = target;
            video.playbackRate = 1.0;
            syncEngine.pendingHardSeek = null;
            syncEngine.lastAutoSeekAt = Date.now();
        }
        syncEngine.rafId = requestAnimationFrame(syncLoop);
        return;
    }

    if (!video.src || isBuffering || video.readyState < 2) {
        syncEngine.rafId = requestAnimationFrame(syncLoop);
        return;
    }

    const estimated = getEstimatedHostTime();
    if (estimated <= 0) {
        syncEngine.rafId = requestAnimationFrame(syncLoop);
        return;
    }

    const drift = estimated - video.currentTime;
    const absDrift = Math.abs(drift);
    syncEngine.lastDrift = drift;

    if (absDrift < SYNC.DEAD_ZONE) {
        if (video.playbackRate !== 1.0) video.playbackRate = 1.0;
    } else if (absDrift < SYNC.RATE_ZONE) {
        const factor = absDrift / SYNC.RATE_ZONE;
        const delta = factor * (SYNC.MAX_RATE - 1.0);
        const newRate = drift > 0
            ? Math.min(1.0 + delta, SYNC.MAX_RATE)
            : Math.max(1.0 - delta, SYNC.MIN_RATE);
        if (Math.abs(video.playbackRate - newRate) > 0.002) {
            video.playbackRate = newRate;
        }
    } else {
        const now = Date.now();
        const cooldownOk = (now - syncEngine.lastAutoSeekAt) > SYNC.SEEK_COOLDOWN_MS;
        if (cooldownOk) {
            if (isBuffered(estimated)) {
                _viewerSeekFromRemote = true;
                video.currentTime = estimated;
                video.playbackRate = 1.0;
                syncEngine.lastAutoSeekAt = now;
            } else {
                syncEngine.pendingHardSeek = { reason: 'auto-seek' };
                video.playbackRate = 1.0;
            }
        } else {
            if (video.playbackRate !== 1.0) video.playbackRate = 1.0;
        }
    }

    syncEngine.rafId = requestAnimationFrame(syncLoop);
}

function applyHostTick(data) {
    if (isHost) return;

    syncEngine.hostTime = data.time;
    syncEngine.hostPlaying = data.isPlaying;
    syncEngine.hostReceivedAt = Date.now();

    if (data.isPlaying && video.paused && !isBuffering) {
        video.play().catch(() => {});
        isPaused = false;
    } else if (!data.isPlaying && !video.paused) {
        video.pause();
        isPaused = true;
    }
}

function resetSyncState() {
    syncEngine.hostTime = video.currentTime;
    syncEngine.hostReceivedAt = Date.now();
    syncEngine.pendingHardSeek = null;
    syncEngine.lastAutoSeekAt = Date.now();
    video.playbackRate = 1.0;
    isPaused = video.paused;
}

function startHostHeartbeat() {
    if (syncEngine.hostInterval) clearInterval(syncEngine.hostInterval);
    syncEngine.hostInterval = setInterval(() => {
        if (!currentRoom || !video.src) return;
        socket.emit('host-heartbeat', {
            time: video.currentTime,
            isPlaying: !video.paused && !isBuffering,
            hostSendTime: Date.now()
        });
    }, SYNC.HOST_HEARTBEAT_MS);
}

function startSyncLoop() {
    if (syncEngine.rafId) cancelAnimationFrame(syncEngine.rafId);
    syncEngine.active = true;
    syncEngine.rafId = requestAnimationFrame(syncLoop);
}

function stopSyncEngine() {
    syncEngine.active = false;
    if (syncEngine.hostInterval) { clearInterval(syncEngine.hostInterval); syncEngine.hostInterval = null; }
    if (syncEngine.rafId) { cancelAnimationFrame(syncEngine.rafId); syncEngine.rafId = null; }
    if (video) video.playbackRate = 1.0;
}

function initSyncEngine() {
    stopSyncEngine();
    if (isHost) {
        startHostHeartbeat();
    } else {
        startSyncLoop();
    }
}

// ============================================================
// SOCKET EVENTS - SERVER RESPONSES
// ============================================================

socket.on('host-tick', (data) => {
    applyHostTick(data);
});

socket.on('sync-state', (state) => {
    if (!state.url) return;

    const now = Date.now();
    const serverAgeMs = now - state.serverTime;
    const elapsedSec = (state.isPlaying ? serverAgeMs / 1000 : 0);
    const targetTime = state.time + Math.min(elapsedSec, 2.0);

    syncEngine.hostTime = targetTime;
    syncEngine.hostPlaying = state.isPlaying;
    syncEngine.hostReceivedAt = now;

    if (state.forced) {
        syncEngine.lastAutoSeekAt = 0;
    }

    if (state.isPlaying && video.paused && !isBuffering) {
        video.play().catch(() => {});
        isPaused = false;
    } else if (!state.isPlaying && !video.paused) {
        video.pause();
        isPaused = true;
    }
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

    if (video.src) initSyncEngine();
});

socket.on('host-info', (data) => {
    hostId = data.hostId;
    hostName = data.hostName;
    const hostLabel = document.getElementById('hostLabel');
    if (hostLabel) hostLabel.innerText = `👑 Host: ${hostName}`;
    if (!isHost) updateControlsVisibility();
});

// ============================================================
// VIDEO EVENT LISTENERS
// ============================================================

let _viewerSeekFromRemote = false;

video.addEventListener('play', () => {
    if (isHost && !isBuffering) {
        socket.emit('play', { time: video.currentTime, serverTime: Date.now() });
    }
    isPaused = false;
});

video.addEventListener('pause', () => {
    if (isHost && !isBuffering) {
        socket.emit('pause', { time: video.currentTime, serverTime: Date.now() });
    }
    isPaused = true;
});

video.addEventListener('seeked', () => {
    if (isHost && !isBuffering) {
        socket.emit('seek', { time: video.currentTime, serverTime: Date.now() });
        resetSyncState();
        return;
    }
    if (!isHost && !_viewerSeekFromRemote) {
        syncEngine.hostTime = video.currentTime;
        syncEngine.hostReceivedAt = Date.now();
        syncEngine.pendingHardSeek = null;
    }
    _viewerSeekFromRemote = false;
});

// ============================================================
// BUFFERING - DEBOUNCED
// ============================================================

let _bufferingDebounce = null;

video.addEventListener('waiting', () => {
    if (isBuffering) return;
    _bufferingDebounce = setTimeout(() => {
        if (isBuffering) return;
        isBuffering = true;
        bufferingIndicator.classList.add('active');
        video.playbackRate = 1.0;
        socket.emit('buffering-start', { time: video.currentTime });
    }, 300);
});

video.addEventListener('canplay', () => {
    if (_bufferingDebounce) {
        clearTimeout(_bufferingDebounce);
        _bufferingDebounce = null;
    }
    if (isBuffering) {
        isBuffering = false;
        bufferingIndicator.classList.remove('active');
        socket.emit('buffering-end', { time: video.currentTime });
        if (!isHost) {
            syncEngine.hostReceivedAt = Date.now();
        }
    }
});

video.addEventListener('canplaythrough', () => {
    if (_bufferingDebounce) {
        clearTimeout(_bufferingDebounce);
        _bufferingDebounce = null;
    }
    if (isBuffering) {
        isBuffering = false;
        bufferingIndicator.classList.remove('active');
        socket.emit('buffering-end', { time: video.currentTime });
        if (!isHost) {
            syncEngine.hostReceivedAt = Date.now();
        }
    }
});

video.addEventListener('loadedmetadata', () => {
    if (currentRoom) initSyncEngine();
});

// ============================================================
// SOCKET LISTENERS - CONTROL EVENTS
// ============================================================

socket.on('play', (data) => {
    if (isYouTube && ytPlayer && typeof ytPlayer.playVideo === 'function') {
        if (Math.abs(ytPlayer.getCurrentTime() - data.time) > 1.5) ytPlayer.seekTo(data.time, true);
        ytPlayer.playVideo();
    } else {
        const videoEl = document.getElementById('videoPlayer');
        if (Math.abs(videoEl.currentTime - data.time) > 1.5) videoEl.currentTime = data.time;
        videoEl.play();
    }
});

socket.on('pause', (data) => {
    if (isYouTube && ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
        ytPlayer.pauseVideo();
        ytPlayer.seekTo(data.time, true);
    } else {
        const videoEl = document.getElementById('videoPlayer');
        videoEl.pause();
        videoEl.currentTime = data.time;
    }
});

socket.on('seek', (data) => {
    if (isHost) return;

    const now = Date.now();
    const targetTime = data.time;

    syncEngine.hostTime = targetTime;
    syncEngine.hostPlaying = data.isPlaying !== undefined ? data.isPlaying : syncEngine.hostPlaying;
    syncEngine.hostReceivedAt = now;
    syncEngine.lastAutoSeekAt = 0;
    syncEngine.pendingHardSeek = null;

    _viewerSeekFromRemote = true;
    video.currentTime = targetTime;
    video.playbackRate = 1.0;
});

socket.on('auto-sync-join', (state) => {
    if (!state.url) return;

    const targetTime = (() => {
        const now = Date.now();
        const elapsedSec = (now - (state.lastUpdate || now)) / 1000;
        return state.time + (state.isPlaying ? Math.min(elapsedSec, 5.0) : 0);
    })();

    loadVideoUrl(state.url);

    const onMeta = () => {
        video.removeEventListener('loadedmetadata', onMeta);
        video.currentTime = Math.max(0, targetTime);
        video.playbackRate = 1.0;
        if (state.isPlaying) video.play().catch(() => {});
        syncEngine.hostTime = targetTime;
        syncEngine.hostPlaying = state.isPlaying;
        syncEngine.hostReceivedAt = Date.now();
        syncEngine.pendingHardSeek = null;
        initSyncEngine();
    };
    if (video.readyState >= 1) {
        onMeta();
    } else {
        video.addEventListener('loadedmetadata', onMeta);
    }
});

socket.on('video-changed', (data) => {
    // Dukungan format data lama (object) dan baru (string url)
    const url = typeof data === 'string' ? data : data.url;
    if (url) loadVideoUrl(url);
});

// ============================================================
// FORCE SYNC
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

// ============================================================
// VIDEO LOADER - RESOLVE & STREAM (UPDATED WITH GDRIVE SUPPORT)
// ============================================================

async function resolveAndLoadVideo(rawUrl, autoPlay = true) {
    if (!rawUrl) return;

    let streamUrl = rawUrl;

    // Cek apakah ini Google Drive link
    const isDrive = rawUrl.includes('drive.google.com');
    if (isDrive) {
        const fileId = extractDriveFileId(rawUrl);
        if (fileId) {
            streamUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${GOOGLE_API_KEY}`;
            console.log(`📂 GDrive direct stream: ${streamUrl}`);
        } else {
            showSystemMessage('❌ Gagal mengekstrak ID dari link Google Drive.');
            return;
        }
    }

    screenPlayer.style.display = 'none';
    video.style.display = 'block';
    currentBaseVideoUrl = rawUrl;
    video.src = streamUrl;
    video.load();
    if (autoPlay) video.play().catch(() => {});
}

// ==========================================
// 2. MESIN PEMUTAR UNIVERSAL (DRIVE & YOUTUBE)
// ==========================================
function loadVideoUrl(url) {
    console.log("🎬 Memuat video:", url);
    const ytId = extractYouTubeId(url);
    const driveId = extractDriveFileId(url);
    
    const videoEl = document.getElementById('videoPlayer');
    const ytContainer = document.getElementById('youtubeContainer');
    
    // Bersihkan status pemutar sebelum memuat baru
    if (videoEl) {
        videoEl.pause();
        videoEl.style.display = 'none';
        videoEl.removeAttribute('src'); 
    }
    if (ytContainer) {
        ytContainer.style.display = 'none';
    }

    const loader = document.getElementById('loader');
    const buffering = document.getElementById('bufferingIndicator');
    if (loader) loader.style.display = 'none';
    if (buffering) buffering.style.display = 'none';

    if (ytId) {
        // --- MODE YOUTUBE ---
        isYouTube = true;
        if (ytContainer) ytContainer.style.display = 'block';

        if (ytPlayer && ytReady) {
            ytPlayer.loadVideoById(ytId);
        } else if (ytReady) {
            ytPlayer = new YT.Player('youtubePlayer', {
                videoId: ytId,
                playerVars: { 
                    'autoplay': 1, 
                    'controls': isHost ? 1 : 0, 
                    'disablekb': 1, 
                    'rel': 0 
                },
                events: { 'onStateChange': onYouTubePlayerStateChange }
            });
        }
    } else if (driveId) {
        // --- MODE GOOGLE DRIVE ---
        isYouTube = false;
        videoEl.style.display = 'block';

        if (userAccessToken) {
            console.log("🎬 Streaming Drive menggunakan Token Mandiri...");
            // Merakit URL menggunakan token dari masing-masing peserta
            const directStreamUrl = `https://www.googleapis.com/drive/v3/files/${driveId}?alt=media&acknowledgeAbuse=true&access_token=${userAccessToken}`;
            
            videoEl.src = directStreamUrl;
            videoEl.load();
            let playPromise = videoEl.play();
            if (playPromise !== undefined) {
                playPromise.catch(e => console.log("Menunggu interaksi untuk Autoplay..."));
            }
        } else {
            alert("⚠️ Kamu belum login Google. Akses video Drive ditolak.");
        }
    } else {
        // --- MODE MP4 BIASA / UPLOAD LOKAL ---
        isYouTube = false;
        videoEl.style.display = 'block';
        videoEl.src = url;
        videoEl.load();
        let playPromise = videoEl.play();
        if (playPromise !== undefined) {
            playPromise.catch(e => console.log("Menunggu interaksi untuk Autoplay..."));
        }
    }
}

// ==========================================
// 3. LOGIKA KONTROL HOST & SYNC VIEWER
// ==========================================

// Fungsi yang terhubung ke Tombol Ganti Video / Play
function changeVideo() {
    if (!isHost) {
        alert("❌ Hanya Host yang bisa mengganti video!");
        return;
    }
    
    const inputEl = document.getElementById('streamUrl');
    if (!inputEl) return;
    
    const rawUrl = inputEl.value.trim();
    if (!rawUrl) {
        alert('Masukkan link Google Drive atau YouTube!');
        return;
    }
    
    // KUNCI PERBAIKAN: Host menyiarkan URL mentah yang belum ditempeli token
    socket.emit('change-video', rawUrl);
    
    // Host memuat video di layarnya sendiri
    loadVideoUrl(rawUrl); 
    inputEl.value = ''; 
}

// Peserta menerima instruksi ganti video dari Host
socket.on('video-changed', (data) => {
    // Menangani format lama dan baru (menghindari undefined URL)
    const url = typeof data === 'string' ? data : data.url;
    if (url) {
        loadVideoUrl(url);
    }
});

// Listener interaksi UI YouTube untuk Sinkronisasi
function onYouTubePlayerStateChange(event) {
    if (!isHost || !isYouTube) return;
    const currentTime = ytPlayer.getCurrentTime();
    
    if (event.data === YT.PlayerState.PLAYING) {
        socket.emit('play', { time: currentTime, serverTime: Date.now() });
    } else if (event.data === YT.PlayerState.PAUSED) {
        socket.emit('pause', { time: currentTime, serverTime: Date.now() });
    } else if (event.data === YT.PlayerState.BUFFERING) {
        socket.emit('waiting');
    }
}

// Sinkronisasi PLAY
socket.on('play', (data) => {
    if (isYouTube && ytPlayer && typeof ytPlayer.playVideo === 'function') {
        if (Math.abs(ytPlayer.getCurrentTime() - data.time) > 1.5) ytPlayer.seekTo(data.time, true);
        ytPlayer.playVideo();
    } else {
        const videoEl = document.getElementById('videoPlayer');
        if (videoEl && Math.abs(videoEl.currentTime - data.time) > 1.5) videoEl.currentTime = data.time;
        if (videoEl) videoEl.play();
    }
});

// Sinkronisasi PAUSE
socket.on('pause', (data) => {
    if (isYouTube && ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
        ytPlayer.pauseVideo();
        ytPlayer.seekTo(data.time, true);
    } else {
        const videoEl = document.getElementById('videoPlayer');
        if (videoEl) {
            videoEl.pause();
            videoEl.currentTime = data.time;
        }
    }
});

function playStream() {
    if (!isHost) { showSystemMessage('⚠️ Hanya Host yang bisa memutar video!'); return; }
    const raw = document.getElementById('streamUrl').value.trim();
    if (!raw) { alert('Masukkan link Google Drive atau URL video terlebih dahulu!'); return; }

    const isDrive = raw.includes('drive.google.com');
    if (isDrive) showSystemMessage('📂 Memuat video dari Google Drive...');

    socket.emit('video-changed', { url: raw, serverTime: Date.now() });
    loadVideoUrl(raw);
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

    if (containsProfanity(msg)) {
        showProfanityWarning();
        return;
    }
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

// ============================================================
// Fungsi Darurat: Hard Reset Player
// ============================================================

function hardResetPlayer() {
    console.log("🔄 Melakukan Hard Reset pada Player...");
    
    const videoEl = document.getElementById('videoPlayer');
    const ytContainer = document.getElementById('youtubeContainer');
    const loader = document.getElementById('loader');
    const buffering = document.getElementById('bufferingIndicator');

    // 1. Bersihkan Loading UI
    if (loader) loader.style.display = 'none';
    if (buffering) buffering.style.display = 'none';

    // 2. Reset HTML5 Video
    if (videoEl) {
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
    }

    // 3. Reset YouTube
    if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
        ytPlayer.stopVideo();
    }

    // 4. Jika kamu adalah Host, kirim sinyal ke server untuk pause ruangan
    if (isHost) {
        socket.emit('pause', { time: 0 });
        alert("Player berhasil di-reset. Silakan masukkan ulang link video!");
    } else {
        alert("Player berhasil di-reset untuk layarmu.");
    }
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

console.log('✅ MeiraWatch siap digunakan! (Sync Engine v5 — RAF Loop + NTP Latency)');
