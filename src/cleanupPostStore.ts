import { JobContext, JSONObject, Post, ScheduledJobEvent } from "@devvit/public-api";
import { getUserStatus, POST_STORE, UserStatus } from "./dataStore.js";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "./constants.js";
import { addSeconds } from "date-fns";
import { statusToFlair } from "./postCreation.js";

const POST_STORE_DUPLICATES_KEY = "PostStoreDuplicates";

async function queuePostStoreDuplicates (context: JobContext): Promise<boolean> {
    const postStore = await context.redis.hGetAll(POST_STORE);
    const userPosts: Record<string, string[]> = {};
    const duplicateUserPosts: Record<string, string> = {};

    for (const [postId, username] of Object.entries(postStore)) {
        const existingRecord = userPosts[username] ?? [];
        if (existingRecord.length === 0) {
            userPosts[username] = [postId];
        } else {
            userPosts[username].push(postId);
            duplicateUserPosts[username] = JSON.stringify(userPosts[username]);
        }
    }
    if (Object.keys(duplicateUserPosts).length === 0) {
        console.log("Post store duplicates: No duplicate posts found in post store.");
        return false;
    }

    await context.redis.hSet(POST_STORE_DUPLICATES_KEY, duplicateUserPosts);
    console.log(`Post store duplicates: Stored ${Object.keys(duplicateUserPosts).length} duplicate entries for checking.`);
    return true;
}

interface PostDetails {
    postId: string;
    createdAt: Date;
    removed: boolean;
    deleted: boolean;
    status?: UserStatus;
    post: Post;
}

function postToDetails (post: Post): PostDetails {
    return {
        postId: post.id,
        createdAt: post.createdAt,
        removed: post.removed || post.spam,
        deleted: post.authorName === "[deleted]",
        status: post.flair?.text as UserStatus | undefined,
        post,
    };
}

async function deleteRedundantPosts (postDetails: PostDetails[], context: JobContext) {
    const postsToDelete = postDetails.filter(post => !post.deleted);
    if (postsToDelete.length > 0) {
        await Promise.all(postsToDelete.map(postToDelete => postToDelete.post.delete()));
        console.log(`Post store duplicates: Deleted ${postsToDelete.length} redundant posts that were still present.`);
    } else {
        console.log("Post store duplicates: No redundant posts to delete.");
    }

    if (postDetails.length > 0) {
        await context.redis.hDel(POST_STORE, postDetails.map(post => post.postId));
    }
}

async function correctDuplicatePostStore (username: string, postIds: string[], context: JobContext) {
    if (postIds.length <= 1) {
        return;
    }

    const posts = await Promise.all(postIds.map(postId => context.reddit.getPostById(postId)));
    const postDetails = posts.map(postToDetails);
    const currentStatus = await getUserStatus(username, context);
    if (!currentStatus) {
        console.error(`Post store duplicates: No user status found for ${username}, likely deleted/purged user.`);
        await deleteRedundantPosts(postDetails, context);
        return;
    }

    const trackedPost = postDetails.find(post => post.postId === currentStatus.trackingPostId);
    if (trackedPost && !trackedPost.removed && !trackedPost.deleted) {
        // Tracked post exists, and is not removed or deleted
        console.log(`Post store duplicates: Keeping tracked post ${trackedPost.postId} for user ${username}.`);

        if (trackedPost.status !== currentStatus.userStatus) {
            console.log(`Post store duplicates: Tracked post ${trackedPost.postId} for user ${username} has wrong status ${trackedPost.status}. Changing to ${currentStatus.userStatus}.`);
            await context.reddit.setPostFlair({
                subredditName: CONTROL_SUBREDDIT,
                postId: trackedPost.postId,
                flairTemplateId: statusToFlair[currentStatus.userStatus],
            });
        }

        const remainingPosts = postDetails.filter(post => post.postId !== trackedPost.postId);
        await deleteRedundantPosts(remainingPosts, context);
        return;
    }

    // No tracked post, or tracked post is removed/deleted
    const candidatePost = postDetails.find(post => !post.removed && !post.deleted);
    if (!candidatePost) {
        console.error(`Post store duplicates: No valid candidate post found for user ${username}.`);
        return;
    }

    // Check to see if the candidate post has the correct flair
    if (candidatePost.status !== currentStatus.userStatus) {
        console.log(`Post store duplicates: Candidate post ${candidatePost.postId} for user ${username} has wrong status ${candidatePost.status}. Changing to ${currentStatus.userStatus}.`);
        await context.reddit.setPostFlair({
            subredditName: CONTROL_SUBREDDIT,
            postId: candidatePost.postId,
            flairTemplateId: statusToFlair[currentStatus.userStatus],
        });
    }

    // Remove all other records from post store
    const remainingPosts = postDetails.filter(post => post.postId !== candidatePost.postId);
    await deleteRedundantPosts(remainingPosts, context);
}

export async function cleanupPostStore (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (event.data?.firstRun) {
        const entriesQueued = await queuePostStoreDuplicates(context);
        if (!entriesQueued) {
            return;
        }

        await context.scheduler.runJob({
            name: ControlSubredditJob.CleanupPostStore,
            runAt: addSeconds(new Date(), 2),
        });
        return;
    }

    const runLimit = addSeconds(new Date(), 25);

    const postStoreDuplicates = await context.redis.hGetAll(POST_STORE_DUPLICATES_KEY);
    if (Object.keys(postStoreDuplicates).length === 0) {
        console.log("Post store duplicates: No duplicates found in post store.");
        return;
    }

    const users = Object.keys(postStoreDuplicates);
    console.log(`Post store duplicates: Found ${users.length} users with duplicate posts in post store.`);

    while (users.length > 0 && new Date() < runLimit) {
        const username = users.shift();
        if (!username) {
            continue;
        }

        await correctDuplicatePostStore(username, JSON.parse(postStoreDuplicates[username]) as string[], context);
        await context.redis.hDel(POST_STORE_DUPLICATES_KEY, [username]);
    }

    if (users.length > 0) {
        console.log(`Still ${users.length} users with duplicate posts left after cleanup.`);
        await context.scheduler.runJob({
            name: ControlSubredditJob.CleanupPostStore,
            runAt: addSeconds(new Date(), 5),
            data: { firstRun: false },
        });
    } else {
        console.log("Post store duplicates: Cleanup completed successfully.");
    }
}
