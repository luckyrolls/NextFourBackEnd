import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { supabase } from './supabase';

export interface FacilityAdmin {
  authUserId: string;
  playerId: string;
  facilityId: string;
  role: 'organizer' | 'owner';
}

const uuidSchema = z.string().uuid();

/**
 * Requires a Supabase JWT (Authorization: Bearer <access token>) belonging to a
 * player who is an active organizer or owner of the facility in req.params[param].
 *
 * The check runs through the secret-key client, so this middleware — not RLS —
 * is the authorization boundary for these endpoints. It intentionally exercises
 * the same identity chain the RLS policies use: auth user -> players.auth_user_id
 * -> facility_members role. On success the identity lands in res.locals.admin.
 */
export function requireFacilityAdmin(param = 'id') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const facilityId = uuidSchema.safeParse(req.params[param]);
    if (!facilityId.success) {
      res.status(400).json({ error: 'invalid_facility_id' });
      return;
    }

    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) {
      res.status(401).json({ error: 'missing_bearer_token' });
      return;
    }

    const { data: userData, error: userError } = await supabase().auth.getUser(token);
    if (userError || !userData.user) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }

    const { data: player, error: playerError } = await supabase()
      .from('players')
      .select('id')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle();
    if (playerError) {
      next(playerError);
      return;
    }
    if (!player) {
      // The signup gap: an auth user with no players row has no identity here.
      res.status(403).json({ error: 'no_player_record' });
      return;
    }

    const { data: membership, error: membershipError } = await supabase()
      .from('facility_members')
      .select('role')
      .eq('facility_id', facilityId.data)
      .eq('player_id', player.id)
      .eq('status', 'active')
      .in('role', ['organizer', 'owner'])
      .maybeSingle();
    if (membershipError) {
      next(membershipError);
      return;
    }
    if (!membership) {
      res.status(403).json({ error: 'not_facility_admin' });
      return;
    }

    const admin: FacilityAdmin = {
      authUserId: userData.user.id,
      playerId: player.id,
      facilityId: facilityId.data,
      role: membership.role as FacilityAdmin['role'],
    };
    res.locals['admin'] = admin;
    next();
  };
}
