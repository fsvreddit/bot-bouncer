import { TriggerContext, User } from "@devvit/public-api";
import * as protos from "@devvit/protos";
import { UserAboutResponse } from "@devvit/protos/types/devvit/plugin/redditapi/users/users_msg.js";
import { getExtendedDevvit } from "devvit-helpers";

async function getRawUserData (username: string, metadata: protos.Metadata): Promise<UserAboutResponse | undefined> {
    let userAboutResponse: UserAboutResponse | undefined;

    try {
        userAboutResponse = await getExtendedDevvit().redditAPIPlugins.Users.UserAbout({ username }, metadata);
    } catch (error) {
        if (error instanceof Error && (error.message.includes("404 Not Found") || error.message.includes("403 Forbidden"))) {
            return;
        }
        throw error; // Rethrow the error if it's not a 404 or 403
    }

    return userAboutResponse;
}

export interface UserExtended {
    createdAt: Date;
    commentKarma: number;
    displayName?: string;
    hasVerifiedEmail: boolean;
    id: string;
    isAdmin: boolean;
    isGold: boolean;
    isModerator: boolean;
    linkKarma: number;
    nsfw: boolean;
    username: string;
    userDescription?: string;
    isSuspended?: boolean;
}

export async function getUserExtended (username: string, context: TriggerContext): Promise<UserExtended | undefined> {
    const rawUserData = await getRawUserData(username, context.metadata);
    if (!rawUserData?.data) {
        return;
    }

    const userExtendedVal = {
        createdAt: new Date((rawUserData.data.created ?? 0) * 1000),
        commentKarma: rawUserData.data.commentKarma ?? 0,
        displayName: rawUserData.data.subreddit?.title,
        hasVerifiedEmail: rawUserData.data.hasVerifiedEmail ?? false,
        id: `t2_${rawUserData.data.id ?? ""}`,
        isAdmin: rawUserData.data.isEmployee ?? false,
        isGold: rawUserData.data.isGold ?? false,
        isModerator: rawUserData.data.isMod ?? false,
        linkKarma: rawUserData.data.linkKarma ?? 0,
        nsfw: rawUserData.data.subreddit?.over18 ?? false,
        username: rawUserData.data.name ?? "",
        userDescription: rawUserData.data.subreddit?.publicDescription,
        isSuspended: rawUserData.data.isSuspended ?? false,
    };

    return userExtendedVal;
}

export async function getUserExtendedFromUser (user: User, context: TriggerContext): Promise<UserExtended> {
    try {
        const userExtended = await getUserExtended(user.username, context);
        if (userExtended) {
            return userExtended;
        }
    } catch {
        //
    }

    return {
        createdAt: user.createdAt,
        commentKarma: user.commentKarma,
        hasVerifiedEmail: user.hasVerifiedEmail,
        id: user.id,
        isAdmin: user.isAdmin,
        isGold: false,
        isModerator: false,
        linkKarma: user.linkKarma,
        nsfw: user.nsfw,
        username: user.username,
    };
}
