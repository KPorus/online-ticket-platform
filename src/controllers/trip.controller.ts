import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Trip } from '../models/Trip';
import { Vehicle } from '../models/Vehicle';
import { Seat, ISeat } from '../models/Seat';
import { Booking } from '../models/Booking';
import { User } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { generateSeatsForTrip } from '../services/seat.service';

export const createTrip = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as {
    title: string;
    vehicle: string;
    from: string;
    to: string;
    departureAt: string;
    arrivalAt?: string;
    pricePerSeat: number;
    perks?: string[];
    images?: string[];
  };

  const vehicle = await Vehicle.findById(body.vehicle);
  if (!vehicle) throw new ApiError(404, 'Vehicle not found');
  if (String(vehicle.assignedVendor) !== req.user!.id) {
    throw new ApiError(403, 'This vehicle is not assigned to you');
  }

  const trip = await Trip.create({
    title: body.title,
    vehicle: vehicle._id,
    vendor: new Types.ObjectId(req.user!.id),
    transportType: vehicle.type,
    from: body.from,
    to: body.to,
    departureAt: new Date(body.departureAt),
    arrivalAt: body.arrivalAt ? new Date(body.arrivalAt) : undefined,
    pricePerSeat: body.pricePerSeat,
    totalSeats: vehicle.seatLayout.totalSeats,
    perks: body.perks || [],
    images: body.images && body.images.length ? body.images : vehicle.images,
  });

  await generateSeatsForTrip(trip._id.toString());
  res.status(201).json({ success: true, trip });
});

// Public list with search / filter / sort / pagination
export const listPublicTrips = asyncHandler(async (req: Request, res: Response) => {
  const { from, to, type, sort, page = '1', limit = '9', advertised } = req.query as Record<string, string>;

  const fraudVendors = await User.find({ isFraud: true }).distinct('_id');

  const filter: Record<string, unknown> = {
    isActive: true,
    departureAt: { $gte: new Date() },
    vendor: { $nin: fraudVendors },
  };
  if (from) filter.from = new RegExp(`^${escapeRegex(from)}`, 'i');
  if (to) filter.to = new RegExp(`^${escapeRegex(to)}`, 'i');
  if (type) filter.transportType = type;
  if (advertised === 'true') filter.isAdvertised = true;

  const sortMap: Record<string, Record<string, 1 | -1>> = {
    price_asc: { pricePerSeat: 1 },
    price_desc: { pricePerSeat: -1 },
    latest: { createdAt: -1 },
    departure: { departureAt: 1 },
  };
  const sortBy = sortMap[sort] || { createdAt: -1 };

  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
  const skip = (pageNum - 1) * limitNum;

  const [trips, total] = await Promise.all([
    Trip.find(filter)
      .populate('vendor', 'name email')
      .populate('vehicle', 'name type operator')
      .sort(sortBy)
      .skip(skip)
      .limit(limitNum),
    Trip.countDocuments(filter),
  ]);

  res.json({
    success: true,
    trips,
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
  });
});

export const latestTrips = asyncHandler(async (_req: Request, res: Response) => {
  const fraudVendors = await User.find({ isFraud: true }).distinct('_id');
  const trips = await Trip.find({ isActive: true, departureAt: { $gte: new Date() }, vendor: { $nin: fraudVendors } })
    .populate('vehicle', 'name type operator')
    .sort({ createdAt: -1 })
    .limit(8);
  res.json({ success: true, trips });
});

export const advertisedTrips = asyncHandler(async (_req: Request, res: Response) => {
  const fraudVendors = await User.find({ isFraud: true }).distinct('_id');
  const trips = await Trip.find({
    isActive: true,
    isAdvertised: true,
    departureAt: { $gte: new Date() },
    vendor: { $nin: fraudVendors },
  })
    .populate('vehicle', 'name type operator')
    .limit(6);
  res.json({ success: true, trips });
});

/**
 * Returns a client-safe seat shape. Crucially it exposes a `mine` flag (held by the current
 * viewer - matched by the browser guestId and/or the authenticated user) WITHOUT ever leaking
 * other holders' ids, so a returning user can re-claim and pay for the seats they already hold.
 */
function mapSeatsForViewer(seats: ISeat[], req: Request) {
  const now = Date.now();
  const guestId = typeof req.query.holderId === 'string' ? req.query.holderId.slice(0, 64) : '';
  const userId = req.user?.id;
  return seats.map((s) => {
    const active = s.status === 'held' && !!s.holdExpiresAt && s.holdExpiresAt.getTime() > now;
    const mine =
      active &&
      ((!!guestId && s.holderId === guestId) ||
        (!!userId && (s.holderId === userId || String(s.holderUser) === userId)));
    return {
      _id: s._id,
      seatNumber: s.seatNumber,
      status: s.status,
      holdExpiresAt: s.holdExpiresAt,
      mine,
    };
  });
}

export const getTrip = asyncHandler(async (req: Request, res: Response) => {
  const trip = await Trip.findById(req.params.id)
    .populate('vendor', 'name email')
    .populate('vehicle', 'name type operator seatLayout');
  if (!trip) throw new ApiError(404, 'Trip not found');

  const seatsRaw = await Seat.find({ trip: trip._id }).select('seatNumber status holdExpiresAt holderId holderUser');
  res.json({ success: true, trip, seats: mapSeatsForViewer(seatsRaw, req) });
});

export const getTripSeats = asyncHandler(async (req: Request, res: Response) => {
  const seatsRaw = await Seat.find({ trip: req.params.id }).select('seatNumber status holdExpiresAt holderId holderUser');
  res.json({ success: true, seats: mapSeatsForViewer(seatsRaw, req) });
});

export const myTrips = asyncHandler(async (req: Request, res: Response) => {
  const trips = await Trip.find({ vendor: req.user!.id })
    .populate('vehicle', 'name type operator')
    .sort({ createdAt: -1 });
  res.json({ success: true, trips });
});

export const updateTrip = asyncHandler(async (req: Request, res: Response) => {
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw new ApiError(404, 'Trip not found');
  if (String(trip.vendor) !== req.user!.id && req.user!.role !== 'admin') {
    throw new ApiError(403, 'Not allowed');
  }
  const body = req.body as Record<string, unknown>;
  const fields = ['title', 'from', 'to', 'pricePerSeat', 'perks', 'images', 'isActive'];
  for (const f of fields) if (body[f] !== undefined) (trip as unknown as Record<string, unknown>)[f] = body[f];
  if (body.departureAt) trip.departureAt = new Date(body.departureAt as string);
  if (body.arrivalAt) trip.arrivalAt = new Date(body.arrivalAt as string);
  await trip.save();
  res.json({ success: true, trip });
});

export const deleteTrip = asyncHandler(async (req: Request, res: Response) => {
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw new ApiError(404, 'Trip not found');
  if (String(trip.vendor) !== req.user!.id && req.user!.role !== 'admin') {
    throw new ApiError(403, 'Not allowed');
  }
  await Seat.deleteMany({ trip: trip._id });
  await trip.deleteOne();
  res.json({ success: true, message: 'Trip deleted' });
});

// Admin: list all trips for advertise management
export const listAllTrips = asyncHandler(async (_req: Request, res: Response) => {
  const trips = await Trip.find()
    .populate('vendor', 'name email')
    .populate('vehicle', 'name type')
    .sort({ createdAt: -1 });
  res.json({ success: true, trips });
});

export const toggleAdvertise = asyncHandler(async (req: Request, res: Response) => {
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw new ApiError(404, 'Trip not found');

  if (!trip.isAdvertised) {
    const count = await Trip.countDocuments({ isAdvertised: true });
    if (count >= 6) throw new ApiError(400, 'You cannot advertise more than 6 tickets at a time');
  }
  trip.isAdvertised = !trip.isAdvertised;
  await trip.save();
  res.json({ success: true, trip });
});

// Vendor revenue overview
export const vendorRevenue = asyncHandler(async (req: Request, res: Response) => {
  const vendorId = new Types.ObjectId(req.user!.id);
  const tripIds = await Trip.find({ vendor: vendorId }).distinct('_id');

  const totalTrips = tripIds.length;
  const paidBookings = await Booking.find({ trip: { $in: tripIds }, status: 'paid' });
  const totalSold = paidBookings.reduce((sum, b) => sum + b.seatNumbers.length, 0);
  const totalRevenue = paidBookings.reduce((sum, b) => sum + b.totalPrice, 0);

  const byTrip = await Booking.aggregate([
    { $match: { trip: { $in: tripIds }, status: 'paid' } },
    { $group: { _id: '$trip', revenue: { $sum: '$totalPrice' }, seats: { $sum: { $size: '$seatNumbers' } } } },
    { $lookup: { from: 'trips', localField: '_id', foreignField: '_id', as: 'trip' } },
    { $unwind: '$trip' },
    { $project: { title: '$trip.title', revenue: 1, seats: 1 } },
    { $sort: { revenue: -1 } },
  ]);

  res.json({ success: true, stats: { totalTrips, totalSold, totalRevenue }, byTrip });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
