import { Post, TriggerContext } from "@devvit/public-api";
import { setUserStatus, UserDetails, UserStatus } from "./dataStore.js";
import { CONTROL_SUBREDDIT, PostFlairTemplate } from "./constants.js";
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
