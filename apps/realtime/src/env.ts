import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: required('DATABASE_URL'),
  wsTicketSecret: required('PRACTICE_WS_TICKET_SECRET'),
  settleSecret: required('PRACTICE_SETTLE_SECRET'),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  allowedOrigins: (process.env.WS_ALLOWED_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
