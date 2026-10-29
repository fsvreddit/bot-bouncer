import { Context } from "hono";
import { Comment, Post, reddit } from "@devvit/web/server";
import { ReducedComment, ReducedPost } from "@fsvreddit/bot-bouncer-types";

interface ResponseData {
    posts: ReducedPost[];
    comments: ReducedComment[];
}

export const handleGetRecentContentForUser = async (c: Context): Promise<Response> => {
    if (c.req.method !== "GET") {
        return c.json({ error: "Method not allowed" }, 405);
    }

    const username = c.req.param("username");
    if (!username) {
        return c.json({ error: "Username is required" }, 400);
    }

    const [posts, comments] = await Promise.all([
        reddit.getPostsByUser({
            username,
            limit: 100,
            sort: "new",
        }).all(),
        reddit.getCommentsByUser({
            username,
            limit: 100,
            sort: "new",
        }).all(),
    ]);

    return c.json<ResponseData>({
        posts: posts.map(mapPostToReducedPost),
        comments: comments.map(mapCommentToReducedComment),
    }, 200);
};

function mapPostToReducedPost (post: Post): ReducedPost {
    return {
        id: post.id,
        createdAt: post.createdAt.getTime(),
        subredditName: post.subredditName,
        nsfw: post.nsfw,
        title: post.title,
        body: post.body,
        authorName: post.authorName,
        authorId: post.authorId,
        url: post.url,
        crosspostParentId: post.crosspostParentId,
    };
}

function mapCommentToReducedComment (comment: Comment): ReducedComment {
    return {
        id: comment.id,
        createdAt: comment.createdAt.getTime(),
        subredditName: comment.subredditName,
        postId: comment.postId,
        authorName: comment.authorName,
        authorId: comment.authorId,
    };
}
