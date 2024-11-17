import { JobContext, JSONObject, ScheduledJobEvent } from "@devvit/public-api";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { CONTROL_SUBREDDIT, PostFlairTemplate } from "./constants.js";
import { getUserOrUndefined } from "./utility.js";
import { ALL_EVALUATORS } from "./userEvaluation/allEvaluators.js";

export async function handleControlSubAccountEvaluation (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    const username = event.data?.username as string | undefined;
    const postId = event.data?.postId as string | undefined;

    if (!username || !postId) {
        return;
    }

    const currentStatus = await getUserStatus(username, context);
    if (currentStatus && currentStatus.userStatus !== UserStatus.Pending) {
        console.log(`Evaluation: ${username} has already been classified`);
        return;
    }

    const user = await getUserOrUndefined(username, context);
    if (!user) {
        return;
    }

    let userEligible = false;
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator();
        if (evaluator.preEvaluateUser(user)) {
            userEligible = true;
        }
    }

    if (!userEligible) {
        console.log(`Evaluator: ${username} does not pass any user pre-checks.`);
    }

    const userItems = await context.reddit.getCommentsAndPostsByUser({
        username,
        sort: "new",
        limit: 100,
    }).all();

    if (userItems.length < 5) {
        console.log(`Evaluator: ${username} does not have enough content for automatic evaluation.`);
        return;
    }

    let isBot = false;
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator();
        const isABot = evaluator.evaluate(user, userItems);
        if (isABot) {
            isBot = true;
            console.log(`Evaluator: ${username} appears to be a bot via the evaluator: ${evaluator.getName()}`);
            break;
        } else {
            console.log(`${evaluator.getName()} did not match: ${evaluator.getReasons().join(", ")}`);
        }
    }

    if (!isBot) {
        console.log(`Evaluator: ${username} does not appear to be a bot via evaluators.`);
        return;
    }

    await context.reddit.setPostFlair({
        subredditName: CONTROL_SUBREDDIT,
        postId,
        flairTemplateId: PostFlairTemplate.Banned,
    });

    console.log(`Evaluator: Post flair changed for ${username}`);
}
