# Chatroom Node

一个基于 `Node.js`、`Express` 与 `Socket.IO` 的聊天室项目，支持文字、图片、文件发送，并提供管理员后台用于禁言与踢出用户。

## 功能

- 实时聊天功能
- 支持发送图片和文件
- 管理后台 `/admin`
- 管理员可禁言、解除禁言、踢出在线用户
- 在线用户列表展示 IP、用户名和状态
- 通过 `/ping` 端点提供心跳检测，适配 Render 等平台部署

## 项目结构

- `server.js` - 服务端入口，包含 Express 与 Socket.IO 逻辑
- `admin.html` - 管理后台页面
- `public/index.html` - 聊天客户端页面
- `package.json` - 项目依赖与启动脚本
- `readme.md` - 项目说明文档

## 安装

```bash
npm install
```

## 本地运行

```bash
npm start
```

默认监听端口：`33333`。

## 开发模式

```bash
npm run dev
```

> 需要安装 `nodemon`：
>
> ```bash
> npm install -g nodemon
> ```

## 使用说明

打开浏览器访问：

- 聊天客户端：`http://localhost:33333`
- 管理后台：`http://localhost:33333/admin`

## 管理后台 API

- `GET /api/users` - 获取当前在线用户列表
- `POST /api/mute` - 禁言用户
- `POST /api/unmute` - 解除禁言
- `POST /api/kick` - 踢出用户
- `GET /ping` - 心跳检测接口

### 管理操作请求体格式

```json
{
  "username": "用户名"
}
```

## 端口与部署

- 默认端口：`33333`
- 支持 `process.env.PORT`，可适配 Render、Heroku 等托管平台

## 注意事项

- 用户信息与禁言、踢出状态均保存在内存中，服务器重启后会丢失
- 踢出后会在 5 分钟内禁止同一用户名再次加入

## 许可证

MIT
