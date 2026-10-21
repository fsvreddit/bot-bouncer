import assert from "node:assert/strict";
import { describe, it } from "vitest";
import devvitConfig from "../../../devvit.json";
import { ClientSubredditJob, ControlSubredditJob, ObserverSubredditJob, UniversalJob } from "./schedulerJobNames.js";

const allEnumJobValues = [
    ...Object.values(UniversalJob),
    ...Object.values(ControlSubredditJob),
    ...Object.values(ClientSubredditJob),
    ...Object.values(ObserverSubredditJob),
].sort() as string[];

const devvitJobNames = Object.keys(devvitConfig.scheduler.tasks).sort();

describe("Scheduler job configuration parity", () => {
    it("has a devvit.json task for every scheduler job enum value", () => {
        const missingFromConfig = allEnumJobValues.filter(job => !devvitJobNames.includes(job));
        assert.deepEqual(missingFromConfig, []);
    });

    it("has a scheduler job enum value for every devvit.json task", () => {
        const missingFromEnum = devvitJobNames.filter(job => !allEnumJobValues.includes(job));
        assert.deepEqual(missingFromEnum, []);
    });
});
