import { TriggerContext, User } from "@devvit/public-api";
import { PostCreate } from "@devvit/protos";
import { CONTROL_SUBREDDIT, EVALUATE_USER, PostFlairTemplate } from "./constants.js";
import { getUsernameFromUrl, getUserOrUndefined, isModerator } from "./utility.js";
import { getUserStatus, setUserStatus, UserStatus } from "./dataStore.js";

export async function handleBackroomSubmission (event: PostCreate, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    if (!event.post || !event.author) {
        return;
    }

    if (event.author.name === context.appName) {
        if (event.post.spam) {
            await context.reddit.approve(event.post.id);
        }
        return;
    }

    let submissionResponse: string | undefined;

    const username = getUsernameFromUrl(event.post.url);

    if (!username) {
        if (await isModerator(event.author.name, context)) {
            // Allow mods to make meta submissions
            return;
        }

        submissionResponse = "Hi, thanks for your submission.\n\nOnly links to user accounts are permitted here.";
    }

    let user: User | undefined;
    if (username) {
        user = await getUserOrUndefined(username, context);
    }

    if (!user && !submissionResponse) {
        submissionResponse = `Hi, thanks for your submission.\n\n/u/${username} appears to be deleted, suspended or shadowbanned already, so no post will be created for it.`;
    }

    if (user?.username === event.author.name) {
        submissionResponse = `Hi, thanks for your submission.\n\nYou cannot make a submission for yourself.`;
    }

    if (user && !submissionResponse) {
        const currentStatus = await getUserStatus(user.username, context);
        if (currentStatus) {
            const post = await context.reddit.getPostById(currentStatus.trackingPostId);
            submissionResponse = `Hi, thanks for your submission.\n\n/u/${username} is already tracked by Bot Bouncer, you can see the submission [here](${post.permalink}).`;
        } else {
            const newPost = await context.reddit.submitPost({
                subredditName: CONTROL_SUBREDDIT,
                title: `Overview for ${user.username}`,
                url: `https://www.reddit.com/user/${user.username}`,
                flairId: PostFlairTemplate.Pending,
            });

            await setUserStatus(user.username, {
                userStatus: UserStatus.Pending,
                lastUpdate: new Date().getTime(),
                submitter: event.author.name,
                operator: context.appName,
                trackingPostId: newPost.id,
            }, context);

            console.log(`Created new post for ${username}`);

            submissionResponse = `Hi, thanks for your submission.\n\nThe post tracking ${user.username} can be found [here](${newPost.permalink}).`;

            await context.scheduler.runJob({
                name: EVALUATE_USER,
                runAt: new Date(),
                data: {
                    username: user.username,
                    postId: newPost.id,
                },
            });
        }
    }

    if (submissionResponse) {
        const newComment = await context.reddit.submitComment({
            id: event.post.id,
            text: submissionResponse,
        });
        await newComment.distinguish(true);
    }

    await context.reddit.remove(event.post.id, false);
}
