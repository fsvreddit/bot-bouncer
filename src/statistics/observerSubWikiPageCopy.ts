import { TriggerContext, WikiPage } from "@devvit/public-api";
import { addDays } from "date-fns";
import { getControlSubSettings } from "../settings.js";
import { CONTROL_SUBREDDIT } from "../constants.js";

enum ObserverSubWikiPage {
    BANNED_SUBS = "banned-subreddits",
    COMMENT_KF_CHECKS = "comment-kf-checks-last-hit",
}

export async function handleObserverSubsWikiPageCopy (_: unknown, context: TriggerContext) {
    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    const controlSubSettings = await getControlSubSettings(context);
    if (!controlSubSettings.observerSubreddits?.includes(subredditName)) {
        return;
    }

    for (const page of Object.values(ObserverSubWikiPage)) {
        let wikiPage: WikiPage | undefined;
        try {
            wikiPage = await context.reddit.getWikiPage(subredditName, `statistics/${page}`);
        } catch {
            continue;
        }

        const lastRevisionKey = `observerSubsWikiPageRevision:${page}`;
        const lastRevision = await context.redis.get(lastRevisionKey);
        if (wikiPage.revisionId === lastRevision) {
            continue;
        }

        await context.reddit.updateWikiPage({
            subredditName: CONTROL_SUBREDDIT,
            page: `statistics/${page}`,
            content: wikiPage.content,
            reason: `Updated by ${context.appSlug} based on changes in /r/${subredditName}`,
        });

        console.log(`Updated statistics/${page} in /r/${CONTROL_SUBREDDIT} based on changes in /r/${subredditName}`);

        await context.redis.set(lastRevisionKey, wikiPage.revisionId, { expiration: addDays(new Date(), 7) });
    }
}
