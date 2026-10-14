import { vi } from "vitest";

vi.hoisted(() => {
    globalThis.devvit = { config: {} };
});

vi.mock("@devvit/web/server", () => ({
    context: {
        subredditId: "t5_test",
        subredditName: "BotBouncer",
    },
    redis: {},
}));

vi.mock("@fsvreddit/fsv-devvit-web-helpers", () => ({
    getExtendedDevvit: vi.fn(),
    hasTriggerBeenHandled: vi.fn(),
}));

import { describe, it } from "vitest";
import devvitConfig from "../../../devvit.json";
import { AppSetting } from "./appSettings.js";

type SettingNode = { type: string; fields?: Record<string, unknown> };

function flattenSettingKeys (settings: Record<string, SettingNode>): string[] {
    return Object.entries(settings).flatMap(([key, value]) => value.type === "group" && value.fields ? Object.keys(value.fields) : [key]);
}

const configSettingKeys = [
    ...flattenSettingKeys(devvitConfig.settings.subreddit),
    ...flattenSettingKeys(devvitConfig.settings.global),
].sort();

const appSettingValues: string[] = Object.values(AppSetting).sort();

describe("AppSetting configuration parity", () => {
    it("has a devvit.json setting for every AppSetting enum value", () => {
        const missingFromConfig = appSettingValues.filter(setting => !configSettingKeys.includes(setting));

        assert.deepEqual(missingFromConfig, []);
    });

    it("has an AppSetting enum value for every devvit.json setting", () => {
        const missingFromEnum = configSettingKeys.filter(setting => !appSettingValues.includes(setting));

        assert.deepEqual(missingFromEnum, []);
    });
});
