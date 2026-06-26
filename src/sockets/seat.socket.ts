import { Server, Socket } from 'socket.io';
import { holdSeat, releaseSeat, countActiveHolds, MAX_HOLDS_PER_TRIP } from '../services/seat.service';

interface SelectPayload {
  tripId: string;
  seatNumber: string;
  holderId: string;
  userId?: string | null;
}

// Simple in-memory token bucket to throttle seat selection per holder. This is identity-based
// (keyed by the browser/user holderId), so rotating IPs via a VPN does not help an abuser.
const SELECT_MAX = 20;
const SELECT_WINDOW_MS = 10_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

function allowSelect(holderId: string): boolean {
  if (!holderId) return false;
  const now = Date.now();
  const bucket = buckets.get(holderId);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(holderId, { count: 1, resetAt: now + SELECT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= SELECT_MAX) return false;
  bucket.count += 1;
  return true;
}

export function registerSeatSocket(io: Server): void {
  io.on('connection', (socket: Socket) => {
    socket.on('trip:join', (tripId: string) => {
      socket.join(`trip:${tripId}`);
    });

    socket.on('trip:leave', (tripId: string) => {
      socket.leave(`trip:${tripId}`);
    });

    // A user/guest tries to select (hold) a seat.
    socket.on('seat:select', async (payload: SelectPayload, ack?: (res: unknown) => void) => {
      const { tripId, seatNumber, holderId, userId } = payload;
      try {
        if (!allowSelect(holderId)) {
          ack?.({ ok: false, message: 'Too many requests. Please slow down.' });
          return;
        }

        // Enforce the per-holder hold cap (re-selecting an already-held seat is always allowed).
        const others = await countActiveHolds(tripId, holderId, seatNumber);
        if (others >= MAX_HOLDS_PER_TRIP) {
          const msg = { seatNumber, message: `You can hold at most ${MAX_HOLDS_PER_TRIP} seats at a time.` };
          socket.emit('seat:unavailable', msg);
          ack?.({ ok: false, ...msg });
          return;
        }

        const seat = await holdSeat(tripId, seatNumber, holderId, userId);
        if (!seat) {
          const msg = { seatNumber, message: `Seat ${seatNumber} is already taken. Please choose another.` };
          socket.emit('seat:unavailable', msg);
          ack?.({ ok: false, ...msg });
          return;
        }
        // Broadcast to everyone in the room EXCEPT the sender, and never expose the holderId.
        socket.to(`trip:${tripId}`).emit('seat:locked', {
          seatNumbers: [seatNumber],
          holdExpiresAt: seat.holdExpiresAt,
        });
        ack?.({ ok: true, seatNumber, holdExpiresAt: seat.holdExpiresAt });
      } catch {
        ack?.({ ok: false, message: 'Could not select seat' });
      }
    });

    // Release a seat the holder previously selected.
    socket.on('seat:deselect', async (payload: SelectPayload, ack?: (res: unknown) => void) => {
      const { tripId, seatNumber, holderId } = payload;
      try {
        const seat = await releaseSeat(tripId, seatNumber, holderId);
        if (seat) {
          io.to(`trip:${tripId}`).emit('seat:released', { seatNumbers: [seatNumber] });
        }
        ack?.({ ok: true, seatNumber });
      } catch {
        ack?.({ ok: false });
      }
    });
  });
}
