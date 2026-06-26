import { Router } from 'express';
import { createCheckout, myBookings, myTransactions, cancelBooking } from '../controllers/booking.controller';
import { confirmSession } from '../controllers/stripe.controller';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { checkoutLimiter } from '../middleware/rateLimit';
import { checkoutSchema } from '../validators/schemas';

const router = Router();

router.post('/checkout', requireAuth, checkoutLimiter, validate(checkoutSchema), createCheckout);
router.post('/confirm', requireAuth, confirmSession);
router.get('/mine', requireAuth, myBookings);
router.get('/transactions', requireAuth, myTransactions);
router.patch('/:id/cancel', requireAuth, cancelBooking);

export default router;
