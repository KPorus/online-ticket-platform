import { Router } from 'express';
import {
  createTrip,
  listPublicTrips,
  latestTrips,
  advertisedTrips,
  getTrip,
  getTripSeats,
  myTrips,
  updateTrip,
  deleteTrip,
  listAllTrips,
  toggleAdvertise,
  vendorRevenue,
} from '../controllers/trip.controller';
import { requireAuth, requireRole, optionalAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { createTripSchema, updateTripSchema } from '../validators/schemas';

const router = Router();

// Public
router.get('/', listPublicTrips);
router.get('/latest', latestTrips);
router.get('/advertised', advertisedTrips);

// Vendor
router.get('/mine', requireAuth, requireRole('vendor'), myTrips);
router.get('/revenue', requireAuth, requireRole('vendor'), vendorRevenue);
router.post('/', requireAuth, requireRole('vendor'), validate(createTripSchema), createTrip);

// Admin
router.get('/all', requireAuth, requireRole('admin'), listAllTrips);
router.patch('/:id/advertise', requireAuth, requireRole('admin'), toggleAdvertise);

// Public detail (keep after specific routes to avoid conflicts).
// optionalAuth lets us flag the viewer's own held seats without forcing login.
router.get('/:id', optionalAuth, getTrip);
router.get('/:id/seats', optionalAuth, getTripSeats);

router.patch('/:id', requireAuth, requireRole('vendor', 'admin'), validate(updateTripSchema), updateTrip);
router.delete('/:id', requireAuth, requireRole('vendor', 'admin'), deleteTrip);

export default router;
