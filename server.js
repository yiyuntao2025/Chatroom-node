const express = require('express');
const https = require('https');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();

// 添加这一行，支持 Render 自动分配的端口
const PORT = process.env.PORT || 33333;
const ADMIN_PORT = process.env.ADMIN_PORT || 33334;
const HOST = '0.0.0.0';

// ========== 中间件 ==========
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 存储数据
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

// ========== 用户管理API（用于管理页面）=========
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
app.post('/api/mute', express.json(), (req, res) => {
    const { username } = req.body;
    if (username) {
        bannedUsers[username] = true;
        
        // 通知该用户被禁言
        for (const [socketId, name] of Object.entries(users)) {
            if (name === username) {
                io.to(socketId).emit('message', {
                    user: '系统',
                    text: '⚠️ 你已被管理员禁言！',
                    time: new Date().toLocaleTimeString()
                });
                break;
            }
        }
        
        // 广播禁言消息
        io.emit('message', {
            user: '系统',
            text: `🔇 用户 ${username} 已被管理员禁言`,
            time: new Date().toLocaleTimeString()
        });
        
        res.json({ success: true, message: `已禁言 ${username}` });
    } else {
        res.status(400).json({ success: false, message: '需要用户名' });
    }
});

// 解除禁言
app.post('/api/unmute', express.json(), (req, res) => {
    const { username } = req.body;
    if (username && bannedUsers[username]) {
        delete bannedUsers[username];
        
        // 通知该用户解除禁言
        for (const [socketId, name] of Object.entries(users)) {
            if (name === username) {
                io.to(socketId).emit('message', {
                    user: '系统',
                    text: '🔊 你已被解除禁言',
                    time: new Date().toLocaleTimeString()
                });
                break;
            }
        }
        
        io.emit('message', {
            user: '系统',
            text: `🔊 用户 ${username} 已被解除禁言`,
            time: new Date().toLocaleTimeString()
        });
        
        res.json({ success: true, message: `已解除 ${username} 禁言` });
    } else {
        res.status(400).json({ success: false, message: '用户不存在或未被禁言' });
    }
});

// 踢出用户
app.post('/api/kick', express.json(), (req, res) => {
    const { username } = req.body;
    if (username) {
        // 找到该用户的socket并断开
        for (const [socketId, name] of Object.entries(users)) {
            if (name === username) {
                // 发送踢出消息
                io.to(socketId).emit('kicked', {
                    reason: '你已被管理员踢出聊天室'
                });
                
                // 断开连接
                const socket = io.sockets.sockets.get(socketId);
                if (socket) {
                    socket.disconnect(true);
                }
                break;
            }
        }
        
        // 广播踢出消息
        io.emit('message', {
            user: '系统',
            text: `👢 用户 ${username} 已被管理员踢出`,
            time: new Date().toLocaleTimeString()
        });
        
        res.json({ success: true, message: `已踢出 ${username}` });
    } else {
        res.status(400).json({ success: false, message: '需要用户名' });
    }
});

// ========== 主聊天服务器 ==========
const CHAT_PORT = 33333;
const ADMIN_PORT = 33334;
const HOST = '0.0.0.0';

// 创建 HTTP 服务器（用于聊天）
const chatServer = http.createServer(app);

// 初始化 Socket.IO
const io = socketIo(chatServer, {
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
        socket.emit('message', {
            user: '系统',
            text: `<div><div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 15px; color: white; font-family: 'Microsoft YaHei', sans-serif;"><!--标题区域--><div style="text-align: center; margin-bottom: 25px;"><h1 style="margin: 0; font-size: 28px; text-shadow: 2px 2px 4px rgba(0,0,0,0.3);">💬聊天室使用守则</h1><p style="margin: 10px 0 0; opacity: 0.9; font-size: 14px;">基于Node.js+Socket.io构建|遵守规则，共创美好聊天环境</p></div><!--状态卡片--><div style="background: rgba(255,255,255,0.15); backdrop-filter: blur(10px); border-radius: 12px; padding: 20px; margin-bottom: 25px; border: 1px solid rgba(255,255,255,0.2);"><div style="display: flex; flex-wrap: wrap; gap: 20px; justify-content: center;"><div style="flex: 1; min-width: 200px; text-align: center;"><div style="font-size: 16px; margin-bottom: 8px; opacity: 0.9;">📊当前状态</div><div style="display: inline-block; background: #00AA00; padding: 8px 20px; border-radius: 20px; font-weight: bold; font-size: 18px; box-shadow: 0 2px 10px rgba(0,170,0,0.3);">✅开放中</div></div><div style="flex: 1; min-width: 200px; text-align: center;"><div style="font-size: 16px; margin-bottom: 8px; opacity: 0.9;">⏰维护时间</div><div style="background: rgba(0,0,0,0.3); padding: 8px 15px; border-radius: 20px; font-size: 15px;">22:00-次日12:00</div></div><div style="flex: 1; min-width: 200px; text-align: center;"><div style="font-size: 16px; margin-bottom: 8px; opacity: 0.9;">🔗访问地址</div><div style="background: rgba(0,0,0,0.3); padding: 8px 15px; border-radius: 20px; font-size: 14px; word-break: break-all;">https:</div></div></div><!--守则内容-网格布局--><div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 25px;"><!--基本准则--><div style="background: rgba(255,255,255,0.1); border-radius: 12px; padding: 18px; border-left: 4px solid #4CAF50;"><h3 style="margin: 0 0 12px 0; font-size: 18px; display: flex; align-items: center; gap: 8px;"><span style="font-size: 24px;">📌</span>基本准则</h3><div style="color: rgba(255,255,255,0.9); font-size: 14px; line-height: 1.7;"><p>✅保持礼貌友善的交流氛围</p><p>✅禁止人身攻击、歧视性言论</p><p>✅尊重不同观点和文化背景</p><p>✅使用恰当的称呼和语言</p><p>❌禁止暴力、**等不适内容</p><p>❌不得分享恶意软件或危险链接</p><p>❌保护隐私，勿公开他人信息</p><p>❌禁止垃圾广告或重复内容</p></div></div><!--安全规则--><div style="background: rgba(255,255,255,0.1); border-radius: 12px; padding: 18px; border-left: 4px solid #FF9800;"><h3 style="margin: 0 0 12px 0; font-size: 18px; display: flex; align-items: center; gap: 8px;"><span style="font-size: 24px;">🛡️</span>安全规则</h3><div style="color: rgba(255,255,255,0.9); font-size: 14px; line-height: 1.7;"><p><strong>账户安全：</strong></p><p>•使用合适的昵称，勿冒用他人</p><p>•不要分享账户信息或密码</p><p>•异常活动立即通知管理员</p><p><strong>聊天安全：</strong></p><p>•谨慎点击未知链接</p><p>•勿传输敏感个人信息</p><p>•发现可疑行为立即举报</p></div></div><!--文件分享规则--><div style="background: rgba(255,255,255,0.1); border-radius: 12px; padding: 18px; border-left: 4px solid #2196F3;"><h3 style="margin: 0 0 12px 0; font-size: 18px; display: flex; align-items: center; gap: 8px;"><span style="font-size: 24px;">📁</span>文件分享规则</h3><div style="color: rgba(255,255,255,0.9); font-size: 14px; line-height: 1.7;"><p style="color: #A5D6A5;">✅允许的文件类型：</p><p>图片：JPG,PNG,GIF(≤5MB)</p><p>文档：PDF,TXT(≤2MB)</p><p>压缩：ZIP(≤10MB)</p><p style="color: #FFB3B3; margin-top: 10px;">❌禁止的文件类型：</p><p>可执行文件：EXE,MSI,BAT</p><p>脚本文件：JS,PY,PHP</p><p>侵权内容：盗版软件、版权材料</p></div></div><!--使用规范--><div style="background: rgba(255,255,255,0.1); border-radius: 12px; padding: 18px; border-left: 4px solid #9C27B0;"><h3 style="margin: 0 0 12px 0; font-size: 18px; display: flex; align-items: center; gap: 8px;"><span style="font-size: 24px;">⚡</span>使用规范</h3><div style="color: rgba(255,255,255,0.9); font-size: 14px; line-height: 1.7;"><p><strong>消息发送：</strong></p><p>•避免刷屏或重复消息</p><p>•单条消息≤1000字符</p><p>•合理使用表情和格式</p><p>•⚠️禁止利用HTML漏洞</p><p><strong>聊天礼仪：</strong></p><p>•欢迎新成员加入</p><p>•保持讨论主题相关</p><p>•离开时礼貌告别</p></div></div><!--隐私保护--><div style="background: rgba(255,255,255,0.1); border-radius: 12px; padding: 18px; border-left: 4px solid #607D8B;"><h3 style="margin: 0 0 12px 0; font-size: 18px; display: flex; align-items: center; gap: 8px;"><span style="font-size: 24px;">🔒</span>隐私保护</h3><div style="color: rgba(255,255,255,0.9); font-size: 14px; line-height: 1.7;"><p><strong>数据收集：</strong></p><p>•仅收集必要的聊天数据</p><p>•消息内容会话后自动清除</p><p>•文件24小时内删除</p><p><strong>隐私权利：</strong></p><p>•有权要求删除自己的消息</p><p>•可随时更改昵称</p><p>•可选择退出聊天室</p></div></div><!--违规处理--><div style="background: rgba(255,255,255,0.1); border-radius: 12px; padding: 18px; border-left: 4px solid #F44336;"><h3 style="margin: 0 0 12px 0; font-size: 18px; display: flex; align-items: center; gap: 8px;"><span style="font-size: 24px;">⚠️</span>违规处理</h3><div style="color: rgba(255,255,255,0.9); font-size: 14px; line-height: 1.7;"><p><strong>轻微违规：</strong></p><p>•第一次：警告</p><p>•第二次：临时禁言1小时</p><p>•多次：延长禁言时间</p><p><strong>严重违规：</strong></p><p>•发布违法内容：永久封禁</p><p>•恶意攻击他人：封禁7天</p><p>•传播病毒：永久封禁+报告</p></div></div></div><!--技术信息--><div style="background: rgba(0,0,0,0.2); border-radius: 10px; padding: 15px; margin-bottom: 20px; font-size: 13px; color: rgba(255,255,255,0.8);"><div style="display: flex; flex-wrap: wrap; gap: 15px; justify-content: space-between; align-items: center;"><span>🔧基于Node.js+Socket.io构建|开源代码|借助DeepSeek力量</span><span>🌐公网映射:cpolar/ngrok免费套餐|连接数有限，敬请谅解</span></div></div><!--联系管理--><div style="text-align: center; padding: 15px; background: rgba(0,0,0,0.15); border-radius: 10px;"><p style="margin: 0 0 8px 0; font-size: 16px; font-weight: bold;">📞联系管理</p><p style="margin: 5px 0; font-size: 13px; opacity: 0.9;">遇到问题：使用举报功能/查看健康检查页面/记录异常时间</p><p style="margin: 10px 0 0 0; font-size: 12px; opacity: 0.7;">最后更新：2026年2月|遵守规则，共创美好聊天环境</p></div></div></div>`,
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
// 启动聊天服务器（33333）
chatServer.listen(CHAT_PORT, HOST, () => {
    const localIP = getLocalIP();
    
    console.log('='.repeat(60));
    console.log('🚀 聊天室服务器启动成功！');
    console.log('='.repeat(60));
    console.log(`💬 聊天室地址: http://localhost:${CHAT_PORT}`);
    console.log(`💬 局域网地址: http://${localIP}:${CHAT_PORT}`);
    console.log('');
    console.log(`🔧 管理后台地址: http://localhost:${ADMIN_PORT}/admin`);
    console.log(`🔧 管理后台局域网: http://${localIP}:${ADMIN_PORT}/admin`);
    console.log('');
    console.log('🌍 cpolar 公网地址:');
    console.log(`   https://你的cpolar域名 (聊天室)`);
    console.log('');
    console.log('📊 当前在线: 0 人');
    console.log('='.repeat(60));
});

// 启动管理服务器（33334）
const adminApp = express();
adminApp.use(express.json());
adminApp.use(express.static(path.join(__dirname)));

// 把管理API也挂载到admin服务器
adminApp.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

adminApp.get('/api/users', (req, res) => {
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

adminApp.post('/api/mute', express.json(), (req, res) => {
    const { username } = req.body;
    if (username) {
        bannedUsers[username] = true;
        
        for (const [socketId, name] of Object.entries(users)) {
            if (name === username) {
                io.to(socketId).emit('message', {
                    user: '系统',
                    text: '⚠️ 你已被管理员禁言！',
                    time: new Date().toLocaleTimeString()
                });
                break;
            }
        }
        
        io.emit('message', {
            user: '系统',
            text: `🔇 用户 ${username} 已被管理员禁言`,
            time: new Date().toLocaleTimeString()
        });
        
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false });
    }
});

adminApp.post('/api/unmute', express.json(), (req, res) => {
    const { username } = req.body;
    if (username && bannedUsers[username]) {
        delete bannedUsers[username];
        
        for (const [socketId, name] of Object.entries(users)) {
            if (name === username) {
                io.to(socketId).emit('message', {
                    user: '系统',
                    text: '🔊 你已被解除禁言',
                    time: new Date().toLocaleTimeString()
                });
                break;
            }
        }
        
        io.emit('message', {
            user: '系统',
            text: `🔊 用户 ${username} 已被解除禁言`,
            time: new Date().toLocaleTimeString()
        });
        
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false });
    }
});

adminApp.post('/api/kick', express.json(), (req, res) => {
    const { username } = req.body;
    if (username) {
        // 记录被踢时间
        kickedUsers[username] = Date.now();
        
        for (const [socketId, name] of Object.entries(users)) {
            if (name === username) {
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
        
        io.emit('message', {
            user: '系统',
            text: `👢 用户 ${username} 已被管理员踢出`,
            time: new Date().toLocaleTimeString()
        });
        
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false });
    }
});

adminApp.listen(ADMIN_PORT, HOST, () => {
    console.log(`🔧 管理后台已启动: http://localhost:${ADMIN_PORT}/admin`);
});

// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n🛑 正在关闭服务器...');
    chatServer.close();
    process.exit(0);
});