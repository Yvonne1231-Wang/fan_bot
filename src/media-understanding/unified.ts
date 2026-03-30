import type {
  UnifiedMessage,
  ContentBlock,
  ImageContentBlock,
  FileContentBlock,
} from '../transport/unified.js';
import type { MsgContext } from './types.js';
import { inferMimeType } from './providers/openai.js';

export function unifiedToMsgContext(message: UnifiedMessage): MsgContext {
  const ctx: MsgContext = {
    SessionKey: message.context.sessionId,
    ChatType: message.context.groupId ? 'group' : 'direct',
    IsMainSession: true,
  };

  const mediaPaths: string[] = [];
  const mediaUrls: string[] = [];
  const mediaTypes: string[] = [];

  for (const block of message.content) {
    if (block.type === 'image') {
      const imgBlock = block as ImageContentBlock;
      if (imgBlock.localPath) {
        mediaPaths.push(imgBlock.localPath);
      } else {
        mediaUrls.push(imgBlock.url);
      }
      mediaTypes.push(
        imgBlock.localPath ? inferMimeType(imgBlock.localPath) : 'image/png',
      );
    } else if (block.type === 'file') {
      const fileBlock = block as FileContentBlock;
      if (fileBlock.localPath) {
        mediaPaths.push(fileBlock.localPath);
      } else {
        mediaUrls.push(fileBlock.url);
      }
      mediaTypes.push(fileBlock.mimeType ?? 'application/octet-stream');
    }
  }

  if (mediaPaths.length) ctx.MediaPaths = mediaPaths;
  if (mediaUrls.length) ctx.MediaUrls = mediaUrls;
  if (mediaTypes.length) ctx.MediaTypes = mediaTypes;

  return ctx;
}
