import { Comment, Post, TriggerContext } from "@devvit/public-api";
import { isLinkId } from "@devvit/public-api/types/tid.js";
import { getUserExtended, UserExtended } from "@fsvreddit/fsv-devvit-helpers";
import _ from "lodash";
import { getUserSocialLinks } from "devvit-helpers";
import { getInitialAccountProperties } from "../dataStore.js";
import {
    AIHistoryItem,
    buildHistoryCoverage,
    buildProfileChanges,
    buildPromotionDigest,
    buildReuseDigest,
    ProfileSnapshot,
} from "./evidenceDigests.js";

const CONTENT_LIMIT = 100;

interface PostInfo {
    title: string;
    createdAt: Date;
    url?: string;
}

export interface AIUserInfoResult {
    payload: {
        userInfo: UserExtended & {
            socialLinks: { title: string; url: string }[];
        };
        coverage: ReturnType<typeof buildHistoryCoverage>;
        profileChanges?: ReturnType<typeof buildProfileChanges>;
        promotionDigest?: ReturnType<typeof buildPromotionDigest>;
        reuseDigest?: ReturnType<typeof buildReuseDigest>;
        history: AIHistoryItem[];
    };
    source: {
        user: UserExtended;
        history: (Post | Comment)[];
    };
}

function profileSnapshot (
    bio: string | undefined,
    displayName: string | undefined,
    socialLinkUrls: string[],
): ProfileSnapshot {
    return {
        bio,
        displayName,
        socialLinkUrls: _.uniq(socialLinkUrls.filter(Boolean)),
    };
}

export async function getUserInfoForOpenAI (username: string, context: TriggerContext): Promise<AIUserInfoResult | undefined> {
    try {
        const [user, socialLinks, initialAccountProperties] = await Promise.all([
            getUserExtended(username, context),
            getUserSocialLinks(username, context.metadata),
            getInitialAccountProperties(username, context),
        ]);

        if (!user) {
            return;
        }

        const typedSocialLinks = socialLinks as { title: string; outboundUrl: string }[];

        const history = await context.reddit.getCommentsAndPostsByUser({
            username,
            limit: CONTENT_LIMIT,
            sort: "new",
        }).all();

        const postInfoMap: Record<string, PostInfo> = {};
        let failedParentPostLookups = 0;
        const uniqueCommentPosts = _.uniq(history.filter(item => item instanceof Comment).map(comment => comment.postId));

        await Promise.all(uniqueCommentPosts.map(async (postId) => {
            let post: Post;
            try {
                post = await context.reddit.getPostById(postId);
            } catch (err) {
                failedParentPostLookups++;
                const message = err instanceof Error ? err.message : String(err);
                console.error(`Failed to fetch post info for postId ${postId}:`, message);
                return;
            }

            postInfoMap[postId] = {
                title: post.title,
                createdAt: post.createdAt,
                url: post.url,
            };
        }));

        const serializedHistory: AIHistoryItem[] = history.map((item) => {
            if (item instanceof Comment) {
                return {
                    id: item.id,
                    type: "comment",
                    content: item.body,
                    karma: item.score,
                    subredditName: item.subredditName,
                    createdAt: item.createdAt,
                    postId: item.postId,
                    parentId: item.parentId,
                    isTopLevel: isLinkId(item.parentId),
                    edited: item.edited ? true : undefined,
                    parentPostInfo: postInfoMap[item.postId],
                };
            }

            return {
                id: item.id,
                type: "post",
                title: item.title,
                content: item.body,
                karma: item.score,
                subredditName: item.subredditName,
                createdAt: item.createdAt,
                url: item.url,
                isPinnedToProfile: item.stickied ? true : undefined,
                edited: item.edited ? true : undefined,
                nsfw: item.nsfw ? true : undefined,
            };
        });

        const currentProfile = profileSnapshot(
            user.userDescription,
            user.displayName,
            typedSocialLinks.map(link => link.outboundUrl),
        );
        const originalProfile = profileSnapshot(
            initialAccountProperties.bioText,
            initialAccountProperties.displayName,
            initialAccountProperties.socialLinks.map(link => link.outboundUrl),
        );

        return {
            payload: {
                userInfo: {
                    ...user,
                    socialLinks: typedSocialLinks.map(link => ({ title: link.title, url: link.outboundUrl })),
                },
                coverage: buildHistoryCoverage(serializedHistory, CONTENT_LIMIT, failedParentPostLookups),
                profileChanges: initialAccountProperties.captured
                    ? buildProfileChanges(originalProfile, currentProfile)
                    : undefined,
                promotionDigest: buildPromotionDigest(currentProfile, serializedHistory),
                reuseDigest: buildReuseDigest(serializedHistory),
                history: serializedHistory,
            },
            source: {
                user,
                history,
            },
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        console.error(`Error in getUserInfoForOpenAI for username ${username}:`, errorMessage);
    }
}
