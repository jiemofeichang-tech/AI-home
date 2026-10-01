import { query } from './db';
import { active,adminAccess,human } from './permissions';
import type { Actor } from '../shared/contracts';
import type { AdminStatsSnapshot } from '../shared/admin-stats';

const ONLINE_WINDOW_MINUTES=5;
const STATS_TIME_ZONE='Asia/Shanghai';

/** Only the browser heartbeat calls this; API/Agent traffic is not presence. */
export async function recordPresence(actor:Actor):Promise<{ok:true}> {
  human(actor);
  await active(actor);
  await query(`UPDATE profiles SET last_seen_at=now()
    WHERE user_id=$1 AND NOT banned AND deleted_at IS NULL
      AND (last_seen_at IS NULL OR last_seen_at<now()-interval '30 seconds'
        OR last_seen_at < (date_trunc('day',now() AT TIME ZONE $2) AT TIME ZONE $2))`,
  [actor.userId,STATS_TIME_ZONE]);
  return {ok:true};
}

export async function adminStats(actor:Actor):Promise<AdminStatsSnapshot> {
  await active(actor);
  await adminAccess(actor);
  // Aggregate the whole population, independently of the capped management list.
  // Use the database clock and an explicit day boundary on every deployment.
  const [stats]=await query(`SELECT
    count(*)::int AS "totalUsers",
    count(*) FILTER (WHERE NOT banned AND last_seen_at>=now()-($1*interval '1 minute') AND last_seen_at<=now())::int AS "onlineUsers",
    count(*) FILTER (WHERE NOT banned AND last_seen_at>=(date_trunc('day',now() AT TIME ZONE $2) AT TIME ZONE $2) AND last_seen_at<=now())::int AS "activeToday",
    count(*) FILTER (WHERE created_at>=(date_trunc('day',now() AT TIME ZONE $2) AT TIME ZONE $2) AND created_at<=now())::int AS "newToday",
    now() AS "asOf"
    FROM profiles WHERE deleted_at IS NULL`,[ONLINE_WINDOW_MINUTES,STATS_TIME_ZONE]);
  return {
    totalUsers:stats.totalUsers,onlineUsers:stats.onlineUsers,
    activeToday:stats.activeToday,newToday:stats.newToday,
    onlineWindowMinutes:ONLINE_WINDOW_MINUTES,
    asOf:new Date(stats.asOf).toISOString(),timeZone:STATS_TIME_ZONE
  };
}
