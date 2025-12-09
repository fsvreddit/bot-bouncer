import { TriggerContext } from "@devvit/public-api";
import { ModmailMessage } from "./modmail.js";
import { getEvaluatorVariables } from "../userEvaluation/evaluatorVariables.js";
import { evaluateUserAccount, EvaluationResult } from "../handleControlSubAccountEvaluation.js";
import json2md from "json2md";

export async function evaluateAccountFromModmail (modmail: ModmailMessage, context: TriggerContext) {
    const regex = /^!evaluate ([a-zA-Z0-9_-]+)\b/;
    const matches = regex.exec(modmail.bodyMarkdown);
    if (!matches) {
        return;
    }

    const username = matches[1];
    if (!username) {
        return;
    }

    console.log(`Modmail: Checking user ${username} from modmail`);

    const variables = await getEvaluatorVariables(context);
    let evaluationResults: EvaluationResult[];
    const output: json2md.DataObject[] = [];

    try {
        evaluationResults = await evaluateUserAccount(username, variables, context, false);
        console.log(`Modmail: Evaluation results for ${username}: ${JSON.stringify(evaluationResults)}`);
        if (evaluationResults.length === 0) {
            output.push({ p: `No evaluation results for ${username}` });
        } else {
            output.push({ p: `Evaluation results for ${username}` });
            const bullets: string[] = [];
            evaluationResults.forEach((result) => {
                if (!result.hitReason) {
                    bullets.push(`${result.botName} - No hit reason provided`);
                    return;
                }

                if (typeof result.hitReason === "string") {
                    bullets.push(`${result.botName} - ${result.hitReason.slice(0, 100)}`);
                } else {
                    bullets.push(`${result.botName} - ${result.hitReason.reason.slice(0, 100)}`);
                }
            });
            output.push({ ul: bullets });
        }
    } catch (error) {
        console.error(`Karma Farming Subs: Error evaluating user ${username}: ${error}`);
        output.push({ p: `Error evaluating user ${username}` });
        output.push({ blockquote: error instanceof Error ? error.message : String(error) });
    }

    await context.reddit.modMail.reply({
        body: json2md(output),
        conversationId: modmail.conversationId,
        isInternal: true,
    });
}
