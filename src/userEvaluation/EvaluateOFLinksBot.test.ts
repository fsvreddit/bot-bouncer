import { TriggerContext, UserSocialLink } from "@devvit/public-api";
import { UserExtended } from "../extendedDevvit.js";
import { EvaluateOFLinksBot } from "./EvaluateOFLinksBot.js";

vi.mock("./EvaluateOFLinksBot.js", async () => {
    const originalModule = await vi.importActual<typeof import("./EvaluateOFLinksBot.js")>("./EvaluateOFLinksBot.js");
    return {
        ...originalModule,
        EvaluateOFLinksBot: class extends originalModule.EvaluateOFLinksBot {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            protected override async getSocialLinks (_: string): Promise<UserSocialLink[]> {
                return Promise.resolve([{
                    id: "fake",
                    outboundUrl: "https://onlyfans.com/ericalovely",
                    type: 2,
                    title: "My Lovely Onlyfans",
                }]);
            }
        },
    };
});

function createMockUser (displayName: string, userDescription: string) {
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
        displayName,
        userDescription,
    } as UserExtended;
}

const mockContext = {} as unknown as TriggerContext;
const evaluatorVariables = {
    "oflinks:maxageindays": 30,
    "oflinks:prefixes": ["https://onlyfans.com/"],
};

test("User who matches criteria", async () => {
    const evaluator = new EvaluateOFLinksBot(mockContext, evaluatorVariables);
    const mockUser = createMockUser("Erica :)", "Hi, I'm Erica. Aren't I great!");
    const evaluationResult = await Promise.resolve(evaluator.preEvaluateUser(mockUser));
    expect(evaluationResult).toBeTruthy();
});

test("User who doesn't match social links criteria", async () => {
    const evaluator = new EvaluateOFLinksBot(mockContext, evaluatorVariables);
    const mockUser = createMockUser("Susan :)", "Hi, I'm Susan. Aren't I great!");
    const evaluationResult = await Promise.resolve(evaluator.preEvaluateUser(mockUser));
    expect(evaluationResult).toBeFalsy();
});
