import { Seat } from '../models/Seat';
import { Trip } from '../models/Trip';
import { Vehicle, ISeatLayout } from '../models/Vehicle';
import { env } from '../config/env';

const ALPHA = 'ABCDEFGHIJKL';

export function buildSeatNumbers(layout: ISeatLayout): string[] {
  const seats: string[] = [];
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.columns; c++) {
      if (seats.length >= layout.totalSeats) break;
      if (layout.labelStyle === 'numeric') {
        seats.push(String(r * layout.columns + c + 1));
      } else {
        seats.push(`${ALPHA[r] || `R${r + 1}`}${c + 1}`);
      }
    }
  }
  return seats;
}

export async function generateSeatsForTrip(tripId: string): Promise<void> {
  const trip = await Trip.findById(tripId);
  if (!trip) return;
  const vehicle = await Vehicle.findById(trip.vehicle);
  if (!vehicle) return;
  const seatNumbers = buildSeatNumbers(vehicle.seatLayout);
  const docs = seatNumbers.map((seatNumber) => ({ trip: trip._id, seatNumber, status: 'available' as const }));
  await Seat.insertMany(docs, { ordered: false }).catch(() => undefined);
}

export function holdExpiry(): Date {
  return new Date(Date.now() + env.holdMinutes * 60 * 1000);
}

// Identity-based abuse cap: one holder may only actively hold this many seats per trip.
// Keyed by the browser/user holderId (not IP), so it cannot be bypassed with a VPN.
export const MAX_HOLDS_PER_TRIP = 6;

/** Count seats currently held by this holder on a trip, excluding one seat (the one being (re)selected). */
export async function countActiveHolds(tripId: string, holderId: string, excludeSeat?: string): Promise<number> {
  const filter: Record<string, unknown> = {
    trip: tripId,
    status: 'held',
    holderId,
    holdExpiresAt: { $gt: new Date() },
  };
  if (excludeSeat) filter.seatNumber = { $ne: excludeSeat };
  return Seat.countDocuments(filter);
}

/**
 * Attempt to hold a single seat for holderId. Returns the updated seat or null if it could not be held.
 * Uses an atomic conditional update so concurrent requests cannot both win.
 */
export async function holdSeat(tripId: string, seatNumber: string, holderId: string, holderUser?: string | null) {
  const now = new Date();
  return Seat.findOneAndUpdate(
    {
      trip: tripId,
      seatNumber,
      $or: [
        { status: 'available' },
        { status: 'held', holderId },
        { status: 'held', holdExpiresAt: { $lt: now } },
      ],
    },
    {
      $set: {
        status: 'held',
        holderId,
        holderUser: holderUser || null,
        holdExpiresAt: holdExpiry(),
      },
    },
    { new: true }
  );
}

export async function releaseSeat(tripId: string, seatNumber: string, holderId: string) {
  return Seat.findOneAndUpdate(
    { trip: tripId, seatNumber, status: 'held', holderId },
    { $set: { status: 'available', holderId: null, holderUser: null, holdExpiresAt: null } },
    { new: true }
  );
}
