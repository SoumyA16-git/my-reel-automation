import pino from 'pino';

const isDev = process.env['NODE_ENV'] !== 'production';

const options: pino.LoggerOptions = {
  level: process.env['LOG_LEVEL'] ?? 'info',

  // Redact sensitive fields from all log entries
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.token',
      '*.token_enc',
      '*.password',
      '*.password_hash',
      '*.api_key',
      '*.bot_token',
      '*.master_key',
      '*.csrf_secret',
      '*.totp_secret_enc',
      '*.token_2_enc',
      '*.session_secret',
    ],
    censor: '[REDACTED]',
  },

  // Serialize request/response with safe defaults
  serializers: {
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
    err: pino.stdSerializers.err,
  },
};

if (isDev) {
  options.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  };
}

export const logger = pino(options);

export type Logger = typeof logger;
export type ChildLogger = ReturnType<typeof logger.child>;

