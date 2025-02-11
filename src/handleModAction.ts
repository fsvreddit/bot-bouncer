import { TriggerContext } from "@devvit/public-api";
import { ModAction } from "@devvit/protos";
import { CONTROL_SUBREDDIT, UPDATE_EVALUATOR_VARIABLES } from "./constants.js";
import { recordWhitelistUnban, removeRecordOfBan } from "./handleClientSubredditWikiUpdate.js";
import { handleExternalSubmissionsPageUpdate } from "./externalSubmissions.js";
import { validateControlSubConfigChange } from "./settings.js";

export async function handleModAction (event: ModAction, context: TriggerContext) {
    if (!event.action) {
        return;
    }

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
        if (event.moderator?.name === context.appName || event.moderator?.name === "bot-bouncer-int") {
            await handleExternalSubmissionsPageUpdate(context);
        } else if (event.moderator) {
            await validateControlSubConfigChange(event.moderator.name, context);
            await context.scheduler.runJob({
                name: UPDATE_EVALUATOR_VARIABLES,
                runAt: new Date(),
                data: { username: event.moderator.name },
            });
        }
    }

    /**
     * If Automod, Reddit or a mod removes a post or comment, ensure that the record of the comment being
     * stored for potential reapproval is removed. While normally the "spam" property should already
     * be set when the CommentCreate or PostCreate trigger is fired, this is a failsafe.
     */
    const actions = ["removecomment", "removelink", "spamcomment", "spamlink"];
    if (actions.includes(event.action) && event.moderator?.name !== context.appName && event.targetUser) {
        await context.redis.del(`removed:${event.targetUser.name}`);
    }
}
