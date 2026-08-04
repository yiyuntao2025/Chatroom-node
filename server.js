// server.js - 聊天室（单端口版本，适配 Render 部署）
const express = require('express');
const http = require('http');
const https = require('https');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const os = require('os');

const chatApp = express();
const adminApp = express();

// ========== 配置 ==========
const PORT = process.env.PORT || 33333;  // 聊天室端口
const ADMIN_PORT = process.env.ADMIN_PORT || 33334;  // 管理后台端口
const HOST = '0.0.0.0';

// ========== 中间件 ==========
chatApp.use(express.json({ limit: '10mb' }));
chatApp.use(express.urlencoded({ extended: true, limit: '10mb' }));
chatApp.use(express.static(path.join(__dirname, 'public')));

adminApp.use(express.json({ limit: '10mb' }));
adminApp.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ========== 存储数据（内存）==========
let users = {};           // socket.id -> 用户名
let userIps = {};         // socket.id -> IP地址
let userIpInfos = {};     // socket.id -> IP信息
let bannedIps = {};        // 被禁言的广域网IP { ipKey: true }
let kickedIps = {};        // 被踢出的广域网IP { ipKey: timestamp }

// 文件类型图标映射
const fileIcons = {
    'pdf': '📄', 'doc': '📝', 'docx': '📝', 'xls': '📊', 'xlsx': '📊',
    'ppt': '📊', 'pptx': '📊', 'txt': '📄', 'zip': '📦', 'rar': '📦',
    '7z': '📦', 'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️',
    'mp3': '🎵', 'mp4': '🎬', 'avi': '🎬', 'mov': '🎬', 'exe': '⚙️',
    'msi': '⚙️', 'default': '📎'
};

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeIp(ip) {
    if (!ip) return '未知';
    return ip.startsWith('::ffff:') ? ip.replace('::ffff:', '') : ip;
}

function formatIpInfo(info, fallbackIp = '未知') {
    if (!info) return fallbackIp;
    const parts = [];
    if (info.ip) parts.push(info.ip);
    if (info.region) parts.push(info.region);
    if (info.isp) parts.push(info.isp);
    return parts.join(' · ') || fallbackIp;
}

function getNetworkIpKey(ipInfo) {
    if (!ipInfo) return 'unknown';
    const baseIp = (ipInfo.ip || '').trim();
    const beginIp = (ipInfo.beginip || '').trim();
    const endIp = (ipInfo.endip || '').trim();
    const region = (ipInfo.region || '').trim();
    const isp = (ipInfo.isp || '').trim();
    const asn = (ipInfo.asn || '').trim();
    const llc = (ipInfo.llc || '').trim();

    return [baseIp, beginIp, endIp, region, isp, asn, llc].filter(Boolean).join('|');
}

function getPublicIpInfo(fallbackIp = '未知') {
    return new Promise((resolve) => {
        const req = https.get('https://uapis.cn/api/v1/network/myip', (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({
                        ip: json.ip || fallbackIp,
                        beginip: json.beginip || '',
                        endip: json.endip || '',
                        region: json.region || '未知',
                        isp: json.isp || '未知',
                        asn: json.asn || '',
                        llc: json.llc || '',
                        latitude: json.latitude || '',
                        longitude: json.longitude || ''
                    });
                } catch (error) {
                    resolve({
                        ip: fallbackIp,
                        region: '未知',
                        isp: '未知',
                        asn: '',
                        llc: '',
                        latitude: '',
                        longitude: ''
                    });
                }
            });
        });

        req.on('error', () => {
            resolve({
                ip: fallbackIp,
                region: '未知',
                isp: '未知',
                asn: '',
                llc: '',
                latitude: '',
                longitude: ''
            });
        });

        req.setTimeout(4000, () => {
            req.destroy();
            resolve({
                ip: fallbackIp,
                region: '未知',
                isp: '未知',
                asn: '',
                llc: '',
                latitude: '',
                longitude: ''
            });
        });
    });
}

// 获取本机IP
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name in interfaces) {
        for (const addr of interfaces[name]) {
            if (addr.family === 'IPv4' && !addr.internal) {
                return addr.address;
            }
        }
    }
    return '127.0.0.1';
}

// ========== 管理后台页面和API ==========
adminApp.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

adminApp.get('/api/rs', (req, res) => {
    const userList = [];
    for (const [socketId, username] of Object.entries(users)) {
        const ipInfo = userIpInfos[socketId] || {};
        const ipKey = getNetworkIpKey(ipInfo);
        userList.push({
            socketId,
            username,
            ip: ipInfo.ip || userIps[socketId] || '未知',
            ipInfo,
            region: ipInfo.region || '未知',
            isp: ipInfo.isp || '未知',
            banned: !!bannedIps[ipKey],
            online: true
        });
    }
    res.json(userList);
});

adminApp.get('/api/users', (req, res) => {
    const userList = [];
    for (const [socketId, username] of Object.entries(users)) {
        const ipInfo = userIpInfos[socketId] || {};
        const ipKey = getNetworkIpKey(ipInfo);
        userList.push({
            socketId,
            username,
            ip: ipInfo.ip || userIps[socketId] || '未知',
            ipInfo,
            region: ipInfo.region || '未知',
            isp: ipInfo.isp || '未知',
            banned: !!bannedIps[ipKey],
            online: true
        });
    }
    res.json(userList);
});

// 禁言用户
adminApp.post('/api/mute', (req, res) => {
    const { username } = req.body;
    if (username) {
        const targetSocket = Object.entries(users).find(([, name]) => name === username);
        if (targetSocket) {
            const [socketId] = targetSocket;
            const ipKey = getNetworkIpKey(userIpInfos[socketId]);
            bannedIps[ipKey] = true;

            if (io) {
                io.to(socketId).emit('message', {
                    user: '系统',
                    text: '⚠️ 你所在的网络已被管理员禁言！',
                    time: new Date().toLocaleTimeString()
                });
            }

            if (io) {
                io.emit('message', {
                    user: '系统',
                    text: `🔇 用户 ${username} 所在网络已被管理员禁言`,
                    time: new Date().toLocaleTimeString()
                });
            }

            res.json({ success: true, message: `已禁言 ${username} 所在网络` });
        } else {
            res.status(404).json({ success: false, message: '当前在线用户不存在' });
        }
    } else {
        res.status(400).json({ success: false, message: '需要用户名' });
    }
});

// 解除禁言
adminApp.post('/api/unmute', (req, res) => {
    const { username } = req.body;
    const targetSocket = Object.entries(users).find(([, name]) => name === username);
    if (username && targetSocket) {
        const [socketId] = targetSocket;
        const ipKey = getNetworkIpKey(userIpInfos[socketId]);
        delete bannedIps[ipKey];

        if (io) {
            io.to(socketId).emit('message', {
                user: '系统',
                text: '🔊 你所在的网络已被解除禁言',
                time: new Date().toLocaleTimeString()
            });
        }

        if (io) {
            io.emit('message', {
                user: '系统',
                text: `🔊 用户 ${username} 所在网络已被解除禁言`,
                time: new Date().toLocaleTimeString()
            });
        }

        res.json({ success: true, message: `已解除 ${username} 所在网络禁言` });
    } else {
        res.status(400).json({ success: false, message: '用户不存在或未被禁言' });
    }
});

// 踢出用户
adminApp.post('/api/kick', (req, res) => {
    const { username } = req.body;
    if (username) {
        const targetSocket = Object.entries(users).find(([, name]) => name === username);
        if (targetSocket) {
            const [socketId] = targetSocket;
            const ipKey = getNetworkIpKey(userIpInfos[socketId]);
            kickedIps[ipKey] = Date.now();

            if (io) {
                io.to(socketId).emit('kicked', {
                    reason: '你已被管理员踢出聊天室'
                });

                const socket = io.sockets.sockets.get(socketId);
                if (socket) {
                    socket.disconnect(true);
                }
            }

            if (io) {
                io.emit('message', {
                    user: '系统',
                    text: `👢 用户 ${username} 所在网络已被管理员踢出`,
                    html: false,
                    time: new Date().toLocaleTimeString()
                });
            }

            res.json({ success: true, message: `已踢出 ${username} 所在网络` });
        } else {
            res.status(404).json({ success: false, message: '当前在线用户不存在' });
        }
    } else {
        res.status(400).json({ success: false, message: '需要用户名' });
    }
});

// 管理员消息（支持 HTML）
adminApp.post('/api/admin-message', (req, res) => {
    let { message, html } = req.body;
    if (!message || typeof message !== 'string') {
        return res.status(400).json({ success: false, message: '需要消息内容' });
    }

    if (html) {
        io.emit('message', {
            user: '管理员',
            text: message,
            html: true,
            time: new Date().toLocaleTimeString()
        });
    } else {
        io.emit('message', {
            user: '管理员',
            text: message,
            html: false,
            time: new Date().toLocaleTimeString()
        });
    }

    res.json({ success: true, message: '管理员消息已发送' });
});

// 心跳检测端点（防止 Render 休眠）
chatApp.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

adminApp.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// ========== 创建服务器 ==========
const chatServer = http.createServer(chatApp);
const adminServer = http.createServer(adminApp);

// 初始化 Socket.IO
const io = socketIo(chatServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

// ========== Socket.IO 逻辑 ==========
io.on('connection', async (socket) => {
    const clientIp = normalizeIp(socket.handshake.address);
    const publicIpInfo = await getPublicIpInfo(clientIp);
    userIps[socket.id] = clientIp;
    userIpInfos[socket.id] = publicIpInfo;

    console.log('🔗 新用户连接:', socket.id, '本机IP:', clientIp, '公网IP:', publicIpInfo.ip, '地区:', publicIpInfo.region, '运营商:', publicIpInfo.isp);

    // 新用户加入
    socket.on('join', async (username) => {
        const ipInfo = userIpInfos[socket.id] || await getPublicIpInfo(userIps[socket.id] || '未知');
        userIpInfos[socket.id] = ipInfo;
        const ipKey = getNetworkIpKey(ipInfo);

        // 检查是否被踢出（最近5分钟内被踢过的不能进）
        if (kickedIps[ipKey] && (Date.now() - kickedIps[ipKey] < 5 * 60 * 1000)) {
            socket.emit('message', {
                user: '系统',
                text: '⛔ 你所在网络已被踢出，5分钟后方可重新加入',
                time: new Date().toLocaleTimeString()
            });
            return;
        }

        if (bannedIps[ipKey]) {
            socket.emit('message', {
                user: '系统',
                text: '⚠️ 你所在网络当前处于禁言状态，无法发送消息',
                time: new Date().toLocaleTimeString()
            });
        }

        users[socket.id] = username;

        socket.broadcast.emit('message', {
            user: '系统',
            text: `${username} 加入了聊天室`,
            time: new Date().toLocaleTimeString()
        });

        const userList = Object.entries(users).map(([socketId, userName]) => ({
            username: userName,
            ip: userIpInfos[socketId]?.ip || userIps[socketId] || '未知',
            ipInfo: userIpInfos[socketId] || null
        }));
        io.emit('updateUsers', userList);

        socket.emit('message', {
            user: '系统',
            text: '欢迎使用聊天室！',
            time: new Date().toLocaleTimeString()
        });

        socket.emit('yourIpInfo', ipInfo);

        // 发送聊天室守则（简化版，避免HTML过长）
        socket.emit('message', {
            user: '系统',
            text: '📜 请遵守聊天室规则，文明交流，禁止发布违法违规内容。',
            time: new Date().toLocaleTimeString()
        });

        console.log('👤 用户加入:', username, 'IP:', formatIpInfo(ipInfo, userIps[socket.id] || '未知'));
    });

    // 接收文本消息（检查禁言，前端按文本渲染，避免尖括号被误显示为实体）
    socket.on('sendMessage', (message) => {
        const username = users[socket.id];
        const ipInfo = userIpInfos[socket.id];
        const ipKey = getNetworkIpKey(ipInfo);
        if (username && !bannedIps[ipKey]) {
            io.emit('message', {
                user: username,
                text: message,
                html: false,
                time: new Date().toLocaleTimeString()
            });
        } else if (username && bannedIps[ipKey]) {
            socket.emit('message', {
                user: '系统',
                text: '⛔ 你所在网络已被禁言，无法发送消息',
                html: false,
                time: new Date().toLocaleTimeString()
            });
        }
    });

    // 接收图片（检查禁言）
    socket.on('sendImage', (imageData) => {
        const username = users[socket.id];
        const ipInfo = userIpInfos[socket.id];
        const ipKey = getNetworkIpKey(ipInfo);
        if (username && !bannedIps[ipKey]) {
            io.emit('image', {
                user: username,
                filename: imageData.filename,
                data: imageData.data,
                type: imageData.type,
                time: new Date().toLocaleTimeString()
            });
        } else if (username && bannedIps[ipKey]) {
            socket.emit('message', {
                user: '系统',
                text: '⛔ 你所在网络已被禁言，无法发送图片',
                time: new Date().toLocaleTimeString()
            });
        }
    });

    // 接收文件（检查禁言）
    socket.on('sendFile', (fileData) => {
        const username = users[socket.id];
        const ipInfo = userIpInfos[socket.id];
        const ipKey = getNetworkIpKey(ipInfo);
        if (username && !bannedIps[ipKey]) {
            const ext = fileData.filename.split('.').pop().toLowerCase();
            const icon = fileIcons[ext] || fileIcons.default;

            io.emit('file', {
                user: username,
                filename: fileData.filename,
                data: fileData.data,
                type: fileData.type,
                size: fileData.size,
                icon: icon,
                time: new Date().toLocaleTimeString()
            });
        } else if (username && bannedIps[ipKey]) {
            socket.emit('message', {
                user: '系统',
                text: '⛔ 你所在网络已被禁言，无法发送文件',
                time: new Date().toLocaleTimeString()
            });
        }
    });

    // 断开连接
    socket.on('disconnect', () => {
        const username = users[socket.id];
        if (username) {
            delete users[socket.id];
            delete userIps[socket.id];
            delete userIpInfos[socket.id];

            io.emit('message', {
                user: '系统',
                text: `${username} 离开了聊天室`,
                time: new Date().toLocaleTimeString()
            });
            const userList = Object.entries(users).map(([socketId, userName]) => ({
                username: userName,
                ip: userIpInfos[socketId]?.ip || userIps[socketId] || '未知',
                ipInfo: userIpInfos[socketId] || null
            }));
            io.emit('updateUsers', userList);
            console.log('👋 用户离开:', username);
        }
    });
});

// ========== 启动服务器 ==========
chatServer.listen(PORT, HOST, () => {
    const localIP = getLocalIP();

    console.log('='.repeat(60));
    console.log('🚀 聊天室服务器启动成功！');
    console.log('='.repeat(60));
    console.log(`💬 聊天室地址: http://localhost:${PORT}`);
    console.log(`💬 局域网地址: http://${localIP}:${PORT}`);
    console.log(`❤️ 心跳检测: http://localhost:${PORT}/ping`);
    console.log('');
    console.log('📊 等待用户连接...');
    console.log('='.repeat(60));
});

adminServer.listen(ADMIN_PORT, HOST, () => {
    const localIP = getLocalIP();

    console.log('='.repeat(60));
    console.log('🔧 管理后台服务启动成功！');
    console.log('='.repeat(60));
    console.log(`🖥️ 管理后台地址: http://localhost:${ADMIN_PORT}/admin`);
    console.log(`🖥️ 管理后台局域网: http://${localIP}:${ADMIN_PORT}/admin`);
    console.log(`❤️ 心跳检测: http://localhost:${ADMIN_PORT}/ping`);
    console.log('='.repeat(60));
});

// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n🛑 正在关闭服务器...');
    chatServer.close(() => {
        adminServer.close(() => {
            console.log('✅ 服务器已关闭');
            process.exit(0);
        });
    });
});

// 导出 io 供外部使用（如果需要）
module.exports = { io };
