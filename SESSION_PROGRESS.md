# OpenCodex 语音助手开发进度 (2026-06-09)

## 已完成的功能

### 1. 豆包 TTS 修复
- `src/proxy/index.ts` 中 `synthesizeSpeechDoubao` 已修复为 V3 streaming API
- 响应格式是 NDJSON（每行一个 JSON，data 字段是 base64），需要解码拼接
- 修复：`Buffer.from(json.data, 'base64')` 拼接所有 chunks

### 2. 性格注入（System Prompt）
- `voice_settings.json` 中 `voice_system_prompt` 字段
- `opencodex-bar/Sources/OpenCodexBar/AppDelegate.swift` 的 `ask()` 函数中注入
- 格式：`system_prompt + "\n\n用户说：" + user_message`
- 已验证生效（bar 日志有 `[Prompt] System prompt loaded`）

### 3. 会话管理 API（`src/proxy/index.ts`）
- `GET /api/sessions` - 会话列表（扫描 ~/.codex/sessions/ 目录）
- `GET /api/sessions/:id` - 对话详情（解析 rollout JSONL）
- `DELETE /api/sessions/:id` - 删除会话
- `POST /api/sessions/:id/archive` - 归档
- `POST /api/sessions/:id/unarchive` - 取消归档
- `POST /api/sessions/activate` - 激活会话（WebSocket 通知 bar）

### 4. 网关页前端（`src/proxy/dashboard.ts`）
- Tab 切换：网关管理 / 会话管理
- 左边：API 密钥配置（模型名 + URL + Key）+ 添加按钮
- 右边：已配置模型下拉列表
- 语音设置：STT/TTS/VAD/System Prompt
- 会话列表：实时更新，点击查看详情，删除有二次确认
- 保存后 localStorage 记住当前 tab

### 5. 会话管理 API（`src/proxy/index.ts`）
- `GET /api/sessions` - 扫描 ~/.codex/sessions/ 目录返回列表
- `GET /api/sessions/:id` - 解析 rollout JSONL 返回对话记录
- `DELETE /api/sessions/:id` - 删除 rollout 文件和索引
- `POST /api/sessions/:id/archive` - 调用 codex archive
- `POST /api/sessions/:id/unarchive` - 调用 codex unarchive
- `POST /api/sessions/activate` - WebSocket 通知 bar 切换会话
- `GET /api/settings` / `POST /api/settings` - 配置读写

## 未完成 / Bug

### 1. "切换到此会话" WebSocket 不生效
- 服务端 `POST /api/sessions/activate` 能正确发送 `activate_session` 消息
- Bar 的 `WebSocketManager.swift` 已添加 `onActivateSession` 回调
- `AppDelegate.swift` 的 `applicationDidFinishLaunching` 已设置回调
- **问题**：服务端发给了 1 个客户端，但 bar 没收到消息。可能是 bar 的 WebSocket 连接在 listening 时才建立，或者 `handleMessage` 的 switch case 有问题
- 需要调试：bar 的 WebSocket 连接时机 + 消息接收

### 2. 前端 UI 问题
- API 配置区域的紧凑项显示逻辑需要优化
- 保存后 compact 项和输入框的切换逻辑
- 模型下拉列表的更新时机

### 3. 语音模型路由
- `findProvider` 函数逻辑可能需要改进
- 讯飞 API 需要 HMAC 认证（当前只支持 Bearer token）

## 关键文件
- `~/.opencodex/voice_settings.json` - 语音配置（含 system prompt）
- `~/.opencodex/providers.json` - API provider 配置
- `~/.opencodex/custom_model_catalog.json` - 模型目录
- `~/.codex/sessions/` - 会话 rollout 文件
- `~/.codex/session_index.jsonl` - 会话索引
