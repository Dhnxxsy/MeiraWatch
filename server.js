const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
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
// GOOGLE DRIVE PROXY STREAM
// ============================================================

const https = require('https');

function extractDriveFileId(url) {
    if (!url) return null;
    const m1 = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m1) return m1[1];
    const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m2) return m2[1];
    return null;
}

function resolveGDriveUrl(fileId) {
    return new Promise((resolve, reject) => {
        const candidates = [
            `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`,
            `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`,
        ];
        let attempt = 0;

        function tryNext() {
            if (attempt >= candidates.length) {
                return resolve(`https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`);
            }
            followRedirect(candidates[attempt++], 0);
        }

        function followRedirect(url, depth) {
            if (depth > 10) return resolve(url);

            const parsed = new URL(url);
            const options = {
                hostname: parsed.hostname,
                path: parsed.pathname + parsed.search,
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': '*/*',
                    'Range': 'bytes=0-0',
                },
                timeout: 12000,
            };

            const req = https.request(options, (res) => {
                res.resume();

                if ((res.statusCode >= 301 && res.statusCode <= 308) && res.headers.location) {
                    let next = res.headers.location;
                    if (!next.startsWith('http')) next = `https://${parsed.hostname}${next}`;
                    if (next.includes('storage.googleapis.com') || next.includes('lh3.googleusercontent.com')) {
                        return resolve(next);
                    }
                    followRedirect(next, depth + 1);
                } else if (res.statusCode === 200 || res.statusCode === 206) {
                    const ct = res.headers['content-type'] || '';
                    if (ct.includes('text/html')) {
                        tryNext();
                    } else {
                        resolve(url);
                    }
                } else if (res.statusCode === 403 || res.statusCode === 404) {
                    tryNext();
                } else {
                    resolve(url);
                }
            });

            req.on('error', () => tryNext());
            req.on('timeout', () => {
                req.destroy();
                resolve(`https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`);
            });
            req.end();
        }

        tryNext();
    });
}

const driveUrlCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

app.get('/gdrive-stream', async (req, res) => {
    const fileId = req.query.id;
    if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
        return res.status(400).send('Invalid file ID');
    }

    try {
        let cdnUrl = null;
        const cached = driveUrlCache.get(fileId);
        if (cached && Date.now() - cached.resolvedAt < CACHE_TTL) {
            cdnUrl = cached.cdnUrl;
        } else {
            cdnUrl = await resolveGDriveUrl(fileId);
            driveUrlCache.set(fileId, { cdnUrl, resolvedAt: Date.now() });
        }

        const range = req.headers.range;
        const parsedCdn = new URL(cdnUrl);
        const proxyHeaders = {
            'User-Agent': 'Mozilla/5.0',
            'Accept': '*/*',
        };
        if (range) proxyHeaders['Range'] = range;

        const proxyOptions = {
            hostname: parsedCdn.hostname,
            path: parsedCdn.pathname + parsedCdn.search,
            method: 'GET',
            headers: proxyHeaders,
        };

        const proxyReq = https.request(proxyOptions, (proxyRes) => {
            if ((proxyRes.statusCode >= 301 && proxyRes.statusCode <= 308) && proxyRes.headers.location) {
                proxyRes.resume();
                driveUrlCache.delete(fileId);
                return res.redirect(302, `/gdrive-stream?id=${fileId}&_r=${Date.now()}`);
            }

            const statusCode = proxyRes.statusCode;
            const headers = {
                'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            };
            if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length'];
            if (proxyRes.headers['content-range']) headers['Content-Range'] = proxyRes.headers['content-range'];

            res.writeHead(statusCode === 206 ? 206 : 200, headers);
            proxyRes.pipe(res);
            proxyRes.on('error', () => res.end());
        });

        proxyReq.on('error', (err) => {
            console.error('Proxy error:', err.message);
            if (!res.headersSent) res.status(502).send('Proxy error');
        });

        req.on('close', () => proxyReq.destroy());
        proxyReq.end();

    } catch (err) {
        console.error('GDrive resolve error:', err.message);
        if (!res.headersSent) res.status(502).send('Gagal memuat video dari Google Drive: ' + err.message);
    }
});

app.post('/resolve-gdrive', express.json(), async (req, res) => {
    const { url } = req.body;
    const fileId = extractDriveFileId(url);
    if (!fileId) {
        return res.json({ streamUrl: url, isDrive: false });
    }
    res.json({ streamUrl: `/gdrive-stream?id=${fileId}`, fileId, isDrive: true });
});

// ============================================================
// STREAM FILE LOKAL
// ============================================================

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

    const baseHeaders = {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Connection': 'keep-alive',
        'Cache-Control': 'public, max-age=3600',
        'ETag': `"${stat.size}-${stat.mtimeMs}"`,
        'Last-Modified': stat.mtime.toUTCString(),
    };

    const ifNoneMatch = req.headers['if-none-match'];
    const etag = `"${stat.size}-${stat.mtimeMs}"`;
    if (ifNoneMatch === etag) {
        res.writeHead(304, baseHeaders);
        return res.end();
    }

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const requestedStart = parseInt(parts[0], 10);
        let requestedEnd = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        requestedEnd = Math.min(requestedEnd, fileSize - 1);

        const MIN_CHUNK_SIZE = 4 * 1024 * 1024;
        const naturalChunk = requestedEnd - requestedStart + 1;
        let end = requestedEnd;
        if (naturalChunk < MIN_CHUNK_SIZE) {
            end = Math.min(requestedStart + MIN_CHUNK_SIZE - 1, fileSize - 1);
        }

        const chunksize = end - requestedStart + 1;

        res.writeHead(206, {
            ...baseHeaders,
            'Content-Range': `bytes ${requestedStart}-${end}/${fileSize}`,
            'Content-Length': chunksize,
        });

        const stream = fs.createReadStream(filePath, {
            start: requestedStart,
            end,
            highWaterMark: 2 * 1024 * 1024,
        });

        stream.on('error', (err) => {
            console.error('Stream error:', err.message);
            if (!res.headersSent) res.status(500).end();
            else res.destroy();
        });

        stream.pipe(res);
    } else {
        res.writeHead(200, {
            ...baseHeaders,
            'Content-Length': fileSize,
        });

        const stream = fs.createReadStream(filePath, {
            highWaterMark: 2 * 1024 * 1024,
        });

        stream.on('error', (err) => {
            console.error('Stream error:', err.message);
            if (!res.headersSent) res.status(500).end();
            else res.destroy();
        });

        stream.pipe(res);
    }
}

// ============================================================
// UPLOAD
// ============================================================

app.post('/upload', upload.single('videoFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Tidak ada file yang diupload' });
    }
    const fileUrl = `/stream/${req.file.filename}`;
    res.json({ success: true, url: fileUrl, filename: req.file.filename });
});

// ============================================================
// ROOM STATE
// ============================================================

const rooms = {};

function getRoom(roomId) {
    if (!rooms[roomId]) {
        rooms[roomId] = {
            users: [],
            names: {},
            hostId: null,
            hostAssigned: false,
            state: {
                url: '',
                time: 0,
                isPlaying: false,
                lastUpdate: Date.now()
            },
            buffering: { isBuffering: false, user: null },
            messages: {},
            usernameLock: false,
        };
    }
    return rooms[roomId];
}

// ============================================================
// SOCKET.IO
// ============================================================

io.on('connection', (socket) => {

    // --- JOIN ROOM ---
    socket.on('join-room', (data) => {
        const roomId = data.roomId;
        const room = getRoom(roomId);

        // Anti-zombie: if this user (by name) already has a stale socket
        // registered in this room (e.g. from a connection that hasn't
        // timed out yet after a reconnect), clean it up first so we don't
        // end up with duplicate/ghost entries and a stuck old hostId.
        let wasHost = false;
        for (const [oldId, oldName] of Object.entries(room.names || {})) {
            if (oldName === data.name && oldId !== socket.id) {
                if (room.hostId === oldId) wasHost = true;

                room.users = room.users.filter(id => id !== oldId);
                delete room.names[oldId];

                const oldSocket = io.sockets.sockets.get(oldId);
                if (oldSocket) {
                    oldSocket.roomId = null;
                    oldSocket.disconnect(true);
                }
            }
        }

        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = data.name;
        socket.peerId = data.peerId;

        if (!room.users.includes(socket.id)) {
            room.users.push(socket.id);
        }
        room.names[socket.id] = data.name;

        let isHost = false;
        if (wasHost) {
            // Restore host status to the same user under their new socket id.
            room.hostId = socket.id;
            isHost = true;
            console.log(`👑 ${data.name} (Host) menyambung ulang di room ${roomId}`);
        } else if (!room.hostAssigned || room.hostId === null) {
            room.hostId = socket.id;
            room.hostAssigned = true;
            isHost = true;
            console.log(`👑 ${data.name} menjadi Host di room ${roomId}`);
        } else {
            isHost = (room.hostId === socket.id);
        }

        socket.emit('role-assigned', { isHost, hostId: room.hostId });

        io.to(roomId).emit('user-count', room.users.length);
        io.to(roomId).emit('user-list', Object.values(room.names));

        const hostName = room.names[room.hostId] || 'Host';
        io.to(roomId).emit('host-info', { hostId: room.hostId, hostName });

        if (data.rejoin) {
            io.to(roomId).emit('role-assigned-broadcast', { isHost, hostId: room.hostId });
        } else {
            socket.to(roomId).emit('system-message', `👋 ${data.name} telah bergabung ke dalam room.`);
        }

        if (room.state.url) {
            socket.emit('auto-sync-join', room.state);
        }

        socket.emit('username-lock-status', room.usernameLock || false);

        console.log(`${data.name} joined room ${roomId} (${isHost ? '👑 Host' : '👤 Viewer'}) - Total: ${room.users.length}`);
    });

    // --- CONNECTION HEALTH CHECK (anti-zombie) ---
    socket.on('ping-check', (clientTime) => {
        socket.emit('pong-check', clientTime);
    });

    // --- SYNC ---
    socket.on('host-heartbeat', (data) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);
        if (!room || room.hostId !== socket.id) return;

        const now = Date.now();
        room.state.time = data.time;
        room.state.isPlaying = data.isPlaying;
        room.state.lastUpdate = now;

        socket.to(roomId).emit('host-tick', {
            time: data.time,
            isPlaying: data.isPlaying,
            serverTime: now,
            hostSendTime: data.hostSendTime
        });
    });

    socket.on('request-sync', () => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);
        if (!room || !room.state.url) return;

        const now = Date.now();
        const elapsedSec = (now - room.state.lastUpdate) / 1000;
        const safeElapsed = Math.min(elapsedSec, 5.0);
        const estimatedTime = room.state.time + (room.state.isPlaying ? safeElapsed : 0);

        socket.emit('sync-state', {
            url: room.state.url,
            time: estimatedTime,
            isPlaying: room.state.isPlaying,
            serverTime: now
        });
    });

    // --- CONTROL ---
    socket.on('play', (data) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);
        if (room.hostId !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa memainkan video!');
            return;
        }

        const now = Date.now();
        room.state.time = data.time;
        room.state.isPlaying = true;
        room.state.lastUpdate = now;

        io.to(roomId).emit('play', { time: data.time, serverTime: now });
    });

    socket.on('pause', (data) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);
        if (room.hostId !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa menjeda video!');
            return;
        }

        const now = Date.now();
        room.state.time = data.time;
        room.state.isPlaying = false;
        room.state.lastUpdate = now;

        io.to(roomId).emit('pause', { time: data.time, serverTime: now });
    });

    socket.on('seek', (data) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);
        if (room.hostId !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa memindah video!');
            return;
        }

        const now = Date.now();
        room.state.time = data.time;
        room.state.lastUpdate = now;

        io.to(roomId).emit('seek', {
            time: data.time,
            isPlaying: room.state.isPlaying,
            serverTime: now
        });
    });

    socket.on('sync-request', (time) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);
        if (!room || room.hostId !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa melakukan sync!');
            return;
        }

        const now = Date.now();
        room.state.time = time;
        room.state.lastUpdate = now;

        socket.to(roomId).emit('sync-state', {
            url: room.state.url,
            time: time,
            isPlaying: room.state.isPlaying,
            serverTime: now,
            forced: true
        });
    });

    // --- VIDEO CHANGE ---
    socket.on('video-changed', (data) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);
        if (room.hostId !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa mengganti video!');
            return;
        }

        const rawUrl = typeof data === 'string' ? data : data.url;
        room.state.url = rawUrl;
        room.state.time = 0;
        room.state.isPlaying = true;
        room.state.lastUpdate = Date.now();

        socket.to(roomId).emit('video-changed', { url: rawUrl, serverTime: Date.now() });
        console.log(`🎬 Video changed in room ${roomId}: ${rawUrl}`);
    });

    // --- BUFFERING ---
    socket.on('buffering-start', (data) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);
        const username = socket.username || 'Seseorang';

        room.buffering.isBuffering = true;
        room.buffering.user = username;

        io.to(roomId).emit('buffering-notification', {
            user: username,
            isBuffering: true,
            time: data.time
        });
        console.log(`⏳ ${username} buffering di room ${roomId}`);
    });

    socket.on('buffering-end', (data) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);
        const username = socket.username || 'Seseorang';

        room.buffering.isBuffering = false;
        room.buffering.user = null;

        io.to(roomId).emit('buffering-end', {
            user: username,
            time: data.time,
            serverTime: Date.now()
        });
        console.log(`✅ ${username} selesai buffering di room ${roomId}`);
    });

    // --- CHAT ---
    socket.on('chat-message', (data) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);
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

        room.messages[messageId] = messageData;
        io.to(roomId).emit('chat-message', messageData);
    });

    socket.on('edit-message', (data) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);
        const { messageId, newText } = data;

        if (!room.messages[messageId]) {
            socket.emit('error-message', '❌ Pesan tidak ditemukan!');
            return;
        }

        const message = room.messages[messageId];
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
    });

    // --- USERNAME LOCK ---
    socket.on('toggle-username-lock', (data) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);

        if (room.hostId !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa mengunci nama pengguna!');
            return;
        }

        const newStatus = data.lock !== undefined ? data.lock : !room.usernameLock;
        room.usernameLock = newStatus;

        io.to(roomId).emit('username-lock-status', newStatus);
        io.to(roomId).emit('system-message', newStatus
            ? '🔒 Nama pengguna telah dikunci oleh Host.'
            : '🔓 Nama pengguna telah dibuka oleh Host.');
    });

    socket.on('get-username-lock-status', () => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);
        socket.emit('username-lock-status', room.usernameLock || false);
    });

    // --- KICK & TRANSFER ---
    socket.on('kick-user-by-name', (username) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);

        if (room.hostId !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa mengeluarkan peserta!');
            return;
        }

        let targetId = null;
        for (const [id, name] of Object.entries(room.names || {})) {
            if (name === username) {
                targetId = id;
                break;
            }
        }

        if (!targetId) {
            socket.emit('error-message', '❌ Peserta tidak ditemukan!');
            return;
        }

        if (targetId === socket.id) {
            socket.emit('error-message', '❌ Tidak bisa mengeluarkan diri sendiri!');
            return;
        }

        io.to(targetId).emit('kicked', {
            message: 'Anda dikeluarkan dari room oleh Host.',
            roomId
        });

        setTimeout(() => {
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) targetSocket.disconnect();
        }, 1000);

        io.to(roomId).emit('system-message', `🚫 ${username} telah dikeluarkan dari room oleh Host.`);
    });

    socket.on('transfer-host-by-name', (username) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);

        if (room.hostId !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa mentransfer status Host!');
            return;
        }

        let targetId = null;
        for (const [id, name] of Object.entries(room.names || {})) {
            if (name === username) {
                targetId = id;
                break;
            }
        }

        if (!targetId) {
            socket.emit('error-message', '❌ Peserta tidak ditemukan!');
            return;
        }

        if (targetId === socket.id) {
            socket.emit('error-message', '❌ Tidak bisa transfer ke diri sendiri!');
            return;
        }

        const oldHostId = room.hostId;
        room.hostId = targetId;

        io.to(roomId).emit('host-info', { hostId: targetId, hostName: username });
        io.to(roomId).emit('role-assigned', { isHost: false, hostId: targetId });
        io.to(targetId).emit('role-assigned', { isHost: true, hostId: targetId });
        io.to(roomId).emit('system-message', `👑 Host telah ditransfer dari ${room.names[oldHostId]} ke ${username}`);
    });

    // --- BROADCAST ---
    socket.on('broadcast-message', (message) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);

        if (room.hostId !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa mengirim broadcast!');
            return;
        }

        io.to(roomId).emit('broadcast-message', message);
    });

    // --- MISC ---
    socket.on('request-user-count', (roomId) => {
        const room = getRoom(roomId);
        socket.emit('user-count', room.users?.length || 0);
    });

    socket.on('request-peer-ids', () => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);
        if (room.hostId !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa Share Screen!');
            return;
        }
        socket.emit('receive-peer-ids', []);
    });

    socket.on('typing', (name) => socket.to(socket.roomId).emit('typing', name));
    socket.on('stop-typing', () => socket.to(socket.roomId).emit('stop-typing'));
    socket.on('reaction', (emoji) => socket.to(socket.roomId).emit('reaction', emoji));

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        if (!socket.roomId) {
            console.log('User terputus:', socket.id);
            return;
        }

        const roomId = socket.roomId;
        const room = getRoom(roomId);
        const username = socket.username || 'Seseorang';

        if (room.buffering.user === username) {
            room.buffering.isBuffering = false;
            room.buffering.user = null;
        }

        if (room.users) {
            room.users = room.users.filter(id => id !== socket.id);
            if (room.names) delete room.names[socket.id];
            io.to(roomId).emit('user-count', room.users.length);
            io.to(roomId).emit('user-list', Object.values(room.names || {}));
        }

        if (room.hostId === socket.id) {
            if (room.users?.length > 0) {
                const newHostId = room.users[0];
                room.hostId = newHostId;
                const newHostName = room.names?.[newHostId] || 'New Host';
                io.to(roomId).emit('host-info', { hostId: newHostId, hostName: newHostName });
                io.to(roomId).emit('role-assigned', { isHost: false, hostId: newHostId });
                io.to(newHostId).emit('role-assigned', { isHost: true, hostId: newHostId });
                io.to(roomId).emit('system-message', `👑 ${username} (Host) telah keluar. ${newHostName} menjadi Host baru.`);
            } else {
                delete rooms[roomId];
                console.log(`Room ${roomId} kosong, semua data dihapus.`);
            }
        } else {
            socket.to(roomId).emit('system-message', `👋 ${username} telah keluar dari room.`);
        }

        console.log('User terputus:', socket.id);
    });
});

const PORT = process.env.PORT || 3001;
const serverInstance = server.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));
serverInstance.timeout = 0;