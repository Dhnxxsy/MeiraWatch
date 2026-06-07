// --- SCRIPT.JS OPTIMAL ---
const socket = io();
const peer = new Peer(); 
let myPeerId = null;

peer.on('open', (id) => {
    myPeerId = id; 
});

const video = document.getElementById('videoPlayer');
const screenPlayer = document.getElementById('screenPlayer');
const preloaderVideo = document.getElementById('preloaderVideo');
const chatBox = document.getElementById('chatBox');

// Load suara sekali saja
const msgSound = new Audio('public/sfx/pop.mp3');
msgSound.volume = 1; 

let isHostAction = true;
let currentRoom = '';
let currentBaseVideoUrl = '';

function joinRoom() {
    const roomId = document.getElementById('roomIdInput').value.trim();
    if (!roomId) return alert("Masukkan ID Room terlebih dahulu!");
    
    // Ambil nama dari input sebelum masuk room
    const username = document.getElementById('usernameInput').value || 'Guest';
    
    currentRoom = roomId;
    document.getElementById('displayRoomId').innerText = roomId;
    
    // Kirim ID Room, ID WebRTC, dan Nama ke server
    socket.emit('join-room', currentRoom, myPeerId, username);
    
    document.getElementById('roomOverlay').style.display = 'none';
    document.getElementById('appContainer').style.display = 'flex';

    // Tampilkan pesan ke diri sendiri
    showSystemMessage(`Anda bergabung ke room ${roomId}`);
}

// --- LOGIKA PERGANTIAN RESOLUSI PERSONAL ---
function changeResolution() {
    if (!currentBaseVideoUrl) return;

    const select = document.getElementById('resolutionSelect');
    
    // Jika user memilih original, hilangkan embel-embel ?res=
    // Jika user memilih 144p/360p, tambahkan ?res=144p di belakang URL
    if (select.value === 'original') {
        changeQuality(currentBaseVideoUrl);
    } else {
        changeQuality(`${currentBaseVideoUrl}?res=${select.value}`);
    }
}

// Smart switching untuk ganti kualitas tanpa memutus koneksi
async function changeQuality(newUrl) {
    const currentTime = video.currentTime; // Simpan posisi waktu
    
    // Ganti source
    video.src = newUrl;
    
    // Load ulang dan tunggu sampai bisa play
    video.load();
    
    // Set posisi ke waktu terakhir setelah video siap
    video.currentTime = currentTime;
    
    video.oncanplay = () => {
        video.play();
        video.oncanplay = null; // Reset event listener
    };
}

// Pre-buffering untuk kualitas lain
function preloadQuality(url) {
    preloaderVideo.src = url;
    preloaderVideo.load(); // Memaksa browser mengunduh metadata di background
}

// Smart Loader untuk bebas lag
function playVideo(url) {
    const video = document.getElementById('videoPlayer');
    
    // Simpan posisi saat ini untuk transisi mulus
    const lastTime = video.currentTime;
    
    // Ganti source
    video.src = url;
    
    // Load ulang
    video.load();
    
    // Setelah siap, pindah ke posisi terakhir
    video.oncanplay = () => {
        video.currentTime = lastTime;
        video.play();
    };
}

// Load Google Drive video untuk iframe
function loadGoogleDriveVideo(shareLink) {
    // Ambil ID dari link share drive
    const videoId = shareLink.split('/d/')[1].split('/')[0];
    
    // Ubah ke format embed preview
    const embedUrl = `https://drive.google.com/file/d/${videoId}/preview`;
    
    // Tampilkan di iframe
    const player = document.getElementById('videoPlayer');
    player.src = embedUrl;
}

// Modifikasi video-changed agar menutup share screen jika host mengganti film
socket.on('video-changed', (url) => {
    screenPlayer.style.display = 'none';
    if (screenPlayer.srcObject) {
        screenPlayer.srcObject.getTracks().forEach(t => t.stop());
        screenPlayer.srcObject = null;
    }
    video.style.display = 'block';
    
    currentBaseVideoUrl = url;
    document.getElementById('resolutionSelect').value = 'original';
    video.src = url;
    video.load();
    isHostAction = false;
    video.play().catch(() => alert("Video dimuat. Silakan tekan Play."));
});

// --- SINKRONISASI VIDEO (TETAP SAMA) ---
video.addEventListener('play', () => { if (isHostAction) socket.emit('play', video.currentTime); isHostAction = true; });
video.addEventListener('pause', () => { if (isHostAction) socket.emit('pause', video.currentTime); isHostAction = true; });
video.addEventListener('seeked', () => { if (isHostAction) socket.emit('seek', video.currentTime); isHostAction = true; });

socket.on('play', (time) => { isHostAction = false; video.currentTime = time; video.play(); });
socket.on('pause', (time) => { isHostAction = false; video.currentTime = time; video.pause(); });
socket.on('seek', (time) => { isHostAction = false; video.currentTime = time; });

socket.on('sync-request', (serverTime) => {
    if (Math.abs(video.currentTime - serverTime) > 2) {
        isHostAction = false;
        video.currentTime = serverTime;
    }
});

function forceSync() { socket.emit('sync-request', video.currentTime); }
setInterval(() => { if (!video.paused && currentRoom) socket.emit('sync-request', video.currentTime); }, 5000);

// --- FITUR REPLY ---
let activeReply = null; // Menyimpan data pesan yang akan dibalas

// Fungsi saat tombol "Reply" diklik
function setReply(name, msg) {
    activeReply = { name, msg };
    document.getElementById('replyPreviewName').innerText = `Membalas ${name}`;
    document.getElementById('replyPreviewText').innerText = msg;
    document.getElementById('replyPreview').style.display = 'flex';
    document.getElementById('messageInput').focus();
}

// Fungsi batal reply
function cancelReply() {
    activeReply = null;
    document.getElementById('replyPreview').style.display = 'none';
}

// --- FITUR CHAT & TYPING INDICATOR ---
const messageInput = document.getElementById('messageInput');
const typingIndicator = document.getElementById('typingIndicator');
let typingTimer;

// Deteksi saat kita mengetik di kolom input
messageInput.addEventListener('input', () => {
    const name = document.getElementById('usernameInput').value || 'Guest';
    socket.emit('typing', name);
    
    // Hapus timer lama, dan buat timer baru (Reset)
    clearTimeout(typingTimer);
    
    // Jika tidak ada ketikan selama 2 detik, matikan tanda mengetik
    typingTimer = setTimeout(() => {
        socket.emit('stop-typing');
    }, 2000);
});

function sendMessage() {
    const name = document.getElementById('usernameInput').value || 'Guest';
    const msg = messageInput.value;
    if (msg.trim() === '') return;

    const messageData = { name, msg };
    
    // Jika sedang membalas, lampirkan data pesannya
    if (activeReply) {
        messageData.replyTo = activeReply;
    }

    socket.emit('chat-message', messageData);
    
    // Bersihkan setelah mengirim
    socket.emit('stop-typing');
    clearTimeout(typingTimer);
    messageInput.value = '';
    cancelReply(); // Hilangkan preview reply
}

function handleEnter(e) { if (e.key === 'Enter') sendMessage(); }

// Menampilkan pesan masuk ke layar
socket.on('chat-message', (data) => {
    // Mainkan suara HANYA JIKA bukan pesan dari diri sendiri
    if (data.name !== document.getElementById('usernameInput').value) {
        msgSound.play().catch(e => console.log("User harus interaksi dulu sebelum suara bisa play"));
    }

    const msgWrapper = document.createElement('div');
    msgWrapper.className = 'msg-wrapper';
    
    // Sanitasi teks agar tanda kutip (') tidak merusak HTML tombol reply
    const safeName = data.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeMsg = data.msg.replace(/'/g, "\\'").replace(/"/g, '&quot;');

    // Jika pesan ini adalah balasan (memiliki replyTo), buat kotak kutipannya
    let quotedHTML = '';
    if (data.replyTo) {
        quotedHTML = `
            <div class="msg-quoted">
                <div class="msg-quoted-name">${data.replyTo.name}</div>
                <div class="msg-quoted-text">${data.replyTo.msg}</div>
            </div>
        `;
    }

    // Gabungkan dengan bubble pesan utama
    msgWrapper.innerHTML = `
        <div class="msg-bubble">
            ${quotedHTML}
            <div class="msg-name">${data.name}</div>
            <div>${data.msg}</div>
        </div>
        <button class="reply-btn" onclick="setReply('${safeName}', '${safeMsg}')">↩ Reply</button>
    `;
    
    chatBox.appendChild(msgWrapper);
    chatBox.scrollTop = chatBox.scrollHeight;
});

// Menangkap sinyal saat teman sedang mengetik
socket.on('typing', (name) => {
    typingIndicator.innerHTML = `${name} sedang mengetik<span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>`;
    typingIndicator.classList.add('active');
});

// Menangkap sinyal saat teman berhenti mengetik
socket.on('stop-typing', () => {
    typingIndicator.classList.remove('active');
});

// --- FITUR UPLOAD & STREAM (TETAP SAMA) ---
async function uploadVideo() {
    const fileInput = document.getElementById('fileInput');
    if (!fileInput.files[0]) return alert("Pilih file dulu!");

    const formData = new FormData();
    formData.append('videoFile', fileInput.files[0]);

    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    
    if (data.success) {
        // PERBAIKAN: Putar langsung di lokal untuk Host
        currentBaseVideoUrl = data.url;
        document.getElementById('resolutionSelect').value = 'original';
        
        // Reset tampilan kembali ke player film (jika sedang share screen)
        screenPlayer.style.display = 'none';
        video.style.display = 'block';

        video.src = data.url;
        video.load();
        video.play().catch(e => console.log("Auto-play dicegah browser", e));
        
        // Beritahu penonton lain
        socket.emit('video-changed', data.url); 
    } else {
        alert("Gagal unggah");
    }
}

function playStream() {
    const url = document.getElementById('streamUrl').value;
    if (url) socket.emit('video-changed', url);
}

// --- FITUR SHARE SCREEN (WEBRTC) ---
let localScreenStream = null;

async function startScreenShare() {
    try {
        // SETTING OPTIMAL: 720p & 15 FPS (Sangat hemat kuota, teks tetap tajam)
        localScreenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { width: 1280, height: 720, frameRate: 15 },
            audio: { echoCancellation: true, noiseSuppression: true }
        });
        
        // Tampilkan layar kita sendiri
        video.style.display = 'none';
        screenPlayer.style.display = 'block';
        screenPlayer.srcObject = localScreenStream;

        // Minta daftar penonton ke server untuk ditelepon
        socket.emit('request-peer-ids');

        // Jika kita menekan tombol "Stop Sharing" dari browser
        localScreenStream.getVideoTracks()[0].onended = () => {
            socket.emit('video-changed', currentBaseVideoUrl); // Kembalikan ke film
        };
    } catch (err) {
        console.error("Gagal share screen:", err);
    }
}

// Host menelepon semua penonton yang ada di room
socket.on('receive-peer-ids', (peerIds) => {
    peerIds.forEach(id => {
        if (id !== myPeerId) {
            peer.call(id, localScreenStream);
        }
    });
});

// Penonton menerima panggilan Share Screen
peer.on('call', (call) => {
    call.answer(); // Angkat telepon secara otomatis
    
    call.on('stream', (remoteStream) => {
        // Ganti tampilan ke layar host
        video.pause();
        video.style.display = 'none';
        screenPlayer.style.display = 'block';
        screenPlayer.srcObject = remoteStream;
    });
});

// --- FITUR SMART AUTO-SYNC SAAT JOIN/RECONNECT ---
socket.on('auto-sync-join', (state) => {
    console.log("Menyinkronkan otomatis dengan room...");
    currentBaseVideoUrl = state.url;
    document.getElementById('resolutionSelect').value = 'original'; // Default ke original dulu
    
    video.src = state.url;
    
    // Tunggu sampai browser tahu durasi video sebelum melompat ke menit tertentu
    video.onloadedmetadata = () => {
        isHostAction = false;
        video.currentTime = state.time; // Lompat ke waktu host
        
        if (state.isPlaying) {
            video.play().catch(e => {
                console.log("Autoplay dicegah browser", e);
                alert("Anda telah terhubung kembali! Silakan tekan Play untuk menyinkronkan.");
            });
        }
    };
    video.load();
});

// --- FITUR SYSTEM MESSAGE (JOIN/LEAVE) ---
socket.on('system-message', (msg) => {
    showSystemMessage(msg);
});

function showSystemMessage(text) {
    const msgEl = document.createElement('div');
    msgEl.className = 'system-msg';
    msgEl.innerText = text;
    chatBox.appendChild(msgEl);
    chatBox.scrollTop = chatBox.scrollHeight;
}

// Mencegah scroll paksa saat keyboard muncul di iOS/Android
// (Dihapus karena sudah digantikan dengan viewport lock di atas)

// --- FITUR FLOATING REACTIONS ---
const videoWrapper = document.querySelector('.video-wrapper');

// Fungsi saat kita mengklik emote
function sendReaction(emoji) {
    socket.emit('reaction', emoji); // Beritahu server
    showFloatingReaction(emoji);    // Munculkan di layar kita sendiri
}

// Fungsi saat kita menerima emote dari teman
socket.on('reaction', (emoji) => {
    showFloatingReaction(emoji);
});

// Logika memunculkan dan menganimasikan emote
function showFloatingReaction(emoji) {
    if (!videoWrapper) return;

    const el = document.createElement('div');
    el.className = 'floating-emoji';
    el.innerText = emoji;

    // Acak posisi kemunculan dari kiri ke kanan (agar tidak bertumpuk di satu garis lurus)
    const startX = 50 + (Math.random() * 30 - 15); // Antara 35% sampai 65% lebar layar
    el.style.left = `${startX}%`;

    // Acak arah terbangnya ke kiri/kanan
    const randomX = Math.floor(Math.random() * 100) - 50; 
    el.style.setProperty('--end-x', `calc(-50% + ${randomX}px)`);

    // Masukkan ke dalam layar video
    videoWrapper.appendChild(el);

    // Hapus elemen setelah animasi selesai (2.5 detik) agar web tidak lemot
    setTimeout(() => {
        el.remove();
    }, 2500);
}