import { JobContext, JSONObject, ScheduledJobEvent, User } from "@devvit/public-api";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { EvaluateShortTlc } from "./userEvaluation/EvaluateShortTlc.js";
import { CONTROL_SUBREDDIT, PostFlairTemplate } from "./constants.js";
import { EvaluateCopyBot } from "./userEvaluation/EvaluateCopyBot.js";
import { EvaluateMixedBot } from "./userEvaluation/EvaluateMixedBot.js";

const evaluators = [
    EvaluateShortTlc,
    EvaluateCopyBot,
    EvaluateMixedBot,
];

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
    if (currentStatus?.userStatus !== UserStatus.Pending) {
        console.log("Evaluation: User has already been classified");
        return;
    }

    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(username);
    } catch {
        //
    }

    if (!user) {
        return;
    }

    const userItems = await context.reddit.getCommentsAndPostsByUser({
        username,
        sort: "new",
        limit: 100,
    }).all();

    let isBot = false;
    for (const Evaluator of evaluators) {
        const evaluator = new Evaluator();
        const isABot = evaluator.evaluate(user, userItems);
        if (isABot) {
            isBot = true;
            console.log(`Evaluator: ${username} appears to be a bot via the evaluator: ${evaluator.getName()}`);
            break;
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
