import { TriggerContext } from "@devvit/public-api";
import { UserExtended } from "../extendedDevvit.js";
import { EvaluateObfuscatedBioKeywords } from "./EvaluateObfuscatedBioKeywords.js";

function createFakeUser (bioText: string): UserExtended {
    return {
        createdAt: new Date(),
        commentKarma: 0,
        hasVerifiedEmail: false,
        id: "t2_fake",
        isAdmin: false,
        isGold: false,
        isModerator: false,
        linkKarma: 0,
        nsfw: false,
        username: "fake",
        userDescription: bioText,
    };
}

const variables = {
    "obfuscatedbiowords:keywords": ["whatsapp"],
};

test("Bio text that should be banned", () => {
    const fakeUser = createFakeUser("my wh,at.sapp: carla18");
    const mockTriggerContext = {} as unknown as TriggerContext;
    const evaluator = new EvaluateObfuscatedBioKeywords(mockTriggerContext, variables);
    expect(evaluator.preEvaluateUser(fakeUser)).toBeTruthy();
});

test("Bio text that should not be banned", () => {
    const fakeUser = createFakeUser("my whatsapp: carla18");
    const mockTriggerContext = {} as unknown as TriggerContext;
    const evaluator = new EvaluateObfuscatedBioKeywords(mockTriggerContext, variables);
    expect(evaluator.preEvaluateUser(fakeUser)).toBeFalsy();
});

test("Bio text that should not be banned 2", () => {
    const fakeUser = createFakeUser("my Whatsapp: carla18");
    const mockTriggerContext = {} as unknown as TriggerContext;
    const evaluator = new EvaluateObfuscatedBioKeywords(mockTriggerContext, variables);
    expect(evaluator.preEvaluateUser(fakeUser)).toBeFalsy();
});

test("Bio text that has no related keywords at all", () => {
    const fakeUser = createFakeUser("Just here for the memes!");
    const mockTriggerContext = {} as unknown as TriggerContext;
    const evaluator = new EvaluateObfuscatedBioKeywords(mockTriggerContext, variables);
    expect(evaluator.preEvaluateUser(fakeUser)).toBeFalsy();
});
