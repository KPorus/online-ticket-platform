<div align="center">
  <img src="../jatri-logo.svg" alt="Jatri" width="280" />
  <h1>Jatri — System Architecture & Engineering Notes</h1>
  <p><em>Real-time, multi-modal travel ticketing for Bangladesh.</em></p>
</div>

---

## 1. Overview

**Jatri** (যাত্রী — _"passenger"_) is a full-stack platform for booking **bus, train, launch, and plane**
tickets across Bangladesh. Its defining characteristic is a **live, conflict-free seat-selection
engine**: many users (and even unauthenticated guests) can browse the same trip simultaneously, and the
seat map updates in real time so two people can never pay for the same seat.

The system is split into two deployables:

| Tier | Stack | Responsibility |
|------|-------|----------------|
| **Client** (`client/`) | Next.js 15 (App Router), React 19, TypeScript, Tailwind | UI, dashboards, real-time seat map, checkout redirect |
| **Server** (`server/`) | Node + Express, TypeScript, MongoDB/Mongoose, Socket.io | REST API, WebSocket seat locking, cron hold release, Stripe |

---

## 2. High-Level System Architecture

```mermaid
flowchart TB
    subgraph Client["🖥️  Client — Next.js (App Router)"]
        UI["Pages & Components<br/>(SeatMap, Dashboards, Search)"]
        AX["axios api client<br/>(JWT interceptor)"]
        WS["socket.io-client"]
        BA["BetterAuth<br/>(Google OAuth)"]
    end

    subgraph Server["⚙️  Server — Express + Socket.io"]
        REST["REST API<br/>(controllers + zod validation)"]
        SOCK["Socket Gateway<br/>(seat:select / release)"]
        SVC["Domain Services<br/>(seat.service, stripe.service)"]
        CRON["node-cron<br/>releaseHolds (every 1m)"]
        SEC["Security Layer<br/>helmet · cors · rate-limit · JWT"]
    end

    subgraph Data["🗄️  Data & External"]
        DB[("MongoDB<br/>Users · Vehicles · Trips<br/>Seats · Bookings · Transactions")]
        STRIPE["Stripe<br/>(dynamic product + checkout)"]
        IMG["ImgBB<br/>(image hosting)"]
    end

    UI --> AX --> REST
    UI --> WS
    BA -->|OAuth code| REST
    WS <-->|"live seat events"| SOCK
    REST --> SEC --> SVC
    SOCK --> SVC
    SVC --> DB
    CRON --> DB
    CRON -->|"seat:released"| SOCK
    SVC -->|create session| STRIPE
    STRIPE -->|"webhook: checkout.session.completed"| REST
    UI -->|direct upload| IMG

    classDef c fill:#d6f9e7,stroke:#0a9065,color:#094b39;
    classDef s fill:#e0e7ff,stroke:#4338ca,color:#1e1b4b;
    classDef d fill:#fef3c7,stroke:#b45309,color:#7c2d12;
    class UI,AX,WS,BA c;
    class REST,SOCK,SVC,CRON,SEC s;
    class DB,STRIPE,IMG d;
```

### Why two channels (REST **and** WebSocket)?

- **REST** handles request/response work: auth, CRUD for trips/vehicles, creating a checkout, fetching bookings.
- **WebSocket** handles the *broadcast* problem: when one person holds a seat, **everyone watching that trip**
  must see it instantly. Polling would be wasteful and laggy, so Jatri rooms each trip
  (`trip:<id>`) and pushes `seat:locked` / `seat:released` / `seat:booked` events only to interested clients.

---

## 3. Data Model (ER Diagram)

```mermaid
erDiagram
    USER ||--o{ VEHICLE : "assigned (vendor)"
    USER ||--o{ TRIP : "creates (vendor)"
    USER ||--o{ BOOKING : places
    USER ||--o{ TRANSACTION : pays
    VEHICLE ||--o{ TRIP : "runs on"
    TRIP ||--o{ SEAT : "has"
    TRIP ||--o{ BOOKING : "for"
    BOOKING ||--|| TRANSACTION : "settles into"
    BOOKING ||--o{ SEAT : "locks"

    USER {
        string name
        string email UK
        string passwordHash
        enum role "user|vendor|admin"
        enum provider "local|google"
        bool isFraud
    }
    VEHICLE {
        enum type "bus|train|launch|plane"
        string operator
        object seatLayout "rows/cols/aisle/labelStyle"
        objectId assignedVendor
    }
    TRIP {
        string title
        string from
        string to
        date departureAt
        number pricePerSeat
        bool isAdvertised
    }
    SEAT {
        objectId trip
        string seatNumber
        enum status "available|held|booked"
        string holderId
        date holdExpiresAt
    }
    BOOKING {
        objectId user
        string[] seatNumbers
        number totalPrice
        enum status "pending|paid|expired|cancelled"
        date holdExpiresAt
        string stripeSessionId
    }
    TRANSACTION {
        string transactionId
        string stripeSessionId
        number amount
        string currency
        date paymentDate
    }
```

**Key index design** — the seat collection carries a **compound unique index** `{ trip, seatNumber }`
(one physical seat per trip) plus secondary indexes on `status` and `holdExpiresAt` so both the
real-time hold query and the cron sweep stay fast.

---

## 4. Activity Diagram — Real-time Seat Hold (the core)

The hold is performed with a **single atomic `findOneAndUpdate`**. The query condition itself encodes
the business rule, so concurrent requests can never both succeed — the database, not the application,
is the arbiter.

```mermaid
flowchart TD
    A([User taps a seat]) --> B["client emits<br/>seat:select {tripId, seatNumber, holderId}"]
    B --> C{"Atomic findOneAndUpdate:<br/>status = available<br/>OR held by me<br/>OR hold expired"}
    C -- "matched (won)" --> D["Seat -> held<br/>holderId + holdExpiresAt = now+5m"]
    C -- "no match (lost)" --> E["emit seat:unavailable<br/>to this socket only"]
    D --> F["broadcast seat:locked<br/>to room trip:&lt;id&gt;"]
    F --> G["All other clients grey the seat"]
    E --> H["Show toast: 'Seat already taken'"]
    G --> I([Seat reserved for 5 min])
    H --> J([User picks another seat])
```

> The matching condition `available OR (held by me) OR (hold expired)` is what makes the operation
> **idempotent and self-healing**: re-selecting your own seat refreshes the hold, and a stale hold from a
> user who left is automatically reclaimable without any cleanup step.

---

## 5. Activity Diagram — Guest → Booking → Payment

Login is deferred until the **payment step**, lowering friction during browsing and seat selection.

```mermaid
sequenceDiagram
    autonumber
    participant G as Guest (browser)
    participant W as WebSocket
    participant API as REST API
    participant DB as MongoDB
    participant S as Stripe

    G->>W: seat:select (guestId)
    W->>DB: atomic hold (holderId = guestId)
    W-->>G: seat:locked (5-min hold)
    Note over G: Clicks "Proceed to Pay"
    G->>API: login / register  (JWT issued)
    G->>API: POST /bookings/checkout (tripId, seats, guestId)
    API->>DB: verify seats still held by user/guest
    API->>DB: transfer hold -> userId, create Booking(pending)
    API->>S: create Product + Price + Checkout Session
    S-->>API: session.url
    API-->>G: redirect URL
    G->>S: completes card payment
    S-->>API: webhook checkout.session.completed
    API->>DB: Booking -> paid, Seats -> booked, write Transaction
    API->>W: broadcast seat:booked
    W-->>G: seat map shows booked
```

If the user abandons checkout, no webhook fires — the **cron job** below reclaims the seat.

---

## 6. Activity Diagram — Cron Hold-Release (anti-deadlock)

```mermaid
flowchart LR
    T(["⏱ every 60s (node-cron)"]) --> Q["find Seats where<br/>status=held AND holdExpiresAt < now"]
    Q --> Z{"any expired?"}
    Z -- no --> Stop([return])
    Z -- yes --> U1["Seats -> available<br/>clear holder + expiry"]
    U1 --> U2["Bookings(pending, expired) -> expired"]
    U2 --> GP["group released seats by trip"]
    GP --> B["emit seat:released per trip room"]
    B --> End([UIs free the seats live])
```

This guarantees the system can never **deadlock on inventory**: a seat held by someone who closed their
tab is guaranteed to return to the pool within ~1 minute, and every watching client is told immediately.

---

## 7. Roles & Authorization Flow

```mermaid
flowchart TD
    R([Request]) --> EX["extract token<br/>(Authorization: Bearer / cookie)"]
    EX --> V{valid JWT?}
    V -- no --> P{route public?}
    P -- yes --> OK1([handler runs as guest])
    P -- no --> D1([401 Unauthorized])
    V -- yes --> RB{requireRole?}
    RB -- "none" --> OK2([handler runs])
    RB -- "role ok" --> OK3([handler runs])
    RB -- "role mismatch" --> D2([403 Forbidden])
```

| Role | Can do |
|------|--------|
| **User** | Browse, hold seats, book & pay, view own bookings/transactions, cancel pending |
| **Vendor** | Everything a user can + create/manage trips on **assigned** vehicles, view revenue |
| **Admin** | Manage users, create/assign vehicles to vendors, advertise trips, flag fraud |

Two auth strategies coexist: **email/password** issues a custom JWT (`jsonwebtoken` + `bcrypt`), while
**Google** sign-in is brokered by BetterAuth on the client and exchanged for the same app JWT — so the
rest of the API is auth-mechanism agnostic.

---

## 8. Request/Realtime Lifecycle Summary

```mermaid
flowchart LR
    subgraph Browse
        a1[Search From→To] --> a2[List trips: filter/sort/paginate]
    end
    subgraph Select
        b1[Open trip] --> b2[Join socket room] --> b3[Hold seats atomically]
    end
    subgraph Pay
        c1[Login at checkout] --> c2[Create pending booking] --> c3[Stripe Checkout]
    end
    subgraph Settle
        d1[Webhook / confirm] --> d2[Booking paid + Seats booked] --> d3[Transaction recorded]
    end
    a2 --> b1
    b3 --> c1
    c3 --> d1
```

See the root [`README.md`](../README.md) for the full feature list and engineering techniques, and
[`server/README.md`](../server/README.md) / [`client/README.md`](../client/README.md) for tier-specific
setup and API references.
