import { TriggerContext } from "@devvit/public-api";
import { ModAction } from "@devvit/protos";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { removeRecordOfBan } from "./dataStore.js";

export async function handleModAction (event: ModAction, context: TriggerContext) {
    if (event.action !== "unbanuser" || !event.targetUser || context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    await removeRecordOfBan([event.targetUser.name], context);
}
