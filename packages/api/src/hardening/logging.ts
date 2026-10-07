export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.body.authToken',
  'req.body.uploadToken',
  'req.body.downloadToken',
  'res.body.uploadToken',
  'res.body.downloadToken',
];

export function createLoggerOptions() {
  return {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: { paths: REDACTED_LOG_PATHS, remove: true },
  };
}
