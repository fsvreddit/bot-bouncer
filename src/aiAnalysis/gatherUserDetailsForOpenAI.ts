import { Comment, Post, TriggerContext } from "@devvit/public-api";
import { isLinkId } from "@devvit/public-api/types/tid.js";
import { getUserExtended } from "../extendedDevvit.js";
import _ from "lodash";
import { getUserSocialLinks } from "devvit-helpers";

interface PostInfo {
    title: string;
    createdAt: Date;
    url?: string;
}

export async function getUserInfoForOpenAI (username: string, context: TriggerContext) {
    const user = await getUserExtended(username, context);
    const socialLinks = await getUserSocialLinks(username, context.metadata);

    const history = await context.reddit.getCommentsAndPostsByUser({
        username,
        limit: 100,
        sort: "new",
    }).all();

    console.log(`Fetched ${history.length} comments and posts for user ${username}`);

    const postInfoMap: Record<string, PostInfo> = {};
    const uniqueCommentPosts = _.uniq(history.filter(item => item instanceof Comment).map(comment => comment.postId));

    await Promise.all(uniqueCommentPosts.map(async (postId) => {
        let post: Post;
        try {
            post = await context.reddit.getPostById(postId);
        } catch (err) {
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

    return {
        userInfo: {
            ...user,
            socialLinks: socialLinks.map(link => ({ title: link.title, url: link.outboundUrl })),
        },
        history: history.map((item) => {
            if (item instanceof Comment) {
                return {
                    type: "comment",
                    content: item.body,
                    subredditName: item.subredditName,
                    createdAt: item.createdAt,
                    isTopLevel: isLinkId(item.parentId),
                    parentPostInfo: postInfoMap[item.postId],
                };
            } else {
                return {
                    type: "post",
                    title: item.title,
                    content: item.body,
                    subredditName: item.subredditName,
                    createdAt: item.createdAt,
                    url: item.url,
                };
            }
        }),
    };
}
