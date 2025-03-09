import { Post, TriggerContext, User } from "@devvit/public-api";
import { setUserStatus, UserDetails, UserStatus } from "./dataStore.js";
import { CONTROL_SUBREDDIT, PostFlairTemplate } from "./constants.js";
import { getExtendedDevvit } from "./extendedDevvit.js";
import { UserAboutResponse } from "@devvit/protos/types/devvit/plugin/redditapi/users/users_msg.js";

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

export async function createNewSubmission (user: User, details: UserDetails, context: TriggerContext): Promise<Post> {
    let userExtended: UserAboutResponse | undefined;
    try {
        userExtended = await getExtendedDevvit().redditAPIPlugins.Users.UserAbout({ username: user.username }, context.debug.metadata);
    } catch {
        // Error retrieving user history, likely shadowbanned.
    }

    const newPost = await context.reddit.submitPost({
        subredditName: CONTROL_SUBREDDIT,
        title: `Overview for ${user.username}`,
        url: `https://www.reddit.com/user/${user.username}`,
        flairId: statusToFlair[details.userStatus],
        nsfw: user.nsfw ? user.nsfw : userExtended?.data?.over18 ?? userExtended?.data?.subreddit?.over18,
    });

    details.trackingPostId = newPost.id;

    await setUserStatus(user.username, details, context);

    return newPost;
}
