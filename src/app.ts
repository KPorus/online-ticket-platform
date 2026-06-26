import express, { Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import routes from './routes';
import { notFound, errorHandler } from './middleware/error';
import { sanitizeRequest, preventParamPollution } from './middleware/security';
import { stripeWebhook } from './controllers/stripe.controller';

export function createApp(): Application {
  const app = express();

  // Trust the first proxy so req.ip / rate limiting see the real client IP and secure cookies work.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // API serves JSON (and image URLs) to a separate origin; allow cross-origin resource use.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );
  app.use(
    cors({
      origin: env.clientUrl,
      credentials: true,
    })
  );
  app.use(cookieParser());

  // Stripe webhook must receive the raw body, so register it before the JSON parser.
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhook);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Block NoSQL operator injection and HTTP parameter pollution on every parsed request.
  app.use(sanitizeRequest);
  app.use(preventParamPollution);

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api', limiter);

  app.use('/api', routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
