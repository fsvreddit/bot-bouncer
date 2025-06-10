import { TriggerContext } from "@devvit/public-api";
import { ALL_EVALUATORS } from "@fsvreddit/bot-bouncer-evaluation";

export async function removeRetiredEvaluatorsFromStats (context: TriggerContext) {
    const redisKey = "EvaluatorStats";
    const statsValue = await context.redis.get(redisKey);
    if (!statsValue) {
        return;
    }
    const allStats: Record<string, unknown> = statsValue ? JSON.parse(statsValue) as Record<string, unknown> : {};
    const newStats: Record<string, unknown> = {};

    for (const Evaluator of ALL_EVALUATORS) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
        const evaluator = new Evaluator({} as any, {});
        if (allStats[evaluator.name]) {
            newStats[evaluator.name] = allStats[evaluator.name];
        }
    }

    if (Object.keys(newStats).length !== Object.keys(allStats).length) {
        await context.redis.set(redisKey, JSON.stringify(newStats));
    }
}
