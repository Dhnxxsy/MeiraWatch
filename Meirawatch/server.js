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
// VIDEO TRANSCODE
// ============================================================

// ============================================================
// VIDEO TRANSCODE - OPTIMIZED FOR STREAMING
// ============================================================

// ============================================================
// VIDEO STREAMING - OPTIMIZED FOR CLOUDFLARE TUNNEL
// Masalah utama tunnel: overhead per-request tinggi, latency naik-turun.
// Solusi: chunk besar (4MB), aggressive caching, keep-alive, highWaterMark besar.
// ============================================================

// Ukuran chunk minimum yang dikirim per range request.
// Browser biasanya minta chunk kecil (misalnya 512KB), kita paksakan minimal 4MB
// agar jumlah round-trip lewat tunnel berkurang drastis.
const MIN_CHUNK_SIZE = 4 * 1024 * 1024;  // 4MB minimum per request
const READ_STREAM_HWM = 2 * 1024 * 1024; // 2MB highWaterMark untuk Node stream

// ============================================================
// GOOGLE DRIVE PROXY STREAM
//
// Masalah drive.google.com/uc?export=download sebagai video.src:
//   - Google Drive return HTML redirect, bukan byte stream
//   - CORS diblokir browser untuk cross-origin video
//   - Browser tidak bisa stream langsung dari URL tersebut
//
// Solusi: server jadi transparent proxy.
//   Client → /gdrive-stream?id=FILE_ID → Server → Google Drive CDN → Client
//   Server fetch ke Google (server-to-server, no CORS), pipe bytes ke client.
//   Client cukup set video.src = '/gdrive-stream?id=...'
// ============================================================

const https = require('https');

// Ekstrak Google Drive file ID dari berbagai format URL share
function extractDriveFileId(url) {
    if (!url) return null;
    // https://drive.google.com/file/d/FILE_ID/view
    const m1 = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m1) return m1[1];
    // https://drive.google.com/open?id=FILE_ID
    const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m2) return m2[1];
    return null;
}

// Resolve redirect chain dari Google Drive sampai dapat CDN URL yang sebenarnya
// Google Drive /uc?export=download akan redirect beberapa kali sebelum sampai ke
// storage.googleapis.com atau lh3.googleusercontent.com — URL itulah yang bisa dipakai
function resolveGDriveUrl(fileId) {
    return new Promise((resolve, reject) => {
        let startUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;

        function followRedirect(url, depth) {
            if (depth > 8) return reject(new Error('Too many redirects'));

            const parsed = new URL(url);
            const options = {
                hostname: parsed.hostname,
                path: parsed.pathname + parsed.search,
                method: 'HEAD',
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': '*/*',
                },
                timeout: 10000,
            };

            const req = https.request(options, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const next = res.headers.location.startsWith('http')
                        ? res.headers.location
                        : `https://${parsed.hostname}${res.headers.location}`;
                    followRedirect(next, depth + 1);
                } else if (res.statusCode === 200) {
                    const ct = res.headers['content-type'] || '';
                    if (ct.includes('video') || ct.includes('octet-stream') || ct.includes('mp4')) {
                        resolve(url);
                    } else {
                        // Google mungkin return download confirm page — coba dengan cookies confirm
                        if (depth === 0) {
                            followRedirect(`https://drive.google.com/uc?export=download&id=${fileId}&confirm=t&authuser=0`, 1);
                        } else {
                            resolve(url); // biarkan proxy yang handle
                        }
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode} dari ${url}`));
                }
            });

            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout resolving Drive URL')); });
            req.end();
        }

        followRedirect(startUrl, 0);
    });
}

// Cache resolved CDN URLs agar tidak resolve ulang setiap request
const driveUrlCache = new Map(); // fileId → { cdnUrl, resolvedAt }
const CACHE_TTL = 30 * 60 * 1000; // 30 menit

// Endpoint utama: GET /gdrive-stream?id=FILE_ID
// Ini yang dipakai sebagai video.src oleh semua client
app.get('/gdrive-stream', async (req, res) => {
    const fileId = req.query.id;
    if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
        return res.status(400).send('Invalid file ID');
    }

    try {
        // Cek cache dulu
        let cdnUrl = null;
        const cached = driveUrlCache.get(fileId);
        if (cached && Date.now() - cached.resolvedAt < CACHE_TTL) {
            cdnUrl = cached.cdnUrl;
        } else {
            cdnUrl = await resolveGDriveUrl(fileId);
            driveUrlCache.set(fileId, { cdnUrl, resolvedAt: Date.now() });
        }

        // Proxy request ke CDN Google dengan range request support
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
            const statusCode = proxyRes.statusCode;
            const headers = {
                'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-store',
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

// Endpoint resolve: POST /resolve-gdrive { url }
// Server resolve URL Drive → kembalikan stream URL ke client
// Sehingga client bisa langsung set video.src tanpa tahu soal proxy
app.post('/resolve-gdrive', express.json(), async (req, res) => {
    const { url } = req.body;
    const fileId = extractDriveFileId(url);
    if (!fileId) {
        // Bukan Google Drive URL — kembalikan URL asli, mungkin direct MP4
        return res.json({ streamUrl: url, isDrive: false });
    }
    // Kembalikan proxy URL — client stream lewat proxy ini
    res.json({ streamUrl: `/gdrive-stream?id=${fileId}`, fileId, isDrive: true });
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

    // Header umum yang selalu dikirim
    const baseHeaders = {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Connection': 'keep-alive',
        // Cache 1 jam di browser — video tidak berubah setelah diupload
        'Cache-Control': 'public, max-age=3600',
        // ETag berbasis ukuran+waktu modif untuk validasi cache
        'ETag': `"${stat.size}-${stat.mtimeMs}"`,
        'Last-Modified': stat.mtime.toUTCString(),
    };

    // Handle conditional request (If-None-Match / If-Modified-Since)
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

        // Clamp end ke fileSize
        requestedEnd = Math.min(requestedEnd, fileSize - 1);

        // Paksa chunk minimal MIN_CHUNK_SIZE agar Cloudflare Tunnel
        // tidak perlu banyak round-trip untuk buffer video yang sama
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
            highWaterMark: READ_STREAM_HWM,
        });

        stream.on('error', (err) => {
            console.error('Stream error:', err.message);
            if (!res.headersSent) res.status(500).end();
            else res.destroy();
        });

        stream.pipe(res);
    } else {
        // Request tanpa range — kirim seluruh file
        res.writeHead(200, {
            ...baseHeaders,
            'Content-Length': fileSize,
        });

        const stream = fs.createReadStream(filePath, {
            highWaterMark: READ_STREAM_HWM,
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
// ROOM STATE - CLEAN STRUCTURE
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
            seats: {}
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

        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = data.name;
        socket.peerId = data.peerId;

        room.users.push(socket.id);
        room.names[socket.id] = data.name;

        if (data.seats && data.seats.length > 0) {
            data.seats.forEach(seatId => {
                room.seats[seatId] = {
                    name: data.name,
                    socketId: socket.id
                };
            });
        }

        let isHost = false;
        if (!room.hostAssigned || room.hostId === null) {
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

        socket.to(roomId).emit('system-message', `👋 ${data.name} telah bergabung ke dalam room.`);

        if (room.state.url) {
            socket.emit('auto-sync-join', room.state);
        }

        socket.emit('username-lock-status', room.usernameLock || false);

        const seatData = Object.keys(room.seats).reduce((acc, seat) => {
            acc[seat] = true;
            return acc;
        }, {});
        socket.emit('taken-seats', seatData);

        console.log(`${data.name} joined room ${roomId} (${isHost ? '👑 Host' : '👤 Viewer'}) - Total: ${room.users.length}`);
    });

    // ============================================================
    // SYNC ENGINE HANDLERS
    // ============================================================

    // Host mengirim heartbeat posisi video secara berkala.
    // Server meneruskan ke semua viewer dengan timestamp server
    // agar viewer bisa menghitung one-way latency secara akurat.
    socket.on('host-heartbeat', (data) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);
        if (!room || room.hostId !== socket.id) return;

        const now = Date.now();
        room.state.time = data.time;
        room.state.isPlaying = data.isPlaying;
        room.state.lastUpdate = now;

        // Broadcast ke viewer, sertakan serverTime agar bisa NTP compensation
        socket.to(roomId).emit('host-tick', {
            time: data.time,
            isPlaying: data.isPlaying,
            serverTime: now,
            hostSendTime: data.hostSendTime // untuk round-trip kalkulasi di viewer
        });
    });

    // Viewer meminta snapshot state saat join atau setelah reconnect.
    // Server menghitung posisi estimasi berdasarkan waktu terakhir update.
    socket.on('request-sync', () => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);
        if (!room || !room.state.url) return;

        const now = Date.now();
        const elapsedSec = (now - room.state.lastUpdate) / 1000;
        // Batasi elapsed agar tidak ada lompatan besar jika server idle lama
        const safeElapsed = Math.min(elapsedSec, 5.0);
        const estimatedTime = room.state.time + (room.state.isPlaying ? safeElapsed : 0);

        socket.emit('sync-state', {
            url: room.state.url,
            time: estimatedTime,
            isPlaying: room.state.isPlaying,
            serverTime: now
        });
    });

    // ============================================================
    // CONTROL EVENTS
    // ============================================================

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

        io.to(roomId).emit('play', {
            time: data.time,
            serverTime: now
        });
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

        io.to(roomId).emit('pause', {
            time: data.time,
            serverTime: now
        });
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

        // Kirim force-sync ke semua viewer (termasuk host sendiri tidak perlu)
        socket.to(roomId).emit('sync-state', {
            url: room.state.url,
            time: time,
            isPlaying: room.state.isPlaying,
            serverTime: now,
            forced: true
        });
    });

    // ============================================================
    // VIDEO CHANGE
    // ============================================================

    socket.on('video-changed', (data) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);
        if (room.hostId !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa mengganti video!');
            return;
        }

        // Simpan raw URL — resolving dilakukan di client via /resolve-gdrive
        room.state.url = data.url;
        room.state.time = 0;
        room.state.isPlaying = true;
        room.state.lastUpdate = Date.now();

        io.to(roomId).emit('video-changed', { url: data.url, serverTime: Date.now() });
    });

    // ============================================================
    // BUFFERING
    // ============================================================

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

    // ============================================================
    // CHAT
    // ============================================================

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

    // ============================================================
    // USERNAME LOCK
    // ============================================================

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

    // ============================================================
    // KICK & TRANSFER HOST
    // ============================================================

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

    // ============================================================
    // BROADCAST
    // ============================================================

    socket.on('broadcast-message', (message) => {
        const roomId = socket.roomId;
        const room = getRoom(roomId);

        if (room.hostId !== socket.id) {
            socket.emit('error-message', '❌ Hanya Host yang bisa mengirim broadcast!');
            return;
        }

        io.to(roomId).emit('broadcast-message', message);
    });

    // ============================================================
    // SEAT MANAGEMENT
    // ============================================================

    socket.on('get-taken-seats', (roomId) => {
        const room = getRoom(roomId);
        const seatData = Object.keys(room.seats).reduce((acc, seat) => {
            acc[seat] = true;
            return acc;
        }, {});
        socket.emit('taken-seats', seatData);
    });

    socket.on('reserve-seats', (data) => {
        const { roomId, seats, name } = data;
        const room = getRoom(roomId);

        const taken = [];
        seats.forEach(seatId => {
            if (room.seats[seatId]) {
                taken.push(seatId);
            }
        });

        if (taken.length > 0) {
            socket.emit('error-message', `Kursi ${taken.join(', ')} sudah terisi!`);
            return;
        }

        seats.forEach(seatId => {
            room.seats[seatId] = {
                name: name,
                socketId: socket.id
            };
        });

        const seatData = Object.keys(room.seats).reduce((acc, seat) => {
            acc[seat] = true;
            return acc;
        }, {});
        io.to(roomId).emit('seats-updated', seatData);
    });

    // ============================================================
    // MISC
    // ============================================================

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

    // ============================================================
    // DISCONNECT
    // ============================================================

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

        if (room.seats) {
            Object.keys(room.seats).forEach(seatId => {
                if (room.seats[seatId].socketId === socket.id) {
                    delete room.seats[seatId];
                }
            });
            const seatData = Object.keys(room.seats).reduce((acc, seat) => {
                acc[seat] = true;
                return acc;
            }, {});
            io.to(roomId).emit('seats-updated', seatData);
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
