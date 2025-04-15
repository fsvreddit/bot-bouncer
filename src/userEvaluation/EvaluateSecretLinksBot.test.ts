import { Comment, Post, TriggerContext } from "@devvit/public-api";
import { subYears } from "date-fns";
import { UserExtended } from "../extendedDevvit.js";
import { EvaluateSecretLinksBot } from "./EvaluateSecretLinksBot.js";

const mockUser: UserExtended = {
    id: "t2_fake",
    createdAt: subYears(new Date(), 1),
    username: "CaptivatingCassandra",
    userDescription: "Goddess who will haunt your dreams every night. I'm a sadist who thrives on control. Submit fully, or don't bother, beta. 🖤 https://secretlinks.me/CaptivatingCassandra",
    commentKarma: 350,
    linkKarma: 15024,
    hasVerifiedEmail: true,
    isGold: false,
    isModerator: false,
    isAdmin: false,
    nsfw: true,
    displayName: "Cassandra",
};

test("User with matching bio with a pinned post", () => {
    const history = [
        {
            id: "t3_fake",
            stickied: true,
        },
    ] as unknown as Post[];

    const evaluator = new EvaluateSecretLinksBot({} as unknown as TriggerContext, { });
    const result = evaluator.evaluate(mockUser, history);
    expect(result).toBeTruthy();
});

test("User with matching bio with no pinned post but a distinguished comment", () => {
    const history = [
        {
            id: "t1_fake",
            isDistinguished: () => true,
            subredditName: `u_${mockUser.username}`,
        },
    ] as unknown as Comment[];

    const evaluator = new EvaluateSecretLinksBot({} as unknown as TriggerContext, { });
    const result = evaluator.evaluate(mockUser, history);
    expect(result).toBeTruthy();
});

test("User with matching bio with no pinned post and no distinguished comment", () => {
    const history = [
        {
            id: "t1_fake",
            isDistinguished: () => false,
            subredditName: `u_${mockUser.username}`,
        },
    ] as unknown as Comment[];

    const evaluator = new EvaluateSecretLinksBot({} as unknown as TriggerContext, { });
    const result = evaluator.evaluate(mockUser, history);
    expect(result).toBeFalsy();
});
