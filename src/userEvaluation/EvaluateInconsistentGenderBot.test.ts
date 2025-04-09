import { Post, TriggerContext } from "@devvit/public-api";
import { EvaluateInconsistentGenderBot } from "./EvaluateInconsistentGenderBot.js";
import { UserExtended } from "../extendedDevvit.js";

const mockContext = {} as unknown as TriggerContext;

test("User with consistent genders", () => {
    const history = Array.from({ length: 6 }, (_, i) => ({
        id: `t3_fake_${i}`,
        createdAt: new Date(),
        title: "M19",
        isNsfw: () => true,
    })) as unknown as Post[];

    const evaluator = new EvaluateInconsistentGenderBot(mockContext, {});
    const evaluationResult = evaluator.evaluate({} as unknown as UserExtended, history);
    expect(evaluationResult).toBeFalsy();
});

test("User with inconsistent genders", () => {
    const history = Array.from({ length: 6 }, (_, i) => ({
        id: `t3_fake_${i}`,
        createdAt: new Date(),
        title: "M19",
        isNsfw: () => true,
    })) as unknown as Post[];

    history.push({
        id: "t3_fake_7",
        createdAt: new Date(),
        title: "20 [F4M]",
        isNsfw: () => true,
    } as unknown as Post);

    const evaluator = new EvaluateInconsistentGenderBot(mockContext, {});
    const evaluationResult = evaluator.evaluate({} as unknown as UserExtended, history);
    expect(evaluationResult).toBeTruthy();
});
