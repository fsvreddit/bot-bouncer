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
    "obfuscatedbiowords:keywords": [
        "telegram",
        "snapchat",
        "whatsapp",
    ],
};

test("Bio text that should be banned", () => {
    const fakeUser = createFakeUser("my wh,at.sapp: carla18");
    const mockTriggerContext = {} as unknown as TriggerContext;
    const evaluator = new EvaluateObfuscatedBioKeywords(mockTriggerContext, variables);
    expect(evaluator.preEvaluateUser(fakeUser)).toBeTruthy();
});

test("Bio text that should be banned 2", () => {
    const fakeUser = createFakeUser("my whats4pp: carla18");
    const mockTriggerContext = {} as unknown as TriggerContext;
    const evaluator = new EvaluateObfuscatedBioKeywords(mockTriggerContext, variables);
    expect(evaluator.preEvaluateUser(fakeUser)).toBeTruthy();
});

test("Bio text that should be banned 3", () => {
    const fakeUser = createFakeUser("my T. E. L. E. G. R. A. M: carla18");
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

test("Bio text that should not be banned 3", () => {
    const fakeUser = createFakeUser("I'm available for sexting session until you cum🔥 nudes videos 🥵 custom video 🔥 drop box 🎁 facetime 💕 WhatsApp +1 (586) 873-9543 telegram @Lilerose83");
    const mockTriggerContext = {} as unknown as TriggerContext;
    const evaluator = new EvaluateObfuscatedBioKeywords(mockTriggerContext, variables);
    expect(evaluator.preEvaluateUser(fakeUser)).toBeFalsy();
});

test("Bio text that should not be banned 4", () => {
    const fakeUser = createFakeUser("23M looking for fun 👉👌 dm me NO I DON'T HAVE TELEGRAM OR WHATSAPP AND I NEVER WILL if you add on snap, just mention you found me through reddit");
    const mockTriggerContext = {} as unknown as TriggerContext;
    const evaluator = new EvaluateObfuscatedBioKeywords(mockTriggerContext, variables);
    expect(evaluator.preEvaluateUser(fakeUser)).toBeFalsy();
});

test("Bio text that should not be banned 5", () => {
    const fakeUser = createFakeUser("kinky redditor playing on Reddit, telegram, snap, discord and session. Message for my username on those apps! Open to anything legal and 18+");
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
