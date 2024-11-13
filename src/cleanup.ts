import { TriggerContext } from "@devvit/public-api";
import { addDays } from "date-fns";

const CLEANUP_LOG = "CleanupLog";
const DAYS_BETWEEN_CHECKS = 28;

export async function setCleanupForUser (username: string, context: TriggerContext) {
    await context.redis.zAdd(CLEANUP_LOG, { member: username, score: addDays(new Date(), DAYS_BETWEEN_CHECKS).getTime() });
}
