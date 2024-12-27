import { TriggerContext } from "@devvit/public-api";
import { ModAction } from "@devvit/protos";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { recordWhitelistUnban, removeRecordOfBan } from "./handleClientSubredditWikiUpdate.js";
import { createExternalSubmissionJob } from "./externalSubmissions.js";
import { validateControlSubConfigChange } from "./settings.js";

export async function handleModAction (event: ModAction, context: TriggerContext) {
    /**
     * If a user is unbanned on a client subreddit, remove the record of their ban.
     */
    if (event.action === "unbanuser" && event.moderator?.name !== context.appName && event.targetUser && context.subredditName !== CONTROL_SUBREDDIT) {
        await removeRecordOfBan([event.targetUser.name], context);
        await recordWhitelistUnban(event.targetUser.name, context);
    }

    /**
     * When the wiki gets revised on the control subreddit, it may be because another
     * subreddit has filed in an external submission. Handle that eventuality.
     *
     * It may also be because the control sub configuration has changed, in which case
     * check that too.
     */
    if (event.action === "wikirevise" && context.subredditName === CONTROL_SUBREDDIT) {
        if (event.moderator?.name === context.appName) {
            await createExternalSubmissionJob(context);
        } else if (event.moderator) {
            await validateControlSubConfigChange(event.moderator.name, context);
        }
    }
}
