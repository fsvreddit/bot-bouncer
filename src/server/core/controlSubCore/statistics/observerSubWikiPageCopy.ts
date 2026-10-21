import { context, reddit, redis, WikiPage } from "@devvit/web/server";
import { CONTROL_SUBREDDIT, getControlSubSettings } from "../..";
import { addDays } from "date-fns";

enum ObserverSubWikiPage {
    BANNED_SUBS = "banned-subreddits",
    BANNED_SUBS_LIST = "banned-subreddits-list",
    COMMENT_KF_CHECKS = "comment-kf-checks-last-hit",
}

export async function handleObserverSubsWikiPageCopy () {
    const subredditName = context.subredditName;
    const controlSubSettings = await getControlSubSettings();
    if (!controlSubSettings.observerSubreddits?.includes(subredditName)) {
        return;
    }

    for (const page of Object.values(ObserverSubWikiPage)) {
        let wikiPage: WikiPage | undefined;
        try {
            wikiPage = await reddit.getWikiPage(subredditName, `statistics/${page}`, {});
        } catch {
            continue;
        }

        const lastRevisionKey = `observerSubsWikiPageRevision:${page}`;
        const lastRevision = await redis.get(lastRevisionKey);
        if (wikiPage.revisionId === lastRevision) {
            continue;
        }

        await reddit.updateWikiPage({
            subredditName: CONTROL_SUBREDDIT,
            page: `statistics/${page}`,
            content: wikiPage.content,
            reason: `Updated by ${context.appSlug} based on changes in /r/${subredditName}`,
        });

        console.log(`Updated statistics/${page} in /r/${CONTROL_SUBREDDIT} based on changes in /r/${subredditName}`);

        await redis.set(lastRevisionKey, wikiPage.revisionId, { expiration: addDays(new Date(), 7) });
    }
}
