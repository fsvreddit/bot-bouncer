import { Devvit, TriggerContext } from "@devvit/public-api";
import * as protos from "@devvit/protos";
import { UserAboutResponse } from "@devvit/protos/types/devvit/plugin/redditapi/users/users_msg.js";

export interface RedditAPIPlugins {
    NewModmail: protos.NewModmail;
    Widgets: protos.Widgets;
    ModNote: protos.ModNote;
    LinksAndComments: protos.LinksAndComments;
    Moderation: protos.Moderation;
    GraphQL: protos.GraphQL;
    Listings: protos.Listings;
    Flair: protos.Flair;
    Wiki: protos.Wiki;
    Users: protos.Users;
    PrivateMessages: protos.PrivateMessages;
    Subreddits: protos.Subreddits;
}

export type ExtendedDevvit = typeof Devvit & {
    redditAPIPlugins: RedditAPIPlugins;
};

export function getExtendedDevvit (): ExtendedDevvit {
    return Devvit as ExtendedDevvit; // The Devvit object already has the extended properties, they are simply not reflected in the public type definition.
}

async function getRawUserData (username: string, metadata: protos.Metadata): Promise<UserAboutResponse | undefined> {
    try {
        return await getExtendedDevvit().redditAPIPlugins.Users.UserAbout({ username }, metadata);
    } catch {
        return undefined;
    }
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
}

export async function getUserExtended (username: string, context: TriggerContext): Promise<UserExtended | undefined> {
    const rawUserData = await getRawUserData(username, context.metadata);
    if (!rawUserData?.data) {
        return;
    }

    return {
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
    };
}
