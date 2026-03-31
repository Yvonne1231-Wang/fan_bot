---
name: lark-im
version: 1.0.0
description: "飞书即时通讯：收发消息和管理群聊。发送和回复消息、搜索聊天记录、管理群聊成员、上传下载图片和文件、管理表情回复。当用户需要发消息、查看或搜索聊天记录、下载聊天中的文件、查看群成员时使用。"
metadata:
  requires:
    bins: ["lark-cli"]
  cliHelp: "lark-cli im --help"
---

# im (v1)

**CRITICAL — 开始前 MUST 先用 Read 工具读取 [`../lark-shared/SKILL.md`](../lark-shared/SKILL.md)，其中包含认证、权限处理**

## Core Concepts

- **Message**: A single message in a chat, identified by `message_id` (om_xxx). Supports types: text, post, image, file, audio, video, sticker, interactive (card), share_chat, share_user, merge_forward, etc.
- **Chat**: A group chat or P2P conversation, identified by `chat_id` (oc_xxx).
- **Thread**: A reply thread under a message, identified by `thread_id` (om_xxx or omt_xxx).
- **Reaction**: An emoji reaction on a message.

## Resource Relationships

```
Chat (oc_xxx)
├── Message (om_xxx)
│   ├── Thread (reply thread)
│   ├── Reaction (emoji)
│   └── Resource (image / file / video / audio)
└── Member (user / bot)
```

## Important Notes

### Identity and Token Mapping

- `--as user` means **user identity** and uses `user_access_token`. Calls run as the authorized end user, so permissions depend on both the app scopes and that user's own access to the target chat/message/resource.
- `--as bot` means **bot identity** and uses `tenant_access_token`. Calls run as the app bot, so behavior depends on the bot's membership, app visibility, availability range, and bot-specific scopes.
- If an IM API says it supports both `user` and `bot`, the token type changes who the operator is. The same API can succeed with one identity and fail with the other because owner/admin status, chat membership, tenant boundary, or app availability are checked against the current caller.

### Sender Name Resolution with Bot Identity

When using bot identity (`--as bot`) to fetch messages (e.g. `+chat-messages-list`, `+threads-messages-list`, `+messages-mget`), sender names may not be resolved (shown as open_id instead of display name). This happens when the bot cannot access the user's contact info.

**Root cause**: The bot's app visibility settings do not include the message sender, so the contact API returns no name.

**Solution**: Check the app's visibility settings in the Lark Developer Console — ensure the app's visible range covers the users whose names need to be resolved. Alternatively, use `--as user` to fetch messages with user identity, which typically has broader contact access.

### Card Messages (Interactive)

Card messages (`interactive` type) are not yet supported for compact conversion in event subscriptions. The raw event data will be returned instead, with a hint printed to stderr.

## Shortcuts（⚠️ 必须使用 Shortcut）

**重要**：所有常用操作都有对应的 Shortcut 命令，**必须优先使用 Shortcut**，不要使用原生 API。

Shortcut 命令格式：`lark-cli im +<verb> [flags]`（注意 `+` 前缀）

| Shortcut | 说明 | 示例命令 |
|----------|------|----------|
| [`+chat-create`](references/lark-im-chat-create.md) | 创建群聊 | `lark-cli im +chat-create --name "群名"` |
| [`+chat-messages-list`](references/lark-im-chat-messages-list.md) | 获取聊天记录 | `lark-cli im +chat-messages-list --chat-id oc_xxx` |
| [`+chat-search`](references/lark-im-chat-search.md) | 搜索群聊 | `lark-cli im +chat-search --query "关键词"` |
| [`+chat-update`](references/lark-im-chat-update.md) | 更新群信息 | `lark-cli im +chat-update --chat-id oc_xxx --name "新名称"` |
| [`+messages-mget`](references/lark-im-messages-mget.md) | 批量获取消息 | `lark-cli im +messages-mget --ids om_xxx,om_yyy` |
| [`+messages-reply`](references/lark-im-messages-reply.md) | 回复消息 | `lark-cli im +messages-reply --message-id om_xxx --text "回复内容"` |
| [`+messages-resources-download`](references/lark-im-messages-resources-download.md) | 下载图片/文件 | `lark-cli im +messages-resources-download --message-id om_xxx --file-key file_xxx --type file` |
| [`+messages-search`](references/lark-im-messages-search.md) | 搜索消息 | `lark-cli im +messages-search --query "关键词"` |
| [`+messages-send`](references/lark-im-messages-send.md) | 发送消息 | `lark-cli im +messages-send --chat-id oc_xxx --text "消息内容"` |
| [`+threads-messages-list`](references/lark-im-threads-messages-list.md) | 获取话题消息 | `lark-cli im +threads-messages-list --thread omt_xxx` |

### 常见错误

| ❌ 错误命令 | ✅ 正确命令 |
|------------|------------|
| `lark-cli im messages --chat-id oc_xxx` | `lark-cli im +chat-messages-list --chat-id oc_xxx` |
| `lark-cli im chats list` | `lark-cli im +chat-search --query ""` |
| `lark-cli im messages send --chat-id oc_xxx` | `lark-cli im +messages-send --chat-id oc_xxx --text "内容"` |

## 原生 API（仅当没有对应 Shortcut 时使用）

```bash
lark-cli schema im.<resource>.<method>   # 调用 API 前必须先查看参数结构
lark-cli im <resource> <method> [flags]  # 调用 API
```

> **警告**：原生 API 格式为 `lark-cli im <resource> <method>`，没有 `+` 前缀。使用前必须先运行 `schema` 查看参数结构。

### chats

  - `create` — 创建群。Identity: `bot` only (`tenant_access_token`).
  - `get` — 获取群信息。Identity: supports `user` and `bot`; the caller must be in the target chat to get full details, and must belong to the same tenant for internal chats.
  - `link` — 获取群分享链接。Identity: supports `user` and `bot`; the caller must be in the target chat, must be an owner or admin when chat sharing is restricted to owners/admins, and must belong to the same tenant for internal chats.
  - `list` — 获取用户或机器人所在的群列表。Identity: supports `user` and `bot`.
  - `update` — 更新群信息。Identity: supports `user` and `bot`.

### chat.members

  - `create` — 将用户或机器人拉入群聊。Identity: supports `user` and `bot`; the caller must be in the target chat; for `bot` calls, added users must be within the app's availability; for internal chats the operator must belong to the same tenant; if only owners/admins can add members, the caller must be an owner/admin, or a chat-creator bot with `im:chat:operate_as_owner`.
  - `get` — 获取群成员列表。Identity: supports `user` and `bot`; the caller must be in the target chat and must belong to the same tenant for internal chats.

### messages

  - `delete` — 撤回消息。Identity: supports `user` and `bot`; for `bot` calls, the bot must be in the chat to revoke group messages; to revoke another user's group message, the bot must be the owner, an admin, or the creator; for user P2P recalls, the target user must be within the bot's availability.
  - `forward` — 转发消息。Identity: `bot` only (`tenant_access_token`).
  - `merge_forward` — 合并转发消息。Identity: `bot` only (`tenant_access_token`).
  - `read_users` — 查询消息已读信息。Identity: `bot` only (`tenant_access_token`); the bot must be in the chat, and can only query read status for messages it sent within the last 7 days.

### reactions

  - `batch_query` — 批量获取消息表情。Identity: supports `user` and `bot`.[Must-read](references/lark-im-reactions.md)
  - `create` — 添加消息表情回复。Identity: supports `user` and `bot`; the caller must be in the conversation that contains the message.[Must-read](references/lark-im-reactions.md)
  - `delete` — 删除消息表情回复。Identity: supports `user` and `bot`; the caller must be in the conversation that contains the message, and can only delete reactions added by itself.[Must-read](references/lark-im-reactions.md)
  - `list` — 获取消息表情回复。Identity: supports `user` and `bot`; the caller must be in the conversation that contains the message.[Must-read](references/lark-im-reactions.md)

### images

  - `create` — 上传图片。Identity: `bot` only (`tenant_access_token`).

### pins

  - `create` — Pin 消息。Identity: supports `user` and `bot`.
  - `delete` — 移除 Pin 消息。Identity: supports `user` and `bot`.
  - `list` — 获取群内 Pin 消息。Identity: supports `user` and `bot`.

## 权限表

| 方法 | 所需 scope |
|------|-----------|
| `chats.create` | `im:chat:create` |
| `chats.get` | `im:chat:read` |
| `chats.link` | `im:chat:read` |
| `chats.list` | `im:chat:read` |
| `chats.update` | `im:chat:update` |
| `chat.members.create` | `im:chat.members:write_only` |
| `chat.members.get` | `im:chat.members:read` |
| `messages.delete` | `im:message:recall` |
| `messages.forward` | `im:message` |
| `messages.merge_forward` | `im:message` |
| `messages.read_users` | `im:message:readonly` |
| `reactions.batch_query` | `im:message.reactions:read` |
| `reactions.create` | `im:message.reactions:write_only` |
| `reactions.delete` | `im:message.reactions:write_only` |
| `reactions.list` | `im:message.reactions:read` |
| `images.create` | `im:resource` |
| `pins.create` | `im:message.pins:write_only` |
| `pins.delete` | `im:message.pins:write_only` |
| `pins.list` | `im:message.pins:read` |

