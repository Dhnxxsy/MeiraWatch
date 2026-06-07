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
const io = new Server(server);

const videoCache = {};

const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, 'video-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.use(express.static('public'));

function transcodeVideo(inputPath, outputPath, height, videoBitrate, audioBitrate) {
    console.log(`Memulai kompresi ke ${height}p...`);
    ffmpeg(inputPath)
        .output(outputPath)
        .videoCodec('libx264')
        .videoFilters(`scale=-2:${height}`)
        .videoBitrate(videoBitrate)
        .audioCodec('aac')
        .audioBitrate(audioBitrate)
        .outputOptions([
            '-movflags faststart',
            '-preset ultrafast'
        ])
        .on('end', () => console.log(`Kompresi ${height}p selesai!`))
        .on('error', (err) => console.error(`Gagal kompresi ${height}p:`, err.message))
        .run();
}

async function getTranscodedVideo(videoPath, resolution) {
    const cacheKey = `${videoPath}-${resolution}`;
    if (videoCache[cacheKey]) return videoCache[cacheKey];
    const outputPath = `./uploads/temp-${resolution}.mp4`;
    await transcodeVideo(videoPath, outputPath, resolution);
    videoCache[cacheKey] = outputPath;
    return outputPath;
}

app.post('/upload', upload.single('videoFile'), (req, res) => {
    if (req.file) {
        const filename = req.file.filename;
        const ext = path.extname(filename);
        const baseName = path.basename(filename, ext);
        const inputPath = `./uploads/${filename}`;
        const out360 = `./uploads/${baseName}_360p${ext}`;
        const out144 = `./uploads/${baseName}_144p${ext}`;

        transcodeVideo(inputPath, out360, 360, '400k', '64k');
        transcodeVideo(inputPath, out144, 144, '100k', '32k');

        const videoUrl = `/stream/${filename}`;
        res.json({ success: true, url: videoUrl });
    } else {
        res.status(400).json({ success: false });
    }
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
    if (!fs.existsSync(filePath)) {
        res.status(404).send("Video tidak ditemukan!");
        return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });

        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        const head = {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
    }
}

const roomPeers = {};
const roomStates = {};
const roomUsers = {};
const userNames = {};
const roomHosts = {};
const roomHostAssigned = {};
const roomBuffering = {};
const messageStore = {};

io.on('connection', (socket) => {
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
            roomBuffering[data.roomId] = {
                isBuffering: false,
                bufferingUser: null,
                bufferingStart: null,
                bufferingTime: null
            };
            messageStore[data.roomId] = {};
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

        socket.emit('role-assigned', { isHost: isHost, hostId: roomHosts[data.roomId] });

        console.log(`${data.name} joined room ${data.roomId} (${isHost ? '👑 Host' : '👤 Viewer'}) - Total: ${roomUsers[data.roomId].length}`);

        io.to(data.roomId).emit('user-count', roomUsers[data.roomId].length);

        const userList = Object.values(userNames[data.roomId]);
        io.to(data.roomId).emit('user-list', userList);

        const hostName = userNames[data.roomId][roomHosts[data.roomId]] || 'Host';
        io.to(data.roomId).emit('host-info', { hostId: roomHosts[data.roomId], hostName: hostName });

        socket.to(data.roomId).emit('system-message', `👋 ${data.name} telah bergabung ke dalam room.`);

        if (roomStates[data.roomId]) {
            socket.emit('auto-sync-join', roomStates[data.roomId]);
        }
    });

    socket.on('request-user-count', (roomId) => {
        const count = roomUsers[roomId] ? roomUsers[roomId].length : 0;
        socket.emit('user-count', count);
    });

    socket.on('request-sync', () => {
        const roomId = socket.roomId;
        if (roomStates[roomId]) {
            socket.emit('sync-state', {
                url: roomStates[roomId].url,
                time: roomStates[roomId].time,
                isPlaying: roomStates[roomId].isPlaying,
                serverTime: Date.now(),
                buffering: roomBuffering[roomId]?.isBuffering || false,
                bufferingUser: roomBuffering[roomId]?.bufferingUser || null
            });
        }
    });

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
            lastUpdate: Date.now(),
            lastSync: Date.now(),
            buffering: false
        };
        roomBuffering[roomId] = {
            isBuffering: false,
            bufferingUser: null,
            bufferingStart: null,
            bufferingTime: null
        };

        io.to(roomId).emit('video-changed', { url: data.url, serverTime: Date.now() });
    });

    socket.on('play', (data) => {
        if (roomHosts[socket.roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa memainkan video!');
            return;
        }

        const roomId = socket.roomId;
        if (roomStates[roomId]) {
            roomStates[roomId].time = data.time;
            roomStates[roomId].isPlaying = true;
            roomStates[roomId].lastUpdate = Date.now();
            roomStates[roomId].lastSync = Date.now();
        }

        socket.to(roomId).emit('play', { time: data.time, serverTime: Date.now() });
    });

    socket.on('pause', (data) => {
        if (roomHosts[socket.roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa menjeda video!');
            return;
        }

        const roomId = socket.roomId;
        if (roomStates[roomId]) {
            roomStates[roomId].time = data.time;
            roomStates[roomId].isPlaying = false;
            roomStates[roomId].lastUpdate = Date.now();
            roomStates[roomId].lastSync = Date.now();
        }

        socket.to(roomId).emit('pause', { time: data.time, serverTime: Date.now() });
    });

    socket.on('seek', (data) => {
        if (roomHosts[socket.roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa memindah video!');
            return;
        }

        const roomId = socket.roomId;
        if (roomStates[roomId]) {
            roomStates[roomId].time = data.time;
            roomStates[roomId].lastUpdate = Date.now();
            roomStates[roomId].lastSync = Date.now();
        }

        socket.to(roomId).emit('seek', { time: data.time, serverTime: Date.now() });
    });

    socket.on('heartbeat', (data) => {
        if (roomHosts[socket.roomId] !== socket.id) return;

        const roomId = socket.roomId;
        if (roomStates[roomId]) {
            roomStates[roomId].time = data.time;
            roomStates[roomId].isPlaying = data.isPlaying;
            roomStates[roomId].lastUpdate = Date.now();
            roomStates[roomId].lastSync = Date.now();
            roomStates[roomId].buffering = data.buffering || false;
        }
    });

    socket.on('sync-request', (time) => {
        if (roomHosts[socket.roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa melakukan sync!');
            return;
        }

        const roomId = socket.roomId;
        if (roomStates[roomId]) {
            roomStates[roomId].time = time;
            roomStates[roomId].lastUpdate = Date.now();
            roomStates[roomId].lastSync = Date.now();
        }
        socket.to(roomId).emit('sync-request', Date.now());
    });

    socket.on('buffering-start', (data) => {
        const roomId = socket.roomId;
        const username = socket.username || 'Seseorang';

        roomBuffering[roomId].isBuffering = true;
        roomBuffering[roomId].bufferingUser = username;
        roomBuffering[roomId].bufferingStart = Date.now();
        roomBuffering[roomId].bufferingTime = data.time;

        io.to(roomId).emit('buffering-notification', {
            user: username,
            isBuffering: true,
            time: data.time
        });

        console.log(`⏳ ${username} buffering di room ${roomId} pada posisi ${data.time}`);
    });

    socket.on('buffering-end', (data) => {
        const roomId = socket.roomId;
        const username = socket.username || 'Seseorang';

        roomBuffering[roomId].isBuffering = false;
        roomBuffering[roomId].bufferingUser = null;
        roomBuffering[roomId].bufferingStart = null;
        roomBuffering[roomId].bufferingTime = null;

        io.to(roomId).emit('buffering-end', {
            user: username,
            time: data.time,
            serverTime: Date.now()
        });

        console.log(`✅ ${username} selesai buffering di room ${roomId} pada posisi ${data.time}`);
    });

    // --- CHAT MESSAGE ---
    socket.on('chat-message', (data) => {
        const roomId = socket.roomId;
        const messageId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        
        const messageData = {
            id: messageId,
            name: data.name,
            msg: data.msg,
            replyTo: data.replyTo || null,
            timestamp: Date.now(),
            edited: false,
            editedAt: null,
            editCount: 0
        };
        
        if (!messageStore[roomId]) {
            messageStore[roomId] = {};
        }
        messageStore[roomId][messageId] = messageData;
        
        io.to(roomId).emit('chat-message', messageData);
    });

    // --- EDIT MESSAGE ---
    socket.on('edit-message', (data) => {
        const roomId = socket.roomId;
        const { messageId, newText } = data;
        
        if (!messageStore[roomId] || !messageStore[roomId][messageId]) {
            socket.emit('error-message', '❌ Pesan tidak ditemukan!');
            return;
        }
        
        const message = messageStore[roomId][messageId];
        if (message.name !== socket.username) {
            socket.emit('error-message', '❌ Anda hanya bisa mengedit pesan Anda sendiri!');
            return;
        }
        
        message.msg = newText;
        message.edited = true;
        message.editedAt = Date.now();
        message.editCount += 1;
        
        io.to(roomId).emit('message-edited', {
            id: messageId,
            msg: newText,
            edited: true,
            editedAt: message.editedAt,
            editCount: message.editCount
        });
        
        console.log(`✏️ ${socket.username} mengedit pesan di room ${roomId}`);
    });

    socket.on('request-peer-ids', () => {
        if (roomHosts[socket.roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa Share Screen!');
            return;
        }
        socket.emit('receive-peer-ids', roomPeers[socket.roomId] || []);
    });

    socket.on('kick-user', (targetSocketId) => {
        if (roomHosts[socket.roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa mengeluarkan user!');
            return;
        }
        if (targetSocketId === socket.id) {
            socket.emit('error-message', '❌ Tidak bisa mengeluarkan diri sendiri!');
            return;
        }
        const targetUser = userNames[socket.roomId]?.[targetSocketId];
        if (!targetUser) {
            socket.emit('error-message', '❌ User tidak ditemukan di room!');
            return;
        }
        io.to(targetSocketId).emit('kicked', { message: `Anda dikeluarkan dari room oleh Host.`, roomId: socket.roomId });
        setTimeout(() => {
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (targetSocket) {
                targetSocket.disconnect();
            }
        }, 1000);
        io.to(socket.roomId).emit('system-message', `🚫 ${targetUser} telah dikeluarkan dari room oleh Host.`);
    });

    socket.on('transfer-host', (targetSocketId) => {
        if (roomHosts[socket.roomId] !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa mentransfer status Host!');
            return;
        }
        if (targetSocketId === socket.id) {
            socket.emit('error-message', '❌ Tidak bisa transfer ke diri sendiri!');
            return;
        }
        if (!userNames[socket.roomId]?.[targetSocketId]) {
            socket.emit('error-message', '❌ User target tidak ditemukan di room!');
            return;
        }
        const oldHostId = roomHosts[socket.roomId];
        roomHosts[socket.roomId] = targetSocketId;
        const newHostName = userNames[socket.roomId][targetSocketId];
        io.to(socket.roomId).emit('host-info', { hostId: targetSocketId, hostName: newHostName });
        io.to(socket.roomId).emit('role-assigned', { isHost: false, hostId: targetSocketId });
        io.to(targetSocketId).emit('role-assigned', { isHost: true, hostId: targetSocketId });
        io.to(socket.roomId).emit('system-message', `👑 Host telah ditransfer dari ${userNames[socket.roomId][oldHostId]} ke ${newHostName}`);
    });

    socket.on('typing', (name) => {
        socket.to(socket.roomId).emit('typing', name);
    });

    socket.on('stop-typing', () => {
        socket.to(socket.roomId).emit('stop-typing');
    });

    socket.on('reaction', (emoji) => {
        socket.to(socket.roomId).emit('reaction', emoji);
    });

    socket.on('sync-time', (data) => {
        socket.to(socket.roomId).emit('sync-time', data.time);
    });

    socket.on('change-quality', (data) => {
        socket.to(socket.roomId).emit('change-quality', data.url);
    });

    socket.on('disconnect', () => {
        if (socket.roomId) {
            const roomId = socket.roomId;
            const username = socket.username || 'Seseorang';

            if (roomBuffering[roomId] && roomBuffering[roomId].bufferingUser === username) {
                roomBuffering[roomId].isBuffering = false;
                roomBuffering[roomId].bufferingUser = null;
                roomBuffering[roomId].bufferingStart = null;
                roomBuffering[roomId].bufferingTime = null;
            }

            if (roomUsers[roomId]) {
                roomUsers[roomId] = roomUsers[roomId].filter(id => id !== socket.id);
                if (userNames[roomId]) {
                    delete userNames[roomId][socket.id];
                }
                io.to(roomId).emit('user-count', roomUsers[roomId].length);
                const userList = Object.values(userNames[roomId] || {});
                io.to(roomId).emit('user-list', userList);
            }

            if (roomHosts[roomId] === socket.id) {
                if (roomUsers[roomId] && roomUsers[roomId].length > 0) {
                    const newHostId = roomUsers[roomId][0];
                    roomHosts[roomId] = newHostId;
                    const newHostName = userNames[roomId][newHostId] || 'New Host';
                    io.to(roomId).emit('host-info', { hostId: newHostId, hostName: newHostName });
                    io.to(roomId).emit('role-assigned', { isHost: false, hostId: newHostId });
                    io.to(newHostId).emit('role-assigned', { isHost: true, hostId: newHostId });
                    io.to(roomId).emit('system-message', `👑 ${username} (Host) telah keluar. ${newHostName} menjadi Host baru.`);
                } else {
                    delete roomHosts[roomId];
                    delete roomHostAssigned[roomId];
                    delete roomStates[roomId];
                    delete roomUsers[roomId];
                    delete userNames[roomId];
                    delete roomPeers[roomId];
                    delete roomBuffering[roomId];
                    delete messageStore[roomId];
                    console.log(`Room ${roomId} menjadi kosong, semua data dihapus.`);
                }
            } else {
                socket.to(roomId).emit('system-message', `👋 ${username} telah keluar dari room.`);
            }

            if (roomPeers[roomId]) {
                roomPeers[roomId] = roomPeers[roomId].filter(id => id !== socket.peerId);
            }
        }
        console.log('User terputus:', socket.id);
    });
});

const PORT = process.env.PORT || 3001;
const serverInstance = server.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));
serverInstance.timeout = 0;