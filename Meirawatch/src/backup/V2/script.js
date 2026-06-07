// --- SCRIPT.JS DENGAN FIX CONFIRM SUPPORT ---
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
const bufferingIndicator = document.getElementById('bufferingIndicator');

// --- SUARA NOTIFIKASI ---
const msgSound = new Audio('https://www.soundjay.com/buttons/sounds/button-16.mp3');
msgSound.volume = 0.7;

const notifSound = new Audio('https://www.soundjay.com/buttons/sounds/button-16.mp3');
notifSound.volume = 0.5;

let isHostAction = true;
let currentRoom = '';
let currentBaseVideoUrl = '';
let currentRoomUsers = 0;
let currentUsername = '';
let isHost = false;
let hostId = null;
let hostName = 'Host';

// --- VARIABEL UNTUK SYNC ---
let syncInterval = null;
let heartbeatInterval = null;
let isBuffering = false;
let isSyncing = false;
let smoothSyncActive = false;
let lastPlaybackRate = 1.0;
let bufferingUser = null;
let bufferingPosition = 0;
let bufferingStartTime = 0;

// --- CONSTANTS ---
const HEARTBEAT_INTERVAL = 2000;
const SYNC_CHECK_INTERVAL = 3000;
const EXTRA_SYNC_INTERVAL = 1000;
const SYNC_THRESHOLD = 0.5;
const LARGE_SYNC_THRESHOLD = 2.0;

// --- FIX MOBILE ---
document.addEventListener('DOMContentLoaded', function() {
    const chatInputArea = document.querySelector('.chat-input-area');
    const chatInputWrapper = document.querySelector('.chat-input-wrapper');

    if (chatInputArea) {
        chatInputArea.style.display = 'flex';
        chatInputArea.style.visibility = 'visible';
    }

    if (chatInputWrapper) {
        chatInputWrapper.style.display = 'block';
        chatInputWrapper.style.visibility = 'visible';
    }

    let vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
});

window.addEventListener('resize', function() {
    let vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
});

// --- TAMBAHAN: Touch event untuk menampilkan actions di HP ---
document.addEventListener('touchstart', function(e) {
    const msgWrapper = e.target.closest('.msg-wrapper');
    if (msgWrapper) {
        document.querySelectorAll('.msg-wrapper.active').forEach(el => {
            if (el !== msgWrapper) {
                el.classList.remove('active');
            }
        });
        msgWrapper.classList.toggle('active');
    }
});

document.addEventListener('touchstart', function(e) {
    if (!e.target.closest('.msg-wrapper')) {
        document.querySelectorAll('.msg-wrapper.active').forEach(el => {
            el.classList.remove('active');
        });
    }
});

// --- REACTION BAR DRAG UNTUK LAPTOP ---
document.addEventListener('DOMContentLoaded', function() {
    const reactionBar = document.querySelector('.reaction-bar');
    if (!reactionBar) return;
    
    let isDown = false;
    let startX = 0;
    let scrollLeft = 0;

    reactionBar.addEventListener('mousedown', (e) => {
        isDown = true;
        reactionBar.classList.add('dragging');
        startX = e.pageX - reactionBar.offsetLeft;
        scrollLeft = reactionBar.scrollLeft;
        reactionBar.style.cursor = 'grabbing';
    });

    reactionBar.addEventListener('mouseleave', () => {
        if (isDown) {
            isDown = false;
            reactionBar.classList.remove('dragging');
            reactionBar.style.cursor = 'grab';
        }
    });

    reactionBar.addEventListener('mouseup', () => {
        isDown = false;
        reactionBar.classList.remove('dragging');
        reactionBar.style.cursor = 'grab';
    });

    reactionBar.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        e.preventDefault();
        const x = e.pageX - reactionBar.offsetLeft;
        const walk = (x - startX) * 1.5;
        reactionBar.scrollLeft = scrollLeft - walk;
    });
    
    reactionBar.addEventListener('wheel', (e) => {
        e.preventDefault();
        reactionBar.scrollLeft += e.deltaY;
    }, { passive: false });
});

// --- SIMPLE SYNC ---
function performSync(targetTime) {
    if (isBuffering) return;
    if (video.paused) {
        video.currentTime = targetTime;
        return;
    }

    const currentTime = video.currentTime;
    const diff = targetTime - currentTime;

    if (Math.abs(diff) < 0.3) return;

    if (Math.abs(diff) < LARGE_SYNC_THRESHOLD) {
        const targetRate = 1.0 + (diff / 15);
        const clampedRate = Math.max(0.9, Math.min(1.1, targetRate));
        video.playbackRate = clampedRate;
        
        setTimeout(() => {
            video.playbackRate = 1.0;
        }, 2000);
    } else {
        if (video.paused) {
            video.currentTime = targetTime;
        }
    }
}

// --- INIT SYNC ---
function initSync() {
    if (syncInterval) clearInterval(syncInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    if (isHost) {
        heartbeatInterval = setInterval(() => {
            if (currentRoom && video.src) {
                socket.emit('heartbeat', {
                    time: video.currentTime,
                    isPlaying: !video.paused,
                    buffering: isBuffering
                });
            }
        }, HEARTBEAT_INTERVAL);
    }

    syncInterval = setInterval(() => {
        if (currentRoom && video.src && !isBuffering) {
            if (isHost) {
                socket.emit('sync-request', video.currentTime);
            } else {
                socket.emit('request-sync');
            }
        }
    }, SYNC_CHECK_INTERVAL);

    setInterval(() => {
        if (currentRoom && video.src && isHost && !isBuffering) {
            socket.emit('extra-sync', {
                time: video.currentTime,
                isPlaying: !video.paused
            });
        }
    }, EXTRA_SYNC_INTERVAL);
}

// --- JOIN ROOM ---
function joinRoom() {
    const roomId = document.getElementById('roomIdInput').value.trim();
    if (!roomId) return alert("Masukkan ID Room terlebih dahulu!");

    const username = document.getElementById('usernameInputModal').value.trim() || document.getElementById('usernameInput').value || 'Guest';
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

    setTimeout(initSync, 1000);
}

// --- ROLE SYSTEM ---
socket.on('role-assigned', (data) => {
    isHost = data.isHost;
    hostId = data.hostId;

    updateControlsVisibility();

    if (isHost) {
        showSystemMessage('👑 Anda adalah Host! Anda bisa mengontrol video.');
    } else {
        showSystemMessage('👤 Anda adalah Viewer. Selamat menonton!');
    }
});

socket.on('host-info', (data) => {
    hostId = data.hostId;
    hostName = data.hostName;

    const hostLabel = document.getElementById('hostLabel');
    if (hostLabel) {
        hostLabel.innerText = `👑 Host: ${hostName}`;
    }

    if (!isHost) {
        updateControlsVisibility();
    }
});

function updateControlsVisibility() {
    const uploadSection = document.querySelector('.upload-section');
    const streamSection = document.querySelector('.stream-section');
    const syncBtn = document.querySelector('.sync-btn');
    const screenShareBtn = document.querySelector('.stream-section button:last-child');

    if (isHost) {
        if (uploadSection) uploadSection.style.display = 'flex';
        if (streamSection) streamSection.style.display = 'flex';
        if (syncBtn) syncBtn.style.display = 'inline-block';
        if (screenShareBtn) screenShareBtn.style.display = 'inline-block';
    } else {
        if (uploadSection) uploadSection.style.display = 'none';
        if (streamSection) streamSection.style.display = 'none';
        if (syncBtn) syncBtn.style.display = 'none';
        if (screenShareBtn) screenShareBtn.style.display = 'none';
    }
}

// --- LOGIKA VIDEO ---
function changeResolution() {
    if (!currentBaseVideoUrl) return;
    const select = document.getElementById('resolutionSelect');
    if (select.value === 'original') {
        changeQuality(currentBaseVideoUrl);
    } else {
        changeQuality(`${currentBaseVideoUrl}?res=${select.value}`);
    }
}

async function changeQuality(newUrl) {
    const currentTime = video.currentTime;
    video.src = newUrl;
    video.load();
    video.currentTime = currentTime;
    video.play().catch(() => {});
}

// --- VIDEO EVENT LISTENERS ---
video.addEventListener('play', () => {
    if (isHostAction && isHost) {
        socket.emit('play', {
            time: video.currentTime,
            serverTime: Date.now()
        });
    }
    isHostAction = true;
});

video.addEventListener('pause', () => {
    if (isHostAction && isHost) {
        socket.emit('pause', {
            time: video.currentTime,
            serverTime: Date.now()
        });
    }
    isHostAction = true;
});

video.addEventListener('seeked', () => {
    if (isHostAction && isHost) {
        socket.emit('seek', {
            time: video.currentTime,
            serverTime: Date.now()
        });
    }
    isHostAction = true;
});

// --- BUFFERING DETECTION ---
video.addEventListener('waiting', () => {
    if (!isBuffering) {
        isBuffering = true;
        bufferingIndicator.classList.add('active');
        bufferingPosition = video.currentTime;
        bufferingStartTime = Date.now();

        socket.emit('buffering-start', {
            time: video.currentTime
        });
    }
});

video.addEventListener('canplay', () => {
    if (isBuffering) {
        const bufferingDuration = (Date.now() - bufferingStartTime) / 1000;
        isBuffering = false;
        bufferingIndicator.classList.remove('active');

        socket.emit('buffering-end', {
            time: video.currentTime
        });
    }
});

// --- SOCKET LISTENERS ---
socket.on('play', (data) => {
    if (isBuffering) return;

    isHostAction = false;

    const serverTime = data.serverTime || Date.now();
    const networkDelay = Date.now() - serverTime;
    const adjustedTime = data.time + (networkDelay / 1000);

    if (Math.abs(video.currentTime - adjustedTime) > LARGE_SYNC_THRESHOLD) {
        video.currentTime = adjustedTime;
    }

    if (video.paused) {
        video.play().catch(() => {});
    }
});

socket.on('pause', (data) => {
    if (isBuffering) return;

    isHostAction = false;

    const serverTime = data.serverTime || Date.now();
    const networkDelay = Date.now() - serverTime;
    const adjustedTime = data.time + (networkDelay / 1000);

    if (Math.abs(video.currentTime - adjustedTime) > LARGE_SYNC_THRESHOLD) {
        video.currentTime = adjustedTime;
    }

    if (!video.paused) {
        video.pause();
    }
});

socket.on('seek', (data) => {
    if (isBuffering) return;

    isHostAction = false;

    const serverTime = data.serverTime || Date.now();
    const networkDelay = Date.now() - serverTime;
    const adjustedTime = data.time + (networkDelay / 1000);

    video.currentTime = adjustedTime;
});

socket.on('sync-state', (state) => {
    if (isBuffering) return;

    const serverTime = state.serverTime || Date.now();
    const networkDelay = Date.now() - serverTime;
    const adjustedTime = state.time + (networkDelay / 1000);

    const diff = Math.abs(video.currentTime - adjustedTime);

    if (diff > SYNC_THRESHOLD) {
        performSync(adjustedTime);
    }

    if (state.isPlaying && video.paused) {
        video.play().catch(() => {});
    } else if (!state.isPlaying && !video.paused) {
        video.pause();
    }
});

socket.on('extra-sync', (data) => {
    if (isHost) return;
    if (isBuffering) return;

    const serverTime = data.serverTime || Date.now();
    const networkDelay = Date.now() - serverTime;
    const adjustedTime = data.time + (networkDelay / 1000);

    const diff = Math.abs(video.currentTime - adjustedTime);

    if (diff > 0.2) {
        performSync(adjustedTime);
    }

    if (data.isPlaying && video.paused) {
        video.play().catch(() => {});
    } else if (!data.isPlaying && !video.paused) {
        video.pause();
    }
});

// --- BUFFERING NOTIFICATION ---
socket.on('buffering-notification', (data) => {
    const { user, isBuffering: buffering, time } = data;

    if (buffering) {
        bufferingUser = user;
        bufferingPosition = time;
    } else {
        bufferingUser = null;
        bufferingPosition = 0;
    }
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
    document.getElementById('resolutionSelect').value = 'original';
    video.src = data.url;
    video.load();
    isHostAction = false;
    video.play().catch(() => {});
});

// --- AUTO SYNC JOIN ---
socket.on('auto-sync-join', (state) => {
    console.log("Menyinkronkan otomatis dengan room...");
    currentBaseVideoUrl = state.url;
    document.getElementById('resolutionSelect').value = 'original';
    video.src = state.url;

    video.onloadedmetadata = () => {
        isHostAction = false;

        const serverTime = state.lastUpdate || Date.now();
        const networkDelay = Date.now() - serverTime;
        const adjustedTime = state.time + (networkDelay / 1000);

        video.currentTime = adjustedTime;

        if (state.isPlaying) {
            video.play().catch(e => {
                console.log("Autoplay dicegah browser", e);
            });
        }

        initSync();
    };
    video.load();
});

// --- FORCE SYNC ---
function forceSync() {
    if (isHost) {
        socket.emit('sync-request', video.currentTime);
    } else {
        showSystemMessage('⚠️ Hanya Host yang bisa melakukan force sync!');
    }
}

// --- UPLOAD VIDEO ---
async function uploadVideo() {
    if (!isHost) {
        showSystemMessage('⚠️ Hanya Host yang bisa mengupload video!');
        return;
    }

    const fileInput = document.getElementById('fileInput');
    if (!fileInput.files[0]) return alert("Pilih file dulu!");

    const formData = new FormData();
    formData.append('videoFile', fileInput.files[0]);

    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (data.success) {
        currentBaseVideoUrl = data.url;
        document.getElementById('resolutionSelect').value = 'original';
        screenPlayer.style.display = 'none';
        video.style.display = 'block';
        video.src = data.url;
        video.load();
        video.play().catch(() => {});
        socket.emit('video-changed', {
            url: data.url,
            serverTime: Date.now()
        });
    } else {
        alert("Gagal unggah");
    }
}

// --- PLAY STREAM ---
function playStream() {
    if (!isHost) {
        showSystemMessage('⚠️ Hanya Host yang bisa memutar URL stream!');
        return;
    }

    const url = document.getElementById('streamUrl').value;
    if (url) {
        socket.emit('video-changed', {
            url: url,
            serverTime: Date.now()
        });
    }
}

// --- SHARE SCREEN ---
let localScreenStream = null;

async function startScreenShare() {
    if (!isHost) {
        showSystemMessage('⚠️ Hanya Host yang bisa Share Screen!');
        return;
    }

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
            socket.emit('video-changed', {
                url: currentBaseVideoUrl,
                serverTime: Date.now()
            });
        };
    } catch (err) {
        console.error("Gagal share screen:", err);
    }
}

socket.on('receive-peer-ids', (peerIds) => {
    peerIds.forEach(id => {
        if (id !== myPeerId) {
            peer.call(id, localScreenStream);
        }
    });
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

// --- KICK USER ---
function kickUser(targetSocketId) {
    if (!isHost) {
        showSystemMessage('⚠️ Hanya Host yang bisa mengeluarkan user!');
        return;
    }
    socket.emit('kick-user', targetSocketId);
}

// --- TRANSFER HOST ---
function transferHost(targetSocketId) {
    if (!isHost) {
        showSystemMessage('⚠️ Hanya Host yang bisa mentransfer status Host!');
        return;
    }
    socket.emit('transfer-host', targetSocketId);
}

// --- SYSTEM MESSAGE ---
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

// --- ERROR MESSAGE ---
socket.on('error-message', (msg) => {
    showSystemMessage(`⚠️ ${msg}`);
    alert(msg);
});

// --- KICKED ---
socket.on('kicked', (data) => {
    alert(data.message);
    document.getElementById('appContainer').style.display = 'none';
    document.getElementById('roomOverlay').style.display = 'flex';
    document.getElementById('roomIdInput').value = '';
});

// --- CHAT WITH EDIT (FIX HP - TOMBOL KIRIM) ---
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
    typingTimer = setTimeout(() => {
        socket.emit('stop-typing');
    }, 2000);
});

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
    }
});

function handleSend() {
    if (isEditing && editingMessageId) {
        editMessage();
    } else {
        sendMessage();
    }
}

function sendMessage() {
    if (isEditing && editingMessageId) {
        return;
    }
    
    const name = document.getElementById('usernameInput').value || 'Guest';
    const msg = messageInput.value;
    if (msg.trim() === '') return;

    const messageData = { name, msg };
    if (activeReply) {
        messageData.replyTo = activeReply;
    }

    socket.emit('chat-message', messageData);
    socket.emit('stop-typing');
    clearTimeout(typingTimer);
    messageInput.value = '';
    cancelReply();
}

function editMessage() {
    const newText = messageInput.value;
    if (newText.trim() === '') return;
    if (!editingMessageId) return;

    socket.emit('edit-message', {
        messageId: editingMessageId,
        newText: newText.trim()
    });

    messageInput.value = '';
    editingMessageId = null;
    isEditing = false;
    document.getElementById('messageInput').placeholder = 'Ketik pesan...';
    sendButton.innerText = 'Kirim';
    socket.emit('stop-typing');
    clearTimeout(typingTimer);
}

function handleEnter(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
    }
}

function playNotificationSound() {
    msgSound.play().catch(() => {
        notifSound.play().catch(() => {
            console.log("Suara notifikasi tidak bisa diputar");
        });
    });
}

socket.on('chat-message', (data) => {
    const myName = document.getElementById('usernameInput').value;
    const isMine = data.name === myName;
    
    if (!isMine) {
        playNotificationSound();
    }

    const existingMsg = document.getElementById(`msg-${data.id}`);
    if (existingMsg) {
        return;
    }

    const msgWrapper = document.createElement('div');
    msgWrapper.className = 'msg-wrapper';
    msgWrapper.dataset.messageId = data.id;
    
    if (isMine) {
        msgWrapper.classList.add('mine');
    } else {
        msgWrapper.classList.add('others');
    }

    const safeName = data.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeMsg = data.msg.replace(/'/g, "\\'").replace(/"/g, '&quot;');

    let quotedHTML = '';
    if (data.replyTo) {
        quotedHTML = `
            <div class="msg-quoted">
                <div class="msg-quoted-name">${data.replyTo.name}</div>
                <div class="msg-quoted-text">${data.replyTo.msg}</div>
            </div>
        `;
    }

    msgWrapper.innerHTML = `
        <div class="msg-bubble" id="msg-${data.id}">
            ${quotedHTML}
            <div class="msg-name">${data.name}</div>
            <div class="msg-content">${safeMsg}</div>
        </div>
        <div class="msg-actions">
            <button class="reply-btn" onclick="setReply('${safeName}', '${safeMsg}')">↩ Reply</button>
            ${isMine ? `
                <button class="edit-btn" onclick="startEdit('${data.id}', '${safeMsg}')">✏️ Edit</button>
            ` : ''}
        </div>
    `;
    
    chatBox.appendChild(msgWrapper);
    chatBox.scrollTop = chatBox.scrollHeight;
});

socket.on('message-edited', (data) => {
    const msgBubble = document.getElementById(`msg-${data.id}`);
    if (msgBubble) {
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
    }
});

function startEdit(messageId, currentText) {
    if (isEditing) return;
    
    editingMessageId = messageId;
    isEditing = true;
    messageInput.value = currentText;
    document.getElementById('messageInput').placeholder = 'Edit pesan... (Enter untuk simpan)';
    sendButton.innerText = 'Simpan';
    messageInput.focus();
    
    const msgBubble = document.getElementById(`msg-${messageId}`);
    if (msgBubble) {
        msgBubble.style.border = '2px solid var(--accent)';
    }
}

function setReply(name, msg) {
    activeReply = { name, msg };
    document.getElementById('replyPreviewName').innerText = `Membalas ${name}`;
    document.getElementById('replyPreviewText').innerText = msg;
    document.getElementById('replyPreview').style.display = 'flex';
    document.getElementById('messageInput').focus();
}

function cancelReply() {
    activeReply = null;
    document.getElementById('replyPreview').style.display = 'none';
}

socket.on('typing', (name) => {
    typingIndicator.innerHTML = `${name} sedang mengetik<span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>`;
    typingIndicator.classList.add('active');
});

socket.on('stop-typing', () => {
    typingIndicator.classList.remove('active');
});

// --- USER COUNTER ---
socket.on('user-count', (count) => {
    currentRoomUsers = count;
    document.getElementById('userCount').innerText = count;
});

// --- REACTION ---
function sendReaction(emoji) {
    console.log('Sending reaction:', emoji);
    socket.emit('reaction', emoji);
    showFloatingReaction(emoji);
}

function showFloatingReaction(emoji) {
    const videoWrapper = document.querySelector('.video-wrapper');
    if (!videoWrapper) {
        console.warn('Video wrapper not found');
        return;
    }
    
    const existingEmojis = videoWrapper.querySelectorAll('.floating-emoji');
    if (existingEmojis.length > 10) {
        existingEmojis[0].remove();
    }
    
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
    
    setTimeout(() => {
        if (el.parentNode) {
            el.remove();
        }
    }, duration * 1000 + 100);
}

socket.on('reaction', (emoji) => {
    console.log('Received reaction from server:', emoji);
    showFloatingReaction(emoji);
});

// --- FIX: Prevent keyboard from hiding on mobile ---
document.addEventListener('touchend', (e) => {
    if (e.target.id === 'messageInput' || e.target.id === 'usernameInput') {
        setTimeout(() => {
            const chatSection = document.querySelector('.chat-section');
            if (chatSection && window.innerWidth < 768) {
                chatSection.scrollIntoView({ behavior: 'smooth', block: 'end' });
            }
        }, 100);
    }
});

// --- SUPPORT MODAL ---
let selectedMethod = null;

const paymentData = {
    dana: {
        number: '081585419615',
        name: 'Raga Kalas Ramadhan',
        instruction: 'Transfer via DANA ke nomor di atas. Konfirmasi setelah transfer.'
    },
    gopay: {
        number: '081585419615',
        name: 'Raga Kalas Ramadhan',
        instruction: 'Transfer via GoPay ke nomor di atas. Konfirmasi setelah transfer.'
    },
    shopeepay: {
        number: '081585419615',
        name: 'Raga Kalas Ramadhan',
        instruction: 'Transfer via ShopeePay ke nomor di atas. Konfirmasi setelah transfer.'
    },
    seabank: {
        number: '901245428657',
        name: 'Raga Kalas Ramadhan',
        instruction: 'Transfer via SeaBank ke nomor di atas. Konfirmasi setelah transfer.'
    }
};

function openSupportModal() {
    console.log('🔓 openSupportModal dipanggil!');
    const modal = document.getElementById('supportModal');
    if (!modal) {
        console.error('❌ Support modal tidak ditemukan!');
        return;
    }
    console.log('✅ Support modal ditemukan, mencoba menampilkan...');
    modal.style.display = 'flex';
    document.getElementById('paymentDetails').style.display = 'none';
    selectedMethod = null;
    document.querySelectorAll('.support-method').forEach(el => el.classList.remove('active'));
    console.log('✅ Modal support ditampilkan');
}

function closeSupportModal() {
    console.log('🔒 Menutup support modal');
    const modal = document.getElementById('supportModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

function selectMethod(method) {
    console.log(`📱 Memilih metode: ${method}`);
    selectedMethod = method;
    
    document.querySelectorAll('.support-method').forEach(el => {
        el.classList.remove('active');
        if (el.dataset.method === method) {
            el.classList.add('active');
        }
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
        setTimeout(() => {
            copyBtn.innerText = originalText;
        }, 2000);
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

// --- CONFIRM SUPPORT DENGAN MODAL SUKSES ---
function confirmSupport() {
    const amount = document.getElementById('supportAmount').value;
    if (!amount || amount < 1000) {
        alert('Masukkan nominal minimal Rp 1.000');
        return;
    }
    if (!selectedMethod) {
        alert('Pilih metode pembayaran terlebih dahulu!');
        return;
    }
    
    const methodName = selectedMethod.charAt(0).toUpperCase() + selectedMethod.slice(1);
    const number = paymentData[selectedMethod].number;
    const formattedAmount = `Rp ${parseInt(amount).toLocaleString()}`;
    
    // **TUTUP MODAL SUPPORT DULU**
    closeSupportModal();
    
    // **TAMPILKAN MODAL SUKSES SETELAH SUPPORT MODAL TERTUTUP**
    setTimeout(() => {
        showSuccessModal(methodName, formattedAmount, number);
    }, 300);
}

// --- SHOW SUCCESS MODAL ---
function showSuccessModal(method, amount, number) {
    console.log('📢 Menampilkan modal sukses...');
    const modal = document.getElementById('successModal');
    if (!modal) {
        console.error('❌ Success modal tidak ditemukan!');
        return;
    }
    document.getElementById('successMethod').innerText = method;
    document.getElementById('successAmount').innerText = amount;
    document.getElementById('successNumber').innerText = number;
    modal.style.display = 'flex';
    console.log('✅ Modal sukses ditampilkan');
}

// --- CLOSE SUCCESS MODAL ---
function closeSuccessModal() {
    console.log('🔒 Menutup success modal');
    const modal = document.getElementById('successModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// --- TUTUP MODAL SAAT KLIK DI LUAR ---
document.addEventListener('click', function(e) {
    const modal = document.getElementById('successModal');
    const content = document.querySelector('.success-modal-content');
    if (modal && modal.style.display === 'flex' && content && !content.contains(e.target)) {
        closeSuccessModal();
    }
});

// --- TAMBAHAN: Event listener langsung untuk tombol support ---
document.addEventListener('DOMContentLoaded', function() {
    const supportTrigger = document.getElementById('supportTrigger');
    if (supportTrigger) {
        supportTrigger.addEventListener('click', function(e) {
            e.stopPropagation();
            openSupportModal();
        });
    }
});

console.log('✅ MeiraWatch siap digunakan!');