import { JSONValue, TriggerContext } from "@devvit/public-api";
import { UserExtended } from "../extendedDevvit.js";
import { subDays } from "date-fns";
import { EvaluateBioText } from "./EvaluateBioText.js";

const variables = JSON.parse(`{
    "biotext:bantext": [
        "(im (4|5)'[0-9] btw don't bully)|(in my free time I like to go to my dancing classes and eat food)|(i only reply on my OF)",
        "toxic relationship without access to social media",
        "TessPeaches",
        "^Snap & Tele",
        "(1031916488|2316222014)",
        "(@)?(addison|ashley|ava|anna|bailey|betty|daisy|elyse|emily|faith|greta|rachel|rosa|skye|tatum|vanny|yara|zoey)([a-z]{3,5}|assp|avnn|bduep|bnso|bnt|cln|cryss|cx|djj|duep|eklb|emp|frdo|ghlb|gjhfk|hgq|hys|jycf|ieap|jgfs|oeh|qpx|spg|syv|vvx|wpr)(>)?\\b",
        "(@)?(Annanura007|callme_juniper|charismajae|Chloennli|eliana12ty|elsina32|goddessana23|goddesslisa126@[a-z]+.([a-z]{3})|gretaoeh|LadyComely|LauraLuxe|lilly_gorgs|Lonabunnyy|lunacurves11|maria2k|melanysqa|momanna21|mom_sa|Mommyforfree00|mommyforfree001|natalymartinyk|oliviardl|opalhvq|reagancbrook|realjane551|reeseosh|rixa2k|Safe_wish87|sanderalex0959|sara45x|saradecost|sendermommy|skyeassp|stella074922|uuu_uuu030|vanswoods|tatumcln|((telegram:-)?tinxa1)|TessPeaches|theyluvvsoph69|twincarla18|jennaspx|vannyfrdo|vansosr|vidahsq)$",
        "^(Increíblemente fascinante)",
        "^(wanna sext with me on my free OF!?)$",
        "^(I Donntt reply on reddittt.. only T,e,leg,ram)",
        "^(Mommy looking for a submissive for my new instructions)",
        "^(College girl by day, your personal slut by night. Here for all your kinky fantasies.)",
        "^(([Tt]elegram|TG)(:|;|::) (ashleybnso|ava(jgfs|ieap)|baileyghlb|Chloennli|emilyeklb|LadyComely|Lonabunnyy|Nancy-9g|oliviardl|reagancbrook|realjane551|@Safe_wish87|skyeassp|TessPeaches|vanswoods))",
        "^(Open to finding my person. Kindness and adventure are a must!)",
        "only looking for a rebound, don’t hmu if you want anything else. no i don’t have telegram, stop asking. dms on here work fine xx",
        "Big on adventure, meaningful convos, and just letting things unfold naturally. Let’s link up and make some cool memories!",
        "^(Hi my name('s| is) Lily and I'm 19 years old. Sweet on the surface, but trouble underneath.)",
        "^(H(i)+, I('m| am) Lily (&|and) just turned 18)",
        "^(A little sarcasm, a lot of curiosity xD btw (i'm|i am) Lily, 19yo from Ukraine. i love lily (the flower or plant idk) they are very cute.)",
        "(https://getallmylinks.com/lilymilkersss)$",
        "(https://getallmylinks.com/imlilyhehe)$",
        "https://t.me/LauraLuxe",
        "I’m all about deep connections, spontaneous fun, and seeing where life takes us. Let’s vibe and create something unforgettable!",
        "I'm ([A-Z]([a-z]+)), your passionate innocent looking but kinky & always horny girlfriend, ready for all the naughty fun",
        "so why not do it on camera?",
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
