import { JSONValue, Post, TriggerContext } from "@devvit/public-api";
import { UserExtended } from "../extendedDevvit.js";
import { EvaluateInconsistentAgeBot } from "./EvaluateInconsistentAgeBot.js";

const mockContext = {} as unknown as TriggerContext;
const mockBasicHistory = [
    { createdAt: new Date(), id: "t3_fake1", title: "Post 1", isNsfw: () => true },
    { createdAt: new Date(), id: "t3_fake2", title: "Post 2", isNsfw: () => true },
    { createdAt: new Date(), id: "t3_fake3", title: "Post 3", isNsfw: () => true },
    { createdAt: new Date(), id: "t3_fake4", title: "Post 4", isNsfw: () => true },
    { createdAt: new Date(), id: "t3_fake5", title: "Post 5", isNsfw: () => true },
] as unknown as Post[];

const mockUser = {} as unknown as UserExtended;

const mockVariables = {} as unknown as Record<string, JSONValue>;

test("User with three different sequential ages", () => {
    const history = [
        ...mockBasicHistory,
        { createdAt: new Date(), id: "t3_fake6", title: "F23 Hello", isNsfw: () => true },
        { createdAt: new Date(), id: "t3_fake7", title: "F24 Hello", isNsfw: () => true },
        { createdAt: new Date(), id: "t3_fake8", title: "F25 Hello", isNsfw: () => true },
    ] as unknown as Post[];

    const evaluator = new EvaluateInconsistentAgeBot(mockContext, mockVariables);
    const result = evaluator.evaluate(mockUser, history);
    console.log(`Result: ${evaluator.getReasons().join(", ")}`);
    expect(result).toBeTruthy();
});
