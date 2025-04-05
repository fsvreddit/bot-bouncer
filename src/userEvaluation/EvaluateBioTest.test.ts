import { JSONValue, TriggerContext } from "@devvit/public-api";
import { UserExtended } from "../extendedDevvit.js";
import { subDays } from "date-fns";
import { EvaluateBioText } from "./EvaluateBioText.js";

const variables = JSON.parse(`{
    "biotext:bantext": [
        "just looking for real connections out here"
    ]
}`) as Record<string, JSONValue>;

function createMockUser (bioText: string): UserExtended {
    return {
        id: "t2_fake",
        createdAt: subDays(new Date(), 10),
        username: "Wonderful-Lemon5828",
        userDescription: bioText,
        commentKarma: 350,
        linkKarma: 100,
        hasVerifiedEmail: true,
        isGold: false,
        isModerator: false,
        isAdmin: false,
        nsfw: true,
        displayName: "Wonderful-Lemon5828",
    };
}

test("User with matching bio", () => {
    const evaluator = new EvaluateBioText({} as unknown as TriggerContext, variables);
    const mockUser = createMockUser("📍Oklahoma 20y/o just looking for real connections out here, Text me for more details on the link below!");
    const result = evaluator.evaluate(mockUser, []);
    expect(result).toBeTruthy();
});

test("User with nonmatching bio", () => {
    const evaluator = new EvaluateBioText({} as unknown as TriggerContext, variables);
    const mockUser = createMockUser("A very ordinary Redditor with no special interests.");
    const result = evaluator.evaluate(mockUser, []);
    expect(result).toBeFalsy();
});
