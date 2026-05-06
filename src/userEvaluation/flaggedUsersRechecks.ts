import { JobContext, TriggerContext } from "@devvit/public-api";
import { EvaluateBotGroupAdvanced } from "@fsvreddit/bot-bouncer-evaluation/dist/userEvaluation/EvaluateBotGroupAdvanced.js";
import { UserDetails, UserFlag, UserStatus } from "../dataStore.js";
import { getUserExtended } from "../extendedDevvit.js";
import { getEvaluatorVariables } from "./evaluatorVariables.js";
import { getSummaryForUser } from "../UserSummary/userSummary.js";
import json2md from "json2md";
import { markdownToText } from "../modmail/controlSubModmail.js";

/**
 * Rechecks users flagged as "Hacked and Recovered", "Scammed", or "Future NSFW" to see if they now match Bot Group Advanced evaluation
 * @param username The username of the user to check
 * @param currentStatus Their current user status
 * @param context Reddit's context
 * @returns Whether or not the user needs to be checked more rapidly in the future
 */
export async function recheckFlaggedUser (username: string, currentStatus: UserDetails, context: TriggerContext | JobContext): Promise<boolean> {
    const eligibleFlags = [UserFlag.HackedAndRecovered, UserFlag.Scammed, UserFlag.FutureNSFW];

    if (!currentStatus.flags) {
        return false;
    }

    if (!currentStatus.flags.some(flag => eligibleFlags.includes(flag))) {
        return false;
    }

    if (currentStatus.userStatus !== UserStatus.Organic) {
        return false;
    }

    const userHistory = await context.reddit.getCommentsAndPostsByUser({
        username,
        limit: 100,
        sort: "new",
    }).all();

    const user = await getUserExtended(username, context);
    if (!user) {
        console.error("FlaggedRechecks: Could not fetch user details for", username);
        return false;
    }

    const variables = await getEvaluatorVariables(context);

    const evaluator = new EvaluateBotGroupAdvanced(context, userHistory, undefined, variables);

    const evaluationResult = await evaluator.evaluate(user);
    if (!evaluationResult || !evaluator.canAutoBan || !evaluator.hitReasons || evaluator.hitReasons.length === 0) {
        return true;
    }

    const formattedHitReaasons = evaluator.hitReasons.map((reason) => {
        if (typeof reason === "string") {
            return reason;
        } else {
            return reason.reason;
        }
    });

    console.log(`FlaggedRechecks: User ${user.username} hit reasons: ${formattedHitReaasons.join(", ")}`);

    const message: json2md.DataObject[] = [
        { p: `User ${user.username} has flags ${currentStatus.flags.join(", ")} and is marked as organic, but currently matches evaluators. Check to see if action is needed` },
        { hr: "" },
    ];

    message.push(...await getSummaryForUser(user.username, "modmail", context));

    const modmailStrings = markdownToText(message);

    const firstString = modmailStrings.shift();
    if (!firstString) {
        console.error("FlaggedRechecks: No content to send in modmail for user", user.username);
        return false;
    }

    const newConversationId = await context.reddit.modMail.createModInboxConversation({
        subredditId: context.subredditId,
        subject: `Flagged User Recheck: ${user.username}`,
        bodyMarkdown: firstString,
    });

    for (const string of modmailStrings) {
        await context.reddit.modMail.reply({
            body: string,
            conversationId: newConversationId,
            isInternal: true,
        });
    }
    return false;
}
