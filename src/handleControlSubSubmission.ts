import { TriggerContext } from "@devvit/public-api";
import { PostCreate } from "@devvit/protos";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "./constants.js";
import { getUsernameFromUrl, isModerator } from "./utility.js";
import { getUserStatus, UserDetails, UserStatus } from "./dataStore.js";
import { subMonths } from "date-fns";
import { getControlSubSettings } from "./settings.js";
import { createNewSubmission } from "./postCreation.js";
import { getUserExtended, UserExtended } from "./extendedDevvit.js";

export async function handleControlSubSubmission (event: PostCreate, context: TriggerContext) {
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

    const controlSubSettings = await getControlSubSettings(context);
    if (controlSubSettings.reporterBlacklist.includes(event.author.name)) {
        submissionResponse = "You are not currently permitted to submit bots to r/BotBouncer. Please write in to modmail if you believe this is a mistake";
    }

    const submitterStatus = await getUserStatus(event.author.name, context);
    if (submitterStatus && submitterStatus.userStatus === UserStatus.Banned) {
        submissionResponse = "You are currently listed as a bot on r/BotBouncer, so we cannot accept submissions from you. Please write in to modmail if you believe this is a mistake";
    }

    let user: UserExtended | undefined;
    if (username) {
        user = await getUserExtended(username, context);
    }

    if (!user && !submissionResponse) {
        submissionResponse = `Hi, thanks for your submission.\n\n${username} appears to be deleted, suspended or shadowbanned already, so no post will be created for it.`;
    }

    if (user?.username === event.author.name) {
        submissionResponse = "Hi, thanks for your submission.\n\nYou cannot make a submission for yourself.";
    }

    if (user) {
        const userContent = await context.reddit.getCommentsAndPostsByUser({
            username: user.username,
            limit: 100,
            sort: "new",
        }).all();

        if (userContent.filter(item => item.createdAt > subMonths(new Date(), controlSubSettings.maxInactivityMonths ?? 3)).length === 0) {
            submissionResponse = `Hi, thanks for your submission.\n\n${username} has no recent content on their history, so may be retired. Submissions can only be made for active users.`;
        }
    }

    if (user && !submissionResponse) {
        const currentStatus = await getUserStatus(user.username, context);
        if (currentStatus) {
            const post = await context.reddit.getPostById(currentStatus.trackingPostId);
            submissionResponse = `Hi, thanks for your submission.\n\n${username} is already tracked by Bot Bouncer with a current status of ${currentStatus.userStatus}, you can see the submission [here](${post.permalink}).`;
            if (currentStatus.userStatus === UserStatus.Organic) {
                submissionResponse += `\n\nIf you have information about how this user is a bot that we may have missed, please [modmail us](https://www.reddit.com/message/compose?to=/r/BotBouncer&subject=More%20information%20about%20/u/${user.username}) with the details, so that we can review again.`;
            }
        } else {
            const newStatus = controlSubSettings.trustedSubmitters.includes(event.author.name) ? UserStatus.Banned : UserStatus.Pending;

            const newDetails: UserDetails = {
                userStatus: newStatus,
                lastUpdate: new Date().getTime(),
                submitter: event.author.name,
                operator: context.appName,
                trackingPostId: "",
            };

            const newPost = await createNewSubmission(user, newDetails, context);

            console.log(`Created new post for ${username}`);

            submissionResponse = `Hi, thanks for your submission.\n\nThe post tracking ${user.username} can be found [here](${newPost.permalink}).\n\nYour post has been removed, and can be deleted.`;

            await context.scheduler.runJob({
                name: ControlSubredditJob.EvaluateUser,
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
