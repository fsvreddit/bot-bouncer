import { Post, TriggerContext } from "@devvit/public-api";
import { EvaluateAdviceBot } from "./EvaluateAdviceBot.js";
import { UserExtended } from "../extendedDevvit.js";
import { yamlToVariables } from "./evaluatorVariables.js";

const mockContext = {} as unknown as TriggerContext;

const mockUser = {} as unknown as UserExtended;

const evaluatorConfigYaml = `
name: "advice"

anysub: true

maxageindays: 60

minparagraphs: 5
maxparagraphs: 15
maxfinalparalength: 120

requiredregexes:
    - —

eachpararequiredregexes:
    - '^[A-Z]'
    - '[.?!:][”"]?$'

disallowedregexes:
    - \\p{M}

scorethreshold: 4

# Terms that add a point for every one found
intensifierregexes:
    - \\bsmirk(?:ed)\\b
    - \\bstunned\\b
    - ["“] (?:and|or) ["”]
    -
    - \\(\\d{1,2}[MF]\\)
    - \\(\\d{1,2}[MF] (?:and|&) \\d{1,2}[MF]\\)

paragraphintensifierregexes:
    - ^So(?:…|...)
    - ^So, Reddit(?:…|...)
    - \\?$

`;

function getMockPost (body: string) {
    return {
        id: "t3_fake",
        createdAt: new Date(),
        body,
    } as unknown as Post;
}

interface TestScenario {
    body: string;
    expected: boolean;
}

const testScenarios: TestScenario[] = [
    {
        body: `Throwaway account because my girlfriend follows my main.

So, I was dating my girlfriend “Sophie” for almost 3 years. We lived together, talked about marriage, all that good stuff. Everything was going great until her childhood best friend “Liam” moved back to our city after working abroad for two years.

I didn’t mind at first. She was excited to see him again, and I thought, “Cool, I’ll finally get to meet the guy she keeps talking about.” But when Liam came back, he practically moved in with us. Not literally, but he was at our apartment all the time. Staying for dinner, crashing on the couch after “movie nights,” texting her constantly, etc.

I expressed my discomfort a few times—not in a controlling way, just stuff like:
“Hey, I’d really like to have some alone time with you,” or “Do you think it’s weird that he sleeps over this often?”

She always brushed it off with, “We’ve known each other since we were kids,” or “You’re being insecure.”

Then one night, I came home early and found them cuddled under a blanket watching a movie. Not making out, not kissing—just cuddling. I didn’t yell, but I did say something like, “This feels really inappropriate.” She snapped and said I was being possessive and controlling.

A few days later, she gave me an ultimatum:
“Either accept my friendship with Liam without questioning it, or we’re done.”

So… I told her, “Alright then. We’re done.”

She was shocked. Cried, begged me to reconsider, said I was overreacting. I packed a bag and left for my brother’s place that night.

Now, two months later, she’s been texting me almost daily. Saying Liam admitted he had feelings for her and that she rejected him. She says she now realizes I was right and wants another chance.

But honestly? I’m done. Even if nothing physical happened, the emotional betrayal hurt just as bad. My friends are split—some say I’m being petty, others say I dodged a bullet.

So… AITA for not taking her back?`,

        expected: true,
    },
    {
        body: `So I (23M) live with my roommate (22M), let's call him Adam. We’ve been sharing an apartment for almost a year, and while things have mostly been okay, Adam can be... eccentric, to put it mildly.

We split chores 50/50. I do dishes one week, he does them the next. Recently, I had a rough week at work, was running on no sleep, and Adam had apparently cooked a *five-course medieval banquet* and left all the dishes for me. Whatever, I suck it up and start doing them.

Then, two days later, I come home from work, and the living room smells *wrong*. Like, horrifically wrong. I walk in, and Adam is sitting on the couch looking sheepish. I ask him what the hell happened.

He tells me he had "an accident." On my seat. The armchair that I bought, that I always sit in, that he *never* uses. When I press him for details, he tells me he had some bad tacos, didn't make it to the bathroom in time, panicked, and sat down to "try and hold it in." Yes. That was his plan.

He shat. In. My. Chair.

Then he tried to clean it, but it still smells, there’s a stain, and honestly I just want to throw the whole thing away. He shrugged it off like it was no big deal. No offer to replace it, no deep cleaning, nothing.

So I told him, flat-out: I'm not doing your dishes anymore. You crapped in my chair, Adam. You broke the sacred roommate code. You don’t get clean forks from me anymore.

Now he's sulking and saying I'm being immature and making a big deal out of "just an accident" and that I’m "weaponizing chores" to punish him. Our other friends are kinda split — some say I'm justified, others say I’m being childish and should get over it.

So, Reddit... AITA for not doing the dishes because my roommate shat in my seat?`,
        expected: true,
    },
    {
        body: `I (24F) share a two-bedroom apartment with my roommate “Kayla” (25F). When we signed the lease, we agreed it would just be the two of us, and things went pretty smoothly for the first few months. But lately, her boyfriend has been over all the time. And I don’t mean just visiting — I mean he’s here more than she is.

He showers here, eats our groceries, leaves his laundry around, and even uses our Wi-Fi for work calls. He doesn’t pay rent, utilities, or even chip in for cleaning supplies. At first, I tried to be understanding — it’s her boyfriend, and I didn’t want to be that annoying roommate. But after a month of feeling like I’m living with a third (uninvited) person, I had to say something.

I brought it up to Kayla as nicely as I could. I said I didn’t sign up to live with her boyfriend and that it feels like he’s unofficially moved in. I asked if we could agree on some boundaries, like how many nights a week he stays over. She got super defensive and accused me of “policing her relationship.” She said he basically has nowhere else to go because his current living situation isn’t great.

Now she’s being cold and passive-aggressive, and I’m walking on eggshells in my own home. I get that she wants to support her boyfriend, but this isn't what I agreed to when I signed the lease. I’m just asking for some space and fairness.

So… AITA for telling my roommate her boyfriend can’t practically live in our apartment?`,

        expected: true,
    },
    {
        body: `So here’s some context:

I (17M) live with a 34F woman in the city. She’s not my mom, not a relative, not a family friend like irc she was a friend of one of my mothers colleagues but don’t quote me on that — literally just someone I split rent with. Rent in this city is insane, and since I go to a private school here (which is about two hours from my actual home), this was the only realistic setup. We both pay rent and live our own lives. That was the arrangement.

She has a 7-year-old son, and lately she’s been expecting me to feed or “watch” him in the evenings. This wasn’t discussed beforehand. I didn’t sign up to be anyone’s babysitter. I’m currently on study break for my final exams in May, and I usually just stay in my room all day grinding through prep. Her kid gets home around 4 PM, and she doesn’t finish her second job until around 7:30 PM most days. Until recently, the kid just grabbed snacks or something from the pantry, and that was that.

But this past Friday, she messaged me saying she’d be home late — like 1:30 AM — and asked me to make dinner for her son. I replied, “Nah, I’m busy with something and can’t be bothered to make anything. If you want, order Uber Eats or something and I’ll go down and pick it up from the front desk.”

She said she couldn’t do that (gave no reason), and I didn’t follow up. I was busy, and honestly didn’t feel like I should be responsible for that situation.

She got back home late and was pissed. Told me I was selfish and inconsiderate, that I’m “living under her roof and eating her food” — even though I’m paying rent, like I said — and that the least I could do was help her out. I told her bluntly that I’m not her babysitter, I didn’t agree to take on any responsibility for her kid, and that it’s not fair to try and guilt me into it just because I’m physically present.

Since then, it’s gotten worse. She’s started making passive-aggressive comments — stuff like, “Must be nice to only care about your little exams,” or complaining loudly on the phone when I’m nearby about how some people “don’t respect the house they live in.” She slams doors, sighs dramatically, and sometimes tries to bait me into arguments by asking things like, “So are you too busy to even say hi to a child now?”

I’m trying to keep my head down and stay focused, but it’s exhausting. I pay rent. I stay in my room. I’m not being disruptive. I never agreed to provide childcare, and I don’t think it’s fair that she’s treating me like I did.

So Reddit, AITA for refusing to cook for her kid and not taking responsibility for something I never signed up for?`,
        expected: true,
    },

    // HUMANS
    {
        body: `Throwaway Account

    Okay, cutting to the chase my half sister "Kelly" (32f) caught my other half sister "Lily" (29f) in bed with her husband and Lily is having a baby who's paternity is in question, and from where I (19f) from sitting this is all delicious.

    Now before you all come at me in the comments, here's some context:

    CONTEXT: I am my parents' only child together. Kelly and Lily are my half siblings via my dad who divorced their mom. A year after the divorced was finalized he met my mom who had just moved in from another state, so my mom was never the other woman. Didn't stop Kelly and Lily's mom from painting it that way and they believed her. Kelly and Lily didn't like my mom and made it known. They weren't happy when they found out that I was coming and have told me so themselves that they wished bad things to happen to my mom while she was pregnant so I wouldn't exist when I was a child.

    Because of this, I am not close to my sisters at ALL and while they have calmed down with age, there's too much negative history there. For the longest time Kelly and Lily only considered themselves as each other's sister, while I was just their dad's other kid. That's fine by me, my mom has another daughter from a previous relationship that I love and trust, and I'm fine with just having her. When Kelly got engaged I was invited to the wedding and only went to appease my dad as I'm sure Kelly only invited me for the same reason. She made it a point to sit me far away from the rest of the family but it was cool since I didn't get a gift and left early. Although not before sitting through Lily's lovely MOH speech talking about the importance of family and fidelity (oh the irony). That was 5 years ago and I have a copy of the recording of said speech.

    Kelly, Lily, and I don't follow each other on social media but because of our shared paternal side we have a lot of mutuals and will occasionally see what the other posts. When I heard through word of mouth of what happened, I was shocked and in disbelief. I wanted to test to see if it was real but in a super petty way so I posted a clip of Lily's speech and innocently captioned it a message asking if anyone knew/remembered any details about where I could the dress because I wanted to buy one just like it but in a different color.

    I got a message from Kelly (surprised she had my number) and she started to rage at me. I spent on hour on the phone with her pointing out that we never talk so I didn't know that my post would touch a nerve. That seemed to calm her down and she just vented to me and I was like "yeah it sucks when you have a sister who actively hurts you." Nothing clicked. I immediately took down the post after the call and Kelly shot me a friend request. Then I got another one from Lily the next day. My sister "Roberta" (32f) thinks that I should either just block them and continue with our estranged relationship as is or help to fix it, but I kinda just want to stick around for the drama. However, Roberta's words are starting to get to me so I have to ask AITAH?`,

        expected: false,
    },
];

interface FailedScenario {
    index: number;
    result: boolean;
    reasons: string[];
}

test("Run test scenarios", () => {
    let scenarioIndex = 0;
    const failedScenarios: FailedScenario[] = [];
    for (const scenario of testScenarios) {
        const post = getMockPost(scenario.body);
        const evaluator = new EvaluateAdviceBot(mockContext, yamlToVariables(evaluatorConfigYaml));

        const result = evaluator.evaluate(mockUser, [post]);
        if (result !== scenario.expected) {
            failedScenarios.push({
                index: scenarioIndex,
                result,
                reasons: evaluator.getReasons(),
            });
        }
        scenarioIndex++;
    }

    expect(failedScenarios).toEqual([]);
});
