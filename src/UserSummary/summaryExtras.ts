import { JSONObject } from "@devvit/public-api";
import _ from "lodash";

interface SummaryExtra {
    type: "post" | "comment";
    title: string;
    regex: string;
}

export function getSummaryExtras (evaluatorConfig: Record<string, unknown>): SummaryExtra[] {
    const extras = Object.entries(evaluatorConfig)
        .filter(([key]) => key.startsWith("summary-extras:comment") || key.startsWith("summary-extras:post"))
        .map(([key, value]) => {
            const valueObj = value as JSONObject;
            const title = valueObj.title as string | undefined;
            const regex = valueObj.regex as string | undefined;
            if (typeof title !== "string" || typeof regex !== "string") {
                console.warn(`Invalid summary extra configuration for key ${key}`);
                return;
            }

            return {
                type: key.startsWith("summary-extras:comment") ? "comment" : "post",
                title,
                regex,
            } as SummaryExtra;
        });

    return _.compact(extras);
}
