const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    // Cloudflare WebSocket support
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, 'video-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

app.use(express.static('public'));

// ============================================================
// VIDEO TRANSCODE
// ============================================================

function transcodeVideo(inputPath, outputPath, height, videoBitrate, audioBitrate) {
    console.log(`Memulai kompresi ke ${height}p...`);
    ffmpeg(inputPath)
        .output(outputPath)
        .videoCodec('libx264')
        .videoFilters(`scale=-2:${height}`)
        .videoBitrate(videoBitrate)
        .audioCodec('aac')
        .audioBitrate(audioBitrate)
        .outputOptions(['-movflags faststart', '-preset ultrafast'])
        .on('end', () => console.log(`Kompresi ${height}p selesai!`))
        .on('error', (err) => console.error(`Gagal kompresi ${height}p:`, err.message))
        .run();
}

app.post('/upload', upload.single('videoFile'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false });

    const filename = req.file.filename;
    const ext = path.extname(filename);
    const baseName = path.basename(filename, ext);
    const inputPath = `./uploads/${filename}`;

    transcodeVideo(inputPath, `./uploads/${baseName}_360p${ext}`, 360, '400k', '64k');
    transcodeVideo(inputPath, `./uploads/${baseName}_144p${ext}`, 144, '100k', '32k');

    res.json({ success: true, url: `/stream/${filename}` });
});

app.get('/stream/:filename', (req, res) => {
    let filename = req.params.filename;
    const requestedRes = req.query.res;
    if (requestedRes === '360p' || requestedRes === '144p') {
        const ext = path.extname(filename);
        const baseName = path.basename(filename, ext);
        filename = `${baseName}_${requestedRes}${ext}`;
    }
    const filePath = `./uploads/${filename}`;
    if (!fs.existsSync(filePath)) {
        const originalPath = `./uploads/${req.params.filename}`;
        if (!fs.existsSync(originalPath)) return res.status(404).send('Video tidak ditemukan');
        return streamFile(originalPath, req, res);
    }
    streamFile(filePath, req, res);
});

function streamFile(filePath, req, res) {
    if (!fs.existsSync(filePath)) return res.status(404).send('Video tidak ditemukan!');

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(206, head);
        fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' });
        fs.createReadStream(filePath).pipe(res);
    }
}

// ============================================================
// ROOM STATE
// ============================================================

const roomPeers = {};
const roomStates = {};      // { url, time, isPlaying, lastUpdate }
const roomUsers = {};       // roomId → [socketId, ...]
const userNames = {};       // roomId → { socketId: name }
const roomHosts = {};       // roomId → socketId
const roomHostAssigned = {};
const roomBuffering = {};
const messageStore = {};
const roomUsernameLock = {};
const roomSeats = {};       // roomId → { seatId: { name, socketId } }

// ============================================================
// SOCKET.IO
// ============================================================

io.on('connection', (socket) => {

    // --- JOIN ROOM ---
    socket.on('join-room', (data) => {
        socket.join(data.roomId);
        socket.roomId = data.roomId;
        socket.username = data.name;
        socket.peerId = data.peerId;

        if (!roomUsers[data.roomId]) {
            roomUsers[data.roomId] = [];
            userNames[data.roomId] = {};
            roomHosts[data.roomId] = null;
            roomHostAssigned[data.roomId] = false;
            roomBuffering[data.roomId] = { isBuffering: false, bufferingUser: null };
            messageStore[data.roomId] = {};
            roomUsernameLock[data.roomId] = false;
            roomSeats[data.roomId] = {};
        }

        // Jika user membawa seats, simpan
        if (data.seats && data.seats.length > 0) {
            data.seats.forEach(seatId => {
                roomSeats[data.roomId][seatId] = {
                    name: data.name,
                    socketId: socket.id
                };
            });
        }

        roomUsers[data.roomId].push(socket.id);
        userNames[data.roomId][socket.id] = data.name;

        let isHost = false;
        if (!roomHostAssigned[data.roomId] || roomHosts[data.roomId] === null) {
            roomHosts[data.roomId] = socket.id;
            roomHostAssigned[data.roomId] = true;
            isHost = true;
            console.log(`👑 ${data.name} menjadi Host di room ${data.roomId}`);
        } else {
            isHost = (roomHosts[data.roomId] === socket.id);
        }

        socket.emit('role-assigned', { isHost, hostId: roomHosts[data.roomId] });

        io.to(data.roomId).emit('user-count', roomUsers[data.roomId].length);
        io.to(data.roomId).emit('user-list', Object.values(userNames[data.roomId]));

        const hostName = userNames[data.roomId][roomHosts[data.roomId]] || 'Host';
        io.to(data.roomId).emit('host-info', { hostId: roomHosts[data.roomId], hostName });

        socket.to(data.roomId).emit('system-message', `👋 ${data.name} telah bergabung ke dalam room.`);

        if (roomStates[data.roomId]) {
            socket.emit('auto-sync-join', roomStates[data.roomId]);
        }

        socket.emit('username-lock-status', roomUsernameLock[data.roomId] || false);

        console.log(`${data.name} joined room ${data.roomId} (${isHost ? '👑 Host' : '👤 Viewer'}) - Total: ${roomUsers[data.roomId].length}`);
    });

    // ============================================================
    // SYNC ENGINE HANDLERS (SIMPLIFIED)
    // ============================================================

    // Host mengirim posisi video secara berkala
    socket.on('host-heartbeat', (data) => {
        if (roomHosts[socket.roomId] !== socket.id) return;

        const roomId = socket.roomId;
        const now = Date.now();

        // Update state room
        if (!roomStates[roomId]) return;
        roomStates[roomId].time = data.time;
        roomStates[roomId].isPlaying = data.isPlaying;
        roomStates[roomId].lastUpdate = now;

        // Broadcast ke semua viewer (bukan host)
        socket.to(roomId).emit('sync-from-host', {
            time: data.time,
            isPlaying: data.isPlaying,
            clientTime: data.clientTime,  // diteruskan untuk hitung RTT di client
            serverTime: now
        });
    });

    // Client meminta sync state saat ini
    socket.on('client-sync-request', (clientTime) => {
        const roomId = socket.roomId;
        if (!roomStates[roomId]) return;

        const now = Date.now();
        const state = roomStates[roomId];
        const elapsed = (now - state.lastUpdate) / 1000;
        const estimatedTime = state.time + (state.isPlaying ? elapsed : 0);

        socket.emit('sync-response', {
            time: estimatedTime,
            isPlaying: state.isPlaying,
            clientTime: clientTime,
            serverTime: now
        });
    });

    // Request sync manual (dipakai saat join atau force sync)
    socket.on('request-sync', () => {
        const roomId = socket.roomId;
        if (!roomStates[roomId]) return;

        const now = Date.now();
        const state = roomStates[roomId];
        const elapsed = (now - state.lastUpdate) / 1000;
        const estimatedTime = state.time + (state.isPlaying ? elapsed : 0);

        socket.emit('sync-state', {
            url: state.url,
            time: estimatedTime,
            isPlaying: state.isPlaying,
            serverTime: now
        });
    });

    // ============================================================
    // CONTROL EVENTS (play/pause/seek dari host)
    // ============================================================

    socket.on('play', (data) => {
        if (roomHosts[socket.roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa memainkan video!');
            return;
        }
        const roomId = socket.roomId;
        const now = Date.now();
        if (roomStates[roomId]) {
            roomStates[roomId].time = data.time;
            roomStates[roomId].isPlaying = true;
            roomStates[roomId].lastUpdate = now;
        }
        // Broadcast ke semua (termasuk host untuk konfirmasi)
        io.to(roomId).emit('play', { time: data.time, clientTime: data.clientTime, serverTime: now });
    });

    socket.on('pause', (data) => {
        if (roomHosts[socket.roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa menjeda video!');
            return;
        }
        const roomId = socket.roomId;
        const now = Date.now();
        if (roomStates[roomId]) {
            roomStates[roomId].time = data.time;
            roomStates[roomId].isPlaying = false;
            roomStates[roomId].lastUpdate = now;
        }
        io.to(roomId).emit('pause', { time: data.time, clientTime: data.clientTime, serverTime: now });
    });

    socket.on('seek', (data) => {
        if (roomHosts[socket.roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa memindah video!');
            return;
        }
        const roomId = socket.roomId;
        const now = Date.now();
        if (roomStates[roomId]) {
            roomStates[roomId].time = data.time;
            roomStates[roomId].lastUpdate = now;
        }
        io.to(roomId).emit('seek', { time: data.time, clientTime: data.clientTime, serverTime: now });
    });

    socket.on('sync-request', (time) => {
        if (roomHosts[socket.roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa melakukan sync!');
            return;
        }
        const roomId = socket.roomId;
        const now = Date.now();
        if (roomStates[roomId]) {
            roomStates[roomId].time = time;
            roomStates[roomId].lastUpdate = now;
        }
        socket.to(roomId).emit('sync-state', {
            url: roomStates[roomId]?.url,
            time,
            isPlaying: roomStates[roomId]?.isPlaying,
            serverTime: now
        });
    });

    // ============================================================
    // VIDEO CHANGE
    // ============================================================

    socket.on('video-changed', (data) => {
        if (roomHosts[socket.roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa mengganti video!');
            return;
        }
        const roomId = socket.roomId;
        roomStates[roomId] = {
            url: data.url,
            time: 0,
            isPlaying: true,
            lastUpdate: Date.now()
        };
        io.to(roomId).emit('video-changed', { url: data.url, serverTime: Date.now() });
    });

    // ============================================================
    // BUFFERING
    // ============================================================

    socket.on('buffering-start', (data) => {
        const roomId = socket.roomId;
        const username = socket.username || 'Seseorang';
        roomBuffering[roomId] = { isBuffering: true, bufferingUser: username };
        io.to(roomId).emit('buffering-notification', { user: username, isBuffering: true, time: data.time });
        console.log(`⏳ ${username} buffering di room ${roomId}`);
    });

    socket.on('buffering-end', (data) => {
        const roomId = socket.roomId;
        const username = socket.username || 'Seseorang';
        roomBuffering[roomId] = { isBuffering: false, bufferingUser: null };
        io.to(roomId).emit('buffering-end', { user: username, time: data.time, serverTime: Date.now() });
        console.log(`✅ ${username} selesai buffering di room ${roomId}`);
    });

    // ============================================================
    // CHAT
    // ============================================================

    socket.on('chat-message', (data) => {
        const roomId = socket.roomId;
        const messageId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        const messageData = {
            id: messageId, name: data.name, msg: data.msg,
            replyTo: data.replyTo || null, timestamp: Date.now(),
            edited: false, editedAt: null, editCount: 0
        };
        if (!messageStore[roomId]) messageStore[roomId] = {};
        messageStore[roomId][messageId] = messageData;
        io.to(roomId).emit('chat-message', messageData);
    });

    socket.on('edit-message', (data) => {
        const roomId = socket.roomId;
        const { messageId, newText } = data;
        if (!messageStore[roomId]?.[messageId]) {
            socket.emit('error-message', '❌ Pesan tidak ditemukan!'); return;
        }
        const message = messageStore[roomId][messageId];
        if (message.name !== socket.username) {
            socket.emit('error-message', '❌ Anda hanya bisa mengedit pesan Anda sendiri!'); return;
        }
        message.msg = newText;
        message.edited = true;
        message.editedAt = Date.now();
        message.editCount += 1;
        io.to(roomId).emit('message-edited', {
            id: messageId, msg: newText, edited: true,
            editedAt: message.editedAt, editCount: message.editCount
        });
    });

    // ============================================================
    // USERNAME LOCK
    // ============================================================

    socket.on('toggle-username-lock', (data) => {
        const roomId = socket.roomId;
        if (roomHosts[roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa mengunci nama pengguna!'); return;
        }
        const newStatus = data.lock !== undefined ? data.lock : !roomUsernameLock[roomId];
        roomUsernameLock[roomId] = newStatus;
        io.to(roomId).emit('username-lock-status', newStatus);
        io.to(roomId).emit('system-message', newStatus
            ? '🔒 Nama pengguna telah dikunci oleh Host.'
            : '🔓 Nama pengguna telah dibuka oleh Host.');
    });

    socket.on('get-username-lock-status', () => {
        socket.emit('username-lock-status', roomUsernameLock[socket.roomId] || false);
    });

    // ============================================================
    // KICK & TRANSFER HOST
    // ============================================================

    socket.on('kick-user-by-name', (username) => {
        const roomId = socket.roomId;
        if (roomHosts[roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa mengeluarkan peserta!'); return;
        }
        let targetId = null;
        for (const [id, name] of Object.entries(userNames[roomId] || {})) {
            if (name === username) { targetId = id; break; }
        }
        if (!targetId) { socket.emit('error-message', '❌ Peserta tidak ditemukan!'); return; }
        if (targetId === socket.id) { socket.emit('error-message', '❌ Tidak bisa mengeluarkan diri sendiri!'); return; }
        io.to(targetId).emit('kicked', { message: 'Anda dikeluarkan dari room oleh Host.', roomId });
        setTimeout(() => {
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) targetSocket.disconnect();
        }, 1000);
        io.to(roomId).emit('system-message', `🚫 ${username} telah dikeluarkan dari room oleh Host.`);
    });

    socket.on('kick-user', (targetSocketId) => {
        if (roomHosts[socket.roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa mengeluarkan user!'); return;
        }
        if (targetSocketId === socket.id) {
            socket.emit('error-message', '❌ Tidak bisa mengeluarkan diri sendiri!'); return;
        }
        const targetUser = userNames[socket.roomId]?.[targetSocketId];
        if (!targetUser) { socket.emit('error-message', '❌ User tidak ditemukan di room!'); return; }
        io.to(targetSocketId).emit('kicked', { message: 'Anda dikeluarkan dari room oleh Host.', roomId: socket.roomId });
        setTimeout(() => {
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (targetSocket) targetSocket.disconnect();
        }, 1000);
        io.to(socket.roomId).emit('system-message', `🚫 ${targetUser} telah dikeluarkan dari room oleh Host.`);
    });

    socket.on('transfer-host-by-name', (username) => {
        const roomId = socket.roomId;
        if (roomHosts[roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa mentransfer status Host!'); return;
        }
        let targetId = null;
        for (const [id, name] of Object.entries(userNames[roomId] || {})) {
            if (name === username) { targetId = id; break; }
        }
        if (!targetId) { socket.emit('error-message', '❌ Peserta tidak ditemukan!'); return; }
        if (targetId === socket.id) { socket.emit('error-message', '❌ Tidak bisa transfer ke diri sendiri!'); return; }
        const oldHostId = roomHosts[roomId];
        roomHosts[roomId] = targetId;
        io.to(roomId).emit('host-info', { hostId: targetId, hostName: username });
        io.to(roomId).emit('role-assigned', { isHost: false, hostId: targetId });
        io.to(targetId).emit('role-assigned', { isHost: true, hostId: targetId });
        io.to(roomId).emit('system-message', `👑 Host telah ditransfer dari ${userNames[roomId][oldHostId]} ke ${username}`);
    });

    socket.on('transfer-host', (targetSocketId) => {
        const roomId = socket.roomId;
        if (roomHosts[roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa mentransfer status Host!'); return;
        }
        if (targetSocketId === socket.id) {
            socket.emit('error-message', '❌ Tidak bisa transfer ke diri sendiri!'); return;
        }
        if (!userNames[roomId]?.[targetSocketId]) {
            socket.emit('error-message', '❌ User target tidak ditemukan di room!'); return;
        }
        const oldHostId = roomHosts[roomId];
        roomHosts[roomId] = targetSocketId;
        const newHostName = userNames[roomId][targetSocketId];
        io.to(roomId).emit('host-info', { hostId: targetSocketId, hostName: newHostName });
        io.to(roomId).emit('role-assigned', { isHost: false, hostId: targetSocketId });
        io.to(targetSocketId).emit('role-assigned', { isHost: true, hostId: targetSocketId });
        io.to(roomId).emit('system-message', `👑 Host telah ditransfer dari ${userNames[roomId][oldHostId]} ke ${newHostName}`);
    });

    // ============================================================
    // MISC
    // ============================================================

    socket.on('broadcast-message', (message) => {
        const roomId = socket.roomId;
        if (roomHosts[roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa mengirim broadcast!'); return;
        }
        io.to(roomId).emit('broadcast-message', message);
    });

    socket.on('request-user-count', (roomId) => {
        socket.emit('user-count', roomUsers[roomId]?.length || 0);
    });

    socket.on('request-peer-ids', () => {
        if (roomHosts[socket.roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa Share Screen!'); return;
        }
        socket.emit('receive-peer-ids', roomPeers[socket.roomId] || []);
    });

    socket.on('typing', (name) => socket.to(socket.roomId).emit('typing', name));
    socket.on('stop-typing', () => socket.to(socket.roomId).emit('stop-typing'));
    socket.on('reaction', (emoji) => socket.to(socket.roomId).emit('reaction', emoji));

    // --- SEAT MANAGEMENT ---
    socket.on('get-taken-seats', (roomId) => {
        const taken = roomSeats[roomId] || {};
        const seatList = Object.keys(taken);
        socket.emit('taken-seats', seatList.reduce((acc, seat) => {
            acc[seat] = true;
            return acc;
        }, {}));
    });

    socket.on('reserve-seats', (data) => {
        const { roomId, seats, name } = data;
        if (!roomSeats[roomId]) roomSeats[roomId] = {};

        // Check if seats are available
        const taken = [];
        seats.forEach(seatId => {
            if (roomSeats[roomId][seatId]) {
                taken.push(seatId);
            }
        });

        if (taken.length > 0) {
            socket.emit('error-message', `Kursi ${taken.join(', ')} sudah terisi!`);
            return;
        }

        // Reserve seats
        seats.forEach(seatId => {
            roomSeats[roomId][seatId] = {
                name: name,
                socketId: socket.id
            };
        });

        // Broadcast updated seat data
        io.to(roomId).emit('seats-updated', roomSeats[roomId]);
    });

    // ============================================================
    // DISCONNECT
    // ============================================================

    socket.on('disconnect', () => {
        if (!socket.roomId) { console.log('User terputus:', socket.id); return; }

        const roomId = socket.roomId;
        const username = socket.username || 'Seseorang';

        // Clear buffering jika user ini yang buffering
        if (roomBuffering[roomId]?.bufferingUser === username) {
            roomBuffering[roomId] = { isBuffering: false, bufferingUser: null };
        }

        // Remove dari users
        if (roomUsers[roomId]) {
            roomUsers[roomId] = roomUsers[roomId].filter(id => id !== socket.id);
            if (userNames[roomId]) delete userNames[roomId][socket.id];
            io.to(roomId).emit('user-count', roomUsers[roomId].length);
            io.to(roomId).emit('user-list', Object.values(userNames[roomId] || {}));
        }

        // Free up seats
        if (roomSeats[roomId]) {
            Object.keys(roomSeats[roomId]).forEach(seatId => {
                if (roomSeats[roomId][seatId].socketId === socket.id) {
                    delete roomSeats[roomId][seatId];
                }
            });
            io.to(roomId).emit('seats-updated', roomSeats[roomId]);
        }

        // Handle host disconnect
        if (roomHosts[roomId] === socket.id) {
            if (roomUsers[roomId]?.length > 0) {
                const newHostId = roomUsers[roomId][0];
                roomHosts[roomId] = newHostId;
                const newHostName = userNames[roomId]?.[newHostId] || 'New Host';
                io.to(roomId).emit('host-info', { hostId: newHostId, hostName: newHostName });
                io.to(roomId).emit('role-assigned', { isHost: false, hostId: newHostId });
                io.to(newHostId).emit('role-assigned', { isHost: true, hostId: newHostId });
                io.to(roomId).emit('system-message', `👑 ${username} (Host) telah keluar. ${newHostName} menjadi Host baru.`);
            } else {
                // Room kosong, bersihkan semua
                delete roomHosts[roomId];
                delete roomHostAssigned[roomId];
                delete roomStates[roomId];
                delete roomUsers[roomId];
                delete userNames[roomId];
                delete roomPeers[roomId];
                delete roomBuffering[roomId];
                delete messageStore[roomId];
                delete roomUsernameLock[roomId];
                delete roomSeats[roomId];
                console.log(`Room ${roomId} kosong, semua data dihapus.`);
            }
        } else {
            socket.to(roomId).emit('system-message', `👋 ${username} telah keluar dari room.`);
        }

        if (roomPeers[roomId]) {
            roomPeers[roomId] = roomPeers[roomId].filter(id => id !== socket.peerId);
        }

        console.log('User terputus:', socket.id);
    });
});

const PORT = process.env.PORT || 3001;
const serverInstance = server.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));
serverInstance.timeout = 0;