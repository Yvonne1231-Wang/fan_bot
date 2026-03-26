import Fastify, { FastifyInstance } from 'fastify';
import type {
  HTTPTransportOptions,
  ChatRequest,
  ChatResponse,
  SessionListResponse,
} from './types.js';

export type ChatHandler = (body: ChatRequest) => Promise<ChatResponse>;
export type SessionListHandler = () => Promise<SessionListResponse>;

export type HTTPHandlers = {
  chatHandler?: ChatHandler;
  sessionListHandler?: SessionListHandler;
};

export async function createServer(
  options: HTTPTransportOptions & HTTPHandlers = {},
): Promise<FastifyInstance> {
  const {
    port = 3000,
    host = '0.0.0.0',
    chatHandler,
    sessionListHandler,
  } = options;

  const app = Fastify({ logger: false });

  app.post<{ Body: ChatRequest }>('/chat', async (req, reply) => {
    const { sessionId, message } = req.body;

    if (!message) {
      return reply.status(400).send({ error: 'message is required' });
    }

    try {
      const response = await chatHandler?.({ sessionId, message });
      return reply.send({
        response: response?.response ?? '',
        sessionId: sessionId ?? response?.sessionId ?? '',
        timestamp: Date.now(),
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: errorMessage });
    }
  });

  app.get('/sessions', async (_req, reply) => {
    try {
      const result = await sessionListHandler?.();
      return reply.send({ sessions: result?.sessions ?? [] });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: errorMessage });
    }
  });

  app.get('/health', async (_req, reply) => {
    return reply.send({ status: 'ok', timestamp: Date.now() });
  });

  await app.listen({ port, host });
  console.log(`HTTP server listening on ${host}:${port}`);

  return app;
}

export async function startHTTP(
  options: HTTPTransportOptions & HTTPHandlers = {},
): Promise<void> {
  await createServer(options);
  return new Promise(() => {});
}
