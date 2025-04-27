import { JSONValue, Post, TriggerContext } from "@devvit/public-api";
import { EvaluateWorldTraveller } from "./EvaluateWorldTraveller.js";
import { UserExtended } from "../extendedDevvit.js";

const variables: Record<string, JSONValue> = {
    "worldtraveler:killswitch": false,
    "worldtraveler:distinctgroups": 2,
    "worldtraveler:subgroups": [
        "CasualUK, unitedkingdom, uknews",
        "canada, ontario",
    ],
};

function createMockHistory (subreddits: string[]): Post[] {
    return subreddits.map(subreddit => ({
        subredditName: subreddit,
        id: `t3_${subreddit}`,
        createdAt: new Date(),
    } as unknown as Post));
}

test("Content in more than one group", () => {
    const evaluator = new EvaluateWorldTraveller({} as unknown as TriggerContext, variables);
    const history = createMockHistory(["CasualUK", "canada"]);
    const result = evaluator.evaluate({} as unknown as UserExtended, history);
    expect(result).toBe(true);
});

test("Content in one group", () => {
    const evaluator = new EvaluateWorldTraveller({} as unknown as TriggerContext, variables);
    const history = createMockHistory(["CasualUK", "uknews"]);
    const result = evaluator.evaluate({} as unknown as UserExtended, history);
    expect(result).toBe(false);
});
