# Architecture — NextFour POC

*Last updated: August 2026*

## Stack

- **Mobile app:** Expo (React Native), latest stable SDK. OTP-code auth flow (no deep links), matching the pattern proven in Moosii.
- **Backend:** Node/TypeScript Express on Render.
- **Database:** Supabase (Postgres + Auth + RLS). New dedicated project — do not share the Moosii instance.
- **Dev workflow:** Claude Chat for architecture/planning; Claude Code for implementation. Windows desktop primary, MacBook travel.

## Core design principles

1. **Two truth sources, never conflated.** Clubs like Southcoast already take per-session registration in CourtReserve — that external roster is *attendance truth* for those sessions, and a diverging native RSVP list would destroy trust in the core screen ("NextFour says 5, the desk says 12"). So: `sessions.registration_mode` = `external` | `native`.
   - **External sessions** (club-registered open play): the synced/imported external roster is the attendance list; NextFour layers the social graph on top ("3 of your crew are registered") and, absent API access, native RSVPs are explicitly *intent* ("planning to go") with a deep link to complete registration — labeled so nobody reads intent as roster.
   - **Native sessions** (crew sessions, informal meetups, anything not gated by club registration): NextFour RSVPs ARE the truth. This is where the original native-first principle fully applies.
   - Crews, profiles, feeds, and the relationship graph are native in all cases — that data never comes from, or depends on, the external system.
2. **External-system agnostic — this is an immediate requirement, not a hedge.** Target facility #2 (Island Pickle, Cape Cod) runs PodPlay, not CourtReserve. External IDs are stored as external references, never as our primary keys; `external_system` is an enum from day one. PodPlay has no public API found — for those clubs the native-data path plus whatever admin exports exist is the only route.
3. **One ingestion abstraction, multiple adapters.** All external data flows through a single normalized import pipeline with idempotent upserts. Adapters: (a) CSV/xlsx report upload, (b) CourtReserve API sync worker. Same downstream logic.
4. **No payments, no booking in v1.** Deep-link to the club's CourtReserve portal when a member needs to book or pay. Zero PCI surface, zero displacement conversation.
5. **Graceful degradation.** If an API is revoked or a club stops uploading reports, the app keeps working on native data; roster just ages.

## Data model (v1 entities)

```
facilities        — club profile, timezone, external_system (enum: courtreserve|none|...), portal_url
players           — our identity. Keyed by our UUID. email is the practical join key.
facility_members  — player ↔ facility, role (member|organizer|owner), status,
                    external_ref (CourtReserve member ID if known), skill_level, joined_via
sessions          — an occurrence of play: facility_id, starts_at, ends_at, session_type
                    (open_play|league|clinic|crew_session), skill_band, capacity (nullable),
                    registration_mode (external|native), external_event_ref (nullable),
                    source (native|recurring_template|import)
session_templates — recurring schedule (e.g. "Open Play 3.0–3.5, Tue/Thu 7–9pm"),
                    generates sessions rows ahead on a rolling window
rsvps             — player ↔ session, status (in|out|waitlist|maybe), created_at. NATIVE.
                    On external sessions this represents INTENT, not attendance.
external_registrations — synced/imported roster rows for external sessions:
                    session_id, external_ref or matched player_id, name_raw, synced_at.
                    Attendance truth for registration_mode=external. Fed by API adapter
                    (or event-report import); never user-editable in-app.
crews             — named recurring groups within a facility, owner, visibility (open|invite)
crew_members      — player ↔ crew
imports           — audit of every ingestion run: adapter, file/endpoint, row counts,
                    matched/created/skipped, correlation_id
```

Notes:
- Email matching on import: normalize (lowercase/trim), match to existing `players`; unmatched rows create shadow member records claimable at signup via the same email.
- Skill level: store the club's raw value AND a normalized band; clubs are inconsistent (verify against real export).
- RLS from day one — multi-tenant by facility_id. Do the sweep per-slice, not as a pre-launch scramble (Moosii lesson).

## Ingestion adapters

### Adapter A: report upload (v1 default)
Admin uploads CourtReserve Members Report export (.xlsx). Precedent: Patch Retention and Quke both onboard clubs via this exact workflow, so club admins have muscle memory for it.
- Parse server-side (SheetJS or equivalent), map columns via a per-facility column mapping saved after first upload
- Idempotent upsert keyed on external_ref if present, else normalized email
- Every run writes an `imports` row with correlation_id; log matched/created/skipped counts

### Adapter B: CourtReserve API sync (priority raised — see note)
**Note:** since Southcoast members already register for sessions in CourtReserve, live event-registration sync is what makes the flagship feature ("3 of your crew are registered Thursday") real rather than intent-only. The API is no longer a nice-to-have automation; it's the strongest version of the product. The club's plan tier question is therefore near-gating for the full experience (the intent-mode fallback still ships without it).
- HTTPS/JSON, Basic Auth, Swagger docs at api.courtreserve.com/apihelp
- Location-level API keys, created per-vendor by the club, scopeable read-only and per data area (memberships, events, calendars)
- Plan-gated: requires upper-tier plans (Scale/Enterprise per API docs; naming inconsistent across their help articles — verify current)
- Readable objects: reservations, members, events, transactions (permission-dependent). **Spike must confirm: do event/reservation endpoints expose registrant rosters, and at what freshness?**
- When enabled: scheduled sync worker (roster + upcoming events + event registrations → external_registrations), never writes to CourtReserve in v1

## What we deliberately do NOT build in the POC

- Payments / dues / any money movement
- Court-level booking grid or availability engine
- Chat (start with session RSVP lists + crew feeds; full chat is a slice-gated decision — evaluate whether RSVP visibility alone beats TeamReach)
- Push notification infrastructure beyond Expo's default (needed early-ish, but not slice 1)
- Ratings/rankings (UTR/DUPR territory — integrate later if ever, never compete)

## Open architecture questions (resolve via investigate-and-propose, not upfront)

1. Do CourtReserve exports include a stable member ID column, or is email the only key? (Gate: real export file.)
2. Can the public member-portal calendar be read without API access (iCal/public URL) to auto-populate session templates? Unverified — do not assume.
3. Feed model for crews: activity feed vs. simple message board — decide after watching pilot behavior, not before.
4. What member/roster exports does PodPlay's admin panel offer? (Relevant for Island Pickle onboarding; no public API found. Recon, don't assume.)
5. Southcoast registration behavior: which session types require CourtReserve registration (all open play? paid only?), how far ahead they fill, and whether walk-ups happen anyway. Determines the external/native split of the real schedule.
