import { JobContext, JSONObject, ScheduledJobEvent } from "@devvit/public-api";
import { getUserStatus } from "./dataStore.js";
import { EvaluateShortTlc } from "./userEvaluation/EvaluateShortTlc.js";
import { CONTROL_SUBREDDIT, EVALUATE_USER, PostFlairTemplate } from "./constants.js";
import { addHours } from "date-fns";
import pluralize from "pluralize";

const evaluators = [
    EvaluateShortTlc,
];

export async function handleControlSubAccountEvaluation (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    const username = event.data?.username as string | undefined;
    const postId = event.data?.postId as string | undefined;
    const run = event.data?.run as number | undefined;

    if (!username || !postId) {
        return;
    }

    const currentStatus = await getUserStatus(username, context);
    if (currentStatus) {
        console.log("Evaluation: User has already been classified");
        return;
    }

    let isBot = false;
    for (const Evaluator of evaluators) {
        const evaluator = new Evaluator(username, context);
        const isABot = await evaluator.evaluate();
        if (isABot) {
            isBot = true;
            console.log(`Evaluator: ${username} appears to be a bot via the evaluator: ${evaluator.name}`);
            break;
        }
    }

    if (!isBot) {
        const nextRunInHours = run === 1 ? 6 : undefined;
        console.log(`Evaluator: ${username} does not appear to be a bot`);
        if (run && nextRunInHours) {
            await context.scheduler.runJob({
                name: EVALUATE_USER,
                runAt: addHours(new Date(), nextRunInHours),
                data: {
                    username,
                    postId,
                    run: run + 1,
                },
            });
            console.log(`Evaluator: Second run for ${username} will be run in ${nextRunInHours} ${pluralize("hour", nextRunInHours)}`);
        }

        return;
    }

    await context.reddit.setPostFlair({
        subredditName: CONTROL_SUBREDDIT,
        postId,
        flairTemplateId: PostFlairTemplate.Banned,
    });

    console.log(`Evaluator: Post flair changed for ${username}`);
}
