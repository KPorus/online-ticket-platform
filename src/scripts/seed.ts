import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { env } from '../config/env';
import { User } from '../models/User';
import { Vehicle, IVehicle } from '../models/Vehicle';
import { Trip } from '../models/Trip';
import { Seat } from '../models/Seat';
import { Booking } from '../models/Booking';
import { Transaction } from '../models/Transaction';
import { generateSeatsForTrip } from '../services/seat.service';

const BD_CITIES = [
  'Dhaka',
  'Chattogram',
  'Sylhet',
  'Khulna',
  'Rajshahi',
  'Barishal',
  'Rangpur',
  'Mymensingh',
  "Cox's Bazar",
  'Cumilla',
];

const ROUTES: Array<{ from: string; to: string }> = [
  { from: 'Dhaka', to: 'Chattogram' },
  { from: 'Dhaka', to: 'Sylhet' },
  { from: 'Dhaka', to: "Cox's Bazar" },
  { from: 'Dhaka', to: 'Khulna' },
  { from: 'Chattogram', to: 'Dhaka' },
  { from: 'Rajshahi', to: 'Dhaka' },
  { from: 'Dhaka', to: 'Barishal' },
  { from: 'Sylhet', to: 'Chattogram' },
];

const IMAGES = [
  'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?w=800&q=80',
  'https://images.unsplash.com/photo-1474487548417-781cb71495f3?w=800&q=80',
  'https://images.unsplash.com/photo-1436491865332-7a61a109cc05?w=800&q=80',
  'https://images.unsplash.com/photo-1517400508447-f8dd518b86db?w=800&q=80',
];

function daysFromNow(days: number, hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

async function run(): Promise<void> {
  await connectDB();
  console.log('[seed] clearing collections...');
  await Promise.all([
    User.deleteMany({}),
    Vehicle.deleteMany({}),
    Trip.deleteMany({}),
    Seat.deleteMany({}),
    Booking.deleteMany({}),
    Transaction.deleteMany({}),
  ]);

  const adminHash = await bcrypt.hash(env.seedAdminPassword, 10);
  const admin = await User.create({
    name: 'Platform Admin',
    email: env.seedAdminEmail,
    passwordHash: adminHash,
    role: 'admin',
    provider: 'local',
    avatar: 'https://i.pravatar.cc/150?img=12',
  });

  const vendorHash = await bcrypt.hash('Vendor@1234', 10);
  const vendor = await User.create({
    name: 'GreenLine Travels',
    email: 'vendor@jatri.com',
    passwordHash: vendorHash,
    role: 'vendor',
    provider: 'local',
    avatar: 'https://i.pravatar.cc/150?img=33',
  });

  const userHash = await bcrypt.hash('User@1234', 10);
  await User.create({
    name: 'Demo User',
    email: 'user@jatri.com',
    passwordHash: userHash,
    role: 'user',
    provider: 'local',
    avatar: 'https://i.pravatar.cc/150?img=5',
  });

  const vehicleConfigs = [
    { type: 'bus' as const, name: 'GreenLine Volvo', operator: 'GreenLine', rows: 10, columns: 4 },
    { type: 'train' as const, name: 'Subarna Express', operator: 'Bangladesh Railway', rows: 12, columns: 4 },
    { type: 'launch' as const, name: 'Sundarban-10', operator: 'Sundarban Navigation', rows: 8, columns: 6 },
    { type: 'plane' as const, name: 'Biman BG-101', operator: 'Biman Bangladesh', rows: 10, columns: 6 },
  ];

  const vehicles: (mongoose.HydratedDocument<IVehicle>)[] = [];
  for (const cfg of vehicleConfigs) {
    const v = await Vehicle.create({
      type: cfg.type,
      name: cfg.name,
      operator: cfg.operator,
      registrationNo: `BD-${cfg.type.toUpperCase()}-${Math.floor(Math.random() * 9000 + 1000)}`,
      seatLayout: {
        rows: cfg.rows,
        columns: cfg.columns,
        aisleAfterColumn: Math.floor(cfg.columns / 2),
        labelStyle: 'alpha-row',
        totalSeats: cfg.rows * cfg.columns,
      },
      assignedVendor: vendor._id,
      images: [IMAGES[vehicles.length % IMAGES.length]],
    });
    vehicles.push(v);
  }

  const perksPool = ['AC', 'WiFi', 'Breakfast', 'Charging Port', 'Blanket', 'Snacks'];
  let advertiseCount = 0;

  for (let i = 0; i < ROUTES.length; i++) {
    const route = ROUTES[i];
    const vehicle = vehicles[i % vehicles.length];
    const trip = await Trip.create({
      title: `${vehicle.operator} ${route.from} to ${route.to}`,
      vehicle: vehicle._id,
      vendor: vendor._id,
      transportType: vehicle.type,
      from: route.from,
      to: route.to,
      departureAt: daysFromNow(i + 2, 8 + (i % 10)),
      arrivalAt: daysFromNow(i + 2, 14 + (i % 6)),
      pricePerSeat: 600 + i * 150,
      totalSeats: vehicle.seatLayout.totalSeats,
      perks: perksPool.slice(0, 2 + (i % 4)),
      images: [IMAGES[i % IMAGES.length]],
      isAdvertised: advertiseCount++ < 6,
    });
    await generateSeatsForTrip(trip._id.toString());
  }

  console.log('[seed] done.');
  console.log('--------------------------------------------------');
  console.log(`Admin:  ${env.seedAdminEmail} / ${env.seedAdminPassword}`);
  console.log('Vendor: vendor@jatri.com / Vendor@1234');
  console.log('User:   user@jatri.com / User@1234');
  console.log(`Cities seeded: ${BD_CITIES.length}, Routes: ${ROUTES.length}, Vehicles: ${vehicles.length}`);
  console.log('--------------------------------------------------');

  await mongoose.connection.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('[seed] error', err);
  process.exit(1);
});
