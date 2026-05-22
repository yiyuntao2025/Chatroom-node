// server.js - 聊天室（单端口版本，适配 Render 部署）
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();

// ========== 配置 ==========
const PORT = process.env.PORT || 33333;  // Render 会用环境变量，本地默认 33333
const HOST = '0.0.0.0';

// ========== 中间件 ==========
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== 存储数据（内存）==========
let users = {};           // socket.id -> 用户名
let userIps = {};         // socket.id -> IP地址
let bannedUsers = {};     // 被禁言的用户 { username: true }
let kickedUsers = {};     // 被踢出的用户 { username: timestamp }

// 文件类型图标映射
const fileIcons = {
    'pdf': '📄', 'doc': '📝', 'docx': '📝', 'xls': '📊', 'xlsx': '📊',
    'ppt': '📊', 'pptx': '📊', 'txt': '📄', 'zip': '📦', 'rar': '📦',
    '7z': '📦', 'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️',
    'mp3': '🎵', 'mp4': '🎬', 'avi': '🎬', 'mov': '🎬', 'exe': '⚙️',
    'msi': '⚙️', 'default': '📎'
};

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
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/users', (req, res) => {
    const userList = [];
    for (const [socketId, username] of Object.entries(users)) {
        userList.push({
            socketId,
            username,
            ip: userIps[socketId] || '未知',
            banned: !!bannedUsers[username],
            online: true
        });
    }
    res.json(userList);
});

// 禁言用户
app.post('/api/mute', (req, res) => {
    const { username } = req.body;
    if (username) {
        bannedUsers[username] = true;
        
        // 通知该用户被禁言
        for (const [socketId, name] of Object.entries(users)) {
            if (name === username && io) {
                io.to(socketId).emit('message', {
                    user: '系统',
                    text: '⚠️ 你已被管理员禁言！',
                    time: new Date().toLocaleTimeString()
                });
                break;
            }
        }
        
        // 广播禁言消息
        if (io) {
            io.emit('message', {
                user: '系统',
                text: `🔇 用户 ${username} 已被管理员禁言`,
                time: new Date().toLocaleTimeString()
            });
        }
        
        res.json({ success: true, message: `已禁言 ${username}` });
    } else {
        res.status(400).json({ success: false, message: '需要用户名' });
    }
});

// 解除禁言
app.post('/api/unmute', (req, res) => {
    const { username } = req.body;
    if (username && bannedUsers[username]) {
        delete bannedUsers[username];
        
        // 通知该用户解除禁言
        for (const [socketId, name] of Object.entries(users)) {
            if (name === username && io) {
                io.to(socketId).emit('message', {
                    user: '系统',
                    text: '🔊 你已被解除禁言',
                    time: new Date().toLocaleTimeString()
                });
                break;
            }
        }
        
        if (io) {
            io.emit('message', {
                user: '系统',
                text: `🔊 用户 ${username} 已被解除禁言`,
                time: new Date().toLocaleTimeString()
            });
        }
        
        res.json({ success: true, message: `已解除 ${username} 禁言` });
    } else {
        res.status(400).json({ success: false, message: '用户不存在或未被禁言' });
    }
});

// 踢出用户
app.post('/api/kick', (req, res) => {
    const { username } = req.body;
    if (username) {
        // 记录被踢时间
        kickedUsers[username] = Date.now();
        
        for (const [socketId, name] of Object.entries(users)) {
            if (name === username && io) {
                io.to(socketId).emit('kicked', {
                    reason: '你已被管理员踢出聊天室'
                });
                
                const socket = io.sockets.sockets.get(socketId);
                if (socket) {
                    socket.disconnect(true);
                }
                break;
            }
        }
        
        if (io) {
            io.emit('message', {
                user: '系统',
                text: `👢 用户 ${username} 已被管理员踢出`,
                time: new Date().toLocaleTimeString()
            });
        }
        
        res.json({ success: true, message: `已踢出 ${username}` });
    } else {
        res.status(400).json({ success: false, message: '需要用户名' });
    }
});

// 心跳检测端点（防止 Render 休眠）
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// ========== 创建服务器 ==========
const server = http.createServer(app);

// 初始化 Socket.IO
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

// ========== Socket.IO 逻辑 ==========
io.on('connection', (socket) => {
    const clientIp = socket.handshake.address;
    console.log('🔗 新用户连接:', socket.id, 'IP:', clientIp);
    
    // 保存IP
    userIps[socket.id] = clientIp;

    // 新用户加入
    socket.on('join', (username) => {
        // 检查是否被踢出（最近5分钟内被踢过的不能进）
        if (kickedUsers[username] && (Date.now() - kickedUsers[username] < 5 * 60 * 1000)) {
            socket.emit('message', {
                user: '系统',
                text: '⛔ 你已被踢出，5分钟后方可重新加入',
                time: new Date().toLocaleTimeString()
            });
            return;
        }
        
        users[socket.id] = username;
        
        socket.broadcast.emit('message', {
            user: '系统',
            text: `${username} 加入了聊天室`,
            time: new Date().toLocaleTimeString()
        });
        
        io.emit('updateUsers', Object.values(users));
        
        // 检查是否被禁言
        if (bannedUsers[username]) {
            socket.emit('message', {
                user: '系统',
                text: '⚠️ 你当前处于禁言状态，无法发送消息',
                time: new Date().toLocaleTimeString()
            });
        }
        
        socket.emit('message', {
            user: '系统',
            text: '欢迎使用聊天室！',
            time: new Date().toLocaleTimeString()
        });
        
        // 发送聊天室守则（简化版，避免HTML过长）
        socket.emit('message', {
            user: '系统',
            text: '📜 请遵守聊天室规则，文明交流，禁止发布违法违规内容。',
            time: new Date().toLocaleTimeString()
        });
        
        console.log('👤 用户加入:', username);
    });

    // 接收文本消息（检查禁言）
    socket.on('sendMessage', (message) => {
        const username = users[socket.id];
        if (username && !bannedUsers[username]) {
            io.emit('message', {
                user: username,
                text: message,
                time: new Date().toLocaleTimeString()
            });
        } else if (username && bannedUsers[username]) {
            socket.emit('message', {
                user: '系统',
                text: '⛔ 你已被禁言，无法发送消息',
                time: new Date().toLocaleTimeString()
            });
        }
    });

    // 接收图片（检查禁言）
    socket.on('sendImage', (imageData) => {
        const username = users[socket.id];
        if (username && !bannedUsers[username]) {
            io.emit('image', {
                user: username,
                filename: imageData.filename,
                data: imageData.data,
                type: imageData.type,
                time: new Date().toLocaleTimeString()
            });
        } else if (username && bannedUsers[username]) {
            socket.emit('message', {
                user: '系统',
                text: '⛔ 你已被禁言，无法发送图片',
                time: new Date().toLocaleTimeString()
            });
        }
    });

    // 接收文件（检查禁言）
    socket.on('sendFile', (fileData) => {
        const username = users[socket.id];
        if (username && !bannedUsers[username]) {
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
        } else if (username && bannedUsers[username]) {
            socket.emit('message', {
                user: '系统',
                text: '⛔ 你已被禁言，无法发送文件',
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
            
            io.emit('message', {
                user: '系统',
                text: `${username} 离开了聊天室`,
                time: new Date().toLocaleTimeString()
            });
            io.emit('updateUsers', Object.values(users));
            console.log('👋 用户离开:', username);
        }
    });
});

// ========== 启动服务器 ==========
server.listen(PORT, HOST, () => {
    const localIP = getLocalIP();
    
    console.log('='.repeat(60));
    console.log('🚀 聊天室服务器启动成功！');
    console.log('='.repeat(60));
    console.log(`💬 聊天室地址: http://localhost:${PORT}`);
    console.log(`💬 局域网地址: http://${localIP}:${PORT}`);
    console.log(`🔧 管理后台: http://localhost:${PORT}/admin`);
    console.log(`🔧 管理后台局域网: http://${localIP}:${PORT}/admin`);
    console.log(`❤️ 心跳检测: http://localhost:${PORT}/ping`);
    console.log('');
    console.log('📊 等待用户连接...');
    console.log('='.repeat(60));
});

// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n🛑 正在关闭服务器...');
    server.close(() => {
        console.log('✅ 服务器已关闭');
        process.exit(0);
    });
});

// 导出 io 供外部使用（如果需要）
module.exports = { io };
