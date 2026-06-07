const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Library FFmpeg baru
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Cache untuk menyimpan hasil transcode
const videoCache = {};

const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, 'video-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.use(express.static('public'));

// --- FUNGSI KOMPRESI DINAMIS ---
function transcodeVideo(inputPath, outputPath, height, videoBitrate, audioBitrate) {
    console.log(`Memulai kompresi ke ${height}p...`);
    ffmpeg(inputPath)
        .output(outputPath)
        .videoCodec('libx264')
        .videoFilters(`scale=-2:${height}`) // Anti gepeng, tinggi menyesuaikan
        .videoBitrate(videoBitrate) 
        .audioCodec('aac')
        .audioBitrate(audioBitrate) 
        .outputOptions([
            '-movflags faststart', // KUNCI UTAMA agar video cepat muncul
            '-preset ultrafast'    // Mempercepat proses kompresi
        ])
        .on('end', () => console.log(`Kompresi ${height}p selesai! siap ditonton.`))
        .on('error', (err) => console.error(`Gagal kompresi ${height}p:`, err.message))
        .run();
}

// Fungsi caching untuk transcode
async function getTranscodedVideo(videoPath, resolution) {
    const cacheKey = `${videoPath}-${resolution}`;
    
    // Jika sudah pernah di-transcode, langsung kirim path-nya
    if (videoCache[cacheKey]) return videoCache[cacheKey];
    
    // Jika belum, lakukan transcode dan simpan ke cache
    const outputPath = `./uploads/temp-${resolution}.mp4`;
    await transcodeVideo(videoPath, outputPath, resolution);
    
    videoCache[cacheKey] = outputPath;
    return outputPath;
}

// --- ENDPOINT UPLOAD ---
app.post('/upload', upload.single('videoFile'), (req, res) => {
    if (req.file) {
        const filename = req.file.filename;
        const ext = path.extname(filename);
        const baseName = path.basename(filename, ext);

        const inputPath = `./uploads/${filename}`;
        const out360 = `./uploads/${baseName}_360p${ext}`;
        const out144 = `./uploads/${baseName}_144p${ext}`;

        // Jalankan pembuatan 2 resolusi sekaligus di background
        // 360p: Kualitas menengah, 400kbps
        transcodeVideo(inputPath, out360, 360, '400k', '64k');
        // 144p: Kualitas terendah (super hemat kuota), 100kbps
        transcodeVideo(inputPath, out144, 144, '100k', '32k');

        const videoUrl = `/stream/${filename}`;
        res.json({ success: true, url: videoUrl });
    } else {
        res.status(400).json({ success: false });
    }
});

// --- ENDPOINT STREAMING ---
app.get('/stream/:filename', (req, res) => {
    let filename = req.params.filename;
    const requestedRes = req.query.res; // Menangkap permintaan 144p atau 360p

    // Cek apakah user meminta resolusi khusus
    if (requestedRes === '360p' || requestedRes === '144p') {
        const ext = path.extname(filename);
        const baseName = path.basename(filename, ext);
        filename = `${baseName}_${requestedRes}${ext}`;
    }

    const filePath = `./uploads/${filename}`;
    
    // Fallback: Jika file 144p/360p belum selesai dirender, putar yang Original dulu
    if (!fs.existsSync(filePath)) {
        const originalPath = `./uploads/${req.params.filename}`;
        if (!fs.existsSync(originalPath)) return res.status(404).send('Video tidak ditemukan');
        return streamFile(originalPath, req, res);
    }

    streamFile(filePath, req, res);
});

// Fungsi pembantu chunking video stream (Dioptimalkan)
function streamFile(filePath, req, res) {
    const fs = require('fs');
    const path = require('path');

    // Pastikan file ada
    if (!fs.existsSync(filePath)) {
        console.error("File tidak ditemukan di:", filePath);
        res.status(404).send("Video tidak ditemukan!");
        return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // Jika ada request Range (untuk video besar)
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
        // Jika request biasa
        const head = {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
    }
}

// Memori untuk menyimpan status penonton (WebRTC)
const roomPeers = {}; 
// MEMORI BARU: Menyimpan status video terakhir di setiap room
const roomStates = {}; 

io.on('connection', (socket) => {
    // MODIFIKASI: Menangkap data room saat join
    socket.on('join-room', (data) => {
        socket.join(data.roomId);
        socket.roomId = data.roomId;
        socket.username = data.name; // Simpan nama di sesi socket
        
        console.log(`${data.name} joined room ${data.roomId}`);

        // --- TAMBAHKAN BARIS INI: Siarkan notifikasi join ke pengguna lain ---
        socket.to(data.roomId).emit('system-message', `👋 ${data.name} telah bergabung ke dalam room.`);
    });

    // Setiap ada perubahan, server mencatatnya ke memori roomStates
    socket.on('video-changed', (url) => {
        roomStates[socket.roomId] = { url: url, time: 0, isPlaying: true, lastUpdate: Date.now() };
        io.to(socket.roomId).emit('video-changed', url); 
    });

    socket.on('play', (time) => {
        if(roomStates[socket.roomId]) { roomStates[socket.roomId].time = time; roomStates[socket.roomId].isPlaying = true; roomStates[socket.roomId].lastUpdate = Date.now(); }
        socket.to(socket.roomId).emit('play', time);
    });

    socket.on('pause', (time) => {
        if(roomStates[socket.roomId]) { roomStates[socket.roomId].time = time; roomStates[socket.roomId].isPlaying = false; roomStates[socket.roomId].lastUpdate = Date.now(); }
        socket.to(socket.roomId).emit('pause', time);
    });

    socket.on('seek', (time) => {
        if(roomStates[socket.roomId]) { roomStates[socket.roomId].time = time; roomStates[socket.roomId].lastUpdate = Date.now(); }
        socket.to(socket.roomId).emit('seek', time);
    });

    socket.on('sync-request', (time) => {
        if(roomStates[socket.roomId]) { roomStates[socket.roomId].time = time; roomStates[socket.roomId].lastUpdate = Date.now(); }
        socket.to(socket.roomId).emit('sync-request', time);
    });

    socket.on('chat-message', (data) => { 
        io.to(socket.roomId).emit('chat-message', data); 
    });

    // --- TAMBAHAN FITUR MENGETIK ---
    socket.on('typing', (name) => {
        socket.to(socket.roomId).emit('typing', name);
    });

    socket.on('stop-typing', () => {
        socket.to(socket.roomId).emit('stop-typing');
    });

    // --- TAMBAHAN FITUR FLOATING REACTION ---
    socket.on('reaction', (emoji) => {
        // Broadcast emote ke semua orang di room yang sama
        socket.to(socket.roomId).emit('reaction', emoji);
    });

    // Sinkronisasi Detik Video
    socket.on('sync-time', (data) => {
        socket.to(socket.roomId).emit('sync-time', data.time);
    });

    // Sinkronisasi Ganti Kualitas
    socket.on('change-quality', (data) => {
        socket.to(socket.roomId).emit('change-quality', data.url);
    });

    socket.on('request-peer-ids', () => { socket.emit('receive-peer-ids', roomPeers[socket.roomId] || []); });

    // MODIFIKASI: Beritahu room saat user terputus/keluar
    socket.on('disconnect', () => {
        if (socket.roomId) {
            // Pancarkan pesan keluar ke room
            socket.to(socket.roomId).emit('system-message', `${socket.username || 'Seseorang'} telah keluar dari room.`);
            
            if (roomPeers[socket.roomId]) {
                roomPeers[socket.roomId] = roomPeers[socket.roomId].filter(id => id !== socket.peerId);
            }
        }
        console.log('User terputus:', socket.id);
    });
});

const PORT = process.env.PORT || 3001;
const serverInstance = server.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));
serverInstance.timeout = 0;