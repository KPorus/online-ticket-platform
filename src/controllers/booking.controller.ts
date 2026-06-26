import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Trip } from '../models/Trip';
import { Seat } from '../models/Seat';
import { Booking } from '../models/Booking';
import { Transaction } from '../models/Transaction';
import { User } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { holdExpiry } from '../services/seat.service';
import { createCheckoutSession } from '../services/stripe.service';
import { emitToTrip } from '../sockets/io';

/**
 * Creates a pending booking from currently-held seats and returns a Stripe Checkout URL.
 * Login is enforced here (requireAuth) even though seat selection is allowed for guests.
 */
export const createCheckout = asyncHandler(async (req: Request, res: Response) => {
  const { tripId, seatNumbers, guestId } = req.body as { tripId: string; seatNumbers: string[]; guestId?: string };
  const userId = req.user!.id;

  const trip = await Trip.findById(tripId);
  if (!trip) throw new ApiError(404, 'Trip not found');
  if (trip.departureAt.getTime() <= Date.now()) {
    throw new ApiError(400, 'This trip has already departed');
  }

  const now = new Date();
  const holderCandidates = [userId, ...(guestId ? [guestId] : [])];

  // Validate that each seat is held by this user or their guest session (and not expired) or already by user.
  const seats = await Seat.find({ trip: tripId, seatNumber: { $in: seatNumbers } });
  if (seats.length !== seatNumbers.length) throw new ApiError(400, 'Some seats do not exist');

  for (const seat of seats) {
    const heldByMe =
      seat.status === 'held' &&
      seat.holderId &&
      holderCandidates.includes(seat.holderId) &&
      seat.holdExpiresAt &&
      seat.holdExpiresAt > now;
    if (!heldByMe) {
      throw new ApiError(409, `Seat ${seat.seatNumber} is no longer available. Please reselect.`);
    }
  }

  const expiresAt = holdExpiry();
  // Transfer the hold to the authenticated user and refresh expiry.
  await Seat.updateMany(
    { trip: tripId, seatNumber: { $in: seatNumbers } },
    { $set: { holderId: userId, holderUser: new Types.ObjectId(userId), holdExpiresAt: expiresAt } }
  );

  const totalPrice = trip.pricePerSeat * seatNumbers.length;
  const booking = await Booking.create({
    user: new Types.ObjectId(userId),
    trip: trip._id,
    seatNumbers,
    totalPrice,
    status: 'pending',
    holdExpiresAt: expiresAt,
  });

  emitToTrip(tripId, 'seat:locked', { seatNumbers });

  const user = await User.findById(userId);
  const session = await createCheckoutSession({
    userId,
    userEmail: user?.email || req.user!.email,
    bookingId: booking._id.toString(),
    tripId: trip._id.toString(),
    ticketTitle: trip.title,
    amount: totalPrice,
    quantity: seatNumbers.length,
  });

  booking.stripeSessionId = session.id;
  await booking.save();

  res.status(201).json({ success: true, bookingId: booking._id, url: session.url });
});

export const myBookings = asyncHandler(async (req: Request, res: Response) => {
  const bookings = await Booking.find({ user: req.user!.id })
    .populate({ path: 'trip', select: 'title from to departureAt pricePerSeat images transportType' })
    .sort({ createdAt: -1 });
  res.json({ success: true, bookings });
});

export const myTransactions = asyncHandler(async (req: Request, res: Response) => {
  const transactions = await Transaction.find({ user: req.user!.id }).sort({ paymentDate: -1 });
  res.json({ success: true, transactions });
});

export const cancelBooking = asyncHandler(async (req: Request, res: Response) => {
  const booking = await Booking.findOne({ _id: req.params.id, user: req.user!.id });
  if (!booking) throw new ApiError(404, 'Booking not found');
  if (booking.status !== 'pending') throw new ApiError(400, 'Only pending bookings can be cancelled');

  booking.status = 'cancelled';
  await booking.save();
  await Seat.updateMany(
    { trip: booking.trip, seatNumber: { $in: booking.seatNumbers }, status: 'held' },
    { $set: { status: 'available', holderId: null, holderUser: null, holdExpiresAt: null } }
  );
  emitToTrip(booking.trip.toString(), 'seat:released', { seatNumbers: booking.seatNumbers });
  res.json({ success: true, message: 'Booking cancelled' });
});
