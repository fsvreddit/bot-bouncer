import { TriggerContext, WikiPage } from "@devvit/public-api";
import { addDays } from "date-fns";
import { getControlSubSettings } from "../settings.js";
import { CONTROL_SUBREDDIT } from "../constants.js";

const WIKI_PAGE_NAME = "statistics/banned-subreddits";

export async function handleBannedSubredditsModAction (_: unknown, context: TriggerContext) {
    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

    const lastRevisionKey = "bannedSubredditsLastRevision";
    const lastRevision = await context.redis.get(lastRevisionKey);

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, WIKI_PAGE_NAME);
    } catch {
        return;
    }

    if (wikiPage.revisionId === lastRevision) {
        return;
    }

    const controlSubSettings = await getControlSubSettings(context);
    if (!controlSubSettings.observerSubreddits?.includes(subredditName)) {
        return;
    }

    await context.reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: WIKI_PAGE_NAME,
        content: wikiPage.content,
        reason: `Updated by ${context.appName} based on changes in /r/${subredditName}`,
    });

    console.log(`Updated ${WIKI_PAGE_NAME} in /r/${CONTROL_SUBREDDIT} based on changes in /r/${subredditName}`);

    await context.redis.set(lastRevisionKey, wikiPage.revisionId, { expiration: addDays(new Date(), 7) });
}
