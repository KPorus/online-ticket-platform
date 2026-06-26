import { Router } from 'express';
import { register, login, googleAuth, me, logout } from '../controllers/auth.controller';
import { validate } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimit';
import { registerSchema, loginSchema, googleSchema } from '../validators/schemas';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), register);
router.post('/login', authLimiter, validate(loginSchema), login);
router.post('/google', authLimiter, validate(googleSchema), googleAuth);
router.get('/me', requireAuth, me);
router.post('/logout', logout);

export default router;
