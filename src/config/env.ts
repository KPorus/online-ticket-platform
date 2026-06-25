import dotenv from 'dotenv';

dotenv.config();

function required(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const env = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: required('MONGODB_URI'),
  jwtSecret: required('JWT_SECRET', 'dev_secret_change_me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  imgbbKey: process.env.IMGBB_KEY || '',
  seedAdminEmail: process.env.SEED_ADMIN_EMAIL || 'admin@jatri.com',
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD || 'Admin@1234',
  holdMinutes: 5,
};
