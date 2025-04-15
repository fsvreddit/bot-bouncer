import { Comment, Post, TriggerContext } from "@devvit/public-api";
import { setUserStatus, UserDetails, UserStatus } from "./dataStore.js";
import { CONTROL_SUBREDDIT, PostFlairTemplate } from "./constants.js";
import { subDays } from "date-fns";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";
import { uniq } from "lodash";
import { UserExtended } from "./extendedDevvit.js";

export const statusToFlair: Record<UserStatus, PostFlairTemplate> = {
    [UserStatus.Pending]: PostFlairTemplate.Pending,
    [UserStatus.Banned]: PostFlairTemplate.Banned,
    [UserStatus.Service]: PostFlairTemplate.Service,
    [UserStatus.Organic]: PostFlairTemplate.Organic,
    [UserStatus.Purged]: PostFlairTemplate.Purged,
    [UserStatus.Retired]: PostFlairTemplate.Retired,
    [UserStatus.Declined]: PostFlairTemplate.Declined,
    [UserStatus.Inactive]: PostFlairTemplate.Inactive,
};

export async function createNewSubmission (user: UserExtended, details: UserDetails, context: TriggerContext): Promise<Post> {
    let history: (Post | Comment)[] | undefined;
    try {
        history = await context.reddit.getCommentsAndPostsByUser({
            username: user.username,
            limit: 100,
            sort: "new",
        }).all();
    } catch {
        // User is likely shadowbanned.
    }

    if (history) {
        const recentHistory = history.filter(item => item.createdAt > subDays(new Date(), 14));
        details.recentPostSubs = uniq(recentHistory.filter(item => isLinkId(item.id)).map(item => item.subredditName));
        details.recentCommentSubs = uniq(recentHistory.filter(item => isCommentId(item.id)).map(item => item.subredditName));
    }

    details.bioText = user.userDescription;

    const newPost = await context.reddit.submitPost({
        subredditName: CONTROL_SUBREDDIT,
        title: `Overview for ${user.username}`,
        url: `https://www.reddit.com/user/${user.username}`,
        flairId: statusToFlair[details.userStatus],
        nsfw: user.nsfw,
    });

    details.trackingPostId = newPost.id;

    await setUserStatus(user.username, details, context);

    return newPost;
}
